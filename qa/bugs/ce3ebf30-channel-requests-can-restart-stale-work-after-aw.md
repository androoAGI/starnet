---
fingerprint: ce3ebf30
slug: channel-requests-can-restart-stale-work-after-aw
title: Channel requests can restart stale work after awaited history or steering
surface: channels
severity: P1
status: fixed
found: 2026-11-03
lane: turn-identity-1103
fix: 8f6cb7928
origin: audit
---

# Channel requests can restart stale work after awaited history or steering

## Symptom

A newer message or STOP can be followed by an older request starting late while channel history or steering waits. A late successful steer can also claim the task is still running after it stopped. The unconditional history await exposed overlapping preparation in the unlanded C9 migration; the earlier pending-steer race was inherited. No released-installer occurrence is claimed.

## Repro

1. Run `test/channels.history-preparation.test.js` with `CHANNEL_PREPARATION_HUB_SOURCE` naming the exact AD204 saved Hub and `CHANNEL_PREPARATION_ROUTE_SOURCE` naming its saved routes under `_logs/codex-overnight-1103/turn-identity-c9-preparation-control`.
2. Hold two real canonical history reads in one chat, then release them in either order. Only the newest request should reach the provider; STOP and E-STOP must also withdraw pending work.
3. Hold two steer replies against the same live task, accept or refuse the newer one first, then refuse the older one. Also finish the original task and a newer request before resolving the old steer. The old fallback must not restart work or abort the newer task.

## Evidence

`turn-identity-c9-prep-old.log/.json`: exact AD204 Hub plus old routes, RED39/94 (55 positives), PID38412 exit1. `turn-identity-c9-prep-intermediate.log/.json`: saved91EC with preparation repaired but inherited steer unchanged, RED19/94 (75 positives), PID59540 exit1. `turn-identity-c9-prep-current.log/.json`: current HubFA79AFE9/Routes95E75598, GREEN94, PID56208 exit0. All controls reached complete assertion reports. The permanent fixture uses actual Hub, channel Store, canonical history Port, durable receipts and controlled history/media/steer waits. It covers first-wins cancellation, old-finally identity, separate chats, natural409 and status positives, newer completed work, route eviction and truthful late-acceptance acknowledgement. `test/channels.hub.test.js` passes189 assertions and `test/channels.edit-admission.test.js` passes52 at the repaired source. The first broad-Hub incomplete fixture receipts and reply census RED2/185 remain preserved separately.

## Verdict

Fixed with the same stop owner through preparation and private order tokens on existing task/route owners. Exact AD204 old39/94 red, intermediate91EC19/94 red, current94 green; independent source review closed. Hub189, edit52, all23 direct consumers,12 laws and Telegramthreads49 green. Full40x40 predates this final preparation delta and remains combined-gate coverage, not a repeat claim. Combined/browser acceptance separate.
