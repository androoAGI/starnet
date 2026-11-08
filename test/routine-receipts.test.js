/* node test/routine-receipts.test.js — routine runs are receipts, not conversations.

   Customer report 2026-11-08 (macOS 0.15.0): 10,000 script checks (noAgent) made 10,000 session records in the window save
   beside 71 conversations, the browser storage warning kept coming back, and after a cleanup and a restart 72 routine records
   were imported again. Locks: a script check that did not fail forms no session; each routine keeps its newest
   Workstreams.ROUTINE_KEEP sessions in the window save; the boot backfill never brings an older (pruned or deleted) fire back;
   and no conversation of the Commander's is ever dropped or changed. */
'use strict';
const A = require('./_assert.js');
const W = require('../frontend/app/workstreams.js');
const KEEP = W.ROUTINE_KEEP;

const T0 = 1700000000000;
const auto = id => ({ kind: 'routine', id, name: id });
// 71 ordinary conversations (the customer's count), each with its own turns
function seedConversations() {
  for (let i = 0; i < 71; i++) {
    W.adopt({ id: 'ws_conv' + i, title: 'Conversation ' + i, lane: 'active', kind: 'chat', lastActiveAt: T0 + i,
      history: [{ role: 'user', content: 'question ' + i, ts: T0 + i }, { role: 'assistant', content: 'answer ' + i, ts: T0 + i }] });
  }
}
// (General is a conversation too, asserted present; boot marks it read, so it is left out of the byte comparison)
const ordinary = () => W.all().filter(w => !String(w.id).startsWith('cron-') && w.id !== W.generalId());
const snap = rows => JSON.stringify(rows.map(w => Object.assign({}, w)));
const routineRows = key => W.all().filter(w => String(w.id).startsWith('cron-') && W.automationOf(w).id === key);
const fireRow = (runId, prompt) => ({ role: 'user', content: prompt, sourceRunId: runId, turnId: 'r' + runId });

