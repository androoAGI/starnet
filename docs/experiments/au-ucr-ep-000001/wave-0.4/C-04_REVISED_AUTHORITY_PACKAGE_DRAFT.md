# C-04 Revised Authority Package — Wave 0.4 Design Draft

## Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Stable source task: `C-04`
- Artifact status: `DESIGN_DRAFT`
- Artifact completion: `DRAFT_PRODUCED`
- Independent review: `NOT_STARTED`
- Governance acceptance: `NOT_ACCEPTED`
- Execution release: `NOT_AUTHORIZED`
- Decision Chair: `UNASSIGNED`
- Decision A: `REVISE`
- Branch inspected: `cursor/populate-authority-readiness-7886`
- Baseline HEAD inspected: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Authorization effect: **NONE**

`Decision A: REVISE` is the required remediation disposition, not a Decision Chair receipt. No
person, signature, appointment, acceptance, or release is inferred. This draft may not appoint an
actor or authorize publication, review, acceptance, implementation, testing, merge, or execution.

## Evidence basis and corrections carried forward

This revision is based on:

- `../wave-0.3/C-04_AUTHORITY_PACKAGE_DRAFT.md`
- `../wave-0.3/D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md`
- `../wave-0.3/D-02_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md`
- `../wave-0.3/GATE-03_CONSOLIDATED_DECISION_PACKAGE.md`
- `../wave-0.3/GATE-03_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md`
- `../wave-0.3/SCRUM03_RECONCILIATION.md`
- `../AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`
- `../S0_EVIDENCE_CONVENTIONS.md`
- `../S0_WORKTREE_LANE_REGISTER.yaml`
- `../S0_QA_READINESS_GATE.json`

The Wave 0.3 files are now tracked in baseline HEAD `39bade050...`; statements that they are
untracked are historical observations and are not current state. Amendment 1 also withdraws the
three-file PRE_A09 mismatch as a blocker: the manifest hashes Git-blob/LF content and matches the
index and HEAD. Remaining provenance defects are the unstated hash domain, absent `.gitattributes`,
and the deterministic-readiness receipt's unresolved commit-identity discrepancy.

## Four separate authority states

These states never imply one another:

1. **Artifact completion** — content exists and is bound to a candidate.
2. **Review completion** — assigned QA and an assigned Independent Reviewer have examined that
   exact candidate and emitted separate receipts.
3. **Governance acceptance** — an effectively assigned Decision Chair has emitted an
   `ACCEPTED`, `REVISE`, or `REJECTED` receipt.
4. **Execution release** — only after acceptance, an effectively assigned Coordinator/Architect
   has emitted a separate run-specific release receipt.

Current state is draft produced, review not started, not accepted, and not execution-released.

## Assignment-authority provenance policy

An assignment is invalid unless the assigning authority proves its own mandate through a complete,
independently verifiable chain. Each link must contain:

- stable mandate/delegation ID and governing policy version;
- grantor and grantee names, stable identities, organizations, and role;
- exact roles and work/release scopes that may be assigned;
- delegation permission and maximum delegation depth;
- effective-from and effective-through UTC values;
- suspension, expiry, revocation, and supersession state;
- conflict declaration and separation-of-duties result;
- canonical signed receipt and verification result; and
- parent mandate link, ending at an identified governing authority record.

The chain is invalid if missing, expired, suspended, revoked, out of scope, circular, or unable to
terminate at a governing authority record. Self-appointment, reciprocal appointment, appointment
by an incompatible implementation/evidence/publication actor, and delegation used to combine
incompatible roles are prohibited. Repository access, OS identity, authorship, agent label, lane
name, and technical signing capability are not provenance of assignment authority.

## Required assignment record

Blank fields mean no assignment and must remain empty when unknown.

### Identity and scope

- Assignment record ID: ``
- Experiment ID: `AU-UCR-EP-000001`
- Governed role: `Decision Chair`
- Assignee name: ``
- Assignee stable identity and identity system: ``
- Organization: ``
- Implementation/evidence/publication lane: ``
- Work-item scope: ``
- Candidate/repository scope: ``
- Permitted actions: ``
- Explicitly prohibited actions: ``
- Effective from, UTC: ``
- Effective through, UTC: ``
- Maximum decision count or usage scope: ``

### Assigning authority provenance

- Assignment authority name: ``
- Assignment authority stable identity: ``
- Root mandate ID: ``
- Delegation-chain IDs, ordered: ``
- Authority policy/version: ``
- Authority scope match result: `NOT_VERIFIED`
- Delegation-depth result: `NOT_VERIFIED`
- Provenance verifier stable identity and effective assignment: ``
- Provenance verification receipt: ``

### Conflict and separation declaration

The assignee, assignment authority, every delegator, and the checker must each explicitly declare:

- no implementation, evidence preparation, publication, QA, independent review, release, or
  decision role incompatible with this assignment;
- no self-appointment or reciprocal-appointment relationship;
- all organizational, financial, supervisory, technical, and personal conflicts;
- any shared reporting line, account, credential, key, or controlling entity; and
- whether recusal, replacement, or a recorded conflict disposition is required.

