/* node test/routine-receipts-unopened.test.js — a routine fire that still waits on the Commander is never a receipt.

   Review R56-1-D2 (stabilization plan C0-5, condition 3; introduced by 185dc25e8, the 11-08 receipts change). COMMS keeps each
   routine's newest Workstreams.ROUTINE_KEEP fires (routine-receipts.test.js). A fire that failed, asked a question or did not
   finish, and that the Commander had not opened, went with the rest as soon as ten newer fires ran (an hourly routine that
   failed once overnight and succeeded after), and its NEEDS YOU row went with it: no word, no tombstone. A failure that ran
   while the page was closed and had ten newer fires never formed at all.
   Locks, through the real Workstreams, AutoSessions and NeedsYou (RunOutcome loaded, as the page loads it):
     1. live: a failed, an asked and an unfinished fire, unopened, stay through ten newer clean fires, each with its NEEDS YOU
        row; a stopped one (no NEEDS YOU row) is still a receipt; once a fire is opened, the next prune lets it go;
     2. the bound that keeps the 11-08 storage fix: a routine failing on every fire keeps its newest ten plus ten more
        unopened failures (twenty), never all of them;
     3. page closed: a failure newer than every session the save holds forms past the newest ten, unread, with its row; one
        the save held, showed and pruned does not come back on the next boot. */
'use strict';
const A = require('./_assert.js');
require('./helpers/frontend-esc.js').installEsc();
global.RunOutcome = require('../frontend/app/runoutcome.js');
const W = require('../frontend/app/workstreams.js');
const KEEP = W.ROUTINE_KEEP;

