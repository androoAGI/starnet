# Wave 0.6 Complete Evidence Inventory and Crosswalk

## Control record

- Experiment: `AU-UCR-EP-000001`
- Role: Agent D, reconciliation only
- Inspection date: `2026-10-12`
- Repository: `https://github.com/mrrobot787/starnet.git`
- Local repository: `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- Branch: `cursor/populate-authority-readiness-7886`
- `HEAD`: `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- Git object format: `sha1`
- Status: `CURRENT_BYTES_INVENTORIED_NOT_FROZEN`
- Authority effect: none

This record was produced by read-only filesystem, hash, JSON and Git inspection. It is not a
candidate manifest, publication receipt, QA receipt, acceptance receipt or execution release.
No prior-wave or `qa/evidence` file was changed.

## Inventory method

Each root was recursively enumerated, files were sorted by repository-relative UTF-8 path, and
one line per file was formed as:

`path<TAB>raw_bytes<TAB>raw_sha256<TAB>lf_bytes<TAB>lf_sha256<TAB>state<LF>`

`lf` means only `0d 0a -> 0a`. `state` is `tracked-head` when the exact path is in `HEAD`,
otherwise `untracked`. The root digest is SHA-256 over the concatenated lines. This commits the
complete enumerated membership and every per-file raw/LF size and digest without pretending to be
an authorized manifest.

## Reconciliation totals

| Root | Files | Raw bytes | State | Inventory SHA-256 |
| --- | ---: | ---: | --- | --- |
| `wave-0.3` | 9 | 183,602 | all tracked and in `HEAD` | `c53d51687d7f13f9cf386bcb13d04b1363d9c09cb8be205d055209d0c2b2a82a` |
| `wave-0.4` | 20 | 295,253 | all untracked and absent from `HEAD` | `a2e3eb9eb7ab090371b513055bfcffeb6eff7a05e29ecdf4bc4337a6a4f6f458` |
| `wave-0.5` | 88 | 953,337 | all untracked and absent from `HEAD` | `aee80c9f761368e09cca23e80393bd07158e3c36ff2a325c86620724fb4348f3` |
| `qa/evidence/.../star-wr-0001` | 10 | 39,074 | all tracked and in `HEAD` | `b5e36168454a0f0a1310810558c8c437092fbd24e9d9163dcdefcb8d04d80b70` |
| **Total** | **127** | **1,471,266** | 19 tracked; 108 untracked | n/a |

The 117 Wave 0.3-0.5 paths normalize to 117 unique case-folded forward-slash paths. No actual
duplicate, separator-normalized duplicate or case-colliding path was found. Backslash and
forward-slash forms seen in status/transcript presentations are two representations of the same
Windows paths, not two filesystem entries.

## Complete Wave 0.3 membership and current raw identities

| File | Bytes | Raw SHA-256 |
| --- | ---: | --- |
| `A-04_TRUSTED_RUNTIME_ATTESTATION_SPEC.md` | 30,976 | `3bdb80b055f672141101dd4417aa75df349e4a8b25c3f19051a77a98613cc5ed` |
| `B-03_EXECUTABLE_ENFORCEMENT_SPEC.md` | 32,599 | `f6cad82b5bb9049a8a5bebc4bbfd4d8be09af3b927aaa9b301fb287b09c6582a` |
| `C-04_AUTHORITY_PACKAGE_DRAFT.md` | 11,385 | `f78fa119d767285efb984b3246842081ac0be4a7513eadbd70566bae64377999` |
| `D-02_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md` | 8,822 | `f86a8d02591a18f0081d6d1d096c58160b6ba73ef64717af7f62fbd8f154c0bb` |
| `D-02_INDEPENDENT_DESIGN_ASSURANCE_REPORT.md` | 25,418 | `6a1ec6f35f2b66a87da0270a713b23c2e767a8784c7cbdf241ca278905b664d0` |
| `GATE-03_AMENDMENT-1_MANIFEST_HASH_CONVENTION.md` | 6,797 | `8549a89cf9c05be7cefd8ca8edaf9fc784cafa5648510586919a61b9dee134ea` |
| `GATE-03_CONSOLIDATED_DECISION_PACKAGE.md` | 21,828 | `b7767c81e3093c7d031e432533805f415f8082d01c3970e8f91e66367ce2b31b` |
| `LAB-03_ISOLATED_EXECUTION_ENVIRONMENT_SPEC.md` | 32,071 | `b9ba2f40db06921fc01368b00a838d59f5ab0d72f9867c0a39d2277c9f4c2361` |
| `SCRUM03_RECONCILIATION.md` | 13,706 | `b3b3349454e76a6705674e5c65d21e3aee3ff4519941586313bca727bef7abd3` |

