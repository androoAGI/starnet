# StarNet neglected seams audit

Audit date: September 12–13, 2026. Source: `091d6e7f312e08ca9e813e94f7b8863d1a5d9e5a` (0.11.2 repository). Isolated branch: `agent/seam-audit-0912-b`.

The most urgent cleanup is consolidating lifecycle and state handling across entry points. Safer implementations already exist beside older copies. Nine actionable findings emerged: three reproduced through the running UI, and six reproduced using unchanged source functions with controlled dependencies. Those evidence classes are kept separate below. None is an installed-desktop reproduction or an affected-customer recovery claim.

The audit changed no product code. It created a separate seeded station, ran read/failure probes, and restarted that station. No paid model run, real channel message, production profile edit, merge, or release was performed. The model name `replay` was only a keyless placeholder here; the launcher correctly rejected it as an unavailable live model. These receipts do not claim a provider replay run occurred.

## Findings, ordered for repair

| ID | Priority | Problem | Evidence |
| --- | --- | --- | --- |
| A1 | P1 | Failed startup history read permanently skips away-work review recovery | Actual ReturnStore/Returns code, two simulated page boots |
| A2 | P1 | Agent-command loop Pause/Stop leaves an aborted iteration running and its lease held | Actual command function and loop driver, controlled provider settlement |
| A3 | P1 | Follow-up checkbox can save a routine that its scheduler refuses to run | Real UI save, live API read, sidecar restart, actual preflight |
| A4 | P1 | Routine creation pins the station provider instead of inheriting the selected agent's provider | Actual backend resolver; UI request path traced |
| A5 | P2 | Loop refresh destroys a rejection explanation while the user types | Running UI, controlled candidate fixture |
| A6 | P2 | Loop Pause/Resume silently ignores refused requests | Running UI, injected HTTP 409, request receipt |
| A7 | P2 | Outbox labels one run with another run's answer | Actual rendering block, two-run transcript fixture |
| A8 | P2 | Settings can flash “saved” after local persistence failed | Actual save function with storage failure; callers inspected |
| A9 | P2 | Shared refresh/retry cannot escape a hung predecessor request | Actual QuerySpine with unsettled transport |

Priority is an engineering triage judgment, not evidence that a customer encountered the failure. P1 means repair before expanding these workflows; P2 means schedule a focused reliability cleanup.

### A1 — Away-work recovery advances its cursor before proving the read

Source: [returnstore.js](../../frontend/app/returnstore.js) lines 28–38 and 78–90; [returns.js](../../frontend/app/returns.js) lines 60–80.

On entry, `init()` captures the old attendance timestamp, immediately persists a fresh heartbeat, and schedules one digest attempt. `composeRows()` converts a failed history read to an empty array. There is no retry for that original away interval. At the next launch, the old interval is already behind the persisted timestamp.

Reproduction: saved last-seen `1000`, completed run at `2000`, boot at `3000` with a failed read, boot at `4000` with a successful read containing the run. Both pending lists are empty. The run survives in history, but its Outbox/digest review opportunity is lost. This is visibility/recovery loss, not deletion of the underlying artifact.

Repair: keep an independent durable reconciliation cursor. Advance it only after a successful complete history read and durable fold. Preserve the failed interval across retries and restart. Test partial pagination failure as well as outright failure; XpStore's paginated reader is a relevant sibling.

### A2 — Asking an agent to pause a loop is weaker than clicking Pause

Source: [index.js](../../sidecar/index.js) `modelControlLoop` at line 7315 versus `handleLoopsControl` at line 7509; [loopjob-driver.js](../../sidecar/loopjob-driver.js) lines 399–406 and 537–548.

The HTTP control uses `loopDriver.abortLease()`, which aborts and settles the iteration at the host boundary. The agent-tool callback only aborts the controller after saving the paused/stopped state. A resolved provider promise then hits the driver's `signal.aborted` early return and never settles the old iteration or releases its lease.

Actual-code reproduction returned `{state:"paused", iteration:"running", leases:1}` after the provider settled. Calling the UI's shared cancellation seam recorded `cancelled` and released the lease. Resuming through the weaker path can remain blocked by that outstanding lease until another recovery path handles it.

