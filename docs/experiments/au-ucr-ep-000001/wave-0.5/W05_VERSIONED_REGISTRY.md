# Wave 0.5 Versioned Contract Registry

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-CONTRACT`, F-04 correction
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `W05_VERSIONED_REGISTRY`
- **Registry ID:** `urn:au-ucr:registry:wave-0.5-contract`
- **Registry version:** `1.3.0`
- **Supersedes:** `urn:au-ucr:registry:wave-0.5-contract:1.2.0`
- **Repository baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Design status:** `AUTHORITATIVE_WITHIN_WAVE_0.5_PROPOSED_DESIGN`
- **Adoption status:** `NOT_ADOPTED`
- **Publication status:** `UNPUBLISHED_WORKING_TREE`
- **Demonstrated enforcement:** `NONE`
- **Acceptance / execution effect:** `NONE / NONE`

This registry is the single authoritative **design mapping** for names and compatibility among
`W05_SHARED_TRUST_AND_STATE_CONTRACT.md`, `W05_INTERFACE_MATRIX.md`, the current 35-schema
proposal, and the current one-family/fourteen-scenario/six-file vector proposal. It records the
post-correction contract state while preserving F-04 and Wave 2 reports as historical records.

“Authoritative within proposed design” means any later Wave 0.5 revision must retain these
identifiers and semantics or explicitly supersede this registry. It does not mean the registry,
schemas, vectors, authority records, or provenance records are adopted, published, implemented,
validator-executed, cryptographically verified, accepted, or operationally enforced.

## 2. Registry precedence and compatibility

For Wave 0.5 design interpretation, precedence is:

1. this registry for identifiers, aliases, decisions, reason ordering, audit projection, and
   interface/profile assignment;
2. `W05_SHARED_TRUST_AND_STATE_CONTRACT.md` for ownership, trust, state, and authority semantics;
3. `W05_INTERFACE_MATRIX.md` for producer/consumer boundaries and required inputs/outputs;
4. exact A-04/B-03 framing requirements;
5. existing schema/vector literals only where mapped below.

An unmapped literal is `UNKNOWN`, never a nearest-name match. Unknown, ambiguous, incompatible,
or deprecated-without-an-allowed-alias input fails closed with `E_UNKNOWN_REGISTRY` and default
decision `BLOCK`.

Compatibility rules:

- Registry IDs and canonical IDs are exact, case-sensitive ASCII.
- Semantic versions use `MAJOR.MINOR.PATCH`.
- Same-major minor/patch compatibility is permitted only when a registry entry expressly says
  `BACKWARD_COMPATIBLE`; absence means incompatible.
- Any field removal, meaning change, enum contraction, hash projection change, or framing change
  requires a new major version.
- Aliases are accepted only at the detector interface and only until the listed removal version.
- Deprecated aliases are recorded in audit output using canonical IDs; original input spelling is
  preserved as evidence.
- No alias may convert technical `ALLOW` into governance `ACCEPTED`.

## 3. Canonical schema IDs and versions

### 3.1 Naming rule

Canonical schema document IDs are:

`urn:au-ucr:schema:<profile-name>:<MAJOR.MINOR.PATCH>`

The schema family ID omits the version:

`urn:au-ucr:schema:<profile-name>`

The exact schema version for this registry is `1.0.0` unless noted. A schema document is not
published merely because this registry reserves its ID.

### 3.2 Current schema proposal inventory

The current schema directory contains **35** `*.schema.json` files. Read-only identifier
inspection shows that each file now uses the canonical `urn:au-ucr:schema:*:1.0.0` family. This
is a current membership and identifier observation, not schema validation or adoption.

| Current family | Count | Present canonical profiles | Design disposition |
| --- | ---: | --- | --- |
| Shared/support | 4 | `common-envelope`, `authority-object-base`, `profile-receipt`, `nested-candidate-manifest` | `PRESENT_CORRECTED_DESIGN` |
| Purpose-specific authority/lifecycle | 13 | assignment, acknowledgement, separation, QA, independent review, findings closure, A09, G3, G4 release, authority revocation, rollback authorization, rollback receipt, reinstatement | `PRESENT_CORRECTED_DESIGN` |
| Interface/runtime/audit | 18 | transition result, candidate review package, ARM, runtime attestation, effective configuration, platform result, model statement, verifier challenge/verdict, session binding, inference, governed event/envelope, outbox, ledger head, anchor, reconciliation, revocation snapshot | `PRESENT_CORRECTED_DESIGN` |
| **Total** | **35** | closed current schema file set | `PRESENT_NOT_VALIDATED_NOT_ADOPTED` |

The purpose-specific files inspected after Registry 1.2.0 use the separated Section 8 purposes,
including challenge versus verdict, model endpoint statement, acknowledgement, findings closure,
A09 versus G3, G4, authority revocation versus revocation snapshot, rollback authorization versus
receipt, and reinstatement. Presence and literal alignment do not prove full-document
conformance, reference resolution, consumer enforcement, cryptographic validity, or authority.

### 3.3 Current vector family

The current vector directory contains **6 files** supporting **1 canonical family**,
`urn:au-ucr:vector-bundle:ledger-attestation:1.0.0`, with **14 scenarios**: **2 positive** and
**12 negative**. The current bundle file SHA-256 is
`b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. Its current literals name
`governed-audit-event`, `governed-audit-ledger-envelope`, and `ledger-head-attestation` canonical
schema IDs. Historical vector IDs and older scenario/file counts remain evidence of prior
snapshots only and are not current aliases.

## 4. Interface ID registry

Interface IDs are the exact closed set `IF-01` through `IF-22`. Their meanings are fixed by
`W05_INTERFACE_MATRIX.md`; reuse for another producer/consumer boundary requires a new major
registry version.

