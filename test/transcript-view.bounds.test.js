'use strict';
/* Count actual segment reads on cold long histories. No timing thresholds or synthetic performance claim. */
const A = require('./_assert.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), Module = require('node:module');
let Store = require('../sidecar/transcriptstore.js'), History = require('../sidecar/transcript-history.js');
if (process.env.TURN_VIEW_BOUNDS_CONTROL) {
  for (const [file, saved] of [['transcriptstore.js', 'store'], ['transcript-history.js', 'history']]) {
    const filename = require.resolve('../sidecar/' + file), loaded = new Module(filename, module);
    loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded._compile(fs.readFileSync(path.join(process.env.TURN_VIEW_BOUNDS_CONTROL, 'turn-identity-c6-' + saved + '-pre-bounds.js.txt'), 'utf8'), filename);
    if (saved === 'store') Store = loaded.exports; else History = loaded.exports;
  }
}
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'transcript-view-bounds-'));
if (path.dirname(path.resolve(root)) !== temp) throw new Error('fixture directory escaped its temporary parent');
const opened = [], reads = [], warnings = [], tracked = Object.create(fs);
tracked.readFileSync = (file, ...args) => { if (/segment-\d+\.jsonl$/.test(String(file))) reads.push(String(file)); return fs.readFileSync(file, ...args); };
function open(name, segmentBytes) {
  const io = History.makeSegmentedTranscriptIo({ fs: tracked, path, root: path.join(root, name), segmentBytes, schedule() {}, onWarning: text => warnings.push(text) });
  opened.push(io); return io;
}
(async () => {
  try {
    const seed = open('listing', 4096);
    for (const streamId of ['visible', 'hidden-tail']) for (let i = 0; i < 700; i++) seed.appendDurable({ streamId, rowId: undefined,
      sourceRunId: streamId + '-' + i, role: i % 2 ? 'assistant' : 'user', kind: streamId === 'hidden-tail' && i >= 450 ? 'station' : 'turn',
      content: (streamId === 'hidden-tail' && i >= 450 ? 'HIDDEN_SENTINEL_' : 'VISIBLE_') + i + ' ' + 'x'.repeat(180), ts: i + 1 });
    seed.close();
    const io = open('listing', 4096), historyCalls = [], previewCalls = [], wrapped = Object.create(io);
    let contextCalls = 0;
    wrapped.history = (streamId, options) => { historyCalls.push({ streamId, limit: options.limit, strict: options.strict }); return io.history(streamId, options); };
    if (typeof io.preview === 'function') wrapped.preview = (streamId, options) => { previewCalls.push({ streamId, limit: options.limit }); return io.preview(streamId, options); };
    wrapped.retractionsFor = ids => { contextCalls++; return io.retractionsFor(ids); };
    const store = Store.makeTranscriptStore({ io: wrapped, ramPerStream: 1, ramMax: 2 });
    reads.length = 0;
    const listing = store.view('display', null, { op: 'streams', limit: 10 });
    const listingReads = reads.length;
    A.eq(listing.length, 2, 'hidden-only tail does not pretend no older conversation exists');
    A.ok(historyCalls.length === 0 && previewCalls.length === 2 && previewCalls.every(call => call.limit <= 200), 'ordinary listing uses the IO-owned bounded preview reader');
    A.eq(contextCalls, 1, 'all listing previews share one retract-context lookup');
    A.ok(listingReads <= 32, 'two cold 700-row streams respect the assembly segment budget: ' + listingReads);
    A.ok(listing.every(row => row.turns === 700), 'listing keeps the existing honest durable stored-row count');
    A.eq(listing.find(row => row.streamId === 'hidden-tail').preview, '', 'a hidden-only tail supplies no private preview');
    A.ok(!JSON.stringify(listing).includes('HIDDEN_SENTINEL'), 'no hidden preview reaches listing metadata');
    A.ok(listing.find(row => row.streamId === 'visible').preview.includes('VISIBLE_698'), 'bounded tail retains the latest eligible user preview');

    const sparseSeed = open('sparse', 256);
    for (let i = 0; i < 12; i++) for (let stream = 0; stream < 8; stream++) sparseSeed.appendDurable({ streamId: 'sparse-' + stream,
      role: 'user', kind: 'turn', content: 'SPARSE_' + stream + '_' + i + ' ' + 'x'.repeat(300), ts: i * 8 + stream + 1 });
    sparseSeed.close();
    const sparseIo = open('sparse', 256), sparseStore = Store.makeTranscriptStore({ io: sparseIo, ramPerStream: 1, ramMax: 8 });
    reads.length = 0;
    const sparse = sparseStore.view('display', null, { op: 'streams', limit: 8 });
    A.eq(sparse.length, 8, 'budget exhaustion preserves all manifest-backed stream entries');
    A.ok(reads.length <= 32, 'eight sparse streams across ninety-six segments share the same finite assembly budget: ' + reads.length);
    A.ok(sparse.every(row => row.turns === 12), 'sparse-stream metadata counts stay honest');
    A.ok(sparse.filter(row => !row.preview).length >= 2, 'exhausted preview budget stays blank instead of scanning more history');

    const old = open('old-summaries', 256), target = old.appendDurable({ streamId: 's', role: 'user', kind: 'turn', content: 'target ' + 'x'.repeat(300), ts: 1 });
    for (let i = 0; i < 18; i++) old.appendDurable({ streamId: 's', role: 'assistant', kind: 'turn', content: 'filler ' + i + ' ' + 'x'.repeat(300), ts: i + 2 });
    old.appendDurable({ streamId: 's', role: 'system', kind: 'retract', targets: [target.rowId], reason: 'undo', content: '', ts: 22 });
    old.appendDurable({ streamId: 's', role: 'assistant', kind: 'turn', content: 'active ' + 'x'.repeat(300), ts: 23 });
    old.close();
    const manifestFile = old._internals.manifestFile, manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    for (const meta of manifest.segments) { delete meta.retracts; delete meta.retractsHash; }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const cold = open('old-summaries', 256), coldStore = Store.makeTranscriptStore({ io: cold, ramPerStream: 1, ramMax: 1 });
    reads.length = 0;
    const firstContext = cold.retractionsFor([target.rowId]);
    A.ok(reads.length <= 8, 'first cold context read is bounded before any summary has hydrated: ' + reads.length);
    A.eq(firstContext.proofComplete, false, 'one bounded read does not falsely vouch for every old summary');
    reads.length = 0;
    let failure; try { coldStore.view('display', 's', { limit: 1 }); } catch (error) { failure = error; }
    A.eq(failure && failure.code, 'TRANSCRIPT_UNVOUCHED', 'unknown old summaries refuse authority while bounded hydration is incomplete');
    // The tail itself may read rows; the dedicated context call below measures its own strict eight-read budget.
    let complete = false, proof, attempts = 0;
    while (!complete && attempts++ < 5) {
      reads.length = 0; proof = cold.retractionsFor([target.rowId]);
      A.ok(reads.length <= 8, 'each general context hydration reads at most eight segments: ' + reads.length);
      complete = proof.proofComplete;
    }
    A.eq(complete, true, 'validated closed summaries make bounded incremental progress');
    A.eq(proof.retractions.get(target.rowId), 'undo', 'completed context retains the actual later retract');
    A.ok(!coldStore.view('display', 's', { limit: 100 }).some(row => row.rowId === target.rowId), 'hydration never restores the retracted target');
    const { recallTool } = require('../sidecar/tools/builtin/recall.js').makeRecallTool({ transcriptStore: { view() { const error = new Error('unknown'); error.code = 'TRANSCRIPT_UNVOUCHED'; throw error; } } });
    const browse = await recallTool.run({}, { streamId: 's' }), around = await recallTool.run({ around: 10 }, { streamId: 's' });
    A.eq(browse.summary, 'history listing incomplete', 'recall browse distinguishes unknown from an empty station');
    A.eq(around.summary, 'history read incomplete', 'recall around distinguishes unknown from no matching turns');
  } finally {
    for (const io of opened) io.close();
    if (path.dirname(path.resolve(root)) !== temp) throw new Error('refusing to remove a fixture outside its temporary parent');
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('transcript-view.bounds');
})().catch(error => { A.ok(false, error.stack); A.report('transcript-view.bounds'); });
