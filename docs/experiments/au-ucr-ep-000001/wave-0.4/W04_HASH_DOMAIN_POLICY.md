# Wave 0.4 Hash Domain Policy

## 1. Control record

- Experiment: `AU-UCR-EP-000001`
- Wave: `0.4`
- Artifact: `W04_HASH_DOMAIN_POLICY`
- Prepared by: Agent A, documentation/design role only
- Prepared: `2026-10-11`
- Status: `POLICY_DRAFT_NOT_ADOPTED`
- Related findings: `W04_EVIDENCE_INTEGRITY_FINDINGS.md`
- Historical artifacts amended: none
- Authorization effect: none

This is a proposed forward-looking evidence-integrity convention. It does not retroactively change
the meaning of a historical digest, repair an unsupported commit reference, accept evidence, open
a gate, or authorize execution. Adoption requires the existing governed process and roles.

## 2. Purpose

Every recorded digest must state exactly which bytes and identity system it covers. A bare
`sha256` field is insufficient when Git checkout conversion can make raw working-tree bytes differ
from committed bytes.

This policy separates five domains:

1. raw working-tree bytes;
2. explicitly LF-normalized bytes;
3. Git blob object identity;
4. Git index and commit-path bindings; and
5. manifest identity and containment.

These domains are related but are not interchangeable.

## 3. Normative domain identifiers

### 3.1 `raw-working-tree-sha256-v1`

- Input: exact bytes returned by an ordinary binary read of the named working-tree path.
- Transformation: none.
- Algorithm: SHA-256.
- Required metadata:
  - repository stable identifier and local or URI locator;
  - repository-relative path;
  - byte count;
  - SHA-256;
  - capture operating system;
  - capture time in UTC;
  - line-ending counts: CRLF pairs, lone LF, and lone CR;
  - worktree status relative to the index; and
  - tool/command used.
- Meaning: identity of one checkout rendering only.
- Prohibition: must not be called a Git blob hash or used alone as a cross-platform content
  identity.

### 3.2 `crlf-to-lf-sha256-v1`

- Input: exact raw working-tree bytes.
- Transformation: replace every byte pair `0d 0a` with the single byte `0a`.
- No other transformation is allowed: no lone-CR conversion, encoding decode/re-encode, Unicode
  normalization, whitespace trimming, final-newline insertion, JSON parsing, key ordering, or
  pretty printing.
- Algorithm: SHA-256 over transformed bytes.
- Required metadata:
  - all `raw-working-tree-sha256-v1` metadata;
  - normalized byte count;
  - normalized SHA-256;
  - transformation identifier exactly `crlf-to-lf-sha256-v1`; and
  - post-transformation CRLF/lone-LF/lone-CR counts.
- Meaning: a narrowly defined line-ending-normalized content digest.
- Prohibition: equality with a Git blob must be measured and recorded, not assumed.

### 3.3 `git-blob-oid-v1`

- Input: exact Git blob object bytes.
- Identity: `<object-format>:<object-id>`, for example
  `sha1:1646f08d23c4d66f3882f0c34cea0ef2349da6fc`.
- Required metadata:
  - `git rev-parse --show-object-format` result;
  - object type from `git cat-file -t`;
  - object size from `git cat-file -s`;
  - object ID;
  - SHA-256 of bytes emitted by `git cat-file blob <oid>` as an independent content digest; and
  - repository stable identifier.
- Meaning: Git object identity in the repository's declared object format.
- Prohibition: a SHA-1 Git OID must never be labeled SHA-256 merely because a separate SHA-256
  digest is also recorded.

### 3.4 `git-index-path-binding-v1`

- Input: index stage-0 entry for a repository-relative path.
- Required metadata:
  - repository-relative path;
  - index mode;
  - index stage;
  - `git-blob-oid-v1`;
  - index status at capture;
  - capture time; and
  - command result from `git ls-files -s -- <path>`.
- Meaning: the path-to-blob binding currently staged in the index.
- Prohibition: it is not a commit binding.

### 3.5 `git-commit-path-binding-v1`

- Input: exact full commit ID and repository-relative path.
- Required metadata:
  - full commit object ID and object format;
  - successful `git cat-file -t <commit>` result of `commit`;
  - repository-relative path;
  - mode and blob OID from the commit tree;
  - containing tree ID;
  - blob SHA-256;
  - verification time; and
  - ref names, if any, recorded as discoverability metadata rather than identity.
