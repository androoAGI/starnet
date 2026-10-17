# AU-UCR-S0-PUBLICATION-RECOVERY-001 — external evidence receipt

## Receipt identity

- Work item: `AU-UCR-S0-PUBLICATION-RECOVERY-001`
- Scope: **publication-only** (no identity, review, acceptance, or execution advancement)
- Captured at: `2026-10-03T18:24:00Z`
- Repository: `mrrobot787/starnet` (`/workspace/starnet`)
- Recovery worktree (read-only checks): `/workspace/starnet-ucr-s0-recovery-001`
- Local branch: `cursor/ucr-s0-recovery-3141`
- Required local recovery commit: `887b1d9586b005606e1d8985e6c47c70a4a2900e`
- Canonical thin bundle: `/opt/cursor/artifacts/au-ucr-s0-recovery-001-canonical-thin.bundle`
- Expected bundle SHA-256: `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07`
- Canonical S0 candidate: `cdc793ba738c688ef2493fcd196043bfb3fddd77`
- Canonical GOV candidate: `3f2dd71db76ddc89ff2dabad391665f4a381698c`
- Integration target: `origin/feat/harness-backend` = `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3`
- Verification log: `/opt/cursor/artifacts/au-ucr-s0-publication-recovery-001-verification.log`
- **Terminal status:** `BLOCKED_PUBLICATION_AUTHORITY`
- **Next active gate (not entered):** `BLOCKED_IDENTITY`

## Fail-closed rules

Immutable git objects, bundle digest, and freshly fetched `origin` refs were used for verification.
No repository file or history edits were made. Provisional identity outputs were not modified.
Remote branch `cursor/ucr-s0-recovery-3141` was absent after refresh; exactly one normal
`git push -u origin cursor/ucr-s0-recovery-3141` was attempted. HTTP 403 does not constitute a
publication receipt. `RECOVERY_EVIDENCE_PUBLISHED` was **not** entered. Identity-gated evidence
remains `NOT_PRODUCED`.

## Evidence index (`EV-PUB-00`..`EV-PUB-11` only)

| Evidence | Exact meaning | Status / result |
| --- | --- | --- |
| `EV-PUB-00` | preflight | `PASS` — required constants, paths, and bundle artifact present |
| `EV-PUB-01` | isolation | `PASS` — StarNet at `/workspace/starnet` → `mrrobot787/starnet`; recovery worktree linked to same gitdir; AML `/workspace` is separate `mrrobot787/aml` |
| `EV-PUB-02` | local commit | `PASS` — worktree HEAD and main-repo ref both `887b1d9586b005606e1d8985e6c47c70a4a2900e`; branch `cursor/ucr-s0-recovery-3141`; target is ancestor |
| `EV-PUB-03` | bundle | `PASS` — raw SHA-256 `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07`; `git bundle verify` okay; sole ref tip `887b1d95…`; requires `0b73cb2f…`; b64 decode matches |
| `EV-PUB-04` | authority | `BLOCKED` — `gh` active account `cursor`; `git fetch` read succeeds; **write denied** to `mrrobot787/starnet` (no Publication Custodian / owner push capability for this principal) |
| `EV-PUB-05` | action | `BLOCKED` — one normal push attempted; exit 128; `Permission to mrrobot787/starnet.git denied to cursor[bot]`; HTTP 403; no force/rebase/amend |
| `EV-PUB-06` | remote branch | `NOT_PUBLISHED` — after fetch/`ls-remote`, remote ref absent |
| `EV-PUB-07` | parity | `NOT_ESTABLISHED` — local `887b1d958…`; remote none |
| `EV-PUB-08` | S0 nonmutation | `PASS` — object `cdc793ba738c688ef2493fcd196043bfb3fddd77` on target history; 0-byte diff on canonical S0 paths vs recovery branch |
| `EV-PUB-09` | GOV nonmutation | `PASS` — object `3f2dd71db76ddc89ff2dabad391665f4a381698c` on target history; 0-byte diff on GOV addendum path; target tree `ae99976557967adb3ad13242de553d32512183e1` unchanged |
| `EV-PUB-10` | RCA status | `RECORDED` — evidence IDs exactly `EV-PUB-00`..`11` (12 items); AML RCA: publication run isolated to StarNet, not AML; identity-gated items `NOT_PRODUCED` |
| `EV-PUB-11` | transition | `BLOCKED` — `RECOVERY_EVIDENCE_PUBLISHED` **not entered**; terminal `BLOCKED_PUBLICATION_AUTHORITY`; earliest downstream gate remains `BLOCKED_IDENTITY` (not active until publication receipt exists) |

