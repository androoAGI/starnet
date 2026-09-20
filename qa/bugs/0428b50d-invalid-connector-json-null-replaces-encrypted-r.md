---
fingerprint: 0428b50d
slug: invalid-connector-json-null-replaces-encrypted-r
title: Invalid connector JSON null replaces encrypted recovery credentials at startup
surface: channels
severity: P1
status: open
found: 2026-09-20
lane: release-audit-0124-0920
fix:
origin: audit
---

# Invalid connector JSON null replaces encrypted recovery credentials at startup

## Symptom

Startup can erase the saved connector inventory and its encrypted recovery copy when the primary state contains JSON null.

## Repro

Create an encrypted connectors/state.json with one connector and a healthy backup, replace only the main with literal null, then start the production sidecar in that isolated workspace. Before the fix both files become valid encrypted empty states. Run test/connector-vault-invalid.http.test.js for the preservation, restart and explicit recovery regression.

## Evidence

Candidate de7f4456f, Windows Node 22.23.0: real sidecar reproduction returned {"beforeCount":1,"afterCount":0,"backupPreserved":false}. After repair the live GET /api/connectors reports locked credential storage across two boots, both original files remain byte-identical, and explicitly restoring the healthy backup recovers the connector. test/connector-vault.test.js also rejects null, arrays, booleans, numbers and strings without mutation. Anchor: sidecar/connector-vault.js readOne.

## Verdict

Source repair validated in the production sidecar and unit regressions. Non-object JSON is present invalid authority, never an absent store; boot remains usable but connector writes stay locked. Installed Windows/macOS acceptance remains owed.
