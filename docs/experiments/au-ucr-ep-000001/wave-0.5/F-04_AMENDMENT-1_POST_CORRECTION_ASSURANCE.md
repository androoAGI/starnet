# F-04 Amendment 1 — Post-Correction Wave 0.5 Assurance

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-REVIEW`
- **Experiment:** `AU-UCR-EP-000001`
- **Artifact:** `F-04_AMENDMENT-1_POST_CORRECTION_ASSURANCE`
- **Reviewer label:** `Agent F`
- **Review date:** 2026-10-12
- **Baseline/current HEAD:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **F-04 preserved:** 34,734 bytes; SHA-256
  `f4266579f607b9416250db7315bb733936d7321af7b89d92f72e58abd90b67cc`
- **Schema-validator execution:** **NONE — AUTHORIZATION REMAINS UNRESOLVED**
- **Review mode:** read-only strict JSON parsing, structural `$ref`/JSON Pointer inspection,
  exact-byte hashing, Git metadata inspection, and independent standard-library-only vector
  recomputation without importing or running Agent B's generator or reproducer
- **Acceptance/authorization effect:** **NONE / NONE**

This amendment re-reviews the corrected mutable working-tree candidate. It does not edit or
supersede F-04, validate a schema, accept an artifact, appoint an actor, close G3, authorize G4,
commit, push, merge, publish, sign, implement, construct, test, or operate anything.

## 2. Candidate snapshot and exact evidence hashes

Before this amendment was created, Wave 0.5 contained **77 files**. All 77 were untracked and
absent from `HEAD`. This amendment becomes file 78 and therefore necessarily changes any later
complete-candidate inventory.

Inventory digests below are SHA-256 over sorted UTF-8 lines:

`repository-relative-path<TAB>raw-byte-count<TAB>raw-sha256<LF>`

They are present-byte review indexes, not governed manifests, Git identities, or publication
receipts.

| Evidence set | Members | Inventory SHA-256 |
| --- | ---: | --- |
| `EV-CAND-77` — complete pre-amendment Wave 0.5 set | 77 | `b69cf0f01e92875aabdce69c8ffcdb45c88024175090cede9325d6f917782736` |
| `EV-SCHEMA-52` — `schemas/` README, 35 schemas and 16 fixture files | 52 | `9b41dd05d6b2c3020d3d6edaeec55b2192c891013877c115bfd181dab120a6a7` |
| `EV-VECTOR-6` — corrected vector family | 6 | `3c5ecf48789c94953ee194d641d9a0052da8404bab70b4185a8c714aa00fcde9` |
| `EV-CONTRACT-3` — registry, shared contract and matrix | 3 | `ddbddaffc8aa7b2329e05a538440afbbd7c667bf13473e62977e086c5e13cdbc` |
| `EV-AUTHORITY-4` — closure, schema requirements, G3/G4 requirements and crosswalk | 4 | `86507568e744368946c3f075cbb4466cc2cc4b0cf354fe81646fdfb47dc439a3` |
| `EV-PROVENANCE-4` — publication, nested manifest, evidence register and crosswalk | 4 | `9430059b6ed0dab8e57ee46f0a3c72b64f969be86783726ffc533954ab8350fe` |

Primary current artifact identities:

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `W05_VERSIONED_REGISTRY.md` | 43,426 | `04851c8f8440ac119c4478e7c347b2744ae149b01cdb2ea849eb56f4acbff954` |
| `W05_SHARED_TRUST_AND_STATE_CONTRACT.md` | 28,532 | `f6fd333844bc91bfc228ba606a78e7773452317611ece46f2114b380c81318e9` |
| `W05_INTERFACE_MATRIX.md` | 31,299 | `c371c379d57eb5c0f55f8bd4dc855137fb4cab41a8a119271368b8c3a171aa84` |
| `schemas/README.md` | 5,707 | `20920cdfd9f8ca3bba693e91371e927188f6ba13e6120978b1c054224a4555c3` |
| `schemas/common.schema.json` | 10,229 | `caa276f24e0cafcdc5524ce80211aa645328ed97332d6202711f4c9c28b2c5f9` |
| `schemas/audit-ledger-record.schema.json` | 3,215 | `49a044956d85127b12b56714be51ddd9db5024a93a694943de4a8266cf66581c` |
| `schemas/governed-audit-ledger-envelope.schema.json` | 1,361 | `959b378cad6e7309b1ad8721f7ae5c0167662aaf53b93dd2249eeb1d6750dd18` |
| `schemas/ledger-head-attestation.schema.json` | 1,391 | `6715eb7d8e4c9e0141aa38de8ee47595438bc1a07a187ecdd1f482a0e7a07b0b` |
| `schemas/nested-candidate-manifest.schema.json` | 3,931 | `789d4ac34eab9e834c436abbe656e15398454bd01e1500368c2d9358dbb1777e` |
| `schemas/fixtures/manifest.json` | 2,223 | `4dcd38bbc051e04b605abffa38dc40948dbe924362d68945a2544f034e6b32e6` |
| `schemas/fixtures/correction-unit-fixtures.json` | 16,099 | `fcc7584852f7b5d6851d58147a14f853ed1f59e34b4d29d1ba57ec7170fe4d06` |
| `vectors/W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json` | 132,370 | `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692` |
| `vectors/W05_VECTOR_DERIVATION_AND_REPRODUCTION.md` | 19,779 | `c5dc1a3a09b291220425bd828234cd2523b93afd306381e81484bf6587eaa040` |
| `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md` | 20,520 | `58de9a09fd4b86e84070d23a33ac9f4036d86b8350e2b7c44df66f4bc1cf72d0` |
| `W05_AUTHORITY_CLOSURE_PACKAGE.md` | 13,592 | `70a04edffa45ed7027d70d22039d5dd647633c4fb6eef34fd32df05fa10c6d42` |
| `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md` | 20,973 | `3193e114239f26ccff22089edf7d5da48a74455bffbea0835ed83416d87cf768` |
| `W05_PUBLICATION_AND_PROVENANCE_SPEC.md` | 16,456 | `21d31876a77dcf1dcab93ffa802896f6082c88a218cc31380b664ba8010dbcf3` |
| `W05_AUTHORITY_CONTRACT_CROSSWALK.md` | 21,054 | `1ddf84e3418c05387a3b7bda0d7f871f785f6825e7824c05a43d8926b051d785` |
| `W05_IMMUTABLE_REFERENCE_CROSSWALK.md` | 19,876 | `60db67bdc70a34ab87282c65bd2abb86dbd458582bc6a107520bcddd5e58c022` |
| `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md` | 19,877 | `f5a03dbb5d4ff570a3d59415150d49ed7b952cc3ed61967fd3b59b05795eb5bd` |
| `W05_CROSS_CONTRACT_INTEGRATION_REPORT.md` | 27,894 | `24a26503dc78d41d9fb4eb92d0abe2dc52252a896f46bda8a59148ce481e81bc` |

## 3. Structural schema and fixture inspection

Read-only standard-library inspection produced:

- strict JSON parses with duplicate-key and non-finite-constant rejection: **52/52**;
- schema documents: **35**;
- unique `$id` values: **35/35**;
- local/relative `$ref` occurrences resolved to present files and JSON Pointers: **541/541**;
- unresolved `$ref` values: **0**;
- correction-unit fixture target pointers resolved: **53/53**;
- active full-document fixture cases: **2**;
- positive/negative subschema unit pairs: **53**, or **106** fragment cases;
- active cases claimed by the fixture manifest: **108**;
- retired pre-correction full-document fixtures excluded from current outcomes: **12**;
- JSON Schema validator/meta-validator runs: **0**.

The corrected package now contains all 25 Registry Section 3 profiles, purpose-specific authority
objects, the external governed-event envelope, and the nested-manifest shape. The governed-event
vector payloads have exactly the 25 audit-schema required keys; the external envelopes and the two
positive ledger-head objects also exactly match their respective required/property key sets.

These are structural observations only. Subschema scalar fixtures do not establish full-document
validity. The package still lacks full-document positive/negative coverage for 32 of 33 record
schemas and does not cover every minimum/maximum, duplicate-key byte input, Unicode/resource
boundary, temporal/cross-object rule, replay, revocation, wrong-candidate/audience, sequence gap,
fork, wrong predecessor, duplicate sequence or unauthorized-transition case required by the
review method.

## 4. Independent vector recomputation

The reviewer read the published JSON bundle and independently implemented, in a one-off
standard-library-only read-only computation:

- restricted sorted-key/minified UTF-8 serialization;
- unsigned big-endian 32-bit and 64-bit lengths;
- B-03 ledger framing;
- A-04 signature-input framing;
- raw predecessor decoding and SHA-256;
- bundle-supplied byte, preimage, digest and oracle comparisons.

Neither `derive_vectors.py`, `derive_vectors_registry_1_2.py`,
`reproduce_vectors.py`, nor `reproduce_vectors_registry_1_2.py` was imported or run.

Result: **53/53 independent byte/digest/oracle assertions agreed** across the corrected positive
and negative material.

- bundle SHA-256:
  `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`;
- genesis record hash:
  `e0e004a5721000f0b6d81b05ef39eeb4e3471b544a9d6732615819f44156f0b8`;
- successor record hash:
  `06291931826359f280a29983f147b3be25483bd8c8e89b355ea061804706075e`;
- single-head attestation-input SHA-256:
  `0f43dabb96be2ad7bd52fd1ae9b4e4d0dac0696255693fa16e227c71f0e2786e`;
- chain-head attestation-input SHA-256:
  `0f6808d9bd0c976ace5d0055f68bddbb41775392a3f9ab35a600c91d8d784598`.

The recomputation establishes exact restricted-subset byte agreement. It does not establish
general RFC 8785 conformance, schema-validator acceptance/rejection, ES256 validity, signer
authority, replay behavior, or an implementation's negative-case behavior. The ledger-head
signing projection is explicitly `VECTOR_SPECIFIED_NOT_REGISTRY_ADOPTED`.

## 5. F-04 material-finding dispositions

| Finding | Classification | Exact current evidence and basis |
| --- | --- | --- |
| `F04-NMF-01` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV-SCHEMA-52` `9b41dd05d6b2c3020d3d6edaeec55b2192c891013877c115bfd181dab120a6a7`; README `20920cdfd9f8ca3bba693e91371e927188f6ba13e6120978b1c054224a4555c3`. The package expanded from 8 to 35 unique schemas and now represents every registered profile and authority family. Full-document fixtures, validator evidence and semantic/cross-object conformance remain absent. |
| `F04-NMF-02` | **DESIGN ADDRESSED — VERIFICATION PENDING** | audit schema `49a044956d85127b12b56714be51ddd9db5024a93a694943de4a8266cf66581c`; envelope `959b378cad6e7309b1ad8721f7ae5c0167662aaf53b93dd2249eeb1d6750dd18`; vector bundle `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`. Payload/envelope placement, `ALLOW`, schema IDs and exact key sets now agree and all independent byte checks passed. Validator execution, negative consumer execution, ES256 and an adopted ledger-head signing projection remain pending. |
| `F04-NMF-03` | **DESIGN ADDRESSED — VERIFICATION PENDING** | registry `04851c8f8440ac119c4478e7c347b2744ae149b01cdb2ea849eb56f4acbff954`; common schema `caa276f24e0cafcdc5524ce80211aa645328ed97332d6202711f4c9c28b2c5f9`; `EV-VECTOR-6` `3c5ecf48789c94953ee194d641d9a0052da8404bab70b4185a8c714aa00fcde9`. Current machine artifacts use the canonical IDs, purposes, domains, decisions and reasons. Adoption and negative enforcement are absent, and stale narrative status claims require correction under `A1-NMF-01`. |
| `F04-NMF-04` | **DESIGN ADDRESSED — VERIFICATION PENDING** | requirements `58de9a09fd4b86e84070d23a33ac9f4036d86b8350e2b7c44df66f4bc1cf72d0`; authority base `7d0758d26f11f3816602c49e8f112c90330a5663d7d0c736ab0292a57b07c6e6`; `EV-SCHEMA-52`. Separate assignment, acknowledgement, separation, QA, review, closure, A09, G3, G4, revocation, rollback and reinstatement shapes now constrain purpose-specific tuples. No validator, real identity, mandate, assignment, acknowledgement, separation, signature or receipt exists. |
| `F04-NMF-05` | **DESIGN ADDRESSED — VERIFICATION PENDING** | nested specification `3193e114239f26ccff22089edf7d5da48a74455bffbea0835ed83416d87cf768`; nested schema `789d4ac34eab9e834c436abbe656e15398454bd01e1500368c2d9358dbb1777e`; `EV-PROVENANCE-4` `9430059b6ed0dab8e57ee46f0a3c72b64f969be86783726ffc533954ab8350fe`. L0-L6 scope, parent-child binding, review layering, partial publication and append-only amendment are specified. No hierarchy is instantiated, and embedded 47-file/old-family snapshot counts do not describe the current 77/78-file candidate. |

