/* node test/channels.delivery-line.test.js — a reply the platform refused for good is VISIBLE on every channel, not only on
   Telegram (channel-delivery-ledger: the spec's "parks retryable:false failures as visible 'undeliverable'").

   The delivery ledger gives such a reply up at once and reports it once: one channel.delivery 'undeliverable', one console
   line, and the channel's DELIVERY LINE (status.delivery: what Live Doctor and the status routes read). channel.delivery
   alone shows the owner nothing (the floor drops ok:false), so the line is the report. The adapter's onDelivery hook writes
   it, and only startTelegram and startTelegramBot wired that hook: on Discord, Slack, Matrix and Signal the status routes
   answered 'unknown' for ever, and a reply given up there left no trace but a console line.

   THE WIRING IS THE PRODUCTION ONE: each closure is lifted out of sidecar/index.js (test/helpers/source.js) and runs over a
   real hub, adapter and delivery ledger (Discord through wireChannel, its production path), with fakes only at the platform
   and the disk.
     A. Discord: a reply refused for good is one tombstone, one 'undeliverable', and the line goes down naming the refusal.
        The gateway's own state changes (a reconnect) keep the line; the next reply that lands clears it. A send refused for
        the moment (a 503) is on the line too, while its reply stays queued for the lane.
     B. Slack, Matrix, Signal: startGenericChannel's closures do the same, for every channel id it serves.
     C. The census: every site that builds an adapter wires onDelivery.
     D. Live Doctor reads the line for every channel: down is UNREACHABLE and names it, which covers a ledger that holds
        outbound too (channelDeliveryLine); a good or unknown line changes nothing.
     E. Discord's own status route carries the line, as every other status answer does.

   The CHANNELS panel still paints this line for Telegram and the bots alone (frontend/app/windows/messaging.js): that is
   the plan's open decision 3 for Andrew, a frontend edit with the claims re-lock it brings, and nothing here depends on it.

   RED on a scratch checkout of a3af8dafd: A's and B's lines stay undefined, C finds two sites of four, D answers
   AUTHENTICATED over a down line, and E's answer has no delivery. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { sidecarTopLevelFunction, sidecarFunctionSource, liftProp } = require('./helpers/source.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');
const LiveDoctor = require('../sidecar/live-doctor.js');

const T0 = Date.parse('2026-11-02T09:00:00.000Z');
const settle = async (n) => { for (let i = 0; i < (n || 40); i++) await new Promise(r => setImmediate(r)); };
const lifted = (src, name) => liftProp(src, name) || 'undefined';
const line = (() => {
  const src = sidecarFunctionSource('channelDeliveryLine');
  return (store, d) => (src ? new Function('channelStore', src + '\nreturn channelDeliveryLine;')(store)(d) : d);   // eslint-disable-line no-new-func
})();

// the fake Discord REST: each POST is answered from `plan` (a status), 200 once it is empty
function discordRest() {
  const r = { plan: [], posts: [] };
  r.fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url)) || !init || init.method !== 'POST') return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '{}' };
    const status = r.plan.length ? r.plan.shift() : 200;
    r.posts.push({ status: status, body: JSON.parse(String(init.body)) });
    return { ok: status === 200, status: status, headers: { get: () => null }, json: async () => ({ id: 'd' + r.posts.length }), text: async () => '{}' };
  };
  return r;
}
function memStore(now) {
  const files = new Map();
  const err = (code) => Object.assign(new Error(code), { code: code });
  const fs = {
    readFileSync(p) { if (!files.has(p)) throw err('ENOENT'); return files.get(p); },
    writeFileSync(p, d) { files.set(p, String(d)); },
    renameSync(a, b) { if (!files.has(a)) throw err('ENOENT'); files.set(b, files.get(a)); files.delete(a); },
    mkdirSync() {}
  };
  return makeChannelStore({ fs: fs, pathMod: path.posix, root: '/ws/channels', clock: { now: now }, bootId: 'line' });
}

(async () => {
  /* ---- A. Discord: wireChannel, its production path, under startDiscord's own closures ------------------------------ */
  {
    const src = sidecarTopLevelFunction('startDiscord');
    const scope = new Function('chanEmit',   // eslint-disable-line no-new-func
      'let discordStatus = { connected: true, state: "up", detail: "" };\n'
      + 'return { onDelivery: (' + lifted(src, 'onDelivery') + '), onState: (' + lifted(src, 'onState') + '), status: () => discordStatus };')(() => {});
    const rest = discordRest();
    const events = [];
    let now = T0;
    const store = memStore(() => now);
    const reg = makeChannelRegistry();
    const wired = wireChannel(reg.get('discord'), {
      outbound: (t) => t,
      hub: { runOnce: async () => {}, store: store, secrets: () => ({ key: 'k', model: 'm', configured: true }), classify: () => true, redact: (p) => p,
        emit: (name, p) => { if (name === 'channel.delivery') events.push(p); }, newId: () => 'r' + (++now), now: () => now },
      adapter: { fetch: rest.fetch, token: 'D', clock: { now: () => now }, connectGateway: () => ({ close() {} }), ownerUserId: 'owner', sleep: async () => {}, onDelivery: scope.onDelivery }
    });
    const quiet = console.error;
    const said = [];
    console.error = (l) => { said.push(String(l)); };
    try {
      rest.plan.push(403);
      const out = await wired.hub._internals.deliver('99', 'the answer', 'run-gone', 'done');
      await settle();
      A.eq([out.ok, out.undeliverable, rest.posts.length], [false, true, 1], 'A: a reply refused for good is tried once and given up');
      const gone = events.filter(e => e.reason === 'undeliverable');
      A.eq(gone.map(e => [e.runId, e.ok]), [['run-gone', false]], 'A: reported once on channel.delivery');
      A.eq((store.ledger ? store.ledger.tombstones('discord') : []).map(t => t.runId), ['run-gone'], 'A: one tombstone');
      A.ok(said.some(l => /undeliverable/.test(l)), 'A: one console line');
      const down = scope.status().delivery;
      A.eq(down && down.state, 'down', 'A: the delivery line goes down, as Telegram\'s does (was: never written on Discord)');
      A.ok(/discord http 403/.test(String(down && down.detail)), 'A: and names the refusal: ' + JSON.stringify(down));
      A.eq((line(store, down) || {}).state, 'down', 'A: every status reader gets it through channelDeliveryLine');

      // the gateway's own state changes do not wipe it: that answer is about the transport, this one about the sends
      scope.onState({ state: 'reconnecting', detail: 'socket closed' });
      A.eq((scope.status().delivery || {}).state, 'down', 'A: a gateway reconnect keeps the line (was: its status write dropped every other field)');
      A.eq([scope.status().state, scope.status().connected], ['reconnecting', false], 'A: and still reports the transport as it is');
      scope.onState({ state: 'up' });

      // the next reply that lands clears it
      const ok = await wired.hub._internals.deliver('99', 'the next answer', 'run-next', 'done');
      await settle();
      A.eq([ok.ok, (scope.status().delivery || {}).state], [true, 'up'], 'A: the next reply that lands clears the line');

      // refused for the moment: the line says so while the lane keeps the reply
      rest.plan.push(503, 503);
      const held = await wired.hub._internals.deliver('99', 'a third answer', 'run-later', 'done');
      await settle();
      A.eq([held.ok, held.queued, (scope.status().delivery || {}).state], [false, true, 'down'], 'A: a send refused for the moment is on the line too, its reply still queued');
    } finally { console.error = quiet; wired.hub.close(); if (store.ledger) store.ledger.close(); }
  }

  /* ---- B. Slack, Matrix, Signal: startGenericChannel's closures, for every id it serves ----------------------------- */
  {
    const src = sidecarTopLevelFunction('startGenericChannel');
    for (const id of ['slack', 'matrix', 'signal']) {
      const forwarded = [];
      const scope = new Function('id', 'genericChannels',   // eslint-disable-line no-new-func
        'const genericStatus = {}; genericStatus[id] = { connected: true, state: "up", detail: "" };\n'
        + 'return { onDelivery: (' + lifted(src, 'onDelivery') + '), onStatus: (' + lifted(src, 'onStatus') + '), status: () => genericStatus[id] };')(id, { [id]: { hub: { onStatus: (s) => forwarded.push(s) } } });
      if (typeof scope.onDelivery === 'function') scope.onDelivery({ ok: false, chatId: 'C1', attempts: 1, detail: 'channel_not_found' });
      A.eq((scope.status().delivery || {}).state, 'down', 'B: ' + id + ': a refused send turns the delivery line down');
      A.eq((scope.status().delivery || {}).detail, 'channel_not_found', 'B: ' + id + ': and names the refusal');
      scope.onStatus({ state: 'down', detail: 'poll error' });
      A.eq((scope.status().delivery || {}).state, 'down', 'B: ' + id + ': a status report keeps the line (was: its status write dropped every other field)');
      A.eq(scope.status().state, 'down', 'B: ' + id + ': and still reports the transport as it is');
      A.eq(forwarded.length, 1, 'B: ' + id + ': the hub still hears the status');
      if (typeof scope.onDelivery === 'function') scope.onDelivery({ ok: true, chatId: 'C1', attempts: 1, detail: '' });
      A.eq((scope.status().delivery || {}).state, 'up', 'B: ' + id + ': a send that lands clears it');
    }
  }

  /* ---- C. The census: every adapter the station builds reports its sends ------------------------------------------- */
  for (const fn of ['startTelegram', 'startTelegramBot', 'startDiscord', 'startGenericChannel']) {
    A.ok(/\n\s*onDelivery: \(d\) => \{/.test(sidecarTopLevelFunction(fn)), 'C: ' + fn + ' wires its adapter\'s onDelivery (the delivery line\'s one writer)');
  }

  /* ---- D. Live Doctor reads the line for every channel ------------------------------------------------------------- */
  {
    const handler = sidecarTopLevelFunction('handleLiveDoctor');
    const head = 'for (const descriptor of channelRegistry.list()) {';
    const at = handler.indexOf(head);
    const end = handler.indexOf('\n  }\n', at);
    A.ok(at >= 0 && end > at, 'D: fixture: Live Doctor\'s channel probes are found');
    const probeOf = (id, status) => {
      const targets = [];
      new Function('channelRegistry', 'channelSecrets', 'channelStatusPayload', 'LiveDoctor', 'targets', handler.slice(at, end + 4))(   // eslint-disable-line no-new-func
        { list: () => [{ id: id, label: id }] }, {}, () => status, LiveDoctor, targets);
      return targets[0].probe();
    };
    const up = { configured: true, connected: true, state: 'up' };
    for (const id of ['discord', 'slack', 'matrix', 'signal']) {
      const bad = await probeOf(id, Object.assign({}, up, { delivery: { state: 'down', detail: 'discord http 403', at: T0 } }));
      A.eq(bad.state, LiveDoctor.STATES.UNREACHABLE, 'D: ' + id + ': an up adapter whose replies are refused is not healthy (was: AUTHENTICATED)');
      A.ok(/outbound replies are degraded: discord http 403/.test(bad.detail), 'D: ' + id + ': and says what refused them: ' + bad.detail);
      const held = await probeOf(id, Object.assign({}, up, { delivery: { state: 'down', detail: 'delivery ledger cannot be written (EBUSY); holding outbound, retrying', at: T0 } }));
      A.ok(/delivery ledger cannot be written/.test(held.detail), 'D: ' + id + ': a ledger holding outbound reaches it the same way');
      for (const delivery of [{ state: 'up', detail: '', at: T0 }, { state: 'unknown', detail: '', at: 0 }, undefined]) {
        const good = await probeOf(id, Object.assign({}, up, { delivery: delivery }));
        A.eq(good.state, LiveDoctor.STATES.AUTHENTICATED, 'D: ' + id + ': a good or unknown line changes nothing (' + JSON.stringify(delivery) + ')');
      }
    }
  }

  /* ---- E. Discord's own status route carries the line, like every other status answer ------------------------------ */
  {
    const res = { body: '', writeHead() {}, end(b) { this.body = String(b); } };
    const status = { connected: true, state: 'up', detail: '', delivery: { state: 'down', detail: 'discord http 403', at: T0 } };
    const src = sidecarTopLevelFunction('handleDiscordStatus');
    new Function('channelSecrets', 'channelToken', 'isChannelTokenDurable', 'discordStatus', 'channelDeliveryLine', src + '\nreturn handleDiscordStatus;')(   // eslint-disable-line no-new-func
      { discord: {} }, () => '', () => false, status, (d) => d)({}, res);
    A.eq((JSON.parse(res.body).delivery || {}).state, 'down', 'E: GET /api/channels/discord/status carries the delivery line');
  }

  A.report('channels.delivery-line.test');
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
