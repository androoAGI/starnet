# Wave 0.5 Shared Trust and State Contract

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-CONTRACT`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `W05_SHARED_TRUST_AND_STATE_CONTRACT`
- **Repository baseline inspected:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Preparation mode:** documentation/design and read-only inspection only
- **Artifact status:** `SPECIFIED_DESIGN_PROPOSAL_F04_RECONCILED`
- **Adoption status:** `NOT_ADOPTED`
- **Demonstrated enforcement:** `NONE`
- **Acceptance effect:** `NONE`
- **Execution effect:** `NONE`

This contract reconciles the proposed A-04 runtime-attestation, B-03 executable-enforcement, and
C-04 authority designs. It does not amend those artifacts, appoint an actor, approve a
cryptographic suite, publish a schema, close an objection, or authorize implementation, schema
validation, testing, commit, push, merge, publication, or execution.

The baseline commit contains Wave 0.3, not Wave 0.4 or Wave 0.5. The inspected Wave 0.4 and Wave
0.5 source documents are mutable working-tree artifacts. Their presence is evidence of proposed
design content only.

## 2. Assertion classes

Every normative statement in this document has class **SPECIFIED**: it states behavior required
of a future adopted system.

- **SPECIFIED:** proposed contract behavior or proposed data requirement.
- **OBSERVED:** a read-only repository fact, such as the baseline identity or presence of a file.
- **DEMONSTRATED:** supported by separately authorized execution evidence against an immutable
  candidate.
- **ADOPTED:** accepted by an effectively assigned adoption authority through a candidate-bound
  signed receipt.

No enforcement claim in this document is `DEMONSTRATED`. No contract, registry, authority,
schema, role assignment, trust root, or interface in this document is `ADOPTED`. Uppercase
`MUST`, `SHALL`, and similar terms are therefore **SPECIFIED design assertions**, not claims about
current controls.

### 2.1 Authoritative design mapping and F-04 correction

`W05_VERSIONED_REGISTRY.md`, registry
`urn:au-ucr:registry:wave-0.5-contract:1.3.0`, is the authoritative mapping within this proposed
design for:

- schema family IDs and semantic versions;
- `IF-01` through `IF-22`;
- decision and state vocabularies;
- the exact audit-event `record_without_hash` projection and external framing fields;
- algorithms, canonicalization, framing domains, key purposes, and hash domains; and
- ordered reason codes, aliases, deprecation, detector interfaces, precedence, and safe states.

Where an earlier literal or table in this contract differs from that registry, the registry
controls. This design-precedence statement resolves naming ambiguity; it does not adopt the
registry or alter existing schema/vector bytes.

This revision addresses the Contract-owner portions of:

- `F04-NMF-01` by selecting one interface/profile scope and explicitly deferring missing schemas
  to Agent A;
- `F04-NMF-02` by selecting one event schema/projection, placing framing fields outside JSON,
  and separating technical `ALLOW` from governance `ACCEPTED`; and
- `F04-NMF-03` by establishing one closed, versioned vocabulary mapping.

## 3. Reconciled control ownership

### 3.1 Configuration authority, measurement, verification, and enforcement

The following responsibilities are separate and non-substitutable:

| Responsibility | SPECIFIED owner | Required output | Prohibited inference |
| --- | --- | --- | --- |
| Define the approved runtime configuration | Approved Runtime Manifest (`ARM`) publisher acting under a valid release-authority assignment and exact execution release | Signed, immutable, digest-addressed ARM | A working tree, environment, CLI, prompt, roster, or runtime label is not configuration authority |
| Resolve and load configuration | Approved loader under TMC observation | Exact parsed-byte digests and effective-configuration digest for values supplied to the runtime | Loader output alone is not an attestation verdict |
| Measure runtime configuration and executable state | Trusted Measurement Component (`TMC`) outside the agent/model process | Challenge-bound producer launch/liveness evidence over exact opened/loaded objects and effective configuration | TMC may claim `MEASURED`; it may not claim `TRUSTED_ACTIVE`, governance acceptance, or release |
| Verify runtime configuration and session binding | Independently assigned verifier service under pinned policy | Signed verifier verdict receipt | Evidence producer, runtime, agent, harness, or model cannot self-verify |
| Enforce runtime admission and governed state mutation | Governance Policy Enforcement Point (`G-PEP`) | Admission decision and transactional mutation/denial event | Verifier does not write governed object state; G-PEP does not manufacture attestation |
| Issue A09 governance outcome | Named, acknowledged, effective Decision Chair | Candidate-bound A09 decision under `KP-A09-DECISION-v1` | A09 `ACCEPTED` is not G3 acceptance or execution release |
| Accept G3 | Same effective Decision Chair, acting through a separate candidate-bound event after accepted A09 and valid typed prerequisites | G3 acceptance under `KP-G3-ACCEPTANCE-v1` | A09 signature/purpose cannot be reused; G3 is not execution release |
| Release an exact G4 run | Named, acknowledged, effective Coordinator/Architect | Run-specific release under `KP-G4-EXACT-RUN-RELEASE-v1` | Standing assignment, A09, or G3 acceptance is not release |

The ARM is the sole proposed source of approved configuration. The loader determines the
effective configuration from ARM-declared precedence. The TMC measures the exact loader inputs
and output supplied to the runtime. The verifier independently evaluates that evidence. G-PEP
enforces the verifier result and all governance prerequisites.

### 3.2 Validation locations

Validation is cumulative. A successful earlier check never bypasses a later check.

1. **Publication validation:** the future registry validates schema, canonical bytes, digest,
   signatures, signer purpose, candidate scope, assignment state, and immutable identity before
   publishing an ARM, policy, schema, trust store, or registry.
2. **Ingress/acceptance validation:** G-PEP rejects malformed encoding, duplicate keys, unknown
   schema or critical extension, excessive bounds, unauthenticated identity, absent interface
   inventory ID, malformed references, and unsupported registry versions before transaction
   admission.
3. **Pre-launch validation:** the TMC validates ARM retrieval by digest, release chain, trust
   store, revocation state, ownership/location policy, challenge, time health, hash domains, and
   exact opened handles before launch.
4. **Independent attestation validation:** the verifier validates platform/TMC identity,
   challenge, session/channel binding, effective configuration, module/model/endpoint evidence,
   policy, freshness, sequence, counter, assignments, signatures, and revocation.
5. **Persistence validation:** G-PEP repeats identity, schema, policy, topology, role, receipt,
   replay, revocation, current-state, expected-version, prerequisite, and event-chain checks
   inside the serializable state/event/outbox transaction.
6. **Post-commit validation:** relay, WORM destination, anchor service, and reconciler validate
   event identity, bytes, sequence, predecessor, checkpoint freshness, and bidirectional
   agreement. They never create authoritative state.

Unknown, missing, stale, contradictory, unavailable, ambiguous, or unverifiable required input at
any location yields denial or suspension. Availability pressure does not authorize fail-open
behavior.

## 4. Identity and signer contract

### 4.1 Stable identities

Every governed actor and service identity SHALL be a stable identifier in an approved identity
system, not a display name, repository username, OS account name, agent label, branch, lane,
authorship claim, or possession of a key. A receipt SHALL bind:

- stable subject identity and identity-system identifier;
- governed role and exact scope;
- assignment record and complete mandate/delegation chain;
- acknowledgement and separation/conflict result;
- effective-from and effective-through values;
- lifecycle state and revocation epoch;
- key ID, issuer chain, algorithm ID, key-purpose ID, and key-validity evidence;
- candidate, environment, audience, run/session/object scope as applicable; and
- verifier identity, verification time, result, and reason codes.

Identity-to-role binding and key-to-purpose binding are independent checks. Passing one does not
pass the other.

### 4.2 Required signer roles

| Signed object | Permitted signer role | Mandatory separation |
| --- | --- | --- |
| Role assignment/delegation | Valid assignment authority within mandate and delegation depth | No self-appointment, reciprocal appointment, or incompatible-role aggregation |
| QA receipt | Effective QA/Evidence Agent | Separate from implementer, publisher, Decision Chair, and Independent Reviewer |
| Independent-review acknowledgement | Effective Independent Reviewer | Separate from preparer, implementer, publisher, QA, Decision Chair, and release issuer |
| A09 outcome | Effective Decision Chair | Separate from publisher, implementer, evidence producer, QA, reviewer, Coordinator/Architect, and relevant Security/Governance actor |
| G3 acceptance | Effective Decision Chair after a separately signed accepted A09 and valid typed prerequisites | Uses `KP-G3-ACCEPTANCE-v1`; cannot reuse A09 purpose/signature |
| G4 exact-run release | Effective Coordinator/Architect | Uses `KP-G4-EXACT-RUN-RELEASE-v1`; separate from Decision Chair and affected implementer/evidence producer |
| ARM/publication envelope | Purpose-authorized release/publication signer acting on the exact accepted and released candidate | Cannot create acceptance or release through signing |
| Trust store / key status | Trust-Store Publisher under required independent quorum | Separate purpose from ARM, A09, runtime, and audit keys |
| Revocation/suspension | Authorized Revocation or Security/Governance role under applicable quorum | Cannot erase history or backdate without signed incident adjudication |
| TMC evidence | Enrolled TMC runtime key bound to the measured platform/session | Key interface accepts only TMC-assembled schema-valid evidence |
| Verifier challenge | Effective `VERIFIER_OPERATOR` | `KP-VERIFIER-CHALLENGE-v1`; verdict-purpose reuse is prohibited |
| Verifier verdict | Effective `VERIFIER_OPERATOR` | Separate `KP-VERIFIER-VERDICT-v1`; challenge purpose cannot issue a verdict |
| Model endpoint/provider statement | Effective `LOCAL_MEASURED_MODEL_ADAPTER` or `MODEL_PROVIDER_IDENTITY_AUTHORITY` | `KP-MODEL-ENDPOINT-STATEMENT-v1`; evidence only, never a verdict or governance act |
| G-PEP event/checkpoint | Effective G-PEP or independently administered anchor identity, according to object purpose | Purpose-separated keys and administrations |

All current human and service assignments are absent or unverified. The phrase `"Human
approved."` does not establish a stable identity, authority source, exact scope, effective time,
expiry, revocation process, acknowledgement, Decision Chair, or adoption authority.

