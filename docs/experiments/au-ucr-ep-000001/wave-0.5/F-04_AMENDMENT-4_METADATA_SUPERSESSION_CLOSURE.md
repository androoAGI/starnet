# F-04 Amendment 4 — Metadata Supersession Closure

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-REVIEW`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `F-04_AMENDMENT-4_METADATA_SUPERSESSION_CLOSURE`
- **Reviewer label:** `Agent F`
- **Review date:** 2026-10-12
- **Scope:** final narrow disposition of `A2-NMF-01`
- **Baseline/current HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Validation/cryptographic execution:** **NONE / NONE**
- **Acceptance/authorization effect:** **NONE / NONE**

This check inspected only the superseded reconciliation, its Amendment 1, Registry 1.3.0 and the
final vector bundle. It preserves all prior reports and source artifacts unchanged. It does not
accept, validate, adopt, publish, sign, commit, push, merge, implement, construct, test or
execute anything.

## 2. Exact closure evidence

SHA-256 values are over exact current working-tree bytes.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `W05_POST_CORRECTION_RECONCILIATION.md` | 8,942 | `e3de7a4e27a68e2103fd12708e3f295bb6af5a424694a4bed42b4bdfbaa28193` |
| `W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md` | 2,837 | `9f5892f1d1ff28a8169b08720bad9b33853cba711d5fb9379d8e01777cb14d4c` |
| `W05_VERSIONED_REGISTRY.md` | 42,335 | `c39ea9240f0715d5ecaa56137745ca72fed2720913795ead5806c107b9fa05d4` |
| `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json` | 204,024 | `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52` |

Direct standard-library inspection of the final bundle confirms:

- declared scenarios: **14**;
- actual scenarios: **14**;
- positive scenarios: **2**;
- negative scenarios: **12**;
- files under `vectors/`: **6**; and
- bundle SHA-256:
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`.

No vector-byte recomputation, schema validation or ES256 operation was repeated or performed in
this narrow metadata check.

## 3. Supersession-chain verification

### Preserved base reconciliation

`W05_POST_CORRECTION_RECONCILIATION.md` now:

- titles itself a **Superseded Snapshot**;
- places an explicit supersession notice before its control record;
- defines every use of “current” as current only at its pre-final-vector observation point;
- says its 8-scenario count predates expansion to 14;
- identifies itself as not current controlling metadata;
- names `W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md` as the superseding record for vector
  count, positive/negative split, bundle identity and affected present-tense interpretation; and
- uses status `SUPERSEDED_SNAPSHOT_NOT_ADOPTED`.

The preserved 8-scenario text is therefore explicit historical evidence, not an unresolved
current assertion.

### Reconciliation Amendment 1

`W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md`:

- has status `CURRENT_VECTOR_METADATA_RECONCILED_NOT_ADOPTED`;
- expressly preserves the base record as historical;
- supersedes only its stale current vector metadata;
- states **1 family / 14 scenarios / 2 positive / 12 negative / 6 files**;
- states exact bundle SHA-256
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`;
- preserves all validation, cryptographic, adoption, publication, authority, A09/G3 and G4
  limitations; and
- does not imply that metadata correction is evidence of conformance or governance authority.

### Registry and bundle agreement

Registry 1.3.0 states the same current family ID, 14/2/12 scenario split, six-file count and exact
bundle digest. The machine-readable bundle independently confirms the stated scenario
cardinality and exact file digest.

Result: **PASS — THE SUPERSESSION CHAIN IS EXPLICIT, NON-CIRCULAR, CURRENTLY CONSISTENT AND
FAILS CLOSED AGAINST HISTORICAL COUNT REUSE.**

## 4. `A2-NMF-01` disposition

### Final vector expansion was not consumed by current-status records

- **Prior classification:** `OPEN`
- **Current classification:** **DESIGN ADDRESSED — VERIFICATION PENDING**
- **Design disposition:** the stale-count ambiguity is corrected. A consumer following the
  top-level supersession notice, named Amendment 1 and Registry 1.3.0 reaches one current
  metadata tuple:
  `1 family / 14 scenarios / 2 positive / 12 negative / 6 files /
  b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`.
- **Why not `RESOLVED WITH EVIDENCE`:** the records and bundle remain mutable, untracked and
  unpublished. No authorized freeze, candidate manifest, Git-object binding, publication receipt
  or candidate-bound formal independent review fixes these exact bytes.
- **Residual verification dependency:** independently re-establish this supersession chain after
  authorized candidate freeze/publication and bind it to the final manifest and review receipt.

No new finding was opened.

## 5. W05 objection updates

Only objections 07 and 09 were reconsidered.

| Objection | Amendment 3 | Amendment 4 | Basis |
| --- | --- | --- | --- |
| `W05-OBJ-07` | **OPEN** | **OPEN** | The stale scenario-count inconsistency is removed, but the broader objection still lacks an instantiated dependency registry and authorized adoption evidence. The narrow metadata correction does not cure that supplied-design gap or external dependency. |
| `W05-OBJ-09` | **OPEN** | **OPEN** | Current vector metadata is now coherent, but the aggregate objection still lacks requirement-complete validation/cryptographic outputs, a complete closure manifest, immutable publication, effective QA/review and authority receipts. The metadata fix alone cannot close the aggregate objection. |

No other objection classification changes. The final design-objection classifications remain:

- `W05-OBJ-01`: **DESIGN ADDRESSED — VERIFICATION PENDING**
- `W05-OBJ-02`: **DESIGN ADDRESSED — VERIFICATION PENDING**
- `W05-OBJ-03`: **BLOCKED BY DEPENDENCY**
- `W05-OBJ-04`: **BLOCKED BY DEPENDENCY**
- `W05-OBJ-05`: **BLOCKED BY DEPENDENCY**
- `W05-OBJ-06`: **BLOCKED BY DEPENDENCY**
- `W05-OBJ-07`: **OPEN**
- `W05-OBJ-08`: **BLOCKED BY DEPENDENCY**
- `W05-OBJ-09`: **OPEN**

Count: **0 RESOLVED WITH EVIDENCE; 2 DESIGN ADDRESSED — VERIFICATION PENDING; 2 OPEN;
5 BLOCKED BY DEPENDENCY**.

## 6. Preserved external blockers and holds

This metadata supersession closure does not reopen, expand or close:

- validator/meta-validator and full positive/negative conformance execution;
- generalized RFC 8785 and consumer enforcement evidence;
- genuine ES256 signing/verification, trust-root/key lifecycle, revocation and malformed-signature
  evidence;
- effective adoption authority and exact-candidate adoption receipt;
- stable governed identities, mandate chains, assignments, acknowledgements, separation, QA,
  effective independent review, findings closure, A09 and G3 receipts;
- authorized final freeze, complete manifest, Git blob/tree/commit identity, immutable
  publication, independent retrieval/remeasurement and publication receipt; or
- G3 acceptance and the later separate G4 exact-run release.

Preserved holds:

- A09: `UNRESOLVED`
- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- G4: `NOT AUTHORIZED`
- validation/ES256: `NOT RUN`
- adoption/publication/acceptance: `NONE`
- commit/push/merge: `NOT AUTHORIZED / NOT PERFORMED`
- historical reference `2ea38d86a19697b80a827d2dfd83a9219e145532`:
  `UNSUPPORTED`, not substituted

## 7. Final narrow disposition

**METADATA SUPERSESSION DESIGN CLOSURE ACHIEVED — IMMUTABLE VERIFICATION PENDING**

`8-SCENARIO TEXT EXPLICITLY HISTORICAL -> AMENDMENT 1 + REGISTRY 1.3.0 + BUNDLE AGREE ON
14 / 2 / 12 / 6 / b174...fac52 -> A2-NMF-01 DESIGN ADDRESSED — VERIFICATION PENDING ->
W05-OBJ-07 OPEN / W05-OBJ-09 OPEN -> EXTERNAL HOLDS UNCHANGED`
