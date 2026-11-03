---
fingerprint: 85f602c4
slug: windows-0132-packaged-backend-startup
title: Windows 0.13.2 startup fails loading a packaged backend module
surface: release
severity: P2
status: open
found: 2026-10-11
lane: release-0135-prep
fix:
origin: customer
report: support-2026-10-11-windows-packaged-backend-startup
affected: Windows 10, reported StarNet 0.13.2; exact installer hash and installed bytes unverified
family: packaged-backend-integrity
installer: unverified
recovery: unconfirmed
---

# Windows 0.13.2 startup fails loading a packaged backend module

## Symptom

A customer reports that the local engine fails to start after installing 0.13.2 on Windows 10. The message quotes `Cannot find module './tools/builtin/shell.js'`, says the installed `sidecar/tools/builtin/shell.js` is zero bytes while `index.js` and `node.exe` exist, and says downloading again did not resolve startup. The customer wants recovery without deleting station data. These are reported observations; the complete original stack and exact installed bytes have not been independently inspected.

## Repro

Reported sequence: install 0.13.2, launch StarNet, observe local-engine startup failure, download again and observe continued failure. No controlled reproduction of the affected artifact exists yet.

Next reproduction must identify the installer hash/signature, actual startup resource root and complete sanitized exception stack. Read existence, size and SHA-256 of `index.js`, `shell.js`, neighboring modules and `node.exe`; compare against files extracted from that exact verified installer in an isolated directory. Record disk space and read errors. Do not execute supplied customer files or replace/delete the existing station as a diagnostic step.

An existing empty CommonJS module normally resolves and exports an empty object. Therefore the reported size alone does not explain `MODULE_NOT_FOUND`; path identity, timing, missing dependencies and the full stack remain to be reconciled.

## Evidence

- Fresh support email dated 2026-10-11, read in full during customer-driven intake. Private source identifiers and original text remain in the private intake mapping, outside tracked files.
- Released tag `v0.13.2` resolves to `54899e5ff3f2b002b457757916b3977818db6fc1`. Its LF Git blob `sidecar/tools/builtin/shell.js` is 89,158 bytes, SHA-256 `794cde0f88e1ca4c77dff336248896749ecf96f19f7783ba940d2262f52ef685`. This proves source content only; it is not an installed-file checksum and checkout line endings may differ.
- Startup resource selection at `src-tauri/src/main.rs:1529` checks for `sidecar/index.js`; Tauri resource configuration copies the sidecar directory. The inspected packaging paths are unchanged between that tag and `a20ffa71f`.
- `test/source-text-integrity.test.js` rejects NUL bytes, not empty JavaScript. Node staging verifies the runtime archive checksum. Existing release provenance, signing and `scripts/qa/installed-smoke.mjs` checks do not by themselves establish every loose installed JavaScript file's identity.
- No exact installed 0.13.2 per-file manifest/hash receipt was found in the inspected tracked release evidence. This is a bounded evidence search, not proof that the public installer is corrupt.

## Verdict

Re-triaged P1 to P2 for the 0.13.5 cut: the build guard 08d7735de now refuses a zero-byte backend module at build time; the reporter's machine is not re-verified. Waiting on reporter data. Andrew approved this disposition for the 0.13.5 cut (10-15).

## Required acceptance

Identify the failing file/path boundary; demonstrate the repair on a disposable installation of the exact affected artifact, then on the release candidate. Verify startup, a real local task, restart, and upgrade/reinstall continuity of existing station data. If the original report cannot be reproduced, retain that limitation and the specific evidence request. A successful source checkout run cannot close installed acceptance.

## Public artifact inspection — 2026-10-12

The official public `StarNet_0.13.2_x64-setup.exe` (457,888,688 bytes, SHA-256 `f8ce564ffe5d420efd1d8efb35c796d73bfd4baae00444c61a82bbc268371cdd`) has a valid Authenticode signature. Read-only selective NSIS extraction found nonempty `sidecar/tools/builtin/shell.js` (90,354 bytes), `sidecar/index.js` (2,007,111 bytes), and `sidecar/loop.js` (184,069 bytes). All three match released source after CRLF-to-LF normalization; their raw installed-archive hashes and method limits are recorded in [the artifact receipt](../evidence/customer-release-1011/windows-0132-artifact.json). The installer and extracted code were never executed.

This establishes the selected public archive contents only. It does not identify the customer's installer, installed file bytes, startup resource root, exception stack, or failure cause, and does not prove installed startup or recovery. The report remains open; no source repair is justified by this inspection alone.

## Build-side guard — 2026-10-14

Every bundle path (npm run desktop:build, desktop:dev, both CI workflows) stages through scripts/stage-frontend-dist.mjs before tauri copies sidecar/ and shared/ verbatim from the working tree, and nothing checked those trees. Commit 08d7735de: staging now refuses to package when any code file under sidecar/, shared/ or frontend/ is zero bytes, or when a git-tracked file with content is missing or emptied on disk, and names each file. Regression: test/bundle-source-integrity.test.js.

This guards packages built from a damaged checkout only. The public 0.13.2 installer's shell.js was already shown whole, so this does not explain or repair the customer's installation, and no installed startup or recovery is claimed. The report stays open.

## Diagnostic hardening - 2026-11-03

Source 6b4c22ff0 embeds an installation manifest derived from the actual bundle map, reports named missing/empty/wrong-size files before engine startup, and hashes content in the background. Startup proceeds regardless of the diagnostic verdict. Review repair 61560264b keeps an install diagnosable when the entire sidecar tree is missing or replaced by a file, using surviving roots from the same resource map. A standalone executable remains not checked.

The fresh native class suite passed ten tests, including every-entry damage and Windows/macOS/Linux layout cases. test/install-manifest.test.js passed 96 assertions; test/installed-integrity-proofs.test.js passed 46 through acceptance-script fixtures. These proofs establish the diagnostic source behavior, not an affected installed artifact or customer recovery. This report stays open; the original cause remains unknown. No fixedIn tag or shipped claim is added.
