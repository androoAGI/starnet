# Wave 0.5 Canonical Ledger and Attestation Vector Derivation — Registry 1.3.0 Final Pass

## Current control record

- **Task:** final narrow vector pass for `FOR-ACT-S0-001-W05-VECTORS`
- **Controlling design registry:** `urn:au-ucr:registry:wave-0.5-contract:1.3.0`
- **Vector family:** `urn:au-ucr:vector-bundle:ledger-attestation:1.0.0`
- **Scenario count:** 14
- **Positive scenarios:** 2
- **Negative scenarios:** 12
- **Required original scenarios preserved:** 8 of 8
- **Added design-level negatives:** 6
- **Status:** `REGISTRY_1_3_PROFILE_BOUND_DERIVED_NOT_VALIDATED_OR_CRYPTO_VERIFIED`

Registry 1.3.0 is authoritative within the proposed design for the seven-field ledger-head signing
projection, signature encoding profile, verification order, domains, key purpose, and rejection
reasons. This pass supersedes the Registry 1.2 vector bytes recorded in the historical correction
section below; it does not alter the schema, registry, contract, authority, or review artifacts.

## Authoritative ledger-head signing profile

Every generated ledger-head attestation binds:

- schema `urn:au-ucr:schema:ledger-head-attestation:1.0.0`;
- `signing_profile_id: PROFILE-LEDGER-HEAD-SIGNING-v1`;
- `algorithm_id: ALG-SIG-ES256-v1`;
- `canonicalization_id: CANON-JCS-RFC8785-v1`;
- `framing_id: FRAME-LEN-DOMAIN-v1`;
- `domain_id: DOMAIN-LEDGER-HEAD-ATTEST-v1`;
- exact 24-byte ASCII domain `AU-LEDGER-HEAD-ATTEST-v1`;
- envelope and nested signature purpose `KP-LEDGER-HEAD-ATTEST-v1`; and
- `signature_encoding_id: SIGENC-ES256-P1363-LOW-S-B64URL-v1`.

The authoritative `signing_payload` has exactly seven properties:

1. `envelope_binding`;
2. `ledger_id`;
3. `sequence`;
4. `head_hash`;
5. `policy_digest`;
6. `prior_checkpoint_ref`; and
7. `verified_at`.

`envelope_binding` includes every present envelope member except exactly `payload_digest` and
`signature`. Both final payload-digest locations equal SHA-256 of the restricted-JCS UTF-8
signing payload. The signature input remains:

`uint32be(24) || ASCII("AU-LEDGER-HEAD-ATTEST-v1") || uint64be(len(signing_payload_bytes)) || signing_payload_bytes`

The generated `signature_value` is unpadded base64url of exactly 64 P1363 bytes representing
synthetic `r=1, s=1`. Those integers satisfy width, range, and low-S shape, but the value is
deliberately not an ES256 signature over the input. No signing or verification operation was
performed.

## Bound verification order

Bundle metadata records the Registry 1.3.0 order:

1. framing and length bounds;
2. strict parse, schema, profile, and version;
3. interface, kind, algorithm, domain, and key purpose;
4. seven-field projection and both payload-digest comparisons;
5. signature encoding, resolved key/authority/trust, and replay;
6. ES256 over the exact framed input; and
7. ledger chain, policy, checkpoint, and freshness.

The vectors define expected detector interfaces, consumer decisions, and ordered reasons. They do
not execute this verification order.

## Current scenario inventory and oracles

The original required eight are preserved:

1. `W05-VEC-001` — valid genesis and ledger-head attestation: `ALLOW`, `IF-17`, no reasons.
2. `W05-VEC-002` — valid two-record chain and head attestation: `ALLOW`, `IF-17`, no reasons.
3. `W05-VEC-003` — changed payload/stale hash: `REJECT`, `SUSPEND`, `IF-16`,
   `E_HASH_MISMATCH`.
4. `W05-VEC-004` — wrong ledger domain: `REJECT`, `DENY`, `IF-16`,
   `E_DOMAIN_MISMATCH`.
5. `W05-VEC-005` — ambiguous framing: `REJECT`, `DENY`, `IF-16`,
   `E_FRAMING_AMBIGUOUS`.
