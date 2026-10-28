# AU-UCR-S0-IDENTITY-001 assignment requests

**REQUEST_ONLY_NOT_AUTHORIZATION**

This document requests governed role assignments. It does not assign roles, grant authority, or authorize execution, publication, acceptance, or handoff.

- Work request: `AU-UCR-S0-IDENTITY-001`
- Experiment: `AU-UCR-EP-000001`
- Governed worktree: `/workspace/starnet-ucr-s0-local-001`
- Branch: `cursor/ucr-s0-local-001-3141`
- Frozen HEAD: `07d9ab53cecdec9a68efd7d25edadeb10db71538`
- Entry disposition from frozen local package: `BLOCKED_IDENTITY`
- Policy source: `docs/experiments/au-ucr-ep-000001/AU_UCR_GOV_001_RACI_RELEASE_AUTHORITY_ADDENDUM.md`
- Lane register (informational only; not assignment): `docs/experiments/au-ucr-ep-000001/S0_WORKTREE_LANE_REGISTER.yaml`

## Requested assignments

| Role | Input gate | Current authoritative status | Request |
| --- | --- | --- | --- |
| Coordinator/Architect | identity assignment | `MISSING_REQUIRED_RECORD` (`qa/evidence/au-ucr-ep-000001-local/actor-assignment-state.json` / frozen `EV-L08`) | Publish a complete assignment register entry with all nine required fields per the GOV-001 addendum |
| QA/Evidence Agent | identity assignment | `MISSING_REQUIRED_RECORD` | Same |
| Independent Reviewer | identity assignment | `MISSING_REQUIRED_RECORD` | Same |
| Decision Chair | identity assignment | `MISSING_REQUIRED_RECORD` | Same |

## Required fields per assignee (GOV-001 addendum)

1. experiment ID and work-item or release scope
2. role name
3. assignee name and stable identity
4. organization and implementation lane, if any
5. assignment authority and assignment timestamp (UTC)
6. effective-from and, when ended, effective-through timestamps
7. explicit duties and limits
8. independence and conflict-of-interest declaration
9. acknowledgement by the assignee

## Explicit non-actions

- Cursor Cloud Agent technical execution is **not** a governed role assignment.
- `unassigned_role_only` in the lane register does **not** satisfy assignment requirements.
- No inference from Git commit authorship, PR metadata, branch names, or Cursor session identity.

Captured at: `2026-10-03T18:05:00Z` (approximate execution time)