## 5. Cross-system binding chain

### 5.1 Required binding

The future control SHALL preserve this digest-addressed chain:

`published candidate`
`-> QA and independent-review receipts`
`-> findings/dependency closure`
`-> Decision Chair A09 decision`
`-> separate Decision Chair G3 acceptance`
`-> Coordinator/Architect execution-release receipt`
`-> ARM + policy/schema/registry dependency snapshot`
`-> verifier challenge`
`-> TMC launch evidence + effective configuration + platform/model/endpoint evidence`
`-> verifier verdict`
`-> G-PEP admission/mutation decision`
`-> authoritative event + outbox`
`-> WORM delivery acknowledgement + anchor checkpoint`
`-> governed request/output audit binding`

Every link SHALL identify the exact preceding receipt or object by registry-declared digest. A
broken, mutable, conflicting, expired, revoked, superseded, wrong-purpose, wrong-audience, or
wrong-scope link breaks the chain and fails closed.

### 5.2 Decision-session-audit minimum tuple

Every governed runtime admission, mutation event, and governed inference audit record SHALL bind
at least:

- repository ID, candidate commit and publication-manifest digest;
- governed object ID/version and prior event hash, where applicable;
- A09 decision ID/digest/outcome and separate G3 acceptance ID/digest;
- execution-release ID/digest, run ID, environment, validity window, and rollback target;
- ARM, effective configuration, schema, policy, topology, trust-store, revocation-snapshot,
  algorithm-registry, dependency-registry, and reason-code-registry IDs/digests;