- Meaning: immutable path-to-content binding in one resolvable commit.
- Prohibition: abbreviated IDs, same-prefix commits, branch names, nearby timestamps, or parent/
  child relationships may not substitute for the exact commit ID.

### 3.6 `manifest-entry-sha256-v1`

- Input: bytes in an explicitly declared content domain.
- Required entry fields:
  - repository-relative path;
  - content-domain identifier;
  - algorithm;
  - digest;
  - byte count in that domain;
  - optional Git blob OID, with explicit object format; and
  - media/schema identifier when known.
- Required manifest-level fields:
  - manifest schema/version;
  - repository stable identifier;
  - path root;
  - generation time;
  - generator identity/version;
  - sorted-entry rule;
  - duplicate-path rejection rule;
  - path encoding and separator rule;
  - containing commit/tree binding when available; and
  - manifest's own external digest or signed envelope locator.
- Meaning: declared-domain content inventory.
- Prohibition: a traditional two-column `sha256sum` file must not be presumed to describe raw
  checkout bytes, LF bytes, or Git blobs without an adjacent immutable domain declaration.

## 4. Required multi-domain receipt record

For text evidence stored in Git, a new receipt should record all applicable values:

```json
{
  "path": "repository/relative/path.json",
  "raw_working_tree": {
    "domain": "raw-working-tree-sha256-v1",
    "bytes": 0,
    "sha256": "<64 lowercase hex>",
    "crlf": 0,
    "lone_lf": 0,
    "lone_cr": 0
  },
  "normalized": {
    "domain": "crlf-to-lf-sha256-v1",
    "bytes": 0,
    "sha256": "<64 lowercase hex>"
  },
  "index": {
    "domain": "git-index-path-binding-v1",
    "mode": "100644",
    "stage": 0,
    "object_format": "sha1",
    "blob_oid": "<40 lowercase hex>"
  },
  "commit": {
    "domain": "git-commit-path-binding-v1",
    "commit_oid": "<full commit oid>",
    "tree_oid": "<full tree oid>",
    "blob_oid": "<full blob oid>",
    "blob_bytes": 0,
    "blob_sha256": "<64 lowercase hex>"
  }
}
```

Zero placeholders in this example are schema illustrations only. A produced evidence record must
contain measured values or an explicit `unknown`, `blocked`, `not_applicable`, or `not_run` state;
it must not convert unavailable data to zero.

## 5. Commit-reference classification

Every commit-bound receipt must be checked against the exact full object ID. It must receive one
of these classifications:

### `RESOLVABLE`

The exact object exists, `git cat-file -t` returns `commit`, and the required path/tree facts can be
inspected. Record the exact object, tree, parents, and relevant path binding.

### `HISTORICALLY_VALID_BUT_UNAVAILABLE`

The exact object is unavailable in the inspected repository, but independent immutable evidence
establishes that exact identity as a valid historical commit. Acceptable support must identify the
same full object ID and enough provenance to distinguish it from transcription or prefix error,
for example a signed transparency record or an independently archived, verifiable commit object.
Merely repeating the ID in the receipt under review is not independent support.

### `UNSUPPORTED`

The exact object is unavailable and independent evidence does not establish its historical
validity. A syntactically valid hash, a similar prefix, an adjacent commit, a matching subject, or
an inferred typo is insufficient.

For every classification:

- never substitute another commit;
- report similarly prefixed or adjacent commits only as distinct comparison objects;
- preserve the original receipt unchanged;
- add any correction as a new append-only artifact;
- state whether claims are limited to present-byte integrity; and
- do not infer acceptance, authority, or execution release.

Applied to the inspected deterministic-readiness receipt, the exact
`2ea38d86a19697b80a827d2dfd83a9219e145532` reference is `UNSUPPORTED`. The distinct local
`2ea38d86acaf8e744ea6bc7c282a4bbeb2ca573d` commit is not a substitute.

## 6. Repository line-ending policy

A repository that intends LF Git content and platform-dependent checkout rendering should add an
applicable, separately reviewed `.gitattributes` policy. A candidate rule may use explicit text and
EOL attributes for the governed evidence namespace, but this document does not modify
`.gitattributes` and does not select or adopt a rule.

