# F-04 Independent Wave 0.5 Technical Assurance Report

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-REVIEW`
- **Experiment:** `AU-UCR-EP-000001`
- **Wave:** `0.5`
- **Artifact:** `F-04_INDEPENDENT_WAVE_0.5_ASSURANCE_REPORT`
- **Reviewer label:** `Agent F`
- **Repository:** `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- **Branch inspected:** `cursor/populate-authority-readiness-7886`
- **Baseline and current HEAD inspected:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Git object format:** `sha1`
- **Review date:** 2026-10-12
- **Review mode:** read-only technical inspection, strict JSON parsing, exact-byte hashing, Git
  metadata inspection, and independent standard-library-only recomputation of published vector
  bytes and SHA-256 values
- **Schema-validator execution:** **NONE — AUTHORIZATION UNRESOLVED**
- **Package disposition:** **OPEN — MATERIAL DESIGN RECONCILIATION REQUIRED; FORMAL REVIEW ALSO
  BLOCKED BY DEPENDENCY**
- **Acceptance effect:** **NONE**
- **Authorization effect:** **NONE**

This report does not accept, adopt, publish, validate, certify, implement, construct, test,
commit, push, merge, release, or operate anything. It does not appoint a reviewer, Decision Chair,
Coordinator/Architect, publisher, QA actor, adoption authority, verifier, or other governed role.
It does not open G3 or authorize G4.

## 2. Scope and method

The assessment applied `W05_REVIEW_PREPARATION_MATRIX.md` to all 43 pre-F-04 Wave 0.5 files then
present. It inspected:

- eight JSON Schema documents, the schema README, fourteen fixtures, and the fixture manifest;
- the eight-vector bundle, derivation report, generator, and reproducer;
- the shared trust/state contract and all 22 interfaces;
- authority closure and G3/G4 receipt requirements;
- publication/provenance design and unauthenticated-evidence register;
- the five Wave 2 reconciliation reports:
  `W05_SCHEMA_CONTRACT_RECONCILIATION.md`,
  `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md`,
  `W05_CROSS_CONTRACT_INTEGRATION_REPORT.md`,
  `W05_AUTHORITY_CONTRACT_CROSSWALK.md`, and
  `W05_IMMUTABLE_REFERENCE_CROSSWALK.md`; and
- the authorization input, baseline inventory, nine-objection matrix, and review-preparation
  matrix.

Read-only computation:

1. measured byte count and SHA-256 over every exact current file;
2. parsed all 24 JSON files with duplicate-key rejection and rejection of non-finite constants;
3. resolved every local schema `$ref` syntactically to an existing `common.schema.json` definition;
4. verified all 14 fixture-manifest paths exist and parse;
5. independently reimplemented restricted sorted-key/minified UTF-8 serialization, unsigned
   big-endian length framing, ledger framing, signature-input framing, and SHA-256 without
   importing either vector script;
6. checked 27 independent vector byte/frame/digest assertions across eight derived byte objects;
7. directly compared the published genesis `record_without_hash` keys and decision value with the
   proposed audit-ledger schema; and
8. confirmed no Wave 0.5 path exists in baseline `HEAD`.

This was structural inspection, not JSON Schema validation. Fixture labels remain proposed
oracles. No schema meta-validation, format assertion, `$ref` evaluation, positive/negative
validator run, ES256 operation, generalized RFC 8785 conformance test, or runtime enforcement test
was performed.

## 3. Independence limitation

Agent F authored `W05_REVIEW_PREPARATION_MATRIX.md` and then used that method for this review.
That is disclosed methodological participation and creates anchoring risk. Agent F did not author
or edit the Agent A-E source outputs reviewed here and independently recomputed vector bytes
without importing Agent B tooling. However:

1. `Agent F` is a label, not a stable governed identity or effective Independent Reviewer
   assignment;
2. no assignment-authority chain, acknowledgement, effective interval, conflict/separation
   receipt, key-purpose evidence, or candidate-bound review request exists;
3. no effectively assigned authority has determined whether method authorship is compatible with
   formal reviewer independence;
4. the reviewed files are mutable working-tree objects, not one fixed immutable candidate; and
5. this report therefore supplies technical assurance findings only and cannot satisfy the formal
   G3 independent-review receipt.

Another effectively assigned reviewer must review the eventual immutable corrected candidate and
must account for Agent F's prior method authorship if this report is used as evidence.

## 4. Exact reviewed artifact inventory

SHA-256 values are over exact current working-tree bytes observed before this report was created.
They are present-byte identities, not Git blob/path identities or publication identities.

