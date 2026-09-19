# StarNet reliability audit — 2026-09-19

The audit reproduced and repaired five reliability defects: four in saved-station persistence/recovery and one in capped routine scheduling. It also reproduced an unresolved Windows Node 24 validation-process crash. This is source and isolated-browser evidence, not a production-readiness or installed-customer-recovery claim.

Workspace: `agent/reliability-audit-0919`. Starting trunk: `acbf3c225`. The branch incorporates the independently authored chat-completion repair through trunk `7f55d8809`. Final frozen source candidate: `43a59104e3c2c472cb3405780d56e5ab46ca9e43`. The HTTP campaign and scheduler soak started at `9dfedb18f4b7b31f241909b46d41fcfd9af2e5c9`; backend bytes remained unchanged through the final candidate. Subsequent frontend changes distinguish cache failure from disconnection and are covered by the final browser proof and fast gate. No integration-tree feature edits, shared-event/schema changes, external messages, account changes, installer rebuilds, or publication.

## Reproduced repairs

| Priority | Defect and user consequence | Repair and evidence |
| --- | --- | --- |
| P1 | [Unreadable primary or sole backup](../bugs/34c58f4f-unreadable-station-save-is-reported-empty-and-it.md) became a successful empty-station read. A replacement eclipsed the backup after restart. | Preserve unreadable authority; GET returns 503; writes refuse until a safe prior can be read. Cache-cleared browser reload shows SAVE-READ; Retry restores the station. Missing-main recovery is disclosed. Real bytes and restart are covered by the HTTP regression. |
| P1 | [Malformed save replies](../bugs/28dbd392-malformed-save-acknowledgements-claim-durability.md) claimed durability, or claimed no station existed. | Require explicit `ok:true` for writes and explicit `save:null` for empty reads. Bad replies retain pending work or enter recovery. The live browser reproduction covers malformed JSON and malformed objects. |
| P1 | [Stalled acknowledgements](../bugs/e6b19398-stalled-save-responses-permanently-block-the-per.md) blocked the entire serial save queue. | Bound headers and body acknowledgement to 15 seconds, abort on timeout, retain the snapshot, and ignore late replies. Controlled-timer regressions cover both phases; a real browser holds the body for 16 seconds and proves timeout/retry. |
| P1 | [Failed cache adoption](../bugs/25de9a74-failed-remote-save-adoption-falls-through-to-fir.md) fell into onboarding, or rebased stale cached content onto the newer server revision. | Verify the cache write before migration; retain the old revision on failed adoption. A no-local failure enters recovery. Browser quota-fault proof verifies unchanged cache and retained revision; concurrency/version tests protect neighboring paths. |
| P1 | [Routine starvation under a concurrency cap](../bugs/0cfef8af-concurrency-limited-routines-starve-later-due-jo.md) repeatedly favored earlier array entries over older deferred occurrences. | Allocate capped slots in oldest-due order. Equal due times remain stable; uncapped scheduling, lease exclusion, misfire policy and durable advance-before-run are unchanged. Regression reproduces the error before and after driver restart. |

Persistence source commit: `d9b6fba04`, recovery copy/test follow-ups `b2b471d40` and `f64fe5679`. Scheduler source commit: `b651a8f5d`. Existing chat-cutoff work is incorporated, not claimed as authored by this audit.

## Coverage and limits

Every row names actual exercised workflows; it does not imply all possible inputs or every platform were exhausted.