Finding classification count: **0 RESOLVED WITH EVIDENCE; 5 DESIGN ADDRESSED —
VERIFICATION PENDING; 0 OPEN; 0 BLOCKED BY DEPENDENCY**.

## 6. Nine-objection dispositions

| Objection | Classification | Exact current evidence and distinction |
| --- | --- | --- |
| `W05-OBJ-01` | **DESIGN ADDRESSED — VERIFICATION PENDING** | `EV-SCHEMA-52` `9b41dd05d6b2c3020d3d6edaeec55b2192c891013877c115bfd181dab120a6a7`; common schema `caa276f24e0cafcdc5524ce80211aa645328ed97332d6202711f4c9c28b2c5f9`. ARM/runtime/platform/model/verdict/session profiles now exist and fail-closed vocabularies are mapped. Complete full-document fixtures, authorized validator output and semantic conformance are pending. |
| `W05-OBJ-02` | **OPEN** | `EV-VECTOR-6` `3c5ecf48789c94953ee194d641d9a0052da8404bab70b4185a8c714aa00fcde9`; bundle `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`. Corrected bytes independently reproduce and ledger schema shape agrees, but the required sequence-gap, fork, wrong-predecessor, duplicate-sequence, unauthorized-transition and replay negatives are absent; no rejection implementation ran; and the attestation signing projection is not registry-adopted. |
| `W05-OBJ-03` | **BLOCKED BY DEPENDENCY** | `EV-PROVENANCE-4` `9430059b6ed0dab8e57ee46f0a3c72b64f969be86783726ffc533954ab8350fe`; publication spec `21d31876a77dcf1dcab93ffa802896f6082c88a218cc31380b664ba8010dbcf3`. Design exists; authorized freeze, commit/tree/blob identity, publisher and publication receipt do not. |
| `W05-OBJ-04` | **BLOCKED BY DEPENDENCY** | Same provenance set and nested specification `3193e114239f26ccff22089edf7d5da48a74455bffbea0835ed83416d87cf768`. LAB-03 remains untracked and has no immutable object/publication receipt. No construction is inferred or required. |
| `W05-OBJ-05` | **BLOCKED BY DEPENDENCY** | `EV-CAND-77` `b69cf0f01e92875aabdce69c8ffcdb45c88024175090cede9325d6f917782736`; nested specification `3193e114239f26ccff22089edf7d5da48a74455bffbea0835ed83416d87cf768`. Freeze, partial-publication, amendment and revocation are designed, but all source bytes remain mutable and commit/push/publication authority is absent. |
| `W05-OBJ-06` | **BLOCKED BY DEPENDENCY** | `EV-AUTHORITY-4` `86507568e744368946c3f075cbb4466cc2cc4b0cf354fe81646fdfb47dc439a3`; closure package `70a04edffa45ed7027d70d22039d5dd647633c4fb6eef34fd32df05fa10c6d42`. Machine shapes now exist, but ten authority gaps, all real identities/mandates/acknowledgements/separation evidence and exact-run authority remain absent. |
| `W05-OBJ-07` | **OPEN** | `EV-CONTRACT-3` `ddbddaffc8aa7b2329e05a538440afbbd7c667bf13473e62977e086c5e13cdbc`; registry `04851c8f8440ac119c4478e7c347b2744ae149b01cdb2ea849eb56f4acbff954`. A coherent identifier mapping exists, but no complete adopted cryptographic profile or instantiated dependency registry exists, the signing projection is vector-local, and controlling narratives still contradict current artifacts. This is more than missing adoption. |
| `W05-OBJ-08` | **OPEN** | shared contract `f6fd333844bc91bfc228ba606a78e7773452317611ece46f2114b380c81318e9`; matrix `c371c379d57eb5c0f55f8bd4dc855137fb4cab41a8a119271368b8c3a171aa84`; stale integration report `24a26503dc78d41d9fb4eb92d0abe2dc52252a896f46bda8a59148ce481e81bc`. Registry/matrix claim 22 design-aligned interfaces while the included integration report still claims 0 aligned, 19 partial and 2 conflicts. The candidate must reconcile that contradiction before adoption can be the only blocker. |
| `W05-OBJ-09` | **OPEN** | `EV-CAND-77` `b69cf0f01e92875aabdce69c8ffcdb45c88024175090cede9325d6f917782736`; fixture manifest `4dcd38bbc051e04b605abffa38dc40948dbe924362d68945a2544f034e6b32e6`. The aggregate package has no current closure manifest, validator output, requirement-complete fixtures/vectors, effective QA/review, publication or reconciled current-status reports. |

