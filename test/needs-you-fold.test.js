'use strict';
/* node test/needs-you-fold.test.js — NEEDS YOU's fold counts WAITS, its rows keep their age honest, and it settles
   (two independent reviews of the one-panel rail, 2026-10-16).

   1. "N more" counted CARDS while the header counted WAITS: an agent's 23 builds are one card, so a folded build card
      read "1 more" for 23 waits, and the header never matched the rows (2 + "3 more" under a header of 28). The fold now
      counts the waits in every row it leaves out (each row carries its own: data-ny-n), so the header is always the waits
      shown plus N.
   2. A card of builds that carry no time showed the age "now" (Math.min of no times is Infinity): the module's own rule
      is "no time: show no age".
   3. At a fold boundary the heartbeat settles: a row's height never depends on a reading of its own line (the inbox reads
      none, Andrew 10-19), so fitRows folds the same rows every beat and nothing rebuilds.
   4. The rows keep one width, scrolling or not: the section reserves its scrollbar's gutter and the list takes the measured
      gutter back (--ny-gutter), so a scrollbar coming in never moves a row's right edge or re-wraps its line.
   GENUINE (executed): the real needsyou.js renders into a host laid out by a height model (each kind's strip over its rows, a
   row's two lines with its portrait and its one key beside them), so the real fitRows and heartbeat run; case 4's scrollbar
   and the panel's give-back are read from the real pipglass.css. */
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();   // delegated.js / needsyou.js escape with the production U.esc, as in the page (qw36)
const fs = require('fs');
const path = require('path');

const NOW = 40 * 86400000;
let clock = NOW;
Date.now = () => clock;
global.localStorage = { getItem: () => null, setItem() {} };
const sessions = new Map([['home', { id: 'home', title: null, agentId: 'agent' }], ['proj', { id: 'proj', title: 'Launch prep', agentId: 'agent' }]]);
global.Workstreams = { get: id => sessions.get(id) || null, list: () => [...sessions.values()], unread: () => false, generalId: () => 'home', isDeleted: () => false };
let pending = [];
global.Channels = { allPending: () => pending };
const opened = [], answered = [];
global.App = { agentName: id => ({ agent: 'NOVA', ultron: 'ULTRON', vex: 'VEX', mira: 'MIRA' })[id] || id, openWorkstream: id => opened.push(id) };
global.Chat = { consentPhrase: p => 'use fs read: ' + p.argsSummary, consentInspect: () => null, revealAsk: () => true,
  answerConsent: async (p, ws, d) => { answered.push(p.promptId + ':' + d); } };
let builds = [], workers = [];
global.WorkshopStore = { pendingAll: async () => builds, pendingAllOk: () => true, ensureSession: m => 'workshop-' + m.runId };
global.Overseer = { snapshot: () => ({ workers }) };
global.fetch = async url => ({ ok: true, json: async () => url === '/api/hooks' ? { hooks: [], pending: [] } : { plugins: [] } });
global.document = undefined;
const NY = require('../frontend/app/needsyou.js');