These nine files are contained by current `HEAD`. Statements in the original D-02/GATE-03 that
they were untracked remain historically true at their authoring point but are stale as current
repository-state claims.

## Complete Wave 0.4 membership and current raw identities

| File | Bytes | Raw SHA-256 |
| --- | ---: | --- |
| `A-04_REVISED_RUNTIME_ATTESTATION_SPEC.md` | 18,640 | `3c3bc08ff3b18490dcf279790ff841b7a2cc22baa06b0800d339a7da791f0560` |
| `B-03_REVISED_EXECUTABLE_ENFORCEMENT_SPEC.md` | 21,495 | `bc6cd09ddccdf084537d9f76140e22c3880f3c8f7873b816e8b427381e706659` |
| `C-04_REVISED_AUTHORITY_PACKAGE_DRAFT.md` | 10,835 | `1c6821ac4262c7ff97f974f52fd18a7d300aec9a4e2f929a598be8bc6d84b551` |
| `D-03_AMENDMENT-1_POST_CORRECTION_REVIEW.md` | 14,271 | `8a0b3c953683fdaaea691569faddd1827fdb87d38c7902689881a342dbdae803` |
| `D-03_INDEPENDENT_WAVE_0.4_ASSURANCE_REPORT.md` | 26,674 | `4ac662b1baaa764e41984269af3a251c94ba025b2734a4030d76f95003758134` |
| `GATE-04_PROPOSED_DECISION_PACKAGE.md` | 12,604 | `fa8c82bc3dff5a53ad446bb0e509466eb9c8cdeb7156f44511daaf4bea25367b` |
| `LAB-03_REVISED_ISOLATION_SPEC.md` | 26,492 | `1beac099d6c59699635a4f934a629712fcfe159763c7db82d78d004ce9a3d9bc` |
| `SCRUM04_RECONCILIATION.md` | 12,999 | `a50dddf3028c053f743519348909b627f998d2b0cd5d1409a6c8b1bc38c9f971` |
| `W04_BASE_VERIFIED_REPOSITORY_AND_ARTIFACT_INVENTORY.md` | 7,238 | `138fee96b2513736c7baaf84bfc835aee251eb6469dd18a0103ad06250a62512` |
| `W04_CONTROLS_OBJECTION_RESOLUTION_MATRIX.md` | 9,059 | `f54154d72e279789502d47bbafc17eda13532f49868aeff57cb6a03f60463e01` |
| `W04_CONTROLS_RESIDUAL_RISK_REGISTER.md` | 15,162 | `7152e68f1777406b24c03ea115bed81b3507b3aa571409c147774874ddadeee2` |
| `W04_D03_REVIEW_PREPARATION.md` | 31,270 | `9d7e6879f37df299e1084589c4296104034d8e4aee94825d78e4dac51918526c` |
| `W04_EVIDENCE_INTEGRITY_FINDINGS.md` | 14,503 | `6d9341d429c684cf8e37de7aa215416bda884e5a7137b05ea4eae73d20e46e93` |
| `W04_GOVERNANCE_DEPENDENCY_MAP.md` | 7,617 | `05c05cbafb33a033bdbab5a3e77004756c9241f0dd8bfbb95bc9e09751b5b4` |
| `W04_HASH_DOMAIN_POLICY.md` | 13,366 | `f02a762b9553a729052fa135c78788ba2d5072573a0d582742903266afa399b2` |
| `W04_LAB_ISOLATION_ACCEPTANCE_CHECKLIST.md` | 15,509 | `6ddba05d88056e802b5f10371b88b57e4357f219aa9a87aa74733991e5ba42f2` |
| `W04_LAB_RESIDUAL_RISK_AND_REUSE_ASSESSMENT.md` | 17,029 | `9526946801f8c1e0d86536874da104eab8d35454f54a917b8c72fe219a98c20e` |
| `W04_MISSING_AUTHORIZATION_REGISTER.md` | 6,865 | `d88198e380c1cc51dc7a6113f8bd581e687fb880b37044130a32b6890665ef14` |
| `W04_SCRUM_AUTHORITATIVE_TRACKER.md` | 7,769 | `15ca1353d195351d246637c2011938ffb27957da9487f89c8059afc6d92ad7ee` |
| `W04_VERIFICATION_REPORT.md` | 5,856 | `3dc16c9d7db1ceab579729f50b4bc28810296f6f7cb78fcf8b5dd095f0d85357` |

All 20 are mutable untracked files. Their hashes are observations, not Git or publication
identities.

