# StarNet systemic reliability audit — 2026-09-19

The strongest recurring defect is loss of authority at a boundary: a transport response, cached projection, default value or late callback is treated as proof of current durable state. This audit reproduced and repaired eight additional manifestations across durable storage, permissions, routine creation, finite API requests, Recipe Bay and execution/messaging controls.

Source fixes: `8eb87b0d3`; source candidate locked at `ff8c5b709`. Work remains on `agent/reliability-audit-0919`, in its isolated worktree. This is source and local runtime evidence, not an installer release or a claim that every customer incident is resolved.

## Evidence scope

Reviewed all 181 historical records present after synchronizing this branch with trunk, including the six records from the preceding end-to-end audit. The accompanying [report-patterns.json](../evidence/systemic-bugs-0919/report-patterns.json) maps every historical record to its symptom, recorded mechanism/disposition, source file hash and primary pattern. Eight reproduced findings and three newly imported unresolved reports bring the register to 192.

Read the prior support intake, session-delivery handoff, ground-up audit, current known-issue suppressions and September 16 release intake. Refreshed all 14 accessible GitHub issues, including comments, and searched inbound Gmail for StarNet after September 16: nine messages in eight threads, with their conversation context. Older mail is represented by the durable register and dated intake documents, not a new complete mailbox census. Inline images and customer machines were not inspected. Private messages and account details are not copied into these artifacts. No customer messages, billing actions or issue closures were performed.

A shared pattern is a search lead, not proof that two customers had the same cause. Historical source fixes, released artifacts and actual customer recovery remain separate facts.

## Recurring patterns and failure conditions

These are primary analysis buckets; a report can also involve another mechanism. Counts describe the 181 historical reports, not prevalence among all users.

| Pattern | Reports | Recurring trigger and systemic lesson |
| --- | ---: | --- |
| Authority and acknowledgement | 29 | HTTP success, model prose or UI optimism substitutes for a validated domain outcome. Check the requested effect and preserve uncertainty on an ambiguous response. |
| Durability, recovery and replay | 20 | Restart, partial writes, unreadable files, lost acknowledgements and repeated delivery expose disagreement between memory and disk. Distinguish missing, corrupt and inaccessible state; keep durable identity through retries. |
| Asynchronous ownership and lifecycle | 23 | Switching provider/agent/panel, concurrent mutations or delayed callbacks allows an earlier operation to win. Give each result an owner and generation; serialize conflicting writes; bound finite waits. |
| Configuration and capability propagation | 27 | Interactive, delegated, scheduled and channel entrypoints build different execution contexts. Carry provider, credentials, permissions, capabilities and workspace together through each route. |
| Representation, identity and context | 21 | Provider schemas, conversation origins, run IDs and context projections change meaning between layers. Preserve provenance and determine eligibility from the individual action. |
| Rendering, layout and resource pressure | 33 | Valid backend data, large histories, absent globals or interaction order break rendering independently of backend health. Exercise actual pages, error rendering and recovery. |
| Packaging, platform and evidence authority | 19 | Older WebKit, stale assets, wrong build identity or overstated test receipts make a source fix appear delivered when it is not. Test supported runtime capabilities and exact artifacts. |
| Cause unresolved | 8 | Reports lack the request, run, account or platform correlation needed to establish a cause. Keep the uncertainty visible. |
| Deliberate policy boundary | 1 | An intentional unattended permission restriction must remain enforced and accurately explained. |

Examples that connect the patterns: `1600dcf0` is late model-catalog authority; `09f0e9fa` is interactive rating eligibility confused with scheduled conversation origin; `5308fc67` is Mac runtime capability mismatch; `25120f27` is a valid Projects response followed by a renderer failure; `11341152` is a finite MCP result trapped behind a held-open SSE stream. The new findings below follow those same boundaries into sibling code.

## Repairs made in this follow-up

