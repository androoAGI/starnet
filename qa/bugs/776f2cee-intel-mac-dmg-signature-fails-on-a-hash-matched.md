---
fingerprint: 776f2cee
slug: intel-mac-dmg-signature-fails-on-a-hash-matched
title: Intel Mac DMG signature fails on a hash-matched download
surface: release
severity: P2
status: open
found: 2026-11-03
lane: installed-integrity-and-engine-floor-1103
fix:
origin: customer
report: support-intel-dmg-signature-intake
affected: Reported StarNet 0.12.5 on Intel Mac, macOS 15.7.5; exact affected artifact trust verdict unverified
family: release-dmg-trust
installer: unverified
recovery: unconfirmed
---

# Intel Mac DMG signature fails on a hash-matched download

## Symptom

The customer reports that codesign rejects an Intel Mac DMG even though its download hash matches the expected value. A matching download hash alone does not establish the disk image's own signature or notarization verdict.

## Repro

The original artifact has not been executed or independently rechecked on macOS in this continuation. The source regression runs scripts/verify-macos-dmg.sh with command-boundary fixtures for a valid image, bad own signature, wrong signing team, absent ticket, and refused Gatekeeper assessment. Actual acceptance still requires those commands against the exact notarized Intel DMG on macOS, followed by the installed application proof.

## Evidence

The stopped lane's sanitized intake records an Intel Mac 0.12.5 report on macOS 15.7.5. Commit 27b02ea5c adds scripts/verify-macos-dmg.sh to check the DMG's own Developer ID signature before submission and its stapled ticket and Gatekeeper verdict after notarization. Commit 10436b19b expands installed acceptance to the manifest, page boot and a zeroed module in a disposable copy. The continuation passed test/release-train-macos-trust.test.js, test/desktop-build-macos-notarization.test.js, test/installer-upgrade-resilience.test.js and test/installed-integrity-proofs.test.js. No live macOS trust or installed-artifact run is claimed.

## Verdict

Open pending a real macOS artifact and installed-acceptance receipt. The release checks are source-hardened, but the original failure cause and affected download's trust state remain unconfirmed. No workflow was dispatched, tag cut, installer built, or release published by this continuation.
