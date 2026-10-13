# GP-R2 Formal Independent Review Packet

## Purpose

This packet gives an authenticated Independent Reviewer a reproducible procedure for accepting,
revising, or blocking the R2 manifest proposal. It does not appoint the reviewer, authenticate an
identity, record acceptance, adopt the proposal, or approve Gate P.

## Exact review objects

- Original R2 proposal commit: `fee376a30deb86698ea4d22bc4ab32e72e2fe713`
- Original R2 proposal tree: `c5d141af4e1065a09d7cdf0cca2419648726b2be`
- Corrected review-packet commit and tree: supplied with the committed handoff and required in the
  exported review receipt; they cannot be embedded in the commit they identify.
- Candidate content commit: `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Candidate content tree: `dca22c304034f1662db99230a29d3ccc3ca38889`
- Proposed 54-file aggregate:
  `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`

Original committed artifact identities at `fee376a30...`:

- Governance proposal:
  - path: `artifacts/plans/GP-R2-GOVERNANCE-PROPOSAL.md`
  - Git blob: `sha1:3c2f953bb7311e7f47f09f790d211c98a99678d1`
  - blob SHA-256: `370128d65a77c55eb8418da9728f6dd85de60f7a4b353a069c1453e52fafadea`
- Manifest proposal:
  - path: `artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json`
  - Git blob: `sha1:49adf221150fb18cd8a600be8a10e445b3f5c64a`
  - blob SHA-256: `3613f878189ebc34e73dcdee390dc5ac33f188f2c72a3c60725ab955c906b4d0`
- Generator:
  - path: `artifacts/plans/generate_r2_manifest_proposal.py`
  - Git blob: `sha1:416a8b2dfe3b8e3cd7339d4c63fbfd8f1ec882ea`
  - blob SHA-256: `1326dc4791a5a3b6bc121eea7113a86f6b7d8a3960ff7c7cc6f83fc042ae9d2a`
  - disposition: `SUPERSEDED_BY_UNCOMMITTED_PATH_VALIDATION_CORRECTION`
- Validation report:
  - path: `artifacts/reports/GP-R2-PROPOSAL-VALIDATION.md`
  - Git blob: `sha1:c464ec86ef97d0881a93e6e8822c5b7ca5db607d`
  - blob SHA-256: `654f120042c94065fbcaea406b49d7068021e2bbf4c91685c3f249f76d154f37`

The reviewer must not begin formal review until the corrected generator, this protocol, the
instrument, and the challenge addendum are committed together. The handoff must supply that full
commit and tree, and the exported receipt must bind both. The reviewer must inspect committed blob
bytes, not assume local checkout bytes are identical.

## Reviewer prerequisites

The reviewer must provide:

1. stable identity identifier and identity issuer;
2. authenticated appointment to the `INDEPENDENT_REVIEWER` role for `AU-UCR-EP-000001`;
3. declared conflicts and prior methodological participation;
4. signing-key identifier and key purpose;
5. verification time from an authenticated time source;
6. evidence that the reviewer did not author or modify the R1/R2 implementation under review.

An AI agent or same-workspace challenge may assist but cannot satisfy these human authentication
requirements.

## Required independent procedure

Use a fresh clone or isolated worktree at the corrected review-packet commit recorded above.

1. Confirm the corrected full packet commit and tree resolve exactly.
2. Recompute each committed artifact blob OID and SHA-256 listed above.
3. Inspect the historical v1.0.0 manifest directly from candidate commit `01b5e02a...`.
4. Independently enumerate the 54 historical paths; reject missing, extra, duplicate, absolute,
   drive-qualified, dot-component, traversal, CR/LF/NUL, or non-blob paths.
5. For every member, independently obtain the candidate Git blob and recompute:
   - object format and OID;
   - blob byte count and SHA-256;
   - CRLF-to-LF byte count and SHA-256;
   - line-ending counts;
   - relationships to the preserved v1.0.0 values.
6. Recompute the aggregate without invoking `generate_r2_manifest_proposal.py`.
7. Confirm the aggregate equals
   `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`.
8. Run the supplied generator separately and compare its complete JSON output with the committed
   manifest proposal.
9. Review the proposed `.gitattributes` scope, complete the binary inventory, and perform the
   renormalization preview in an isolated worktree.
10. Confirm no procedure rewrites the historical v1.0.0 manifest or historical failure records.
11. Review the append-only supersession and rollback terms.
12. Record every exception, even if it does not change the final outcome.

## Outcome rules

- `REVIEW_PASS`: all member identities and the aggregate reproduce; the policy and rollback terms
  are complete for consideration; limitations are disclosed.
- `REVIEW_REVISE`: a correctable proposal, generator, policy, or documentation defect remains.
- `REVIEW_BLOCKED`: identity, membership, provenance, reviewer authority, or required primary
  evidence cannot be established.

`REVIEW_PASS` permits the proposal to proceed to an authorized adoption decision. It does not itself
adopt the proposal, supersede v1.0.0, authorize preservation, or approve Gate P.

## Required signed output

Complete:
`artifacts/reports/GP-R2-INDEPENDENT-REVIEW-INSTRUMENT-UNSIGNED.md`

The signed record must bind:

- reviewer identity and mandate;
- packet commit and tree;
- candidate commit;
- artifact blob identities;
- independently observed aggregate;
- findings, objections, and limitations;
- outcome and reason codes;
- signature, signing-key identifier, and authenticated time;
- statement that Gate P remains unchanged unless separately decided.

## Current state

Internal challenge review: `PASS`.

Formal authenticated independent review: `PENDING`.

Gate P: `BLOCKED_BY_EVIDENCE`.
