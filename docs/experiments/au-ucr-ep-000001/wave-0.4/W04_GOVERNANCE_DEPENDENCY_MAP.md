# Wave 0.4 Governance Dependency Map

## Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Artifact: `W04_GOVERNANCE_DEPENDENCY_MAP`
- Status: `DESIGN_DRAFT`
- Baseline HEAD: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Decision Chair: `UNASSIGNED`
- Decision A: `REVISE`
- Authorization effect: **NONE**

This map is a fail-closed design record. An edge means “depends on”; it does not establish that the
dependency is satisfied.

## Stable nodes

- `W04-N-C04`: revised authority package.
- `W04-N-SCRUM04`: corrected reconciliation.
- `W04-N-A04`: revised trusted-runtime-attestation design.
- `W04-N-B03`: revised executable-enforcement design.
- `W04-N-LAB03`: revised isolated-execution-environment design.
- `W04-N-D02`: new independent review of the exact Wave 0.4 candidate.
- `W04-N-QA`: independent QA of exact candidate and evidence.
- `W04-N-PUB`: immutable, commit-addressed publication and receipt.
- `W04-N-FINDINGS`: findings disposition and closure record.
- `W04-N-AUTH`: effective assignments, provenance, acknowledgements, and separation checks.
- `W04-N-G3`: governance gate.
- `W04-N-CHAIR`: Decision Chair decision receipt.
- `W04-N-DEPCLOSE`: dependency-closure receipt.
- `W04-N-G4`: execution gate.
- `W04-N-RELEASE`: Coordinator/Architect run-specific execution-release receipt.
- `W04-N-PROVENANCE`: evidence manifest/hash-domain and commit-identity provenance.
- `W04-N-BASELINE`: baseline failed/blocked-gate disposition.
- `W04-N-WORKIDS`: authoritative enumeration of `FOR-ACT-S0-001-W04-*`.
- `W04-N-BASE`: `FOR-ACT-S0-001-W04-BASE` repository/artifact inventory.

## Dependency edges

### Candidate preparation

- `W04-N-C04` depends on Wave 0.3 C-04, D-02 plus Amendment 1, GATE-03 plus Amendment 1,
  `AU-UCR-GOV-001`, evidence conventions, lane register, and readiness gate.
- `W04-N-SCRUM04` depends on the exact current paths and states of all Wave 0.3 inputs, this
  dependency map, the missing-authorization register, and `W04-N-WORKIDS`.
- `W04-N-A04`, `W04-N-B03`, and `W04-N-LAB03` each depend on closure of their non-withdrawn D-02
  findings and a shared authoritative cryptographic/trust/state vocabulary.
- `W04-N-C04` depends on `W04-N-AUTH` for effectiveness, but its draft may exist while authority is
  missing.

### Publication, QA, and review

- `W04-N-PUB` depends on a containing commit, immutable artifact manifest, exact digests, a valid
  Publication Custodian assignment, and a publication receipt.
- `W04-N-PROVENANCE` depends on an explicit hash domain, line-ending policy, exact repository
  identity, and resolution of the deterministic-readiness commit-identity discrepancy.
- `W04-N-QA` depends on `W04-N-PUB`, `W04-N-PROVENANCE`, `W04-N-BASELINE`, an effective independent
  QA assignment, exact candidate/evidence binding, and a QA receipt.
- `W04-N-D02` depends on `W04-N-PUB`, `W04-N-QA`, an effective Independent Reviewer assignment,
  conflict/separation checks, and a digest-specific acknowledgement.
- `W04-N-FINDINGS` depends on all QA and independent-review findings, dispositions, correction
  evidence, and confirmation that no material contradiction remains.

### G3 — governance acceptance and closure

- `W04-N-CHAIR` depends on `W04-N-AUTH`, `W04-N-PUB`, `W04-N-QA`, `W04-N-D02`, and
  `W04-N-FINDINGS`.
- `W04-N-DEPCLOSE` depends on accepted exact candidate links, all prerequisite receipts, resolved
  missing dependency IDs, and no duplicate/self/cyclic dependency defect.
