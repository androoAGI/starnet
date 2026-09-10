# 0.11.1 audit and proposed 0.11.2 scope

Audit date: 2026-09-10 UTC / September 9 New York. Owner requested a deep audit after the expedited release. This is an audit and release plan, not a repair or release authorization.

## Decision

Make 0.11.2 a focused reliability patch. Three reproduced P1 defects should lead it: stale catalog replies can overwrite a newer provider choice, managed image charges are absent from local run cost receipts, and image generation can write after cancellation. Two reproduced P2 regressions can fit the same patch: glass panel height is not remembered and BYOK media recovery omits the supported OpenRouter option.

0.11.1's signed artifacts and manual upgrades have acceptance evidence. That does not establish that every paid customer recovered. The release carried seven open customer P1 reports, an explicit readiness/soak exception, and hardware/account verification gaps. Retain those distinctions for 0.11.2.

## Frozen scope and method

Compared `v0.11.0` (`58dc520de6db835c0cf917908ee9e6a5501cba81`) with released `v0.11.1` (`b3760c46ff3fe02790e6c3b0c50a23c30b5837a8`). The integration head observed during the audit was `83c896e7d2c5b88d99147e75fbeedde6fb93c27b`, which adds publication receipts. Work is isolated on `agent/audit-0112-0910`.

The release changes 333 files: 60 frontend runtime files, 7 backend runtime files, 37 visual assets, 64 test files/manifests, 97 generated website-mirror files, 41 QA/documentation files, 10 website documentation files, 4 audit tools, 3 desktop version-pin files, and 10 remaining root/release files. See [the complete file inventory](../qa/evidence/0.11.2-audit/change-inventory.json). It is substantially broader than a connection hotfix.

Reviewed release exceptions, final acceptance receipts, the complete changed-file inventory, changed backend paths, frontend changes by feature family, new tests and their registration, the customer bug register, and current Guardian/readiness evidence. Ran the full fast gate, customer campaign, an additional managed-endpoint regression, website parity, two live UI sweeps and controlled browser/sidecar probes. No production credentials, paid requests or customer profiles were used. No runtime code was changed.

This is not exhaustive hardware, security or production-provider certification. The tables below identify what is reproduced, what is only source-reviewed, and what remains unverified.

## Reproduced defects

| Priority | Record | Observed behavior | Release relationship |
| --- | --- | --- | --- |
| P1 | [1600dcf0](../qa/bugs/1600dcf0-late-model-catalog-reverts-new-provider-choice.md) | Hold an Ollama catalog reply; select StarNet / anthropic/test-model; release the reply. State becomes Ollama / empty model. | Existing race survives 0.11.1. Same capture/reconcile sequence is present in 0.11.0. |
| P1 | [79867817](../qa/bugs/79867817-managed-image-charge-missing-from-run-cost.md) | Simulated managed wallet loses $0.025 for an image, while both cost events and completed run report $0.00. Repeated after restart. | Newly enabled managed-image path exposes an existing auxiliary-cost accounting omission. |
| P1 | [a0dffdd7](../qa/bugs/a0dffdd7-image-generation-writes-after-run-cancellation.md) | Cancel while image response is held; after cancellation is acknowledged, release it. Run ends cancelled but the output file is created. | Inherited image-tool cancellation limitation also affects new managed route. |
| P2 | [12203375](../qa/bugs/12203375-glass-panel-height-resets-on-reopen.md) | Settings panel height: 420px initially, 512px after two keyboard resize actions, 420px after close/reopen. | New glass control retains height only on the current DOM node. |
| P2 | [3a2837bd](../qa/bugs/3a2837bd-byok-image-recovery-only-offers-paid-link.md) | An unlinked BYOK image task is told only to link a StarNet account, although a separate OpenRouter key is supported. | Error-message regression in the media-route repair. |

### Provider selection

`fetchModels` captures the active provider before asynchronous catalog work. `reconcileCurrentModel` then compares that old provider's catalog with the *current* model and writes the old provider back. The reproduction uses the shipped browser code and controlled delayed responses; provider changes use the real Harness setters. It does not prove the exact sequence on any customer's machine or demonstrate an actual paid misroute.

Fence application by selection generation and agent/session identity. Cache completion and selection mutation must be separate. Test provider A to B, A to B to A, a different model on the same provider, agent switches, relink, empty catalogs and errors. After choosing a model through the visible UI, reload/restart and confirm the intended pair survives.

### Media accounting and cancellation

