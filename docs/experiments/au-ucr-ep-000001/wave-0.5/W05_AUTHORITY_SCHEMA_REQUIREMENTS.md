# Wave 0.5 Authority Schema Requirements

## Control record

- **Task:** `FOR-ACT-S0-001-W05-AUTHORITY`
- **Finding addressed:** `F04-NMF-04`
- **Experiment:** `AU-UCR-EP-000001`
- **Baseline HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Status:** `AUTHORITY_SCHEMA_REQUIREMENTS_SPECIFIED_NOT_IMPLEMENTED`
- **Schema effect:** **NONE**
- **Validation performed:** **NONE**
- **Unsafe generic receipt hazard count:** **24**
- **Decision Chair:** `UNASSIGNED`
- **A09:** `UNRESOLVED`
- **G3:** `CLOSED — BLOCKED BY DEPENDENCY`
- **G4:** `NOT AUTHORIZED`

This document specifies requirements for later purpose-specific schemas. It does not edit or
adopt the proposed schema bundle, validate an instance, create a real receipt, appoint an actor,
accept a candidate, or release a run. Every real actor, identity, mandate, key, signature, and
receipt value below remains blank.

## Required object separation

The authority model requires twelve separate object schemas:

1. `AuthorityAssignment`
2. `AssignmentAcknowledgement`
3. `SeparationConflictAssessment`
4. `CandidateQAReceipt`
5. `IndependentReviewReceipt`
6. `FindingsClosureReceipt`
7. `A09Decision`
8. `G3Acceptance`
9. `G4ExactRunRelease`
10. `AuthorityRevocation`
11. `RollbackAuthorization`
12. `ReinstatementAuthorization`

No generic `receipt_kind` discriminator is sufficient. Each object must have a distinct closed
schema ID/version and a constant `object_kind`. Shared definitions may be referenced, but no
schema may allow one object's role, key purpose, outcome, or prerequisites to substitute for
another's.

## Common normative envelope

Every object must require:

- `schema_id`, `schema_version`, `object_kind`, `object_id`, and globally unique `event_id`;
- experiment ID, canonical repository identity, object/candidate/run scope as applicable;
- canonicalization, signature framing, algorithm, and digest-domain profile IDs;
- exact payload digest and all referenced-object IDs plus digests;
- issuer governed name, stable identity, identity system/issuer, identity-proofing evidence, and
  organization;
- issuer `AuthorityAssignment`, `AssignmentAcknowledgement`, and
  `SeparationConflictAssessment` IDs/digests, except that assignment creation uses the grantor's
  corresponding authority objects and acknowledgement refers to the assignment being
  acknowledged;
- issuer role, exact key ID, exact key purpose, trust chain, and key-status evidence;
- issued-at, effective-from, effective-through, and verification-time UTC values;
- authority-scoped event counter, previous-event digest or genesis marker, nonce, and
  replay-register result;
- revocation/status snapshot ID/digest and status epoch;
- audience, conditions, exclusions, prior state, next state, and closed outcome;
- signature, verifier stable identity/effective assignment, and verification result; and
- critical-extension policy with unknown critical fields rejected.

The schemas must prohibit `null` for required evidence. Empty strings are invalid instances.
Unknown roles, kinds, purposes, outcomes, lifecycle states, and critical extensions fail closed.
Cross-object verification must prove that all prerequisite digests identify the same immutable
candidate and compatible policy, schema, trust, dependency, and revocation snapshots.

## Stable identity and mandate requirements

An assignment or receipt is ineffective unless the consumer verifies:

- governed/legal name: ``
- stable identity: ``
- identity system and issuer: ``
- identity-proofing/assurance evidence: ``
- organization: ``
- grantor name/stable identity: ``
- root mandate ID/digest: ``
- ordered delegation-chain IDs/digests: ``
- governing policy/version/digest: ``
- delegation permission and depth: ``
- terminating governing authority record: ``
- exact role, candidate/action/repository/environment/run scope: ``
- effective interval and lifecycle state: ``
- acknowledgement ID/digest: ``
- separation/conflict assessment ID/digest: ``
- current revocation/status evidence: ``

Display names, repository accounts, agent labels, branches, authorship, key possession, fixture
identities, and `"Human approved."` cannot satisfy these fields.

## Exact object requirements

### 1. `AuthorityAssignment`

