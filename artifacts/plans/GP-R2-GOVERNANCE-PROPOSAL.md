# Gate P R2 Portability and Manifest Proposal

## Control record

- Project: `Agent University / StarNet`
- Experiment: `AU-UCR-EP-000001`
- Workstream: `GP-R2`
- Status: `PROPOSED_NOT_ADOPTED`
- Authorization effect: `NONE`
- Gate P effect: `NO_CHANGE — BLOCKED_BY_EVIDENCE`
- Proposal baseline: commit `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Historical records modified: none

This packet proposes a portable successor to the Wave 0.6 technical manifest and a prospective
line-ending policy. It does not supersede the original manifest, adopt `.gitattributes`, authorize
preservation, accept work, or approve Gate P.

## Problem being addressed

`W06_TECHNICAL_FREEZE_MANIFEST.json` version 1.0.0 declares
`raw-working-tree-sha256-v1`. Its 54 entries describe a mixed working-tree byte population:
51 entries correspond to CRLF-rendered text and three correspond to LF bytes written directly by
generators. A fresh CRLF checkout therefore disagrees with three entries, while a fresh LF checkout
disagrees with 51. The manifest can identify its historical checkout but is not a portable
cross-platform identity by itself.

R1 repaired the verifier and CRLF-sensitive tests. R2 must preserve the historical v1.0.0 record
while proposing a platform-independent identity for the same 54 paths.

## Proposed manifest v1.1.0

Machine-readable proposal:
`artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json`

Reproducible generator:
`artifacts/plans/generate_r2_manifest_proposal.py`

The proposal:

- preserves every v1.0.0 path, byte count, digest, and declared historical domain;
- binds each path to an exact Git blob at the proposal commit;
- records the Git object format, blob OID, blob byte count, and independent blob SHA-256;
- records a `crlf-to-lf-sha256-v1` digest without decoding, re-encoding, or other normalization;
- records line-ending counts and explicit equality relationships;
- rejects missing paths, traversal, duplicate normalized paths, and non-blob objects;
- uses deterministic case-folded path ordering and explicit NUL/LF framing;
- declares itself `PROPOSED_NOT_ADOPTED`;
- grants no adoption, acceptance, preservation, publication, or Gate P effect.

The proposed aggregate digest is only the root of this proposal. It is not a replacement historical
root until the proposal is reviewed, regenerated at an approved candidate commit, independently
verified, and adopted by authorized governance.

## Proposed prospective `.gitattributes` policy

Do not add this policy to the repository until the binary inventory, renormalization preview, and
governance review are complete.

```gitattributes
# Prospective evidence text policy — proposal only.
docs/experiments/au-ucr-ep-000001/** text eol=lf
qa/evidence/au-ucr-ep-000001-s0/** text eol=lf

# Binary exclusions must be complete before adoption.
docs/experiments/au-ucr-ep-000001/**/*.png -text
docs/experiments/au-ucr-ep-000001/**/*.jpg -text
docs/experiments/au-ucr-ep-000001/**/*.jpeg -text
docs/experiments/au-ucr-ep-000001/**/*.gif -text
docs/experiments/au-ucr-ep-000001/**/*.webp -text
docs/experiments/au-ucr-ep-000001/**/*.pdf -text
docs/experiments/au-ucr-ep-000001/**/*.zip -text
```

Before adoption, run `git check-attr --all` for every candidate path and inspect an isolated-worktree
preview with:

```powershell
git add --renormalize --dry-run -- `
  docs/experiments/au-ucr-ep-000001 `
  qa/evidence/au-ucr-ep-000001-s0
```

Any content change to an existing historical evidence blob blocks direct adoption. The policy is
prospective; it cannot retroactively redefine v1.0.0.

## Adoption prerequisites

1. Select the exact candidate commit and prove the complete 54-file membership.
2. Review all files under the proposed attribute scopes and complete binary exclusions.
3. Reproduce the proposed manifest on Windows CRLF, Windows/Linux LF, and an independent checkout.
4. Require identical Git-blob and normalized roots across those environments.
5. Independently sample member blobs and recompute the full aggregate framing.
6. Approve the schema, generator version, path rules, and aggregate serialization.
7. Create an authenticated supersession decision naming:
   - old artifact and digest;
   - new artifact and digest;
   - reason;
   - authorized actor and role;
   - decision time;
   - rollback path.
8. Preserve v1.0.0 unchanged and retain its original interpretation.
9. Record an independent review receipt.
10. Keep Gate P blocked until candidate identity, FOR-ACT authority, custody, and acceptance are
    separately resolved.

## Proposed supersession record

If adopted later, the new record must state:

- `supersedes`: `W06_TECHNICAL_FREEZE_MANIFEST.json` version 1.0.0;
- `supersedes_digest`: the exact approved external digest and domain of the old artifact;
- `reason`: replace platform-specific working-tree identity as the controlling portable identity;
- `historical_effect`: none; v1.0.0 remains immutable and valid only in its declared domain;
- `effective_scope`: the same 54 technical paths at the approved commit;
- `authority`: authenticated adopting authority;
- `independent_review`: authenticated review receipt;
- `rollback`: invalidate or supersede v1.1.0 without deleting either version.

The current proposal intentionally omits signatures, acceptance, and effective dates because none
has been supplied.

## Rollback

If this proposal, generator, path set, domain definition, or aggregate is invalidated:

1. retain the v1.0.0 manifest and this proposal unchanged;
2. mark this proposal `INVALIDATED` or `SUPERSEDED` through a new append-only record;
3. identify the old and new references, reason, authorized actor, and evidence;
4. restore v1.0.0 as the only historical manifest interpretation;
5. reopen every dependent Scrum item and Gate P finding;
6. do not delete or rewrite any manifest, failure, or review record.

## Human decisions still required

- Whether to adopt an LF checkout policy and its exact scope.
- Which commit is the authoritative candidate binding.
- Whether manifest v1.1.0 is accepted as the controlling portable identity.
- Who is authenticated to adopt the supersession.
- Who performs formal independent review.
- Which immutable destination and custody controls apply.

Until those decisions and evidence exist, this packet remains a proposal and Gate P remains blocked.
