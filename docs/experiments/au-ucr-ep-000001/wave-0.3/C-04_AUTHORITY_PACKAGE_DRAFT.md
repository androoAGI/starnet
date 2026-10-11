# C-04 Authority Package — Design Draft

## Document control

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.3`
- Task: `C-04`
- Classification: `DESIGN_DRAFT`
- Authorization effect: **NONE**
- Signature state: **UNSIGNED**
- Decision Chair: **UNASSIGNED — NOT APPROVED**
- Investigation branch: `cursor/populate-authority-readiness-7886`
- Investigation revision: `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Prepared under: documentation, read-only investigation, and design authority only

This package is an unexecuted assignment template. It neither appoints a person nor activates,
delegates, certifies, accepts, releases, or suspends authority. A completed draft has no effect
until the governing assignment authority executes it and every prerequisite below is evidenced.
Repository access, commit authorship, OS identity, technical executor labels, and role aliases are
not assignment authority.

## Repository basis inspected

The design was reconciled against these existing records:

- `docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml`
  - State: `proposed_not_accepted`.
  - Every listed lane owner is `unassigned_role_only`.
- `docs/experiments/au-ucr-ep-000001/S0_QA_READINESS_GATE.json`
  - Outcome: `blocked`; acceptance: `false`; review outcome: `not_recorded`.
  - Tested commit: `cdc793ba738c688ef2493fcd196043bfb3fddd77`.
- `docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`
  - Requires named assignments, stable identity, UTC effectiveness, duties and limits,
    independence/conflict declaration, acknowledgement, separation of duties, and distinct
    receipts for publication, governance decision, and execution release.
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-AUTHORITY-NAMES-00.json`
  - Result: `BLOCKED_BY_MISSING_NAMED_ASSIGNMENTS`.
  - Decision Chair assignment and decision receipt: absent.
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json`
  - Result: `PASS_WITH_A09_TRANSITION_CLOSED`; no decision and no transition.
- `qa/evidence/au-ucr-ep-000001-s0/receipts/readiness-check.json`
  - Verdict: `PACKAGE_CONSISTENT_S1_CLOSED`; expressly not acceptance or execution release.
- `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-STAR-00.json` through
  `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/EV-STAR-05.json`, with
  `qa/evidence/au-ucr-ep-000001-s0/star-wr-0001/MANIFEST.sha256`.
  - These are technical evidence receipts, not assignment or acceptance receipts.

No local file identifiable as a `STAR-WR-0001` tracker was found. The receipt directory above is
evidence for that work request but is not reclassified as its tracker.

## Assignment template

All fields marked **REQUIRED** must be completed without aliases, shared accounts, generic role
labels, or inferred identities. Blank fields mean no assignment.

### 1. Assignment identity and time

- Assignment record ID (**REQUIRED, stable**): `[UNFILLED]`
- Experiment ID (**REQUIRED**): `AU-UCR-EP-000001`
- Work item/release scope (**REQUIRED**): `[UNFILLED]`
- Governed role (**REQUIRED**): `Decision Chair`
- Assignee legal/display name (**REQUIRED**): `[UNFILLED]`
- Assignee stable identity and identity system (**REQUIRED**): `[UNFILLED]`
- Organization (**REQUIRED**): `[UNFILLED]`
- Implementation lane, if any (**REQUIRED; use NONE only when verified**): `[UNFILLED]`
- Assignment authority name (**REQUIRED**): `[UNFILLED]`
- Assignment authority stable identity (**REQUIRED**): `[UNFILLED]`
- Assignment authority basis/record (**REQUIRED**): `[UNFILLED]`
- Assignment recorded at, UTC (**REQUIRED, RFC 3339**): `[UNFILLED]`
- Effective from, UTC (**REQUIRED, RFC 3339**): `[UNFILLED]`
- Effective through, UTC (**REQUIRED or explicitly OPEN**): `[UNFILLED]`

### 2. Duties, limits, and decision authority

**Duties**

- Review the exact published candidate, publication receipt, QA receipt, Independent Reviewer
  acknowledgement, and resolved/unresolved findings.
- Decide only after all required evidence and effective role assignments are verified.
- Produce an append-only, commit-specific decision receipt for any governed outcome.

**Permitted decision authority**

- The Decision Chair alone may record one governance outcome:
  `ACCEPTED`, `REVISE`, or `REJECTED`.

**Limits**

- May not publish artifacts, implement work, prepare or QA-certify evidence, independently review
  the same candidate, issue an execution release, or treat acceptance as execution release.
- May not decide outside the scope and effective interval stated in this assignment.
- May not waive missing evidence, dependencies, independence, conflicts, or receipt requirements.
- `ACCEPTED` is necessary but not sufficient for execution.

### 3. Conflict and independence declaration

The proposed assignee must declare each item:

- `[ ]` I did not implement the reviewed work.
- `[ ]` I did not prepare or publish the reviewed evidence/package.
- `[ ]` I did not QA-certify or independently review the reviewed candidate.
- `[ ]` I am not the Coordinator/Architect, Publication Custodian, relevant implementation role,
  Security/Governance Agent, QA/Evidence Agent, or Independent Reviewer for this candidate.
- `[ ]` I have disclosed all organizational, financial, supervisory, technical, and personal
  conflicts: `[UNFILLED]`.
- `[ ]` No undisclosed conflict impairs independent judgment.

Conflict disposition and deciding authority: `[UNFILLED]`

### 4. Separation-of-duties checks

Record stable identities, not names alone.

