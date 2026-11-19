# StarNet v0.15.3: cut record

The record of how v0.15.3 was cut, gated and published. Written on 2026-11-19 after Publish, from about 08:33Z. Sections 9 to 11 were written last and carry their own read times.

- **TIP is the tagged commit.** This file lands on `agent/release-0153` after the tag. It is not part of what shipped.
- **Sources.** The release session's cut log (`gen-trees/_logs/release-0153/PLAN.md`, which continues `gen-trees/_logs/release-0152/PLAN.md`), the committed waiver `docs/releases/0.15.3/SOAK_WAIVER.md`, the local gate logs and receipts in `gen-trees/_logs/release-0153/` (written `<logs>/` below; not in this repo), the pre-Publish audit digest `<logs>/prepublish-audit.txt`, the release session's transcript for Andrew's words, and the CI runs and their logs. Repo paths are written in full.
- **"Read at writing"** marks a fact read with a read-only `gh` or `git` query while this record was written. Every run ID, commit, count, time and digest here was read that way or from an evidence file. A fact that could not be read is marked "not confirmed".
- **Later entries win.** Pins before TIP were superseded. Their runs are history (§3.4), not proof of TIP.
- **Quoted output is verbatim.** Text in code blocks is copied from tool output and keeps that tool's punctuation.

## 1. Identity

| Item | Value |
|---|---|
| Version | 0.15.3. All five version pins agree (preflight row PASS) |
| Tag | `v0.15.3`, lightweight, made on TIP outside the ritual with `<logs>/tag-push.sh` (waiver §4 and §5). `git describe --tags --exact-match` printed `v0.15.3`. Origin `refs/tags/v0.15.3` = TIP (read at writing) |
| TIP | **8dbbf0446294bca1f1fc9aad292f2b470e459b58**, "qa(claims): re-lock the release surface for v0.15.3" |
| Branch | `agent/release-0153`: a branch-based cut, the written exception in waiver §5, as v0.14.1, v0.14.2 and v0.15.0 were. Origin `agent/release-0153` = TIP (read at writing) |
| Base | The tag `v0.15.2` = **09697b6f9**, pushed 2026-11-18T17:20:39Z and never published (§2). The last public release before this one is v0.15.0 = 71e207bed |
| Commits | 17 in v0.15.2..TIP, none a merge. 620 in v0.15.0..TIP, 69 of them merges (read at writing) |
| Hygiene | All 17 release commits are authored and committed by andro, with empty `%(trailers:only)`. In v0.15.0..TIP all 620 commits carry the author name andro and one author address, and no co-author, generated-with or signed-off trailer. Six merge subjects in v0.15.0..v0.15.2 name a branch (five `agent/*`, one `feat/harness-backend`); they were public with the v0.15.2 tag and none is among the 17. `shared/` is unchanged in v0.15.0..TIP |
| Size | v0.15.2..TIP: 21 files changed, 349 insertions, 32 deletions. v0.15.0..TIP: 1171 files changed, 77815 insertions, 2933 deletions |
| Bump | a7e6ee0d6 `release: v0.15.3`, then notes e916dc4e7, waiver c519ed469 and relock 170681fde |
| Tag push | 2026-11-19T02:46:34Z (21:46 EST on 11-18), the tag alone. It started release-train 44446754903 at 02:46:39Z |
| Published | **2026-11-19T08:30:05Z** (03:30 EST), by `gh release edit v0.15.3 -R androoAGI/starnet-releases --draft=false --prerelease=false --latest` (cut log; `<logs>/publish-time.txt` reads 08:30:04Z). releases/latest = v0.15.3 (read at writing) |
| Release | https://github.com/androoAGI/starnet-releases/releases/tag/v0.15.3, named "StarNet 0.15.3": 9 assets (the Windows installer and its `.sig`, two DMGs, two Mac updater archives and their `.sig` files, and latest.json) |
| Notes | RELEASE_NOTES.md at TIP is 34825 bytes with 81 bullets and no CR. It differs from the v0.15.2 notes by 4 insertions and 3 deletions: the title, two bullets renumbered from 0.15.2 to 0.15.3, and one new bullet for the model list. The word "soak" does not appear |
| Claims | `claims.mjs` PASS: 37 claims, 400 locked surface files (preflight row) |

