---
fingerprint: e6b19398
slug: stalled-save-responses-permanently-block-the-per
title: Stalled save responses permanently block the persistence queue
surface: sessions
severity: P1
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: d9b6fba04
origin: audit
---

# Stalled save responses permanently block the persistence queue

## Symptom

One stalled save response blocks every later save in the window. Continued work has only its browser cache while the durable copy stops advancing.

## Repro

Hold POST /api/save before headers or while decoding its acknowledgement; push and flush. Before the repair no transport deadline releases the serial write queue. `test/cloudsave-timeout.test.js` drives both phases, expiration, a late reply and successful retry using controlled timers. `dev/reliability-save-proof.mjs` holds an acknowledgement in the actual loaded browser for 16 seconds.

## Evidence

`qa/evidence/reliability-audit-0919/save-timeout-before.log`: outcome still-pending and aborted:false. Final live proof requires outcome:false and aborted:true. Fast regression verifies a late acknowledgement cannot set lastPushOkAt, and the retained snapshot retries successfully.

## Verdict

A 15-second deadline covers the complete save acknowledgement, aborts the transport and releases the queue into existing retry logic. Existing unload, update-drain and concurrency regressions remain required. This is a JSON persistence request, not a model streaming deadline. Installer acceptance remains unverified.
