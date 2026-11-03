'use strict';
/* Original directive evidence comes from current disk bytes, with a bounded per-assembly read budget. */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
let Store = require('../sidecar/transcriptstore.js');
const Learning = require('../sidecar/trusted-learning.js');
const actual = require.resolve('../sidecar/transcript-history.js');
let History = require(actual);
if (process.env.TURN_OWNER_CONTROL_DIR) {
  const m = new Module(actual, module); m.filename = actual; m.paths = Module._nodeModulePaths(path.dirname(actual));
  m._compile(fs.readFileSync(path.join(process.env.TURN_OWNER_CONTROL_DIR, 'turn-identity-c6-transcript-history-pre-review.js.txt'), 'utf8'), actual); History = m.exports;
  const filename = require.resolve('../sidecar/transcriptstore.js'), storeModule = new Module(filename, module);
  storeModule.filename = filename; storeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  storeModule._compile(fs.readFileSync(path.join(process.env.TURN_OWNER_CONTROL_DIR, 'turn-identity-c6-transcriptstore-pre-review.js.txt'), 'utf8'), filename); Store = storeModule.exports;
}
if (process.env.TURN_OWNER_SUMMARY_CONTROL) {
  const m = new Module(actual, module); m.filename = actual; m.paths = Module._nodeModulePaths(path.dirname(actual));
  m._compile(fs.readFileSync(process.env.TURN_OWNER_SUMMARY_CONTROL, 'utf8'), actual); History = m.exports;
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-owner-proof-'));
const opened = [];
const owner = { runId: 'owner-run', agentId: 'agent', streamId: 's', ownerDirective: true, internal: false };
const makeStore = io => Store.makeTranscriptStore({ io, clock: { now: () => 100 }, quotedMaterial: Learning.quotedMaterial,
  runOf: id => id === owner.runId ? owner : null });
function fixture(name, segmentBytes) {
  const reads = [], warnings = [], trackedFs = Object.create(fs);
  trackedFs.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(String(file)); return fs.readFileSync(file, ...args); };
  const io = History.makeSegmentedTranscriptIo({ fs: trackedFs, path, root: path.join(root, name), segmentBytes,
    onWarning: message => warnings.push(message), schedule() {} });
  opened.push(io); return { io, store: makeStore(io), reads, warnings };
}
const append = (store, extra) => store.appendStrict(Object.assign({ streamId: 's', agentId: 'agent', sourceRunId: owner.runId,
  role: 'user', content: 'OWNER_A', kind: 'turn', directive: true, taint: null }, extra));
