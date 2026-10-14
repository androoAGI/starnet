# GP-R3 IMHOTEP Blocker-Recovery Playbook

Status: PROPOSED / NOT DISPATCHED / NO GOVERNANCE EFFECT  
Experiment: AU-UCR-EP-000001  
Cycle: GP3-CYCLE-001, proposed revision 2  
Created: 2026-10-14

## Outcome

IMHOTEP must produce one corrected, reviewable GP3-001 tranche that closes the four known technical exceptions, adds an evidence-backed organizational review, and stops for independent Codex review and a separate human decision.

This playbook does not authorize a commit, push, publication, manifest adoption or supersession, preservation action, governance-role appointment, L5 issuance, or Gate P approval.

## Current blocker

The first GP3-001 draft is not ready for approval because:

1. E01 — the scope record omits the approval-payload SHA-256.
2. E02 — the scope record omits the signature SHA-256.
3. E03 — the validation report says there are no exceptions despite those missing bindings.
4. E04 — the integrated response does not provide a reliable final `AGENT_TRANCHE_*` disposition for the reviewed bytes.

StarNet is also paused on a proposed dispatch to the existing Support Agent. That dispatch is not part of this recovery design and must not be treated as approved. The user separately requested replacement of the Support Agent and Strategist; retirement and recruitment remain unexecuted pending their own confirmed action.

## Crew design

### IMHOTEP — accountable integrator

IMHOTEP owns the work sequence, assigns non-overlapping scopes, prevents conflicting edits, integrates evidence, and issues the final tranche disposition. IMHOTEP may not approve its own work or supply the human decision.

### Evidence Integrity Auditor — proposed replacement specialist

This specialist verifies commits, trees, blobs, file hashes, line-ending normalization, manifest membership, aggregate framing, generator output, Git status, and fail-closed tests. It reports reproducible commands and every discrepancy. It does not edit governance conclusions or approve a decision.

### Governance & Approval Custodian — proposed replacement specialist

This specialist verifies authority boundaries, exception completeness, decision bindings, supersession and rollback language, separation of duties, and approval-receipt requirements. It does not act as the human approver, claim independence it does not possess, or fabricate identity, timestamp, signature, or receipt evidence.

### Dean-G1 — organizational policy consultation

IMHOTEP must inspect the documented Dean-G1 role before integration. The curated source defines Dean-G1 as a Governance & Policy Assistant and independent verifier that produces cited determinations and mitigations. Its explicit red line is final approval; policy ambiguity escalates to the human dean.

Dean-G1's contribution to this tranche is a policy determination, not approval. It must answer:

- Does the corrected scope preserve the distinction between technical readiness and Gate P authority?
- Are all governance-significant actions still human-only?
- Are the proposed supersession and append-only rollback terms unambiguous?
- Are any role, authority, independence, or evidence claims unsupported?
- Which decisions must be escalated to the human?

### Librarian / Dean Librarian — organizational knowledge consultation

IMHOTEP must inspect the documented Librarian function before integration. The source describes the Dean Librarian as responsible for University pipeline orchestration and catalog management; Librarian-level work includes advanced curation, cross-domain integration, efficacy reporting, and a complete evidence trail.

The Librarian contribution to this tranche is a provenance and organizational map. It must:

- inventory every governing artifact and identify its authoritative version;
- distinguish committed packet evidence, candidate evidence, historical evidence, proposed drafts, and untracked local files;
- map dependencies from directive through output, review, human decision, receipt, and authorized action;
- cite source paths and SHA-256 values;
- identify duplicate, stale, missing, or uncataloged organizational material;
- preserve historical records rather than silently replacing them; and
- recommend where the final evidence belongs in organizational memory after an authorized decision.

The Librarian may organize and recommend. It may not adopt, supersede, preserve, publish, or approve Gate P.

### Codex — independent computational review

After IMHOTEP finishes, Codex reviews the actual bytes and returns exactly `REVIEW_PASS`, `REVIEW_REVISE`, or `REVIEW_BLOCKED`. Codex packages the human decision record but is not the human approver.

### Human — decision and authenticated approval

The human decides `APPROVE`, `REVISE`, `REJECT`, or `DEFER`. Governance-significant approval remains `SIGNATURE_PENDING` until the exact canonical record is signed and independently verified.

## Source integrity for the Dean and Librarian review

IMHOTEP should use the Agents University library and its catalog rather than relying on memory or titles alone.

Curated, LF-normalized catalog bindings verified locally:

- `agent-registry/aml_university_agent_registry_schema_examples.md` — `3da42cc91003d6270fb04202b8a3ab359f4def9fb1605da7169313e0ba1cc3b6`
- `docs/AML_University_Verifier_Architecture.md` — `6f59d58de837c8b8eb948fafa24108da38af364034027b21f72c900ba6faa320`
- `triage-agent/agents_university_triage.py` — `dbc899ca8f77137b36bcea4424429c4640e51752687df02b7f827410e6d2cd34`
- `launchers/university.ps1` — `c89be25ad8a7c13e6a391a81a5cc1a9ea0eefc3d98c2ecb87122b74f947b9cf2`

The catalog specifies LF-normalized text hashing. Raw working-tree hashes for files with CRLF may differ while the normalized hashes remain valid.

The older source `D:\AML_University_Training_Hospital\agents\README.md` documents the combined Dean Librarian hierarchy but is not present in the curated catalog. Its current raw SHA-256 is `1443edb39be93201ed933e99b3f5b764144a21547b827d8adff07592377cfa9c`. IMHOTEP must label it supplemental and uncataloged rather than treating it as canonical without a separate curation decision.

If the trusted-project sandbox cannot read the library, IMHOTEP must report that limitation and request a bounded read-only source handoff. It must not invent the missing consultation.

