'use strict';
/* node test/channels.connect-provider-switch.test.js — a channel reconnect that switches provider never sends the OLD
   provider's saved key, or the OLD provider's saved endpoint, to the new provider.

   The bug (in every build since at least v0.14.1): the Telegram, Discord and generic-channel connect handlers fill every
   field the body leaves out from the channel's saved record, so RECONNECT is one click. They also reused the record's key
   and base URL, whatever provider the record was saved for. A reconnect that switched provider and sent no key (the
   desktop page never sends one) handed the old provider's key to the new provider as the EXPLICIT key, which beats a key
   the station holds for the new provider (providerRuntimeKey). The bot then sent it with every message: an OpenRouter
   key went to api.anthropic.com, or to a LAN CUSTOM server. The saved endpoint crossed the same way, so the new
   provider's key (or the station's) went to the old provider's server.

   Everything below runs the REAL sidecar source, lifted by name (test/helpers/source.js): the resolvers, the three
   connect handlers, and each start function's own per-message secrets() block, run against the record the connect saved.
   The start functions are stood in for by their own persistence line, which the source lock below pins.

   A later shape of these handlers calls a connect gate and a credential helper (run-wire: stationHubConnectError,
   channelConnectCredential). OPTIONAL lifts them, with the stubs they read, whenever the tree declares them, so the
   rows keep running the real handlers in either shape. Their stricter rule (a key the station holds is never written
   into a record) is not tested here; channels.station-key.test.js owns it.

   Rows A and B fail on the commit before the fix. C and D (a key in the body, and a one-click reconnect on the same
   provider) are controls that hold on both. */
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source.js');
const Reg = require('../sidecar/providers/registry.js');