- verifier challenge ID/nonce digest and `KP-VERIFIER-CHALLENGE-v1`; separately, verdict receipt
  ID/digest, `KP-VERIFIER-VERDICT-v1`, receipt time, and verdict state;
- model endpoint/provider statement ID/digest, exact signer role,
  `KP-MODEL-ENDPOINT-STATEMENT-v1`, request, tenant, service, endpoint, model, commitments,
  audience, and validity;
- platform, boot, TMC, process creation, runtime instance, session, endpoint tuple, and immutable
  model identities;
- interface inventory ID, authenticated caller, correlation ID, request ID, idempotency key, and
  expected object version;
- authoritative event ID/sequence/hash, outbox ID, WORM acknowledgement, and nearest checkpoint
  ID/hash; and
- final decision, ordered reason-code list, and evidence completeness result.

A request/output commitment SHALL be bound to the accepted launch evidence and nearest accepted
liveness response. The audit record SHALL use commitments rather than secret or unnecessary
plaintext.

## 6. Shared state vocabulary

### 6.1 Authority-assignment state

`DRAFT -> ACKNOWLEDGED -> EFFECTIVE -> SUSPENDED | EXPIRED | REVOKED | SUPERSEDED`

`SUSPENDED -> EFFECTIVE` requires a new reinstatement receipt within original scope and expiry.
`EXPIRED`, `REVOKED`, and `SUPERSEDED` are terminal for new actions. Reinstatement never
retroactively validates actions.

