# GP-R3 Gate P Blocker-Removal Plan

## Control record

- Experiment: `AU-UCR-EP-000001`
- Plan ID: `GP-R3`
- Status: `PROPOSED_NOT_EXECUTED`
- Gate P effect: `NO_CHANGE — BLOCKED_BY_EVIDENCE`
- Created: `2026-10-13`
- Purpose: convert the remaining authority, custody, immutable-publication, and acceptance gaps into an executable evidence chain.
- Non-effects: this plan does not adopt the proposed manifest, supersede v1.0.0, authorize preservation, publish any object, appoint any role, accept A09/G3/G4, or approve Gate P.

## Fixed review binding

The technical input to this plan is fixed to the reviewed packet and candidate:

- Packet commit: `bddfafef7f558084a94b76b9cf38d57e924b05db`
- Packet tree: `a71ef60556304d1d77561affe91f260ec72ad43c`
- Candidate commit: `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Candidate tree: `dca22c304034f1662db99230a29d3ccc3ca38889`
- R2 54-file aggregate: `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`
- Computational review outcome: `REVIEW_PASS`
- Human approval payload SHA-256: `4580f85ac69eb076e11c93c992bfbb14e985d973cb6a0f2112771a2fd26d062f`
- SSH signature SHA-256: `404d49fc8cb5c0db33c22fadc57c8964e511a189ff67b547596c039de5e7eeb4`
- SSH key fingerprint: `SHA256:2pjiz5NEOUQCIVLomZ534+EJjIZNUME8fyUL2xyoYpo`
- RFC 3161 generation time: `2026-10-13T23:52:58Z`
- Local handoff SHA-256: `865f240385b008b28e0954430d45e6b2c62583541e5e919447f7ba63600b597b`

These facts evidence approval of the computational review result only. They do not establish reviewer independence from the approving human and do not authorize Gate P.

## Blocker statement

The computational uncertainty is resolved, but the governance and preservation transition is not. The committed records still show:

1. an unsigned Gate P decision with a pending L3 binding;
2. no human-selected immutable destination;
3. proposed, not operational, WORM, retention, integrity, and custody controls;
4. no effective signed appointment and acknowledgement for the Publication Custodian and Decision Chair;
5. no signed conflict/separation assessment;
6. all ten authority gaps formally open;
7. no authorized freeze/publication run;
8. no remote retrieval and independent byte remeasurement;
9. no L5 publication receipt; and
10. no separate signed Gate P disposition for the exact L4/L5 candidate.

No technical artifact can close items 2, 4, 5, 7, or 10 without a human decision.

## Recommended solution architecture

### 1. Authority plane

Use the existing SSH signing identity as one identity-evidence input, then issue new, narrowly scoped signed instruments for:

- root mandate and delegation;
- Decision Chair appointment and acknowledgement;
- Publication Custodian appointment and acknowledgement;
- Independent Verifier appointment and acknowledgement;
- duties, prohibited overlaps, effective time, expiry/revocation, and exact experiment scope;
- conflict/separation assessment covering the Human Authority, Decision Chair, Publication Custodian, evidence preparer, QA, Independent Reviewer, and Independent Verifier; and
- one-time publication authorization bound to the exact packet, candidate, aggregate, L3 root, destination, retention configuration, and execution window.

Role labels are not appointments. Every effective role record must carry an authenticated identity, public-key fingerprint, signature, trusted timestamp or independently checkable time evidence, and digest references to all prerequisites.

### 2. Immutable destination plane

The recommended implementation profile is a dedicated Amazon S3 general-purpose bucket with Versioning and S3 Object Lock enabled, using `COMPLIANCE` mode, no automated deletion, and a legal hold on every published object version. The Human Authority must still select and sign the exact AWS account, region, bucket ARN, retention duration, legal-hold policy, encryption profile, and cost acceptance before provisioning or use.

This profile is recommended because AWS documents Object Lock as WORM storage, requires Versioning, and states that Compliance mode prevents deletion or overwrite during retention even by the account root user. AWS also documents legal holds and S3 Inventory fields for retention mode, retain-until date, and legal-hold status. Object Lock does not prevent creation of new versions or delete markers, so the evidence receipt must bind immutable object `versionId` values rather than keys alone.

Provisioning is intentionally outside this plan. AWS states that Object Lock cannot be disabled and Versioning cannot be suspended after Object Lock is enabled, so the irreversible configuration and its cost require the signed destination decision first.

Required destination controls:

- separate administration for publication, verification, and account recovery;
- default `COMPLIANCE` retention with duration `TBD_HUMAN_DECISION`;
- legal hold `ON` for every evidence object version;
- bucket policy denying unencrypted transport and writes outside the authorized custodian role;
- no `s3:BypassGovernanceRetention` dependency;
- read-only verifier access to object bytes, versions, retention, and legal-hold metadata;
- CloudTrail data-event logging or an approved equivalent;
- S3 Inventory including version, checksum where available, retention, and legal-hold fields;
- no lifecycle deletion rule for governed evidence;
- if SSE-KMS is selected, key administration and deletion controls that preserve readability for at least the entire evidence retention period; and
- a second, separately administered checkpoint or exported inventory digest when the Human Authority requires recovery from account loss.

AWS source basis, accessed `2026-10-13`:

- [Locking objects with Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
- [Configuring S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-configure.html)
- [Object Lock considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-managing.html)
- [Cataloging and analyzing data with S3 Inventory](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-inventory.html)

### 3. Evidence plane

Create a content-addressed publication set. Every child record is hashed before its parent, and no record includes its own digest.

- L0: exact object bytes, size, Git blob OID where applicable, SHA-256, and media/encoding facts.
- L1: family manifests for candidate content, review packet, approval receipt, authority instruments, and destination configuration evidence.
- L2: source, review, authority, and preservation-policy roots.
- L3: reviewed source-candidate root bound to the packet commit/tree, candidate commit/tree, and 54-file aggregate.
- L4: decision-package root binding L3 plus QA, independent review, findings closure, authority, separation, and publication authorization.
- L5: signed publication envelope issued only after every remote object version is retrieved and remeasured.
- L6: QA, Independent Reviewer, Independent Verifier, findings-closure, and Decision Chair receipt chain.

The historical v1.0.0 manifest remains unchanged. If v1.1.0 is later adopted, adoption and supersession must be separate append-only signed records. Rollback means issuing an invalidation or supersession record; it never means deleting or rewriting either manifest or any published evidence version.

## Fail-closed execution sequence

1. Human Authority signs the identity/mandate, role appointments, acknowledgements, separation assessment, destination decision, retention decision, and one-time publication authorization.
2. QA verifies signatures, timestamps, fingerprints, scope, effective time, revocation state, and role separation. Any unknown or conflicting value stops the run.
3. Publication Custodian records the exact source and review cutoffs and freezes the candidate inputs without modifying reviewed bytes.
4. The packager recomputes every R2 fact independently from the fixed Git objects, then creates proposed L0-L4 records.
5. An Independent Reviewer reproduces the 54-member calculation and aggregate from committed bytes and signs an exact L3 acknowledgement. Existing R2 review evidence may be incorporated, but any required independence assessment remains separate.
6. QA validates the complete L4 package and closes or records every exception. Open material findings stop publication.
7. Publication Custodian uploads every authorized child object with explicit Compliance retention and legal hold, recording the bucket ARN, key, `versionId`, provider checksum/ETag, retention mode, retain-until time, legal-hold status, uploader identity, and provider request identifier.
8. Independent Verifier retrieves each exact `versionId`, recomputes size and SHA-256, reads retention and legal-hold metadata, and compares the result with L4.
9. If and only if every object resolves and matches, Publication Custodian creates, signs, timestamps, uploads, retrieves, and verifies L5 last. L5 binds all object-version locators and the L4 digest.
10. QA and the Independent Verifier issue L6 receipts. Any discrepancy results in `PUBLICATION_INCOMPLETE`; no success receipt is emitted.
11. Decision Chair verifies the exact L4/L5/L6 chain and signs one disposition: `PASS`, `REVISE`, or `REJECT`.
12. A Gate P `PASS` records only the preservation decision for the exact L4/L5/L6 candidate. Manifest adoption, supersession, A09, G3, G4, execution, and later preservation maintenance or rollback remain separately governed transitions.

## Work register

The machine-readable companion is `artifacts/reports/GP-R3-GATE-P-BLOCKER-REMOVAL-TRACKER.csv`. Status values are evidence states, not estimates.

| ID | Outcome | Current state | Blocking dependency | Acceptance evidence |
| --- | --- | --- | --- | --- |
| `GP3-001` | Formalize the exact candidate and L3 scope | `READY_FOR_DRAFT` | None | Signed scope record binds all fixed review identifiers |
| `GP3-002` | Close identity, mandate, scope, time, and lifecycle gaps | `BLOCKED_HUMAN_SIGNATURE` | `GP3-001` | Effective signed mandate and acknowledgement |
| `GP3-003` | Appoint Decision Chair, Publication Custodian, and Independent Verifier | `BLOCKED_HUMAN_SELECTION` | `GP3-002` | Signed appointments and acknowledgements |
| `GP3-004` | Prove conflicts and separation | `BLOCKED_ROLE_IDENTITIES` | `GP3-003` | Signed separation assessment with explicit comparisons |
| `GP3-005` | Select destination and retention profile | `BLOCKED_HUMAN_DECISION` | `GP3-002` | Signed account/region/bucket/retention/encryption/cost decision |
| `GP3-006` | Provision and attest immutable controls | `BLOCKED_AUTHORIZATION` | `GP3-003`, `GP3-005` | Read-only configuration export and negative-control tests |
| `GP3-007` | Generate proposed L0-L4 package | `BLOCKED_SCOPE_AND_POLICY` | `GP3-001`, `GP3-004`, `GP3-006` | Deterministic package plus independent recomputation log |
| `GP3-008` | Close QA, review, and findings | `BLOCKED_PACKAGE` | `GP3-007` | Candidate-bound signed receipts; zero open material findings |
| `GP3-009` | Authorize exact publication run | `BLOCKED_PREREQUISITES` | `GP3-002`–`GP3-008` | Signed one-time authorization with cutoffs and destination |
| `GP3-010` | Publish and independently remeasure | `BLOCKED_RUN_AUTHORITY` | `GP3-009` | Per-version upload and retrieval evidence |
| `GP3-011` | Issue and verify L5/L6 | `BLOCKED_PUBLICATION` | `GP3-010` | Signed/timestamped L5 and QA/verifier L6 receipts |
| `GP3-012` | Decide Gate P | `BLOCKED_L5_L6` | `GP3-011` | Decision Chair signature over exact L4/L5/L6 chain |

## Acceptance gate

Gate P is eligible for a human decision only when all of the following evaluate true:

- all ten authority gaps have evidence-backed closure records;
- exact role identities, mandates, acknowledgements, effective times, and revocation states verify;
- the separation assessment permits the actual role allocation;
- the signed destination record matches the provisioned immutable store;
- destination negative tests prove denied overwrite, denied early delete, and denied unauthorized write;
- L3 binds the reviewed packet, candidate, and aggregate exactly;
- L4 binds review approval, authority, QA, review, and findings closure without circular hashing;
- every remote child object version retrieves byte-for-byte and retains the required lock metadata;
- L5 was issued last and binds the exact remote object versions and L4 root;
- L6 receipts verify and contain no open material exception; and
- the Decision Chair signs the exact Gate P disposition after verifying L4/L5/L6.

Anything less remains `BLOCKED_BY_EVIDENCE`. Technical checks, provider configuration, MFA, key ownership, or a reviewer recommendation alone cannot substitute for the signed decision.

## Failure, rollback, and supersession

- Before L5: quarantine the incomplete prefix, preserve logs and provider receipts, revoke the run authorization, and begin a new run with a new identifier. Never label the attempt published.
- After L5: never mutate or delete the published evidence. Issue an append-only invalidation or supersession record that references the exact L5 and reason, then publish a new candidate under a new L3/L4/L5 chain.
- Credential compromise: revoke the affected authority record and key, retain the old signed evidence, publish a revocation receipt, and require a new authorization chain.
- Destination-control drift: suspend Gate P reliance, preserve the last verified inventory, investigate, and require a new independent retrieval audit before restoration.
- Hash, signature, timestamp, locator, retention, or role mismatch: fail closed; no inferred acceptance and no partial PASS.

## Decisions still required

The Human Authority must supply or sign the following before execution:

1. actual names and authenticated identities for Decision Chair, Publication Custodian, and Independent Verifier;
2. whether the proposed role allocation passes separation requirements;
3. exact AWS account, region, bucket ARN, retention duration, legal-hold policy, encryption profile, and cost acceptance—or a signed choice of another destination with equivalent controls;
4. source/review cutoffs and the exact authorized publication scope;
5. whether and when the v1.1.0 proposal may be adopted and v1.0.0 superseded through separate append-only records; and
6. the final Gate P disposition after L4/L5/L6 exist.

Until these decisions are evidenced, the blocker has a closure path but is not removed.