6. `W05-VEC-006` — truncated input: `REJECT`, `DENY`, `IF-16`,
   `E_TRUNCATED_INPUT`.
7. `W05-VEC-007` — unsupported major version: `REJECT`, `BLOCK`, `IF-17`,
   `E_VERSION_UNSUPPORTED`.
8. `W05-VEC-008` — registered but unauthorized TMC key purpose: `REJECT`, `DENY`, `IF-17`,
   `E_KEY_PURPOSE`.

The six added design negatives are:

9. `W05-VEC-009` — sequence 2 directly after sequence 0: `REJECT`, `SUSPEND`, `IF-17`,
   `E_INTEGRITY`.
10. `W05-VEC-010` — competing record at the same predecessor and sequence: `REJECT`, `SUSPEND`,
    `IF-17`, `E_INTEGRITY`.
11. `W05-VEC-011` — sequence 1 with the wrong raw predecessor: `REJECT`, `SUSPEND`, `IF-17`,
    `E_HASH_MISMATCH`.
12. `W05-VEC-012` — attempted continuation reusing accepted sequence 1: `REJECT`, `SUSPEND`,
    `IF-17`, `E_INTEGRITY`.
13. `W05-VEC-013` — schema-shaped `SUPERSEDED -> IN_PROGRESS` transition: `REJECT`, `DENY`,
    `IF-15`, `E_TRANSITION`.
14. `W05-VEC-014` — exact accepted attestation object/nonce replay: `REJECT`, `DENY`, `IF-17`,
    `E_REPLAY`.

These are design oracles. No chain verifier, state-transition evaluator, replay store, schema
validator, or signature verifier was executed.

## Current derived results

- Bundle bytes: `204024`
- Bundle SHA-256:
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`
- Genesis record hash:
  `e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8`
- Successor record hash:
  `06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e`
- Single-head signature-input SHA-256:
  `9f73b04c40d924fcfa677231ce9b1289b725d1bf18e6f884eb2adbfe4368ea44`
- Chain-head signature-input SHA-256:
  `f93d688d9d9d6c59d88465cc0d16fbb58eb94f12f269d3cccc5ee784dee4be39`

## Current commands and outputs

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/derive_vectors.py
```

