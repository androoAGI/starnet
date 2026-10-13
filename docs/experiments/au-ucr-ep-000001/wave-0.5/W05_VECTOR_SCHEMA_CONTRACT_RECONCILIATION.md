# Wave 0.5 Vector / Schema / Contract Reconciliation

## 1. Control record

- **Task:** Wave 2 reconciliation for `FOR-ACT-S0-001-W05-VECTORS`
- **Repository baseline context:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Artifact created:** `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md`
- **Existing artifacts edited:** none
- **Review mode:** read-only contract inspection plus existing standard-library vector reproduction
- **Status:** `RECONCILED_MISMATCHES_AND_BLOCKERS_OPEN`
- **Acceptance, adoption, publication, authority, or execution effect:** none

This document crosswalks the existing eight-vector bundle against the complete proposed Wave 0.5
schema package, `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`, `W05_INTERFACE_MATRIX.md`,
`W05_AUTHORITY_CLOSURE_PACKAGE.md`, and `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`. It does not
amend, validate, adopt, or publish any vector, schema, fixture, contract, authority record, or
provenance artifact.

## 2. Inputs and inspection coverage

The complete inspected schema package comprised:

- eight schema documents: seven record schemas plus `common.schema.json`;
- `schemas/README.md`;
- fourteen fixture documents: seven intended-positive and seven intended-negative;
- `schemas/fixtures/manifest.json`.

Schema-package inspection count: **24 files**. The fixture expectations remain proposed oracles.
No JSON Schema validator was installed or run.

Vector inspection count: **8 vectors**:

- 2 positive construction vectors;
- 6 negative rejection vectors;
- 4 ledger record occurrences represented in vectors 001-003, including the repeated genesis;
- 4 attestation signature-input occurrences in vectors 001, 002, 007, and 008.

The existing `reproduce_vectors.py` was run without modification. It reads the current JSON
bundle, independently reimplements the restricted JSON serialization and framing logic without
importing the generator, and compares semantic bytes and digests. This is same-author/same-lane
reproduction, not independent verification.

## 3. Reconciliation counts

- Vectors crosswalked: **8 of 8**.
- Positive vectors whose currently published bytes reproduce: **2 of 2**.
- Negative vectors whose currently published bytes/digests reproduce where applicable: **6 of
  6** through the existing aggregate checks.
- Vectors that are direct instances of an existing record schema: **0 of 8**.
- Positive vectors schema-conformant as presently shaped: **0 of 2**.
- Negative vectors with directionally correct fail-closed intent: **6 of 6**.
- Negative vectors whose exact reason code is consistently registered in both
  `common.schema.json` and the shared contract: **0 of 6**.
- Vector schema-family IDs exactly matching a published `$id`: **0 of 2 families**.
- Fixed ledger-domain reconciliations: **1 exact fixed domain**,
  `AU-GPEP-EVENT-v1`.
- Attestation-domain registry reconciliations: **0**; `AU-RUNTIME-ATTEST-v1` remains
  vector-local and provisional.
- Material mismatch classes: **12**.
- Blocking dependency classes: **7**.

Overall vector dispositions:

- **2** `BYTE_CONSISTENT / SCHEMA_INCOMPATIBLE`;
- **6** `FAIL_CLOSED_INTENT_ALIGNED / EXACT_ORACLE_UNRECONCILED`;
- **0** `SCHEMA_AND_CONTRACT_RECONCILED`;
- **0** independently verified.

## 4. Schema and profile crosswalk

### 4.1 Ledger records

The nearest schema is:

`urn:au-ucr:wave-0.5:schema:audit-ledger-record:1.0.0`

The vector payload instead declares:

`urn:au-ucr:gpep:event:1.0`

The vector's `record_without_hash` contains:

`decision`, `event_id`, `ledger_framing_version`, `object_id`, `object_version`, `schema`,
`timestamp`, and `transition`.

The audit schema requires a different record:

`contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile`,
`framing_profile`, `ledger_id`, `sequence`, `prev_hash`, `event_id`, `actor_id`,
`interface_inventory_id`, `object_id`, `object_version`, `requested_transition`, `decision`,
`reason_code`, four dependency digests, `workload_identity`, `transaction_outcome`,
`correlation_id`, `trusted_receipt_time`, and `record_hash`.

Because that schema has `additionalProperties: false`, the vector-local `schema`,
`ledger_framing_version`, `timestamp`, and nested `transition` fields are not merely aliases; they
are undeclared fields. Required audit fields are also absent. The vector value `decision:
"ACCEPT"` is not in the audit schema enum `ALLOW | DENY | ORPHAN_REJECTED`.