Repair: one cancellation/control operation for HTTP, model tools, E-STOP and removal. Cover both promise resolve and reject after abort, pause→resume before late settlement, and persistence failure. `modelRemoveLoop()` also directly aborts its controller and warrants the same sibling review; its full removal lifecycle was not independently reproduced here.

### A3 — “Allow follow-up” can prevent the entire routine from running

Source: [routines.js](../../frontend/app/windows/routines.js) lines 106–107 and 639–654; [index.js](../../sidecar/index.js) lines 4824–4830 and 11904–11914.

The UI permits “Keep in StarNet” plus “Allow follow-up in that conversation.” It sends `attachToSession:true` but only captures `origin` when the destination is `origin`. Create validation accepts the local combination. The scheduler's actual preflight refuses it with `missing-session-origin`.

Live receipt: the verified checked checkbox saved and cleared the name/prompt fields. GET `/api/cron` returned `deliver:"local", attachToSession:true, origin:null`. The same job survived a real seeded-sidecar restart. Running its actual preflight returned `ok:false` with the missing-session error. Scheduling remained deliberately off; this audit did not spend a model call proving a condition already rejected before dispatch.

Repair: capture the intended conversation whenever follow-up is requested, or disable/explain an unsupported combination. Validate the same invariant at create/update and fire time. The confirmation should identify the conversation, including when the user changes sessions while editing.

### A4 — Routine provider selection can contradict its agent picker

Source: [routines.js](../../frontend/app/windows/routines.js) lines 467–474 and 622–643; [harness.js](../../frontend/app/harness.js) line 456; [index.js](../../sidecar/index.js) lines 2035–2038 and 2243–2250.

The form selects a roster agent, but gets `provider` from the global `Harness.getProv()`. That value becomes an explicit saved job override. The executor prefers `job.provider` over the selected agent's provider, while the model can still come from that agent. A Codex specialist can therefore inherit an OpenRouter job provider simply because that was the station selection when the routine was saved. Later agent provider changes also lose to this saved override.

Actual resolver probe: the same Codex agent resolves to `codex` without an override and to `openrouter` with the UI-shaped override. No live request using real multi-provider credentials was made, so the precise external failure depends on the model/provider pair.

Repair: inherit the selected agent's complete runtime configuration by default; only persist a provider override if the form explicitly offers and explains one. Include model, base URL, reasoning, credential identity and subsequent agent-setting edits in parity tests. Goal-loop creation at `loops.js:611` also sends the station provider and is a sibling to examine.

### A5 — A four-second poll erases loop review input

Source: [loops.js](../../frontend/app/windows/loops.js) lines 186–195, 303 and 630.

Every refresh replaces `#lp-list.innerHTML`, including the rejection textarea, disclosure state and buttons. In the unchanged running UI, a synthetic pending candidate's textarea held “Keep this rejection explanation while I think.” with `hidden:false`. After the next poll it held `""` and its container was hidden. No verdict was submitted. The refreshed nodes also caused two audit clicks to encounter detached controls.

Repair: preserve row identity and update only changed status/output fields. Key review drafts and in-flight actions by loop ID and iteration ID. Keep expanded diff/history state. Test typing for longer than one poll interval and delayed verdict responses.

### A6 — Loop control errors disappear

Source: [loops.js](../../frontend/app/windows/loops.js) lines 379–382. Compare [routines.js](../../frontend/app/windows/routines.js) lines 558–567.

Pause/Resume awaits `post()` but checks neither HTTP status nor JSON and swallows rejection. The comparable routine control reports that the operation failed. Loop delete and global unhalt also already check HTTP status, making the omission especially localized.

Live fault-injection receipt: the server returned HTTP 409, “Review in progress; retry when it finishes,” for the recorded Pause request. The UI kept “loops running,” retained Pause and displayed no notification. A plain network failure follows the same silent catch. This does not falsely display a paused badge; it fails to tell the user their stop request was refused.

Repair: check the response, keep the control pending until a verdict, report failure with a retry action, and confirm the resulting state. Test 409, 500, offline and interrupted-body responses across all automation controls.

### A7 — Outbox joins files by run but text by the entire session

Source: [outbox.js](../../frontend/app/windows/outbox.js) lines 61–76 and 117–136; [index.js](../../sidecar/index.js) line 20318.

Files are joined by `runId`. Text is fetched by `streamId`, then the renderer chooses the first user message and last assistant message from the last 50 turns, without filtering to the crate's run. The rating callback still targets the crate's original run.

