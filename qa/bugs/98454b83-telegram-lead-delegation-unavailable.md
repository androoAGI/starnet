---
fingerprint: 98454b83
slug: telegram-lead-delegation-unavailable
title: Telegram-bound lead reports crew delegation unavailable
surface: channels
severity: P1
status: open
found: 2026-09-11
lane: release-0120-prep-0915
fix:
origin: customer
report: https://github.com/androoAGI/starnet/issues/14
affected: v0.11.2 Windows, Telegram-bound orchestrator
family: channel-delegation-parity
installer: unverified
recovery: unconfirmed
---

# Telegram-bound lead reports crew delegation unavailable

## Symptom

After upgrading to Windows 0.11.2, a lead can delegate to a specialist in the desktop chat but reportedly says team.dispatch is unavailable when invoked through its assigned Telegram bot. The reporter says team dispatch is enabled and the bot binding is correct.

## Repro

1. Enable team dispatch; create a lead and specialist and prove delegation in desktop COMMS.
2. Bind the Telegram bot to the same lead and send the same task through an admitted owner DM.
3. Capture task classification, bound agent ID, authority scope, provider tool schema and any tool-search result, then the actual dispatch result.
4. Repeat after restart and compare specialist bindings and group-channel policy. The exact customer failure has not been reproduced locally.

## Evidence

GitHub #14 was read on 2026-09-16 UTC. It was created after 0.11.2 publication and closed at 2026-09-11T21:22:02Z; the issue has no comments, and the closure event has no linked commit. Closure alone does not prove a fix or recovery. This symptom is distinct from #13 / acd9ecb4, which concerns MCP access inside a delegated worker.

`test/channels.telegram.e2e.test.js` already asserts that an owner Telegram task advertises team_dispatch and that /tools lists delegation authority. `test/e2e.dispatch-session.test.js` covers separate dispatch/session behavior. These are relevant baseline protections; neither supplies the failing customer input or proves this exact report resolved. Source entry points: `sidecar/index.js:8082` and `sidecar/tools/builtin/orchestration.js`.

## Verdict

Open investigation, imported during 0.12.0 preparation because the closed public issue had no durable symptom record. Obtain a sanitized reproduction or establish and repair an independently reproduced cause. Do not weaken channel authority or add unconditional delegation to conversational turns to make the report disappear.

## Regression

No exact before/after failure receipt. Existing Telegram wire coverage is corroboration only. Required acceptance: the same lead and task delegate through desktop and admitted Telegram, produce the specialist result, and remain correctly bound after restart.

## Sibling coverage

{"adapters":[{"target":"Telegram owner DM tool advertisement","state":"covered","test":"test/channels.telegram.e2e.test.js","scenario":"owner task advertises team_dispatch and /tools lists task delegation","gate":"http"},{"target":"actual reporter provider and Telegram task","state":"blocked","reason":"No task text, run trace or provider wire was supplied."}],"entrypoints":[{"target":"desktop dispatch session binding","state":"covered","test":"test/e2e.dispatch-session.test.js","scenario":"delegated workers retain explicit session targeting","gate":"http"},{"target":"Telegram lead versus specialist and group bindings","state":"blocked","reason":"Need same-task end-to-end dispatch comparison across the relevant authority scopes."}],"displays":[{"target":"channel tools card","state":"covered","test":"test/channels.telegram.e2e.test.js","scenario":"/tools reflects delegation authority","gate":"http"},{"target":"returned specialist result","state":"blocked","reason":"Tool advertisement does not establish executed delegation and returned output."}],"lifecycle":[{"target":"reported binding after installed restart","state":"blocked","reason":"No exact installer reproduction or affected-user recovery evidence."}]}
