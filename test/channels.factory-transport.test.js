'use strict';
// Execute the actual host starters, not hand-built constructor bags. Real adapters normalize
// raw messages and serialize replies over a closed synthetic fetch boundary; real Hub,
// LineRunner, chain, store and live RunWire resolution do the work between those edges.
// Poll-loop startup is disabled (dispatch is explicit), and the paid run host is recorded.
// This proves composition, not a real account, gateway connection or paid provider call.
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const crypto = require('crypto');
const A = require('./_assert.js');
const Bags = require('./helpers/channel-hub-bags.js');
const History = require('./helpers/channel-history.js');
const Factory = require('../sidecar/channels/factory.js');
const Hub = require('../sidecar/channels/hub.js');
const Registry = require('../sidecar/channels/registry.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makePromptRegistry } = require('../sidecar/channels/prompts.js');
const { makeTelegramTransport } = require('../sidecar/channels/telegram.transport.js');
const RunWire = require('../sidecar/run-wire.js');
const Classify = require('../frontend/app/classify.js');
const { TaskIntent } = require('../frontend/app/fork.js');
const Scrub = require('../sidecar/host-path-scrub.js');

const KINDS = ['telegram', 'telegram-bot', 'discord', 'slack', 'matrix', 'signal'];
const FUNCTIONS = ['runWireEnv', 'runWireFor', 'channelRunConfigFor', 'stationHubRunConfig',
  'channelHubSecrets', 'makeHubDeps', 'makeAdapterOpts', 'startTelegram', 'stopTelegram',
  'telegramBotRecords', 'makeBotScopedStore', 'startTelegramBot', 'stopTelegramBot',
  'startDiscord', 'stopDiscord', 'channelPersona', 'startGenericChannel', 'stopGenericChannel', 'stopChannel'];
const text = Bags.hostSource();
// Older controls predate the factories and shared stop; their starters still execute unchanged.
const hostCode = FUNCTIONS.map(name => Bags.topLevel(text, name)).filter(Boolean).join('\n');

function raw(kind, text, number, stranger = false) {
  const who = stranger ? 'other' : 'owner';
  if (kind.startsWith('telegram')) return { update_id: number, message: {
    message_id: number, date: 1, chat: { id: 42, type: 'private' }, from: { id: who }, text
  } };
  if (kind === 'discord') return { id: String(number), channel_id: 'DM42', author: { id: who }, content: text };
  if (kind === 'slack') return { type: 'message', channel: 'D42', channel_type: 'im', user: who, text, ts: String(number) };
  if (kind === 'matrix') return { roomId: '!room:fixture', selfId: '@bot:fixture', event: {
    type: 'm.room.message', sender: who, event_id: '$' + number, content: { msgtype: 'm.text', body: text }
  } };
  return { envelope: { sourceNumber: who, dataMessage: { message: text, timestamp: number } } };
}

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  if (!predicate()) throw new Error('Timed out waiting for ' + label);
}