- Constant kind: `AUTHORITY_ASSIGNMENT`
- Permitted issuer role: `ASSIGNMENT_AUTHORITY`
- Exact key purpose: `AUTHORITY_ASSIGNMENT`
- Permitted outcomes: `ASSIGNMENT_PROPOSED | ASSIGNMENT_EFFECTIVE | ASSIGNMENT_DENIED`
- Required subject: governed name, stable identity, identity proof, organization, assigned role
- Required provenance: grantor assignment; root mandate; ordered delegation chain; policy;
  delegation permission/depth; terminating governing record; verifier receipt
- Required scope: experiment, repository, immutable candidate classes, actions, exclusions,
  environment/run jurisdiction, usage limit, duties, and prohibited role combinations
- Required lifecycle: `DRAFT | ACKNOWLEDGED | EFFECTIVE | SUSPENDED | EXPIRED | REVOKED |
  SUPERSEDED`, effective interval, predecessor event, counter, status source
- Candidate binding: optional only for a policy-permitted standing assignment; exact candidate
  scope is mandatory before candidate action
- Real assignee name/stable identity: ``
- Real grantor name/stable identity: ``

An assignee cannot issue this object for itself. Reciprocal appointment and incompatible-role
aggregation must be rejected.

### 2. `AssignmentAcknowledgement`

- Constant kind: `ASSIGNMENT_ACKNOWLEDGEMENT`
- Permitted issuer role: the exact `ASSIGNEE`
- Exact key purpose: `ASSIGNMENT_ACKNOWLEDGEMENT`
- Permitted outcomes: `ACKNOWLEDGED | DECLINED`
- Required prerequisite: one exact `AuthorityAssignment` ID/digest in `DRAFT`
- Required binding: assignment digest, role, duties, scope, exclusions, effective interval,
  conflicts, lifecycle, revocation behavior, cryptographic profile, and standing/run boundary
- Required identity equality: issuer stable identity equals assignment subject stable identity
- Candidate binding: identical to the assignment
- Real assignee name/stable identity: ``

Silence, activity, credential use, or receipt of a task is not acknowledgement.

### 3. `SeparationConflictAssessment`

- Constant kind: `SEPARATION_CONFLICT_ASSESSMENT`
- Permitted issuer role: `SEPARATION_CHECKER`
- Exact key purpose: `SEPARATION_CONFLICT_ASSESSMENT`
- Permitted outcomes: `CLEAR | CONFLICT_DISPOSITIONED | RECUSAL_REQUIRED | FAILED`
- Required prerequisites: assignment, acknowledgement, declarations by assignee/grantor/all
  delegators, and checker's own effective assignment/acknowledgement
- Required checks: transitive stable-identity and role comparison; self/reciprocal appointment;
  shared reporting line/account/credential/key/control; organizational, financial, supervisory,
  technical, and personal conflicts; checker independence
- Required disposition: authority basis, recusal/replacement, conditions, affected scope
- Candidate binding: exact assignment and candidate/action scope
- Real checker name/stable identity: ``

### 4. `CandidateQAReceipt`

- Constant kind: `CANDIDATE_QA`
- Permitted issuer role: `QA_EVIDENCE_AGENT`
- Exact key purpose: `QA_RECEIPT`
- Permitted outcomes: `QA_PASS | QA_FAIL | QA_BLOCKED`
- Required prerequisites: QA assignment, acknowledgement, clear/dispositioned separation,
  immutable publication receipt, exact candidate manifest, schema/policy/trust/dependency
  snapshots
- Required evidence: QA plan, checks executed, reproducible results, checks blocked, defects,
  limitations, reason codes, and evidence digests
- Candidate binding: mandatory candidate commit/tree/manifest/publication identity and byte
  domains
- Prohibited outcome: `ACCEPTED`, `G3_ACCEPTED`, or `RELEASED`
- Real QA actor name/stable identity: ``

### 5. `IndependentReviewReceipt`

- Constant kind: `INDEPENDENT_REVIEW`
- Permitted issuer role: `INDEPENDENT_REVIEWER`
- Exact key purpose: `INDEPENDENT_REVIEW`
- Permitted outcomes: `REVIEW_PASS | REVIEW_REVISE | REVIEW_BLOCKED`
- Required prerequisites: reviewer assignment, acknowledgement, separation assessment, exact
  candidate/publication, and exact QA receipt
