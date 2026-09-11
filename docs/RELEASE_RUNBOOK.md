# StarNet release runbook

Solo, 2am, tired: follow this top to bottom. Every step is a command to paste or an exact
click. Nothing here says "ensure that" — if a step is judgment, it tells you the exact thing
to look at and the exact decision.

**Read these two first (they are the design this runbook executes):**
- `docs/UPDATE_PIPELINE_AUDIT_2026-07-06.md` — why the pipeline is shaped this way (the P0/P1
  weaknesses this train fixes).
- `docs/RELEASE_TRAIN_BUILD_PLAN_2026-07-06.md` — the pinned contracts (C1–C5) each script and
  workflow was built to.

**The one law of this pipeline:** nothing reaches a user until *you* click **Publish** on
GitHub. The release train only ever stages a **DRAFT**. Until you publish, zero clients can
see or download anything.

**Fixed facts (from the code, do not retype from memory):**
- Public source repo: `androoAGI/starnet` — where you run
  `release:bump` and where the train workflow lives.
- Public releases repo: `androoAGI/starnet-releases` — installers live here,
  and this is what the updater points at.
- Updater endpoint baked into every shipped binary
  (`src-tauri/tauri.conf.json` → `plugins.updater.endpoints[0]`):
  `https://github.com/androoAGI/starnet-releases/releases/latest/download/latest.json`
- Updater signing key: `~/.tauri/starnet-updater.key` (see section 4 — this is the single
  most dangerous thing to lose in the whole project).
- Release state is live data, not a fact to freeze in this runbook. Read the current in-tree version from
  the five pins listed in `docs/BRAIN.md`; list publicly receivable distribution releases with
  `gh release list -R androoAGI/starnet-releases --exclude-drafts`; and inspect drafts separately before
  selecting a version. A source tag or distribution draft already bearing that version is a collision even
  when no updater fleet can see it. (The version numbers used as examples below are illustrative.)

---

## 0. THE CUT — two commands (read this section; the rest of §1 is what happens after the push)

The cut used to be a ritual spread across this runbook, memory notes, and tribal knowledge —
version in five files, gate AFTER bump BEFORE tag, claims re-lock owed, receipts, the key — and every
step-order mistake cost real money (v0.2.0 + v0.2.1 burned by gating after the tag push; a 15h soak
lost to a re-cut; 0.10.6 shipped a close-zombie partly because cutting was expensive enough that the
fix waited). The cut is now **two scripts**. They encode every requirement below; nothing was removed
from the ritual, it was moved into code that refuses to skip a step.

```
npm run release:preflight -- --next patch        # read-only checklist: PASS/FAIL/WARN/SKIP per row
npm run release:ritual    -- --next patch        # the ordered cut; hard-stops; NEVER pushes
npm run release:ritual:dry -- --next patch       # print the whole plan, mutate nothing
```

(`--version X.Y.Z` instead of `--next patch|minor|major` when you want an exact number.)

### 0.1 `release:preflight` — every precondition, one checklist, exact fix per red row

Read-only and idempotent; run it as often as you like. Exit 0 only when no row is `FAIL`. Each row
exists because of a law; the law is cited so you know why you can't wave it through:

| row | hard? | why it exists |
| --- | --- | --- |
| on trunk `feat/harness-backend` | FAIL (`--allow-lane` → WARN) | the tag must point at trunk; a lane bump is fine (v0.10.7 did it) but the **tag goes on the merge commit** |
| working tree clean | FAIL on modified tracked files; WARN on untracked | the tag must name a tree you can rebuild; foreign untracked files have blocked the claims re-lock guard |
| Guardian `qa/STATUS.md` row refresh | WARN, named | the Guardian's periodic status row is benign dirt — commit it as `qa: record …` or stash it; never fold it into the release commit |
| five version pins agree | FAIL | `package.json`, `package-lock.json` root, `tauri.conf.json`, `Cargo.toml`, `Cargo.lock` `skynet-desktop` (`docs/BRAIN.md`); `release:bump` moves all five; a straggler breaks `cargo build --locked` on CI |
| tag not local / not on origin / no release on `starnet-releases` | FAIL (SKIP "unverified: offline" when unreachable) | a tag already on origin has **already fired the train**; a draft on the releases repo reserves the version; tags are never force-moved (§2.3) — spent versions get `--next patch` |
| claims lock current for HEAD | FAIL | `qa/product-perfect/claims.json` pins bytes of the release surface (incl. `RELEASE_NOTES.md`, `website/app`); the audit **reads the COMMIT, never the tree** — an uncommitted re-lock is invisible |
| `website/app` mirror in sync | FAIL | the live demo is a GENERATED verbatim copy of `frontend/` (`sync:website --check`); drift is a truthfulness bug, and it is inside the locked claims surface |
| `test:fast` green at HEAD | WARN pre-bump, **FAIL post-bump** | `MISTAKES.md` "Gate order": gate AFTER the bump, BEFORE the tag push. The receipt is `.dogfood/gate-receipts/<sha>.fast.json`, written only by the ritual after verifying a gate LOG's last line |
| `test:http` green at HEAD | WARN (`--require-http` → FAIL) | `starnet-backend-law`: owed whenever sidecar/ship/route code changed since the last cut |
| T0 clean-install · G1 packaged-lifecycle | WARN "owed" until a complete receipt for the target exists | post-draft RELEASE BLOCKERS (§1.7a); pre-tag they can only be owed — the row makes the debt explicit so it is never silently forgotten |
| installed-exe smoke | PASS only for a fresh GREEN stamp naming the target version | short startup/interaction evidence; exact candidate and executable binding are enforced by `qa:ready` |
| 48-hour installed soak acceptance | WARN — manual evidence review remains owed | review elapsed duration, real-provider workload and final readiness under `docs/RELEASE_READINESS.md`; a smoke stamp does not prove the soak. An explicit owner hotfix waiver must be recorded in `RELEASE_NOTES`/`NEXT.md` |
| `qa:ready` verdict | FAIL on NOT READY or unrunnable | READY-GATE law (`docs/RELEASE_READINESS.md`, `docs/DECISIONS.md`): no version is cut against a red house. No-fake-green: an unrunnable `qa:ready` is NOT READY |
| updater signing key present | FAIL | `~/.tauri/starnet-updater.key` — lose it and no installed StarNet can ever update again (§4). Presence only; the file is never read or printed |
| updater key backed up offline ≥2 copies | SKIP — human attestation | §4.1; no machine can verify a USB stick |
| `RELEASE_NOTES.md` for the target | WARN pre-bump, **FAIL post-bump** if still the TODO scaffold | the notes are the GitHub release body AND the in-app UPDATE CENTER text |
| trunk vs `origin` | WARN if ahead | informational: push the branch WITH the tag so the source-release mirror can find the commit |