Objection classification count:

- **RESOLVED WITH EVIDENCE:** 0
- **DESIGN ADDRESSED — VERIFICATION PENDING:** 1
- **OPEN:** 4
- **BLOCKED BY DEPENDENCY:** 4
- **Total:** 9

## 7. Full 50-check delta

`Previous` is F-04. `Current` applies to the exact mutable snapshot indexed by `EV-CAND-77`.

### Candidate fixation

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-CAND-01` | `PASS` | `PASS` | 77 pre-amendment paths enumerated. |
| `W05-CHK-CAND-02` | `PASS` | `PASS` | Raw byte counts/SHA-256 recomputed for all 77. |
| `W05-CHK-CAND-03` | `FAIL` | `FAIL` | No instantiated complete manifest; embedded membership snapshot is obsolete. |
| `W05-CHK-CAND-04` | `FAIL` | `FAIL` | No Wave 0.5 blob/tree/commit/publication identity. |
| `W05-CHK-CAND-05` | `PARTIAL` | `PARTIAL` | Drift is observable but mutable bytes cannot be fixed by review. |

### Schema completeness

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-SCH-01` | `PASS` | `PASS` | 35/35 unique draft-2020-12 schema IDs. |
| `W05-CHK-SCH-02` | `PARTIAL` | `PASS` | Closed required/optional shapes and omission policy now span registered profiles. |
| `W05-CHK-SCH-03` | `PARTIAL` | `PARTIAL` | Local bounds improved; aggregate depth/resource and semantic limits remain external. |
| `W05-CHK-SCH-04` | `PARTIAL` | `PARTIAL` | IDs/timestamps/canonical IDs align; Unicode/general JCS/format assertions are unverified. |
| `W05-CHK-SCH-05` | `PARTIAL` | `PARTIAL` | Closed objects/extensions exist; duplicate-key and critical-extension behavior require consumers. |
| `W05-CHK-SCH-06` | `PARTIAL` | `PARTIAL` | Purpose conditionals improved; temporal and cross-object equality remain external. |
| `W05-CHK-SCH-07` | `FAIL` | `PARTIAL` | Authority/run/replay/candidate shapes exist; effective semantic enforcement is unverified. |
| `W05-CHK-SCH-08` | `FAIL` | `PASS` | Registry now maps malformed/unsupported classes to ordered reasons and safe states. |
| `W05-CHK-SCH-09` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Validator execution remains unauthorized/not run. |

