---
fingerprint: 2e6344fc
slug: casual-replies-continue-after-the-local-output-c
title: Casual replies continue after the local output ceiling
surface: providers
severity: P1
status: fixed
found: 2026-09-16
lane: agent/response-audit-0915-7c2a
fix: fc4c9e0f415251870778da1405086c421aff0670
origin: customer
report: https://github.com/androoAGI/starnet/issues/17
affected: 0.11.2 Windows Ollama; related ceiling repair 5acf4640f
family: response-latency
installer: unverified
recovery: unconfirmed
---

# Casual replies continue after the local output ceiling

## Symptom

Issue #17 reports a 2.5-minute wait for a greeting followed by ten minutes of technical prose on Windows with Ollama llama3.2:3b. The first repair reduced the prompt and added a 4096-token per-call ceiling, but a casual reply reaching that ceiling could still cause five generations. This record covers that reproduced gap and the oversized casual allowance, not proof of the reporter's exact hardware timings.

## Repro

Run `test/chat-prompt-diet.e2e.test.js` with its capped greeting fixture against baseline 90d6f0111. Send `hello cap regression` as a non-task turn through the real `/api/run` route. Have the local provider return valid partial text with `finish_reason: length`. Count provider requests and inspect the run-end finish reason.

## Evidence

Before repair: `FAIL: a capped casual reply stops after one generation — expected 1, got 5`. After the host disables semantic continuation only for non-task turns: all 29 assertions pass, partial text and finishReason:length remain visible, and task continuation still executes. `test/casual-response-safety.e2e.test.js` additionally proves the Ollama 512-token casual cap versus the 4096-token task cap through the real host. It checks worker parity, hosted wire preservation, supplied context, durable clarification promotion and transcript persistence/replay after restart.

## Verdict

Source repair verified through the real host and a dev-seeded station. Casual Ollama requests have a smaller configurable cap; task and auxiliary requests keep their existing allowance. A pending brief promotes a terse answer to a task before either policy applies. Generic hosted requests have no new cap. Automatic output continuation stays enabled for tasks. The unrelated transport retry path remains intact. Full gate receipts belong to the audit report. Installer and customer-model timing remain unverified.

## Regression

The real HTTP reproduction fails before the repair (five generations) and passes afterward (one). Provider tests cover absent classification for auxiliary calls, explicit task classification without tools, caller overrides, lower configured ceilings, non-finite values, and hosted requests. Cache-boundary and deferred-authentication regressions from the earlier latency branch are combined and tested separately.

The second review reproduced an internal auxiliary run receiving 512 instead of 4096 tokens; internal calls now retain their original classification-independent policy. It also reproduced Stop waiting on deferred OAuth refresh; cancellation now releases the caller immediately without cancelling shared refresh work or sending inference afterward. Seeded evidence: `qa/evidence/casual-response-0915/seeded-response-proof.json` (eight foreground runs across two boots; local controlled inference, not a customer-model benchmark).

## Sibling coverage

{"adapters":[{"target":"Ollama and hosted OpenAI-compatible","state":"covered","test":"test/provider.openai-compatible.test.js","scenario":"casual/task/auxiliary caps, caller overrides, invalid values, hosted wire","gate":"fast"},{"target":"native Claude, OpenRouter Claude, generic","state":"covered","test":"test/prompt-cache-prefix.e2e.test.js","scenario":"stable cache boundary, fresh runtime identity, complete task context and tools","gate":"http"},{"target":"Codex/Kimi/Grok fallback","state":"covered","test":"test/provider.registry.test.js","scenario":"lazy auth, live metadata, failed activation retry, cancellation before activation","gate":"fast"}],"entrypoints":[{"target":"lead and worker chat, pending clarification","state":"covered","test":"test/casual-response-safety.e2e.test.js","scenario":"small talk, actionable greeting, preserved context, pending brief promotion","gate":"http"},{"target":"task output continuation","state":"covered","test":"test/chat-prompt-diet.e2e.test.js","scenario":"capped casual reply stops once while task continues","gate":"http"}],"displays":[{"target":"streamed partial reply and completion status","state":"covered","test":"test/chat-prompt-diet.e2e.test.js","scenario":"partial token and finishReason:length retained","gate":"http"},{"target":"customer Windows Ollama inference and installed UI","state":"blocked","reason":"No local Ollama runtime or affected hardware is available; source fixtures do not establish user-visible timing or installer acceptance."}],"lifecycle":[{"target":"restart and conversation resume","state":"covered","test":"test/casual-response-safety.e2e.test.js","scenario":"exact transcript survives restart and earlier dialogue reaches next request","gate":"http"}]}
