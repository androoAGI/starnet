/* A QUIET ROUTINE RUN KEEPS NO SESSION, AND A DELETED SESSION STAYS DELETED (customer report 11-10).

   A station with routines firing every minute saved one session per fire, nearly all "routine ran, nothing to report", until browser
   storage was full (~5,800 sessions, 13.4 MB). Cleaning them up did not hold: the deleted-session list kept only the newest 500 ids,
   so 72 removed sessions re-formed on the next boot. Covered here, on the real Workstreams store:
     1. a fire that succeeded and said nothing (no reply / [SILENT]) is dropped when it settles, live and on the boot backfill;
     2. quiet sessions an older build saved (archived ones included) are cleared at boot; anything with real content or a person's
        touch (open, pinned, renamed, a follow-up, a failure line, a packed second row) is kept;
     3. deleting 5,000 sessions keeps every id refused across a save/reload (the 500 cap brought the oldest back). */
'use strict';
const A = require('./_assert.js');

(async () => {
  global.HistoryRef = require('../frontend/app/historyref.js');
  const W = require('../frontend/app/workstreams.js');
  global.Workstreams = W;
  const busy = new Set();
  global.Channels = { end: id => busy.delete(id), begin: id => busy.add(id), setStatus: () => {}, isBusy: id => busy.has(id), busyIds: () => [...busy] };
  let persisted = 0;
  global.App = { persist: () => { persisted++; }, refreshRail: () => {} };

  const transcripts = new Map();   // streamId -> turns
  let runs = [], transcriptReads = 0;
  global.fetch = async url => {
    if (url === '/api/cron') return { ok: true, json: async () => ({ jobs: [{ id: 'job1', name: 'Inbox check', agentId: 'agent', prompt: 'Check the inbox' }] }) };
    if (url.indexOf('/api/runs?') === 0) return { ok: true, json: async () => ({ runs }) };
    if (url.indexOf('/api/transcript?') === 0) {
      transcriptReads++;
      const stream = decodeURIComponent(/stream=([^&]+)/.exec(url)[1]);
      return { ok: true, json: async () => ({ turns: transcripts.get(stream) || [] }) };
    }
    throw new Error('unexpected request: ' + url);
  };
  const { AutoSessions } = require('../frontend/app/autosessions.js');
  const I = AutoSessions._internals;
  const prompt = (sid, rowId) => ({ role: 'user', content: 'Check the inbox', rowId: rowId || 1, streamId: sid, ts: 1 });

  // ---- 1. live: a quiet fire is dropped when it settles; a fire with a reply stays ----
  W.init({});
  await I.loadRoutines();
  for (const [runId, reply, outcome] of [['q1', '[SILENT]', 'silent'], ['q2', '', 'ok'], ['r1', 'Two new emails from the bank.', 'ok'], ['f1', '', 'failed']]) {
    const sid = 'cron-' + runId;
    transcripts.set(sid, [prompt(sid), { role: 'assistant', content: reply, rowId: 2, streamId: sid, ts: 2 }]);
    I.beginSession(runId, { id: 'job1', name: 'Inbox check', agentId: 'agent', prompt: 'Check the inbox' });
    A.ok(!!W.get(sid), sid + ': the running fire shows as a session while it runs');
    await I.completeSession(runId, outcome, outcome === 'failed' ? 'error' : '');
  }
  A.eq(W.get('cron-q1'), null, 'a [SILENT] fire keeps no session once it settles');
  A.eq(W.get('cron-q2'), null, 'a fire with no reply at all keeps no session once it settles');
  A.ok(!!W.get('cron-r1'), 'a fire that said something keeps its session');
  A.ok(!!W.get('cron-f1'), 'a FAILED fire keeps its session (it says why)');
  A.ok(!W.isDeleted('cron-q1'), 'a dropped quiet session costs the deleted-session list nothing');
  A.ok(!busy.has('cron-q1'), 'a dropped quiet session leaves nothing marked running');

  // the open session is never dropped from under the Commander
  transcripts.set('cron-q3', [prompt('cron-q3'), { role: 'assistant', content: '[SILENT]', rowId: 2, streamId: 'cron-q3', ts: 2 }]);
  I.beginSession('q3', { id: 'job1', name: 'Inbox check', agentId: 'agent', prompt: 'Check the inbox' });
  W.switch('cron-q3');
  await I.completeSession('q3', 'silent', '');
  A.ok(!!W.get('cron-q3'), 'a quiet fire the Commander has open stays');

  // ---- 2. boot: older quiet sessions are cleared; real content and a person's touch are kept ----
  const quietRow = sid => ({ id: sid, title: 'Inbox check', agentId: 'agent', lane: 'active', kind: 'chat', runIds: [sid.slice(5)], lastRunOk: true,
    automation: { kind: 'routine', id: 'job1', name: 'Inbox check' },
    history: [prompt(sid), { role: 'system', sys: true, content: '— routine ran, nothing to report —' }] });
  const saved = [];
  for (let i = 0; i < 40; i++) saved.push(quietRow('cron-old' + i));
  saved.push(Object.assign(quietRow('cron-arch'), { archived: true }));
  saved.push(Object.assign(quietRow('cron-pin'), { pinned: true }));
  saved.push(Object.assign(quietRow('cron-renamed'), { title: 'Mine', titleAuto: false }));
  saved.push(Object.assign(quietRow('cron-followup'), { history: quietRow('cron-followup').history.concat([{ role: 'user', content: 'why nothing?' }]) }));
  saved.push(Object.assign(quietRow('cron-failed'), { lastRunOk: false, history: [prompt('cron-failed'), { role: 'system', sys: true, content: '⚠ Routine failed — error', error: true, marker: 'fire-end' }] }));
  saved.push(Object.assign(quietRow('cron-reply'), { history: [prompt('cron-reply'), { role: 'assistant', content: 'Found one.' }, { role: 'system', sys: true, content: '— routine ran, nothing to report —' }] }));
  // packed (save v7): the prompt alone packed is still quiet; two packed rows may hold a reply, so it is kept
  saved.push(Object.assign(quietRow('cron-packed1'), { history: [{ $ref: '1' }, { role: 'system', sys: true, content: '— routine ran, nothing to report —' }] }));
  saved.push(Object.assign(quietRow('cron-packed2'), { history: [{ $ref: '1,1' }, { role: 'system', sys: true, content: '— routine ran, nothing to report —' }] }));
  saved.push({ id: 'ws_chat', title: 'Plain chat', agentId: 'agent', lane: 'active', kind: 'chat', history: [] });
  W.init({ workstreams: saved });
  runs = [];
  await I.backfill({ waits: [] });
  for (let i = 0; i < 40; i++) if (W.get('cron-old' + i)) A.ok(false, 'cron-old' + i + ' should have been cleared at boot');
  A.eq(W.get('cron-arch'), null, 'an ARCHIVED quiet session is cleared too (archiving no longer leaves it in the save)');
  A.eq(W.get('cron-packed1'), null, 'a packed quiet session (only its prompt packed) is cleared');
  for (const keep of ['cron-pin', 'cron-renamed', 'cron-followup', 'cron-failed', 'cron-reply', 'cron-packed2', 'ws_chat']) A.ok(!!W.get(keep), keep + ' is kept');
  A.ok(!JSON.stringify(W.serialize()).includes('cron-old'), 'the cleared quiet sessions are gone from the saved document');

  // the boot backfill never forms a session for a quiet while-away run, and still forms one for a run that said something
  W.init({});
  runs = [
    { runId: 'away-q', streamId: 'cron-away-q', cronJobId: 'job1', agentId: 'agent', title: 'Check the inbox', reason: 'done', ts: 1700000000000 },
    { runId: 'away-r', streamId: 'cron-away-r', cronJobId: 'job1', agentId: 'agent', title: 'Check the inbox', reason: 'done', ts: 1700000000001 }
  ];
  transcripts.set('cron-away-q', [prompt('cron-away-q'), { role: 'assistant', content: '[SILENT]', rowId: 2, streamId: 'cron-away-q', ts: 2 }]);
  transcripts.set('cron-away-r', [prompt('cron-away-r'), { role: 'assistant', content: 'The bank wrote back.', rowId: 2, streamId: 'cron-away-r', ts: 2 }]);
  transcriptReads = 0;
  await I.backfill();
  A.eq(W.get('cron-away-q'), null, 'a quiet run that finished while the page was closed forms no session');
  A.ok(!!W.get('cron-away-r'), 'a run that said something while the page was closed still forms its session');
  A.eq(transcriptReads, 2, 'each finished run is read once at boot (no persistence-race retries on a run already done)');
  await I.backfill();
  A.eq(W.get('cron-away-q'), null, 'a second boot does not bring the quiet run back');

  // ---- 3. deleted sessions stay deleted past 500 ----
  W.init({});
  const N = 5000;
  for (let i = 0; i < N; i++) W.adopt({ id: 'cron-del' + i, title: 'x', agentId: 'agent', lane: 'active' });
  for (let i = 0; i < N; i++) W.del('cron-del' + i);
  const reloaded = JSON.parse(JSON.stringify(W.serialize()));
  W.init(reloaded);
  let back = 0;
  for (let i = 0; i < N; i++) if (W.adopt({ id: 'cron-del' + i, title: 'x', agentId: 'agent', lane: 'active' })) back++;
  A.eq(back, 0, 'none of ' + N + ' deleted sessions re-forms after a save and reload (the oldest came back at the 500 cap)');
  A.ok(!!W.adopt({ id: 'cron-del0', revive: true, title: 'x' }), 'a deliberate re-open (revive) still works');

  // the sidecar's multi-window merge keeps the same bound (save-merge.js TOMBS_MAX mirrors MAX_TOMBS)
  const src = require('fs').readFileSync(require('path').join(__dirname, '../sidecar/save-merge.js'), 'utf8');
  A.ok(/const TOMBS_MAX = 20000;/.test(src), 'save-merge.js keeps as many deleted ids as the page does');

  A.ok(persisted > 0, 'each change was saved');
  A.report('routine-quiet-records.test');
})().catch(e => { console.error(e); process.exit(1); });