- `W04-N-G3` depends on `W04-N-QA`, `W04-N-D02`, a valid `W04-N-CHAIR` acceptance receipt,
  `W04-N-FINDINGS`, and `W04-N-DEPCLOSE`.
- G3 remains `CLOSED`; QA, independent review, acceptance, and closure are all separately required.

### G4 — execution release

- `W04-N-RELEASE` depends on closed-and-satisfied G3, `W04-N-AUTH` for the Coordinator/Architect,
  exact implementation and governance commits, all prerequisite receipts, feature-flag and
  dependency state, rollback target, bounded run ID/scope, and replay controls.
- `W04-N-G4` depends on `W04-N-RELEASE`.
- G4 remains `NOT AUTHORIZED`. Acceptance never automatically supplies execution release.

## Work-ID coverage

The baseline commit contains no Wave 0.4 work IDs because Wave 0.4 files are current untracked
working-tree drafts. A current working-tree scan found one concrete identifier:

- `FOR-ACT-S0-001-W04-BASE`
  - path: `W04_BASE_VERIFIED_REPOSITORY_AND_ARTIFACT_INVENTORY.md`;
  - artifact completion: `BASELINE_VERIFIED_NOT_ACCEPTED`;
  - review completion: `NOT ESTABLISHED`;
  - acceptance: `NOT ACCEPTED`;
  - execution release: `NOT AUTHORIZED`;
  - dependency eligibility: `EVIDENCE INPUT ONLY`.

No authoritative tracker establishes that this is the complete namespace. Therefore:

- authoritative work-ID enumeration: `INCOMPLETE / MISSING`;
- wildcard namespace: `FOR-ACT-S0-001-W04-*`;
- every additional unenumerated member: `UNRESOLVED / NOT AUTOMATICALLY ACCEPTED`;
- downstream node blocked: `W04-N-WORKIDS`;
- required evidence: an authoritative tracker or assignment record listing every concrete stable
  ID, scope, dependencies, acceptance criteria, and current state.

Any later concrete ID must be appended and reconciled; it must not be inferred from an agent,
artifact, lane, or filename label.

## Dependency integrity diagnostics

### Missing dependencies

- Complete authoritative `FOR-ACT-S0-001-W04-*` enumeration beyond the observed `-BASE` record.
- Effective assignments and assignment-authority provenance for every governed role.
- Commit-addressed Wave 0.4 candidate and publication receipt.
- Exact-candidate QA receipt and formal Independent Reviewer acknowledgement.
- Finding-closure and dependency-closure receipts.
- Decision Chair decision receipt; the chair remains unassigned.
- Coordinator/Architect execution-release receipt.
- Explicit manifest hash-domain/line-ending policy and deterministic-readiness commit discrepancy
  disposition.
- Baseline failed/blocked-gate disposition.
- Accepted shared trust root, cryptographic profile, schemas, and cross-artifact state vocabulary.

### Duplicate dependencies

No duplicate exact edge is asserted in this map. Shared prerequisites such as assignments,
publication, and provenance appear under multiple consumers by design and are one stable node, not
multiple satisfactions. Any tracker that creates separate aliases for the same obligation must
normalize them to the node IDs above before closure.

### Self-dependencies

No self-edge is asserted. A record that signs, reviews, accepts, or releases itself is prohibited
even if its graph encoding does not show a literal self-edge.

### Cycles

No cycle is asserted in this proposed map. The current nine-receipt PRE_A09 graph was reported by
Amendment 1 as 14 edges with no cycle. The broader Wave 0.4 graph cannot be declared cycle-free
until the missing concrete work-ID graph is supplied and independently checked.

Prohibited authority cycles include self-appointment, reciprocal appointment, and a delegation
chain that returns to any prior identity or mandate. Any such cycle invalidates the affected
assignment and blocks G3 and G4.

## Current gate result

- Candidate artifact completion: `PARTIAL / DESIGN DRAFTS ONLY`
- Independent QA: `NOT STARTED`
- Independent review: `NOT STARTED`
- Governance acceptance: `NOT ACCEPTED`
- Dependency closure: `NOT ESTABLISHED`
- G3: `CLOSED`
- Coordinator/Architect release: `NONE`
- G4: `NOT AUTHORIZED`
