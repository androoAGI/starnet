# Wave 0.5 Schema / Contract Reconciliation

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-SCHEMA`, Wave 2 reconciliation
- **Experiment:** `AU-UCR-EP-000001`
- **Repository baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Artifact status:** `PROPOSED_NOT_ADOPTED`
- **Inspection mode:** documentation/design and non-destructive read inspection only
- **Schema-validation status:** `NOT VALIDATOR-EXECUTED`
- **Adoption, acceptance, implementation, execution, publication effect:** `NONE`

This report reconciles the seven proposed record schemas and `common.schema.json` against:

- `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`;
- `W05_INTERFACE_MATRIX.md`;
- `W05_AUTHORITY_CLOSURE_PACKAGE.md`;
- `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`;
- `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md`;
- `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`;
- `vectors/derive_vectors.py`; and
- `vectors/reproduce_vectors.py`.

No existing artifact was edited. No validator, project test, vector generator, reproducer, signature
operation, dependency installation, implementation, commit, push, publication, or merge was run.
The schemas remain proposed design artifacts. “Consistent” below means only internally compatible
as design; it does not mean schema-valid, conformant, adopted, authoritative, or effective.

## 2. Reconciliation result and counting rule

The schemas are **coherent as narrow proposed record shapes**, but they are **not conformant to the
later shared common envelope, common verification result, registry, identity, provenance, and
interface binding requirements**. The vector package is also not instance-compatible with the
audit-ledger schema.

Counts are by distinct reconciliation finding, not by every repeated occurrence of the same
cross-cutting gap:

- **Total mismatch findings:** **27**
- **Cross-cutting/shared-definition findings:** **10**
- **Record-schema-specific findings:** **17**
- **Schemas inspected:** **7 of 7**
- **Shared-definition schemas inspected:** **1 of 1**
- **Unresolved authoritative-source questions:** **8**
- **Validator executions:** **0**

Repeated absence of the common envelope in seven schemas is one cross-cutting finding (`RC-X01`),
not seven. Every field is nevertheless enumerated in the crosswalks below.

## 3. Shared-definition crosswalk

| Definition / field | Shared-contract or interface target | Reconciliation |
| --- | --- | --- |
| `proposalStatus` = `PROPOSED_NOT_ADOPTED` | Contract Sections 1-2; all interfaces remain specified/not adopted | **Consistent design.** Stronger and clearer than implying adoption. |
| `schemaVersion` = `1.0.0`; `compatibleMajor` = `1` | Interface common envelope `schema_id`, `schema_version`; closed version registry | **Partial.** Version is bounded, but no registry identifier, compatibility rule, or mapping to vector URNs is supplied. |
| `id` | Stable actor/service/object identifiers | **Partial.** Syntax is bounded, but does not bind identity system, issuer, proofing, assignment, or type. |
| `uuidUrn` | Event, receipt, session, runtime, ledger identities | **Consistent syntax** for UUID URNs; authority and uniqueness remain external. |
| `sha256` | Content/event/registry/receipt digests | **Consistent syntax.** It does not identify algorithm registry entry, hash domain, or semantic object by itself. |
| `gitSha1` | Provenance candidate commit in repository object format `sha1` | **Consistent only for current repository design.** It lacks repository/object-format binding and cannot generalize to another Git object format. |
| `timestamp` | UTC RFC 3339, at most microseconds | **Consistent design.** Ordering, trusted clock, and interval relationships are not schema-provable. |
| `nonce256` | IF-03/IF-06 verifier nonce | **Consistent size/encoding design.** Single use and atomic consumption remain external. |
| `canonicalProfile` = `RFC8785-JCS-UTF8` | `CANON-JCS-RFC8785-v1`; vector `RFC8785-JCS` | **Identifier mismatch.** Semantics appear intended to match, but no authoritative alias/mapping exists. |
| `hashAlgorithm` = `SHA-256` | `ALG-HASH-SHA256-v1` | **Semantic match, identifier mismatch.** |
| `signatureAlgorithm` = `ES256` | `ALG-SIG-ES256-v1` | **Semantic match, identifier mismatch.** Encoding/determinism/certificate profile remains unresolved. |
| `failureCategory` values | Interface failure routing | **Supplementary only.** The shared contract standardizes reason entries and decisions, not this 16-value category registry. No adoption source defines category semantics. |
| `reasonCode` values | Shared 25-code reason registry; ordered `reason_codes` | **Mismatch.** Exact vocabulary and cardinality differ; see Section 5. |
| `sourceTrace` | Provenance and source authority | **Useful design metadata, non-authoritative.** It is not a publication manifest, source digest, commit-path binding, or adoption receipt. |
| `digestRef.uri` | Exact object/receipt/registry reference | **Partial.** URI is untyped and not tied to repository, registry, object type, or immutable locator. |
| `digestRef.hash_algorithm` | Algorithm registry ID/digest | **Mismatch:** literal `SHA-256` instead of registry entry and snapshot. |
| `digestRef.digest` | Exact referred-object digest | **Consistent syntax.** |
| `digestRef.hash_domain` | Shared/provenance domain registry | **Mismatch:** local names do not match the provenance domain identifiers; see Section 7. |
| `signature.algorithm` | Algorithm registry | **Mismatch:** literal `ES256`, no registry ID/digest. |
| `signature.key_id` | Stable key identity | **Partial.** Issuer chain, validity, custody and revocation evidence are absent. |
| `signature.key_purpose` | Shared key-purpose registry | **Mismatch:** four local enum values do not use the shared `KP-...-v1` identifiers and omit required purposes. |
| `signature.payload_digest` | Common envelope payload digest | **Consistent syntax, incomplete binding.** Domain/framing/canonicalization identifiers are absent. |
| `signature.value` | Signature bytes | **Partial.** Encoding is unspecified. |
| `extensions` property names | Reverse-DNS controlled extension namespace | **Consistent design.** |
| `extensions.*.critical` and `.value` | Unknown critical extensions fail closed | **Partial.** Shape is represented, but schema alone cannot know whether a critical extension is registered/supported. |

### Shared-envelope and result disposition

None of the seven record schemas contains the full Section 2.1 common envelope:
`schema_id`, `object_type`, general `object_id`, general `event_id`, `producer_id`,
`producer_role`, `producer_assignment_ref`, `algorithm_id`, `key_purpose_id`,
`canonicalization_id`, `framing_id`, general `not_before`, `authority_counter`,
`previous_event_digest`, `publication_manifest_digest`, `run_id`, registry snapshot digests,
`challenge_ref`, or a separately identified `payload_digest`.

None contains the full Section 2.2 consumer verification result:
`interface_id`, `result_id`, consumer stable identity, exact input IDs/digests, trusted
verification time, six-state `decision`, resulting/prior shared state, ordered `reason_codes`,
`retryable`, recovery authority, full snapshots, and audit/intake reference.

This is a design mismatch, not evidence that existing fields are false. The schemas predate the
completed shared interface contract and represent narrower payloads.

## 4. Record-schema field-by-field crosswalk

### 4.1 `attestation-evidence.schema.json`

**Primary interfaces/profiles:** IF-08 `LaunchEvidence`, IF-12 `LivenessEvidence`, IF-13 inference
receipt; shared producer-evidence state.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Proposal/version/source/canonical metadata | Status is consistent; version/canonical IDs need registry mapping. |
| `evidence_id` | Envelope object/event identity | Consistent UUID identity, but no explicit `object_type` or event relationship. |
| `evidence_kind` (`LAUNCH`, `LIVENESS`, `INFERENCE`, `SUSPENSION`, `REVOCATION`) | IF-08/IF-12/IF-13 and lifecycle evidence families | Reasonable discriminant, but one schema does not apply kind-specific requirements beyond liveness predecessor. |
| `session_id` | Cross-system session identity | Consistent. |
| `sequence` | IF-12 strict sequence | Consistent type/bound; monotonicity and fork detection remain external. |
| `issued_at`, `expires_at` | Envelope validity interval | Consistent shape; no `not_before` or trusted consumer receipt time. |
| `verifier_nonce` | IF-06 challenge nonce | Partial: nonce is present, but challenge ID/reference, issue time, policy digest and single-use result are absent. |
| `channel_binding_digest` | IF-06/IF-08/IF-12 channel binding | Consistent digest shape. |
| `arm` | IF-05 immutable digest-addressed ARM | Partial digest reference; ARM eligibility, release and registry snapshots are absent. |
| `platform_quote_digest` | IF-08/IF-09 platform quote | Partial: no device enrollment, TMC identity, quote policy/result, PCR/event profile or boot identity. |
| `effective_config_digest`, `module_set_digest`, `model_digest`, `endpoint_tuple_digest` | IF-08/IF-10 runtime identity evidence | Consistent core digests; provider/account/region/proxy statement and complete endpoint identity remain absent. |
| `prior_evidence_digest` | IF-12 prior accepted evidence | Correctly required for `LIVENESS`; acceptance identity and nearest launch/liveness receipt IDs are absent. |
| `producer_state` | Producer state machine | Enum matches shared states except `UNINITIALIZED`; omission may be reasonable for issued records, but the restriction is undocumented. |
| `failure_category`, `reason_code` | Failure routing/result | Singular local reason model mismatches ordered shared `reason_codes`. |
| `signature` | TMC evidence signature | Purpose intent is consistent, but local key-purpose/algorithm identifiers and missing framing/domain IDs do not satisfy registry binding. |
| `extensions` | Common extension policy | Structurally consistent; support/adoption is external. |

**Specific gaps:** runtime evidence omits platform/boot/TMC/launcher/process creation/runtime key
identities; liveness omits challenge reference, monotonic counter and security flags; inference
omits request ID and input/output commitments. The schema also does not represent verifier
evaluation, which is correctly separate but must be linked by a verdict receipt.

**Verdict:** `DESIGN_PARTIAL_NOT_INTERFACE_CONFORMANT`.

### 4.2 `session-binding.schema.json`

**Primary interfaces/profiles:** IF-11 `VerifierVerdictReceipt`, IF-12 state handoff, admission
state boundary.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `session_id`, `runtime_instance_id`, `device_id`, `boot_id` | Decision-session-audit identity tuple | Semantically consistent; `device_id`/`boot_id` use generic, untyped IDs. |
| `process_id`, `process_created_at`, `runtime_key_id` | IF-08/IF-11 process/runtime identity | Consistent core identity; no TMC/launcher/platform profile identity. |
| `arm_digest`, `effective_config_digest`, `module_set_digest`, `model_digest`, `endpoint_tuple_digest` | IF-11 complete runtime input set | Useful subset; release, A09, candidate/publication and registry snapshots are absent. |
| `verifier_nonce`, `channel_binding_digest` | IF-06/IF-11 challenge/channel | Partial; no challenge receipt ID or policy digest. |
| `verdict` | Shared verifier state | Exact shared verdict vocabulary, including `NOT_EVALUATED`. |
| `reason_code` | Verdict reasons | Singular and local; shared contract requires ordered registry-pinned reasons. |
| `bound_at`, `fresh_until` | Verifier receipt/freshness | Semantically consistent, but verifier identity, trusted-clock declaration and receipt ID/signature are absent. |
| `extensions` | Extension policy | Structurally consistent. |

The object is named a binding rather than a signed verifier receipt. It cannot establish which
verifier issued the verdict, the input evidence set, or the audit reference. It also omits the
repository/candidate/publication, A09, execution release/run, policy/schema/topology/trust/revocation
and registry tuple required by Contract Section 5.

**Verdict:** `DESIGN_PARTIAL_NOT_INTERFACE_CONFORMANT`.

### 4.3 `effective-configuration-measurement.schema.json`

**Primary interface/profile:** IF-07 `LoaderObservation`, input to IF-08/IF-11.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `measurement_id` | Loader observation identity | Consistent UUID identity. |
| `arm_digest` | ARM dependency | Consistent digest subset. |
| `precedence_policy_digest` | Declared configuration precedence | Consistent intent; not explicitly a pinned policy/registry snapshot. |
| `ordered_inputs[].order` | Ordered resolution trace | Consistent bound; uniqueness/contiguity is not schema-enforced. |
| `ordered_inputs[].purpose`, `.source_uri` | Component mapping/source | Partial; source is not an immutable opened-handle identity. |
| `ordered_inputs[].hash_domain`, `.raw_digest`, `.canonical_digest` | Exact bytes/canonical component identity | Core intent consistent; domain vocabulary conflicts with provenance IDs and `canonical_digest` is not conditionally required for structured inputs. |
| `ordered_inputs[].loader_digest`, `.executable` | Loader identity/component executability | Useful fields; repeated loader digest semantics are unclear. |
| `ambient_input_denylist_digest` | IF-05/IF-07 ambient input policy | Consistent digest subset. |
| `effective_configuration_digest`, top-level `loader_digest` | IF-07 output/loader identity | Consistent core outputs. |
| `measured_at` | Observation time | Shape consistent; producer versus trusted receipt time remains distinct. |
| `failure_category`, `reason_code` | Load result/failure | No explicit `load_result`; singular local reason mismatch. |
| `extensions` | Extension policy | Structurally consistent. |

The schema omits opened-handle/component mapping, exact parsed-byte digest set as such, load result,
ARM component IDs, and TMC observation/signature linkage.

**Verdict:** `DESIGN_PARTIAL_NOT_INTERFACE_CONFORMANT`.

### 4.4 `authorization-a09-decision.schema.json`

**Primary interface/profile:** IF-03 `A09Receipt`; authority package proposed governance receipt.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `decision_id` | Decision receipt/object/event identity | Consistent UUID, but no separate event ID or previous authority event digest. |
| `repository_id`, `candidate_commit`, `artifact_bundle_digest` | Exact candidate identity | Partial. Provenance additionally requires root tree, publication manifest identity and publication receipt identity. |
| `object_id`, `prior_object_version`, `prior_state`, `prior_event_hash`, `requested_transition` | Prior governed object/transition | These model B-03 object state, not the IF-03 candidate governance state. `next governance state` is absent. |
| `registry_digest`, `policy_digest`, `schema_bundle_digest`, `evidence_bundle_digest` | Snapshot/evidence bindings | Partial. One generic registry digest cannot identify algorithm, dependency, reason, topology, trust and revocation snapshots. |
| `supporting_receipt_digests` | Publication, QA, review, role and findings/dependency receipts | Count is bounded, but entries are untyped, so required receipt classes and exact roles cannot be proven. |
| `outcome` | Governance outcome | Exact `ACCEPTED`, `REVISE`, `REJECTED` vocabulary. |
| `rationale` | Supplemental rationale | Consistent; must not replace reasons. No ordered reason codes are present. |
| `signer_identity` | Decision Chair stable identity | Partial generic ID; no identity system/issuer/proofing or assignment record/digest. |
| `role_scope`, `role_effective_from`, `role_effective_until` | Decision Chair role/effective interval | Scope const and interval fields are useful; `role_effective_until` is optional despite authority package requiring it. |
| `key_id`, `key_purpose` | Signer key/purpose | Local purpose `A09_DECISION` mismatches `KP-A09-DECISION-v1`; trust chain and key validity are absent. |
| `audience`, `environment` | Scope binding | Consistent values but no run/object scope model. |
| `issued_at`, `not_before`, `expires_at` | Receipt validity | Consistent shape. |
| `nonce`, `authority_counter`, `revocation_epoch` | Replay/order/revocation | Consistent core fields. |
| `signature` | Signed receipt | Present, but duplicates `key_id`/purpose without equality constraints and lacks framing/registry identifiers. |
| `extensions` | Extension policy | Structurally consistent. |

The authority package confirms every real authority value remains absent. This schema is only a
proposed shape and must not be populated by inference from `"Human approved."`.

**Verdict:** `DESIGN_PARTIAL_NOT_INTERFACE_CONFORMANT`.

### 4.5 `a01-a12-transition-record.schema.json`

**Primary interfaces/profiles:** IF-14 `MutationRequest`/acceptance result and IF-15
`GovernedEvent`/transaction result.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `event_id` | Governed event identity | Consistent UUID. |
| `object_id`, `prior_object_version`, `new_object_version`, `expected_object_version` | IF-14/IF-15 object/version controls | Core fields are consistent; arithmetic and current lock result remain external. |
| `stage` | A01-A12 registry node | Complete A01-A12 enum. |
| `from_status`, `to_status` | Governed-object state | Uses the shared B-03 vocabulary. `NOT_STARTED` is correctly absent from `to_status`; legal edge combinations are not encoded. |
| `registry_state` | Stage registry state | Includes `ENABLED` for a future registry, while current topology remains empty; consistent only as prospective design. |
| `registry_digest`, `policy_digest`, `schema_digest` | IF-15 snapshots | Partial; no bundle/algorithm/dependency/reason/revocation snapshots. |
| `idempotency_key`, `principal_id`, `interface_inventory_id` | IF-14 request identity | Core request fields are consistent; no request ID or correlation ID. |
| `evidence_refs` | IF-14 evidence references | Bounded digest references; domain vocabulary mismatch persists. |
| `a09_decision_digest` | A09 guard | Correctly conditional for A09 `PASSED`; release and acceptance validity are not represented. |
| `decision` | Boundary result | Only `ALLOW`/`DENY`, while common result also requires `SUSPEND`, `REVOKE`, `BLOCK`, `NO_MUTATION`. |
| `failure_category`, `reason_code` | Failure result | Singular local code instead of ordered shared reasons. |
| `recorded_at` | Result/event time | Shape consistent; no trusted-clock or boundary identity. |
| `extensions` | Extension policy | Structurally consistent. |

The schema merges IF-14 acceptance and IF-15 persistence into one record, contrary to the explicit
double-validation rule. It lacks separate `interface_id`/`result_id`, acceptance result,
persistence result, transaction outcome, nonce/counter consumption, current/prior event hashes,
outbox ID and atomic-commit representation.

**Verdict:** `DESIGN_PARTIAL_NOT_INTERFACE_CONFORMANT`.

### 4.6 `audit-ledger-record.schema.json`

**Primary interfaces/profiles:** IF-15 `GovernedEvent`, IF-16 delivery, IF-17 anchor and IF-18
reconciliation; fixed B-03 event framing.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `framing_profile` = `AU-GPEP-EVENT-v1` | B-03 fixed event domain; `FRAME-GPEP-EVENT-v1` | Exact fixed ASCII domain is consistent with B-03/vector bytes, but the field name/value is a domain literal rather than the shared registry ID. |
| `ledger_id`, `sequence`, `prev_hash`, `record_hash` | B-03 ledger framing/chain | Core types and genesis zero predecessor are consistent. Successor arithmetic and hash computation are external. |
| `event_id` | Governed event identity | Consistent UUID. |
| `actor_id`, `interface_inventory_id` | Boundary actor/interface | Core audit identities present; actor identity is generic/untyped. |
| `object_id`, `object_version`, `requested_transition` | Governed object transition | Core fields present; prior/new state and expected version are absent. |
| `decision` | Event/audit decision | `ALLOW`, `DENY`, `ORPHAN_REJECTED` differs from vector `ACCEPT` and from the common result decision vocabulary. |
| `failure_category`, `reason_code` | Failure routing | Singular local reason mismatch. |
| `schema_digest`, `policy_digest`, `registry_digest`, `evidence_digest` | Snapshot/evidence bindings | Partial generic snapshots; required distinct registries and receipts are absent. |
| `prior_event_hash`, `current_event_hash` | Object event chain | Optional and semantically overlaps `prev_hash`/`record_hash`; relationship is not defined. |
| `workload_identity` | G-PEP service identity | Partial generic ID; assignment/key/trust evidence absent. |
| `transaction_outcome` | IF-14/IF-15 result | Useful distinction among committed, rolled back and pre-transaction rejection. |
| `correlation_id` | Request/audit correlation | Consistent. |
| `trusted_receipt_time` | Trusted audit receipt time | Consistent shape. |
| `extensions` | Extension policy | Structurally consistent. |

The vector `record_without_hash` is **not an instance of this schema**. It contains
`decision: "ACCEPT"`, `ledger_framing_version`, `schema`, `timestamp`, and nested `transition`;
the schema instead requires the proposal envelope plus `framing_profile`, actor/interface,
digests, workload/transaction/correlation fields, `trusted_receipt_time`, and `record_hash`.
Because `additionalProperties` is false, the vector’s `ledger_framing_version`, `schema`,
`timestamp`, and `transition` are also undeclared. No authoritative rule states whether the
schema instance, `record_without_hash`, or another projection is the bytes to hash.

The schema also omits outbox identity, exact committed bytes identity, WORM acknowledgement,
delivery state, checkpoint identity/hash, Merkle root and reconciliation classification required
across IF-16 through IF-18.

**Verdict:** `DESIGN_INCOMPATIBLE_WITH_VECTOR_PAYLOAD_AND_PARTIAL_FOR_INTERFACES`.

### 4.7 `evidence-acceptance-receipt.schema.json`

**Primary profiles:** publication, QA, independent review, A09 acceptance, execution release,
verifier verdict, suspension, rollback and reinstatement receipts across IF-02 through IF-04,
IF-11, and IF-19 through IF-22.

| Schema fields | Interface mapping | Design disposition |
| --- | --- | --- |
| `contract_status`, `schema_version`, `compatible_major`, `source_trace`, `canonical_profile` | Common proposal/version metadata | Status consistent; identifiers need mapping. |
| `receipt_id`, `receipt_kind` | Receipt object/profile identity | Useful discriminant, but one union is under-constrained for nine materially different profiles. |
| `subject_id` | Receipt subject | Generic and untyped; cannot establish candidate/run/session/object/assignment scope. |
| `candidate_commit`, `candidate_bundle_digest` | Candidate identity | Partial; provenance requires repository, root tree, manifest and publication receipt identities. |
| `evidence_digest` | Supporting evidence | Single untyped digest cannot prove profile-specific prerequisites. |
| `issuer_identity`, `issuer_role` | Signer identity/role | Role vocabulary is useful, but no assignment, mandate, issuer system, effective interval or separation result. |
| `outcome` | Receipt result/state | Aggregates governance, verdict, release and recovery states; conditionals do not constrain most kind/outcome combinations. |
| `failure_category`, `reason_code` | Failure routing | Singular local reason mismatch. |
| `limitations` | Non-authoritative limitations | Useful supplementary metadata. |
| `issued_at`, `expires_at` | Receipt validity | Consistent shape; no `not_before`, counter or revocation epoch. |
| `audience` | Scope binding | Present; repository/environment/run/object scopes absent. |
| `prior_receipt_digest` | Predecessor/supersession | Useful optional link; lifecycle semantics are unspecified. |
| `signature` | Signed receipt | Present, but key-purpose enum cannot represent execution release, verifier verdict, assignment, revocation, trust store, G-PEP event or TMC purposes exactly. |
| `extensions` | Extension policy | Structurally consistent. |

Only `EXECUTION_RELEASE` is conditionally tied to issuer/outcome. Missing kind-specific fields
include publication locator/tree/manifest, QA/review findings, A09 assignment and governance
state, execution run/window/actions/rollback/abort conditions, verifier input set/freshness,
suspension scope, rollback quorum/source/target/compensation, and reinstatement corrected evidence
plus new-release/A09 references.

**Verdict:** `DESIGN_PARTIAL_AND_UNDERCONSTRAINED`.

## 5. State and reason reconciliation

### 5.1 States

- **Producer evidence:** schema includes `MEASURING`, `EVIDENCE_ISSUED`, `RESPONDING`, `FAILED`,
  `ENDED`; shared contract additionally defines `UNINITIALIZED`. The subset can describe issued
  records but is not documented as such.
- **Verifier verdict:** session schema exactly includes `NOT_EVALUATED`, `TRUSTED_ACTIVE`,
  `UNTRUSTED`, `SUSPENDED`, `REVOKED`, `ENDED`.
- **Governed object:** transition/A09 schemas use all nine shared B-03 states. Transition
  `to_status` correctly excludes `NOT_STARTED`.
- **Governance:** A09 `outcome` matches `ACCEPTED`, `REVISE`, `REJECTED`, but `prior_state` is the
  governed-object vocabulary rather than `DRAFT_PRODUCED`, `REVIEW_PENDING`, `REVIEW_COMPLETE`.
- **Run authorization, ARM eligibility, assignment, admission and audit delivery:** not modeled as
  dedicated schema fields/state machines. Receipt `outcome` contains some terminal labels but is
  not an equivalent state contract.
- **Stage registry:** all A01-A12 stage names are present. `DEFINED_DISABLED`,
  `UNDEFINED_BLOCKED`, `ENABLED` are prospective; no schema enables an edge by itself.

### 5.2 Reason codes

The shared contract proposes 25 exact codes. The schema proposes 22 values, including `OK`.
Exact overlap is only:

`E_CONFLICT`, `E_EXPIRED`, `E_IDEMPOTENCY_CONFLICT`, `E_INTERNAL`, `E_REPLAY`, `E_REVOKED`,
`E_SCHEMA`.

Shared-contract codes missing from the schema are:

`E_AUTHN`, `E_AUTHORITY_ABSENT`, `E_SEPARATION`, `E_UNKNOWN_REGISTRY`, `E_KEY_PURPOSE`,
`E_SIGNATURE`, `E_REVOCATION_UNAVAILABLE`, `E_ORDERING_AMBIGUOUS`, `E_SCOPE`, `E_DEPENDENCY`,
`E_ATTESTATION`, `E_LIVENESS`, `E_MODEL_BINDING`, `E_TRANSITION`, `E_AUDIT_DELIVERY`, `E_ANCHOR`,
`E_ROLLBACK_AUTHORITY`, `E_IRREVERSIBLE_EFFECT`.

Schema-only values without an adopted mapping are:

`OK`, `E_AUTHENTICATION`, `E_AUTHORITY`, `E_BINDING`, `E_CANONICAL`, `E_EVIDENCE`, `E_FUTURE`,
`E_INTEGRITY`, `E_MISSING`, `E_POLICY`, `E_STALE`, `E_TOPOLOGY`, `E_UNAVAILABLE`,
`E_UNKNOWN_CRITICAL_EXTENSION`, `E_VERSION`.

Vector-only provisional rejection codes not in either complete schema vocabulary are:

`E_HASH_MISMATCH`, `E_DOMAIN_MISMATCH`, `E_FRAMING_AMBIGUOUS`, `E_TRUNCATED_INPUT`,
`E_VERSION_UNSUPPORTED`. Vector `E_KEY_PURPOSE` exists in the shared registry but not the schema.

All schemas use at most one `reason_code`; the shared result requires an ordered `reason_codes`
array with highest-precedence cause first. No authoritative mapping or precedence table exists.

## 6. Identity crosswalk

Present identity classes include UUID URNs for evidence, session, runtime instance, decision,
event, measurement, ledger and receipt identities; generic bounded IDs for actors, devices,
boots, keys, principals, workloads, repositories and subjects; and a 40-hex Git commit.

The shared contract additionally requires identity-system/issuer IDs, producer and consumer stable
identities, assignment references, mandate/delegation chains, verifier identity, publisher and
release identities, repository stable identity, publication manifest/receipt, run, challenge,
request, outbox, WORM acknowledgement and checkpoint identities. Those are absent or represented
only by untyped digests.

The authority package confirms that Decision Chair name, stable identity, issuer/proofing,
delegating authority, scope, effective interval, conflict result, acknowledgement, revocation
mechanism and run authorization are all missing. Schema shape must not be mistaken for evidence.

## 7. Domain, framing, canonicalization and version crosswalk

- `AU-GPEP-EVENT-v1` is byte-consistent among corrected B-03, audit schema and vectors. The shared
  registry label is `FRAME-GPEP-EVENT-v1`; no authoritative alias binds the label to the domain.
- General signature framing `len32(domain)||domain||len64(payload)||payload` is present in the
  vector package and shared contract, but absent from schema fields.
- `AU-RUNTIME-ATTEST-v1` exists only as a provisional vector domain. The attestation schema does
  not name it, and the shared contract does not adopt a purpose-domain registry entry.
- Canonical identifiers differ: schema `RFC8785-JCS-UTF8`, vector `RFC8785-JCS`, shared registry
  `CANON-JCS-RFC8785-v1`.
- Schema hash domains `checkout_bytes`, `git_blob_lf`, `rfc8785_jcs_utf8`,
  `framed_binary_v1` do not exactly match provenance domains
  `raw-working-tree-sha256-v1`, `crlf-to-lf-sha256-v1`, `git-blob-oid-v1`,
  `git-index-path-binding-v1`, `git-commit-path-binding-v1`,
  `candidate-manifest-identity-v1`, and `publication-receipt-identity-v1`.
- Schema IDs use `urn:au-ucr:wave-0.5:schema:<name>:1.0.0`. Vectors use
  `urn:au-ucr:gpep:event:1.0` and `urn:au-ucr:runtime:attestation:1.0`. No alias, supersession or
  compatibility registry connects them.
- `schema_version: 1.0.0` plus `compatible_major: 1` does not define whether `1.0`, `1.0.0` or a
  URN-embedded version is authoritative, nor minor/patch compatibility behavior.
- Current repository object format is SHA-1, matching `gitSha1`, but provenance requires object
  format and repository identity to travel with every OID.

## 8. Mismatch register

### Cross-cutting — 10

1. `RC-X01` — Seven record schemas omit the complete shared signed-object envelope.
2. `RC-X02` — Seven record schemas omit the complete consumer verification-result contract and
   use singular local reasons.
3. `RC-X03` — Schema, shared-contract and vector reason-code vocabularies are not mapped.
4. `RC-X04` — Local signature key-purpose enum does not match the proposed shared registry.
5. `RC-X05` — Literal algorithm/canonical/framing names do not use shared registry IDs/digests.
6. `RC-X06` — Schema and vector schema/version identifiers are incompatible without an alias.
7. `RC-X07` — Schema hash-domain names do not match the provenance domain policy.
8. `RC-X08` — Generic IDs do not satisfy stable identity, issuer/proofing and assignment binding.
9. `RC-X09` — Signature shape omits issuer chain, key validity/revocation, encoding and domain.
10. `RC-X10` — Critical-extension shape exists, but supported/unknown critical semantics require
    an absent adopted registry and cannot be established by schema alone.

### Record-specific — 17

11. `RC-A01` — Attestation lacks platform/boot/TMC/launcher/process/runtime-key identity.
12. `RC-A02` — Liveness lacks challenge reference, monotonic counter and security flags.
13. `RC-A03` — Inference lacks request ID and input/output commitments.
14. `RC-S01` — Session binding lacks candidate/publication/A09/release/run/registry tuple.
15. `RC-S02` — Session verdict lacks verifier receipt identity, signer and complete input set.
16. `RC-C01` — Effective configuration lacks opened-handle mapping, parsed-byte set and load result.
17. `RC-C02` — Configuration input hash domains conflict with provenance identifiers.
18. `RC-D01` — A09 models governed-object prior state, not prior/next governance state.
19. `RC-D02` — A09 supporting receipt digests are untyped and cannot prove required classes.
20. `RC-D03` — A09 lacks assignment, root-tree, publication-manifest and publication-receipt binding.
21. `RC-T01` — Transition record conflates IF-14 acceptance and IF-15 persistence results.
22. `RC-T02` — Transition record lacks atomic event/outbox/nonce/current-hash transaction output.
23. `RC-L01` — Ledger vector `record_without_hash` is not an audit-schema instance.
24. `RC-L02` — Audit schema lacks IF-16/IF-17 delivery, WORM and checkpoint binding.
25. `RC-L03` — No authoritative hash projection defines `record_without_hash`.
26. `RC-R01` — One receipt union under-constrains nine different interface profiles.
27. `RC-R02` — Receipt schema lacks the profile-specific prerequisite and scope fields.

## 9. Unresolved authoritative-source questions — 8

1. Which body adopts the shared contract, interface matrix, schema bundle, vector domains and
   registries, and through what exact-candidate receipt?
2. Which identifier is authoritative for each schema/version: Wave 0.5 `$id`, vector `1.0` URN,
   semantic `1.0.0`, or a future registry entry?
3. Is the ledger hash payload the full audit schema minus `record_hash`, the vector
   `record_without_hash`, or another formally declared projection?
4. Does `AU-RUNTIME-ATTEST-v1` become the adopted attestation signature domain, and which key
   purpose/schema set may use it?
5. What are the authoritative reason-code mappings and validation precedence across schema,
   shared contract and vectors?
6. What are the authoritative aliases between schema hash domains and provenance identity domains?
7. Must each interface profile have a separate schema, or may discriminated unions be used with
   complete kind-specific conditionals?
8. What adopted identity, assignment, trust-root, revocation and publication sources turn generic
   IDs/digests into effective authority evidence?

## 10. Final design disposition

All eight inspected schemas preserve `PROPOSED_NOT_ADOPTED` intent. Their strict unknown-field
policy, bounded values, UTC timestamp profile, SHA-256 syntax, JCS intent, A01-A12 enum, governed
object state vocabulary, verifier verdict vocabulary and fixed G-PEP event domain are useful and
generally consistent as design building blocks.

They do not yet implement the completed shared envelope, verification result, registry, identity,
provenance and interface contracts. The ledger schema/vector incompatibility is a direct design
integration defect, while the other findings are principally missing bindings, unmapped
vocabularies or under-constrained profile semantics.

Disposition:

`SCHEMA DESIGN PRESENT -> 27 RECONCILIATION MISMATCHES -> AUTHORITATIVE SOURCES UNRESOLVED -> NO VALIDATOR EXECUTION -> NOT ADOPTED -> NO IMPLEMENTATION OR EXECUTION`