The image regression proves correct simulated gateway debit, not a gateway overcharge. The defect is local attribution: `image_generate` discards response usage and returns only content/summary, while the run total accounts for conversation inference. Include actual media charges in local receipts without making a second debit. Audit configured budget enforcement and media retry costs as related follow-ups; this audit has not proven a cap overrun.

The cancellation probe releases the provider *after* the cancel endpoint acknowledges the run ID. File publication still occurs. Propagate the parent cancellation signal through generation/download/resize and check before publishing a file or deliverable. Account honestly for upstream work that may already have been billed. The evidence does not assert that the write happened after the terminal event or that an upstream service can always reverse a charge.

### UI recovery and persistence

Use the existing window preference store for docked panel height, retaining separate normal/maximized state and clamping after DPI changes. For media recovery, distinguish a broken managed link from a BYOK station missing a media credential. The supported OpenRouter option should remain visible to BYOK users. These are bounded fixes, not reasons to redesign the menus again.

## What the hurried release left unresolved

| Concern | Evidence/status | Required 0.11.2 follow-through |
| --- | --- | --- |
| Historical managed Sonnet HTTP 400 | [fd9c4b4d](../qa/bugs/fd9c4b4d-managed-sonnet-400-unresolved.md) remains open. Production gateway tracing was deployed on September 6 and isolated production-host requests succeeded, but the affected request remains uncorrelated. | Exercise the exact installed build and a funded test account with a currently advertised model; correlate local run ID, gateway request ID and upstream response. Do not call it fixed from neighboring routing tests. |
| Incorrect authoritative managed URL | 0.11.1 fixes stale *per-request* overrides. [3195ab5a](../qa/bugs/3195ab5a-managed-chat-can-use-a-stale-request-endpoint.md) excludes a bad saved link URL, operator override or DNS redirection. | Verify sanitized actual destination and credential source after relink/provider switch/restart. Distinguish local Ollama refusal from managed-service failure in recovery text. |
| Funded account shows zero-credit warning | [72af29f4](../qa/bugs/72af29f4-funded-station-false-zero-warning.md), still open. | Verify cached/stale/offline balance, auth state, relink, restart and UI readback against the actual account. |
| Mac paid onboarding after relink | [eaaa3ec8](../qa/bugs/eaaa3ec8-mac-onboarding-unreachable-after-link.md), still open. | Real Mac installed link/reload/restart path with protected credential persistence. Linux/Windows fixtures cannot close it. |
| Blank viewport after 10–20 minutes | [9256a771](../qa/bugs/9256a771-viewport-black-after-idle.md), still open; rendering changed substantially. | Run a sustained installed renderer test at relevant display scale with active/idle transitions, minimize/restore, sleep/wake and context loss; collect GPU/frame/memory diagnostics before reload. |
| Unexplained idle usage | [acb47320](../qa/bugs/acb47320-idle-usage-customer-unexplained.md), no established customer-specific billing cause. | Attribute actual model/media/background calls to run receipts; compare idle with routines, loops, discovery and night shift individually enabled. Do not infer zero spend from an idle animation. |
| ONCE routine missing | [c2a6c3c8](../qa/bugs/c2a6c3c8-once-routine-reported-missing.md), still open despite successful related readback/restart tests. | Visible create, schedule, execution, history and restart verification on the candidate; retain lost-ack and duplicate recovery cases. |
| Trusted Project / equipment discrepancy | [432df352](../qa/bugs/432df352-saved-equipment-omitted-from-interactive-tool-pr.md): omitted placement is reproduced/fixed; the original persisted Trusted Project symptom is not. | Verify installed saved profile and actual tool list; distinguish absent, empty, removed and disabled equipment, assigned empty rooms, and explicit agent identity. |
| Voice hardware/acoustics | [voice receipt](../qa/digests/2026-09-09-voice-continuity.md) proves controlled failures and real local Kokoro playback; not physical noise/echo or provider realtime audio. | Check installed microphone allow/deny/reset and echo/noise/barge-in on actual hardware, including Apple Silicon. Record which voice mode was tested. |
| Automatic updater path | Publication receipt proves signed downloads, hashes, manual 0.10.13/0.11.0 upgrades and read-only updater smoke. | Drive an older installed client through actual Tauri download/install/relaunch, then verify version, station state, keychain and a run. A manually installed binary is not that canary. |
| Extended soak | Explicitly waived for 0.11.1. Short source/UI runs cannot replace it. | Run the established release-soak requirement on the frozen candidate with restart/outage/scale coverage; any new exception must remain explicit. |

## Current QA authority needs reconciliation