| ID | Canonical input profile | Canonical output profile | Design status |
| --- | --- | --- | --- |
| `IF-01` | mandate/delegation evidence | `assignment-receipt` | `DESIGN_ALIGNED` |
| `IF-02` | publication + QA + review + closure evidence | `candidate-review-package` | `DESIGN_ALIGNED` |
| `IF-03` | candidate review + assignment + challenge/status; then accepted A09 + still-valid typed prerequisites | separate `a09-decision`; later separate `g3-acceptance` | `DESIGN_ALIGNED` |
| `IF-04` | valid G3 acceptance + accepted A09 + exact run/dependencies | `execution-release` / `G4_EXACT_RUN_RELEASE` | `DESIGN_ALIGNED` |
| `IF-05` | publication + A09 + release + registries | `approved-runtime-manifest` | `DESIGN_ALIGNED` |
| `IF-06` | verifier policy/channel/time | `verifier-challenge` under `KP-VERIFIER-CHALLENGE-v1` | `DESIGN_ALIGNED` |
| `IF-07` | ARM component handles + precedence | `effective-configuration-measurement` | `DESIGN_ALIGNED` |
| `IF-08` | challenge + ARM + platform/config/model evidence | `runtime-attestation-evidence` kind `LAUNCH` | `DESIGN_ALIGNED` |
| `IF-09` | enrollment + quote + lifecycle | `platform-verification-result` | `DESIGN_ALIGNED` |
| `IF-10` | request/model/endpoint/provider evidence | `model-endpoint-statement` under `KP-MODEL-ENDPOINT-STATEMENT-v1` | `DESIGN_ALIGNED` |
| `IF-11` | IF-05/08/09/10 evidence + trust snapshots | `verifier-verdict` | `DESIGN_ALIGNED` |
| `IF-12` | verifier challenge + active runtime state | `runtime-attestation-evidence` kind `LIVENESS` | `DESIGN_ALIGNED` |
| `IF-13` | admitted request/output commitments | `inference-receipt` | `DESIGN_ALIGNED` |
| `IF-14` | untrusted mutation request | `transition-request-result` or intake denial | `DESIGN_ALIGNED` |
| `IF-15` | accepted IF-14 request + locked state/dependencies | state + `governed-audit-event` + outbox atomically | `DESIGN_ALIGNED` |
| `IF-16` | committed outbox bytes using Section 6 projection | `outbox-delivery` | `DESIGN_ALIGNED` |
| `IF-17` | WORM chain/head + prior checkpoint | `ledger-head-attestation` + `anchor-checkpoint` | `DESIGN_ALIGNED` |
| `IF-18` | state/event/outbox/WORM/checkpoint sets | `reconciliation-result` | `DESIGN_ALIGNED` |
| `IF-19` | authorized trust/key lifecycle change | `revocation-snapshot` / trust-store snapshot | `DESIGN_ALIGNED` |
| `IF-20` | policy trigger or rollback quorum + target | `rollback-plan` | `DESIGN_ALIGNED` |
| `IF-21` | authorized rollback plan + verified target | new state/event/outbox + `rollback-receipt` | `DESIGN_ALIGNED` |
| `IF-22` | corrected evidence + QA/review/release/A09 as required | `reinstatement-receipt` | `DESIGN_ALIGNED` |

All 22 statuses are design-only. Every interface is operationally
`BLOCKED_BY_ADOPTION_AND_IMPLEMENTATION`.

## 5. Decision vocabularies

### 5.1 Consumer boundary decision

The exact enum is:

`ALLOW | DENY | SUSPEND | REVOKE | BLOCK | NO_MUTATION`

- `ALLOW`: all checks passed for the bounded action; it is not governance acceptance.
- `DENY`: request/evidence failed and the attempted action is rejected.
- `SUSPEND`: previously active scope is made inactive pending adjudication/recovery.
- `REVOKE`: authority/key/release/session/object is terminally invalidated for new action.
- `BLOCK`: prerequisite is absent, unknown, ambiguous, unavailable, or not yet satisfied.
- `NO_MUTATION`: no authoritative state change occurred, including intake rejection or orphan
  retention.

### 5.2 Separate non-interchangeable vocabularies

- Governance outcome: `ACCEPTED | REVISE | REJECTED`.
- Technical vector expectation: `ALLOW | REJECT`.
- Transaction outcome: `COMMITTED | ROLLED_BACK | REJECTED_PRE_TRANSACTION`.
- External record classification: `ORPHAN_REJECTED | MISSING_EXTERNAL | MATCHED | CONFLICT`.

Deprecated vector/schema aliases:

| Alias | Canonical value | Rule |
| --- | --- | --- |
| vector `expected.result: ACCEPT` | technical expectation `ALLOW` | Allowed only when regenerating construction vectors; never maps to governance `ACCEPTED` |
| historical vector/audit `decision: ACCEPT` | consumer `ALLOW` | Historical input only; current bundle uses `ALLOW`; new inputs reject after the closed migration window |
| audit `ORPHAN_REJECTED` as decision | decision `NO_MUTATION` plus external classification `ORPHAN_REJECTED` | Split fields; no direct decision alias after registry 1.x |

## 6. Authoritative audit event and hash projection

### 6.1 One event schema

The sole canonical event schema is:

`urn:au-ucr:schema:governed-audit-event:1.0.0`

The event has two layers:

1. `record_without_hash`: the JSON object below; and
2. ledger framing metadata and derived hash outside JSON.

There is no self-referential JSON `record_hash`. The full logical delivered record may package
the JSON payload with external framing fields, but only `record_without_hash` is canonicalized as
`record_bytes`.

### 6.2 Exact `record_without_hash` projection

The JSON object SHALL contain exactly these required properties:

1. `schema_id` = `urn:au-ucr:schema:governed-audit-event:1.0.0`
2. `schema_version` = `1.0.0`
3. `event_id`
4. `actor_id`
5. `interface_id` = `IF-15`
6. `interface_inventory_id`
7. `object_id`
8. `prior_object_version`
9. `new_object_version`
10. `requested_transition`
11. `from_status`
12. `to_status`
13. `decision`
14. `reason_codes`
15. `policy_digest`
16. `schema_bundle_digest`
17. `algorithm_registry_digest`
18. `dependency_registry_digest`
19. `reason_registry_digest`
20. `evidence_bundle_digest`
21. `workload_identity`
22. `transaction_outcome`
23. `idempotency_key`
24. `correlation_id`
25. `trusted_receipt_time`

