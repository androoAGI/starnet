---
fingerprint: 037ec5d2
slug: desktop-bundles-include-development-only-native
title: Desktop bundles include development-only native dependencies
surface: release
severity: P2
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: a711f6ea2
origin: audit
---

# Desktop bundles include development-only native dependencies

## Symptom

Desktop installers include development-only native dependencies. Linux AppImage packaging fails when linuxdeploy inspects a musl Canvas binding in the glibc bundle.

## Repro

Private `desktop-build` run 35476844504 on source `9cdfc0ba5` fails in the Linux job while resolving `@napi-rs/canvas-linux-x64-musl/skia.linux-x64-musl.node`. The locked package is marked dev:true. `scripts/stage-voice-deps.mjs` copied all top-level trees except a small explicit denylist.

## Evidence

[Original failing Linux job](https://github.com/androoAGI/starnet/actions/runs/35476844504/job/105987436179), 2026-09-19T23:50:46Z: `Failed to run ldd: exited with code 1`. `test/staging-development-closure.test.js` executes the real staging script against fresh and warm miniature package trees, covering scoped and nested development-only packages, shared production packages, optional dependencies and preservation of source dependencies. `test/desktop-voice-bundle.test.js` checks the actual lockfile Canvas variants and every production root. Real local Windows staging produced a 276.5 MB runtime closure with both required ONNX runtimes retained.

## Verdict

Candidate repair `a711f6ea2` uses lockfile development-only identities rather than adding a Canvas-name exception. This extends the earlier Sharp-specific packaging lesson (`694472bf`) to dependency closure. The replacement Linux build in 35477408214 passed, and local gates passed 834 fast steps, 124 HTTP steps and 139 live journey assertions; Linux remains outside the supported public release platform set.