## Additive-only recovery surface

| Check | Result |
| --- | --- |
| Commits above target | 3: `9de298049…`, `dd9ea6002…`, `887b1d958…` |
| File diff vs `origin/feat/harness-backend` | one added file: `docs/experiments/au-ucr-ep-000001/AU_UCR_S0_HISTORICAL_REVIEW_RECOVERY.md` (+344 lines) |
| Canonical path mutations | none (0-byte diffs on S0/GOV register paths) |

## Publication probe (not a receipt)

| Step | Result |
| --- | --- |
| `git fetch origin --prune` | completed |
| `git ls-remote origin refs/heads/cursor/ucr-s0-recovery-3141` | empty |
| `git push -u origin cursor/ucr-s0-recovery-3141` | exit 128; HTTP 403 `cursor[bot]` denied |
| force / rebase / amend | not attempted |

## Repository mutations (this run)

| Surface | Mutation |
| --- | --- |
| `/workspace/starnet` git objects/refs/history | **none** |
| `/workspace/starnet-ucr-s0-recovery-001` | **none** |
| `/workspace` (AML) | **none** |
| External artifacts only | evidence + verification log under `/opt/cursor/artifacts/` |

## Required Cursor Completion Report

| Field | Exact report |
| --- | --- |
| Work item | `AU-UCR-S0-PUBLICATION-RECOVERY-001` |
| Terminal status | `BLOCKED_PUBLICATION_AUTHORITY` |
| Earliest unresolved gate | Remote publication authority / receipt (`EV-PUB-04` `BLOCKED`, `EV-PUB-05` `BLOCKED`, `EV-PUB-06` `NOT_PUBLISHED`) |
| Next gate (inactive until publication) | `BLOCKED_IDENTITY` |
| Repository / remote | `/workspace/starnet`; `origin` → `mrrobot787/starnet` |
| Recovery worktree | `/workspace/starnet-ucr-s0-recovery-001` |
| Local branch / commit | `cursor/ucr-s0-recovery-3141` @ `887b1d9586b005606e1d8985e6c47c70a4a2900e` |
| Remote branch / commit | absent |
| Local/remote parity | `NOT_ESTABLISHED` (`EV-PUB-07`) |
| Bundle digest | `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07` |
| Canonical S0 / GOV | `cdc793ba738c688ef2493fcd196043bfb3fddd77` / `3f2dd71db76ddc89ff2dabad391665f4a381698c` — nonmutation `PASS` |
| Integration target | `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3` (`origin/feat/harness-backend`) |
| Evidence `EV-PUB-00`..`11` | `00`–`03` `PASS`; `04`–`05` `BLOCKED`; `06` `NOT_PUBLISHED`; `07` `NOT_ESTABLISHED`; `08`–`09` `PASS`; `10` `RECORDED`; `11` `BLOCKED` (no `RECOVERY_EVIDENCE_PUBLISHED`) |
| Publication actor | `cursor[bot]` via ambient credentials — **no write authority** to owner repo |
| Push result | one normal push failed HTTP 403 |
| AML RCA | Separate repo `/workspace` (`mrrobot787/aml`); not used for this publication run |
| Artifact references | `/opt/cursor/artifacts/au-ucr-s0-publication-recovery-001-evidence.md`; `/opt/cursor/artifacts/au-ucr-s0-publication-recovery-001-verification.log` |
| Actions not taken | no force push; no identity/review/acceptance/execution transitions; no provisional identity output changes; no in-repo edits |

## Governed conclusion

**`BLOCKED_PUBLICATION_AUTHORITY`**

Local recovery commit, bundle integrity, repository isolation, and canonical S0/GOV nonmutation are
verified. An owner-authenticated principal must perform a single normal push of
`cursor/ucr-s0-recovery-3141` at exactly `887b1d9586b005606e1d8985e6c47c70a4a2900e` before
`RECOVERY_EVIDENCE_PUBLISHED` and governed identity work may proceed.
