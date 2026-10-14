# GP-R3 Human–Agent Communication Rhythm

Status: PROPOSED / LOCAL / NOT ADOPTED  
Experiment: AU-UCR-EP-000001  
Governance context: GP-R3  
Created: 2026-10-14

## Purpose

This protocol establishes a repeatable conversation loop in which the human issues a directive, StarNet agents return bounded deliverables, Codex independently reviews the received bytes, and the human makes the resulting decision in this chat.

The protocol does not adopt a manifest, supersede historical evidence, authorize preservation, appoint a governance role, or approve Gate P. Those effects require a separately bound and evidenced human approval.

## Participants and boundaries

1. **Human Commander** — states the desired outcome, constraints, and final decision.
2. **IMHOTEP** — coordinates the StarNet crew and integrates their output. IMHOTEP does not supply human approval.
3. **SUPPORT AGENT** — inspects files, runs tools and tests, computes hashes, and reports reproducible evidence.
4. **STRATEGIST** — reviews dependencies, governance meaning, exceptions, and decision consequences.
5. **Codex Reviewer** — independently inspects the received deliverables, reports one review outcome, and packages any approval record. Codex does not act as the human approver.
6. **Human Signer** — supplies the authenticated decision when a governance-significant action requires cryptographic evidence.

Agents may recruit additional agents when the directive names their responsibility and IMHOTEP remains accountable for the integrated response. Agent conclusions are inputs to review, not approvals.

## One-cycle rhythm

Each tranche uses a stable cycle identifier such as `GP3-CYCLE-001`. Corrections remain in the same cycle and increment the revision.

1. **CYCLE_OPEN** — Codex records the cycle ID, revision, starting commit and tree, work-item IDs, and current governance boundary.
2. **DIRECTIVE_ISSUED** — the human directive is restated in bounded form, including deliverables, evidence requirements, prohibitions, and the decision that will eventually be requested.
3. **DISPATCHED** — IMHOTEP receives the directive and allocates work to named agents, including existing agents when relevant.
4. **AGENT_WORKING** — agents work only inside the declared scope. Progress messages are informative and do not count as deliverables.
5. **OUTPUT_RECEIVED** — IMHOTEP returns the complete tranche with file paths, hashes, validation results, and every known exception.
6. **CODEX_REVIEW** — Codex inspects actual bytes and returns exactly one of `REVIEW_PASS`, `REVIEW_REVISE`, or `REVIEW_BLOCKED`.
7. **HUMAN_DECISION_PENDING** — Codex presents the decision in plain English and identifies exactly what each choice would authorize.
8. **HUMAN_DECISION_RECORDED** — the human responds with `APPROVE`, `REVISE`, `REJECT`, or `DEFER`, together with any limits.
9. **APPROVAL_EVIDENCED** — when cryptographic evidence is required, the exact canonical decision record is signed and independently verified. Until then the status is `NOT_EVIDENCED` or `SIGNATURE_PENDING`.
10. **AUTHORIZED_ACTION_EXECUTED** — only the action explicitly authorized by the decision may be performed.
11. **CYCLE_CLOSED** — Codex records the final state, evidence, residual exceptions, and next eligible cycle.

No later tranche starts merely because an agent says it is complete. The current tranche must first receive a Codex review and a human decision.

## Directive format

Use this block in chat when assigning a tranche:

```text
DIRECTIVE
Cycle: <cycle-id>
Revision: <integer>
Goal: <one outcome>
Starting commit: <commit>
Starting tree: <tree>
Work items: <IDs>
Required deliverables: <paths or named outputs>
Required checks: <tests, hashes, comparisons>
Prohibited actions: <for example commit, push, merge, adopt, approve Gate P>
Decision requested after review: <specific human choice>
```

Codex records a SHA-256 hash of the final directive text when the directive itself must be bound into an approval record.

## Agent response format

The integrated agent response begins with a simple-English summary and then provides this evidence block:

```text
AGENT OUTPUT
Cycle: <cycle-id>
Revision: <integer>
Outcome: AGENT_TRANCHE_READY_FOR_REVIEW | AGENT_TRANCHE_REVISE | AGENT_TRANCHE_BLOCKED
What changed: <plain English>
Deliverables: <path plus SHA-256 for each>
Checks run: <command or method plus result>
Starting and ending Git state: <commit, tree, working-tree status>
Exceptions: <every discrepancy, or NONE with supporting checks>
Human decision needed: <specific decision, or NONE>
```

