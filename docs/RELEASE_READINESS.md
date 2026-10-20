# StarNet release readiness — RC freeze + soak

Solo, 2am, tired. This is the protocol that stops **you** from being the first real tester. It sits
in front of `docs/RELEASE_RUNBOOK.md`: the runbook cuts and ships a version; **this doc decides a
version is allowed to be cut at all.** Every step is a command to paste or an exact decision — nothing
here says "ensure that."

**The one law (READY-GATE):** no version gets cut, and no session/doc claims StarNet is "ready" or
"go-public-able", without a fresh `npm run qa:ready` printing **READY** next to the claim. Lane-green is
not project-green. "Lane X verified" only ever means lane X — station-wide status is whatever
`qa:ready` says, nothing softer.

**Why this exists (session audit 2026-07-07):** the EL loop fixed *detection* but not the *repeat* —
(a) the aggregate "ready" claim was never gated on anything, so sessions reported lane-green as
project-green while the Guardian sat RED; (b) nothing ever used the product the way Andrew does
(installed exe · real providers · long multi-step work), so he was structurally the first tester;
(c) no freeze — 10+ lanes/day merge, so readiness was always audited against a moving target. RC freeze
kills (c), the soak kills (b), and `qa:ready` kills (a).

**Fixed facts (from the code / sibling lanes — do not retype from memory):**
- `npm run qa:ready` → `scripts/qa/ready.mjs` (lane `agent/ready-gate`, EL-7): the one machine verdict
  READY / NOT READY. It reads the installed-exe smoke stamp this doc's soak produces
  (`qa/installed/last-smoke.json`). If that command isn't in your worktree yet, the ready-gate lane
  hasn't merged — do not hand-wave it; the freeze can't start without it.