| Major workflow | Evidence exercised | Boundary |
| --- | --- | --- |
| Boot, recovery, save adoption | Real seeded station; cache-cleared reload; scoped EACCES and quota faults; recovery screen and Retry; save/future-version tests | Actual Mac WebKit and installed Windows WebView quota behavior not exercised |
| Saving, stale tabs, close/update drain | Save HTTP restart; concurrent-client revision tests; malformed/lost acknowledgements; unload-beacon and update-drain tests | Abrupt power loss and hardware filesystem faults are simulated, not physical |
| Direct work and interruption | Live journey corps: task lifecycle, stop, panel close, reload mid-run, rapid sends, task-board truth, command dispatch | Deterministic provider streams; external model behavior not certified |
| Providers and credential routing | Customer campaign: managed StarNet, OpenRouter, custom-compatible, Gemini and Codex; sample/direct/routine execution, real filesystem tools, second inference, restart/reuse | Strict local upstream simulators, not real account login, allowance or paid upstream calls |
| Delegation, groups and projects | HTTP/fast suites: session dispatch, worker access, group brief/attachments/handoff, delegated connector tools, project render/navigation regressions | Representative adapter combinations; not a full provider × entrypoint cross-product |
| Approvals and capability boundaries | Live approval prompt → blocked run → approve → resume; fast/HTTP capability, permission, E-STOP, access and revocation suites | Physical desktop interactions and elevated host operations not exercised manually |
| Schedules and unattended work | Cron tick, one-shot, DST, lock, durability, run-now, recovery and transcript suites; live capped-load/outage/restart probe | Short diagnostic soak only; not a 12-hour or 50-routine acceptance claim |
| Connectors and channels | HTTP OAuth/token persistence, expiry and refresh races, MCP session recovery, Telegram ingress/reply/restart and channel pairing | No real external-service outage or user-account round trip |
| Deliverables and history | Live deliverable OPEN; HTTP output recovery, transcript/session attribution, immutable group handoff and restart | Representative files; no blanket certification of every generated artifact type |
| Station, crew and build | Live behavior audit: floor containment/gaze, HUD/event truth, prop placement and approval; panel sweep; world/build fast regressions | Seeded browser station, not prolonged GPU/native-display acceptance |
| Settings, recipes, goals, updates | Sixteen live panel states, visible controls, no native-white paint or uncaught exceptions; focused state and persistence regressions in full gates | Panel opening is not proof of every destructive or external action |
| Distribution and upgrade | Source-side update-preparation, lifecycle, recovery, packaging and updater contract regressions | No exact-installer acceptance, signing/notarization, public update delivery or customer recovery claim |

The 16 panel states are floor, agents, recruit, commander, tasks, deliverables, recipes, automation, goals, build, connectors, messaging, manual, settings, updates and notifications. Evidence includes the state-driven results and visible-control counts, not screenshots inferred from code.

## Validation receipts

The final frozen fast gate passed **820/820 steps**, and the backend-equivalent HTTP campaign passed **120/120 suites**, both on Node 22.23.0. Live browser journeys passed **139/139 assertions** on the frozen source. The supporting behavior audit passed **49/49 assertions**, the panel sweep passed all **16 states**, and the customer-journey campaign passed **36/36 suites**. Save fault injection demonstrated unreadable-file and cache-restore recovery screens, retry after faults clear, retained pending writes, finite acknowledgement timeout and preserved stale-client revision. These are complementary receipts, not a sum of unique test cases.

See [validation.json](../evidence/reliability-audit-0919/validation.json) for source identities, scope and SHA-256 hashes, with retained fast, HTTP, journey, behavior and customer-campaign logs alongside it. Earlier baseline runs passed 818 fast steps and 119 HTTP suites; the final counts include new and independently integrated regression suites.

The initial load probe failed its accounting rule: 61 capacity deferrals and two fireable routines with no observed advancement. Its 13 direct runs had zero failures, but that did not make the scheduler healthy. The before receipt remains in [soak-before.json](../evidence/reliability-audit-0919/soak-before.json). The repeated five-minute, ten-routine probe with a concurrency cap of three, one restart and a 30-second provider outage passed unchanged rules: 24 owed occurrences were accounted for as 17 fires, five already-running occurrences and two collapsed misfires, with zero lost, doubled, unexpected or off-schedule occurrences. All four ordinary fireable routines advanced; all 13 direct runs succeeded. Health latency p95 was 18 ms; tick p95 was 185 ms. See [soak-after.json](../evidence/reliability-audit-0919/soak-after.json). This remains a short diagnostic, not sustained-load acceptance.

