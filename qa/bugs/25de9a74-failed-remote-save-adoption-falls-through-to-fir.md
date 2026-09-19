---
fingerprint: 25de9a74
slug: failed-remote-save-adoption-falls-through-to-fir
title: Failed remote save adoption falls through to first-run onboarding
surface: onboarding
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9b6fba04
origin: audit
---

# Failed remote save adoption falls through to first-run onboarding

## Symptom

If browser storage cannot accept the durable save, the app can offer first-run onboarding. With an older cache present it can instead label stale content with the newer durable revision, permitting a subsequent overwrite without conflict.

## Repro

Make localStorage.setItem throw while reconciling a valid remote. With no readable local snapshot the pre-fix path returns null. With an older valid cache it reads that old cache as if adoption succeeded, while retaining the remote revision. `test/cloudsave-unknown.test.js` covers both. The actual browser proof injects QuotaExceededError only for the save key, restores the browser methods and original cache afterwards, and compares expected/actual revisions.

## Evidence

`qa/evidence/reliability-audit-0919/save-adoption-before.log`: expected stale revision 2, actual 3. The pre-fix regression observed expected 1, actual 5. Final live proof requires retained old revision, an unknown-state sentinel when no valid local snapshot exists, and unchanged cache bytes. `test/saveversion.test.js` and `test/cloudsave-concurrency.test.js` protect migration, future-version refusal and stale-write conflict behavior.

## Verdict

Read back the exact cached remote before migration; on failure restore the old cache and its original revision. No-local failure enters recovery. Source verification is separate from installed WebView quota/recovery acceptance, which remains unverified.
