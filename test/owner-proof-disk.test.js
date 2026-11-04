'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js'), Learning = require('../sidecar/trusted-learning.js');
const { sidecarFunctionSource } = require('./helpers/source.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-proof-disk-'));
const io = History.makeSegmentedTranscriptIo({ fs, path, root, segmentBytes: 1024 * 1024 });
const runs = [], briefs = [];
const store = Store.makeTranscriptStore({ io, clock: { now: () => 100 }, ramPerStream: 2, ramMax: 3,
  runOf: id => runs.find(row => row.runId === id), quotedMaterial: Learning.quotedMaterial });
function owner(runId, content) {
  runs.push({ runId, streamId: 's', agentId: 'agent', ownerDirective: true, internal: false });
  return store.appendStrict({ role: 'user', kind: 'turn', directive: true, sourceRunId: runId, streamId: 's', agentId: 'agent', content, taint: null });
}
try {
  const first = owner('one', 'Please prepare the weekly release'), second = owner('two', 'Please prepare the weekly release');
  A.eq(first.taintKnown, true, 'fixture uses the real writer checked-clean stamp');
  for (let i = 0; i < 12; i++) owner('later-' + i, 'later work ' + i);
  for (const [runId, row] of [['one', first], ['retry-one', first], ['two', second]]) briefs.push({ id: 'tb_' + runId,
    originalRunId: runId, agentId: 'agent', streamId: 's', directiveRowId: row.rowId, originalDirective: row.content });
  briefs.push({ id: 'tb_missing', originalRunId: 'one', agentId: 'agent', streamId: 's', directiveRowId: 99999, originalDirective: first.content });
  const sandbox = { Map, Set, transcriptStore: store, runView: (name, r) => r, runStore: { all: () => runs }, taskBriefStore: { list: () => briefs }, failNote(tag, error) { throw error; } };
  vm.createContext(sandbox); vm.runInContext(sidecarFunctionSource('evidenceRows'), sandbox);
  const ev = sandbox.evidenceRows({});
  A.ok(!ev.ownerRecent.some(row => row.rowId === first.rowId), 'original occasion is older than the actual RAM recency mirror');
  A.ok(ev.transcript.some(row => row.rowId === first.rowId), 'the real host assembly proves that old occasion from disk');
  const owned = Learning.ownedBriefs(briefs, ev.transcript, ev.runs);
  A.eq(owned.length, 2, 'repeat-work count equals distinct clean original directive IDs; a retry counts once');
  A.ok(!owned.some(brief => brief.id === 'tb_missing'), 'a missing explicit ID never falls back to identical directive text');
  A.eq(Learning.ownedBriefs([briefs[1]], ev.transcript, ev.runs).length, 1, 'a retry brief can prove the original directive without inventing a retry-run row');
  let originalReads = 0;
  const legacyBriefs = Array.from({ length: 80 }, (_, i) => ({ id: 'tb_legacy-' + i, originalRunId: 'legacy-' + i, agentId: 'agent', streamId: 's', originalDirective: 'old' }));
  sandbox.taskBriefStore = { list: () => legacyBriefs };
  sandbox.transcriptStore = { ownerProof: () => new Map(), view(name, sid, opts) { if (opts.sourceRunId) originalReads++; return []; } };
  sandbox.evidenceRows({});
  A.eq(originalReads, 60, 'one host assembly bounds legacy original-run reads to sixty');
} finally { io.close(); fs.rmSync(root, { recursive: true, force: true }); }
A.report('owner-proof-disk');
