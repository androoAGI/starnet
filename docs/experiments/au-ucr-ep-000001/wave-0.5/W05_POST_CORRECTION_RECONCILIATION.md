# Wave 0.5 Post-Correction Reconciliation — Superseded Snapshot

> **Supersession notice:** This record is a preserved pre-final-vector snapshot. Every use of
> “current” in this file means current at this record's observation point, before the vector
> family expanded from 8 to 14 scenarios. It is not current controlling metadata.
> `W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md` supersedes the vector count, positive and
> negative scenario counts, bundle digest, and every present-tense interpretation affected by
> that expansion. Registry 1.3.0 and Amendment 1 are authoritative for the present design state.

## 1. Control record

- **Experiment:** `AU-UCR-EP-000001`
- **Contract task:** `FOR-ACT-S0-001-W05-CONTRACT`
- **Baseline HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Registry:** `urn:au-ucr:registry:wave-0.5-contract:1.3.0`
- **Status:** `SUPERSEDED_SNAPSHOT_NOT_ADOPTED`
- **Validation performed:** `NONE`
- **Cryptographic operation performed:** `NONE`
- **Publication effect:** `NONE`
- **Authority / acceptance / release effect:** `NONE / NONE / NONE`

This is a preserved historical reconciliation snapshot. It does not alter or supersede the
evidentiary integrity of `F-04_INDEPENDENT_WAVE_0.5_ASSURANCE_REPORT.md`,
`F-04_AMENDMENT-1_POST_CORRECTION_ASSURANCE.md`, or any Wave 2 report. Counts and statuses in
those reports remain accurate for the snapshots they inspected and are historical, not current.

## 2. Current scoped counts

Read-only membership and identifier inspection establishes this current design snapshot:

| Scope | Current count | Current interpretation |
| --- | ---: | --- |
| `schemas/*.schema.json` | **35 files** | Canonical `urn:au-ucr:schema:*:1.0.0` proposal set; present, not validator-executed |
| Vector families | **1 family** | `urn:au-ucr:vector-bundle:ledger-attestation:1.0.0` |
| Vector scenarios | **8** | Two positive and six negative design oracles |
| Files under `vectors/` | **6 files** | One JSON bundle, one derivation report, two derivation scripts, two reproduction scripts |
| Schema families directly represented by positive vector objects | **3** | Governed event, governed ledger envelope, ledger-head attestation |
| Design interface inventory | **22 interfaces** | `IF-01` through `IF-22`, all design-aligned |
| Operationally adopted/demonstrated interfaces | **0 / 0** | All 22 remain blocked from operation by adoption and implementation |

These counts are scoped, mutable working-tree observations. They are not a freeze manifest,
candidate identity, Git tree/commit binding, publication receipt, or validation result.

## 3. Historical status markers

The following included statements are expressly historical:

- Wave 2 counts of 8 schemas, 4 vector files, and 0 aligned interfaces;
- Wave 2 claims that assignment, G3, G4, ledger-head, and other interface profiles were absent;
- pre-correction claims that vector schema IDs, decision literals, domains, purposes, and audit
  projection were still incompatible;
- nested-specification snapshots with 24 schema-family members or 47 total files; and
- F-04 handoffs saying Agent A or Agent B still had to consume the now-present corrected
  vocabulary and profiles.

They remain unchanged in their source reports. For present-tense interpretation, Registry 1.3.0
and this record take precedence.

## 4. Current corrected families

### 4.1 Schema and interface families

The 35 schema files comprise:

- **4 shared/support profiles:** common envelope, authority object base, profile receipt, nested
  candidate manifest;
- **13 purpose-specific authority/lifecycle profiles:** assignment, acknowledgement, separation,
  QA, independent review, findings closure, A09, G3, G4 exact-run release, authority revocation,
  rollback authorization, rollback receipt, reinstatement; and
- **18 interface/runtime/audit profiles:** transition result, candidate review package, ARM,
  runtime attestation, effective configuration, platform result, model endpoint statement,
  verifier challenge/verdict, session binding, inference receipt, governed event/envelope,
  outbox delivery, ledger-head attestation, anchor checkpoint, reconciliation, revocation
  snapshot.

Literal/profile inspection records all 22 interfaces as design-aligned. No statement here claims
that a JSON Schema validator resolved every reference or accepted/rejected any instance.