const lift = name => { const s = sidecarFunctionSource(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };
const top = name => { const s = sidecarTopLevelFunction(name); A.ok(s.length > 20, 'fixture: ' + name + ' is lifted'); return s; };

const OR_KEY = 'sk-or-COMMANDER-OWN';
const STATION_OR = 'sk-or-STATION-KEYCHAIN';
const ANT_ENV = 'sk-ant-ENV-OPERATOR';
const LAN = 'http://192.168.1.40:1234/v1';
const PROXY = 'https://commander-proxy.example/v1';
const OR_DEFAULT = Reg.getProviderProfile('openrouter').baseUrl;
const ANT_DEFAULT = Reg.getProviderProfile('anthropic').baseUrl;

// ---- the start functions persist exactly the key and endpoint they are handed (the stand-ins below copy this line) ----
{
  const tg = top('startTelegram'), dc = top('startDiscord'), gen = top('startGenericChannel');
  A.ok(/telegram: \{\n\s+token: token, key: key, model: model, provider: provider, baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(tg), 'startTelegram saves the key and endpoint it is handed');
  A.ok(/discord: \{\n\s+token: token, key: key, model: model, provider: provider, baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(dc), 'startDiscord saves the key and endpoint it is handed');
  A.ok(/token: token \|\| undefined, key: key, model: model, provider: provider,\n\s+baseUrl: cfg\.baseUrl \|\| cfg\.base_url \|\| '',/.test(gen), 'startGenericChannel saves the key and endpoint it is handed');
}

// the per-message secrets() block of each start function: what every inbound message really runs on
function secretsBlock(fn) {
  const m = /\n\s+secrets: \(\) => \{\n([\s\S]*?\n\s+return \{ key[^\n]*\};)\n\s+\},\n/.exec(top(fn));
  A.ok(!!m, 'fixture: ' + fn + "'s per-message secrets() is sliced");
  return m ? m[1] : 'return {};';
}
const SECRETS = { telegram: secretsBlock('startTelegram'), discord: secretsBlock('startDiscord'), slack: secretsBlock('startGenericChannel') };

const RESOLVERS = ['normalizeProvider', 'providerRuntimeKey', 'providerOperatorKey', 'pageCopyRidesWith', 'providerRuntimeBaseUrl',
  'providerHasCredential', 'providerCredentialError', 'channelToken'];
const HANDLERS = ['handleChannelConnect', 'handleDiscordConnect', 'handleGenericChannelConnect'];
const OPTIONAL = ['normalizeProviderId', 'unknownProviderError', 'keptEndpointProvider', 'providerEndpointNotHandedOver', 'channelKeyIsStationHeld',
  'channelConnectCredential', 'channelRunConfigFor', 'stationHubRunConfig', 'stationHubConnectError'];
const LIFTED = RESOLVERS.map(lift).concat(OPTIONAL.map(n => sidecarFunctionSource(n)).filter(Boolean), HANDLERS.map(lift)).join('\n');

/* One station: its runtime keys (the desktop keychain push), operator env, the roster agent the channel runs, and the
   channel's saved records. The roster agent is on the provider the page reconnects with (the Commander moved it there). */
function station(opts) {
  const o = opts || {};
  const env = Object.assign({}, o.env || {});
  const agent = { name: 'NOVA', model: o.model || 'openai/gpt-5', provider: o.provider || 'openrouter' };
  const runtimeKeys = Object.assign(Object.create(null), o.runtimeKeys || {});
  let reqBody = {};
  const deps = {
    normalizeProviderIdFromRegistry: Reg.normalizeProviderId,
    getProviderProfile: Reg.getProviderProfile,
    registryProviderUsesCodex: Reg.providerUsesCodex,
    registryProviderUsesDeviceOAuth: Reg.providerUsesDeviceOAuth,
    providerRequiresKey: Reg.providerRequiresKey,
    providerRequiresBaseUrl: Reg.providerRequiresBaseUrl,
    providerUsesCodex: p => Reg.providerUsesCodex(Reg.normalizeProviderId(p, 'openrouter')),
    resolveCreditsConfig: () => ({ url: '', apiKey: '' }),
    envFirst: names => { for (const n of names || []) if (env[n]) return env[n]; return ''; },
    engineKeys: { get: () => null },
    runtimeKeys, runtimeBaseUrls: Object.create(null), runtimeKey: String(runtimeKeys.openrouter || ''),
    codexTokens: null, oauthProviders: {}, accountLive: () => false, anyExtraAccountLive: () => false, providerSignInExpired: () => false,
    channelTokenRuntime: {},
    resolveReasoningEffort: (p, e) => String(e || 'medium'),
    expiredSignInNote: () => '',
    readBody: async () => JSON.stringify(reqBody), CHANNEL_BODY_MAX: 1 << 20, channelBodyError: () => 'bad json',
    telegramStatus: { connected: false, state: 'connecting' }, discordStatus: { connected: false, state: 'connecting' }, genericStatus: {},
    issueTelegramOwnerPairing: () => ({ ok: true, code: 'PAIR', expiresAt: 0 }),
    withOwnerPairing: (id, out) => out,
    parseSlackTokens: () => ({ botToken: 'xoxb-1', appToken: 'xapp-1' }),
    // read only by the OPTIONAL helpers (the connect gate proves the roster agent's own pair)
    agentRoster: new Map([['agent', agent]]),
    runWireFor: () => ({ ok: true, provider: agent.provider, model: agent.model, source: 'agent', reasoningEffort: 'medium' }),
    chatModelId: (p, m) => m,
    SHELL_PUSHES_PROVIDER_CONFIG: false
  };
  const names = Object.keys(deps);
  const body = `
    let channelSecrets = ${JSON.stringify(o.secrets || {})};
    const started = [];
    // the start functions' own persistence line (pinned by the source lock above)
    function startTelegram(token, key, model, cfg) { started.push({ ch: 'telegram', key }); channelSecrets = Object.assign({}, channelSecrets, { telegram: { token: token, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startDiscord(token, key, model, cfg) { started.push({ ch: 'discord', key }); channelSecrets = Object.assign({}, channelSecrets, { discord: { token: token, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined } }); return { secretsPersisted: true }; }
    function startGenericChannel(id, token, key, model, cfg) { started.push({ ch: id, key }); const p = {}; p[id] = { token: token || undefined, key: key, model: model, provider: normalizeProvider(cfg.provider), baseUrl: cfg.baseUrl || cfg.base_url || '', enabled: true, agentId: cfg.agentId || undefined }; channelSecrets = Object.assign({}, channelSecrets, p); return { secretsPersisted: true }; }
    ${LIFTED}
    const perMessage = {
      telegram: () => { ${SECRETS.telegram} },
      discord: () => { ${SECRETS.discord} },
      slack: () => { const id = 'slack'; ${SECRETS.slack} }
    };
    return { handleChannelConnect, handleDiscordConnect, handleGenericChannelConnect, perMessage, started, get: () => channelSecrets };`;
  const api = new Function(...names, body)(...names.map(n => deps[n]));
  api.call = async (handler, b, ...extra) => {
    reqBody = b; let status = 0, out = '';
    try { await api[handler]({}, { writeHead(s) { status = s; }, end(t) { out = String(t || ''); } }, ...extra); }
    catch (e) { return { status: 'threw: ' + ((e && e.message) || e), body: {} }; }   // the caller's assertion reports it
    let j = {}; try { j = JSON.parse(out); } catch (_) { j = {}; }
    return { status, body: j };
  };
  return api;
}

const CHANNELS = [['handleChannelConnect', 'telegram', []], ['handleDiscordConnect', 'discord', []], ['handleGenericChannelConnect', 'slack', ['slack']]];
const record = (fields) => Object.assign({ token: 'tok', model: 'openai/gpt-5', enabled: true, agentId: 'agent' }, fields);
const sent = m => (m && m.configured) ? [m.key, m.baseUrl] : ['refused', ''];

(async () => {
  for (const [connect, ch, extra] of CHANNELS) {
    const recOf = s => s.get()[ch] || {};

    // ======================= A: the saved KEY never follows a provider switch =======================
    // A1. The record holds the Commander's OpenRouter key; the agent moves to Anthropic, and the station holds the
    // operator's Anthropic env key. The reconnect sends no key. Before: the OpenRouter key was the explicit key, it beat
    // the env key, and every message sent it to api.anthropic.com.
    {
      const s = station({ provider: 'anthropic', model: 'claude-x', env: { ANTHROPIC_API_KEY: ANT_ENV },
        secrets: { [ch]: record({ key: OR_KEY, provider: 'openrouter' }) } });
      const tag = ch + ' openrouter -> anthropic (env key)';
      const r = await s.call(connect, { provider: 'anthropic', model: 'claude-x', agentId: 'agent' }, ...extra);
      A.eq([r.status, recOf(s).provider], [200, 'anthropic'], tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.ok(recOf(s).key !== OR_KEY, tag + ': the OpenRouter key is not saved under anthropic');
      A.ok(s.started.every(x => x.key !== OR_KEY), tag + ': the bot is not started on the OpenRouter key');
      A.eq(sent(s.perMessage[ch]()), [ANT_ENV, ANT_DEFAULT], tag + ": each message runs the station's Anthropic key at Anthropic");
    }
    // A2. The same switch with no Anthropic key anywhere on the station. Before: 200, and the OpenRouter key went to
    // api.anthropic.com with every message. Now the connect is refused and the saved OpenRouter record stands as it was.
    {
      const s = station({ provider: 'anthropic', model: 'claude-x', secrets: { [ch]: record({ key: OR_KEY, provider: 'openrouter' }) } });
      const tag = ch + ' openrouter -> anthropic (no key)';
      const r = await s.call(connect, { provider: 'anthropic', model: 'claude-x', agentId: 'agent' }, ...extra);
      A.eq(r.status, 400, tag + ': the reconnect is refused (no Anthropic credential): ' + JSON.stringify(r.body));
      A.eq(s.started.length, 0, tag + ': no bot is started');
      A.eq([recOf(s).provider, recOf(s).key], ['openrouter', OR_KEY], tag + ': the saved OpenRouter record is untouched');
    }
    // A3. The agent moves to a keyless LAN CUSTOM server (the operator's env URL). Before: the OpenRouter key went to the
    // LAN server with every message. Now the bot runs keyless there, as the station is configured.
    {
      const s = station({ provider: 'custom', model: 'local/qwen', env: { CUSTOM_OPENAI_BASE_URL: LAN },
        secrets: { [ch]: record({ key: OR_KEY, provider: 'openrouter' }) } });
      const tag = ch + ' openrouter -> custom (LAN)';
      const r = await s.call(connect, { provider: 'custom', model: 'local/qwen', agentId: 'agent' }, ...extra);
      A.eq([r.status, recOf(s).provider], [200, 'custom'], tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.ok(recOf(s).key !== OR_KEY, tag + ': the OpenRouter key is not saved under custom');
      A.eq(sent(s.perMessage[ch]()), ['', LAN], tag + ': each message runs keyless at the LAN server, never with the OpenRouter key');
    }

    // ======================= B: the saved ENDPOINT never follows a provider switch =======================
    // B1. The record is a CUSTOM LAN server's; the reconnect moves to OpenRouter with a new OpenRouter key in the body.
    // Before: the LAN endpoint was reused, so the OpenRouter key went to the LAN server.
    {
      const s = station({ provider: 'openrouter', secrets: { [ch]: record({ key: 'sk-lan-OWN', provider: 'custom', model: 'local/qwen', baseUrl: LAN }) } });
      const tag = ch + ' custom -> openrouter (body key)';
      const r = await s.call(connect, { provider: 'openrouter', model: 'openai/gpt-5', key: 'sk-or-NEW', agentId: 'agent' }, ...extra);
      A.eq(r.status, 200, tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.eq(sent(s.perMessage[ch]()), ['sk-or-NEW', OR_DEFAULT], tag + ': each message sends the new key to OpenRouter, never to the LAN server');
    }
    // B2. A keyless LAN record; the desktop reconnect moves to OpenRouter with no key (the keychain holds one). Before:
    // the station's own OpenRouter key went to the LAN server.
    {
      const s = station({ provider: 'openrouter', runtimeKeys: { openrouter: STATION_OR },
        secrets: { [ch]: record({ provider: 'custom', model: 'local/qwen', baseUrl: LAN }) } });
      const tag = ch + ' custom -> openrouter (keychain key)';
      const r = await s.call(connect, { provider: 'openrouter', model: 'openai/gpt-5', agentId: 'agent' }, ...extra);
      A.eq(r.status, 200, tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.eq(sent(s.perMessage[ch]()), [STATION_OR, OR_DEFAULT], tag + ": each message sends the station's key to OpenRouter, never to the LAN server");
    }

    // ======================= C: a key in the body still wins on a switch (control) =======================
    {
      const s = station({ provider: 'anthropic', model: 'claude-x', secrets: { [ch]: record({ key: OR_KEY, provider: 'openrouter' }) } });
      const tag = ch + ' openrouter -> anthropic (body key)';
      const r = await s.call(connect, { provider: 'anthropic', model: 'claude-x', key: 'sk-ant-BODY', agentId: 'agent' }, ...extra);
      A.eq(r.status, 200, tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.eq(sent(s.perMessage[ch]()), ['sk-ant-BODY', ANT_DEFAULT], tag + ': each message runs the key the body sent');
    }

    // ======================= D: RECONNECT on the same provider is still one click (control) =======================
    for (const [label, saved, b, want] of [
      ['no provider in the body', { key: OR_KEY, provider: 'openrouter', baseUrl: PROXY }, {}, [OR_KEY, PROXY]],
      ['the provider spelled differently', { key: OR_KEY, provider: 'openrouter', baseUrl: PROXY }, { provider: 'OpenRouter' }, [OR_KEY, PROXY]],
      ['an alias of the saved provider', { key: 'sk-ant-OWN', provider: 'anthropic', model: 'claude-x' }, { provider: 'claude' }, ['sk-ant-OWN', ANT_DEFAULT]],
      ['a record saved before records named their provider', { key: OR_KEY }, { provider: 'openrouter' }, [OR_KEY, OR_DEFAULT]]
    ]) {
      const prov = Reg.normalizeProviderId(saved.provider || 'openrouter', 'openrouter');
      const s = station({ provider: prov, model: saved.model || 'openai/gpt-5', secrets: { [ch]: record(saved) } });
      const tag = ch + ' same provider, ' + label;
      const r = await s.call(connect, Object.assign({ agentId: 'agent' }, b), ...extra);
      A.eq(r.status, 200, tag + ': fixture: the reconnect lands: ' + JSON.stringify(r.body));
      A.eq(sent(s.perMessage[ch]()), want, tag + ': the saved key and endpoint are reused');
    }
  }
  A.report('channels.connect-provider-switch');
})();
