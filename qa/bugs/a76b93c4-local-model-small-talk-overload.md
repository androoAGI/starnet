---
fingerprint: a76b93c4
slug: local-model-small-talk-overload
title: Local model small talk carries excessive context and produces prolonged replies
surface: providers
severity: P1
status: fixed
found: 2026-09-15
lane: release-0120-prep-0915
fix: 5acf4640f
origin: customer
report: https://github.com/androoAGI/starnet/issues/17
affected: v0.11.2 Windows, Ollama llama3.2:3b, Intel Iris Xe
family: local-model-conversation-latency
installer: unverified
recovery: unconfirmed
---

# Local model small talk carries excessive context and produces prolonged replies

## Symptom

On Windows 0.11.2 with Ollama llama3.2:3b, a greeting reportedly waits about 2.5 minutes before a long technical reply takes roughly ten minutes to finish. The station also has scheduled research and a goal loop. The report asks for brief conversation and appropriate model assignment.

## Repro

1. Select Ollama llama3.2:3b for the main agent on Windows; retain a research routine and goal loop.
2. Send "hello" in COMMS and capture prompt size, first-token latency, output tokens and completion time.
3. Repeat in a fresh conversation and then with retained conversation history; compare task turns and a specialist using the same model.
4. Run `node test/chat-prompt-diet.e2e.test.js` for the independently reproducible excessive-prompt mechanism. This mock-provider check does not reproduce hardware latency.

## Evidence

September 16 intake refresh: the reporter's 01:40 UTC comment thanks another user for setup advice and asks about CEO/specialist setup and cost control. It does not provide a new latency measurement or confirm recovery. Peer explanations about local-model performance are not accepted as a verified diagnosis. No support reply was sent by this preparation task.

GitHub #17 was read on 2026-09-16 UTC. Source repair `5acf4640f95201f0817dd7402211daecf2a5d56c` is an ancestor of preparation baseline `90d6f0111931ec3991aaba28d580422b4b02a81b`. It removes task-only manual/recipe/orchestration blocks from non-task turns and adds the Ollama profile's configurable 4096-token ceiling. Anchors: `test/chat-prompt-diet.test.js`, `test/chat-prompt-diet.e2e.test.js`, `test/provider.openai-compatible.test.js`, `test/provider.registry.test.js`.

The HTTP regression drives a real sidecar with a local mock provider, checking that greeting prompts omit task-only blocks while task tools and runtime identity remain. The default output ceiling is a bound, not proof of a brief response or an acceptable duration on a 3B local model. The public discussion contains no reporter recovery or exact timing after this repair.

## Verdict

Open for the end-user latency/verbosity symptom. The related source mechanism is repaired, but no same-model before/after latency, long-history comparison, rebuilt installer or affected-machine result establishes resolution. Keep automatic multi-model routing requests separate from this bug; this record does not promise that feature.

## Regression

Existing fast and HTTP scenarios exercise the prompt and provider-wire changes. The 0.12.0 acceptance run must record actual local-model timing, output length, task capability retention and history effects before claiming the reported behavior fixed.

## Sibling coverage

{"adapters":[{"target":"Ollama compatible wire and hosted profiles","state":"covered","test":"test/provider.openai-compatible.test.js","scenario":"optional max_tokens and unsupported-parameter recovery","gate":"fast"},{"target":"llama3.2:3b on reported Windows hardware","state":"blocked","reason":"No exact-machine before/after timing or real-model receipt is available."}],"entrypoints":[{"target":"non-task and task HTTP runs","state":"covered","test":"test/chat-prompt-diet.e2e.test.js","scenario":"greeting omits task-only context while task tools remain","gate":"http"},{"target":"specialist small talk and background research contention","state":"blocked","reason":"The reported combination needs a separate live model scenario."}],"displays":[{"target":"COMMS latency and reply length","state":"blocked","reason":"Wire assertions do not prove a short, timely visible answer."}],"lifecycle":[{"target":"long history, fresh conversation and installed restart","state":"blocked","reason":"Requires same-model comparison and exact candidate installer evidence."}]}
