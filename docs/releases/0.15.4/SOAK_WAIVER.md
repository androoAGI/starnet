# 0.15.4 owner soak waiver and READY-gate exception

> **Signature status is in §6: Andrew's go for this release is recorded there in his words; his explicit yes to this waiver is asked for in the pre-Publish report, and Publish does not happen without it.**
> Committed as `docs/releases/0.15.4/SOAK_WAIVER.md` on `agent/release-0154` **before the tag**.
> Precedents: [0.15.3](../0.15.3/SOAK_WAIVER.md), [0.15.2](../0.15.2/SOAK_WAIVER.md) (tagged, never published), [0.15.0](../0.15.0/SOAK_WAIVER.md).

## 1. Decision

**The 12-hour source soak (`npm run qa:soak:release`) and the 48-hour installed/attended soak are WAIVED for 0.15.4**, subject to §6. No elapsed-time wait is required for this release.

This is a release-specific owner decision. No later version inherits it, and it does not change the default procedure (docs/RELEASE_READINESS.md §2, RELEASE_RUNBOOK §0.4).

**Why this release is urgent.** v0.15.3 was published on 2026-11-19 08:30Z. The same day a customer reported that an agent on Full Access asked before every command and that giving Full Access again did not stop it. The cause is in 0.15.3 itself, and its one-time permission upgrade also switches Full Access off for everyone who updates, which nothing can give back afterwards. Every hour 0.15.3 stays the latest release, more stations lose it.

**Candidate:** `agent/release-0154` = the 0.15.3 cut record (94290b2e7, the v0.15.3 tag plus its record) plus:

- bd4e4b3fc: after a run reads outside content, Full Access lifts the boundary for every tool again (`sidecar/taint.js`). 0.15.3 held host processes and file-carrying web requests behind it: one card per command when watched, a refusal when not.
- f44a3f692: a Full Access agent stays at Full Access through a change to its model, provider, instructions or skills made in the StarNet window, by the headless model and personality routes, or by a config import (`sidecar/index.js`). 0.15.3 asked the desk to keep it, or dropped it.
- 39bfb2418: the one-time permission-seal upgrade seals FULL BYPASS and each agent's Full Access as they are (`sidecar/authority-seal.js`). 0.15.3 sealed them off.
- 7bba29248: a Full Access agent's own job hands no outside-content latch to the path guard (no write card, no unattended refusal), and whole-host Full Power outranks the `.env`/`.git` floor again (`sidecar/index.js`, `sidecar/permissions.js`, `sidecar/pathtrust.js`).
- 935d1a6eb: an impossible learned context overhead is neither learned nor projected from, and a model-basis projection never hard-blocks the composer (`frontend/app/harness.js`, `frontend/app/chat.js`, their website mirrors, a pinned test). Built in another lane (d2ed92a71 on the local trunk) and picked here; one conflict in `harness.js`, resolved by keeping this line's `stepDelta` term inside the new guard.
- 4ae1990e2 (the five version pins), the notes, this waiver, and the claims re-lock on top.