Before adoption, reviewers must assess:

- whether existing evidence contains intentional CRLF or binary data;
- renormalization effects and the requirement not to rewrite historical evidence;
- whether attributes apply only prospectively;
- compatibility with Windows and Linux verification commands; and
- whether raw-checkout evidence remains necessary.

Adding `.gitattributes` later does not change old blob bytes or retroactively redefine old manifest
entries. Historical domain interpretation must remain attached to evidence from the applicable
revision.

## 7. Manifest generation and verification procedure

For a new manifest:

1. Freeze the intended repository revision without changing refs.
2. Inventory paths and reject duplicates, missing paths, traversal components, absolute paths, and
   ambiguous separators.
3. State the selected content domain per entry.
4. Read bytes in binary mode and record byte count plus SHA-256.
5. For Git domains, obtain the exact object format, blob OID, commit OID, tree OID, and blob bytes.
6. Compare raw, normalized, index, and commit bytes explicitly; record equality or difference.
7. Parse receipt dependencies, require every target, and reject cycles.
8. Verify every commit reference using the classification in Section 5.
9. Serialize entries deterministically under the manifest schema.
10. Bind the manifest through an external digest, signed envelope, or containing commit; a manifest
    cannot safely embed an ordinary digest of its own final bytes.
11. Preserve the prior manifest and receipts unchanged.
12. Record failures and unavailable values; do not suppress them or convert them to passes.

## 8. Reproducible non-destructive reference commands

```powershell
# Repository and object domains
git rev-parse --show-object-format
git ls-files -s -- <path>
git rev-parse HEAD:<path>
git cat-file -t <object-id>
git cat-file -s <object-id>
git ls-tree HEAD -- <path>

# Attributes and configuration
git check-attr --all -- <path>
git config --show-origin --get core.autocrlf
git config --show-origin --get core.eol
git config --show-origin --get core.safecrlf

# Exact commit resolution and discoverability
git cat-file -t <full-commit-id>
git show -s --format=fuller <full-commit-id>
git show-ref
git rev-list --all --objects
git reflog show --all
git fsck --full --no-reflogs --unreachable --no-progress
```

Reference binary hashing:

```powershell
@'
import hashlib, pathlib, subprocess
p = pathlib.Path("<path>")
raw = p.read_bytes()
lf = raw.replace(b"\r\n", b"\n")
rel = p.as_posix()
idx = subprocess.check_output(["git", "rev-parse", ":" + rel], text=True).strip()
head = subprocess.check_output(["git", "rev-parse", "HEAD:" + rel], text=True).strip()
ib = subprocess.check_output(["git", "cat-file", "blob", idx])
hb = subprocess.check_output(["git", "cat-file", "blob", head])
print("raw", len(raw), hashlib.sha256(raw).hexdigest())
print("lf", len(lf), hashlib.sha256(lf).hexdigest())
print("index", idx, len(ib), hashlib.sha256(ib).hexdigest())
print("head", head, len(hb), hashlib.sha256(hb).hexdigest())
print("index_equals_head", ib == hb)
'@ | python -
```

These commands inspect; they do not establish that any historical command ran.

## 9. Outstanding policy risks

- This draft is not governed adoption and has no enforcement mechanism.
- Repository identity and signing profiles still require an approved authority model.
- A future `.gitattributes` decision can cause large apparent working-tree changes and must not be
  used to rewrite historical receipts.
- SHA-1 remains the current Git object format; SHA-256 content digests mitigate content-identity
  ambiguity but do not change Git's object format.
- Acyclic dependency verification needs a versioned implementation and independent review before
  it can become a gate control.
- Manifest signatures, key custody, revocation, timestamping, transparency, and long-term archival
  remain unspecified.
- Unsupported historical commit references require append-only provenance treatment; domain policy
  alone cannot repair them.

## 10. Holds and non-claims

- S1 remains `closed_pending_explicit_acceptance`.
- G1 remains `PENDING`; G2 remains `PENDING`.
- G3 remains `CLOSED`; G4 remains `NOT AUTHORIZED`.
- A09 remains `NO_DECISION_NO_TRANSITION`.
- This policy records no acceptance, certification, assignment, publication, execution release,
  transition, merge authorization, or permission to run runtime controls.