try {
  const warm = fixture('active', 65536), row = append(warm.store), activeFile = warm.io._internals.segFile(warm.io.status().activeSegment);
  A.eq(warm.store.ownerProof([row.rowId]).get(row.rowId).content, 'OWNER_A', 'initial disk-backed owner proof');
  const original = fs.readFileSync(activeFile, 'utf8'), changed = original.replace('OWNER_A', 'OWNER_B');
  A.eq(Buffer.byteLength(changed), Buffer.byteLength(original), 'mutation preserves exact active-file byte length');
  fs.writeFileSync(activeFile, changed);
  A.eq(warm.store.ownerProof([row.rowId]).get(row.rowId).content, 'OWNER_B', 'warm active cache cannot substitute former bytes for current owner proof');
  const corrupt = '!' + changed.slice(1); fs.writeFileSync(activeFile, corrupt);
  A.eq(warm.store.ownerProof([row.rowId]).size, 0, 'same-size active corruption leaves no owner proof');
  A.ok(warm.warnings.some(w => w.includes('owner proof')), 'failed owner segment proof is observable');

  const closed = fixture('closed', 256), old = append(closed.store, { content: 'first owner ' + 'x'.repeat(300) });
  append(closed.store, { content: 'second owner ' + 'x'.repeat(300) });
  A.ok(closed.store.ownerProof([old.rowId]).has(old.rowId), 'closed owner segment proves before corruption');
  const closedMeta = closed.io.status().segments.find(s => old.rowId >= s.minRowId && old.rowId <= s.maxRowId);
  const closedFile = closed.io._internals.segFile(closedMeta.number), closedBytes = fs.readFileSync(closedFile, 'utf8');
  fs.writeFileSync(closedFile, '!' + closedBytes.slice(1));
  A.eq(closed.store.ownerProof([old.rowId]).size, 0, 'closed-segment corruption cannot return cached owner evidence');

  const bounded = fixture('bounded', 256), ids = [];
  for (let i = 0; i < 9; i++) ids.push(append(bounded.store, { content: 'owner ' + i + ' ' + 'x'.repeat(300) }).rowId);
  bounded.reads.length = 0;
  const proofs = bounded.store.ownerProof(ids);
  A.eq(proofs.size, 8, 'a ninth distinct segment remains explicitly unproven');
  A.eq(bounded.reads.length, 8, 'one strict disk read per accepted segment, at most eight per assembly');
  A.eq(new Set(bounded.reads).size, 8, 'same segment is never repeatedly parsed for each requested id');

  // A pre-summary history may need more disk reads to prove that no later retract names a target.
  // The proof budget is a hard ceiling: inability to establish that absence is not an empty retract set.
  const oldSummary = fixture('old-summary', 256), oldIds = [];
  for (let i = 0; i < 9; i++) oldIds.push(append(oldSummary.store, { content: 'old index ' + i + ' ' + 'x'.repeat(300) }).rowId);
  oldSummary.io.close();
  const manifestFile = oldSummary.io._internals.manifestFile, manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  A.ok(manifest.segments.length >= 8, 'old-summary fixture contains more closed history than one proof can scan');
  for (const meta of manifest.segments) delete meta.retracts;
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const reopened = History.makeSegmentedTranscriptIo({ fs, path, root: path.join(root, 'old-summary'), segmentBytes: 256, schedule() {} });
  opened.push(reopened);
  A.eq(makeStore(reopened).ownerProof(oldIds).size, 0, 'unvouched old retract summaries beyond the shared budget produce no owner proof');

  const batch = fixture('one-segment', 65536), batchIds = [];
  for (let i = 0; i < 3; i++) batchIds.push(append(batch.store, { content: 'same segment owner ' + i }).rowId);
  batch.reads.length = 0;
  A.eq(batch.store.ownerProof(batchIds).size, 3, 'all requested rows in one segment are proven together');
  A.eq(batch.reads.length, 1, 'multiple ids share one fresh segment parse');

  const changedSummary = fixture('changed-summary', 256), summaryTarget = append(changedSummary.store, { content: 'summary target ' + 'x'.repeat(300) });
  const retractRow = append(changedSummary.store, { kind: 'retract', role: 'system', content: '', targets: [summaryTarget.rowId], reason: 'undo' });
  append(changedSummary.store, { content: 'active filler ' + 'x'.repeat(300) }); changedSummary.io.close();
  const summaryFile = changedSummary.io._internals.manifestFile, summaryManifest = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const altered = summaryManifest.segments.find(s => retractRow.rowId >= s.minRowId && retractRow.rowId <= s.maxRowId);
  A.ok(altered && altered.number !== changedSummary.io.status().activeSegment, 'altered summary belongs to a closed retract segment');
  altered.retracts = { v: 1, targets: [] }; // well-formed false absence; retained checksum still names the real summary
  fs.writeFileSync(summaryFile, JSON.stringify(summaryManifest));
  const summaryIo = History.makeSegmentedTranscriptIo({ fs, path, root: path.join(root, 'changed-summary'), segmentBytes: 256, schedule() {} });
  opened.push(summaryIo);
  A.eq(makeStore(summaryIo).ownerProof([summaryTarget.rowId]).size, 0, 'valid-shape altered summary cannot hide a real closed-segment retract');

  const lateCollision = fixture('late-collision', 256), first = append(lateCollision.store, { content: 'first proof ' + 'x'.repeat(300) });
  const second = append(lateCollision.store, { content: 'other proof ' + 'x'.repeat(300) });
  const collisionFile = lateCollision.io._internals.segFile(lateCollision.io.status().activeSegment), collisionBefore = fs.readFileSync(collisionFile, 'utf8');
  const collisionAfter = collisionBefore.replace('"rowId":' + second.rowId, '"rowId":' + first.rowId);
  A.eq(Buffer.byteLength(collisionAfter), Buffer.byteLength(collisionBefore), 'late duplicate mutation preserves segment byte length');
  A.ok(collisionAfter !== collisionBefore, 'late duplicate mutation actually replaced the row id');
  fs.writeFileSync(collisionFile, collisionAfter);
  A.eq(lateCollision.store.ownerProof([first.rowId]).size, 0, 'a duplicate discovered across the fresh batch disavows the key');

  for (const reason of ['undo', 'retry']) {
    const f = fixture(reason, 65536), target = append(f.store);
    append(f.store, { kind: 'retract', role: 'system', content: '', targets: [target.rowId], reason });
    A.eq(f.store.ownerProof([target.rowId]).size, 0, reason + ' retract outside requested target list still disqualifies owner evidence');
  }
  const cross = fixture('cross-stream-retract', 256), target = append(cross.store, { content: 'old target ' + 'x'.repeat(300) });
  append(cross.store, { streamId: 'other', kind: 'retract', role: 'system', content: '', targets: [target.rowId], reason: 'undo' });
  A.eq(cross.store.ownerProof([target.rowId]).size, 0, 'a globally addressed retract is not ignored by a candidate-stream shortcut');
  const bare = Store.makeTranscriptStore({ io: { readAll: () => [Object.assign({ rowId: 7, taintKnown: true }, owner, { role: 'user', content: 'RAM only', sourceRunId: owner.runId })] },
    clock: { now: () => 100 }, runOf: () => owner, quotedMaterial: Learning.quotedMaterial });
  A.eq(bare.ownerProof([7]).size, 0, 'no batch disk proof API means no fallback to plausible RAM evidence');
} finally {
  for (const io of opened) io.close();
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('turn-owner-proof');