## Complete Wave 0.5 membership crosswalk

Wave 0.5 contains 88 files: 30 root Markdown records, 36 schema-root files (35 schemas plus
`README.md`), 16 fixture JSON files, and 6 vector files.

### Root records — 30

`F-04_AMENDMENT-1_POST_CORRECTION_ASSURANCE.md`; `F-04_AMENDMENT-2_FINAL_RECONCILIATION_ASSURANCE.md`;
`F-04_AMENDMENT-3_FINAL_METADATA_CLOSURE.md`; `F-04_AMENDMENT-4_METADATA_SUPERSESSION_CLOSURE.md`;
`F-04_INDEPENDENT_WAVE_0.5_ASSURANCE_REPORT.md`; `GATE-05_AMENDMENT-1_HUMAN_AUTHORITY_IDENTITY.md`;
`GATE-05_PROPOSED_DECISION_PACKAGE.md`; `W05_AUTHORITY_CLOSURE_PACKAGE.md`;
`W05_AUTHORITY_CONTRACT_CROSSWALK.md`; `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md`;
`W05_AUTHORIZATION_INPUT_AMENDMENT_1_HUMAN_AUTHORITY.md`; `W05_AUTHORIZATION_INPUT_RECORD.md`;
`W05_BASE_VERIFIED_INVENTORY.md`; `W05_CROSS_CONTRACT_INTEGRATION_REPORT.md`;
`W05_G3_G4_RECEIPT_REQUIREMENTS.md`; `W05_IMMUTABLE_REFERENCE_CROSSWALK.md`;
`W05_INTERFACE_MATRIX.md`; `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md`;
`W05_NINE_OBJECTION_CLOSURE_MATRIX.md`; `W05_POST_CORRECTION_RECONCILIATION.md`;
`W05_POST_CORRECTION_RECONCILIATION_AMENDMENT_1.md`; `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`;
`W05_REVIEW_PREPARATION_MATRIX.md`; `W05_SCHEMA_CONTRACT_RECONCILIATION.md`;
`W05_SCRUM_TRACKER_AMENDMENT.md`; `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`;
`W05_UNAUTHENTICATED_EVIDENCE_REGISTER.md`; `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md`;
`W05_VERIFICATION_REPORT.md`; `W05_VERSIONED_REGISTRY.md`.

### Schema-root files — 36

`README.md`; `a01-a12-transition-record.schema.json`; `anchor-checkpoint.schema.json`;
`approved-runtime-manifest.schema.json`; `assignment-acknowledgement.schema.json`;
`assignment-receipt.schema.json`; `attestation-evidence.schema.json`;
`audit-ledger-record.schema.json`; `authority-object-base.schema.json`;
`authority-revocation.schema.json`; `authorization-a09-decision.schema.json`;
`candidate-qa-receipt.schema.json`; `candidate-review-package.schema.json`; `common.schema.json`;
`effective-configuration-measurement.schema.json`; `evidence-acceptance-receipt.schema.json`;
`execution-release.schema.json`; `findings-closure-receipt.schema.json`; `g3-acceptance.schema.json`;
`governed-audit-ledger-envelope.schema.json`; `independent-review-receipt.schema.json`;
`inference-receipt.schema.json`; `ledger-head-attestation.schema.json`;
`model-endpoint-statement.schema.json`; `nested-candidate-manifest.schema.json`;
`outbox-delivery.schema.json`; `platform-verification-result.schema.json`;
`reconciliation-result.schema.json`; `reinstatement-receipt.schema.json`;
`revocation-snapshot.schema.json`; `rollback-plan.schema.json`; `rollback-receipt.schema.json`;
`separation-conflict-assessment.schema.json`; `session-binding.schema.json`;
`verifier-challenge.schema.json`; `verifier-verdict.schema.json`.

### Fixture files — 16

`a01-a12-transition-record.negative.json`; `a01-a12-transition-record.positive.json`;
`attestation-evidence.negative.json`; `attestation-evidence.positive.json`;
`audit-ledger-record.negative.json`; `audit-ledger-record.positive.json`;
`authorization-a09-decision.negative.json`; `authorization-a09-decision.positive.json`;
`correction-unit-fixtures.json`; `effective-configuration-measurement.negative.json`;
`effective-configuration-measurement.positive.json`; `evidence-acceptance-receipt.negative.json`;
`evidence-acceptance-receipt.positive.json`; `manifest.json`; `session-binding.negative.json`;
`session-binding.positive.json`.

### Vector files — 6

