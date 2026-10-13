# Wave 0.5 Cross-Contract Integration Report

## 1. Control record

- **Task:** Wave 2 integration for `FOR-ACT-S0-001-W05-CONTRACT`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `W05_CROSS_CONTRACT_INTEGRATION_REPORT`
- **Repository baseline inspected:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Inspection mode:** documentation/design and read-only inspection only
- **Report status:** `INTEGRATION_REVIEW_COMPLETE_CONFLICTS_AND_DEPENDENCIES_OPEN`
- **Existing artifacts edited:** none
- **Schema validation executed:** none
- **Fixture or vector execution:** none
- **Demonstrated enforcement:** none
- **Adoption effect:** none
- **Acceptance effect:** none
- **Execution effect:** none

This report compares the completed Wave 0.5 schema, vector, authority, and provenance design
outputs with:

- `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`; and
- `W05_INTERFACE_MATRIX.md`.

It is an integration inspection of current working-tree bytes. It is not QA certification,
independent review, schema conformance, cryptographic verification, publication, adoption,
governance acceptance, or execution release.

## 2. Inputs inspected

### Contract baseline

- `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`
- `W05_INTERFACE_MATRIX.md`

### Schema output

- `schemas/README.md`
- `schemas/common.schema.json`
- `schemas/attestation-evidence.schema.json`
- `schemas/session-binding.schema.json`
- `schemas/effective-configuration-measurement.schema.json`
- `schemas/authorization-a09-decision.schema.json`
- `schemas/a01-a12-transition-record.schema.json`
- `schemas/audit-ledger-record.schema.json`
- `schemas/evidence-acceptance-receipt.schema.json`
- the fixture inventory and stated fixture classifications

### Vector output

- `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`
- `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md`

The vector derivation report records execution by one agent using two same-agent programs. This
report inspected those recorded outputs but did not rerun either program.

### Authority and provenance output

- `W05_AUTHORITY_CLOSURE_PACKAGE.md`
- `W05_G3_G4_RECEIPT_REQUIREMENTS.md`
- `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`
- `W05_UNAUTHENTICATED_EVIDENCE_REGISTER.md`
- `W05_REVIEW_PREPARATION_MATRIX.md`
- `W05_AUTHORIZATION_INPUT_RECORD.md`
- `W05_BASE_VERIFIED_INVENTORY.md`
- `W05_NINE_OBJECTION_CLOSURE_MATRIX.md`

## 3. Classification method

Each `IF-01` through `IF-22` receives one primary design-integration classification:

- **`ALIGNED`** — names, ownership, states, inputs/outputs, security semantics, and registry
  references are mutually compatible and sufficiently represented for later adoption.
- **`PARTIAL`** — some design is consistent, but required fields, object schemas, vocabulary,
  bindings, lifecycle rules, or cross-references are absent or incomplete.
- **`CONFLICT`** — supplied outputs use incompatible names, values, structures, or semantics that
  cannot all be normative without an explicit mapping or revision.
- **`BLOCKED_BY_ADOPTION`** — design is sufficiently consistent for the interface, but effective
  assignments, immutable publication, trust infrastructure, adoption receipt, or another
  external governance prerequisite is absent.

`BLOCKED_BY_ADOPTION` is not used to conceal an internal omission or contradiction. Every
interface is operationally unavailable because no contract is adopted and no enforcement is
demonstrated; the table records the more specific primary design-integration result.

## 4. Executive result and counts

| Classification | Count |
| --- | ---: |
| `ALIGNED` | 0 |
| `PARTIAL` | 19 |
| `CONFLICT` | 2 |
| `BLOCKED_BY_ADOPTION` | 1 |
| **Total interfaces** | **22** |

The package is directionally consistent on role separation, fail-closed behavior, immutable
history, G3/G4 separation, and the distinction between specified design and demonstrated
enforcement. It is not yet a single interoperable contract. The blocking integration defects are:

1. schema and vector schema IDs do not match;
2. schema, vector, and shared-contract key-purpose vocabularies do not match;
3. schema, vector, and shared-contract reason-code vocabularies do not match; and
4. vector ledger records do not conform to the proposed audit-ledger schema.

The other interfaces lack one or more required machine objects or bindings. No interface is
classified `ALIGNED`.

## 5. Cross-cutting reconciliation

### 5.1 Ownership

**Design result: substantially consistent, representation partial.**

The outputs agree that:

- the approved loader resolves effective configuration;
- the TMC measures runtime state and emits producer evidence;
- the verifier determines trust;
- G-PEP alone writes governed state;
- the Decision Chair alone issues A09 governance outcomes;
- the Coordinator/Architect separately issues exact-run release;
- publication, QA, independent review, acceptance, and release are distinct; and
- WORM, anchor, and reconciliation services cannot manufacture authoritative state.

The schemas do not consistently bind those owners. `effective-configuration-measurement` has no
loader identity, TMC identity, session binding, signature, or verifier result.
`evidence-acceptance-receipt` permits role labels but does not bind assignment receipts,
acknowledgements, mandate chains, conflict results, counters, or revocation epochs. The common
signature definition binds a key ID and purpose but not signer stable identity, issuer/trust-root
chain, assignment, validity evidence, or verifier.

### 5.2 Interface names and object profiles

**Design result: partial.**

The interface matrix defines stable names `IF-01` through `IF-22`. None of the schemas identifies
its producing or consuming interface by `interface_id`. The transition and audit schemas contain
`interface_inventory_id`, which identifies an AMI entry rather than the contract interface that
accepted or produced the object.

Only a subset of matrix object profiles has candidate schemas. Missing dedicated schemas include:

- assignment/delegation and acknowledgement;
- candidate review package;
- execution-release receipt with run-specific fields;
- ARM;
- verifier challenge;
- platform enrollment/quote result;
- provider model/endpoint statement;
- outbox and delivery acknowledgement;
- anchor checkpoint;
- revocation snapshot;
- reconciliation result;
- rollback plan/receipt with quorum and target details; and
- reinstatement receipt with corrected-evidence prerequisites.

The multipurpose `evidence-acceptance-receipt` does not supply the interface-specific conditional
requirements for these objects.

### 5.3 State vocabulary

**Design result: core states consistent, coverage partial.**

The following schema enums match the contract's core vocabulary:

- attestation producer states include `MEASURING`, `EVIDENCE_ISSUED`, `RESPONDING`, `FAILED`, and
  `ENDED`;
- session verdicts include `NOT_EVALUATED`, `TRUSTED_ACTIVE`, `UNTRUSTED`, `SUSPENDED`,
  `REVOKED`, and `ENDED`;
- governed-object states use `NOT_STARTED`, `IN_PROGRESS`, `READY`, `PASSED`, `FAILED`, `HOLD`,
  `SUSPENDED`, `ROLLED_BACK`, and `SUPERSEDED`; and
- the evidence receipt includes governance, runtime, release, rollback, and reinstatement
  outcomes.

The schemas do not represent the complete separate state machines for assignment, candidate
governance, run authorization, ARM eligibility, admission, or audit delivery. They also do not
encode legal transition edges, terminality, new-version/new-session re-entry, or the prohibition
against collapsing `READY`, `PASSED`, `ACCEPTED`, `RELEASED`, `TRUSTED_ACTIVE`, and `ADMITTED`.

### 5.4 Precedence

**Design result: prose aligned, machine contract partial.**

The authority, G3/G4, provenance, and shared-contract documents consistently give revocation,
suspension, expiry, ambiguity, and dependency failure precedence over positive state. They
consistently reject “newest wins,” require counter/event-chain ordering, and fail closed when
ordering cannot be proven.

No schema carries the complete precedence rule or a common ordering result. Most schemas contain
only one state or outcome and cannot prove cross-system precedence. No fixture inventory claims
complete race coverage across assignment, release, ARM, session, object, and audit states.

### 5.5 Reason codes

**Design result: conflict.**

The shared contract proposes codes including:

`E_AUTHN`, `E_AUTHORITY_ABSENT`, `E_SEPARATION`, `E_UNKNOWN_REGISTRY`, `E_KEY_PURPOSE`,
`E_SIGNATURE`, `E_REVOCATION_UNAVAILABLE`, `E_ORDERING_AMBIGUOUS`, `E_SCOPE`, `E_DEPENDENCY`,
`E_ATTESTATION`, `E_LIVENESS`, `E_MODEL_BINDING`, `E_TRANSITION`, `E_AUDIT_DELIVERY`,
`E_ANCHOR`, `E_ROLLBACK_AUTHORITY`, and `E_IRREVERSIBLE_EFFECT`.

`common.schema.json` instead defines a closed 22-value enum containing differently named or more
generic codes such as:

`E_AUTHENTICATION`, `E_AUTHORITY`, `E_BINDING`, `E_CANONICAL`, `E_EVIDENCE`, `E_INTEGRITY`,
`E_MISSING`, `E_POLICY`, `E_STALE`, `E_TOPOLOGY`, `E_UNAVAILABLE`,
`E_UNKNOWN_CRITICAL_EXTENSION`, and `E_VERSION`.

The vector bundle uses another provisional set:

`E_HASH_MISMATCH`, `E_DOMAIN_MISMATCH`, `E_FRAMING_AMBIGUOUS`, `E_TRUNCATED_INPUT`,
`E_VERSION_UNSUPPORTED`, and `E_KEY_PURPOSE`.

Only `E_CONFLICT`, `E_EXPIRED`, `E_IDEMPOTENCY_CONFLICT`, `E_INTERNAL`, `E_REPLAY`, `E_REVOKED`,
`E_SCHEMA`, and some broad semantics overlap across the schema and contract sets. Most vector
rejection codes are not schema-valid; `E_KEY_PURPOSE` is in the shared contract and vectors but
not in `common.schema.json`.

No authoritative mapping, alias rule, precedence rule, or registry version reconciles these
sets. The reason-code registry is therefore internally incompatible and remains unadopted.

### 5.6 Algorithms, framing, and key purposes

**Design result: algorithms partly aligned; identifiers and key purposes conflict.**

The outputs consistently propose SHA-256, RFC 8785 JCS, ES256, the general
`len32(domain) || domain || len64(payload) || payload` signature input, and B-03's fixed
`AU-GPEP-EVENT-v1` ledger framing. The vector bundle reproduces the fixed 16-byte ledger domain
and raw 32-byte predecessor design.

Conflicts remain:

- the contract registry IDs are `ALG-HASH-SHA256-v1`, `ALG-SIG-ES256-v1`,
  `CANON-JCS-RFC8785-v1`, `FRAME-LEN-DOMAIN-v1`, and `FRAME-GPEP-EVENT-v1`;
- schemas use literals `SHA-256`, `ES256`, `RFC8785-JCS-UTF8`, and `AU-GPEP-EVENT-v1`;
- vectors use `SHA-256`, `ES256`, `RFC8785-JCS`, and URNs for framing versions;
- the contract proposes purpose IDs such as `KP-A09-DECISION-v1`, `KP-EXEC-RELEASE-v1`,
  `KP-TMC-RUNTIME-v1`, and `KP-VERIFIER-VERDICT-v1`;
- schemas permit only `A09_DECISION`, `AUDIT_ANCHOR`, `EVIDENCE_RECEIPT`, and
  `RUNTIME_ATTESTATION`; and
- vectors use lowercase hyphenated `runtime-attestation` and `general-signing`.

The schema set has no key purposes for assignment, execution release, ARM publication, trust
store, revocation, verifier verdict, G-PEP event, or the complete contract registry. The A09
schema fixes top-level `key_purpose` to `A09_DECISION` but does not constrain the nested common
signature's `key_purpose` to the same value.

ES256 signature encoding, trust roots, certificate profile, key validity, hardware protection,
rollover, and compromise recovery remain unspecified or unapproved.

### 5.7 Identity and signature profiles

**Design result: authority prose aligned, schemas partial.**

Authority outputs match the shared contract on stable identity, mandate/delegation chain, exact
scope, effective interval, acknowledgement, conflict/separation, key purpose, counter, nonce,
replay register, and revocation status.

The schemas reduce those requirements to short `id` strings and role enums. They do not provide
identity-system/issuer, assurance level, organization, assignment digest, mandate chain,
acknowledgement, conflict receipt, trust chain, key validity, or independent verification result.
The `signature.value` field is an unconstrained string representation rather than a fixed ES256
encoding profile.

### 5.8 Expiry, revocation, and freshness

**Design result: prose aligned, schema enforcement partial.**

Authority and G3/G4 outputs correctly require effective intervals, terminal expiry/revocation,
append-only lifecycle events, counter/event-chain race ordering, and fail-closed uncertainty.
Runtime schemas include several issue/expiry or freshness fields.

Missing machine constraints include:

- ordering of issue, not-before, expiry, and verification times;
- the 120-second challenge maximum;
- the 60-second challenge and 30-second response requirements;
- two-missed-challenge suspension;
- assignment/release/ARM/key/trust-store lifecycle objects;
- revocation snapshot identity and epoch on most records; and
- atomic replay/counter consumption.

JSON Schema format checks alone cannot demonstrate trusted-time, freshness, revocation, or event
ordering.

### 5.9 Decision-session-audit binding

**Design result: partial.**