A read-only `node scripts/qa/ready.mjs --json` on integration at 01:30:57 UTC returned **NOT READY**, with six reasons: four blocking detector findings, seven customer P1 records, RED Guardian, journey source mismatch, Beginner source mismatch, and installed-smoke mismatch. This was before adding the five new audit records on this branch.

The latest Guardian cycle (01:17:12 UTC, exact release SHA) passed fast, HTTP, saboteur, screenshot, audit and journeys. Golden comparison alone exited 3: all 16 surfaces opened, 12 frames differed beyond threshold, and 4 were accepted through earlier dismissed/known findings. The changed default glass/world appearance plausibly contributes, but this is not sufficient evidence to bless all frames. Review differences against the approved appearance, especially whether the four dismissed signatures still meaningfully identify animation noise. No baselines were changed here.

The four existing blocking detector records are a historical fast-gate timeout (P0), two panel-close cancellation checks (P1), and an Abilities opening/layout timeout (P1). The P0 label describes an unavailable detector, not a proven catastrophic product defect. Later passes are evidence for a focused recheck/reconciliation; they do not justify deleting the records without linking the corresponding scenario. The two cancellation findings deserve particular scrutiny alongside the newly reproduced media cancellation issue, without assuming the same cause.

The journey mismatch is between the release SHA and the later publication-documentation commit. Distinguish that receipt bookkeeping from a runtime regression. Refresh the authoritative candidate-bound receipts correctly; do not copy timestamps or mark missing proof green. The recorded installed smoke still names 0.11.0, even though separate 0.11.1 release acceptance exists. Consolidate those receipts without pretending the automatic update was exercised.

## Coverage of the rest of the update

| Changed family | Audit coverage | Remaining practical limit |
| --- | --- | --- |
| Managed resolver, media route, Doctor reasoning | Backend diff review; focused managed-endpoint tests; media probes; fast/customer campaign | No new real paid provider/account test in this audit |
| Saved equipment and permission disclosures | Diff review; ten real local sidecar/file-write projection runs in the campaign; consent regressions in fast gate | Controlled model responses and profiles; original customer configuration unconfirmed |
| Sessions, background focus, legacy ratings | Changed paths reviewed; session-focus and legacy-rating regressions passed | Catalog-selection race above crosses a different asynchronous seam |
| Voice buffering/retry/interrupt diagnostics | Diff review; changed voice regressions passed; prior real Kokoro receipt inspected | No new acoustic/realtime-provider acceptance |
| Glass windows, model picker, menus, forms, recruitment and recipes | Both live sweeps passed; resized-height probe found a gap; curated archived-ID compatibility reviewed | Long use, touch/assistive technology and physical display matrices not exhaustively tested |
| Automation/global-stop removal | Recovery code and regression coverage reviewed; hydrate/readback/partial-failure checks passed | Removal was explicitly owner-directed; do not reintroduce global stop as an audit fix. Verify individual controls, including image cancellation. |
| World lighting, wall/floor materials, character/prop rendering and worker previews | Runtime/limits/diff review; registered rendering tests; live worker/geometry/performance sweep; one current Settings frame visually inspected | No exhaustive golden approval, long GPU soak or customer-hardware certification |
| Website mirror, shell/version and release plumbing | Mirror parity passed for 3,963 files plus two embed transforms; shell diff is only version pins; release signing/upgrade receipts inspected | Production web deployment and automatic Tauri installation not newly exercised |

## Proposed 0.11.2 sequence

1. Freeze feature scope to these reliability repairs. Assign provider-selection and media-accounting/cancellation ownership explicitly; coordinate both media findings in one lane because they share tool execution and settlement. Keep UI persistence/recovery wording bounded.
2. Convert the four audit harnesses into maintained regressions in the appropriate fast/HTTP gates while fixing each defect. They currently record failing behavior; they are not passing-product assertions or registered release gates.
3. Run linked-account text and image tasks, provider switches and cancellation on the actual candidate installer. Verify local receipts against real gateway receipts without double-debiting. Exercise reload/restart and the older-client automatic update canary.
4. Review the 12 changed golden frames and four accepted signatures. Reproduce/reconcile detector findings; refresh Beginner/journey/installed receipts and complete the required soak/hardware checks or explicitly document remaining constraints.
5. Run fast, HTTP, customer journeys and `qa:ready` on the frozen candidate. Preserve open customer reports until their stated proof exists. A new expedited release must not inherit 0.11.1's exception implicitly.

## Evidence and limits