The ledger ID itself is aligned: both the positive schema fixture and the vectors use
`urn:uuid:11111111-1111-4111-8111-111111111111`. Vector event and object IDs satisfy the shared
UUID/general-ID lexical forms, but lexical identity validity does not cure the record-shape
mismatch or establish a governed actor/service identity.

The exact B-03 binary framing is preserved in the vectors:

`len32(domain) || domain || len32(ledger_id) || ledger_id || uint64be(sequence) || len32(prev_hash) || prev_hash || len64(record_bytes) || record_bytes`

The fixed domain is correctly the 16 ASCII bytes `AU-GPEP-EVENT-v1`; genesis uses 32 raw zero
bytes; the successor uses the genesis digest decoded to 32 raw bytes. The schema, however, places
`ledger_id`, `sequence`, and textual `prev_hash` inside the JSON record while the vector keeps
those framing fields outside `record_without_hash`. No adopted projection specifies whether those
values must also be duplicated inside the JSON payload.

The audit schema requires `record_hash` inside the schema instance while corrected B-03 defines
`record_bytes` as JCS of `record_without_hash`. The schema does not formally define the
hash-exclusion projection. Hashing a record containing its own final hash would be circular; the
current vector avoids that cycle, but the schema/vector boundary is unresolved.

### 4.2 Attestation signature inputs

The nearest runtime schema is:

`urn:au-ucr:wave-0.5:schema:attestation-evidence:1.0.0`

The vector payload declares:

`urn:au-ucr:runtime:attestation:1.0`

The vector payload contains:

`algorithm`, `audience`, `head_hash`, `key_id`, `key_purpose`, `ledger_id`, `schema`,
`sequence`, and `signature_framing_version`.

The attestation-evidence schema instead requires launch/liveness evidence including contract
metadata, `evidence_id`, `evidence_kind`, `session_id`, times, verifier nonce, channel binding,
ARM reference, platform/config/module/model/endpoint digests, producer state, and a complete
signature object. With `additionalProperties: false`, the vector payload is not an instance of
that schema. It is more accurately a proposed ledger-head attestation payload, for which the
schema package has no exact record schema.

The vector key purpose `runtime-attestation` differs from:

- schema signature value `RUNTIME_ATTESTATION`; and
- shared-contract key-purpose ID `KP-TMC-RUNTIME-v1`.

The vector signature framing formula agrees with the general formula in A-04 and the shared
contract, but the identifiers do not match:

- vector: `urn:au-ucr:signature-framing:1.0`;
- shared contract: `FRAME-LEN-DOMAIN-v1`.

The attestation domain `AU-RUNTIME-ATTEST-v1` is 20 ASCII bytes and is consistently framed by the
vector tooling, but it is not an entry in the proposed shared domain/key-purpose registry. The
contract specifies purpose-separated domains without adopting this exact value.

The vector canonicalization label `RFC8785-JCS` is conceptually compatible but not identifier-equal
to schema value `RFC8785-JCS-UTF8` or contract registry ID `CANON-JCS-RFC8785-v1`.

Positive vectors contain signature-input bytes and digests only. They contain no ES256 signature,
TMC producer identity, assignment reference, trust chain, revocation state, issue/expiry interval,
nonce, session identity, or verifier result. Their `ACCEPT` oracle therefore applies only to byte
and framing construction and cannot mean schema-valid or authorized attestation acceptance.

### 4.3 Version rules

The schema package uses:

- `$id` suffix `1.0.0`;
- field `schema_version: "1.0.0"`; and
- `compatible_major: 1`.

The vectors use URN values ending in `1.0` and do not carry `schema_version` or
`compatible_major`. Vector 007 changes the URN suffix to `2.0`; it does not exercise the actual
schema package's `schema_version` and `compatible_major` fields. The intended unknown-major
behavior aligns conceptually, but the test object and version representation do not.

## 5. Per-vector crosswalk

### `W05-VEC-001` — valid single genesis

- **Schema target:** nearest is audit-ledger-record for the ledger and no exact schema for the
  ledger-head attestation; attestation-evidence is not structurally compatible.
- **Aligned:** fixed domain, genesis sequence, raw zero predecessor, lowercase UUID URN ledger ID,
  RFC 8785-safe fixture subset, SHA-256 framing calculation.
- **Mismatch:** event schema ID/version, record fields, `ACCEPT` decision, absent audit identities
  and dependency digests, absent in-record framing fields/hash, attestation schema/fields/domain
  registry/key-purpose ID/signature/identity.
- **Disposition:** byte construction reproduces; schema acceptance is not supported.

### `W05-VEC-002` — valid two-record chain

- **Schema target:** same as vector 001.
- **Aligned:** genesis plus immediate sequence 1; predecessor is the 32 raw bytes decoded from the
  genesis hash; object version increments; head attestation binds sequence 1 and successor hash.