### 4.2 Authority family

The corrected authority design separates assignment, acknowledgement, separation, QA, review,
findings closure, A09, G3, G4, authority revocation, rollback authorization, and reinstatement.
Rollback execution has a separate receipt. Exact roles, kinds, outcomes, purposes, quorums, and
safe failures are registered.

Authority evidence remains absent: all ten authority gaps remain open, the Decision Chair is
unassigned, A09 is unresolved, G3 remains closed by dependency, and G4 is not authorized. Schema
presence and signature-shaped fields do not appoint or authorize an actor.

### 4.3 Provenance family

The corrected provenance design includes:

- the `nested-candidate-manifest` schema family;
- the nested candidate manifest specification;
- publication/provenance identity-domain and freeze design;
- immutable-reference crosswalk requirements; and
- base verified inventory observations.

These designs separate working-tree, LF-normalized, Git object, candidate manifest, published
revision, receipt, and acceptance identities. No final complete freeze inventory, exact Git
tree/commit binding, immutable publication locator, publication receipt, independent retrieval,
or acceptance binding exists.

### 4.4 Vector family

The current ledger-attestation family has eight scenarios and canonical schema/domain/purpose/
decision/reason literals. Its two ledger-head objects use the same non-self-referential signing
payload projection now adopted as `PROFILE-LEDGER-HEAD-SIGNING-v1`.

The recorded `UNVERIFIED-SYNTHETIC-ES256-VALUE` remains a non-cryptographic sentinel. Derived byte
agreement is not ES256 verification, validator conformance, or consumer enforcement.

## 5. A1 finding reconciliation

### `A1-NMF-01`

**Contract/current-status portion:** `ADDRESSED_BY_CURRENT_RECONCILIATION`.

Registry 1.3.0 no longer states that current schema/vector bytes are an old nonconformant set,
that present profiles are missing/deferred, or that corrected literals await Agent A/B
consumption. Historical reports remain unchanged and are explicitly time-scoped here.

**Residual:** a fresh authorized complete freeze inventory over the final candidate is still
required. This record is not that inventory and does not close publication/provenance evidence.

### `A1-NMF-02`

**Contract portion:** `ADDRESSED_BY_REGISTRY_1.3.0`.

Registry Section 7.1 now authoritatively defines exact payload inclusion/exclusion,
non-self-reference, RFC 8785 canonicalization, 24-byte domain, length framing, payload digest
placement, ledger-head key purpose, low-S P1363/base64url ES256 design encoding, verification
order, and failure reasons.

**Residual:** no cryptographic key, trust root, signature, verifier execution, wrong-coverage
cryptographic vector, schema validation, or consumer negative execution was authorized or
performed. Full `A1-NMF-02` therefore remains open outside the contract portion.

## 6. Remaining blockers

1. **Adoption:** no effective adoption authority or exact-candidate adoption receipt.
2. **Validation:** no pinned validator/meta-schema/reference-resolution profile and no preserved
   full positive/negative execution receipts.
3. **Cryptography:** no approved operational trust root/key lifecycle and no executed ES256
   signing, verification, wrong-coverage, revocation, or malformed-encoding evidence.
4. **Negative coverage:** sequence, fork, predecessor, replay, transition, and broader consumer
   enforcement suites remain incomplete or unexecuted.
5. **Authority:** stable identities, mandates, assignments, acknowledgements, separation, QA,
   effective independent review, findings closure, A09, and G3 evidence remain absent.
6. **Publication/provenance:** no final freeze, Git object binding, immutable publication,
   independent retrieval/remeasurement, or publication receipt.
7. **Implementation/enforcement:** no interface implementation or fail-closed runtime behavior
   has been demonstrated.
8. **Release:** without valid G3 acceptance, no Coordinator/Architect may issue a G4 exact-run
   release.

## 7. Current disposition

`35 SCHEMAS PRESENT / NOT VALIDATED`

`1 VECTOR FAMILY / 8 SCENARIOS / 6 FILES / NOT CRYPTO-VERIFIED`

`22 DESIGN-ALIGNED INTERFACES / 0 ADOPTED / 0 DEMONSTRATED`

`AUTHORITY GAPS OPEN / CANDIDATE UNFROZEN / UNPUBLISHED / A09 UNRESOLVED / G3 CLOSED / G4 NOT AUTHORIZED`
