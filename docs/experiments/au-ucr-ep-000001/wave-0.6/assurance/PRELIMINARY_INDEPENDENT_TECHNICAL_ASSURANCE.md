# Wave 0.6 Preliminary Independent Technical Assurance

## 1. Status and independence disclosure

- **Role label:** Agent F, preliminary technical assurance
- **Assessment date:** 2026-10-12
- **Scope inspected:** existing Wave 0.3, 0.4 and 0.5 files
- **Disposition:** `PRELIMINARY_REVIEW_COMPLETE_WITH_HIGH_SEVERITY_HOLDS`
- **Final assurance:** **NOT CLAIMED**
- **Acceptance, approval or authorization effect:** **NONE**

I am an AI subagent operating in the same workspace as Agents A–E. I am not organizationally
independent, formally appointed, identity-proofed or separated from the artifact-production
environment. “Independent” here means only that I performed a separate adversarial computation
and review pass. This report cannot satisfy a governed Independent Reviewer appointment,
acknowledgement, conflict assessment, signature or receipt.

Agents A–E were working concurrently. Their Wave 0.6 outputs were deliberately not treated as a
complete or stable candidate. This report gives no final assurance over those concurrent outputs.
Every integration-sensitive item in Section 9 must be re-reviewed after a candidate is frozen.

No operational, laboratory, sandbox, network, runtime, signing, publication, commit, push, merge
or approval action was performed. No dependency was installed. Prior waves were not edited.

## 2. Files produced

Only the requested assurance directory was changed:

1. `PRELIMINARY_INDEPENDENT_TECHNICAL_ASSURANCE.md` — this report.
2. `preliminary_checks.py` — standard-library inventory, digest, JSON, reference, fixture,
   closed-set and cross-reference checker.
3. `PRELIMINARY_CHECK_RESULTS.json` — exact inventory and machine-readable results.
4. `validate_schemas.py` — local non-operational draft-2020-12 validation harness using the
   already-installed `jsonschema` package.
5. `SCHEMA_VALIDATION_RESULTS.json` — meta-schema, active fixture, unit-pair and retired-fixture
   observations.

## 3. Scope and reproduced checks

### 3.1 Inventory and repository state

- Enumerated **117 files** in the three wave directories:
  - Wave 0.3: **9**
  - Wave 0.4: **20**
  - Wave 0.5: **88**
- Extension split: **61 Markdown**, **52 JSON**, **4 Python**.
- Recorded exact byte count and SHA-256 for every file in
  `PRELIMINARY_CHECK_RESULTS.json`.
- Repository branch reproduced as `cursor/populate-authority-readiness-7886`.
- HEAD reproduced as `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`.
- Wave 0.4 and Wave 0.5 remained untracked. HEAD therefore does not identify their current bytes.
- Reproduced the four current exact hash/size claims in F-04 Amendment 4, including:
  - vector bundle SHA-256
    `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`;
  - Registry 1.3.0 SHA-256
    `c39ea9240f0715d5ecaa56137745ca72fed2720913795ead5806c107b9fa05d4`;
  - final reconciliation and superseding-amendment hashes.

### 3.2 JSON and schema structure

- Strict duplicate-key-aware JSON parsing: **52/52 passed**.
- Schema inventory: **35 files / 35 unique canonical `$id` values**.
- Draft declarations and canonical ID shape: **35/35 passed**.
- Local `$ref` occurrences: **576 inspected / 576 resolved**.
- Fixture JSON Pointers: **57 inspected / 57 resolved**.
- Draft 2020-12 meta-schema checks with the installed validator: **35/35 passed**.
- No nullable schema type was found by the targeted null-type scan.

These results establish syntactic and limited validator consistency, not cross-object semantics,
consumer behavior, authority or implementation.

### 3.3 Fixtures

- Active full-document cases: **2**, both against
  `audit-ledger-record.schema.json`.
- Intended positive: observed valid.
- Intended one-defect negative: observed invalid because `decision` was not `ALLOW`.
- Subschema unit pairs: **57/57 passed**; every positive scalar was accepted and every negative
  scalar was rejected at its named pointer.
- Active count arithmetic reproduced:
  `2 full documents + (57 × 2 scalar cases) = 116 active cases`.
- All twelve retired pre-correction full-document fixtures are invalid against current schemas,
  consistent with their retirement classification.

### 3.4 Vectors and hashes

- Vector directory: **6 files**.
- Bundle: **14 unique scenarios**, declared and actual counts equal.
- Expected-result split: **2 `ALLOW` / 12 `REJECT`**.
- Bundle SHA-256 reproduced exactly as `b174...fac52`.
- Existing reproduction entry point completed with:
  - 8 direct schema-instance design mappings;
  - 15 semantic byte checks;
  - 22 digest checks;
  - 5 signature-profile shape checks;
  - 14 oracle checks;
  - result `ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED`.

This is deterministic design reproduction. It did not execute ES256 verification and uses the
package's Python JSON canonicalization subset rather than proving generalized RFC 8785 behavior.

### 3.5 Interfaces, objections and authority-schema enumeration