These conditionally required properties SHALL be included when the governed action is bound to
the corresponding scope:

- `publication_manifest_digest`
- `a09_receipt_digest`
- `execution_release_digest`
- `run_id`
- `session_id`
- `extensions`

No other property is permitted. `null` is not permitted. Inapplicable conditional properties are
omitted. A governed event exists only after the state/event/outbox transaction commits, so
`decision` SHALL be `ALLOW`, `transaction_outcome` SHALL be `COMMITTED`, and `reason_codes`
SHALL be empty. Pre-transaction denials, blocked requests, and rolled-back transaction attempts
are recorded in the intake/attempt ledger under their detecting interface and are not inserted
into the authoritative governed-event chain.

### 6.3 Fields outside JSON

These framing fields SHALL NOT appear in `record_without_hash`:

- `domain` = exact 16 ASCII bytes `AU-GPEP-EVENT-v1`;
- `ledger_id` = UTF-8 lowercase UUID URN bytes;
- `sequence` = unsigned 64-bit integer;
- `prev_hash` = exactly 32 raw bytes; and
- `record_hash` = the resulting 32-byte SHA-256.

`record_bytes = UTF-8(RFC8785-JCS(record_without_hash))`.

The complete hash preimage remains:

`len32(domain) || domain || len32(ledger_id) || ledger_id || uint64be(sequence) || len32(prev_hash) || prev_hash || len64(record_bytes) || record_bytes`

All lengths are unsigned big-endian. Genesis uses `sequence = 0` and 32 zero `prev_hash` bytes.
A successor uses predecessor sequence plus one and the predecessor `record_hash` decoded to 32
raw bytes. Textual hex is never framed as `prev_hash`.

### 6.4 Current correction status

The current audit payload schema, external ledger-envelope schema, and canonical vector family
use the payload/framing split, canonical schema IDs, `ALLOW`, purposes, domains, and reason codes
described above. That literal/design agreement resolves the current IF-15 contract conflict. It
does not establish validator conformance, negative consumer execution, cryptographic
verification, adoption, or publication.

## 7. Algorithm, canonicalization, and framing registry

| Canonical ID | Exact meaning | Existing aliases | Alias status |
| --- | --- | --- | --- |
| `ALG-HASH-SHA256-v1` | SHA-256 producing 32 bytes | `SHA-256` | accepted input alias through registry 1.x |
| `ALG-SIG-ES256-v1` | ECDSA P-256/SHA-256 | `ES256` | accepted input alias through registry 1.x; encoding is fixed per signing profile |
| `CANON-JCS-RFC8785-v1` | RFC 8785 JCS, UTF-8 bytes, after strict duplicate-key/schema checks | `RFC8785-JCS-UTF8`, `RFC8785-JCS` | accepted aliases through registry 1.x |
| `FRAME-LEN-DOMAIN-v1` | `len32(domain)||domain||len64(payload)||payload` | `urn:au-ucr:signature-framing:1.0` | deprecated alias; remove in registry 2.0 |
| `FRAME-GPEP-EVENT-v1` | exact B-03 framing in Section 6 | `AU-GPEP-EVENT-v1`, `urn:au-ucr:gpep:ledger-framing:1.0` | domain literal and deprecated profile alias |
| `SIGENC-ES256-P1363-LOW-S-B64URL-v1` | exactly 64 raw bytes `r || s`, each 32-byte unsigned big-endian; `1 <= r,s < n`; low-S `s <= n/2`; base64url without padding in `signature_value` | none | design encoding for Section 7.1; DER and padded/base64 variants reject |
| `PROFILE-LEDGER-HEAD-SIGNING-v1` | exact non-self-referential IF-17 projection in Section 7.1 | vector-local Registry 1.2 projection | now authoritative within proposed design |
| `DOMAIN-TMC-RUNTIME-v1` | exact ASCII `AU-TMC-RUNTIME-v1` for IF-08/12/13 signed TMC evidence | `AU-RUNTIME-ATTEST-v1` | no alias: old value is reassigned away from runtime use |
| `DOMAIN-LEDGER-HEAD-ATTEST-v1` | exact 24 ASCII bytes `AU-LEDGER-HEAD-ATTEST-v1` for IF-17 ledger-head attestation | historical `AU-RUNTIME-ATTEST-v1` | historical source is not a current alias |

The current vector family uses the canonical IF-17 schema, domain, framing, and key purpose. Its
signature value remains an explicitly synthetic sentinel, so the family is not cryptographic
verification evidence.

### 7.1 Authoritative ledger-head signing projection

The versioned signing profile is `PROFILE-LEDGER-HEAD-SIGNING-v1`. It applies only to
`urn:au-ucr:schema:ledger-head-attestation:1.0.0` at `IF-17`.

#### Exact inclusion and exclusion

`signing_payload` is an object with exactly these seven properties:

1. `envelope_binding`;
2. `ledger_id`;
3. `sequence`;
4. `head_hash`;
5. `policy_digest`;
6. `prior_checkpoint_ref`; and
7. `verified_at`.

`envelope_binding` contains every member present in the schema-valid `envelope` except exactly
`payload_digest` and `signature`. The baseline required members therefore include
`contract_status`, `schema_id`, `schema_version`, `object_type`, `object_id`, `event_id`,
`interface_id`, `producer_id`, `producer_role`, `producer_assignment_ref`, `algorithm_id`,
`key_purpose_id`, `canonicalization_id`, `framing_id`, `domain_id`, `issued_at`, `not_before`,
`expires_at`, `authority_counter`, `previous_event_digest`, `audience`, `environment`,
`repository_id`, `candidate_commit`, `publication_manifest_digest`, `policy_digest`,
`schema_bundle_digest`, `algorithm_registry_digest`, `dependency_registry_digest`,
`reason_registry_digest`, `revocation_epoch`, and `nonce`. Any schema-allowed optional envelope
member that is present is also included; no present member other than the two exact exclusions
may be dropped.

