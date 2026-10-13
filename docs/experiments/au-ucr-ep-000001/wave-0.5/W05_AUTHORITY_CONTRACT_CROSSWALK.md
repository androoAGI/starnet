# Wave 0.5 Authority Contract Crosswalk

## Control record

- **Task:** `FOR-ACT-S0-001-W05-AUTHORITY`
- **Reconciliation:** `WAVE_2`
- **Experiment:** `AU-UCR-EP-000001`
- **Baseline HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Artifact status:** `CROSSWALK_COMPLETE_REMEDIATION_REQUIRED`
- **Authority effect:** **NONE**
- **Open human-authority gaps:** **10**
- **Schema/contract mismatches:** **16**
- **Decision Chair:** `UNASSIGNED`
- **G3:** `CLOSED — BLOCKED BY DEPENDENCY`
- **G4:** `NOT AUTHORIZED`
- **A09:** `UNRESOLVED`

This crosswalk inspects proposed design artifacts only. It does not adopt a contract or schema,
validate a signature, appoint an actor, accept a candidate, release a run, or authorize A09.
Existing authority artifacts are not amended by this record.

## Inspected inputs

- `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`
- `W05_INTERFACE_MATRIX.md`
- `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`
- `schemas/README.md`
- `schemas/common.schema.json`
- `schemas/authorization-a09-decision.schema.json`
- `schemas/evidence-acceptance-receipt.schema.json`
- the other five proposed record schemas and their fixture manifest
- `schemas/fixtures/authorization-a09-decision.positive.json`
- `schemas/fixtures/evidence-acceptance-receipt.positive.json`
- `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md`
- `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`
- `W05_AUTHORITY_CLOSURE_PACKAGE.md`
- `W05_G3_G4_RECEIPT_REQUIREMENTS.md`

The schema bundle is `PROPOSED_NOT_ADOPTED`; no validator was run. The vector bundle is derived
design evidence, not independently verified or adopted, and contains no ES256 signature values.
The Wave 0.4 and Wave 0.5 artifacts remain mutable working-tree content rather than an immutable
published candidate.

## Technical signature validity is not governance authority

A technical signature check answers only whether signature bytes verify under a supplied key over
the claimed payload and framing. Governance authority additionally requires all of the following
to be independently verified:

1. the signer is a named person or service bound to a stable identity;
2. a valid mandate/delegation chain authorized that identity for the exact governed role;
3. the assignment covers the exact candidate, action, repository, environment, and time;
4. duties, prohibitions, delegation depth, and separation constraints are satisfied;
5. conflicts were declared, checked transitively, and dispositioned;
6. the assignee explicitly acknowledged the exact assignment;
7. the assignment and key were effective, unexpired, unsuspended, and unrevoked at the
   authority-scoped event ordering point;
8. prerequisites were independently verified and bind the same immutable candidate;
9. nonce, counter, predecessor, event-chain, and replay checks passed; and
10. the receipt's state transition is permitted and recorded by the authoritative consumer.

`signature`, `key_id`, `key_purpose`, `signer_identity`, `issuer_role`, `role_scope`, or a
cryptographically valid payload does not prove any item above by itself. A role label is a claim,
not an appointment. Key possession is not mandate provenance. Schema validity is not receipt
validity. Publication is not acceptance, and acceptance is not execution release.

## Crosswalk to the ten open human-authority gaps

### `W05-AUTH-GAP-01` — Named Decision Chair

- Contract/interface coverage: the shared contract requires a named Decision Chair; `IF-03`
  assigns governance-outcome write authority to that role.
- Schema fields: `signer_identity`; `role_scope: DECISION_CHAIR`; generic
  `issuer_identity`/`issuer_role`.
- Provenance requirement: exact-candidate acceptance must identify the effectively assigned
  Decision Chair.
- Unresolved evidence/schema gap: no legal/governed name, assignment record ID/digest, or
  machine-valid `AssignmentReceipt` schema exists. A role constant cannot appoint its signer.
- Status: `OPEN`.

### `W05-AUTH-GAP-02` — Stable identity