- Required evidence: review method, evidence examined, findings, objections, limitations, prior
  methodological-participation disposition, and reason codes
- Candidate binding: same immutable candidate and snapshots as QA
- Prohibited outcome: `ACCEPTED`, `G3_ACCEPTED`, or `RELEASED`
- Real reviewer name/stable identity: ``

### 6. `FindingsClosureReceipt`

- Constant kind: `FINDINGS_CLOSURE`
- Permitted issuer role: `FINDINGS_CLOSURE_AUTHORITY`
- Exact key purpose: `FINDINGS_CLOSURE`
- Permitted outcomes: `CLOSED | OPEN | BLOCKED`
- Required prerequisites: issuer assignment/acknowledgement/separation; exact QA and independent
  review; authoritative finding register; authoritative dependency registry
- Required evidence: every finding/dependency ID, disposition type, closure/waiver/acceptance
  authority basis, evidence IDs/digests, remaining blockers, policy-adoption receipts, and
  baseline/readiness hold disposition
- Candidate binding: exact immutable candidate and registry/policy snapshots
- Prohibited outcome: `ACCEPTED`, `G3_ACCEPTED`, or `RELEASED`
- Real closure authority name/stable identity: ``

### 7. `A09Decision`

- Constant kind: `A09_DECISION`
- Permitted issuer role: `DECISION_CHAIR`
- Exact key purpose: `A09_DECISION`
- Permitted outcomes: `ACCEPTED | REVISE | REJECTED`
- Required prerequisites: Decision Chair assignment, acknowledgement, separation assessment,
  exact QA receipt, exact independent-review receipt, exact findings-closure receipt, exact
  dependency-closure state, and immutable publication receipt
- Required transition vocabulary: candidate governance states only; object-stage `READY` or
  `PASSED` is forbidden
- Candidate binding: exact commit/tree/manifest/publication identity, all digest domains, and
  policy/schema/trust/dependency snapshots
- Effect: records A09 candidate decision only; cannot set G3 gate state or run state
- Real Decision Chair name/stable identity: ``

### 8. `G3Acceptance`

- Constant kind: `G3_ACCEPTANCE`
- Permitted issuer role: `DECISION_CHAIR`
- Exact key purpose: `G3_ACCEPTANCE`
- Sole permitted positive outcome: `G3_ACCEPTED`
- Required prerequisites: all prerequisites of `A09Decision`, plus exact accepted
  `A09Decision`, all still valid and candidate-identical at G3 ordering time
- Required transition: `CLOSED -> G3_ACCEPTED`
- Candidate binding: mandatory and identical across all typed prerequisites
- Effect: records G3 acceptance only; cannot set release, ARM eligibility, admission, or object
  stage
- Real Decision Chair name/stable identity: ``

### 9. `G4ExactRunRelease`

- Constant kind: `G4_EXACT_RUN_RELEASE`
- Permitted issuer role: `COORDINATOR_ARCHITECT`
- Exact key purpose: `G4_EXACT_RUN_RELEASE`
- Sole permitted positive outcome: `RELEASED`
- Required prerequisites: Coordinator/Architect assignment, acknowledgement, separation
  assessment, exact valid `G3Acceptance`, exact accepted `A09Decision`, QA/review/closure
  receipts, immutable candidate/publication, implementation and dependency snapshots
- Required run binding: unique run ID, environment/isolation boundary, actors and assignment
  digests, bounded actions/effects, release row/nodes/edges, feature state, effective window,
  preconditions, abort conditions, rollback target/actions, recovery authority, prior/next run
  state, nonce/counter/replay
- Candidate binding: exact accepted candidate plus exact implementation objects
- Effect: applies only to one run and cannot be generalized
- Real Coordinator/Architect name/stable identity: ``

### 10. `AuthorityRevocation`

- Constant kind: `AUTHORITY_REVOCATION`
- Permitted issuer role: `REVOCATION_AUTHORITY`
- Exact key purpose: `AUTHORITY_REVOCATION`
- Permitted outcomes: `SUSPENDED | REVOKED | SUPERSEDED`
- Required prerequisites: revocation-authority assignment, acknowledgement, separation, current
  status snapshot, incident/adjudication authority
- Required affected objects: assignment, acknowledgement, separation, decision, acceptance,
  release, keys, and/or scope IDs/digests
- Required ordering/effect: effective counter/time, reason, containment, affected work, re-review,
  prior/new state, status epoch, append-only predecessor