Fresh audit results on unchanged released runtime: **fast 752/752**, **customer campaign 34/34**, **managed-endpoint 2/2**, glass sweep PASS, menu sweep PASS, website parity PASS. The two browser probes produced zero uncaught page errors while reproducing their incorrect behavior. Image probes use the actual sidecar and real temporary files with simulated upstream responses/billing. [Hashed local log receipts](../qa/evidence/0.11.2-audit/verification-receipts.json) and [raw probe outcomes](../qa/evidence/0.11.2-audit/findings.json) are retained.

The full HTTP suite was not redundantly rerun here: the independent fresh Guardian on the same immutable release SHA and the final release receipt both record 108/108 passing; this audit reran the focused campaign and additional endpoint/media scenarios. The full fast pass predates audit-only documentation/record additions. Those additions receive syntax/register/index validation separately.

See [reproduction instructions](../scripts/qa/audit-0112/README.md). No production fixes, merge, push, version bump, customer communication, refund, credential change or deployment was performed. No open report was marked recovered. This plan does not claim 0.11.2 is ready to release.


## Cleanup follow-through — 2026-09-10

The owner subsequently authorized reliability cleanup in `agent/cleanup-0112-0910`.
Source commits: provider selection `59b5f2462`, panel persistence `871561348`, media
accounting/cancellation/recovery `d503f00c5`. The five audit records now distinguish
verified source repairs from installer/account recovery. The original audit above is
retained as historical before-fix evidence.

Maintained regressions extend the existing fast/HTTP gates; `test/loop.media-cost.test.js`
is newly registered. `scripts/qa/cleanup-0112-live.cjs` asserts the actual browser resize,
reopen, reload, maximize/restore, smaller-viewport and delayed-catalog behavior. Image
verification uses the actual sidecar, real temporary files and the actual local cloud
gateway implementation with synthetic upstream responses and credentials. No paid
customer request was made. The simulated gateway now faithfully returns post-margin
usage.cost, matching its actual $0.025 debit; the original audit simulator returned an
upstream $0.02 response while debiting $0.025. Both proved missing local attribution,
but only the corrected fixture can prove exact equality with the managed receipt.

Remaining release acceptance is explicit: seven historical customer P1 reports,
affected-account Sonnet correlation, real Mac relink/onboarding and microphone behavior,
long installed renderer soak, and actual older-client automatic download/install/relaunch.
A fresh worktree has no detector history; its empty local finding directory does not
supersede integration's four blocking detector records. Integration's read-only readiness
check still reports NOT READY: four detector findings, seven customer P1 records, RED
Guardian, stale Beginner source and installed-smoke source mismatch. Journey evidence
has since refreshed on integration, so the original audit's journey mismatch is no longer
a current integration failure. No finding or visual baseline was dismissed to clear gates.

The extended release soak is 720 minutes in the current script, plus the separately
required installed/hardware acceptance. A shorter cleanup smoke cannot replace it, and
0.11.1's exception does not authorize another release or another skipped soak.

Final source verification is complete; exact sources, results and remaining release acceptance are recorded below.


Additional cleanup findings: `a03ea726` exposed unsanitized swallowed-error console output
using an intentionally synthetic test key; the unchanged secret scanner caught it at fast
step 181/753. The warning path now uses the existing scrubber, and the captured before-fix
log was sanitized without removing its failed-gate result. `8993bb79` reproduced a complete
black-to-white image replacement being excused solely by a panel-name dismissal. Historical
name dismissals now remain review context, not pixel approval; no baseline was blessed.
The four formerly excused glass frames therefore require current review alongside the other
12. Settings, Abilities and Recruitment screenshots were inspected: they visibly use the
new docked glass geometry, supporting structural change rather than a claim of noise.
This does not certify all 16 frames or the affected customer hardware.

The model repair also fences overlap with a secondary per-agent picker: a superseded dock
request cannot reconcile from an older cached catalog. The regression explicitly overlaps
both pending requests after a new model choice.


The exploratory 20-minute soak overlapped the later logging/catalog/QA edits. Its result
is retained as exploratory evidence only; it cannot certify one immutable cleanup
candidate. Final verification restarts from the frozen candidate after those repairs.


Final verification also exposed two QA defects, now source-fixed in `5262e4a29`: a host-timed hydration fixture (`4bc5d562`) and an aggregate HTTP deadline shorter than the observed complete run (`0c148510`). All 108 unchanged HTTP tests passed in the longer diagnostic run, just over 15 minutes. The HTTP watchdog is now 20 minutes; Guardian gives that child 21 minutes while honoring an explicit operator override. No tests, assertions, individual product timeouts, or release acceptance requirements were removed. The image staging cleanup ratchet failure was repaired in `f9750306d`; unexpected cleanup errors are now observable, and image tests pass 100 assertions.

