# Wave 0.5 Proposed Schema Bundle — F-04 Correction

## Status

Every schema remains `PROPOSED_NOT_ADOPTED`. No real actor, appointment, mandate, key, signature,
receipt, manifest, candidate, acceptance, release, implementation, or execution is asserted.
Synthetic fixture identities use the `urn:example:` namespace and are not authority evidence.

No JSON Schema validator or meta-validator was installed or executed. Inspection is limited to
JSON parsing, local-reference/path inspection, registry-ID comparison, and manual read review.

## Governing proposed-design sources

1. `../W05_VERSIONED_REGISTRY.md` for canonical IDs, versions, interfaces, decisions, audit
   projection, algorithms, purposes, domains and ordered reasons.
2. `../W05_SHARED_TRUST_AND_STATE_CONTRACT.md` for trust/state semantics.
3. `../W05_INTERFACE_MATRIX.md` for IF-01 through IF-22 boundaries.
4. `../W05_AUTHORITY_SCHEMA_REQUIREMENTS.md` for twelve purpose-specific authority objects.
5. `../W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` for L0-L6 provenance hierarchy.

The registry is authoritative only within the proposed Wave 0.5 design and is itself not adopted.

## Schema coverage

The package contains 35 schema documents:

- **2 shared/helper schemas:** `common.schema.json` and
  `authority-object-base.schema.json`.
- **25 canonical registry profiles:** every profile enumerated in Registry Section 3, including
  common envelope, ARM, challenge, platform/provider, verifier, inference, transition, governed
  event, delivery, anchor, reconciliation, revocation, rollback and reinstatement.
- **Purpose-specific authority schemas:** assignment, acknowledgement, separation, QA,
  independent review, findings closure, A09, G3, G4 exact-run release, authority revocation,
  rollback authorization/plan and reinstatement.
- **Additional integration schemas:** external governed-event ledger envelope and nested candidate
  manifest.

The former generic receipt is now `urn:au-ucr:schema:profile-receipt:1.0.0` and is explicitly
`ABSTRACT_BASE_ONLY`. It cannot authorize any receipt kind.

## F-04 correction mapping

- **F04-NMF-01:** all 25 registry profiles are present; interfaces are explicit and IF-14 is split
  from IF-15.
- **F04-NMF-02 (schema side):** `audit-ledger-record.schema.json` validates exactly Registry
  Section 6 `record_without_hash`. `governed-audit-ledger-envelope.schema.json` separately carries
  domain, ledger ID, sequence, raw-predecessor hex representation and derived record hash.
- **F04-NMF-03:** schema IDs use `urn:au-ucr:schema:<profile>:1.0.0`; canonical decision,
  algorithm, canonicalization, framing, domain, hash-domain, key-purpose and ordered reason
  vocabularies come from `common.schema.json`.
- **F04-NMF-04 (schema side):** distinct schemas prevent generic role/kind/outcome substitution
  for all twelve authority objects.
- **F04-NMF-05 (schema side):** `nested-candidate-manifest.schema.json` binds L0-L4 child
  manifests using canonical digest references. L5/L6 are represented by typed publication and
  authority receipt references, not instantiated evidence.

## Representation

- JSON Schema draft 2020-12; semantic version `1.0.0`.
- Canonicalization ID `CANON-JCS-RFC8785-v1`.
- General signed framing `FRAME-LEN-DOMAIN-v1`.
- Governed-event framing `FRAME-GPEP-EVENT-v1`, exact ASCII domain
  `AU-GPEP-EVENT-v1`, external to `record_without_hash`.
- Runtime TMC domain `DOMAIN-TMC-RUNTIME-v1`; ledger-head domain
  `DOMAIN-LEDGER-HEAD-ATTEST-v1`.
- Ledger-head signing uses `PROFILE-LEDGER-HEAD-SIGNING-v1`, excludes both payload-digest
  locations and the complete signature from its seven-member signing projection, and requires
  `SIGENC-ES256-P1363-LOW-S-B64URL-v1`.
- Canonical SHA-256 and Git/provenance hash-domain IDs only; ambiguous `git_blob_lf` is removed.
- Ordered, unique `reason_codes`; success uses an empty array and never `OK`.
- Consumer decisions are `ALLOW`, `DENY`, `SUSPEND`, `REVOKE`, `BLOCK`, `NO_MUTATION`.
  Governance outcomes and technical vector expectations remain separate.
- Objects reject undeclared properties and required evidence does not permit `null`.

## Fixtures

`fixtures/manifest.json` is authoritative for current fixture classification:

- 2 active full-document governed-event cases: one intended valid and one single-defect intended
  invalid (`ACCEPT` instead of `ALLOW`);
- 57 positive/negative subschema unit pairs (114 scalar/fragment cases), covering all 33 record
  schemas plus Registry 1.3.0 vocabulary/projection and purpose-separation requirements;
- 12 old full-document fixtures retained as pre-correction historical design material and
  explicitly excluded from current outcome counts.

Subschema fixtures test a named JSON Pointer constraint in isolation. They improve one-defect
traceability but do not establish complete-object validity.

## Unresolved design and verification gaps

1. JSON Schema cannot prove timestamp ordering, challenge duration, counter monotonicity,
   identity equality/separation, candidate equality, state-machine legality, sequence arithmetic,
   hash calculation, decoded P1363 scalar bounds/low-S, signature validity, replay consumption or
   cross-object status.
2. The vector package has not been regenerated against the corrected governed-event projection or
   ledger-head profile.
3. Full-document positive/negative fixtures for every schema remain future work; unit fixtures
   are not validator evidence.
4. No approved cryptographic encoding/profile, trust roots, identities, assignments, immutable
   candidate, publication receipt, QA result, independent review, adoption or execution release
   exists.

Disposition:

`F-04 SCHEMA CORRECTION DESIGNED -> REGISTRY 1.3.0 ALIGNED -> 35 SCHEMAS -> 116 ACTIVE FIXTURE CASES -> JSON PARSE/REFERENCE INSPECTION ONLY -> NOT VALIDATOR-EXECUTED -> PROPOSED_NOT_ADOPTED`
