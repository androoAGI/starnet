# Wave 0.5 Review Preparation Matrix

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-REVIEW`
- **Experiment:** `AU-UCR-EP-000001`
- **Wave:** `0.5`
- **Role label:** `Agent F — review preparer`
- **Repository:** `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- **Baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Prepared:** 2026-10-12
- **Preparation sources:** Wave 0.4 D-03, D-03 Amendment 1, GATE-04, W05 authorization input, W05 baseline inventory, and W05 nine-objection closure matrix
- **Status:** **REVIEW PREPARATION COMPLETE — FINAL REVIEW BLOCKED BY DEPENDENCY**
- **Acceptance effect:** **NONE**
- **Authorization effect:** **NONE**

This artifact prepares the Wave 0.5 review method. It does not review or accept an Agent A-E
submission, validate a schema, execute a fixture or vector, close an objection, certify QA, create
publication identity, appoint a reviewer, authorize a gate transition, or permit implementation,
construction, testing, commit, push, publication, merge, or operation.

Agent A-E outputs were being produced concurrently and were not a fixed candidate during this
preparation. Final review is **BLOCKED BY DEPENDENCY** until all required A-E submissions are
present and fixed by exact path, byte count, SHA-256, repository identity, and one immutable
candidate identity. An absent, mutable, or path-only submission is not review evidence.

## 2. Governing predecessor disposition

D-03 Amendment 1 controls the post-correction Wave 0.4 disposition: 32 objections were addressed
in design, nine remained, and four were amendment-corrected. GATE-04 proposed Option A —
`REVISE`; G3 remained `CLOSED — BLOCKED BY DEPENDENCY`; G4 remained `NOT AUTHORIZED`.

Wave 0.5 authorization input records only `"Human approved."` without stable approving identity,
authority source, effective time, exact activities, publication permission, schema-validation
permission, expiry, or revocation terms. It permits preparation of proposed documentation within
the stated effective boundary but does not close authority provenance, authorize validation, or
authorize publication.

## 3. Permitted review classifications

Each objection and each consolidated review must use exactly one classification:

1. **`RESOLVED WITH EVIDENCE`** — the exact fixed candidate supplies complete normative design,
   and authorized, candidate-bound evidence has been independently reproduced with the expected
   positive and negative results. Artifact existence, author assertions, or a proposed test is
   insufficient.
2. **`DESIGN ADDRESSED — VERIFICATION PENDING`** — the exact fixed candidate supplies an
   internally consistent, testable normative answer, but validation, reproduction, adoption,
   publication, authority, QA, or other required evidence is absent or was not authorized.
3. **`OPEN`** — the design is missing, incomplete, contradictory, ambiguous, or fails a mandatory
   criterion. A dependency label must not conceal a defect in supplied material.
4. **`BLOCKED BY DEPENDENCY`** — the supplied design may be reviewable, but a specifically named
   prerequisite outside it is absent or ineffective, preventing the claimed closure.

Absence is never a pass. `RESOLVED WITH EVIDENCE` is prohibited when any required check is not
run, partially run, non-reproducible, bound to different bytes, or performed without authority.
`DESIGN ADDRESSED — VERIFICATION PENDING` is not acceptance. No classification changes G3 or G4.

## 4. Reviewer record and independence requirements

Every final-review record must state:

- reviewer stable identity and reviewer label;
- exact assignment and acknowledgement evidence;
- assignment authority and its mandate/delegation chain;
- effective interval, repository, branch, candidate, objection and activity scope;
- evidence accessed, checks performed, tool/version, working directory, UTC time, result and
  output identity;
- participation in authorship, editing, schema/fixture/vector generation, QA, publication,
  findings closure, governance, or decision activity;
- direct and transitive conflict/separation result;
- evidence limitations, blocked checks and excluded scope;
- exact candidate path, bytes, digest, containing object and publication receipt;
- classification and rationale for each objection, without self-closing findings.

`Agent F` is a preparer label, not a governed Independent Reviewer appointment. Agent F authored
this review method and therefore has a methodological-participation and anchoring limitation.
Repository access, task assignment, or this document does not establish stable identity,
independence, authority, acknowledgement, or formal review scope. An effectively assigned
authority must determine whether this preparation activity is compatible with final-review
independence; otherwise a different reviewer must perform the final review. The final reviewer
must not classify their own authorship, evidence production, corrections, or findings closure as
independent evidence.

## 5. Agent A-E submission fixation gate

For each Agent A-E submission, final review requires a submission record containing:

1. agent label and governed author/preparer identity, if established;
2. task/workstream ID and exact scope;
3. exact repository-relative path and stable artifact ID;
4. byte count and SHA-256 with the byte domain stated;
5. schema, fixture, vector, registry and contract dependency paths and digests;
6. baseline, containing commit/tree/blob identities, or an explicit unpublished-state blocker;
7. creation/revision time, supersession relation and change history;
8. claimed objection mapping and claimed classification;
9. validation/reproduction status stated as run, not run, partial or blocked;
10. known limitations, unresolved findings, authority limits and rollback impact.

All five submission records must resolve to one non-conflicting candidate manifest. Duplicate
stable IDs, digest drift, unstated replacements, unresolved cross-links, missing outputs, or
working-tree mutation after fixation reopens the affected review and blocks the consolidated
classification. At preparation time no complete fixed Agent A-E candidate set was available;
therefore every substantive check in Section 7 is **NOT RUN — CANDIDATE NOT FIXED**.

## 6. Nine-objection review matrix

### `W05-OBJ-01` — A-04 schemas and conformance

Required design criteria:

- machine-valid, versioned ARM and attestation/evidence schemas identify dialect, `$id`, version,
  media type, canonical encoding and extension policy;
- required/optional fields, null versus omitted semantics, bounds, formats, numeric ranges,
  duplicate-key handling, unknown critical fields and cross-field/evidence-type conditionals are
  normative;
- producer evidence, verifier verdict and session state are distinct and linked without allowing
  producer-supplied verdict text to establish trust;
- malformed, unknown-version, stale, replayed, oversized, ambiguous or unverifiable input fails
  closed and cannot produce `TRUSTED_ACTIVE`.

Required evidence: fixed schema bundle; positive and negative fixtures; fixture-to-rule trace;
pinned-validator disposition; complete outputs; independent conformance record bound to exact
schema and fixture digests.

Classification threshold: complete design without authorized validator evidence may be
`DESIGN ADDRESSED — VERIFICATION PENDING`; `RESOLVED WITH EVIDENCE` requires independent positive
acceptance and negative rejection reproduction. Any schema ambiguity or fail-open branch is
`OPEN`; unavailable validator authority or independent conformance is `BLOCKED BY DEPENDENCY`
only after design completeness is established.

### `W05-OBJ-02` — B-03 schemas, vectors and conformance

Required design criteria:

- versioned transition, authority, audit/event, outbox, suspension, rollback, anchor and recovery
  schemas define all identifiers, state/status invariants and conditional requirements;
- ledger framing fixes the 16-byte ASCII domain `AU-GPEP-EVENT-v1`, length encodings, integer
  endianness, JCS UTF-8 record bytes, raw 32-byte predecessor, genesis value, hash algorithm and
  output representation;
- canonical genesis and immediate-successor vectors include semantic input, canonical bytes,
  complete framed preimage, intermediate predecessor and expected hash;
- malformed framing, sequence gaps, forks, wrong predecessor, mutation, truncation, duplicate
  sequence, unknown state, unauthorized transition and replay fail closed.

Required evidence: fixed schemas and fixtures; vector manifest; at least two implementation-
independent generators or one generator plus an independent byte-level recomputation; exact
outputs and mismatch disposition; conformance trace.

Classification threshold: normative schemas and complete vectors without reproduction may be
`DESIGN ADDRESSED — VERIFICATION PENDING`; reproducible exact-byte agreement plus required
negative rejection evidence is required for `RESOLVED WITH EVIDENCE`.

### `W05-OBJ-03` — SCRUM04 and candidate publication identity

Required design criteria:

- one manifest enumerates the exact reviewed candidate, including SCRUM04, all Wave 0.4
  predecessors, Wave 0.5 submissions, schemas, fixtures, vectors, registries and review inputs;
- each entry states repository, path, stable ID, bytes, digest algorithm/domain, blob/tree/commit,
  schema/profile version and supersession status;
- publication is distinguished from working-tree presence, Git containment, review, QA,
  acceptance and release;
- any absent publication authority is explicit and no proposed receipt is represented as issued.

Required evidence: immutable containing identity, manifest digest, publication receipt with
authorized issuer and independently resolvable repository/object binding, or an explicit
publication blocker.

Classification threshold: a complete publication design while bytes remain unpublished is
`BLOCKED BY DEPENDENCY`, not resolved. `RESOLVED WITH EVIDENCE` requires the exact authorized
publication receipt and independent identity resolution.

### `W05-OBJ-04` — LAB-03 publication identity

Required design criteria:

