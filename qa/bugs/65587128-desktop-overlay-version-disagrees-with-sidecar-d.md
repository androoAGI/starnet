---
fingerprint: 65587128
slug: desktop-overlay-version-disagrees-with-sidecar-d
title: Desktop overlay version disagrees with sidecar diagnostics
surface: release
severity: P2
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Desktop overlay version disagrees with sidecar diagnostics

## Symptom

An installed canary reports 0.11.2 in native BuildInfo and the updater, but 0.11.1 in `/api/version`. Exact installed verification correctly refuses that disagreement.

## Repro

Build and install a Tauri canary with the version overlay set to 0.11.2 while normal Cargo/version pins remain 0.11.1. Compare `starnet_build_info.version` with the live `/api/version` app field.

## Evidence

`.dogfood/release-0112-closeout/installed-identity.json` records shell 0.11.2 versus sidecar 0.11.1 on source `31ce0e785`. `src-tauri/src/main.rs` injected `CARGO_PKG_VERSION` instead of the same resolved package version used by BuildInfo. The repair carries `app.package_info().version` in AppState and uses it on every sidecar launch, including recovery. Existing env-first version behavior is covered by `test/sidecar.http.test.js`.

## Verdict

Source repaired; rebuilt installed verification pending. Normal releases keep all version pins aligned, so this observed mismatch concerns version-overlay builds. No customer release is claimed affected without evidence.