### 0.2 `release:ritual` — the ordered cut, with a hard stop between irreversible steps

The ritual is **re-runnable**: after every STOP you fix the thing and run the SAME command again;
completed steps are detected from the repo and skipped. There is no `--resume` to forget. The order
is the v0.10.7 cut as practiced (`db64f0064` release commit → `3ba1837cb` claims re-lock → `07ea9ebf8`
merge, tag on the merge):

1. **preflight (pre-bump)** — any `FAIL` row stops here (§0.1).
2. **bump** — `node scripts/release-bump.mjs <ver> --no-tag`: moves the five pins, scaffolds
   `RELEASE_NOTES.md`, commits `release: v<ver>` by pathspec. `--no-tag` on purpose: the tag goes on
   the re-lock commit (tag-after-stamp is what made the v0.6.5 train pass first try).
   `release-bump` also refuses a version ≤ the highest **published** release (the fleet floor) when
   `gh` can reach `starnet-releases`, and warns loudly when it can't.
3. **release notes — STOP** until `RELEASE_NOTES.md` has no `TODO: summarize` line. Write the real
   user-facing notes, then `git add RELEASE_NOTES.md && git commit --amend --no-edit` (the
   `release: v<ver>` commit must be HEAD). Re-run.
4. **claims re-lock** — `claims.mjs --refresh-surface --candidate HEAD` spliced into
   `qa/product-perfect/claims.json`, committed as its OWN commit
   `qa(claims): re-lock the release surface for v<ver>`. Every bump owes this because
   `RELEASE_NOTES.md` is in the locked surface.
