# GP-R2 Proposal Validation

## Result

`PASS_FOR_REVIEW_ONLY`

This result means the proposal is reproducible and internally consistent. It does not mean adopted,
accepted, preserved, or approved for Gate P.

## Inputs

- Repository commit: `01b5e02a84fe260558c4ae66d03df91bb7f66c20`
- Historical manifest:
  `docs/experiments/au-ucr-ep-000001/wave-0.6/technical/W06_TECHNICAL_FREEZE_MANIFEST.json`
- Generator: `artifacts/plans/generate_r2_manifest_proposal.py`
- Generated proposal:
  `artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json`
- Governance proposal: `artifacts/plans/GP-R2-GOVERNANCE-PROPOSAL.md`

## Observed results

- Proposal status: `PROPOSED_NOT_ADOPTED`
- Member count: 54
- Unique case-folded paths: 54
- Missing or non-blob members: 0
- Proposed aggregate:
  `defad8411df0b6e63b14c71345346976d4ea8c9e2e372d126126b9a0fca7ea8d`
- Entries where the historical v1.0.0 digest equals both the Git blob and normalized digest: 3
- Entries where the historical v1.0.0 digest equals neither: 51
- Deterministic regeneration: pass; the repository output and independently regenerated temporary
  output have identical file hashes.
- Internal challenge review: pass; all 54 entries and the aggregate were independently recomputed.
  This is internal assurance, not formal acceptance by an authenticated reviewer.
- Python syntax compilation: pass.
- Diff whitespace validation: pass.
- Governed evidence or manifest modifications: none.

The 51/3 relationship reproduces the known mixed-domain condition: 51 historical entries identify
CRLF working-tree bytes, while three identify LF bytes. The proposed Git-blob and normalized domains
do not reinterpret those historical values.

## Reproduction

```powershell
python artifacts/plans/generate_r2_manifest_proposal.py

$tmp = Join-Path $env:TEMP 'W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json'
python artifacts/plans/generate_r2_manifest_proposal.py --output $tmp
Get-FileHash artifacts/plans/W06_TECHNICAL_FREEZE_MANIFEST_v1.1.0_PROPOSAL.json
Get-FileHash $tmp
```

The two output hashes must match. A reviewer must additionally recompute the aggregate framing and
sample Git blobs independently rather than trusting this generator alone.

## Controls confirmed

- The source v1.0.0 manifest remains unchanged.
- The proposal retains all historical member values.
- The proposed portable identity is bound to an exact commit and tree.
- The generator reads committed blobs, not platform-rendered working-tree bytes.
- The proposal has no signatures, adoption date, acceptance, or preservation receipt.
- The rollback model is append-only and retains both old and proposed records.

## Open blockers

- The proposed commit has not been designated as the authoritative preservation candidate.
- The proposed `.gitattributes` scope has not received a complete binary inventory or governance
  approval.
- Manifest v1.1.0 has not been independently accepted.
- No authenticated supersession decision exists.
- Gate P and FOR-ACT authority remain unresolved.
- Candidate-specific immutable custody remains unresolved.

## Classification

R2 proposal preparation is complete. R2 adoption is pending governance and independent review.
Gate P remains `BLOCKED_BY_EVIDENCE`.
