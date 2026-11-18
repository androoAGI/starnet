# 0.15.2 owner soak waiver and READY-gate exception

> **Signature status is in §6: Andrew's go for this release is recorded there in his words; his explicit yes to this waiver is asked for in the report he requested before Publish, and Publish does not happen without it.**
> Committed as `docs/releases/0.15.2/SOAK_WAIVER.md` on `agent/release-0152` **before the tag**.
> Precedents: [0.15.0](../0.15.0/SOAK_WAIVER.md), [0.14.2](../0.14.2/SOAK_WAIVER.md), [0.12.0](../0.12.0/SOAK_WAIVER.md).

## 1. Decision

**The 12-hour source soak (`npm run qa:soak:release`) and the 48-hour installed/attended soak are WAIVED for 0.15.2**, subject to §6. No elapsed-time wait is required for this release.

This is a release-specific owner decision. No later version inherits it, and it does not change the default procedure (docs/RELEASE_READINESS.md §2, RELEASE_RUNBOOK §0.4).

**Scope, in Andrew's words (2026-11-13):** "gather everything together and prepare for a new update, but first test all of StarNet's new changes on a new installer myself", then "everything we worked on besides the workflow marketplace". The chat scroll ("tail floor") change is also out: its review found that long chats jump and go blank, and it stays out until that is fixed.

**Candidate:** `agent/release-0152`. It is the 0.15.2 test candidate Andrew ran on his own station (`agent/cand-0152`, last installed build 281913794) with:

- a **message-only history rewrite**: 182 of its commits carried an agent co-author trailer, and two subjects claimed more than their commits did. Every commit's tree, author, committer and dates are unchanged (579 commits compared one by one; the tip tree is 73d22042ab94 before and after), and the 236 commits with no trailer in their ancestry kept their SHAs. The pre-rewrite tip is kept locally as `archive/cand-0152-pre-trailer-strip` and is not pushed;
- 0f0c82d1c: two small restore status lines (a finished restore says what it restored again; the prior-install gate shows restore lines);
- 76d2aa98b: the release notes;
- this waiver, and the claims re-lock on top of it.

It contains everything on `origin/feat/harness-backend` (v0.15.0 plus its seven post-release notes and docs commits). It does **not** contain 24 commits of the local trunk (the tail-floor chat scroll change and its QA records among them).

The tagged commit is recorded in the cut record as TIP.

## 2. What replaces the duration soaks

