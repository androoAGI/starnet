'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const parent = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'turn-retract-disk-'));
if (path.dirname(path.resolve(root)) !== parent) throw new Error('temporary fixture escaped its parent');
const handles = [], reads = [], tracked = Object.create(fs);
tracked.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(String(file)); return fs.readFileSync(file, ...args); };
function open(name) {
  const io = makeSegmentedTranscriptIo({ fs: tracked, path, root: path.join(root, name), segmentBytes: 4096, schedule() {}, onWarning() {} });
  handles.push(io);
  return { io, store: makeTranscriptStore({ io, clock: { now: () => 10 } }) };
}
try {
  const first = open('restart'), T = 'disk_undo_turn_001';
  const directive = first.store.appendStrict({ streamId: 's', role: 'user', content: 'DISK_UNDO', turnId: T, directive: true, sourceRunId: 'old-run' });
  const answer = first.store.appendStrict({ streamId: 's', role: 'assistant', content: 'OLD_ANSWER', turnId: T, sourceRunId: 'old-run' });
  A.eq(first.store.retract({ streamId: 's', turnId: T, reason: 'undo' }).state, 'done', 'real segmented IO acknowledges the undo');
  first.io.close();
  const second = open('restart'); reads.length = 0;
  A.eq(second.store.cacheRetractions('s', [directive.rowId, answer.rowId]), { state: 'done', retracted: [directive.rowId, answer.rowId] }, 'cold restart proves old cache targets from durable bytes');
  A.ok(reads.length <= 8, 'the cold cache proof keeps the eight-segment physical read ceiling');
  A.eq(second.store.view('display', 's', { limit: 200 }), [], 'restart cannot restore undone dialogue');
  A.eq(second.store.view('proof', 's', { limit: 200 }).filter(row => row.kind !== 'retract').map(row => row.content), ['DISK_UNDO', 'OLD_ANSWER'], 'append-only originals remain available to raw proof');
  const long = open('sparse'), ids = [];
  for (let i = 0; i < 12; i++) ids.push(long.store.appendStrict({ streamId: 's', role: i ? 'assistant' : 'user', content: 'x'.repeat(4300),
    turnId: 'sparse_turn_001', directive: i === 0, sourceRunId: 'old-run' }).rowId);
  long.io.close();
  const sparse = open('sparse'); reads.length = 0;
  A.eq(sparse.store.cacheRetractions('s', ids).state, 'unknown', 'target IDs spanning more than eight segments remain unproven');
  A.ok(reads.length <= 8, 'a sparse cache cannot force unbounded proof reads');
  const count = sparse.io.streamRows('s'); reads.length = 0;
  A.eq(sparse.store.retract({ streamId: 's', turnId: 'sparse_turn_001', reason: 'retry' }).state, 'unknown', 'a bounded suffix that cannot reach the directive does not retract a partial attempt');
  A.ok(reads.length <= 8, 'mutation selection has a separate explicit eight-segment ceiling');
  A.eq(sparse.io.streamRows('s'), count, 'an unproven suffix performs no append');
  const corrupt = open('collision');
  const c = corrupt.store.appendStrict({ streamId: 's', role: 'user', content: 'ORIGINAL', turnId: T, directive: true });
  // Exact legacy disk collision: append raw through IO to preserve the supplied identity.
  corrupt.io.appendDurable({ streamId: 's', rowId: c.rowId, role: 'assistant', content: 'COLLISION', turnId: T });
  corrupt.io.close();
  const reopened = open('collision');
  A.eq(reopened.store.cacheRetractions('s', [c.rowId]).state, 'unknown', 'restart collision audit disavows cache identity');
  A.eq(reopened.store.retract({ streamId: 's', rowIds: [c.rowId], reason: 'undo' }).state, 'unknown', 'a collided explicit target cannot acquire mutation authority');
} finally {
  for (const io of handles) io.close();
  if (path.dirname(path.resolve(root)) !== parent) throw new Error('temporary cleanup escaped its parent');
  fs.rmSync(root, { recursive: true, force: true });
}
A.report('turn-retract.disk');