### Control, contract, authority, provenance and reconciliation artifacts — 15

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `W05_AUTHORITY_CLOSURE_PACKAGE.md` | 10,214 | `0a68d732b711e0921eb1d4577e9bfc8ff811314c5ec101cc9b73221d1a6ac758` |
| `W05_AUTHORITY_CONTRACT_CROSSWALK.md` | 21,054 | `1ddf84e3418c05387a3b7bda0d7f871f785f6825e7824c05a43d8926b051d785` |
| `W05_AUTHORIZATION_INPUT_RECORD.md` | 3,382 | `cdbab1cb272c49e59c008281b2ca6a9a8633678a2ef373bec7f7d4d6294fe75b` |
| `W05_BASE_VERIFIED_INVENTORY.md` | 5,512 | `db989f8102c86a57786291532072cdc4994f73bce615ecdfd6553b851893b7da` |
| `W05_CROSS_CONTRACT_INTEGRATION_REPORT.md` | 27,894 | `24a26503dc78d41d9fb4eb92d0abe2dc52252a896f46bda8a59148ce481e81bc` |
| `W05_G3_G4_RECEIPT_REQUIREMENTS.md` | 11,124 | `691ddbc4cfeb10a9c6670439f93c4c9631b025e5a38c6303989d38957df46273` |
| `W05_IMMUTABLE_REFERENCE_CROSSWALK.md` | 19,876 | `60db67bdc70a34ab87282c65bd2abb86dbd458582bc6a107520bcddd5e58c022` |
| `W05_INTERFACE_MATRIX.md` | 26,783 | `6a55167960924545802870d58fc03a1eac2b1c601d5841f6da374f153225724a` |
| `W05_NINE_OBJECTION_CLOSURE_MATRIX.md` | 3,586 | `599cdd7fd83c0ae2853ff9bd32ab19a86bc4f813b3235b70f757956e92948bde` |
| `W05_PUBLICATION_AND_PROVENANCE_SPEC.md` | 12,136 | `1a400cde91c4bee964897de091583f4afcc88091d08534824e8fca1103845ca6` |
| `W05_REVIEW_PREPARATION_MATRIX.md` | 24,790 | `7f640055a1979c158f993afc4136d71f857419f217121d46ca20fdea6f520b7f` |
| `W05_SCHEMA_CONTRACT_RECONCILIATION.md` | 36,170 | `1518760e9b571828b576d4865f6ce0f1bbbb38f524d88442c70b7e699ccca94b` |
| `W05_SHARED_TRUST_AND_STATE_CONTRACT.md` | 29,788 | `03b821e401d58e06799f85e02031b885ca2cb3351fdb7198929c222e7d796c71` |
| `W05_UNAUTHENTICATED_EVIDENCE_REGISTER.md` | 12,753 | `c7bd184807c0f88833d4c00b0c4964b098c25b807cbb2d9324198563ff517055` |
| `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md` | 19,877 | `f5a03dbb5d4ff570a3d59415150d49ed7b952cc3ed61967fd3b59b05795eb5bd` |

