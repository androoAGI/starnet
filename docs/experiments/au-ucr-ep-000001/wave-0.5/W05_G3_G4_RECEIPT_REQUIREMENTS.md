# Wave 0.5 G3 and G4 Receipt Requirements

## Control record

- **Task:** `FOR-ACT-S0-001-W05-AUTHORITY`
- **Experiment:** `AU-UCR-EP-000001`
- **Baseline HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Artifact status:** `PROPOSED_RECEIPT_REQUIREMENTS`
- **Authorization effect:** **NONE**
- **G3:** `CLOSED — BLOCKED BY DEPENDENCY`
- **G4:** `NOT AUTHORIZED`
- **A09:** `UNRESOLVED`
- **F04-NMF-04 authority disposition:** `DESIGN_CORRECTION_SPECIFIED_RE-REVIEW_REQUIRED`
- **Companion object specification:** `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md`

G3 governance acceptance and G4 execution release are sequential, separate state transitions.
Artifact production, QA, independent review, dependency closure, formal acceptance, and
exact-run release never imply one another. `"Human approved."` satisfies none of the receipts
below.

## Common binding and verification requirements

Every receipt must bind:

- one closed schema ID/version and one closed object kind;
- schema ID/version and governing policy/version;
- globally unique receipt/event ID;
- experiment, repository, immutable candidate/object identities, and digest byte domains;
- issuer name, stable identity, effective assignment ID/digest, key ID/purpose, and trust chain;
- scope, exclusions, previous state, next state, and conditions;
- issued-at, effective-from, effective-through, and verification-time UTC values;
- assignment/status evidence proving the issuer was in scope and effective when ordered;
- authority-scoped counter, previous-event digest or genesis marker, nonce, and replay-register
  result;
- canonical encoding/signature framing, signature, verifier identity, and verification result;
  and
- referenced prerequisite receipt IDs and digests.

Every receipt must also bind its issuer's `AuthorityAssignment`,
`AssignmentAcknowledgement`, and `SeparationConflictAssessment` IDs and digests. The verifier
must enforce the exact object-kind/issuer-role/key-purpose/outcome tuple defined in
`W05_AUTHORITY_SCHEMA_REQUIREMENTS.md`. A technically valid signature on a disallowed tuple is
invalid governance evidence.

A receipt fails closed if any bound object is mutable or missing, the issuer is unassigned or out
of scope, a prerequisite is absent, the signature/trust/status check fails, the receipt is stale
or replayed, or suspension/expiry/revocation/supersession precedes or cannot be ordered against
the action.

## G3 required receipt set

G3 may move from `CLOSED — BLOCKED BY DEPENDENCY` only when five distinct receipt classes exist
for one exact immutable candidate. Combining them into an undifferentiated approval is
insufficient.

### G3-1 — Exact-candidate QA receipt

Required issuer: an effectively assigned, acknowledged, conflict-checked QA/Evidence Agent,
independent from implementation and evidence preparation as required by policy.

- QA receipt ID: ``
- Object kind: `CANDIDATE_QA`
- Issuer role: `QA_EVIDENCE_AGENT`
- Key purpose: `QA_RECEIPT`
- Permitted outcome: `QA_PASS | QA_FAIL | QA_BLOCKED`
- QA actor name and stable identity: ``
- Effective assignment ID/digest: ``
- Assignment acknowledgement ID/digest: ``
- Conflict/separation receipt ID/digest: ``
- Exact candidate manifest/digest and byte domain: ``
- QA plan, schema, fixture, vector, and reason-registry versions/digests: ``
- Checks executed and reproducible results: ``
- Checks blocked or not executed: ``
- Defects/findings and severity: ``
- Disposition and residual limitations: ``
- Issued/effective interval, UTC: ``
- Event counter/nonce/replay result: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

`READY FOR ACCEPTANCE REVIEW`, design inspection, or artifact presence is not a QA receipt.

### G3-2 — Exact-candidate independent-review receipt

Required issuer: an effectively assigned, acknowledged, conflict-checked Independent Reviewer
whose independence from preparers, QA, publication, implementation, decision, and release roles
has been verified. The Wave 0.4 Agent D label, D-03, and its amendment do not by themselves
establish this governed assignment.