- **Mismatch:** same record and attestation incompatibilities as vector 001. JSON Schema cannot
  prove sequence arithmetic or predecessor/hash linkage, and no separately authorized validator
  or chain verifier was run.
- **Disposition:** byte/chain derivation reproduces; schema and independent conformance remain
  unproved.

### `W05-VEC-003` — changed payload with stale claimed hash

- **Schema target:** binary/hash verification associated with audit-ledger-record and `IF-16` /
  `IF-17`, not JSON Schema alone.
- **Aligned:** changing `transition.to` changes the derived framed hash while the stale claimed
  genesis hash remains different; fail-closed rejection is required.
- **Mismatch:** `E_HASH_MISMATCH` exists in neither reason registry. The schema registry's nearest
  code is `E_INTEGRITY`; the shared contract has no exact integrity/hash-mismatch code and routes
  external ledger byte disagreement toward `E_AUDIT_DELIVERY` or checkpoint failure depending on
  boundary.
- **Disposition:** reject intent is correct; detecting boundary and exact ordered reason code are
  unresolved.

### `W05-VEC-004` — wrong ledger domain

- **Schema target:** audit-ledger-record fixes `framing_profile` to `AU-GPEP-EVENT-v1`; the schema
  negative fixture also uses `AU-GPEP-EVENT-v2`.
- **Aligned:** supplied binary domain is exactly `AU-GPEP-EVENT-v2` and must be rejected before
  interpreting it as the fixed B-03 event profile.
- **Mismatch:** `E_DOMAIN_MISMATCH` is absent from both reason registries. Interface routing offers
  `E_SCHEMA` or `E_UNKNOWN_REGISTRY`; the vector does not state which boundary owns the result.
- **Disposition:** negative condition is aligned; exact oracle is unregistered.

### `W05-VEC-005` — ambiguous unframed concatenation

- **Schema target:** pre-JSON binary framing parser; no JSON Schema can validate this byte stream.
- **Aligned:** omission of all required lengths cannot be accepted or guessed.
- **Mismatch:** `E_FRAMING_AMBIGUOUS` is absent from both reason registries. The interface contract
  routes malformed encoding/framing to `E_SCHEMA`; parser consumption/trailing-byte rules are not
  specified in a machine contract.
- **Disposition:** fail-closed intent is aligned; parser contract and exact reason are unresolved.

### `W05-VEC-006` — truncated framed input

- **Schema target:** pre-JSON binary framing parser.
- **Aligned:** declared record length is 348 bytes and only 347 are present; interpretation must
  stop before JSON/schema processing.
- **Mismatch:** `E_TRUNCATED_INPUT` is absent from both reason registries. The nearest interface
  code is `E_SCHEMA`; no adopted parser result schema fixes the detection stage or code.
- **Disposition:** fail-closed intent is aligned; exact oracle is unregistered.

### `W05-VEC-007` — attestation version mismatch

- **Schema target:** nearest is attestation-evidence, but the vector payload is not that schema's
  object and uses a different version representation.
- **Aligned:** unknown major versions fail closed under the schema README and interface matrix.
- **Mismatch:** vector expects `E_VERSION_UNSUPPORTED`; `common.schema.json` defines `E_VERSION`,
  while the shared contract/interface use `E_UNKNOWN_REGISTRY` or `E_SCHEMA`. The vector exercises
  URN `2.0`, not `schema_version: "2.0.0"` plus `compatible_major: 2`.
- **Disposition:** version-rejection intent is aligned; object shape, version fields, and exact
  reason are unresolved.

### `W05-VEC-008` — unauthorized key purpose

- **Schema target:** nearest is the common signature definition inside attestation-evidence.
- **Aligned:** the shared contract and interface matrix explicitly require `E_KEY_PURPOSE` for a
  purpose/signer-role mismatch and require rejection before treating the object as authorized.
- **Mismatch:** `E_KEY_PURPOSE` is absent from `common.schema.json`'s reason-code enum; vector
  purpose `general-signing` does not use the schema or contract key-purpose vocabulary; the
  purpose appears in a vector-local payload rather than the common `signature` object; no
  signature or verified signer identity exists.
- **Disposition:** strongest contract-level reason alignment of the six negatives, but still not
  representable by the schema reason-code type and not a cryptographic signature test.

## 6. Exact mismatch classes

1. **Ledger schema ID mismatch:** vector `urn:au-ucr:gpep:event:1.0` versus schema
   `urn:au-ucr:wave-0.5:schema:audit-ledger-record:1.0.0`.
2. **Ledger record-shape mismatch:** required audit fields are absent; vector fields are
   undeclared; `ACCEPT` is not an allowed audit decision.
3. **Hash-projection mismatch:** schema requires `record_hash` but does not define the
   `record_without_hash` projection needed to avoid self-reference.