### Schema package — 24

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `schemas/README.md` | 3,957 | `0b44a9c0ee932a9cb7eb107758e265fcb3bc5db7c10156a00d52b0bd7f2c3ddb` |
| `schemas/a01-a12-transition-record.schema.json` | 3,474 | `223e45d4fca1bfd553f671cb167ace008c4e5c2c64c1722fb9f98723ed92e68b` |
| `schemas/attestation-evidence.schema.json` | 2,961 | `d1110bfb28370d26f67cf838da45703f0ce8fdaddaa8d1c48d2fbc03412f4d39` |
| `schemas/audit-ledger-record.schema.json` | 3,561 | `d1c45cc7caeb26bbb139c9e5e3455faaf780ef781e2b7654837d1cce70ac6082` |
| `schemas/authorization-a09-decision.schema.json` | 3,931 | `87b85790c1bfecbdcd0690810f4daec6af5b6a5e1859b151e90d27ae973fccf8` |
| `schemas/common.schema.json` | 3,604 | `305d3636fd3b9e7a3af1ad2e180e4aa331595e783a1bb457af0f278fff7d4a1d` |
| `schemas/effective-configuration-measurement.schema.json` | 2,803 | `2d4f7b4ada5b46839e73734d184dc493c46c6f3d8045f1da96039acc95bfe60d` |
| `schemas/evidence-acceptance-receipt.schema.json` | 3,260 | `8a9f5d2a3c8d46e31e02197f312a8e0e7328db63f5ba77ef981d86907969bc7f` |
| `schemas/session-binding.schema.json` | 2,777 | `251ba65dbb1aec55cac4baa9ecf321063c93b218322fc46f23b0c06010466aff` |
| `schemas/fixtures/a01-a12-transition-record.negative.json` | 610 | `cb569f5515b56269c24045e3e299bc863ea9e49714caf1edaaba40a9617bd5ec` |
| `schemas/fixtures/a01-a12-transition-record.positive.json` | 1,064 | `0cddd7ba28ff8d8899712cd1ff1836e7b43c51744ca33e4788cfb8cdb8f6bd81` |
| `schemas/fixtures/attestation-evidence.negative.json` | 596 | `42a5973b4e34e92abdd909eeea41d62526bd73263953bf57d566168da79ef6b8` |
| `schemas/fixtures/attestation-evidence.positive.json` | 1,451 | `37df9bc5e74b18c53975734464cd9200d5213c6a74a0ad07e430b0f93d868d3e` |
| `schemas/fixtures/audit-ledger-record.negative.json` | 695 | `6834984ddc105d902c2a45608c38bff3de5bdb1d5fa7b8c3074a8a7e5a0fa38b` |
| `schemas/fixtures/audit-ledger-record.positive.json` | 1,247 | `a42c07301d475d57e55dabe3e29d085f11b0d662a1997bf67f17112eb99e8884` |
| `schemas/fixtures/authorization-a09-decision.negative.json` | 848 | `ec3a51760c9fc1d4da583702625521dacbadb574e79b7ddac1a474c6c1d85a9f` |
| `schemas/fixtures/authorization-a09-decision.positive.json` | 1,970 | `b7e658defe2b68390f819c540902ba91322b206cc4daa0d62c9cc366a48379ca` |
| `schemas/fixtures/effective-configuration-measurement.negative.json` | 434 | `8eadbd8851b797ca95e3bed20752045c2f2b0d57a5c249117d6fc8286e650bb2` |
| `schemas/fixtures/effective-configuration-measurement.positive.json` | 1,134 | `09515f27aef760914058fdfad8c05a3d8f68829c48ca3d5f20a0f0fa56bf83e1` |
| `schemas/fixtures/evidence-acceptance-receipt.negative.json` | 491 | `6a234eadf7d5ec699209cbc71257c80919eb5c9af616c77192a7ddbc84af46eb` |
| `schemas/fixtures/evidence-acceptance-receipt.positive.json` | 1,144 | `4ff585aeb5a10b97d5888b8f50c90b95a19700da40fe226a7d9c170f80aba733` |
| `schemas/fixtures/manifest.json` | 2,631 | `a0816f222d5bd02a0d698828b6f564d5c841e77ae6a24ba3195c7a5062e7d1d3` |
| `schemas/fixtures/session-binding.negative.json` | 545 | `5368d4378373d8adc7998546071290b291e7574a170fddaed5de7abe05c8d867` |
| `schemas/fixtures/session-binding.positive.json` | 1,153 | `4a5c3af5b183e488bdb46e4a5016fdf382b075fba6a2bfd9e5b402861de032c1` |