**These five changes reverse parts of the security hardening that shipped in 0.15.3 (GHSA-2hpj-9wm7-rvg5 items #2 and #6, review2 #6, final review #5, fix-sec2 review 5).** That is the owner's decision of 2026-11-19, recorded in `docs/DECISIONS.md` ("FULL POWER NEVER ASKS", "LOCKED ON once set"). What was kept is listed there and in the release notes: the credential floor, the reach fence, the lock on runs that outside content started, fresh-consent tools, the desk confirmation when Full Access is turned on, the seal on permission files after the upgrade, and the drop for a client-key caller under the desktop shell.

It does **not** contain the commits of the local trunk that 0.15.3 left out, nor anything the local trunk gained since, except the context fix named above.

## 2. What replaces the duration soaks

Every gate below is run again, whole, on the 0.15.4 TIP.

- **Local whole-suite gates on TIP**, one at a time on a quiet machine: the claims test, `npm run test:fast`, `npm run test:http` (both logs read by `scripts/qa/receipt-lint.mjs`), `qa:journeys` and `qa:beginner`.
- **CI on TIP** (dispatched by hand): secret-history first and alone, then fast-gate, floor-canaries, soak and desktop-build (Windows NSIS, both Mac legs notarized, the Intel installed acceptance, both update signer rehearsals).
- **Pre-tag T0 on the TIP desktop-build installer**, on a fresh hosted Windows VM.
- **On the staged draft, before Publish:** T0, and G1 (the Windows cases plus the macOS lifecycle job).
- **What each change was proven with before the gates.** bd4e4b3fc: `test/e2e.trigger-fullaccess-taint.test.js` on a booted hermetic station (the shipped rule raises one card and blocks the command; the fix raises none and the command runs; the payload-started run stays locked). f44a3f692: `test/roster-raise.http.test.js` on a booted station (five assertions fail against the shipped `index.js`). 39bfb2418 and 7bba29248: their module tests (`authority-seal`, `master-bypass`, `pathtrust`, `taint-host-write`, `taint-standing-files`) and the booted seal tests. 935d1a6eb: `test/ctx-overhead-selflock.test.js`.
- **The 0.15.3 → 0.15.4 and 0.15.0 → 0.15.4 UPDATE CENTER paths** cannot be proven before Publish. They are proven right after Publish by the G1 public canary. **Rollback if it fails:** mark v0.15.4 pre-release on starnet-releases so `releases/latest` falls back to v0.15.3.

## 3. What this waiver does NOT remove

- The scripted machine soaks in §2. A FAIL there is a finding, not a flake.
- The claims re-lock, the website mirror check, CI on TIP, and T0 and G1 on the staged draft before Publish.
- **Not covered by any soak:** Windows stop/boot restart cycles beyond T0 and G1's cases; RSS at the scale shape; macOS beyond the CI lifecycle job and the Intel acceptance.
- **Not exercised on real data:** the one-time permission upgrade from a real 0.15.0 station that still holds Full Access. Andrew's own station was upgraded on 2026-11-14 and already lost it, so it cannot show the kept case; T0's v0.15.0 → candidate continuity case is the only run of that path.
- **Not driven in the live window:** the five changes were proven by tests against booted stations and by module tests, not by clicking through the desktop app.
- **Known and shipping:** a station already on 0.15.3 has lost Full Access and FULL BYPASS and gets neither back from this update (the release notes say so first).
- Andrew's own items: the offline updater-key backup attestation (runbook §4.1).

## 4. READY-gate exception

qa:ready runs in the release worktree as `SKYNET_GUARDIAN_TRUNK=agent/release-0154 node scripts/qa/ready.mjs`. The exception is the one the 0.15.3 waiver states in its §4, row for row: rows 3 (Green Guardian), 5 (Beginner Run, only for `STUCK@boot`) and 6 (installed-exe smoke) may be waived with the substitutes named there; rows 1, 2 and 4 must PASS. Any other FAIL row in the post-bump preflight voids this exception and the cut stops.

## 5. Branch-based cut

The tag goes on the tip of `agent/release-0154`, not on a trunk merge commit, as v0.15.3 did. The local trunk is not pushed by this cut. After Publish the release branch merges back into local `feat/harness-backend`; that is a real merge and it owes its own gate.

## 6. Signature

- **Andrew Sims's decisions, 2026-11-19:** "THIS SHOULD BE NEVER ASK … FULL POWER IS FULL DAMN POWER … ONCE THE USER SETS IT TO FULL ACCESS … IT SHOULD BE LOCKED ON FULL POWER"; then "do as u recommend pls … lets fix it and merge quicky".
- **His go for this release, 2026-11-19**, asked whether the issue was big enough for an immediate mini update and told that the cut would stop before any push, tag or publish: "YES then go for it immediately and include the context bar not resettting session included as well".
- Those answers did not name this waiver, a push or a tag. **His go for the push and the tag, and his explicit yes to waiving the two duration soaks, are asked for and recorded in the cut record.** Until he gives them, this waiver covers preparing and gating the branch locally, and nothing is pushed or published.
- TIP: recorded in the cut record.
- Spend: none. No paid probe runs.
- Offline updater-key backup: **his, still open.**

Carry this waiver into the cut record. The public notes cite no soak duration for 0.15.4.