The first Node 24 HTTP attempt failed after nine successful update-preparation assertions with a native libuv assertion. A direct Node 24 replay repeated it; Node 22 replay passed. The canonical combined gates use Node 22.23.0, preserving this runtime difference as an open finding. A browser-recovery source-lock assertion also failed after the new specific error branch was added; the contract test now retains the existing network hint and explicitly checks the separate file-read diagnosis.

An intermediate fast run overlapped source/ledger commits and failed one claims-authority assertion. The repeated frozen run passed all 64 assertions in that suite. The final gate receipt distinguishes the repeated run from that invalidated intermediate attempt; no failing assertion was removed or weakened.

## Prioritized unresolved work

| Priority | Open item | Why it cannot safely close here; next proof needed |
| --- | --- | --- |
| P1 | [Affected Mac boot failure](../bugs/2f156837-mac-boot-guard-reports-shared-specialty-catalog.md) | Source hardening exists, but the original resource/engine failure and affected installed recovery remain uncorrelated. Capture exact installer/build, page origin, failed resource response and startup log on the affected Mac; repeat the boot/restart there. |
| P1 acceptance gap | Newly repaired persistence and scheduler behavior in packaged apps | Run the same fault/retry/restart scenarios against exact Windows and Mac installer identities. Source and headless-browser evidence cannot establish installed recovery. |
| P2 | [Node 24 Windows validation crash](../bugs/6e29727c-windows-node-24-http-test-exits-with-a-native-li.md) | Native assertion reproduced twice after passing test assertions. Reduce the shutdown case and distinguish runtime from test/application teardown before patching; retain Node 22 evidence separately. |
| P2 | [Mac credit usage](../bugs/abd75bb4-credit-usage-during-mac-boot-failure.md) and [unexplained idle usage](../bugs/acb47320-idle-usage-customer-unexplained.md) | Distinct account incidents require authoritative charge/run/routine correlation. No account access or refund operation was performed; a balance change alone does not establish an erroneous charge. |
| P2 | [Managed Sonnet historical HTTP 400](../bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) | Need a fresh sanitized request ID and gateway response on the affected path. Local adapter success does not explain a historical production response. |
| P2 | [Ollama request never observed](../bugs/5274c7b7-ollama-chat-request-not-observed.md) | Need affected Ollama/runtime versions, loopback capture and exact payload correlation. The local simulator matrix does not reproduce the reported transport failure. |
| P2 | [Uncorrelated visibility failure](../bugs/6bb9d2a1-visibility-failure-without-diagnostics.md) | Build, platform and original failing display state remain unknown. Obtain those before choosing a source change. |
| P2 | [Mac installer unsupported](../bugs/ff3fb4cb-mac-unsupported-installation-uncorrelated.md) | Need the downloaded artifact hash, CPU architecture and OS version; test the matching signed installer. |
| P2 acceptance gap | Extended load, sleep/wake and real integrations | The short mock-provider soak cannot establish multi-hour behavior, system sleep/resume, microphone/audio-device recovery, OS keychain lifecycle or live account integrations. Preserve those explicit release acceptance tasks. |

The fresh `qa:ready` check returned **NOT READY** with five reasons: the existing Mac P1 report remains open and this isolated branch lacks a current-trunk Guardian, Beginner and installed-smoke evidence set; its passing journey receipt is branch evidence, not an exact-trunk receipt. Trunk advanced concurrently to `8e182efaf` with a separate station-autosave repair and verification receipts after this audit incorporated `7f55d8809`. Integration must merge the newer trunk into this branch, refresh the source lock and repeat combined gates before merging back. This audit does not clear the readiness verdict or claim exhaustive product perfection.

Changes are committed in the isolated audit branch for review/integration. No installer was changed and no public release was made.
