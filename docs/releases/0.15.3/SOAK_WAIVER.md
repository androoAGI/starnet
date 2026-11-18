# 0.15.3 owner soak waiver and READY-gate exception

> **Signature status is in §6: Andrew's go for this release is recorded there in his words; his explicit yes to this waiver is asked for in the report he requested before Publish, and Publish does not happen without it.**
> Committed as `docs/releases/0.15.3/SOAK_WAIVER.md` on `agent/release-0153` **before the tag**.
> Precedents: [0.15.2](../0.15.2/SOAK_WAIVER.md) (tagged, never published), [0.15.0](../0.15.0/SOAK_WAIVER.md), [0.14.2](../0.14.2/SOAK_WAIVER.md).

## 1. Decision

**The 12-hour source soak (`npm run qa:soak:release`) and the 48-hour installed/attended soak are WAIVED for 0.15.3**, subject to §6. No elapsed-time wait is required for this release.

This is a release-specific owner decision. No later version inherits it, and it does not change the default procedure (docs/RELEASE_READINESS.md §2, RELEASE_RUNBOOK §0.4).

**0.15.3 is the 0.15.2 release with four changes.** v0.15.2 was tagged on 2026-11-18 (09697b6f9) and was never published: no draft was staged and no user received it. Before Publish, Andrew found a display bug in it and stopped the release: "There is a cosmetic bug that was unfortunately just found … I think its probably better off that we fix it before release". A pushed tag is never moved, so the fixed build takes the next version. The scope is otherwise the one recorded in the 0.15.2 waiver ("everything we worked on besides the workflow marketplace"; the chat scroll "tail floor" change is also out).

**Candidate:** `agent/release-0153` = the v0.15.2 tag plus:

- ef1abf1f7: the model list stays inside a narrow COMMS and its footer keys wrap (CSS in `frontend/css/app.css` and `glass-comms.css`, their website mirrors, and a pinned test). This is the bug Andrew found. It was fixed and proven in another lane (fa8707535) and picked here unchanged.
- a5c5f1263: the update signer check gives its Windows PowerShell child that shell's own module folder. In v0.15.2 a StarNet started from a PowerShell 7 session refused every update as "unreadable". The first v0.15.2 release train found it: its Windows gate step runs in PowerShell 7. One Rust file, with a test that runs the real check and a poisoned-path control.
- fbd7a83ce and 5df6a0364: release workflows and their structural test only. `desktop-build` now rehearses both update signer gates on the signed artifacts before a tag exists, and the train's Windows gate keeps PowerShell 7's inherited module path on purpose.
- b4957f440: a run's temporary browser profile, which holds a copy of the saved sign-ins, is removed even when the browser is slow to leave. v0.15.2 retried the removal for one second; on Linux and macOS the browser's child processes can outlast that, and the first CI run of this branch (fast-gate 44392087525, HTTP shard 4/4, `browser-signin-survives.e2e`) left the profile behind. The removal now keeps trying for about five more seconds. One file (`sidecar/tools/builtin/browser.js`); the 48 listed tests that read it pass locally.
- a7e6ee0d6 (the five version pins), e916dc4e7 (the notes: the 0.15.2 notes renumbered, plus one bullet for the model list), this waiver, and the claims re-lock on top.

It does **not** contain the 24 commits of the local trunk that 0.15.2 left out (the tail-floor chat scroll change and its QA records among them), nor anything the local trunk gained since. The tagged commit is recorded in the cut record as TIP.

## 2. What replaces the duration soaks

Every gate below is run again, whole, on the 0.15.3 TIP. What 0.15.2's TIP earned is history, not proof for this release.

