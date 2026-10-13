# Wave 0.5 Nested Candidate Manifest Specification

## 1. Control record

- **Task:** `FOR-ACT-S0-001-W05-PROVENANCE`
- **Finding addressed:** `F04-NMF-05`
- **Experiment:** `AU-UCR-EP-000001`
- **Repository:** `https://github.com/mrrobot787/starnet.git`
- **Local repository:** `C:\Users\hakee\.cursor\starnet-ucr-publish-2`
- **Inspected baseline:** `39bade0506b4d5b12bb979ccf6a51bb11944a9ff`
- **Git object format:** `sha1`
- **Prepared:** 2026-10-12
- **Status:** `NESTED_MANIFEST_HIERARCHY_SPECIFIED_NOT_INSTANTIATED`
- **Publication claim:** none
- **Acceptance effect:** none

This specification normatively resolves the manifest-scope ambiguity identified by
`F04-NMF-05`. It defines how Wave 0.4 content, all final Wave 0.5 outputs, review evidence,
publication evidence and acceptance must be related. It does not freeze, stage, commit, push,
publish, sign, review or accept any artifact.

All current Wave 0.4 and Wave 0.5 artifacts remain untracked and outside baseline `HEAD`.
Commit and push/publication authority remain absent.

## 2. Normative language and invariants

`MUST`, `MUST NOT`, `SHALL` and `SHALL NOT` state requirements for a future authorized
publication process. They are not claims that the process has occurred.

The hierarchy SHALL satisfy these invariants:

1. every final in-scope file occurs exactly once as a leaf in one family manifest;
2. every child manifest is bound by exact canonical bytes, byte count and SHA-256 in its parent;
3. every parent records the ordered child set and rejects missing, extra or duplicate children;
4. every artifact records separate raw, LF-normalized and Git-object identities;
5. branch, path, filename, URN, PR and tag are metadata, never immutable identity by themselves;
6. review evidence identifies the exact lower-level candidate it reviewed;
7. a review output is not represented as reviewing its own bytes;
8. publication is complete only when the root and every transitive child resolve remotely;
9. amendment, supersession and revocation are append-only; no published manifest is rewritten;
10. no historical commit may be inferred, corrected or substituted silently;
11. no embedded observation count or illustrative filename list defines current membership; and
12. only an authorized freeze enumeration and its generated count/digest define candidate
    membership.

## 3. Seven-level hierarchy

The hierarchy has **seven normative levels, L0 through L6**.

### L0 — Artifact identity records

One record per repository-relative file. Each L0 record MUST contain the identity fields in
Section 5 and exactly one family assignment.

### L1 — Versioned family manifests

L1 manifests group artifacts by governance purpose. The required families are:

1. `W04-CONTENT` — every in-scope Wave 0.4 content/control/review/gate artifact present at the
   authorized cutoff.
2. `W05-CONTROL` — all Wave 0.5 baseline, tracker, objection, Scrum, status and gate outputs.
3. `W05-SCHEMA-FIXTURE` — all schema documentation, schema files, fixtures, fixture manifests and
   schema-validation outputs included at freeze.
4. `W05-VECTOR` — all vector bundles, derivation/reproduction reports, generators, reproducers,
   negative suites and vector-verification outputs included at freeze.
5. `W05-CONTRACT` — all shared contracts, interface matrices, registries and contract amendments.
6. `W05-AUTHORITY` — all authorization inputs, closure packages, schema requirements,
   assignment/receipt requirements, crosswalks and authority amendments.
7. `W05-PROVENANCE` — all publication, unauthenticated-evidence, immutable-reference and nested
   manifest specifications, amendments and provenance receipts.
8. `W05-RECONCILIATION` — all schema/vector/contract/authority/provenance integration,
   reconciliation and post-correction reports.
9. `W05-REVIEW` — every review-preparation, assurance, amendment, QA, independent re-review,
   findings-closure, gate-review and review-disposition output included at the applicable freeze.

Each L1 manifest MUST state family ID, semantic version, candidate sequence, exact sorted member
set, entry count, prior family-manifest digest, change reason and lifecycle state.

### L2 — Wave manifests

- `W04-WAVE-MANIFEST` MUST bind the `W04-CONTENT` child.
- `W05-SOURCE-WAVE-MANIFEST` MUST bind the seven non-review Wave 0.5 families:
  `W05-CONTROL`, `W05-SCHEMA-FIXTURE`, `W05-VECTOR`, `W05-CONTRACT`, `W05-AUTHORITY`,
  `W05-PROVENANCE` and `W05-RECONCILIATION`.
- `W05-REVIEW-WAVE-MANIFEST` MUST bind `W05-REVIEW`.