## Required execution sequence

### Step 1 — freeze the starting state

Record the current repository HEAD, tree, branch, `git status --short`, and SHA-256 of every existing GP3-001 deliverable. Preserve `artifacts/plans/GP-GOVERNANCE-BACKLOG.md` and the historical v1.0.0 manifest untouched.

Do not approve the pending legacy Support Agent dispatch as a substitute for this sequence.

### Step 2 — run the Librarian provenance pass

Produce `artifacts/reports/GP-R3-ORGANIZATIONAL-READINESS-MEMO.md` with a section named `Librarian provenance review`. List authoritative artifacts, hashes, classification, dependency, and any source-access limitation. Clearly label the supplemental uncataloged Dean Librarian source.

### Step 3 — run the Dean policy pass

Add a section named `Dean-G1 policy determination` to the same memo. Cite the Dean-G1 source, list policy findings and mitigations, state all human-only decisions, and include the sentence `Dean-G1 provides no final approval and no Gate P authority.`

### Step 4 — repair the exact-candidate scope

Revise `artifacts/plans/GP-R3-L3-SCOPE-PROPOSED_UNSIGNED.md` so it binds all previously required packet and candidate identifiers plus:

- approval-payload SHA-256 `4580f85ac69eb076e11c93c992bfbb14e985d973cb6a0f2112771a2fd26d062f`;
- signature SHA-256 `404d49fc8cb5c0db33c22fadc57c8964e511a189ff67b547596c039de5e7eeb4`;
- review outcome `REVIEW_PASS`;
- every applicable exception and explicit non-effect; and
- the statement that the evidenced receipt approves the computational review result only, not Gate P.

The scope remains `PROPOSED_UNSIGNED` and `NO_GOVERNANCE_EFFECT` until a distinct authorized action says otherwise.

### Step 5 — repair validation and tracking

Revise `artifacts/reports/GP3-001-VALIDATION-REPORT.md` so each check names its method and observed result. Replace the false `Exceptions: None` statement with an accurate exception history and current residual-exception list.

Update only the applicable GP3-001 tracker and communication-register fields after their acceptance criteria are supported. Do not mark a row accepted, approved, operational, or closed merely because a file exists.

### Step 6 — run deterministic checks

At minimum:

- verify exact HEAD and tree;
- recompute SHA-256 for every changed deliverable;
- verify required identifiers occur exactly where expected;
- confirm the organizational memo cites both Dean and Librarian sources;
- confirm no final approval is attributed to an agent;
- run `git diff --check`;
- confirm the historical manifest is unchanged;
- confirm the backlog remains untouched; and
- list the complete working-tree status.

### Step 7 — return one integrated outcome

IMHOTEP must end with exactly one of:

- `AGENT_TRANCHE_READY_FOR_REVIEW`
- `AGENT_TRANCHE_REVISE`
- `AGENT_TRANCHE_BLOCKED`

The response must list files changed, SHA-256 values, checks run, all exceptions, unresolved human decisions, and explicit non-effects. A sub-agent result is not the integrated outcome.

### Step 8 — independent review and human decision

Codex reviews the received bytes. Only after `REVIEW_PASS` does this chat present a human decision request. A positive human response to a governance-significant request creates `SIGNATURE_PENDING`; it is not `APPROVAL_EVIDENCED` until the canonical record and receipt verify.

## Acceptance gates

The tranche is ready for Codex review only when all gates pass:

1. **G1 — Source integrity:** Dean and Librarian conclusions cite inspected sources and matching catalog hashes or disclose a source limitation.
2. **G2 — Binding completeness:** E01 and E02 are closed with the exact payload and signature hashes.
3. **G3 — Reporting truthfulness:** E03 is closed; the report distinguishes historical exceptions from current residual exceptions.
4. **G4 — Integrated disposition:** E04 is closed with exactly one valid `AGENT_TRANCHE_*` outcome.
5. **G5 — Organizational clarity:** the memo separates Dean policy verification, Librarian provenance management, IMHOTEP integration, Codex review, and human authority.
6. **G6 — Historical integrity:** the historical v1.0.0 manifest and excluded backlog are unchanged.
7. **G7 — No authority leakage:** no agent claims final approval, adoption, supersession, preservation authority, L5, or Gate P approval.

Any failed gate produces `AGENT_TRANCHE_REVISE` or `AGENT_TRANCHE_BLOCKED`, never a qualified pass hidden behind `Exceptions: None`.

## Directive for IMHOTEP

```text
DIRECTIVE
Cycle: GP3-CYCLE-001
Revision: 2
Goal: Produce a corrected, organizationally reviewed GP3-001 tranche ready for independent Codex review.

Follow artifacts/plans/GP-R3-IMHOTEP-BLOCKER-RECOVERY-PLAYBOOK.md exactly.

Before editing, inspect the documented Dean-G1 and Librarian/Dean Librarian functions through the Agents University library. Use the Dean for a cited governance-policy determination with no final-approval authority. Use the Librarian for a cited artifact inventory, provenance map, dependency map, and organizational-memory recommendation. If those sources are inaccessible, stop and report the limitation; do not invent consultation.

Close E01-E04, produce the organizational-readiness memo, repair the unsigned scope and validation report, update only evidence-supported tracker/register fields, and run the required deterministic checks.

Do not dispatch the legacy Support Agent for this recovery. Do not commit, push, publish, adopt or supersede a manifest, modify the historical v1.0.0 manifest, touch GP-GOVERNANCE-BACKLOG.md, fabricate an identity/signature/receipt, issue L5, close a human authority gap, or approve Gate P.

End with exactly AGENT_TRANCHE_READY_FOR_REVIEW, AGENT_TRANCHE_REVISE, or AGENT_TRANCHE_BLOCKED and include every exception.
```
