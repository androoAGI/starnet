# Wave 0.6 Bounded Implementation and Test Plan

## Current state

- Plan status: `PREPARED_NOT_AUTHORIZED`
- Proposed next-phase ID: `AU-UCR-EP-000001-W06-NEXT-01`
- Environment class: `ISOLATED_NONPRODUCTION_ONLY`
- Production, publication, merge and G4 effect: `NONE`

This plan is complete preparatory work. It must not be executed unless Hakeem Moore selects
`APPROVE` and fills every scope field in the candidate-bound decision receipt.

## Entry prerequisites

1. Exact dossier and technical manifest digests are bound by the decision.
2. Repository lanes, paths, actors, environments, fixtures, time window and resource limits are
   explicit.
3. Implementation, QA, review and rollback actors have effective acknowledged appointments and
   conflict checks.
4. Test keys and trust data are synthetic, isolated and approved; no operational credential or
   production data is available to the environment.
5. A compatible rollback target, suspension authority and abort procedure are recorded.
6. Commit, push, publication and merge remain prohibited unless separately and explicitly
   authorized.

## Proposed implementation sequence

### `NEXT-P1` — Contract harness

Implement Registry 1.3.0 parsing, closed vocabularies, schema dispatch and `IF-01`–`IF-22`
interface stubs in an assigned local lane. Unknown registry, schema, interface, purpose, decision
or reason values must fail closed.

Evidence: source diff, dependency lock, build record, interface-to-code crosswalk and negative
dispatch results.

### `NEXT-P2` — Stateless conformance

Implement exact framing, SHA-256, canonicalization and ES256 P1363 low-S verification with
designated test keys. Run positive and malformed/wrong-key/high-S/domain/version vectors.

Evidence: pinned tool versions, test-key identities, input/output digests, command logs and
per-vector verdicts.

### `NEXT-P3` — Stateful controls

Implement sequence/predecessor/fork handling, idempotency, replay consumption, transition
legality, revocation/trusted-time checks and atomic state/event/outbox behavior.

Evidence: deterministic state traces, concurrency/failure-injection logs and safe-state results.

### `NEXT-P4` — Audit, rollback and reinstatement

Implement delivery, reconciliation, WORM/anchor adapters and reversible rollback/reinstatement
within the approved isolated environment.

Evidence: containment proof, rollback target compatibility, rollback receipt, post-rollback
remeasurement and no-external-effect attestation.

### `NEXT-P5` — Package for governed review

Stop implementation. Produce a complete dynamic candidate manifest, updated inventory, QA
inputs, residual-risk update, findings register and next-review package. Do not issue A09, G3 or
G4 on an agent's authority.

## Required tests

- all 162 current full-document schema cases and 114 subschema outcomes;
- independent validator and complete RFC 8785 corpus;
- all 14 canonical vectors plus generated malformed/edge variants;
- genuine ephemeral/test-key ES256 positive, wrong-key, malformed, high-S and revoked-key cases;
- all 22 interface success/failure paths;
- replay, idempotency conflict, ordering ambiguity, fork, stale, transition and dependency
  failures;
- audit delivery failure/recovery, reconciliation and anchor mismatch;
- rollback precondition, irreversible-effect refusal, successful restoration and reinstatement;
- privilege, path, credential, network and production-isolation assertions.

## Stop and suspension conditions

Stop immediately on scope drift, unknown dependency, non-test credential discovery, production
reachability, irreversible effect, manifest/hash mismatch, failed isolation assertion,
uncontained side effect, evidence-write failure, critical security finding or revocation.

On stop: preserve logs, deny further mutations, record the last known state, invoke only
pre-authorized containment, and return a suspension package to Hakeem Moore. Silence never permits
continuation.

## Completion criteria

The next phase completes only when every authorized work item and test has a recorded outcome,
all failures are dispositioned without fabrication, rollback evidence exists, the evidence
inventory is current, and no agent-owned task remains unfinished. Completion does not imply
acceptance or release.