- Independent-review receipt ID: ``
- Object kind: `INDEPENDENT_REVIEW`
- Issuer role: `INDEPENDENT_REVIEWER`
- Key purpose: `INDEPENDENT_REVIEW`
- Permitted outcome: `REVIEW_PASS | REVIEW_REVISE | REVIEW_BLOCKED`
- Reviewer name and stable identity: ``
- Effective assignment ID/digest: ``
- Assignment acknowledgement ID/digest: ``
- Independence/conflict receipt ID/digest: ``
- Exact candidate manifest/digest: ``
- QA receipt ID/digest reviewed: ``
- Review method and evidence examined: ``
- Findings, objections, and unresolved limitations: ``
- Compatibility disposition for prior methodological participation: ``
- Review outcome: ``
- Issued/effective interval, UTC: ``
- Event counter/nonce/replay result: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

### G3-3 — Findings and dependency closure receipt

Required issuer(s): effectively assigned authorities for the governed dependency registry and
finding dispositions. Closure must be evidence-backed; waiver, acceptance, and remediation must
be distinguished.

- Closure receipt ID: ``
- Object kind: `FINDINGS_CLOSURE`
- Issuer role: `FINDINGS_CLOSURE_AUTHORITY`
- Key purpose: `FINDINGS_CLOSURE`
- Permitted outcome: `CLOSED | OPEN | BLOCKED`
- Issuer name(s), stable identities, and assignment digests: ``
- Assignment acknowledgement and separation/conflict digests: ``
- Exact candidate manifest/digest: ``
- Authoritative finding register/version/digest: ``
- Authoritative dependency registry/version/digest: ``
- Each finding ID and closure evidence ID/digest: ``
- Each dependency ID and satisfied evidence ID/digest: ``
- Remaining, waived, accepted, or transferred items and authority basis: ``
- Nine-objection matrix disposition: ``
- Baseline/readiness hold disposition: ``
- Trust/schema/state/hash-domain policy adoption receipts: ``
- Publication/immutable-candidate receipt: ``
- Closure outcome: ``
- Issued/effective interval, UTC: ``
- Event counter/nonce/replay result: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

Any open or merely design-addressed blocking dependency prevents G3 acceptance.

### G3-4 — A09 Decision Chair decision

Required issuer: the named, effectively assigned, acknowledged, conflict-checked Decision Chair.
It must be issued after verifying G3-1 through G3-3 for the same candidate.

- A09 decision receipt ID: ``
- Object kind: `A09_DECISION`
- Issuer role: `DECISION_CHAIR`
- Key purpose: `A09_DECISION`
- Decision Chair name and stable identity: ``
- Effective assignment and acknowledgement IDs/digests: ``
- Authority-chain and separation receipt IDs/digests: ``
- Exact candidate manifest/digest: ``
- QA receipt ID/digest: ``
- Independent-review receipt ID/digest: ``
- Findings/dependency closure receipt ID/digest: ``
- Decision: ``
- Permitted values: `ACCEPTED | REVISE | REJECTED`
- Accepted scope, conditions, exclusions, and residual risks: ``
- Previous state: ``
- Next state: ``
- Issued/effective interval, UTC: ``
- Assignment/status evidence at decision ordering point: ``
- Event counter/nonce/replay result: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

Only a verified `ACCEPTED` A09 outcome makes the candidate eligible for a separate G3 gate
acceptance. `REVISE`, `REJECTED`, a proposed decision, or general human approval does not make it
eligible.

### G3-5 — Formal G3 gate-acceptance receipt

Required issuer: the named, effectively assigned, acknowledged, conflict-checked Decision Chair
acting under a distinct G3 acceptance key purpose after rechecking G3-1 through G3-4.