- LAB-03 and every referenced observation, evidence profile, fixture rule, platform decision and
  acceptance criterion are separately enumerated and digest-bound;
- historical D-02 state at `c0579a4e...`, current baseline `39bade050...`, and current LAB
  candidate identity remain distinct;
- no directory, local path, design artifact or historical observation is described as a
  constructed or verified sandbox;
- LAB publication does not imply platform selection, construction, preflight, testing, reuse,
  risk acceptance or execution authority.

Required evidence: exact LAB object/commit/publication binding and authorized receipt, or an
explicit no-publication blocker. No construction or negative test is required or authorized by
this review.

Classification threshold follows `W05-OBJ-03`; path existence and a working-tree digest cannot
produce `RESOLVED WITH EVIDENCE`.

### `W05-OBJ-05` — Complete package immutability

Required design criteria:

- publication procedure defines freeze authority, candidate cut, manifest creation, hash domain,
  line-ending/canonicalization policy, atomicity, amendment/supersession, revocation and recovery;
- the procedure detects post-freeze mutation, omitted or extra artifacts, aliasing, duplicate
  stable IDs, split manifests and inconsistent repository/object identities;
- failed or partial publication leaves the prior candidate authoritative, marks the new candidate
  invalid/quarantined and requires a new review cycle;
- commit, push and publication steps remain conditional on separate explicit authority.

Required evidence: clean resolution of every manifest entry to immutable objects, authorized
publication receipt, and an independently repeated candidate enumeration.

Classification threshold: procedure-only remediation is
`DESIGN ADDRESSED — VERIFICATION PENDING`; current untracked or mutable bytes keep actual
immutability closure `BLOCKED BY DEPENDENCY`.

### `W05-OBJ-06` — Governed assignments and acknowledgements

Required design criteria:

- each assignment identifies stable human identity, role, assignment authority, terminating
  mandate/delegation chain, scope, candidate, effective time, expiry and acknowledgement;
- lifecycle covers draft, acknowledgement, effective state, suspension, expiry, revocation,
  supersession and in-flight decision races;
- direct and transitive separation checks cover assigners, delegators, preparers, implementers,
  evidence producers, QA, reviewers, publication custodians, Decision Chair and
  Coordinator/Architect;
- unknown identity, stale authority, missing acknowledgement, conflicting assignments, invalid
  time, unavailable revocation or prohibited overlap fails closed.

Required evidence: signed, schema-conformant assignment and acknowledgement receipts; mandate
chain; conflict matrix; trusted-time and revocation evidence; exact candidate/run binding where
required.

Classification threshold: a complete authority design does not resolve absent appointments.
Without stable effective governed evidence this objection is `BLOCKED BY DEPENDENCY`. The general
`"Human approved."` statement cannot satisfy any required authority field.

### `W05-OBJ-07` — Shared trust, identity, cryptography and dependencies

Required design criteria:

- one versioned registry defines trust roots, key purposes, algorithms, curves/parameters,
  canonical encoding, identity namespaces, issuer/audience rules, trusted time, evidence stores,
  revocation, rollover, compromise recovery and decommissioning;
- one dependency registry maps A-04, B-03, C-04 and LAB contracts by stable interface/version,
  provider/consumer, required state, evidence, failure behavior and rollback dependency;
- incompatible versions, unknown critical extensions, wrong key purpose, stale revocation,
  untrusted time, unresolved dependency or registry unavailability fail closed;
- adoption authority, effective version, supersession and rollback are explicit.

Required evidence: exact registry/contract bytes, cross-artifact interface trace, compatibility
analysis, authorized adoption receipt and negative evidence for incompatible or unavailable
dependencies.

Classification threshold: coherent proposals without authorized adoption are
`BLOCKED BY DEPENDENCY`; internal inconsistencies are `OPEN`.

### `W05-OBJ-08` — Shared state vocabulary and precedence

Required design criteria:

- a versioned contract maps attestation, verifier, session, enforcement, assignment, LAB,
  suspension, rollback and gate states without collapsing distinct meanings;
- every cross-system transition states event, guard, source evidence, authority, next state,
  emitted reason code and rollback/suspension effect;
- precedence is deterministic for revocation, suspension, expiry, trust loss, evidence loss,
  candidate supersession, dependency failure, concurrent events and restart;
- unknown or contradictory state, stale evidence, partial transition or unavailable dependency
  selects the safer state, keeps treatment/execution OFF and emits an auditable reason.

Required evidence: interface/state matrix, transition fixtures, reason-code mapping, conflict and
race cases, authorized adoption receipt, and independent reconciliation against all consumers.