function station(kind, root) {
  const runs = [], wire = [], warnings = [], lifecycle = [], events = [], hubs = [], adapters = [];
  let next = 0, routed = 'writer', chained = false;
  const roster = new Map([
    ['agent', { name: 'NOVA', provider: 'custom', model: 'station-model', system: 'STATION-SYSTEM' }],
    ['writer', { name: 'Writer', provider: 'custom', model: 'writer-model', system: 'WRITER-SYSTEM' }],
    ['editor', { name: 'Editor', provider: 'openrouter', model: 'editor-model', system: 'EDITOR-SYSTEM' }],
    ['reviewer', { name: 'Reviewer', provider: 'custom', model: 'review-model', system: 'REVIEW-SYSTEM' }]
  ]);
  const fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : {};
    let data, message = null, chat = '';
    if (u.origin === 'https://telegram.fixture' && /^\/botfixture\//.test(u.pathname)) {
      const method = u.pathname.split('/').at(-1);
      if (method === 'getMe') data = { ok: true, result: { id: 1, username: 'fixture_bot', first_name: 'Fixture' } };
      else if (method === 'sendChatAction' || method === 'setMessageReaction') data = { ok: true, result: true };
      else if (method === 'sendMessage') { message = body.text; chat = String(body.chat_id); data = { ok: true, result: { message_id: ++next } }; }
      else throw new Error('Unexpected Telegram method: ' + method);
    } else if (u.origin === 'https://discord.com' && /\/channels\/DM42\/messages$/.test(u.pathname)) {
      message = body.content; chat = 'DM42'; data = { id: String(++next) };
    } else if (u.origin === 'https://slack.com' && u.pathname === '/api/chat.postMessage') {
      message = body.text; chat = body.channel; data = { ok: true, ts: String(++next) };
    } else if (u.origin === 'https://matrix.fixture' && /\/send\/m.room.message\//.test(u.pathname)) {
      message = body.body; chat = decodeURIComponent(u.pathname.split('/rooms/')[1].split('/')[0]); data = { event_id: '$out' + (++next) };
    } else if (u.origin === 'https://signal.fixture' && u.pathname === '/v2/send') {
      message = body.message; chat = body.recipients[0]; data = { timestamp: ++next };
    } else throw new Error('Unexpected transport request: ' + u.origin + u.pathname);
    if (message !== null) wire.push({ text: message, chat, method: options.method, path: u.pathname });
    return { ok: true, status: 200, json: async () => data };
  };
  const recordRun = async o => {
    runs.push(o);
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'UNACCEPTED-TOKEN' });
    o.emit('agent.tool_call', { agentId: o.agentId, runId: o.runId, name: 'fixture.read', args: {} });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'Accepted answer from ' + o.agentId });
    const end = { agentId: o.agentId, runId: o.runId, reason: 'done', outcome: 'succeeded', turns: 1, usd: 0 };
    o.emit('agent.run.end', end);
    return Object.assign({ text: 'Accepted answer from ' + o.agentId }, end);
  };
  const chain = makeChainRunner({ nextAgent: () => null,
    stepAgent: id => !chained ? null : id === 'writer' ? { agentId: 'editor' } : id === 'editor' ? { agentId: 'reviewer' } : null });
  const lineRunner = makeLineRunner({ chain, runOnce: recordRun, newId: () => crypto.randomUUID(), now: Date.now });
  const wrapAdapter = make => opts => {
    const adapter = make(opts), disconnect = adapter.disconnect;
    adapter.connect = () => { lifecycle.push('poll-requested'); };
    adapter.disconnect = () => { lifecycle.push('disconnect'); return disconnect.call(adapter); };
    adapters.push(adapter);
    return adapter;
  };
  const channelStore = makeChannelStore({ fs, pathMod: path, root, clock: { now: Date.now } });
  const context = {
    fetch, console: { log() {}, warn: (...args) => warnings.push(args.join(' ')) }, crypto, Date, Math,
    WebSocket: class FixtureSocket { constructor() { throw new Error('Explicit dispatch must not open a socket'); } },
    channelHubFactory: Factory, makePromptRegistry, makeTelegramTransport,
    makeTelegramAdapter: wrapAdapter(require('../sidecar/channels/telegram.js').makeTelegramAdapter),
    channelRegistry: Registry.makeChannelRegistry({ adapters: Object.fromEntries(['discord','slack','matrix','signal'].map(id =>
      [id, wrapAdapter(require('../sidecar/channels/' + id + '.js')['make' + id[0].toUpperCase() + id.slice(1) + 'Adapter'])])) }),
    makeChannelHub: options => {
      const hub = Hub.makeChannelHub(options), close = hub.close;
      hub.close = () => { lifecycle.push('close'); return close.call(hub); };
      hubs.push(hub); return hub;
    },
    wireChannel: (descriptor, deps) => Registry.wireChannel(descriptor, { ...deps, makeHub: context.makeChannelHub }),
    unwireChannel: Registry.unwireChannel,
    channelStore, channelHistory: History.make(channelStore).history, botScopedStores: new Map(), lineRunner, runOnce: recordRun, agentRoster: roster, RunWire,
    channelSecrets: { telegramBots: { bot: { token: 'fixture', ownerId: 'owner', username: 'fixture_bot', agentId: 'writer', provider: 'custom', model: 'stale-model', key: 'fixture-bot-own-key' } } },
    channelTokenRuntime: {}, telegram: null, telegramStatus: {}, discord: null, discordStatus: {},
    genericChannels: {}, genericStatus: {}, telegramBots: new Map(), stationBotUsername: '', stationBotName: '', stationBotSeesAll: null,
    channelToken: (_id, _candidate, rec) => rec.token,
    channelCredential: id => id.startsWith('telegramBots:') ? context.channelSecrets.telegramBots.bot : context.channelSecrets[id] || {},
    credStore: { resolve: (provider, { channel }) => ({ key: channel.key || 'fixture-' + provider, baseUrl: 'https://provider.fixture/' + provider }) },
    saveChannelSecrets: () => true, channelOwnerAdmission: () => false, telegramOwnerAdmission: () => false,
    persistOwnerClaim: () => { throw new Error('An already paired fixture must not claim a new owner'); },
    persistTelegramBotOwnerClaim: () => { throw new Error('An already paired fixture must not claim a new bot owner'); },
    channelNotice: () => async () => ({ ok: true }), publishCommandMenu() {}, telegramStatusLine() {},
    TELEGRAM_API_BASE: 'https://telegram.fixture', TELEGRAM_PERSONA: 'TELEGRAM-PERSONA', DISCORD_PERSONA: 'DISCORD-PERSONA',
    telegramTransportFetch: () => fetch, makeConnectGateway: () => () => { throw new Error('Explicit dispatch must not open a gateway'); },
    normalizeProvider: p => p || 'openrouter', normalizeProviderId: p => ['custom','openrouter'].includes(p) ? p : '',
    providerRuntimeKey: (provider, key) => key || 'fixture-' + provider,
    providerRuntimeBaseUrl: provider => 'https://provider.fixture/' + provider,
    providerHasCredential: () => true, providerHasStoredCredential: () => true,
    providerCredentialError: () => 'missing fixture credential', channelKeyLostError: () => 'fixture key lost', expiredSignInNote: () => '',
    resolveReasoningEffort: (_provider, effort) => effort || 'default', chatModelId: (_provider, model) => model,
    codexTokens: null, CODEX_DEFAULT_MODEL: 'unused', registryProviderUsesCodex: () => false, ENV: () => '',
    router: { resolveDock: () => ({ agentId: routed }), lineOriginFor: () => chained ? 'fixture-line' : null, stationFor: () => null, stageBrief: () => null },
    // the host asks the router through its admit (dispatch) and observe (read) seams, routing/saved-seams.js
    admit: { resolveDock: () => ({ agentId: routed }), lineOriginFor: () => chained ? 'fixture-line' : null, stationFor: () => null, stageBrief: () => null },
    observe: { intakeReceiptFor: () => null },
    rosterWireRows: () => [...roster].map(([agentId, row]) => ({ agentId, ...row })),
    setAgentModelFromChannel: (agentId, model) => { roster.get(agentId).model = model; return { ok: true, model }; },
    maybeRewarmModelCatalog() {}, orModelCatalogIds: null,
    channelSteerRun: () => ({ ok: false }), transcriptStore: { reconstruct: () => [] }, channelObserveInto() {},
    runSlashForChannel: () => ({ handled: false }), userCommandEntries: () => [], isDesktopSlashCommand: () => false,
    Classify, TaskIntent, taskBriefStore: { active: () => null, groundedFor: () => null },
    // The production redactor preserves event object shape. All credentials here are synthetic;
    // object-to-string coercion would destroy the lead's end receipt before the hub reads it.
    redact: value => value, chanEmit: (name, data) => events.push({ name, data }), media: { transcribeForMime() {} }, attachments: { saveAttachment() {} },
    scrubOutbound: String, guardOutbound: adapter => Scrub.guardOutbound(adapter, String),
    channelAskConsent() {}, channelResolveConsent() {}, channelConsentOutcome() {},
    activeItem: new Map(), bumpQueue: () => 0, QUEUE_CAP: 20
  };
  vm.createContext(context);
  vm.runInContext(hostCode, context);
  const cfg = { ownerId: 'owner', agentId: 'writer', model: 'stale-model', provider: 'custom', system: 'STALE-SYSTEM',
    endpoint: kind === 'signal' ? 'https://signal.fixture' : 'https://matrix.fixture', account: '+15550000000' };
  if (kind === 'telegram') context.startTelegram('fixture', cfg.model, cfg);
  else if (kind === 'telegram-bot') context.startTelegramBot('bot');
  else if (kind === 'discord') context.startDiscord('fixture', cfg.model, cfg);
  else context.startGenericChannel(kind, kind === 'slack' ? 'xoxb-fixture xapp-fixture' : 'fixture', cfg.model, cfg);
  const connection = kind === 'telegram' ? context.telegram : kind === 'telegram-bot' ? context.telegramBots.get('bot')
    : kind === 'discord' ? context.discord : context.genericChannels[kind];
  const stop = () => {
    if (kind === 'telegram') context.stopTelegram();
    else if (kind === 'telegram-bot') context.stopTelegramBot('bot');
    else if (kind === 'discord') context.stopDiscord();
    else context.stopGenericChannel(kind);
  };
  return { context, runs, wire, warnings, lifecycle, events, connection, roster, stop,
    route: (agentId, hops) => { routed = agentId; chained = hops; },
    cleanup: () => { stop(); for (const hub of hubs) hub.close(); for (const adapter of adapters) adapter.disconnect(); } };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-factory-transport-'));
  try {
    for (const kind of KINDS) {
      const s = station(kind, path.join(root, kind));
      try {
        A.eq(s.lifecycle.filter(x => x === 'poll-requested').length, 1, kind + ': actual starter requests one poll owner');
        s.connection.adapter._internals.dispatch(raw(kind, 'Write a stranger reply', 1, true));
        A.eq(s.runs.length, 0, kind + ': a stranger never reaches the paid edge');
        A.eq(s.wire.length, 0, kind + ': a stranger never receives a reply');
        for (const [i, mode] of ['direct', 'live-change', 'two-hop'].entries()) {
          s.route(mode === 'live-change' ? 'editor' : 'writer', mode === 'two-hop');
          if (mode === 'live-change') s.roster.get('writer').model = 'writer-updated';
          const before = s.runs.length, sent = s.wire.length;
          s.connection.adapter._internals.dispatch(raw(kind, 'Write the requested answer ' + mode, i + 2));
          await until(() => s.wire.length > sent && s.connection.hub._internals.inflight.size === 0, kind + '/' + mode + ' reply');
          const expected = mode === 'two-hop' ? ['writer', 'editor', 'reviewer'] : [mode === 'live-change' && kind !== 'telegram-bot' ? 'editor' : 'writer'];
          const calls = s.runs.slice(before);
          A.eq(calls.map(call => call.agentId), expected, kind + '/' + mode + ': exact live entry and downstream owners');
          for (const [at, id] of expected.entries()) {
            const config = s.context.channelRunConfigFor(id), run = calls[at];
            A.eq(run && [run.provider, run.model, run.system], [config.provider, config.model, at === 0 ? Hub.dockSystem(config.system, null, true) : config.system],
              kind + '/' + mode + ': ' + id + ' owns its provider/model/system');
            A.eq(run && run.key, kind === 'telegram-bot' && at === 0 ? 'fixture-bot-own-key' : 'fixture-' + config.provider,
              kind + '/' + mode + ': ' + id + ' receives its scoped credential without crossing a downstream provider');
          }
          const replies = s.wire.slice(sent);
          A.ok(replies.some(reply => reply.text.includes('Accepted answer from ' + expected.at(-1))), kind + '/' + mode + ': actual transport carries accepted terminal output');
          A.ok(replies.every(reply => !reply.text.includes('UNACCEPTED-TOKEN')), kind + '/' + mode + ': token-only text is not delivered');
          A.ok(replies.every(reply => reply.chat === (kind.startsWith('telegram') ? '42' : kind === 'discord' ? 'DM42' : kind === 'slack' ? 'D42' : kind === 'matrix' ? '!room:fixture' : 'owner')),
            kind + '/' + mode + ': actual transport addresses the admitted conversation');
        }
        const paid = s.runs.length, sent = s.wire.length;
        s.connection.adapter._internals.dispatch(raw(kind, '/status', 50));
        await until(() => s.wire.length > sent, kind + ' live status reply');
        A.ok(s.wire.slice(sent).some(reply => reply.text.includes('(writer-updated)')), kind + ': real adapter status reads the current target model');
        A.eq(s.runs.length, paid, kind + ': status does not invoke the run host');
        A.eq(s.warnings, [], kind + ': actual host wrappers did not swallow a wiring exception');
        const beforeStop = s.lifecycle.length;
        s.stop();
        A.eq(s.lifecycle.slice(beforeStop), ['close', 'disconnect'], kind + ': host closes hub before disconnecting transport');
      } finally { s.cleanup(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  A.report('channels.factory-transport.test');
})().catch(error => { console.error(error); process.exitCode = 1; });