- Decision Chair vs Publication Custodian: `[UNVERIFIED]`
- Decision Chair vs Coordinator/Architect: `[UNVERIFIED]`
- Decision Chair vs QA/Evidence Agent: `[UNVERIFIED]`
- Decision Chair vs Independent Reviewer: `[UNVERIFIED]`
- Decision Chair vs relevant implementation role(s): `[UNVERIFIED]`
- Decision Chair vs Security/Governance Agent: `[UNVERIFIED]`
- Independent Reviewer vs all prohibited roles: `[UNVERIFIED]`
- QA/Evidence Agent independence from implementation/evidence preparation: `[UNVERIFIED]`
- Checker name, stable identity, and effective assignment reference: `[UNFILLED]`
- Check completed at, UTC: `[UNFILLED]`
- Check result: `NOT PERFORMED`

Any `UNVERIFIED`, overlap, missing effective assignment, or unresolved conflict blocks appointment
effectiveness and all decision authority.

### 5. Exact reviewed commit and evidence linkage

The following values identify the investigation baseline only; they do **not** preselect or approve
a decision candidate:

- Investigation revision:
  `c0579a4e4d272162963de09bdec7494d822c1fe2`
- Canonical S0 commit named by governance/readiness records:
  `cdc793ba738c688ef2493fcd196043bfb3fddd77`
- Governance content commit named by the addendum:
  `3f2dd71db76ddc89ff2dabad391665f4a381698c`

Before review, bind the assignment and later decision to:

- Exact reviewed candidate commit SHA (**REQUIRED**): `[UNFILLED]`
- Exact reviewed tree/content digest (**REQUIRED**): `[UNFILLED]`
- Publication receipt ID, path, and digest (**REQUIRED**): `[UNFILLED]`
- QA receipt ID, path, tested commit, and digest (**REQUIRED**): `[UNFILLED]`
- Independent Reviewer acknowledgement ID, path, commit, and digest (**REQUIRED**): `[UNFILLED]`
- Assignment records for all participating roles (**REQUIRED**): `[UNFILLED]`
- Findings register and resolution evidence (**REQUIRED**): `[UNFILLED]`
- Evidence manifest path and digest (**REQUIRED**): `[UNFILLED]`
- Dependency and gate snapshot (**REQUIRED**): `[UNFILLED]`

Existing pre-A09 and STAR-WR-0001 receipts may be referenced as historical inputs only after their
commit scope and manifest integrity are checked. They do not fill the missing assignment,
acknowledgement, QA acceptance, publication, or Decision Chair receipt fields.

### 6. Assignee acknowledgement

> I acknowledge the scope, duties, limits, conflicts, separation-of-duties constraints,
> effective interval, revocation rules, exact evidence linkage, and receipt obligations above. I
> understand that this assignment does not authorize implementation, publication, independent
> review, QA certification, or execution release.

- Assignee name: `[UNFILLED]`
- Assignee stable identity: `[UNFILLED]`
- Acknowledged at, UTC: `[UNFILLED]`
- Signature/verification mechanism: `[UNFILLED]`
- Acknowledgement receipt ID/path/digest: `[UNFILLED]`

### 7. Assignment authorization

- Assignment authority decision: `NOT EXECUTED`
- Effective assignment approved: `NO`
- Assignment authority name/stable identity: `[UNFILLED]`
- Authorization time, UTC: `[UNFILLED]`
- Signature/verification mechanism: `[UNFILLED]`
- Executed assignment receipt ID/path/digest: `[UNFILLED]`

Until this section is validly executed, the Decision Chair remains **UNASSIGNED** and
**NOT APPROVED**.

## Revocation and suspension

Authority must be suspended immediately upon an unresolved conflict, separation-of-duties breach,
scope mismatch, expired or revoked identity/assignment, evidence-integrity failure, material
contradiction, or inability to verify the exact reviewed commit.

Every suspension or revocation must be append-only and record:

- event ID and previous assignment ID;
- action (`SUSPENDED`, `REINSTATED`, or `REVOKED`);
- reason and affected scope;
- issuing authority name, stable identity, and authority basis;
- effective UTC time;
- prior and next state;
- affected open reviews/decisions and containment action;
- replacement/re-review requirement; and
- receipt path and digest.

Suspension blocks new decisions. Revocation does not erase prior receipts; affected decisions must
be assessed separately for validity and re-review.

## Decision-receipt requirements

A Decision Chair outcome is invalid unless its append-only receipt contains:

1. experiment, work item, candidate, and decision receipt IDs;
2. exact reviewed commit SHA and content digest;
3. publication receipt reference and digest;
4. QA receipt reference, tested commit, outcome, and digest;
5. Independent Reviewer acknowledgement reference and digest;
6. resolved and unresolved findings, conflicts, and material contradictions;
7. outcome exactly `ACCEPTED`, `REVISE`, or `REJECTED`;
8. rationale and scope;
9. chair name, stable identity, effective assignment record, and acknowledgement reference;
10. separation-of-duties check reference;
11. previous and next governance states;
12. decision timestamp in UTC and signature/verification data; and
13. explicit statement that the receipt is not publication or execution release.

`REVISE` requires a new revision and review cycle. `REJECTED` terminates that candidate unless a
new candidate is published. `ACCEPTED` only permits later dependency-eligibility assessment; a
separate Coordinator/Architect execution-release receipt remains mandatory.

## Current disposition

- Package preparation: `DESIGN_DRAFT`
- Assignment execution: `NOT STARTED`
- Separation-of-duties review: `NOT PERFORMED`
- Assignee acknowledgement: `NONE`
- Assignment receipt: `NONE`
- Decision receipt: `NONE`
- Decision Chair: **UNASSIGNED**
- Governance approval: **NOT APPROVED**
- Execution authority: **NOT GRANTED**