- Contract/interface coverage: Sections 4.1 and `IF-01` require a stable identity in an approved
  identity system and reject display names, repository identities, agent labels, and key
  possession as identity proof.
- Schema fields: `signer_identity` and `issuer_identity` use only the generic string `id`.
- Unresolved evidence/schema gap: identity system, issuer, legal-person binding, assurance level,
  identity-proofing evidence, organization, and verification receipt are absent.
- Status: `OPEN`.

### `W05-AUTH-GAP-03` — Delegating authority

- Contract/interface coverage: `IF-01` requires root mandate, delegation chain, depth, and signed
  assignment lifecycle verification; the shared contract prohibits self- or reciprocal
  appointment.
- Schema fields: none in either authority-relevant record schema.
- Unresolved evidence/schema gap: no grantor identity, root mandate, ordered delegation chain,
  policy/version, delegation permission/depth, terminating governing record, or chain-verifier
  receipt.
- Status: `OPEN`.

### `W05-AUTH-GAP-04` — Scope

- Contract/interface coverage: common envelope and `IF-03`/`IF-04` require candidate, repository,
  audience, environment, run, action, and object scope.
- Schema fields: A09 has `repository_id`, `object_id`, `candidate_commit`,
  `artifact_bundle_digest`, `role_scope`, `audience`, and `environment`; the generic receipt has
  candidate and audience fields.
- Unresolved evidence/schema gap: no exact assignment scope, candidate manifest/publication
  receipt/root tree, branch/object jurisdiction, permitted decision set, explicit exclusions,
  decision/usage limit, or scope-verification result. Generic receipt scope is weaker still.
- Status: `OPEN`.

### `W05-AUTH-GAP-05` — Duties and boundaries

- Contract/interface coverage: signer-role matrix, interface ownership, and state handoffs
  separate QA, review, Decision Chair, Coordinator/Architect, publisher, verifier, and G-PEP.
- Schema fields: role labels and receipt kinds only.
- Unresolved evidence/schema gap: no assignment-bound duties, prohibited actions, separation from
  incompatible roles, required evidence checks, or acknowledgement that standing assignment does
  not authorize a run.
- Status: `OPEN`.

### `W05-AUTH-GAP-06` — Effective time

- Contract/interface coverage: explicit effective interval, trusted verification time, event
  counter, and fail-closed expiry are required.
- Schema fields: A09 requires `role_effective_from`, receipt `issued_at`, `not_before`,
  `expires_at`, and `authority_counter`; `role_effective_until` exists but is optional. The generic
  receipt requires only `issued_at` and `expires_at`.
- Unresolved evidence/schema gap: no required assignment effective-through, trusted verification
  time, explicit ordering against assignment status events, or proof that receipt and assignment
  windows overlap. Receipt expiry cannot substitute for assignment expiry.
- Status: `OPEN`.

### `W05-AUTH-GAP-07` — Conflicts and separation

- Contract/interface coverage: mandatory role separation appears in the signer-role matrix,
  `IF-01` through `IF-04`, ownership rules, and rollback quorum.
- Schema fields: none.
- Unresolved evidence/schema gap: no assignee/grantor/delegator declarations, transitive identity
  comparison, shared-control disclosure, checker identity/authority, disposition/recusal, or
  signed separation receipt.
- Status: `OPEN`.

### `W05-AUTH-GAP-08` — Explicit acknowledgement

- Contract/interface coverage: identity/role receipts and `AssignmentReceipt` profile require
  acknowledgement; named Decision Chair and Coordinator/Architect are explicitly described as
  acknowledged roles.
- Schema fields: none.
- Unresolved evidence/schema gap: no acknowledgement receipt ID/digest, acknowledged assignment
  digest, acknowledged duties/scope/limits/interval/conflicts/lifecycle/run boundary, actor
  identity, timestamp, or verification result.
- Status: `OPEN`.

### `W05-AUTH-GAP-09` — Revocation and lifecycle

