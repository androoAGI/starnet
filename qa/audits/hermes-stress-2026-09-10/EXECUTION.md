# Hermes-derived improvements: execution receipt

Initial candidate: 6974ac3f8e72127e09a915b043583a50a0665d3b on agent/hermes-stress-0910. Integration is pending. This records source work, not installed-build verification or measured model-quality parity.

| Area | Implemented | Verified so far | Still required |
| --- | --- | --- | --- |
| Completion honesty | Host terminal status, partial output and real usage survive sync, streaming and run-status responses | Eight terminal cases across three API surfaces; original live partial-failure probe passes three repetitions per surface; baseline API 36 assertions | Full gates; restart/status scope review |
| Request retries | Durable reservation before dispatch; canonical request/model binding; principal/session isolation; conflict rejection; exact saved response replay | Live sidecar: three concurrent requests produce one primary call, changed request returns 409, replay survives actual sidecar restart; orphan/corrupt-store unit checks | Rotation/write-failure siblings; complete gate |
| Report structure | Semantic tables, ordered/nested lists, quotes and named links; escaped output; original code-copy control and phosphor styling | 26 renderer/copy assertions, including hostile markup/protocol input | Live browser, narrow widths, selection/scroll, reload and clipboard proof; browser tool approval blocked |
| Result contracts | Pinned Ajv 8.20.0 in a dedicated host module; minimum, pattern, minItems, oneOf and local refs; strict whole JSON; one output-only repair; API format handling | Six positive/negative schema pairs; 262 orchestration assertions; API repair/usage tests; live invalid-JSON probes; installed OpenAI Python SDK accepts sync, stream and failure metadata | Full gates; hostile tool request during repair, spawn/resume/restart live siblings |

## Evidence and limits

The historical before-results remain unchanged in this directory. New starnet-partial-after.json and starnet-json_object-after.json / starnet-json_schema-after.json record actual source-sidecar calls with a controlled local provider. Zero usage in the fatal partial stream means the provider emitted no usage; it is not an estimate of free work. Failed JSON output records 40 tokens, accounting for both 20-token calls.

The installed OpenAI Python SDK completed sync and streaming requests and exposed the failed JSON response as finish_reason error with starnet.completed false. This used the isolated local provider, not a paid model.

Keyed streaming now shares incremental progress with matching callers; terminal frames wait until the complete response is durably saved. This prevents a disconnected retry from cancelling shared work and the actual caller-disconnect regression passes. Reservations left without a durable response return an explicit interrupted conflict; they do not automatically resume a task or repeat mutations. The existing /v1/runs store is still in-memory. A new regression ensures pre-dispatch 429 responses remain retryable. The first full fast run was intentionally stopped to fix this edge; it is not a passing gate receipt.

Result schemas intentionally support a bounded subset: local JSON Pointer refs, no recursive/remote refs, safe simple patterns, schemas up to 12,000 characters and structured output up to 1 MiB. Unsupported contracts fail explicitly. Structured streaming is rejected before dispatch; clients can request stream:false. The validator does not silently accept output when unavailable. See [Ajv schema documentation](https://ajv.js.org/json-schema.html) and [security guidance](https://ajv.js.org/security.html) for the underlying validator behavior.

## Remaining campaign

The planned 72 live-model trials require the same provider/model and an explicit total API spending ceiling. Both were requested from the user; none has been selected by the agent. No paid comparison trials have run. The 48-hour soak follows the short campaign and has not started. The existing scripts/qa/soak.mjs can provide source-sidecar restart/scheduling/process evidence; it does not prove desktop UI behavior or cover all newly added API scenarios without additional workload coverage.

Browser-only opening of the isolated test page was rejected by automatic approval review, citing disabled native computer APIs. Permission to retry the browser-only verification was requested. No workaround was used. A separate npm audit invocation was rejected because it could transmit dependency metadata; it was not run. The public Ajv version lookup and installation with --no-audit succeeded.
