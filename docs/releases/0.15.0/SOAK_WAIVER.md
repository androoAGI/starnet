# 0.15.0 owner soak waiver and READY-gate exception

> **Andrew's approval is recorded in §6.** His go for this release, given 2026-11-06 after testing the 0.15.0 candidate on his own station: "Do one last quick sweep, make sure we are in the perfect position for this update, and then execute all the steps to put the official 0.15.0 update out."
> Committed as `docs/releases/0.15.0/SOAK_WAIVER.md` on `agent/release-0150` **before the tag**. Unlike 0.14.2's it was written after the bump: the release commit (9fa2b17f3) came first. The waiver's terms below do not depend on that order.
> Precedents: [0.14.2](../0.14.2/SOAK_WAIVER.md), [0.12.0](../0.12.0/SOAK_WAIVER.md), [0.11.2](../0.11.2/SOAK_WAIVER.md).

## 1. Decision

**The 12-hour source soak (`npm run qa:soak:release`) and the 48-hour installed/attended soak are WAIVED for 0.15.0.** No elapsed-time wait is required for this release.

This is a release-specific owner decision. No later version inherits it, and it does not change the default procedure (docs/RELEASE_READINESS.md §2, RELEASE_RUNBOOK §0.4).

**Scope, in Andrew's words (2026-11-05):** "include all changes and exclude the workflow marketplace from this update, but for all other fixes, changes, improvements, and everything else needs to be in the new update." His decisions D1–D9 ("Ok we will go with your recommendation. and I agree with your recommendations for 1-9"): version 0.15.0; all six batch-6 lanes in; #157 only after his live test (it was not done, so #157 is **not** in 0.15.0); turn identity C10–C12 in and C13 after a soak (not in); the world-idle renderer ships behind its flag, off; the shell REPL refusal ships; the 5.77 MiB save at 10,000 chats is accepted; the visible "open StarNet once" refusal stays, with a notes line; a rollback paragraph in the notes.

