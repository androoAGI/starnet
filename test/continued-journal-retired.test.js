/* node test/continued-journal-retired.test.js — a continued run's SOURCE journal retires (2026-09-22).

   remove() used to refuse every status but 'finished', so an interrupted run's journal stayed on disk forever after
   its continuation completed (status 'resolved'/'resumable', continuation 'finished'). Now the source retires once
   its continuation finished AND that continuation's own transcript acknowledgement was durably recorded first —
   the same ordering finishAndRetire uses for an ordinary run. Proven here on the real fs writer:
     A. automatic (resumable) source: continuation finished WITHOUT the acknowledgement stays (not retirable);
        with it, retirable -> removed; a second remove is a no-op;
     B. reviewed (resolved) source retires the same way; its `.torn-*` copy (if any) goes with it;
     C. never retired: unresolved needs_review, a started-but-unfinished continuation, a forensic journal;
     D. the listing/boot path: a fresh instance (a restart after a crash between continuation_finish and unlink)
        sees `retirable` and completes the idempotent retirement;
     E. host wiring (index.js source): the continuation's transcript ack is recorded after finishAndRetire and
        consumed by settleRunRecoveryContinuation, which records continuation_finish with it BEFORE removing the
        source; the listing and boot scan retire on `retirable`. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/run-recovery.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-continued-retire-'));
let tick = 100;
const clock = { now: () => ++tick };
const fileOf = runId => path.join(root, J._internals.runFileName(runId));

function automaticSource(j, runId) {
  j.begin({ runId, agentId: 'agent', streamId: 's' });
  j.checkpoint(runId, { phase: 'initial', turn: 0, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }] });
  j.checkpointMessages(runId, { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: 'partial work' }] });
}
function reviewedSource(j, runId) {
  j.begin({ runId, agentId: 'agent', streamId: 's' });
  j.checkpoint(runId, { phase: 'initial', turn: 0, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }] });
  j.checkpointMessages(runId, { phase: 'assistant', turn: 1, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'm1', type: 'function', function: { name: 'shell_exec', arguments: '{}' } }] }] });
  j.toolIntent(runId, { callId: 'm1', name: 'shell.exec', argsRaw: '{}', replayFingerprint: Recovery.replayFingerprint('shell.exec', '{}'), mutating: true, boundaryModel: J.DISPATCH_BOUNDARY_MODEL });
  j.toolDispatch(runId, { callId: 'm1', name: 'shell.exec', mutating: true });
}
function continueIt(j, runId, mode, ack) {
  let state = j.inspect(runId);
  const plan = mode === 'automatic' ? Recovery.automaticContinuationPlan(state) : Recovery.continuationPlan(state);
  j.prepareContinuation(runId, { continuationId: 'c-' + runId, mode, blockedFingerprints: plan.blockedFingerprints, context: plan.context });
  j.startContinuation(runId, { continuationId: 'c-' + runId, continuedRunId: 'next-' + runId });
  if (ack === 'start-only') return j.inspect(runId);
  state = j.finishContinuation(runId, { continuationId: 'c-' + runId, continuedRunId: 'next-' + runId, reason: 'done', transcriptAck: ack === true });
  return state;
}

try {
  // ---- A. automatic source ---------------------------------------------------------------------------------
  {
    const j = J.makeRunJournal({ dir: root, clock });
    automaticSource(j, 'auto-noack');
    const noAck = continueIt(j, 'auto-noack', 'automatic', false);
    A.eq([noAck.status, noAck.continuation.state, noAck.retirable], ['resumable', 'finished', false], 'a continuation finished without its transcript acknowledgement does not settle the source');
    A.eq(j.remove('auto-noack'), false, 'remove refuses an unacknowledged source');
    A.ok(fs.existsSync(fileOf('auto-noack')), 'the unacknowledged source stays discoverable');

    automaticSource(j, 'auto-ack');
    const acked = continueIt(j, 'auto-ack', 'automatic', true);
    A.eq([acked.continuation.transcriptAck, acked.retirable], [true, true], 'continuation_finish durably carries the acknowledgement and the source becomes retirable');
    A.eq(j.remove('auto-ack'), true, 'the settled automatic source retires');
    A.ok(!fs.existsSync(fileOf('auto-ack')), 'its journal file is gone');
    A.eq(j.remove('auto-ack'), false, 'a second retirement is a harmless no-op');
  }

  // ---- B. reviewed source (+ its torn copy) ------------------------------------------------------------------
  {
    const writer = J.makeRunJournal({ dir: root, clock });
    reviewedSource(writer, 'reviewed');
    fs.appendFileSync(fileOf('reviewed'), '{"v":1,"runId":"reviewed","se', 'utf8');   // a torn final record
    const j = J.makeRunJournal({ dir: root, clock });   // restart
    j.recoverAll();
    j.resolve('reviewed', { resolutionId: 'r-1', outcomes: [{ callId: 'm1', outcome: 'happened' }] });
    const settled = continueIt(j, 'reviewed', 'reviewed', true);
    A.eq([settled.status, settled.retirable], ['resolved', true], 'a resolved source whose continuation settled is retirable');
    A.ok(fs.readdirSync(root).some(n => n.indexOf(J._internals.runFileName('reviewed') + '.torn-') === 0), 'the torn copy existed before retirement');
    A.eq(j.remove('reviewed'), true, 'the settled reviewed source retires');
    A.eq(fs.readdirSync(root).filter(n => n.indexOf(J._internals.runFileName('reviewed')) === 0), [], 'the journal and its torn copy are both gone');
  }

  // ---- C. never retired ----------------------------------------------------------------------------------------
  {
    const j = J.makeRunJournal({ dir: root, clock });
    reviewedSource(j, 'unresolved');
    const unresolved = j.inspect('unresolved');
    A.eq([unresolved.status, unresolved.retirable], ['needs_review', false], 'an unresolved needs_review journal is not retirable');
    A.eq(j.remove('unresolved'), false, 'remove refuses unresolved review evidence');

    automaticSource(j, 'in-flight');
    const started = continueIt(j, 'in-flight', 'automatic', 'start-only');
    A.eq([started.continuation.state, started.retirable], ['started', false], 'a started-but-unfinished continuation keeps its source');
    A.eq(j.remove('in-flight'), false, 'remove refuses a source whose continuation has not finished');

    automaticSource(j, 'forensic');
    const f = fileOf('forensic');
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    lines.splice(1, 0, '{mid-file damage');
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
    const k = J.makeRunJournal({ dir: root, clock });
    k.recoverAll();   // repairs to the valid prefix, keeps the .corrupt-* evidence
    const state = k.inspect('forensic');
    A.eq([state.forensic, state.retirable], [true, false], 'a forensic journal is never retirable');
    A.throws(() => k.prepareContinuation('forensic', { continuationId: 'c-forensic', mode: 'automatic' }), 'a forensic source can never even reach a continuation');
    A.eq(k.remove('forensic'), false, 'remove refuses forensic evidence');
  }

  // ---- D. crash between continuation_finish and unlink: the next listing/boot completes the retirement ------
  {
    const j = J.makeRunJournal({ dir: root, clock });
    automaticSource(j, 'crash-before-unlink');
    continueIt(j, 'crash-before-unlink', 'automatic', true);   // ... and the process dies before remove()
    const restarted = J.makeRunJournal({ dir: root, clock });
    const row = restarted.recoverAll().find(r => r.runId === 'crash-before-unlink');
    A.eq(row.retirable, true, 'a restart sees the settled source as retirable');
    A.eq(restarted.remove('crash-before-unlink'), true, 'the idempotent retirement completes after restart');
  }

  // ---- E. host wiring ----------------------------------------------------------------------------------------
  {
    const src = readSidecarSource();
    const settle = A.fnBody(src, 'function settleRunRecoveryContinuation(');
    A.ok(settle.length > 200 && settle.length < 4000, 'settleRunRecoveryContinuation located');
    const iAck = settle.indexOf('continuationTranscriptAcks.delete(');
    const iFinish = settle.indexOf('runJournal.finishContinuation(');
    const iRemove = settle.indexOf('runJournal.remove(sourceRunId)');
    A.ok(iAck >= 0 && iFinish > iAck && iRemove > iFinish, 'settle consumes the ack proof, records continuation_finish with it, and only then removes the source');
    A.ok(/finishContinuation\(sourceRunId, \{[^}]*transcriptAck[^}]*\}\)/.test(settle), 'continuation_finish carries the transcript acknowledgement');
    A.ok(/if \(!settled\.retirable \|\| settled\.forensicOnly\) return;/.test(settle), 'the source is removed only when the journal itself says it is retirable (and never with forensic evidence)');
    const core = A.fnBody(src, 'async function runOnceCore(');
    const iRetire = core.indexOf('runJournal.finishAndRetire(runId');
    const iAdd = core.indexOf('continuationTranscriptAcks.add(runId)');
    A.ok(iRetire > 0 && iAdd > iRetire, 'the ack proof is recorded only after the continuation\'s own finish record (with transcriptAck) is durable');
    A.ok(/o\.recovery && retirement\.state && retirement\.state\.finish && retirement\.state\.finish\.transcriptAck === true/.test(core), 'the proof requires the durable transcriptAck on the continuation\'s finish record');
    const listing = A.fnBody(src, 'function serveRunRecoveries(');
    A.ok(/if \(r\.retirable && !r\.forensicOnly\)/.test(listing), 'the recovery listing retires any retirable, non-forensic journal (finished or settled source)');
    const scan = A.fnBody(src, 'function scanInterruptedRuns(');
    A.ok(/r\.retirable && !r\.forensicOnly && runJournal\.remove\(r\.runId\)/.test(scan), 'the boot scan finishes an interrupted retirement');
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

A.report('continued-journal-retired.test');