const store = new Map();
global.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
global.Workstreams = W;
const busy = new Set();
global.Channels = { begin: id => busy.add(id), end: id => busy.delete(id), setStatus: () => {}, isBusy: id => busy.has(id), busyIds: () => Array.from(busy), allPending: () => [] };
global.App = { persist: () => {}, refreshRail: () => {}, agentName: id => (id === 'agent' ? 'NOVA' : id) };
global.document = undefined;
const jobs = [{ id: 'nightly', name: 'Nightly report', agentId: 'agent', prompt: 'write the report' }, { id: 'probe', name: 'Site probe', agentId: 'agent', prompt: 'check the site' }];
let runs = [];
global.fetch = async url => {
  if (url === '/api/cron') return { ok: true, json: async () => ({ jobs }) };
  if (url.indexOf('/api/runs?') === 0) return { ok: true, json: async () => ({ runs }) };
  if (url.indexOf('/api/transcript?') === 0) {
    const stream = decodeURIComponent(/stream=([^&]+)/.exec(url)[1]), runId = stream.slice(5);
    return { ok: true, json: async () => ({ turns: [{ role: 'user', content: 'write the report', sourceRunId: runId, rowId: 1 }, { role: 'assistant', content: 'report ' + runId, rowId: 2 }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };   // NEEDS YOU's other feeds: nothing waiting there
};
const { AutoSessions } = require('../frontend/app/autosessions.js');
const I = AutoSessions._internals;
const NY = require('../frontend/app/needsyou.js');

const BASE = Date.now() - 30 * 86400000;
const HOUR = 3600000;
const routineRows = () => NY.items().filter(i => i.kind === 'routine');
const rowOf = id => routineRows().find(i => i.wsId === id) || null;
const firesOf = key => W.all().filter(w => String(w.id).startsWith('cron-') && W.automationOf(w).id === key);
// one live fire through AutoSessions, settled at hour h; the Commander has not opened it (a fire lands unread)
async function fire(jobId, runId, h, outcome, reason) {
  I.onFire({ jobId, runId });
  await I.onResult({ jobId, runId, outcome, reason });
  const w = W.get('cron-' + runId);
  if (w) { w.lastActiveAt = BASE + h * HOUR; w.lastReadAt = 0; }
  // the page prunes after every fire (autosessions pruneReceipts); run it again now the times are the fire's own
  W.pruneRoutineSessions({ keep: Channels.busyIds() });
}

(async () => {
  await I.loadRoutines();

  /* ---- 1. live: an unopened failure, question and unfinished fire stay through ten newer clean fires ---- */
  {
    W.init(null);
    await fire('nightly', 'f0', 0, 'failed', 'error');            // failed overnight
    await fire('nightly', 'q0', 1, 'failed', 'clarifying');       // asked a question
    await fire('nightly', 'u0', 2, 'failed', 'budget');           // did not finish (a limit)
    await fire('nightly', 's0', 3, 'stopped', 'cancelled');       // stopped: no NEEDS YOU row, a receipt as before
    A.ok(rowOf('cron-f0') && rowOf('cron-q0') && rowOf('cron-u0') && !rowOf('cron-s0'), 'fixture: three NEEDS YOU rows before the newer fires (' + routineRows().map(i => i.wsId).join(',') + ')');
    for (let i = 1; i <= KEEP; i++) await fire('nightly', 'ok' + i, 3 + i, 'ok');
    A.ok(W.get('cron-f0'), 'an unopened failed fire stays in COMMS after ' + KEEP + ' newer clean fires');
    A.ok(W.get('cron-q0'), 'so does an unopened fire that asked a question');
    A.ok(W.get('cron-u0'), 'and one that did not finish');
    A.eq(W.get('cron-s0'), null, 'a stopped fire (no NEEDS YOU row) is still a receipt and goes');
    const r = rowOf('cron-f0');
    A.ok(r && /routine "Nightly report" failed/.test(r.what), 'its NEEDS YOU row is still there: ' + (r && r.what));
    A.ok(rowOf('cron-q0') && rowOf('cron-q0').oc === 'asked' && rowOf('cron-u0') && rowOf('cron-u0').oc === 'out_of_budget', 'and the question and the unfinished fire keep theirs, in their own words');
    A.eq(firesOf('nightly').length, KEEP + 3, 'the routine holds its newest ' + KEEP + ' plus the three that wait on the Commander');
    // the Commander opens the failure: it has done its job, and the next prune lets it go (its transcript stays on the station)
    W.markRead('cron-f0');
    A.ok(typeof W.awaitsCommander === 'function' && !W.awaitsCommander(W.get('cron-f0')), 'an opened fire no longer waits on the Commander');
    await fire('nightly', 'ok' + (KEEP + 1), 4 + KEEP, 'ok');
    A.eq(W.get('cron-f0'), null, 'once opened, the failure is a receipt again and the keep-' + KEEP + ' lets it go');
    A.ok(W.get('cron-q0') && W.get('cron-u0'), 'the unopened ones stay');
    A.ok(!W.isDeleted('cron-f0'), 'a pruned fire is still not a deleted one');
  }

  /* ---- 2. the 11-08 storage bound holds: a routine failing on every fire keeps 2 x ROUTINE_KEEP, never all ---- */
  {
    W.init(null);
    for (let i = 0; i < 30; i++) await fire('probe', 'down' + i, i, 'failed', 'error');
    const held = firesOf('probe').map(w => w.id);
    A.eq(held.length, 2 * KEEP, 'thirty unopened failures in a row keep the newest ' + (2 * KEEP) + ' (got ' + held.length + ')');
    A.ok(held.includes('cron-down29') && held.includes('cron-down10') && !held.includes('cron-down9'), 'the newest ones');
    A.eq(routineRows().length, 2 * KEEP, 'and NEEDS YOU lists each of them');
  }

  /* ---- 3. page closed: a failure from while the page was closed forms past the newest ten; a pruned seen one does not come back ---- */
  {
    W.init(null);
    // what the save holds: ten fires from before the page closed, all opened
    for (let i = 0; i < KEEP; i++) W.adopt({ id: 'cron-old' + i, title: 'Nightly report', lane: 'active', automation: { kind: 'routine', id: 'nightly', name: 'Nightly report' },
      runIds: ['old' + i], lastActiveAt: BASE + i * HOUR, lastReadAt: BASE + i * HOUR, history: [{ role: 'user', content: 'write the report', sourceRunId: 'old' + i, rowId: 1 }, { role: 'assistant', content: 'report', rowId: 2 }] });
    // while it was closed: the oldest of twelve fires failed, eleven succeeded after it
    runs = [];
    for (let i = 0; i < 12; i++) runs.push(i === 0
      ? { runId: 'away0', streamId: 'cron-away0', cronJobId: 'nightly', agentId: 'agent', title: 'write the report', reason: 'error', error: 'provider http 500', ts: BASE + (20 + i) * HOUR }
      : { runId: 'away' + i, streamId: 'cron-away' + i, cronJobId: 'nightly', agentId: 'agent', title: 'write the report', reason: 'done', ts: BASE + (20 + i) * HOUR });
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    const f = W.get('cron-away0');
    A.ok(f, 'a failure from while the page was closed forms although eleven newer fires ran');
    A.ok(f && W.unread(f) && f.lastRunOk === false, 'unread, settled failed');
    A.ok(rowOf('cron-away0'), 'with its NEEDS YOU row');
    A.eq(W.get('cron-away1'), null, 'a clean fire past the newest ' + KEEP + ' still stays on the station');
    A.ok(W.get('cron-away11') && W.get('cron-away2'), 'the newest ' + KEEP + ' form as before');

    // the Commander opens it; a later prune lets it go; the next boot does not bring it back
    W.markRead('cron-away0');
    W.pruneRoutineSessions({});
    A.eq(W.get('cron-away0'), null, 'opened, it is pruned like any receipt');
    W.init(JSON.parse(JSON.stringify(W.serialize())));
    await I.backfill({ sleep: () => Promise.resolve(), waits: [] });
    A.eq(W.get('cron-away0'), null, 'a failure this page showed and pruned is not imported again on the next boot');
    A.eq(routineRows().length, 0, 'and NEEDS YOU does not list it again');
  }

  AutoSessions.reset();
  A.report('routine-receipts-unopened.test (R56-1-D2)');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
