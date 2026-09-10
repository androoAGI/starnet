/* node test/channels.discord-wire.test.js — the HOST wiring for the Discord channel (P0-4, settings gap audit).
   The Discord adapter + transport shipped fully-tested (channels.discord*.test.js) and the registry knows it
   (channels.registry.test.js), but the running sidecar never exposed it: no /api/channels/discord/* endpoints and
   the Messaging panel had no Discord card. This guards THAT seam:
   1) BACKEND source-guard over sidecar/index.js — the four discord endpoints are routed, dispatch to handlers that
      mirror the Telegram ones, start/stop through startDiscord/stopDiscord, and the status handler NEVER echoes the
      token (secret-safety, matching the Telegram contract).
   2) FRONTEND source-guard over the Messaging card — a Discord card with a masked token, connect/disconnect, a live
      status line, the shared autonomous-ping opt-in, and inline "how to get a bot token" help, mirroring Telegram.
   3) A behavioural check that the real registry's discord descriptor is startable + participates in the generic
      wire path (belt-and-braces over the registry test), and that connect()/disconnect() are clean with no gateway
      (the honest no-WS default): connect does not throw, disconnect does not throw, send still returns a SendResult. */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory(a) { return (hist.get(a) || []).slice(); },
           appendTurn(a, r, c) { const arr = hist.get(a) || []; arr.push({ role: r, content: c }); hist.set(a, arr); return arr; },
           getChatRecord() { return null; } };
}
const ids = () => { let i = 0; return () => 'r' + (++i); };
function fakeFetch() { return async () => ({ ok: true, status: 200, async json() { return { id: '1' }; }, headers: { get: () => null } }); }

