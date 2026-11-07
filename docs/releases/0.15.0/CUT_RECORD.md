# StarNet v0.15.0 — cut record

The record of how v0.15.0 was cut, gated and published. Drafted during the final local gates on 2026-11-07 and completed after Publish, at about 09:15Z (04:15 EST).

- **TIP is the tagged commit.** This file and the website restamp (d95089f04, §10) land on `agent/release-0150` after the tag. They are not part of what shipped.
- **Sources.** The release session's cut log (`gen-trees/_logs/release-0150/PLAN.md`, "CUT LOG 2026-11-07"), the cut plan (`gen-trees/_logs/reliability-coordination-codex-1029/release-cut-plan-99a7d541.md`), the committed waiver `docs/releases/0.15.0/SOAK_WAIVER.md`, the local gate logs and receipts in `gen-trees/_logs/release-0150/` (written `<logs>/` below; not in this repo), and the CI artifacts. Repo paths are written in full.
- **"Read at writing"** marks a fact read with a read-only `gh` or `git` query while this record was written. Every run ID and commit named here was checked against GitHub and git at writing.
- **Later entries win.** Pins before TIP were superseded. Their runs are history (§3.4), not proof of TIP.

## 1. Identity

| Item | Value |
|---|---|
| Version | 0.15.0. All five version pins agree (preflight row PASS) |
| Tag | `v0.15.0`, lightweight, made by hand on TIP immediately before the push (waiver §4–§5). `git describe` printed `v0.15.0`. Origin `refs/tags/v0.15.0` = TIP (read at writing) |
| TIP | **71e207bed6949c6d07e23cc6f2f21a5771353e4f**, "qa(claims): re-lock the release surface for v0.15.0" |
| Branch | `agent/release-0150`: a branch-based cut, the written exception in waiver §5, as v0.14.1 and v0.14.2 were |
| Base | Local trunk `feat/harness-backend` at **524b421a7**: 37 of 38 audit lanes, batches 5 and 6, without the workflow marketplace, #157 or C13. Baseline v0.14.2 = c6468b7f9 |
| Commits | 25 in 524b421a7..TIP, none a merge. 1013 in v0.14.2..TIP, 81 of them merges (read at writing) |
| Hygiene | All 25 release commits are authored and committed by andro, with empty `%(trailers:only)` and no co-author, generated-with or signed-off text. In v0.14.2..TIP, 1010 commits use the nonfungiblefunyuns address and 3 use andro@users.noreply.github.com (7f7a2689a, 16d15a7f3, 04a5dffbd). `shared/` changed in one file, shared/events.js (+47 −6) |
| Size | v0.14.2..TIP: 1703 files changed, 196914 insertions, 18434 deletions |
| Bump | 9fa2b17f3 `release: v0.15.0` → 75cde9998 relock. Unlike 0.14.2's, the waiver (fce96b8bb) came after the bump; its terms do not depend on that order |
| Tag push | 2026-11-07T07:20:40Z (02:20 EST). It started release-train 42350897656 at 07:20:48Z |
| Published | **2026-11-07T08:48:22Z** (03:48 EST), by `gh release edit --draft=false --prerelease=false --latest`. releases/latest = v0.15.0 |
| Release | https://github.com/androoAGI/starnet-releases/releases/tag/v0.15.0: 9 assets, the same set as v0.14.2 |
| Notes | RELEASE_NOTES.md at TIP has 68 bullets in 20 sections. Heading plus summary is 446 characters and ends on the summary's full stop. No CR, BOM, TODO or HTML comment. The one use of "soak" says C13 follows a soak; no soak duration is cited |
| Claims | `claims.mjs` PASS: 37 claims, 396 locked surface files |