- Contract/interface coverage: separate assignment, governance, run, and ARM lifecycles;
  `IF-19` revocation snapshots; blocking precedence; terminal states; append-only adjudication.
- Schema fields: A09 has `revocation_epoch`, `authority_counter`, `not_before`, and `expires_at`;
  generic receipts have `expires_at` and optional `prior_receipt_digest`.
- Unresolved evidence/schema gap: no required assignment lifecycle state/status snapshot,
  revocation source/digest, suspension/revocation/supersession event reference, previous authority
  event digest, status verification time/result, affected-work containment, or re-review rule.
- Status: `OPEN`.

### `W05-AUTH-GAP-10` — Exact-run authorization

- Contract/interface coverage: `IF-04`, run-state machine, binding chain, and
  `ExecutionReleaseReceipt` profile correctly require a later Coordinator/Architect release after
  acceptance.
- Schema fields: the generic receipt allows `receipt_kind: EXECUTION_RELEASE`, requires
  `issuer_role: COORDINATOR_ARCHITECT`, and forces `outcome: RELEASED`.
- Unresolved evidence/schema gap: no dedicated release schema and no required run ID, environment,
  validity window, bounded actions/effects, actor assignments, exact A09 acceptance reference,
  dependency snapshot, feature state, abort conditions, rollback target/actions, nonce/counter,
  revocation epoch, or prior/next run state.
- Status: `OPEN / NOT AUTHORIZED`.

## G3 verification

The narrative contract preserves G3 separation:

- `IF-02` requires immutable candidate publication, QA, independent review, and
  findings/dependency status.
- `IF-03` permits only the Decision Chair to create the governance outcome.
- The binding chain orders publication, QA/review, A09, and only then execution release.
- Governance `ACCEPTED` permits release evaluation only; it does not create `RELEASED`,
  `ELIGIBLE`, `ADMITTED`, or `PASSED`.

The schema bundle does not fully enforce G3:

- no typed candidate review package schema exists;
- no findings/dependency-closure receipt kind or schema exists;
- four opaque `supporting_receipt_digests` do not prove one QA, one independent review, one
  findings closure, and one dependency closure receipt;
- receipt-kind/issuer-role/outcome compatibility is not enforced for A09 acceptance; and
- candidate publication identity is incomplete.

Result: narrative separation `VERIFIED AS SPECIFIED`; machine-enforced G3 separation
`NOT ESTABLISHED`; G3 remains `CLOSED — BLOCKED BY DEPENDENCY`.

## G4 verification

The narrative contract preserves G4 separation:

- `IF-04` has Coordinator/Architect as producer and requires a valid `ACCEPTED` A09 receipt.
- governance and run authorization have separate state machines;
- the Decision Chair is an explicit non-writer of execution release;
- an execution release must bind the exact run, implementation/candidate, environment, window,
  effects, feature state, abort conditions, and rollback target; and
- `IF-05` may evaluate ARM eligibility only after both acceptance and release.

The generic receipt schema enforces only the Coordinator/Architect role label and `RELEASED`
outcome. It does not enforce an effective assignment, a valid A09 predecessor, run binding,
release-window semantics, conflict separation, acknowledgement, revocation ordering, or rollback.

Result: narrative separation `VERIFIED AS SPECIFIED`; machine-enforced G4 separation
`INCOMPLETE`; G4 remains `NOT AUTHORIZED`.

## Expiry, revocation, acknowledgement, conflict, and run-binding verification

- **Expiry:** narratively fail-closed and ordered; schema incomplete because
  `role_effective_until` is optional and assignment/receipt interval overlap is not expressible.
- **Revocation:** narratively fail-closed through `IF-19` and precedence; schema incomplete
  because an integer epoch alone does not identify or verify the applicable status snapshot.
- **Acknowledgement:** narratively mandatory; absent from the authority-relevant schemas.
- **Conflict/separation:** narratively mandatory and role-specific; absent from the
  authority-relevant schemas.
- **Run binding:** narratively detailed in `IF-04`; almost entirely absent from the generic
  execution-release receipt.
