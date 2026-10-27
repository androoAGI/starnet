/* sidecar/channels/registry.js — the channel registry + a generic wire-up (H6.2).

   Telegram was bound by ~90 lines of bespoke wiring in index.js; Discord shipped a fully-tested adapter
   (channels/discord.js + .transport.js) that the host NEVER started — so "Discord support" existed in code but
   not in the running app. This module is the missing seam: a small DESCRIPTOR list ({ id, makeAdapter, transport,
   maxMessageLength, env }) plus `wireChannel(descriptor, deps)` that builds the SAME makeChannelHub + the
   descriptor's adapter and returns them connected-ready. One generic path drives every channel through the one
   real `runOnce`, so adding a channel is a registry row, not a fork. 2026-07-08: slack/matrix/signal joined the
   registry (Andrew's call — every messaging surface a LOCAL-FIRST sidecar can honestly drive, no public webhook).
   Webhook-only platforms (WhatsApp Cloud API, Messenger, LINE) stay OUT: a 127.0.0.1-bound sidecar cannot
   receive their pushes, and shipping a connector that can't hear replies would violate truthful telemetry.

   The live gateways still need a real token to connect for real — but the registry + wire path is fully testable
   with an injected adapter factory + fake hub, exactly as the per-channel adapter tests already inject transports.

     makeChannelRegistry({ adapters?, extra? }) -> { list, ids, has, get, register }
     wireChannel(descriptor, { hub, adapter, makeHub? }) -> { hub, adapter }   // send-ref closure tied for you */
