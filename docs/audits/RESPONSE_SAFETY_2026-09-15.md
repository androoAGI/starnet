# Response latency safety review

Branch: `agent/response-audit-0915-7c2a`, starting at `90d6f0111`.
Source repairs: `148be89b5`, `54c95c6b3`, `fc4c9e0f4`; prior cache/authentication repair integrated at `9107d66e1`.

## Findings and changes

- A per-call output ceiling did not bound a greeting: `finish_reason:length` triggered four continuation calls. The real HTTP regression failed with expected 1 request, actual 5. Casual chat now stops after one generation, retains the partial text and reports its length stop. Real tasks retain semantic continuation and partial-tool-call protection.
- Ollama small talk now uses a 512-token ceiling, configurable with `SKYNET_OLLAMA_MAX_CHAT_TOKENS`. Task and auxiliary calls retain the existing 4096-token default and `SKYNET_OLLAMA_MAX_TOKENS` override. A lower general ceiling still wins. Hosted/custom profiles get no new output limit. Explicit caller limits retain precedence; non-finite values cannot accidentally remove the ceiling.
- The earlier prompt-cache and lazy fallback-authentication fixes are combined with the existing prompt reduction. Claude receives a separate stable-prefix cache boundary. Other providers retain their expected wire format, with changing runtime identity last. All task instructions and tools remain present.
- A second review caught internal auxiliary calls inheriting the new casual ceiling. That was reproduced and corrected before acceptance. A pending clarification answer is promoted to task work before classification reaches the provider.
- Stop during deferred OAuth authentication previously waited for the refresh to finish. The caller now stops immediately; successful shared refresh remains reusable, and the cancelled request never sends inference.

## Behavior proof

The real host tests cover lead/worker small talk, actionable greetings, hosted/local output policy, pending task answers, preserved conversation context, exact transcript persistence and restored dialogue after restart. Cache tests exercise native Claude, OpenRouter Claude and generic adapters. Fallback tests cover Codex/Kimi/Grok credentials, metadata, failures and cancellation.

`node dev/seed.js --keep` was exercised across two boots with eight real `/api/run` foreground runs. Greetings carried 1,854 system characters, versus 40,545 for task requests in this fixture. Ollama chat used 512 tokens, Ollama tasks 4096, and the generic hosted wire had no added limit. Output-limit stops retained `finishReason:length`. Source and raw run receipts are in `qa/evidence/casual-response-0915/seeded-response-proof.json`.

These are real host requests against a local controlled provider. No real Ollama installation was available on this machine, so the receipts do not establish customer-model response time or quality. Provider queues, cold local model loading and long-history summarization can still take time. No installer was rebuilt or published by this lane.

## Validation

Focused provider, continuation, task-promotion, history and seeded checks pass. Final full fast/HTTP/customer-journey receipts will be added after the frozen-source run. The first broad pass overlapped the second-review corrections and is not an immutable-candidate acceptance receipt; its source-authority checks correctly detected the changed source/ledger.