- G3 acceptance receipt ID: ``
- Object kind: `G3_ACCEPTANCE`
- Issuer role: `DECISION_CHAIR`
- Key purpose: `G3_ACCEPTANCE`
- Permitted outcome: `G3_ACCEPTED`
- Decision Chair name and stable identity: ``
- Effective assignment/acknowledgement/separation IDs and digests: ``
- Exact candidate manifest/publication identity and digest domains: ``
- QA receipt ID/digest: ``
- Independent-review receipt ID/digest: ``
- Findings/dependency-closure receipt ID/digest: ``
- Accepted A09 decision ID/digest: ``
- Policy/schema/trust/dependency snapshot digests: ``
- Prior gate state: `CLOSED`
- Next gate state: `G3_ACCEPTED`
- Conditions, exclusions, and residual risks: ``
- Issued/effective interval and verification time, UTC: ``
- Event counter/previous-event digest/nonce/replay result: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

G3 acceptance authorizes no execution.

## G3 evaluation rule

G3 is eligible to close only if:

1. G3-1 through G3-5 are individually valid;
2. all five bind the same immutable candidate and compatible policy/dependency snapshots;
3. receipt ordering proves QA, review, closure, and A09 decision preceded G3 acceptance;
4. no issuer assignment or prerequisite was expired, suspended, revoked, or superseded at its
   event point;
5. no blocking finding, dependency, replay, scope, conflict, trust, or candidate-identity failure
   remains; and
6. the acceptance transition is recorded append-only.

Current result: `NOT ELIGIBLE`; all five receipt classes are absent.

## G4 subsequent exact-run release receipt

G4 is evaluated only after a valid G3 acceptance. It requires a new receipt from an effectively
assigned and acknowledged Coordinator/Architect. The Decision Chair cannot issue this receipt,
and the G3 acceptance cannot be reused as a run release.

### Coordinator/Architect assignment prerequisites

- Coordinator/Architect name and stable identity: ``
- Effective assignment ID/digest: ``
- Delegating-authority chain receipt ID/digest: ``
- Release-row and environment scope: ``
- Duties and prohibited actions: ``
- Effective-from/effective-through, UTC: ``
- Conflict/separation receipt ID/digest: ``
- Explicit acknowledgement ID/digest: ``
- Current lifecycle/status evidence: ``
- Verification result: `NOT_PERFORMED`

### Fillable exact-run execution-release receipt

- Release receipt ID: ``
- Object kind: `G4_EXACT_RUN_RELEASE`
- Issuer role: `COORDINATOR_ARCHITECT`
- Key purpose: `G4_EXACT_RUN_RELEASE`
- Permitted outcome: `RELEASED`
- Run ID and unique event ID: ``
- Coordinator/Architect name and stable identity: ``
- Effective assignment and acknowledgement IDs/digests: ``
- Exact G3 gate-acceptance receipt ID/digest: ``
- Exact accepted A09 decision ID/digest: ``
- Exact candidate and publication manifest/digest: ``
- Implementation commit/tree/artifact digests: ``
- Governance/policy/dependency snapshot digests: ``
- QA, review, findings-closure, and dependency-closure receipt IDs/digests: ``
- Run purpose and bounded authorized actions: ``
- Explicitly prohibited actions and maximum effects: ``
- Release row and enabled nodes/edges: ``
- Target environment identity and isolation boundary: ``
- Actor assignments and acknowledgement IDs/digests: ``
- Required LAB construction/test authorization IDs/digests, if applicable: ``
- Feature/treatment flag initial and authorized states: ``
- Effective-from/effective-through run window, UTC: ``
- Preconditions and readiness checks: ``
- Abort/stop conditions: ``
- Rollback target exact identity: ``
- Rollback actions already authorized by this receipt: ``
- Recovery authority and escalation boundary: ``
- Previous run state: ``
- Next run state: ``
- Run nonce/counter and replay-register result: ``
- Assignment and prerequisite status evidence at release ordering point: ``
- Signature/receipt: ``
- Independent verification result: `NOT_PERFORMED`

The release becomes ineffective outside its time window, scope, environment, candidate,
implementation identity, actor set, or maximum effects. It cannot be generalized to another run.

## Separate revocation, rollback, and reinstatement objects

These lifecycle actions may not be represented by changing the outcome of a generic receipt.

### Authority revocation

