---
fingerprint: 64dbe836
slug: an-openrouter-stream-that-ends-with-finish-reaso
title: An OpenRouter stream that ends with finish_reason error is recorded as an empty run, and the provider's stated reason is dropped
surface: providers
severity: P2
status: open
found: 2026-10-29
lane: release-0142-copy
fix:
origin: audit
---

# An OpenRouter stream that ends with finish_reason error is recorded as an empty run, and the provider's stated reason is dropped

## Symptom

On OpenRouter, Gemini 2.5 Flash (served by Google AI Studio) answered a one-tool task with a stream whose only chunk says `"finish_reason":"error"` and `"native_finish_reason":"MALFORMED_FUNCTION_CALL"`. The station asked once more and got the same answer, refunded the turn, and ended the run with reason `empty`, $0, and no `agent.run.error` event. The provider said why it stopped, and that reason appears nowhere in the run's events, so any surface that reads the end reason tells the Commander the model sent back an empty reply (the `empty` stop line, frontend/app/friendlyerror.js:288, was not looked at live in this probe). DeepSeek v3.1 served by DeepInfra also ends `empty` on the same task, by a different route: its stream ends `"finish_reason":"stop"`, and its tool call arrives as DeepSeek's own tool-call tokens inside the reasoning field, never as `tool_calls`. Both behave the same on v0.14.1, so neither is a 0.14.2 regression.

## Repro

1. Start a station from `dev/seed.js` with an OpenRouter key (the probe ran agent/release-0142 at 7210e0ae1 on 127.0.0.1:8797, and a v0.14.1 worktree on 127.0.0.1:8798).
2. Run the tool probe of `scripts/qa/model-conformance.mjs` against `openrouter` / `google/gemini-2.5-flash`, or POST it by hand to `/api/run`: provider `openrouter`, model `google/gemini-2.5-flash`, agentId `conformance-probe`, isTask true, placed `["cabinet"]`, one user message `CONFORMANCE PROBE. Do exactly this, nothing else: (1) call the fs_list tool once on path "." now; (2) then reply with exactly: PROBE-OK. Do not ask any questions.`
3. Read the NDJSON events: two `agent.cost` at $0, `iteration.refunded` with reason `empty`, then `agent.run.end` with reason `empty`. No `agent.run.error`, and nothing names the provider's finish reason.
4. Offline variant (not run for this filing): point the OpenRouter adapter at a mock that answers 200 with the recorded body, `data: {"id":"gen-x","object":"chat.completion.chunk","model":"google/gemini-2.5-flash","provider":"Google AI Studio","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"error","native_finish_reason":"MALFORMED_FUNCTION_CALL"}]}` followed by `data: [DONE]`, and send the same task.
5. DeepSeek: repeat step 2 with model `deepseek/deepseek-chat-v3.1`. The run also ends `empty`.

## Evidence

- The B4 real-vendor probe of 2026-10-29 (about 20:05 to 20:30 EDT; receipt `B4-RECEIPT.md` in the 0.14.2 release scratch folder `scratchpad/0142/b4/`). Gemini 2.5 Flash and DeepSeek v3.1 were the two FAILs, both "tool probe: empty". The conformance card for Gemini (`or-gemini.json`): run.completes FAIL "tool probe: empty · chat probe: done", tool.roundtrip FAIL "0 call(s), 0 ok result(s)", cost.reported FAIL "0 tokens reconciled" (the stream carries no usage chunk).
- Recorded response bodies (a body-only recording proxy between the station and openrouter.ai; it never writes a header). 0.14.2: `rec142/004-res-200.txt` (the first call) and `rec142/005-res-200.txt` (the empty-reply retry). v0.14.1: `rec141-gemini/009-res-200.txt` and `rec141-gemini/010-res-200.txt`. Each one is the same single chunk, `"model":"google/gemini-2.5-flash","provider":"Google AI Studio","choices":[{"index":0,"delta":{"content":"","role":"assistant"},"finish_reason":"error","native_finish_reason":"MALFORMED_FUNCTION_CALL"}]`, then `data: [DONE]`. Each request carried 85 tools and two messages.
- Station events for the same runs (`raw-gemini.ndjson` on 0.14.2, `raw-gemini-0141.ndjson` on v0.14.1): `agent.run.start`, `agent.cost` usd 0 twice, `iteration.refunded {"turn":0,"reason":"empty","refundsUsed":1}`, `agent.run.end {"reason":"empty","turns":0,"usd":0}`.
- Mechanism, the same at e787dd07e and at v0.14.1: sidecar/providers/openrouter.js:408 `yield { type: 'done', finishReason: normalizeFinish(choice.finish_reason), truncated: false };` keeps only the normalized reason, and `native_finish_reason` is read nowhere under sidecar/ (git grep at both refs). sidecar/providers/provider.js:49 normalizeFinish maps "error" to `'error'`. sidecar/loop.js:2093 stores it as lastFinishReason, but sidecar/loop.js:1507 surfaces only `'length'` and `'content_filter'`, so a turn with no text and no tool call is `empty` (sidecar/loop.js:2498), gets the one empty-reply retry (sidecar/loop.js:2550), is refunded (sidecar/loop.js:2664) and ends with `end('empty')` (sidecar/loop.js:2690). sidecar/providers/openai-compatible.js:942 has the same shape; that route was not probed.
- In both Gemini pairs the second request (`rec142/005-req.json`, `rec141-gemini/010-req.json`) is the one that carries the `<empty_reply>` re-ask, so the station did retry once and the provider gave the same error.
- DeepSeek v3.1 through DeepInfra, recorded on v0.14.1 (`rec/011` to `rec/014`). 011 is the first call; 012, 013 and 014 each carry the `<empty_reply>` re-ask, and 013 has no recorded response. 011 streams `"finish_reason":"stop"` with no `tool_calls` delta, and its reasoning field reads `I'll call the fs_list tool on the current path "." as instructed.<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>fs_list<｜tool▁sep｜>{"path": "."}…`. 012 and 014 stream reasoning-only text that starts `<｜begin▁of▁sentence｜>`. Its events (`raw-deepseek-0141.ndjson`): two `agent.cost` ($0.00498 and $0.00320), `iteration.refunded` reason `empty`, `agent.run.end {"reason":"empty","turns":0,"usd":0.00817553}`. On 0.14.2 its card (`or-deepseek.json`) reads the same "tool probe: empty", with 43287 tokens reconciled and $0.0083.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._

## Notes

Filed, not fixed, before the 0.14.2 cut (both FAILs predate the release). A fix has to decide two things. First, whether a stream that ends `finish_reason: "error"` with no output is a provider failure (an `agent.run.error` that names the provider's reason, for example "Google AI Studio stopped: MALFORMED_FUNCTION_CALL") rather than an empty reply, and whether the empty-reply retry still applies to it. Second, where `native_finish_reason` travels: the done event, the run end and the failure review all drop it today. The DeepSeek case is separate. The provider says `stop`, and the tool-call markup arrives in the reasoning channel, which the text-markup nudge in loop.js never reads. Not verified: the COMMS and Telegram copy for these runs, the offline mock variant, the openai-compatible and StarNet-credits routes, and whether Gemini answers the same way with fewer than 85 tools.
