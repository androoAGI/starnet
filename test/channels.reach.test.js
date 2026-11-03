/* node test/channels.reach.test.js — the ONE outbound reachability gate (sidecar/channels/reach.js, quick win 22).

   A live HANDLE is not reachability: a revoked token / Discord 4004 / a second poller breaks the poll loop and leaves the
   handle alive, with { state: 'error' } as the only record (bug a199ee3c). channel.targets was fixed to read the health
   bit; channel.send, its file upload, a routine's chat delivery and the autonomous notifier went on checking the handle
   alone and spent a doomed transport call on a channel the panel showed as errored.

   Proves: (A) reach() refuses a missing handle, an errored or still-connecting transport, and a throwing dependency, and
   answers ok only for a live handle whose status says connected; reach(c, { attempt: true }) ALSO lets a SEND be tried
   while the transport is still 'connecting' (no failure known yet — refusing there lost every notifier ping and routine
   delivery for up to a Telegram long poll after each boot), and still refuses 'error' and 'down' — except a 'down' whose
   cause is the durable intake (a refused receipt says nothing about sending: channel-delivery-ledger S4), which a send
   may try and a claim may not; (B) every host send outside a hub's own reply path goes through the ONE outbound contract
   (channels/outbound.js), which asks the gate in attempt mode before any transport call — a routine's chat delivery,
   channel.send and its upload, the notifier, the sign-in nudge, the loop's stop notice and the offline notices — while
   the two CLAIMS (channel.targets' connected bit, the routine preflight) ask it bare. Each lock slices the ONE function
   or block it is about (test/helpers/source.js), never the whole sidecar text. Since S4 these locks read
   ChannelOutbound's send where they read each path's own reach call; the behaviour behind them is proven in
   test/channels.outbound.contract.test.js. */
'use strict';
const A = require('./_assert.js');
const { makeChannelReach } = require('../sidecar/channels/reach.js');
const { sidecarTopLevelFunction, sidecarFunctionSource, sidecarSourceFiles, functionSourceIn } = require('./helpers/source.js');

// ---- A. the gate itself ----
{
  const handles = { telegram: { adapter: { send() {} } }, discord: { adapter: { send() {} } }, slack: { adapter: { send() {} } } };
  const health = { telegram: { connected: true, state: 'up' }, discord: { connected: false, state: 'error' }, slack: { connected: false, state: 'connecting' } };
  const { reach } = makeChannelReach({ liveChannelFor: (c) => handles[c] || null, channelLiveHealth: (c) => health[c] || { connected: false, state: 'down' } });
  const up = reach('telegram');
  A.eq(up.ok, true, 'a live handle with a proven-up transport is reachable');
  A.ok(up.live === handles.telegram, 'and hands back the live handle to send through');
  const errored = reach('discord');
  A.eq(errored.ok, false, 'an ERRORED transport is not reachable even though its handle is alive');
  A.ok(/discord is not connected right now \(error\)/.test(errored.error), 'the refusal names the channel and its real state: ' + errored.error);
  A.eq(reach('slack').ok, false, 'a still-CONNECTING transport has proven nothing yet');
  const gone = reach('matrix');
  A.eq([gone.ok, gone.live], [false, null], 'no handle at all is not reachable');
  A.ok(/matrix is not connected/.test(gone.error), 'and says so');
  const throwing = makeChannelReach({ liveChannelFor: () => { throw new Error('boom'); }, channelLiveHealth: () => { throw new Error('boom'); } }).reach;
  A.eq(throwing('telegram').ok, false, 'a throwing dependency is a refusal, never a throw');
  const healthThrows = makeChannelReach({ liveChannelFor: () => handles.telegram, channelLiveHealth: () => { throw new Error('boom'); } }).reach;
  A.eq(healthThrows('telegram').ok, false, 'an unreadable health bit is not "connected"');
  A.throws(() => makeChannelReach({}), 'the gate refuses to be built without both dependencies');
  // attempt mode: a SEND may be tried while 'connecting'; a failure the adapter actually saw is still refused
  const health2 = Object.assign({}, health, { matrix: { connected: false, state: 'down' } });
  const handles2 = Object.assign({}, handles, { matrix: { adapter: { send() {} } } });
  const r2 = makeChannelReach({ liveChannelFor: (c) => handles2[c] || null, channelLiveHealth: (c) => health2[c] || { connected: false, state: 'down' } }).reach;
  const tryConnecting = r2('slack', { attempt: true });
  A.eq([tryConnecting.ok, tryConnecting.proven], [true, false], 'a still-CONNECTING transport may be TRIED by a send — unproven, never claimed');
  A.ok(tryConnecting.live === handles2.slack, 'and the send goes through its live handle');
  A.eq(r2('slack').ok, false, 'asked bare (a claim), connecting is still not reachable');
  A.eq(r2('discord', { attempt: true }).ok, false, 'an ERRORED transport is refused even for an attempt');
  A.eq(r2('matrix', { attempt: true }).ok, false, 'a DOWN transport (a sustained outage the adapter saw) is refused for an attempt');
  A.eq([r2('telegram').proven, r2('telegram', { attempt: true }).proven], [true, true], 'a proven-up transport is proven either way');
  A.eq(r2('nope', { attempt: true }).ok, false, 'no handle is refused for an attempt too');
  const healthThrows2 = makeChannelReach({ liveChannelFor: () => handles.telegram, channelLiveHealth: () => { throw new Error('boom'); } }).reach;
  A.eq(healthThrows2('telegram', { attempt: true }).ok, false, 'an unreadable health bit is not a connecting one');
  // INTAKE IS NOT AN OUTAGE: a 'down' the adapter reported because a receipt could not be written may be tried by a send
  const health3 = { telegram: { connected: false, state: 'down', cause: 'intake' }, discord: { connected: false, state: 'down', cause: '' } };
  const r3 = makeChannelReach({ liveChannelFor: (c) => handles[c] || null, channelLiveHealth: (c) => health3[c] || { connected: false, state: 'down' } }).reach;
  A.eq([r3('telegram', { attempt: true }).ok, r3('telegram', { attempt: true }).proven], [true, false], 'a down whose cause is the durable intake may be TRIED by a send — unproven');
  A.eq(r3('telegram').ok, false, 'asked bare (a claim), an intake-held channel is still not reachable');
  A.eq(r3('discord', { attempt: true }).ok, false, 'a down with no such cause (the transport saw it) is still refused for an attempt');
}