- Interface matrix exact set: `IF-01` through `IF-22`; none missing or unexpected.
- Registry exact interface set: `IF-01` through `IF-22`; none missing or unexpected.
- Objection matrix exact set: `W05-OBJ-01` through `W05-OBJ-09`.
- Authority requirements enumerate exact numbered objects 1 through 12.
- These are presence and closed-set checks only. No interface was implemented or exercised.

### 3.6 Cross-references

- Examined **499 explicit file-reference occurrences**.
- Seven references do not resolve in the current workspace, all in Wave 0.3:
  `IMHOTEP_IDENTITY_VERIFICATION.md`, the historical transition-receipt schema,
  `D-02_DESIGN_DRAFT.md`, and four old `*_DESIGN_DRAFT.md` paths in SCRUM03.
- Wave 0.3 and later gate records already classify several of these as stale/superseded. Their
  preservation is appropriate, but they cannot be used as currently retrievable evidence.

## 4. Findings

### F-PRELIM-01 — HIGH — No immutable candidate or repository binding

The current Wave 0.4 and Wave 0.5 package is untracked and mutable. The repeated baseline HEAD
identifies the repository context, not the package bytes. There is no candidate manifest
instance, Git tree/commit binding, authorized freeze, immutable publication locator,
publication receipt or independent retrieval.

**Impact:** counts, hashes and assurances can change without a commit-addressed audit trail.
Current exact hashes are useful observations but are not durable candidate identity.

**Required closure:** freeze the integrated candidate; enumerate dynamic membership; bind raw,
canonical, Git object, tree and commit identities; publish through an authorized mechanism; then
retrieve and remeasure independently.

### F-PRELIM-02 — HIGH — Full-document schema evidence is grossly incomplete

All 35 schemas pass draft meta-schema validation, but only one schema has active positive and
negative full-document fixtures. The 57 pairs are scalar/subschema tests and cannot detect
whole-object composition, conditional-requirement, nested-reference or interaction failures.

**Impact:** “35 schemas” and “116 cases” are numerically correct but can be misread as broad
full-document conformance. They are not. Thirty-four schemas have no active complete-object
positive/negative evidence.

**Required closure:** add requirement-traced complete documents for every concrete schema,
including composition, boundary, unknown-property, conditional and cross-field negatives; run
with a pinned validator and preserve exact outputs.

### F-PRELIM-03 — HIGH — Cryptographic and canonicalization assurance is absent

Vector bytes and SHA-256 values reproduce, and signature encoding shape checks pass. However,
signature values are synthetic; no ES256 signing or verification, wrong-key, malformed encoding,
high-S, trust-chain, key-purpose, revocation or replay consumer execution occurred. The
reproducer's `json.dumps(sort_keys=True, separators=...)` helper is explicitly a JCS subset, not
evidence for generalized RFC 8785 handling.

**Impact:** the package demonstrates deterministic selected bytes, not cryptographic validity or
interoperable canonicalization.

**Required closure:** use an independent implementation and pinned conformance corpus; test JCS
edge cases and exact P1363 low-S ES256 behavior with designated test keys; verify trust,
revocation, purpose and failure routing.

### F-PRELIM-04 — HIGH — Interfaces are design-only

The 22 interface IDs reconcile between registry and matrix, but zero interfaces are adopted,
implemented or demonstrated. No consumer rejection, state transition, atomic state/event/outbox,
replay, rollback, WORM, anchor or reconciliation behavior was exercised.

**Impact:** design alignment cannot support an enforcement, runtime-readiness or release claim.

**Required closure:** after separate authorization, produce implementation-bound conformance
evidence for each interface and each fail-closed path. This preliminary review does not authorize
those tests.

### F-PRELIM-05 — HIGH — Authority and formal independence remain uninstantiated

Wave 0.5 records the statement that Hakeem Moore is the sole Human Authority, but also correctly
records no stable identity-system identifier, identity proofing, root mandate, exact activity
scope, effective interval, signature binding or governed appointments. Decision Chair, QA,
Independent Reviewer and Coordinator/Architect remain unassigned/not established.

**Impact:** no design, validation output, review, A09 result, G3 acceptance or G4 release acquires
governance effect. Prior “independent” reports are role-labeled same-environment reviews.

**Required closure:** instantiate identity, mandate, assignments, acknowledgements, separation,
scope, lifecycle and purpose-specific signed receipts without backdating.

### F-PRELIM-06 — MEDIUM — Historical references are not all retrievable

Seven explicit Wave 0.3 references do not resolve. Some are intentionally stale design-draft
paths already called out by prior assurance, while the identity-verification and old transition
schema references remain unavailable at their named locations.

**Impact:** a reader cannot reproduce every historical dependency solely from the current
workspace. Supersession limits current design impact but not the provenance gap.

**Required closure:** preserve a manifest classification for each missing reference:
`REPLACED_BY`, `HISTORICAL_UNAVAILABLE`, or an immutable locator and digest. Do not silently
rewrite historical records.

### F-PRELIM-07 — MEDIUM — Same-author tooling limits vector independence

