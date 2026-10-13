# F-04 Amendment 2 — Final Reconciliation Assurance

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-REVIEW`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `F-04_AMENDMENT-2_FINAL_RECONCILIATION_ASSURANCE`
- **Reviewer label:** `Agent F`
- **Review date:** 2026-10-12
- **Baseline/current HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **F-04 preserved:** 34,734 bytes; SHA-256
  `f4266579f607b9416250db7315bb733936d7321af7b89d92f72e58abd90b67cc`
- **Amendment 1 preserved:** 28,974 bytes; SHA-256
  `4302607f32ced7877bf1e1015715d78ba2c0ad340d752b9992615413370e0893`
- **Schema-validator execution:** **NONE**
- **ES256 signing/verification:** **NONE**
- **Review mode:** read-only strict JSON parsing, structural reference inspection, exact-byte
  hashing, Git metadata inspection, and independent standard-library-only vector recomputation
  without importing or running Agent B code
- **Acceptance/authorization effect:** **NONE / NONE**

This amendment preserves F-04 and Amendment 1 unchanged. It does not edit a source artifact,
validate a schema, perform an ES256 operation, adopt a contract, appoint an actor, accept a
candidate, open G3, authorize G4, commit, push, publish, merge, implement, construct, test, or
operate anything.

## 2. Final scoped snapshot and exact hashes

Before this amendment was created, Wave 0.5 contained **79 mutable working-tree files**. All were
untracked and absent from baseline `HEAD`. This amendment becomes file 80 and therefore cannot
itself be part of the pre-amendment snapshot it reviews.

Inventory digests are SHA-256 over sorted UTF-8 lines:

`repository-relative-path<TAB>raw-byte-count<TAB>raw-sha256<LF>`

They are review indexes, not governed manifests, Git object identities, or publication receipts.

| Evidence set | Members | Inventory SHA-256 |
| --- | ---: | --- |
| `EV2-CAND-79` — complete pre-amendment Wave 0.5 snapshot | 79 | `83e3ce4f9b9f2e189f383033c8202ffe156b95b0648bfb11c1dc1fbd55ece52c` |
| `EV2-SCHEMA-52` — schema/fixture family | 52 | `ee7541846b8c209d0493f827420a590fcba733b20d5eab0296bae212c9b362b2` |
| `EV2-VECTOR-6` — final vector family | 6 | `f379bd7618e959b1123976df62bd88d108ee69c6c153eb8fac60109d14abd835` |
| `EV2-CONTRACT-4` — registry, shared contract, matrix and reconciliation | 4 | `baf9bfd1a6102c531a43e01d6c7ad4f44fc31c9f35908a651f35cd82dd27bf0d` |
| `EV2-PROVENANCE-4` — current provenance family | 4 | `03e264a628f55a73a352ae0c670d6860824b34e8339fecd6c8cd19c315ab4a09` |
| `EV2-AUTHORITY-4` — authority requirements/status family | 4 | `86507568e744368946c3f075cbb4466cc2cc4b0cf354fe81646fdfb47dc439a3` |

Primary final-pass identities:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `W05_VERSIONED_REGISTRY.md` | 42,077 | `0b3ed7e5028167ef45f38d301d685eb78575e9c55cfcc791007b98d0fd157535` |
| `W05_POST_CORRECTION_RECONCILIATION.md` | 8,353 | `2903efabd2715805f19bf029b78def8e061836597ad65228fa3ae14213b85a57` |
| `W05_SHARED_TRUST_AND_STATE_CONTRACT.md` | 28,722 | `ed9c496e597b4b3278c580e44b7c39e3ffe504be7f9af62021f849f4dd5fad91` |
| `W05_INTERFACE_MATRIX.md` | 31,288 | `2855713fce7429f0eddcae8818f344e4cf3670b27ce443585f3c2d70307a721c` |
| `schemas/README.md` | 5,973 | `16782d5a4cffa7b46c2d9b45fae79feaf4404f47e90d22e5b82074bd3b00d194` |
| `schemas/common.schema.json` | 10,636 | `f1c8075a3a3d0a4e573392f3d1c08156cfb4c3305c0ce313faa6eef923ed9c84` |
| `schemas/ledger-head-attestation.schema.json` | 6,439 | `f3ac7f480b2d7b57ddbcb1080018495876aff9e4cbbaa64979d9e8a54d1eebcf` |
| `schemas/fixtures/manifest.json` | 2,228 | `e30484964c9ac326d7ffda75080f0602798779fe3976abdf9f9ff14943be4450` |
| `schemas/fixtures/correction-unit-fixtures.json` | 17,345 | `1cb6299696654d4143d817ecd6fd456b9675152b682b49346fce657e13df6c76` |
| `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json` | 204,024 | `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52` |
| `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md` | 28,725 | `7df3165ca9c66213cbaca08bd566830f48e53a32f5762392385a0d34f2eb9905` |
| `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` | 23,972 | `67fd56cd4b2af1893e77fb28ae5026748703e85ffffc2226659c6f7887d9d81e` |
| `W05_PUBLICATION_AND_PROVENANCE_SPEC.md` | 18,602 | `cedb71405c778770ad7626e5bc0239c8fdbfe0b505064f12de82d89ee9132ec6` |
| `W05_UNAUTHENTICATED_EVIDENCE_REGISTER.md` | 18,327 | `ad7c9838c2781bd02f10a12a7ab0ebc73da1fa6cab5c869f6e9b52d4170be1b5` |
| `W05_IMMUTABLE_REFERENCE_CROSSWALK.md` | 21,887 | `45e59206ee5654100871ab4e1696dbb9e500256f67df92a3a2f4569e54f5604d` |
| `W05_AUTHORITY_CLOSURE_PACKAGE.md` | 13,592 | `70a04edffa45ed7027d70d22039d5dd647633c4fb6eef34fd32df05fa10c6d42` |
| `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md` | 20,520 | `58de9a09fd4b86e84070d23a33ac9f4036d86b8350e2b7c44df66f4bc1cf72d0` |

## 3. Structural schema and fixture inspection

Independent standard-library inspection produced:

- strict JSON parses with duplicate-key/non-finite-constant rejection: **52/52**;
- schema documents: **35**;
- unique schema `$id` values: **35/35**;
- local/relative `$ref` occurrences resolved to present files and JSON Pointers: **576/576**;
- unresolved references: **0**;
- correction-unit fixture target pointers resolved: **57/57**;
- active full-document fixtures: **2**;
- positive/negative subschema unit pairs: **57**, or **114** fragment cases;
- total active fixture cases claimed by the manifest: **116**;
- JSON Schema validator/meta-validator executions: **0**.

The revised ledger-head schema structurally defines:

- `PROFILE-LEDGER-HEAD-SIGNING-v1`;
- the exact seven-property `signingPayload`;
- an `envelopeBinding` that excludes only `payload_digest` and `signature`;
- `SIGENC-ES256-P1363-LOW-S-B64URL-v1`;
- exact IF-17 schema/domain/purpose/profile bindings; and
- a closed ledger-head verification-failure reason set.

The two positive vector objects continue to have exact required/property key-set equality with
the governed-event, governed-ledger-envelope and ledger-head-attestation schemas. These are
structural observations, not schema validation. Full-document positive/negative coverage remains
limited to the governed-event pair; fragment cases do not prove complete-document validity or
semantic/cross-object behavior.

## 4. Independent final-vector recomputation

The reviewer independently implemented restricted sorted-key/minified UTF-8 serialization,
unsigned big-endian length framing, B-03 ledger framing, A-04 signature-input framing, raw
predecessor handling, SHA-256, unpadded base64url decoding, 64-byte P1363 width/range/low-S shape,
the seven-field signing projection, and exact scenario-oracle comparisons.

No Agent B script was imported or run.

Result: **125/125 independent assertions agreed** across all 14 scenarios after intentional
negative values were evaluated against their expected defect:

- 10 ledger-material occurrences recomputed;
- 5 attestation-material occurrences recomputed;
- both raw malformed/truncated inputs rehashed;
- all 14 detector/decision/reason/result oracles matched;
- sequence-gap, fork, wrong-predecessor, duplicate-sequence, illegal-transition and replay
  conditions were independently confirmed;
- vector 008 consistently substitutes `KP-TMC-RUNTIME-v1` in both purpose locations as its
  intentional `E_KEY_PURPOSE` defect; and
- vector 014 exactly reuses vector 001 attestation bytes/object under replay reference
  `W05-VEC-001/attestation`.

Reproduced current values:

- bundle SHA-256:
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`;
- genesis record hash:
  `e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8`;
