# Sprint S0 rubric approval workflow

Dimensions stay pending. Thresholds stay unset. This workflow does not freeze the rubric.

## Pending dimensions

- `intent_preservation`
- `traceability`
- `lineage`
- `dependency_integrity`
- `implementation_completeness`
- `governance_preservation`

## Approval path

1. An assigned Independent Reviewer proposes a definition and a threshold for one dimension.
2. The proposal records the dimension name, the threshold, the interpretation constraint, and the commit under review.
3. Blank scores stay `pending` or `unknown`. They stay unset. A blank is never stored as `0` and never stored as a pass.
4. A threshold pass is a measurement. Acceptance is a separate Decision Chair outcome: `ACCEPTED`, `REVISE`, or `REJECTED`.
5. `Done` on a work item stays distinct from `Accepted`.
6. The Decision Chair records the freeze decision. Until that record exists, `frozen` stays false and every threshold stays null.

## Freeze record

| Field | Value |
| --- | --- |
| Reviewer | unset |
| Date (UTC) | unset |
| frozen | false |
| Approved definitions | none |
| Approved thresholds | none |

`scripts/qa/au-ucr-s0-readiness.mjs check` rejects this file when a freeze flag is set or a numeric zero threshold is written into it.