### Fixture coverage

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-FIX-01` | `PARTIAL` | `PARTIAL` | 53 traced unit pairs do not map every normative semantic requirement. |
| `W05-CHK-FIX-02` | `FAIL` | `FAIL` | Full-document minimum/maximum coverage remains absent. |
| `W05-CHK-FIX-03` | `PARTIAL` | `PARTIAL` | Unit wrong-value cases exist; complete missing/null/extra/type/duplicate coverage does not. |
| `W05-CHK-FIX-04` | `PARTIAL` | `FAIL` | No complete boundary/overflow/Unicode/timestamp/resource suite. |
| `W05-CHK-FIX-05` | `PARTIAL` | `PARTIAL` | Purpose/projection units improved; state/authority/cross-object cases remain incomplete. |
| `W05-CHK-FIX-06` | `FAIL` | `FAIL` | Replay/stale/revoked/wrong-candidate/audience suite remains incomplete. |
| `W05-CHK-FIX-07` | `NOT RUN` | `NOT RUN` | No validator or reason/state aggregator executed. |

### Vector reproducibility

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-VEC-01` | `PASS` | `PASS` | Semantic objects, canonical bytes and preimages are published. |
| `W05-CHK-VEC-02` | `PASS` | `PASS` | Restricted canonical bytes independently recomputed. |
| `W05-CHK-VEC-03` | `PASS` | `PASS` | Corrected genesis/successor preimages and hashes independently reproduced. |
| `W05-CHK-VEC-04` | `NOT RUN` | `NOT RUN` | Input bytes reproduce; no ES256 signature or authorized key exists. |
| `W05-CHK-VEC-05` | `PARTIAL` | `PARTIAL` | Six negative oracles are byte-consistent; rejection consumers and required cases are absent. |
| `W05-CHK-VEC-06` | `FAIL` | `PASS` | 53/53 independent comparisons agree; positive schema key shapes now match. |