- successor record hash:
  `06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e`;
- single-head signature-input SHA-256:
  `9f73b04c40d924fcfa677231ce9b1289b725d1bf18e6f884eb2adbfe4368ea44`;
- chain-head signature-input SHA-256:
  `f93d688d9d9d6c59d88465cc0d16fbb58eb94f12f269d3cccc5ee784dee4be39`.

This proves exact restricted-subset byte/oracle agreement only. It does not prove general RFC
8785 conformance, validator outcomes, actual consumer rejection behavior, signature validity,
trust roots, key authority, revocation, replay-store enforcement, or adoption.

## 5. Amendment 1 finding dispositions

| Finding | Classification | Exact evidence and basis |
| --- | --- | --- |
| `A1-NMF-01` | **OPEN** | Registry `0b3ed7e5028167ef45f38d301d685eb78575e9c55cfcc791007b98d0fd157535`, reconciliation `2903efabd2715805f19bf029b78def8e061836597ad65228fa3ae14213b85a57`, README `16782d5a4cffa7b46c2d9b45fae79feaf4404f47e90d22e5b82074bd3b00d194`, and current bundle `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. Registry 1.3.0 and the current reconciliation correctly time-scope old Wave 2/F-04 counts, but both still state that the current family has 8 scenarios; the bundle and derivation report now contain 14. The README also still states that vectors have not been regenerated. Current-state reconciliation is therefore not complete. |
| `A1-NMF-02` | **DESIGN ADDRESSED — VERIFICATION PENDING** | Registry `0b3ed7e5028167ef45f38d301d685eb78575e9c55cfcc791007b98d0fd157535`, ledger-head schema `f3ac7f480b2d7b57ddbcb1080018495876aff9e4cbbaa64979d9e8a54d1eebcf`, and bundle `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. The exact non-self-referential projection, encoding profile, verification order and reasons are now normative within proposed design and independently byte-reproduce. Validator execution, genuine ES256, wrong-encoding/wrong-key/wrong-coverage cryptographic execution and adoption remain absent. |