### Vector package — 4

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json` | 29,306 | `b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1` |
| `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md` | 9,440 | `074680a7b3cdf50a8b306b7b0b0ebc251188778c6cf4986da66741921fdb987c` |
| `vectors/derive_vectors.py` | 12,665 | `5ecc7bfbb5d3b94d28e3f84fe9586b2d4425f481f826335231fa980ad2bb4b50` |
| `vectors/reproduce_vectors.py` | 5,154 | `b3fea56a7fab3480338ef61ae7c42dc0bd7f798dd5bede0b2bb76c3ba4dbcd4d` |

Inventory count: **43** inputs. None is contained in `HEAD`.

## 5. Schema completeness and fixture coverage

### Structural inspection

- JSON files parsed with duplicate-key rejection: **24 of 24**.
- Schema files inspected: **8 of 8**.
- Schemas declaring draft 2020-12 and a unique `$id`: **8 of 8**.
- Record schemas with `additionalProperties: false`: **7 of 7**.
- Local `$ref` occurrences syntactically resolved to present common definitions: **156 of 156**.
- Manifest fixture paths present and JSON-parseable: **14 of 14**.
- Positive fixture labels: **7**.
- Negative fixture labels: **7**.
- Validator executions and established fixture outcomes: **0**.

The package is not complete against the later common contract. All seven record schemas omit the
complete common signed envelope and verification result. An ARM schema is absent. Dedicated
schemas are absent for assignment/delegation, acknowledgement, candidate review, exact-run
release, verifier challenge, platform enrollment/quote result, provider/model statement, outbox,
delivery acknowledgement, anchor, revocation snapshot, reconciliation, rollback, and
reinstatement. Generic IDs, generic digests, a four-purpose signature enum, and one multipurpose
receipt cannot establish those contracts.

Fixture coverage is shallow: one intended-positive and one intended-negative document per record
schema. It does not provide requirement-complete minimum/maximum coverage, all boundary values,
every conditional branch, duplicate-key byte fixtures, unknown critical-extension behavior,
cross-record references, state races, replay/counter ordering, revocation, candidate/audience
misbinding, rollback, or the 22 interfaces. Several negative fixtures intentionally combine many
defects, so a future validator result would not establish that each target fails independently or
with the expected reason/precedence.

## 6. Vector reproducibility and schema compatibility

Independent standard-library-only recomputation passed **27 of 27** byte/frame/digest assertions
across **8** independently assembled byte objects. Reproduced values:

- bundle: `b074af8678ffdfad3ce688f8fe89d1469eb87d128e071e78311b1c752b0855a1`;
- genesis: `f2b8d64cc6e3f50a8af46f37ff35d9843708649ff37bfbd4f00354086f18ddf9`;
- successor: `985f9c99648478643c886f5d42fe11f2fa0b43a666e528f9de0f8430be02ff2d`;
- single-record attestation input:
  `6e5c1474a899f1986e42aa58522b398e9bd7e955bf8e5102bdf893275238f180`;
- chain-head attestation input:
  `cb29e2ea4c7624e57714a24f069d60af7eae972b9510b615e0a83989023c0685`.

This establishes exact restricted-subset byte reproducibility for the current bundle. It does not
establish general RFC 8785 conformance, validator conformance, ES256 verification, identity,
authority, or adoption.

Direct compatibility comparison failed. The genesis vector's `record_without_hash`:

- lacks **22** fields required by `audit-ledger-record.schema.json`;
- contains **4** fields undeclared by that schema;
- uses `decision: "ACCEPT"`, while the schema permits `ALLOW`, `DENY`, or `ORPHAN_REJECTED`; and
- uses a different schema ID/version and no normative projection for excluding `record_hash`.

All six negative vectors have sound fail-closed intent, but none has an exact rejection code
registered consistently in both `common.schema.json` and the shared reason registry. Actual
rejection behavior was not executed.

## 7. Cross-contract assurance

The shared contract and 22-interface matrix are strong prose designs for ownership separation,
state separation, denial precedence, G3/G4 separation, immutable history, fail-closed behavior,
and bounded rollback. They are not yet one interoperable contract.

Independent review confirms the Wave 2 integration count:

- `ALIGNED`: **0**
- `PARTIAL`: **19**
- `CONFLICT`: **2** (`IF-08`, `IF-15`)
- `BLOCKED_BY_ADOPTION`: **1** (`IF-02`)

Material cross-contract conflicts:

1. schema, vector, and contract schema/version identifiers are not mapped;
2. key-purpose vocabularies conflict;
3. schema, vector, and contract reason-code vocabularies conflict;
4. vector ledger objects conflict with the audit schema;
5. schema hash-domain names do not match the provenance domain registry;
6. transition schema conflates IF-14 ingress acceptance and IF-15 persistence;
7. no normative ledger hash projection resolves which fields are canonical record bytes; and
8. the common envelope, consumer result, identity/assignment and per-interface object bindings are
   absent from the record schemas.

## 8. Authority and publication assurance

Authority remains absent, not merely unverified:

- ten human-authority evidence gaps remain open;
- Decision Chair: `UNASSIGNED`;
- effective Independent Reviewer and QA assignments: absent;
- Coordinator/Architect assignment: absent;
- assignment/acknowledgement/separation schemas and receipts: absent;
- G3 QA, review, closure and acceptance receipts: absent;
- G4 exact-run release: absent;
- A09: `UNRESOLVED`.

`"Human approved."` cannot establish identity, mandate, scope, effective interval,
acknowledgement, separation, publication permission, schema-validation permission, adoption,
acceptance, or release.

The provenance design correctly distinguishes raw, LF, Git-object, index, commit-path, manifest,
receipt, and repository identities. Current evidence has none of the required immutable layers:

- all Wave 0.4 and Wave 0.5 artifacts are untracked and mutable;
- no candidate content commit/tree or complete review manifest exists;
- no remote immutable locator or publication receipt exists;
- no authorized publisher identity/signature exists;
- the 20-item Wave 0.4 manifest and final Wave 0.5 review manifest hierarchy is not defined; and
- historical commit `2ea38d86a19697b80a827d2dfd83a9219e145532` remains unsupported and
  was not replaced by the distinct nearby object.

## 9. Failure-closed and rollback consistency

Prose-level consistency is substantial:

- unknown, missing, stale, revoked, contradictory or unavailable prerequisites deny or suspend;
- revocation/suspension outrank positive states;
- G3 does not imply G4;
- rollback preserves history and creates a new version/session;
- rollback requires a known-good exact target and bounded authority;
- failed publication or candidate drift invalidates stale evidence and triggers re-review; and
- reinstatement requires corrected evidence and new receipts.

Machine-level consistency is incomplete. The schemas do not encode complete precedence, rollback
quorum/target/side-effects, reinstatement prerequisites, common ordered reason codes, complete
authority lifecycle, run binding, revocation snapshot, or audit/outbox/anchor chain. Therefore
the package specifies fail-closed intent but does not yet provide a coherent machine contract that
could demonstrate it.

## 10. Nine-objection classifications

| Objection | Classification | Basis |
| --- | --- | --- |
| `W05-OBJ-01` | **OPEN** | Seven record schemas and fixtures exist, but no ARM schema exists; attestation/session/config schemas are partial against IF-05 through IF-13; fixture coverage is shallow; no validator evidence exists. The supplied design itself is incomplete, so this is not only verification pending. |
| `W05-OBJ-02` | **OPEN** | Transition/authority/audit schemas and reproducible vectors exist, but ledger vector and audit schema are directly incompatible, hash projection is undefined, IF-14/IF-15 are conflated, reasons conflict, and conformance is absent. |
| `W05-OBJ-03` | **BLOCKED BY DEPENDENCY** | Publication design is complete enough to act later, but SCRUM04 and the full reviewed candidate have no containing commit, canonical manifest, authorized publication, or receipt. |
| `W05-OBJ-04` | **BLOCKED BY DEPENDENCY** | LAB identity requirements are specified, but LAB-03 and evidence remain untracked and unpublished; publication authority and receipt are absent. No construction is required for this conclusion. |
| `W05-OBJ-05` | **BLOCKED BY DEPENDENCY** | Freeze, two-commit/external-envelope, amendment and rollback procedures are specified, but the complete package remains mutable. Commit/push/publication authority is absent. |
| `W05-OBJ-06` | **BLOCKED BY DEPENDENCY** | Authority requirements and fail-closed lifecycle are specified, but no stable named effective assignments, mandate chains, acknowledgements or separation receipts exist. General approval is ineffective. |
| `W05-OBJ-07` | **OPEN** | A proposed shared registry exists, but schema/vector/contract identifiers, key purposes, reasons and domains conflict; identity and dependency objects are partial. Adoption absence cannot conceal these design mismatches. |
| `W05-OBJ-08` | **OPEN** | The prose vocabulary and precedence are substantial, but 19 interfaces are partial, two conflict, several state machines have no machine object, and transition/rollback/reinstatement contracts are incomplete. |
| `W05-OBJ-09` | **OPEN** | Exact schemas, one closed reason registry, requirement-complete fixtures, schema-conformant vectors, validator results, complete evidence, reconciled contracts and immutable publication are absent. Byte-reproducible vectors alone cannot close the aggregate objection. |

Classification count:

- **RESOLVED WITH EVIDENCE:** 0
- **DESIGN ADDRESSED — VERIFICATION PENDING:** 0
- **OPEN:** 5
- **BLOCKED BY DEPENDENCY:** 4
- **Total:** 9

## 11. Fifty-check result

`PASS` means the permitted read-only evidence supported the narrow check. It does not mean
acceptance. `FAIL` means supplied design/evidence did not satisfy the check. `PARTIAL` means some
elements were present but required coverage was incomplete. `NOT RUN` preserves the validation or
cryptographic boundary. `BLOCKED BY DEPENDENCY` names an unavailable external prerequisite.

### Candidate fixation — 5

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-CAND-01` | `PASS` | All 43 pre-report files, five Wave 2 reports, and all required families enumerated. |
| `W05-CHK-CAND-02` | `PASS` | Exact path, bytes and SHA-256 measured for 43 files. |
| `W05-CHK-CAND-03` | `FAIL` | No one governed candidate manifest binds the full set. |
| `W05-CHK-CAND-04` | `FAIL` | No Wave 0.5 blob/tree/commit, publication or supersession identity. |
| `W05-CHK-CAND-05` | `PARTIAL` | End-of-review status can detect observed mutation, but mutable untracked files cannot be fixed by review. |

