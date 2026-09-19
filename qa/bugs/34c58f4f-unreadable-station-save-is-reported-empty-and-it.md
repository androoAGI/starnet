---
fingerprint: 34c58f4f
slug: unreadable-station-save-is-reported-empty-and-it
title: Unreadable station save is reported empty and its sole backup can be eclipsed
surface: onboarding
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9b6fba04
origin: audit
---

# Unreadable station save is reported empty and its sole backup can be eclipsed

## Symptom

A temporary file read failure makes an existing station appear empty. If only its backup remains, a new save can eclipse that backup and remain authoritative after restart.

## Repro

Run `node dev/reliability-save-proof.mjs` on the pre-fix source: the test-only host injects EACCES on one exact save path, retaining real file bytes. First deny primary reads and reconcile without a local cache; then move a separate save to its backup, deny backup reads, submit a replacement, unlock and restart. `test/save-unreadable.http.test.js` asserts the corrected HTTP contract. `test/save.test.js` covers missing and corrupt main files with a locked backup.

## Evidence

`qa/evidence/reliability-audit-0919/save-live-before.log`: primary GET 200/save:null, browser empty:true, backup replacement ok:true, restart name EMPTY REPLACEMENT. The final live receipt requires GET 503, SAVE-READ recovery screen after cache removal/reload, Retry restoring the station, denied replacement, and RETAIN ME after restart with a recovered notice.

## Verdict

Source repair preserves unreadable primary/backup authority, refuses replacement, exposes an explicit error and discloses missing-main backup recovery. Installer acceptance remains unverified.