Classification threshold: a complete but unadopted contract is `BLOCKED BY DEPENDENCY`; omitted
precedence or fail-open behavior is `OPEN`.

### `W05-OBJ-09` — Complete verification and published candidate

Required design criteria:

- a closure manifest enumerates every normative schema, reason/status code, fixture, vector,
  shared contract, authority record, verification output, limitation and candidate identity;
- every requirement maps to at least one positive case and every safety/failure rule maps to at
  least one negative case with expected code and state;
- aggregation rules distinguish pass, expected rejection, unexpected acceptance, mismatch, not
  run, partial, blocked and tool error; only complete reproducible evidence may support resolved;
- any changed schema, fixture, vector, contract, registry or candidate digest invalidates stale
  outputs and triggers a new review cycle;
- publication, QA, independent review, findings closure, acceptance and execution release remain
  separate receipts.

Required evidence: complete content-addressed closure manifest; all expected outputs; independent
reproduction record; immutable authorized publication identity; no unresolved material mismatch.

Classification threshold: this objection cannot be `RESOLVED WITH EVIDENCE` by combining design-
only classifications. Any required not-run check prevents resolution; missing authorization or
publication is `BLOCKED BY DEPENDENCY`; incomplete coverage or contradictory output is `OPEN`.

## 7. Exact final-review check inventory

The final reviewer must record `PASS`, `FAIL`, `NOT RUN`, `PARTIAL`, or
`BLOCKED BY DEPENDENCY` for each check and cite candidate-bound evidence. `PASS` is not available
during preparation.

### Candidate fixation — 5 checks

- `W05-CHK-CAND-01`: enumerate all Agent A-E submission records and required outputs.
- `W05-CHK-CAND-02`: measure path, stable ID, bytes, SHA-256 and byte domain for every input.
- `W05-CHK-CAND-03`: resolve one candidate manifest with no omission, duplicate or digest drift.
- `W05-CHK-CAND-04`: resolve repository, baseline, blob/tree/commit and supersession identities.
- `W05-CHK-CAND-05`: repeat status/enumeration after review and detect any candidate mutation.

### Schema completeness — 9 checks

- `W05-CHK-SCH-01`: inventory every required schema and declared dialect/version.
- `W05-CHK-SCH-02`: trace required, optional, null, omitted and default semantics.
- `W05-CHK-SCH-03`: trace string, array, object, numeric, depth and total-size bounds.
- `W05-CHK-SCH-04`: trace formats, identifiers, timestamps, Unicode and canonical encoding.
- `W05-CHK-SCH-05`: trace duplicate keys, unknown fields and unknown critical extensions.
- `W05-CHK-SCH-06`: trace conditional and cross-field invariants.
- `W05-CHK-SCH-07`: trace state, authority, replay and candidate-binding constraints.
- `W05-CHK-SCH-08`: confirm malformed/unsupported input has a fail-closed reason and state.
- `W05-CHK-SCH-09`: run only if separately authorized: pinned-validator meta-schema and bundle
  validation with complete content-addressed output.

### Fixture coverage — 7 checks

- `W05-CHK-FIX-01`: map every normative requirement to fixture IDs.
- `W05-CHK-FIX-02`: require at least one valid minimum and valid maximum/representative case.
- `W05-CHK-FIX-03`: cover missing, null, extra, duplicate and wrong-type fields.
- `W05-CHK-FIX-04`: cover boundary, overflow, Unicode, timestamp and resource-limit cases.
- `W05-CHK-FIX-05`: cover conditional, cross-field, state and authority violations.
- `W05-CHK-FIX-06`: cover replay, stale evidence, revoked identity and wrong candidate/audience.
- `W05-CHK-FIX-07`: verify expected acceptance/rejection, reason code and resulting safe state.

### Vector reproducibility — 6 checks

- `W05-CHK-VEC-01`: verify semantic inputs and canonical bytes are both published.
- `W05-CHK-VEC-02`: recompute JCS/canonical encodings independently.
- `W05-CHK-VEC-03`: recompute ledger genesis and immediate successor framed preimages/hashes.
- `W05-CHK-VEC-04`: reproduce signature inputs and valid verification outcomes.
- `W05-CHK-VEC-05`: reproduce mutation, wrong predecessor/domain/audience/key and replay rejection.
- `W05-CHK-VEC-06`: compare independent outputs byte-for-byte and disposition every mismatch.

### Shared contracts — 7 checks

