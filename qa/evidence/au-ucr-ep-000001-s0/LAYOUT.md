# Evidence layout for AU-UCR-EP-000001 Sprint S0

Namespace: `qa/evidence/au-ucr-ep-000001-s0/`.

| Directory | Contents |
| --- | --- |
| `baseline/` | Git identity, manifest counts, authority-module inventory, route/gate inventory, flag search, lane materialization |
| `receipts/` | Gate command logs and receipt JSON tied to the commit tested |
| `adversarial/` | Reserved for adversarial logs. Empty in S0. |
| `reconciliation/` | Reserved for reconciliation outputs. Empty in S0. |

Naming: `<experiment>-<sprint>-<work_item>-<artifact_kind>-<seq>.<ext>`.

Example: `au-ucr-ep-000001-s0-s0-001-gate-receipt-01.json`.

Required receipt fields are defined in `docs/experiments/au-ucr-ep-000001/S0_RECEIPT_SCHEMA.json`: experiment, sprint, work item, owner lane, branch, commit tested, gate set, outcome, reviewer, review outcome, and UTC timestamp.

Historical notes in `S0_BASELINE_AND_GATES.md` cite `/opt/cursor/artifacts/`. Those paths are outside this worktree. This capture stores its own logs under `receipts/`.

A new commit that changes runtime behavior invalidates prior commit-bound gate receipts until the gates are rerun. Failures stay in the directory. Missing data is recorded as `unknown`, `blocked`, or `not_run`.
