# Wave 0.6 Role Appointment, Delegation, and Acceptance

## Prepared-state declaration

This specification and its templates are agent-complete. No agent appointment remains to be
drafted. No appointment is effective merely because a template exists, and no human acceptance
is asserted.

Hakeem Moore is the sole final decision authority. Appointed roles prepare, verify, review,
publish, or release only within an explicit scope; none may substitute for Hakeem Moore's final
`APPROVE`, `REVISE`, or `REJECT` disposition.

## Governed roles and boundaries

- `GOVERNANCE_PREPARER`: prepares records and resolves agent-owned drafting defects; cannot
  appoint, accept, decide, publish, or release.
- `QA_EVIDENCE_AGENT`: validates evidence independently of the work checked; cannot issue the
  final decision or operational release.
- `INDEPENDENT_REVIEWER`: reviews the exact candidate and QA record; cannot prepare the reviewed
  work, self-certify, decide, publish, or release.
- `PUBLICATION_CUSTODIAN`: performs separately authorized immutable publication; cannot decide or
  release.
- `COORDINATOR_ARCHITECT`: may verify dependencies and issue a separately authorized exact-run
  release; is not the final decision-maker and is not assigned by this package.
- `SECURITY_GOVERNANCE`: records specialist controls and may co-authorize a bounded rollback;
  cannot self-certify or issue the final decision.
- `FINAL_DECISION_AUTHORITY`: fixed to Hakeem Moore for this package; may issue only the final
  governance disposition and does not become coordinator of agent-owned work.

One actor may not hold incompatible preparer, QA, independent-review, publication, final-decision,
or release roles for the same candidate. A conflict causes `BLOCKED`, not implied waiver.

## Appointment and delegation receipt template

One receipt is required per person, role, and scope.

- Object kind: `ROLE_APPOINTMENT`
- Appointment ID: ``
- Experiment ID: `AU-UCR-EP-000001`
- Wave: `0.6`
- Role: ``
- Appointee governed name: ``
- Appointee stable identity: ``
- Identity system/issuer and proofing evidence: ``
- Organization/lane: ``
- Grantor governed name: `Hakeem Moore`
- Grantor stable identity: ``
- Root mandate ID/digest: ``
- Parent delegation IDs/digests: ``
- Delegation permission and maximum depth: `NO_SUBDELEGATION`
- Exact repository: `starnet-ucr-publish-2`
- Exact path/artifact scope: ``
- Exact candidate manifest/digest: ``
- Permitted duties/actions: ``
- Prohibited duties/actions: ``
- Permitted outcome vocabulary: ``
- Usage/decision limit: ``
- Effective from UTC: ``
- Effective through UTC: ``
- Suspension/revocation authority and triggers: ``
- Supersession/expiry behavior: ``
- Conflict declaration: ``
- Separation assessment ID/digest/result: ``
- Issued at UTC: ``
- Event counter/previous-event digest/nonce: ``
- Grantor signature/receipt: ``
- Verification result: `NOT_PERFORMED`
- Lifecycle state: `DRAFT`

An appointment becomes `OFFERED` only after Hakeem Moore issues a verifiable grantor receipt. It
does not become `ACTIVE` until the acceptance receipt below is valid and all separation checks
pass.

## Appointee acceptance receipt template

- Object kind: `ROLE_APPOINTMENT_ACCEPTANCE`
- Acceptance ID: ``
- Appointment ID/digest: ``
- Appointee governed name: ``
- Appointee stable identity: ``
- Accepted exact role, scope, duties, prohibitions, interval, and usage limit: ``
- Conflict disclosure: ``
- Separation assessment ID/digest acknowledged: ``
- Suspension, revocation, expiry, and containment behavior acknowledged: ``
- No-subdelegation or bounded-subdelegation rule acknowledged: ``
- Final-decision boundary acknowledged: ``
- Accepted at UTC: ``
- Signing key ID/purpose, if used: ``
- Appointee signature/receipt: ``
- Nonce/replay verification: ``
- Independent verification result: `NOT_PERFORMED`
- Acceptance outcome: `ACCEPTED | DECLINED`

No agent may populate an appointee's acknowledgement or signature. A blank acceptance keeps the
appointment inactive.

## Separation/conflict assessment template

- Object kind: `SEPARATION_CONFLICT_ASSESSMENT`
- Assessment ID: ``
- Appointment ID/digest: ``
- Exact candidate manifest/digest: ``
- Appointee roles compared: ``
- Accounts, credentials, keys, reporting lines, work authorship, and control paths compared: ``
- Direct and transitive conflicts found: ``
- Recusal/replacement controls: ``
- Independent checker governed name/stable identity: ``
- Checker authority ID/digest: ``
- Checked at UTC: ``
- Result: `PASS | FAIL | BLOCKED`
- Checker signature/receipt: ``
- Verification result: `NOT_PERFORMED`

Unknown identity, missing comparison evidence, or an unappointed checker yields `BLOCKED`.

## State machine

`DRAFT -> OFFERED -> ACTIVE -> SUSPENDED | EXPIRED | REVOKED | SUPERSEDED`

- `DECLINED` terminates the offer.
- `ACTIVE` requires a valid appointment, acceptance, and separation assessment.
- `SUSPENDED` permits no new action.
- `EXPIRED`, `REVOKED`, and `SUPERSEDED` are terminal for the appointment.
- Reinstatement requires a new versioned receipt; it does not rewrite the prior state.

## Current role state

- Hakeem Moore final-decision authority: `NAMED_NOT_MACHINE_BOUND`
- QA/Evidence Agent: `UNAPPOINTED`
- Independent Reviewer: `UNAPPOINTED`
- Publication Custodian: `UNAPPOINTED`
- Coordinator/Architect: `UNAPPOINTED`
- Security/Governance rollback co-authority: `UNAPPOINTED`
- Any role acceptance: `ABSENT`

These are human-governed dependencies, not unfinished agent drafting tasks.
