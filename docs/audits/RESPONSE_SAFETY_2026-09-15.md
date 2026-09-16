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

`node dev/seed.js --keep` was exercised with the populated development station across two boots with eight real `/api/run` foreground runs. Greetings carried 1,854 system characters, versus 40,545 for task requests in this fixture. Ollama chat used 512 tokens, Ollama tasks 4096, and the generic hosted wire had no added limit. Output-limit stops retained `finishReason:length`. Source and raw run receipts are in `qa/evidence/casual-response-0915/seeded-response-proof.json`. The final receipt supersedes an earlier run whose fixture workspace alias overrode the seeded workspace; both workspace aliases were aligned for this run.

The actual COMMS UI was also exercised in the populated station. A hosted greeting completed; an Ollama fixture reply ending at its length limit displayed CUT SHORT and the existing instruction to say "continue". It sent one foreground generation with a 512-token limit. Reload preserved both user messages and their replies in order. The COMMS persona made these prompts about 8,680 characters; this is distinct from the smaller direct API fixture above. A background auxiliary call retained its 4096-token allowance. See `ui-proof.json` and `ui-requests-proof.json` beside the seeded receipt.

These are real host requests against a local controlled provider. No real Ollama installation was available on this machine, so the receipts do not establish customer-model response time or quality. Provider queues, cold local model loading and long-history summarization can still take time. No installer was rebuilt or published by this lane.

## Validation

Final acceptance: fast 783/783 on `a23f0e4d0`, HTTP 117/117 and customer journeys 34/34 on `bac8e8245`. Production source is identical across those candidates; the only later changes were three HTTP capture fixtures setting UTF-8 decoding on the request stream. The first frozen HTTP run exposed a split multibyte character in fixture capture at its last suite. Strict equality was retained, stream decoding was repaired, and the entire HTTP gate was rerun successfully. Source text integrity also passed across 1,965 tracked JavaScript files. Gate log hashes and candidate identities are in `gates.json`.

Focused provider, continuation, task-promotion, history, cancellation and seeded checks pass. Earlier exploratory broad runs overlapped second-review corrections and are not acceptance receipts; their source-authority checks correctly detected the changed source/ledger. No production source changed during the final acceptance runs. The history-order repair already on trunk remains covered; these checks do not establish recovery of previously lost customer data or every cause of missing sessions.