## 6. Original F-04 finding dispositions

| Finding | Classification | Exact evidence and basis |
| --- | --- | --- |
| `F04-NMF-01` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV2-SCHEMA-52` `ee7541846b8c209d0493f827420a590fcba733b20d5eab0296bae212c9b362b2`. All 35 schema files, 35 unique IDs and 576 references are structurally present/resolved; no validator or requirement-complete full-document suite ran. |
| `F04-NMF-02` | **DESIGN ADDRESSED — VERIFICATION PENDING** | ledger-head schema `f3ac7f480b2d7b57ddbcb1080018495876aff9e4cbbaa64979d9e8a54d1eebcf`; bundle `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. Event/envelope/vector projections agree and 125/125 assertions reproduce; schema validation and consumer enforcement remain pending. |
| `F04-NMF-03` | **DESIGN ADDRESSED — VERIFICATION PENDING** | registry `0b3ed7e5028167ef45f38d301d685eb78575e9c55cfcc791007b98d0fd157535`; common schema `f1c8075a3a3d0a4e573392f3d1c08156cfb4c3305c0ce313faa6eef923ed9c84`. Closed literals and signing profile align in current machine artifacts; adoption/enforcement remain absent and scenario-count status requires correction. |
| `F04-NMF-04` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV2-AUTHORITY-4` `86507568e744368946c3f075cbb4466cc2cc4b0cf354fe81646fdfb47dc439a3`; `EV2-SCHEMA-52`. Purpose-specific authority shapes remain present; no real identity, mandate, assignment, acknowledgement, separation, signature or receipt exists. |
| `F04-NMF-05` | **DESIGN ADDRESSED — VERIFICATION PENDING** | nested specification `67fd56cd4b2af1893e77fb28ae5026748703e85ffffc2226659c6f7887d9d81e`; `EV2-PROVENANCE-4` `03e264a628f55a73a352ae0c670d6860824b34e8339fecd6c8cd19c315ab4a09`. Historical counts are now explicitly non-normative and final membership is dynamically enumerated only at authorized freeze; no hierarchy/freeze/publication is instantiated. |

Original-finding count: **0 RESOLVED WITH EVIDENCE; 5 DESIGN ADDRESSED — VERIFICATION PENDING;
0 OPEN; 0 BLOCKED BY DEPENDENCY**.

## 7. Nine-objection dispositions

| Objection | Classification | Exact evidence and design/dependency distinction |
| --- | --- | --- |
| `W05-OBJ-01` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV2-SCHEMA-52` `ee7541846b8c209d0493f827420a590fcba733b20d5eab0296bae212c9b362b2`. Registered A-04 profiles and fail-closed vocabularies exist. Full-document fixture coverage and authorized validator/semantic conformance remain pending. |
| `W05-OBJ-02` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV2-VECTOR-6` `f379bd7618e959b1123976df62bd88d108ee69c6c153eb8fac60109d14abd835`; bundle `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`. The 14 scenarios now cover the specified ledger chain/state negatives and exact bytes/oracles independently reproduce. Validator, generalized JCS, ES256 and consumer execution remain pending. |
| `W05-OBJ-03` | **BLOCKED BY DEPENDENCY** | `EV2-PROVENANCE-4` `03e264a628f55a73a352ae0c670d6860824b34e8339fecd6c8cd19c315ab4a09`. Publication design exists; authorized freeze, Git identity, publisher and receipt do not. |
| `W05-OBJ-04` | **BLOCKED BY DEPENDENCY** | Same provenance set. LAB-03 remains untracked and unpublished with no authorized immutable binding. |
| `W05-OBJ-05` | **BLOCKED BY DEPENDENCY** | `EV2-CAND-79` `83e3ce4f9b9f2e189f383033c8202ffe156b95b0648bfb11c1dc1fbd55ece52c`; nested specification `67fd56cd4b2af1893e77fb28ae5026748703e85ffffc2226659c6f7887d9d81e`. Dynamic freeze design is corrected, but the package remains mutable and unpublished. |
| `W05-OBJ-06` | **BLOCKED BY DEPENDENCY** | `EV2-AUTHORITY-4` `86507568e744368946c3f075cbb4466cc2cc4b0cf354fe81646fdfb47dc439a3`. Ten authority gaps and all effective governed receipts remain absent. |
| `W05-OBJ-07` | **OPEN** | `EV2-CONTRACT-4` `baf9bfd1a6102c531a43e01d6c7ad4f44fc31c9f35908a651f35cd82dd27bf0d`. Trust/algorithm/purpose/signing design is materially complete, but no instantiated dependency registry exists and current scenario-count statements conflict with the final vector family. Adoption absence does not conceal those supplied-design gaps. |
| `W05-OBJ-08` | **BLOCKED BY DEPENDENCY** | shared contract `ed9c496e597b4b3278c580e44b7c39e3ffe504be7f9af62021f849f4dd5fad91`; matrix `2855713fce7429f0eddcae8818f344e4cf3670b27ce443585f3c2d70307a721c`. State, precedence, failure and rollback design is coherent across 22 interfaces; authorized adoption and demonstrated implementation are absent. |
| `W05-OBJ-09` | **OPEN** | `EV2-CAND-79` `83e3ce4f9b9f2e189f383033c8202ffe156b95b0648bfb11c1dc1fbd55ece52c`. Current-status reconciliation still misstates final vector cardinality; complete full-document validation, cryptographic evidence, closure manifest, QA/review and publication remain absent. |

Objection count:

- **RESOLVED WITH EVIDENCE:** 0
- **DESIGN ADDRESSED — VERIFICATION PENDING:** 2
- **OPEN:** 2
- **BLOCKED BY DEPENDENCY:** 5
- **Total:** 9

## 8. Full 50-check delta from Amendment 1

| Check | Amendment 1 | Amendment 2 | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-CAND-01` | `PASS` | `PASS` | 79 pre-amendment paths enumerated. |
| `W05-CHK-CAND-02` | `PASS` | `PASS` | Exact byte counts/SHA-256 recomputed. |
| `W05-CHK-CAND-03` | `FAIL` | `FAIL` | No instantiated complete candidate manifest. |
| `W05-CHK-CAND-04` | `FAIL` | `FAIL` | No blob/tree/commit/publication identity. |
| `W05-CHK-CAND-05` | `PARTIAL` | `PARTIAL` | Drift is observable but candidate is not fixed. |
| `W05-CHK-SCH-01` | `PASS` | `PASS` | 35 unique draft-2020-12 IDs. |
| `W05-CHK-SCH-02` | `PASS` | `PASS` | Closed profile shapes remain present. |
| `W05-CHK-SCH-03` | `PARTIAL` | `PARTIAL` | Aggregate/semantic resource limits remain external. |
| `W05-CHK-SCH-04` | `PARTIAL` | `PARTIAL` | General JCS/Unicode/format behavior is unverified. |
| `W05-CHK-SCH-05` | `PARTIAL` | `PARTIAL` | Duplicate-key/critical-extension behavior requires consumers. |
| `W05-CHK-SCH-06` | `PARTIAL` | `PARTIAL` | Cross-object and temporal equality remain external. |
| `W05-CHK-SCH-07` | `PARTIAL` | `PARTIAL` | Shapes exist; stateful enforcement is unverified. |
| `W05-CHK-SCH-08` | `PASS` | `PASS` | Registry maps malformed/unsupported inputs to safe states. |
| `W05-CHK-SCH-09` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Validator execution unauthorized/not run. |
| `W05-CHK-FIX-01` | `PARTIAL` | `PARTIAL` | 57 pairs do not map every semantic requirement. |
| `W05-CHK-FIX-02` | `FAIL` | `FAIL` | Full-document min/max coverage absent. |
| `W05-CHK-FIX-03` | `PARTIAL` | `PARTIAL` | Complete missing/null/extra/type/duplicate suite absent. |
| `W05-CHK-FIX-04` | `FAIL` | `FAIL` | Boundary/Unicode/resource suite incomplete. |
| `W05-CHK-FIX-05` | `PARTIAL` | `PARTIAL` | Projection units improved; cross-object cases incomplete. |
| `W05-CHK-FIX-06` | `FAIL` | `FAIL` | Full stale/revoked/wrong-candidate/audience suite absent. |
| `W05-CHK-FIX-07` | `NOT RUN` | `NOT RUN` | No validator/aggregator execution. |
| `W05-CHK-VEC-01` | `PASS` | `PASS` | Semantic inputs/canonical bytes/preimages published. |
| `W05-CHK-VEC-02` | `PASS` | `PASS` | Restricted canonical bytes independently recomputed. |
| `W05-CHK-VEC-03` | `PASS` | `PASS` | Genesis/successor framing/hashes reproduced. |
| `W05-CHK-VEC-04` | `NOT RUN` | `NOT RUN` | No genuine ES256 operation/key. |
| `W05-CHK-VEC-05` | `PARTIAL` | `PARTIAL` | Chain/state negatives added; audience/consumer/crypto execution remains absent. |
| `W05-CHK-VEC-06` | `PASS` | `PASS` | 125/125 independent assertions agree. |
| `W05-CHK-CON-01` | `PARTIAL` | `PARTIAL` | Effective stable identities/repository adoption absent. |
| `W05-CHK-CON-02` | `PARTIAL` | `PASS` | Signing projection/encoding now exact and machine-bound. |
| `W05-CHK-CON-03` | `PARTIAL` | `PARTIAL` | No adopted roots, trust stores or services. |
| `W05-CHK-CON-04` | `PARTIAL` | `PARTIAL` | No instantiated dependency registry. |
| `W05-CHK-CON-05` | `PASS` | `PASS` | State/decision/reason mapping remains coherent. |
| `W05-CHK-CON-06` | `PASS` | `PASS` | Suspension/rollback/reinstatement design remains aligned. |
| `W05-CHK-CON-07` | `PASS` | `PASS` | Unknown/unavailable/incompatible behavior fails closed. |
| `W05-CHK-AUT-01` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No terminating mandate chain. |
| `W05-CHK-AUT-02` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No effective assignee/scope/time/acknowledgement. |
| `W05-CHK-AUT-03` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No governed separation result. |
| `W05-CHK-AUT-04` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No authoritative lifecycle/status evidence. |
| `W05-CHK-AUT-05` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No candidate/run-bound authority. |
| `W05-CHK-PUB-01` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No immutable repository objects. |
| `W05-CHK-PUB-02` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No instantiated manifest/digest. |
| `W05-CHK-PUB-03` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Publisher/authority/signature/receipt absent. |
| `W05-CHK-PUB-04` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No published candidate to retrieve. |
| `W05-CHK-PUB-05` | `PARTIAL` | `PARTIAL` | Dynamic membership/lifecycle design corrected; no receipts. |
| `W05-CHK-FCR-01` | `PASS` | `PASS` | Failure maps to safe state. |
| `W05-CHK-FCR-02` | `PASS` | `PASS` | Unknown profiles/versions do not permit. |
| `W05-CHK-FCR-03` | `PASS` | `PASS` | Invalid authority/trust/evidence suspends or blocks. |
| `W05-CHK-FCR-04` | `PASS` | `PASS` | Unexpected acceptance remains review-stopping. |
| `W05-CHK-FCR-05` | `PASS` | `PASS` | Rollback target/quorum/history/restart design remains complete. |
| `W05-CHK-FCR-06` | `PASS` | `PASS` | Drift invalidates stale review evidence. |