'use strict';
(function (root, factory) {
  const api = factory(
    (typeof require === 'function') ? require('./hub.js') : (root.SK && root.SK.channels && { makeChannelHub: root.SK.channels.hub && root.SK.channels.hub.makeChannelHub }),
    (typeof require === 'function') ? require('./telegram.js') : (root.SK && root.SK.channels && root.SK.channels.telegram),
    (typeof require === 'function') ? require('./discord.js') : (root.SK && root.SK.channels && root.SK.channels.discord),
    (typeof require === 'function') ? require('./slack.js') : (root.SK && root.SK.channels && root.SK.channels.slack),
    (typeof require === 'function') ? require('./matrix.js') : (root.SK && root.SK.channels && root.SK.channels.matrix),
    (typeof require === 'function') ? require('./signal.js') : (root.SK && root.SK.channels && root.SK.channels.signal)
  );
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {}; root.SK.channels.registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (hubMod, tgMod, dcMod, slMod, mxMod, sgMod) {
  'use strict';
  const makeChannelHubDefault = hubMod && hubMod.makeChannelHub;

  // the SUPPORTED channels. env names mirror index.js's existing auto-start (token + shared key/model).
  // `auth` declares what a connect needs beyond provider config, so the host/UI stay data-driven:
  //   'token' = one secret token; 'token2' = two tokens combined in one secret string (slack xoxb+xapp);
  //   'endpoint+token' = a non-secret base URL + a secret token (matrix); 'endpoint+account' = a non-secret
  //   base URL + account id, no secret token at all (signal-cli REST).
  function defaultDescriptors(adapters) {
    const a = adapters || {};
    return [
      { id: 'telegram', label: 'Telegram', maxMessageLength: 4096, auth: 'token',
        makeAdapter: a.telegram || (tgMod && tgMod.makeTelegramAdapter),
        env: { tokenVar: 'SKYNET_TELEGRAM_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } },
      { id: 'discord', label: 'Discord', maxMessageLength: (dcMod && dcMod.MAX_MESSAGE_LENGTH) || 2000, auth: 'token',
        makeAdapter: a.discord || (dcMod && dcMod.makeDiscordAdapter),
        env: { tokenVar: 'SKYNET_DISCORD_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } },
      { id: 'slack', label: 'Slack', maxMessageLength: (slMod && slMod.MAX_MESSAGE_LENGTH) || 4000, auth: 'token2',
        makeAdapter: a.slack || (slMod && slMod.makeSlackAdapter),
        env: { tokenVar: 'SKYNET_SLACK_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } },
      { id: 'matrix', label: 'Matrix', maxMessageLength: (mxMod && mxMod.MAX_MESSAGE_LENGTH) || 4096, auth: 'endpoint+token',
        makeAdapter: a.matrix || (mxMod && mxMod.makeMatrixAdapter),
        env: { tokenVar: 'SKYNET_MATRIX_TOKEN', keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } },
      { id: 'signal', label: 'Signal', maxMessageLength: (sgMod && sgMod.MAX_MESSAGE_LENGTH) || 4096, auth: 'endpoint+account',
        makeAdapter: a.signal || (sgMod && sgMod.makeSignalAdapter),
        env: { keyVar: 'SKYNET_OPENROUTER_KEY', modelVar: 'SKYNET_DEFAULT_MODEL' } }
    ];
  }

  function makeChannelRegistry(opts) {
    opts = opts || {};
    const map = new Map();
    const add = (d) => { if (d && d.id) map.set(String(d.id), d); };
    defaultDescriptors(opts.adapters).forEach(add);
    (opts.extra || []).forEach(add);   // tests/host can register additional descriptors
    return {
      list() { return Array.from(map.values()); },
      ids() { return Array.from(map.keys()); },
      has(id) { return map.has(String(id)); },
      get(id) { return map.get(String(id)) || null; },
      register(d) { add(d); return this; }
    };
  }

  // build hub + adapter for ONE descriptor, tying the send-ref closure (hub.send -> adapter.send) and routing the
  // adapter's inbound/callback/status into the hub. `deps.hub` is the makeChannelHub bag MINUS channel/send/
  // maxMessageLength (filled here); `deps.adapter` is the adapter-specific bag (fetch/token/clock/owner...).
  function wireChannel(descriptor, deps) {
    if (!descriptor || typeof descriptor.makeAdapter !== 'function') throw new Error('wireChannel: descriptor.makeAdapter required');
    deps = deps || {};
    const makeHub = deps.makeHub || makeChannelHubDefault;
    if (typeof makeHub !== 'function') throw new Error('wireChannel: makeChannelHub unavailable');
    let adapterRef = null;
    const hub = makeHub(Object.assign({
      channel: descriptor.id,
      maxMessageLength: descriptor.maxMessageLength,
      send: (chatId, text, o) => adapterRef ? adapterRef.send(chatId, text, o) : Promise.resolve({ ok: false, error: 'no adapter' }),
      // typing indicator (adapter-optional): a transport without sendChatAction answers ok:false non-retryable,
      // so the hub probes once per run and shows no bubble — exactly the old behavior on those channels.
      chatAction: (chatId) => (adapterRef && typeof adapterRef.chatAction === 'function') ? adapterRef.chatAction(chatId) : Promise.resolve({ ok: false, error: 'no adapter', retryable: false }),
      // The paired owner, as the ADAPTER knows it (owner-pairing claim, never message text). Gates the hub's
      // owner-only control commands and Full Power inheritance. Unpaired -> nobody is the owner (fail closed).
      isOwner: (msg) => {
        const own = adapterRef && adapterRef._internals ? String(adapterRef._internals.owner || '') : '';
        return !!(own && msg && String(msg.userId == null ? '' : msg.userId) === own);
      }
    }, deps.hub));
    const adapterOpts = Object.assign({}, deps.adapter, {
      onInbound: (deps.adapter && deps.adapter.onInbound) || hub.onInbound,
      onCallback: (deps.adapter && deps.adapter.onCallback) || hub.onCallback,
      onStatus: (deps.adapter && deps.adapter.onStatus) || hub.onStatus,
      // OUR OWN membership changed (blocked / kicked): the hub marks the chat unreachable and drops its backlog. Only
      // the bespoke station-Telegram wiring passed this, so every registry-wired hub kept retrying a chat that had
      // removed the bot (quick win 21). onDelivery is the caller's per-send outcome hook (delivery health).
      onMembership: (deps.adapter && deps.adapter.onMembership) || (typeof hub.onMembership === 'function' ? hub.onMembership : undefined),
      onDelivery: (deps.adapter && deps.adapter.onDelivery) || undefined,
      // the groups the paired owner admitted with /allow, read live off the hub's chat records (a caller's own
      // list still wins). Absent, every group/guild/room message was dropped on every platform (2026-10-19).
      allowedChats: (deps.adapter && deps.adapter.allowedChats) || (typeof hub.chatAdmitted === 'function' ? hub.chatAdmitted : undefined)
    });
    const adapter = descriptor.makeAdapter(adapterOpts);
    adapterRef = adapter;
    return { hub, adapter };
  }

  /* unwireChannel({ hub, adapter }) — the ONE teardown for a wired channel: close the hub FIRST (stops its outbox retry
     timer and any flush/recovery it would start), then disconnect the adapter. Dropping only the adapter left the old
     hub's timer redelivering the shared outbox beside the reconnected hub's (quick win 21). Never throws; false = nothing. */
  function unwireChannel(wired) {
    if (!wired) return false;
    if (wired.hub && typeof wired.hub.close === 'function') { try { wired.hub.close(); } catch (_) {} }
    if (wired.adapter && typeof wired.adapter.disconnect === 'function') { try { wired.adapter.disconnect(); } catch (_) {} }
    return true;
  }

  return { makeChannelRegistry, wireChannel, unwireChannel, _internals: { defaultDescriptors } };
});