5. **gates — STOP** until a fresh green receipt exists for HEAD. The ritual prints the exact commands:
   ```
   npm run test:fast 2>&1 | tee gate-fast.log
   npm run test:http 2>&1 | tee gate-http.log      # when sidecar/ship/route code changed
   npm run release:ritual -- --version <ver> --gates-proven-by gate-fast.log --gates-proven-by gate-http.log
   ```
   It verifies the log's **last line** is the runner's green summary
   (`run-fast-tests: OK — N step(s) green`) — never the exit code (`| tail` and wrappers hide a red
   gate; the summary line can't be faked by accident) — and that the log is newer than HEAD's commit
   (a green log from before the bump proves an older tree). Then it writes
   `.dogfood/gate-receipts/<sha>.<gate>.json`. **This is the gate that burned v0.2.0 and v0.2.1 when
   it was skipped**: the bump changes the shipped version, and a test coupled to it fails the train's
   CI gate AFTER the tag is pushed, which burns the number (tags are never force-moved).
6. **preflight (post-bump)** — same checklist, now hard: pins == target, notes real, claims current,
   gate receipt at HEAD.
7. **tag** — `git tag v<ver>` on HEAD (the re-lock commit). On a lane (`--allow-lane`) this step
   STOPs instead and prints the merge: from the integration tree
   `git merge agent/<lane> -m "merge: cut v<ver>"`, then run the ritual again there to tag the merge
   commit (a non-fast-forward merge is a NEW commit — earn its gate receipt there too).
8. **STOP — never pushes.** Prints `git push origin HEAD v<ver>` and what it triggers (below), plus
   the post-push debts (train watch, draft review, T0, G1, Publish, `verify-host`, canary).

### 0.3 What the push does (read before you paste it)

- Pushing the `v*` tag **fires `.github/workflows/release-train.yml`**: gate → build (Windows + both
  Mac legs, updater signing REQUIRED) → assemble one multi-platform `latest.json` → stage a **DRAFT**
  on `starnet-releases`. A draft is invisible to users; nothing ships until you click Publish (§1.8).
- The stage-draft job uploads with `--clobber`: re-pushing or force-moving the tag **overwrites the
  staged installer/.sig** for that version. Never force-move a tag CI may have built from — bump a
  patch instead (§2.3).
- Push the branch WITH the tag (`git push origin HEAD v<ver>`): the tag alone drives the train; the
  branch push is what lets the source-release mirror (§1.8a) find the commit.

### 0.4 What the scripts cannot check (still yours)

- That the release notes are *true* — the script only checks the TODO scaffold is gone.
- The offline key backups (§4.1) — two physical copies, password "(empty string)".
- Whether a hotfix may waive the 48h RC soak (`docs/RELEASE_READINESS.md`) — the row stays WARN; you
  decide and you write the waiver down in `RELEASE_NOTES`/`NEXT.md`.
- Everything after the push: §1.6 onward is still a human watching a train and clicking Publish.

### 0.5 READY GATE (the ritual runs it for you; here is what it means)

`qa:ready` is row one of the preflight and the runbook's original section 0. There are exactly two
outcomes:

- **READY** → the house is green: zero open P0/P1 findings, the Guardian's last cycle is green and
  fresh on the current trunk head, `qa:journeys` passes, the Beginner Run isn't stuck, and the
  installed-exe smoke stamp (`qa/installed/last-smoke.json`) is fresh + GREEN. You're clear to cut.
- **NOT READY** → **stop. Do not bump. Do not tag.** Every NOT-READY line names the check that failed.
  Route those findings (`node scripts/qa/ledger.mjs --digest`), fix them on trunk, and re-run
  `npm run qa:ready` until it prints READY. No version is cut against a red house — that's the whole
  point of the gate (READY-GATE law, `docs/RELEASE_READINESS.md`).

No-fake-green: if `qa:ready` itself can't run (missing script, a check that errors), that is a NOT
READY — the preflight row goes FAIL, not green. And if you're cutting the real release off an RC you
soaked, the READY receipt you earned at soak end (`docs/RELEASE_READINESS.md` §2.3) is exactly this
gate — the preflight re-runs it at cut time to confirm it's still green.

### 0.6 Scripted soak — the mandatory MACHINE verdict (before any attended soak)

The attended packaged-desktop soak (`docs/RELEASE_READINESS.md` §2) stays the FINAL check: it is the only thing
that sees the installed exe, the Tauri shell, WebView2, and real providers. But it owns the dev box for 15–48h
and produces no machine-readable verdict — the first v0.10.0 soak failed after ~15h with nothing to read. So
before anyone spends those hours, the scripted soak must PASS:

```
npm run qa:soak            # 20-minute smoke (same harness, short; ONE heartbeat routine)
npm run qa:soak:scale      # 10-minute POWER-USER scale soak: 50 overlapping routines, cron cap 8, a 150 s outage
npm run qa:soak:release    # 720-minute release soak
# or any length: node scripts/qa/soak.mjs --minutes=N [--routines=N] [--max-parallel=N] [--outage-seconds=N] [--out=dir]
#   · CI: Actions → soak → minutes (+ routines / max_parallel / outage_seconds for the scale shape)
```

Both `qa:soak` AND `qa:soak:scale` must PASS before the attended soak. The scale run is the machine proof of
the power-user claim ("30–50 routines a day fire each one"): it seeds 50 routines with deliberately OVERLAPPING
schedules (1-min / 2-min intervals mixed with `* * * * *`, `*/2`, `*/3`, `*/5` and odd-minute cron patterns,
many due in the same minute), 3 SLOW routines whose mock answer outlives their period (so the lease must
produce `already-running` skips), 1 routine paused after arming (the driver must report it `disabled`), and 2
whose schedules are CORRUPTED in the store under the first restart (the driver must mark them
`schedule-unfireable` exactly once). The first restart holds the sidecar down 150 s — past the 2-minute misfire
grace — so the catch-up collapse is exercised for real.

It boots a hermetic SOURCE sidecar (scratch workspace + scratch app-data profile, free port, in-process MOCK
provider — zero spend, never your real station) and drives it unattended: real `/api/run` conversations, a
real `shell_exec` tool run, a cron routine firing on its own, `/api/diagnostics` / `/api/health` /
`/api/state/snapshot` reads every tick, and stop→boot restart cycles on the same workspace. Every tick samples
RSS, health latency, the fail-open swallowed-error tally, the diagnostics error ring, and workspace growth.

The receipt (`.dogfood/soak/<timestamp>/soak-receipt.json` + `SUMMARY.md`, schema
`starnet.soak-receipt.v1`) carries one PASS/FAIL per rule WITH the numbers and the threshold's reason: run
errors (tolerance 0 — the mock never errors), routine never fired, swallowed-error growth over the last third,
RSS leak trend over the last half, health p95 > 500 ms, any persisted entity (agent / routine / run / turn)
lost across a restart, an unplanned exit or orphaned child, an incomplete soak, the **routine ACCOUNTING**
ledger, and the **scheduler TICK** latency. An unobtainable metric is `null` with a reason, never 0.

The accounting rule is the per-routine occurrence ledger (the `## Routine accounting` table in SUMMARY.md):
for EVERY seeded routine, every occurrence its schedule owes inside the window — enumerated with
`sidecar/cron.js` `nextFireAt` from the armed `nextRunAt`, the scheduler's own math — must end as exactly one
of fired / already-running / caught-up / collapsed (a missed occurrence folded into the ONE misfire catch-up,
visible as the store's `nextRunAt` jumping more than a period) / disabled / unfireable; `at-capacity` deferrals
are transient and must still reach a terminal. A fire at an instant the schedule never owed, two fires for one
occurrence (the restart double-fire class), an owed occurrence with no terminal (lost), or a `nextRunAt`
advance the math does not predict is a FAIL, and the offending routine + instant are named. The tick rule
bounds p95 of the synchronous scheduler tick (`lastSuccessAt − lastTickAt` from `GET /api/cron`) at 300 ms
over the last half — the tick does a whole-store fsync + read-back (`saveCronJobs`) per advance, so this is
where the store write model shows its cost at 50 routines. A breach is a finding against the write model. **A FAIL is a finding, not a flaky gate — route it through the ledger; do not
re-run until green and do not tune the threshold.**

What it cannot see (so the attended soak still must): the packaged shell and its close/tray branches (that is
G1, §1.7a), WebView2, the installer/updater, real provider behavior and quota, channels, and anything aux
passes do under a real model (aux is off by default; `--aux` turns it on against the mock).

---

## 1. NORMAL CUT

You are cutting version `<VER>` (example below uses `0.2.0`). Sections 1.1–1.5 are now executed by
`npm run release:ritual` (§0.2) — they stay here as the reference for what each step does and as the
manual fallback if the script itself is broken.

### 1.1 Bump the version (creates the commit locally, pushes nothing)

```
npm run release:bump 0.2.0 -- --no-tag
```

This (per contract C1) bumps `package.json`, the `package-lock.json` root entries,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the `skynet-desktop` pin in
`src-tauri/Cargo.lock` (the five pins in `docs/BRAIN.md`), scaffolds `RELEASE_NOTES.md`, and commits
`release: v0.2.0` with those files only. It does **not** push. Without `--no-tag` it also tags — the
ritual passes `--no-tag` so the tag lands on the claims re-lock commit instead (§1.2a).

> Want to see exactly what it will touch first? `npm run release:bump 0.2.0 -- --dry-run`

### 1.2 Write the real release notes

`release:bump` scaffolds `RELEASE_NOTES.md` with a `# StarNet v0.2.0` header and a TODO
bullet. Open it and replace the TODO with the actual user-facing changes — these notes become
the GitHub release body AND the text a user sees in the in-app UPDATE CENTER. Then amend them
into the release commit so the tag points at the final notes:

```
git add RELEASE_NOTES.md
git commit --amend --no-edit
```

### 1.2a Re-lock the claims surface (its own commit)

`RELEASE_NOTES.md` is inside the locked release surface, so every bump owes a re-lock, generated
from the COMMIT (the audit never reads the working tree):

```
SHA=$(git rev-parse HEAD)
node scripts/qa/product-perfect/claims.mjs --refresh-surface --candidate $SHA > surface.json
# splice surface.json in as .releaseSurface of qa/product-perfect/claims.json
git commit -m "qa(claims): re-lock the release surface for v0.2.0" -- qa/product-perfect/claims.json
node scripts/qa/product-perfect/claims.mjs      # expect: PASS claims planning authority …
```

### 1.3 Review the commits before they leave your machine

```
git show --stat HEAD~1 HEAD
```

Eyeball: version is `0.2.0` in **all five** pins; `RELEASE_NOTES.md` reads the way you want; the
re-lock commit touches only `qa/product-perfect/claims.json`; no stray files snuck in.

### 1.4 Run the gate locally AFTER the bump, BEFORE pushing the tag

```
npm run test:fast 2>&1 | tee gate-fast.log
npm run test:http 2>&1 | tee gate-http.log     # when sidecar/ship/route code changed
```

Read the LAST LINE of each log — `run-fast-tests: OK — N step(s) green` — never the exit code. The
bump changes the shipped version, and any test coupled to it will fail the train's CI gate AFTER the
tag is pushed — which burns a version number (tags are never force-moved; a failed tag means cutting
a patch). This exact mistake cost v0.2.0 AND v0.2.1 on 2026-07-06 (a fixture pinned near the current
version). Green locally post-bump = the CI gate will be green too. Then tag the re-lock commit:

```
git tag v0.2.0
```

### 1.5 Push the tag — this is what starts the train

```
git push origin HEAD v0.2.0
```

Pushing the `v*` tag triggers `.github/workflows/release-train.yml` (§0.3 says what that means).
(The tag is the trigger; the branch push lets the source-release mirror find the commit.)

### 1.6 Watch the train (4 jobs)

Open the source repo → **Actions** → the **release-train** run for tag `v0.2.0`. Per contract
C4 it runs four jobs in sequence; each must go green before the next starts:

1. **gate** (ubuntu) — `npm ci` + `npm run test:fast`. Red here = the code is broken; nothing
   builds. Fix the code, cut a new patch tag. Do not proceed.
2. **build** (matrix: Windows NSIS / macOS arm64 app+dmg / macOS x64 app+dmg) — updater
   signing is **required** here; a leg fails if it did not produce its updater
   artifact + `.sig`. All four legs must be green.
3. **assemble** (ubuntu) — downloads every leg's artifacts, runs
   `release-assemble-manifest.mjs` to build ONE multi-platform `latest.json`, then runs
   `verify-update-host.mjs --manifest release/latest.json` against that local manifest.
4. **stage-draft** — creates (or re-syncs) a **DRAFT** release `v0.2.0` on
   `starnet-releases` with all installers + `.sig` files + `latest.json` attached, and prints a
   go/no-go summary ending in "DRAFT staged — nothing is live until you click Publish."

If any job is red, go to **section 2**.

### 1.7 Review the DRAFT release

Open: `https://github.com/androoAGI/starnet-releases/releases` → the draft
tagged **v0.2.0** (it has a grey "Draft" badge; it is NOT yet the public "latest").

Checklist — eyeball all of these before you publish:
- **Version / tag** is exactly `v0.2.0` (leading `v`, matches what you bumped).
- **Notes** are your real `RELEASE_NOTES.md` text, not the TODO scaffold.
- **Assets count.** You should see, at minimum:
  - `latest.json` (exactly one)
  - Windows: `StarNet_0.2.0_x64-setup.exe` + its `.sig`
  - macOS Apple Silicon: an `.app.tar.gz` (aarch64) + its `.sig`, and the `.dmg`
  - macOS Intel: an `.app.tar.gz` (x64) + its `.sig`, and the `.dmg`
  - Rule of thumb: **every updater artifact has a matching `.sig`** and **there is exactly one
    `latest.json`**. A `.sig` with no artifact, or an artifact with no `.sig`, is a red flag —
    do not publish; re-run **stage-draft** (section 2.2).

### 1.7a Packaged gates on the DRAFT — T0 clean-install + G1 packaged-lifecycle (RELEASE BLOCKERS)

Both run on a **fresh GitHub-hosted Windows VM** against the exact staged installer, so they prove
what no dev box and no `test:fast` step can: the installed exe on a clean machine. **Neither green =
do not publish.**

- **T0 clean-install proof** — Actions → `t0-clean-install-proof` → Run workflow → `tag` = `v0.2.0`.
  Artifact `clean-install-proof-<tag>` (schema `starnet.clean-install-proof.v1`). Proves first launch
  on a machine with no prior StarNet state.
- **G1 packaged-lifecycle** — Actions → `g1-packaged-lifecycle` → Run workflow → `tag` = `v0.2.0`
  (blank = latest *published* release; `cases` defaults to all three). Artifact
  `packaged-lifecycle-<tag>` holds `packaged-lifecycle-receipt.json`
  (schema `starnet.packaged-lifecycle-receipt.v1`, per-case PASS/FAIL + reasons + timings + process
  snapshots + the close branch the shell logged) plus the shell's `startup.log`. The job is red on any
  miss. What it proves, case by case:
  1. `idle-close` — default prefs, real `WM_CLOSE`: `skynet-desktop.exe` exits, **no orphan
     `<install>\node.exe`**, `startup.log` shows the idle branch (`close_to_tray=false`, no "staying
     resident"), relaunch shows a visible `StarNet` window and `/api/health` answers. This is the
     branch 0.10.5 / 0.10.6 escaped through.
  2. `close-to-tray` — `%APPDATA%\ai.skynet.harness\lifecycle.json` set to
     `{"version":1,"startMinimized":false,"closeToTray":true}` while the app is down, launch, `WM_CLOSE`:
     shell + sidecar **stay**, window hidden, log shows `staying resident (close-to-tray preference)`;
     a second launch (single-instance signal) **reveals** a visible window on the SAME pid — never a
     windowless resident.
  3. `updater-smoke` — installed exe ProductVersion == tag; the tag's own `latest.json` is pinned to
     it with a signed `windows-x86_64` entry; the public updater endpoint is reachable (and pinned to
     the tag when the tag is the published latest). Read-only — nothing is installed.

  **Not covered** (stated in the receipt too): the tray-menu **Quit** item, the armed-work residency
  branch (needs seeded scheduled work), macOS. The same matrix runs locally with
  `npm run qa:lifecycle:packaged -- --exe=<path\skynet-desktop.exe> --tag=v0.2.0` — but ONLY inside
  an isolated identity (a throwaway Windows user or VM): the shell reads `lifecycle.json` from the
  real `%APPDATA%\ai.skynet.harness` of whoever runs it, and the runner closes, rewrites that prefs
  file, and relaunches whatever exe you point it at. Never run it against your real station.

### 1.8 Publish (the only human ship gate)

On the draft release page: **Edit** (pencil) if needed → scroll to the bottom → make sure
**"Set as the latest release"** is checked and **"Set as a pre-release"** is **un**checked →
click **Publish release**.

The moment you publish, GitHub repoints `releases/latest` at v0.2.0, and every client's
6-hour check loop will start pulling the new `latest.json`.

### 1.8a Source repository release mirror (automatic)

Do **not** create a second release by hand on `androoAGI/starnet`. The
`sync-source-release` workflow in the source repository checks the dedicated distribution
repository every 15 minutes (and also supports **Run workflow** for an immediate sync).
After the distribution release is published it automatically:

1. reads only `starnet-releases/releases/latest` (drafts and prereleases are ineligible),
2. requires the matching immutable `v<version>` tag to exist in `androoAGI/starnet`,
3. downloads each human installer and verifies its GitHub SHA-256 digest,
4. creates the source release as a draft, uploads the byte-identical installers, and only
   then publishes it as the source repository's **Latest** release, and
5. re-reads the published source release and proves every asset digest still matches.

The workflow is idempotent: an exact existing mirror is a no-op, and an interrupted draft is
repaired on the next run. It refuses to rewrite a published release whose assets differ from
the distribution authority. If the source repository sidebar has not updated after 15 minutes,
open **Actions → sync-source-release → Run workflow**; a red run is a mirror problem and does
not change the already-published updater feed.

### 1.9 Prove the live endpoint is coherent

```
npm run release:verify-host
```

This fetches the LIVE endpoint (from `tauri.conf.json`) and checks, for every platform in the
manifest: schema, signature shape, version ≥ shipped, and asset URL reachability. Expect
**ALL CHECKS PASSED**. If it fails, go to **section 2.4**.

Pin the expected version to catch a stale "latest":
```
npm run release:verify-host -- --expect-version 0.2.0
```

### 1.10 Canary proof (an actually-installed older StarNet takes the update)

`verify-host` proves the *feed* is correct; the canary proves the *client* consumes it. Do
this on a machine (or VM) that already has an **older** StarNet installed (e.g. 0.1.9):

1. Launch that older installed StarNet (the packaged desktop app, not a browser/dev build).
2. Open **Settings** → **UPDATES** section → click **UPDATE CENTER**.
3. In the UPDATE CENTER, click **CHECK NOW**.
4. Confirm the card shows **AVAILABLE v0.2.0** with your release notes.
5. Click **INSTALL UPDATE**. Watch the progress bar go downloading → installing → restarting.
   (The signature is verified by Tauri against the baked-in pubkey during install; a bad/mis-
   signed artifact fails here instead of installing.)
6. After it relaunches, open UPDATE CENTER again — the header should read **current v0.2.0** and
   "No update is pending."

That is a done release: feed green + a real old client pulled, verified, installed, and
relaunched onto the new version.

---

## 2. PARTIAL-FAILURE RECOVERY

The train is designed so you almost never have to re-cut from scratch. Match your symptom.

### 2.1 One matrix leg is red (e.g. macOS x64 failed, others green)

- Open the failed **build** run → **Re-run jobs** → **Re-run failed jobs**. Transient runner
  flakes (network, cache, the E0463 ctor race) usually clear on a re-run.
- If the same leg fails twice with a real compile/sign error, that platform genuinely can't
  build this commit. **Do not publish a draft that is missing a platform** — every user on the
  missing OS would be stranded. Fix the cause, then cut a patch (`npm run release:bump 0.2.1`).
- If a leg failed only because the updater `.sig` was missing, the signing secret is empty on
  the source repo — see **section 4** to set `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, then re-run.

### 2.2 Draft is half-uploaded (some assets attached, some missing)

The **stage-draft** job uploads assets with `--clobber`, so it is **idempotent** — re-running
it re-uploads/overwrites without erroring on the assets already there.

- Actions → the release-train run → **Re-run jobs** → re-run **stage-draft** (re-running
  `assemble` too is fine and cheap if the manifest itself looked wrong).
- Then re-check the draft's asset list per **section 1.6**.
- Do NOT hand-delete individual assets on the draft first; `--clobber` handles overwrites.

### 2.3 "Tag already exists" when re-running

The tag `v0.2.0` already exists on the source repo (you pushed it) and possibly a draft
release exists on `starnet-releases`. Decide by whether the *artifacts* are wrong:

- **Artifacts are fine, only the draft is messy/half-uploaded** → keep the tag. Just re-run
  **stage-draft** (2.2). `gh release create` in the train is written to reuse an existing draft
  and `--clobber` its assets, so a re-run repairs it in place.
- **You need to actually rebuild** (bad commit, wrong notes baked into the tag, wrong version)
  → do NOT reuse the tag. **Bump a fresh patch version** — it is always safer than force-moving
  a tag that CI has already built from:
  ```
  npm run release:bump 0.2.1
  ```
  If a broken **draft** for the old version is lying around on `starnet-releases`, delete it
  first (drafts are invisible to users, so this is harmless):
  `Releases → the v0.2.0 draft → Delete`.
- Only force-move a tag (`git tag -f` + `git push -f origin v0.2.0`) if **nothing** has been
  published or drafted from it yet and you are certain no CI artifacts depend on it. When in
  doubt, bump the patch instead.

### 2.4 `release:verify-host` is red AFTER you published

The script prints a "Common causes" list on failure (copied verbatim from
`verify-update-host.mjs`'s `finish()` so you don't have to open the file):

```
The updater path is NOT yet live/coherent. Common causes:
  - release not published yet (draft releases do not resolve latest/download)
  - tag is not exactly v<version>, so the pinned installer URL 404s
  - latest.json / installer / .sig not all attached to the release
```

Translated to action:
- **"release not published yet"** — you're still looking at a draft. Publish it (1.7). `latest`
  only resolves for a *published, non-prerelease* release.
- **"tag is not exactly v<version>"** — the release tag isn't `v0.2.0`, so the installer URL
  inside `latest.json` (pinned to `/download/v0.2.0/…`) 404s. The tag on the release must be
  exactly `v` + the version. Re-tag the release correctly or cut a patch with the right tag.
- **"latest.json / installer / .sig not all attached"** — an asset is missing from the
  published release. Re-run **stage-draft** to re-attach (2.2). If you already published, you
  can attach the missing asset directly to the published release, then re-run verify.
- **"installer asset reachable" fails** — the `latest.json` URL is right but the asset behind
  it 404s (asset name mismatch, or attached to the wrong release). Confirm the asset filename on
  the release matches the `url` inside `latest.json`.

---

## 3. EMERGENCY ROLLBACK

A bad version is live and users are pulling it. You have two independent populations:

### 3.1 Users who have NOT updated yet — roll back the feed

Delete the bad release on `starnet-releases`:
`Releases → v0.2.0 (the bad one) → Delete release`.

GitHub immediately repoints `releases/latest` at the **previous** published release (e.g.
0.1.9), which carries **its own** `latest.json`. Within minutes, every client that hasn't
updated yet will see the older manifest again and stop pulling the bad one. No manifest edit is
needed — the pointer follows the newest published release automatically.

> If you'd rather not lose the release entirely: edit it and check **"Set as a pre-release"**.
> GitHub never points `latest` at a prerelease, so this also takes it out of the feed while
> keeping the assets. Deleting is the cleaner, more obvious 2am move.

### 3.2 Users who ALREADY updated to the bad version — FIX FORWARD ONLY

Tauri's updater **never offers a lower version** — it will not downgrade. Anyone already on the
bad build cannot be rolled back; they can only be moved *forward* to a fixed build. So:

```
npm run release:bump 0.2.1
```
Fix the bug in that patch, run the full train (section 1), and publish it. Already-updated
users get 0.2.1 on their next check; not-yet-updated users were already protected by 3.1.

### 3.3 Comms template (paste into your channel / release notes)

```
StarNet 0.2.0 had a problem and has been pulled. If you're still on an earlier
version you'll stay there — nothing to do. If you already updated to 0.2.0, a fix
(0.2.1) is on the way; your app will offer it automatically within a few hours, or
open Settings → UPDATES → UPDATE CENTER → CHECK NOW to grab it immediately.
Sorry for the noise.
```

---

## 4. KEY MANAGEMENT (read this before you ever need it)

`~/.tauri/starnet-updater.key` is the updater signing key. Its **public** half is baked into
**every StarNet binary ever shipped** (`tauri.conf.json` → `plugins.updater.pubkey`). The
endpoint is fixed and the pubkey in installed apps can't be changed remotely. Therefore:

> **If you lose this key, no installed StarNet can ever update again — on any machine, forever.**
> There is no re-signing path for already-shipped binaries. This is the single highest-
> consequence item in the whole project. Back it up before you do anything else tonight.

### 4.1 Back it up NOW — ≥2 offline copies

The key is a small text file. Copy it to at least two places that are **not** this machine and
**not** a synced cloud folder you could accidentally wipe:

```
# see it exists
ls -l ~/.tauri/starnet-updater.key

# copy to two removable/offline destinations (adjust drive letters)
cp ~/.tauri/starnet-updater.key /d/backups/starnet-updater.key      # e.g. a USB stick
cp ~/.tauri/starnet-updater.key /e/backups/starnet-updater.key      # e.g. a second stick / drive
```

Also record the key's password. It is **empty** (that's deliberate — see the header of
`scripts/release-cut.mjs`), so the note is literally "password: (empty string)". Store that
note with the backups so a future you doesn't assume it's lost.
Treat these copies like a house key: offline, physically controlled, never committed to git and
never pasted into chat.

### 4.2 Refresh the GitHub secrets (source repo)

The train signs on CI, so the key also lives as two Actions secrets on the **source** repo
(Settings → Secrets and variables → Actions):
- `TAURI_SIGNING_PRIVATE_KEY` — the **entire contents** of `~/.tauri/starnet-updater.key`
  (the whole file, not a path).
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — an **empty** string.

To refresh (e.g. new machine, or you rotated): open each secret → Update → paste the file
contents / leave the password empty → Save. The publish token
`RELEASES_TOKEN` (fine-grained PAT with Contents:write on `starnet-releases`) also lives here;
refresh it the same way if it expires.

### 4.3 Rotation plan (only if the key is compromised — it is a big deal)

You cannot just swap keys: installed apps trust the OLD pubkey, so a release signed with a NEW
key would be **rejected** by every existing install and they'd be stuck. Rotation must be a
two-step bridge:

1. **Interim release, signed with the OLD key**, whose `tauri.conf.json` carries the **NEW**
   pubkey. Existing installs accept it (old signature) and, once installed, now trust the new
   pubkey.
2. **All subsequent releases signed with the NEW key.** Clients that took the interim release
   accept them; clients that skipped it are stuck on old-key trust and must be walked to the
   interim build manually.

Because step 2 strands anyone who missed the interim release, keep the interim build available
for a long time and announce it loudly. Rotate only if you truly must (key leak). Otherwise the
right answer is: **don't lose the key** (4.1).

---

## 5. STANDING RULES (violate these and you break the feed for real users)

1. **Only the release train attaches `latest.json`.** `latest.json` is the updater feed. The
   train is the *only* thing that should ever put a `latest.json` on `starnet-releases`. Never
   hand-upload one.
2. **Anything else published on `starnet-releases` must be a PRE-release.** GitHub never points
   `releases/latest` at a prerelease, so test/beta builds (e.g. `desktop-build.yml`'s
   `publish-test`) can't disturb the live feed. If you publish a *non*-prerelease without a
   `latest.json`, the endpoint 404s and every client's check errors until you fix it.
3. **The robocopy in-place hot-patch is DEV-ONLY.** It's a developer convenience for patching a
   local install; it is **never** a user-facing update path. Users update only through the
   signed updater feed.
4. **Verify green on all three supported platform keys before you Publish.** The draft must
   have windows-x86_64, darwin-aarch64, and darwin-x86_64 present and signed, and
   `verify-update-host` (run against the manifest) must pass for all three. Linux packages are
   internal/manual artifacts, not a supported public release target; if support is restored,
   add both linux-x86_64 and linux-x86_64-deb to the train and verifier together.
5. **`release.yml` is emergency-fallback only.** It's the old Windows-only, publish-immediately
   path (carries a deprecation header). Do **not** run it with `publish=true` unless the release
   train itself is broken and you must ship. The normal path is always the train.

---

### VERIFICATION STATUS (updated 2026-07-09)

The build tooling this runbook drives has since **merged to trunk** (`feat/harness-backend`) — it was
being built by parallel lanes when the runbook was first written:

- **`npm run release:bump`** (`scripts/release-bump.mjs`), **`scripts/release-assemble-manifest.mjs`**,
  and the 4-job **`.github/workflows/release-train.yml`** (gate → build → assemble → stage-draft) all
  exist on trunk now. Sections 1–2 describe real scripts/jobs, not pending ones.
- **`verify-update-host.mjs`** now supports `--manifest <file>`, `--expect-version X.Y.Z`,
  `--require-platforms <list>`, and `--check-urls`, and validates the full supported public
  platform set — Windows plus both macOS architectures (`npm run release:verify-host` is wired
  in `package.json`). Linux/manual manifests can opt into both Linux keys explicitly.

**Still unverified — do not trust these until proven:**

- **The release train has never completed a fully-green end-to-end run, and nothing has ever been
  published.** The last version *built* is `0.4.1`; `starnet-releases` has no public release, so
  `releases/latest` currently 404s. Sections 1–2 are written to the workflow as it stands, but the
  tag-push → gate → build → assemble → stage-draft path has not been proven green on live CI (a prior
  cut stalled at the P1.5 build-provenance stamp). Treat the first real cut as the shakedown run.
- **The exact top-level click to reach Settings** in the packaged app was not pinned from code;
  the verified path *inside* Settings is `UPDATES` section → `UPDATE CENTER` button → then
  `CHECK NOW` / `INSTALL UPDATE` (`frontend/app/updates.js`). Confirm the Settings entry point
  on the live desktop build during the canary.

## Local update canary — offline end-to-end proof (no public exposure)

`npm run release:canary` (`scripts/update-canary.mjs`) proves the FULL update cycle on one
Windows machine with nothing published anywhere: check loop → manifest fetch → version
compare → download → minisign verification against the baked pubkey → NSIS passive install →
restart as the new version. The manifest comes from the REAL `release-assemble-manifest.mjs`
(crypto verification included) with only the asset base swapped to `127.0.0.1`.

Canary builds are `StarNet Canary` / `ai.skynet.harness.canary` — side-by-side install,
separate `%APPDATA%` workspace; your real StarNet install and data are untouched. Uninstall
"StarNet Canary" from Windows afterwards.

```powershell
node scripts/update-canary.mjs build-old   # installer @ current version, endpoint = localhost
node scripts/update-canary.mjs build-new   # installer @ patch+1 + signed feed (latest.json)
node scripts/update-canary.mjs serve       # leave running; logs every request the app makes
# install .canary\old\*.exe → open StarNet Canary → Settings → UPDATES → UPDATE CENTER →
# CHECK NOW → INSTALL UPDATE → app restarts as the bumped version. The serve log is the receipt.
```

Each build is a full Rust release build (10–30 min; rustc ctor-race crash = re-run, the cache
resumes). Requires `~/.tauri/starnet-updater.key` (same key as production — deliberately).
This canary does NOT replace the public-path proof (older install → published release →
restart); it de-risks everything except the literal production URL before anything goes public.