The schemas separately represent candidate decisions, session identity, runtime evidence,
transition records, and audit records. They do not preserve the complete tuple required by the
shared contract:

- A09 receipt and exact execution release;
- publication manifest and receipt;
- ARM, policy, schema, topology, algorithm, dependency, reason-code, trust-store, and revocation
  digests;
- verifier challenge and verdict receipt;
- run, runtime instance, process creation, platform/TMC, endpoint, and model identities;
- request/output commitments and nearest accepted liveness evidence;
- object/version, event, outbox, WORM acknowledgement, and anchor checkpoint.

No one schema or linked family makes those references mandatory end to end. The generic
`evidence_digest` and `registry_digest` fields are insufficient because they do not identify
which required dependency each digest represents.

### 5.10 Rollback and reinstatement

**Design result: authority prose aligned, object contracts partial.**

The contract, authority package, G3/G4 requirements, and provenance design agree that rollback:

- requires a pre-authorized exact target and bounded actions;
- cannot broaden execution authority;
- preserves evidence append-only;
- creates new state/version/session rather than overwriting or reactivating old state; and
- requires corrected evidence and new receipts for reinstatement.

The generic evidence receipt can label `ROLLBACK` and `REINSTATEMENT`, and the audit/transition
schemas can record `ROLLED_BACK`. No schema binds the rollback quorum, initiator, both
authorizers, trigger evidence, source/target identities, compatibility result, compensation,
irreversible effects, invalidated receipts/nonces, credential rotation, resulting object
version, delivery acknowledgement, anchor, or reinstatement prerequisites.

### 5.11 Publication identity

**Design result: coherent prospective design, current use blocked by adoption/authority.**

The provenance output is consistent with the contract in separating raw working-tree,
LF-normalized, Git blob, index, commit-path, candidate-manifest, and publication-receipt
identities. It correctly preserves the unsupported historical commit reference and prohibits
silent substitution. It also keeps publication separate from acceptance and release.

No immutable Wave 0.4/Wave 0.5 candidate, canonical manifest, containing commit, remote object,
authorized publisher, publication signature, timestamp/transparency record, or publication
receipt exists. The provenance design requires a 20-entry Wave 0.4 candidate manifest, while the
review-preparation design requires the final review manifest to include Wave 0.5 submissions.
These can be nested or separately versioned, but their hierarchy and binding are not yet
specified.

### 5.12 G3/G4 boundaries

**Design result: aligned in prose, unavailable in evidence.**

The authority outputs and shared contract consistently require:

1. exact-candidate publication;
2. separate QA;
3. separate independent review;
4. findings/dependency closure;
5. Decision Chair `ACCEPTED` receipt for G3; and
6. only afterward, a separate Coordinator/Architect exact-run release for G4.

They consistently state that G3 acceptance does not authorize execution and that the Decision
Chair cannot issue the G4 release. Current states remain:

- Decision Chair: `UNASSIGNED`;
- A09: `UNRESOLVED`;
- G3: `CLOSED — BLOCKED BY DEPENDENCY`; and
- G4: `NOT AUTHORIZED`.

The schemas do not fully represent all four G3 receipt classes or the run-specific G4 receipt.
The generic receipt requires no run ID, implementation identity, dependency snapshot, release
row, actor set, maximum effects, abort conditions, rollback target, authorized rollback actions,
counter, nonce, revocation epoch, assignment, acknowledgement, or separation receipt.

## 6. Interface-by-interface classification