### Schema completeness — 9

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-SCH-01` | `PASS` | Eight schemas inventory draft and IDs; seven record schemas plus common definitions. |
| `W05-CHK-SCH-02` | `PARTIAL` | Required/optional fields and no-null policy exist, but common envelope/profile applicability is absent. |
| `W05-CHK-SCH-03` | `PARTIAL` | Many lexical/count bounds exist; aggregate resource, cross-record and interface bounds are incomplete. |
| `W05-CHK-SCH-04` | `PARTIAL` | Timestamp/UUID/digest patterns exist; identity, canonical/profile and version mappings conflict. |
| `W05-CHK-SCH-05` | `PARTIAL` | Unknown properties are closed and extension shape exists; supported-critical registry behavior is external. |
| `W05-CHK-SCH-06` | `PARTIAL` | Some `if/then` constraints exist; most kind-specific, temporal, lifecycle and cross-object constraints are absent. |
| `W05-CHK-SCH-07` | `FAIL` | Complete authority, replay, publication, run and candidate-binding constraints are absent. |
| `W05-CHK-SCH-08` | `FAIL` | Prose fails closed, but closed reason/state contracts conflict or are missing from schemas. |
| `W05-CHK-SCH-09` | `BLOCKED BY DEPENDENCY` | Schema validator execution was not authorized and was not performed. |

### Fixture coverage — 7

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-FIX-01` | `PARTIAL` | Seven positive/seven negative fixtures exist, not a complete requirement-to-fixture map. |
| `W05-CHK-FIX-02` | `FAIL` | No systematic valid minimum and maximum/representative coverage per rule. |
| `W05-CHK-FIX-03` | `PARTIAL` | Combined negatives cover several missing/extra/wrong values, not each rule independently; duplicate-key byte cases absent. |
| `W05-CHK-FIX-04` | `PARTIAL` | Some bounds and timestamp defects exist; Unicode and resource-limit coverage is incomplete. |
| `W05-CHK-FIX-05` | `PARTIAL` | A few conditionals are targeted; state/authority/cross-object branches are incomplete. |
| `W05-CHK-FIX-06` | `FAIL` | Replay, stale evidence, revocation and wrong candidate/audience fixture coverage is not complete. |
| `W05-CHK-FIX-07` | `NOT RUN` | No validator or reason/state aggregator was authorized or executed. |