### 6.2 Candidate governance state

`DRAFT_PRODUCED -> REVIEW_PENDING -> REVIEW_COMPLETE -> ACCEPTED | REVISE | REJECTED`

Only a valid Decision Chair A09 decision creates `ACCEPTED`, `REVISE`, or `REJECTED`. Artifact
completion and review completion do not imply acceptance.

### 6.3 Run-authorization state

`NOT_RELEASED -> RELEASED -> SUSPENDED -> REINSTATED | ROLLED_BACK | EXPIRED | REVOKED | ENDED`

`REINSTATED` SHALL create a new release version and re-enter `RELEASED`; it does not reactivate
the old receipt. `ROLLED_BACK`, `EXPIRED`, `REVOKED`, and `ENDED` are terminal for that release.
Governance `ACCEPTED` with `NOT_RELEASED` remains non-executable.

### 6.4 ARM eligibility state

`UNPUBLISHED -> PUBLISHED_INELIGIBLE -> ELIGIBLE -> SUSPENDED | EXPIRED | REVOKED | SUPERSEDED`

Only an immutable, signed, dependency-complete ARM with valid acceptance and later release may be
`ELIGIBLE`. A successor ARM does not delete its predecessor.

### 6.5 Producer evidence state

`UNINITIALIZED -> MEASURING -> EVIDENCE_ISSUED <-> RESPONDING -> ENDED`

Any nonterminal producer state may move to `FAILED` where allowed by the A-04 state machine;
`FAILED -> ENDED`. Producer state never equals trust state.

### 6.6 Verifier verdict and admission state

- Verdict:
  `NOT_EVALUATED -> TRUSTED_ACTIVE | UNTRUSTED`;
  `TRUSTED_ACTIVE -> SUSPENDED | REVOKED | ENDED`;
  `SUSPENDED -> REVOKED | ENDED`.
- Admission:
  `BLOCKED -> ADMITTED` only on a current `TRUSTED_ACTIVE` receipt;
  `ADMITTED -> BLOCKED` immediately on any other, absent, or stale verdict.

`UNTRUSTED`, `REVOKED`, and `ENDED` are terminal for the candidate session. There is no
same-session reactivation. Restart or recovery creates a new process, runtime key, challenge,
session, and verdict.

### 6.7 Governed-object state

The B-03 vocabulary is retained:

