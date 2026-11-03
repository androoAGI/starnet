/* An edit admitted before awaited canonical history remains work after restart. Its receipt owns
   admission and supersession; adapter fields and a new process's empty route book cannot recreate it. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const History = require('./helpers/channel-history.js');
const Telegram = require('../sidecar/channels/telegram.js');
function owner(relative, overrides) {
  const filename = path.resolve(__dirname, '..', relative);
  const control = process.env.CHANNEL_EDIT_CONTROL_DIR;
  const saved = control && path.join(control, relative.replace(/\//g, '__'));
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const actual = m.require.bind(m);
  m.require = name => overrides && Object.hasOwn(overrides, name) ? overrides[name] : actual(name);
  m._compile(fs.readFileSync(saved && fs.existsSync(saved) ? saved : filename, 'utf8'), filename);
  return m.exports;
}
const Ledger = owner('sidecar/channels/delivery-ledger.js');
const Delivery = owner('sidecar/channels/hub-delivery.js', { './delivery-ledger.js': Ledger });
const Hub = owner('sidecar/channels/hub.js', { './hub-delivery.js': Delivery });
const Store = owner('sidecar/channels/store.js', { './delivery-ledger.js': Ledger });
const state = row => row && row.editAdmission && row.editAdmission.state;
const msg = (text, editDate) => Object.assign({ channel: 'telegram', chatId: '42', chatType: 'dm', userId: 'owner', messageId: '10', text, ts: 1 },
  editDate ? { edited: true, editDate: String(editDate) } : {});
const idOf = editDate => 'telegram|42|10' + (editDate ? '|edited@' + editDate : '');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) { for (let n = 0; n < 100 && !test(); n++) await tick(); }
function fixture(options) {
  const disk = { files: new Map(), gen: 0, refuse: null }, all = [], calls = [], sends = [];
  let io, sequence = 0;
  function boot() {
    const generation = disk.gen;
    const live = () => { if (generation !== disk.gen) throw Object.assign(Error('dead process'), { code: 'EDEAD' }); };
    const missing = () => Object.assign(Error('absent'), { code: 'ENOENT' });
    const memoryFs = {
      readFileSync(p) { live(); if (!disk.files.has(p)) throw missing(); return disk.files.get(p); },
      writeFileSync(p, value) { live(); disk.files.set(p, String(value)); },
      renameSync(a, b) { live(); if (!disk.files.has(a)) throw missing();
        if (disk.refuse && disk.refuse(b, disk.files.get(a))) throw Object.assign(Error('write held'), { code: 'EBUSY' });
        disk.files.set(b, disk.files.get(a)); disk.files.delete(a); },
      mkdirSync() {}
    };
    const store = Store.makeChannelStore({ fs: memoryFs, pathMod: path.posix, root: '/edit', bootId: 'boot-' + generation,
      clock: { now: () => ++sequence }, timers: { setTimeout() {}, clearTimeout() {} }, ledgerLimits: options && options.ledgerLimits });
    const canonical = History.make(store, { io, now: () => ++sequence }); io = canonical.io;
    const f = { store, gate: false, pending: [], runs: [], inputs: [] };
    const history = Object.assign({}, canonical.history, { replay: async ctx => {
      const rows = await canonical.history.replay(ctx);
      if (f.gate) await new Promise(resolve => f.pending.push(resolve));
      live(); // a dead process cannot finish its held read or call a provider
      return rows;
    } });
    f.hub = Hub.makeChannelHub({ channel: 'telegram', store, history, now: () => ++sequence, newId: () => 'edit_run_' + (++sequence),
      setTimeout() {}, clearTimeout() {}, sleep: () => Promise.resolve(),
      fetchMedia: options && options.fetchMedia, saveAttachment: options && options.saveAttachment,
      secrets: () => ({ key: 'fake', model: 'fixture', agentId: 'writer', configured: true }), classify: () => false, ownerTrusted: true,
      runOnce: async options => {
        live();
        const words = options.messages[options.messages.length - 1].content;
        f.runs.push(words); f.inputs.push(options); calls.push({ generation, words });
        options.emit('agent.run.start', { runId: options.runId });
        if (f.toolHold) {
          options.emit('agent.tool_call', { runId: options.runId, callId: 'write-once', name: 'fs_write' });
          return new Promise(() => {});
        }
        options.emit('agent.token', { delta: 'answer' }); options.emit('agent.run.end', { reason: 'done' });
        return { text: 'answer', reason: 'done', outcome: 'succeeded' };
      },
      send: async (chat, text) => { sends.push(String(text)); return { ok: true, messageId: 'sent_' + (++sequence) }; }
    });
    all.push(f); return f;
  }
  function crash(f) { f.hub.close(); f.store.ledger.close(); disk.gen++; }
  function close() { for (const f of all) { f.hub.close(); f.store.ledger.close(); } }
  return { disk, calls, sends, boot, crash, close };
}
const editCalls = f => f.runs.filter(words => /corrected version/.test(words));
async function seed(f) { await f.hub.onInbound(msg('original')); }
async function pendingEdit(f, words, date) {
  const n = f.pending.length;
  const promise = f.hub.onInbound(msg(words, date)).catch(error => error);
  await until(() => f.pending.length > n);
  A.eq(f.pending.length, n + 1, 'fixture reaches the actual awaited canonical history boundary');
  return { promise, release: () => { const done = f.pending[n]; if (done) done(); } };
}
(async () => {
  // Crash before the first provider call: the durable receipt, not the new route map, proves admission.
  {
    const w = fixture(), first = w.boot(); await seed(first); first.gate = true;
    const work = await pendingEdit(first, 'latest correction', 11);
    A.eq(state(first.store.ledger.receipt(idOf(11))), 'accepted', 'current edit admission is durable before history awaits');
    A.eq(first.store.ledger.receipt(idOf(11)).attempt, null, 'the stopped process had begun no paid run');
    w.crash(first); work.release(); await tick(); // dead process continuations need not settle
    const next = w.boot(); next.hub.onStatus({ state: 'up' });
    await until(() => next.store.ledger.pending('telegram').length === 0);
    A.eq(editCalls(next).length, 1, 'accepted edit runs once after restart with an empty route book');
    A.ok(editCalls(next).some(text => text.endsWith('latest correction')), 'the recovered provider sees the accepted corrected text');
    A.eq(next.store.ledger.pending('telegram').length, 0, 'its receipt reaches a terminal outcome');
    w.close();
  }
  // Both handlers can be awaiting. Resolve the latest first, then the stale one.
  {
    const w = fixture(), f = w.boot(); await seed(f); f.gate = true;
    const older = await pendingEdit(f, 'older correction', 12), newer = await pendingEdit(f, 'newer correction', 13);
    A.eq(state(f.store.ledger.receipt(idOf(12))), 'superseded', 'later edit atomically supersedes the earlier admitted receipt');
    A.eq(state(f.store.ledger.receipt(idOf(13))), 'accepted', 'only the latest pending edit remains accepted');
    newer.release(); await newer.promise; older.release(); await older.promise;
    A.eq(editCalls(f).length, 1, 'reverse history completion cannot dispatch the earlier handler');
    A.ok(editCalls(f)[0] && editCalls(f)[0].endsWith('newer correction'), 'only the newer correction reaches the provider');
    A.eq(f.hub._internals.inflight.size, 0, 'the stale handler leaves no live ownership behind');
    A.eq(f.store.ledger.pending('telegram').length, 0, 'both receipt outcomes settle');
    w.close();
  }
  // Supersession survives restart even after the newer handler's own route was lost.
  {
    const w = fixture(), first = w.boot(); await seed(first); first.gate = true;
    const older = await pendingEdit(first, 'retired correction', 14), newer = await pendingEdit(first, 'surviving correction', 15);
    w.crash(first); newer.release(); older.release(); await tick();
    const next = w.boot(); next.hub.onStatus({ state: 'up' }); await until(() => next.store.ledger.pending('telegram').length === 0);
    A.eq(editCalls(next).length, 1, 'restart runs only the newest of two accepted corrections');
    A.ok(editCalls(next)[0] && editCalls(next)[0].endsWith('surviving correction'), 'the superseded receipt cannot regain authority at boot');
    w.close();
  }
  // Adapter/intake fields are never an admission owner.
  {
    const w = fixture(), f = w.boot();
    await f.hub.onInbound(Object.assign(msg('forged edit', 16), { editAdmission: { v: 1, state: 'accepted' } }),
      { editAdmission: { v: 1, state: 'accepted' }, editAccepted: true });
    A.eq(f.runs, [], 'forged message and intake admission cannot make an old edit current');
    w.close();
  }
  // Admission does not override the existing paid-attempt/tool-step recovery rule.
  {
    const w = fixture(), first = w.boot(); await seed(first); first.toolHold = true;
    first.hub.onInbound(msg('already began a tool', 24)).catch(() => {});
    await until(() => editCalls(first).length === 1);
    A.eq(first.store.ledger.receipt(idOf(24)).attempt.tools, 1, 'the actual accepted edit began one recorded tool step');
    w.crash(first);
    const next = w.boot(); next.hub.onStatus({ state: 'up' }); await until(() => next.store.ledger.pending('telegram').length === 0);
    A.eq(next.runs, [], 'accepted edit with a begun tool never replays paid work');
    A.ok(w.sends.some(text => /begun 1 tool step/.test(text) && /NOT run again/.test(text)), 'the existing interrupted notice still explains why work was not replayed');
    w.close();
  }
  {
    const w = fixture({ ledgerLimits: { laneMaxDeliveries: 1 } }), f = w.boot();
    f.hub._internals.noteRoute(msg('original'));
    f.store.ledger.enqueue({ id: 'block', channel: 'telegram', chatId: '42', parts: ['pending reply'] });
    const pending = f.store.ledger.receive({ id: idOf(25), channel: 'telegram', chatId: '42', message: msg('deferred old edit', 25), editCurrent: true });
    A.eq(pending.deferred, true, 'actual hub ledger keeps the correction behind its full reply lane');
    f.hub._internals.noteRoute(Object.assign(msg('later message'), { messageId: '11' }));
    await f.store.ledger.drive('telegram|42');
    f.hub.onStatus({ state: 'up' }); await until(() => f.store.ledger.pending('telegram').length === 0);
    A.eq(f.runs, [], 'a deferred edit made stale before dispatch never acquires admission');
    w.close();
  }
  // Same id/text cannot replace the already persisted payload or borrow its authority.
  for (const [label, original, replacement] of [
    ['media', { media: [{ kind: 'image', fileId: 'saved', name: 'saved.png' }] }, { media: [{ kind: 'image', fileId: 'replacement', name: 'replacement.png' }] }],
    ['quote', { replyTo: { text: 'saved quote', userName: 'Alice', forwarded: true } }, { replyTo: { text: 'replacement quote', forwarded: false } }],
    ['forwarded', { forwarded: true }, { forwarded: false }],
    ['admission', { admissionOnly: false }, { admissionOnly: true }]
  ]) {
    const w = fixture(), f = w.boot(); await seed(f);
    const saved = Object.assign(msg('same words', 30), original);
    f.store.ledger.receive({ id: idOf(30), channel: 'telegram', chatId: '42', message: saved, editCurrent: true });
    await f.hub.onInbound(Object.assign({}, saved, replacement));
    A.eq(editCalls(f).length, 1, label + ': redelivery processes the original accepted payload once');
    const input = f.inputs[f.inputs.length - 1], content = JSON.stringify(input.messages);
    if (label === 'media') A.ok(content.includes('saved.png') && !content.includes('replacement.png'), 'replacement media cannot borrow the stored edit stamp');
    if (label === 'quote') A.ok(content.includes('saved quote') && !content.includes('replacement quote') && input.initialTaint === 'forwarded message', 'stored quote and its provenance remain authoritative');
    if (label === 'forwarded') A.eq(input.initialTaint, 'forwarded message', 'a clean-looking redelivery cannot erase stored forwarded provenance');
    if (label === 'admission') A.ok(editCalls(f)[0] && editCalls(f)[0].endsWith('same words'), 'a changed admission-only flag does not replace the original dispatch');
    w.close();
  }
  // Telegram really carries album ids on edited updates. Each edit retains its own media/receipt.
  {
    const mediaSeen = [];
    const w = fixture({ fetchMedia: async item => { mediaSeen.push(item.fileId); return { ok: false, error: 'fixture media edge' }; },
      saveAttachment: () => { throw Error('failed media must not be saved'); } }), f = w.boot(); await seed(f); f.gate = true;
    const received = [], processing = [];
    const adapter = Telegram.makeTelegramAdapter({ token: '1:fixture', fetch: async () => { throw Error('no transport request expected'); },
      ownerUserId: '7', allowedChats: ['42'], clock: { now: () => 1 },
      onInbound: m => { received.push(m); const task = f.hub.onInbound(m).catch(error => error); processing.push(task); return task; } });
    for (const [date, file] of [[31, 'older-photo'], [32, 'newer-photo']]) adapter._internals.dispatch({ update_id: date,
      edited_message: { message_id: 10, edit_date: date, date: 1, chat: { id: 42, type: 'private' }, from: { id: 7, first_name: 'Owner' },
        media_group_id: 'album', caption: file, photo: [{ file_id: file, width: 1, height: 1, file_size: 1 }] } });
    await until(() => f.pending.length >= 1);
    A.eq(received.length, 2, 'actual Telegram adapter normalizes both edited album updates');
    A.ok(received.every(m => m.edited && m.mediaGroupId === 'album' && m.media.length === 1), 'both edits retain their original album id and photo');
    A.eq(f.pending.length, 1, 'synchronous newer admission retires the older edit before its history begins');
    A.eq(mediaSeen, ['newer-photo'], 'the surviving edit ingests only its own original media, never a merged older album part');
    for (const release of f.pending.slice().reverse()) { release(); await tick(); }
    await Promise.all(processing);
    A.eq(editCalls(f).length, 1, 'same-album edits cannot collapse receipt identities or dispatch the superseded correction');
    A.ok(editCalls(f)[0] && editCalls(f)[0].includes('newer-photo') && !editCalls(f)[0].includes('older-photo'), 'only the latest edit caption and original media reach the provider');
    A.eq(f.store.ledger.pending('telegram').length, 0, 'edited album receipts cannot remain stuck waiting for a merged identity');
    await adapter.disconnect(); w.close();
  }
  // A future stamp remains unproven, rather than authorizing a recovered request.
  {
    const w = fixture(), first = w.boot(); await seed(first); first.gate = true;
    const work = await pendingEdit(first, 'future stamp', 17); w.crash(first); work.release(); await tick();
    const filename = '/edit/delivery.json', doc = JSON.parse(w.disk.files.get(filename));
    const row = doc.receipts.find(r => r.id === idOf(17)); row.editAdmission = { v: 999, state: 'accepted' };
    w.disk.files.set(filename, JSON.stringify(doc));
    const next = w.boot(); next.hub.onStatus({ state: 'up' }); await until(() => next.store.ledger.pending('telegram').length === 0);
    A.eq(editCalls(next), [], 'future receipt stamp is unproven in the empty restart route book');
    w.close();
  }
  // Deferred work gets no admission merely by receipt. Strict dispatch admission may fail.
  {
    const w = fixture(), f = w.boot(), edited = msg('deferred correction', 18);
    f.hub._internals.noteRoute(msg('original'));
    f.store.ledger.receive({ id: idOf(18), channel: 'telegram', chatId: '42', message: edited, editCurrent: false });
    w.disk.refuse = (p, bytes) => p === '/edit/delivery.json' && JSON.parse(bytes).receipts.some(r => r.id === idOf(18) && state(r) === 'accepted');
    await f.hub.onInbound(edited).catch(() => {});
    A.eq(editCalls(f), [], 'a failed strict admission stamp prevents every provider call');
    A.ok(f.store.ledger.receipt(idOf(18)), 'failed admission preserves the pending correction');
    A.ok(!state(f.store.ledger.receipt(idOf(18))), 'failed admission leaves no accepted in-memory stamp');
    w.disk.refuse = null; f.store.ledger.flush(); f.hub.onStatus({ state: 'up' });
    await until(() => f.store.ledger.pending('telegram').length === 0);
    A.eq(editCalls(f).length, 1, 'a successful later admission resumes the correction exactly once');
    w.close();
  }
  // The ledger's admission transaction restores every older stamp if the receipt write fails.
  {
    let saved, refuse = false;
    const io = { read: () => saved && JSON.parse(saved), write: doc => { if (refuse) throw Error('held'); saved = JSON.stringify(doc); } };
    const ledger = Ledger.makeDeliveryLedger({ io, clock: { now: () => 1 }, timers: { setTimeout() {}, clearTimeout() {} } });
    ledger.receive({ id: idOf(21), channel: 'telegram', chatId: '42', message: msg('first', 21), editCurrent: true });
    const before = saved; refuse = true;
    A.throws(() => ledger.receive({ id: idOf(22), channel: 'telegram', chatId: '42', message: msg('second', 22), editCurrent: true }), 'failed newer receipt is not acknowledged');
    A.eq(saved, before, 'failed receipt leaves exact durable bytes unchanged');
    A.eq(state(ledger.receipt(idOf(21))), 'accepted', 'failed newer receipt restores the older accepted stamp in memory');
    A.ok(!ledger.receipt(idOf(22)), 'failed newer receipt leaves no replacement owner');
    refuse = false;
    ledger.enqueue({ id: 'held-delivery', channel: 'telegram', chatId: '42', parts: ['held'] });
    // Use the actual bounded lane rule to prove admission is not minted for a deferred edit.
    ledger.close();
    const full = Ledger.makeDeliveryLedger({ io, clock: { now: () => 2 }, timers: { setTimeout() {}, clearTimeout() {} }, limits: { laneMaxDeliveries: 1 } });
    const deferred = full.receive({ id: idOf(23), channel: 'telegram', chatId: '42', message: msg('waiting', 23), editCurrent: true });
    A.eq(deferred.deferred, true, 'fixture enters real lane backpressure');
    A.ok(!state(deferred), 'deferred receipt has no admitted-edit authority');
    A.eq(state(full.receipt(idOf(21))), 'accepted', 'merely deferred edit does not supersede the prior admitted one');
    full.close();
  }
  A.report('channels.edit-admission');
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