/* ---- the section, laid out: head, rows (name + ask lines, then keys), and the fold key when it shows ---- */
const HEAD = 30, MORE = 25, ROW = 52, STRIP = 26;   // (Andrew 10-19, B) the waits sit under their kind's strip
let lineCut = false;   // every ask line reads cut (a TEXT SIZE change, a dragged rail): the boxes read it live
const dataset = attrs => Object.fromEntries([...attrs.matchAll(/data-([a-z-]+)="([^"]*)"/g)].map(m => [m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase()), m[2]]));
const LISTENERS = {};   // needsyou.js wires its click listener once (one section per page): every host here shares it
/* (case 4) the section's own scrollbar, as the browser lays it out from the REAL stylesheet: BAR px wide (Chrome's thin
   scrollbar on Windows, measured live 10-16), shown while the section overflows — or always, where pipglass.css reserves
   its gutter (scrollbar-gutter: stable) — and the panel's right margin giving back up to its own width of what
   --ny-gutter says. Whatever the scrollbar takes and the panel does not give back narrows every ask line. */
const GLASS = fs.readFileSync(path.join(__dirname, '..', 'frontend/css/pipglass.css'), 'utf8');
const RESERVED = /scrollbar-gutter:\s*stable/.test((/^#left \.ws-needs \{([^}]*)\}/m.exec(GLASS) || [])[1] || '');
const GIVE_BACK = (/body\.glass-demo:not\(\.hud-mode\) #left \.ws-needs \.ny-panel \{[^}]*margin-right:\s*max\(0px,\s*(\d+)px - var\(--ny-gutter, 0px\)\)/.exec(GLASS) || [])[1];
const BAR = 10, RAIL = 200;
function makeHost(room, scroll) {
  const doc = { activeElement: null, hidden: false };
  const host = { hidden: false, writes: 0, rows: [], secs: [], buttons: [], more: null, listeners: LISTENERS, _h: '', clientHeight: room,
    setAttribute() {}, addEventListener(t, fn) { LISTENERS[t] = fn; }, contains: () => false,
    querySelectorAll: sel => sel === 'li.ny-item[data-ny-key]' ? host.rows : sel === '[data-ny-act]' ? host.buttons : sel === '.ny-sec' ? host.secs : [],
    querySelector: sel => sel === '.ny-more' ? host.more : null,
    // the head, each kind's strip over the rows it shows, the rows, the fold key
    get scrollHeight() { return HEAD + host.secs.filter(s => s.rows.some(r => !r.hidden)).length * STRIP + host.rows.filter(r => !r.hidden).reduce((s, r) => s + r.h, 0) + (host.more && !host.more.hidden ? MORE : 0); },
    get innerHTML() { return this._h; },
    set innerHTML(h) {
      this._h = h; this.writes++;
      this.secs = [...h.matchAll(/<div class="ny-sec ([^"]*)"[^>]*>([\s\S]*?)<\/ul><\/div>/g)].map(m => {
        const keys = [...m[2].matchAll(/<li class="ny-item [^"]*" data-ny-key="([^"]*)"/g)].map(k => k[1]);
        const sec = { kind: m[1], keys, rows: [], hidden: false };
        sec.querySelectorAll = sel => sel === 'li.ny-item[data-ny-key]' ? sec.rows : [];
        return sec;
      });
      this.rows = [...h.matchAll(/<li class="ny-item ([^"]*)"([^>]*)>([\s\S]*?)<\/li>/g)].map(m => {
        const inner = m[3], labels = [...inner.matchAll(/class="ny-key\b[^"]*"[^>]*>([^<]*)</g)].map(k => k[1]);
        const row = { dataset: dataset(m[2]), labels, hidden: false, ageEl: { textContent: (/<span class="ny-age">([^<]*)<\/span>/.exec(inner) || [])[1] },
          // (the inbox) a compact row: its two lines and its padding; its one key stands beside them, across both lines
          h: ROW };
        // the ask line's box, as the browser reports it: a row the section folded away (hidden) is not laid out. (case 4)
        // its line fits two lines in the full text column and wraps to a cut third in any narrower one
        const cut = () => lineCut || (scroll ? host.narrowed() > 0 : false);
        const what = { get clientHeight() { return row.hidden ? 0 : 40; }, get scrollHeight() { return row.hidden ? 0 : cut() ? 60 : 40; },
          get clientWidth() { return row.hidden ? 0 : 150; }, get scrollWidth() { return row.hidden ? 0 : 150; } };
        row.querySelector = sel => sel === '.ny-age' ? row.ageEl : sel === '.ny-what' ? what : null;
        return row;
      });
      for (const sec of this.secs) sec.rows = this.rows.filter(r => sec.keys.includes(r.dataset.nyKey));
      const mm = /<button type="button" class="ny-more"([^>]*)>([^<]*)<\/button>/.exec(h);
      this.more = mm ? { dataset: Object.assign(dataset(mm[1]), { nyAct: 'more' }), hidden: / hidden/.test(mm[1]), textContent: mm[2] } : null;
      this.buttons = [...h.matchAll(/<button type="button" class="ny-key[^"]*" data-ny-act="([^"]*)" data-ny-key="([^"]*)"[^>]*>([^<]*)</g)].map(m =>
        ({ dataset: { nyAct: m[1], nyKey: m[2] }, label: m[3], closest: sel => sel === 'li.ny-item' ? host.rows.find(r => r.dataset.nyKey === m[2]) || null : null }));
    } };
  if (scroll) {   // (case 4) the section's scrollbar, its border box (offsetWidth) and its style (--ny-gutter)
    const vars = {}, barOn = () => RESERVED || host.scrollHeight > host.clientHeight;
    Object.assign(host, { offsetWidth: RAIL, clientLeft: 0, style: { setProperty: (k, v) => { vars[k] = String(v); }, getPropertyValue: k => vars[k] || '' },
      narrowed: () => (barOn() ? BAR : 0) - (GIVE_BACK ? Math.min(Number(GIVE_BACK), parseFloat(vars['--ny-gutter']) || 0) : 0),
      overflows: () => host.scrollHeight > host.clientHeight });
    Object.defineProperty(host, 'clientWidth', { get: () => RAIL - (barOn() ? BAR : 0) });
  }
  doc.getElementById = id => id === 'ws-needs' ? host : null;
  global.document = doc;
  return host;
}
// a fresh section (another rail, another room): leaving SESSIONS and coming back makes the next render a full rebuild
function remount(room, scroll) { const host = makeHost(room, scroll); App.railView = () => 'projects'; NY.render(); delete App.railView; NY.render(); return host; }
const click = (host, b) => host.listeners.click({ target: { closest: sel => sel === '[data-ny-act]' ? b : null }, preventDefault() {}, stopPropagation() {} });
const headerOf = host => Number((/<span class="ny-count">(\d+)<\/span>/.exec(host.innerHTML) || [])[1]);
const moreOf = host => host.more && !host.more.hidden ? Number((/^(\d+) more$/.exec(host.more.textContent) || [])[1]) : 0;
const shownKeys = host => host.rows.filter(r => !r.hidden).map(r => r.dataset.nyKey);
const rowOf = (host, k) => host.rows.find(r => r.dataset.nyKey === k);
const keysOf = (host, k) => (rowOf(host, k) || { labels: [] }).labels.join(' · ');

(async () => {
  /* ---- 1. the fold counts waits: 2 asks, ULTRON's 23 builds, VEX's 2 untimed builds, a failed worker = 28 waits ---- */
  pending = [
    { wsId: 'proj', p: { promptId: 'q1', tool: 'brief.ask', argsSummary: JSON.stringify({ question: 'Which tier should lead?' }), agentId: 'agent', askedAt: NOW - 120000 } },
    { wsId: 'home', p: { promptId: 'a1', tool: 'fs.read', argsSummary: 'notes.md', agentId: 'agent', askedAt: NOW - 60000 } }];
  builds = Array.from({ length: 23 }, (_, i) => ({ runId: 'u' + i, agentId: 'ultron', title: 'Ghost run v' + i, builtAt: NOW - (40 - i) * 60000 }))
    .concat([{ runId: 'v0', agentId: 'vex', title: 'Pricing page', builtAt: 0 }, { runId: 'v1', agentId: 'vex', title: 'Pricing page v2' }]);
  workers = [{ runId: 'w1', status: 'error', agentId: 'mira', parentStreamId: 'home', completedAt: NOW - 30000 }];
  await NY.refreshFeeds(true);
  A.eq(NY.items(NOW).length, 28, 'fixture: 28 waits');

  let host = remount(10000);   // room for everything
  A.eq(headerOf(host), 28, 'the header counts every wait');
  A.eq(shownKeys(host), ['ask:a1', 'ask:q1', 'build:u0', 'build:v0', 'worker:w1'], 'with room, every row shows, by kind: the approval, the question, ULTRON\'s builds (one row, named by the oldest), VEX\'s, the failed worker');
  A.eq(host.secs.map(s => s.kind), ['approvals', 'questions', 'builds', 'failed'], '…each kind under its own strip');
  A.eq((rowOf(host, 'build:u0') || { dataset: {} }).dataset.nyN, '23', 'that row holds its 23 waits (data-ny-n)');
  A.eq(moreOf(host), 0, 'nothing folded: no "N more"');

  /* ---- 2. when the room folds a card, "N more" counts its WAITS: ULTRON\'s builds fold, and all 23 are in it ---- */
  host = remount(HEAD + 2 * STRIP + 2 * ROW + MORE + 1);
  A.eq(shownKeys(host), ['ask:a1', 'ask:q1'], 'a room for two rows (and their strips) shows two');
  A.eq(host.secs.map(s => s.kind + (s.hidden ? ':folded' : '')), ['approvals', 'questions', 'builds:folded', 'failed:folded'], 'a kind whose rows all fold folds its strip with them');
  A.eq(moreOf(host), 26, '"26 more": ULTRON\'s 23 builds, VEX\'s 2 and the failed worker, never the 3 cards');
  A.eq(headerOf(host), 2 + moreOf(host), 'the header (28) is the waits shown plus N more');

  /* ---- 3. no time, no age: a card of untimed builds shows none (never "now") ---- */
  click(host, host.more);   // expand: every row
  A.eq(shownKeys(host), ['ask:a1', 'ask:q1', 'build:u0', 'build:v0', 'worker:w1'], 'expanded, every row shows');
  A.eq(rowOf(host, 'build:v0').ageEl.textContent, '', 'VEX\'s builds carry no time: their row shows no age (it said "now")');
  A.eq(rowOf(host, 'build:u0').ageEl.textContent, '40m', 'ULTRON\'s row shows its oldest build\'s age');
  click(host, host.more);   // Show fewer

  /* ---- 4. at a fold boundary the heartbeat settles: no rebuild loop, and the only key is the safe one ---- */
  pending = [
    { wsId: 'proj', p: { promptId: 'q2', tool: 'brief.ask', argsSummary: JSON.stringify({ question: 'Which tier should lead?' }), agentId: 'agent', askedAt: NOW - 120000 } },
    { wsId: 'home', p: { promptId: 'a2', tool: 'fs.read', argsSummary: 'notes.md', agentId: 'agent', askedAt: NOW - 60000 } }];
  builds = []; workers = [];
  await NY.refreshFeeds(true);
  host = remount(HEAD + STRIP + ROW + MORE + 1);
  const settled = host.writes;
  for (let beat = 0; beat < 6; beat++) { clock += 1000; NY.render(); }
  A.eq(host.writes - settled, 0, 'six heartbeats at the fold boundary rebuild nothing');
  A.eq(shownKeys(host), ['ask:a2'], 'a room for one row shows the approval (approvals lead the panel)');
  A.eq([headerOf(host), moreOf(host)], [2, 1], '…the question in "1 more", under a header of 2');
  A.eq(keysOf(host, 'ask:a2'), 'Deny', 'the approval\'s one key is Deny: nothing is approved from the rail');
  A.eq(keysOf(host, 'ask:q2'), '', 'the question has no key: its row opens its card');
  click(host, host.more);   // expand
  answered.length = 0;
  click(host, host.buttons.find(b => b.dataset.nyAct === 'deny' && b.dataset.nyKey === 'ask:a2'));
  await new Promise(r => setTimeout(r, 0));
  A.eq(answered, ['a2:deny'], 'Deny answers through the approval card\'s own path');
  pending = pending.filter(x => x.p.promptId !== 'a2');
  click(host, host.more);   // Show fewer

  /* ---- 5. the rows keep one width while the section scrolls (fix round 10-16): the gutter is reserved and given back ---- */
  pending = Array.from({ length: 5 }, (_, n) => ({ wsId: 'home', p: { promptId: 'f' + n, tool: 'fs.read', argsSummary: 'notes/' + n + '.md', agentId: 'agent', askedAt: NOW - 60000 * (n + 1) } }));
  await NY.refreshFeeds(true);
  host = remount(HEAD + ROW + 10, true);
  click(host, host.more);   // expanded: every row, the section scrolls
  const settled3 = host.writes;
  for (let beat = 0; beat < 6; beat++) { clock += 1000; NY.render(); }
  A.eq(host.writes - settled3, 0, 'six heartbeats with the section scrolling rebuild nothing');
  A.ok(host.overflows(), '(the expanded list overflows the room: the section scrolls)');
  A.ok(RESERVED && Number(GIVE_BACK) >= BAR, '(pipglass.css reserves the section\'s gutter and the list can give back up to ' + GIVE_BACK + 'px)');
  A.eq(host.narrowed(), 0, 'the rows keep their width while the section scrolls: the scrollbar takes nothing the list does not give back');
  A.report('needs-you-fold.test');
})().catch(e => { console.error(e); process.exit(1); });