- **Rollback:** narratively requires an exact accepted target and Coordinator/Architect plus
  independent Security/Governance approval; the generic receipt has neither rollback target nor
  quorum fields.

## Sixteen schema/contract mismatches and implication hazards

### `W05-AUTH-MM-01` — Assignment profile has no schema

`AssignmentReceipt` is required by `IF-01` but no machine-valid assignment/delegation schema
exists. Consumers therefore cannot schema-enforce appointment provenance or lifecycle.

### `W05-AUTH-MM-02` — Role labels can masquerade as appointment

`role_scope: DECISION_CHAIR` and generic `issuer_role` values are self-asserted strings/constants
without an assignment record/digest or assignment verification result. They must never be read as
appointments.

### `W05-AUTH-MM-03` — Stable identity proof is absent

`signer_identity`/`issuer_identity` accept generic IDs without identity system, issuer,
proofing/assurance, organization, or legal/governed-name binding.

### `W05-AUTH-MM-04` — Mandate and delegation are absent

The A09 and generic receipt schemas contain no grantor, root mandate, delegation chain,
delegation-depth, parent mandate, or provenance-verifier fields.

### `W05-AUTH-MM-05` — Assignment scope and duties are absent

Candidate and environment fields do not encode assignment jurisdiction, permitted decisions,
explicit prohibitions, decision limits, duties, or standing-assignment/run boundary.

### `W05-AUTH-MM-06` — Effective assignment interval is incomplete

`role_effective_until` is optional, assignment lifecycle/status is absent, and the schemas cannot
prove the signer was effective when the event was ordered.

### `W05-AUTH-MM-07` — Acknowledgement is absent

No authority-relevant schema binds assignee acknowledgement to the exact assignment, duties,
scope, interval, conflicts, lifecycle, revocation, and run boundary.

### `W05-AUTH-MM-08` — Conflict/separation evidence is absent

No declarations, transitive role comparison, checker authority, recusal/disposition, or
separation receipt is required.

### `W05-AUTH-MM-09` — Signature validity can be mistaken for authority

The schemas require signature-shaped fields but cannot prove ES256 validity, trust-root status,
identity-to-role authorization, or mandate provenance. Even a valid ES256 signature would prove
possession/control of a key, not appointment or acceptance authority.

### `W05-AUTH-MM-10` — Opaque prerequisites can imply G3 completion

`supporting_receipt_digests` requires four untyped hashes. It does not require distinct valid QA,
independent-review, findings-closure, and dependency-closure receipts for the same candidate.

### `W05-AUTH-MM-11` — Generic receipt permits invalid kind/role/outcome combinations

Except for `EXECUTION_RELEASE`, the generic schema does not constrain combinations. For example,
an `A09_ACCEPTANCE` could be schema-valid with `issuer_role: PUBLISHER`, and QA or publication
could carry `outcome: ACCEPTED`. Those combinations must not create governance acceptance.

### `W05-AUTH-MM-12` — Governance and object-stage states are conflated

The A09 fixture requests `A09:READY->PASSED`, while the shared contract gives governance its own
`... -> ACCEPTED | REVISE | REJECTED` state machine and states that object `PASSED` is not
acceptance. `requested_transition` is unconstrained free text and `prior_state` uses the governed
object vocabulary, creating an implication hazard.

### `W05-AUTH-MM-13` — Execution release is structurally under-specified

The generic release receipt can become schema-valid without run ID, exact accepted predecessor,
environment/window, bounded actions/effects, actor assignments, feature state, abort conditions,
rollback target/actions, dependency snapshot, nonce/counter, or prior/next run state.

### `W05-AUTH-MM-14` — Key-purpose separation is inconsistent

The common signature enum has no assignment, execution-release, publication, revocation, or
rollback key purpose. The generic `EXECUTION_RELEASE` receipt can therefore use an unrelated
allowed purpose, and no receipt-kind-to-signature-purpose conditional prevents it.

### `W05-AUTH-MM-15` — Revocation/replay/event-chain binding is incomplete

