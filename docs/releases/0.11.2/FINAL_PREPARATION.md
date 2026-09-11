# 0.11.2 final preparation — September 11, 2026 UTC

> **Superseding owner decision, September 11:** the typical 12-hour source and 48-hour installed soak durations are waived for 0.11.2. The source runner has been stopped; no soak completion is awaited. Historical run descriptions below remain evidence, not current requirements. See [SOAK_WAIVER.md](SOAK_WAIVER.md) for the decision and focused update verification.

Integrated candidate: **`7f6c7b005120381539ad9c4b4601cb42b6b9b27d`**. The application code matches `61528ba95`; the additional change repairs release-preflight evidence reporting and updates the handoff. Official version pins remain **0.11.1**. The locally installed **0.11.2 canary** has a separate application identity and profile; no public release or tag was created.

The inventory now covers **60 reachable merge commits and 5,023 changed paths since v0.11.1**, through application candidate `61528ba95`. Synchronization merges overlap; this is not a count of independent features. The subsequent preflight/documents change is listed separately in the source-equivalence receipt.

## Additional repair

Preflight had reported **soak PASS** immediately after a short installed smoke. A live invocation reproduced that false implication. Repair `b9c553955` gives smoke its own row and leaves 48-hour installed acceptance explicitly owed for manual evidence review. It also rejects misleading `NOT_GREEN` status values and invalid/future timestamps. The regression failed before the repair; preflight **104 assertions** and release ritual **64 assertions** pass afterward. The runbook now describes the two kinds of evidence separately. [Bug record](../../../qa/bugs/0ea3abca-release-preflight-mistakes-installed-smoke-for-c.md).

## Verified in this pass

| Check | Result and exact scope |
| --- | --- |
| Pre-merge gate | **771/771 PASS** with the repaired release tooling and bug metadata; subsequent changes were documentation only. |
| Post-merge Guardian | **All seven gates GREEN**, finished 03:33:21 UTC on `7f6c7b005`: fast **771/771**, HTTP **111/111**, adversarial API sweep, UI capture, unchanged visual thresholds, behavioral audit **47/47** and full journeys **139/139**. |
| Fresh onboarding | **6/6 UI steps PASS** on the merged candidate, 101.344 seconds. This stops at the real-model boundary. |
| Installed identity | Exact clean candidate `7f6c7b005`, native/sidecar identity and installed executable hash verified; smoke GREEN. |
| Served frontend | **31 changed JavaScript/CSS files** fetched from the installed WebView match the candidate byte-for-byte. HTML shell injection and binary assets are outside this comparison. |
| State preservation | **9/9 checks across installation and 9/9 across ordinary quit/relaunch**: crew, props, configured-key status, conversation history, project root, last successful run, run IDs, project file and completed ONCE routine. No key was exported. |
| Conversation recovery | The originally reproduced duplicate conversation remains **four canonical rows** after reopen, persist, reload and reopen on the final installed candidate. |
| Refit at 4K | Forest, Moon and City passed real middle-button dragging at Refit's **20% minimum zoom**, with nonblank pixels, healthy workers, no runtime exceptions and unchanged station props. Emulated viewport, not a physical 4K display claim. |
| Installed idle/recovery | **20 minutes / 80 samples** on application source `61528ba95`, Forest at a 3840×2160 emulated viewport. No sampled blank viewport, renderer error or usage increase. Deliberate cached-canvas, WebGL and stage faults recovered. The final candidate's committed application/native build inputs are unchanged. This does not establish recovery on the affected customer's GPU or a 48-hour soak. |
| Platforms | [Workflow 34555729560](https://github.com/androoAGI/starnet/actions/runs/34555729560) passed Windows, Linux, Apple Silicon and Intel builds, both Mac notarizations and Intel installed acceptance on `61528ba95`. Publishing was disabled. The later change has no application/native build-input delta; no physical Apple Silicon paid-account or microphone test is inferred. CI artifacts retain the official 0.11.1 pins. |

The first idle probe started before the preceding Refit reload had initialized `StationUI`. That failed probe is retained; the corrected driver waits for app readiness and ran a fresh, full twenty-minute window. No idle duration or check was waived.

## Remaining release acceptance

The latest canonical readiness verdict is **NOT READY — one failing category: seven open customer P1 reports**. Ledger, current Guardian, journeys, fresh Beginner and exact installed smoke all pass. The receipt is recorded in [the evidence pack](../../../qa/evidence/0.11.2-finalprep-0911/manifest.json), with [specific retest requirements](CUSTOMER_RETESTS.md). Passing neighboring tests is not a substitute for the affected account, station or hardware evidence.

The previous 12-hour source soak stopped at **260.8 minutes**, without a final receipt; its termination cause is unknown. Its partial logs remain retained. The replacement started at **02:51 UTC** on a separate frozen checkout of `61528ba95` and passed its observed restart cycles. Its earliest expected finish is **14:51 UTC / 10:51 a.m. EDT**, assuming uninterrupted execution. This is progress, not a completed soak verdict. Keep both the frozen soak checkout and its owning preparation/dependency worktrees intact.

The separate installed/attended acceptance, physical Apple Silicon recovery, affected-account charge/cancellation correlation, historical public-client update continuity and staged-draft T0/G1 checks remain as scoped in [FOLLOWTHROUGH.md](FOLLOWTHROUGH.md) and the [release runbook](../../RELEASE_RUNBOOK.md). Source soak time cannot substitute for installed/provider acceptance. No earlier release's waiver is inherited.

Supporting evidence is committed separately from the integrated candidate so its build/Guardian/onboarding identities remain stable while acceptance completes. Do not relabel those receipts with the evidence-only commit. The public release notes and five version pins remain unchanged until the cut is permitted.

Integration's pre-existing operational notes in `docs/NEXT.md` and `qa/STATUS.md` were preserved and left unstaged. The release cut still needs a clean integration tree and the post-bump ritual gates; current Guardian passes do not pre-authorize a later version bump or tag.
