# Update pipeline audit — 2026-07-06 (pre-launch)

Scope: everything between "trunk is ready" and "an installed user is on the new version."
Grounded against current code (not docs): `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs:1001-1093`,
`frontend/app/updates.js` + `updatecore.js`, `scripts/release-cut.mjs`, `scripts/verify-update-host.mjs`,
`scripts/starnet-release-manifest.mjs`, `.github/workflows/release.yml`, `.github/workflows/desktop-build.yml`.

## What is already solid (do not rebuild)

- **Signature chain is real.** minisign pubkey baked into `tauri.conf.json`; `release-cut.mjs` hard-fails if
  `createUpdaterArtifacts` is off, if the `.sig` is missing, or if the `.sig` is staler than the installer.
- **Version coherence gate.** Preflight fails if `Cargo.toml` and `tauri.conf.json` disagree.
- **User data is update-safe.** Workspaces live in `%APPDATA%/ai.skynet.harness/workspaces` (main.rs:307-318),
  NOT the install dir; 5-root legacy migration is copy-if-missing and runs before sidecar spawn; covered by
  `test/desktop-workspace-migration.test.js`. NSIS reinstall cannot eat user state.
- **Client check loop is sane.** Auto-check on startup + every 6h, exponential backoff 15m→6h on failure,
  notify-once-per-version with snooze/skip, no silent auto-install (user-initiated install only).
- **Test publishes can't leak.** `desktop-build.yml publish-test` creates PRE-releases only — GitHub never
  points `releases/latest` at a prerelease, so the updater feed is undisturbed.
- **Post-publish proof exists.** `verify-update-host.mjs` checks manifest schema, version coherence, and
  installer reachability against the LIVE endpoint.

## Weak areas

### P0 — will cause chaos at launch

1. **The update feed is Windows-only.** `latest.json` (built by release-cut.mjs:189-196) contains only
   `windows-x86_64`. Mac/Linux installers exist (desktop-build matrix) and the mac legs even produce the
   updater artifacts (`.app.tar.gz` + `.sig`), but nothing assembles them into the manifest and `release.yml`
   builds Windows only. **Every Mac/Linux user you ship to is permanently stranded on their install version.**
2. **Publish is instant with no human checkpoint.** `release.yml` runs `gh release create` (published, not
   draft) — the moment CI finishes, `releases/latest/download/latest.json` flips and every client's 6-hour
   loop starts pulling it. The only guard against an accidental ship is a workflow-input default. There is no
   draft → verify → promote step.
3. **No OS code signing.** Windows: no Authenticode → SmartScreen "unknown publisher" on first install AND
   the NSIS updater exe every update; some AVs quarantine mid-update. Mac: unsigned/un-notarized → Gatekeeper
   wall. This is the single biggest source of "update chaos" for real users.

### P1 — operational fragility

4. **Two overlapping pipelines, no source-of-truth trigger.** `release.yml` (dispatch, Windows, publishes
   latest) vs `desktop-build.yml` (dispatch or `v*` tag, 3 platforms, prerelease only). A `v*` tag builds but
   does not release; `release.yml` never tags the source repo — no traceability from a shipped build back to
   a commit.
5. **No test gate on the release path.** `release.yml` goes checkout → build → publish. `test:fast` /
   release smoke are never run.
6. **Manual version bump** across `tauri.conf.json` + `Cargo.toml` (preflight catches drift but nothing
   fixes it); `RELEASE_NOTES.md` handling is ad-hoc (build fails late if missing).
7. **No idempotency/partial-failure story.** `gh release create` fails if the tag exists; a half-uploaded
   release (installer up, latest.json missing) leaves the feed ambiguous. No retry/resume runbook.
8. **Rollback is possible but undocumented.** Deleting a bad release reverts `releases/latest` to the prior
   release (which carries its own latest.json) — instant rollback for not-yet-updated users. Already-updated
   clients can only be fixed forward (Tauri never offers a lower version). Nobody wrote this down.
