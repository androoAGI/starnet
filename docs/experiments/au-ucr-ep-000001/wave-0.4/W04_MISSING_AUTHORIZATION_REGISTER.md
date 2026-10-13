# Wave 0.4 Missing Authorization Register

## Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Artifact: `W04_MISSING_AUTHORIZATION_REGISTER`
- Status: `DESIGN_DRAFT`
- Baseline HEAD: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Decision Chair: `UNASSIGNED`
- Decision A: `REVISE`
- Authorization effect: **NONE**

Empty identity, metric, and date fields are intentional: the inspected evidence does not support
values. `unassigned_role_only`, agent labels, authorship, technical access, and repository identity
are not assignments.

## Register

### W04-MAR-001 — Assignment authority

- Role/action: establish assignments for governed roles
- Name: ``
- Stable identity: ``
- Provenance/root mandate: ``
- Scope and delegation limits: ``
- Effective from / through: ``
- Conflict declaration: ``
- Explicit acknowledgement: ``
- Signed receipt and replay controls: ``
- Current state: `MISSING`
- Blocks: every effective role assignment, G3, and G4

### W04-MAR-002 — Publication Custodian

- Name: ``
- Stable identity: ``
- Effective assignment: ``
- Exact candidate scope: ``
- Conflict/separation result: ``
- Acknowledgement: ``
- Publication receipt: ``
- Current state: `MISSING`
- Blocks: commit-addressed publication, QA, independent review, and G3

### W04-MAR-003 — QA/Evidence Agent

- Name: ``
- Stable identity: ``
- Effective assignment: ``
- Independence from implementation/evidence preparation: `NOT_VERIFIED`
- Conflict/separation result: ``
- Acknowledgement: ``
- Exact-candidate QA receipt: ``
- Current state: `MISSING`
- Blocks: G3

### W04-MAR-004 — Independent Reviewer

- Name: ``
- Stable identity: ``
- Effective assignment: ``
- Independence from all prohibited roles: `NOT_VERIFIED`
- Conflict/separation result: ``
- Acknowledgement: ``
- Exact-candidate review/acknowledgement receipt: ``
- Current state: `MISSING`
- Blocks: formal review completion and G3

The Wave 0.3 D-02 report is evidence of requested design assurance, not a formally effective
Independent Reviewer acknowledgement.

### W04-MAR-005 — Decision Chair

- Name: ``
- Stable identity: ``
- Effective assignment: ``
- Assignment-authority chain: ``
- Scope and expiry: ``
- Conflict/separation result: ``
- Explicit acknowledgement: ``
- Decision receipt: ``
- Current state: `UNASSIGNED`
- Decision A: `REVISE`
- Blocks: valid governance decision and G3

`Decision A: REVISE` is the required remediation disposition. It is not an effective chair
decision because no assigned chair or signed decision receipt exists.

### W04-MAR-006 — Coordinator/Architect

- Name: ``
- Stable identity: ``
- Effective assignment: ``
- Release-row scope: ``
- Conflict/separation result: ``
- Explicit acknowledgement: ``
- Run-specific execution-release receipt: ``
- Current state: `MISSING`
- Blocks: G4

This role may act only after acceptance and may not create the governance outcome.

### W04-MAR-007 — Security/Governance Agent

- Name: ``
- Stable identity: ``
- Effective assignment and scope: ``
- Conflict/separation result: ``
- Explicit acknowledgement: ``
- Current state: `MISSING`
- Blocks: any security/governance action that requires this role; does not substitute for QA,
  Independent Reviewer, Decision Chair, or Coordinator/Architect

### W04-MAR-008 — Relevant implementation roles

- Contract Agent name/stable identity/assignment: ``
- Runtime Agent name/stable identity/assignment: ``
- Campus/UI Agent name/stable identity/assignment: ``
- Other run-specific actor assignments: ``
- Conflict/separation results: ``
- Explicit acknowledgements: ``
- Current state: `MISSING`
- Blocks: implementation or execution; neither is authorized by Wave 0.4 documentation work

### W04-MAR-009 — Conflict and separation checker

- Name: ``
- Stable identity: ``
- Effective assignment and authority basis: ``
- Independence from assignee, assigner, delegators, and governed work: `NOT_VERIFIED`
- Conflict declaration: ``
- Check receipt: ``
- Current state: `MISSING`
- Blocks: assignment effectiveness

### W04-MAR-010 — Cryptographic/trust administration

- Approved cryptographic profile authority: ``
- Identity-proofing authority: ``
- Trust-root issuer/administrator: ``
- Key-custody actors and quorum: ``
- Revocation/status authority: ``
- Replay-register authority/operator: ``
- Effective assignments and acknowledgements: ``
- Current state: `MISSING`
- Blocks: verifiable assignment, decision, and run receipts

### W04-MAR-011 — Run-specific authorization

- Run ID: ``
- Run type and bounded scope: ``
- Environment and time window: ``
- Authorizing role and effective assignment: ``
- Candidate/implementation/governance digests: ``
- QA/review/acceptance/dependency receipts: ``
- Nonce/counter/replay check: ``
- Rollback target and abort conditions: ``
- Signed authorization receipt: ``
- Current state: `MISSING / NOT AUTHORIZED`
- Blocks: G4 and all execution

### W04-MAR-012 — Wave 0.4 work-ID authority

- Authoritative tracker: ``
- Concrete ID observed in current working-tree drafts: `FOR-ACT-S0-001-W04-BASE`
- Observed path: `W04_BASE_VERIFIED_REPOSITORY_AND_ARTIFACT_INVENTORY.md`
- Observed status: `BASELINE_VERIFIED_NOT_ACCEPTED`
- Review / acceptance / release: `NOT ESTABLISHED / NOT ACCEPTED / NOT AUTHORIZED`
- Evidence that this is the complete namespace: ``
- Enumeration authority: ``
- Scope/dependency/acceptance mapping: ``
- Current state: `INCOMPLETE / MISSING AUTHORITY`
- Blocks: proof that all Wave 0.4 work has been reconciled

No additional work IDs are created here because that would invent stable identifiers without an
authoritative source. The `-BASE` artifact is evidence input only and does not confer acceptance.

## Missing authorization effects

- Artifact drafting may be recorded as drafting only.
- Review labels cannot become formal governed acknowledgement.
- No draft, review, technical receipt, commit, or merge becomes acceptance.
- G3 requires independent QA, independent review, a valid Decision Chair acceptance receipt, and
  findings/dependency closure. G3 remains `CLOSED`.
- G4 requires a later, separate, run-specific Coordinator/Architect release after acceptance.
  G4 remains `NOT AUTHORIZED`.
- Suspension, expiry, revocation, conflict, provenance failure, scope mismatch, or replay failure
  preserves the blocked state and requires append-only evidence.

## Register disposition

- Missing authorization entries: `OPEN`
- Effective governed assignments found: `NONE`
- Effective acknowledgements found: `NONE`
- Governance acceptance found: `NONE`
- Execution release found: `NONE`
- Decision Chair: `UNASSIGNED`
- Decision A: `REVISE`
