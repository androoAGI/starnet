'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), Module = require('node:module'), crypto = require('node:crypto');
const Kinds = require('../frontend/app/turnkinds.js');
function owner(rel, env, dependencies) {
  const file = require.resolve(rel), saved = process.env[env];
  if (!saved && !dependencies) return require(file);
  const source = fs.readFileSync(saved || file, 'utf8'), hash = crypto.createHash('sha256').update(source).digest('hex');
  if (saved) console.log('CONTROL_SOURCE ' + env + ' ' + saved + ' SHA256=' + hash);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  if (dependencies) { const original = loaded.require.bind(loaded); loaded.require = name => Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : original(name); }
  loaded._compile(source, file); return loaded.exports;
}
const Publication = owner('../sidecar/channels/history-publication.js', 'CHANNEL_PUBLICATION_SCHEMA_SOURCE');
const Ledger = owner('../sidecar/channels/delivery-ledger.js', 'CHANNEL_PUBLICATION_LEDGER_SOURCE',
  process.env.CHANNEL_PUBLICATION_SCHEMA_SOURCE ? { './history-publication.js': Publication } : undefined);
const Store = owner('../sidecar/channels/store.js', 'CHANNEL_PUBLICATION_STORE_SOURCE', { './delivery-ledger.js': Ledger });
const clone = value => JSON.parse(JSON.stringify(value));
const runId = 'routine-run-123', target = 'saved-target', id = 'routine:job1:' + runId + ':' + target;
const proof = { streamId: 'original_stream', rowId: 7, turnId: Kinds.runTurnId(runId) };
const receipt = { v: 1, target, deliveryId: id, channel: 'telegram', chatId: 'room', streamId: proof.streamId,
  agentId: 'agent', runId, rowId: proof.rowId, turnId: proof.turnId };