4. **Framing-field placement mismatch:** ledger ID, sequence, and predecessor are external framing
   data in the vectors but required JSON fields in the audit schema.
5. **Attestation schema-family mismatch:** no exact ledger-head attestation schema exists;
   attestation-evidence models runtime producer evidence instead.
6. **Version representation mismatch:** vector URN `1.0`/`2.0` versus schema field
   `1.0.0` plus compatible major.
7. **Profile identifier mismatch:** canonicalization and framing labels are conceptually related
   but not identifier-equal or mapped by an adopted registry.
8. **Attestation domain gap:** `AU-RUNTIME-ATTEST-v1` is absent from the shared registry.
9. **Key-purpose vocabulary mismatch:** lower-case vector labels, upper-case schema enum, and
   `KP-*` contract IDs are not mapped.
10. **Reason-registry conflict:** the schema and shared contract expose different closed code
    sets; none of the six negative vector codes is consistently registered in both.
11. **Identity/signature evidence gap:** vector keys are examples without stable producer
    identity, assignment, authority chain, signature value, trust/revocation state, or verifier
    result.
12. **Common-envelope gap:** vector payloads and several record schemas do not implement the full
    `W05_INTERFACE_MATRIX` signed-envelope identity and registry bindings.

## 7. Authority, identity, and provenance reconciliation

The authority package records 10 open authority gaps, an unassigned Decision Chair, no governance
acceptance, and no exact-run release. It supplies no authority that could adopt the schemas,
register the vector domains/reason codes, authorize a signer, or convert example key IDs into
governed identities.

The shared contract requires stable subject/service identity, assignment and mandate chain,
effective interval, conflict/separation result, key issuer/purpose, revocation epoch, scope, and
consumer verification result. None is established by the vector examples. Possession of
`urn:au-ucr:key:runtime-attestation:example-01` would not itself establish a TMC identity or role.

The provenance specification requires immutable commit/tree/path binding, canonical publication
manifest, publication receipt, publisher authority, and remote reachability. The current vector,
schema, and contract artifacts remain mutable working-tree content. The reproduced bundle hash is
an exact current-byte observation, not a Git candidate, publication identity, adoption receipt,
or acceptance.

## 8. Blocking dependencies

Seven dependency classes block a reconciled or independently verified disposition:

1. **Schema selection and payload redesign:** choose an exact ledger-event schema and create an
   exact ledger-head attestation schema, or formally map the vectors to revised schemas.
2. **Hash projection and framing contract:** define which fields are inside canonical record
   bytes, which are external framing fields, and how `record_hash` is excluded and then attached.
3. **Adopted profile/domain registry:** map canonicalization/framing IDs and register the exact
   purpose-separated attestation domain.
4. **One closed reason-code registry:** reconcile schema and shared-contract enums, map all six
   vector failures, and define ordered validation precedence and detecting interface.
5. **Identity and cryptographic evidence:** establish purpose IDs, signer roles, assignments,
   trust roots, revocation, ES256 encoding, signatures, and authorized verification material.
6. **Authorized conformance and independent verification:** run an adopted JSON Schema/JCS/framing
   validator and obtain reproduction by an independently implemented generator/reviewer.
7. **Immutable publication and adoption authority:** freeze the exact package, publish its
   commit/tree/manifest identity, obtain QA/formal independent review, and secure candidate-bound
   adoption; current authority evidence cannot do so.

## 9. Reproduction check

Exact command run from repository root:

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/reproduce_vectors.py
```

Observed output:

```text
bundle_sha256=b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1
vectors=8
semantic_byte_checks=8
digest_checks=11
result=ALL_DERIVED_DIGESTS_REPRODUCED
```

Classification:

- current bundle byte/hash consistency: `DERIVED_SAME_AUTHOR_REPRODUCED`;
- JSON Schema conformance: `NOT VALIDATED`;
- general RFC 8785 conformance: `NOT INDEPENDENTLY VERIFIED`;
- ES256 signature validity: `NOT PRESENT / NOT VERIFIED`;
- contract adoption: `NONE`;
- immutable publication: `NONE`;
- independent generator/reviewer verification: `NOT SATISFIED`.

## 10. Reconciliation disposition

The current vectors remain useful deterministic byte fixtures. Their exact current bytes
reproduce, the fixed B-03 ledger domain is correct, and all six negative cases express appropriate
fail-closed intent. They are not schema fixtures for the newly produced schemas, their profile and
reason-code identifiers are not reconciled, and they carry no governed identity/signature or
publication authority.

Final disposition:

`8/8 CROSSWALKED -> BYTES REPRODUCED -> 0/8 DIRECT SCHEMA INSTANCES -> 12 MISMATCH CLASSES -> 7 BLOCKING DEPENDENCY CLASSES -> NOT INDEPENDENTLY VERIFIED -> NOT ADOPTED`
