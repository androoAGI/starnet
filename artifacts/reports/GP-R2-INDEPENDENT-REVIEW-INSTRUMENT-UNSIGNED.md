# GP-R2 Independent Review Instrument

## Control state

- Status: `UNSIGNED_DRAFT`
- Formal review outcome: `PENDING`
- Acceptance effect: `NONE`
- Adoption effect: `NONE`
- Gate P effect: `NO_CHANGE — BLOCKED_BY_EVIDENCE`

This instrument must not be interpreted as a completed review until every required identity,
evidence, outcome, and signature field is completed and authenticated.

## Reviewer identity and mandate

- Reviewer governed name: `[REQUIRED]`
- Stable identity identifier: `[REQUIRED]`
- Identity issuer: `[REQUIRED]`
- Appointment or delegation record: `[REQUIRED]`
- Role: `INDEPENDENT_REVIEWER`
- Scope: `AU-UCR-EP-000001 / GP-R2`
- Conflict disclosure: `[REQUIRED]`
- Prior methodological participation: `[REQUIRED]`
- Independence determination: `[REQUIRED: ELIGIBLE / NOT_ELIGIBLE]`

## Exact candidate binding

- Original R2 proposal commit: `fee376a30deb86698ea4d22bc4ab32e72e2fe713`
- Corrected review-packet commit: `[REQUIRED FROM COMMITTED HANDOFF]`
- Corrected review-packet tree: `[REQUIRED FROM COMMITTED HANDOFF]`
- Candidate content commit: `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Candidate content tree: `dca22c304034f1662db99230a29d3ccc3ca38889`
- Historical manifest:
  `docs/experiments/au-ucr-ep-000001/wave-0.6/technical/W06_TECHNICAL_FREEZE_MANIFEST.json`
- Proposed manifest:
  `artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json`
- Expected proposed aggregate:
  `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`

## Review method

- Review protocol:
  `artifacts/plans/GP-R2-FORMAL-INDEPENDENT-REVIEW-PACKET.md`
- Review environment: `[REQUIRED]`
- Commands or verifier implementation: `[REQUIRED]`
- Raw transcript location and digest: `[REQUIRED]`
- Independent aggregate observed: `[REQUIRED]`
- Member checks completed: `[REQUIRED] / 54`
- Artifact blob checks completed: `[REQUIRED] / 4`
- Generator comparison: `[REQUIRED: PASS / FAIL / NOT_RUN]`
- Binary inventory and renormalization preview:
  `[REQUIRED: PASS / FAIL / NOT_RUN]`

## Findings

- Verified findings: `[REQUIRED]`
- Contradicted findings: `[REQUIRED]`
- Open objections: `[REQUIRED]`
- Limitations: `[REQUIRED]`
- Historical records preserved: `[REQUIRED: YES / NO]`
- Unreviewed scope: `[REQUIRED]`

## Reviewer outcome

- Outcome: `[REQUIRED: REVIEW_PASS / REVIEW_REVISE / REVIEW_BLOCKED]`
- Reason codes: `[REQUIRED]`
- Corrective actions: `[REQUIRED or NONE]`

Outcome meanings:

- `REVIEW_PASS` permits submission to an authorized adoption decision.
- `REVIEW_REVISE` returns the proposal for correctable changes.
- `REVIEW_BLOCKED` retains the current blocked state because required evidence or authority is
  unavailable.

No outcome in this instrument adopts manifest v1.1.0, supersedes v1.0.0, authorizes preservation,
or approves Gate P.

## Signature and authenticated time

- Signing-key identifier: `[REQUIRED]`
- Key purpose: `KP-INDEPENDENT-REVIEW-v1`
- Signature algorithm: `[REQUIRED]`
- Signature over canonical instrument bytes: `[REQUIRED]`
- Authenticated review time: `[REQUIRED]`
- Timestamp authority or verification evidence: `[REQUIRED]`
- Signature verification result: `[REQUIRED: VALID / INVALID / NOT_VERIFIED]`
- Signature verifier identity: `[REQUIRED]`

## Rollback and supersession

If this review is later invalidated, retain this instrument unchanged and issue a new signed
invalidation or supersession record naming:

- this instrument and digest;
- invalidating evidence;
- authorized actor;
- authenticated time;
- replacement review, if any;
- affected Gate P and Scrum items.

No historical review or evidence record may be deleted or overwritten.