### Vector reproducibility — 6

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-VEC-01` | `PASS` | Semantic inputs, canonical subset bytes, preimages and expected digests are published. |
| `W05-CHK-VEC-02` | `PASS` | Restricted-subset canonical bytes independently recomputed exactly. |
| `W05-CHK-VEC-03` | `PASS` | Genesis and successor framing/hashes independently reproduced. |
| `W05-CHK-VEC-04` | `NOT RUN` | Signature inputs reproduced, but no ES256 signatures or authorized keys exist. |
| `W05-CHK-VEC-05` | `PARTIAL` | Negative bytes/digests reproduce and fail-closed intent is sound; rejection implementations and exact oracles were not run. |
| `W05-CHK-VEC-06` | `FAIL` | Bytes agree, but schema IDs, record shape, key purposes and reason codes materially mismatch. |

### Shared contracts — 7

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-CON-01` | `PARTIAL` | Stable identity requirements are specified; schema bindings and effective identities are absent. |
| `W05-CHK-CON-02` | `FAIL` | Algorithm semantics broadly align, but canonical, framing and key-purpose identifiers conflict. |
| `W05-CHK-CON-03` | `PARTIAL` | Lifecycle requirements exist; adopted roots, revocation, time and stores do not. |
| `W05-CHK-CON-04` | `PARTIAL` | Dependency registry design exists; per-interface schemas and verified dependencies are absent. |
| `W05-CHK-CON-05` | `PARTIAL` | Core state vocabulary aligns; reasons and several state machines are incomplete. |
| `W05-CHK-CON-06` | `PARTIAL` | Suspension/rollback prose aligns; machine bindings, quorum, targets and reinstatement are incomplete. |
| `W05-CHK-CON-07` | `PARTIAL` | Fail-closed prose is strong; conflicting schemas/registries prevent one enforceable contract. |

