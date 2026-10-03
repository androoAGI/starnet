# Sprint 0 evidence conventions

## Evidence namespace

- Primary experiment namespace: `qa/evidence/au-ucr-ep-000001-s0/`
- External raw runtime logs for this execution: `/opt/cursor/artifacts/`

## Naming convention

Use:

`<experiment>-<sprint>-<work_item>-<artifact_kind>-<timestamp_or_seq>.<ext>`

Examples:

- `au-ucr-ep-000001-s0-s0-001-gate-receipt-01.md`
- `au-ucr-ep-000001-s0-ucr-001-contract-diff-01.json`

## Required receipt metadata

Every receipt must include:

- `experiment_id`
- `sprint_id`
- `work_item_id`
- `owner_lane`
- `branch`
- `commit_tested`
- `gate_set` (for example `test:fast`, `test:http`)
- `outcome` (`pass`, `fail`, `blocked`)
- `reviewer`
- `review_outcome`
- `created_at_utc`

## Evidence integrity rules

- Evidence is append-only for historical records.
- A new commit invalidates prior commit-bound receipts for affected gates until rerun.
- Failures are valid evidence and must be retained.
- Any redacted or unavailable datum must be explicit (`unknown`, `blocked`, or `not_run`), never converted to zero.

## Storage split

- In-repo evidence index and summaries: `qa/evidence/au-ucr-ep-000001-s0/`
- Large ephemeral shell/test logs: `/opt/cursor/artifacts/`
- Review documents and execution contracts: `docs/experiments/au-ucr-ep-000001/`
