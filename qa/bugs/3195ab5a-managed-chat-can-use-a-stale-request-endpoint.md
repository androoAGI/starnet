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
    { "target": "channels and routines", "state": "blocked", "reason": "Share the resolver, but stale-override executions were not separately driven through each ingress." }
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
