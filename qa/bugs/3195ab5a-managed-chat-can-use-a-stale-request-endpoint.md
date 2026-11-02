---
fingerprint: 3195ab5a
slug: managed-chat-can-use-a-stale-request-endpoint
title: Managed chat can use a stale request endpoint
surface: providers
severity: P1
status: fixed
found: 2026-09-09
lane: managed-endpoint-0909
fix: 177a9384e
origin: customer
report: support-localhost-refusal-2026-09-09
affected: v0.10.13 resolver and trunk 41253b0bd
family: managed-routing
installer: unverified
recovery: unconfirmed
---

# Managed chat can use a stale request endpoint

## Symptom

A valid linked StarNet account fails with fetch failed (ECONNREFUSED 127.0.0.1) when a request carries an obsolete local baseUrl. A per-request key can also replace the linked device credential independently of the destination.

## Repro

1. Save a valid funded credits link and start the actual sidecar.
2. POST /api/run with provider starnet: the linked route succeeds.
3. Repeat with baseUrl pointing to a closed local port: the original code reproduces the exact reported transport error.
4. With the repair, repeat the same request: it completes using the linked service and credential.

## Evidence

Baseline trunk 41253b0bd: test/managed-endpoint.e2e.test.js with ENDPOINT_BASELINE=1 proved a successful linked request followed by the exact refused-localhost error. The same resolver ordering exists in v0.10.13 (source comparison, not a released-installer reproduction). After 177a9384e, the actual sidecar completes with both baseUrl spellings overridden, retains explicit custom-provider routing, and returns to the linked token/URL after switching providers. This survives restarting with the file token removed and a synthetic desktop-injected token, without changing the linked URL. A temporary wrapper also exercised node dev/seed.js --keep against the disposable profile; the wrapper was removed afterward. All provider responses and credentials were synthetic; no customer data or paid external request was used.

The real frontend Harness storage code was evaluated with persisted localStorage across a reload. Normal custom -> Gemini -> StarNet switching does NOT copy endpoints between providers. An already-existing starnet-scoped endpoint does survive reload. Thus this is a demonstrated defect matching the reported symptom, not proof of how the reporter acquired it.

## Regression

Before: the valid linked account succeeded, then the stale request endpoint produced the exact ECONNREFUSED localhost failure. After: the same request completes on the linked route, survives restart, preserves custom routing, and rejects an unlinked managed request before any provider call.

Routines (credential-store lane, step S7): `test/credential-store.endpoint-pair.e2e.test.js` drives Run Now and the scheduled fire of a StarNet routine on a linked station that also holds a stale CUSTOM page URL and a stale starnet record in its page file, against a fake linked cloud that records the device token. Both go to the linked URL with the token, and a request naming the stale endpoint does too; nothing reaches the stale endpoint. These rows pass at trunk a3af8dafd too: they are the proof the record lacked, not a fix.

Channels (credential-store lane, step S8): `test/credential-store.channel-ref.e2e.test.js` row 8 boots a station with a starnet Telegram record an older build left, carrying a stale endpoint and a stale key, and sends a real message through a real hub against a fake linked cloud. It goes to the linked URL with the device token, nothing reaches the stale endpoint, and the stale key goes nowhere. Like the routine rows, the delivery passes at trunk a3af8dafd: it is proof, not a fix. Since S8 the reconciliation also takes the stale endpoint and key off the record, because a linked account takes no channel credential.

## Verdict

Managed requests now resolve the linked credential and endpoint before considering any per-request override. BYOK/custom providers retain their explicit routing. This does not repair an incorrect URL in the authoritative credits link, an operator CREDITS_URL override, or DNS/hosts redirection. Mike's report omits the requested hostname and destination port, so his personal root cause and recovery remain unconfirmed. No release or installer claim is made.

## Sibling coverage

{
  "adapters": [
    { "target": "StarNet managed", "state": "covered", "test": "test/managed-endpoint.e2e.test.js", "scenario": "linked endpoint/token wins over stale request overrides", "gate": "http" },
    { "target": "custom BYOK", "state": "covered", "test": "test/managed-endpoint.e2e.test.js", "scenario": "explicit endpoint and key preserved", "gate": "http" }
  ],
  "entrypoints": [
    { "target": "POST /api/run", "state": "covered", "test": "test/managed-endpoint.e2e.test.js", "scenario": "actual provider request completes", "gate": "http" },
    { "target": "routines", "state": "covered", "test": "test/credential-store.endpoint-pair.e2e.test.js", "scenario": "Run Now and the scheduled fire of a StarNet routine run on the linked URL with the device token, under a stale CUSTOM page URL and a stale starnet record in the page file", "gate": "http" },
    { "target": "channels", "state": "covered", "test": "test/credential-store.channel-ref.e2e.test.js", "scenario": "a Telegram message through a real hub, on a starnet record with a stale endpoint and a stale key, runs on the linked URL with the device token", "gate": "http" }
  ],
  "displays": [
    { "target": "frontend provider settings", "state": "covered", "test": "test/managed-endpoint.e2e.test.js", "scenario": "real Harness storage logic, provider switch and reload", "gate": "http" },
    { "target": "installed Windows desktop", "state": "blocked", "reason": "No rebuilt signed installer or customer-device test." }
  ],
  "lifecycle": [
    { "target": "restart", "state": "covered", "test": "test/managed-endpoint.e2e.test.js", "scenario": "saved link and injected desktop token remain authoritative", "gate": "http" },
    { "target": "DNS or incorrect linked service URL", "state": "blocked", "reason": "Outside this reproduced per-request routing defect; source of Mike's localhost destination remains unknown." }
  ]
}