The projection excludes the entire final `envelope.signature` object and both derived
`payload_digest` locations. It includes no `signature_value`. Consequently, the payload is
non-self-referential:

`signing_payload_bytes = UTF-8(RFC8785-JCS(signing_payload))`

`payload_digest_bytes = SHA-256(signing_payload_bytes)`

`payload_digest_hex = lowercase_hex(payload_digest_bytes)`

The same `payload_digest_hex` SHALL appear in both `envelope.payload_digest` and
`envelope.signature.payload_digest`. A mismatch between either location and the recomputed value
is `E_HASH_MISMATCH`.

Because the signature object is excluded, its `key_id`, algorithm, purpose, trust-chain/status
digests, and encoding are not independent authority claims. The verifier SHALL resolve the key
from the signed producer/assignment binding and adopted trust state, then require all signature
metadata to equal that resolved state and the signed envelope algorithm/purpose. Substitution or
disagreement is `E_SIGNATURE`, `E_KEY_PURPOSE`, or `E_INTEGRITY` and cannot select another key.

#### Domain, framing, and signature encoding

- canonicalization: `CANON-JCS-RFC8785-v1`;
- algorithm: `ALG-SIG-ES256-v1`;
- framing: `FRAME-LEN-DOMAIN-v1`;
- domain ID: `DOMAIN-LEDGER-HEAD-ATTEST-v1`;
- domain bytes: exact 24 ASCII bytes `AU-LEDGER-HEAD-ATTEST-v1`;
- key purpose in envelope and signature: `KP-LEDGER-HEAD-ATTEST-v1`; and
- signature encoding: `SIGENC-ES256-P1363-LOW-S-B64URL-v1`.

The exact signature input is:

`uint32be(24) || ASCII("AU-LEDGER-HEAD-ATTEST-v1") || uint64be(len(signing_payload_bytes)) || signing_payload_bytes`

ES256 signs and verifies that framed byte string. `signature_value` is unpadded base64url of the
64-byte `r || s` encoding. DER, variable-width integers, high-S values, padding, standard-base64
alphabet, or any alternate framing fail closed. This is a design encoding profile; this task
performs no signing or verification operation.

#### Verification order and failure mapping

1. Enforce input size and framing bounds before JSON interpretation:
   `E_TRUNCATED_INPUT` or `E_FRAMING_AMBIGUOUS`.
2. Strict-parse JSON, reject duplicate/unknown members, and verify schema/profile/version:
   `E_SCHEMA`, `E_VERSION_UNSUPPORTED`, or `E_UNKNOWN_REGISTRY`.
3. Verify `IF-17`, object kind, canonicalization, algorithm, framing, exact domain ID/bytes, and
   exact key purpose in both locations: `E_DOMAIN_MISMATCH` or `E_KEY_PURPOSE`.
4. Construct the exact projection, RFC 8785-canonicalize it, recompute SHA-256, and compare both
   digest locations: `E_HASH_MISMATCH`.
5. Decode exactly 64 low-S P1363 bytes, resolve the assigned ledger-head attestor key, and verify
   trust chain, key status, assignment, audience, effective interval, revocation, nonce, and
   replay state: `E_SIGNATURE`, `E_AUTHORITY_ABSENT`, `E_REVOKED`,
   `E_REVOCATION_UNAVAILABLE`, `E_EXPIRED`, `E_NOT_YET_VALID`, `E_SCOPE`, or `E_REPLAY`.
6. Verify ES256 over the exact framed input: `E_SIGNATURE`.
7. Verify ledger ID, sequence, head hash, policy, prior checkpoint, freshness, chain, and anchor:
   `E_HASH_MISMATCH`, `E_STALE`, `E_INTEGRITY`, or `E_ANCHOR`.

Any failure produces no trusted attestation and blocks or suspends promotion according to
Section 10 precedence. Unknown profiles `BLOCK`; malformed, mismatched, or invalid signed inputs
`DENY`; committed chain/head uncertainty `SUSPEND`. No nearest-name, alternate projection,
signature transcoding, or verifier-selected field omission is permitted.

## 8. Key-purpose registry

### 8.1 Exact purpose-separated identifiers

| Canonical key-purpose ID | Sole permitted governance/control act |
| --- | --- |
| `KP-ASSIGNMENT-v1` | create one `AUTHORITY_ASSIGNMENT` |
| `KP-ASSIGNMENT-ACKNOWLEDGEMENT-v1` | acknowledge or decline one exact assignment |
| `KP-SEPARATION-CONFLICT-ASSESSMENT-v1` | issue one separation/conflict assessment |
| `KP-QA-RECEIPT-v1` | issue one exact-candidate QA receipt |
| `KP-INDEPENDENT-REVIEW-v1` | issue one exact-candidate independent-review receipt |
| `KP-FINDINGS-CLOSURE-v1` | issue one findings/dependency closure disposition |
| `KP-A09-DECISION-v1` | issue one A09 `ACCEPTED`, `REVISE`, or `REJECTED` decision; cannot close G3 |
| `KP-G3-ACCEPTANCE-v1` | issue one G3 acceptance after one still-valid accepted A09 decision |
| `KP-G4-EXACT-RUN-RELEASE-v1` | issue one bounded exact-run G4 release; cannot accept A09/G3 |
| `KP-ARM-RELEASE-v1` | sign one exact eligible ARM/publication envelope |
| `KP-TRUST-STORE-v1` | publish one trust-store or trust-store-signed revocation snapshot under quorum |
| `KP-REVOCATION-SNAPSHOT-v1` | publish one monotonic revocation/status snapshot |
| `KP-AUTHORITY-REVOCATION-v1` | suspend, revoke, or supersede identified authority objects append-only |
| `KP-TMC-RUNTIME-v1` | sign IF-08/12/13 platform-bound TMC evidence |
| `KP-VERIFIER-CHALLENGE-v1` | issue one single-use, audience/channel/policy-bound verifier challenge |
| `KP-VERIFIER-VERDICT-v1` | sign one IF-11 verifier verdict |
| `KP-MODEL-ENDPOINT-STATEMENT-v1` | sign one request-scoped provider/model/endpoint identity statement |
| `KP-GPEP-EVENT-v1` | sign one IF-15 governed event/outbox object |
| `KP-LEDGER-HEAD-ATTEST-v1` | sign one IF-17 ledger-head attestation |
| `KP-AUDIT-ANCHOR-v1` | sign one independent anchor checkpoint |
| `KP-ROLLBACK-AUTHORIZATION-v1` | authorize or deny one exact rollback plan under dual control |
| `KP-ROLLBACK-RECEIPT-v1` | record execution/failure of one previously authorized rollback |
| `KP-REINSTATEMENT-AUTHORIZATION-v1` | authorize or deny one new-version/new-session reinstatement |