- `W05-CHK-CON-01`: reconcile stable identity and repository/candidate namespaces.
- `W05-CHK-CON-02`: reconcile algorithm, key-purpose and canonicalization profiles.
- `W05-CHK-CON-03`: reconcile trust roots, revocation, trusted time and evidence stores.
- `W05-CHK-CON-04`: reconcile dependency provider/consumer versions and failure semantics.
- `W05-CHK-CON-05`: reconcile state vocabulary, transitions, precedence and reason codes.
- `W05-CHK-CON-06`: reconcile suspension, rollback, recovery and supersession effects.
- `W05-CHK-CON-07`: verify unknown, unavailable or incompatible contracts fail closed.

### Authority provenance — 5 checks

- `W05-CHK-AUT-01`: resolve assignment authority to an effective terminating mandate chain.
- `W05-CHK-AUT-02`: resolve stable assignee identity, scope, time and acknowledgement.
- `W05-CHK-AUT-03`: compute direct and transitive conflict/separation results.
- `W05-CHK-AUT-04`: verify lifecycle, revocation, supersession and in-flight race handling.
- `W05-CHK-AUT-05`: verify candidate/run binding and reject labels or general approval as authority.

### Publication identity — 5 checks

- `W05-CHK-PUB-01`: resolve every manifest entry to exact immutable repository objects.
- `W05-CHK-PUB-02`: verify hash domains, line-ending/canonicalization policy and manifest digest.
- `W05-CHK-PUB-03`: verify publisher identity, authority, receipt signature, scope and time.
- `W05-CHK-PUB-04`: independently retrieve and remeasure the exact published candidate.
- `W05-CHK-PUB-05`: verify amendment, revocation, partial-publication and rollback behavior.

### Failure-closed behavior and rollback — 6 checks

- `W05-CHK-FCR-01`: map every unavailable/invalid dependency to an OFF, blocked or quarantined state.
- `W05-CHK-FCR-02`: verify no unknown schema/state/reason/version defaults to permit or trusted.
- `W05-CHK-FCR-03`: verify invalid authority, trust, time, revocation or evidence suspends dependents.
- `W05-CHK-FCR-04`: verify unexpected fixture/vector acceptance stops review and opens a finding.
- `W05-CHK-FCR-05`: verify rollback target, authority, receipt, audit preservation and restart rules.
- `W05-CHK-FCR-06`: verify publication/candidate drift invalidates stale evidence and restarts review.

**Prepared final-review check count: 50**  
Breakdown: 5 candidate fixation, 9 schema completeness, 7 fixture coverage, 6 vector
reproducibility, 7 shared contracts, 5 authority provenance, 5 publication identity, and 6
failure-closed/rollback checks.

## 8. Required final-review output

The final review must include:

1. one fixed candidate inventory and manifest identity;
2. one reviewer identity/scope/evidence/independence record;
3. all 50 check dispositions with exact evidence or blocker;
4. all nine objection classifications with criterion-by-criterion rationale;
5. fixture requirement coverage and negative-case coverage counts;
6. vector reproduction agreement/mismatch counts;
7. schema, contract, authority and publication completeness counts;
8. new finding count and append-only finding records;
9. explicit residual dependencies, rollback/suspension effects and next permitted action;
10. separate artifact, objection and consolidated package conclusions without acceptance or
    execution overclaim.

If a supplied design has a material omission or contradiction, classify the objection `OPEN`
rather than hiding it behind a missing validation or adoption dependency. If design is complete
but verification was not authorized, use `DESIGN ADDRESSED — VERIFICATION PENDING` or
`BLOCKED BY DEPENDENCY` according to the exact closure requirement. A single material failed
negative case, unexplained vector mismatch, mutable candidate, invalid reviewer independence, or
unresolved publication/authority dependency prevents a consolidated resolved conclusion.

## 9. Prepared counts and current disposition

- **Open-objection review entries prepared:** **9**
- **Permitted classifications:** **4**
- **Agent submission fixation criteria:** **10 per submission**
- **Final-review checks prepared:** **50**
- **Required final-review output elements:** **10**
- **Agent A-E fixed candidate sets available at preparation:** **0**
- **Schemas validated by this preparation:** **0**
- **Fixtures executed by this preparation:** **0**
- **Vectors reproduced by this preparation:** **0**
- **Objections accepted or closed by this preparation:** **0**

Current disposition:

`PREPARATION COMPLETE -> A-E SUBMISSIONS NOT FIXED -> FINAL REVIEW BLOCKED BY DEPENDENCY -> NO ACCEPTANCE -> NO EXECUTION`