The Wave 0.4 and Wave 0.5 manifests are separately versioned. Updating Wave 0.5 does not mutate
the Wave 0.4 manifest; it creates a new Wave 0.5 manifest and parent root.

### L3 — Reviewed source-candidate root

The L3 root binds the exact `W04-WAVE-MANIFEST` and `W05-SOURCE-WAVE-MANIFEST` that constitute
the source candidate under review. It MUST identify `W05-REVIEW-WAVE-MANIFEST` as intentionally
excluded because those outputs evaluate L3. Its ID is the only candidate ID that QA/review outputs
may claim to have reviewed.

Current `F-04_INDEPENDENT_WAVE_0.5_ASSURANCE_REPORT.md` reviewed 43 pre-F-04 Wave 0.5 inputs.
It predates the F04-NMF-05 corrections and cannot be represented as reviewing the corrected L3
candidate. It remains historical technical review evidence whose scope points to its measured
pre-correction inventory. A new review is required after an authorized corrected candidate is
frozen.

### L4 — Decision-package root

The L4 root binds:

- the exact L3 reviewed source-candidate root;
- `W05-REVIEW-WAVE-MANIFEST`, transitively binding the L1 `W05-REVIEW` manifest containing
  review preparation, F-04, later review amendments, QA, independent re-review and closure outputs;
- any findings/dependency-closure family manifests added by the final process; and
- an explicit relation from every review/closure artifact to the exact L3 digest it evaluates.

L4 therefore covers every final source and review output without claiming that a report reviewed
itself. Acceptance MUST target L4 while preserving L3 as the reviewed source identity.

### L5 — Publication envelope and receipt

L5 binds final canonical L4 bytes to:

- canonical repository identity and publication service/namespace;
- candidate-content commit and root tree;
- manifest commit or external immutable envelope;
- every transitive Git object;
- immutable published locator;
- publisher stable identity, authority, signature and verification evidence; and
- remote retrieval and independent remeasurement result.

L5 is publication evidence only. It does not itself create QA, review, adoption or acceptance.

### L6 — Governance receipt chain

L6 binds the exact L5 publication receipt and L4 decision package through separately valid:

1. exact-candidate QA receipt;
2. independent-review receipt;
3. findings/dependency-closure receipt; and
4. Decision Chair acceptance receipt.

Only the fourth valid receipt with outcome `ACCEPTED` may close G3. A later, separate
Coordinator/Architect exact-run receipt is outside candidate publication and is required for G4.

## 4. Historical observations and dynamic freeze membership

### 4.1 Historical observations only

The following counts and lists record earlier inspection scopes. They are **not normative current
membership**:

- an early provenance observation saw 44 Wave 0.5 files;
- the F04-NMF-05 correction later saw 47 files after concurrent additions;
- F-04 Amendment 1 subsequently recorded 77 pre-amendment files and noted that its own creation
  became a 78th file; and
- earlier family observations such as 24 schema/fixture files, 4 vector files, 2 or 3 contract
  files, and 4 or 5 authority files describe only their measured snapshots.

No consumer may use those numbers as an expected candidate count, omission threshold or
publication completeness test. Later schemas, vectors, registries, assurance amendments and
other outputs demonstrate why static embedded counts cannot define a final candidate.

The filenames below are likewise historical examples useful for family classification. They are
not an exhaustive current manifest and do not exclude later files.

### Historical `W05-CONTROL` examples

- `W05_BASE_VERIFIED_INVENTORY.md`
- `W05_NINE_OBJECTION_CLOSURE_MATRIX.md`

### Historical `W05-CONTRACT` examples

- `W05_SHARED_TRUST_AND_STATE_CONTRACT.md`
- `W05_INTERFACE_MATRIX.md`
- `W05_VERSIONED_REGISTRY.md`

### Historical `W05-AUTHORITY` examples

- `W05_AUTHORIZATION_INPUT_RECORD.md`
- `W05_AUTHORITY_CLOSURE_PACKAGE.md`
- `W05_G3_G4_RECEIPT_REQUIREMENTS.md`
- `W05_AUTHORITY_CONTRACT_CROSSWALK.md`
- `W05_AUTHORITY_SCHEMA_REQUIREMENTS.md`

### Historical `W05-PROVENANCE` examples

- `W05_PUBLICATION_AND_PROVENANCE_SPEC.md`
- `W05_UNAUTHENTICATED_EVIDENCE_REGISTER.md`
- `W05_IMMUTABLE_REFERENCE_CROSSWALK.md`
- `W05_NESTED_CANDIDATE_MANIFEST_SPEC.md`