The cleanup branch was synchronized with trunk `2aa8305c0`, including the doorway movement repair. The product candidate `ed0788584` passed all 753 fast steps and the refreshed live frontend check. Its default 15-minute HTTP attempt timed out; that result remains a failure, separate from diagnostic 108/108 coverage. Final normal gates are restarted after the QA deadline/clock repairs.


The outer-deadline audit also found Closer and Phase 2 callers. They now share the same HTTP-specific policy with Guardian via `npmGateTimeoutMs` in `scripts/lib/run-command.mjs`. Existing lock-heartbeat coercion and explicit operator overrides are retained. A verification attempt was intentionally interrupted to complete this caller alignment; it is not a passing gate.


## Final cleanup verification — 2026-09-10

**Source cleanup verified on `c2193f1fbc07f827db07814487769adaeb6467b3`.** The branch is
`agent/cleanup-0112-0910`, synchronized with trunk `2aa8305c0`. No merge to trunk,
version bump, publication, customer message, credential change or refund was performed.
The integration checkout's existing QA/Rooms edits remain untouched.

Nine source findings are repaired: the five original audit defects, secret-bearing
failure logs, unsafe visual-dismissal reuse, host-sensitive hydration regression timing,
and the undersized aggregate HTTP watchdog. Unexpected image staging cleanup errors
found by the fast ratchet are also observable now. The HTTP child budget is 20 minutes;
Guardian, Closer and Phase 2 give it 21 minutes through one shared policy. Explicit
operator overrides, individual test/product timeouts and the full test lists remain intact.

| Verification | Result and exact scope |
| --- | --- |
| Normal fast gate | **753/753 PASS** on `c2193f1fb`; no excluded steps |
| Normal HTTP gate | **108/108 PASS** on `c2193f1fb`, using the corrected aggregate budget |
| Live panel/catalog probe | PASS, zero page errors on frontend `ed0788584`; panel height 420 → 512 → 512 after reopen and reload, maximize/restore and small viewport, selected provider/model preserved |
| Managed image/cloud integration | PASS on `ed0788584` through actual local cloud gateway code with synthetic upstream/credentials; billing, persistence, cancellation and honest failures checked; no paid customer request |
| Browser journeys | **139/139 PASS** on `e8541fcbd`; Stop/reload and truthful backend idle/stream settlement covered |
| Beginner onboarding | Six UI-only steps PASS on `e8541fcbd`, ending at the real-model boundary; not paid-account first-value proof |
| Source soak | **20.01 minutes PASS** on `e8541fcbd`: 54 successful runs, zero failures, 19 routine fires, four restarts and a 90-second outage |
| Visual capture/review | All 16 expected states opened and all screenshots inspected on `e8541fcbd`; detector remains CHANGED, zero automatic excuses, baseline untouched |

The application runtime is unchanged between `ed0788584` and the final tested candidate;
subsequent changes repair QA timing and record evidence. The soak and visual captures
predate the final staging diagnostic/doorway synchronization and remain labeled with their
actual sources. They are not claimed as exact-final-installer acceptance.

Earlier failed attempts remain retained: the secret scanner caught the warning leak;
the fast gate caught the hydration timer and silent staging cleanup; two 15-minute HTTP
attempts timed out. A longer diagnostic run passed all 108 unchanged tests in just over
15 minutes, motivating the bounded timeout repair. A later verification was deliberately
interrupted to finish all outer callers. None of those attempts is relabeled green.

[Hashed verification receipts](../qa/evidence/0.11.2-cleanup/verification-receipts.json),
[live probe](../qa/evidence/0.11.2-cleanup/live-probe.json),
[soak receipt](../qa/evidence/0.11.2-cleanup/soak-receipt.json),
[visual review scope](../qa/evidence/0.11.2-cleanup/visual-review.json), and
[integration readiness snapshot](../qa/evidence/0.11.2-cleanup/integration-readiness.json)
are retained. Full logs remain under this worktree's `.dogfood` directory.

**Release acceptance remains open.** The latest integration snapshot (`2aa8305c0`) has
four blocking detector findings (one P0, three P1), seven historical customer P1 bugs,
RED Guardian, stale Beginner evidence and an installed-source mismatch. This lane's
empty local detector directory never supersedes those records. Required follow-through:
reconcile current Guardian/visual evidence, test the exact installer and automatic update
from an older client, complete the required 720-minute release/installed soak, and obtain
real affected-account and Mac/microphone acceptance. Brewtal's routing fix `177a9384e`
is still included; the separate affected-account Sonnet recovery is not confirmed.
