---
fingerprint: f8fa4bba
slug: channel-work-line-hops-omit-the-target-provider
title: Channel work-line hops omit the target provider model and credential
surface: channels
severity: P1
status: fixed
found: 2026-11-03
lane: agent/channel-hub-factory-1103
fix: cd76bdc6e477b11c34c7e40f9c3120b0b31481d4 308de39fe7a0939c54b6571ddab4e97c95fa7cb4
origin: audit
family: channel-hub-factory
---

# Channel work-line hops omit the target provider model and credential

## Symptom

Work entering a drawn line through station Telegram, Discord, Slack, Matrix or Signal could advance to another agent without passing that target's provider, model or credential. The downstream run received channel persona text instead of the target's system prompt. A configured channel and a successful first stage did not establish the identity of its later stages.

## Repro

1. Use the host source at `a255bc335f1f8a890e0b2992b0475f93c288bd61` with `test/channels.factory-transport.test.js`, selected through `CHANNEL_FACTORY_CONTROL` without replacing product files.
2. Send a paired-owner raw message through each actual adapter into a writer -> editor -> reviewer line. Give each target a distinct model/system, and give editor a different provider.
3. Inspect the actual `runOnce` options for the two downstream calls. The old host omits their provider/model/key and supplies channel persona instead. Run the same fixture normally to verify each target's live configuration and scoped credential.

## Evidence

`test/channels.factory.test.js` exercises all ten host hub kinds with the production resolver expressions. The original constructor control is RED12/93, current core GREEN93 (`channel-factory-old-02.log`, `channel-factory-current-01.log`). The expanded `test/channels.factory-transport.test.js` executes the six actual host starter functions, real adapters/normalizers/transport serializers, Hub, LineRunner and chain. Its saved old-host control is RED21/174, including 20 downstream identity/credential failures; current is GREEN174. Receipts: `C:/Users/andro/gen-trees/_logs/codex-overnight-1103/channel-factory-transport-base-control.log` and `channel-factory-transport-current-02.log`. The remaining control failure belongs to the separate status record `accba7ff`.

Actual sidecar affected proof `test/channels.telegram.botchain.e2e.test.js` is GREEN15 against synthetic Telegram/provider servers, with distinct target model, handoff output, final reply and scoped histories (`channel-factory-close-botchain.log`). This is not a paid account or real messaging-service verification.

## Verdict

Source fixed: every host hub receives the shared live `resolveRunConfig` dependency, with per-kind capability policy and existing bound-bot entry authority retained. Expanded adapter policy and proof were committed separately. Combined current-base gates remain the orchestrator's responsibility. The old branch's unrelated port-import scanner still fails on an existing constructed require; its already-landed repair is `b6f13c3b5`, to be retained at integration. No whole-lane, installed-build or customer recovery clearance is inferred.

## Regression

The exact old source fails downstream provider/model/system/key assertions while the current source passes them. Direct work and live entry changes remain covered; bound Telegram retains its own entry key and independently resolves downstream targets. Stranger ingress buys no run and sends no reply. Accepted terminal replies exclude pre-tool narration, address the admitted conversation, and teardown closes the hub before its transport. Synthetic credentials and closed fetch edges keep these proofs isolated.
