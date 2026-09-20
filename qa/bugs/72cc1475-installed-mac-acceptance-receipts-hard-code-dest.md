---
fingerprint: 72cc1475
slug: installed-mac-acceptance-receipts-hard-code-dest
title: Installed Mac acceptance receipts hard-code destination version
surface: release
severity: P2
status: fixed
found: 2026-09-20
lane: reliability-audit-0919
fix: 2098a36f9
origin: audit
---

# Installed Mac acceptance receipts hard-code destination version

## Symptom

A successful v0.12.3 Intel installed acceptance emits an upgrade destination of 0.10.0, misleading release evidence consumers.

## Repro

Run `scripts/verify-macos-intel-installed.sh` on the notarized v0.12.3 artifact from private build 35477408214. Its final receipt writer used a literal destination version.

## Evidence

`qa/evidence/reliability-hardening-0919/intel-macos-installed-acceptance.json` preserves the original receipt. `test/desktop-build-macos-notarization.test.js` executes the actual receipt writer against XML and binary Info.plist files with different versions and missing metadata.

## Verdict

Fixed in 2098a36f9: read CFBundleShortVersionString from the installed app; fail instead of emitting a receipt when metadata is absent. The historical receipt remains unchanged and is explicitly annotated in the report.