9. **Updater key is a single point of total loss.** `~/.tauri/starnet-updater.key`, empty password, one dev
   machine + GitHub secret. Pubkey is baked into every shipped binary: **lose the key and every installed app
   can never update again** (no re-signing path, endpoint is fixed). No offline backup, no rotation plan.
10. **verify-update-host checks Windows only** (hardcoded `windows-x86_64`) — it will pass green while the
    mac/linux feed is broken or absent.
11. **The `latest` pointer is unprotected.** Any future non-prerelease published on `starnet-releases`
    without a `latest.json` asset makes the endpoint 404 → every client's check errors until fixed.

### P2 — polish / future insurance

12. No update channels (stable/beta) — the prerelease trick is an acceptable beta channel for now.
13. Update-available signal is a one-shot toast; no persistent badge in the main UI.
14. No staged rollout — fine at this scale; the mitigation is fast fix-forward + the rollback runbook.
15. **No workspace schema version stamp.** Sidecar stores are versionless JSON; future shape changes rely on
    ad-hoc backward compat. Stamp `schemaVersion` into the workspace root NOW (cheap) so future migrations
    have something to key on.
16. `starnet-release-manifest.mjs` is stale/misleading (single-platform, example URL points at the dead
    `updates.starnet.app`). Rewrite as the multi-platform assembler or delete.

## Target design — the release train

One path, one button, one human checkpoint:

1. **`npm run release:bump 0.2.0`** (new script): bumps `tauri.conf.json` + `Cargo.toml` (+ `cargo update -w`
   for the lockfile), scaffolds `RELEASE_NOTES.md`, commits `release: v0.2.0`, tags `v0.2.0`.
2. **Tag push triggers `release-train.yml`** (replaces release.yml's publish role):
   - **Gate job**: `npm ci` + `npm run test:fast`. Red = no builds.
   - **Build matrix**: win-x64 / linux-x64 / darwin-arm64 / darwin-x64, updater artifacts REQUIRED
     (hard-fail if `.sig` missing — the silent `createUpdaterArtifacts:false` fallback stays only in
     desktop-build test builds). OS signing applied when secrets exist.
   - **Assemble job**: download all artifacts, build ONE multi-platform `latest.json`
     (`windows-x86_64` → nsis exe, `darwin-aarch64`/`darwin-x86_64` → `.app.tar.gz`, `linux-x86_64` →
     AppImage), each with its own signature. Rewrite `starnet-release-manifest.mjs` to do this.
   - **Stage job**: create a **DRAFT** release `v<version>` on `starnet-releases` with all assets +
     `latest.json`; run the verify script against the draft's assets via API; print the go/no-go summary.
3. **The ONLY publish is human**: Andrew opens the draft, checks the verify summary, clicks **Publish**.
   Until that click, zero users can receive anything. (Optionally wrap promotion in a GitHub Environment
   with a required-reviewer rule for a real approval button.)
4. **Post-publish**: `release:verify-host` extended to all platforms + a canary machine/VM left on the
   previous version proving the unattended update path each cut.
5. **Runbooks in docs/RELEASE_RUNBOOK.md**: normal cut, partial-upload recovery, emergency rollback
   (delete release → latest reverts), fix-forward policy, key-loss = product-death warning.

### Non-code actions (Andrew only)

- **Back up `~/.tauri/starnet-updater.key` to ≥2 offline locations TODAY.** This is the highest
  consequence-per-minute item in the whole audit.
- **Windows signing**: Azure Trusted Signing (cheapest legit path) or an OV cert; wire into the train.
- **Apple**: $99 Developer Program → certs/notarization secrets (desktop-build.yml is already wired for them).

### Rules going forward

- Nothing publishes a non-prerelease to `starnet-releases` except the release train (protects `latest`).
- The robocopy in-place hot-patch recipe is DEV-ONLY, never a user-facing update path.
- Every release train run must end with `verify-update-host` green on ALL platforms before the draft is
  published.