(async () => {
  // ---------- 1. BACKEND source-guard: the four discord endpoints + handlers exist and mirror Telegram ----------
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

  // Telegram (the model we mirror) is untouched — additive-only guarantee.
  A.ok(/\/api\/channels\/telegram\/connect/.test(idx), 'Telegram connect route still present (not regressed)');
  A.ok(/function startTelegram/.test(idx), 'startTelegram still present');

  // the four Discord routes are wired into the request dispatcher
  A.ok(/m: 'POST', exact: '\/api\/channels\/discord\/connect'/.test(idx), 'POST /api/channels/discord/connect routed');
  A.ok(/m: 'POST', exact: '\/api\/channels\/discord\/disconnect'/.test(idx), 'POST /api/channels/discord/disconnect routed');
  A.ok(/m: 'GET', exact: '\/api\/channels\/discord\/status'/.test(idx), 'GET /api/channels/discord/status routed');
  A.ok(/m: 'POST', exact: '\/api\/channels\/discord\/sync'/.test(idx), 'POST /api/channels/discord/sync routed');

  // each route dispatches to its handler
  A.ok(/function handleDiscordConnect/.test(idx), 'handleDiscordConnect defined');
  A.ok(/function handleDiscordDisconnect/.test(idx), 'handleDiscordDisconnect defined');
  A.ok(/function handleDiscordStatus/.test(idx), 'handleDiscordStatus defined');
  A.ok(/function handleDiscordSync/.test(idx), 'handleDiscordSync defined');

  // the connect/disconnect path drives the real adapter lifecycle (started the SAME way Telegram is)
  A.ok(/startDiscord\(token,/.test(idx), 'handleDiscordConnect starts the adapter via startDiscord');
  A.ok(/function stopDiscord/.test(idx), 'stopDiscord present (disconnect lifecycle)');
  A.ok(/stopDiscord\(\)/.test(idx), 'disconnect handler stops the adapter');

  // P2-E: the host injects the REAL gateway WS client (full-duplex), not an inert no-WS default. Guard that
  // startDiscord actually wires connectGateway from discord.gateway.js — else ingress silently regresses to inert.
  A.ok(/require\('\.\/channels\/discord\.gateway\.js'\)/.test(idx), 'index requires the real Discord gateway client');
  const startBody = (idx.split('function startDiscord')[1] || '').split('function stopDiscord')[0];
  A.ok(/connectGateway:\s*makeConnectGateway\(/.test(startBody), 'startDiscord injects a real connectGateway (full-duplex ingress)');
  A.ok(/onState:/.test(startBody), 'the gateway reports transport health into discordStatus (truthful status line)');

  // SECRET-SAFETY: the status handler reports only booleans/state — never the token/key. Guard the shape.
  const dcStatusBody = (idx.split('function handleDiscordStatus')[1] || '').split('function ')[0];
  // `configured` is a boolean derived from the resolved token (keychain/runtime on desktop, plaintext record in
  // the bare sidecar) via channelToken() — never the token value itself.
  A.ok(/const configured = !!channelToken\('discord'/.test(dcStatusBody) && /configured:\s*configured\b/.test(dcStatusBody), 'status reports a boolean "configured" from the resolved token, not the token itself');
  A.ok(!/token:\s*d\.token/.test(dcStatusBody), 'status handler never puts the raw token in its JSON');
  A.ok(!/\bkey:\s*d\.key/.test(dcStatusBody), 'status handler never puts the raw key in its JSON');
  A.ok(/notifyAutonomous/.test(dcStatusBody), 'status surfaces the shared autonomous-ping opt-in (parity with Telegram)');

  // ---------- 2. FRONTEND source-guard: the Messaging Discord card mirrors the Telegram card ----------
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');

  // Telegram card intact (additive-only): its masked token field + its catalog entry that generates tg-connect
  A.ok(/id="tg-token"/.test(station) && /pre: 'tg'/.test(station), 'Telegram card preserved (not regressed)');

  // the Discord card (now a channel-catalog entry): header, masked token field, generated connect/disconnect/
  // status/msg elements (ids come from the entry's `pre: 'dc'`), and the ONE shared autonomous-ping opt-in.
  A.ok(/title: 'DISCORD'/.test(station), 'DISCORD card present in the channel catalog');
  A.ok(/id="dc-token"[^>]*type="password"/.test(station), 'Discord token field is masked (type=password), matching Telegram');
  A.ok(/pre: 'dc'/.test(station), 'Discord catalog entry generates its dc-connect/dc-disconnect/dc-status/dc-msg controls');
  A.ok(/'-connect'/.test(station) && /'-disconnect'/.test(station) && /'-status'/.test(station) && /'-msg'/.test(station), 'the catalog renderer generates connect/disconnect/status/msg elements per card');
  A.ok(/id="ch-notify"/.test(station), 'the ONE shared autonomous-ping opt-in present (replaces per-card toggles)');

  // the cards talk to the real endpoints through the generic builder + the bulk status poll
  A.ok(/'\/api\/channels\/' \+ c\.id \+ '\/connect'/.test(station), 'card CONNECT hits /api/channels/<id>/connect');
  A.ok(/'\/api\/channels\/' \+ c\.id \+ '\/disconnect'/.test(station), 'card DISCONNECT hits /api/channels/<id>/disconnect');
  A.ok(/\/api\/channels\/status/.test(station), 'the panel paints from the bulk status endpoint');

  // beginner help: a one-line pointer to where the bot token comes from
  A.ok(/Developer Portal/.test(station), 'inline help points at the Discord Developer Portal for the bot token');
  A.ok(/MESSAGE CONTENT INTENT/.test(station), 'inline help flags the message-content intent gotcha');

  // P2-E: the "send-only" disclosure is GONE — Discord is now full-duplex, and the card must claim two-way honestly.
  A.ok(!/Send-only for now/.test(station), 'the "Send-only for now" disclaimer was removed (Discord now receives)');
  A.ok(!/don\\?'t reach the agent yet/.test(station), 'the "replies don\'t reach the agent yet" line was removed');
  A.ok(/DM your Discord bot to talk to your agent/.test(station), 'the Discord card now advertises two-way chat (truthful full-duplex)');
  // the status line reflects that receive works when connected (generic '● CONNECTED — <verb>' + discord's verb).
  A.ok(/CONNECTED — ' \+ c\.verb/.test(station) && /verb: 'receiving'/.test(station), 'the connected status says it is receiving (not just sending)');

  // keep-saved-when-blank contract (reconnect without re-pasting), same as Telegram
  A.ok(/paste your Discord bot token first/.test(station), 'first-time setup requires a token; a saved token allows blank reconnect');

  // ---------- 3. BEHAVIOUR: the real registry's discord descriptor is startable + clean without a gateway ----------
  {
    const reg = makeChannelRegistry();
    A.ok(reg.has('discord'), 'registry exposes the discord channel the host starts');
    // no connectGateway injected -> ingress is inert (honest no-WS default). connect/disconnect must NOT throw and
    // send must still return a normalized SendResult — the "clear error state, not a crash" the task asks for.
    const transport = makeDiscordTransport({ fetch: fakeFetch(), token: 'T', parkMs: 1 });
    const { adapter } = wireChannel(reg.get('discord'), {
      hub: { runOnce: async () => {}, store: fakeStore(), send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 } }
    });
    A.notThrows(() => adapter.connect(), 'discord adapter connects cleanly with no gateway (inert ingress, no crash)');
    const sr = await adapter.send('chan', 'hi');
    A.ok(sr && typeof sr.ok === 'boolean', 'send returns a normalized SendResult even with no real gateway');
    await A.notThrows(() => adapter.disconnect(), 'discord adapter disconnects cleanly');
  }

  A.report('channels.discord-wire');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
