# 0.14.2 owner soak waiver and READY-gate exception

> **Andrew's approval of this waiver is recorded in §6** ("I trust your recommendation", 2026-10-29 ~17:10 EDT). The offline updater-key backup attestation is still his, and stays an unchecked box until he gives it.
> Committed as `docs/releases/0.14.2/SOAK_WAIVER.md` on `agent/release-0142` **before the bump** (cut plan step 2.7), so it predates the cut.
> **The candidate grew after his approval** (the 10-30 lane merges in §1). The waiver's terms did not change; the release session discloses the growth to him in the cut report.
> Precedents: [0.12.0](../0.12.0/SOAK_WAIVER.md) (2026-09-16) and [0.11.2](../0.11.2/SOAK_WAIVER.md) (2026-09-11).

On 2026-10-29, Andrew directed the 0.14.2 update with: "I want to just make sure everything merged up until this point will be included… make sure my other sessions can continuously keep working on the starnet reliability cleanup… smoothest update possible with everything we have done up until now that is merged and good to go, and lets start to fully prepare for everything you mentioned." (elisions as recorded by the release session). He approved this plan, the vendor-probe spend and these waiver terms with: "I trust your recommendation".

## 1. Decision

**The 12-hour source soak (`npm run qa:soak:release`) and the 48-hour installed/attended soak are WAIVED for 0.14.2.** No elapsed-time wait is required for this release.

This is a release-specific owner decision. No later version inherits it, and it does not change the default procedure (docs/RELEASE_READINESS.md §2, RELEASE_RUNBOOK §0.4).

**Candidate:**
- 0.14.2 is trunk `feat/harness-backend` at **d5024f5a2** (2026-10-29 16:45 EDT), including the run-paths merge;
- plus the release fixes on `agent/release-0142`:
  - 10-29: six fixes merged through 64f0a0679, re-locked at 7210e0ae1; e787dd07e, a `.gitleaksignore` fingerprint for a synthetic test fixture;
  - 10-30: five lane merges (fbdded972 posix-paths tests, f31ee99cf ci-perf tests, 7f0ed81a4 linux-http test cleanup, b3c01637f scale-soak harness, dc3fea600 copy) and the relock c8fa83d8e; then 38c246183 and 42164c888 (test fixes), merge 06adcd770 (the browser.upload receipt) and aabe59904 (test label).
  - **User- or agent-visible text changes since the approval:** dc3fea600 (the chat note for a refused or unsent file in channel.send and routine deliveries; the too-expensive-call message, which no longer claims nothing was charged) and 06adcd770 (the browser.upload receipt bounds the selection to the reply and tells the agent to have the person re-attach before submitting themselves). Everything else after e787dd07e is tests, the soak harness, the bug register or the claims lock.
- The tagged commit is recorded in the cut record as TIP.

## 2. What replaces the duration soaks (all on the exact TIP or its signed build)

- **Scripted machine soaks.** One `soak.yml` dispatch on TIP runs both:
  - the 20-minute soak (`qa:soak` shape);
  - the power-user scale soak (`qa:soak:scale` shape: 50 routines, cron cap 8, a 150 s outage).
  - Both must PASS on TIP: every JUDGED rule, including routine accounting and scheduler tick p95. The scale run's RSS rule reads NOT JUDGED by design (its post-outage window is under the 5-minute minimum set by 2fc129f5e); that is accepted, and RSS at the scale shape is listed as unmeasured in §3.
  - **CI receipts so far (pre-bump, on 7210e0ae1, soak run 40976593740):**
    - **main 20-minute soak: PASS.** 20 of 20 minutes, 60 runs ok and 0 failed, 19/19 routine fires, 1 restart cycle with nothing lost, 0 orphans, tick p95 3 ms. Receipt: CI artifact `soak-receipt-20m-40976593740` (SUMMARY.md; a copy is in the release scratch folder under `ci-soak/`).
    - **scale soak: FAIL on 7210e0ae1.** runs 14 ok / 2 failed; RSS slope 11.15 MB/min, +23.8% over 7 points. Accounting and tick p95 (170 ms) passed. It is being triaged in the scale-soak lane.
    - **Scale-soak lane result (filled 10-30):** soak run **41009949879** on **c8fa83d8e** (pre-bump), both jobs green. Main: PASS, 60 ok / 0 failed, every rule PASS. Scale: PASS, 22 ok / 0 failed; RSS reads NOT JUDGED on a 3.26-minute window (under the new 5-minute minimum), and no rule failed.
      - **Cause of the 7210e0ae1 run failures:** soak-harness defects, not the product (bug 4a3f15d1). The RSS growth's cause is unmeasured, not proven benign; the v0.14.1 baseline showed the same climb. The mock provider steered by words the host quotes into a routine's turn, so routine fires ran the soak's shell command and held the workspace lease; and RSS was judged on a post-boot climb. The v0.14.1 baseline (soak run 40979299342) shows the same defect.
      - **Fix:** 39d1fde80 and 2fc129f5e, merge b3c01637f. Only the soak harness changed.
      - **Still owed:** the scale soak must PASS on TIP (CUT_PLAN 5.2).