### Historical `W05-RECONCILIATION` examples

- `W05_SCHEMA_CONTRACT_RECONCILIATION.md`
- `W05_VECTOR_SCHEMA_CONTRACT_RECONCILIATION.md`
- `W05_CROSS_CONTRACT_INTEGRATION_REPORT.md`

### Historical `W05-REVIEW` examples

- `W05_REVIEW_PREPARATION_MATRIX.md`
- `F-04_INDEPENDENT_WAVE_0.5_ASSURANCE_REPORT.md`
- `F-04_AMENDMENT-1_POST_CORRECTION_ASSURANCE.md`

### 4.2 Normative dynamic membership rule

At authorized freeze, the publisher MUST recursively enumerate the governed Wave 0.4 and Wave
0.5 roots from the filesystem and Git candidate scope, without relying on any count or list
embedded in this or another narrative. The enumeration MUST include every file present at the
declared cutoff that is in authorized scope, including all subsequent:

- schemas, fixtures, vectors, generators and validation/reproduction outputs;
- contracts, registries and authority/provenance artifacts;
- reconciliation and integration reports;
- assurance reports and amendments;
- QA, independent-review and findings/dependency-closure outputs;
- trackers, Scrum/status records and gate/decision packages; and
- publication, amendment, supersession and revocation records assigned to that candidate layer.

The authorized freeze declaration MUST state roots, cutoff, inclusion rules and any explicit
exclusion. An exclusion requires a repository-relative path, reason, authority and impact; silent
exclusion is prohibited. Generated L1-L4 manifest/envelope files are handled by the two-commit or
external-envelope model and MUST not create self-membership.

The freeze tool MUST sort repository-relative UTF-8 paths, reject duplicates, aliases, traversal,
case collisions, missing files and out-of-scope extras, then generate—not consume from prose—the:

- exact leaf count per family;
- exact total source and review counts;
- each leaf's raw/LF/Git identities;
- each L1 family digest and count;
- each L2 wave digest and count;
- L3 reviewed-source root digest/count; and
- L4 decision-package root digest/count.

Any file created, changed, removed or reclassified after the applicable cutoff invalidates the
affected count/digest and requires a new candidate sequence or review overlay. Membership is
therefore unknown until freeze and is never inferred from the latest observed working-tree count.

## 5. Exact identity domains

### 5.1 L0 raw and LF domains

Every L0 record MUST contain:

- repository-relative UTF-8 path using `/`;
- `raw-working-tree-sha256-v1`: exact binary byte count, SHA-256, CRLF-pair count, lone-LF count,
  lone-CR count, capture OS/time and worktree status;
- `crlf-to-lf-sha256-v1`: byte count and SHA-256 after only `0d 0a -> 0a`;
- explicit transformation result counts; and
- equality/difference statements among raw, LF and later blob bytes.

No decoding, Unicode normalization, whitespace change, JSON serialization, final-newline change
or lone-CR conversion is permitted in the LF domain.

### 5.2 Git object and path domains

After authorized staging/commit, every L0 record MUST add:

- repository object format;
- full blob OID, object type, object size and independent SHA-256 of blob bytes;
- index mode/stage/blob binding used during freeze;
- full candidate-content commit OID;
- full containing tree OID;
- path mode and blob OID from that commit tree; and
- proof that the exact commit is a resolvable `commit`.

Git OIDs and SHA-256 content digests MUST not be mislabeled or interchanged.

### 5.3 Manifest identity

Every L1-L4 manifest MUST be UTF-8 JSON without BOM, serialized under one adopted,
digest-pinned canonicalization profile. It MUST contain:

- schema ID/version, manifest level/type, stable manifest ID and semantic version;
- candidate sequence and lifecycle state;
- parent manifest ID/digest where applicable;
- ordered child records with child level/type/ID/version, canonical byte count and SHA-256;
- exact sorted-member rule and duplicate/collision rejection rule;
- canonical repository ID and canonical remote URI;
- content commit/tree and manifest commit/envelope identities when available;
- creation time, generator identity/version and authority reference;
- previous version digest, supersedes/amends relations and change summary;
- unsupported-reference register; and
- external final canonical-byte SHA-256.

A manifest MUST NOT embed a self-referential final digest or claim its own containing commit.
Use the two-commit or external-envelope model in Section 7.

### 5.4 Repository and published-locator domain

Repository identity MUST bind an approved stable repository ID, canonical remote URI, publication
service, namespace/owner and repository name. Local paths, branch/ref names, tags and PRs are
discoverability metadata only.

The published locator MUST be immutable and independently resolvable to the exact envelope,
manifest digest, candidate commit/tree and transitive object set. A mutable branch URL does not
satisfy this requirement.

