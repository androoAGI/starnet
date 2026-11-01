---
fingerprint: a199ee3c
slug: channel-targets-derives-reachable-now-from-the-a
title: `channel.targets` derives "reachable now" from the adapter handle's existence, so an errored (or still-connecting) channel is reported connected while telegramS
surface: channels
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/channels
fix: 96fe108d
---

# `channel.targets` derives "reachable now" from the adapter handle's existence, so an errored (or still-connecting) channel is reported connected while telegramS

## Symptom

A Telegram token gets revoked (or Discord closes 4004, or a second poller steals the token). The poll loop stops for good and the CHANNELS panel correctly shows the channel as errored. An agent asked "can you reach me on Telegram?" calls channel.targets and is told "1 of 1 known chat(s) reachable now" — and repeats that to the Commander. channel.send's own honest refusal ("telegram is not connected right now, so nothing was sent") is unreachable on every real channel, so instead the agent burns a doomed send and reports a raw transport error.

## Repro

Connect Telegram; let it prove 'up'; revoke the token in @BotFather (or start a second poller on the same token, which throws the 409 fatal at telegram.transport.js:84-87). GET /api/channels/status correctly reports state 'error', connected false. Now have an agent call channel.targets: summary still reads "N of N known chat(s) reachable now" and every row carries connected:true. Then channel.send to that target skips its not-connected branch entirely and fails at the transport instead.

## Evidence

`sidecar/index.js:10351`

**Mechanism (read from the code):** listTargets derives reachability from the mere existence of the composition-root handle: `connected: !!(live && live.adapter)` (index.js:10351), where `live = liveChannelFor(channel)` just returns the module-level `telegram` / `discord` / `genericChannels[id]` object. Those objects are nulled ONLY by an explicit teardown — `function stopTelegram() { ... telegram = null; }` (index.js:5595-5597), called from start, from process shutdown, and from the disconnect route. A fatal poll failure does not go near it: adapter.js:188 `if (isFatal(e)) { onStatus && onStatus({ state: 'error', detail: ... }); break; }` kills the loop and leaves the object alive. The real health bit exists and is ignored — index.js:5574 `telegramStatus = { connected: state === 'up' && !!telegram, state: state, ... }`, and the same shape in `discordStatus` / `genericStatus[id]` (index.js:5984). So comms.js:159 `if (!t.connected) { throw new Error(t.channel + ' is not connected right now, so nothing was sent to ' + t.target ...) }` is a stamped verdict with zero live producers.

**Existing test coverage:** test/comms-tools.test.js supplies `connected` on hand-written fake targets (lines 16-19), so it tests the pure module's policy, never the wiring that computes the flag. test/comms-send.e2e.test.js exercises the real listTargets but only over the DEV channel, whose liveChannelFor branch is synthetic and always live — its header even claims it locks "live transport state". No test drives a fatal-error channel through listTargets.

**Adversarial verdict (survived refutation):** Confirmed by reading. sidecar/index.js:10351 `connected: !!(live && live.adapter)` where liveChannelFor (index.js:3080-3095) returns the module-level handle, and that handle is nulled ONLY by explicit teardown (stopTelegram index.js:5595-5598; call sites 5441/6564/12250 = start, shutdown, disconnect route — none on transport failure). A fatal poll error breaks the loop and only reports status (channels/adapter.js:188 `if (isFatal(e)) { onStatus && onStatus({state:'error'…}); break; }`), and index.js:5565-5572 handles that by writing telegramStatus only, leaving `telegram` alive. The honest producer therefore exists and is ignored: index.js:5570 `telegramStatus = { connected: state === 'up' && !!telegram, … }` (mirrored 5984 generic, 5769 discord, surfaced by channelStatusPayload index.js:12444-12448). The consumer is truthful-telemetry-shaped: comms.js:127-132 renders 'N of M known chat(s) reachable now' and comms.js:159-162 is the not-connected refusal. Tests do not cover it — test/comms-tools.test.js:15-19 hand-writes the `connected` flag, and comms-send.e2e.test.js drives only the DEV channel, whose liveChannelFor branch (index.js:3086-3090) is synthetic and always live. Two corrections to the claim: the same flag also reports connected:true during the honest 'connecting' phase (handle set at 5575 before any proof, status 5578), and the send-side refusal is NOT dead — it fires correctly whenever the handle is absent (never started / after disconnect), so 'unreachable on every real channel' overstates it. Severity stays P1: false reachability is asserted, but the failure degrades to a failed send that reports honestly, not to a fabricated success.

_Found by the `sweep/channels` lane, 2026-07-28. Finder confidence: high. Severity claimed P1, after refutation P1._

## Verdict

Fixed in `96fe108d` (2026-07-29; an ancestor of trunk, in every release since v0.8.0). channel.targets reads channelLiveHealth() (state up AND a live handle) instead of the handle's existence, so an errored or still-connecting channel is never reported reachable, and channel.send's own not-connected refusal fires (`sidecar/index.js` channelLiveHealth). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
