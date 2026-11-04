'use strict';
/* node test/loop-review-needs-you.test.js — a GOAL LOOPS verdict clears NEEDS YOU at once (org P01 wiring, 2026-10-14).
   Before: NEEDS YOU's goal-loop row read LoopsReview.waiting, a snapshot only the 25 s watcher rewrote. APPROVE / REJECT /
   DELETE in the GOAL LOOPS window re-read /api/loops for the window alone, so the rail row, NOTIFICATIONS › NEEDS YOU, the
   bell and the AUTOMATE badge kept saying "1 result waiting on your review" for up to 25 s after the window showed none.
   GENUINE (executed): the watcher section and the window's refresh() run from the real source in one context; a refresh
   that reads no pending results empties LoopsReview.waiting, settles the bell's loops-review line, and repaints NEEDS YOU and
   the bell — from the window's own read, with no second request. */
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend/app/windows/loops.js'), 'utf8');

const cut = (from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  A.ok(a > 0 && b > a, 'fixture: found ' + JSON.stringify(from.trim().slice(0, 40)));
  return src.slice(a, b);
};
const watcher = cut("  const SEEN_KEY = 'starnet.loops.seen.v1';", '  // first sweep after boot settles');
const windowRefresh = cut('    let refreshGeneration = 0;', '    // ---------- row + verdict actions');

(async () => {
  const rendered = [], badges = [], settled = [];
  let station = [{ id: 'L1', name: 'Tidy the docs', agentId: 'agent', pendingCount: 1, pending: [{ n: 3, endedAt: 1000, title: 'docs pass' }] }];
  let windowReads = 0, watcherReads = 0;
  const el = () => ({ innerHTML: '', _rendered: '', querySelectorAll: () => [], querySelector: () => null, replaceWith() {}, contains: () => false });
  const listEl = Object.assign(el(), { replaceChildren() {}, appendChild() {} });
  const ctx = vm.createContext({
    window: {}, localStorage: { getItem: () => null, setItem() {} },
    document: { querySelector: () => null, createElement: () => { const h = el(); Object.defineProperty(h, 'innerHTML', { set() { h.firstElementChild = el(); }, get: () => '' }); return h; }, activeElement: null },
    StationUI: { settleNotifs: k => settled.push(k), badges: () => badges.push(1), h: { notify() {} } },
    NeedsYou: { render: () => rendered.push(1) },
    fetch: async () => { watcherReads++; return { ok: true, json: async () => ({ loops: JSON.parse(JSON.stringify(station)) }) }; },
    Harness: { api: { get: async () => { windowReads++; return { loops: JSON.parse(JSON.stringify(station)), armed: true }; } } },
    body: { isConnected: true, querySelector: () => null }, listEl, gateEl: el(), consoleSection: {}, sfx() {}, row: l => '<div class="mc-row">' + l.id + '</div>',
    JSON, Math, Number, Object, Array, Set, Map, isFinite, Promise, Error
  });
  vm.runInContext(watcher, ctx);
  vm.runInContext(windowRefresh + '\nthis.windowRefresh = refresh; this.watch = watch;', ctx);

  // the watcher's sweep lists the result waiting on review (the NEEDS YOU row's source)
  await ctx.watch();
  A.eq(ctx.window.LoopsReview.waiting().map(l => l.id + ':' + l.count).join(','), 'L1:1', 'the watcher lists the loop with a result waiting');
  A.ok(rendered.length === 1 && badges.length === 1, 'the list moved: NEEDS YOU and the bell repaint at once');

  // APPROVE in GOAL LOOPS: the sidecar now has nothing pending; the verdict handler ends in the window's refresh()
  station = [{ id: 'L1', name: 'Tidy the docs', agentId: 'agent', pendingCount: 0, pending: [] }];
  const before = watcherReads;
  await ctx.windowRefresh();
  A.eq(windowReads, 1, 'the window read /api/loops once');
  A.eq(watcherReads, before, 'no second request: the window\'s own read feeds the review state');
  A.eq(ctx.window.LoopsReview.waiting().length, 0, 'the NEEDS YOU loop row leaves with the verdict, not on the next 25 s sweep');
  A.ok(settled.includes('loops-review'), 'the bell\'s stored "waiting on your review" line is settled too');
  A.ok(rendered.length === 2 && badges.length === 2, 'NEEDS YOU and the bell repaint from that read');

  // an unchanged read repaints nothing (the window polls every 4 s while open)
  await ctx.windowRefresh();
  A.ok(rendered.length === 2 && badges.length === 2, 'a read that changes nothing does not repaint the rail or the bell');

  // the verdict and DELETE paths both end in that refresh()
  const handler = src.slice(src.indexOf("    listEl.addEventListener('click', async ev => {"), src.indexOf('    // ---------- START A LOOP:'));
  A.ok(/pendingVerdicts\.delete\(verdictKey\)[\s\S]{0,600}\n        refresh\(\); return;/.test(handler), 'APPROVE / REJECT end in the window refresh (which now feeds NEEDS YOU)');
  A.ok(/post\('\/api\/loops\/remove', \{ id \}\)[\s\S]{0,300}\n        refresh\(\); return;/.test(handler), 'DELETE ends in it too');
  A.report('loop-review-needs-you.test');
})().catch(e => { console.error(e); process.exit(1); });