```text
output=W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json
vectors=14
direct_schema_instance_design_mappings=8
bytes=204024
sha256=b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52
genesis_record_hash=e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8
successor_record_hash=06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e
single_attestation_input_sha256=9f73b04c40d924fcfa677231ce9b1289b725d1bf18e6f884eb2adbfe4368ea44
chain_attestation_input_sha256=f93d688d9d9d6c59d88465cc0d16fbb58eb94f12f269d3cccc5ee784dee4be39
```

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/reproduce_vectors.py
```

```text
bundle_sha256=b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52
vectors=14
direct_schema_instance_design_mappings=8
semantic_byte_checks=15
digest_checks=22
signature_profile_checks=5
oracle_checks=14
result=ALL_REGISTRY_1_3_DERIVED_BYTES_REPRODUCED
```

The separate reproducer does not import the generator. It reconstructs the seven-field projection,
envelope inclusion/exclusion, restricted JCS bytes, length frames, payload/record hashes, P1363
width/range/low-S encoding shape, chain-negative conditions, and every scenario oracle.
Both programs remain authored and run in the same Agent B lineage, so this is same-author
reproduction, not independent verification.

## Remaining vector design and verification gaps

1. No JSON Schema validator or meta-validator accepted or rejected any object.
2. No generalized RFC 8785 conformance implementation was run beyond the documented restricted
   ASCII/string/integer fixture subset.
3. No ES256 key, signing operation, verification operation, trust-root evaluation, revocation
   check, or assignment verification exists.
4. The synthetic P1363 value proves only deterministic encoding shape; it is not a positive
   cryptographic signature vector.
5. No DER, padded-base64, standard-base64 alphabet, wrong-width, zero/out-of-range `r/s`, high-S,
   wrong-key, wrong-coverage, or altered-signature cryptographic negatives are executed; adding
   cryptographic expected-result vectors requires approved key material and authorization.
6. The 12 negative oracles are specified but no consumer implementation executed them.
7. Sequence, fork, predecessor, duplicate, transition, and replay behavior remains cross-record or
   stateful and cannot be established by JSON Schema alone.
8. No independently authored generator or effectively assigned reviewer reproduced the Registry
   1.3.0 bundle.
9. The vector/schema/registry bytes remain mutable and unpublished with no containing commit,
   publication receipt, adoption receipt, QA evidence, or candidate-bound review.
10. Synthetic identities, keys, assignment references, trust digests, and publication digests are
    not authority or provenance evidence; A09 remains unresolved, G3 closed, and G4 unauthorized.

Current classification:

`14 SCENARIOS -> 8 ORIGINAL + 6 CHAIN/STATE NEGATIVES -> REGISTRY 1.3.0 SIGNING PROFILE BOUND -> 15 SEMANTIC / 22 DIGEST / 5 SIGNATURE-PROFILE / 14 ORACLE CHECKS REPRODUCED -> NOT VALIDATED -> NOT ES256-VERIFIED -> NOT INDEPENDENTLY VERIFIED -> NOT ADOPTED`

# Appendix: Registry 1.2.0 correction record

The following section records the superseded Registry 1.2.0 bundle at SHA-256
`569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`.
It is historical and not the current vector oracle.

## Registry 1.2 corrected control record

- **Task:** correction stage for `FOR-ACT-S0-001-W05-VECTORS`
- **Controlling design registry:** `urn:au-ucr:registry:wave-0.5-contract:1.2.0`
- **Schema package consumed:** 35-schema F-04 correction package
- **Vector count:** 8
- **Status:** `REGISTRY_ALIGNED_DERIVED_DESIGN_VECTORS_NOT_VALIDATOR_EXECUTED`
- **Direct-schema-instance design mapping:** 8 schema-instance occurrences across 3 schema
  families and 5 valid logical objects
- **JSON Schema validation:** not executed
- **ES256 signing or verification:** not executed
- **Independent verification of corrected bytes:** not performed

This correction supersedes the pre-Registry 1.2.0 vector derivation recorded in the historical
appendix below. The historical hashes and profile names are retained only as an append-only design
trace and are not current vector expectations.

## Corrected schema and registry mapping

Valid ledger payloads use the exact
`urn:au-ucr:schema:governed-audit-event:1.0.0` `record_without_hash` projection:

- exactly the 25 required Registry Section 6 fields;
- `schema_version: "1.0.0"`;
- `interface_id: "IF-15"`;
- consumer decision `ALLOW`;
- empty ordered `reason_codes`;
- transaction outcome `COMMITTED`; and
- no `domain`, `ledger_id`, `sequence`, `prev_hash`, or `record_hash` inside JSON.

Each valid ledger payload is packaged by design as a direct instance of
`urn:au-ucr:schema:governed-audit-ledger-envelope:1.0.0`. External framing uses:

- framing ID `FRAME-GPEP-EVENT-v1`;
- exact 16-byte domain `AU-GPEP-EVENT-v1`;
- lowercase UUID URN ledger ID;
- external unsigned sequence;
- external 32-byte raw predecessor; and
- external derived SHA-256 record hash.

Valid attestations are shaped by design as direct instances of
`urn:au-ucr:schema:ledger-head-attestation:1.0.0` with:

- `interface_id: "IF-17"`;
- object type `LEDGER_HEAD_ATTESTATION`;
- canonicalization `CANON-JCS-RFC8785-v1`;
- algorithm `ALG-SIG-ES256-v1`;
- framing `FRAME-LEN-DOMAIN-v1`;
- domain ID `DOMAIN-LEDGER-HEAD-ATTEST-v1`;
- exact ASCII domain `AU-LEDGER-HEAD-ATTEST-v1`; and
- key purpose `KP-LEDGER-HEAD-ATTEST-v1` in both envelope and nested signature.

The eight direct-schema-instance mappings are:

1. vector 001 governed-event payload;
2. vector 001 external ledger envelope;
3. vector 001 ledger-head attestation;
4. vector 002 genesis governed-event payload;
5. vector 002 genesis external ledger envelope;
6. vector 002 successor governed-event payload;
7. vector 002 successor external ledger envelope; and
8. vector 002 ledger-head attestation.

The three schema families counted are governed audit event, governed audit ledger envelope, and
ledger-head attestation. These eight schema instances represent five logical objects: three
ledger records and two attestations. Repeated genesis occurrence in vector 002 is counted because
the count is of occurrences, not unique payload values.

“Direct instance by design” means field names, required fields, closed vocabularies, and object
shape were manually generated from the corrected schemas. It is not a validator result or a
schema-conformance claim.

## Corrected scenario and oracle mapping

1. `W05-VEC-001`: valid genesis plus ledger-head attestation; technical result `ALLOW`,
   consumer decision `ALLOW`, detector `IF-17`, empty reasons.
2. `W05-VEC-002`: valid genesis/successor chain plus head attestation; technical result `ALLOW`,
   consumer decision `ALLOW`, detector `IF-17`, empty reasons.
3. `W05-VEC-003`: changed schema-shaped payload with stale claimed hash; technical result
   `REJECT`, consumer decision `SUSPEND`, detector `IF-16`, reason `E_HASH_MISMATCH`.
4. `W05-VEC-004`: wrong ledger domain; `REJECT`, `DENY`, `IF-16`,
   `E_DOMAIN_MISMATCH`.
5. `W05-VEC-005`: ambiguous unframed bytes; `REJECT`, `DENY`, `IF-16`,
   `E_FRAMING_AMBIGUOUS`.
6. `W05-VEC-006`: truncated framed bytes; `REJECT`, `DENY`, `IF-16`,
   `E_TRUNCATED_INPUT`.
7. `W05-VEC-007`: unsupported ledger-head schema major; `REJECT`, `BLOCK`, `IF-17`,
   `E_VERSION_UNSUPPORTED`.
8. `W05-VEC-008`: registered but unauthorized `KP-TMC-RUNTIME-v1` substituted for the required
   ledger-head purpose; `REJECT`, `DENY`, `IF-17`, `E_KEY_PURPOSE`.

These are exact Registry 1.2.0 identifiers and ordered single-cause oracles. The negative vectors
specify expected behavior; no rejection implementation was executed.

## Corrected signature-input definition

The corrected ledger-head schema requires both `payload_digest` and `signature`, but Registry
1.2.0 does not specify a non-self-referential signed-payload projection for the complete
ledger-head object. The vectors therefore explicitly specify this design projection:

`signing_payload = { envelope_binding_without_payload_digest_or_signature, ledger_id, sequence, head_hash, policy_digest, prior_checkpoint_ref, verified_at }`

`signing_payload_bytes = UTF-8(RFC8785-JCS(signing_payload))`

`payload_digest = SHA-256(signing_payload_bytes)`

`signature_input = len32(domain) || domain || len64(signing_payload_bytes) || signing_payload_bytes`

The generated schema-shaped object places that payload digest in both required locations. Its
`signature_value` is the explicit non-cryptographic sentinel
`UNVERIFIED-SYNTHETIC-ES256-VALUE`. This satisfies the proposed schema's string shape by design,
but it is not an ES256 signature and must never be treated as one.

This projection is `VECTOR_SPECIFIED_NOT_REGISTRY_ADOPTED`. Adoption of an exact signed-payload
projection and ES256 encoding profile remains a material verification dependency.

## Corrected derived results

- Bundle bytes: `132370`
- Bundle SHA-256:
  `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`
- Genesis record hash:
  `e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8`
- Successor record hash:
  `06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e`
- Single-head attestation input SHA-256:
  `0f43dabb96be2ad7bd52fd1ae9b4e4d0dac0696255693fa16e227c71f0e2786e`
- Chain-head attestation input SHA-256:
  `0f6808d9bd0c976ace5d0055f68bddbb41775392a3f9ab35a600c91d8d784598`

## Corrected exact commands and outputs

The compatibility entry points delegate to the Registry 1.2.0 implementations. Commands were run
from repository root:

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/derive_vectors.py
```