// ---- B. every outbound send outside a hub reply goes through the one contract, which asks the gate ----
{
  const { readSidecarSource } = require('./helpers/source.js');
  const idx = readSidecarSource();
  const file = (rel) => (sidecarSourceFiles().find(x => x.rel === rel) || { text: '' }).text;
  // ChannelOutbound's send: the gate, asked in attempt mode, before any transport call
  {
    const out = file('sidecar/channels/outbound.js');
    const send = functionSourceIn(out, 'send');
    A.ok(send.length > 200 && send.length < 4000, 'ChannelOutbound.send is sliced (' + send.length + ' chars)');
    A.ok(/reach\(t\.channel, \{ attempt: true \}\)/.test(send), 'ChannelOutbound.send asks the gate in attempt mode (a SEND: a connecting channel may be tried)');
    const gateAt = send.search(/reach\(t\.channel/), firstSend = send.search(/sendDurable\(|sendNow\(/);
    A.ok(gateAt > 0 && firstSend > gateAt, 'and before it hands the send on: a channel known to be down or errored never gets a transport call');
    A.ok(!/liveChannelFor\(/.test(send), 'it never decides reachability from the bare handle');
  }
  // …and the channelReach it asks is the one the host injects: index.js builds the outbound (and the routine delivery) over it
  {
    const at = idx.indexOf('const channelOutbound = makeChannelOutbound({');
    const call = at < 0 ? '' : idx.slice(at, idx.indexOf('\n});', at));
    A.ok(/reach: channelReach,/.test(call), 'index.js builds the one outbound contract over the same channelReach gate');
    const rAt = idx.indexOf('const routineDelivery = makeRoutineDelivery({');
    const rCall = rAt < 0 ? '' : idx.slice(rAt, idx.indexOf('\n});', rAt));
    A.ok(/channelOutbound: channelOutbound,/.test(rCall) && /channelReach: channelReach,/.test(rCall), 'index.js builds the routine delivery over that outbound (its sends) and that gate (its preflight claim)');
  }
  // a routine's chat delivery SENDS through the outbound; its preflight CLAIMS, asking the gate bare
  {
    const cron = sidecarFunctionSource('deliverCronResult');
    A.ok(cron.length > 0 && /channelOutbound\.send\(/.test(cron), 'a routine\'s chat delivery sends through the one outbound contract');
    A.ok(!/channelReach\(/.test(cron) && !/liveChannelFor\(/.test(cron) && !/\.adapter\.send/.test(cron), 'and keeps no reach call, bare handle or adapter send of its own');
    const pre = sidecarFunctionSource('cronPreflightConfig');
    A.ok(/channelReach\(/.test(pre) && !/channelReach\([^)]*\{ attempt: true \}\)/.test(pre), 'cronPreflightConfig is a CLAIM: it asks the gate for proof (bare)');
    A.ok(!/liveChannelFor\(/.test(pre), 'cronPreflightConfig never decides reachability from the bare handle');
  }
  // the notifier's wiring is one block, `const autoNotifier = makeAutoNotifier({ ... });` (sliced as autonotify.test does)
  {
    const at = idx.indexOf('const autoNotifier = makeAutoNotifier({');
    const block = at < 0 ? '' : idx.slice(at, idx.indexOf('\n});', at) + 4);
    const send = block.slice(block.indexOf('send:'), block.indexOf('onDelivery:'));
    A.ok(send.length > 50 && send.length < 2000, 'the notifier send is sliced (' + send.length + ' chars)');
    A.ok(/channelOutbound\.send\(/.test(send) && /durable: false/.test(send), 'the autonomous notifier pings through the one outbound contract (now, once)');
    A.ok(!/liveChannelFor\(/.test(send) && !/\.adapter\.send/.test(send), 'and never decides reachability from the bare handle');
  }
  // the two pings that kept the bare-handle check (review of quick win 22): a sign-in hand-off's nudge and a loop's stop notice
  {
    const hAt = idx.indexOf('const browserHandoffs = makeHandoffHost({');
    const hBlock = hAt < 0 ? '' : idx.slice(hAt, idx.indexOf('\n});', hAt) + 4);
    const nAt = hBlock.indexOf('onNudge:');
    const nudge = nAt < 0 ? '' : hBlock.slice(nAt);
    A.ok(nudge.length > 100 && nudge.length < 3000, 'the sign-in nudge is sliced (' + nudge.length + ' chars)');
    A.ok(/channelOutbound\.send\(/.test(nudge) && /reason: 'nudge'/.test(nudge), 'the sign-in nudge pings through the one outbound contract');
    A.ok(!/liveChannelFor\(/.test(nudge) && !/ch && ch\.adapter/.test(nudge) && !/\.adapter\.send/.test(nudge), 'and never decides reachability from the bare handle');
    const lAt = idx.indexOf('const loopDriver = makeLoopDriver({');
    const lBlock = lAt < 0 ? '' : idx.slice(lAt, idx.indexOf('\n});', lAt) + 4);
    const stopAt = lBlock.indexOf('onStopped:');
    const stop = stopAt < 0 ? '' : lBlock.slice(stopAt, lBlock.indexOf('\n  ledger:', stopAt));
    A.ok(stop.length > 100 && stop.length < 4000, 'the loop stop notice is sliced (' + stop.length + ' chars)');
    A.ok(/channelOutbound\.send\(/.test(stop) && /reason: 'loop'/.test(stop), 'the loop stop notice pings through the one outbound contract');
    A.ok(!/ch && ch\.adapter/.test(stop) && !/genericChannels\[/.test(stop) && !/telegramBots\.get\(/.test(stop) && !/\.adapter\.send/.test(stop), 'and keeps no private channel resolver or bare-handle check');
  }
  // the comms tool's own wiring lives inside runOnceCore: slice it, then require the anchors INSIDE that slice
  {
    const core = sidecarTopLevelFunction('runOnceCore');
    const at = core.indexOf('makeCommsTools({');
    A.ok(at > 0, 'runOnceCore wires makeCommsTools');
    const wiring = core.slice(at, core.indexOf('.register(registry)', at));
    A.ok(/connected: channelReach\(channel\)\.ok/.test(wiring), 'channel.targets reports connected from the same gate, asked bare: a CLAIM needs proof');
    A.ok(/sendTo: \(target, text, o\) => channelOutbound\.send\(/.test(wiring), 'channel.send goes through the one outbound contract');
    A.ok(/sendMediaTo: \(target, item, o\) => channelOutbound\.send\(/.test(wiring), 'the file upload goes through it too');
    A.ok(!/liveChannelFor\(/.test(wiring), 'the comms wiring never decides reachability from the bare handle');
  }
}

A.report('channels.reach.test');
