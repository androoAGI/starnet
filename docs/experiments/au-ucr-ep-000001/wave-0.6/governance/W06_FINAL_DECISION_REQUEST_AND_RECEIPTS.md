# Wave 0.6 Final Decision Request and Receipt Templates

## Decision authority and current state

- Sole final decision authority: `Hakeem Moore`
- Decision state: `PENDING_HUMAN_DECISION`
- Presumed outcome: `NONE`
- Hakeem Moore acknowledgement/signature: `NOT PROVIDED`
- Operational effect before a valid receipt: `NONE`

## Integrated dossier decision object

Hakeem Moore is asked to decide the exact integrated Wave 0.6 dossier, not merely the governance
documents. The integration coordinator must populate the following fields after every workstream
is complete and before presenting the dossier for decision:

- Integrated dossier record ID: ``
- Dossier root path/locator: ``
- Dossier manifest path: ``
- Repository identity: ``
- Branch/ref, if applicable: ``
- Exact candidate tree/commit or equivalent immutable identity: ``
- Per-file path, byte-domain, size, and digest inventory: ``
- Aggregate manifest digest, algorithm, and byte domain: ``
- Manifest generated at UTC: ``
- Integration coordinator governed identity and authority receipt: ``
- Completeness verification receipt ID/digest/result: ``

The manifest must include, by exact path and digest:

1. technical design specifications and interface/contract baselines;
2. verification and reproducibility evidence, including passed, failed, blocked, and not-run
   checks;
3. governance, authority, appointment, delegation, acceptance, and decision controls;
4. a complete evidence inventory identifying authenticated, unauthenticated, missing, superseded,
   and residual evidence;
5. Scrum/work-item closure showing every agent-owned item complete or evidence-backed blocked;
6. independent assurance reports, limitations, amendments, and unresolved findings;
7. residual-risk register with owner, severity, disposition, trigger, and containment;
8. bounded implementation and test plans, prerequisites, environments, actors, stop conditions,
   and evidence outputs;
9. acceptance criteria and traceability from each criterion to evidence;
10. rollback targets, compatibility evidence, procedures, suspension triggers, and reinstatement
    conditions; and
11. this final-decision request and every referenced governing receipt template.

A missing category, mutable reference, digest mismatch, or unresolved manifest membership makes
the dossier ineligible for `APPROVE`.

## Dossier acceptance criteria

`APPROVE` is eligible only when the bound evidence demonstrates all of the following:

1. every required dossier category is present, immutable, internally consistent, and traceable;
2. every agent-owned Wave 0.6 work item is complete, with no agent-owned task deferred to Hakeem
   Moore;
3. verification reports distinguish passed, failed, blocked, and not-run checks without treating
   absence as success;
4. assurance findings have evidence-backed dispositions and no unaccepted critical blocker
   remains;
5. the evidence inventory accounts for every relied-on claim and clearly marks unauthenticated,
   superseded, missing, or residual evidence;
6. residual risks have explicit severity, owner, treatment, trigger, containment, and the risks
   requiring human acceptance are presented in the decision receipt;
7. implementation and test plans are bounded, reproducible, non-production, actor-assigned, and
   linked to objective evidence outputs;
8. suspension triggers, abort boundaries, rollback target compatibility, containment actions,
   and reinstatement conditions are complete;
9. all actors required for the next phase have effective, acknowledged, conflict-checked
   appointments; and
10. the exact next-phase scope fields are complete and do not depend on implied authority.

If any criterion is false or unknown, the eligible outcomes are `REVISE` or `REJECT`, not
`APPROVE`.

## Precisely defined requested next phase

- Next-phase ID: `AU-UCR-EP-000001-W06-NEXT-01`
- Name: `BOUNDED_NONPRODUCTION_IMPLEMENTATION_AND_VERIFICATION`
- Governing baseline: the exact approved integrated dossier manifest/digest
- Purpose: implement only the approved technical designs in assigned repository lanes, execute
  only the approved non-production verification/test plans in approved isolated environments,
  and produce append-only evidence for the next governed review.
- Maximum effects: local, reversible candidate changes and designated non-production test effects
  within the exact repositories, paths, actors, environments, data classes, time windows, and
  resource limits listed in the approved implementation/test plans.
- Required outputs: implementation evidence; test logs and receipts; updated complete evidence
  inventory; residual-risk update; rollback/suspension exercise evidence where authorized; Scrum
  closure update; and next-review candidate manifest.
- Completion boundary: stop after evidence packaging for the next governed review.

`APPROVE` authorizes this next phase only when its exact scope fields below are populated and all
listed prerequisites are valid. `REVISE` and `REJECT` decline next-phase authorization.

### Next-phase scope fields required for APPROVE

- Approved design/work-item IDs: ``
- Approved repository and path/lane scope: ``
- Approved implementation actions: ``
- Approved test-plan IDs and test actions: ``
- Approved isolated environment identities: ``
- Approved actors and effective appointment receipt IDs/digests: ``
- Permitted data classification and fixtures: ``
- Time window and resource/effect limits: ``
- Required prerequisite receipt IDs/digests: ``
- Required evidence outputs and acceptance checks: ``
- Suspension/abort triggers: ``
- Exact rollback target and pre-authorized containment actions: ``

Blank next-phase scope fields mean `NOT AUTHORIZED`; they may not be inferred from the dossier.

