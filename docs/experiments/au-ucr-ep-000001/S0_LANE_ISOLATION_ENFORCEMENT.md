# Sprint S0 lane isolation enforcement

Registry of record: `S0_WORKTREE_LANE_REGISTER.yaml` on canonical Sprint 0 commit `cdc793ba738c688ef2493fcd196043bfb3fddd77`. This file does not replace that registry and does not assign any lane.

## Registered lanes

| Role | Branch | Owner |
| --- | --- | --- |
| Coordinator/Architect | `cursor/ucr-coordination-3141` | `unassigned_role_only` |
| Contract Agent | `cursor/ucr-001-contract-3141` | `unassigned_role_only` |
| Runtime Agent | `cursor/ucr-runtime-3141` | `unassigned_role_only` |
| Security/Governance Agent | `cursor/ucr-governance-3141` | `unassigned_role_only` |
| Campus/UI Agent | `cursor/ucr-campus-3141` | `unassigned_role_only` |
| QA/Evidence Agent | `cursor/ucr-qa-evidence-3141` | `unassigned_role_only` |

## Enforcement in this worktree

- The live worktree is `cursor/ucr-s0-execution-3141`. It prepares Sprint 0 evidence. It is not `feat/harness-backend`.
- Lane branches stay absent until an assignment register contains the fields required by `AU-UCR-GOV-001` (stable identity, assignment authority, acknowledgement, independence declaration).
- `unassigned_role_only` authorizes no lane action.
- One lane occupies one worktree once a lane is materialized.
- University feature edits stay off the integration branch. This readiness package adds evidence and contracts only.
- `scripts/qa/au-ucr-s0-readiness.mjs check` fails when a registered lane branch exists without that assignment register, when an owner field changes, or when the current branch is an integration branch.

Observed materialization is recorded at `qa/evidence/au-ucr-ep-000001-s0/baseline/lane-materialization.json`.
