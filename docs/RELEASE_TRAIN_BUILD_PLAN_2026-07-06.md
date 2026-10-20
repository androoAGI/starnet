# Release-train build plan — 2026-07-06

Executes the target design from docs/UPDATE_PIPELINE_AUDIT_2026-07-06.md. Five parallel lanes,
each built by an Opus agent in its own worktree (`gen-trees\new-agent-tree.ps1 <name>`), merged
to trunk by the orchestrator via starnet-merge-ritual, then verified front-to-back.

## Pinned contracts (all lanes build against these — do not drift)

### C1. `scripts/release-bump.mjs` (lane BUMP)
```
node scripts/release-bump.mjs <version> [--dry-run] [--no-tag]
```
- Validates `<version>` is SemVer and strictly greater than current tauri.conf.json version.
- Updates: `src-tauri/tauri.conf.json` `.version`, `src-tauri/Cargo.toml` `version = "..."`
  (package section only), then refreshes `src-tauri/Cargo.lock` for the app package if the
  lockfile pins it (edit lockfile entry directly or `cargo update -p` — must not require
  network beyond the crates already vendored; if cargo is unavailable, patch the lockfile
  entry textually and say so in output).
- Scaffolds `RELEASE_NOTES.md` (overwrite) with a `# StarNet v<version>` header + TODO bullet.
- Commits `release: v<version>` with pathspecs (ONLY the 4 files above), creates tag `v<version>`
  unless `--no-tag`. NEVER pushes.
- `--dry-run` prints every change and does nothing.
- npm scripts: `"release:bump": "node scripts/release-bump.mjs"`.

### C2. `scripts/release-assemble-manifest.mjs` (lane MANIFEST)
Replaces stale single-platform `scripts/starnet-release-manifest.mjs` (delete it, migrate its
SemVer/https/signature validations).
```
node scripts/release-assemble-manifest.mjs --dist <dir> --version <X.Y.Z> \
  --repo <owner/repo> --tag v<X.Y.Z> [--notes-file RELEASE_NOTES.md] [--out release/latest.json] \
  [--allow-missing <plat,plat>]
```
- Recursively scans `--dist` for updater artifacts + sigs:
  - `*-setup.exe` + `.sig`            → `windows-x86_64`
  - `*.app.tar.gz` + `.sig`, path/name containing `aarch64`/`arm64` → `darwin-aarch64`
  - `*.app.tar.gz` + `.sig`, path/name containing `x64`/`x86_64`   → `darwin-x86_64`
  - `*.AppImage` + `.sig`             → `linux-x86_64`
- Emits ONE latest.json: `{version, notes, pub_date, platforms: {<plat>: {signature, url}}}`
  with `url = https://github.com/<repo>/releases/download/<tag>/<encoded-asset-basename>`.
- HARD-FAILS if any of the 4 platforms is absent, unless listed in `--allow-missing`.
  Fails on: artifact without sig, empty sig, duplicate platform match, version not SemVer.
- Prints a per-platform summary table (artifact, sha256 prefix, sig bytes).

### C3. `scripts/verify-update-host.mjs` extensions (lane VERIFY)
Keep existing live-endpoint behavior as default. Add:
- ALL-platform validation: for every entry in `manifest.platforms`, check signature shape and
  asset URL reachability (HEAD w/ ranged-GET fallback, as today). The windows-only hardcode at
  the current line ~92 becomes a loop. `--require-platforms windows-x86_64,darwin-aarch64,darwin-x86_64,linux-x86_64`
  (default = exactly these four; `--require-platforms windows-x86_64` opts down).
- `--manifest <file>` mode: validate a LOCAL latest.json (schema + platform set + sig shape;
  skip URL reachability unless `--check-urls`). This is what CI runs against the draft before
  any publish.
- `--expect-version` retained; add check that every platform URL contains `/download/v<version>/`.
- npm script `release:verify-host` unchanged (same default behavior, now multi-platform).