### Authority provenance — 5

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-AUT-01` | `BLOCKED BY DEPENDENCY` | No effective mandate/delegation chain. |
| `W05-CHK-AUT-02` | `BLOCKED BY DEPENDENCY` | No stable assignee, effective scope/time or acknowledgement. |
| `W05-CHK-AUT-03` | `BLOCKED BY DEPENDENCY` | No governed conflict/separation receipt. |
| `W05-CHK-AUT-04` | `BLOCKED BY DEPENDENCY` | Lifecycle is specified but no authoritative status/event evidence exists. |
| `W05-CHK-AUT-05` | `BLOCKED BY DEPENDENCY` | Labels/general approval are correctly rejected, but no candidate/run-bound authority exists. |

### Publication identity — 5

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-PUB-01` | `BLOCKED BY DEPENDENCY` | Files are untracked; no immutable repository objects bind the candidate. |
| `W05-CHK-PUB-02` | `BLOCKED BY DEPENDENCY` | Domain design exists, but no adopted canonical manifest/digest. |
| `W05-CHK-PUB-03` | `BLOCKED BY DEPENDENCY` | Publisher identity, authority, signature and receipt absent. |
| `W05-CHK-PUB-04` | `BLOCKED BY DEPENDENCY` | No published candidate exists to retrieve. |
| `W05-CHK-PUB-05` | `PARTIAL` | Amendment/revocation/partial-publication behavior is specified but not represented by effective receipts. |

### Failure-closed behavior and rollback — 6

| Check | Result | Evidence |
| --- | --- | --- |
| `W05-CHK-FCR-01` | `PASS` | Contract/matrix consistently map dependency failure to OFF, blocked, suspended or quarantined state. |
| `W05-CHK-FCR-02` | `PARTIAL` | Prose rejects unknowns; incompatible reason/profile registries prevent uniform machine behavior. |
| `W05-CHK-FCR-03` | `PARTIAL` | Authority/trust invalidation is specified; schemas and effective status evidence are incomplete. |
| `W05-CHK-FCR-04` | `PASS` | Review method requires unexpected acceptance to stop review and open a finding. |
| `W05-CHK-FCR-05` | `PARTIAL` | Rollback target/authority/history/new-version rules align in prose; receipt schema is under-specified. |
| `W05-CHK-FCR-06` | `PASS` | Candidate drift consistently invalidates stale evidence and requires a new review cycle. |

### Check totals

- `PASS`: **9**
- `FAIL`: **8**
- `PARTIAL`: **21**
- `NOT RUN`: **2**
- `BLOCKED BY DEPENDENCY`: **10**
- **Total:** **50**

No failed, partial, not-run, or blocked check is treated as passed.

## 12. Material findings and owner-specific correction requests

### `F04-NMF-01` — Schema package is not complete against its governing interface contract

- **Severity:** material
- **Affected objections:** `W05-OBJ-01`, `W05-OBJ-07`, `W05-OBJ-08`, `W05-OBJ-09`
- **Owners:** Schema owner (Agent A) with Contract owner (Agent C)
- **Finding:** seven narrow record schemas do not implement the later common envelope/result or the
  required ARM and interface object families. Twenty-seven Wave 2 reconciliation mismatches remain.
- **Correction request:** choose the authoritative interface/schema scope; add or explicitly
  defer each missing object schema; bind interface IDs, stable identities, assignments, typed
  registries, candidate/run/publication references, ordered reasons, lifecycle and rollback
  fields; publish requirement-complete fixtures. Do not claim conformance until separately
  authorized validation.

### `F04-NMF-02` — Ledger vectors and audit schema are normatively incompatible

- **Severity:** material
- **Affected objections:** `W05-OBJ-02`, `W05-OBJ-09`
- **Owners:** Schema owner (Agent A), Vector owner (Agent B), Contract owner (Agent C)
- **Finding:** reproducible vector bytes encode an object that is not an audit-schema instance;
  the hash projection, field placement, decision vocabulary and schema IDs conflict.
- **Correction request:** select one authoritative event schema; define the exact
  `record_without_hash` projection without self-reference; decide whether framing fields are
  inside or outside JSON; align decision semantics; regenerate schemas, fixtures and vectors
  together; then obtain independent reproduction and authorized conformance evidence.

### `F04-NMF-03` — Three closed vocabularies conflict

- **Severity:** material
- **Affected objections:** `W05-OBJ-02`, `W05-OBJ-07`, `W05-OBJ-08`, `W05-OBJ-09`
- **Owners:** Contract owner (Agent C), Schema owner (Agent A), Vector owner (Agent B)
- **Finding:** schema, vector and contract reason codes, key purposes, canonical/profile IDs,
  schema versions and hash domains are not one adopted mapping. Negative vector oracles cannot be
  represented consistently.