Executing the unchanged text-rendering block with run A followed by run B in one stream displayed A's request with B's answer on A's crate. Single-run cron streams avoid this case; reused conversation streams and multi-run line streams need explicit attribution. This was a controlled source reproduction, not an observed production transcript mix-up.

Repair: resolve a bounded run transcript or a run-owned output summary. Use `sourceRunId` where present and an explicit unavailable/legacy fallback where attribution cannot be proven. Keep session history labeled as session history in Agent Record; do not imply it is a run-specific transcript. Add a two-run same-session test, including a later follow-up and more than 50 turns.

### A8 — “Saved” feedback does not depend on successful settings persistence

Source: [stationui.js](../../frontend/app/stationui.js) lines 180, 5515 and 6319–6329.

The local settings `save()` swallows every `localStorage.setItem` error. Appearance and notification handlers then call `flashSaved()` unconditionally. A quota/storage denial can therefore apply a preference in memory, say it was saved, and revert on reload.

The unchanged save function swallowed an injected storage exception. The unconditional confirmation is source-verified; an actual full-disk or browser-quota UI scenario was not run. This finding concerns these local preferences, not provider credentials or all station persistence.

Repair: return an explicit persistence result. Distinguish “applied for this session” from durable save, retain an unsaved marker, and retry safely. A single shared save-result contract should cover appearance and notifications.

### A9 — Shared read deduplication can make Retry ineffective

Source: [queryspine.js](../../frontend/app/queryspine.js) lines 91–94 and 131–136; [harness.js](../../frontend/app/harness.js) line 1119.

Refresh joins the current request. After invalidation, it waits for the previous generation's promise before sending another request. The underlying JSON GET has no application deadline. If headers/body never finish, every refresh remains behind that predecessor, including reads shared by routine/Journey consumers.

Actual-code probe: start an unsettled GET, invalidate, then refresh. Wire call count remains one and pending remains true. Recovery waits for the browser/transport to settle or page reload; there is no application-controlled escape.

Repair: add a bounded whole-response deadline for ordinary JSON reads, plus explicit request-generation retirement. Keep the existing last-good/error metadata. Do not reuse this deadline for model SSE streams, where fixed wall-clock timeouts are a documented past regression. Test headers received but body stalled, invalidation while pending, and recovery after timeout.

## Cross-screen differences that deserve one contract

| User concept | Current differences | Desired consistency |
| --- | --- | --- |
| Pause | Routines: “DISABLE”/enable with errors. Goal loops: “PAUSE”/resume without errors. Agent loop command uses weaker cancellation than the HTTP button. | Same action semantics, pending state and explicit failure. Separate pause from destructive stop. |
| Schedule | Navigation says “Scheduled jobs”/“New schedule”; prose and errors say “Active Routines”/“Create Routine”; success says “routine.” | Choose a primary name and preserve it in navigation, help and errors. |
| Agent settings | Routine picker chooses agent; provider comes from station; model can come from agent. | Show and execute one resolved agent configuration. |
| Conversation delivery | “Keep in StarNet” still exposes follow-up “in that conversation”; no conversation identity is shown. | Bind and display the destination; reject impossible combinations before save. |
| Script-only work | Backend accepts script without prompt; routine form requires a prompt regardless of “without a model.” | Script-only form validation should match execution requirements. |
| Finished work | Outbox, Library, Deliverables and Agent Record overlap; files are run-owned, expanded history is session-owned. | Explicitly label output vs conversation history; keep all actions anchored to the same run. |
| Failed reads | QuerySpine retains last-good/error state; Library names a failed load; Outbox silently omits files when its Library join fails. | Distinguish missing data, stale data and unavailable data, with retry. |
| Drafts | COMMS preserves drafts across session switches; goal-loop review polling discards them. | Preserve user text across polling, navigation and retry unless explicitly discarded. |

The script-only and terminology rows are source-traced parity gaps, not additional independently reproduced defects.

## Optimization priorities