### Shared contracts

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-CON-01` | `PARTIAL` | `PARTIAL` | Stable namespace design improved; effective identities/repository adoption remain absent. |
| `W05-CHK-CON-02` | `FAIL` | `PARTIAL` | Current literals align; ES256 encoding and signing projection remain unsettled. |
| `W05-CHK-CON-03` | `PARTIAL` | `PARTIAL` | Revocation/time/store design exists; adopted roots and services do not. |
| `W05-CHK-CON-04` | `PARTIAL` | `PARTIAL` | Provider/consumer failure semantics exist; no instantiated dependency registry. |
| `W05-CHK-CON-05` | `PARTIAL` | `PASS` | Registry supplies one state/decision/reason mapping for current machine artifacts. |
| `W05-CHK-CON-06` | `PARTIAL` | `PASS` | Rollback/recovery/reinstatement shapes and prose now align by design. |
| `W05-CHK-CON-07` | `PARTIAL` | `PASS` | Unknown/unavailable/incompatible behavior is uniformly fail-closed by design. |

### Authority provenance

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-AUT-01` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No effective terminating mandate chain. |
| `W05-CHK-AUT-02` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No stable effective assignee/scope/time/acknowledgement. |
| `W05-CHK-AUT-03` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No governed separation result. |
| `W05-CHK-AUT-04` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No authoritative lifecycle/status evidence. |
| `W05-CHK-AUT-05` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Labels/general approval are rejected, but candidate/run authority is absent. |