- Real revocation authority name/stable identity: ``

Revocation never deletes history and cannot be represented by editing an older object.

### 11. `RollbackAuthorization`

- Constant kind: `ROLLBACK_AUTHORIZATION`
- Required issuer roles: `COORDINATOR_ARCHITECT` and independent `SECURITY_GOVERNANCE`
- Exact key purpose: `ROLLBACK_AUTHORIZATION`
- Permitted outcomes: `ROLLBACK_AUTHORIZED | ROLLBACK_DENIED`
- Required prerequisites: both assignments/acknowledgements/separation assessments, affected G4
  release/run, trigger/incident, source state/evidence, separately accepted rollback target,
  compatibility evidence, side-effect inventory
- Required scope: exact environment, source/target digests, actions, maximum effects,
  compensations, credential rotation, irreversible effects, abort boundary, effective window
- Required signatures: both issuers over one identical payload
- Real Coordinator/Architect name/stable identity: ``
- Real Security/Governance approver name/stable identity: ``

Rollback authority is not general implementation authority.

### 12. `ReinstatementAuthorization`

- Constant kind: `REINSTATEMENT_AUTHORIZATION`
- Required issuer roles: `QA_EVIDENCE_AGENT`, `INDEPENDENT_REVIEWER`, and
  `COORDINATOR_ARCHITECT`; add `DECISION_CHAIR` when A09/G3 was invalidated
- Exact key purpose: `REINSTATEMENT_AUTHORIZATION`
- Permitted outcomes: `REINSTATED_NEW_VERSION | REINSTATEMENT_DENIED`
- Required prerequisites: suspension/revocation/cause record, corrected immutable evidence, new
  QA/review, new A09/G3 where required, new G4 release version, new run/session IDs
- Required scope: no expansion beyond original authority without a new assignment; new validity
  interval, counters, nonces, status and replay evidence
- Effect: creates new versions/sessions only; cannot reactivate a terminal object or
  retroactively validate actions
- Real QA actor name/stable identity: ``
- Real reviewer name/stable identity: ``
- Real Coordinator/Architect name/stable identity: ``
- Real Decision Chair name/stable identity, if required: ``

## Exact allowed role/kind/key-purpose/outcome combinations

Only these combinations are eligible for further verification:

- `ASSIGNMENT_AUTHORITY / AUTHORITY_ASSIGNMENT / AUTHORITY_ASSIGNMENT /
  ASSIGNMENT_PROPOSED|ASSIGNMENT_EFFECTIVE|ASSIGNMENT_DENIED`
- `ASSIGNEE / ASSIGNMENT_ACKNOWLEDGEMENT / ASSIGNMENT_ACKNOWLEDGEMENT /
  ACKNOWLEDGED|DECLINED`
- `SEPARATION_CHECKER / SEPARATION_CONFLICT_ASSESSMENT /
  SEPARATION_CONFLICT_ASSESSMENT / CLEAR|CONFLICT_DISPOSITIONED|RECUSAL_REQUIRED|FAILED`
- `QA_EVIDENCE_AGENT / CANDIDATE_QA / QA_RECEIPT / QA_PASS|QA_FAIL|QA_BLOCKED`
- `INDEPENDENT_REVIEWER / INDEPENDENT_REVIEW / INDEPENDENT_REVIEW /
  REVIEW_PASS|REVIEW_REVISE|REVIEW_BLOCKED`
- `FINDINGS_CLOSURE_AUTHORITY / FINDINGS_CLOSURE / FINDINGS_CLOSURE /
  CLOSED|OPEN|BLOCKED`
- `DECISION_CHAIR / A09_DECISION / A09_DECISION / ACCEPTED|REVISE|REJECTED`
- `DECISION_CHAIR / G3_ACCEPTANCE / G3_ACCEPTANCE / G3_ACCEPTED`
- `COORDINATOR_ARCHITECT / G4_EXACT_RUN_RELEASE / G4_EXACT_RUN_RELEASE / RELEASED`
- `REVOCATION_AUTHORITY / AUTHORITY_REVOCATION / AUTHORITY_REVOCATION /
  SUSPENDED|REVOKED|SUPERSEDED`
- `COORDINATOR_ARCHITECT+SECURITY_GOVERNANCE / ROLLBACK_AUTHORIZATION /
  ROLLBACK_AUTHORIZATION / ROLLBACK_AUTHORIZED|ROLLBACK_DENIED`