The generic receipt lacks revocation epoch/snapshot, nonce, authority counter, and previous-event
digest. The A09 schema has an epoch/counter/nonce but no required revocation snapshot digest,
assignment-status result, or predecessor authority-event digest.

### `W05-AUTH-MM-16` — Fixtures/vectors contain acceptance-like labels without authority

The positive A09 fixture uses `chair.example`, `DECISION_CHAIR`, a signature-shaped placeholder,
and the baseline commit without assignment evidence. Ledger vectors use
`"decision":"ACCEPT"` for byte/framing construction. Although the surrounding documents disclaim
authority and the A09 fixture outcome is `REVISE`, isolated consumption could misread these labels
as an appointment, valid decision, or acceptance. Fixtures must be visibly synthetic and their
`ACCEPT` token must be namespaced as a technical/event disposition, never governance acceptance.

## Fields and values that must not imply appointment or acceptance

- `signer_identity`, `issuer_identity`: identifiers only; not proofed identity or appointment.
- `role_scope`, `issuer_role`, `producer_role`: asserted role labels only.
- `key_id`, `key_purpose`, `signature`: technical signature inputs/evidence only.
- `role_effective_from`, `issued_at`, `not_before`, `expires_at`: timestamps only; not proof of an
  effective assignment.
- `revocation_epoch`: an integer claim only without a verified status snapshot and ordering.
- `supporting_receipt_digests`: opaque references, not typed or verified prerequisites.
- `receipt_kind: A09_ACCEPTANCE` and `outcome: ACCEPTED`: payload claims only until the Decision
  Chair assignment, separation, acknowledgement, prerequisites, candidate identity, signature,
  status, and event transition all verify.
- `receipt_kind: EXECUTION_RELEASE` and `outcome: RELEASED`: payload claims only until the
  Coordinator/Architect assignment and exact-run prerequisites verify.
- vector `expected.result: ACCEPT`: vector-construction expectation only.
- ledger `decision: ACCEPT`: technical event field only; not G3 acceptance.
- object state `PASSED`: stage-evaluator result only; not governance `ACCEPTED`.
- `contract_status: PROPOSED_NOT_ADOPTED`: explicitly prevents adoption or authority inference.

## Required reconciliation direction

1. Add separate schemas for assignment/delegation lifecycle, typed G3 QA/review/closure receipts,
   formal A09 acceptance, exact-run execution release, revocation snapshot, acknowledgement,
   conflict/separation, and rollback/reinstatement.
2. Require assignment and acknowledgement IDs/digests, authority-chain verification,
   conflict/separation receipt, lifecycle/status snapshot, verification time/result, and exact
   role-purpose binding in every governed decision/release.
3. Replace opaque prerequisite arrays with typed, candidate-bound references and enforce
   kind/role/outcome/signature-purpose compatibility.
4. Separate candidate governance state from A01-A12 governed-object state in schema.
5. Require immutable publication manifest/receipt/root-tree bindings and explicit hash domains.
6. Require G4 run/environment/window/action/effect/actor/dependency/feature/abort/rollback fields
   and a valid exact G3 acceptance predecessor.
7. Mark fixture identities and signatures unmistakably synthetic and namespace technical
   `ACCEPT` results away from governance acceptance.
8. Validate schemas, signatures, temporal/order constraints, replay controls, and cross-object
   references only under separately authorized conformance work; schema parsing alone is
   insufficient.

## Final disposition

- Human-authority gaps: `10 OPEN`
- Schema/contract mismatches: `16 OPEN`
- Technical signature validity: `NOT GOVERNANCE AUTHORITY`
- Decision Chair appointment: `NOT ESTABLISHED`
- G3 narrative separation: `SPECIFIED`
- G3 machine enforcement: `NOT ESTABLISHED`
- G4 narrative separation: `SPECIFIED`
- G4 machine enforcement: `INCOMPLETE`
- Acknowledgement schema coverage: `ABSENT`
- Conflict/separation schema coverage: `ABSENT`
- Exact-run release schema coverage: `ABSENT`
- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- G4: `NOT AUTHORIZED`
- A09: `UNRESOLVED`

