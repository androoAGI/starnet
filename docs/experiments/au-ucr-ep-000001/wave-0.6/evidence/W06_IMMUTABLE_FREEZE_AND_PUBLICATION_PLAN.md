# Wave 0.6 Immutable Freeze and Publication Plan

## Control record

- Experiment: `AU-UCR-EP-000001`
- Prepared: `2026-10-12`
- Status: `PLAN_ONLY_FREEZE_AND_PUBLICATION_UNAUTHORIZED`
- Mutating action performed: none
- Publication claim: none

This plan reconciles Wave 0.3-0.5 publication requirements. It does not freeze, stage, commit,
push, sign, publish, merge, accept or release anything.

## Preconditions

The process must not begin until all of the following exist:

1. explicit freeze, stage and commit authority for the exact repository and candidate scope;
2. effective Publication Custodian identity, mandate, acknowledgement and separation evidence;
3. approved manifest schema, canonicalization profile, path policy and hash-domain policy;
4. declared source and review cutoffs with authorized inclusion/exclusion rules;
5. a mechanism that prevents concurrent writes or fails the freeze;
6. explicit push/publication/signing authority and stable repository namespace identity; and
7. assigned QA, Independent Reviewer, findings-closure and Decision Chair roles.

None of these preconditions is satisfied by this Wave 0.6 documentation.

## Technical freeze is not publication freeze

`wave-0.6/technical/W06_TECHNICAL_FREEZE_MANIFEST.json` now provides a local exact-byte technical
freeze for 54 normative files, and final verification found all 54 sizes and SHA-256 values
matching. This closes a technical inventory/checking gap only.

The technical manifest and its 55-file local directory remain untracked, mutable working-tree
content. The manifest deliberately carries `EXTERNAL_BY_DESIGN` rather than a self hash. It has no
Git blob/tree/commit binding, authorized publisher, signature, remote immutable locator,
independent retrieval, publication receipt or adoption decision. It must therefore be consumed as
an input to—not a substitute for—the authorized L0-L5 freeze and publication procedure below.

## Freeze scope

An authorized freeze must recursively enumerate, rather than consume an embedded count:

- all in-scope Wave 0.3 historical design/gate records if carried into the candidate;
- every Wave 0.4 artifact at cutoff;
- every Wave 0.5 control, schema, fixture, vector, contract, registry, authority, provenance,
  reconciliation, review, amendment, tracker and gate record at cutoff;
- applicable QA evidence only through explicit historical-reference records; and
- Wave 0.6 evidence and any later closure/review outputs assigned to the appropriate source or
  review layer.

Every path must occur exactly once. Reject absolute paths, backslashes in canonical manifest
paths, `.`/`..`, aliases, duplicate stable IDs, duplicate normalized paths, case collisions,
symlink/reparse ambiguity, missing files and silent exclusions.

Current observations—9 Wave 0.3, 20 Wave 0.4 and 88 Wave 0.5 files—are not expected freeze
cardinalities. A later addition or byte change requires a new candidate sequence or review
overlay.

## Required identity domains

Every leaf must record separately:

1. `raw-working-tree-sha256-v1`: exact checkout bytes, byte count, line-ending counts, capture
   platform/time and worktree state;
2. `crlf-to-lf-sha256-v1`: only CRLF-pair replacement, transformed byte count and SHA-256;
3. `git-blob-oid-v1`: object format, full blob OID, object size and independent blob SHA-256;
4. `git-index-path-binding-v1`: mode, stage and blob OID;
5. `git-commit-path-binding-v1`: canonical repository, full commit/tree, path, mode and blob OID;
6. canonical manifest bytes and external SHA-256; and
7. immutable publication locator and publication-receipt identity.

Equality among domains must be measured, not inferred. A Git SHA-1 OID must never be labeled a
SHA-256 digest. A branch, PR, tag, filename, URN or local path is discoverability metadata only.

## Non-circular hierarchy

Use the Wave 0.5 nested model:

- L0: leaf identities;
- L1: purpose-specific family manifests;
- L2: wave/source/review manifests;
- L3: reviewed source-candidate root;
- L4: decision-package root binding L3 plus review and closure evidence;
- L5: publication envelope/receipt; and
- L6: QA, independent review, findings closure and Decision Chair receipt chain.

QA and review target L3. Their own outputs appear later in L4. A review must not claim to review
itself or post-review corrections. Amendment and revocation receipts require external immutable
binding and must not exist only inside the object they amend.

## Authorized execution sequence

When authority exists:

1. declare repository identity, candidate sequence, roots, cutoff and exclusions;
2. stop concurrent mutation or fail;
3. enumerate and classify every leaf deterministically;
4. independently measure raw/LF identities;
5. generate L0-L4 proposed records without self-digests;
6. stage only authorized paths and verify index/blob equality;
7. create content commit A;
8. regenerate commit/tree/path bindings against A;
9. finalize canonical manifests in manifest commit B or an external signed envelope;
10. independently reproduce leaf, family, wave and root identities;
11. prove source bytes did not change during finalization;
12. push all required objects only under publication authority;
13. retrieve and remeasure every required object from the publication service;
14. issue L5 only after complete remote resolution;
15. perform candidate-bound QA and independent review against L3;
16. append findings/dependency closure and bind review evidence at L4/L6;
17. obtain a Decision Chair decision for the exact L4/L5 candidate; and
18. if accepted, seek a later separate exact-run G4 release.

## Publication failure and recovery

Publication is atomic at L5. If any child, object, signature, locator or remeasurement fails:

- issue no success receipt;
- mark the attempted root `PUBLICATION_FAILED_QUARANTINED`;
- preserve transferred objects and exact failure evidence;
- keep any prior accepted candidate authoritative;
- prohibit QA, acceptance and release against the partial root; and
- retry only through an authorized new sequence or resumable attempt that revalidates the whole
  root.

No subset, branch push or valid child implies successful parent publication.

## Historical evidence treatment

- Do not edit, renormalize or replace prior-wave or QA evidence.
- Carry the exact unsupported commit reference and its `UNSUPPORTED` classification.
- Carry both raw and LF interpretations of the PRE_A09 manifest without redefining the historical
  file.
- Preserve old vector counts as historical snapshots and bind the explicit supersession chain.
- Preserve the removed circular-receipt history as lineage; verify only that the current graph is
  acyclic.

## Plan exit criteria

The publication plan is complete only when all exact objects, manifests and receipts are remotely
resolvable and independently remeasured. Publication does not equal acceptance. Acceptance does
not equal execution release.

Current result:

`PLAN RECONCILED -> FREEZE UNAUTHORIZED -> 108 PRIOR-WAVE FILES UNTRACKED -> NO GIT CANDIDATE -> NO PUBLICATION -> NO ACCEPTANCE`