Key purpose is part of authorization, not descriptive metadata. A key authorized for one row
cannot sign another row, even when the issuer identity is otherwise eligible.

### 8.2 Exact role / kind / purpose / outcome tuples

Only these tuples are eligible for further identity, assignment, prerequisite, temporal,
signature, replay, and transition verification:

| Required issuer role or exact quorum | Object kind | Required key purpose | Permitted outcomes |
| --- | --- | --- | --- |
| `ASSIGNMENT_AUTHORITY` | `AUTHORITY_ASSIGNMENT` | `KP-ASSIGNMENT-v1` | `ASSIGNMENT_PROPOSED`, `ASSIGNMENT_EFFECTIVE`, `ASSIGNMENT_DENIED` |
| exact assignment subject as `ASSIGNEE` | `ASSIGNMENT_ACKNOWLEDGEMENT` | `KP-ASSIGNMENT-ACKNOWLEDGEMENT-v1` | `ACKNOWLEDGED`, `DECLINED` |
| `SEPARATION_CHECKER` | `SEPARATION_CONFLICT_ASSESSMENT` | `KP-SEPARATION-CONFLICT-ASSESSMENT-v1` | `CLEAR`, `CONFLICT_DISPOSITIONED`, `RECUSAL_REQUIRED`, `FAILED` |
| `QA_EVIDENCE_AGENT` | `CANDIDATE_QA` | `KP-QA-RECEIPT-v1` | `QA_PASS`, `QA_FAIL`, `QA_BLOCKED` |
| `INDEPENDENT_REVIEWER` | `INDEPENDENT_REVIEW` | `KP-INDEPENDENT-REVIEW-v1` | `REVIEW_PASS`, `REVIEW_REVISE`, `REVIEW_BLOCKED` |
| `FINDINGS_CLOSURE_AUTHORITY` | `FINDINGS_CLOSURE` | `KP-FINDINGS-CLOSURE-v1` | `CLOSED`, `OPEN`, `BLOCKED` |
| `DECISION_CHAIR` | `A09_DECISION` | `KP-A09-DECISION-v1` | `ACCEPTED`, `REVISE`, `REJECTED` |
| `DECISION_CHAIR` | `G3_ACCEPTANCE` | `KP-G3-ACCEPTANCE-v1` | `G3_ACCEPTED` only |
| `COORDINATOR_ARCHITECT` | `G4_EXACT_RUN_RELEASE` | `KP-G4-EXACT-RUN-RELEASE-v1` | `RELEASED` only |
| `REVOCATION_AUTHORITY` | `REVOCATION_SNAPSHOT` | `KP-REVOCATION-SNAPSHOT-v1` | snapshot state entries only; no A09/G3/G4 outcome |
| `TRUST_STORE_PUBLISHER` under required quorum | `REVOCATION_SNAPSHOT` | `KP-TRUST-STORE-v1` | trust-store/status publication only |
| `REVOCATION_AUTHORITY` | `AUTHORITY_REVOCATION` | `KP-AUTHORITY-REVOCATION-v1` | `SUSPENDED`, `REVOKED`, `SUPERSEDED` |
| `VERIFIER_OPERATOR` | `VERIFIER_CHALLENGE` | `KP-VERIFIER-CHALLENGE-v1` | no governance outcome; `single_use` must be `true` |
| `LOCAL_MEASURED_MODEL_ADAPTER` | `MODEL_ENDPOINT_STATEMENT` | `KP-MODEL-ENDPOINT-STATEMENT-v1` | no governance outcome; request-scoped evidence only |
| `MODEL_PROVIDER_IDENTITY_AUTHORITY` | `MODEL_ENDPOINT_STATEMENT` | `KP-MODEL-ENDPOINT-STATEMENT-v1` | no governance outcome; request-scoped evidence only |
| `VERIFIER_OPERATOR` | `VERIFIER_VERDICT` | `KP-VERIFIER-VERDICT-v1` | `TRUSTED_ACTIVE`, `UNTRUSTED`, `SUSPENDED`, `REVOKED`, `ENDED` |
| exact quorum `COORDINATOR_ARCHITECT` + independent `SECURITY_GOVERNANCE` | `ROLLBACK_AUTHORIZATION` | each signature uses `KP-ROLLBACK-AUTHORIZATION-v1` over identical payload bytes | `ROLLBACK_AUTHORIZED`, `ROLLBACK_DENIED` |
| `G_PEP_RECOVERY_CONTROLLER` | `ROLLBACK_RECEIPT` | `KP-ROLLBACK-RECEIPT-v1` | `ROLLED_BACK`, `ROLLBACK_FAILED` |
| exact quorum `QA_EVIDENCE_AGENT` + `INDEPENDENT_REVIEWER` + `COORDINATOR_ARCHITECT`, plus `DECISION_CHAIR` when A09/G3 was invalidated | `REINSTATEMENT_AUTHORIZATION` | each signature uses `KP-REINSTATEMENT-AUTHORIZATION-v1` over identical payload bytes | `REINSTATED_NEW_VERSION`, `REINSTATEMENT_DENIED` |

Tuple compatibility is necessary but never sufficient. The consumer SHALL also verify stable
identity, mandate, assignment, acknowledgement, separation, candidate/run identity, typed
prerequisites, effective interval, revocation snapshot, nonce/counter/replay state, payload
identity, signature, and legal transition.