| Finding | Shared cause and repair | Regression coverage |
| --- | --- | --- |
| `7aeb7f9f` unreadable durable records | Shared `durable-store.js` no longer sends temporary I/O failures through destructive corruption callbacks. Both update and full-state writers refuse uncertain reads, including an inaccessible sole backup. | Five I/O error classes across valid, absent, empty and torn primary states; callback and byte preservation; direct/set/update writers; four real sidecar fault/restart cases. |
| `83c34908` swallowed backup failure | Backup write errors are no longer caught as if parsing the original primary had failed. ENOSPC refuses the replacement before primary data changes. | Injected backup write failure proves original primary bytes and restart recovery. Shared storage matrix totals 122 checks. |
| `dde8e66f` stale permission authority | Permissions use initialization epochs, read generations and mutation revisions; writes execute in submission order and reads wait for pending writes. Old completions cannot change a newer cache. | Reverse read order, late success and error after revoke, queued failures, reinitialization and old mutations. |
| `95d13aaf` ambiguous acknowledgements | Grants, revokes and bypass require proof of the requested state. Routine proposals require a valid success body and durable job identity before disappearing or reporting a duplicate. | Null/empty/malformed/contradictory bodies, HTTP failure, lost response, exact effect, valid create and duplicate. Permission suite: 79 checks. |
| `38aad6db` unbounded finite JSON requests | Shared GET/POST/DELETE transport bounds headers and body, handles caller abort and cleans up timers. Mutation timeout explicitly leaves completion unconfirmed; it does not automatically replay a side effect. | Three verbs, held headers/body, abort, late completion, JSON errors, synchronous throws and cleanup: 53 checks. GET defaults to 15 seconds; mutations to 60 seconds. Streaming runs are separate. |
| `e60f28af` failed catalog reads cached as empty | Recipe Bay validates all five collection envelopes, retains last confirmed cache on refresh failure and keeps first-load failures retryable. | Skills, routines, runs, projects and connectors against HTTP failures, malformed envelopes, JSON/network errors, healthy retry, legitimate empty lists and stale refreshes. |
| `759f281c` disconnected tools count as ready | Recipe fit requires a usable up/cached connector, enabled state and no authentication requirement. Halted routines no longer count as armed. | Six connector state variants; combined catalog/readiness suite: 68 checks. |
| `1b9af0d7` control result contracts | Five execution controls inspect the domain body inside the HTTP wrapper. Messaging disconnect requires confirmed disconnected state and durable persistence. SSH saved configuration remains distinct from a failed connectivity probe. | HTTP failures, body refusal, empty/null responses, valid acknowledgement, not-persisted and still-connected states: 55 checks. |

Mirrored website frontend assets were synchronized. Existing recommendation cache-invalidation regression was updated to include the actual new collection-reader dependency; its 135 assertions retain the old response-versus-new-generation checks. The initial full fast run exposed this harness dependency; the failure is retained, not suppressed.

## Cross-codebase trace

| System | Boundaries inspected or exercised | Evidence and limits |
| --- | --- | --- |
| Station persistence and restart | `/api/save`, CloudSave, durable-store consumers, widgets, backup recovery, autosave | Prior audit save repairs retained; new shared writer guards and real restart fault tests. A successful source test does not prove every possible filesystem failure or multi-process writer race. |
| Permissions and execution | grant/revoke/bypass, refresh/reset, policy, SSH save/clear/sync/cleanup | New ownership and acknowledgement matrix plus real browser revocation and policy refusal. No remote SSH host was modified. |
| Routines and autonomy | proposal creation, cron fairness, armed/halted projection, loop lifecycle, budgets and completion history | Prior cron fairness repair retained; actual browser proposal refusal and full HTTP loop/night-shift tests. Reported overnight spend still requires affected run evidence. |
| Providers and routing | factory, compatible adapter, task classification, model catalogs, fallback context, replay and output caps | Existing regressions cover provider switches, tool forwarding and refusal to silently drop tools. Controlled endpoints do not reproduce every local model or paid route. |
| Integrations and channels | MCP schema translation, authentication truth, SSE lifecycle, delegated tool context, disconnect persistence | New disconnect acknowledgement checks; existing transport/channel/dispatch regressions. Live Zoho schema and affected OAuth accounts unavailable. |
| Conversations and user results | rating origin, transcript restart, run identity, delivery/catch-up and failure states | Existing real-sidecar regression coverage retained. GitHub #18 maps to already-present per-run eligibility repair, not a new closure. |
| Projects, Recipe Bay and station UI | valid backend response/render failure, cached lists, reopen/retry, real settings actions | New catalog matrix and browser recovery; existing Projects renderer repair is present. Live journeys pass 139/139. |
| Packaging and telemetry | boot guard, legacy WebKit features, mirrored assets, source/installer/customer evidence separation | Existing Mac compatibility repair retained. This Windows campaign cannot certify physical Mac recovery or a shipped installer. |

## Fresh intake reconciliation

The [sanitized intake index](../evidence/systemic-bugs-0919/external-intake.json) records all 14 issue links and the eight support-thread dispositions.

GitHub #2, #5, #6, #12, #13, #14 and #18 correspond to already registered boot, OAuth/SSE, provider routing, delegation and rating cases. #17 maps to the existing local-model small-talk overload/cap work; discussion is not a customer recovery receipt. #1, #10, #11 and #15 are feature requests or usage discovery, not additional demonstrated defects. #19 reports Gemini setup trouble under a feature-request title; no text error identifies an adapter failure, and its screenshot could not be retrieved by the available web reader. Preserve it as an uncorrelated provider intake item pending the exact error/model/catalog response; the OpenRouter workaround is not proof of repair. #20 is newly tracked as `678ac951`.

The September 18 Mac regex/timeout diagnostics match `5308fc67`; the separate shared-catalog boot failure and credit follow-up remain their existing open incidents. The Projects loading report matches `25120f27`, already source-fixed; its thread explicitly says no released installer yet. The Ollama no-chat-POST report remains `5274c7b7`, distinct from tool invocation. The Zoho bootstrap report and overnight verification follow-up are newly tracked separately.

## Prioritized unresolved work