| Interface | Classification | Integration disposition |
| --- | --- | --- |
| `IF-01` Assignment authority to role verifier/G-PEP | `PARTIAL` | Authority package defines identity, mandate, scope, lifecycle, acknowledgement, and separation, but no assignment/delegation schema, adopted identity profile, signature purpose, verifier receipt, or effective assignment exists. |
| `IF-02` Publication/QA/review to Decision Chair | `BLOCKED_BY_ADOPTION` | Publication and G3 designs preserve role separation, exact candidate binding, and fail-closed review prerequisites. Current bytes are untracked, no candidate/publication receipt or effective actors exist, and the Wave 0.4 versus Wave 0.5 manifest hierarchy still needs an adopted binding rule. |
| `IF-03` Decision Chair to G-PEP/release verifier | `PARTIAL` | A09 schema covers candidate, prior state, evidence digests, outcome, signer, time, nonce, counter, epoch, and signature. It omits assignment/acknowledgement/separation refs and registry-specific digests; top-level and nested key-purpose consistency is not enforced; Decision Chair remains unassigned. |
| `IF-04` Coordinator/Architect to ARM/verifier/G-PEP | `PARTIAL` | G4 prose is comprehensive, but the generic receipt schema lacks run-specific fields and `common.schema.json` has no execution-release key purpose. No Coordinator/Architect assignment or release exists. |
| `IF-05` ARM publisher to TMC/verifier | `PARTIAL` | Effective-configuration and attestation schemas reference ARM digests, but no ARM schema, ARM publisher identity/purpose, acceptance-release chain, component contract, or ARM lifecycle object exists. |
| `IF-06` Verifier challenge to TMC | `PARTIAL` | Nonce and channel-binding fields occur in evidence/session schemas, but there is no challenge schema, verifier identity/signature, policy/audience binding object, single-use state, or 120-second maximum constraint. |
| `IF-07` Loader observation to TMC | `PARTIAL` | Effective-configuration schema models ordered inputs, hash domains, precedence, denylist, loader digest, and output digest. It does not bind exact opened handles, loader producer identity, TMC observation, session/challenge, signature, load result, or registered reason ordering. |
| `IF-08` TMC launch evidence to verifier | `CONFLICT` | The attestation schema, vector attestation, and contract use different schema IDs and key-purpose identifiers. The vector payload is a ledger-head signature-input object, not a conforming `attestation-evidence` launch object; no mapping or shared domain registry resolves them. |
| `IF-09` Platform enrollment/trust service to verifier | `PARTIAL` | Attestation carries only a platform quote digest. No EK/AK, PCR/event-log, enrollment, lifecycle, vTPM, revocation, or quote-verification schema/profile exists. |
| `IF-10` Provider/model authority to TMC/verifier | `PARTIAL` | Runtime evidence binds model and endpoint digests, but no provider statement schema binds tenant, region, proxy/TLS policy, request nonce, immutable model, commitments, audience, expiry, or provider signer authority. |
| `IF-11` Verifier verdict to G-PEP admission | `PARTIAL` | Session and receipt schemas include verdict/outcome states, but do not require verifier assignment, verdict signature purpose, complete evidence set, trusted receipt time, policy/trust/revocation snapshots, or an explicit admission result. |
| `IF-12` TMC liveness to verifier | `PARTIAL` | Attestation permits `LIVENESS`, sequence, prior evidence, nonce, channel, issue and expiry. It omits monotonic counter, current process/boot identity, security flags, challenge cadence, response deadline, two-miss rule, and schema-level suspension transition. |
| `IF-13` Inference evidence to verifier/audit binder | `PARTIAL` | `INFERENCE` is an evidence kind, but request ID, input/output commitments, nearest accepted liveness receipt, provider statement, inference result status, and governed-use denial binding are absent. |
| `IF-14` AMI-listed caller to G-PEP ingress | `PARTIAL` | Transition schema contains principal, AMI ID, object/version, idempotency, evidence, decision, and reason. It does not distinguish acceptance validation from persistence, bind raw-input commitment/correlation consistently, or define a dedicated intake-denial record. |
| `IF-15` G-PEP transaction to state/event/outbox | `CONFLICT` | Transition and audit schemas are directionally related, but the canonical vector event uses another schema ID and shape, `decision: ACCEPT` instead of schema `ALLOW`, and omits required audit fields. No normative projection maps the vector's `record_without_hash` to the audit schema; no outbox schema or atomic tuple contract exists. |
| `IF-16` G-PEP outbox to relay/WORM | `PARTIAL` | Audit vectors cover ledger framing, but there is no outbox/delivery schema, deadline, relay identity, exact-byte acknowledgement, retry state, or idempotent delivery receipt. Vector/schema event conflict also prevents a common payload. |
| `IF-17` WORM to anchor/chain verifier | `PARTIAL` | `AUDIT_ANCHOR` exists as a schema key-purpose value and prose specifies checkpoints, but no anchor schema, signer profile, Merkle/checkpoint object, freshness bound, or prior-checkpoint chain is supplied. |
| `IF-18` Reconciler to control/security/audit | `PARTIAL` | Prose defines bidirectional comparison, orphan rejection, and replay from committed outbox bytes only. No reconciliation input/output schema, difference classification registry, signed suspension request, or replay-instruction schema exists. |
| `IF-19` Trust-store/revocation publisher to consumers | `PARTIAL` | Contracts and authority prose require monotonic epochs, quorum, event ordering, and fail-closed unavailability. No trust-store, revocation snapshot, quorum, distribution, rollover, compromise, or key-status schema/registry has been supplied or adopted. |
| `IF-20` Rollback initiator/approvers to recovery controller | `PARTIAL` | G4 and contract prose align on bounded pre-authorization and independent approval, but no object records automatic policy authority or manual dual-role quorum, trigger evidence, known-good target, side effects, or plan result. |
| `IF-21` Recovery controller to state/audit/verifier | `PARTIAL` | Object/audit states can record rollback generally, but no rollback receipt binds source/target, new version, transaction/outbox/anchor, compensation, invalidations, credential rotation, or new-session requirement. |
| `IF-22` QA/reviewer/coordinator/Decision Chair to reinstatement | `PARTIAL` | Generic receipt permits `REINSTATEMENT`, while prose requires corrected evidence, QA, review, new release, and sometimes new A09. Those conditional prerequisites, separation rules, new validity, and terminal old-session/release bindings are not schema-enforced. |