## 6. Parent-child binding rules

For every edge from parent `P` to child `C`, `P` MUST carry:

- child manifest ID, version and level;
- canonical child byte count and SHA-256;
- child candidate sequence and lifecycle state;
- child content commit/tree or envelope identity;
- relationship (`contains`, `reviewed`, `evidence_for`, `amends`, `supersedes` or `revokes`);
- required/optional classification; and
- expected child publication locator, once published.

Verification MUST:

1. retrieve exact child bytes;
2. verify canonical serialization and digest;
3. recursively verify every descendant;
4. enforce complete ordered membership;
5. reject duplicate IDs, duplicate paths, case collisions, traversal, aliases and cycles;
6. verify all descendants bind the same repository and compatible candidate sequence; and
7. verify review/evidence edges target the exact L3 digest they claim.

One valid child does not validate its parent or siblings. A valid parent digest does not prove
publication, signer authority or acceptance without L5/L6 evidence.

## 7. Candidate freeze and publication procedure

Only an explicitly authorized actor may perform these mutating steps:

1. declare freeze authority, scope, repository, candidate sequence and cutoff time;
2. dynamically enumerate every in-scope Wave 0.4 and final Wave 0.5 path under Section 4.2 and
   generate counts/digests at that time;
3. stop concurrent writes or fail the freeze;
4. independently measure every L0 raw/LF identity;
5. build proposed L1-L4 manifests from those exact bytes;
6. stage only authorized paths and verify index/blob equality;
7. create the candidate-content commit and record its tree/path/blob bindings;
8. regenerate L0-L4 Git bindings against that exact commit;
9. finalize manifests in a second manifest commit or external immutable signed envelope;
10. independently reproduce all leaf, child, wave and root digests;
11. verify no source bytes changed between freeze and finalization;
12. push all required objects only under explicit push/publication authority;
13. retrieve every object and manifest from the publication service;
14. issue L5 only after complete remote resolution succeeds; and
15. begin candidate-bound QA/review only against the published L3/L4 identities.

The two-commit model SHALL use:

- commit A: exact candidate content;
- commit B: canonical manifests naming commit A; and
- L5: external receipt naming commits A and B plus final root digest.

An external-envelope model MAY omit commit B only if the signed immutable envelope contains the
same bindings and has an independently resolvable immutable locator.

## 8. Partial publication failure

Publication is atomic at L5 even if transport is physically multi-step. A candidate is
`PUBLISHED_VERIFIED` only when every required L0 object and L1-L4 manifest resolves remotely and
matches the root.

If any object, child manifest, parent manifest, signature, locator or remote remeasurement fails:

1. do not issue a success receipt;
2. mark the attempted root `PUBLICATION_FAILED_QUARANTINED`;
3. identify every successfully and unsuccessfully transferred object;
4. preserve transferred objects without treating them as a candidate;
5. keep the prior published candidate authoritative;
6. prohibit QA, review, acceptance and release against the partial root;
7. append a failure receipt with exact root digest, scope, timestamps, error and actor;
8. repair only through a new candidate sequence or authorized resumable attempt that revalidates
   the complete root; and
9. require fresh independent remote enumeration before success.

Publishing only a Wave 0.4 child, only schemas/vectors, or only a branch/ref does not publish L4.
No subset publication may be promoted by inference.

## 9. Amendment, supersession and revocation

Published bytes and manifests are immutable.

An amendment MUST:

- create a new manifest version and candidate sequence;
- bind the prior root digest and exact changed/unchanged child set;
- state whether it corrects metadata, content, review evidence or authority evidence;
- regenerate every affected ancestor digest;
- preserve old locators and receipts;
- obtain new QA/review for every affected dependency scope; and
- obtain a new acceptance decision if accepted bytes or prerequisites change.

Supersession marks a prior candidate ineligible for new use but does not delete it. Revocation
MUST be a separately signed append-only receipt that identifies the exact manifest/publication
receipt, authority, reason, effective ordering, affected scope, containment and re-review
requirements. Revocation uncertainty fails closed.

An amendment or revocation receipt MUST NOT be stored only inside the object it amends or revokes;
it requires an external immutable binding to avoid circular or unavailable evidence.

## 10. Acceptance binding

The Decision Chair acceptance receipt MUST bind:

- L4 decision-package root canonical digest and byte count;
- L3 reviewed source-candidate root;
- L5 publication receipt and immutable locator;
- repository ID, object format, candidate commit/tree and manifest commit/envelope;
- every L1 family manifest digest and version;
- the dynamically enumerated Wave 0.4 child manifest (20 was a historical observation only);
- all final Wave 0.5 schema, fixture, vector, contract, authority, provenance, reconciliation and
  review family manifests;