- required reinstatement quorum `/ REINSTATEMENT_AUTHORIZATION /
  REINSTATEMENT_AUTHORIZATION / REINSTATED_NEW_VERSION|REINSTATEMENT_DENIED`

Exact tuple compatibility is necessary but not sufficient. Stable identity, mandate, assignment,
acknowledgement, separation, candidate/run binding, temporal status, prerequisite, signature,
replay, and transition verification must also pass.

## Twenty-four unsafe generic receipt hazards to reject

1. Any unknown or non-constant receipt kind.
2. Any role string treated as proof of appointment.
3. Any signer/issuer ID without approved stable-identity proof.
4. Any technically valid signature without a valid mandate/delegation chain.
5. Any assignment signed by its own assignee as assignment authority.
6. Any reciprocal appointment or prohibited role aggregation.
7. Any acknowledgement issued by an identity other than the assignment subject.
8. Any acknowledgement that does not bind the exact assignment digest and duties.
9. Any separation assessment issued by the assignee, grantor, delegator, or incompatible actor.
10. Any candidate receipt without exact immutable manifest/publication identity and digest domain.
11. Any QA receipt issued by a non-QA role or carrying `ACCEPTED`, `G3_ACCEPTED`, or `RELEASED`.
12. Any review receipt issued by a non-reviewer or carrying a governance/release outcome.
13. Any closure receipt without typed finding/dependency evidence or carrying
    `ACCEPTED`, `G3_ACCEPTED`, or `RELEASED`.
14. Any A09 decision issued by a non-Decision Chair, wrong key purpose, or generic evidence key.
15. Any A09 decision based on opaque prerequisite hashes rather than typed candidate-identical
    QA, review, closure, dependency, and publication objects.
16. Any object-stage `READY`/`PASSED` transition treated as A09 or G3 acceptance.
17. Any G3 acceptance without a distinct accepted A09 decision and still-valid typed
    prerequisites.
18. Any A09 decision treated directly as G3 gate closure or execution release.
19. Any G4 release issued by the Decision Chair, implementer, generic signer, or wrong key
    purpose.
20. Any G4 release without exact run/environment/window/action/effect/actor/dependency/feature/
    abort/rollback binding.
21. Any publication, QA, review, signature verification, vector `ACCEPT`, or ledger
    `decision: ACCEPT` treated as governance acceptance.
22. Any revocation represented only by an epoch integer, mutable status field, or edit to prior
    evidence rather than an ordered append-only object.
23. Any rollback authorized by one actor, without an exact separately accepted target, or used as
    general implementation authority.
24. Any reinstatement that reactivates an old terminal release/session, omits new required
    QA/review/A09/G3/G4 objects, expands original scope, or retroactively validates actions.

Every hazard rejects the object or preserves the blocking state even when syntax and signature
verification succeed.

## Candidate-bound prerequisite rules

For QA, review, closure, A09, G3, G4, rollback, and reinstatement:

1. every prerequisite reference must be typed by schema ID and object kind, not an opaque digest;
2. every reference must include ID, digest, digest domain, repository, and immutable publication
   identity;
3. candidate commit/tree/manifest and policy/schema/trust/dependency/revocation snapshots must
   match exactly unless an authorized supersession object explicitly establishes a new version;
4. ordering must prove publication precedes QA, QA precedes review/closure as policy requires,
   closure precedes A09, A09 precedes G3, and G3 precedes G4;
5. no prerequisite may be expired, suspended, revoked, superseded, replayed, conflicted, or out
   of scope at the dependent event point;
6. changed candidate bytes, implementation, environment, run, or dependency snapshot require new
   applicable receipts; and
7. missing or ambiguous equality/order/status fails closed.

## Current disposition

- Purpose-specific schema objects required: `12`
- Unsafe generic receipt hazards: `24`
- Purpose-specific schemas implemented by this task: `0`
- Schema or signature validation performed: `0`
- Real actor/identity/mandate/signature fields populated: `0`
- `F04-NMF-04`: `DESIGN CORRECTION SPECIFIED / RE-REVIEW REQUIRED`
- Authority evidence gaps: `10 OPEN`
- Decision Chair: `UNASSIGNED`
- A09: `UNRESOLVED`
- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- G4: `NOT AUTHORIZED`

