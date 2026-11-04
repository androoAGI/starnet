/* Root C9 review controls: a strict history refusal cannot block plain STOP, and separate live/disconnected
   bot consumers must share the same scoped-store import queue. Real Hub, Store, port, host handler and writer. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), Module = require('node:module');
const Source = require('./helpers/source.js');
const Port = require('../sidecar/channels/history-port.js'), Factory = require('../sidecar/channels/factory.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function hubModule() {
  if (!process.env.CHANNEL_HISTORY_REVIEW_HUB_SOURCE) return require('../sidecar/channels/hub.js');
  const filename = path.resolve(__dirname, '../sidecar/channels/hub.js');
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(fs.readFileSync(process.env.CHANNEL_HISTORY_REVIEW_HUB_SOURCE, 'utf8'), filename); return m.exports;
}
const Hub = hubModule();
const source = process.env.CHANNEL_HISTORY_REVIEW_HOST_SOURCE ? fs.readFileSync(process.env.CHANNEL_HISTORY_REVIEW_HOST_SOURCE, 'utf8') : Source.readSidecarSource();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-history-owner-'));
  const channelStore = makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  const store = makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 100 }, hash });
  let append = row => store.appendStrict(row);
  const history = Port.make({ view: store.view, append: row => append(row), cacheRetractions: store.cacheRetractions,
    legacyStore: channelStore, hash, now: () => 100, newId: () => 'fresh' });
  return { root, channelStore, store, history, setAppend(fn) { append = fn; },
    close() { fs.rmSync(root, { recursive: true, force: true }); } };
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
(async () => {
  {
    const f = fixture(), started = defer(), teardown = defer(), sends = [], settled = [];
    let calls = 0, strictRefusals = 0, signal, first;
    const h = Hub.makeChannelHub({ channel: 'telegram', store: f.channelStore, history: f.history, textBatchWaitMs: 0,
      runOnce: async o => {
        calls++; signal = o.signal;
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId }); started.resolve();
        await Promise.race([new Promise(resolve => o.signal.addEventListener('abort', resolve, { once: true })), teardown.promise]);
        const reason = o.signal.aborted ? 'cancelled' : 'done';
        o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason });
        return { reason, outcome: o.signal.aborted ? 'stopped' : 'succeeded', text: '' };
      }, send: async (_chat, text) => { sends.push(text); return { ok: true }; }, isOwner: () => true, classify: () => false,
      secrets: () => ({ key: 'k', model: 'm', agentId: 'agent' }), newId: () => 'active_stop_run', now: () => 100 });
    try {
      first = h.onInbound({ channel: 'telegram', chatId: 'room', chatType: 'dm', userId: 'owner', text: 'keep working', messageId: 'start', ts: 1 });
      await started.promise;
      const get = f.channelStore.getChatRecord.bind(f.channelStore);
      // Inject at the newly strict owner boundary while the established live handle remains independently known.
      f.channelStore.getChatRecord = (id, options) => { if (options?.readOnly) { strictRefusals++; throw Error('strict chat marker unavailable'); } return get(id, options); };
      await h.onInbound({ channel: 'telegram', chatId: 'room', chatType: 'dm', userId: 'owner', text: 'stop', messageId: 'stop', ts: 2 }, { onSettled: out => settled.push(out) });
      A.eq(signal?.aborted, true, 'owner plain STOP cancels the actual live run despite unavailable strict history');
      A.eq(strictRefusals, 0, 'plain STOP does not attempt an unnecessary strict history read');
      A.eq(calls, 1, 'STOP neither starts a replacement run nor buys another provider call');
      A.ok(sends.some(text => text === 'Stopped the run in progress.'), 'STOP retains its confirmed cancellation acknowledgement');
      A.ok(!sends.some(text => /could not read this chat.s history/.test(text)), 'history hold cannot swallow this cancellation');
      A.ok(!settled.some(out => out.ok === true), 'STOP does not claim delivered work');
    } finally { teardown.resolve(); h.close(); if (first) await first; f.close(); }
  }
  {
    const f = fixture(), bots = { known: { agentId: 'agent', model: 'first-config' } };
    const scope = { channelStore: f.channelStore, channelHistory: f.history, channelHubFactory: Factory, ChannelHistory: Port,
      CHANNEL_AGENT_PREFIX: Hub.DEFAULT_AGENT_PREFIX, telegramBotRecords: () => bots, channelRegistry: new Map(), liveChannelFor: () => null,
      readBody: async req => JSON.stringify(req.body), respondJson: (res, code, value) => Object.assign(res, { code, value }),
      isAgentId: id => /^[A-Za-z0-9_-]{1,40}$/.test(id), refuseBadAgentId: require('../sidecar/respond.js').refuseBadAgentId, failNote() {} };
    const definitions = Source.callRegion(source, 'const botScopedStores = ', ';') + '\n' +
      ['makeBotScopedStore', 'disconnectedChannelHistory', 'handleChannelHandoff'].map(name =>
        A.fnBody(source, (name === 'handleChannelHandoff' ? 'async function ' : 'function ') + name + '(')).join('\n');
    const host = new Function(...Object.keys(scope), definitions + '\nreturn {makeBotScopedStore, disconnectedChannelHistory, handleChannelHandoff};')(...Object.values(scope));
    const call = async () => { const res = {}; await host.handleChannelHandoff({ body: { channel: 'telegram:known', chatId: 'race', streamId: 'bot_race', agentId: 'agent' } }, res); return res; };
    try {
      const scoped = host.makeBotScopedStore('known');
      A.eq(host.makeBotScopedStore('known') === scoped, true, 'reconnect and disconnected requests retain one scoped data-access identity');
      const hopKey = 'hop_' + 'a'.repeat(32);
      f.channelStore.saveChatRecord('known|race', { channel: 'telegram:known', chatId: 'race', agentId: 'agent', hopKeys: [hopKey] });
      fs.writeFileSync(path.join(f.root, hopKey + '.history.json'), JSON.stringify({ version: 1, messages: [{ role: 'assistant', content: 'ISOLATED HOP IMPORT', ts: 1 }] }));
      const reached = defer(), release = defer(); let appends = 0;
      f.setAppend(async row => { appends++; if (appends === 1) { reached.resolve(); await release.promise; } return f.store.appendStrict(row); });
      const first = call(); await reached.promise; const second = call();
      await new Promise(resolve => setImmediate(resolve));
      A.eq(appends, 1, 'a concurrent second request cannot append while the same bot import is awaiting acknowledgement');
      release.resolve();
      const results = await Promise.all([first, second]);
      A.eq(results.map(r => [r.code, r.value?.turns, r.value?.historyAvailable]), [[200, 1, true], [200, 1, true]], 'both actual handoff counts await one complete canonical import');
      const rows = f.store.view('proof', 'bot_race', { complete: true });
      A.eq(rows.map(r => r.content), ['ISOLATED HOP IMPORT'], 'concurrent bot import appends the isolated source exactly once');
      A.eq(new Set(rows.map(r => r.importKey)).size, rows.length, 'no duplicate durable import identity remains');
      A.eq(f.channelStore.getChatRecord('known|race', { readOnly: true }).legacyImport?.state, 'done', 'completed marker follows the serialized durable import');
      delete bots.known;
      A.eq(host.disconnectedChannelHistory('telegram:known', 'race'), null, 'deleted bot cannot mint a new context from the cached data-access wrapper');
      bots.known = { agentId: 'replacement', model: 'replacement-config' };
      A.eq(host.makeBotScopedStore('known') === scoped, true, 'recreated bot reuses data access without retaining old config authority');
      scoped.saveChatRecord('race', { agentId: 'replacement' });
      A.eq(host.disconnectedChannelHistory('telegram:known', 'race').store.getChatRecord('race', { readOnly: true }).agentId, 'replacement', 'recreated context reads the current durable record');
      A.ok(!Object.hasOwn(scoped, 'model') && !Object.hasOwn(scoped, 'key') && !Object.hasOwn(scoped, 'token'), 'scoped wrapper stores no credential or model snapshot');
      const init = source.indexOf('const botScopedStores = '), autoStart = source.indexOf('startTelegramBot(bid)');
      A.ok(init >= 0 && autoStart > init, 'actual host initializes scope identity before saved bot auto-start');
    } finally { f.close(); }
  }
  A.report('channels.history-ownership');
})().catch(error => { console.error(error); process.exitCode = 1; });
