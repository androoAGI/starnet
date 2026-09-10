# Hermes-derived improvements: execution receipt

Verified source candidate: 61eeac2b40c9fd0e2e0a5d2b342f44de74119078 on agent/hermes-stress-0910. Both full gates passed. Integration remains pending. The later [browser follow-up](BROWSER_VERIFICATION.md) verifies the renderer and records two additional fixes. This is source-sidecar evidence, not installed-build or live-model parity.

| Area | Implemented | Verified so far | Still required |
| --- | --- | --- | --- |
| Completion honesty | Host terminal status, partial output and real usage survive sync, streaming and run-status responses | Eight terminal cases across three API surfaces; original live partial-failure probe passes three repetitions per surface; baseline API 36 assertions | Installed-build proof; /v1/runs restart persistence is outside this repair |
| Request retries | Durable reservation before dispatch; canonical request/model binding; principal/session isolation; conflict rejection; exact saved response replay | Live sidecar: one primary call for concurrent callers, conflict and exact restart replay, incremental streaming and caller disconnect; auth-rotation, orphan, corrupt-store and write-failure regressions | Long-load/soak coverage |
| Report structure | Semantic tables, ordered/nested lists, quotes and named links; escaped output; original code-copy control and phosphor styling | 33 renderer/copy assertions; live browser at three sizes, wide-table scrolling, exact copy, reload/restart, and selection during streaming | Installed desktop and broader UI zoom coverage; see browser follow-up |
| Result contracts | Pinned Ajv 8.20.0 in a dedicated host module; minimum, pattern, minItems, oneOf and local refs; strict whole JSON; one output-only repair; API format handling | 12 positive/negative live schema cases; 262 orchestration assertions; hostile repair: one generation, no tools, no mutation; installed OpenAI Python SDK sync/stream/error checks | Additional live worker spawn/resume coverage in the campaign |

## Evidence and limits

The historical before-results remain unchanged in this directory. New starnet-partial-after.json and starnet-json_object-after.json / starnet-json_schema-after.json record actual source-sidecar calls with a controlled local provider. Zero usage in the fatal partial stream means the provider emitted no usage; it is not an estimate of free work. Failed JSON output records 40 tokens, accounting for both 20-token calls.

The installed OpenAI Python SDK completed sync and streaming requests and exposed the failed JSON response as finish_reason error with starnet.completed false. This used the isolated local provider, not a paid model.

Keyed streaming now shares incremental progress with matching callers; terminal frames wait until the complete response is durably saved. This prevents a disconnected retry from cancelling shared work and the actual caller-disconnect regression passes. Reservations left without a durable response return an explicit interrupted conflict; they do not automatically resume a task or repeat mutations. The existing /v1/runs store is still in-memory. A new regression ensures pre-dispatch 429 responses remain retryable. The first full fast run was intentionally stopped to fix this edge; it is not a passing gate receipt.

Result schemas intentionally support a bounded subset: local JSON Pointer refs, no recursive/remote refs, safe simple patterns, schemas up to 12,000 characters and structured output up to 1 MiB. Unsupported contracts fail explicitly. Structured streaming is rejected before dispatch; clients can request stream:false. The validator does not silently accept output when unavailable. See [Ajv schema documentation](https://ajv.js.org/json-schema.html) and [security guidance](https://ajv.js.org/security.html) for the underlying validator behavior.

## Remaining campaign

The planned 72 live-model trials require the same provider/model and an explicit total API spending ceiling. Both were requested from the user; none has been selected by the agent. No paid comparison trials have run. The 48-hour soak follows the short campaign and has not started. The existing scripts/qa/soak.mjs can provide source-sidecar restart/scheduling/process evidence; it does not prove desktop UI behavior or cover all newly added API scenarios without additional workload coverage.

Browser-only opening of the isolated test page was rejected by automatic approval review, citing disabled native computer APIs. The user approved a retry, which succeeded; see BROWSER_VERIFICATION.md. No workaround was used. A separate npm audit invocation was rejected because it could transmit dependency metadata; it was not run. The public Ajv version lookup and installation with --no-audit succeeded.

## Final gates and reproducibility

Full fast gate: 757/757 steps, exit 0. Full HTTP manifest: 110/110 steps, exit 0 under the documented 30-minute runner ceiling. The original 15-minute audit timeout remains historical evidence; it is not relabeled as a pass. The new complete receipts and SHA-256 hashes are in implementation-receipt.json. No tests were removed.

Earlier validation included two intentionally stopped runs for retry/repair corrections and three failed runs: stale frontend source hashes, a worker-cap source assertion that did not recognize the stricter repair bound, and silent progress-listener catches. The hashes were refreshed without changing claim verdicts; the assertion still requires normal worker limits; listener errors now reach the diagnostic logger. A later adversarial probe found unsafe patterns accepted inside propertyNames and schema dependencies; the schema traversal now covers those and additionalItems, with regressions. Final full runs include all corrections.

Run the focused permanent pack with: node scripts/run-test-list.mjs test/hermes-strengths.list. All ten suites also belong to fast or HTTP. The 72-trial live-campaign-queue.json contains scenario templates and explicit not_run slots; it is not a completed campaign.

Campaign preflight should verify native tool availability across entrypoints: openai-compat.startRun currently supplies no isTask flag, while the host tool advertisement depends on it. The existing adapter probes establish API outcomes and primary-dispatch counts, not full mutating-task capability parity. Also measure request-reservations.js with large durable responses; its full-file JSON strategy has not been load/soak verified. These are source-guided questions, not additional verified Hermes wins.

Browser follow-up: source fixes at 19e6aebde, source-lock refresh at c9997b6b9, and a fresh complete fast gate. Integration remains pending; the integration tree was observed with unrelated uncommitted work, which this lane did not modify.