- QA, independent review and findings/dependency-closure receipts that target the same L3/L4;
- decision scope, conditions, residual risks, effective time, expiry/revocation; and
- effective Decision Chair assignment, acknowledgement, separation, key purpose, signature and
  verification evidence.

Acceptance of L4 does not claim that F-04 reviewed post-F-04 correction bytes. The final
independent-review receipt must explicitly target the corrected L3 root. Any changed descendant
invalidates the ancestor roots and requires new applicable QA/review/publication/acceptance.

## 11. Unsupported historical commit preservation

The deterministic-readiness receipt's exact historical reference remains:

`2ea38d86a19697b80a827d2dfd83a9219e145532`

Its classification remains **`UNSUPPORTED`**. The distinct local commit
`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` is not a substitute. Every L1-L4 manifest MUST carry
the unsupported-reference disposition or a digest-bound child register preserving it. No
amendment, review, manifest, commit or publication may silently replace the exact original value.

## 12. Current blockers

There are **10 open blockers**:

1. `W05-NCM-B01` — explicit candidate-freeze/commit authority is absent.
2. `W05-NCM-B02` — push/publication/signing authority is absent.
3. `W05-NCM-B03` — current Wave 0.4 and Wave 0.5 artifacts are untracked and have no blob/tree/
   commit bindings.
4. `W05-NCM-B04` — final membership is not frozen; concurrent or later correction/review outputs
   can change the set.
5. `W05-NCM-B05` — no canonical L1-L4 manifests or adopted manifest schema/profile exist.
6. `W05-NCM-B06` — no remotely resolvable immutable locator or L5 publication receipt exists.
7. `W05-NCM-B07` — no authorized publisher identity, mandate, signature or transparency evidence
   exists.
8. `W05-NCM-B08` — F-04 and Amendment 1 predate the final A1-NMF-01 membership correction;
   candidate-bound QA and an effective independent review of a frozen candidate are absent.
9. `W05-NCM-B09` — findings/dependency closure and Decision Chair acceptance are absent.
10. `W05-NCM-B10` — the exact historical deterministic commit remains unsupported and must remain
    explicitly carried as an unresolved provenance limitation.

No blocker is converted to a pass by this design.

## 13. Reproducible read-only checks

```powershell
git rev-parse HEAD
git rev-parse --show-object-format
git status --porcelain=v1 -uall
git ls-tree -r --name-only HEAD -- docs/experiments/au-ucr-ep-000001/wave-0.4
git ls-tree -r --name-only HEAD -- docs/experiments/au-ucr-ep-000001/wave-0.5
git ls-files --others --exclude-standard docs/experiments/au-ucr-ep-000001/wave-0.4
git ls-files --others --exclude-standard docs/experiments/au-ucr-ep-000001/wave-0.5
```

```powershell
@'
import hashlib, pathlib
roots = [
  pathlib.Path("docs/experiments/au-ucr-ep-000001/wave-0.4"),
  pathlib.Path("docs/experiments/au-ucr-ep-000001/wave-0.5"),
]
for root in roots:
    paths = sorted((p for p in root.rglob("*") if p.is_file()),
                   key=lambda p: p.as_posix().encode("utf-8"))
    print(root.as_posix(), len(paths))
    for path in paths:
        raw = path.read_bytes()
        lf = raw.replace(b"\r\n", b"\n")
        print(path.as_posix(), len(raw), hashlib.sha256(raw).hexdigest(),
              len(lf), hashlib.sha256(lf).hexdigest())
'@ | python -
```

These checks observe mutable bytes. They do not instantiate any L1-L6 object, create Git objects,
publish a locator or establish acceptance.

## 14. Final disposition

- Normative hierarchy levels: **7** (`L0` through `L6`)
- Required L1 families: **9** (one Wave 0.4; eight Wave 0.5)
- Historical observed Wave 0.4 count: **20**; non-normative until re-enumerated at freeze
- Historical observed Wave 0.5 counts: **44, 47, 77 and 78**; all non-normative
- Normative current/final leaf counts and digests: **UNDETERMINED UNTIL AUTHORIZED FREEZE**
- Open blockers: **10**
- Actual manifests instantiated: **0**
- Commits/publications/acceptances created: **0**
- Historical commit substitutions: **0**

`HIERARCHY SPECIFIED -> MEMBERSHIP NOT FROZEN -> ARTIFACTS UNTRACKED -> COMMIT/PUSH UNAUTHORIZED -> NO PUBLICATION -> NO ACCEPTANCE`
