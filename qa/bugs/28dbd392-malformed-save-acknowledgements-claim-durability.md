---
fingerprint: 28dbd392
slug: malformed-save-acknowledgements-claim-durability
title: Malformed save acknowledgements claim durability and malformed reads claim an empty station
surface: sessions
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9b6fba04
origin: audit
---

# Malformed save acknowledgements claim durability and malformed reads claim an empty station

## Symptom

The save indicator can claim a durable save after a malformed success-status reply. A malformed read reply can instead send the user into first-run onboarding.

## Repro

In the seeded browser, replace only POST /api/save responses with HTTP 200 `{}` or non-JSON, push a snapshot and flush. Then replace GET /api/save with `{}`, `{error:'unavailable'}` or an invalid save and reconcile without a local cache. The live script is `dev/reliability-save-proof.mjs`; fast regressions are `test/cloudsave-refusal.test.js` and `test/cloudsave-unknown.test.js`.

## Evidence

`qa/evidence/reliability-audit-0919/save-reply-before.log`: both malformed acknowledgements returned confirmed:true; all three malformed reads returned empty:true. Final live proof requires confirmed:false and unknown:true. Actual sidecar persistence/restart is independently exercised by `test/save-unreadable.http.test.js`.

## Verdict

Only explicit ok:true acknowledges persistence; only explicit save:null proves absence. Malformed replies retain pending snapshots or enter recovery. The old permissive non-JSON compatibility assertion was replaced with this stronger persistence contract. Installer acceptance remains unverified.
