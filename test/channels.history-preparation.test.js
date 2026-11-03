/* Awaited history/media preparation retains the Hub's existing stop owner until paid work begins.
   Exact saved Hub bytes exercise the same real Store/Port fixture as the repaired owner. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const History = require('./helpers/channel-history.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const Halt = require('../sidecar/halt.js');
function hubOwner() {
  if (!process.env.CHANNEL_PREPARATION_HUB_SOURCE) return require('../sidecar/channels/hub.js');
  const filename = path.resolve(__dirname, '../sidecar/channels/hub.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  if (process.env.CHANNEL_PREPARATION_ROUTE_SOURCE) {
    const routesFile = path.resolve(__dirname, '../sidecar/channels/routes.js');
    const routes = new Module(routesFile, module); routes.filename = routesFile; routes.paths = Module._nodeModulePaths(path.dirname(routesFile));
    routes._compile(fs.readFileSync(process.env.CHANNEL_PREPARATION_ROUTE_SOURCE, 'utf8'), routesFile);
    const actual = m.require.bind(m); m.require = name => name === './routes.js' ? routes.exports : actual(name);
  }
  m._compile(fs.readFileSync(process.env.CHANNEL_PREPARATION_HUB_SOURCE, 'utf8'), filename); return m.exports;
}
const Hub = hubOwner();
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) { for (let n = 0; n < 100 && !test(); n++) await tick(); if (!test()) throw Error('fixture boundary was not reached'); }
const message = (text, id, chat) => ({ channel: 'telegram', chatId: chat || '42', chatType: 'dm', userId: 'owner', messageId: id, text, ts: 1 });
function fixture(options) {
  const o = options || {}, files = new Map(), calls = [], sends = [], waits = [], media = [], steers = [], holds = [];
  let seq = 0;
  const missing = () => Object.assign(Error('absent'), { code: 'ENOENT' });
  const memoryFs = {
    readFileSync(p) { if (!files.has(p)) throw missing(); return files.get(p); },
    writeFileSync(p, value) { files.set(p, String(value)); },
    renameSync(a, b) { if (!files.has(a)) throw missing(); files.set(b, files.get(a)); files.delete(a); }, mkdirSync() {}
  };
  const store = makeChannelStore({ fs: memoryFs, pathMod: path.posix, root: '/preparation', bootId: 'fixture',
    clock: { now: () => ++seq }, timers: { setTimeout() {}, clearTimeout() {} } });
  const canonical = History.make(store, { now: () => ++seq });
  const history = Object.assign({}, canonical.history, { replay: async ctx => {
    const rows = await canonical.history.replay(ctx);
    if (!o.mediaOnly && !o.noGate) await new Promise((resolve, reject) => waits.push({ resolve, reject }));
    return rows;
  } });
  const hub = Hub.makeChannelHub({ channel: 'telegram', store, history, textBatchWaitMs: 0,
    bindChats: o.mirror ? false : undefined, streamId: o.mirror ? 'preparation_stream' : undefined,
    now: () => ++seq, newId: () => 'preparing_' + (++seq), setTimeout() {}, clearTimeout() {},
    isOwner: () => true, classify: () => false, secrets: () => ({ key: 'fake', model: 'fixture', agentId: 'writer', configured: true }),
    steerRun: o.steer ? () => new Promise(resolve => steers.push(resolve)) : undefined,
    fetchMedia: async ref => { await new Promise((resolve, reject) => media.push({ resolve, reject })); return { ok: true, buffer: Buffer.from('photo'), name: ref.name }; },
    saveAttachment: async (_agent, name) => ({ ok: true, id: 'image', name, path: '.attachments/image', mediaType: 'image/png', kind: 'image' }),
    runOnce: async opt => {
      const text = opt.messages[opt.messages.length - 1].content;
      calls.push({ text, opt }); opt.emit('agent.run.start', { agentId: opt.agentId, runId: opt.runId });
      if (o.park || (o.parkFirst && calls.length === 1)) await new Promise(resolve => { holds.push(resolve); if (opt.signal.aborted) resolve(); else opt.signal.addEventListener('abort', resolve, { once: true }); });
      const reason = opt.signal.aborted ? 'cancelled' : 'done';
      if (reason === 'done') opt.emit('agent.token', { delta: 'answer ' + text });
      opt.emit('agent.run.end', { agentId: opt.agentId, runId: opt.runId, reason });
      return { text: 'answer ' + text, reason, outcome: reason === 'done' ? 'succeeded' : 'stopped' };
    }, send: async (_chat, text) => { sends.push(String(text)); return { ok: true, messageId: 'sent_' + (++seq) }; }
  });
  return { hub, store, canonical, calls, sends, waits, media, steers, holds,
    close() { Halt.killAll(null, hub._internals.inflight); for (const release of holds) release(); hub.close(); store.ledger.close(); } };
}
async function pending(f, text, id, chat) {
  const count = f.waits.length, promise = f.hub.onInbound(message(text, id, chat));
  await until(() => f.waits.length > count); return { promise, wait: f.waits[count], owner: f.hub._internals.inflight.get(chat || '42') };
}
async function active(f) {
  const promise = f.hub.onInbound(message('active task', 'active'));
  await until(() => f.calls.length === 1 && f.holds.length === 1);
  return { promise, owner: f.hub._internals.inflight.get('42') };
}
async function steering(f, text, id) {
  const count = f.steers.length, promise = f.hub.onInbound(message(text, id));
  await until(() => f.steers.length > count); return { promise, resolve: f.steers[count] };
}
(async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    try {
      const a = await pending(f, 'older preparation', 'a'), b = await pending(f, 'newer preparation', 'b');
      A.ok(!!a.owner && a.owner.runId === '' && a.owner.startedAt === null, 'pending history has a stop owner without inventing a started run');
      A.eq(Halt.endOf(a.owner), 'superseded', 'the newer request withdraws the earlier preparation through the existing first-wins owner');
      A.eq(f.calls.length, 0, 'neither history wait has begun a provider call');
      const first = reverse ? b : a, second = reverse ? a : b;
      first.wait.resolve(); await first.promise;
      if (!reverse) A.eq(f.hub._internals.inflight.get('42'), b.owner, 'older preparation cleanup cannot delete the newer pending owner');
      second.wait.resolve(); await second.promise;
      A.eq(f.calls.map(c => c.text), ['newer preparation'], (reverse ? 'reversed' : 'same-order') + ' history completion never dispatches the stale request');
      A.eq(f.hub._internals.inflight.size, 0, 'completed preparation leaves no phantom live owner');
      A.eq(f.store.ledger.pending('telegram').length, 0, 'both ordinary receipts settle without a stale replay');
    } finally { f.close(); }
  }
  for (const mode of ['plain', 'slash', 'estop', 'fault']) {
    const f = fixture();
    try {
      const work = await pending(f, 'waiting for history', 'work');
      let stopping, stopFinished = false;
      if (mode === 'plain' || mode === 'slash') {
        stopping = f.hub.onInbound(message(mode === 'plain' ? 'stop' : '/stop', 'stop')).then(() => { stopFinished = true; });
        // The old owner may treat plain stop as a new question. Release that real read too, so
        // the negative control completes and reports the unwanted provider call instead of hanging.
        await until(() => stopFinished || f.waits.length > 1);
        for (const wait of f.waits.slice(1)) wait.resolve();
      }
      else { if (mode === 'fault') Halt.markFaulted(f.hub._internals.inflight); Halt.killAll(null, f.hub._internals.inflight); }
      A.eq(Halt.endOf(work.owner), mode === 'plain' || mode === 'slash' ? 'stopped' : mode === 'estop' ? 'halted' : 'faulted', mode + ' owns the pending work before the read resumes');
      work.wait.resolve(); await work.promise; if (stopping) await stopping;
      A.eq(f.calls.length, 0, mode + ' prevents a provider call after the history wait');
      A.eq(f.hub._internals.inflight.size, 0, mode + ' cleanup releases the same owner');
      A.eq(f.store.ledger.pending('telegram').length, 0, mode + ' settles the actual durable receipt');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const work = await pending(f, 'unreadable history', 'held');
      work.wait.reject(Error('history unavailable')); await work.promise;
      A.eq(f.calls.length, 0, 'a failed history read buys no run');
      A.eq(f.hub._internals.inflight.size, 0, 'a failed history read releases its pending owner');
      A.ok(f.sends.some(text => /could not read this chat.s history/.test(text)), 'failed history retains the existing truthful hold');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const a = await pending(f, 'stopped old request', 'a');
      await f.hub.onInbound(message('/stop', 'stop'));
      const b = await pending(f, 'current request', 'b');
      a.wait.reject(Error('late failed old history')); await a.promise;
      A.eq(Halt.endOf(a.owner), 'stopped', 'a later supersede or failed read cannot rewrite the first STOP reason');
      A.eq(f.hub._internals.inflight.get('42'), b.owner, 'a stopped old read rejection cannot delete the newer owner');
      b.wait.resolve(); await b.promise;
      A.eq(f.calls.map(c => c.text), ['current request'], 'only current work dispatches after old stopped history rejects');
      A.ok(!f.sends.some(text => /could not read this chat.s history/.test(text)), 'a late read failure does not replace the confirmed stop with a history fault');
    } finally { f.close(); }
  }
  {
    const f = fixture({ mediaOnly: true });
    try {
      const a = f.hub.onInbound(Object.assign(message('older photo', 'media'), { media: [{ id: 'old', kind: 'photo', name: 'photo.png' }] }));
      await until(() => f.media.length === 1);
      const owner = f.hub._internals.inflight.get('42');
      await f.hub.onInbound(message('newer text', 'text'));
      f.media[0].resolve(); await a;
      A.eq(Halt.endOf(owner), 'superseded', 'the same owner spans the inherited media await');
      A.eq(f.calls.map(c => c.text), ['newer text'], 'late media completion cannot dispatch old work after the newer reply');
      A.eq(f.hub._internals.inflight.size, 0, 'media withdrawal releases its owner');
    } finally { f.close(); }
  }
  {
    const f = fixture({ mediaOnly: true });
    try {
      const work = f.hub.onInbound(Object.assign(message('stopped photo', 'media'), { media: [{ id: 'old', kind: 'photo', name: 'photo.png' }] }));
      await until(() => f.media.length === 1);
      const owner = f.hub._internals.inflight.get('42');
      await f.hub.onInbound(message('/stop', 'stop'));
      f.media[0].reject(Error('late media download failure')); await work;
      A.eq(Halt.endOf(owner), 'stopped', 'a media rejection cannot replace the first STOP reason');
      A.eq(f.calls.length, 0, 'a stopped media failure cannot fall through into a note-only paid run');
      A.eq(f.hub._internals.inflight.size, 0, 'stopped media failure cleans up the owned record');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      const a = await pending(f, 'chat A', 'a', 'a'), b = await pending(f, 'chat B', 'b', 'b');
      a.wait.resolve(); b.wait.resolve(); await Promise.all([a.promise, b.promise]);
      A.eq(f.calls.map(c => c.text).sort(), ['chat A', 'chat B'], 'separate chats routed to the same agent never cancel each other');
      A.eq(f.hub._internals.inflight.size, 0, 'both independent owners clean up');
    } finally { f.close(); }
  }
  for (const reverse of [false, true]) {
    const f = fixture({ noGate: true, parkFirst: true, steer: true }); let a;
    try {
      a = await active(f);
      const b = await steering(f, 'older fallback', 'b'), c = await steering(f, 'newer fallback', 'c');
      const first = reverse ? c : b, second = reverse ? b : c;
      first.resolve({ ok: false, status: 404 }); await first.promise;
      if (!reverse) A.eq(a.owner.abort.signal.aborted, false, 'older refusal cannot stop A while the newer steer decision still waits');
      second.resolve({ ok: false, status: 404 }); await second.promise; await a.promise;
      A.eq(f.calls.map(c => c.text), ['active task', 'newer fallback'], (reverse ? 'reversed' : 'same-order') + ' refused steers permit only the newest fallback');
      A.eq(Halt.endOf(a.owner), 'superseded', 'the actual newest fallback owns the supersede');
      A.eq(f.hub._internals.inflight.size, 0, 'deferred refusal cleanup leaves no owner');
    } finally { f.close(); if (a) await a.promise; }
  }
  {
    const f = fixture({ noGate: true, parkFirst: true, steer: true, mirror: true }); let a;
    try {
      a = await active(f);
      const b = await steering(f, 'older refused steer', 'b'), c = await steering(f, 'newer accepted steer', 'c');
      c.resolve({ ok: true }); await c.promise;
      b.resolve({ ok: false, status: 404 }); await b.promise;
      A.eq(f.calls.map(c => c.text), ['active task'], 'a newer accepted steer prevents the older refused fallback from buying a run');
      A.eq(a.owner.abort.signal.aborted, false, 'older refused steer cannot kill A after C joined it');
      A.ok(f.store.loadHistory('writer').some(row => row.content === 'newer accepted steer'), 'current accepted steer retains its legacy mirror compatibility');
      A.ok(!f.store.loadHistory('writer').some(row => row.content === 'older refused steer'), 'older refused fallback does not create a legacy directive');
      A.ok(f.sends.some(text => /Added to the task/.test(text)), 'current successful steer keeps its live acknowledgement');
    } finally { f.close(); if (a) await a.promise; }
  }
  for (const mode of ['plain', 'slash', 'estop', 'fault']) {
    const f = fixture({ noGate: true, parkFirst: true, steer: true }); let a;
    try {
      a = await active(f); const b = await steering(f, 'waiting follow-up', 'b');
      if (mode === 'plain' || mode === 'slash') await f.hub.onInbound(message(mode === 'plain' ? 'stop' : '/stop', 'stop'));
      else { if (mode === 'fault') Halt.markFaulted(f.hub._internals.inflight); Halt.killAll(null, f.hub._internals.inflight); }
      await a.promise; b.resolve({ ok: false, status: 404 }); await b.promise;
      A.eq(f.calls.map(c => c.text), ['active task'], mode + ' while steering forbids a late fallback run');
      A.eq(Halt.endOf(a.owner), mode === 'plain' || mode === 'slash' ? 'stopped' : mode === 'estop' ? 'halted' : 'faulted', mode + ' remains first-wins after steer refusal');
      A.eq(f.store.ledger.pending('telegram').length, 0, mode + ' and refused steer settle their durable receipts');
    } finally { f.close(); if (a) await a.promise; }
  }
  for (const mode of ['stop', 'fault']) {
    const f = fixture({ noGate: true, parkFirst: true, steer: true, mirror: true }); let a;
    try {
      a = await active(f); const b = await steering(f, 'late accepted follow-up', 'b');
      if (mode === 'stop') await f.hub.onInbound(message('/stop', 'stop'));
      else { Halt.markFaulted(f.hub._internals.inflight); Halt.killAll(null, f.hub._internals.inflight); }
      await a.promise; b.resolve({ ok: true }); await b.promise;
      A.eq(f.calls.map(c => c.text), ['active task'], 'late successful steer after ' + mode + ' is never retried as a run');
      A.ok(!f.store.loadHistory('writer').some(row => row.content === 'late accepted follow-up'), 'late accepted ' + mode + ' result cannot mirror into an ended task');
      A.ok(f.sends.includes('Your follow-up was accepted by the earlier task.'), 'late accepted ' + mode + ' acknowledgement states only the proved acceptance');
      A.ok(!f.sends.some(text => /Added to the task.*already running/.test(text)), 'late accepted ' + mode + ' result makes no stale running claim');
      A.eq(f.store.ledger.pending('telegram').length, 0, 'accepted ' + mode + ' result settles its receipt without replay');
    } finally { f.close(); if (a) await a.promise; }
  }
  {
    const f = fixture({ noGate: true, parkFirst: true, steer: true }); let a;
    try {
      a = await active(f); const b = await steering(f, 'after natural completion', 'b');
      f.holds[0](); await a.promise;
      A.eq(f.hub._internals.inflight.size, 0, 'A naturally leaves the map while its steer reply is pending');
      await f.hub.onInbound(message('/status', 'status'));
      b.resolve({ ok: false, status: 409 }); await b.promise;
      A.eq(f.calls.map(c => c.text), ['active task', 'after natural completion'], 'natural missing-owner409 after harmless status retains the legitimate next request');
      A.eq(a.owner.abort.signal.aborted, false, '409 never aborts A after its normal finish');
      A.ok(f.sends.some(text => text === 'answer active task'), 'A keeps its completed reply under409');
    } finally { f.close(); if (a) await a.promise; }
  }
  for (const intervening of ['work', 'stop', 'eviction']) {
    const f = fixture({ noGate: true, parkFirst: true, steer: true }); let a;
    try {
      a = await active(f); const b = await steering(f, 'late obsolete fallback', 'b');
      f.holds[0](); await a.promise;
      if (intervening === 'work') await f.hub.onInbound(message('newer completed work', 'c'));
      else if (intervening === 'stop') await f.hub.onInbound(message('/stop', 'stop'));
      else for (let n = 0; n < f.hub._internals.MAX_ROUTES + 1; n++) f.hub._internals.noteRoute(message('elsewhere', 'm', 'other-' + n));
      A.eq(f.hub._internals.inflight.size, 0, intervening + ' leaves no live owner before B resumes');
      b.resolve({ ok: false, status: 409 }); await b.promise;
      A.eq(f.calls.map(c => c.text), intervening === 'work' ? ['active task', 'newer completed work'] : ['active task'], intervening + ' retires stale B even after A and C left the live map');
      A.eq(f.store.ledger.pending('telegram').length, 0, intervening + ' fallback refusal leaves no receipt to replay');
      const route = f.hub._internals.routeOpts('42', true);
      A.ok(!route || !Object.hasOwn(route, 'workIntent'), 'private work ordering never appears in a transport route');
    } finally { f.close(); if (a) await a.promise; }
  }
  A.report('channels.history-preparation');
})().catch(error => { console.error(error); process.exitCode = 1; });