The envelope `key_purpose_id` and nested signature `key_purpose_id` SHALL be identical. For
multi-signature objects, each signature SHALL use the purpose in the tuple and all signatures
SHALL cover the same canonical payload digest. A role, kind, purpose, or outcome from another row
is not substitutable.

For these evidence objects, the signer/object/consumer tuples are additionally closed:

| Producer tuple | Producing interface | Exact consumers | Permitted consumer effect |
| --- | --- | --- | --- |
| `VERIFIER_OPERATOR / VERIFIER_CHALLENGE / KP-VERIFIER-CHALLENGE-v1` | `IF-06` | an enrolled platform-bound TMC at `IF-08` launch or `IF-12` liveness | reserve the nonce once and proceed to measurement only after signature, purpose, audience, channel, policy, freshness, and replay checks pass |
| `LOCAL_MEASURED_MODEL_ADAPTER / MODEL_ENDPOINT_STATEMENT / KP-MODEL-ENDPOINT-STATEMENT-v1` | `IF-10` | TMC evidence assembly and verifier evaluation at `IF-11`; audit binding at `IF-13` | contribute request-scoped model/endpoint evidence only when the adapter identity is measured and session-bound |
| `MODEL_PROVIDER_IDENTITY_AUTHORITY / MODEL_ENDPOINT_STATEMENT / KP-MODEL-ENDPOINT-STATEMENT-v1` | `IF-10` | TMC evidence assembly and verifier evaluation at `IF-11`; audit binding at `IF-13` | contribute request-scoped provider/model/endpoint evidence only when provider authority, tenant, service, endpoint, model, commitments, audience, and freshness all bind |

Neither evidence object creates governance acceptance, G3 acceptance, G4 release, runtime
admission, or a verifier verdict. The consuming verifier may issue `TRUSTED_ACTIVE` only through
a separate `VERIFIER_VERDICT / KP-VERIFIER-VERDICT-v1` object after evaluating all required
evidence.

### 8.3 Alias, deprecation, and non-collapse rules

| Existing value or use | Canonical mapping | Rule |
| --- | --- | --- |
| `A09_DECISION` | `KP-A09-DECISION-v1` | deprecated spelling for A09 only; never G3 |
| `AUDIT_ANCHOR` | `KP-AUDIT-ANCHOR-v1` | deprecated spelling for checkpoints only |
| `RUNTIME_ATTESTATION` | `KP-TMC-RUNTIME-v1` | deprecated spelling only for actual IF-08/12/13 objects |
| `KP-EXEC-RELEASE-v1` | `KP-G4-EXACT-RUN-RELEASE-v1` | one-to-one deprecated alias for `G4_EXACT_RUN_RELEASE` only |
| `KP-REINSTATEMENT-v1` | `KP-REINSTATEMENT-AUTHORIZATION-v1` | one-to-one deprecated alias for `REINSTATEMENT_AUTHORIZATION` only |
| `KP-ASSIGNMENT-v1` on acknowledgement or separation assessment | none | governance-act collapse; reject with `E_KEY_PURPOSE` |
| `KP-INDEPENDENT-REVIEW-v1` on findings closure | none | governance-act collapse; reject with `E_KEY_PURPOSE` |
| `KP-A09-DECISION-v1` on G3 acceptance | none | governance-act collapse; reject; G3 remains closed |
| `KP-VERIFIER-VERDICT-v1` on `VERIFIER_CHALLENGE` | none | issuance/verdict collapse; reject with `E_KEY_PURPOSE`; no measurement |
| `KP-VERIFIER-CHALLENGE-v1` on `VERIFIER_VERDICT` | none | issuance/verdict collapse; reject with `E_KEY_PURPOSE`; no admission |
| any runtime, verdict, or generic signing purpose on `MODEL_ENDPOINT_STATEMENT` | none | evidence-purpose mismatch; reject with `E_KEY_PURPOSE` |
| `KP-REVOCATION-v1` | none | ambiguous between snapshot and authority act; reject and select exact purpose |
| `KP-ROLLBACK-v1` | none | ambiguous between authorization and execution receipt; reject and select exact purpose |
| `runtime-attestation` on ledger vectors | none | misapplied; regenerate with `KP-LEDGER-HEAD-ATTEST-v1` |
| `EVIDENCE_RECEIPT` | none | overbroad; reject and select exact purpose |
| `general-signing` | none | prohibited; reject |

No alias maps challenge issuance, verdict issuance, model/endpoint evidence, QA, review, findings
closure, A09, G3, G4, revocation, rollback, or reinstatement to one another. One-to-one
deprecated aliases do not broaden role, kind, outcome, candidate, or run scope and are removed
in registry `2.0.0`.

### 8.4 Safe failure

- Unknown/unregistered key purpose: emit primary `E_UNKNOWN_REGISTRY`, decision `BLOCK`, perform
  no signature-based authorization, and preserve the prior safe state.
- Registered purpose with wrong role, object kind, outcome, interface, schema, or signer quorum:
  emit primary `E_KEY_PURPOSE`, decision `DENY`, and perform no governed transition.
- Envelope/signature purpose disagreement: `E_KEY_PURPOSE`; do not choose either value.
- Missing required signer or differing multi-signature payload digests: `E_KEY_PURPOSE` plus
  contributing `E_SIGNATURE`; do not count the quorum.
- Purpose failure on acknowledgement leaves the assignment no more effective than its prior
  state; on QA/review/closure creates no valid prerequisite; on A09 changes no governance state;
  on G3 leaves G3 closed; on G4 leaves the run `NOT_RELEASED`; on revocation preserves prior
  authoritative state while separately escalating uncertainty; on rollback/reinstatement leaves
  the affected scope `SUSPENDED`.
- Purpose failure on `VERIFIER_CHALLENGE` means the TMC does not reserve/use the nonce and emits
  no launch/liveness evidence. Purpose failure on `MODEL_ENDPOINT_STATEMENT` blocks its use at
  IF-10/11/13, emits primary `E_KEY_PURPOSE` with contributing `E_MODEL_BINDING` when applicable,
  and cannot contribute to `TRUSTED_ACTIVE` or governed output use.
