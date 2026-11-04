---
fingerprint: accba7ff
slug: channel-status-and-model-commands-report-stale-o
title: Channel status and model commands report stale or absent target configuration
surface: channels
severity: P2
status: fixed
found: 2026-11-03
lane: agent/channel-hub-factory-1103
fix: 308de39fe7a0939c54b6571ddab4e97c95fa7cb4
origin: audit
family: channel-hub-factory
---

# Channel status and model commands report stale or absent target configuration

## Symptom

Channel `/status` and `/model` could name a stale roster model, omit the bound bot's current model, or continue presenting configuration after its live resolver refused it. The readout could disagree with the next message's execution pair.

## Repro

1. Run `test/channels.live-status.test.js` with `CHANNEL_STATUS_CONTROL` pointing to the saved pre-change `sidecar/channels/hub.js` (`channel-hub-pre-status.js` in the overnight receipt directory).
2. Give the live resolver a model different from the roster/connect snapshots. Ask `/status`, query and change `/model`, then make the resolver return an explicit unready result.
3. Observe the old readouts disagree with the current resolver. Run the fixture normally: commands must show the live model or explicit failure, and querying them must invoke no run.

## Evidence

The exact old hub control fails 6/10 assertions (`channel-factory-live-status-old.log`); the current ten assertions pass in `channel-factory-followups-01.log`. Both are under `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/`. The broader `test/channels.factory-transport.test.js` exercises actual starter/adapter command ingress: six live model readouts and zero command-triggered runs pass as part of GREEN174. Its pre-factory host control independently fails the bound-bot readout because that host lacks the explicit entry resolver.

Actual sidecar command/owner/group/steer affected proof `test/channels.telegram.chat-truth.e2e.test.js` is GREEN31 (`channel-factory-close-chat-truth.log`). Existing shared command, desktop alias, button and registry suites are green in the nine-file follow-up receipt. No real account was used.

## Verdict

Source fixed. Readouts use the same live entry resolver as execution; a failed or throwing resolver produces an explicit unavailable response rather than a stale fallback. Standalone legacy hubs without that callback preserve their existing compatibility behavior. The shared command metadata retains owner gates and aliases; unsupported mention controls respond honestly. Root's independent expanded review found no blocking source issue. Combined gates and installed/customer acceptance remain separate, including the known older-base scanner hold documented in the factory handoff.

## Regression

State coverage includes live model, model mutation and missing/failed target configuration. Identity coverage includes station and bound-bot hubs, followed by actual adapter ingress across all six transports. Authority coverage checks owner refusal, preserved bound-bot roster restrictions and zero run calls for status. Temporal coverage changes the live model after construction and checks the next command/message, without reconnecting or trusting connect-time snapshots.