Raw JSON is supplied only when requested or when it is itself a governed deliverable. An agent must not report `Exceptions: NONE` if a required binding, hash, test, or terminal outcome is missing.

## Codex review format

Codex responds with exactly one headline outcome:

- `REVIEW_PASS` — the tranche is technically ready for the separately stated human decision. It does not grant that decision.
- `REVIEW_REVISE` — correctable discrepancies exist. Codex lists each exception and returns them to IMHOTEP under the same cycle with the revision incremented.
- `REVIEW_BLOCKED` — required evidence cannot presently be obtained or a safe review cannot be completed. Codex identifies the blocker without inventing a result.

Every review states:

```text
What changed
What checks passed
What is missing or exceptional
What decision is needed
What that decision would and would not authorize
```

## Human decision and approval classes

### Class A0 — review direction

Examples include asking for another inspection, requesting corrections, or selecting the next draft. The chat message is recorded as direction but conveys no implementation or governance authority.

### Class A1 — ordinary scoped local action

Examples include authorizing Codex to commit already reviewed local files or asking agents to revise a named draft. A clear human instruction in this chat may authorize the exact local action stated. Codex must restate the files, reviewed hashes, and action before execution and must report the resulting commit or outcome afterward.

An A1 decision does not imply publication, manifest adoption, supersession, preservation authorization, governance-role appointment, or Gate P approval.

### Class A2 — governance-significant approval

This class includes Gate P, manifest adoption or supersession, publication or preservation authorization, governance-role appointment, A09/G3/G4 authority, or any action whose evidence contract requires an authenticated signature.

The conversation and decision request occur in this chat, but chat text alone is not authenticated approval evidence. `APPROVE` advances the cycle to `SIGNATURE_PENDING`. The human then signs the exact canonical record with the established SSH approval key and completes the approved timestamp procedure. Codex verifies the signature, key identity and fingerprint, timestamp, record hash, bound commits and trees, aggregate, review outcome, exceptions, and authorized action before returning `APPROVAL_EVIDENCED`.

If any required binding is absent or unverifiable, Codex returns `NOT_EVIDENCED`. It never invents identity, signature, approval time, receipt ID, or verification success.

## Human decision prompt

After review, Codex uses this structure:

```text
HUMAN DECISION REQUEST
Cycle: <cycle-id and revision>
Review outcome: <REVIEW_PASS | REVIEW_REVISE | REVIEW_BLOCKED>
Reviewed deliverables and hashes: <complete list>
Exceptions: <complete list>
Requested decision: APPROVE | REVISE | REJECT | DEFER
If APPROVE, authorized action: <exact action>
Explicit non-effects: <actions not authorized>
Approval class: <A0 | A1 | A2>
Evidence required: <chat record, or canonical signed receipt>
```

For A2, the canonical approval payload must bind at least:

- authenticated human identity and public-key fingerprint;
- cycle ID and revision;
- directive hash;
- packet and candidate commits and trees, when applicable;
- reviewed deliverable hashes and aggregate, when applicable;
- review outcome and every exception;
- exact authorized action and explicit non-effects;
- approval timestamp;
- platform, session, or receipt identifier; and
- signature plus an independently checkable verification method.

## Repair loop

When Codex returns `REVIEW_REVISE`, it sends IMHOTEP the numbered exceptions and expected evidence. IMHOTEP coordinates the same crew, increments the cycle revision, and returns only after all requested repairs are addressed. The new output must identify both corrected and unresolved exceptions.

The earlier review remains historical evidence. It is not overwritten or described as passing after a later revision succeeds.

## Stop conditions

The cycle stops and awaits the human when:

- a required choice materially changes scope or governance meaning;
- an agent requests authority outside the directive;
- a review result is ready for decision;
- a signature, security-key touch, passphrase, or authenticated account action is needed;
- a proposed action would commit, push, merge, publish, adopt, supersede, preserve, or approve a gate without current authorization; or
- evidence is incomplete or contradictory.

## Current starting rule

GP3-001 remains in repair. Its received scope draft and validation report require correction before any human approval request. The missing approval-payload hash, missing signature hash, inaccurate `Exceptions: None` statement, and missing `AGENT_TRANCHE_*` terminal outcome must be resolved in the next revision.

Gate P remains blocked until a separate A2 decision record explicitly approving Gate P is signed and verified. Approval of the R2 computational review result is not Gate P approval.