Compare stable identities transitively across the assignee, assignment authority, delegators,
checker, Publication Custodian, Coordinator/Architect, QA/Evidence Agent, Independent Reviewer,
Decision Chair, implementation roles, and Security/Governance Agent.

- Conflict declarations: ``
- Conflict disposition authority and basis: ``
- Separation checker: ``
- Separation receipt: ``
- Result: `NOT_PERFORMED`

Any missing declaration, unresolved conflict, identity overlap, or incompatible control
relationship blocks effectiveness.

### Explicit acknowledgement

The proposed assignee must acknowledge the exact assignment record, duties, limits, scope,
effective interval, conflicts, lifecycle, cryptographic profile, revocation behavior, and
run-specific authorization boundary.

- Acknowledgement receipt ID: ``
- Assignment-record digest acknowledged: ``
- Assignee stable identity: ``
- Acknowledged at, UTC: ``
- Verification result: `NOT_PERFORMED`

Silence, repository activity, draft authorship, and use of credentials are not acknowledgement.

## Cryptographic binding and replay controls

No algorithm is approved by this draft. A future record must identify an accepted versioned
cryptographic profile rather than use free text. The signed envelope must include:

- schema ID/version and authority-policy ID/version;
- repository identity and object type (`commit`, `tree`, `artifact`, or `manifest`);
- digest algorithm and digest for every bound object;
- assignment/decision/release receipt ID and globally unique event ID;
- signer stable identity, key ID, key purpose, issuer/trust-root chain, and key-validity evidence;
- issued-at, effective-from, effective-through, and verification-time UTC values;
- unpredictable verifier challenge/nonce;
- monotonic sequence or authority-scoped counter;
- previous-event digest or explicit genesis marker;
- canonical encoding and signature-input framing profile;
- scope, candidate ID, run ID where applicable, and previous/next state; and
- revocation/status evidence and verifier result.

Verifiers must reject duplicate event IDs, nonce reuse, non-increasing counters, broken event
chains, stale or future-dated envelopes outside policy tolerance, wrong key purpose, scope
mismatch, unknown schema/profile, revoked keys, and a receipt already consumed for a different
candidate or run. A durable append-only replay register must be consulted before a state change.

## Assignment lifecycle

Normative states:

`DRAFT -> ACKNOWLEDGED -> EFFECTIVE -> SUSPENDED | EXPIRED | REVOKED | SUPERSEDED`

`SUSPENDED -> EFFECTIVE` is allowed only through a new reinstatement receipt that resolves the
cause and remains within the original scope and expiry. `EXPIRED`, `REVOKED`, and `SUPERSEDED` are
terminal for new actions. Reinstatement does not retroactively validate actions.

For races, the authoritative event ordering is the verified authority-scoped counter plus event
chain, not wall-clock time alone. A decision is invalid if its signed event is ordered at or after
suspension, expiry, revocation, or supersession, or if the exact ordering cannot be proven.

Every lifecycle event records prior/next state, reason, scope, authority provenance, counter,
previous-event digest, affected open work, containment, re-review requirements, UTC time, and
signed receipt. History is append-only.

## Standing assignment versus run-specific authorization

A standing assignment establishes only role eligibility within its narrow scope. It does not
authorize a particular review, decision, test, implementation, construction, or execution run.

Each governed run requires a separate receipt containing:

- run ID, purpose, bounded actions, environment, release row, and time window;
- exact assignment and acknowledgement receipts for every actor;
- exact candidate, implementation, governance, policy, dependency-snapshot, and evidence digests;
- QA receipt, Independent Reviewer acknowledgement, findings-closure receipt, and Decision Chair
  receipt as applicable;
- feature-flag state, rollback target, abort conditions, and maximum permitted effects;
- run nonce/counter and replay-register check;
- previous/next run state; and
- authorized issuer identity, mandate chain, signature, and verification result.

A Decision Chair assignment cannot issue an execution run. After governance acceptance, G4 still
requires a separate Coordinator/Architect run-specific execution-release receipt.

## Gate requirements

- **G3 remains `CLOSED`.** It may be evaluated only after exact-candidate QA, independent review,
  valid acceptance, and findings/dependency closure are each evidenced by separate receipts.
- **G4 remains `NOT AUTHORIZED`.** Even after G3 acceptance and closure, only a separate,
  effectively assigned Coordinator/Architect may issue an exact-run execution release.

## Current disposition

- Assignment record: `EMPTY / NOT EXECUTED`
- Assignment-authority provenance: `NOT ESTABLISHED`
- Conflict and separation checks: `NOT PERFORMED`
- Explicit acknowledgement: `NONE`
- Cryptographic profile: `NOT APPROVED`
- Replay register evidence: `NONE`
- Run-specific authorization: `NONE`
- Decision Chair: `UNASSIGNED`
- Decision A: `REVISE`
- G3: `CLOSED`
- G4: `NOT AUTHORIZED`