- Every rejection is appended to the applicable intake/attempt audit with the supplied purpose,
  expected purpose, tuple, detector interface, and ordered reasons. It never edits or validates
  the rejected object.

## 9. Hash-domain registry

| Canonical hash-domain ID | Exact bytes identified | Existing alias rule |
| --- | --- | --- |
| `raw-working-tree-sha256-v1` | exact checkout bytes plus byte count/platform/line-ending observation | schema `checkout_bytes` maps only when all required observation metadata is present; otherwise reject |
| `crlf-to-lf-sha256-v1` | replace only CRLF pairs with LF; no other transformation | no schema alias currently |
| `git-blob-oid-v1` | exact Git blob object bytes under declared repository/object format and full OID | no alias |
| `git-blob-sha256-v1` | SHA-256 of exact Git blob bytes, independent of Git OID algorithm | schema `git_blob_lf` does **not** map; it is ambiguous and deprecated |
| `git-index-path-binding-v1` | stage-0 path, mode, blob OID | no alias |
| `git-commit-path-binding-v1` | repository, commit/tree, path, mode, blob OID | no alias |
| `rfc8785-jcs-utf8-sha256-v1` | SHA-256 of UTF-8 RFC 8785 JCS bytes | schema `rfc8785_jcs_utf8` maps through registry 1.x |
| `framed-binary-sha256-v1` | SHA-256 of bytes produced by a named framing profile | schema `framed_binary_v1` maps only with `framing_id` |
| `candidate-manifest-identity-v1` | canonical candidate manifest bytes and external SHA-256 | no alias |
| `publication-receipt-identity-v1` | canonical publication receipt bytes and external SHA-256 | no alias |

`git_blob_lf` SHALL NOT be silently interpreted as a Git blob or LF normalization. Agent A must
remove it or split it into the canonical domains above.

## 10. Ordered reason-code registry

### 10.1 Ordering rule

Each result carries `reason_codes` as a unique ordered array. Lower precedence number wins. Codes
at the same precedence are ordered lexicographically by canonical code. Success with no
qualification uses an empty array; `OK` is not a reason code. A detector may add contributing
lower-priority codes but may not displace a higher-priority safe-state cause.

| Precedence | Canonical code | Primary detector interface(s) | Default decision / safe state |
| ---: | --- | --- | --- |
| 10 | `E_REVOKED` | IF-01, IF-03-05, IF-11, IF-19 | `REVOKE`; affected scope terminal/block |
| 20 | `E_REVOCATION_UNAVAILABLE` | IF-03-12, IF-15, IF-19 | `SUSPEND`; admission/promotion blocked |
| 30 | `E_SIGNATURE` | any signed-object consumer | `DENY`; active dependent scope suspends |
| 31 | `E_KEY_PURPOSE` | any signed-object consumer; IF-17 for vector 008 | `DENY`; no trust/authority implication |
| 32 | `E_AUTHORITY_ABSENT` | IF-01-05, IF-15, IF-20-22 | `BLOCK`; prior state retained |
| 33 | `E_SEPARATION` | IF-01-04, IF-20-22 | `DENY`; prior state retained |
| 40 | `E_EXPIRED` | any time-bound consumer | `BLOCK`; active session/release suspends |
| 41 | `E_NOT_YET_VALID` | any time-bound consumer | `BLOCK`; no early use |
| 42 | `E_ORDERING_AMBIGUOUS` | IF-01, IF-03-05, IF-12, IF-15, IF-19 | `SUSPEND`; safer state |
| 50 | `E_REPLAY` | IF-03, IF-04, IF-06, IF-11, IF-12, IF-15 | `DENY`; alert and suspend affected scope |
| 51 | `E_IDEMPOTENCY_CONFLICT` | IF-14, IF-15 | `DENY`; no mutation |
| 60 | `E_SCOPE` | IF-02-15 | `DENY`; no substitution |
| 61 | `E_AUTHN` | IF-01, IF-14 and service ingress | `DENY`; no action |
| 70 | `E_VERSION_UNSUPPORTED` | schema/framing consumer; IF-17 for vector 007 | `BLOCK`; no interpretation |
| 71 | `E_UNKNOWN_REGISTRY` | every interface | `BLOCK`; no nearest-name fallback |
| 72 | `E_DOMAIN_MISMATCH` | IF-16/17; vector 004 | `DENY`; promotion suspended if committed chain affected |
| 73 | `E_FRAMING_AMBIGUOUS` | IF-16; vector 005 | `DENY`; bytes not parsed |
| 74 | `E_TRUNCATED_INPUT` | IF-16; vector 006 | `DENY`; bytes not parsed |
| 75 | `E_SCHEMA` | every object ingress | `DENY`; no trusted interpretation |
| 76 | `E_POLICY` | policy consumer | `BLOCK`; no policy fallback |
| 80 | `E_HASH_MISMATCH` | IF-16/17/18; vector 003 | `SUSPEND`; promotion blocked and evidence retained |
| 81 | `E_INTEGRITY` | IF-08, IF-15-19 | `SUSPEND`; affected scope blocked |
| 90 | `E_DEPENDENCY` | every interface | `BLOCK`; availability never overrides integrity |
| 91 | `E_ATTESTATION` | IF-08, IF-09, IF-11 | `DENY`; verdict untrusted/admission blocked |
| 92 | `E_LIVENESS` | IF-12, IF-13 | `SUSPEND`; session blocked |
| 93 | `E_MODEL_BINDING` | IF-10, IF-11, IF-13 | `DENY`; governed result blocked |
| 94 | `E_STALE` | freshness-checking consumer | `BLOCK`; active scope suspends where required |
| 100 | `E_CONFLICT` | IF-14, IF-15, IF-18 | `NO_MUTATION`; reread/reconcile |
| 101 | `E_TRANSITION` | IF-14, IF-15, IF-21, IF-22 | `DENY`; prior state retained |
| 110 | `E_AUDIT_DELIVERY` | IF-16, IF-18 | `SUSPEND`; promotion blocked |
| 111 | `E_ANCHOR` | IF-17, IF-18 | `SUSPEND`; promotion blocked |
| 112 | `E_ORPHAN_EXTERNAL` | IF-18 | `NO_MUTATION`; classify `ORPHAN_REJECTED` |
| 120 | `E_ROLLBACK_AUTHORITY` | IF-20, IF-21 | `BLOCK`; remain suspended |
| 121 | `E_IRREVERSIBLE_EFFECT` | IF-20, IF-21 | `SUSPEND`; preserve/escalate/reconcile |
| 200 | `E_INTERNAL` | any | `BLOCK`; safe diagnostics and alert |