function record() {
  return { id, chat: 'telegram|room', channel: 'telegram', chatId: 'room', kind: 'routine', reason: 'routine', runId, agentId: 'agent',
    receiptIds: [], route: null, seed: '', parts: [{ kind: 'text', n: 0, text: 'accepted answer', sent: true, messageId: 'm1' }],
    delayed: false, state: 'done', release: 'caller', tries: 0, nextAt: 0, lastError: '', ts: 1, edit: null, sessionTurns: null,
    historyDestination: { v: 1, streamId: proof.streamId, jobId: 'job1', target }, doneAt: 2 };
}
function document(rows) { return { version: 1, receipts: [], deliveries: rows || [], tombstones: [], chats: {}, openAsks: [], migrated: { inbox: [], outbox: [] } }; }
function attempt(fn) { try { return { value: fn() }; } catch (error) { return { error }; } }
function publication(ledger) {
  if (typeof ledger.publication !== 'function') throw new Error('fresh publication owner unavailable');
  return ledger.publication(id);
}
async function allocated(seed, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-publication-')), file = path.join(root, 'delivery.json');
  const proxy = Object.create(fs), stores = [], pending = new Set();
  const state = { now: 100, before: false, after: false, blockRead: false, readAfterWrite: false, writes: 0, reads: 0 };
  proxy.readFileSync = (name, ...args) => {
    if (path.resolve(String(name)) === file) {
      state.reads++;
      if (state.blockRead) throw Object.assign(new Error('publication primary unavailable'), { code: 'EACCES' });
    }
    return fs.readFileSync(name, ...args);
  };
  proxy.renameSync = (from, to) => {
    const own = path.resolve(String(to)) === file;
    if (own && state.before) throw Object.assign(new Error('publication write refused'), { code: 'EIO' });
    fs.renameSync(from, to);
    if (own) {
      state.writes++;
      if (state.readAfterWrite) state.blockRead = true;
      if (state.after) throw Object.assign(new Error('publication acknowledgement lost after rename'), { code: 'EIO' });
    }
  };
  const timers = { setTimeout(fn) { const item = { fn, unref() {} }; pending.add(item); return item; }, clearTimeout(item) { pending.delete(item); } };
  const open = () => {
    const store = Store.makeChannelStore({ fs: proxy, pathMod: path, root, clock: { now: () => state.now }, timers });
    stores.push(store); return store;
  };
  try {
    if (seed) fs.writeFileSync(file, JSON.stringify(seed));
    const original = seed ? fs.readFileSync(file, 'utf8') : null;
    await fn({ state, root, file, open, store: open(), original, raw: () => JSON.parse(fs.readFileSync(file, 'utf8')),
      bytes: () => fs.readFileSync(file, 'utf8'), retry() { const due = Array.from(pending); pending.clear(); for (const item of due) item.fn(); } });
  } finally {
    for (const store of stores) store.ledger.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('channel-publication-')) throw new Error('publication fixture cleanup escaped temp parent');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
(async () => {
  A.eq(Publication.receipts([receipt], { jobId: 'job1', runId, agentId: 'agent', targets: [target] }), [receipt], 'receipt names the exact result and approved target');
  A.ok(!!attempt(() => Publication.receipt(Object.assign({}, receipt, { target: 'another-target' }))).error, 'receipt intrinsically binds its target even without caller context');
  A.ok(!!attempt(() => Publication.receipt(Object.assign({}, receipt, { deliveryId: 'routine::' + runId + ':' + target }))).error, 'receipt cannot omit its job component');
  const colonRun = 'run:with:colon', colonTarget = 'target:with:colon';
  const colonReceipt = Object.assign({}, receipt, { runId: colonRun, target: colonTarget, deliveryId: 'routine:job:with:colon:' + colonRun + ':' + colonTarget, turnId: Kinds.runTurnId(colonRun) });
  A.eq(attempt(() => Publication.receipt(colonReceipt, { jobId: 'job:with:colon' })).value, colonReceipt, 'exact suffix binding preserves colon-bearing identifiers');
  A.ok(!!attempt(() => Publication.receipt(colonReceipt, { jobId: 'wrong-job' })).error, 'caller job identity is still checked exactly');
  for (const [name, rows] of [['duplicate target', [receipt, receipt]], ['over limit', Array(17).fill(receipt)],
    ['unknown version', [Object.assign({}, receipt, { v: 3 })]], ['wrong run', [Object.assign({}, receipt, { runId: 'another-run' })]],
    ['extra field', [Object.assign({}, receipt, { authority: true })]], ['mixed invalid', [receipt, { v: 1 }]]]) {
    A.ok(!!attempt(() => Publication.receipts(rows, { jobId: 'job1', runId, targets: [target] })).error, name + ' refuses the entire receipt set');
  }
  await allocated(null, async f => {
    const input = Object.assign({}, record(), { state: 'queued' }); delete input.doneAt;
    const placed = f.store.ledger.enqueue(input);
    A.eq(placed.historyDestination, record().historyDestination, 'enqueue captures the original destination in the same durable record');
    A.eq(f.raw().deliveries[0].historyDestination, record().historyDestination, 'destination is present on disk before transport');
    const restarted = f.open().ledger;
    A.eq(restarted.delivery(id).historyDestination, record().historyDestination, 'restart retains the captured destination');
    const before = f.bytes();
    A.ok(!!attempt(() => restarted.enqueue(Object.assign({}, input, { historyDestination: { ...input.historyDestination, streamId: 'rotated_stream' } }))).error, 'same delivery ID cannot recapture a rotated chat stream');
    A.eq(f.bytes(), before, 'conflicting destination leaves the durable record unchanged');
    A.ok(!!attempt(() => restarted.enqueue(Object.assign({}, input, { runId: 'other-run-123' }))).error, 'same ID cannot borrow another run');
    A.ok(!!attempt(() => restarted.enqueue(Object.assign({}, input, { runId: 'x'.repeat(201) }))).error, 'raw overlong run identity refuses before truncation');
    A.ok(!!attempt(() => publication(restarted)).error, 'queued transport never authorizes canonical publication');
  });
  for (const [name, change] of [
    ['future destination', d => { d.historyDestination.v = 9; }], ['extra destination field', d => { d.historyDestination.secret = 'unknown'; }],
    ['missing stream', d => { delete d.historyDestination.streamId; }], ['missing captured job', d => { delete d.historyDestination.jobId; }],
    ['missing captured target', d => { delete d.historyDestination.target; }], ['overlong run', d => { d.runId = 'x'.repeat(201); }],
    ['future acknowledgement', d => { d.sessionTurns = { v: 3, payload: 'keep verbatim' }; }],
    ['wrong acknowledgement stream', d => { d.sessionTurns = { v: 2, at: 5, streamId: 'wrong', rowId: 7, turnId: proof.turnId }; }],
    ['malformed part', d => { d.parts.push({ kind: 'text', n: 1, sent: true }); }],
    ['unfinished part marked done', d => { d.parts[0].sent = false; }]
  ]) {
    const row = record(); change(row);
    await allocated(document([row]), async f => {
      A.eq(f.store.ledger.load(), false, name + ': actual ledger read stays unavailable');
      A.eq(f.store.ledger.flush({ probe: true }), false, name + ': a flush cannot overwrite unknown authority');
      A.ok(!!attempt(() => f.store.ledger.enqueue(record())).error, name + ': enqueue cannot reinitialize or recapture the destination');
      f.retry();
      A.eq(f.bytes(), f.original, name + ': retries preserve exact original bytes');
    });
  }
  for (const seed of [document([record(), record()]), Object.assign(document([record()]), { version: 2 })]) {
    await allocated(seed, async f => {
      A.eq(f.store.ledger.load(), false, 'duplicate identity or unknown enclosing version cannot supply complete publication proof');
      A.eq(f.bytes(), f.original, 'ambiguous enclosing document remains untouched');
    });
  }
  await allocated(document([record()]), async f => {
    const ledger = f.store.ledger;
    A.eq(attempt(() => publication(ledger)).value, record(), 'fresh primary proof returns the exact fully done record');
    const ack = ledger.noteSession(id, proof);
    A.eq(ack, { v: 2, at: 100, ...proof }, 'verified canonical identity becomes a v2 acknowledgement');
    A.eq(f.raw().deliveries[0].sessionTurns, ack, 'acknowledgement is actually durable');
    f.state.now = 8 * 86400000;
    ledger.flush({ probe: true });
    A.ok(!!ledger.delivery(id), 'bound record survives the legacy TTL until cron confirms publication');
    const restarted = f.open().ledger;
    A.eq(restarted.noteSession(id, proof), ack, 'restart re-proves the original acknowledgement without changing its time');
    A.ok(!!attempt(() => restarted.release(id, Object.assign({}, receipt, { rowId: 8 }))).error, 'wrong cron row cannot authorize release');
    A.ok(!!restarted.delivery(id), 'failed release proof retains the caller record');
    A.eq(attempt(() => restarted.release(id, receipt)).value, true, 'matching durable publication receipt permits release');
    A.eq(f.raw().deliveries.length, 0, 'verified release is persisted');
  });
  for (const fault of ['before', 'after', 'readAfterWrite']) {
    await allocated(document([record()]), async f => {
      const ledger = f.store.ledger;
      f.state[fault] = true;
      A.ok(!!attempt(() => ledger.noteSession(id, proof)).error, fault + ': failed write or primary readback cannot claim acknowledgement');
      A.ok(!!ledger.delivery(id), fault + ': failed acknowledgement retains the done record');
      f.state.now = 8 * 86400000;
      ledger.flush({ probe: true });
      A.ok(!!ledger.delivery(id), fault + ': failed acknowledgement remains retained after the legacy TTL');
      A.ok(!!attempt(() => ledger.release(id, receipt)).error, fault + ': RAM marker cannot authorize release');
      f.state[fault] = false; f.state.blockRead = false;
      const ack = attempt(() => ledger.noteSession(id, proof)).value;
      A.eq(ack && [ack.v, ack.rowId, ack.turnId], [2, proof.rowId, proof.turnId], fault + ': same-ID retry confirms the durable publication without a new identity');
      A.eq(f.raw().deliveries.length, 1, fault + ': recovery retains exactly one record for cron');
    });
  }
  await allocated(document([record()]), async f => {
    const ledger = f.store.ledger; ledger.noteSession(id, proof);
    const before = f.bytes();
    A.ok(!!attempt(() => ledger.release(id, Object.assign({}, receipt, { target: 'another-target' }))).error, 'wrong target cannot authorize bound release even with matching row/run identity');
    A.ok(!!ledger.delivery(id), 'wrong-target refusal retains the original record');
    A.eq(f.bytes(), before, 'wrong-target refusal preserves exact disk bytes');
  });
  {
    const exactRun = 'run-12345', actualTarget = 'a:' + exactRun + ':b', exactId = 'routine:job:' + exactRun + ':' + actualTarget;
    const row = Object.assign(record(), { id: exactId, runId: exactRun,
      historyDestination: { v: 1, streamId: proof.streamId, jobId: 'job', target: actualTarget } });
    const exactProof = Object.assign({}, proof, { turnId: Kinds.runTurnId(exactRun) });
    const exactReceipt = Object.assign({}, receipt, { target: actualTarget, deliveryId: exactId, runId: exactRun, turnId: exactProof.turnId });
    await allocated(document([row]), async f => {
      const ledger = f.store.ledger;
      const ack = attempt(() => ledger.noteSession(exactId, exactProof)).value;
      A.eq(ack && ack.turnId, exactProof.turnId, 'colon-bearing target retains its independently captured identity');
      const before = f.bytes();
      A.ok(!!attempt(() => ledger.release(exactId, Object.assign({}, exactReceipt, { target: 'b' }))).error, 'a shorter matching suffix cannot borrow a different inferred job');
      A.eq(f.bytes(), before, 'ambiguous-suffix refusal preserves complete captured binding');
      A.eq(attempt(() => ledger.release(exactId, exactReceipt)).value, true, 'the exact captured colon-bearing target can release');
    });
  }
  for (const fault of ['before', 'after']) {
    await allocated(document([record()]), async f => {
      const ledger = f.store.ledger; ledger.noteSession(id, proof);
      const before = clone(ledger.delivery(id)); let sent = 0;
      ledger.attach('telegram', { send: async () => { sent++; return { ok: true, messageId: 'unexpected' }; } });
      f.state[fault] = true;
      A.ok(!!attempt(() => ledger.release(id, receipt)).error, fault + ': failed removal cannot claim a verified release');
      A.eq(ledger.delivery(id), before, fault + ': failed removal restores the exact bound done record');
      f.state.now = 8 * 86400000;
      ledger.flush({ probe: true });
      A.eq(ledger.delivery(id), before, fault + ': failed release remains retained past the legacy TTL');
      f.state[fault] = false;
      f.retry();
      A.eq(ledger.flush(), true, fault + ': existing retry/flush owner restores durable retained state');
      A.eq(f.raw().deliveries[0], before, fault + ': recovery preserves the exact original acknowledgement and binding');
      A.eq(attempt(() => publication(ledger)).value, before, fault + ': fresh proof confirms retained done state before another release');
      A.eq(attempt(() => ledger.release(id, receipt)).value, true, fault + ': matching cron receipt can retry release once durable');
      A.eq(f.raw().deliveries, [], fault + ': retry removes only the confirmed record');
      A.eq(sent, 0, fault + ': neither failed removal nor recovery repeats transport');
    });
  }
  await allocated(document([record()]), async f => {
    const ledger = f.store.ledger; ledger.noteSession(id, proof);
    const raw = f.raw(); raw.deliveries[0].sessionTurns = { v: 2, at: 100, ...proof, rowId: 8 };
    fs.writeFileSync(f.file, JSON.stringify(raw)); const bytes = f.bytes();
    A.ok(!!attempt(() => ledger.noteSession(id, proof)).error, 'fresh conflicting on-disk acknowledgement refuses before RAM can overwrite it');
    A.eq(f.bytes(), bytes, 'conflicting publication evidence remains unchanged');
  });
  await allocated(null, async f => {
    const ledger = f.store.ledger, input = Object.assign({}, record(), { state: 'queued' }); delete input.doneAt;
    ledger.enqueue(input); let sent = 0;
    f.state.before = true;
    ledger.attach('telegram', { send: async () => { sent++; return { ok: true, messageId: 'm1' }; } });
    await ledger.drive('telegram|room');
    A.eq(sent, 1, 'actual transport accepts the one queued part');
    A.eq(ledger.delivery(id).state, 'done', 'transport completion is retained in RAM after save failure');
    A.ok(!!attempt(() => publication(ledger)).error, 'RAM done with failed persistence cannot authorize canonical write');
    f.state.before = false;
    A.eq(ledger.flush(), true, 'saved completion recovers through the existing ledger retry owner');
    A.eq(attempt(() => publication(ledger)).value && publication(ledger).state, 'done', 'fresh durable completion then authorizes publication');
    A.eq(sent, 1, 'confirming completed delivery never repeats transport');
  });
  await allocated(document([Object.assign(record(), { historyDestination: undefined, sessionTurns: { at: 3 } })]), async f => {
    A.eq(f.store.ledger.load(), true, 'valid legacy records without new fields remain readable');
    A.eq(f.store.ledger.delivery(id).sessionTurns, { at: 3 }, 'legacy one-time marker remains explicit legacy evidence');
  });
  A.report('channels.history-publication');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