- **Correction request:** issue one versioned registry or exhaustive authoritative mapping with
  aliases, precedence, deprecation, detecting interface and default safe state; bind every schema
  and vector to its digest; remove unmapped literals.

### `F04-NMF-04` — Authority receipt shapes permit implication hazards

- **Severity:** material governance/safety
- **Affected objections:** `W05-OBJ-06`, `W05-OBJ-07`, `W05-OBJ-09`
- **Owners:** Authority owner (Agent D) with Schema owner (Agent A) and Contract owner (Agent C)
- **Finding:** role labels and signature-shaped fields can satisfy narrow shapes without mandate,
  stable identity, acknowledgement, separation, typed G3 prerequisites or run binding. The generic
  receipt permits invalid kind/role/outcome combinations except one release conditional.
- **Correction request:** add separate assignment, acknowledgement, separation, QA/review/closure,
  A09, exact-run release, revocation, rollback and reinstatement schemas; require typed
  candidate-bound prerequisites and exact key-purpose/role combinations; keep all real authority
  fields empty until governed evidence exists.

### `F04-NMF-05` — Review/publication identity is incomplete and scope hierarchy is unresolved

- **Severity:** material provenance blocker
- **Affected objections:** `W05-OBJ-03`, `W05-OBJ-04`, `W05-OBJ-05`, `W05-OBJ-09`
- **Owners:** Provenance owner (Agent E), Contract owner (Agent C), later authorized publisher
- **Finding:** the package has exact present-byte observations but no immutable candidate. The
  relationship between the 20-entry Wave 0.4 content manifest, 33-member family crosswalk and full
  43-input/future-final-review candidate is not normative.
- **Correction request:** define nested or versioned manifest hierarchy covering all final
  schemas, fixtures, vectors, contracts, authority/provenance records, reconciliation reports and
  review outputs; freeze under explicit authority; create commit/tree/blob and publication
  bindings; independently remeasure; issue an authorized publication receipt. Preserve the
  unsupported historical commit append-only.

Material F-04 findings: **5**. They consolidate and independently confirm issues exposed by the
Wave 2 reports; no source report was edited and no finding is self-closed here.

## 13. Required correction and re-review sequence

1. Agents A, B and C reconcile schemas, event/attestation payloads, hash projection, schema IDs,
   key purposes, domains and one reason registry.
2. Agent A expands schema/fixture coverage for the common envelope/result and required interface
   objects; validator execution remains separately authorized work.
3. Agent D and Agent A produce machine-complete authority/receipt designs without filling or
   inferring real appointments.
4. Agent E and Agent C define the complete nested candidate-manifest hierarchy.
5. An authorized publisher freezes and publishes the exact corrected candidate.
6. Separately assigned QA executes authorized validation/conformance work.
7. A different or compatibility-approved effectively assigned reviewer reviews the exact
   immutable corrected candidate and the QA evidence.
8. Authorized finding/dependency owners close or explicitly disposition every finding.
9. Only a valid Decision Chair may issue G3 acceptance; only afterward may a separately effective
   Coordinator/Architect consider an exact-run G4 release.

Any source correction changes bytes and invalidates this digest-specific assessment for the
changed artifact and its dependents.

## 14. Final disposition and holds

The Wave 0.5 package materially advances design: JSON structure is readable and strict, the
restricted vector bytes reproduce independently, the contract defines strong ownership and
fail-closed principles, authority gaps are candidly blank, and provenance design avoids silent
substitution. Those strengths do not cure the direct schema/vector conflict, registry conflicts,
partial interface machine contracts, absent authority, or absent publication.

Final technical disposition:

**OPEN — MATERIAL DESIGN RECONCILIATION REQUIRED**

Formal review/acceptance disposition:

**BLOCKED BY DEPENDENCY — NO EFFECTIVE REVIEWER ASSIGNMENT OR IMMUTABLE CANDIDATE**

Preserved state:

- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- G4: `NOT AUTHORIZED`
- A09: `UNRESOLVED`
- schema validation: not authorized/not run
- acceptance: none
- execution release: none
- implementation/construction/testing: not authorized
- commit/push/publication/merge: not authorized

`TECHNICAL REVIEW COMPLETE -> 5 OPEN OBJECTIONS + 4 DEPENDENCY-BLOCKED OBJECTIONS -> CORRECTIONS REQUIRED -> NEW IMMUTABLE CANDIDATE AND GOVERNED REVIEW REQUIRED -> NO ACCEPTANCE -> NO EXECUTION`