- **Local whole-suite gates on TIP**, one at a time on a quiet machine: the claims test, `npm run test:fast`, `npm run test:http` (both logs read by `scripts/qa/receipt-lint.mjs`), `qa:journeys` and `qa:beginner`. Both lists run whole, in one run each, with no filter, shard, environment override or edited list. `test:fast` runs at default configuration. The HTTP list (409 steps) took about 78 minutes of step time when it last ran on this machine, more than the 57-minute run deadline `npm run test:http` sets, so if the default run is cut short by that deadline it is run again with only the deadline raised (`node scripts/run-test-list.mjs test/http.list --deadline=<ms>`), and the cut record says so (RELEASE_RUNBOOK §1.4a rule 2 otherwise holds). A red is read and takes §1.4a's disposition, never a rerun until green.
- **CI on TIP** (dispatched by hand: `agent/*` pushes trigger nothing): secret-history first and alone (gitleaks over full history), then fast-gate (Linux `test:fast`, customer journeys, the HTTP shards, the WebKit floor, the Rust policy), floor-canaries, soak (the 20-minute soak and the scale soak; both must PASS every JUDGED rule) and desktop-build (Windows NSIS, both Mac legs notarized, the Intel installed acceptance).
- **Pre-tag T0 on the TIP desktop-build installer**, on a fresh hosted Windows VM: clean install, first launch over CDP, the lifecycle cases, the v0.15.0 → candidate installer continuity, and an installed smoke bound to TIP.
- **On the staged draft, before Publish:** T0, and G1 (the Windows cases plus the macOS lifecycle job). A red on any of them means do not Publish: fix it and spend v0.15.3.
- **The owner's own installs.** Between 2026-11-14 and 2026-11-17 six builds of this candidate were installed over Andrew's real station (0c625c13d, f315ed777, 8ca33b1a6, 8cc75dda8, e4f42019d, 281913794), each after a verified backup of the station and each followed by a GREEN installed smoke bound to that build. He used the station on those builds through those four days and reported what he found; the restart that opened on RESUME while Claude Code was signed in, fixed in this release, came from that use. After the last install (281913794) he wrote: "It appears to be launched already and it looks and feels quite fantastic." TIP adds to that build only the two restore status lines, the notes, this waiver and the claims re-lock. This is real installed use on one Windows station; it is not a soak with a measured workload.
- **Reviews.** Three read-only reviews on 2026-11-14 (the updater, the upgrade of old data, the default run path); adversarial reviews of each later fix lane, with a refuter per finding; four review rounds on the RESUME changes, each finding fixed and locked by a mutation-checked test or recorded as a follow-up; and a final sweep on 2026-11-17 of the upgrade from 0.15.0 and of the late changes. The final sweep found no blocker and no major defect. What it found that a user can meet is in the release notes under Before you update and Known issues.
- **The 0.15.0 → 0.15.2 UPDATE CENTER path** cannot be proven before Publish (0.15.0's updater reads only `releases/latest`). It is proven right after Publish by the G1 public canary (v0.15.0 updates itself to v0.15.2 through UPDATE CENTER and keeps its state). **Rollback if it fails:** mark v0.15.2 pre-release on starnet-releases so `releases/latest` falls back to v0.15.0.
- **The real-vendor probe (`qa:model`)** on a hermetic release-tree station against free local Ollama, with no key in argv, env or the session. Its result is recorded in the cut record. No paid probe runs.

## 3. What this waiver does NOT remove

- The scripted machine soaks in §2. A FAIL there is a finding, not a flake.
- The claims re-lock, the website mirror check, CI on TIP, and T0 and G1 on the staged draft before Publish.
- **Not covered by any soak:** Windows stop/boot restart cycles beyond T0 and G1's cases (the CI soaks run on ubuntu); RSS at the scale shape (NOT JUDGED by design); macOS beyond the CI lifecycle job and the Intel acceptance (no Mac hardware test).
- **Not exercised on real data:** the one-time permission upgrade from a real 0.15.0 station on a second machine. It ran on Andrew's station on 2026-11-14 (an earlier build of it lowered more than its notice said; the fix, 6c25ce400, is unit-tested and mutation-checked, and his already-sealed station cannot run the upgrade again). T0's v0.15.0 → candidate continuity case is the only other run of it.
- **Known and shipping** (each is in the release notes): after Full Access is given back, StarNet can ask once more whether to keep it; the upgrade notice can be missed if the first open stops before the station; a partly restored backup leaves RESUME STATION and RETRY AUTO-RESUME on different saves; a bare "ok" after a general sign-off can start a work run; a Mac on 0.15.0 installed on another disk cannot take the update in-app. Three cost controls are on by default (the unattended hold on subscription sign-ins, the small model for background passes, earlier tool results sent as a short opening plus a saved file); every other cost change ships switched off, and the notes claim no saving.
- **First real run in the train itself (accepted risk):** the train reads the updater key's passphrase secret added since 0.15.0 (runbook §4.4); desktop-build on TIP rehearses the same signing. A train red that is purely a workflow or harness defect is recovered by dispatching release-train.yml with `tag=v0.15.2` from a repaired ref, without moving the tag. A red on the product means fix it and spend v0.15.3.
- Andrew's own items: the offline updater-key backup attestation (runbook §4.1; one off-box copy exists since 2026-10-31, the second is not attested).

## 4. READY-gate exception (docs/RELEASE_READINESS.md: "no version gets cut … without a fresh `npm run qa:ready` printing READY")

qa:ready runs in the release worktree as `SKYNET_GUARDIAN_TRUNK=agent/release-0152 node scripts/qa/ready.mjs`.

| qa:ready check | Status | Why | Substitute evidence |
|---|---|---|---|
| 1. Ledger open P0/P1 | **NOT waived.** Must PASS | — | — |
| 2. Bug register open P0/P1 | **NOT waived.** Must PASS | — | — |
| 3. Green Guardian last cycle | **WAIVED** | No cycle is recorded on this machine; the release runs its own whole-suite gates instead | The §2 local gates and CI fast-gate. **Not covered:** the golden-frame diff, the screenshot sweep and the behavioral truthfulness audit, accepted as unverified for 0.15.2. The dashboard look changed in this release, so the golden frames would need blessing before they could judge anything |
| 4. Journey corps last run | **NOT waived.** Must PASS on TIP | — | — |
| 5. Beginner Run last result | **Conditionally waived**, only if it ends `STUCK@boot` because the harness could not bring up Chrome/CDP; never for FAIL or a later STUCK | Harness | T0's clean-VM first launch over CDP, CI customer journeys, `qa:journeys` |
| 6. Installed-exe smoke | **Conditionally waived** if the stamp cannot be earned on this machine without reinstalling Andrew's station again | The stamp needs the exact TIP build installed and relaunched with a debug port on his real station, which runs the 281913794 build he is testing (its own smoke is GREEN and bound to that build) | Pre-tag T0's installed smoke bound to TIP on a clean VM, plus T0 and G1 on the draft |

Any other FAIL row in the post-bump preflight, or any qa:ready reason outside rows 3, 5 and 6, voids this exception and the cut stops. The tag is created and pushed by hand.

## 5. Branch-based cut (exception to RELEASE_RUNBOOK §0.1/§0.2)

The tag goes on the tip of `agent/release-0152`, not on a trunk merge commit, as v0.14.1, v0.14.2 and v0.15.0 did. CI enforces no trunk containment: the release train and the source mirror need only the pushed tag. The local trunk is not pushed by this cut. After Publish the release branch merges back into local `feat/harness-backend`; that is a real merge (the trunk holds 24 commits the release does not), and it owes its own gate.

## 6. Signature

- **Andrew Sims's go for this release, 2026-11-17**, after testing the installed 281913794 build, in his words: "It appears to be launched already and it looks and feels quite fantastic. I think we should absolutely push forward everyhthing looks really good. Lets go ahead and do one last quick check, make sure we have everything organized and ready to go for the update take care of any last slight issues, we want this ofcourse to be more reliable than the last version, and not cause any new issues, other than that I want you to go full blast on the update Report back to me right before we officially publish it and let me know if u need any specific context". Earlier the same day: "We want this update to definitely come out soon".
- That go did not answer a list naming this waiver, as 0.15.0's did. **His explicit yes to waiving the two duration soaks is therefore asked for in the pre-Publish report he requested, and is recorded in the cut record.** Until he gives it, this waiver covers preparing, gating and staging the draft, and nothing is published.
- Waived checks confirmed at cut time (a subset of §4 rows 3, 5 and 6): recorded in the cut record.
- TIP: recorded in the cut record.
- Spend: the §2 probe is free (local Ollama). No paid probe runs.
- Offline updater-key backup: **his, still open.**

Carry this waiver into the cut record. The public notes cite no soak duration for 0.15.2.