| Result | Amendment 1 | Amendment 2 | Delta |
| --- | ---: | ---: | ---: |
| `PASS` | 18 | **19** | **+1** |
| `FAIL` | 5 | **5** | 0 |
| `PARTIAL` | 15 | **14** | **-1** |
| `NOT RUN` | 2 | **2** | 0 |
| `BLOCKED BY DEPENDENCY` | 10 | **10** | 0 |
| **Total** | **50** | **50** | 0 |

No failed, partial, not-run or blocked result is promoted through aggregation.

## 9. New final-pass finding

### `A2-NMF-01` — Final vector expansion is not consumed by current-status records

- **Classification:** **OPEN**
- **Affected objections:** `W05-OBJ-07`, `W05-OBJ-09`
- **Exact evidence:** registry
  `0b3ed7e5028167ef45f38d301d685eb78575e9c55cfcc791007b98d0fd157535`;
  reconciliation
  `2903efabd2715805f19bf029b78def8e061836597ad65228fa3ae14213b85a57`;
  README
  `16782d5a4cffa7b46c2d9b45fae79feaf4404f47e90d22e5b82074bd3b00d194`;
  derivation report
  `7df3165ca9c66213cbaca08bd566830f48e53a32f5762392385a0d34f2eb9905`;
  bundle
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`.
- **Finding:** the authoritative current-state documents say the present vector family has eight
  scenarios, while the final family has fourteen. The schema README additionally says vector
  regeneration remains outstanding even though the final derivation report records regeneration.
  Historical-count handling was corrected for provenance, but current semantic family cardinality
  and status were not reconciled after the final vector pass.
- **Correction required:** append a narrow current-state amendment or superseding registry patch
  that records 14 scenarios (2 positive, 12 negative), marks regeneration complete at the exact
  bundle digest, preserves 1.2/earlier bytes as historical, and does not imply validator, ES256,
  adoption or publication evidence.

New material findings: **1 OPEN**.

## 10. Independence limitation

Agent F authored the review method, F-04, Amendment 1 and this Amendment 2. That repeated
methodological participation creates anchoring and self-review risk. Agent F did not edit the
source artifacts and independently recomputed current vector material without importing Agent B
code. Nevertheless:

- `Agent F` is not a stable governed identity or effective Independent Reviewer assignment;
- no mandate chain, acknowledgement, effective interval, conflict/separation receipt or
  candidate-bound review request exists;
- no authority has ruled this prior participation compatible with formal independence;
- the candidate remains mutable, untracked and unpublished; and
- this amendment is technical assurance only, not the G3 independent-review receipt.

An effectively assigned reviewer must review the eventual frozen candidate and authorized QA
evidence. This amendment cannot self-close `A2-NMF-01`.

## 11. Remaining corrections, blockers and disposition

Remaining **design defects**:

1. reconcile Registry 1.3.0, the post-correction reconciliation and schema README to the final
   14-scenario bundle;
2. instantiate a complete dependency registry rather than only specifying its future fields;
3. add requirement-complete full-document fixture coverage, including wrong audience and broad
   boundary/Unicode/resource/cross-object cases; and
4. add cryptographic positive/negative vectors only after approved key/profile authorization.

Remaining **external validation/adoption/authority/publication blockers**:

1. no pinned authorized validator/meta-schema execution or complete fixture result receipt;
2. no general RFC 8785 conformance evidence or consumer implementation execution;
3. no genuine ES256 key, signature, verification, trust-root, revocation or malformed-encoding
   execution;
4. no effective adoption authority or exact-candidate adoption receipt;
5. no stable governed identities, mandates, assignments, acknowledgements, separation, QA,
   effective independent review, findings closure, A09 or G3 receipt;
6. no authorized final freeze, L0-L4 manifests, Git blob/tree/commit binding, L5 publication,
   independent retrieval/remeasurement or publication receipt; and
7. no G3 acceptance, so no G4 exact-run release may be considered.

Final technical package disposition:

**OPEN — FINAL VECTOR/PROFILE DESIGN SUBSTANTIALLY RECONCILED; ONE CURRENT-STATUS FINDING AND
OTHER DESIGN-COVERAGE GAPS REMAIN**

Formal assurance/publication disposition:

**BLOCKED BY DEPENDENCY — NO VALIDATOR/CRYPTO EXECUTION, ADOPTION, EFFECTIVE REVIEWER,
IMMUTABLE CANDIDATE, PUBLICATION OR AUTHORITY CHAIN**

Preserved holds:

- A09: `UNRESOLVED`
- G3: `CLOSED — BLOCKED BY DEPENDENCY`
- G4: `NOT AUTHORIZED`
- validator/meta-validator: `NOT RUN`
- ES256 generation/verification: `NOT RUN`
- adoption/publication/acceptance: `NONE`
- commit/push/merge: `NOT AUTHORIZED / NOT PERFORMED`
- historical reference `2ea38d86a19697b80a827d2dfd83a9219e145532`:
  `UNSUPPORTED`, not substituted

`REGISTRY 1.3 SIGNING PROFILE STRUCTURALLY PRESENT -> 14 SCENARIOS / 125 OF 125 INDEPENDENT
ASSERTIONS -> A1-NMF-02 DESIGN-ADDRESSED -> A1-NMF-01 AND A2-NMF-01 OPEN ON CURRENT STATUS ->
19 PASS / 5 FAIL / 14 PARTIAL / 2 NOT RUN / 10 BLOCKED -> NO ACCEPTANCE -> NO EXECUTION`