(async () => {
  /* ---- 1. the window save keeps each routine's newest fires; nothing of the Commander's is touched ---- */
  {
    W.init(null);
    seedConversations();
    const general = W.active();
    for (let i = 0; i < 30; i++) {
      W.adopt({ id: 'cron-a' + i, title: 'Site check', lane: 'active', automation: auto('job-a'), lastActiveAt: T0 + 1000 + i,
        runIds: ['a' + i], history: [fireRow('a' + i, 'check'), { role: 'assistant', content: 'ok ' + i, rowId: 7 }] });
    }
    for (let i = 0; i < 4; i++) W.adopt({ id: 'cron-b' + i, title: 'Digest', lane: 'active', automation: auto('job-b'), lastActiveAt: T0 + 2000 + i, history: [] });
    // old routine sessions the Commander made their own: each one must stay
    W.pin('cron-a0', true);
    W.rename('cron-a1', 'My site check notes');
    W.appendRun('cron-a2', 'attended-run', T0 + 1002);                // they replied in it
    W.get('cron-a2').lastActiveAt = T0 + 1002;
    W.get('cron-a3').history.push({ role: 'user', content: 'why did this fail?', ts: T0 + 5 });   // typed, never started a run
    W.recordDeliverable && W.get('cron-a4').deliverables.push({ runId: 'a4', path: 'out/report.md' });
    W.setProjectRoot('cron-a5', '/Users/me/site');
    W.setLane('cron-a6', 'shipped');
    W.switch('cron-a7');                                              // the open one
    // a delegated worker's thread under an old plain fire goes with it; one under a kept fire stays
    W.adopt({ id: 'ws_worker_old', worker: true, parentStreamId: 'cron-a8', title: 'worker', history: [] });
    W.adopt({ id: 'ws_worker_kept', worker: true, parentStreamId: 'cron-a29', title: 'worker', history: [] });
    W.del('ws_conv70');                                               // a Commander delete stays a delete (its tombstone)
    W.switch('cron-a7');
    const before = snap(ordinary().filter(w => w.worker !== true));
    const tombsBefore = JSON.stringify(W.serialize().deletedIds);

    const pruned = W.pruneRoutineSessions({ keep: ['cron-a9'] });     // a run still going
    A.eq(pruned.length, 30 - KEEP - 9, 'the older plain fires of the busy routine are pruned (' + pruned.length + ')');
    A.ok(!pruned.some(id => ['cron-a0', 'cron-a1', 'cron-a2', 'cron-a3', 'cron-a4', 'cron-a5', 'cron-a6', 'cron-a7', 'cron-a9'].includes(id)),
      'pinned, renamed, replied-in, typed-in, deliverable, project, turned-in, open and running sessions are never pruned');
    const keptA = routineRows('job-a').map(w => w.id);
    for (let i = 30 - KEEP; i < 30; i++) A.ok(keptA.includes('cron-a' + i), 'the newest fire cron-a' + i + ' stays');
    A.eq(routineRows('job-b').length, 4, 'a routine under the cap is untouched');
    A.eq(snap(ordinary().filter(w => w.worker !== true)), before, 'every ordinary conversation is byte-for-byte the same');
    A.eq(ordinary().filter(w => w.worker !== true).length, 70, 'and all 70 that were not deleted are still here');
    A.ok(W.get(general.id), 'General stays');
    A.eq(W.get('ws_worker_old'), null, 'a pruned fire takes its delegated worker thread with it');
    A.ok(W.get('ws_worker_kept'), 'a kept fire keeps its worker thread');
    A.eq(JSON.stringify(W.serialize().deletedIds), tombsBefore, 'a prune writes no tombstone (the Commander\'s deletes keep their places)');
    A.ok(!W.isDeleted('cron-a10'), 'a pruned fire is not a deleted one: RUN HISTORY may open it again');
    A.eq(W.activeId(), 'cron-a7', 'the open session stays open');
    A.eq(W.pruneRoutineSessions({ keep: ['cron-a9'] }), [], 'a second prune finds nothing more');
  }

  /* ---- 2. live: a script check is a receipt; a failure forms its session; agent routines keep their newest ---- */
  global.Workstreams = W;
  const busy = new Set();
  global.Channels = { begin: id => busy.add(id), end: id => busy.delete(id), setStatus: () => {}, isBusy: id => busy.has(id), busyIds: () => Array.from(busy) };
  let persists = 0;
  global.App = { persist: () => { persists++; }, refreshRail: () => {} };
  const jobs = [
    { id: 'chk', name: 'Synthetic check', agentId: 'agent', prompt: 'curl the site', noAgent: true, script: 'check.js' },
    { id: 'rep', name: 'Report', agentId: 'agent', prompt: 'write the report' }
  ];
  let transcriptReads = 0, runs = [];
  global.fetch = async url => {
    if (url === '/api/cron') return { ok: true, json: async () => ({ jobs }) };
    if (url.indexOf('/api/runs?') === 0) return { ok: true, json: async () => ({ runs }) };
    if (url.indexOf('/api/transcript?') === 0) {
      transcriptReads++;
      const stream = decodeURIComponent(/stream=([^&]+)/.exec(url)[1]), runId = stream.slice(5);
      return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'write the report', sourceRunId: runId, rowId: 1 }, { role: 'assistant', content: 'report ' + runId, rowId: 2 }] }) };
    }
    throw new Error('unexpected request ' + url);
  };
  const { AutoSessions } = require('../frontend/app/autosessions.js');
  const I = AutoSessions._internals;
  {
    W.init(null);
    seedConversations();
    const before = snap(ordinary());
    await I.loadRoutines();
    for (let i = 0; i < 10000; i++) {
      I.onFire({ jobId: 'chk', runId: 'chk' + i });
      await I.onResult({ jobId: 'chk', runId: 'chk' + i, outcome: i % 2 ? 'ok' : 'silent' });
    }
    A.eq(routineRows('chk').length + W.all().filter(w => String(w.id).startsWith('cron-chk')).length, 0, '10,000 passing script checks make no session');
    A.eq(busy.size, 0, 'and leave nothing marked running');
    await I.onResult({ jobId: 'chk', runId: 'chk-bad', outcome: 'failed', reason: 'script exited 1' });
    const bad = W.get('cron-chk-bad');
    A.ok(bad, 'a script check that failed forms its session, so the failure can be read');
    A.eq(bad && bad.title, 'Synthetic check', 'titled after its routine');
    A.ok(bad && bad.history.some(m => m.sys && /Routine failed/.test(m.content)), 'and it says it failed');
    A.eq(busy.size, 0, 'and it is settled');

    for (let i = 0; i < 25; i++) {
      I.onFire({ jobId: 'rep', runId: 'rep' + i });
      W.get('cron-rep' + i).lastActiveAt = T0 + 5000 + i;
      await I.onResult({ jobId: 'rep', runId: 'rep' + i, outcome: 'ok' });
      W.get('cron-rep' + i).lastActiveAt = T0 + 5000 + i;
    }
    const kept = routineRows('rep').map(w => w.id).sort();
    A.eq(kept.length, KEEP, 'an agent routine keeps its newest ' + KEEP + ' fires in the window save');
    A.ok(kept.includes('cron-rep24') && kept.includes('cron-rep15') && !kept.includes('cron-rep14'), 'the newest ones');
    A.eq(snap(ordinary()), before, 'the 71 conversations are untouched by any of it');
  }

  /* ---- 3. a restart never imports old routine records again ---- */
  {
    W.init(null);
    seedConversations();
    const before = snap(ordinary());
    // the station's last 100 runs: 72 report fires (the customer's 72), 20 passing script checks, 1 failed check
    runs = [];
    for (let i = 0; i < 72; i++) runs.push({ runId: 'old' + i, streamId: 'cron-old' + i, cronJobId: 'rep', agentId: 'agent', title: 'write the report', reason: 'done', ts: T0 + 10000 + i });
    for (let i = 0; i < 20; i++) runs.push({ runId: 'sc' + i, streamId: 'cron-sc' + i, cronJobId: 'chk', agentId: 'agent', reason: 'done', ts: T0 + 20000 + i });
    runs.push({ runId: 'scbad', streamId: 'cron-scbad', cronJobId: 'chk', agentId: 'agent', reason: 'error', error: 'exit 1', ts: T0 + 20100 });
    transcriptReads = 0;
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.eq(routineRows('rep').length, KEEP, 'a boot forms only the newest ' + KEEP + ' report fires, not 72');
    A.eq(transcriptReads, KEEP + 1, 'and reads only their transcripts (plus the failed check)');
    A.ok(W.get('cron-old71') && !W.get('cron-old61'), 'the newest ones');
    A.eq(W.all().filter(w => /^cron-sc\d/.test(w.id)).length, 0, 'a passing script check is never imported as a session');
    A.ok(W.get('cron-scbad'), 'a failed one is');

    // restart: the save round-trips; the same 100 runs come back from the station
    const saved = JSON.parse(JSON.stringify(W.serialize()));
    W.init(saved);
    transcriptReads = 0;
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.eq(routineRows('rep').length, KEEP, 'after a restart nothing older comes back');
    A.eq(transcriptReads, 0, 'and nothing is read again');

    // the Commander deletes the newest report session: an older fire does not take its place on the next boot
    W.del('cron-old71');
    W.init(JSON.parse(JSON.stringify(W.serialize())));
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.eq(W.get('cron-old71'), null, 'a deleted fire stays deleted');
    A.eq(W.get('cron-old61'), null, 'and does not let an older one back');
    A.eq(routineRows('rep').length, KEEP - 1, 'the routine keeps what is left');

    // a fire that ran while the window was closed still forms (newer than what the save holds); the oldest kept one goes
    runs.push({ runId: 'new1', streamId: 'cron-new1', cronJobId: 'rep', agentId: 'agent', reason: 'done', ts: T0 + 30000 });
    runs.push({ runId: 'new2', streamId: 'cron-new2', cronJobId: 'rep', agentId: 'agent', reason: 'done', ts: T0 + 30001 });
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.ok(W.get('cron-new1') && W.get('cron-new2'), 'new fires from while the window was closed are readable');
    A.eq(routineRows('rep').length, KEEP, 'and the routine is back at its cap');
    A.eq(W.get('cron-old62'), null, 'its oldest kept fire made room');
    A.eq(snap(ordinary()), before, 'the 71 conversations are untouched across every restart');
  }

  /* ---- 4. a save that already holds thousands of fires shrinks on the first boot ---- */
  {
    W.init(null);
    seedConversations();
    for (let i = 0; i < 3000; i++) W.adopt({ id: 'cron-x' + i, title: 'Synthetic check', lane: 'active', automation: auto('chk'), lastActiveAt: T0 + 40000 + i,
      runIds: ['x' + i], history: [fireRow('x' + i, 'curl the site'), { role: 'assistant', content: 'HTTP 200 ' + 'x'.repeat(200), rowId: 2 }] });
    const before = snap(ordinary());
    const bytesBefore = JSON.stringify(W.serialize()).length;
    runs = [];
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.eq(routineRows('chk').length, KEEP, '3,000 saved fires become the newest ' + KEEP);
    const bytesAfter = JSON.stringify(W.serialize()).length;
    A.ok(bytesAfter < bytesBefore / 10, 'and the window save shrinks (' + bytesBefore + ' -> ' + bytesAfter + ' chars)');
    A.eq(snap(ordinary()), before, 'with every conversation kept as it was');
  }

  AutoSessions.reset();   // stops the bounded busy poll a fire arms
  A.report('routine-receipts.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
