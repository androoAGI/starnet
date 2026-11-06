/* node test/forget.line-jobs.test.js - A DELETED CHAT TAKES THE JOB IT LEFT WAITING AT A REVIEWER'S GATE (turn identity commit 12 x line-hold, contract A14 iv).

   A job a work line HELD for a person keeps, in its saved walk (line-jobs.json), the words of the chat that started it: the ask, the products,
   the draft under review. The line-jobs entry of the forget registry ends an unfinished job of a deleted chat with the station's existing refusal:

     1. a held job of the deleted chat: after the purge it is ENDED (failed, stopped 'refused'), its walk and its words are gone from the record
        and from the file on disk, and a decision on it is refused ('nothing waiting for a decision') - nothing is bought, nothing is delivered;
     2. a held job of ANOTHER chat is untouched and still waits for its decision;
     3. the purge is idempotent, and a restart (the file read back through the store) reads the same ended record;
     4. a job whose line run READ a deleted session (the run is in the scope) goes the same way;
     5. a FINISHED job of the deleted chat is filed under the line and stays;
     6. the wiring: the entry is registered, the old exemption of the store is gone, and the resume's run reader goes through runView.

   The test is RED with the entry removed: the first assertion that the purge ended the job fails. Real modules throughout: the rig is the line-hold
   lane's (real router, chain and LineRunner over the station's verified job writer); only the provider and the clock are fakes. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { makeRig } = require('./helpers/line-hold-rig.js');
const SessionTombstones = require('../sidecar/session-tombstones.js');
const ForgetRegistry = require('../sidecar/forget-registry.js');
const Wiring = require('../sidecar/forget-wiring.js');
const { readSidecarIndex } = require('./helpers/source.js');

const REVISE = 'not yet\nVERDICT: revise', BLOCKED = 'no\nVERDICT: blocked', DRAFT = 'another draft';
const get = (env, id) => J.get(env.host.jobs(), id);
const noise = (tag, e) => { throw new Error(tag + ': ' + (e && e.message)); };

// one job down the line to its hold, settled the way the hub settles it
async function held(env, rig) {
  const ran = await rig.run({ replies: [REVISE, BLOCKED] });
  rig.settle(ran.job, ran.line);
  A.ok(ran.line.held && !ran.line.holdFailed && get(env, ran.job.id).status === 'held', 'a job is parked as a hold: ' + (ran.line.holdFailed || ''));
  return ran;
}

// the registry over a real ledger with ONE delete of `streamId`, and the line-jobs entry over the host's own mutator
function registryFor(env, streamId, runs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-forget-linejobs-'));
  let clock = Date.now() + 1000;
  const ledger = SessionTombstones.makeSessionTombstones({ fs, path, file: path.join(dir, 'session-tombstones.json'), now: () => clock });
  ledger.observe([], []);
  clock += 5000;
  ledger.observe([streamId]);
  const scope = SessionTombstones.deletedScope(ledger.unpurged(), runs || []);
  const registry = ForgetRegistry.make({ deletedAt: id => ledger.deletedAt(id), freshDeletedAt: id => ledger.freshAt(id), latestDeleteAt: () => ledger.latestAt(),
    runForgotten: runId => scope.runIds.has(runId), note: noise });
  const deps = { now: () => clock, notebookStore: () => null, threadsStore: () => null, memoryAgentIds: () => [], personalization: () => ({ markForgotten: async () => {} }),
    lineJobs: () => ({ forget: (bound, why) => J.forgetVia(env.host.mutate, bound, why, clock) }) };
  Wiring.wireForgetRegistry(registry, new Proxy(deps, { get: (t, k) => (k in t ? t[k] : undefined) }));
  registry.seal();
  return { registry, scope, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  // ---- 1-3. a held job of the deleted chat is ended; another chat's stays; the purge is idempotent and survives a restart ----
  await allocated(async env => {
    const rig = makeRig({}).wire(env.host);
    const mine = await held(env, rig), other = await held(env, rig);
    const owner = rig.owner(env.host);
    A.ok(mine.streamId !== other.streamId, 'two jobs, two chats');
    const c0 = get(env, mine.job.id).continuation;
    A.eq([c0.phase, c0.binding.streamId, c0.walk.lastHanded], ['held', mine.streamId, DRAFT], 'the job waits at its gate with the draft under review, filed under its chat');
    A.ok(fs.readFileSync(env.jobFile, 'utf8').includes(DRAFT), 'before the delete the saved file holds the draft');
    const { registry, scope, dispose } = registryFor(env, mine.streamId, []);
    try {
      A.ok(registry.names().includes('line-jobs'), 'the line-job store is a registered entry of the forget registry');
      A.eq(await registry.entry('line-jobs').forget(scope), 1, 'the purge ended the one job the deleted chat left waiting');
      const job = get(env, mine.job.id);
      A.eq([job.status, job.outcome, job.stop && job.stop.code, Object.prototype.hasOwnProperty.call(job, 'continuation'), job.text, job.output],
        ['failed', 'failed', 'refused', false, '', ''], 'the job is ENDED with the existing refusal: no walk, no ask, no output');
      A.ok(job.endedAt > 0 && /deleted/.test(job.error), 'it has an end time and says why');
      const disk = JSON.stringify(env.raw(env.jobFile).jobs.find(j => j.id === mine.job.id));   // this job's record as the file holds it (the other chat's job keeps its words)
      A.ok(!disk.includes(DRAFT) && !disk.includes('write a post') && !disk.includes('VERDICT: blocked'), 'the saved record holds none of its words: not the draft, not the ask, not the reviewer block');
      const r = owner.resume(mine.job.id, { action: 'approve', token: 'tok-after-delete', revision: c0.revision, note: '' });
      A.eq([r.code, /nothing waiting for a decision/.test(String(r.error))], [409, true], 'a decision on it is refused: nothing waits for one');
      A.eq(rig.calls.length, 4, 'nothing was bought by that decision: the four provider calls are the two jobs\' stages before their holds');
      // the other chat
      const kept = get(env, other.job.id);
      A.eq([kept.status, kept.continuation.phase, kept.continuation.walk.lastHanded], ['held', 'held', DRAFT], 'another chat\'s held job is untouched and still waits');
      A.eq(await registry.entry('line-jobs').forget(scope), 0, 'idempotent');
      // a restart: the file read back through the store is the same ended record
      const again = J.normalizeAll(env.raw(env.jobFile)).jobs.find(j => j.id === mine.job.id);
      A.eq([again.status, again.stop && again.stop.code, Object.prototype.hasOwnProperty.call(again, 'continuation')], ['failed', 'refused', false], 'a restart reads the same ended record');
    } finally { dispose(); rig.dispose(); }
  });

  // ---- 4. a job whose line run READ the deleted session (its run is in the scope) is ended the same way ----
  await allocated(async env => {
    const rig = makeRig({}).wire(env.host);
    const mine = await held(env, rig);
    const { registry, scope, dispose } = registryFor(env, 'some-other-chat', [{ runId: mine.runId, streamId: 'a-chat-that-stays', ts: 1000, quotes: ['some-other-chat'], quotesAt: [1] }]);
    try {
      A.ok(scope.runIds.has(mine.runId), 'the scope holds the entry run that read the deleted session');
      A.eq(await registry.entry('line-jobs').forget(scope), 1, 'the job whose entry run read it is ended too');
      A.eq(get(env, mine.job.id).status, 'failed', 'ended');
    } finally { dispose(); rig.dispose(); }
  });

  // ---- 5. a FINISHED job of the deleted chat is filed under the line and stays ----
  await allocated(async env => {
    const rig = makeRig({}).wire(env.host);
    const ran = await rig.run({ replies: ['all done\nVERDICT: approved'] });
    rig.settle(ran.job, ran.line);
    const done = get(env, ran.job.id);
    A.ok(done.status !== 'held' && done.endedAt, 'the job finished: ' + done.status);
    const { registry, scope, dispose } = registryFor(env, ran.streamId, []);
    try {
      A.eq(await registry.entry('line-jobs').forget(scope), 0, 'a finished job is not touched by the purge');
      A.eq(get(env, ran.job.id).status, done.status, 'it keeps its status and what it delivered (filed under the line)');
    } finally { dispose(); rig.dispose(); }
  });

  // ---- 6. the wiring ----
  {
    const wiring = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'forget-wiring.js'), 'utf8');
    A.ok(/\['lineJobStore', 'entry', 'line-jobs'\]/.test(wiring) && !/\['lineJobStore', 'exempt'/.test(wiring), 'the census row for the line-job store is an entry, not the old exemption');
    A.ok(!/filed under the line, not under a conversation session/.test(wiring), 'the old exemption text is gone');
    const index = readSidecarIndex();
    A.ok(index.includes("runRow: runId => runView('lineResume', runStore.latest(runId))"), 'the held job\'s resume reads its run through runView: a forgotten run refuses the resume');
    A.ok(/lineJobs: \(\) => \(\{ forget: \(bound, why\) => \{\s*try \{ return LineJobs\.forgetVia\(lineJobsSet,/.test(index), 'the host hands the entry the verified job writer (lineJobsSet)');
    A.ok(/ELINE_CONTINUATION_READONLY[^\n]*ELINE_ENTRY_READONLY[^\n]*failNote\('forget\.line-jobs\.readonly'/.test(index), 'a store the station cannot rewrite losslessly is preserved and said so, not retried for ever');
  }

  // ---- 7. a store the station will not rewrite (a duplicate or future-version record, preserved by design) refuses the purge with the code the host answers ----
  {
    const dup = { id: 'job-dup0000001', line: 'a', status: 'held', continuation: { version: 99 } };
    const state = J.normalizeAll({ jobs: [dup, dup] });
    let code = null;
    try { J.forgetUnfinished(state, () => true, 'gone', 1); } catch (e) { code = e && e.code; }
    A.eq(code, 'ELINE_CONTINUATION_READONLY', 'the pure purge never rewrites a store that must be preserved; the host notes it and the pass goes on');
  }

  A.report('forget.line-jobs');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