- Object kind: `AUTHORITY_REVOCATION`
- Issuer role: `REVOCATION_AUTHORITY`
- Key purpose: `AUTHORITY_REVOCATION`
- Permitted outcome: `SUSPENDED | REVOKED | SUPERSEDED`
- Revocation record ID: ``
- Issuer name/stable identity and assignment/acknowledgement/separation digests: ``
- Exact affected assignment/decision/acceptance/release IDs and digests: ``
- Effective ordering, scope, reason, incident/adjudication, containment, and re-review: ``
- Event counter/previous-event digest/nonce/replay/status verification: ``
- Signature/receipt: ``
- Verification result: `NOT_PERFORMED`

### Rollback authorization

- Object kind: `ROLLBACK_AUTHORIZATION`
- Issuer roles: `COORDINATOR_ARCHITECT + SECURITY_GOVERNANCE`
- Key purpose: `ROLLBACK_AUTHORIZATION`
- Permitted outcome: `ROLLBACK_AUTHORIZED | ROLLBACK_DENIED`
- Rollback record ID: ``
- Both issuers' names/stable identities and assignment/acknowledgement/separation digests: ``
- Exact affected run/release/candidate/environment/source-state IDs and digests: ``
- Exact separately accepted rollback target and compatibility evidence: ``
- Authorized actions, maximum effects, compensations, abort conditions, and irreversible effects: ``
- Effective window/event ordering/nonce/replay/status verification: ``
- Both signatures/receipts: ``
- Verification result: `NOT_PERFORMED`

### Reinstatement authorization

- Object kind: `REINSTATEMENT_AUTHORIZATION`
- Issuer roles: `QA_EVIDENCE_AGENT + INDEPENDENT_REVIEWER + COORDINATOR_ARCHITECT`;
  `DECISION_CHAIR` additionally required when acceptance was invalidated
- Key purpose: `REINSTATEMENT_AUTHORIZATION`
- Permitted outcome: `REINSTATED_NEW_VERSION | REINSTATEMENT_DENIED`
- Reinstatement record ID: ``
- Issuer names/stable identities and assignment/acknowledgement/separation digests: ``
- Suspension/revocation/cause-resolution record IDs and digests: ``
- Corrected candidate/evidence, new QA/review, and new A09/G3 records where required: ``
- New G4 release version and new run/session IDs: ``
- New validity window/event ordering/nonce/replay/status verification: ``
- Required signatures/receipts: ``
- Verification result: `NOT_PERFORMED`

Reinstatement cannot reactivate an old terminal release or session and cannot retroactively
validate actions.

## Expiry, revocation, suspension, and rollback

- Expiry, suspension, revocation, supersession, conflict discovery, scope mismatch, candidate
  replacement, dependency regression, or failed verification preserves or returns the affected
  gate to its blocked state.
- Event-chain/counter ordering governs races. An acceptance or release ordered at or after the
  invalidating event is rejected; uncertain ordering fails closed.
- Invalidation of G3 evidence invalidates downstream G4 eligibility. Invalidation of a G4
  prerequisite suspends that run without rewriting the historical acceptance record.
- On invalidation: stop at the authorized abort boundary; keep feature/treatment paths OFF or
  return them OFF; preserve receipts and evidence append-only; quarantine affected identities;
  append correction/revocation events; and return the exact candidate to the required QA,
  independent review, closure, decision, and release stages.
- Rollback authority is limited to the exact actions and target bound in the run receipt. A
  rollback clause is not general implementation authority. If safe rollback falls outside the
  receipt, stop, contain, and obtain new authority.
- Reinstatement cannot retroactively validate work and cannot exceed the original scope or
  expiry. A materially changed candidate, dependency snapshot, implementation, environment, or
  run requires new receipts.

## Current disposition

- G3 QA receipt: `ABSENT`
- G3 independent-review receipt: `ABSENT`
- G3 findings/dependency closure receipt: `ABSENT`
- A09 decision receipt: `ABSENT`
- G3 formal gate-acceptance receipt: `ABSENT`
- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- Coordinator/Architect effective assignment: `NOT ESTABLISHED`
- G4 exact-run release receipt: `ABSENT`
- Revocation/rollback/reinstatement objects: `ABSENT`
- `F04-NMF-04`: `DESIGN CORRECTION SPECIFIED / RE-REVIEW REQUIRED`
- G4: `NOT AUTHORIZED`
- A09: `UNRESOLVED`