### C4. `.github/workflows/release-train.yml` (lane TRAIN)
Trigger: `push: tags: ['v*']` + `workflow_dispatch` (input: tag). NEVER publishes — draft only.
Jobs:
1. `gate` (ubuntu): `npm ci` + `npm run test:fast`. Red = everything stops.
2. `build` (needs gate): reuse the EXACT matrix/steps shape of `desktop-build.yml` (win nsis /
   ubuntu-22.04 deb+appimage / macos arm64 + x64 dmg), with one difference: updater signing is
   REQUIRED — if `TAURI_SIGNING_PRIVATE_KEY` secret is empty, fail with a clear error; never
   fall back to `createUpdaterArtifacts:false` here. Verify each leg produced its updater
   artifact + `.sig` and fail the leg if not. Upload per-target artifacts.
3. `assemble` (needs build, ubuntu): download all artifacts → `release-assemble-manifest.mjs
   --dist dist --version $V --repo nonfungiblefunyuns-ship-it/starnet-releases --tag v$V`
   → `verify-update-host.mjs --manifest release/latest.json` → upload `release/` artifact.
4. `stage-draft` (needs assemble): `gh release create v$V --draft --repo
   nonfungiblefunyuns-ship-it/starnet-releases --title "StarNet $V" --notes-file RELEASE_NOTES.md`
   with ALL installers + sigs + latest.json attached (`gh release upload` for idempotent re-runs:
   if the draft already exists, `--clobber` assets instead of failing). Print a go/no-go summary:
   "DRAFT staged — nothing is live until you click Publish on GitHub."
   Env: `GH_TOKEN: secrets.RELEASES_TOKEN`.
- Version source: `jq -r .version src-tauri/tauri.conf.json`; fail if it doesn't match the tag.
- Also in this lane: add a deprecation header comment to `.github/workflows/release.yml`
  ("superseded by release-train.yml — publish path kept as emergency fallback only; do not run
  with publish=true unless the train is broken") — do NOT delete it.

### C5. `docs/RELEASE_RUNBOOK.md` (lane RUNBOOK)
Sections, concrete commands throughout:
1. Normal cut: bump → push tag → watch train → review draft → Publish → post-publish
   `npm run release:verify-host` → canary update proof (older install, System → Updates).
2. Partial-failure recovery: failed leg (re-run job), half-uploaded draft (re-run stage-draft,
   `--clobber`), tag exists (delete draft + re-run vs bump a patch).
3. Emergency rollback: delete the bad release → `releases/latest` reverts to prior (prior
   release carries its own latest.json); updated clients are fix-forward only; template comms.
4. Key management: the updater key at `~/.tauri/starnet-updater.key` is unrecoverable —
   loss = no installed app can ever update. Backup instructions (2+ offline copies), GitHub
   secret refresh, rotation plan (ship interim version signed w/ old key containing new pubkey).
5. Rules: only the train attaches latest.json; anything else on starnet-releases must be a
   prerelease; robocopy hot-patch is dev-only; verify green on all platforms before Publish.

## Lane → agent map

| Lane     | Worktree name    | Files owned                                                        |
| -------- | ---------------- | ------------------------------------------------------------------ |
| BUMP     | release-bump     | scripts/release-bump.mjs, package.json (script line), test file    |
| MANIFEST | release-manifest | scripts/release-assemble-manifest.mjs, delete starnet-release-manifest.mjs, test file |
| VERIFY   | verify-host      | scripts/verify-update-host.mjs, test file                          |
| TRAIN    | release-train    | .github/workflows/release-train.yml, release.yml header comment    |
| RUNBOOK  | runbook          | docs/RELEASE_RUNBOOK.md                                            |

No lane touches shared/events.js, shared/schema.js, sidecar/, or frontend/. package.json is
touched ONLY by BUMP (one script line) — no conflicts expected.

## Done criteria (every lane)

- `npm run test:fast` green in the worktree.
- New/changed scripts have a fast unit test (fixtures, no network) wired into the fast gate the
  same way existing script tests are.
- Lane report states exactly what was verified with command output, and what was not.

## Deferred (explicitly out of this sprint)

- Workspace `schemaVersion` stamp (sidecar change — separate lane later, owned-file risk).
- Persistent UI update badge (P2 polish).
- OS code signing + key backup — Andrew-only actions (audit doc).