- `npm run qa:smoke:installed` → `scripts/qa/installed-smoke.mjs`: CDP-attaches to the RUNNING installed
  exe and writes the stamp `qa:ready` reads. The soak's proof-of-life. See `qa/installed/README.md` for
  the exact operator recipe (relaunch with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`).
- The dogfood loop `loops/dogfood.md` (lane `agent/dogfood`, EL-9) is the soak's **workload driver** — a
  standing session that USES StarNet like a user (recruit → assign real multi-step work → interrupt →
  restart → open deliverables → channels) with REAL providers. The soak IS that loop, pointed at the
  installed build for ≥48h.
- The failing-scenario law (EL-3): every escape lands a failing journey/assertion (or a ledger KNOWN
  entry saying why it can't be automated) BEFORE its fix merges. That applies double during a freeze.

---

## 0. When to cut an RC (the trigger)

You cut an RC when you *think* a version is shippable and you want to prove it over 48h instead of
finding out from Andrew after publish. Do NOT cut an RC off a red house. Before anything:

```
npm run qa:ready
```

- Prints **READY** → proceed to section 1.
- Prints **NOT READY** → stop. Each NOT-READY line names a check (open P0/P1 count · Guardian last
  cycle green+fresh · qa:journeys · Beginner Run · installed-smoke stamp fresh). Route those findings
  through the ledger (`node scripts/qa/ledger.mjs --digest`) and fix them on trunk first. An RC is a
  *freeze of a green house*, not a hope.

---

## 1. Cut the RC branch + tag

You are cutting `0.3.1` (example). The RC lives on its own branch so trunk keeps moving while the RC
holds still — that is the entire point of a freeze.

### 1.1 Branch the RC off trunk

```
git checkout feat/harness-backend
git pull --ff-only
git checkout -b rc/0.3.1
git tag rc/0.3.1-rc.1
git push origin rc/0.3.1 rc/0.3.1-rc.1
```

`rc/0.3.1` is the frozen branch. `rc/0.3.1-rc.1` is the point-in-time tag marking the FIRST commit you'll
soak (rc.2, rc.3, … as fixes cherry-pick in — section 3). The tag is just a marker you cut the soak binary
from **locally** (§2.1 — the release train does not build `rc/*` tags); the branch is where the only allowed
changes land.

### 1.2 The freeze law (write it on your hand)

From this moment until `0.3.1` publishes or the RC is abandoned:

- **Only P0/P1 fixes merge into `rc/0.3.1`.** Nothing else. No features, no P2 polish, no "while I'm
  here." Features keep landing on `feat/harness-backend` (trunk) exactly as before — the RC does not
  freeze the project, only the release.
- **Every fix that enters the RC is a cherry-pick, never a direct commit**, and carries its EL-3
  failing scenario (the journey/assertion that reproduces the bug) — see section 3.
- **The RC branch is never rebased onto trunk.** It diverges on purpose. Trunk moving is irrelevant to
  the soak; that decoupling is what makes the readiness verdict mean something.

If you're tempted to sneak a feature into the RC "because it's small": that is the exact 10-lanes-a-day
drift the freeze exists to stop. It goes on trunk and rides the *next* RC.

---

## 2. Build the soak binary + soak it ≥48h

### 2.1 Build + install the RC as a real signed binary

Do **not** soak a dev sidecar. Soak the thing users install. Build the installer **locally** from the
frozen RC branch, then install it:

- Check out the RC branch (`git checkout rc/0.3.1`) and cut the signed installer locally with
  `npm run release:cut`. That produces the signed Windows NSIS installer + updater `.sig` + a staged
  `latest.json` under `release/` (it needs the updater key at `~/.tauri/starnet-updater.key`; see
  `docs/RELEASE_RUNBOOK.md` §4 for key handling). **This is a local build, not the release train** —
  `.github/workflows/release-train.yml` triggers only on `v*` tags and its `assemble` job hard-fails
  unless the tag is exactly `v<version>` from `tauri.conf.json`, so an `rc/0.3.1-rc.1` tag does **not**
  drive it. Nothing here touches GitHub Releases; the soak binary lives only on your machine.
  (Future work: teach the train to build `rc/*` tags into a DRAFT prerelease so the RC binary is
  CI-built and signed like the real release across all platforms — until then, `release:cut` is the
  path, and it builds the Windows installer only.)
- Install the Windows installer over your current StarNet (silent NSIS, same as
  `docs/RELEASE_RUNBOOK.md` §1.10's canary step). **Purge the WebView2 cache after installing** or the
  soak tests the OLD embedded frontend — `docs/MISTAKES.md` "WebView2 caches the embedded frontend"
  and `desktop-bundles-frontend-directly` memory carry the exact purge recipe (kill app +
  `msedgewebview2.exe`, remove `EBWebView\Default\{Cache,Code Cache,GPUCache}`, relaunch). This is the
  single most-repeated installed-app mistake; do it every time.

### 2.2 Prove the installed build is even attachable before the clock starts

```
# relaunch the freshly-installed exe with the debug port open (see qa/installed/README.md), then:
npm run qa:smoke:installed
```

Expect the stamp `qa/installed/last-smoke.json` to read **GREEN** with `appVersion` = the RC version.
If it's **BLOCKED** (can't attach / can't prove the version) the soak cannot start — a build you can't
observe is not a build you can soak. Fix the attach path first (it also files a P0, so `qa:ready` will
already be NOT READY).

### 2.3 Run the soak — ≥48h, installed exe, REAL providers, real multi-step work

The soak's workload is the **dogfood loop** (`loops/dogfood.md`), pointed at the installed build with a
real provider key (BYOK from your key store; never on disk — same env-only contract as
`qa:beginner:live`). Over the window the loop does what Andrew does: recruit agents, assign real
multi-step work, interrupt mid-run, restart the app, open deliverables, exercise channels. Every anomaly
it hits is filed through the ledger with evidence per EL-3.

Alongside it, keep the installed-smoke stamp fresh — re-run `npm run qa:smoke:installed` at least once a
day and at the very end so `qa:ready` has a recent installed-exe receipt, not a stale one.

**Pass definition (all three, no exceptions):**
1. **Zero new P0/P1 ledger findings** opened during the soak window. (P2s are fine — they ride the next
   train.) Check with `node scripts/qa/ledger.mjs --digest`.
2. `npm run qa:ready` prints **READY** at soak end — with the installed-smoke stamp fresh and GREEN.
3. The full ≥48h elapsed on the actual installed binary (not a dev sidecar, not a partial afternoon).

Miss any one → not shippable. The soak is the thing standing between you and being the first tester;
don't shorten it because it's late.

---

## 3. Escapes DURING the soak

A soak that finds nothing is a pass. A soak that finds something is the soak *working* — that bug would
otherwise have been Andrew's. Handle it by severity, EL-3 first:

1. **Reproduce it as a failing scenario BEFORE any fix.** Land a failing `qa:journeys` step / audit
   assertion (or a ledger KNOWN entry naming why it can't be automated) that reproduces the escape. No
   fix merges anywhere until that exists — an escape is a coverage gap, not just a bug.
2. **Fix on trunk, then cherry-pick into the RC.** The fix lands on `feat/harness-backend` normally
   (with its failing scenario now going green). Then cherry-pick JUST that fix onto `rc/0.3.1`:
   ```
   git checkout rc/0.3.1
   git cherry-pick <fix-sha>          # the fix commit only — not the whole trunk delta
   git tag rc/0.3.1-rc.2              # bump the rc.N counter for the new soak binary
   git push origin rc/0.3.1 rc/0.3.1-rc.2
   ```
   Rebuild the installer from `rc/0.3.1-rc.2`, reinstall, purge the WebView2 cache (§2.1).
3. **Restart the soak clock on a P0.** Any P0 cherry-picked into the RC resets the ≥48h window to zero —
   you changed the binary under test, so the prior soak hours no longer describe it. A P1 fix does **not**
   reset the clock (the run continues), but re-run `qa:smoke:installed` after reinstalling so the stamp
   describes the new binary.
4. **P2/feature-shaped escapes do not touch the RC.** They go on trunk and ride the next RC. Only P0/P1
   are allowed through the freeze.

When the soak completes a clean ≥48h window with `qa:ready` READY, the RC is proven. Rename/re-cut it as
the real `0.3.1` release and hand it to `docs/RELEASE_RUNBOOK.md` section 1 — whose step 0 now requires
exactly the READY receipt you just earned.

---

## 4. Abandoning an RC

If the RC accumulates so many P0s that fix-forward is churn, abandon it: discard the local RC build
(it never left your machine — nothing to unpublish), leave `rc/0.3.1` for history, fix the pile
on trunk, and cut a fresh RC (`rc/0.3.2`) off green trunk when `qa:ready` is READY again. A burned RC is
cheap; a broken public release is not (`docs/MISTAKES.md` "CI / release traps").
