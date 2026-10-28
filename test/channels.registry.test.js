/* node test/channels.registry.test.js — the channel registry + generic wire-up (H6.2).
   Proves: (A) the registry lists exactly the two supported channels and the discord entry points at the REAL
   adapter factory; (B) a STUB channel registered via the registry, wired by wireChannel, drives the SAME real
   makeChannelHub -> runOnce (autonomous surface) and replies through the tied send-ref; (C) the REAL discord
   descriptor, wired generically with an injected gateway, honors normalize + owner-gate (TOFU) end-to-end —
   a first DM is admitted to runOnce, a second DM from a DIFFERENT user is refused. No real network. */
'use strict';
const A = require('./_assert.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const { makeDiscordAdapter, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/discord.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

const tick = () => new Promise(r => setTimeout(r, 0));
function fakeStore() {
  const hist = new Map();
  return {
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); return arr; },
    getChatRecord() { return null; }, hist
  };
}
const ids = () => { let i = 0; return () => 'r' + (++i); };
function fakeFetch() { return async () => ({ ok: true, status: 200, async json() { return { id: '1' }; }, headers: { get: () => null } }); }

(async () => {
  // ---- A. registry contents ----
  {
    const reg = makeChannelRegistry();
    A.ok(reg.has('telegram') && reg.has('discord'), 'registry includes telegram + discord');
    A.eq(reg.ids().slice().sort(), ['discord', 'matrix', 'signal', 'slack', 'telegram'], 'exactly the five supported channels by default (webhook-only platforms OUT)');
    A.eq(reg.get('slack').auth, 'token2', 'slack declares its two-token auth shape');
    A.eq(reg.get('matrix').auth, 'endpoint+token', 'matrix declares homeserver + access token');
    A.eq(reg.get('signal').auth, 'endpoint+account', 'signal declares endpoint + account (no secret token)');
    A.eq(typeof reg.get('slack').makeAdapter, 'function', 'slack descriptor points at a real adapter factory');
    A.eq(typeof reg.get('matrix').makeAdapter, 'function', 'matrix descriptor points at a real adapter factory');
    A.eq(typeof reg.get('signal').makeAdapter, 'function', 'signal descriptor points at a real adapter factory');
    A.eq(reg.get('discord').maxMessageLength, MAX_MESSAGE_LENGTH, 'discord descriptor carries the real 2000 cap');
    A.eq(reg.get('discord').makeAdapter, makeDiscordAdapter, 'discord descriptor points at the REAL adapter factory (no longer dead code)');
    A.eq(reg.get('discord').env.tokenVar, 'SKYNET_DISCORD_TOKEN', 'discord descriptor names its env token var for auto-start');
    A.eq(reg.get('nope'), null, 'unknown channel -> null');
  }

  // ---- B. a stub channel registered -> wireChannel drives the SAME runOnce + ties the send-ref ----
  {
    const reg = makeChannelRegistry();
    let ran = null;
    const runOnce = async (o) => {
      ran = o;
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'hi there' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    let onInboundRef = null; const sent = [];
    reg.register({ id: 'stub', label: 'Stub', maxMessageLength: 100, makeAdapter: (o) => {
      onInboundRef = o.onInbound;
      return { connect() {}, disconnect() {}, send: (c, t) => { sent.push({ c, t }); return Promise.resolve({ ok: true, messageId: 'm1' }); } };
    } });
    A.ok(reg.has('stub'), 'a stub channel can be registered at runtime');
    const wired = wireChannel(reg.get('stub'), {
      hub: { runOnce, store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() }
    });
    A.ok(wired.hub && wired.adapter, 'wireChannel returns a hub + adapter');
    A.eq(typeof onInboundRef, 'function', 'the adapter received hub.onInbound (generic inbound routing)');
    await onInboundRef({ channel: 'stub', chatId: '42', chatType: 'dm', userId: 'u', text: 'hello', messageId: '1', ts: 1 });
    A.ok(ran && ran.surface === 'autonomous', 'the stub channel drove the SAME runOnce on the autonomous surface');
    A.eq(ran.messages, [{ role: 'user', content: 'hello' }], 'the inbound text reached runOnce as the user turn');
    A.eq(sent.length, 1, 'the reply went out through the wired adapter.send (send-ref closure tied)');
    A.ok(/hi there/.test(sent[0].t), 'reply text assembled from runOnce tokens');
  }

  // ---- C. the REAL discord descriptor wires into a STARTABLE adapter bound to the hub ----
  //   The host passes ownerUserId through this generic wire path; a preset owner must survive restart and
  //   refuse a stranger's first DM before it reaches runOnce.
  {
    const reg = makeChannelRegistry();
    const ran = [], sent = [], claims = [];
    const runOnce = async (o) => {
      ran.push(o);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(), token: 'T', connectGateway: ({ onMessage }) => {
      onMessage({ id: '1', channel_id: 'x', content: 'steal it', author: { id: 'stranger', username: 's' } });
      onMessage({ id: '2', channel_id: 'y', content: 'owner msg', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    }, parkMs: 1, sleep: ms => new Promise(r => setTimeout(r, ms)) });
    const { hub, adapter } = wireChannel(reg.get('discord'), {
      hub: { runOnce, store: fakeStore(), send: (c, t) => { sent.push({ c, t }); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 }, ownerUserId: 'owner', onOwnerClaim: u => claims.push(u) }
    });
    A.eq(typeof adapter.connect, 'function', 'discord wires into an adapter with connect()');
    A.eq(typeof adapter.disconnect, 'function', 'discord adapter exposes disconnect()');
    A.eq(typeof adapter.send, 'function', 'discord adapter exposes send() (the hub send-ref target)');
    A.eq(typeof hub.onInbound, 'function', 'a real makeChannelHub backs the discord channel (inbound -> runOnce path exists)');
    await adapter.connect();
    for (let i = 0; i < 20 && ran.length < 1; i++) await tick();
    A.eq(ran.length, 1, 'preset Discord owner through wireChannel: stranger first DM did not reach runOnce');
    A.eq(ran[0].messages, [{ role: 'user', content: 'owner msg' }], 'the owner message reached runOnce');
    A.eq(claims, [], 'preset Discord owner through wireChannel does not emit a fresh owner claim');
    for (let i = 0; i < 20 && sent.length < 1; i++) await tick();
    A.eq(sent, [{ c: 'y', t: 'ok' }], 'reply went back to the owner channel');
    await adapter.disconnect();
  }

  // ---- D. (quick win 21) wireChannel forwards onMembership + onDelivery, every platform adapter passes them on,
  //      and unwireChannel closes the hub before it drops the adapter ----
  // Only the station Telegram bot (bespoke wiring in index.js) heard "you were blocked/kicked" and the per-send
  // delivery outcome: wireChannel built every Discord/Slack/Matrix/Signal adapter without them, and the four
  // platform factories dropped both on the way to makeChannelAdapter. And stopDiscord / stopGenericChannel dropped
  // the adapter without closing the hub, so the dead hub's outbox timer kept redelivering beside its replacement.
  {
    const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
    const { unwireChannel } = require('../sidecar/channels/registry.js');
    const reg = makeChannelRegistry();
    // a generic adapter whose transport yields ONE membership notice: "this chat removed the bot"
    let fed = false;
    reg.register({ id: 'memb', label: 'Memb', maxMessageLength: 100, makeAdapter: (o) => makeChannelAdapter(Object.assign({}, o, {
      name: 'memb', clock: { now: () => 5 }, sleep: () => Promise.resolve(), pollTimeoutSec: 1,
      transport: {
        getUpdates: async () => { if (fed) { await new Promise(r => setTimeout(r, 5)); return []; } fed = true; return [{ id: 1 }]; },
        send: async () => ({ ok: false, error: 'blocked', retryable: false })
      },
      normalize: () => ({ offset: 2, membership: { chatId: 'gone-1', chatType: 'dm', status: 'kicked' } })
    })) });
    const records = new Map();
    const store = Object.assign(fakeStore(), {
      getChatRecord: (c) => records.get(String(c)) || null,
      saveChatRecord: (c, patch) => { const m = Object.assign({}, records.get(String(c)), patch); records.set(String(c), m); return m; }
    });
    const deliveries = [];
    const wired = wireChannel(reg.get('memb'), {
      hub: { runOnce: async () => {}, store, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { onDelivery: (d) => deliveries.push(d) }
    });
    wired.adapter.connect();
    for (let i = 0; i < 50 && !(records.get('gone-1') || {}).unreachable; i++) await tick();
    A.ok(!!(records.get('gone-1') || {}).unreachable, 'a membership notice reaches the wired hub: the chat is marked unreachable');
    await wired.adapter.send('c1', 'hello');
    A.eq(deliveries.length, 1, 'the caller\'s onDelivery hears the send outcome through wireChannel');
    A.eq(deliveries[0].ok, false, 'and it carries the real outcome');
    // unwireChannel: the hub closes BEFORE the adapter disconnects
    const order = [];
    unwireChannel({ hub: { close: () => order.push('hub.close') }, adapter: { disconnect: () => order.push('adapter.disconnect') } });
    A.eq(order, ['hub.close', 'adapter.disconnect'], 'unwireChannel closes the hub, then disconnects the adapter');
    A.eq(unwireChannel(null), false, 'unwiring nothing is a safe no-op');
    unwireChannel(wired);
    // every platform factory forwards both callbacks to the generic adapter
    const { makeSlackAdapter } = require('../sidecar/channels/slack.js');
    const { makeMatrixAdapter } = require('../sidecar/channels/matrix.js');
    const { makeSignalAdapter } = require('../sidecar/channels/signal.js');
    const factories = { discord: makeDiscordAdapter, slack: makeSlackAdapter, matrix: makeMatrixAdapter, signal: makeSignalAdapter };
    for (const name of Object.keys(factories)) {
      const seen = [];
      const ad = factories[name]({
        clock: { now: () => 1 }, sleep: () => Promise.resolve(),
        transport: { getUpdates: async () => [], send: async () => ({ ok: true, messageId: 'x' }) },
        onDelivery: (d) => seen.push(d)
      });
      await ad.send('c1', 'hi');
      A.eq(seen.length, 1, name + ' adapter forwards onDelivery to the generic adapter');
      A.eq(seen[0] && seen[0].ok, true, name + ' adapter reports the real send outcome');
    }
    const { sidecarSourceFiles } = require('./helpers/source.js');
    for (const name of Object.keys(factories)) {
      const f = sidecarSourceFiles().find(x => x.rel === 'sidecar/channels/' + name + '.js');
      A.ok(!!f && /onMembership: o\.onMembership/.test(f.text), name + ' factory passes onMembership on (a transport that learns it can report it)');
    }
  }

  // ---- E. (quick win 21) the host's Discord + generic teardown close the hub (sliced, never the whole sidecar text) ----
  {
    const { sidecarTopLevelFunction } = require('./helpers/source.js');
    for (const fn of ['stopDiscord', 'stopGenericChannel']) {
      const body = sidecarTopLevelFunction(fn);
      A.ok(body.length > 0 && body.length < 2000, fn + ' is found and sliced');
      A.ok(/unwireChannel\(/.test(body), fn + ' tears its channel down through unwireChannel (hub.close, then disconnect)');
    }
  }

  A.report('channels.registry.test');
})().catch(e => { console.error(e); process.exit(1); });