| Priority | Incident or boundary | What is needed for a safe resolution |
| --- | --- | --- |
| P1 | `2f156837` Mac shared-catalog boot failure | Affected installed app/build and exact asset request/response on physical Mac; validate packaged recovery. Do not equate source compatibility tests with this separate missing-script cause. |
| P2, high impact | `f8d479d9` repeated overnight verification spending | Sanitized parent/run/tool ledger, armed work configuration, completion-check outcomes and usage reconciliation. Current dry-stop/red-streak guards cannot establish why these reported runs continued. |
| P2 | `678ac951` Ollama zero-tool task completion | Actual model/station request and structured response, effective tool definitions and task classification. Do not execute tool-looking prose or force tools indiscriminately. |
| P2 | `54564ff9` Zoho bootstrap schema | Authenticated raw tools/list schema, registry schema and provider projection, then an authorized bootstrap call. Do not remove required parameters based only on a tool name. |
| P2 | `5274c7b7` Ollama chat POST not observed | Packet/request correlation on reported Ollama/runtime; local controlled HTTP success is insufficient. |
| P2 | `acb47320` unexplained idle usage; `abd75bb4` Mac credit consumption | Affected work ledger and account-side usage correlation. No refund or billing mutation is part of this audit. |
| P2 | `fd9c4b4d` managed Sonnet 400 | Current sanitized route/model/request correlation and authorized production access. Related routing fixes do not prove the historical provider 400 is recovered. |
| P2 | `6bb9d2a1` visibility and `ff3fb4cb` Mac unsupported-installation incidents | Reproduce on affected build/platform and preserve reported action/response; existing report details remain the authority. |
| P2 | `6e29727c` Node 24 native HTTP crash | Runtime-level reproduction/debugging on that Node build. Node 22 passing does not resolve the native crash. |
| Intake gap | GitHub #19 Gemini setup error | Read the screenshot or obtain its text and compare exact selected model/provider response before assigning a cause. |
| Validation uncertainty | Intermittent paid-link restart ownership refusal | Retain the failed full-gate log and direct retry; correlate child exit/lock ownership under load before attributing the cause. Never bypass the workspace ownership guard. |
| Release validation | Installer delivery and affected-customer recovery | Build/test exact installer artifacts on supported platforms after integration, then obtain recovery receipts. No installer was built or published here. |

The existing register's uncorrelated-report severity rule is preserved. Reports are not marked fixed merely because a neighboring regression passed. Wider architectural review should continue to examine boot loaders that cache defaults after transient reads and independent full-state writers; the new shared guards protect uncertainty during writes, but do not constitute a proof of every future recovery sequence.

## Validation

See [validation.json](../evidence/systemic-bugs-0919/validation.json) for final gate status and retained artifact hashes. The focused campaign passed 21 suites. Browser fault proof uses the production seeded app and controlled transport failures: stale permission read, ambiguous bypass response, rejected routine proposal, Recipe Bay retry and visible execution-policy refusal all passed with no uncaught exceptions. Four real-sidecar durable fault scenarios retained the original widget data after restart. The finite-API matrix has controlled module coverage plus six held-header/body deadline cases in the real seeded browser, all passing with no uncaught exceptions. All execution handler variants have module coverage; only the representative policy refusal was additionally clicked in the browser.

The complete live journey campaign passed 139/139 assertions. Full fast and HTTP gate receipts are retained separately. No claim of universal regression coverage, live paid-provider acceptance, physical Mac acceptance or production readiness follows from those results.

A full HTTP attempt also hit one WORKSPACE_BUSY refusal during the paid-link restart test. All six cases passed on direct retry; the refusal is retained in the first HTTP log and has not been attributed to a product or fixture cause. The final full retry result is recorded separately. One fast retry stopped because the generated index had not yet been refreshed after importing the three new reports; regeneration restored all eight register assertions. These failed attempts are preserved alongside final gates.

A retained intake wire probe passed 18 assertions using native loopback HTTP and the production Ollama provider factory: each of the three reported model identifiers retained the filesystem tool schema and parsed a structured tool call. MCP translation preserved absent, empty and account-required arrays without inventing requirements. This narrows the investigation to actual station/model/schema evidence; it does not close either customer report. Run from the repository root with `node qa/evidence/systemic-bugs-0919/intake-wire-probe.cjs`.

The next full fast run also exposed an old direct-fetch source assertion in `test/class-loadouts.test.js`. It now follows the production collection reader through `Harness.api.get` and retains the live catalog requirement; all 2,651 assertions pass in that suite. No product code changed during these test-harness corrections.

The complete HTTP retry passed all 121 suites, including the paid-link lifecycle and the new durable restart faults. Its existing tool-projection suite also passed ten real sidecar runs with actual filesystem writes, saved-equipment fallback, explicit empty equipment, trusted-project grants, revocation and restart. The controlled responder establishes host behavior, not the affected Ollama model's choices.

The error-handling ratchet correctly detected that the durable-store repair removed one silent catch. Its exact allowance was lowered from four to three in `test/failopen-ratchet.test.js`, preserving the no-slack rule. The remaining 77-suite tail then passed, including all new regression matrices. The final complete fast gate was rerun after this last test-only adjustment.