The wrapper `reproduce_vectors.py` delegates to a file retained under the historical name
`reproduce_vectors_registry_1_2.py` while asserting Registry 1.3.0. The script explicitly states
that it is a same-author design-consistency check.

**Impact:** successful execution is valuable regression evidence but not independent vector
assurance. Historical naming also increases consumer-selection risk.

**Required closure:** add a separately implemented verifier, pin the intended registry version in
the tool identity and result, and compare outputs byte-for-byte.

### F-PRELIM-08 — MEDIUM — Current validation evidence was not candidate-bound

This preliminary pass newly demonstrates 35/35 meta-schema checks, 2/2 active full-document
expectations and 57/57 scalar pairs using the locally installed validator. The package itself
previously and correctly stated validator execution had not occurred.

**Impact:** these results are informative but mutable, same-workspace and not tied to an
authorized immutable candidate. They do not close W05 objections or create acceptance.

**Required closure:** repeat under a pinned toolchain after candidate freeze, preserve versions,
command, stdout/stderr and result digests, and obtain candidate-bound QA and formal review.

## 5. Severity summary

- Critical: **0**
- High: **5**
- Medium: **3**
- Low: **0**

No critical finding means no newly observed contradiction worse than the package's existing
fail-closed posture. The five high findings independently prevent assurance, adoption or release.

## 6. Claims sustained by this preliminary pass

The following narrow claims were reproduced:

- current prior-wave file inventory is 117 files in the three wave directories;
- all 52 JSON files parse without duplicate keys;
- 35 schema files have 35 unique canonical IDs and 576 resolvable local references;
- all 35 schemas pass draft-2020-12 meta-schema checking with the available validator;
- the limited active fixture suite behaves as declared;
- current fixture arithmetic is 116 active cases;
- the vector bundle is 14 scenarios, split 2 positive and 12 negative, in a six-file directory;
- the current vector bundle digest is `b174...fac52`;
- selected vector bytes and digests deterministically reproduce;
- interface, objection and authority-requirement closed sets are numerically complete.

None of these claims implies implementation, authority, adoption, publication, cryptographic
validity, operational enforcement, formal independence, acceptance or release.

## 7. Claims not sustained

This assessment does **not** sustain:

- immutable or published candidate identity;
- complete schema conformance;
- generalized RFC 8785 conformance;
- genuine ES256 validity or trusted signer authority;
- cross-object temporal, identity, ordering, state-machine or replay correctness;
- any implemented interface or fail-closed runtime behavior;
- organizationally independent QA/review;
- A09 acceptance, G3 acceptance, G4 release or approval of any kind.

## 8. Preliminary disposition

`REVISE / HOLD`

The package is materially more internally coherent than its earlier snapshots: current counts,
schema IDs, local references, fixture pointers, interface IDs, vector metadata and selected
digests reconcile. It remains a mutable proposed design with incomplete full-document evidence,
no cryptographic or operational demonstration, no immutable provenance and no effective
governed review/acceptance chain.

## 9. Mandatory post-integration final-review checklist

After Agents A–E finish and before any final assurance statement:

1. Freeze one exact Wave 0.6 candidate and record repository, branch, commit, tree, parent,
   worktree cleanliness and dynamic file membership.
2. Confirm no prior-wave file was modified, deleted or silently superseded.
3. Recompute byte counts and SHA-256 for every candidate member; compare all embedded hash/count
   claims and regenerate only through explicit append-only supersession.
4. Re-run strict JSON duplicate-key parsing, all `$id` uniqueness checks, all `$ref` and JSON
   Pointer resolution, and draft meta-schema validation.
5. Validate complete positive and negative documents for every concrete schema using a pinned
   validator and format policy; review unevaluated/additional-property closure.
6. Reconcile every schema/profile/version, purpose, decision, reason, algorithm, domain and hash
   identifier against the final registry.
7. Reproduce vectors using a separately implemented canonicalizer/verifier; compare exact bytes,
   frames, hashes, scenario counts and oracles.
8. Under separate authorization, execute genuine ES256/P1363 low-S positive and negative
   conformance with designated test keys and trust/revocation state.
9. Reconcile all 22 interfaces end-to-end across specifications, schemas, vectors and any
   implementation; verify failure ownership and safe-state precedence.
10. Reassess authority facts and require candidate-bound identity, mandate, assignment,
    acknowledgement, separation, QA, review and findings-closure evidence.
11. Resolve or explicitly classify all historical missing references without rewriting prior
    records.
12. Verify candidate manifest, Git/tree/commit bindings, immutable publication, independent
    retrieval and remeasurement.
13. Review all concurrent Wave 0.6 artifacts for contradictions, stale counts, circular
    evidence, self-approval, authority inflation and unsupported readiness language.
14. Confirm every preliminary finding above is closed, accepted as residual risk by valid
    authority, or remains an explicit blocker.
15. Issue any final assurance only against the exact frozen candidate, with a new independence
    disclosure and no implication of A09, G3, G4, publication or operational approval.

Until that checklist is completed, this report remains:

`PRELIMINARY ONLY -> SAME-WORKSPACE AI REVIEW -> NO FINAL ASSURANCE -> NO APPROVAL`
