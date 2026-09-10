---
fingerprint: 050da842
slug: update-canary-uses-obsolete-saves-and-snapshots
title: Update canary uses obsolete saves and snapshots the startup WebView
surface: release
severity: P2
status: open
found: 2026-09-10
lane: agent/release-0112-audit-0910
fix:
origin: audit
---

# Update canary uses obsolete saves and snapshots the startup WebView

## Symptom

The installed update canary fails at fixture seeding with a save conflict. Once that is corrected, it may read the relaunching WebView at about:blank or compare an incompletely normalized fixture and report false state loss.

## Repro

Build the old and new canaries, serve their localhost signed feed, install the old client and run `node scripts/update-canary.mjs drive`. On the candidate at `31ce0e785`, the original seed POST omitted `_saveRevision` and was refused at revision 3. The original fixture also lacked a valid station document and complete provider settings.

## Evidence

Raw before/after logs are in `.dogfood/release-0112-closeout/canary-drive*.log`. The repaired live path completed 0.11.1 -> 0.11.2, signed download, installer exit, relaunch and equal populated-state fingerprints. `scripts/update-canary.mjs` now reads the current revision, writes durable state before the local cache, creates real workstation props, boots the old client and verifies the population before taking the baseline. It waits for the actual app origin/modules after relaunch and retains before/attempt evidence on failure. `scripts/lib/update-continuity.mjs` uses the current save schema and explicit provider configuration. All seven update-continuity assertions pass.

## Verdict

Live repair verified with exact receipt `.dogfood/release-0112-closeout/canary/update-receipt.json`, semantic fingerprint `473e2f34872513cbe9ebbbcc5923659327b17cb503bfeb0c87a21f98eb04ea79`. This proves the local Windows update mechanism on same-source version overlays, not the public feed or a historical released-source installer.