### 10.2 Reason aliases and deprecation

| Existing code | Canonical code | Status |
| --- | --- | --- |
| `OK` | empty `reason_codes` | deprecated success sentinel |
| `E_AUTHENTICATION` | `E_AUTHN` | alias through registry 1.x |
| `E_AUTHORITY` | `E_AUTHORITY_ABSENT` | alias through registry 1.x |
| `E_BINDING` | `E_SCOPE` | alias only when detector proves scope/binding mismatch |
| `E_CANONICAL` | `E_SCHEMA` | alias through registry 1.x |
| `E_EVIDENCE` | `E_DEPENDENCY` | alias only for missing/unverified evidence; integrity failures use exact code |
| `E_FUTURE` | `E_NOT_YET_VALID` | alias through registry 1.x |
| `E_MISSING` | `E_DEPENDENCY` | alias through registry 1.x |
| `E_TOPOLOGY` | `E_TRANSITION` | alias through registry 1.x |
| `E_UNAVAILABLE` | `E_DEPENDENCY` | alias unless revocation status is unavailable |
| `E_UNKNOWN_CRITICAL_EXTENSION` | `E_UNKNOWN_REGISTRY` | alias through registry 1.x |
| `E_VERSION` | `E_VERSION_UNSUPPORTED` | alias through registry 1.x |
| `E_INTEGRITY`, `E_POLICY`, `E_STALE` | same canonical spelling | retained |
| vector six rejection codes | same canonical spelling | now canonical with detectors in Section 10.1 |

Ambiguous aliases SHALL be rejected rather than guessed. All aliases are removed in registry
version `2.0.0` unless explicitly renewed.

## 11. Precedence and default safe state

Cross-system event precedence remains:

`REVOKED > SUSPENDED/UNTRUSTED > EXPIRED/NOT_YET_VALID > SUPERSEDED/ROLLED_BACK > ENDED > positive state`

Evaluation order is:

1. framing/length safety before JSON parsing;
2. strict parse, duplicate-key and canonical preconditions;
3. schema/profile/version/registry recognition;
4. signature and key-purpose verification;
5. identity, assignment, separation and scope;
6. revocation, expiry, freshness, nonce/counter/replay and ordering;
7. dependency/evidence integrity;
8. state/transition/idempotency/concurrency;
9. transaction/event/outbox;
10. external delivery, chain, anchor and reconciliation.

The reason order in Section 10 controls reporting when multiple detected causes coexist; this
evaluation order controls which checks may safely run. A parser SHALL NOT attempt a signature or
schema interpretation on ambiguous/truncated framing.

Default safe states:

- before mutation: `NO_MUTATION`;
- runtime admission: `BLOCKED`;
- active runtime uncertainty: verifier `SUSPENDED`, admission `BLOCKED`;
- governance/release uncertainty: gate/run remains or returns blocked;
- audit delivery/anchor uncertainty: promotion `SUSPENDED`;
- rollback uncertainty: remain `SUSPENDED`;
- unknown interface/profile/registry: `BLOCK`.

## 12. Historical finding context and current correction

The original F-04 report and Wave 2 reconciliation reports remain immutable historical
observations of their inspected snapshots. Their schema counts, vector-file counts, profile
availability, interface alignment totals, and pending handoffs are not current package status.
They are not rewritten or silently reinterpreted.

Current read-only reconciliation is recorded append-only in
`W05_POST_CORRECTION_RECONCILIATION.md`:

- `A1-NMF-01` contract portion: current inventory language is 35 schemas, one canonical
  fourteen-scenario vector family in six files, and 22 design-aligned interfaces; no old
  `MUST_REVISE`, deferred-profile, or pending Agent A/B consumption claim remains current.
- `A1-NMF-02` contract portion: Section 7.1 is the authoritative non-self-referential
  ledger-head signing projection and design signature-encoding/verification profile.
- corrected authority design: purpose-separated assignment, acknowledgement, separation, QA,
  review, closure, A09, G3, G4, revocation, rollback, and reinstatement families are present;
  real authority evidence remains absent.
- corrected provenance design: nested candidate manifest and publication/reference identity
  families are present; no frozen candidate, Git-object binding, publication receipt, or
  independent retrieval exists.

These corrections establish current design consistency only. Validator execution, cryptographic
verification, adoption, immutable publication, effective authority, A09/G3 acceptance, and G4
release remain outside this registry task.

## 13. Design alignment and non-adoption

After applying this registry to the companion contract and matrix:

- design `ALIGNED`: **22**
- design `PARTIAL`: **0**
- design `CONFLICT`: **0**
- design `BLOCKED_BY_ADOPTION`: **0**
- operationally adopted interfaces: **0**
- operationally demonstrated interfaces: **0**
- operationally blocked by adoption/implementation: **22**

This count means the producer/consumer design has one internally coherent interpretation. The
current 35 schema files and six vector files are present, but presence is not validator
conformance, cryptographic verification, adoption, publication, or implementation.

Current disposition:

`ONE AUTHORITATIVE DESIGN MAPPING -> 35 SCHEMAS PRESENT -> 1 VECTOR FAMILY / 14 SCENARIOS (2 POSITIVE, 12 NEGATIVE) / 6 FILES -> BUNDLE SHA-256 b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52 -> 22 DESIGN-ALIGNED INTERFACES -> NOT ADOPTED -> NOT VALIDATED -> NOT CRYPTO-VERIFIED -> UNPUBLISHED -> NO ENFORCEMENT`