- **Pre-tag T0 on the exact candidate installer** (desktop-build of TIP, Authenticode-valid), on a fresh hosted Windows VM, dispatched with `candidate_manifest` (a latest.json assembled from that build's artifacts):
  - clean install and first launch proven over CDP;
  - all five candidate lifecycle cases: idle-close, close-to-tray, updater-smoke, kill-relaunch and cli-app-closed;
  - **public v0.14.1 → candidate continuity: the installer run over v0.14.1**;
  - the installed provider-fallback, delegated-connector, session-reliability and spend-authority suites;
  - an installed smoke bound to TIP.
- **On the staged draft, before Publish** (these re-confirm; a red on any of them means do not Publish: fix it and spend v0.14.3):
  - T0;
  - G1, all five Windows cases (idle-close, close-to-tray, updater-smoke, kill-relaunch, cli-app-closed);
  - the macOS lifecycle job (kill-relaunch, cli-app-closed). It is the only macOS runtime evidence, since there is no Mac hardware test.
- **The 0.14.1 → 0.14.2 upgrade.**
  - **Before Publish, the upgrade proof is the installer over v0.14.1:** the pre-tag T0 baseline continuity above, plus W-B5 on Windows. In W-B5 the TIP installer runs over 0.14.1 with a terminal, an MCP server and the station browser running. Saves, skills and skill approvals must carry over, and after reinstalling 0.14.1 its routines run and its skill approvals still hold.
  - **The UPDATE CENTER path is not proven before Publish, and cannot be.** v0.14.1's updater reads only `releases/latest` on starnet-releases, which never serves a draft.
  - **It is proven only right after Publish:** by the public canary (cut plan 8.2: v0.14.1 updates itself to v0.14.2 through UPDATE CENTER and keeps its state) and by Andrew updating his own 0.14.1 through UPDATE CENTER within minutes of Publish.
  - **Rollback (cut plan 8.2b, with Andrew's go):** if either fails, v0.14.2 is marked pre-release on starnet-releases. `releases/latest` then falls back to v0.14.1, and 0.14.1 clients stop being offered the update.
- **The real-vendor probe** (`qa:model`). It ran on 10-29 on 7210e0ae1 for about $0.07, within the $3 cap Andrew approved ("I trust your recommendation"). Receipt: `b4/B4-RECEIPT.md`.
  - **PASS 8/8:** OpenRouter gpt-4o-mini, kimi-k2, mistral-small-3.2 and qwen3-coder; Ollama native and OpenAI-compatible, both qwen3:8b.
  - **Gemini 2.5 Flash and DeepSeek v3.1 via OpenRouter fail identically on v0.14.1:** pre-existing, not this release, and never claimed in the notes.
  - **Not probed:** StarNet credits (needs his linked station), OpenAI direct (needs his key; it shares the adapter and the `chat` projection with the passing custom probe), and the Grok and Kimi sign-ins (subscription-only, Andrew-attended, optional).
- **The live keyless voice canary** on TIP, and again inside the release train. Pre-bump: floor-canaries run 40976596131 is green on 7210e0ae1.

## 3. What this waiver does NOT remove

- **The scripted machine soaks** in §2. The 0.12.0 precedent kept them too. A FAIL there is a finding, not a flake: route it and fix it. Do not re-run until green.
- **The binding gates on TIP:**
  - a whole-list `test:fast` log turned into a receipt by `release-ritual --gates-proven-by`;
  - the HTTP gate, either as a receipt or as the substitute recorded in the cut record;
  - the claims re-lock;
  - the website mirror check.
- **CI on TIP:**
  - fast-gate's Linux `test:fast` and customer journeys (the release train's own gate);
  - secret-history (gitleaks over the full history);
  - desktop-build, which compiles and notarizes both Mac legs and builds the NSIS installer with its hook before the tag.
- **T0 and G1 on the staged draft, before Publish.** 0.14.1 ran them about a minute after Publish; that must not happen again. A red there means do not Publish: fix it and spend v0.14.3, and never edit the notes after the tag.
- **Not covered by any soak.** This is stated here so nobody reads the soaks as covering it:
  - **Windows stop/boot restart cycles.** The CI soaks run on ubuntu, where the restart uses the graceful SIGTERM stop path (soak.yml:16-18). They cannot exercise Windows `TerminateProcess` stop/boot cycles, the Job Object or the reaper, and those are this release's riskiest change.
  - **The partial substitutes:** the pre-tag T0 lifecycle cases (kill-relaunch, idle-close, close-to-tray), G1 on the draft, and W-B4.
  - **The option that would cover it:** a 20-minute `npm run qa:soak` on the laptop farm when it is idle, cited by its receipt.
  - **RSS growth at the 50-routine scale shape.** The scale soak cannot judge it (see §2); only the 20-minute and 720-minute shapes can.
- **Known dependency alerts that ship unchanged from 0.14.1** (accepted for 0.14.2, deferred to the next release): Dependabot #3 sharp <0.35.5 (HIGH; ships in the app runtime for image and local voice), the fast-uri alerts (#1, #6–#9) and the rustls alerts in src-tauri/Cargo.lock (#5, #15–#17), plus #4 glib. The undici alerts #10–#14 are fixed in 0.14.2 for web_fetch and connector OAuth only; the bundled Node's own undici (provider calls, skill import) stays at 6.28.0 until a Node bump. The notes claim none of these closed beyond bullet 103's scope.
- **Ledger and journeys.**
  - Zero open P0/P1 in the real integration ledger, so the three Guardian journey P1s must be dismissed with evidence through the ledger's own path.
  - `qa:journeys` PASS on TIP.
  - If J2/stop or J3 reproduces, it is a real P1 and the cut stops.
- **Andrew's own items:**
  - the offline updater-key backup attestation (runbook §4.1);
  - his truth review of the final notes: delegated ("I trust your recommendation"). Instead, the notes were walked live (23 pass, 8 partial and rewritten, 1 not walked) and checked by two independent critics before the bump. His own testing of the draft installer can still stop Publish, and any notes change after the tag spends v0.14.3;
  - his Publish click.

## 4. READY-GATE exception (docs/RELEASE_READINESS.md: "no version gets cut … without a fresh `npm run qa:ready` printing READY")

The law has no waiver clause, and neither `ready.mjs` nor `release-preflight.mjs` reads one. This section is the written owner exception. It covers **only** the checks named below, **only** with their stated substitutes, and **only** for 0.14.2.

qa:ready is run in the release worktree as:

`SKYNET_GUARDIAN_TRUNK=agent/release-0142 node scripts/qa/ready.mjs`

This compares every stamp to the release branch tip rather than trunk's moving tip. The run uses a mirror of the integration ledger, so check 1 is the real ledger.

| qa:ready check | Status under this exception | Why it cannot be earned for 0.14.2 | Substitute evidence, all on TIP |
|---|---|---|---|
| 1. Ledger open P0/P1 | **NOT waived**, except the narrow §4a amendment, which applies ONLY once Andrew approves it in §6 | — | §4a |
| 2. Bug register open P0/P1 | **NOT waived.** Must PASS | — | — |
| 3. Green Guardian last cycle | **WAIVED** | Three reasons. A cycle takes about 1 h 50 m on a quiet main box, but the box runs at 0.2–2.8 GB free alongside the wave-2 gates. The last GREEN was 2026-09-17, and the 10-29 cycles timed out under RAM pressure. Golden needs 10 frames re-blessed by eye, and that is a committed baseline change. | The whole-list `test:fast` receipt. The HTTP gate (receipt, or the cut record's substitute). CI fast-gate (Linux fast, customer journeys, 4 HTTP shards). `qa:journeys` PASS. [Optional: `npm run qa:saboteur` PASS.] **Not covered by any substitute:** the visual golden-frame diff, the screenshot sweep and the behavioral truthfulness audit. These are accepted as unverified for 0.14.2. |
| 4. Journey corps last run | **NOT waived.** Must PASS on TIP | — | — |
| 5. Beginner Run last result | **Conditionally waived.** Only if the run on TIP ends `STUCK@boot` because the harness could not bring up Chrome/CDP, as on 10-29 (CDP 9350). **Never** for FAIL, or for STUCK at any later step. | Harness/RAM | The T0 clean-VM first launch proven over CDP. CI customer journeys. `qa:journeys` PASS. |
| 6. Installed-exe smoke | **Conditionally waived.** Only if Andrew does not install the TIP build on this machine | The local stamp needs the exact TIP build installed and running here | The pre-tag T0 run's installed smoke on the desktop-build of TIP: `result GREEN`, `expectedHead == TIP`, on a clean VM. Plus T0 and G1 on the draft, and the draft manual checks, all before Publish. |

### 4a. Proposed narrow amendment for check 1 (NOT in force until Andrew approves it in §6)

On 2026-10-30, the mirrored integration ledger showed 1 open P0 and 3 open P1s, all raised by the Guardian on trunk, not on the release branch:
- **eb658efe** (P0), "Guardian BLOCKED: HTTP/E2E integration gate could not run". It timed out after 3702 s on trunk d5024f5a under main-box RAM pressure. This is the same subject as check 3 (the Green Guardian), which is waived above.
- **5f362dca** and **73443649** (P1), J2/stop: conversation Stop mid-run. **cd21adbf** (P1), J3: double-send IDs. Raised on trunk 5203fa2e and c404b358 (10-27).

If approved, check 1 is waived ONLY for these four, and ONLY under these conditions:
- eb658efe: the check-3 substitutes on TIP in the row above.
- Each journey P1: `qa:journeys` PASSES on TIP. The ledger owner (system32-02) re-runs the same journey cases on trunk. A case that passes on both trunk and TIP is dismissed through the ledger's own path, so it needs no waiver. A case that fails on trunk but passes on TIP stays open for trunk and is covered here. A case that fails on TIP is a real P1, and the cut stops.
- Any other open P0/P1, or any new one, is NOT covered.

**Consequences, stated in advance:**
- The post-bump preflight (`release-preflight --version 0.14.2 --phase post-bump --allow-lane`) on TIP will show **exactly one FAIL row, `qa:ready verdict`**, whose reasons are a subset of checks 3, 5 and 6 above (plus check 1, but only for the §4a findings and only once §4a is approved).
- **Any other FAIL row, or any qa:ready reason outside 3, 5 and 6, voids this exception, and the cut stops.**
- `release-ritual` writes the gate receipts (step 5) and then stops at step 6 on that row. On a lane it would stop at step 7 anyway.
- The tag `v0.14.2` is therefore created **by hand** on TIP and pushed **by hand** with Andrew's go.
- The preflight output, the qa:ready output and this file are attached to `docs/releases/0.14.2/CUT_RECORD.md`.
- If every check passes at cut time (READY), this section is moot and the cut record says so.

## 5. Branch-based cut (exception to RELEASE_RUNBOOK §0.1/§0.2)

The runbook says "the tag must point at trunk … the tag goes on the merge commit". For 0.14.2 the tag goes on the tip of `agent/release-0142`, so the other sessions can keep merging reliability work into trunk.

- CI enforces no trunk containment. The release train and the source mirror need only the pushed tag.
- v0.14.1 shipped the same way: tag 8e8311987 on `agent/release-0141-clean`, merged to trunk after Publish.
- After the tag, the release branch merges back into `feat/harness-backend` through a merge worktree, re-locked and gated. The wave-2 coordinator does the fast-forward.

## 6. Signature

- Approved by: **Andrew Sims, recorded 2026-10-29 ~21:10 UTC (~17:10 EDT)**, in his words: "I trust your recommendation".
- [ ] §4a check-1 amendment approved by Andrew (date and his words recorded in the cut record). **Open until he answers; the tag waits for it if qa:ready check 1 is not otherwise PASS.**
- [ ] Offline updater-key backup attested by Andrew (runbook §4.1). **His, still open.**
- Waived checks confirmed at cut time (filled in at cut plan step 5.9, and must be a subset of §4 rows 3, 5 and 6, plus §4a only if approved): ______________________
- TIP: ______________________
- Spend cap for the real-vendor probe: **$3** (Andrew's go, "I trust your recommendation"). Spent: about $0.07 (`b4/B4-RECEIPT.md`).

Carry this waiver into the cut record. The public notes cite no soak duration for 0.14.2.
