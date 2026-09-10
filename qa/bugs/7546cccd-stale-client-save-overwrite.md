---
fingerprint: 7546cccd
slug: stale-client-save-overwrite
title: An older client can erase newer conversations by saving its stale snapshot with a fresh timestamp
surface: sessions
severity: P1
status: open
found: 2026-09-10
lane: agent/adversarial-audit-0910
fix:
origin: audit
---
# An older client can erase newer conversations by saving its stale snapshot with a fresh timestamp

## Symptom

P1: keeping two clients open on the same station can silently erase conversation history. A later interaction in the older client overwrites the whole durable save with its stale in-memory snapshot. Reload and sidecar restart retain the loss; no conflict notice is shown.

## Repro

1. Open two browser clients to one isolated seeded station before either sends a message.
2. In A send 'Audit client A: preserve this message.' It appears in COMMS and is saved.
3. In B, without reloading, send 'Audit client B: second independent message.'
4. Reload A. Only B's message remains. GET /api/save contains B and no A.
5. Restart the sidecar with --keep and reload: A is still missing.

The initial UI reproduction used a keyless station and the resulting missing-provider responses. The loss affects the real saved user messages, independent of model behavior. The server-only reproducer dev/audit-stale-save.cjs isolates the same timestamp flaw with successful save acknowledgements.

## Evidence

Audited source: 2aa8305c0. qa/evidence/adversarial-0910/restart-receipt.json records clientAMessagePresent:false and clientBMessagePresent:true after a real restart.

Root cause: frontend/app/app.js:1456 serializes the entire local Workstreams and agent/station state. frontend/app/save.js:114 supplies Date.now() at write time, not the revision originally read. sidecar/savestore.js:209 only rejects incoming timestamps older than the stored timestamp. An old snapshot written later passes this guard and atomically replaces the new data at sidecar/savestore.js:210. There is no expected-base revision comparison.

Novelty: docs/UPDATE_STATE_SAFETY_AUDIT_2026-07-06.md P1.1 identified roster replacement and explicitly cited savestore's timestamp check as the safe comparison. This finding demonstrates that the savestore protection itself is insufficient. It is also distinct from expired API tokens and the fixed rating-watermark guard.

## Regression

Existing test/save.test.js passes all 70 assertions, including rejection of an older timestamp. It does not exercise an old snapshot stamped with a newer wall-clock time. No repair applied.

## Fix direction

Use a server-issued revision and compare-and-swap against the revision the client loaded. On conflict, preserve the pending local changes and reconcile or request a reload without overwriting newer server state. Test desktop plus browser, same-origin tabs, reconnect/outbox writes, unload beacons and roster/layout siblings.