`W05_CANONICAL_LEDGER_ATTESTATION_VECTORS.json`;
`W05_VECTOR_DERIVATION_AND_REPRODUCTION.md`; `derive_vectors.py`;
`derive_vectors_registry_1_2.py`; `reproduce_vectors.py`;
`reproduce_vectors_registry_1_2.py`.

All 88 files are untracked and absent from `HEAD`. The complete per-leaf raw/LF identities are
committed by the Wave 0.5 inventory digest above. Important independently restated identities are:

- final vector bundle: 204,024 bytes,
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`;
- Registry 1.3.0: 42,335 bytes,
  `c39ea9240f0715d5ecaa56137745ca72fed2720913795ead5806c107b9fa05d4`;
- post-correction Amendment 1: 2,837 bytes,
  `9f5892f1d1ff28a8169b08720bad9b33853cba711d5fb9379d8e01777cb14d4c`;
- nested candidate specification: 23,972 bytes,
  `67fd56cd4b2af1893e77fb28ae5026748703e85ffffc2226659c6f7887d9d81e`.

## QA receipt inventory and manifest crosswalk

| File | Raw bytes | Raw SHA-256 | LF bytes | LF SHA-256 |
| --- | ---: | --- | ---: | --- |
| `EV-INF-PRE-A09-AUTHORITY-NAMES-00.json` | 6,608 | `aef3c4146bbd978a7c4eb2b5798776351e2728d450dd9556404fd8facaa611ef` | 6,448 | `677145c3b3a290a01eed4201384d42797856afb73adeba4aeeccd71bf9bd58b5` |
| `EV-INF-PRE-A09-DETERMINISTIC-READINESS-00.json` | 2,900 | `058bcc5cd035c5c1be243e90be0ec59486e9a7029489511ef2367e7cb436a4ba` | 2,835 | `4477e159af6400c596a8c86ace6be0c7853a1ee019ebd003c66432eaa01bb932` |
| `EV-INF-PRE-A09-LOCAL-BRIDGE-00.json` | 13,605 | `100c4c174df2cf0fc41f4502410eebd3ca32631e6c7a77a36d422c135ca70f28` | 13,464 | `a6e58a37724127122f2a03c07b62753ec57c05214cec2d8b0076a530b72a6e4d` |
| `EV-STAR-00.json` | 1,576 | `44bd0d9eb880e1795eae478c273377eb7564ca1ba8d8e8a5fc4d65903bcfc17f` | 1,530 | `dd0b05fdc0d7bad3b336549087de4c9ef454b81548dae895559ac047528d5e63` |
| `EV-STAR-01.json` | 2,055 | `6d19f1d719f0ac6fbecaf016458848d9e6ec23c89f0bcab430996159bd5555ac` | 2,004 | `28b71a0871cb1b23bda605224ddbd400ec2c6a7bf8524541d3481ec4875d339e` |
| `EV-STAR-02.json` | 1,233 | `ac7f6070445a906e4ed0e03eadcbd59f64bd8322226b3c034284d1670166bd6d` | 1,202 | `49bfffae51172785032c69666b79a915a079d7be9d59d1bc18d8efa963f9f3d7` |
| `EV-STAR-03.json` | 4,652 | `6a16f48ccf075213c1847ac04697948a0fc20652a123492530fac8baa77f7256` | 4,528 | `22cc9c94cd74d604a7f2f73675bfd443f217d7cb192a7a195251a24f199f0eb9` |
| `EV-STAR-04.json` | 2,707 | `d155d5e5a79c1b098c45017836b18373d627171fead68142c52a2a7ba20f44b5` | 2,647 | `57e4f37f6e9ac34302372481ddc6dded02f8f7347157ccc6c45c7070bdf62c17` |
| `EV-STAR-05.json` | 2,917 | `a3d75b73e18a1b30ad5c457a45cd9f529602082f0bd3596dd5c4f33aad9e3e39` | 2,837 | `bdd048415aa65aef59af315a57ed8b12fc861fbbe530ca4cffd57289f821316d` |
| `MANIFEST.sha256` | 821 | `4a67cbe5e960d12a9c15372a7ccdbec0d484dc7a4e58a25d9de8ed9a636fb145` | 812 | `f1c14deb36d3a868cb20d877012a6f3262d72eae1cbcaf6952957f2cb88f73bc` |

Current result: 9 manifest entries, 9 LF-domain matches, 0 mismatches. The manifest remains a
mutable unsigned two-column file with no explicit domain declaration, generation identity,
candidate commit or publication receipt.

## Current parse and graph checks

- Wave 0.5 JSON files discovered: 52; parsed: 52; failures: 0.
- Schema files: 35.
- Fixture JSON files: 16.
- Vector files: 6.
- Final vector declared scenarios: 14; actual scenarios: 14.
- Receipt graph: 9 nodes, 14 edges, 0 missing targets, 0 cycles.

## Wave 0.6 final technical-package crosswalk

The final technical package contains 55 local files. Its
`W06_TECHNICAL_FREEZE_MANIFEST.json` declares 54 normative entries because the manifest cannot
include an ordinary final digest of its own bytes. Read-only verification found all 54 declared
raw-byte sizes and SHA-256 values matching.

This is a **technical freeze manifest**: a deterministic exact-byte inventory of a mutable local
working-tree package. It is not an authorized freeze, Git commit/tree binding, remotely immutable
locator, signed publication envelope or publication receipt. All technical and verification
files remain untracked and absent from `HEAD`.

Controlling human-principal spelling in the final package is **Hakeem Moore**. This spelling is a
package consistency result; it does not establish stable identity, mandate provenance, signature
or a candidate-bound decision.

| Final local output | Bytes | Raw SHA-256 | Purpose |
| --- | ---: | --- | --- |
| `technical/W06_TECHNICAL_FREEZE_MANIFEST.json` | 10,359 | `69d71ec5905abc626ed3337a61dad51a5ebbbe1fda2a04c3b4a84140681757ec` | Local 54-entry normative exact-byte inventory; self hash external by design |
| `technical/W06_TECHNICAL_COMPLETION_REPORT.md` | 5,279 | `2d5c117a1c08b0b9a51afc097c3c84c88a35a8563b558753ce4315c828735a07` | Final technical disposition and residual dependencies |
| `technical/W06_SCHEMA_FULL_DOCUMENT_COVERAGE_MATRIX.md` | 5,186 | `a300477581ba09bc9a213f0793f33dba4963b614bad7d5f906a68ea747bbac64` | Concrete/helper classification and complete-document coverage |
| `verification/FINAL_TECHNICAL_VERIFICATION.md` | 6,595 | `de90f813407586429608465c51da63654e005c0aa6285e0ca652379860a42395` | Human-readable independent local non-operational verification |
| `verification/final_technical_results.json` | 16,624 | `27624c5bfad9715e14ea74d819cded91b55c2cab6060d449faa8d93eb7489b6d` | Machine-readable 15-check final result |
| `verification/final_technical_verify.py` | 50,332 | `3be618ebffaeab70e81c999fe28a94a60b6027ffdac0646caf89b704a451faa7` | Final local verification procedure |

Final executed outcomes:

- 54/54 normative manifest entries matched declared size and SHA-256.
- 15/15 final verification checks passed; 0 executed failures.
- 35 schemas passed parsing, unique-ID and Draft 2020-12 meta-schema checks.
- Schema classification: 33 concrete/instantiable and 2 definition-only helpers.
- 576/576 local references resolved.
- 162/162 full-document outcomes passed, including 125/125 negative cases rejected for the
  intended reason.
- 57/57 positive/negative subschema pairs passed, for 114 outcomes.
- 8/8 directly mapped positive vector instances were schema-valid.
- All 14 vectors reproduced byte-for-byte; the 204,024-byte bundle SHA-256 remains
  `b174bddaf8ace7e405701dd7c96f5f47f07dc2313fec3f96191005da4a4fac52`.
- Ephemeral in-memory P-256 signing/verification, DER-to-64-byte-P1363 conversion, low-S
  normalization, unpadded base64url round-trip and high-S profile rejection passed.
- Bounded Node/ECMAScript cross-runtime canonicalization passed for key ordering, escaping,
  number formatting and exact vector record bytes.

NOT_RUN remains explicit: a complete third-party RFC 8785 conformance suite; treating the
synthetic vector `r=1,s=1` sentinels as genuine signatures; operational key/trust-chain,
authority, identity or revocation verification; stateful consumer enforcement; runtime/lab/
network testing; and authorized publication/adoption.

## Crosswalk result

- Wave 0.3: immutable local Git containment exists at current `HEAD`; no publication or
  governance acceptance is inferred.
- Wave 0.4: exact current bytes are observable, but no index/blob/tree/commit or publication
  binding exists.
- Wave 0.5: exact current bytes and membership are observable, but the entire 88-file set remains
  mutable and untracked; local validation materially improves consistency evidence but does not
  create Git/publication identity or adoption.
- Wave 0.6 technical: the 54-entry local technical freeze and 15/15 verification result establish
  exact-byte and executed non-operational consistency for the final package, but not authorized
  immutable publication, operational trust or acceptance.
- QA receipts: current LF-domain manifest integrity and acyclic dependencies are verified;
  historical execution and the unsupported commit reference are not repaired by hashing.

