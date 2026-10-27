/* node test/channels.reach.test.js — the ONE outbound reachability gate (sidecar/channels/reach.js, quick win 22).

   A live HANDLE is not reachability: a revoked token / Discord 4004 / a second poller breaks the poll loop and leaves the
   handle alive, with { state: 'error' } as the only record (bug a199ee3c). channel.targets was fixed to read the health
   bit; channel.send, its file upload, a routine's chat delivery and the autonomous notifier went on checking the handle
   alone and spent a doomed transport call on a channel the panel showed as errored.

   Proves: (A) reach() refuses a missing handle, an errored or still-connecting transport, and a throwing dependency, and
   answers ok only for a live handle whose status says connected; (B) every host send outside a hub's own reply path asks
   it — each lock slices the ONE function it is about (test/helpers/source.js), never the whole sidecar text. */
'use strict';
const A = require('./_assert.js');
const { makeChannelReach } = require('../sidecar/channels/reach.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');

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
}

// ---- B. every outbound send outside a hub reply asks the gate ----
{
  // the notifier's wiring is one block, `const autoNotifier = makeAutoNotifier({ ... });` (sliced as autonotify.test does)
  {
    const { readSidecarSource } = require('./helpers/source.js');
    const idx = readSidecarSource();
    const at = idx.indexOf('const autoNotifier = makeAutoNotifier({');
    const block = at < 0 ? '' : idx.slice(at, idx.indexOf('\n});', at) + 4);
    const send = block.slice(block.indexOf('send:'), block.indexOf('onDelivery:'));
    A.ok(send.length > 50 && send.length < 2000, 'the notifier send is sliced (' + send.length + ' chars)');
    A.ok(/channelReach\(channel\)/.test(send), 'the autonomous notifier asks channelReach before it pings');
    A.ok(!/liveChannelFor\(/.test(send), 'and never decides reachability from the bare handle');
  }
  for (const fn of ['commsTargetReach', 'deliverCronResult', 'cronPreflightConfig']) {
    const body = sidecarTopLevelFunction(fn);
    A.ok(body.length > 0, fn + ' is found');
    A.ok(/channelReach\(/.test(body), fn + ' asks channelReach (handle AND proven health)');
    A.ok(!/liveChannelFor\(/.test(body), fn + ' never decides reachability from the bare handle');
  }
  for (const fn of ['commsSendTo', 'commsSendMediaTo']) {
    const body = sidecarTopLevelFunction(fn);
    A.ok(/commsTargetReach\(/.test(body), fn + ' resolves its target through the gated resolver');
  }
  // the comms tool's own wiring lives inside runOnceCore: slice it, then require the anchors INSIDE that slice
  const core = sidecarTopLevelFunction('runOnceCore');
  const at = core.indexOf('makeCommsTools({');
  A.ok(at > 0, 'runOnceCore wires makeCommsTools');
  const wiring = core.slice(at, core.indexOf('.register(registry)', at));
  A.ok(/connected: channelReach\(channel\)\.ok/.test(wiring), 'channel.targets reports connected from the same gate');
  A.ok(/sendTo: \(target, text\) => commsSendTo\(/.test(wiring), 'channel.send goes through commsSendTo');
  A.ok(/sendMediaTo: \(target, item\) => commsSendMediaTo\(/.test(wiring), 'the file upload goes through commsSendMediaTo');
  A.ok(!/liveChannelFor\(/.test(wiring), 'the comms wiring never decides reachability from the bare handle');
}

A.report('channels.reach.test');
