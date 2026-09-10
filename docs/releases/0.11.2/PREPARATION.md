# 0.11.2 preparation — September 10, 2026

**Not ready to cut.** This pass reviews the merged update, repairs a reproduced formatting regression, and prepares the release scope. Version pins remain at 0.11.1. No version bump, tag, push, installer replacement or publication was performed.

## Candidate and coverage

Released baseline: `v0.11.1`, `b3760c46ff3fe02790e6c3b0c50a23c30b5837a8`.
Audited integration snapshot: `00de68e0f6da9c00b778eea1deefbaa84b82baa8`.
Audit worktree: `agent/release-0112-audit-0910`. Repair: `cb6c30b4d`.

All **54 reachable merge commits** and **4,917 changed paths** are inventoried in
[inventory.json](../../../qa/evidence/0.11.2-merge-audit/inventory.json). Many merges synchronize overlapping lanes; counting them as 54 independent features would be misleading. The inventory also includes changes that arrived through fast-forward integration.

Of those paths, 2,323 are frontend assets and 2,350 are generated website mirrors. There are 27 frontend runtime/style/markup paths, 15 backend runtime paths, 53 test paths, 15 scripts, 107 QA records, 10 documentation paths and 17 other paths. The earlier 0.11.1 audit alone does not cover this expanded update.

| Combined changes reviewed | Review and current proof | Remaining limit |
| --- | --- | --- |
| Catalog selection, image cost/cancellation, panel persistence | Cleanup ancestry and current implementation checked; delayed-catalog and resize/reopen/reload browser probe passed | Real paid image/gateway reconciliation on the installer remains owed |
| Save conflicts, group conversion, loop reviews | Storage/revision, conversion identity/attachments and review exclusion changes traced; maintained fast/HTTP regressions | Exact customer stations and installed multi-window recovery remain unverified |
| API retries, terminal outcomes, structured result repair | Durable reservations, auth recheck, terminal accounting, validator and tool-free repair paths reviewed | Keyed retry protection applies to chat completions, not `/v1/runs` creation; structured streaming is rejected |
| COMMS reports | Live public renderer exposed and verified the list repair; 54 formatting/copy assertions passed | Browser rendering proof does not certify an installed WebView |
| Creation, personality and managed setup | Changed flow and recovery code reviewed; fresh Beginner run passed all six UI steps | UI-only run stops at the real-model boundary; account recovery is not proven |
| GitHub and platform guide | Device-flow expiry, cancellation, credential persistence/read-back and setup navigation reviewed; registered tests included in gates | No new real GitHub authorization or production account change in this pass |
| World and speech | Merged source and existing movement/approval/speech evidence inspected; regressions included in gates | Physical audio, signed Mac permissions, prolonged GPU behavior and installed recovery remain owed |
| Release and generated mirror | Version pins agree; 0.11.2 had no local/origin tag or distribution release at preflight; mirror synchronized | Reservation checks must repeat immediately before cutting |

These are bounded source and runtime checks, not a claim that every asset was visually approved or every product behavior certified.

## Repairs from this pass

1. **COMMS list parsing** — [bug 3ad3e2b8](../../../qa/bugs/3ad3e2b8-comms-report-lists-lose-plus-and-tab-separated-m.md). The fast rendering shortcut omitted plus bullets, and the new block parser required a literal space. In the running app, plus bullets and tab-separated lists produced zero list items. The repair aligns the shortcut and parser; all four live examples now produce two items. Exact report bytes still copy intact. The existing registered formatting suite now exercises the public renderer across five markers and two spacing variants; six new assertions failed before the repair and all 54 pass afterward.
2. **Readiness text encoding** — repaired mojibake in the canonical bug-count reason and receipt. Counts, blocking severity and readiness rules are unchanged. All 118 readiness assertions pass.

The generated website mirror and advertised source lock were refreshed for the reviewed rendering change. No visual baseline or detector finding was dismissed.

## Verification

- Initial full fast command: **769/769 passed**. Audit edits began near its end, so this is an initial working-tree run, not the final frozen candidate receipt.
- Browser journeys on `00de68e0f`: **139/139 passed**. Includes real run lifecycle, Stop, reload, duplicate send, deliverable opening and slash-command paths with controlled provider responses.
- Fresh Beginner on `00de68e0f`: **6/6 UI steps passed**, 93.021 seconds. It used a disposable fresh station and stopped at the real-model boundary.
- Cleanup live check on `00de68e0f`: height **420 → 512 → 512 after reopen/reload**, maximize/restore and smaller viewport checked; delayed catalog retained `starnet / anthropic/test-model`; zero page exceptions.
- Formatting live check: **0/0/0/2 list items before → 2/2/2/2 after**. [DOM evidence](../../../qa/evidence/0.11.2-merge-audit/report-lists.json).
- Final fast/HTTP/customer checks and candidate identities are recorded in the accompanying verification receipt after completion. Raw gate logs remain in this worktree's `.dogfood/release-0112/` directory.

## Release blockers and next actions

The read-only **integration** readiness snapshot at `00de68e0f` returned six reasons:

1. Four blocking detector findings: one P0 and three P1. The historical P0 is a gate-detector failure, not evidence of catastrophic product damage.
2. Seven open customer P1 records.
3. Guardian's latest cycle was RED.
4. Journey receipt did not identify the current integration commit.
5. Beginner receipt did not identify the current integration commit.
6. Installed smoke still identified an older source/build.

A new lane's empty ignored detector directory does not clear integration's findings. Passing local journeys/Beginner here does not overwrite the integration authority. Preserve historical failure receipts and reconcile each finding against its own current scenario.

Before cutting 0.11.2:

- Freeze and integrate the intended source. Re-run Guardian and current visual review; refresh exact-candidate journey and Beginner evidence. Existing audit documents saying cleanup/world repairs are still branch-only are historical: their runtime repairs are present in this snapshot's ancestry.
- Resolve or explicitly disposition the seven customer P1s with the required evidence: affected-account Sonnet failure, funded-account zero warning, Mac relink/onboarding, idle blank viewport, unexplained idle usage, missing ONCE routine, and Trusted Project/equipment discrepancy. Neighboring passing tests cannot establish customer recovery.
- Build and verify the exact installer: preserved station and protected credentials, linked-account text/image work with matching receipts, Mac microphone permissions and real audio interruption/noise behavior.
- Exercise automatic download/install/relaunch from an older installed client. Manual installation and an updater check do not prove that path.
- Complete the scripted 20-minute and scale checks, the **720-minute release soak**, and the separate installed/attended acceptance required by the runbook. This pass does not inherit 0.11.1's soak/readiness exception.
- Earn the canonical `qa:ready` receipt, then follow `release:ritual` for the five-pin bump, final notes, source lock, post-bump gates and tagging. [Draft notes](RELEASE_NOTES_DRAFT.md) are ready for review; the existing public release notes remain 0.11.1 until a cut is permitted.

Preflight explicitly says **do not bump or tag while NOT READY**. This is why preparation stops short of creating a release number or installer, rather than treating source-test success as release acceptance.