The request expressly excludes:

- rewriting or retroactively correcting Waves 0.3–0.5;
- asserting machine-identity equivalence between correct `Hakeem Moore` and superseded erroneous
  input `Hakim Moore`;
- inventing any acknowledgement, signature, stable identity, appointment, or receipt;
- appointing QA, reviewer, publisher, coordinator, security/governance, or implementation actors
  unless separate appointment receipts are completed;
- commit, push, publication, merge, deployment, production access, production data, external
  side effects, or release;
- operational activity outside the exact approved non-production implementation/test scope;
- destructive migration, irreversible action, use of unapproved credentials/secrets, or scope
  expansion by implication;
- G4 or exact-run release where a separate release receipt is required; and
- suspension, revocation, rollback, or reinstatement beyond the pre-authorized containment
  actions and exact rollback scope in the valid receipt.

An approval of technical designs is not approval of unstated implementation or testing. Approval
of the bounded next phase is not publication, merge, deployment, production, or G4 authorization.
A path-only, category-only, or governance-only approval is invalid.

## Common required receipt fields

Every outcome receipt must contain:

- Receipt ID: ``
- Object kind: `W06_INTEGRATED_DOSSIER_FINAL_DECISION`
- Experiment ID: `AU-UCR-EP-000001`
- Decision authority governed name: `Hakeem Moore`
- Decision authority stable identity: ``
- Identity system/issuer and verification evidence: ``
- Root mandate ID/digest or principal basis: ``
- Exact integrated dossier record ID and manifest path: ``
- Exact reviewed per-file manifest, including each path and content digest: ``
- Aggregate manifest digest and digest algorithm/domain: ``
- Repository and immutable candidate identity: ``
- Dossier completeness verification receipt ID/digest: ``
- Acceptance-criteria evaluation receipt ID/digest: ``
- Assurance and residual-risk records reviewed: ``
- Next-phase ID: `AU-UCR-EP-000001-W06-NEXT-01`
- Next-phase disposition: `AUTHORIZED | DECLINED`
- Scope and exclusions acknowledged: ``
- Decision issued/effective at UTC: ``
- Event counter/previous-event digest/nonce/replay result: ``
- Signature method and key purpose, if used: ``
- Hakeem Moore signature/acknowledgement: ``
- Independent verification record/result, if used: ``

Exactly one outcome section below may be completed.

## APPROVE receipt template

- Outcome: `APPROVE`
- Approved integrated dossier record/manifest/digest: ``
- Acceptance criteria satisfied with evidence: ``
- Assurance findings and limitations accepted: ``
- Residual risks explicitly accepted: ``
- Approved next-phase scope fields: ``
- Next-phase disposition: `AUTHORIZED`
- Conditions: ``
- Explicit exclusions acknowledged: ``
- Required follow-on appointments or records: ``
- Previous state: `PENDING_HUMAN_DECISION`
- Next state: `DOSSIER_APPROVED_NEXT_PHASE_AUTHORIZED`
- Common required fields completed: `NO`

Effect when valid: the exact integrated dossier is approved and the precisely populated bounded
non-production next phase is authorized. The authorization has no effect outside the bound
manifest, work items, actors, lanes, environments, test plans, time window, limits, and rollback
controls. Every explicit exclusion remains prohibited.

## REVISE receipt template

- Outcome: `REVISE`
- Reviewed integrated dossier record/manifest/digest: ``
- Exact sections/files requiring revision: ``
- Required changes and acceptance criteria: ``
- Reason/evidence references: ``
- Unchanged material, if any, retained for the next candidate: ``
- Next-phase disposition: `DECLINED`
- Deadline or priority, if any: ``
- Previous state: `PENDING_HUMAN_DECISION`
- Next state: `REVISION_REQUIRED`
- Common required fields completed: `NO`

Effect when valid: agents must produce a new append-only/versioned candidate addressing the
specified changes, complete all agent-owned revision work, and return only the new exact
integrated dossier for human decision. The next phase is not authorized.

## REJECT receipt template

- Outcome: `REJECT`
- Rejected integrated dossier record/manifest/digest: ``
- Reason/evidence references: ``
- Terminal scope: `THIS_EXACT_CANDIDATE`
- Preservation/archive requirements: `PRESERVE_APPEND_ONLY`
- Conditions, if any, for a distinct future proposal: ``
- Next-phase disposition: `DECLINED`
- Previous state: `PENDING_HUMAN_DECISION`
- Next state: `REJECTED`
- Common required fields completed: `NO`

Effect when valid: this exact candidate is rejected and remains preserved. A later proposal must
be a new integrated dossier candidate with a new manifest and decision receipt. The next phase is
not authorized. `REJECT` is not revocation of an operational release because none is created by
this package.

## Receipt validity rule

A receipt is invalid if it:

- uses superseded erroneous `Hakim Moore` instead of the controlling exact identity
  `Hakeem Moore`;
- lacks the exact integrated dossier manifest/digest or any required dossier category;
- lacks Hakeem Moore's actual acknowledgement/signature;
- leaves the outcome ambiguous or combines outcomes;
- says `APPROVE` while leaving any required next-phase scope field blank;
- expands scope by implication; or
- is authored or completed by an agent on Hakeem Moore's behalf.

Current result: `NO VALID FINAL DECISION RECEIPT EXISTS`.