## 7. Required reconciliation actions

These are design dependencies, not authorization to edit or implement:

1. Adopt one schema-ID/version namespace and explicitly map or regenerate the vector event and
   attestation payloads against the selected schemas.
2. Replace the three incompatible reason-code sets with one versioned registry, or publish an
   exhaustive one-to-one/many-to-one mapping with precedence and deprecation rules.
3. Replace contract, schema, and vector key-purpose literals with one closed registry and bind
   each object schema to its exact permitted purpose.
4. Define the exact schema-level `record_without_hash` projection for `audit-ledger-record` and
   regenerate canonical vectors that conform to it.
5. Add stable `interface_id` producer/consumer bindings and schema/profile versions for
   `IF-01` through `IF-22`.
6. Publish dedicated schemas for the missing assignment, ARM, challenge, provider, release,
   outbox, delivery, anchor, revocation, reconciliation, rollback, and reinstatement objects.
7. Add assignment, identity-system, trust-chain, acknowledgement, separation, counter, nonce,
   revocation, and independent-verification bindings to signed objects.
8. Complete decision-release-session-request-event-outbox-WORM-anchor references without relying
   on ambiguous generic digest fields.
9. Define a manifest hierarchy that binds the 20-artifact Wave 0.4 candidate and all Wave 0.5
   schemas, vectors, contracts, authority, provenance, and review outputs into one reviewable
   candidate.
10. Only after immutable publication, obtain exact-candidate QA, effective independent review,
    findings/dependency closure, Decision Chair acceptance for G3, and a separate
    Coordinator/Architect exact-run release for G4.

## 8. Design consistency versus demonstrated enforcement

### Design consistency established

Read-only inspection establishes that the outputs intentionally:

- distinguish measurement, verification, enforcement, acceptance, and release;
- preserve the core runtime and governed-object state names;
- give revocation/suspension/uncertainty fail-closed precedence;
- retain immutable history through rollback and reinstatement;
- separate publication, G3 acceptance, and G4 release; and
- label schemas, vectors, roles, receipts, and contracts as proposed or unauthenticated.

This is design-level consistency only. The two `CONFLICT` classifications and nineteen `PARTIAL`
classifications prevent a coherent adopted machine contract.

### Enforcement not demonstrated

Nothing inspected demonstrates that:

- schemas accept intended-positive fixtures or reject intended-negative fixtures;
- vectors conform to the schemas or are independently reproduced;
- ES256 signatures verify under authorized keys;
- identities, assignments, trust roots, revocation, trusted time, G-PEP, TMC, verifier, WORM,
  anchor, or reconciliation services exist or enforce the design;
- decision, release, session, mutation, audit, rollback, or reinstatement binding operates; or
- publication, QA, independent review, G3 acceptance, or G4 release has occurred.

No validator, test, signature verification, implementation, runtime probe, commit, push,
publication, or merge was performed for this report.

## 9. Final disposition

- `ALIGNED`: **0**
- `PARTIAL`: **19**
- `CONFLICT`: **2**
- `BLOCKED_BY_ADOPTION`: **1**
- total classified interfaces: **22**
- demonstrated enforcement interfaces: **0**
- adopted interfaces: **0**

Current integration disposition:

`DIRECTIONALLY CONSISTENT DESIGN -> TWO CONTRACT CONFLICTS -> NINETEEN PARTIAL INTERFACES -> PUBLICATION/REVIEW INTERFACE BLOCKED BY ADOPTION -> NO DEMONSTRATED ENFORCEMENT -> G3 CLOSED -> G4 NOT AUTHORIZED`