**Shipped installers** (GitHub's SHA-256 digests of the published assets, read at writing):

| Asset | SHA-256 |
|---|---|
| StarNet_0.15.3_x64-setup.exe | 12c398a002abd10528be9867127cf61b4649dd7f7ca0cdb74715fe4a1dd02674 |
| StarNet_0.15.3_aarch64.dmg | 4424a1b01227867c24dc5ae56eb5d6d90d99ad570dcecc4a01de0e83ab584ff2 |
| StarNet_0.15.3_x64.dmg | c4554845d17d907bdea1f21d52c478ab21ecf254bc6e70f96e5862be7ff5d2e7 |

The Windows installer is 462488912 bytes. The train's published-upgrade proof, the draft T0 proof file and the public canary's receipt each name the same Windows hash.

**latest.json** (digest cd8bff358b30beba04be6259e06bf2ab2145af881d741c5ece1a2264a9ce6026, 36875 bytes) has version 0.15.3 and the platforms windows-x86_64, darwin-aarch64 and darwin-x86_64, each URL pinned to `/download/v0.15.3/`. Its pub_date is 2026-11-19T04:11:14.157Z. The copy saved from the draft (`<logs>/draft-0153/latest.json`) has the same digest as the published asset, so Publish changed nothing in it. On the draft, `<logs>/draft-review-0153.txt` ends `DRAFT REVIEW: OK`: each signature equals its `.sig` asset, the `notes` equal the tagged RELEASE_NOTES.md without the file's final newline (34796 against 34797 characters), and the release body equals the file.

## 2. What changed late

**Why 0.15.2 was never published.** v0.15.2 was tagged at 09697b6f9 and its tag pushed at 2026-11-18T17:20:39Z. Its first train (44357622398) went red in the Windows build at the new update signer gate. A second train (44369504890), dispatched from a repaired ref, had its arm64 macOS build cancelled (the 0.15.2 cut log: no runner was acquired), so no draft was staged. While that train ran, Andrew stopped the release for a display bug: the model list hung out of a narrow COMMS panel. His words are in waiver §6: "WAIT", then "There is a cosmetic bug that was unfortunately just found … better off that we fix it before release". A pushed tag is never moved, so the fix took the next version. No v0.15.2 release or draft exists on starnet-releases (read at writing), and the v0.15.2 tag stays where it is.

His go for this version, 2026-11-18T20:22:54Z: "the issue is fixed and merging now please stay on top of this once its merged lets go FULL blast". The cut log read it as the same cut for the fixed build, stopping before Publish.

**The 17 commits, by pin.** Each pin ends in a claims relock; each later pin also adds one waiver commit naming its fix.

| Pin (commit time, EST, 11-18) | Added on top of the previous pin |
|---|---|
| 170681fde (15:25) | On v0.15.2: fbd7a83ce and 5df6a0364 (release workflows and their structural test), a5c5f1263 (update signer check), ef1abf1f7 (the model list fix), a7e6ee0d6 (the bump), e916dc4e7 (notes), c519ed469 (waiver). Relock. First push of the branch, 20:30Z |
| 920fd4d5f (15:57) | b4957f440 (browser profile removal keeps trying), waiver c38c471dc. Relock |
| 82ecf20be (16:31) | 186141cb7 (the removal never takes a newer browser's directory), waiver b4c1935a3. Relock. This pin had a full CI round and a green pre-tag T0 |
| **8dbbf0446 (19:42) = TIP** | ec9dd73a6 (test rig only), waiver dd31b6216. Relock |

- **The model list fix, ef1abf1f7.** CSS in `frontend/css/app.css` and `frontend/css/glass-comms.css`, their website mirrors, and a pinned test (`test/comms-popup-fit.test.cjs`). It is the fix from another lane (fa8707535 on local trunk), picked unchanged. The cut log records a live proof on this branch: the list stays inside COMMS at 300, 360, 420 and 547 px and at TEXT SIZE 90 to 145, and a control with the cap lifted spills 73 px.
- **The update signer check, a5c5f1263.** One Rust file, `src-tauri/src/update_verify.rs`. The check now gives its Windows PowerShell child that shell's own module folder. In v0.15.2 an app started from a PowerShell 7 session refused every update as "unreadable"; the first v0.15.2 train found it because its Windows gate step runs in PowerShell 7. No user had it: the check does not exist in v0.15.0. fbd7a83ce and 5df6a0364 are workflow and test only: `desktop-build` now rehearses both update signer gates before a tag exists.
- **The browser profile removal, b4957f440 and 186141cb7.** One product file, `sidecar/tools/builtin/browser.js`. The first CI round of this branch left a run's temporary profile behind on Linux (§3.3). The removal now keeps trying for about five more seconds. A review of that change found that the web reader reuses one profile directory, so the waiting removal could have taken a newer browser's directory; 186141cb7 counts browser starts per directory and stops the removal when a newer one has started. `test/browser-close-cleanup.test.js` covers five cases.
- **The test rig fix, ec9dd73a6.** `test/helpers/prefix-rig.js` and `test/prefix-lanes.e2e.test.js` only. It moved TIP after a full round on 82ecf20be (§4.2).
- **Not in 0.15.3.** The local trunk's commits that 0.15.2 left out, the tail-floor chat scroll change among them (no `tailfloor` file is in the tagged tree), and everything the local trunk gained since. In all, 27 local trunk commits are not in TIP at writing (§10).
- **Reviews** (cut log): an adversarial review of the 0.15.3 changes on 170681fde, no blocker and no major; an independent review of b4957f440, which reported four minor defects and no blocker: the web reader successor race became 186141cb7, and the other three (shutdown can drop the removal note, a failing removal holds the run's slot about 5 s longer, no test covers the loop) were not fixed (§7, §8 item 7); a review of ec9dd73a6, no blocker and no major (`<logs>/review-pin-fix.txt`); and the pre-Publish audit, no blocker (`<logs>/prepublish-audit.txt`).
- **Two slips by the release session.** The local gates on 920fd4d5f were started while another session's gate held the gate slot; they were stopped at 21:07Z and count for nothing. The first pre-tag T0 dispatch on TIP omitted two inputs (§3.1).

## 3. CI, train, draft and public runs

### 3.1 CI on TIP

Dispatched by hand on `agent/release-0153` (`agent/*` pushes trigger nothing), headSha = TIP, every run on attempt 1. secret-history ran alone first.

| Run | Workflow | Result |
|---|---|---|
| 44431178475 | secret-history | Green |
| 44431409881 | fast-gate | Green, all 11 jobs: gate 1/4 to 4/4, journeys, http-gate 1/4 to 4/4, rust-policy, webkit-floor |
| 44431414028 | floor-canaries | Run conclusion failure, on two floors only: update-host and web-search. voice, openrouter-catalog, models-dev-prices, google-signin, codex-device, github-device and web-fetch green. update-host cannot pass before Publish and was green after it (§9). web-search is red from hosted IPs (§6) |
| 44431417753 | soak | Green: the soak job (60 runs ok, 0 failed) and the scale job (22 runs ok, 0 failed) both end `[soak] VERDICT: PASS`. **The soak job's rss rule passed at 1.959 MB/min against a limit of 2** (growth 9.3% against a limit of 20%, a 9.54-minute window, 141.8 to 162.3 MB, peak 179.3). The scale job's rss rule is NOT JUDGED (3.26-minute window). The same rule read 1.452 on 82ecf20be (44404542712) and 1.798 on v0.15.0's TIP (42336462042) |
| 44431421764 | desktop-build | Green: builds for darwin-arm64, darwin-x64, linux-x64 and win-x64; notarize-macos ×2; intel-macos-installed-acceptance; publish-test skipped. The new rehearsal steps passed: the update signer gate on the signed Windows installer, and on the updater archive on both Mac legs |

The TIP installer from 44431421764 is `StarNet_0.15.3_x64-setup.exe`, sha256 c0a228a3e7d7c251888ae6b4836e73c80a78b6b2d970dbfd4069bd7792d3a184, 462495520 bytes. **It is not the shipped installer.** The train built again from the same commit and produced 12c398a0… (§1).

**Pre-tag T0 44437606207** (01:31:58Z to 01:38:56Z) on the c0a228a3… installer, with `baseline_tag=v0.15.0`: **green**, steps 3 to 15 success, only the draft download skipped. Evidence is in `<logs>/t0-pretag-8dbbf0446/`.

- Clean-install proof (schema starnet.clean-install-proof.v1): cdpProven true, pageTitle STARNET, sourceCommit TIP, buildRun 44431421764.
- Candidate lifecycle PASS with failedCases []: idle-close, close-to-tray, updater-smoke, kill-relaunch and cli-app-closed.
- Upgrade continuity from v0.15.0 (baseline installer c5136ef3…, the published v0.15.0 digest): PASS, all 6 checks true. Its mode is `manual-nsis-reinstall`: the candidate installer run over an installed 0.15.0, not the in-app updater.
- Installed smoke GREEN, 9/9 checks, appVersion 0.15.3, buildCommit and expectedHead both TIP, tree e8be14cef.
- The installed delegated-connectors, saved-provider-fallback, session-reliability and spend-authority suites passed.

**An earlier dispatch, 44437031765, is not the proof.** It ran on TIP and went green, but it was dispatched without `baseline_tag` and `candidate_manifest`, so its continuity step, its installed-suite step and their evidence step were skipped (read at writing). 44437606207 replaced it.

### 3.2 Tag, draft and public runs

The train, the draft T0, the draft G1 and the public canary ran on ref v0.15.3 with headSha = TIP. The floor-canaries run after Publish ran on `agent/release-0153` (headSha = TIP). sync-source-release ran on the default branch `feat/harness-backend` at e316231d7; it mirrors the published release and does not build from its own ref.

| Run | What | Result |
|---|---|---|
| 44446754903 | release-train, on the tag push | **SUCCESS** on attempt 1 in 1 h 28 m, all 20 jobs: gate (27.7 min), build ×3, webkit-floor-boot, the floor jobs, notarize-macos ×2, intel-macos-installed-acceptance, assemble and stage-draft. Details below |
| 44457081204 | T0 on the draft | **SUCCESS**, in draft mode (04:15:38Z to 04:17:04Z): the staged installer (12c398a0…, 462488912 bytes) downloaded, installed silently, first launch proven over CDP, pageTitle STARNET. Its lifecycle, continuity and installed-suite steps are skipped in this mode (steps 8 to 15 skipped, read at writing) |
| 44457085315 | G1 on the draft, default cases | **SUCCESS** (04:15:40Z to 04:19:53Z). Windows verdict PASS: idle-close, close-to-tray, updater-smoke (exe 0.15.3, tag feed 0.15.3, public feed 0.15.0), kill-relaunch and cli-app-closed. lifecycle-macos verdict PASS: kill-relaunch and cli-app-closed. Not covered, by its own list: tray menu Quit, the armed-work residency branch, macOS window cases, Linux |
| 44488215328 | G1 public canary (`public_canary=true`, `baseline_tag=v0.15.0`), after Publish | Attempt 1 **failure** on the public-updater-canary job; attempt 2, a re-run of that job, **success** with all 10 checks true. Windows lifecycle 5/5 and macOS 2/2 passed in attempt 1. Details in §9 |
| 44488221437 | floor-canaries on `agent/release-0153`, after Publish | update-host **green**; web-search red (the run's only red); voice and the other floors green (§9) |
| 44488228057 | sync-source-release, after Publish | Success: v0.15.3 is Latest on androoAGI/starnet (§9) |

**Inside the train (read from its job list and logs at writing):**

- **Built from the tag.** The Windows job logged `provenance: describe=v0.15.3 commit=8dbbf0446 (clean tree)` and `build binary contains commit stamp '8dbbf0446'`. The provenance step passed on all three build legs.
- **Windows.** Authenticode valid and timestamped on the installer, the installed executable and the uninstaller (CN=Andrew Sims). The update signer gate admitted the signed installer and refused both controls. The published-upgrade proof passed on the installer with sha256 12c398a0…: `v0.15.0 -> 0.15.3` and `v0.14.2 -> 0.15.3`, each with "upgrade, installed integrity, active-process uninstall and state-preservation assertions passed". This proof runs the installer over an old install; it is not the in-app updater.
- **Mac.** On both legs: the Developer ID signing check before notarization, the update signer gate on the updater archive, and the notarization submit. Both notarize jobs passed their "staple, and prove Gatekeeper verdict" step. The Intel installed acceptance passed.
- **The floors are report-only in the train, and two were red inside it.** The jobs `floors (update-host)` and `floors (web-search)` conclude success, but both ran with `REPORT_ONLY: true` and logged `"ok":false`: update-host "the product update verifier failed or timed out", web-search "the product search ladder returned no usable result" (mojeek 403, both DuckDuckGo rungs 202). The train's green does not mean those two floors passed.
- **The updater key password is empty in CI.** The Windows build step printed `TAURI_SIGNING_PRIVATE_KEY_PASSWORD:` with no value, and the source repo's 12 Actions secrets include `TAURI_SIGNING_PRIVATE_KEY` (last updated 2026-07-06) and no password secret (names only, read at writing). See §5.3.

### 3.3 Specific failures

- **fast-gate 44392087525 on 170681fde, http-gate 4/4.** `browser-signin-survives.e2e`: "FAIL: the copy of the sign-ins leaves with the run", after `[failopen] browser.profile.rm (x1): ENOTEMPTY` on the run's temporary profile (`<logs>/ci1-http4-failed.log`). A product finding on Linux: the one-second removal retry was not always enough. Fixed by b4957f440; the same shard was green on 82ecf20be and on TIP.
- **Pre-tag T0 44410871096 on 82ecf20be, attempt 1.** Red in the third installed suite: `Could not connect to CDP on 58841` (`<logs>/t0-pretag-failed.log`). The harness's own Chrome did not open its debug port within `connectCDP`'s 40 tries of 250 ms. Attempt 2 (`--failed`) was green on the same SHA and installer. Read as a readiness red, not a product red.
- **Local HTTP on 82ecf20be: 400/401.** §4.2. It moved TIP.
- **The partial T0 dispatch on TIP, 44437031765.** §3.1. Green, and not a proof.
- **The public canary's first attempt after Publish, 44488215328.** Red at the same `connectCDP` limit, at the first launch of the installed v0.15.0 baseline, before any check ran. Attempt 2 passed (§9).
- **v0.15.2's trains (history).** 44357622398, on the v0.15.2 tag push: the win-x64 build failed and the run was cancelled. The 0.15.2 cut log gives the step, "Gate the signed installer through the shell's own update signer check", and the cause, PowerShell 7's module path inherited by the check's PowerShell 5.1 child, reproduced locally; a5c5f1263 is the product fix. 44369504890, dispatched from fbd7a83ce with `tag=v0.15.2`: conclusion failure, the arm64 build cancelled and notarize, assemble and stage-draft skipped (read at writing).

### 3.4 Superseded runs (history, not evidence for TIP)

| Tree | Runs |
|---|---|
| 170681fde | secret-history 44391746927 green · fast-gate 44392087525 red (http-gate 4/4, §3.3) · floor-canaries 44392096014 red (update-host, web-search) · soak 44392103329 cancelled · desktop-build 44392109744 cancelled |
| 920fd4d5f | secret-history 44396660742 green · fast-gate 44396951125, soak 44396962909 and desktop-build 44396968798 cancelled when the tip moved · floor-canaries 44396956845 red (update-host, web-search) · local gates stopped at 21:07Z |
| 82ecf20be | secret-history 44404256644 green · fast-gate 44404528609 green · floor-canaries 44404535687 red (update-host, web-search) · soak 44404542712 green · desktop-build 44404550188 green (installer 6f6872ba…) · T0 44410871096 red on attempt 1, green on attempt 2 · local, receipts in `<logs>/round-82ecf20be/`: claims OK (64), FAST 1883/1883, HTTP 400/401 with step 330 red, journeys 139/139, beginner PASS · qa:ready dry run NOT READY on rows 3 and 6 only |
| 8dbbf0446 (TIP) | T0 44437031765: green, partial, replaced by 44437606207 (§3.1) |

## 4. Local gates on TIP

All ran in the release worktree at TIP, one at a time. Each receipt names TIP's sha and records `dirty: 0 entries` before the run. The shared gate slot log (`gen-trees/_logs/gate-slot-1101.txt`) shows this round ACTIVE at 00:42Z and RELEASED at 02:42Z with no other entry between. Logs and receipts are in `<logs>/`.

| Gate | Result | Evidence |
|---|---|---|
| Claims test | OK, 64 assertions, 00:42:35Z to 00:44:25Z | final-claims.log/.receipt |
| test:fast, whole list, default configuration | **1883/1883 green**, 00:44:26Z to 01:24:01Z | final-fast.log/.receipt; the ritual accepted the log at 8dbbf0446 (1883 steps, 02:43:37Z) |
| test:http, whole list, **deadline raised** | **401/401 green**, 01:24:01Z to 02:41:01Z (77 min), one run, exit 0. Run as `node scripts/run-test-list.mjs test/http.list --deadline=7200000`, not as `npm run test:http`: the list takes longer than that script's 57-minute deadline. Waiver §2 states this exception. The direct run also drops the 60-minute `scripts/timeout.mjs` wrapper that `npm run test:http` adds; nothing else differs from the default | final-http.log/.receipt; the ritual accepted the log at 8dbbf0446 (401 steps) |
| qa:journeys | **PASS 139/139**, 02:41:01Z to 02:41:34Z | final-journeys.log/.receipt |
| qa:beginner | **RUN PASS**: 6 steps in 44461 ms, stopping at the ui-only boundary as designed. It rewrites its own qa/STATUS.md row, so its receipt reads `dirty-after: 1 entries`. That one file was restored with `git checkout -- qa/STATUS.md` at 02:42Z and nothing was committed: the preflight at 02:43Z reports a clean tree, and the worktree is clean at HEAD = tag at writing | final-beginner.log/.receipt |

### 4.1 Receipt lint

`scripts/qa/receipt-lint.mjs` read both gate logs. Its last line for each log and its verdict (`<logs>/receipt-lint-8dbbf0446.txt`, in full in Appendix A.3):

```text
receipt-lint: final-fast.log — 1883 step(s) (1883 ok, 0 red): 0 false green(s), 3 allow-listed
receipt-lint: final-http.log — 401 step(s) (401 ok, 0 red): 0 false green(s), 0 allow-listed
receipt-lint: OK — every run read to its tally, and no ok step printed an unlisted error signal in 2 log(s) (3 allow-listed step(s); review the allow-list at every cut)
```

The three allow-listed fast steps are nav-coach-dismiss, channels.hub and channels.parity. No step on TIP was red, so no red needed a disposition on TIP.

### 4.2 The red on 82ecf20be: HTTP 400/401

The first whole local HTTP run of this branch ran on 82ecf20be, 2026-11-18T23:18:56Z to 2026-11-19T00:36:40Z, and ended with exit 1 and 1 of 401 steps failed (`<logs>/round-82ecf20be/final-http.log/.receipt`). The other 400 steps were green.

| Step | Failure | Cause | Disposition |
|---|---|---|---|
| 330 `test/prefix-lanes.e2e.test.js` | exit 1, "5 problem(s), 276 ok". Five "BYTE-IDENTICAL to the base 57c741da7" assertions failed: the request hash differed in four lanes and the CLI stdin hash in one, while every system and tools hash matched | The Windows recording (`test/fixtures/prefix-lanes-golden.json`) was made when the app version was 0.15.2. It hashes the whole request, and one line of the request states the app version. The bump to 0.15.3 moved that line only. Linux CI has no recording for its platform and skips the comparison, so no CI run could see it | Not rerun until green. Reproduced alone (cut log), then fixed in the test rig: ec9dd73a6 reads that one line as 0.15.2. The fixed test ends `prefix-lanes.e2e: OK (281 assertions)`; a mutant that reads it as another version fails the same five assertions (`<logs>/prefix-lanes-fixed.log`, `prefix-lanes-mutant.log`). The recording is untouched |

- **Product effect: none.** No product file changed. The red was a test recording pinned to a version string.
- **Cost.** A test-only commit still moved TIP: waiver dd31b6216, relock 8dbbf0446, then secret-history, the whole CI round, the pre-tag T0 and every local gate again on the new TIP (§3.1, §4). On TIP, step 330 is `ok 18.1s`.

## 5. Readiness, waiver and owner approvals

### 5.1 qa:ready on TIP: NOT READY, 2 reasons, both inside the waiver

Run as `SKYNET_GUARDIAN_TRUNK=agent/release-0153 node scripts/qa/ready.mjs` at 02:42:39Z (Appendix A.1).

| Check | Result |
|---|---|
| 1. Ledger open P0/P1 | PASS: 0 P0, 0 P1, 0 P2 |
| 2. Bug register | PASS: 0 P0, 0 P1, 31 P2 |
| 3. Green Guardian | FAIL: no cycle recorded. Waived (waiver §4, row 3) |
| 4. Journey corps | PASS, 139/139, on TIP |
| 5. Beginner Run | PASS (ui-only, 44461 ms). Earned, not waived |
| 6. Installed-exe smoke | FAIL: the stamp on this machine is GREEN for v0.15.2 at 28191379, Andrew's installed test build, not for TIP. Waived (row 6): earning it means installing the TIP build over his real station. The substitute is pre-tag T0's installed smoke, GREEN 9/9 and bound to TIP, on the desktop-build installer (§3.1), plus T0 and G1 on the draft |

### 5.2 Ritual and preflight

- **Ritual** (`<logs>/ritual-8dbbf0446.txt`). Steps 1 to 4 were done or skipped (the bump had landed; notes real; claims current). Step 5 accepted final-fast.log (1883 steps) and final-http.log (401 steps) at 8dbbf0446. Step 6 stopped on the one waived FAIL; "not reached: tag". The tag was made and pushed by hand, as waiver §4 says.
- **Preflight before the tag** (`<logs>/preflight-8dbbf0446.txt`): PASS 11, FAIL 1, WARN 5, SKIP 1.
- **Preflight after tagging** (`<logs>/preflight-tagged-8dbbf0446.txt`, Appendix A.2): PASS 10, FAIL 1, WARN 6, SKIP 1. The one FAIL is the qa:ready verdict, with only rows 3 and 6, as waiver §4 allows. The WARN rows are: on the lane with `--allow-lane`; already tagged at HEAD; T0 and G1 owed at that point (run on the draft, §3.2); the installed-exe smoke stamp is for 0.15.2; the 48-hour installed soak (waived). The SKIP row is the offline key backup, a human attestation (§5.3). Every other row is PASS, among them the five version pins, the claims lock (37 claims, 400 files), the website/app mirror, test:fast (1883 steps) and test:http (401 steps) at HEAD, and the signing key present (contents never read).

### 5.3 The waiver

- `docs/releases/0.15.3/SOAK_WAIVER.md` is committed on TIP (its last commit is dd31b6216). It was written before the tag with its signature open: its §6 says Andrew's earlier answers did not name the waiver, and that his explicit yes would be asked for in the pre-Publish report.
- **The 12-hour source soak (`qa:soak:release`) and the 48-hour installed soak were not run.** They are waived. The scripted soaks are kept: soak 44431417753 is green on TIP, with its rss slope at 1.959 MB/min against a limit of 2 over a 9.54-minute window (§3.1). That figure is the only memory signal in this release's evidence.
- **Its §6 blanks, filled here.** The committed file is not edited, because that would move the pin.
  - **Andrew's explicit yes:** given 2026-11-19T08:29:34Z, "Publish, waive soaks" (§5.4).
  - **TIP:** 8dbbf0446294bca1f1fc9aad292f2b470e459b58.
  - **Waived checks at cut time:** row 3 (Green Guardian) and row 6 (installed-exe smoke). Row 5 (beginner) was earned on TIP and its conditional waiver was not used.
  - **Spend:** none. No paid probe ran, and `qa:model` was not run again (waiver §2).
  - **Offline updater-key backup:** Andrew's, still open. One off-box copy is on record since 2026-10-31; the second is not attested, and the preflight row stays SKIP. The pre-Publish report asked "Do you have a second offline copy?" and the question was asked again after Publish at 08:33Z. He has not answered at writing.
- **Also open with the key: runbook §4.4.** The key that signed v0.15.3 has an empty password in CI (§3.2), so the passphrase step of runbook §4.4 is not done. The pre-Publish report told Andrew this. It does not affect the published files or their signatures.
- **Not covered by any substitute** (row 3): the golden-frame diff, the screenshot sweep and the behavioral truthfulness audit. They are accepted as unverified for 0.15.3. The dashboard look changed in this release.

### 5.4 Pushes, tag, Publish and Andrew's words

All times are from the release session's transcript.

- **The go for this cut, 2026-11-18T20:22:54Z:** "the issue is fixed and merging now please stay on top of this once its merged lets go FULL blast". The branch push, the tag push and the staged draft rest on it and on the earlier answers quoted in waiver §6. Those earlier answers ("Yes, push and tag", "I approve proced") were given for v0.15.2; no separate tag approval naming v0.15.3 is recorded. Earlier the same day (17:46:57Z, while 0.15.2 was still the candidate) he wrote: "let me know when we are ready to publish I want to get this update out very soon".
- **The pre-Publish report, 2026-11-19T04:26:30Z.** It named: the 12-hour and 48-hour soaks not run, with the CI soak's memory growth of 1.96 MB/min against a limit of 2; the two red readiness rows (no Guardian cycle; the installed-smoke stamp from his 0.15.2 test build); the Mac builds proven on CI machines only; one off-box updater-key backup on record and a key with no passphrase; and the web-search canary red from GitHub's machines. It ended with the question: "Publish v0.15.3 now, shipping without the two long soaks: "Publish, waive soaks" or "Not yet"?"
- **His answer, 2026-11-19T08:29:34Z:** "Publish, waive soaks". Publish followed at 08:30:05Z.
- **What the report did not name.** The raised HTTP deadline (waiver §2) and the branch-based tag (waiver §5) are in the committed waiver but were not listed in the report text, and the report did not ask him to approve the waiver document as a whole. The pre-Publish audit had said the report should name all six waiver items. No owner words cover these two exceptions. They were told to him after Publish, in the release session's closing report.
- **Not covered by any go:** a trunk push, a website deploy and the merge-back. None was made (§9, §10).

## 6. Platform, vendor and dependency residuals

- **No Mac hardware test.** As for 0.14.2 and 0.15.0, and named in the pre-Publish report. macOS rests on hosted CI machines only: the train's Mac legs, the Developer ID check, notarization with a Gatekeeper verdict, the Intel installed acceptance and G1's lifecycle-macos job.
- **The deep installed proofs ran on a sibling build.** The four installed suites, the installed smoke and T0's v0.15.0 continuity ran on the desktop-build installer (c0a228a3…). The shipped installer (12c398a0…) is another build of the same commit. On the shipped bytes the proofs are: the train's provenance stamp, Authenticode, the update signer gate and the published-upgrade proof from 0.15.0 and 0.14.2; the draft T0 clean install and first launch; G1's lifecycle cases; and the public canary (§9).
- **Web-search floor: no green proof for this release.** It was red on every pin (§3.4), red on TIP (44431414028), red inside the train and red after Publish (§9), each time from a hosted IP. The audit found no local run of that floor in the evidence for 0.15.2 or 0.15.3. `sidecar/tools/builtin/web.js`, `scripts/canary/floors.mjs` and `scripts/verify-update-host.mjs` are unchanged in v0.15.0..v0.15.3 (read at writing), so the red is not a change in this release.
- **Train floors are report-only** (§3.2). Only the voice floor blocks the train.
- **The real-vendor probe (`qa:model`)** was not run on 0.15.3. It ran on the 0.15.2 candidate against free local Ollama (0.15.2 cut log: PASS 8/8 on three wires). **Not probed:** OpenRouter and every paid or signed-in route.
- **Windows stop/boot cycles under soak: not covered** (waiver §3; the CI soaks run on ubuntu). The partial substitutes are the T0 and G1 lifecycle cases.
- **The one-time permission upgrade from a real 0.15.0 station on a second machine: not exercised** (waiver §3).
- **Dependabot: 14 open alerts on the default branch** (read at writing): zip #18 to #20 (critical, high, medium), sharp #3 (high), fast-uri #1 and #6 to #9, glib #4, rustls #5 and #15 to #17. That branch, origin `feat/harness-backend` at e316231d7, is v0.15.0 plus 7 commits and holds no 0.15.2 or 0.15.3 code until a trunk push.
- **Six merge subjects name a branch** (§1). One names an advisory ID. They are ancestors of the public v0.15.2 tag and cannot be changed without rewriting public history.

## 7. Known issues and not verified

**Shipped, known:**

- **The items waiver §3 lists as "Known and shipping"**, unchanged from 0.15.2 and each in the release notes: Full Access can be asked about once more after it is given back; the upgrade notice can be missed; a partly restored backup leaves two RESUME doors on different saves; a bare "ok" after a general sign-off can start a work run; a Mac on 0.15.0 installed on another disk cannot take the update in-app; three cost controls are on by default and the notes claim no saving. The notes send that Mac user to the website, whose static text says v0.15.0 when its live lookup fails (§9).
- **`browser.js`, not in the notes** (audit minor): the newer-browser guard reads its baseline late in close(), after the earlier waits, so a successor started before that point is not seen. The directory is the web reader's throwaway profile with no sign-ins; the worst case is a failed web search or fetch that relaunches. A failing removal holds a run's slot about 5 s longer.

**Not proven for 0.15.3:**

- The 12-hour and 48-hour soaks (not run), and memory beyond the CI soak's 9.54-minute window at 1.959 MB/min against 2.
- The installed suites and T0's v0.15.0 continuity on the shipped installer bytes (§6).
- The in-app update from 0.15.0 through UPDATE CENTER beyond one passing run: the public canary failed its first attempt before any check and passed its second (§9). It ran on a hosted Windows VM only. No in-app update on macOS was run.
- The update-host and web-search floors at tag time: red inside the train, report-only (§3.2). update-host went green after Publish; web-search has no green run.
- Mac hardware; paid and signed-in provider routes.
- The Green Guardian checks (§5.3).
- G1's own not-covered list (§3.2).
- The model list fix outside its sweep: run-time cards in COMMS, widgets, Build Mode and the real desktop shell were not covered (waiver §2).
- The second offline updater-key copy, and a passphrase on the key (§5.3).
- **Andrew's own UPDATE CENTER update.** His station runs a local 0.15.2 test build (28191379), so UPDATE CENTER should offer 0.15.3 to it. Whether it did is not confirmed. That build carries the update signer check without a5c5f1263: started from a PowerShell 7 terminal it would refuse the update as "unreadable" (0.15.2 cut log). No published version has that fault; `update_verify.rs` is absent at v0.15.0.

## 8. Follow-ups

Tracked in `gen-trees/_logs/cand-0152/review-fix/FOLLOWUPS-0152.md` ("Added 2026-11-19 during the 0.15.3 cut", and "Added 2026-11-19 after Publish" for items 4, 5, 6, 10 and the first clause of item 7, which come from the pre-Publish audit).

1. **`connectCDP` waits 10 s** (`scripts/lib/cdp.mjs`, 40 tries of 250 ms). It caused a pre-tag T0 red on 82ecf20be and the public canary's first red after Publish (§9).
2. **A T0 dispatch with `build_run_id` and no `baseline_tag` or `candidate_manifest` goes green** with the continuity and installed suites skipped. Make the pre-tag mode say so.
3. **Three recordings are win32-only** (prefix-lanes, slim-note-base, toolsearch-off). Only the local Windows lists compare them. Run the local HTTP list right after a version bump. Also: fix the comments in `test/helpers/prefix-rig.js`, and add one assertion that the captured app version line equals `tauri.conf.json`'s version.
4. **The train's floor jobs end green while logging a failed floor.** Read the verdict line, not the job colour. A web-search rung that works from hosted IPs would let that floor prove something in CI.
5. **The updater key** (Andrew's): a second offline copy, and runbook §4.4's passphrase with the CI password secret.
6. **The website's static fallback version** is still 0.15.0 (`website/site.js`, `website/index.html`). It needs a restamp and a deploy (§9).
7. **`browser.js`**: read the guard's baseline before the earlier waits in close(); at station shutdown a failing removal can outlast the exit deadline and lose its note. `browser-signin-survives.run.e2e` flakes under load ("unknown tool: shell_exec").
8. **`update-verify-gate`** should print the child's output on a refusal. The desktop-build Mac rehearsal step goes red on an unsigned Intel build where it should skip.
9. **Payload budget tests read the real app version:** the first two-digit patch or minor adds a byte to any measure that includes the runtime block.
10. **Housekeeping** (audit minors): five old drafts sit on starnet-releases (v0.12.0, v0.12.1, v0.12.2, v0.10.0, v0.10.1; read at writing). The per-release hygiene step in `docs/CODE_SIGNING.md` (VirusTotal upload, Microsoft false-positive submission) has no evidence for this release; do it or retire the line.

## 9. After Publish

Written last. The three post-Publish runs were read at 2026-11-19T08:43:14Z; all three were completed at that time.

| Step | Status |
|---|---|
| verify-host | **ALL CHECKS PASSED** (`<logs>/verify-host-0153.txt`, run right after Publish): version 0.15.3, the three platforms, non-empty signatures, https URLs pinned to /download/v0.15.3/, every asset reachable (HTTP 200). At 08:43Z the updater URL (`releases/latest/download/latest.json`) serves a file with the digest in §1 |
| Public canary | 44488215328, on ref v0.15.3: **completed, success, attempt 2** (read at 08:43:14Z). **Attempt 1 (08:30:42Z to 08:35:24Z) was a failure.** Its public-updater-canary job installed the published v0.15.0 baseline, launched it and failed with "Could not connect to CDP on 19373" (`scripts/lib/cdp.mjs` connectCDP, called from `public-upgrade-continuity.mjs:180`). Its receipt reads `"checks": {}`, `"outcome": "FAIL"`: no check had run and no 0.15.3 code had run (`<logs>/g1-public-0153/`, `<logs>/g1-public-canary-job.log`). The release session re-ran the failed job. **Attempt 2 (that job, 08:36:54Z to 08:41:15Z): PASS**, mode `public-in-app-updater`. v0.15.0 (installer c5136ef3…, 71e207bed, 2493 files verified) found the public update and updated itself to the published installer (12c398a0…); the app then reported 0.15.3 at 8dbbf0446 with install integrity verified (2519 files). All 10 checks true: historicalPublicBoot, populatedPublicRestart, publicUpdateAvailable, installerExitedAndAppRestarted, automaticRestartHealthy, currentVersionHasNoPendingUpdate, exactCandidateInstalled, statePreservedAcrossInstall, statePreservedAcrossRestart and installedSmoke. The lifecycle jobs ran once, in attempt 1, and passed: Windows 5/5 (updater-smoke now reads public feed 0.15.3 with feedMustMatch true) and macOS 2/2 |
| Reading of the attempt 1 red | A readiness red in the harness: the old 0.15.0 app did not open its debug port within 10 s on that VM. It is the limit named in §8 item 1, and it is the second time it cost a run in this cut. It was cleared by one pass on the same published bytes. That is one pass in two attempts, on a hosted VM |
| Rollback | Not triggered. Waiver §2 gives the path: mark v0.15.3 pre-release so that releases/latest falls back to v0.15.0. As commands, after the 0.15.0 record's form: `gh release edit v0.15.3 -R androoAGI/starnet-releases --prerelease`, then `gh release edit v0.15.0 -R androoAGI/starnet-releases --latest`, then check that releases/latest names v0.15.0. Never edit v0.15.3's notes or latest.json to roll back |
| Source mirror | 44488228057 success (08:30:47Z to 08:32:15Z): v0.15.3 is Latest on androoAGI/starnet, published 08:32:09Z with 3 assets (read at 08:43Z) |
| Floors after Publish | 44488221437, on `agent/release-0153` at TIP: run conclusion failure, on web-search only. update-host passed (`"ok":true`, 1 attempt). web-search failed as before (mojeek 403, both DuckDuckGo rungs 202). voice and the other six floors green |
| Website | **No restamp and no deploy were made.** The cut log records starnetos.com read in a browser at 08:31Z: badge v0.15.3 and three v0.15.3 download links. That browser reading was not repeated for this record. Read at 08:38Z with a plain fetch: the served page's static text says v0.15.0 in `#ver-badge`, `span.ver` and `#ver-foot`, and the served `site.js` has `FALLBACK_VERSION = '0.15.0'` and looks the version up at `api.github.com/repos/…/releases/latest`, which names v0.15.3. A visitor whose lookup fails sees v0.15.0 |
| This record | Written as the one untracked file in the release worktree (`git status`, read at 08:43Z); HEAD was still the tag. Two read-only fact-checks followed and their corrections are in the text. It is then committed by pathspec on `agent/release-0153`, after the tag: it is not part of what shipped |
| Merge-back | §10 |

## 10. Merge-back

- **Not done.** No trunk file was touched by this cut.
- **Target.** Local trunk `feat/harness-backend` at **10c2bdab8** (read at writing). It is not an ancestor of TIP: it holds 27 commits the release does not have, and TIP holds 401 commits the local trunk does not have; their merge base is fb5a972c9. So the merge-back is a real merge, as waiver §5 says, and it owes its own gate on the merged tree. The 0.15.0 merge-back was a fast-forward; this one is not.
- **Not done: the trunk push.** It needs Andrew's go. Origin `feat/harness-backend` is at e316231d7 (v0.15.0 plus 7 commits), so the default branch carries no 0.15.2 or 0.15.3 code and its Dependabot alerts stay open (§6).

## 11. Status at writing

v0.15.3 is published and is the latest release on starnet-releases and on the source mirror. verify-host passed. The public canary passed on its second attempt after a harness red on its first. The update-host floor is green; the web-search floor is red and has no green run for this release.

Open at 2026-11-19T08:45Z:

- The merge-back to local trunk and the trunk push (Andrew's go).
- The website restamp and deploy.
- Andrew's answer on the second offline updater-key copy, and the key's passphrase (runbook §4.4).
- The follow-ups in §8.

## Appendix A. Readiness outputs, verbatim

Copied byte for byte from the release session's files, except that `C:/Users/andro/gen-trees/_logs/release-0153/` is shortened to `<logs>/`. The punctuation is the tools' own. The waiver is committed beside this record.

### A.1 qa:ready on TIP (`<logs>/ready-8dbbf0446.txt`)

```text
NOT READY — 2 reasons

  1. Green Guardian last cycle: no guardian cycle recorded — run `npm run qa:guardian`
  2. Installed-exe smoke: installed app unverified — tested binary source does not equal current trunk

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
        stamp:    2026-11-19T02:41:34.562Z
        value:    PASS · 139/139 assertions
        → PASS, 65s old
  [PASS] Beginner Run last result
        artifact: qa/beginner-last-run.json
        stamp:    2026-11-19T02:42:20.038Z
        value:    PASS · ui-only · 44461ms
        → PASS, 19s old
  [FAIL] Installed-exe smoke
        artifact: [object Object]
        stamp:    2026-11-18T01:16:17.823Z
        value:    GREEN · v0.15.2 · @28191379 · reproducible-source · desktop
        → installed app unverified — tested binary source does not equal current trunk

trunk agent/release-0153 @ 8dbbf044 · generated 2026-11-19T02:42:39.499Z
```

### A.2 Preflight after tagging (`<logs>/preflight-tagged-8dbbf0446.txt`)

```text
== release-preflight · phase post-bump · target v0.15.3 · in-tree 0.15.3 · agent/release-0153 @ 8dbbf0446 ==
[WARN] on trunk feat/harness-backend — on "agent/release-0153" (--allow-lane): bump + re-lock may happen here, but the TAG goes on trunk AFTER the merge (v0.10.7 pattern: release commit on lane → merge → tag the merge)
       fix: after merging: run the ritual again from the integration tree to tag
[PASS] working tree clean — clean
[PASS] five version pins agree — all five = 0.15.3
[WARN] tag v0.15.3 not yet local — already tagged at HEAD — the tag step is done; nothing pushed yet
[PASS] tag v0.15.3 not on origin
[PASS] no release v0.15.3 on androoAGI/starnet-releases
[PASS] claims lock current for HEAD — PASS claims planning authority · 37 claims · 400 locked surface files
[PASS] website/app mirror in sync
[PASS] test:fast green at HEAD — 1883 step(s) green · 2026-11-19T02:43:37.968Z · log <logs>/final-fast.log
[PASS] test:http green at HEAD — 401 step(s) green · 2026-11-19T02:43:38.009Z
[WARN] T0 clean-install proof for v0.15.3 — owed — runs on a fresh hosted Windows VM against the STAGED DRAFT (after the tag push)
       fix: Actions → t0-clean-install-proof → Run workflow → tag=v0.15.3 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
[WARN] G1 packaged-lifecycle proof for v0.15.3 — owed — idle-close / close-to-tray / updater-smoke on a fresh hosted Windows VM against the staged draft (this is the branch 0.10.5/0.10.6 escaped through)
       fix: Actions → g1-packaged-lifecycle → Run workflow → tag=v0.15.3 (runbook §1.7a). RELEASE BLOCKER: do not Publish without it
[WARN] installed-exe smoke stamp for v0.15.3 — stamp is for appVersion 0.15.2 (GREEN, 25.5h old) — current target smoke remains unverified
       fix: re-run `npm run qa:smoke:installed` against the exact candidate installer
[WARN] 48-hour installed soak acceptance for v0.15.3 — manual acceptance review owed — installed smoke contains no elapsed duration or real-provider workload evidence
       fix: review the completed installed acceptance evidence against docs/RELEASE_READINESS.md §2; only an explicit owner waiver may replace it. This preflight does not infer completion or a waiver from a smoke stamp
[FAIL] qa:ready verdict — NOT READY — 1. Green Guardian last cycle: no guardian cycle recorded — run `npm run qa:guardian` · 2. Installed-exe smoke: installed app unverified — tested binary source does not equal current trunk
       fix: stop: do not bump, do not tag. `node scripts/qa/ledger.mjs --digest`, fix on trunk, re-run `npm run qa:ready` until READY (READY-GATE law, docs/RELEASE_READINESS.md)
[PASS] updater signing key present — file exists (contents never read or printed)
[SKIP] updater key backed up offline (≥2 copies) — unverifiable by machine — human attestation
       fix: runbook §4.1: confirm two offline copies exist before you push the tag
[PASS] RELEASE_NOTES.md for v0.15.3 — header matches, no TODO scaffold, no HTML comment

PREFLIGHT FAIL (PASS 10 · FAIL 1 · WARN 6 · SKIP 1) — 1 hard row(s) red. Do not bump, do not tag.
```

### A.3 Receipt lint (`<logs>/receipt-lint-8dbbf0446.txt`)

```text
receipt-lint: final-fast.log — 1883 step(s) (1883 ok, 0 red): 0 false green(s), 3 allow-listed
  allowed      step 924/1883  test/nav-coach-dismiss.test.js  (1 expected event(s), receipt-lint.allow, reviewed at every cut)
  allowed      step 1268/1883  test/channels.hub.test.js  (2 expected event(s), receipt-lint.allow, reviewed at every cut)
  allowed      step 1290/1883  test/channels.parity.test.js  (1 expected event(s), receipt-lint.allow, reviewed at every cut)
receipt-lint: final-http.log — 401 step(s) (401 ok, 0 red): 0 false green(s), 0 allow-listed
receipt-lint: OK — every run read to its tally, and no ok step printed an unlisted error signal in 2 log(s) (3 allow-listed step(s); review the allow-list at every cut)
```