**Shipped installers** (GitHub's SHA-256 digests of the published assets; T0, G1 and the public canary each read the same Windows installer hash):

| Asset | SHA-256 |
|---|---|
| StarNet_0.15.0_x64-setup.exe | c5136ef3c3cc292f890bb701548ba2a40cbdad233cd3acb9c2848794fb3f786e |
| StarNet_0.15.0_aarch64.dmg | 7c833196832e227a240bfbd9899fe66d52404c8c11edd2d4f27505614dc7f6c4 |
| StarNet_0.15.0_x64.dmg | bd3043be5a6b2fcf26f5b80ff680ebfdd001aa83b3ceb02989e5aa2ac8beb1cd |

**latest.json** (digest e622d1c64020412e3ce41125e0d29efbf48f0fe3df9eb828335d85cbe4baa89b) has version 0.15.0 and the platforms windows-x86_64, darwin-aarch64 and darwin-x86_64, each URL pinned to `/download/v0.15.0/` and each signature equal to its `.sig` asset. Its pub_date is 2026-11-07T08:39:55.650Z. Its `notes` equal the tagged RELEASE_NOTES.md without the file's final newline, and the release body equals the file (checked on the draft before Publish, `draft-review.js`). After Publish the notes' opening was replaced at Andrew's request (§10, "Notes summary"): the live latest.json is now digest 66de9b65af5dd3b56655bb9f618e537ff2142793b1ce47495450e1ed8e0c4c6a, the same file with only `notes` changed.

## 2. What changed late

Andrew tested a local build of 75cde9998 on his real station on 11-06 ("Everything else feels really solid honestly. I do not see any issues anywhere.") and gave the go: "Do one last quick sweep, make sure we are in the perfect position for this update, and then execute all the steps to put the official 0.15.0 update out. Let me know when your done".

| Pin (commit time, EST) | Added on top of the previous pin |
|---|---|
| 75cde9998 (11-06 01:48) | The bump, the notes and the relock. Andrew's installed test build. 113665c3a (the same tree plus the claims `sourceCommit` stamp) earned the first local gates: claims OK, FAST 1782/1782, HTTP 356/356, journeys 139/139 |
| e13afb245 (15:09) | f92dece0c: the notes name the desktop app's real station folder, found while installing the candidate. Relock |
| 79007c0b5 (15:13) | d7e2d266d: the kept file's folder written out whole. Relock |
| 221f4ff1b (18:24) | The final sweep: a3cd7963f notes made exact against the code, 3a7251972 bugs dd379d02 and e25cb44c closed, d2933f149 the upload fix, fce96b8bb the signed waiver. Relock. The first push of the branch |
| 65bb96339 (18:31) | 2f40f4fed: gitleaks ignores the candidate's 40 reviewed fixture findings by exact fingerprint (130 in all), after secret-history 42312137965 went red. Relock |
| 23f67d526 (19:45) | The CI fix round, d2b2ea7b4 and 7c9171325, and waiver 9c9936948. Relock |
| 43ca869b7 (20:50) | b93d8fc13 (the upgrade check learns save 6→7; pre-tag T0 42324327453 was red on it), 926afe9aa (a station-show race), waiver 8d967010b. Relock |
| **71e207bed (22:55) = TIP** | The late review's fix b53565c29, bug records fc66991b1, waiver 8010962c7. Relock |

- **The upload fix, d2933f149.** The sweep's one product fix: deleting a chat no longer removes an uploaded file that another chat still names (a /branch copy, a re-sent file, a chat whose older turns sit outside the in-memory window).
- **The CI fix round.** The release branch was the candidate's first push, so this was its first Linux run. It found one minor product bug: on macOS and Linux a source checkout's `git describe` was never the leader of its own process group, because `child_process.execFile` drops `detached`, so stopping the station could leave one of git's children running. A packaged app has no checkout and never runs that launch. Everything else was test or harness portability, plus the soak harness: it never founded a station, so a restart read as a lost crew (d2b2ea7b4's message; soak 42312920790, §3.4).
- **The late review, wf_9a6a76fa-b8e.** The sweep's third reviewer (privacy) had been recorded as lost to a usage limit in d2933f149's message. That note was wrong: it came back and read the release tree, and its findings are the reason for b53565c29. Dispositions:
  - F1 (major, new in 0.15, reproduced on a real sidecar): one damaged transcript line or lost segment among a deleted chat's rows kept the upload pass from settling, so later deletes' uploads waited behind it. It failed closed; nothing was lost. Fixed; bug 907bc357.
  - F2 (major against the notes, a pre-existing path, narrowed by background hydration): a chat from before 0.15 deleted from the rail without being opened kept its upload. Fixed; bug 4eb4ea38.
  - F3 (a file sent from a restored copy of a chat stays): in the notes and the census reason.
  - F4 (a composer chip removal and a chat delete walk the transcript on the event loop, about 100 ms at 30 MB and about 1.2 s at 400 MB): follow-up (§9).
  - F5 (one lost segment doubts every later claim): covered by the notes; follow-up.
  - F6 (a failed removal is not retried): logged, in the notes.
  - Nit (uploads from a chat deleted on 0.14 stay): a notes sentence.
- **Also in b53565c29.** A false WORKSPACE_BUSY at start (bug b295999b): pre-tag T0 42329619516 hit it, and real short-lived holders reproduced it 5 of 5 before the fix and 0 of 5 after; the code path is unchanged since 0.14.2. About 600 uploads for one agent overran Windows' command line in the restore-point search (bug 98d36a49, found by the final review). And the harness's ready check (`scripts/lib/seed.mjs`), which had hidden slow boots.
- **The final review of b53565c29** (a read-only agent): "SHIP", nothing unsafe, no settle regression. Its small items were applied before the commit. Not verified by it: POSIX kill(0) and unlink behaviour; a real locked segment (errors were injected).
- **I rewound my own unpushed commits once.** A first records script committed fda79bd01, 656e1a467 and 05be90384 with bug records the register had rejected. Nothing was pushed. The branch was reset to b53565c29 and the records redone with a script that stops on a rejection.

## 3. CI, train and draft runs

### 3.1 CI on TIP

Dispatched by hand on `agent/release-0150` (`agent/*` pushes trigger nothing), headSha = TIP. secret-history ran alone first.

| Run | Workflow | Result |
|---|---|---|
| 42336332778 | secret-history | Green |
| 42336456881 | fast-gate | **Attempt 1 red only on `gate (2/4)`, in `Run npm ci`, before any test:** onnxruntime-node's install hit `connect ETIMEDOUT` to api.nuget.org for microsoft.ml.onnxruntime.gpu.linux 1.24.3. Every http shard, webkit-floor, rust-policy, journeys and the other gate shards were green. **Attempt 2 (`--failed`): success, all 11 jobs** (gate (2/4) job 128297585821: `run-fast-tests: OK — 446 step(s) green`, 7m25s) |
| 42336459693 | floor-canaries | Run conclusion failure, on two floors only. voice green; openrouter-catalog (460 models), models-dev-prices, google-signin, codex-device, github-device and web-fetch green. **Red, as on every pin:** update-host ("the product update verifier failed or timed out"; correct until Publish, green after it, §10) and web-search ("the product search ladder returned no usable result" from a hosted IP; §6) |
| 42336462042 | soak | Green |
| 42336464640 | desktop-build | Green: builds for darwin-arm64, darwin-x64, linux-x64 and win-x64; notarize-macos ×2; intel-macos-installed-acceptance; publish-test skipped |