`NOT_STARTED`, `IN_PROGRESS`, `READY`, `PASSED`, `FAILED`, `HOLD`, `SUSPENDED`,
`ROLLED_BACK`, and `SUPERSEDED`.

`READY` means evidence submitted, not accepted. `PASSED` means only that a stage evaluator passed
under the recorded policy. No caller sets state directly. Re-entry after failure, hold, or
suspension creates a new object version. `ROLLED_BACK` and `SUPERSEDED` do not satisfy forward
prerequisites.

### 6.8 Audit-delivery state

`PENDING -> DELIVERED -> ANCHORED`

Exceptional terminal classifications are `ORPHAN_REJECTED` and `CONFLICT`. A delivery-bound
breach, sequence gap, byte/hash disagreement, WORM rejection, or stale/conflicting anchor causes
promotion suspension; it does not rewrite authoritative state.

## 7. Cross-system precedence

### 7.1 Denial precedence

For a proposed allow or transition, evaluate in this order:

1. emergency revocation, compromise determination, or global suspension;
2. assignment, key, release, ARM, session, object, or dependency expiry/revocation/supersession;
3. current trust store, revocation epoch, trusted time, and dependency availability;
4. execution-release validity and its exact G3 acceptance plus accepted A09 dependencies;
5. immutable publication, QA, independent-review, and findings-closure receipts;
6. signed ARM, policy, schema, topology, algorithm, dependency, and reason-code registries;
7. purpose-valid verifier challenge, platform/TMC evidence, effective configuration,
   purpose-valid model/endpoint evidence, and separately purpose-valid current verdict/liveness;
8. G-PEP current object state, expected version, prerequisites, replay state, and transactional
   constraints;
9. informational metadata.

Any higher-precedence deny, uncertainty, or conflict overrides every lower-precedence allow.
Conflicting evidence at equal precedence denies; “newest wins” is not permitted without an
authorized monotonic event chain that proves supersession.

### 7.2 Simultaneous state events

For a runtime session:

`REVOKED > SUSPENDED or UNTRUSTED > ENDED > TRUSTED_ACTIVE`

For an authority, release, ARM, or governed object:

`REVOKED > SUSPENDED > EXPIRED > SUPERSEDED or ROLLED_BACK > positive/active state`

Where ordering cannot be proven by the authority-scoped counter and previous-event chain, choose
the blocking state and emit `E_ORDERING_AMBIGUOUS`.

## 8. Expiry, revocation, and freshness

- Verifier challenge expiry SHALL be no more than 120 seconds after issue.
- Runtime liveness SHALL be challenged at least every 60 seconds and received within 30 seconds;
  two missed challenges suspend the session.
- Verifier receipt time, not producer time, controls runtime freshness.
- Every assignment, decision, release, ARM, key, trust store, dependency snapshot, and verdict
  SHALL carry explicit validity or freshness rules. Missing expiry where required is invalid.
- Manual suspension SHALL have explicit scope and a maximum 24-hour expiry; extension requires a
  second independent responder.
- Break-glass SHALL have a maximum one-hour lease and cannot create A09 acceptance.
- Revocation status unavailable, stale, forked, or ambiguous fails closed.
- A revocation or compromise determination records effective ordering, affected scope, incident
  receipt, containment, and re-adjudication requirements. Evidence is marked, never deleted.
- Expiry and revocation invalidate new actions. Whether prior actions are affected requires a
  signed, append-only adjudication; it cannot be silently inferred or backdated.

## 9. Fail-closed and recovery behavior

### 9.1 Mandatory failure behavior

Admission or mutation SHALL be denied, and an affected active scope SHALL be suspended, for:

- missing or ambiguous provenance, hash domain, schema, algorithm, purpose, identity, assignment,
  acceptance, release, dependency, or exact loaded bytes;
- malformed or unsupported input, unknown critical extension, unknown registry entry, or reason
  code outside the pinned registry;
- stale, future, expired, revoked, reused, contradictory, wrong-audience, wrong-environment, or
  wrong-candidate evidence;
