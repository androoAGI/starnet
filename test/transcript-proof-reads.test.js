/* node test/transcript-proof-reads.test.js — A DELETE FORGETS WHAT A MODEL READS, NOT WHAT THE STATION PROVED.

   A deleted session's rows are forgotten by every read that hands rows on (qa/bugs/3e926b6a). Two readers never hand a
   row to anyone — they only ask "is this already durable?" — and they read through the same filter, so for a run that
   belongs to a deleted session:
     1. recoverPendingDeliveries never found the accepted final row: the delivery stayed pending forever, and
        finalizeDispatchDelivery saw no prior row, appended a SECOND final row after the delete stamp (visible again)
        and skipped the "first accepted answer cannot be replaced" check.
     2. a recovery continuation's markRecorded got no source rows, so the continuation re-appended every source turn
        after the delete stamp: the deleted words came back, duplicated.
   This proves, on the real modules (temp dirs, real fs, the real tombstone ledger), that a PROOF read (history with
   proof:true) sees the real rows, that every ordinary read still forgets them, and that the host's recovery read and
   both delivery readers ask for a proof read. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const A = require('./_assert.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeSessionTombstones } = require('../sidecar/session-tombstones.js');
const { makeRunStore } = require('../sidecar/runstore.js');
const { finalizeDispatchDelivery, recoverPendingDeliveries } = require('../sidecar/dispatch-delivery.js');
const { makeRunTranscript } = require('../sidecar/transcript-run.js');

const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const clockAt = start => { let t = start; return { now: () => t, set: v => { t = v; } }; };
function memIo() { const lines = []; return { lines, readAll() { return lines.slice(); }, append(e) { lines.push(e); } }; }

function world(label, makeIo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-proofread-' + label + '-'));
  const clock = clockAt(100);
  const ledger = makeSessionTombstones({ fs, path, file: path.join(dir, 'tomb.json'), now: clock.now });
  ledger.observe([]);   // the boot read of a station with no earlier deletes
  const io = makeIo(dir);
  const transcriptStore = makeTranscriptStore({ io, clock, deletedAt: id => ledger.deletedAt(id) });
  const runIo = memIo();
  const runStore = makeRunStore({ io: runIo, clock });
  const tick = () => clock.set(clock.now() + 10);
  return { dir, clock, ledger, transcriptStore, runStore, tick, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

(async () => {
  for (const [label, makeIo] of [['ram', () => memIo()], ['segmented', dir => makeSegmentedTranscriptIo({ fs, path, root: path.join(dir, 'history'), segmentBytes: 700, recentPerStream: 4 })]]) {
    // ---------------- 1. a pending delegated delivery in a session the Commander deleted ----------------
    {
      const w = world('delivery-' + label, makeIo);
      try {
        const text = JSON.stringify({ answer: 'the accepted otter census' });
        w.tick();
        w.runStore.record({ runId: 'd1', agentId: 'worker', streamId: 'ws_gone', reason: 'done', usd: 0.01, startedAt: w.clock.now(), dispatchDelivery: { state: 'pending' }, deliveryPrompt: 'count the otters' });
        w.tick();
        // the accepted answer landed durably, then the station stopped before the run envelope was finalized
        w.transcriptStore.appendStrict({ streamId: 'ws_gone', agentId: 'worker', role: 'assistant', sourceRunId: 'd1', content: text, dispatchState: 'final',
          dispatchPrompt: 'count the otters', dispatchReason: 'done', dispatchRepairRunId: '', textLength: text.length, textSha256: hash(text), taint: null });
        w.tick(); w.ledger.observe(['ws_gone']); w.tick();   // the Commander deletes the session

        A.eq(w.transcriptStore.history('ws_gone', { sourceRunId: 'd1' }).length, 0, label + ': an ordinary read of the deleted session forgets the accepted row');
        A.eq(w.transcriptStore.history('ws_gone', { sourceRunId: 'd1', dispatchState: 'final', limit: 1, strict: true, proof: true }).length, 1, label + ': a proof read still sees the durable accepted row');

        const recovered = recoverPendingDeliveries({ runStore: w.runStore, transcriptStore: w.transcriptStore, hash, onFailure: e => A.ok(false, label + ': recovery failed: ' + e.message) });
        A.eq(recovered, 1, label + ': boot recovery finalizes the pending delivery from its accepted row (it used to stay pending forever)');
        A.eq(w.runStore.latest('d1').dispatchDelivery.state, 'final', label + ': the run envelope is final');

        // a late finalize with a DIFFERENT answer is refused: the first accepted answer cannot be replaced
        w.runStore.record({ runId: 'd2', agentId: 'worker', streamId: 'ws_gone2', reason: 'done', usd: 0.01, startedAt: w.clock.now(), dispatchDelivery: { state: 'pending' }, deliveryPrompt: 'count the herons' });
        w.tick();
        const first = JSON.stringify({ answer: 'first heron count' });
        w.transcriptStore.appendStrict({ streamId: 'ws_gone2', agentId: 'worker', role: 'assistant', sourceRunId: 'd2', content: first, dispatchState: 'final',
          dispatchPrompt: 'count the herons', dispatchReason: 'done', dispatchRepairRunId: '', textLength: first.length, textSha256: hash(first), taint: null });
        w.tick(); w.ledger.observe(['ws_gone', 'ws_gone2']); w.tick();
        A.throws(() => finalizeDispatchDelivery({ runStore: w.runStore, transcriptStore: w.transcriptStore, redact: t => t, hash }, 'd2', { text: JSON.stringify({ answer: 'a different heron count' }), reason: 'done' }),
          label + ': a deleted session\'s first accepted answer still cannot be replaced');
        const again = finalizeDispatchDelivery({ runStore: w.runStore, transcriptStore: w.transcriptStore, redact: t => t, hash }, 'd2', { text: first, reason: 'done' });
        A.eq(again && again.dispatchDelivery.state, 'final', label + ': finalizing the same answer settles the envelope');
        const finals = w.transcriptStore.history('ws_gone2', { sourceRunId: 'd2', limit: 50, proof: true }).filter(r => r.dispatchState === 'final');
        A.eq(finals.length, 1, label + ': no second final row is appended after the delete stamp');
        A.eq(w.transcriptStore.history('ws_gone2').length + w.transcriptStore.search('x', 'heron', { scope: 'all' }).length, 0, label + ': the deleted session stays forgotten for history and recall');
      } finally { w.dispose(); }
    }

    // ---------------- 2. a recovery continuation of an interrupted run in a deleted session ----------------
    {
      const w = world('recovery-' + label, makeIo);
      try {
        const src = makeRunTranscript({ store: w.transcriptStore, streamId: 'ws_gone', agentId: 'agent', runId: 'src1' });
        const call = { id: 'c1', type: 'function', function: { name: 'fs_write', arguments: '{"path":"a.txt"}' } };
        const sourceTurns = [{ role: 'user', content: 'write the badger report' }, { role: 'assistant', content: '', tool_calls: [call] }, { role: 'tool', tool_call_id: 'c1', content: 'wrote a.txt' }];
        w.tick();
        src.setDirective('write the badger report');
        src.start(sourceTurns.slice(0, 1).map(m => Object.assign({}, m)).concat([]));
        w.tick();
        src.checkpoint({ phase: 'tool_results', messages: sourceTurns.slice(1).map(m => Object.assign({}, m)) });
        const written = w.transcriptStore.history('ws_gone', { limit: 50 }).length;
        A.ok(written >= 3, label + ': the source run wrote its directive and turns (' + written + ')');
        w.tick(); w.ledger.observe(['ws_gone']); w.tick();   // deleted while the run awaited review

        // the host's recovery read (index.js transcriptRecoveryTail) asks for a proof read
        const proofRows = w.transcriptStore.history('ws_gone', { sourceRunId: 'src1', limit: 5000, proof: true });
        A.eq(w.transcriptStore.history('ws_gone', { sourceRunId: 'src1', limit: 5000 }).length, 0, label + ': an ordinary sourceRunId read forgets the deleted rows');
        A.ok(proofRows.length >= 3, label + ': the proof read sees every row the source wrote');
        const cont = makeRunTranscript({ store: w.transcriptStore, streamId: 'ws_gone', agentId: 'agent', runId: 'cont1' });
        const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'write the badger report' }].concat(sourceTurns.slice(1).map(m => Object.assign({}, m)));
        cont.adoptRecovery(msgs, { base: 2, rows: proofRows });
        cont.setDirective('write the badger report');
        const appended = cont.start(msgs);
        A.eq(appended, 0, label + ': the continuation re-appends nothing its source already proved durable');
        A.eq(w.transcriptStore.history('ws_gone', { limit: 50 }).length, 0, label + ': the deleted words never come back after the delete stamp');
      } finally { w.dispose(); }
    }
  }

  // ---------------- 3. the host asks for proof reads (static) ----------------
  {
    const idx = readSidecarSource();
    const tail = idx.slice(idx.indexOf('function transcriptRecoveryTail('), idx.indexOf('function transcriptRecoveryTail(') + 900);
    A.ok(/transcriptStore\.history\(streamId, \{ sourceRunId: src, limit: 5000, proof: true \}\)/.test(tail), 'transcriptRecoveryTail reads its source rows with a proof read');
    const dd = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'dispatch-delivery.js'), 'utf8');
    A.eq((dd.match(/dispatchState: 'final', limit: 1, strict: true, proof: true,/g) || []).length, 2, 'finalize and boot recovery both read the accepted row with a proof read');
  }

  A.report('transcript-proof-reads');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