### Publication identity

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-PUB-01` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No immutable repository objects. |
| `W05-CHK-PUB-02` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Hash-domain design exists; no adopted/instantiated manifest. |
| `W05-CHK-PUB-03` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | Publisher authority/signature/receipt absent. |
| `W05-CHK-PUB-04` | `BLOCKED BY DEPENDENCY` | `BLOCKED BY DEPENDENCY` | No published candidate to retrieve. |
| `W05-CHK-PUB-05` | `PARTIAL` | `PARTIAL` | Lifecycle/partial-publication design exists; no effective receipts or current manifest instance. |

### Failure-closed behavior and rollback

| Check | Previous | Current | Delta basis |
| --- | --- | --- | --- |
| `W05-CHK-FCR-01` | `PASS` | `PASS` | Failure maps to OFF/blocked/suspended/quarantined. |
| `W05-CHK-FCR-02` | `PARTIAL` | `PASS` | Registry closes unknown schema/state/reason/version behavior. |
| `W05-CHK-FCR-03` | `PARTIAL` | `PASS` | Purpose-specific design suspends/blocks invalid authority/trust/time/evidence. |
| `W05-CHK-FCR-04` | `PASS` | `PASS` | Unexpected acceptance remains review-stopping. |
| `W05-CHK-FCR-05` | `PARTIAL` | `PASS` | Target, quorum, receipt, history and new-session requirements now have dedicated shapes. |
| `W05-CHK-FCR-06` | `PASS` | `PASS` | Drift invalidates stale evidence and requires re-review. |

### Check totals and delta

| Result | F-04 | Amendment 1 | Delta |
| --- | ---: | ---: | ---: |
| `PASS` | 9 | **18** | **+9** |
| `FAIL` | 8 | **5** | **-3** |
| `PARTIAL` | 21 | **15** | **-6** |
| `NOT RUN` | 2 | **2** | 0 |
| `BLOCKED BY DEPENDENCY` | 10 | **10** | 0 |
| **Total** | **50** | **50** | 0 |

No partial, failed, not-run or blocked check is converted to a pass through aggregation.

## 8. New post-correction findings

### `A1-NMF-01` — Corrected machine artifacts and included governing narratives disagree

- **Classification:** **OPEN**
- **Affected objections:** `W05-OBJ-07`, `W05-OBJ-08`, `W05-OBJ-09`
- **Exact evidence:** registry
  `04851c8f8440ac119c4478e7c347b2744ae149b01cdb2ea849eb56f4acbff954`;
  authority crosswalk
  `1ddf84e3418c05387a3b7bda0d7f871f785f6825e7824c05a43d8926b051d785`;
  immutable-reference crosswalk
  `60db67bdc70a34ab87282c65bd2abb86dbd458582bc6a107520bcddd5e58c022`;
  vector reconciliation
  `f5a03dbb5d4ff570a3d59415150d49ed7b952cc3ed61967fd3b59b05795eb5bd`;
  integration report
  `24a26503dc78d41d9fb4eb92d0abe2dc52252a896f46bda8a59148ce481e81bc`.
- **Finding:** the registry still describes current schema/vector bytes as unchanged and
  nonconformant, labels corrected/present profiles `MUST_REVISE` or
  `EXPLICITLY_DEFERRED_TO_AGENT_A`, and says Agent A/B still must consume corrections. Included
  Wave 2 reports still assert 8 schemas, 4 vector files, absent assignment/G3/G4 profiles,
  incompatible vector IDs and 0 aligned interfaces. The current package instead has 35 schemas,
  6 vector files, corrected purposes and 22 design-aligned interfaces. The nested specification's
  47-file/24-schema-family/4-vector snapshot likewise cannot enumerate the current 77-file
  pre-amendment or 78-file post-amendment set.
- **Correction required:** issue append-only post-correction reconciliation or clearly mark each
  superseded status/count as historical; update the registry's current-disposition language and
  generate a fresh complete inventory at freeze. Do not rewrite historical F-04.

### `A1-NMF-02` — Ledger-head signing projection is vector-local

- **Classification:** **OPEN**
- **Affected objections:** `W05-OBJ-02`, `W05-OBJ-07`, `W05-OBJ-09`
- **Exact evidence:** ledger-head schema
  `6715eb7d8e4c9e0141aa38de8ee47595438bc1a07a187ecdd1f482a0e7a07b0b`;
  derivation report
  `c5dc1a3a09b291220425bd828234cd2523b93afd306381e81484bf6587eaa040`;
  bundle
  `569a88f08311e44a3787736fd6577fa6a46c98512b25a50b68aed063ef15c692`.
- **Finding:** the schema requires `payload_digest` and `signature`, but neither Registry 1.2.0
  nor the schema defines the non-self-referential signed-payload projection. Agent B supplied a
  coherent vector-only exclusion/projection and synthetic signature sentinel. Independent byte
  agreement cannot adopt that projection or establish ES256 verification.
- **Correction required:** place the exact projection, signature encoding and verification order
  in an authoritative versioned registry/schema profile; regenerate if it changes; add valid and
  wrong-coverage cryptographic vectors only under separate authorization.

New material findings: **2 OPEN**.

## 9. Reviewer independence limitation

Agent F authored the review-preparation matrix, authored F-04, and now applies that same method to
the correction. This is substantial methodological participation and anchoring exposure. Agent F
did not edit the corrected source artifacts and independently recomputed the corrected vector
bytes without importing Agent B tooling. Nevertheless:

- `Agent F` remains a label, not a stable governed identity;
- no effective Independent Reviewer assignment, acknowledgement, mandate chain, effective
  interval, separation/conflict receipt or candidate-bound request exists;
- no authority has determined compatibility of method authorship and prior review participation;
- the candidate is mutable, untracked and unpublished; and
- this amendment is technical assurance, not the formal independent-review receipt required for
  G3.

An effectively assigned reviewer must review the eventual frozen candidate and authorized QA
evidence. This amendment cannot self-close its new findings.

## 10. Remaining corrections and final disposition

Required corrections, separated by type:

1. **Design/reconciliation:** reconcile the registry and all included Wave 2/current-status
   narratives to the corrected 35-schema, 6-vector, 22-interface package; replace obsolete
   inventory snapshots at freeze.
2. **Vector design:** adopt a non-self-referential ledger-head signing projection and complete the
   required sequence/fork/predecessor/replay/transition negative suite.
3. **Validation/conformance:** under separate authorization, pin a validator/meta-schema profile,
   execute all full-document positive/negative cases, add missing fixture coverage, and preserve
   complete content-addressed outputs.
4. **Cryptography/adoption:** approve exact ES256 encoding, trust-root, key lifecycle, signature
   and dependency profiles; then execute independent cryptographic/conformance evidence.
5. **Authority:** establish stable named assignments, mandate chains, acknowledgements,
   separation, lifecycle/status evidence, QA, effective independent review, findings closure,
   Decision Chair A09 and G3 receipts.
6. **Publication:** authorize and perform a fresh L0-L4 freeze over all final files, create
   commit/tree/blob bindings and L5 publication evidence, independently retrieve/remeasure, and
   preserve the exact unsupported historical commit without substitution.
7. **Release:** only after valid G3 acceptance may a separately effective
   Coordinator/Architect consider one exact-run G4 release.

Technical package disposition:

**OPEN — POST-CORRECTION DESIGN SUBSTANTIALLY IMPROVED; TWO MATERIAL RECONCILIATION/DESIGN
FINDINGS REMAIN**

Formal review/publication disposition:

**BLOCKED BY DEPENDENCY — NO IMMUTABLE CANDIDATE, AUTHORIZED VALIDATION, EFFECTIVE REVIEWER,
PUBLICATION OR AUTHORITY CHAIN**

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

`CORRECTED BYTES INDEPENDENTLY RECOMPUTED -> FIVE F-04 FINDINGS DESIGN-ADDRESSED -> TWO NEW OPEN
POST-CORRECTION FINDINGS -> 18 PASS / 5 FAIL / 15 PARTIAL / 2 NOT RUN / 10 BLOCKED -> NO
ACCEPTANCE -> NO EXECUTION`