1. **Stop rebuilding loop review DOM every four seconds.** This directly fixes A5 and removes repeated HTML parsing/layout and control churn. Keep polling for fallback recovery, but render only changed rows. The poll checks `body.isConnected`, so switching to a different automation tab does not make it stop.
2. **Bound Outbox work before optimizing the canvas.** `Returns.PENDING_CAP` is now 10,000 (`returns.js:27`), but `buildOutbox()` still renders all rows and starts a transcript request per row before expansion. Its comment still says “pending is capped at 24.” With N pending rows that have stream IDs, opening the panel can issue N transcript requests, plus the Library join. Use pagination/windowing, bounded fetch concurrency and lazy transcript loading. This is a source-derived scaling risk; no 10,000-row browser benchmark or FPS claim was made.
3. **Deduplicate transcript reads and query ownership.** Multiple Outbox rows in one stream repeat the same GET. Reuse a bounded read keyed by the correct output identity, then retire it on close/restart. A9 must be fixed before widening shared caching.
4. **Extract shared operations after pinning behavior.** Highest-return extractions are loop control, resolved run configuration, JSON request lifecycle and save receipts. Avoid a broad hotfile rewrite: `index.js` and `stationui.js` have many unrelated owners and integrations.
5. **Test transitions rather than just source shapes.** `test/outbox-window.test.js` explicitly asserts the first-user/last-assistant rendering pattern, which cannot establish run attribution. Add behavioral cases for delayed responses, repeated clicks, restart after failed reads, failed persistence, same-session multiple runs and cross-provider agent selection.

Additional investigation candidates: `windows/messaging.js:429–438` parses HTTP error JSON without checking status, so old card state may survive a 500; `windows/loops.js:314` replaces the list on read failure but leaves the old gate banner untouched. Both deserve live stale-status tests before being filed as separate confirmed findings.

## Evidence and scope

- [Executable source probes](probe.cjs) and [structured results](probe-results.json).
- [UI observations](ui-observations.json), [controlled proxy](fault-proxy.cjs), and [recorded rejected request](proxy-results.json).
- [Fast gate log](fast-gate.log). Gate result is recorded in the final validation note below.
- Source areas examined: routine CRUD/manual fire/scheduled preflight, loop HTTP/tool controls and driver settlement, Outbox/Library/Agent Record, ReturnStore history recovery, QuerySpine, local appearance/notification persistence, COMMS session draft behavior, channel status rendering, and nearby backup/read paths.
- Ordinary COMMS draft switching was tested and **did preserve the draft**. Existing guarded routine pause/delete, Library response-generation checks and durable routine-store error UI were identified; they are useful sibling implementations, not missing features.
- `qa/BUGS.md` and the known-issue index were consulted. Nine open records were added to this isolated branch's durable bug register and its index regenerated. [Bug ID mapping](bug-map.json) links A1–A9 to those files. They are classified as audit findings, not customer reports. The integration tree and shared readiness ledger were not updated.
- During the audit trunk advanced to `fa85f521f` for website navigation styling. A focused diff showed all product files underpinning these findings unchanged from `091d6e7f3`.
- Not covered: installed Tauri/WebView2 lifecycle, paid live provider behavior, real channel delivery, OAuth/keychain disruption, full disk exhaustion, an extended performance soak, and exhaustive screen/control coverage. These are explicit coverage gaps, not passing checks.

## Validation

Source probes passed, including re-reading the same saved routine after a real seeded-sidecar restart. Three UI reproductions and one negative control are recorded above. `npm run test:fast` exited 0: **772 steps green** on the unchanged audited product source. The updated bug register separately validated **143 records, no violations**. Audit scripts passed syntax checks. The full HTTP gate was not run because no product routes were changed. No product fixes have been implemented or merged.

Temporary audit tabs and the owned seeded sidecar were closed after verification. The local proxy encountered a headers-already-sent error when its upstream restarted after the UI receipts; its error handler was corrected to support that teardown case. This was an audit-fixture issue, not a StarNet finding, and did not affect the recorded pre-restart UI reproductions.

To rerun the receipts: use an isolated worktree at the audited source, install locked dependencies, launch `dev/seed.js --keep` with `SKYNET_PORT=19427`, an empty provider key and a placeholder model. In the UI create a routine named `Audit follow-up enabled`, leave its destination local, and verify the follow-up checkbox is checked before saving. Run `node qa/seam-audit-0912/probe.cjs`. The remaining source cases need no model. For the loop UI cases, run `node qa/seam-audit-0912/fault-proxy.cjs` and open port 19428; it serves the unchanged application with a controlled candidate and refuses loop-control requests with HTTP 409. The synthetic candidate must never be confused with real model-produced work.
