/* Actual host handoff handler and scoped-store/context constructors. Routing may succeed while
   history remains unavailable; only a verified live or known constructor-owned context can count it. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Source = require('./helpers/source.js');
const Port = require('../sidecar/channels/history-port.js'), Factory = require('../sidecar/channels/factory.js');
const Hub = require('../sidecar/channels/hub.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeTranscriptStore } = require('../sidecar/transcriptstore.js');
const { makeMemoryTranscriptIo } = require('../sidecar/transcript-history.js');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const source = process.env.CHANNEL_HISTORY_HOST_SOURCE ? fs.readFileSync(process.env.CHANNEL_HISTORY_HOST_SOURCE, 'utf8') : Source.readSidecarSource();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-handoff-history-'));
  const channelStore = makeChannelStore({ fs, pathMod: path, root, clock: { now: () => 100 }, timers: { setTimeout() {}, clearTimeout() {} } });
  const store = makeTranscriptStore({ io: makeMemoryTranscriptIo(), clock: { now: () => 100 }, hash });
  const live = new Map(), bots = { known: { agentId: 'agent', tokenKey: 'saved-slot' } }, notes = [], hubs = [];
  const history = Port.make({ view: store.view, append: store.appendStrict, cacheRetractions: store.cacheRetractions,
    legacyStore: channelStore, hash, now: () => 100, newId: () => 'fresh', failNote: (tag, e) => notes.push([tag, e.message]) });
  const scope = { channelStore, transcriptStore: store, channelHistory: history, ChannelHistory: Port, channelHubFactory: Factory,
    CHANNEL_AGENT_PREFIX: Hub.DEFAULT_AGENT_PREFIX || 'tg_', channelRegistry: new Map([['telegram', {}], ['discord', {}]]),
    telegramBotRecords: () => bots, liveChannelFor: id => live.get(id),
    readBody: async req => JSON.stringify(req.body), respondJson: (res, code, value) => Object.assign(res, { code, value }),
    isAgentId: id => /^[A-Za-z0-9_-]{1,40}$/.test(id), refuseBadAgentId: require('../sidecar/respond.js').refuseBadAgentId, failNote: (tag, e) => notes.push([tag, e.message]) };
  const definitions = Source.callRegion(source, 'const botScopedStores = ', ';') + '\n' +
    ['makeBotScopedStore', 'disconnectedChannelHistory', 'handleChannelHandoff'].map(name =>
      A.fnBody(source, (name === 'handleChannelHandoff' ? 'async function ' : 'function ') + name + '(')).join('\n');
  const api = new Function(...Object.keys(scope), definitions + '\nreturn {handleChannelHandoff, makeBotScopedStore};')(...Object.values(scope));
  const call = async body => { const res = {}; await api.handleChannelHandoff({ body }, res); return res; };
  const add = (sid, content, extra) => store.appendStrict(Object.assign({ streamId: sid, agentId: 'agent', role: 'user', kind: 'turn', content, taint: null }, extra));
  function hub(channel, options) {
    const h = Hub.makeChannelHub(Object.assign({ channel, history, store: channelStore,
      runOnce: async () => { throw Error('handoff cannot run the model'); }, secrets: () => ({ key: 'k', model: 'm', agentId: 'agent' }),
      send: async () => { throw Error('handoff cannot send a message'); }, classify: () => false }, options));
    hubs.push(h); live.set(channel, { hub: h }); return h;
  }
  const seed = (key, text) => fs.writeFileSync(path.join(root, key + '.history.json'), JSON.stringify({ version: 1, messages: [{ role: 'user', content: text, ts: 1 }] }));
  return { root, store, channelStore, history, live, notes, api, call, add, hub, seed,
    close() { for (const h of hubs) h.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}
const request = (channel, chatId, streamId, extra) => Object.assign({ channel, chatId, streamId, agentId: 'agent' }, extra);
(async () => {
  {
    const f = fixture();
    try {
      f.add('desktop_stream', 'ordinary'); f.add('desktop_stream', 'internal', { kind: 'station' });
      f.hub('telegram');
      const r = await f.call(request('telegram', 'live', 'desktop_stream'));
      A.eq([r.code, r.value?.turns, r.value?.historyAvailable], [200, 1, true], 'live actual hub counts the exact canonical replay view');
      A.eq(f.channelStore.getChatRecord('live', { readOnly: true }).streamId, 'desktop_stream', 'count follows the newly saved routing binding');
      f.seed('tg_cold', 'DISCONNECTED IMPORT');
      const cold = await f.call(request('discord', 'cold', 'cold_stream'));
      A.eq([cold.code, cold.value?.turns, cold.value?.historyAvailable], [200, 1, true], 'known disconnected transport imports through its constructor-owned namespace');
      A.eq(f.store.view('proof', 'cold_stream', { complete: true }).map(r => r.content), ['DISCONNECTED IMPORT'], 'disconnected import uses the actual shared default key owner');
      A.eq(f.channelStore.getChatRecord('cold', { readOnly: true }).legacyImport?.state, 'done', 'disconnected count waits for durable import completion');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.add('unknown_stream', 'canonical words do not grant namespace authority');
      const unknown = await f.call(request('custom', 'unknown', 'unknown_stream', { prefix: 'tg_', store: 'telegram' }));
      A.eq([unknown.code, unknown.value?.ok, unknown.value?.turns, unknown.value?.historyAvailable], [200, true, null, false], 'unknown context retains routing success but cannot claim a count');
      A.eq(f.channelStore.getChatRecord('unknown').streamId, 'unknown_stream', 'unknown context still saves the requested binding');
      const perJob = await f.call(request('trigger', 'coldjob', 'unknown_stream'));
      A.eq([perJob.value?.turns, perJob.value?.historyAvailable], [null, false], 'disconnected per-job constructor cannot borrow a conversation namespace');
      f.hub('trigger', { bindChats: false, streamId: () => 'actual_job', agentPrefix: 'trigger_' });
      f.add('actual_job', 'job-owned words');
      const wrong = await f.call(request('trigger', 'livejob', 'unknown_stream'));
      A.eq([wrong.value?.turns, wrong.value?.historyAvailable], [null, false], 'live explicit per-job stream cannot count another requested binding');
      const right = await f.call(request('trigger', 'livejob', 'actual_job'));
      A.eq([right.value?.turns, right.value?.historyAvailable], [1, true], 'actual matching live per-job context can prove its count');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.add('bot_stream', 'bot canonical');
      const bot = await f.call(request('telegram:known', 'room', 'bot_stream'));
      A.eq([bot.value?.turns, bot.value?.historyAvailable], [1, true], 'saved bot scope can count existing canonical history');
      A.eq(f.channelStore.getChatRecord('known|room', { readOnly: true }).channel, 'telegram:known', 'bot binding uses the real scoped record key');
      A.eq(f.channelStore.getChatRecord('room', { readOnly: true }), undefined, 'bot count never creates an unscoped chat record');
      f.seed('tg_ambiguous', 'UNATTRIBUTED BOT LEGACY');
      const bytes = fs.readFileSync(path.join(f.root, 'tg_ambiguous.history.json'), 'utf8');
      const held = await f.call(request('telegram:known', 'ambiguous', 'fresh_bot_stream'));
      A.eq([held.code, held.value?.ok, held.value?.turns, held.value?.historyAvailable], [200, true, null, false], 'ambiguous nonempty bot legacy is unavailable while routing remains saved');
      A.eq(f.store.view('proof', 'fresh_bot_stream', { complete: true }), [], 'ambiguous bot source cannot be imported');
      A.eq(fs.readFileSync(path.join(f.root, 'tg_ambiguous.history.json'), 'utf8'), bytes, 'ambiguous bot source bytes remain intact');
      const missing = await f.call(request('telegram:missing', 'missing', 'bot_stream'));
      A.eq([missing.value?.turns, missing.value?.historyAvailable], [null, false], 'unregistered bot text cannot mint a saved bot context');
      const empty = await f.call(request('telegram:known', 'empty', 'empty_bot_stream'));
      A.eq([empty.value?.turns, empty.value?.historyAvailable], [0, true], 'proved empty bot conversation remains a genuine zero');
    } finally { f.close(); }
  }
  {
    const f = fixture();
    try {
      f.channelStore.saveChatRecord('owned', { channel: 'discord', streamId: 'other' });
      const conflict = await f.call(request('telegram', 'owned', 'new_target'));
      A.eq(conflict.code, 409, 'history migration preserves channel ownership conflicts');
      A.eq(f.channelStore.getChatRecord('owned').streamId, 'other', 'conflict cannot mutate the original binding');
      const scoped = f.api.makeBotScopedStore('known'), calls = [];
      const original = f.channelStore.getChatRecord.bind(f.channelStore);
      f.channelStore.getChatRecord = (key, options) => { calls.push([key, options]); return original(key, options); };
      scoped.getChatRecord('probe', { readOnly: true });
      A.eq(calls, [['known|probe', { readOnly: true }]], 'bot wrapper forwards strict fresh-read options to the actual persistence owner');
    } finally { f.close(); }
  }
  A.report('channels.history-handoff');
})().catch(error => { console.error(error); process.exitCode = 1; });
