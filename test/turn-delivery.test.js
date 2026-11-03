'use strict';
const A = require('./_assert.js');
const Store = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const Delivery = require('../sidecar/turn-delivery.js');
const Kinds = require('../frontend/app/turnkinds.js');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const options = { streamId: 'chat', agentId: 'agent', runId: 'review-run-123', text: 'Reviewed findings: the accepted public answer.' };
function fixture() {
  const io = makeMemoryTranscriptIo();
  const open = () => Store.makeTranscriptStore({ io, clock: { now: () => 20 }, redact: value => value.replace(/RAW_SECRET/g, '[redacted-key]') });
  return { io, open, store: open() };
}
function thrown(fn) { try { fn(); return null; } catch (error) { return error; } }
{
  const f = fixture();
  f.store.appendStrict({ streamId: 'chat', agentId: 'agent', sourceRunId: options.runId, turnId: Kinds.runTurnId(options.runId), role: 'assistant', kind: 'station', content: 'INTERNAL REVIEW EXECUTION' });
  const first = Delivery.write(f.store, options);
  const rows = f.store.view('proof', 'chat', { complete: true });
  A.eq(rows.length, 2, 'public delivery is distinct from hidden execution of the same run');
  A.eq(rows[1].kind, 'delivery', 'single public row uses the delivery kind');
  A.eq(rows[1].role, 'assistant', 'publication never invents an owner user directive');
  A.eq(first.turnId, Kinds.runTurnId(options.runId), 'the delivered reply keeps the run-derived turn identity');
  A.eq(f.store.view('model-replay', 'chat', { shape: 'pairs' }).map(row => row.content), [options.text], 'only the public answer enters canonical replay');
  A.eq(Delivery.write(f.store, Object.assign({}, options, { text: 'a repeated publication does not rewrite prior bytes' })), first, 'repeat publication returns the already accepted identity');
  A.eq(f.store.view('proof', 'chat', { complete: true }), rows, 'repeat publication leaves the complete durable prefix unchanged');
  f.store = f.open();
  A.eq(Delivery.write(f.store, options), first, 'idempotent delivery survives Store restart');
  const other = Delivery.write(f.store, Object.assign({}, options, { streamId: 'another' }));
  A.ok(other.rowId !== first.rowId, 'one run may deliver independently to two destination streams');
  f.store.retract({ streamId: 'chat', rowIds: [first.rowId], reason: 'undo' });
  const count = f.io.streamRows('chat');
  A.eq(Delivery.write(f.store, options), first, 'an undone delivery remains idempotent evidence');
  A.eq(f.io.streamRows('chat'), count, 'retrying publication cannot resurrect an undone answer');
  A.eq(f.store.view('model-replay', 'chat', { shape: 'pairs' }), [], 'the undone answer stays absent from replay');
}
{
  const f = fixture(), write = f.io.appendDurable;
  f.io.appendDurable = () => { throw new Error('injected strict append failure'); };
  A.ok(/strict append/.test(thrown(() => Delivery.write(f.store, options)).message), 'strict persistence failure propagates');
  A.eq(f.io.streamRows('chat'), 0, 'failed publication leaves no durable row');
  f.io.appendDurable = write;
  A.ok(Delivery.write(f.store, options).rowId > 0, 'the next proved publication can recover');
}
{
  const f = fixture();
  const calls = [];
  const unreadable = Object.assign({}, f.store, { view(name, stream, opts) { calls.push([name, stream, opts]); throw new Error('proof unavailable'); } });
  A.ok(/proof unavailable/.test(thrown(() => Delivery.write(unreadable, options)).message), 'unvouched history never authorizes append');
  A.eq(f.io.streamRows('chat'), 0, 'proof failure has no mutation');
  A.eq(calls, [['proof', 'chat', { sourceRunId: options.runId, complete: true }]], 'the writer proves the full run-scoped stream before mutation');
  const badRead = Object.assign({}, f.store, { view: () => null });
  A.ok(!!thrown(() => Delivery.write(badRead, options)), 'non-array proof is unknown rather than empty');
  A.ok(!!thrown(() => Delivery.write(f.store, Object.assign({}, options, { streamId: '../other' }))), 'invalid stream refuses before persistence');
  A.ok(!!thrown(() => Delivery.write(f.store, Object.assign({}, options, { text: 'x'.repeat(Kinds.LEGACY_FINAL_CONTENT_MAX + 1) }))), 'oversize publication refuses rather than silently truncating its answer');
}
{
  const f = fixture(), first = Delivery.write(f.store, Object.assign({}, options, { text: 'value RAW_SECRET' }));
  A.eq(f.store.view('proof', 'chat', { complete: true })[0].content, 'value [redacted-key]', 'the shared Store redaction boundary remains applied');
  f.io.appendDurable({ streamId: 'other', agentId: 'agent', rowId: first.rowId, role: 'assistant', content: 'collided identity', ts: 20 });
  f.store = f.open();
  const before = f.io.streamRows('chat');
  A.ok(!!thrown(() => Delivery.write(f.store, options)), 'a globally collided delivery id cannot claim successful publication');
  A.eq(f.io.streamRows('chat'), before, 'ambiguous delivery evidence does not append another answer');
}
{
  const f = fixture();
  Delivery.write(f.store, options);
  f.store.appendStrict({ streamId: 'chat', agentId: 'agent', sourceRunId: options.runId, turnId: Kinds.runTurnId(options.runId), role: 'assistant', kind: 'delivery', content: 'duplicate imported evidence' });
  const before = f.io.streamRows('chat');
  A.ok(!!thrown(() => Delivery.write(f.store, options)), 'two existing delivery rows make the publication ambiguous');
  A.eq(f.io.streamRows('chat'), before, 'duplicate evidence is preserved without a third row');
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-delivery-proof-'));
  let io;
  try {
    const open = () => {
      io = makeSegmentedTranscriptIo({ fs, path, root, segmentBytes: 1024, onWarning() {}, schedule() {} });
      return Store.makeTranscriptStore({ io, clock: { now: () => 20 }, limit: 1, ramPerStream: 1 });
    };
    let store = open();
    const first = Delivery.write(store, options);
    for (let n = 0; n < 30; n++) store.appendStrict({ streamId: 'chat', agentId: 'agent', role: 'assistant', content: 'later ' + n + ' ' + 'x'.repeat(200) });
    io.close(); store = open();
    A.eq(store.count(), 1, 'restarted Store holds only the newest row before the old delivery lookup');
    A.eq(Delivery.write(store, options), first, 'cold complete proof finds an old delivery beyond the recent RAM tail');
    const segments = fs.readdirSync(root).filter(name => /^segment-.*\.jsonl$/.test(name)).sort();
    A.ok(segments.length > 1, 'disk proof fixture has a cold closed segment');
    const file = path.join(root, segments[0]);
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('!'), bytes.subarray(1)]));
    const before = io.streamRows('chat');
    A.ok(!!thrown(() => Delivery.write(store, options)), 'damaged closed proof segment refuses instead of treating delivery as absent');
    A.eq(io.streamRows('chat'), before, 'unreadable durable proof never appends another delivery');
    A.eq(fs.readFileSync(file)[0], '!'.charCodeAt(0), 'proof refusal preserves damaged evidence');
  } finally { if (io) io.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
A.report('turn-delivery');