- replay, nonce reuse, counter rollback, sequence fork, event-chain break, or expected-version
  conflict;
- attestation, liveness, endpoint/model binding, trusted-time, trust-store, revocation, database,
  outbox, WORM, anchor, or reconciliation failure; or
- inability to prove decision-release-session-event-audit binding.

Denial itself SHALL be audited. Unknown internal errors use `E_INTERNAL` and preserve safe
diagnostics. No administrator, backup, deployment, migration, full-power, recovery, or
break-glass path may manufacture a valid transition.

### 9.2 Rollback initiation authority

Rollback may be initiated automatically only by a signed policy trigger whose scope, target
selection constraints, and reason code are already adopted. Manual rollback initiation requires:

- an effective Coordinator/Architect; and
- one independent effective Security/Governance approver;

neither may be the affected implementer or evidence producer. An operator may request or
recommend rollback, but the request is not authorization.

### 9.3 Rollback recording

Rollback SHALL:

1. quiesce new transitions and preserve in-flight disposition;
2. snapshot and verify state, events, outbox, WORM, anchors, credentials, and side effects;
3. select a separately signed known-good content/configuration and state target;
4. validate compatibility, authority, acceptance, and exact release scope;
5. create a new object version, event, outbox record, and rollback receipt without overwriting
   failed state;
6. identify initiator, both authorizers, reason codes, trigger evidence, source and target
   digests, affected objects/sessions, irreversible effects, compensations, credential rotation,
   and invalidated receipts/nonces;
7. deliver and anchor the rollback event; and
8. resume only through new-session attestation and the applicable reinstatement receipts.

If integrity cannot be reconciled or no separately accepted rollback target exists, remain
blocked. Backup restoration alone is not recovery completion.

## 10. Versioned registries and dependency records

The canonical algorithm, canonicalization, framing/domain, key-purpose, hash-domain, schema,
interface, decision, and reason-code entries are defined only in `W05_VERSIONED_REGISTRY.md`.
Earlier schema/vector literals are aliases, deprecated values, or incompatible source values
exactly as classified there. No unmapped nearest-name inference is permitted.

The dependency registry remains a separately versioned future object. Each entry SHALL include:

- stable dependency ID, type, owner role, purpose, criticality, and affected `IF-*` interfaces;
- exact artifact/service identity, immutable version/digest, canonical schema/profile,
  environment, and trust boundary;
- required lifecycle state, freshness/expiry, revocation source, and health evidence;
- prerequisite dependency IDs and acyclic ordering;
- fail behavior, suspension scope, canonical ordered reason code, recovery authority, and
  rollback target;
- confidentiality/classification and audit-retention profile;
- adoption receipt, effective interval, supersedes, and prior-entry digest; and
- current verification classification: `SPECIFIED`, `AVAILABLE_NOT_VERIFIED`,
  `VERIFIED_FOR_CANDIDATE`, `SUSPENDED`, `EXPIRED`, `REVOKED`, or `UNAVAILABLE`.

Only `VERIFIED_FOR_CANDIDATE` satisfies an active prerequisite. A dependency entry does not prove
the dependency exists or works.

The adopted cryptographic profile must still settle ES256 encoding/determinism, certificate and
curve policy, key lifetime, hardware protection, rollover, compromise, trust roots, and
independently generated vectors. No such approval or evidence currently exists.

## 11. Audit event projection and interface resolution

The sole authoritative design projection for B-03 event hashing is Registry Section 6:

- JSON `record_without_hash` contains exactly the registered governed-event properties;
- `domain`, `ledger_id`, `sequence`, `prev_hash`, and derived `record_hash` are outside JSON;
- JSON uses consumer decision `ALLOW`, never vector `ACCEPT` or governance `ACCEPTED`;
- `record_bytes` is UTF-8 RFC 8785 JCS of `record_without_hash`; and
- the fixed B-03 binary frame consumes those bytes without self-reference.