**Candidate:** local trunk `feat/harness-backend` at 524b421a7 (37 of 38 audit lanes, batches 5 and 6, not the marketplace, not #157), plus the release commits on `agent/release-0150`:
- 9fa2b17f3 `release: v0.15.0` (the five pins and the notes), and the claims re-locks;
- the notes corrections found while installing the candidate (f92dece0c, d7e2d266d: the desktop app's real station folder);
- the final sweep's commits: d2933f149 (the sweep's one product fix: deleting a chat no longer removes an uploaded file that another chat still names, such as a /branch copy, a re-sent file or a chat whose older turns sit outside the station's in-memory window), a3cd7963f (the notes made exact against the code) and 3a7251972 (the bug register: dd379d02 and e25cb44c closed with their proof);
- the late review's fix, b53565c29: the sweep's third reviewer, recorded as lost to a usage limit, came back and read the release tree. It reproduced a stuck pass: one damaged transcript line among a deleted chat's rows kept the upload pass from settling, so later deletes' uploads waited behind it. It failed closed and nothing was lost. The pass now reads what still parses and settles, and the page reads a packed chat's uploads from its residue. The same commit fixes a false WORKSPACE_BUSY at start that a pre-tag T0 hit (a short-lived process held the old engine's recycled PID; unchanged since 0.14.2), a restore-point search that about 600 uploads for one agent overran, and a stale readiness check in the test harness;
- the CI fix round: d2b2ea7b4 and 7c9171325 (the product fix and the Linux portability fixes), b93d8fc13 (the upgrade check) and 926afe9aa (a test race). The first Linux CI run of these commits (the release branch was its first push) found one minor product bug: on macOS and Linux a source checkout's `git describe` was never the leader of its own process group, because `child_process.execFile` drops `detached`, so stopping the station could leave one of git's children running. A packaged app has no checkout and never runs that launch. Everything else it found was test or harness portability: a soak that never founded a station, an interrupted-run fixture that took the graceful SIGTERM path, a demo page's stale script list, cmd's `type`, and two races a fast host wins. The pre-tag T0 then stopped on its own upgrade check, which predated the save's 6 → 7 step: the only differences in its receipt were the version and the `legacy` mark on a kept history row, in both saves, and the check now takes exactly that step. The T0 run with the corrected check passed on the same installer.

The tagged commit is recorded in the cut record as TIP.

## 2. What replaces the duration soaks

- **Local whole-suite gates.** First on 113665c3a (= 75cde9998 plus the claims `sourceCommit` stamp): claims OK, `test:fast` 1782/1782, `test:http` 356/356, `qa:journeys` 139/139. The final sweep, the CI fix round and the late review then changed product code (d2933f149, d2b2ea7b4 and 7c9171325, b53565c29), so claims, `test:fast`, `test:http` and `qa:journeys` run again on TIP itself, one at a time. The ritual takes their logs only when they are newer than TIP, and the cut record carries the numbers. A red there stops the cut.
- **CI on TIP** (dispatched by hand: `agent/*` pushes trigger nothing): fast-gate (Linux `test:fast`, customer journeys, the 4 HTTP shards), secret-history (gitleaks over full history), floor-canaries (the live keyless voice canary), soak (the 20-minute soak and the 50-routine scale soak; both must PASS every JUDGED rule), desktop-build (Windows NSIS, both Mac legs notarized).
- **Pre-tag T0 on the TIP desktop-build installer**, on a fresh hosted Windows VM: clean install, first launch over CDP, the lifecycle cases, the v0.14.2 → candidate installer continuity, and an installed smoke bound to TIP.
- **On the staged draft, before Publish:** T0, and G1 (all Windows cases plus the macOS lifecycle job). A red on any of them means do not Publish: fix it and spend v0.15.1.
- **The owner's own install.** Andrew installed a local build of 75cde9998 over his 0.14.2 station on 2026-11-06; TIP adds only the final sweep's upload fix, the late review's upload pass, packed-chat and owner-claim fixes, the POSIX git launch a packaged app never runs, test and harness fixes, notes, docs and the bug register. It moved his real station from save v6 to v7 on first open (196 chats in the new save and in the kept v6 copy), and he used it for hours: "Everything else feels really solid honestly. I do not see any issues anywhere."
- **The 0.14.2 → 0.15.0 UPDATE CENTER path** cannot be proven before Publish (0.14.2's updater reads only `releases/latest`). It is proven right after Publish by the G1 public canary (v0.14.2 updates itself to v0.15.0 through UPDATE CENTER and keeps its state). **Rollback if it fails:** mark v0.15.0 pre-release on starnet-releases so `releases/latest` falls back to v0.14.2.
- **The real-vendor probe (`qa:model`)**, on a hermetic release-tree station with no key in argv, env or this session, run on 79007c0b5 with the upload fix applied (neither that fix nor the late review's touches the provider path): Ollama native and the OpenAI-compatible wire at Ollama, `qwen3:8b` (free, local). **Both wires PASS all eight checks:** the run completes, the tool call round-trips on the `tool_calls` wire, its arguments parse as sent, cost reconciles (24,898 and 25,623 tokens), with no errors, no fallback and no consent stall. $0 spent. **Not probed:** OpenRouter, OpenAI direct and StarNet credits need a key entered by Andrew in a throwaway station, which his go to finish the release without him did not include. Their substitutes are the adapter parity tests over the real adapters (test/aux-cache-policy.test.js, test/learned-tail.e2e.test.js) and Andrew's own runs on the installed candidate (Claude through the subscription CLI). The token-efficiency change to explicit cache markers therefore reaches OpenRouter's live API for the first time in the field; a provider refusal there surfaces as a visible run error, not a silent loss.
- **Rollback rehearsal (0.15.0 → 0.14.2), station side:** 0.14.2's own sidecar and Save read the kept pre-history-ref file, `keptAt` included, with every pre-upgrade chat. The window-storage step was derived from 0.14.2's boot code, not run in a real WebView2.

## 3. What this waiver does NOT remove

- The scripted machine soaks in §2. A FAIL there is a finding, not a flake.
- The claims re-lock, the website mirror check, CI on TIP, and T0 and G1 on the staged draft before Publish.
- **Not covered by any soak:** Windows stop/boot restart cycles (the CI soaks run on ubuntu); RSS at the 50-routine scale shape (NOT JUDGED by design); macOS beyond the CI lifecycle job (no Mac hardware test).
- **First real run in the train itself (accepted risk).** Three hard checks added since 0.14.2 exist only in release-train.yml and have local evidence only: the provenance step's install-manifest scan, the signed-mode DMG own-signature check, and the Windows installed-integrity proof in the published-upgrade job. desktop-build on TIP covers the notarized-mode DMG proof and the Intel installed verify on real signed bytes. Bug 776f2cee (the DMG strict-signature check's original failure) is still open, its cause unconfirmed. A train red that is purely a workflow or harness defect is recovered by dispatching release-train.yml with `tag=v0.15.0` from a repaired ref, without moving the tag. A red on the product means fix it and spend v0.15.1.
- **Known and shipping unchanged from 0.14.2** (not claimed fixed by the notes): the E-STOP half of 1ac8819d (a self-detached `Start-Process` child); Gemini 2.5 Flash and DeepSeek v3.1 tool calls through OpenRouter (bug 64dbe836); on Linux only, a recycled-PID cron lock that waits for the 8-minute age break (the one real behaviour behind the six Linux HTTP reds of 0.14.2's CI; the other five were test portability, fixed in the CI round); the dependency alerts the 0.14.2 waiver listed.
- Andrew's own items: the offline updater-key backup attestation (runbook §4.1; one off-box copy exists since 2026-10-31, the second is not attested).

## 4. READY-gate exception (docs/RELEASE_READINESS.md: "no version gets cut … without a fresh `npm run qa:ready` printing READY")

qa:ready runs in the release worktree as `SKYNET_GUARDIAN_TRUNK=agent/release-0150 node scripts/qa/ready.mjs`.

| qa:ready check | Status | Why | Substitute evidence |
|---|---|---|---|
| 1. Ledger open P0/P1 | **NOT waived.** Must PASS | — | — |
| 2. Bug register open P0/P1 | **NOT waived.** Must PASS: a P1 whose fix ships in TIP is closed through `scripts/qa/bugs.mjs --set` with its fix SHA and the tests that prove it | — | — |
| 3. Green Guardian last cycle | **WAIVED** | A cycle takes about 1 h 50 m and was last green 2026-09-17; the release ran its own whole-suite gates instead | The §2 local gates and CI fast-gate. **Not covered:** the golden-frame diff, the screenshot sweep and the behavioral truthfulness audit, accepted as unverified for 0.15.0 |
| 4. Journey corps last run | **NOT waived.** Must PASS on TIP | — | — |
| 5. Beginner Run last result | **Conditionally waived**, only if it ends `STUCK@boot` because the harness could not bring up Chrome/CDP; never for FAIL or a later STUCK | Harness | T0's clean-VM first launch over CDP, CI customer journeys, `qa:journeys` |
| 6. Installed-exe smoke | **Conditionally waived** if the stamp cannot be earned on this machine without reinstalling Andrew's station | The stamp needs the exact TIP build installed and relaunched with a debug port on his real station | Pre-tag T0's installed smoke bound to TIP on a clean VM, plus T0 and G1 on the draft |

Any other FAIL row in the post-bump preflight, or any qa:ready reason outside rows 3, 5 and 6, voids this exception and the cut stops. The tag is created and pushed by hand.

## 5. Branch-based cut (exception to RELEASE_RUNBOOK §0.1/§0.2)

The tag goes on the tip of `agent/release-0150`, not on a trunk merge commit, as v0.14.1 and v0.14.2 did. CI enforces no trunk containment: the release train and the source mirror need only the pushed tag. After Publish the release branch merges back into local `feat/harness-backend`.

## 6. Signature

- Approved by: **Andrew Sims, 2026-11-06**, in his words: "Do one last quick sweep, make sure we are in the perfect position for this update, and then execute all the steps to put the official 0.15.0 update out. Let me know when your done." It answered a list that named each remaining step, this waiver among them ("Sign the soak waiver. The 48-hour installed soak hasn't run, the same as for 0.14.2.").
- Waived checks confirmed at cut time (a subset of §4 rows 3, 5 and 6): recorded in the cut record.
- TIP: recorded in the cut record.
- Spend: the §2 probes are free (local Ollama) and spent $0. No paid probe ran.
- Offline updater-key backup: **his, still open.**

Carry this waiver into the cut record. The public notes cite no soak duration for 0.15.0.