- **Local whole-suite gates on TIP**, one at a time on a quiet machine: the claims test, `npm run test:fast`, `npm run test:http` (both logs read by `scripts/qa/receipt-lint.mjs`), `qa:journeys` and `qa:beginner`. Both lists run whole, in one run each, with no filter, shard, environment override or edited list. `test:fast` runs at default configuration. On 0.15.2's TIP the HTTP list (401 steps) took about 72 minutes, more than the 57-minute run deadline `npm run test:http` sets, and the default run was cut at step 300 with no red; so the HTTP list is run once with only the deadline raised (`node scripts/run-test-list.mjs test/http.list --deadline=<ms>`), and the cut record says so (RELEASE_RUNBOOK §1.4a rule 2 otherwise holds). A red is read and takes §1.4a's disposition, never a rerun until green.
- **CI on TIP** (dispatched by hand: `agent/*` pushes trigger nothing): secret-history first and alone, then fast-gate, floor-canaries, soak (the 20-minute soak and the scale soak; both must PASS every JUDGED rule) and desktop-build (Windows NSIS, both Mac legs notarized, the Intel installed acceptance, and now both update signer gates on the signed artifacts).
- **Pre-tag T0 on the TIP desktop-build installer**, on a fresh hosted Windows VM: clean install, first launch over CDP, the lifecycle cases, the v0.15.0 → candidate installer continuity, and an installed smoke bound to TIP.
- **On the staged draft, before Publish:** T0, and G1 (the Windows cases plus the macOS lifecycle job). A red on any of them means do not Publish: fix it and spend the next version.
- **What 0.15.2 already showed about this code.** Its TIP passed every gate in this section on 2026-11-18 (local fast 1883/1883 and HTTP 401/401 with clean receipts, journeys 139/139, the beginner run, CI fast-gate, soak, desktop-build with both Mac legs notarized, pre-tag T0 with lifecycle 5/5 and the v0.15.0 continuity). Its second train built and signed Windows and Intel Mac and passed both update signer gates on hosted runners. 0.15.3 differs from that code by one CSS rule set, one environment variable on a child process, and a longer retry when a temporary browser profile is removed.
- **The owner's own installs.** Between 2026-11-14 and 2026-11-17 six builds of the 0.15.2 candidate were installed over Andrew's real station, each after a verified backup and each followed by a GREEN installed smoke bound to that build. After the last one (281913794) he wrote: "It appears to be launched already and it looks and feels quite fantastic." He found the model list bug on that build on 2026-11-18. The 0.15.3 TIP itself is not installed on his station before the tag; pre-tag T0's clean-VM install stands in for that. This is real installed use on one Windows station; it is not a soak with a measured workload.
- **Reviews.** Everything listed in the 0.15.2 waiver, plus an adversarial review of the 0.15.3 changes before the tag. The model list fix was swept in its own lane across nine layouts (COMMS 300/360/547 px, TEXT SIZE 90 to 150, two screen sizes), every COMMS pop-up and every dock window; that sweep found nothing else spilling or cut. It did not cover run-time cards in COMMS, widgets, Build Mode or the real desktop shell.
- **The 0.15.0 → 0.15.3 UPDATE CENTER path** cannot be proven before Publish (0.15.0's updater reads only `releases/latest`). It is proven right after Publish by the G1 public canary. **Rollback if it fails:** mark v0.15.3 pre-release on starnet-releases so `releases/latest` falls back to v0.15.0.
- **The real-vendor probe (`qa:model`)** ran on 0.15.2's candidate against free local Ollama (PASS 8/8 on three wires). No file it exercises changed; it is not run again, and no paid probe runs.

## 3. What this waiver does NOT remove

- The scripted machine soaks in §2. A FAIL there is a finding, not a flake.
- The claims re-lock, the website mirror check, CI on TIP, and T0 and G1 on the staged draft before Publish.
- **Not covered by any soak:** Windows stop/boot restart cycles beyond T0 and G1's cases (the CI soaks run on ubuntu); RSS at the scale shape (NOT JUDGED by design); macOS beyond the CI lifecycle job and the Intel acceptance (no Mac hardware test).
- **Not exercised on real data:** the one-time permission upgrade from a real 0.15.0 station on a second machine (see the 0.15.2 waiver §3). T0's v0.15.0 → candidate continuity case is the only other run of it.
- **Known and shipping** (each is in the release notes): after Full Access is given back, StarNet can ask once more whether to keep it; the upgrade notice can be missed if the first open stops before the station; a partly restored backup leaves RESUME STATION and RETRY AUTO-RESUME on different saves; a bare "ok" after a general sign-off can start a work run; a Mac on 0.15.0 installed on another disk cannot take the update in-app. Three cost controls are on by default; every other cost change ships switched off, and the notes claim no saving.
- **The train itself:** GitHub's hosted macOS runners were short on 2026-11-18 and dropped jobs as "not acquired by Runner". A train red that is purely a workflow, runner or harness defect is recovered by re-running the failed jobs, or by dispatching release-train.yml with `tag=v0.15.3` from a repaired ref, without moving the tag. A red on the product means fix it and spend the next version.
- Andrew's own items: the offline updater-key backup attestation (runbook §4.1; one off-box copy exists since 2026-10-31, the second is not attested).

## 4. READY-gate exception (docs/RELEASE_READINESS.md: "no version gets cut … without a fresh `npm run qa:ready` printing READY")

qa:ready runs in the release worktree as `SKYNET_GUARDIAN_TRUNK=agent/release-0153 node scripts/qa/ready.mjs`.

| qa:ready check | Status | Why | Substitute evidence |
|---|---|---|---|
| 1. Ledger open P0/P1 | **NOT waived.** Must PASS | — | — |
| 2. Bug register open P0/P1 | **NOT waived.** Must PASS | — | — |
| 3. Green Guardian last cycle | **WAIVED** | No cycle is recorded on this machine; the release runs its own whole-suite gates instead | The §2 local gates and CI fast-gate. **Not covered:** the golden-frame diff, the screenshot sweep and the behavioral truthfulness audit, accepted as unverified for 0.15.3. The dashboard look changed in this release, so the golden frames would need blessing before they could judge anything |
| 4. Journey corps last run | **NOT waived.** Must PASS on TIP | — | — |
| 5. Beginner Run last result | **Conditionally waived**, only if it ends `STUCK@boot` because the harness could not bring up Chrome/CDP; never for FAIL or a later STUCK | Harness | T0's clean-VM first launch over CDP, CI customer journeys, `qa:journeys` |
| 6. Installed-exe smoke | **Conditionally waived** if the stamp cannot be earned on this machine without reinstalling Andrew's station again | The stamp needs the exact TIP build installed and relaunched with a debug port on his real station, which runs the 281913794 build | Pre-tag T0's installed smoke bound to TIP on a clean VM, plus T0 and G1 on the draft |

Any other FAIL row in the post-bump preflight, or any qa:ready reason outside rows 3, 5 and 6, voids this exception and the cut stops. The tag is created and pushed by hand.

## 5. Branch-based cut (exception to RELEASE_RUNBOOK §0.1/§0.2)

The tag goes on the tip of `agent/release-0153`, not on a trunk merge commit, as v0.14.1, v0.14.2, v0.15.0 and v0.15.2 did. CI enforces no trunk containment: the release train and the source mirror need only the pushed tag. The local trunk is not pushed by this cut. The v0.15.2 tag stays where it is and is never published. After Publish the release branch merges back into local `feat/harness-backend`; that is a real merge (the trunk holds commits the release does not), and it owes its own gate.

## 6. Signature

- **Andrew Sims's go for the release, 2026-11-17**, after testing the installed 281913794 build: "I think we should absolutely push forward everyhthing looks really good … I want you to go full blast on the update Report back to me right before we officially publish it and let me know if u need any specific context". On the push and the tag, 2026-11-18: "Yes, push and tag" and "I approve proced".
- **His stop and his go for this version, 2026-11-18:** "WAIT", "There is a cosmetic bug that was unfortunately just found … better off that we fix it before release", then "the issue is fixed and merging now please stay on top of this once its merged lets go FULL blast".
- Those answers did not name this waiver. **His explicit yes to waiving the two duration soaks is therefore asked for in the pre-Publish report he requested, and is recorded in the cut record.** Until he gives it, this waiver covers preparing, gating and staging the draft, and nothing is published.
- Waived checks confirmed at cut time (a subset of §4 rows 3, 5 and 6): recorded in the cut record.
- TIP: recorded in the cut record.
- Spend: none. No paid probe runs.
- Offline updater-key backup: **his, still open.**

Carry this waiver into the cut record. The public notes cite no soak duration for 0.15.3.