The vector ledger-head attestation is an IF-17 profile, not IF-08 runtime launch evidence.
IF-08 consumes only `runtime-attestation-evidence` signed for `KP-TMC-RUNTIME-v1`. IF-17 consumes
the separately named `ledger-head-attestation` profile and
`KP-LEDGER-HEAD-ATTEST-v1`. Registry Section 7.1 controls its exact signed-payload projection,
non-self-reference, canonicalization, domain, framing, signature encoding, verification order,
and failure routing.

These rules remove the IF-08, IF-15, and ledger-head projection design conflicts. Current
schema/vector literals are design-aligned by inspection; they remain unvalidated, not
cryptographically verified, unadopted, and unpublished.

## 12. Schema and vector reconciliation requirements

Current and future A-04/B-03 schema and vector work remain reconciled to this contract only by:

1. using the object and receipt fields in Sections 4 and 5 without weakening signer separation;
2. using the exact state names and terminal/re-entry rules in Section 6;
3. consuming every canonical schema/profile/interface/algorithm/key-purpose/hash-domain ID in
   `W05_VERSIONED_REGISTRY.md`;
4. using the registered decision vocabulary and ordered `reason_codes`, never free text or an
   unregistered success/error token;
5. validating at the boundaries in Section 3.2 and recording which boundary produced the result;
6. preserving omission versus permitted `null`, strict duplicate-key rejection, bounded values,
   UTC RFC 3339 timestamps, and RFC 8785 JCS;
7. using the exact Registry Section 6 audit projection, keeping ledger framing fields outside
   JSON, and using Registry Section 7.1 exactly for ledger-head signing;
8. binding decision, release, run, ARM, challenge, session, request, event, and audit identities
   as specified in Section 5; and
9. applying registered alias/deprecation rules and rejecting every unknown critical field, enum,
   state, profile, registry entry, algorithm, key purpose, or domain fail closed.

The current 35-schema and one-family/fourteen-scenario/six-file vector proposals contain the
canonical IDs and corrected design literals. That current-state observation supersedes the old
pending-consumption handoff language but does not claim validator or cryptographic conformance.

## 13. Adoption and unresolved dependencies

Adoption authority is absent. At minimum, adoption remains dependent on:

1. a named, stable, acknowledged, effective adoption authority with mandate provenance, scope,
   effective interval, conflict checks, and an exact-candidate adoption receipt;
2. immutable containing-commit and publication identities for the Wave 0.4 and Wave 0.5
   candidate;
3. digest-specific QA and formally effective independent review;
4. machine-valid ARM, attestation, authority, transition, audit, recovery, anchor, registry, and
   interface schemas;
5. approved algorithm/key-purpose, dependency, reason-code, identity, time, revocation, and
   cross-system state registries;
6. established trust roots, key custody, assignment authority, named service/human assignments,
   acknowledgements, and separation evidence;
7. canonical vectors and independently reproduced conformance evidence;
8. selected platform/TMC, endpoint/provider, G-PEP datastore, WORM, anchor, and reconciliation
   profiles;
9. closure or authorized disposition of provenance, baseline, privacy, availability,
   irreversible-effect, and bypass risks;
10. separate Decision Chair A09 and G3 receipts for the exact candidate under their exact key
    purposes; and
11. only afterward, a separate Coordinator/Architect exact-run G4 release under
    `KP-G4-EXACT-RUN-RELEASE-v1`.

Current Wave 0.6 technical disposition:

`22 INTERFACES DESIGN-ALIGNED THROUGH VERSIONED REGISTRY -> 35-SCHEMA BUNDLE AND 14-SCENARIO VECTOR FAMILY TECHNICALLY FROZEN -> LOCAL STRUCTURAL VALIDATION AND DETERMINISTIC REPRODUCTION PASSED -> NOT CRYPTOGRAPHICALLY OR INDEPENDENTLY VERIFIED -> NOT ADOPTED -> NO OPERATIONAL IMPLEMENTATION OR EXECUTION`

