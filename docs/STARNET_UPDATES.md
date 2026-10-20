# StarNet Desktop Updates

StarNet desktop updates are delivered through Tauri's signed updater. The app checks a HTTPS `latest.json` manifest, verifies the downloaded installer signature against the public key embedded in `src-tauri/tauri.conf.json`, then runs the installer from inside the app.

## User Goal Loop

Goal: keep the installed StarNet desktop app on the newest trusted release with the least user friction.

Loop:

1. On app boot, `Updates.init()` asks Rust for local updater status and starts the timer.
2. If automatic checks are enabled and the loop is due, `starnet_update_check` fetches the signed release manifest.
3. If no update exists, the next check is scheduled for 6 hours later.
4. If the check fails, the loop retries with exponential backoff from 15 minutes up to 6 hours.
5. If an update exists, StarNet posts one notification per version and shows it in System -> Updates.
6. When the user clicks Install Update, `starnet_update_install` downloads, verifies, installs, and restarts or exits into the installer as the platform requires.
7. Remind Tomorrow suppresses prompts until the reminder deadline. Skip Version suppresses non-critical updates for that version. Critical updates bypass skip/reminder suppression.

## Release Endpoint

The desktop build checks the **public GitHub Releases** channel:

```text
https://github.com/androoAGI/starnet-releases/releases/latest/download/latest.json
```

`starnet-releases` is a dedicated public binary-distribution repo, separate from the public
source repository. GitHub
redirects the `latest/download` path to the newest published release, so the endpoint never
changes between versions — only the release contents do. The native Tauri updater fetches
this directly (it is not subject to the webview CSP).

> Historical note: earlier builds pointed at `https://updates.starnet.app/...`, a host that
> never resolved, so no shipped install ever updated. That endpoint is retired.

The endpoint serves the static Tauri updater JSON:

```json
{
  "version": "0.1.8",
  "notes": "Release notes shown inside StarNet.",
  "pub_date": "2026-07-03T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "contents of the .sig file",
      "url": "https://github.com/androoAGI/starnet-releases/releases/download/v0.1.8/StarNet_0.1.8_x64-setup.exe"
    }
  }
}
```

The per-platform `url` is pinned to the versioned release tag `v<version>`, so the release
tag MUST be exactly `v<version>`. Optional top-level `critical: true` is understood by
StarNet's UI and notification loop.

## Signing Key

The public updater key is embedded in `src-tauri/tauri.conf.json`. The matching private key was generated outside the repository at:

```text
C:\Users\<you>\.tauri\starnet-updater.key
```

It is an **rsign encrypted secret key with an empty password**. Do not commit it. Back it up
in a password manager or release vault before shipping a public build. If that private key is
lost after release, existing users will not be able to install future signed updates.

### The signing stall (why 0.1.7 shipped without updater artifacts)

`tauri build` invokes minisign to produce the `.sig`. Because the key is encrypted, the CLI
**blocks on an interactive password prompt** when its empty password is supplied through the
normal build environment. That interactive stall is why an earlier build set
`createUpdaterArtifacts: false` to get unblocked (which silently disabled the updater, since
the updater REQUIRES the `.sig`). The release cutter avoids that path: it builds the NSIS
installer first, then signs it explicitly with the key file and `--password=`. No signing
environment variables are required for a local cut:

```powershell
Test-Path "$env:USERPROFILE\.tauri\starnet-updater.key" # must print True
npm run release:cut
```

`createUpdaterArtifacts` is `true` in `tauri.conf.json` and stays that way.

## Build And Publish — one command

```powershell
npm run release:cut
```

`scripts/release-cut.mjs` does the whole thing from trunk: it verifies the versions match,
pre-builds the `ctor` crates (dodging the E0463 parallel-build race), builds NSIS and signs
the final installer with the explicit local key path, stages the installer + `.sig` +
`latest.json` into `release/`, and prints the exact upload checklist. Then, after Andrew
uploads the release, prove the channel is live:

```powershell
npm run release:verify-host
```

`scripts/verify-update-host.mjs` fetches the live `latest.json`, validates its schema and
signature fields, and confirms the referenced installer asset is reachable.

### Manual steps (what only Andrew can do)

1. Bump both desktop versions in lockstep (`release:cut` refuses to run if they disagree):
   - `src-tauri/Cargo.toml` -> `[package].version`
   - `src-tauri/tauri.conf.json` -> top-level `version`
2. Run `npm run release:cut`.
3. On the PUBLIC `starnet-releases` repo, create a GitHub Release tagged **exactly**
   `v<version>` and attach all three staged assets: the installer, its `.sig`, and
   `latest.json`. Publish it (a draft does not resolve via `latest/download`).
4. `npm run release:verify-host` to prove the endpoint is live.
5. Launch an older installed StarNet build and confirm System -> Updates sees the new
   version, downloads it, verifies the signature, and launches the installer.

## Files

- `src-tauri/src/main.rs`: native updater commands and pending update cache.
- `frontend/app/updatecore.js`: pure autonomous goal/loop planner.
- `frontend/app/updates.js`: Update Center UI and Tauri command bridge.
- `test/updatecore.test.js`: planner regression tests.
- `scripts/starnet-release-manifest.mjs`: low-level release manifest generator.
- `scripts/release-cut.mjs`: one-command release cutter (build + sign + stage + checklist).
- `scripts/verify-update-host.mjs`: live endpoint verifier (run after upload).
- `INSTALL.md`: public install instructions and the release-train signing/notarization contract.