Observed output:

```text
output=W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json
vectors=8
direct_schema_instance_design_mappings=8
bytes=132370
sha256=569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692
genesis_record_hash=e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8
successor_record_hash=06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e
single_attestation_input_sha256=0f43dabb96be2ad7bd52fd1ae9b4e4d0dac0696255693fa16e227c71f0e2786e
chain_attestation_input_sha256=0f6808d9bd0c976ace5d0055f68bddbb41775392a3f9ab35a600c91d8d784598
```

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/reproduce_vectors.py
```

Observed output:

```text
bundle_sha256=569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692
vectors=8
direct_schema_instance_design_mappings=8
semantic_byte_checks=9
digest_checks=15
result=ALL_REGISTRY_1_2_DERIVED_BYTES_REPRODUCED
```

The reproducer does not import the generator. It independently reassembles restricted JCS bytes,
ledger frames, signature-input frames, payload digests, and expected object projections.
Nevertheless, both corrected programs were authored and run in the same Agent B correction lane.
The result is a same-author consistency reproduction, not independent verification. F-04's prior
independent recomputation applies only to the superseded bundle hash and cannot verify these new
bytes.

The corrected schema documents were also JSON-parsed without schema evaluation:

```text
python -c 'import json,pathlib; p=pathlib.Path("docs/experiments/au-ucr-ep-000001/wave-0.5/schemas"); fs=sorted(p.glob("*.schema.json")); docs=[json.loads(f.read_text(encoding="utf-8")) for f in fs]; ids=[d["$id"] for d in docs]; print(f"schema_documents_parsed={len(fs)}"); print(f"unique_schema_ids={len(set(ids))}"); print("classification=JSON_PARSE_ONLY_NOT_SCHEMA_VALIDATION")'
```

Observed output:

```text
schema_documents_parsed=35
unique_schema_ids=35
classification=JSON_PARSE_ONLY_NOT_SCHEMA_VALIDATION
```

## Exact remaining limits

- No JSON Schema validator or meta-validator was run.
- No claim is made that any object was validator-accepted.
- No generalized RFC 8785 implementation or conformance suite was run; fixtures remain in the
  restricted ASCII/string/integer subset.
- No ES256 signature was generated or verified.
- The signature sentinel is structurally shaped test data only.
- The signing-payload projection is vector-specified and not yet registry-adopted.
- JSON Schema cannot establish ledger sequence arithmetic, predecessor linkage, hash correctness,
  time ordering, identity equality, assignment validity, replay consumption, or key authority.
- Synthetic `urn:example:` identities, assignments, keys, trust digests, and publication digests
  are not authority or provenance evidence.
- No immutable containing commit, publication receipt, adoption receipt, QA result, or independent
  review exists for the corrected bytes.
- Independent implementation/reviewer reproduction of the corrected bundle remains outstanding.
- Existing authority holds remain: Decision Chair unassigned, A09 unresolved, G3 closed by
  dependency, and G4 not authorized.

Current classification:

`REGISTRY 1.2.0 IDENTIFIERS ALIGNED -> 8 DIRECT-INSTANCE DESIGN MAPPINGS / 5 LOGICAL OBJECTS -> BYTES SAME-AUTHOR REPRODUCED -> NOT VALIDATOR-EXECUTED -> NOT CRYPTOGRAPHICALLY VERIFIED -> NOT INDEPENDENTLY VERIFIED -> NOT ADOPTED`

# Appendix: superseded pre-correction derivation record

The following content records the prior vector generation at bundle SHA-256
`b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1`. It is not the current
oracle after Registry 1.2.0 correction.

## Historical control record

- **Task:** `FOR-ACT-S0-001-W05-VECTORS`
- **Role:** Wave 0.5 Agent B
- **Repository baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Authorization:** design documents and non-destructive byte/hash inspection only
- **Status:** `DERIVED DESIGN FIXTURES — NOT INDEPENDENTLY VERIFIED OR ADOPTED`
- **Vector bundle:** `W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`
- **Vector count:** 8
- **Generator:** `derive_vectors.py`
- **Separate reproducer:** `reproduce_vectors.py`

No project/runtime test, dependency installation, schema validation, ES256 signing or verification,
implementation, commit, push, publication, merge, acceptance, or execution occurred. Both Python
programs were prepared and run by the same Agent B activity. Agreement between them is a
`DERIVED` consistency check, not independent verification or conformance evidence.

## 2. Normative source and local specifications

The ledger framing is taken from corrected Wave 0.4 B-03:

`len32(domain) || domain || len32(ledger_id) || ledger_id || uint64be(sequence) || len32(prev_hash) || prev_hash || len64(record_bytes) || record_bytes`

The signature-input framing is taken from A-04/B-03:

`len32(domain) || domain || len64(payload_bytes) || payload_bytes`

All integers are unsigned big-endian. SHA-256 is applied to the complete framed input.

The following values are `SPECIFIED` by corrected B-03:

- ledger domain: exactly 16 ASCII bytes `AU-GPEP-EVENT-v1`;
- domain hex: `41552d475045502d4556454e542d7631`;
- `len32(domain)`: `00000010`;
- genesis sequence: `0000000000000000`;
- genesis predecessor: 32 raw zero bytes;
- successor predecessor: 32 raw bytes decoded from the predecessor's lowercase hexadecimal hash;
- record bytes: UTF-8 RFC 8785 JCS of `record_without_hash`.

The vector-local ledger ID and version identifiers are `SPECIFIED_PROVISIONAL` design values:

- ledger ID: `urn:uuid:11111111-1111-4111-8111-111111111111`;
- bundle: `urn:au-ucr:gpep:vectors:1.0`;
- ledger framing: `urn:au-ucr:gpep:ledger-framing:1.0`;
- event schema: `urn:au-ucr:gpep:event:1.0`;
- attestation schema: `urn:au-ucr:runtime:attestation:1.0`;
- signature framing: `urn:au-ucr:signature-framing:1.0`;
- attestation signature domain: `AU-RUNTIME-ATTEST-v1`.

The attestation domain and all version IDs require reconciliation and adoption through the Agent A
schema contract and Agent C shared cryptographic/domain registry. They are not asserted to be
existing governance contracts.

## 3. RFC 8785 JCS assumptions

The fixtures intentionally use a JCS-safe subset: JSON objects, arrays, ASCII property names and
string values, booleans if introduced, and non-negative integers within the interoperable integer
range. They contain no floating-point values, negative zero, duplicate keys, Unicode normalization
cases, unpaired surrogates, BOM, `NaN`, or infinity.

For this restricted subset, Python `json.dumps` with `sort_keys=True`,
`separators=(",", ":")`, `ensure_ascii=False`, `allow_nan=False`, followed by UTF-8 encoding,
produces the required JCS bytes. This is a derivation assumption, not a claim that Python's standard
JSON encoder is a general RFC 8785 implementation. A future conforming JCS implementation must
independently reproduce every published payload byte.

## 4. Vector inventory and expected disposition

1. `W05-VEC-001` — valid single genesis record and its attestation signature input: `ACCEPT` for
   ledger and signature-input construction only.
2. `W05-VEC-002` — valid genesis plus immediate successor chain and head attestation input:
   `ACCEPT` for ledger and signature-input construction only.
3. `W05-VEC-003` — changed payload retaining the genesis claimed hash: reject
   `E_HASH_MISMATCH`.
4. `W05-VEC-004` — ledger framed with `AU-GPEP-EVENT-v2`: reject `E_DOMAIN_MISMATCH`.
5. `W05-VEC-005` — concatenated fields with all length prefixes removed: reject
   `E_FRAMING_AMBIGUOUS`.
6. `W05-VEC-006` — valid genesis framed input truncated by one payload byte: reject
   `E_TRUNCATED_INPUT`.
7. `W05-VEC-007` — otherwise framed attestation declaring unsupported schema version `2.0`:
   reject `E_VERSION_UNSUPPORTED` before signature verification.
8. `W05-VEC-008` — attestation declaring `general-signing` rather than
   `runtime-attestation` key purpose: reject `E_KEY_PURPOSE` before signature verification.

The positive attestation fixtures define canonical payload bytes, framed signature-input bytes and
their SHA-256 digests. They do not contain ES256 signature values and therefore do not establish a
cryptographically valid signed attestation. The unauthorized-signature fixture deliberately has no
signature bytes because purpose authorization must fail before cryptographic verification; it is a
policy-layer fixture, not a malformed-signature fixture.

Reason-code names are `SPECIFIED_PROVISIONAL`. Agent A schemas must define validation order and
Agent C must adopt or map the shared reason-code registry.

## 5. Derived canonical results

The first record's complete framed input hashes to:

`f2b8d64cc6e3f50a8af46f37ff35d9843708649ff37bfbd4f00354086f18ddf9`

The successor frames that digest as 32 raw predecessor bytes and hashes to:

`985f9c99648478643c886f5d42fe11f2fa0b43a666e528f9de0f8430be02ff2d`

The single-record attestation signature input hashes to:

`6e5c1474a899f1986e42aa58522b398e9bd7e955bf8e5102bdf893275238f180`

The two-record head attestation signature input hashes to:

`cb29e2ea4c7624e57714a24f069d60af7eae972b9510b615e0a83989023c0685`

The exact LF UTF-8 JSON bundle is 29,306 bytes and hashes to:

`b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1`

Every record payload, payload length, domain and ledger-ID byte sequence, encoded length, sequence,
raw predecessor, complete preimage, and expected digest is present in the machine-readable bundle.

## 6. Exact commands and observed outputs

Commands were run from repository root with the available Python standard library only.

```text
python docs/experiments/au-ucr-ep-000001/wave-0.5/vectors/derive_vectors.py
```

Observed output:

```text
output=W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json
vectors=8
bytes=29306
sha256=b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1
genesis_record_hash=f2b8d64cc6e3f50a8af46f37ff35d9843708649ff37bfbd4f00354086f18ddf9
successor_record_hash=985f9c99648478643c886f5d42fe11f2fa0b43a666e528f9de0f8430be02ff2d
single_attestation_input_sha256=6e5c1474a899f1986e42aa58522b398e9bd7e955bf8e5102bdf893275238f180
chain_attestation_input_sha256=cb29e2ea4c7624e57714a24f069d60af7eae972b9510b615e0a83989023c0685
```

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

The second command reads only the published JSON and independently reimplements restricted JCS
serialization, integer framing, byte assembly, and digest traversal without importing the
generator. Because the same agent authored and executed both programs, the result remains
`DERIVED`, not `INDEPENDENTLY VERIFIED`.

## 7. Classification

- Framing formulas and fixed ledger domain from corrected B-03: `SPECIFIED`.
- Provisional vector identifiers, attestation domain, schema versions and reason codes:
  `SPECIFIED_PROVISIONAL`.
- Exact bytes and SHA-256 values emitted by the generator: `DERIVED`.
- Reproduction by the second local program: `DERIVED_SAME_AGENT_CONSISTENCY_CHECK`.
- RFC 8785 general conformance: `NOT VERIFIED`.
- Schema conformance: `NOT VALIDATED`.
- ES256 signature validity: `NOT GENERATED / NOT VERIFIED`.
- Independent generator comparison required by B-03: `NOT SATISFIED`.
- Governance adoption, QA, acceptance, publication and execution: `NONE`.

## 8. Agent A and Agent C dependencies

Agent A schema work must:

- adopt or map the event and attestation schema/version IDs;
- constrain the exact fields, types, lengths, timestamp profile, unknown-field behavior and JCS
  preconditions represented by these fixtures;
- define parser validation order for domain, framing, truncation, schema version, key purpose and
  hash comparison;
- confirm whether `record_without_hash` is the exact schema-level hash projection; and
- publish positive/negative schema fixtures whose canonical bytes match this bundle.

Agent C shared-contract work must:

- adopt or replace `AU-RUNTIME-ATTEST-v1` in a purpose-separated ASCII domain registry;
- adopt ES256, SHA-256, key purposes and signature encoding;
- define signer authorization, trust-store and revocation semantics;
- adopt or map the provisional reason codes;
- supply authorized test key material and cryptographic signature vectors if later authorized; and
- resolve whether attestation signatures cover the payload framing exactly as specified here.

Until those contracts are adopted and an independently implemented generator reproduces the bytes,
`W05-OBJ-02` and `W05-OBJ-09` are at most
`DESIGN ADDRESSED — VERIFICATION PENDING`; this artifact does not close either objection.
