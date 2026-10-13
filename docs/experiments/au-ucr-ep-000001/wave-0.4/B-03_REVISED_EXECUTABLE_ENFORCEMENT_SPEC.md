# B-03 Revised Executable Enforcement Specification

## 1. Control record

- **Artifact:** `B-03`
- **Experiment / wave:** `AU-UCR-EP-000001 / 0.4`
- **Status:** `READY FOR ACCEPTANCE REVIEW`
- **Preparer:** Agent B, documentation/design role only
- **Design baseline inspected:** branch `cursor/populate-authority-readiness-7886`, HEAD `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Supersedes for review:** Wave 0.3 B-03 design; prior history remains immutable
- **Acceptance receipt / execution release:** none / none
- **Authorization:** design/documentation only

`READY FOR ACCEPTANCE REVIEW` is not acceptance. This document does not claim implementation, deployment, test execution, control effectiveness, role assignment, publication, merge authority, or release authority. All normative language describes a future control.

## 2. Existing observations and design boundary

Read-only inspection confirms partial application controls: `sidecar/permissions.js` contains fail-closed consent branches but also deliberate full-power/full-access and injected grant paths; `sidecar/capability/capGate.js` gates and attenuates capabilities; `shared/schema.js` is intentionally a limited validator. These are not the enforcement system specified here.

No authoritative write boundary, complete A01-A12 transition manager, mandatory A09 signature verifier, protected transactional state ledger, WORM audit anchor, or bypass-complete mediation layer was verified. Prompt/persona prose, client validation, and pre-commit hooks are not enforcement.

## 3. Authoritative write boundary

### 3.1 Sole write authority

The **Governance Policy Enforcement Point** (`G-PEP`) SHALL be the sole logical writer of governed object state. Agents, interactive users, UI/API clients, queue consumers, migration tools, deployment tools, backup operators, and administrators SHALL NOT possess direct state mutation credentials.

The authoritative boundary consists of:

- a dedicated non-interactive G-PEP workload identity;
- a protected executable and signed policy/schema bundle;
- one transactional state/event store;
- an append-only outbox in that same transaction domain;
- an independently administered immutable audit/anchor destination; and
- OS, database, service-control, secret, backup, and deployment controls that preserve mediation.

Every accepted mutation SHALL identify the authenticated principal, interface inventory ID, object and expected version, requested transition, idempotency key, evidence references, effective policy/schema digests, and authority receipts.

### 3.2 Acceptance and persistence validation

Validation SHALL occur twice:

1. **Acceptance validation:** before work enters the transaction, reject duplicate JSON keys, invalid UTF-8/Unicode, excessive size/depth, unknown schema ID/digest, undeclared fields, unauthenticated identity, absent inventory ID, and malformed evidence references.
2. **Persistence validation:** inside the same serializable transaction that locks the current object/version, revalidate schema, policy, role assignments, revocation, nonce/counter, prerequisites, current state, expected version, and event-chain predecessor. Database constraints SHALL enforce object version, event sequence, unique nonce/idempotency key, legal status/stage combinations, and immutable event rows.

Success at acceptance never guarantees persistence. Any changed dependency, conflict, timeout, audit/outbox failure, or persistence constraint violation denies the mutation.

## 4. Complete A01-A12 registry topology

The registry SHALL enumerate all twelve nodes. No omitted or implicit edge is valid.

| Node | Available authority in inspected material | Registry state | Permitted outgoing edge |
| --- | --- | --- | --- |
| A01 Discover | contextual definition available | `DEFINED_DISABLED` | none |
| A02 Define | contextual definition available | `DEFINED_DISABLED` | none |
| A03 | no authoritative definition | `UNDEFINED_BLOCKED` | none |
| A04 | no authoritative definition | `UNDEFINED_BLOCKED` | none |
| A05 | no authoritative definition | `UNDEFINED_BLOCKED` | none |
| A06 Evaluate | contextual definition available | `DEFINED_DISABLED` | none |
| A07 Risk | contextual definition available | `DEFINED_DISABLED` | none |
| A08 Options | contextual definition available | `DEFINED_DISABLED` | none |
| A09 Decision Gate | contextual definition plus AU-UCR authority rules | `DEFINED_DISABLED` | none |
| A10 | no authoritative definition | `UNDEFINED_BLOCKED` | none |
| A11 | no authoritative definition | `UNDEFINED_BLOCKED` | none |
| A12 Review | contextual definition available | `DEFINED_DISABLED` | none |

**Current executable topology is the empty graph.** No A-code transition is enabled by this design.

A future signed registry may enable an edge only when every node involved has an authoritative definition, owner, input/output schema, evidence contract, predecessor/join rules, failure rules, and rollback semantics. It SHALL include all twelve nodes, reject cycles unless expressly approved, and distinguish A-code stages from UCR-001..UCR-012 work items.

The contextual sequence `A01, A02, A06, A07, A08, A09, A12` is not an approved chain and SHALL NOT be used to skip A03-A05 or A10-A11.

## 5. Object and status state machine

Each object SHALL have immutable `object_id`, monotonically increasing `object_version`, `registry_digest`, `stage`, `status`, `last_event_hash`, and evidence references.

### 5.1 Status meaning and transitions

| Current status | Allowed next status | Required guard |
| --- | --- | --- |
| `NOT_STARTED` | `IN_PROGRESS`, `HOLD`, `SUPERSEDED` | enabled stage; start authority, or hold/supersede authority |
| `IN_PROGRESS` | `READY`, `FAILED`, `HOLD`, `SUSPENDED`, `SUPERSEDED` | evidence completeness for `READY`; signed reason otherwise |
| `READY` | `PASSED`, `FAILED`, `HOLD`, `SUSPENDED`, `SUPERSEDED` | stage evaluator result; A09 additionally requires Section 7 |
| `PASSED` | `IN_PROGRESS` at an enabled successor, `SUSPENDED`, `ROLLED_BACK`, `SUPERSEDED` | legal edge and predecessor closure; or authorized corrective event |
| `FAILED` | `IN_PROGRESS`, `HOLD`, `SUPERSEDED` | new object version and remediation authorization; history retained |
| `HOLD` | `IN_PROGRESS`, `SUSPENDED`, `SUPERSEDED` | hold-release receipt; never directly to `PASSED` |
| `SUSPENDED` | `IN_PROGRESS`, `ROLLED_BACK`, `SUPERSEDED` | reinstatement receipt to a new version, or rollback/supersession |
| `ROLLED_BACK` | `SUPERSEDED` | terminal operational state; replacement uses a new version |
| `SUPERSEDED` | none | terminal |

### 5.2 Invariants

- Only one nonterminal current version exists per object.
- `READY` means evidence submitted, not approved.
- `PASSED` means the stage-specific evaluator passed under the recorded policy; it does not imply governance acceptance or execution release.
- A predecessor satisfies a forward edge only when its current version is `PASSED` and every explicit join is complete.
- `HOLD`, `SUSPENDED`, `ROLLED_BACK`, and `SUPERSEDED` never satisfy a predecessor.
- Re-entry after failure/hold/suspension creates a new object version linked to the prior version.
- A registry or policy change requires re-evaluation; it cannot silently reinterpret prior state.
- No caller directly sets stage or status.

### 5.3 Idempotency and concurrency

`(object_id, idempotency_key)` is unique. Identical replay returns the committed result; reuse with different bytes yields `E_IDEMPOTENCY_CONFLICT`. Every request supplies `expected_object_version`; a mismatch yields `E_CONFLICT`. Serializable locking allows at most one winning mutation. Competing valid requests are ordered only by commit; losers reread and re-evaluate rather than auto-retry.

## 6. Normative schema and byte contract

Future schemas SHALL be digest-pinned JSON Schema 2020-12 artifacts for requests, objects, stage registry, role assignments, A09 receipts, events, suspension, rollback, reinstatement, break-glass, outbox, checkpoints, and anchors.

They SHALL use UTF-8 JSON; reject BOM, duplicate keys, invalid Unicode, non-finite numbers, unknown fields outside a controlled extension namespace, and unsupported critical extensions; bound all strings, arrays, nesting, identifiers, and timestamps; and distinguish omission from permitted `null`.

Canonical bytes are RFC 8785 JCS. Signature/hash input is:

`len32(domain) || domain || len64(payload) || payload`

with unsigned big-endian lengths. Ledger record input is:

`len32(domain) || domain || len32(ledger_id) || ledger_id || uint64be(sequence) || len32(prev_hash) || prev_hash || len64(record_bytes) || record_bytes`

For ledger records, `domain` SHALL be exactly the 16 ASCII bytes `AU-GPEP-EVENT-v1` (hex `41 55 2d 47 50 45 50 2d 45 56 45 4e 54 2d 76 31`), so `len32(domain)` SHALL be the four bytes `00 00 00 10`. No NUL terminator, BOM, normalization, substitution, or variable domain value is permitted. `record_bytes` SHALL be the UTF-8 RFC 8785 JCS serialization of `record_without_hash`, and `record_hash = SHA-256(the complete framed ledger record input above)`.

`ledger_id` is a lowercase UUID URN encoded as UTF-8; `prev_hash` is exactly 32 raw bytes. The canonical genesis record SHALL use `sequence = 0` and 32 zero bytes for `prev_hash`. A non-genesis record SHALL use `sequence = predecessor.sequence + 1` and the 32 raw bytes obtained by decoding the predecessor's 64-lowercase-hex `record_hash`; a textual hex digest SHALL NOT be framed as `prev_hash`. Timestamps are UTC RFC 3339 with at most microseconds. Identifiers SHALL declare their encoding and maximum length in schema.

Before schema/conformance closure, the published canonical vector bundle SHALL contain at least:

1. one genesis vector with exact `record_without_hash` JSON, its JCS UTF-8 bytes in hexadecimal, the fixed domain bytes, exact ledger-ID bytes, `uint64be(0)`, 32 zero predecessor bytes, every encoded length, the complete framed preimage in hexadecimal, and the expected SHA-256 `record_hash`; and
2. one immediately following non-genesis vector with exact `record_without_hash` JSON, its JCS UTF-8 bytes, `uint64be(1)`, the genesis hash decoded to 32 raw predecessor bytes, every encoded length, the complete framed preimage, and the expected SHA-256 `record_hash`.

The two expected hashes SHALL be calculated by at least two independently implemented vector generators and byte-for-byte compared. Any disagreement, omitted byte field, use of textual predecessor hex, or framing ambiguity fails conformance. These deterministic vector requirements correct the framing defect but do not close the still-open requirement for machine-valid schemas, published vectors, or independent conformance evidence.

`shared/schema.js` is not sufficient for these schemas unless later proven conformant to the selected mandatory subset; no such proof exists.

## 7. A09 authority, signatures, and replay

### 7.1 Required authority

Only a named, acknowledged, effective Decision Chair may sign the governance outcome. The signer SHALL differ from publisher, implementer, evidence producer, QA/Evidence Agent, Independent Reviewer, Coordinator/Architect, and relevant Security/Governance actor. Governance acceptance does not issue execution release.

### 7.2 Receipt

An A09 receipt SHALL bind:

- repository and governed object identity, candidate commit and artifact digests;
- prior object version/state/event hash and requested transition;
- stage-registry, policy, schema, and evidence-bundle digests;
- publication, QA, independent-review, and role-assignment receipt digests;
- explicit `ACCEPTED`, `REVISE`, or `REJECTED` outcome and rationale;
- signer stable identity, role scope/effective interval, key ID and purpose;
- audience, environment, issue/not-before/expiry times;
- unique 256-bit verifier-issued nonce, authority counter, and revocation epoch.

The provisional shared algorithm registry uses purpose-separated `ES256` keys and SHA-256 for both A-04 and B-03. Enterprise approval remains required.

### 7.3 Verification and replay

Inside the persistence transaction, the G-PEP SHALL verify chain, key purpose, identity-to-role binding, assignment interval, separation, signature, candidate/state/policy binding, nonce, audience, expiry, monotonically increasing authority counter, and current revocation epoch. Nonce and counter consumption is atomic with the event.

Expired, future, revoked, wrong-audience, wrong-environment, wrong-candidate, wrong-prior-state, reused nonce, stale counter, unknown key purpose, unavailable revocation, or ambiguous compromise-effective time fails closed. Key compromise triggers suspension and signed adjudication of the earliest affected time; evidence is retained.

## 8. Transaction, outbox, and external audit

### 8.1 Atomic commit invariant

State row, immutable event row, nonce/counter consumption, and outbox row SHALL be committed in one serializable database transaction. The invariant is:

> No authoritative state version exists without exactly one corresponding event and outbox record, and no committed event claims a state version that does not exist.

If any in-transaction write fails, all roll back. The externally immutable ledger and anchor are deliberately not claimed to be atomically committed with the database.

### 8.2 Outbox delivery and recovery

A separately identified relay reads committed outbox rows, appends canonical events to WORM storage, and records immutable delivery acknowledgements. Delivery is at-least-once; event ID and hash make it idempotent.

- An outbox event may be pending for at most the approved bound.
- Pending beyond the bound, hash disagreement, sequence gap, WORM rejection, or duplicate with different bytes triggers global promotion suspension.
- A reconciler compares state versions, events, outbox, WORM ledger, and checkpoints in both directions.
- Orphan external records that lack authoritative committed state are marked `ORPHAN_REJECTED`, retained, and never imported automatically.
- Missing external records are replayed only from committed outbox bytes.
- Relay restart resumes from durable acknowledgement; it never synthesizes events.

### 8.3 Tamper evidence and anchors

Every attempt, including denial before mutation, SHALL produce an audit record. Pre-transaction denials go to a separately sequenced intake ledger; committed mutations use the authoritative event chain.

At least every five minutes or 1,000 records, an independent anchor service publishes a signed checkpoint with ledger ID, sequence, head hash, Merkle root, policy digest, and prior checkpoint hash to a separately administered destination. A stale or conflicting anchor suspends promotion. WORM retention, legal hold, access logs, backup, restore verification, and independent read-only chain verification are mandatory.

Audit records SHALL include actor, interface inventory ID, object/version, requested transition, decision/reason, schema/policy/registry/evidence hashes, prior/current event hash, workload identity, transaction outcome, correlation ID, and trusted receipt time. Secrets and sensitive payload bodies are excluded.

## 9. Failure-closed rules

No state mutation occurs unless authentication, inventory membership, schema, policy, topology, prerequisites, role/separation, evidence, A09 where applicable, revocation, time, transaction, event, and outbox checks succeed.

Unknown, missing, stale, contradictory, unavailable, or ambiguous values deny. Timeouts deny. Unknown errors return `E_INTERNAL`, retain safe diagnostics, and alert. Failure of policy, trust store, revocation, database integrity, outbox, WORM, anchor freshness, trusted time, or workload attestation suspends affected promotion.

Governance `ACCEPTED` without a later Coordinator/Architect execution-release receipt cannot cause execution. No full-power, administrator, backup, deployment, migration, or recovery path may manufacture a valid transition.

## 10. Entry-point and bypass inventory

The future **Authoritative Mediation Inventory** (`AMI`) SHALL be signed, versioned, owned by the Coordinator/Architect for completeness, independently checked by Security/Governance and QA, and digest-pinned in deployment policy.

It SHALL enumerate UI, public/internal API, CLI, queues, schedulers, webhooks, batch jobs, database accounts/procedures, migrations, deployment systems, service-control interfaces, secret issuance, backups/restores, import/export, disaster recovery, break-glass, file shares, reparse/hard-link paths, debugger/injection rights, and administrator/SYSTEM paths.

Controls:

- deployment admission fails if an executable interface is absent from AMI;
- state database network and credential policy allows only G-PEP workload identity;
- continuous discovery compares services, routes, queues, credentials, scheduled tasks, database grants, and binaries to AMI;
- canary unauthorized writes and effective-access checks detect drift;
- new or changed interface is disabled until reviewed and added;
- backup restore enters quarantine and must replay/reconcile through the same validation boundary;
- deployment identity may replace signed binaries during an approved window but cannot mutate governed state;
- local administrators remain a residual threat; dual control, workload attestation, independent alerts, WORM anchors, and post-action reconciliation are compensating controls.

Observed `permissions.js` full-power/full-access and injected grant paths are bypass surfaces relative to governed transitions. Future integration SHALL place G-PEP after such application consent so those paths cannot bypass governance.

## 11. Suspension, rollback, reinstatement, and break-glass authority

### 11.1 Authorities

- Automatic suspension may be applied by signed policy on defined integrity triggers.
- Manual suspension requires one effective Security/Governance responder; scope and maximum 24-hour expiry are mandatory. Extension requires a second independent responder.
- Rollback requires Coordinator/Architect plus one independent Security/Governance approver; neither may be the affected implementer or evidence producer.
- Reinstatement requires corrected evidence, QA verification, Independent Reviewer acknowledgement, and Coordinator/Architect receipt; if governance acceptance was invalidated, a new Decision Chair outcome is also required.
- Break-glass requires two individually authenticated approvers from different role classes, maximum one-hour lease, MFA, recorded session, narrow command set, immediate independent alert, and mandatory post-use review.

No emergency path can sign an A09 acceptance on behalf of the Decision Chair or erase evidence.

### 11.2 Recovery/rollback sequence

1. Quiesce new transitions and reject or safely finish in-flight work.
2. Snapshot and verify state, event chain, outbox, WORM ledger, anchors, credentials, and side effects.
3. Select a separately signed known-good content and state target.
4. Verify target schema/policy compatibility and authorization.
5. Restore as a new object version/event; never overwrite failed state.
6. Rotate affected credentials and invalidate outstanding receipts/nonces.
7. Reconcile external side effects using idempotent compensation; mark irreversible effects explicitly.
8. Emit and anchor rollback receipt.
9. Resume only through Section 11.1 reinstatement.

If state/event integrity cannot be reconciled, remain suspended. Backup restoration alone is not recovery completion.

## 12. Acceptance prerequisites

Acceptance requires, for the exact published candidate:

- authoritative definitions and signed registry entries for all A01-A12 nodes and edges, or explicit governance acceptance of an empty/partially disabled topology;
- published normative schemas and shared algorithm/key-purpose registry;
- approved AMI and complete mediation architecture;
- selected transactional store, WORM/anchor service, trust/time/revocation design;
- named effective authorities and separation evidence;
- future tests for every transition, malformed input, concurrency, crash point, replay/revocation, bypass, audit tampering, suspension, rollback, restore, and reconciliation;
- commit-addressed publication, independent QA, and digest-specific independent review;
- Decision Chair acceptance; and
- a later separate execution release before any implementation or operation.

No test was run and no criterion is satisfied by this document alone.

## 13. Open items and disposition

Open: A03-A05/A10-A11 definitions; every executable edge; normative schema files; cryptographic approval; assignment and trust infrastructure; datastore/WORM/anchor selection; AMI population and independent verification; implementation and tests; containing-commit publication; formal review, QA, acceptance, and execution-release receipts.

The revised design disposition is:

`READY FOR ACCEPTANCE REVIEW -> NOT ACCEPTED -> EMPTY EXECUTABLE TOPOLOGY -> NO IMPLEMENTATION -> NO TEST -> NO EXECUTION`

G1 remains `PENDING`, G2 remains `PENDING`, G3 remains `CLOSED`, G4 remains `NOT AUTHORIZED`, feature/treatment paths remain OFF, baseline StarNet remains authoritative, and PR merge remains blocked.