The TIP installer from 42336464640 is `StarNet_0.15.0_x64-setup.exe`, sha256 d4ab41266dd60a81fd3bac7a29ef96262f50b534d12303eafde722df1f5df1f8. Its signature verified against the baked public key.

**Pre-tag T0 42338688375** (04:29:40Z–04:37:56Z) on that installer: **green.** Clean-install proof (schema starnet.clean-install-proof.v1): cdpProven true, pageTitle STARNET, sourceCommit TIP. Candidate lifecycle PASS with failedCases []: idle-close, close-to-tray, updater-smoke, kill-relaunch and cli-app-closed. Public upgrade continuity from v0.14.2: PASS, all 6 checks true. Installed smoke GREEN, 9/9 checks, bound to TIP's commit and tree (25f0037da). The installed provider-fallback, delegated-connector, session-reliability and spend-authority suites passed.

### 3.2 Tag, draft and public runs (ref v0.15.0, headSha = TIP)

| Run | What | Result |
|---|---|---|
| 42350897656 | release-train, on the tag push | **SUCCESS** in 1 h 21 m: gate (28.5 min), build ×3 (the win-x64 leg runs the published-upgrade proof), webkit-floor-boot, voice-floor-canary, notarize-macos ×2, intel-macos-installed-acceptance, assemble and stage-draft. Its floor jobs logged warnings for web-search and update-host and still ended green |
| 42356647685 | T0 on the draft | **SUCCESS**, in draft mode: the staged installer (c5136ef3…) downloaded, installed silently, first launch proven over CDP, pageTitle STARNET. Its lifecycle, continuity and installed-suite steps are skipped in this mode |
| 42356649541 | G1 on the draft, default cases | **SUCCESS**. Windows: idle-close, close-to-tray, updater-smoke, kill-relaunch and cli-app-closed PASS. lifecycle-macos: kill-relaunch and cli-app-closed PASS. Not covered, by its own list: tray menu Quit, the armed-work residency branch, macOS window cases, Linux |
| 42357042717 | G1 public canary (`public_canary=true`, baseline v0.14.2), after Publish | **SUCCESS on every job.** public-upgrade-continuity PASS: v0.14.2 (installer aaa65c68…, c6468b7f9) found the public update and updated itself through the in-app updater to the published installer (c5136ef3…), source TIP, install integrity verified (2493 files). All 10 checks true, among them state preserved across the install and across a restart, the save moved from v6 to v7, and installed smoke GREEN. Windows lifecycle 5/5 and macOS 2/2 again |
| 42357418696 | sync-source-release | Success: v0.15.0 is Latest on androoAGI/starnet, 08:55:50Z |
| 42357420606 | floor-canaries on v0.15.0, after Publish | update-host **green**; web-search red (the run's only red); voice and the other floors green |

### 3.3 Specific failures

- **The NuGet flake.** fast-gate attempt 1 on TIP, `npm ci`, §3.1. It did not recur in the train's gate.
- **Pre-tag T0 reds on earlier pins, both fixed.** 42324327453 (23f67d526): the upgrade continuity check did not know the save's 6→7 step; fixed by b93d8fc13, and a dry run with `--ref b93d8fc13` on the same installer, 42325187355, was green. 42329619516 (43ca869b7): idle-close exited 73 with a false WORKSPACE_BUSY, "PID 3088 is running but its start time could not be read"; fixed in b53565c29.
- **pageTitle.** 43ca869b7's green T0 42330733995 recorded pageTitle about:blank; TIP's and the draft's record STARNET. 0.14.2's record saw the same variation.
- **session-reliability's log** ends on a teardown line after its PASS row.

### 3.4 Superseded runs (history, not evidence for TIP)

| Tree | Runs |
|---|---|
| 221f4ff1b | secret-history 42312137965 red (the 40 reviewed fixture findings) |
| 65bb96339 | secret-history 42312717766 green · fast-gate 42312914865 red (the first Linux findings, fixed in d2b2ea7b4) · floor-canaries 42312918038 red (update-host, web-search) · soak 42312920790 red (its soak and scale jobs both failed their verdicts; the scale job's: 3 of 22 runs failed and its restart cycle failed, because the soak never founded a station; fixed in d2b2ea7b4) · desktop-build 42312923528 green · local FAST 1782/1782 |
| d2b2ea7b4 | fast-gate 42318148210 red (the second Linux findings, fixed in 7c9171325) · soak 42318151360 green |
| 23f67d526 | secret-history 42320464622 green · fast-gate 42320667874 green on attempt 2 · floor-canaries 42320671114 red (update-host, web-search) · soak 42320673684 green · desktop-build 42320676627 green (installer 188ad61f…) · T0 42324327453 red · T0 dry run 42325187355 green · local FAST 1782/1782; HTTP 86/357 clean when stopped |
| 43ca869b7 | secret-history 42326355288 green · fast-gate 42326543609 green on attempt 2 (attempt 1 red on comms-owner only: the READY_EXPR defect, fixed in b53565c29) · floor-canaries 42326546755 red (update-host, web-search) · soak 42326549071 green · desktop-build 42326551490 green (installer a13cc96b…) · T0 42329619516 red · T0 42330733995 green · local claims OK, FAST 1782/1782; HTTP stopped at 119/357 with step 108 credential-store.channel-ref red on a withheld token (§4.1) |

## 4. Local gates on TIP

All ran in the release worktree at TIP, one at a time, each receipt recording `dirty: 0 entries`. Logs and receipts are in `<logs>/`.

| Gate | Result | Evidence |
|---|---|---|
| Claims test | OK, 64 assertions, 110 s | final-claims.log/.receipt |
| test:fast, whole list | **1784/1784 green**, 04:02:18Z–04:45:59Z | final-fast.log/.receipt; ritual receipt `.dogfood/gate-receipts/71e207bed….fast.json` (1784 steps, 07:15:32Z) |
| test:http, whole list | First run **354/357, 3 red** (§4.1). Re-run on the same SHA: **357/357 green**, 06:01:16Z–07:13:45Z (4348 s), no quarantine retries | run1-red-final-http.log/.receipt; final-http.log/.receipt; ritual receipt `.dogfood/gate-receipts/71e207bed….http.json` (357 steps, 07:15:32Z) |
| qa:journeys | **PASS 139/139**, 05:55:48Z–05:56:17Z | final-journeys.log/.receipt |
| qa:beginner | **RUN PASS**: 6 steps in 40.9 s, stopping at the ui-only boundary as designed. It rewrites its own qa/STATUS.md row; that one line was restored and nothing was committed | final-beginner.log/.receipt |
| After the tag: website restamp | website-deploy-staging (42 assertions) and website-app-sync (8) pass on d95089f04; claims PASS | §10 |

### 4.1 The HTTP gate's first run

Waiver §2 says a red there stops the cut. It stopped: the three were read, run alone on the same SHA, and the gate ran again in full on the same SHA with no tree change.

| Step | Failure | Reading | Alone on TIP (3 rounds) |
|---|---|---|---|
| 105 credential-store.redaction.e2e | "sidecar became healthy but did not serve a boot token"; the station logged "withheld the station token from a local connection (lookup-failed)" | The peer check's netstat or tasklist call failed or missed its 5 s limit. sidecar/peerowner.js is unchanged since v0.14.2, and 0.14.2's record (§9 item 4) saw the same pattern. Which call, and why, is not proven: on an idle box they take 31–111 ms and 196–299 ms. The test keeps three live stations; step 108 on 43ca869b7 was the same family. The test fixture has no retry | 28 assertions OK ×3, 6–7 s against 24.5 s in the gate |
| 173 start-fresh-browser.e2e | FRESH_ACTIVATION_FAILED, EPERM: the next boot did not end the process left on the profile | Likely sweepSync's process query (10 s limit; a failed query kills nothing, by design). The gate log does not carry the station's output for this test, so this is a reading, not a proof | 18 assertions OK ×3, 15–17 s against 57.2 s |
| 251 aux-token-ceiling.e2e | Four FAILs with one cause: the governor line says RESERVED[skill-review], the test's `childrenDone` took a quiet gap between passes for settled, and the skill review's row (450 tokens: 1350 → 1800) arrived in the next window | Harness timing | 70 assertions OK ×3, 28–44 s against 42.3 s |

- **What a user would see.** The desktop app injects its key (`webview_init_script` in src-tauri) and never takes the peer check. A browser page that gets `lookup-failed` re-reads `/` at most once a minute and adopts the key (frontend/app/harness.js). A START FRESH that hits EPERM says "Nothing was moved. Close what is using it, then press START FRESH again." All three fail safe.
- **Box load.** Other sessions' Godot builders and a python process held the box: about 37% of 16 logical CPUs right after the first run, and 90% while the re-run was at step 256. Since the re-run passed at that load, load alone is not a proven cause; these three are timing-dependent and passed every time alone.
- **Not changed.** A test-only fix would have moved TIP and spent every CI run and T0 again. Follow-ups are in §9.

## 5. Readiness, waiver and owner approvals

### 5.1 qa:ready on TIP: NOT READY, 2 reasons, both inside the waiver

Run as `SKYNET_GUARDIAN_TRUNK=agent/release-0150 node scripts/qa/ready.mjs` at 07:14:04Z (Appendix A.1).

| Check | Result |
|---|---|
| 1. Ledger open P0/P1 | PASS: 0 P0, 0 P1, 0 P2 |
| 2. Bug register | PASS: 0 P0, 0 P1, 31 P2 |
| 3. Green Guardian | FAIL: no cycle recorded. Waived (waiver §4, row 3) |
| 4. Journey corps | PASS, 139/139, on TIP |
| 5. Beginner Run | PASS (ui-only, 40919 ms). Earned, not waived |
| 6. Installed-exe smoke | FAIL: no stamp on this machine. Waived (row 6): earning it means installing the TIP build over Andrew's real station, which runs his 75cde9998 test build. The substitute is pre-tag T0's installed smoke, GREEN 9/9 and bound to TIP (§3.1), plus T0 and G1 on the draft |

### 5.2 Ritual and preflight

- **Ritual** (`<logs>/ritual-71e207bed.txt`, Appendix A.2). Steps 1–4 were done or skipped (the bump had landed; notes real; claims current). Step 5 accepted final-fast.log and final-http.log and wrote both receipts. Step 6 stopped on the waiver path. Run without `SKYNET_GUARDIAN_TRUNK`, its qa:ready row also named journeys and the beginner run as "not on the exact current trunk (71e207be vs 524b421a)": the ritual reads trunk's name, not the release branch's. The preflights below name the branch, as waiver §4 says.
- **Preflight before the tag** (`<logs>/preflight-71e207bed.txt`): PASS 11, FAIL 1, WARN 5, SKIP 1.
- **Preflight after tagging** (`<logs>/preflight-tagged-71e207bed.txt`, Appendix A.3): PASS 10, FAIL 1, WARN 6, SKIP 1. The one FAIL is the qa:ready verdict, with only rows 3 and 6, as waiver §4 allows. The rows:

| Row | Status |
|---|---|
| On trunk | WARN: on the lane, `--allow-lane` |
| Working tree clean | PASS |
| Five version pins | PASS, all 0.15.0 |
| Tag not yet local | WARN after tagging: already tagged at HEAD |
| Tag not on origin; no release on starnet-releases | PASS (before the push) |
| Claims lock | PASS: 37 claims, 396 files |
| website/app mirror | PASS |
| test:fast at HEAD | PASS: 1784 steps |
| test:http at HEAD | PASS: 357 steps |
| T0 and G1 | WARN: owed at that point; run on the draft (§3.2) |
| Installed-exe smoke | WARN: no local stamp (row 6) |
| 48-hour installed soak | WARN: waived |
| qa:ready verdict | **FAIL**: rows 3 and 6 (§5.1) |
| Updater signing key present | PASS (contents never read) |
| Key backed up offline (≥2 copies) | SKIP: human attestation (§5.3) |
| RELEASE_NOTES.md | PASS |

### 5.3 The waiver

- `docs/releases/0.15.0/SOAK_WAIVER.md` is committed on TIP (8010962c7). Andrew's approval is his go above, which answered a list naming "Sign the soak waiver. The 48-hour installed soak hasn't run, the same as for 0.14.2."
- The 12-hour source soak and the 48-hour installed soak are waived. The scripted soaks are kept: soak 42336462042 is green on TIP.
- **Its §6 blanks, filled here.** The committed file is not edited, because that would move the pin.
  - **TIP:** 71e207bed6949c6d07e23cc6f2f21a5771353e4f.
  - **Waived checks at cut time:** row 3 (Green Guardian) and row 6 (installed-exe smoke). Row 5 (beginner) was earned on TIP.
  - **Spend:** $0. The §2 probes ran on free local Ollama. No paid probe ran.
  - **Offline updater-key backup:** Andrew's, still open. One off-box copy exists since 2026-10-31; the second is not attested, and the preflight row stays SKIP.
- **Not covered by any substitute** (row 3): the golden-frame diff, the screenshot sweep and the behavioral truthfulness audit. They are accepted as unverified for 0.15.0.
- **Growth after the waiver** is listed in §2 and named in the waiver's own later commits (9c9936948, 8d967010b, 8010962c7).

### 5.4 Pushes, tag, Publish and the later steps

All rest on one go, given 2026-11-06 after Andrew's own test: "Do one last quick sweep, make sure we are in the perfect position for this update, and then execute all the steps to put the official 0.15.0 update out. Let me know when your done". It answered a six-step list: push the release branch (CI, desktop builds, soaks); a paid model probe; sign the waiver; push the tag, then T0 and G1; Publish; the website deploy and the #122 reply. The paid probe was replaced by a free run on local Ollama (waiver §2); no owner words on that substitution are recorded. The go does not cover a trunk push, and none was made.

## 6. Platform, vendor and dependency residuals

- **No Mac hardware test.** Andrew's standing rule. macOS rests on the CI mac legs, the Developer ID check, notarization with a Gatekeeper verdict, the Intel installed acceptance and lifecycle-macos.
- **The real-vendor probe (`qa:model`)** ran on 79007c0b5 with the upload fix applied, free on local Ollama (native and the OpenAI-compatible wire, `qwen3:8b`): both PASS all eight checks. **Not probed:** OpenRouter and every paid or signed-in route (waiver §2).
- **Windows stop/boot cycles under soak: not covered** (waiver §3). The partial substitutes are the T0 and G1 lifecycle cases.
- **The three checks that existed only in the train** (waiver §3) ran green in 42350897656: the provenance step with its install-manifest scan on all three legs, the Developer ID signing check before notarization on both Mac legs, and the Windows published-upgrade proof. Bug 776f2cee (the Intel DMG strict-signature failure on a hash-matched download) stays open at P2, its cause unconfirmed.
- **Web-search floor in CI.** "The product search ladder returned no usable result" from a hosted IP on every pin (in the train, all three rungs failed: mojeek, duckduckgo-html and duckduckgo-lite). A rung that works from hosted IPs is the follow-up.
- **Dependabot: 19 open alerts on the default branch** (read at writing). That branch, origin `feat/harness-backend` at 74fcd5040, holds no 0.15.0 code until a trunk push.
  - **New: zip #18–20 (critical, high, medium), src-tauri/Cargo.lock.** They reach the app only through tauri-plugin-updater 2.10.1 (zip 4.6.1), which verifies the minisign signature before it extracts (updater.rs:712), so reaching them needs the updater key. Accepted for 0.15.0; bump when the plugin moves.
  - undici #10–#14: TIP pins the fixed 6.29.1. They stay open until the fix reaches the default branch.
  - sharp #3 (high), fast-uri #1 and #6–#9, glib #4, rustls #5 and #15–#17: as the 0.14.2 waiver listed them.

## 8. Known issues and not verified

**Shipped, known:**
- **macOS and Linux quit against a Windows hard kill.** A plain Quit on POSIX books the run, so no continue offer appears; a hard kill or crash stays recoverable everywhere. The notes make no promise otherwise.
- **The upload pass** (the notes' Known limits line covers the user-visible part): F4 and F5 (§2); a corrupt shadow repo still fails its entry at every retry (the other entries run and the uploads have gone by then; only the ledger stays open); a file a page delete could not remove is logged nowhere when no row names it; a kept file is not revisited; the page route never calls the checkpoint purge; `sessionUndo` is not read (Clear/Undo has no UI caller; scan it if one is wired); `proved:false` on page-only refs is not retried or surfaced; a /branch in another window not yet pushed, and two chats sharing an upload no row names deleted within the save debounce (known gaps from d2933f149).
- **The dev-only demo page** carries 40-odd stale scripts. It is not a shipped surface.
- **Linux recycled-PID cron lock** waits for the 8-minute age break (waiver §3; no shipped build runs on Linux).
- **Unchanged from 0.14.2:** the E-STOP half of 1ac8819d; Gemini 2.5 Flash and DeepSeek v3.1 tool calls through OpenRouter (64dbe836).
- **Not in 0.15.0:** the workflow marketplace, #157 and C13.

**Not verified for 0.15.0:**
- Paid and signed-in provider routes (§6) and Mac hardware.
- The Green Guardian checks (§5.3) and a 48-hour installed soak.
- The rollback's window-storage step, derived from 0.14.2's boot code and not run in a real WebView2 (waiver §2).
- POSIX kill(0) and unlink behaviour behind b53565c29, and a real locked transcript segment (errors were injected).
- G1's own not-covered list (§3.2).
- **Andrew's own UPDATE CENTER update.** His station runs a local 75cde9998 build, which is already 0.15.0, so UPDATE CENTER will not offer the release to it. The public canary stands in. Installing the published installer over it is offered to him.
- The updater-key attestation (§5.3).

## 9. Follow-ups

1. **The withheld token in tests.** `test/_httpToken.js` reads the page once; give it the page's own retry for a transient reason (`lookup-failed`, `peer-not-found`). Seen at step 105 on TIP, step 108 on 43ca869b7 and in 0.14.2's gates.
2. **aux-token-ceiling's `childrenDone`** takes a quiet gap between background passes for settled; wait for a named settled state instead.
3. **start-fresh-browser** keeps no station output when it fails; print it, so the next EPERM can be read rather than inferred.
4. **F4** (the transcript walk on the event loop) and **F5** (one lost segment doubts every later claim), from the late review.
5. **A corrupt shadow repo** keeps the forget ledger open (§8).
6. **A web-search rung** that works from hosted IPs, so the floor proves something in CI.
7. **The train's floor jobs end green while logging a failed floor.** Read the warnings, not the job colour.
8. **Procedure.** qa:beginner rewrites qa/STATUS.md during a gate run (the gate script stopped on the dirty tree after the last gate, harmlessly). The ritual's qa:ready row reads trunk's name; run the preflight with `SKYNET_GUARDIAN_TRUNK` set to the release branch. Preflight's lane row still says the tag goes on trunk after a merge, against waiver §5.
9. **zip in tauri-plugin-updater** (§6).

## 10. After Publish

| Step | Status |
|---|---|
| verify-host | **ALL CHECKS PASSED** (`<logs>/verify-host-v0.15.0.txt`): version 0.15.0, the three platforms, non-empty signatures, https URLs pinned to /download/v0.15.0/, every asset reachable (HTTP 200) |
| Public canary | 42357042717: SUCCESS on every job (§3.2) |
| Rollback | Not triggered. If it is ever needed: `gh release edit v0.15.0 -R androoAGI/starnet-releases --prerelease`, then `gh release edit v0.14.2 -R androoAGI/starnet-releases --latest`, then check that releases/latest names v0.14.2. Never edit v0.15.0's notes or latest.json to roll back. The one edit since Publish, the notes summary below, changed text only, at Andrew's request |
| Source mirror | 42357418696 success: v0.15.0 Latest on androoAGI/starnet (08:55:50Z) |
| Floors after Publish | 42357420606: update-host green; web-search still red (§6) |
| Website restamp | **d95089f04** on `agent/release-0150` (parent TIP): 0.14.2 → 0.15.0 in website/index.html (#ver-badge, span.ver, #ver-foot), website/pricing.html (#ver-foot) and website/site.js (FALLBACK_VERSION), a byte-exact swap. website-deploy-staging and website-app-sync pass |
| Website deploy | `npm run website:stage`, then `npx wrangler pages deploy website-deploy --project-name starnet-site --branch main --commit-hash d95089f04…`: production deployment **ecb52d13** (source d95089f). starnetos.com, www.starnetos.com, /pricing and site.js show v0.15.0 and no 0.14.2 (read at writing). The previous production deployment was ca6c04c8 (0.14.2) |
| Issue #122 | Replied at 08:56:47Z (issuecomment-6704758128): fixed in v0.15.0, with what changed and what the tests cover. Left open: closing it was not part of the go |
| Notes summary | Later on 2026-11-07, Andrew asked for the top of the notes to be "a summary of what the new update is", then for "just a basic description". Three plain sentences (469 characters) replaced the opening paragraph. The governor line was narrowed to "One governor admits nine kinds of paid call": it said "every paid call", but image reading books its cost after the call and never asks the governor. Nothing else in the notes changed. Commits on `agent/release-0150`: ffdb4dd65 with relock b0ddf4e75 (a first, longer draft), then bdc0174d8 with relock b721d4ea2 (the published text); claims PASS. Published 20:55:42Z–20:55:49Z after Andrew chose "Everywhere": the release body; latest.json, the same file with only `notes` replaced (e622d1c6… → **66de9b65…**; version, pub_date and URLs unchanged, each signature still equal to its `.sig`, the updater URL serving it, the other 8 assets untouched); and the source mirror's body, rebuilt by scripts/source-release-mirror.mjs (installers unchanged, action noop). verify-host: ALL CHECKS PASSED again (`<logs>/verify-host-v0.15.0-notes-edit.txt`). The app's update panel shows the first 520 characters: the summary and the "Upgrading, and going back" heading. The tag's RELEASE_NOTES.md keeps the shipped opening |
| This record | Committed by pathspec as `docs/releases/0.15.0/CUT_RECORD.md` on `agent/release-0150`, on top of d95089f04, and the branch pushed (no workflow runs on `agent/*` pushes). The notes-summary row was added afterwards |
| Merge-back | §11 |

## 11. Merge-back

- **Target.** Local trunk `feat/harness-backend` at **524b421a7** (read at writing), an ancestor of TIP. The release branch's commits since then never touch trunk's working changes (docs/NEXT.md, qa/STATUS.md, dev/.shots-class-builder/), so the merge-back is a **fast-forward** of local trunk to the release branch tip that carries this record: no merge commit, no conflict, nothing to resolve. The bug register and claims come across as the release branch has them (claims PASS, 37/396).
- **Gates.** TIP's gates (§4) cover everything but the restamp and this record; the restamp's tests and claims pass on d95089f04 (§4). No other file differs from TIP.
- **Not done: the trunk push.** It needs Andrew's go. Until it lands, origin's default branch (74fcd5040) carries no 0.15.0 code, so its Dependabot alerts, undici #10–#14 among them, stay open.

## 12. Status at writing

v0.15.0 is published and public, verified by verify-host and the public canary. The source mirror, the website and the #122 reply are done. This record lands with the branch push; the local fast-forward of trunk follows it, and its result is in the cut log. Open: the trunk push (Andrew's go), the second offline key copy (Andrew's), and the follow-ups in §9. Later the same day the notes' opening became a plain summary, at Andrew's request (§10, "Notes summary").

## Appendix A. Readiness outputs, verbatim

Copied byte for byte from the release session's files, except that `C:/Users/andro/gen-trees/_logs/release-0150/` is shortened to `<logs>/`. The waiver is committed beside this record.

### A.1 qa:ready on TIP (`<logs>/ready-71e207bed.txt`)

```text
NOT READY — 2 reasons

  1. Green Guardian last cycle: no guardian cycle recorded — run `npm run qa:guardian`
  2. Installed-exe smoke: installed app unverified — no installed-exe smoke stamp (the rc-soak runner has not written qa/installed/last-smoke.json)

receipts:
  [PASS] Ledger open P0/P1
        artifact: qa/findings/ (via ledger.mjs)
        value:    0 P0 · 0 P1 · 0 P2
        → no open P0/P1 findings
  [PASS] Bug register open P0/P1
        artifact: qa/bugs/ (via bugs.mjs)
        value:    0 P0 · 0 P1 · 31 P2
        → no open/claimed P0/P1 bugs
  [FAIL] Green Guardian last cycle
        artifact: qa/guardian-last-cycle.json
        value:    MISSING
        → no guardian cycle recorded — run `npm run qa:guardian`
  [PASS] Journey corps last run
        artifact: qa/journeys-last-run.json
        stamp:    2026-11-07T05:56:17.060Z
        value:    PASS · 139/139 assertions
        → PASS, 78m old
  [PASS] Beginner Run last result
        artifact: qa/beginner-last-run.json
        stamp:    2026-11-07T05:56:59.120Z
        value:    PASS · ui-only · 40919ms
        → PASS, 77m old
  [FAIL] Installed-exe smoke
        artifact: qa/installed/last-smoke.json
        value:    MISSING
        → installed app unverified — no installed-exe smoke stamp (the rc-soak runner has not written qa/installed/last-smoke.json)

trunk agent/release-0150 @ 71e207be · generated 2026-11-07T07:14:04.290Z
```

### A.2 Ritual (`<logs>/ritual-71e207bed.txt`)

```text
== release-ritual · target v0.15.0 ==

1. PREFLIGHT [skipped]
   bump already landed — the post-bump preflight (step 6) covers this

2. BUMP [done]
   pins already = 0.15.0 (release commit exists)

3. NOTES [done]
   RELEASE_NOTES.md has a real # StarNet v0.15.0 entry (no TODO, no HTML comment)

4. RELOCK [done]
   claims lock current for HEAD (qa(claims): re-lock the release surface for v0.15.0)

5. GATES [done]
   accepted <logs>/final-fast.log → fast gate green (1784 steps) at 71e207bed
   accepted <logs>/final-http.log → http gate green (357 steps) at 71e207bed
   test:fast green at HEAD (1784 steps, 2026-11-07T07:15:32.398Z) · test:http green (357 steps)

6. PREFLIGHT-POST [stopped]
   == release-preflight · phase post-bump · target v0.15.0 · in-tree 0.15.0 · agent/release-0150 @ 71e207bed ==
   [WARN] on trunk feat/harness-backend — on "agent/release-0150" (--allow-lane): bump + re-lock may happen here, but the TAG goes on trunk AFTER the merge (v0.10.7 pattern: release commit on lane → merge → tag the merge)
          fix: after merging: run the ritual again from the integration tree to tag
   [PASS] working tree clean — clean
   [PASS] five version pins agree — all five = 0.15.0
   [PASS] tag v0.15.0 not yet local
   [PASS] tag v0.15.0 not on origin
   [PASS] no release v0.15.0 on androoAGI/starnet-releases
   [PASS] claims lock current for HEAD — PASS claims planning authority · 37 claims · 396 locked surface files
   [PASS] website/app mirror in sync
   [PASS] test:fast green at HEAD — 1784 step(s) green · 2026-11-07T07:15:32.398Z · log <logs>/final-fast.log
   [PASS] test:http green at HEAD — 357 step(s) green · 2026-11-07T07:15:32.555Z
   [WARN] T0 clean-install proof for v0.15.0 — owed — runs on a fresh hosted Windows VM against the STAGED DRAFT (after the tag push)
          fix: Actions → t0-clean-install-proof → Run workflow → tag=v0.15.0 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
   [WARN] G1 packaged-lifecycle proof for v0.15.0 — owed — idle-close / close-to-tray / updater-smoke on a fresh hosted Windows VM against the staged draft (this is the branch 0.10.5/0.10.6 escaped through)
          fix: Actions → g1-packaged-lifecycle → Run workflow → tag=v0.15.0 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
   [WARN] installed-exe smoke stamp for v0.15.0 — owed — qa/installed/last-smoke.json absent
          fix: run `npm run qa:smoke:installed` against the exact candidate installer
   [WARN] 48-hour installed soak acceptance for v0.15.0 — manual acceptance review owed — installed smoke contains no elapsed duration or real-provider workload evidence
          fix: review the completed installed acceptance evidence against docs/RELEASE_READINESS.md §2; only an explicit owner waiver may replace it. This preflight does not infer completion or a waiver from a smoke stamp
   [FAIL] qa:ready verdict — NOT READY — 1. Green Guardian last cycle: no guardian cycle recorded — run `npm run qa:guardian` · 2. Journey corps last run: journeys did not run on the exact current trunk (71e207be vs 524b421a) · 3. Beginner Run last result: Beginner Run did not run on the exact current trunk (71e207be vs 524b421a) · 4. Installed-exe smoke: installed app unverified — no installed-exe smoke stamp (the rc-soak runner has not written qa/installed/last-smoke.json)
          fix: stop: do not bump, do not tag. `node scripts/qa/ledger.mjs --digest`, fix on trunk, re-run `npm run qa:ready` until READY (READY-GATE law, docs/RELEASE_READINESS.md)
   [PASS] updater signing key present — file exists (contents never read or printed)
   [SKIP] updater key backed up offline (≥2 copies) — unverifiable by machine — human attestation
          fix: runbook §4.1: confirm two offline copies exist before you push the tag
   [PASS] RELEASE_NOTES.md for v0.15.0 — header matches, no TODO scaffold, no HTML comment
   
   PREFLIGHT FAIL (PASS 11 · FAIL 1 · WARN 5 · SKIP 1) — 1 hard row(s) red. Do not bump, do not tag.
   STOP — 1 hard post-bump row(s) red
     fix them, then run this same command again (completed steps are skipped)

not reached: tag → push-stop
```

### A.3 Preflight after tagging (`<logs>/preflight-tagged-71e207bed.txt`)

```text
== release-preflight · phase post-bump · target v0.15.0 · in-tree 0.15.0 · agent/release-0150 @ 71e207bed ==
[WARN] on trunk feat/harness-backend — on "agent/release-0150" (--allow-lane): bump + re-lock may happen here, but the TAG goes on trunk AFTER the merge (v0.10.7 pattern: release commit on lane → merge → tag the merge)
       fix: after merging: run the ritual again from the integration tree to tag
[PASS] working tree clean — clean
[PASS] five version pins agree — all five = 0.15.0
[WARN] tag v0.15.0 not yet local — already tagged at HEAD — the tag step is done; nothing pushed yet
[PASS] tag v0.15.0 not on origin
[PASS] no release v0.15.0 on androoAGI/starnet-releases
[PASS] claims lock current for HEAD — PASS claims planning authority · 37 claims · 396 locked surface files
[PASS] website/app mirror in sync
[PASS] test:fast green at HEAD — 1784 step(s) green · 2026-11-07T07:15:32.398Z · log <logs>/final-fast.log
[PASS] test:http green at HEAD — 357 step(s) green · 2026-11-07T07:15:32.555Z
[WARN] T0 clean-install proof for v0.15.0 — owed — runs on a fresh hosted Windows VM against the STAGED DRAFT (after the tag push)
       fix: Actions → t0-clean-install-proof → Run workflow → tag=v0.15.0 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
[WARN] G1 packaged-lifecycle proof for v0.15.0 — owed — idle-close / close-to-tray / updater-smoke on a fresh hosted Windows VM against the staged draft (this is the branch 0.10.5/0.10.6 escaped through)
       fix: Actions → g1-packaged-lifecycle → Run workflow → tag=v0.15.0 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
[WARN] installed-exe smoke stamp for v0.15.0 — owed — qa/installed/last-smoke.json absent
       fix: run `npm run qa:smoke:installed` against the exact candidate installer
[WARN] 48-hour installed soak acceptance for v0.15.0 — manual acceptance review owed — installed smoke contains no elapsed duration or real-provider workload evidence
       fix: review the completed installed acceptance evidence against docs/RELEASE_READINESS.md §2; only an explicit owner waiver may replace it. This preflight does not infer completion or a waiver from a smoke stamp
[FAIL] qa:ready verdict — NOT READY — 1. Green Guardian last cycle: no guardian cycle recorded — run `npm run qa:guardian` · 2. Installed-exe smoke: installed app unverified — no installed-exe smoke stamp (the rc-soak runner has not written qa/installed/last-smoke.json)
       fix: stop: do not bump, do not tag. `node scripts/qa/ledger.mjs --digest`, fix on trunk, re-run `npm run qa:ready` until READY (READY-GATE law, docs/RELEASE_READINESS.md)
[PASS] updater signing key present — file exists (contents never read or printed)
[SKIP] updater key backed up offline (≥2 copies) — unverifiable by machine — human attestation
       fix: runbook §4.1: confirm two offline copies exist before you push the tag
[PASS] RELEASE_NOTES.md for v0.15.0 — header matches, no TODO scaffold, no HTML comment

PREFLIGHT FAIL (PASS 10 · FAIL 1 · WARN 6 · SKIP 1) — 1 hard row(s) red. Do not bump, do not tag.
```
