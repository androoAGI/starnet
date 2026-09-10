---
fingerprint: 694472bf
slug: linux-appimage-staging-includes-incompatible-mus
title: Linux AppImage staging includes incompatible musl Sharp binaries
surface: release
severity: P2
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Linux AppImage staging includes incompatible musl Sharp binaries

## Symptom

The manual desktop-build workflow builds the Linux executable and Debian package, then fails while bundling the AppImage. Windows and both Mac builds pass independently.

## Repro

Dispatch `.github/workflows/desktop-build.yml` on `f111be488` with publishing disabled. The Ubuntu 22.04 leg fails in linuxdeploy while resolving `@img/sharp-linuxmusl-x64/lib/sharp-linuxmusl-x64-0.35.3.node`.

## Evidence

[Run 34532835410](https://github.com/androoAGI/starnet/actions/runs/34532835410), Linux verbose build log at 2026-09-10T21:40:03Z: `Could not find dependency: libc.musl-x86_64.so.1`. Raw log: `.dogfood/release-0112-closeout/linux-verbose.log`. The earlier non-verbose failure in run 34530138928 is retained too.

`scripts/stage-voice-deps.mjs` previously pruned foreign ONNX binaries but copied both glibc and musl Sharp optional packages. The desktop's bundled Linux Node is glibc. `scripts/lib/staged-native-packages.mjs` now identifies only the unused musl Sharp addon and companion within the @img scope; fresh staging and stale release-output cleanup both use it. `test/desktop-voice-bundle.test.js` covers glibc preservation, the companion package, nested scope boundaries and unchanged Windows/Mac selection. [Sharp documents separate glibc/musl binaries](https://sharp.pixelplumbing.com/install/).

## Verdict

Source repair and local packaging tests pass. A fresh Linux CI AppImage build remains required. Linux is outside the current supported public release platform set; this is still a real build failure and is not hidden with continue-on-error.
