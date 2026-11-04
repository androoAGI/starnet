'use strict';
/* node test/packed-history.writers.test.js — INVARIANT (save v7, history by reference, step S4): a module that WRITES a session's
   history never leaves the packed form (the rows a saved history names, not yet read back) beside what it writes, never keeps a
   stale one over a replacement, and never judges a session blank, unanswered or unplaced from the few rows the page keeps itself.

   The direct writers of ws.history besides chat.js: the routine session fold and the boot backfill (autosessions.js), a group chat's
   server copy (group-chat.js) and the return crate's "review the work" (returnstore.js). Each is the production function, lifted by
   name (or the module itself) over the REAL Workstreams, with fakes only at the transport. The splice writer (stationcommands.js
   foldDelivery) and the readers (station.read_session, the commands) are locked in station-commands.test.js and
   history-hydrate.seam.test.js. */
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const A = require('./_assert.js');

const ROOTS = ['frontend/app', 'website/app/app'];
const unread = () => [{ $ref: '1,1' }];                       // rows 1 and 2 named, none held
const record = (id, extra) => Object.assign({ id, title: 'session ' + id, kind: 'chat', agentId: 'agent', history: unread(), runIds: [], createdAt: 1, lastActiveAt: 1, lastReadAt: 1 }, extra || null);

async function family(root) {
  const read = f => fs.readFileSync(path.join(__dirname, '..', root, f), 'utf8');
  const W = require('../' + root + '/workstreams.js');
  const label = s => root + ': ' + s;

  /* ---- the routine session fold (autosessions.foldTurns): the transcript IS the session's history, so it REPLACES the packed one ---- */
  global.Workstreams = W;
  global.Channels = { end() {}, isBusy: () => false, busyIds: () => [], begin() {}, setStatus() {} };
  global.App = { persist() {}, refreshRail() {} };
  let transcriptReads = 0;
  global.fetch = async url => {
    if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: [] }) };
    if (url.indexOf('/api/runs?') === 0) return { ok: true, json: async () => ({ runs: [{ runId: 'run-packed', streamId: 'cron-run-packed', title: 'Packed routine', agentId: 'agent', reason: 'done', ts: 1700000000000 }] }) };
    if (url.indexOf('/api/transcript?') === 0) { transcriptReads++; return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'from the transcript', rowId: 7 }, { role: 'assistant', content: 'its answer', rowId: 8 }] }) }; }
    throw new Error('unexpected request: ' + url);
  };
  delete require.cache[require.resolve('../' + root + '/autosessions.js')];
  const { AutoSessions } = require('../' + root + '/autosessions.js');
  const I = AutoSessions._internals;

  W.init({ workstreams: [record('cron-fold', { lane: 'active' })], activeId: 'cron-fold', generalId: 'cron-fold' });
  const folded = W.get('cron-fold');
  A.eq(W.needsHydration(folded), true, label('(setup) the routine session boots packed'));
  I.foldTurns(folded, [{ role: 'user', content: 'from the transcript', rowId: 7 }, { role: 'assistant', content: 'its answer', rowId: 8 }], 'ok', 'done', true, 1700000000000);
  A.eq(folded.history.map(r => r.content), ['from the transcript', 'its answer'], label('the fold is the session\'s history'));
  A.eq(W.needsHydration(folded), false, label('and the rows the saved history named are replaced with it, not kept beside it'));
  A.eq(W.serialize().workstreams.find(w => w.id === 'cron-fold').history.map(r => r.content), ['from the transcript', 'its answer'], label('a persist writes the fold alone: no reference to rows it replaced'));

  /* ---- the boot backfill: a packed session HAS output (it is only unread), so it is never folded over or begun again ---- */
  W.init({ workstreams: [record('cron-run-packed', { lane: 'active' })], activeId: 'cron-run-packed', generalId: 'cron-run-packed' });
  transcriptReads = 0;
  await I.backfill({ sleep: () => Promise.resolve() });
  A.eq(transcriptReads, 0, label('a packed routine session is not folded again from the transcript: the page just has not read it'));
  A.eq(W.needsHydration('cron-run-packed'), true, label('and its saved rows are still named'));
  A.eq(W.serialize().workstreams.find(w => w.id === 'cron-run-packed').history, unread(), label('…and saved'));
  // (control) the same session with NO output at all is folded, as it always was
  W.init({ workstreams: [record('cron-run-packed', { lane: 'active', history: [] })], activeId: 'cron-run-packed', generalId: 'cron-run-packed' });
  await I.backfill({ sleep: () => Promise.resolve() });
  A.ok(transcriptReads > 0 && W.get('cron-run-packed').history.length === 2, label('(control) an empty routine session is still folded from its transcript'));

  /* ---- a group chat's server copy (group-chat.js adopt): the backend's messages ARE the chat's history ---- */
  const groupSrc = read('group-chat.js');
  const gctx = vm.createContext({ Workstreams: W, queueMicrotask, App: undefined });
  vm.runInContext('const membersById = new Map();\n' + A.fnBody(groupSrc, 'function adopt(g)') + '\nthis.adopt = adopt;', gctx);
  W.init({ workstreams: [record('grp', { conversationMode: 'group' })], activeId: 'grp', generalId: 'grp' });
  const g = W.get('grp');
  gctx.adopt({ id: 'grp', title: 'Crew', leadId: 'agent', members: ['agent'], messages: [{ author: 'user', content: 'hello crew', at: 5 }, { author: 'agent', content: 'hello', at: 6 }], turns: [], updatedAt: 9 });
  A.eq(g.history.map(r => r.content), ['hello crew', 'hello'], label('the group chat holds the backend\'s messages'));
  A.eq([W.needsHydration(g), W.turnCount(g)], [false, 2], label('and not the rows its saved history named, beside them'));

  /* ---- the return crate's "review the work" (returnstore.openWork): a packed session has output, so it is OPENED, not re-adopted and refolded ---- */
  const crateSrc = read('returnstore.js');
  const opened = [], urls = [];
  const rctx = vm.createContext({ Workstreams: W, App: { openWorkstream: id => { opened.push(id); return true; } }, fetch: async url => { urls.push(String(url)); return { ok: false, json: async () => ({}) }; }, encodeURIComponent });
  vm.runInContext(A.fnBody(crateSrc, 'async function openWork(rw)') + '\nthis.openWork = openWork;', rctx);
  W.init({ workstreams: [record('nightshift-1')], activeId: 'nightshift-1', generalId: 'nightshift-1' });
  A.eq(await rctx.openWork({ runId: 'nightshift-1', streamId: 'nightshift-1', agentId: 'agent', title: 'nightly' }), true, label('a packed session opens'));
  A.eq([opened, urls, W.needsHydration('nightshift-1')], [['nightshift-1'], [], true], label('without a transcript read, and without being replaced by one'));
  W.reset();
}

(async () => {
  for (const root of ROOTS) await family(root);
  A.report('packed-history.writers (a writer of a session\'s history never leaves the packed form beside its rows; both shipped trees)');
})().catch(error => { console.error(error); process.exit(1); });
