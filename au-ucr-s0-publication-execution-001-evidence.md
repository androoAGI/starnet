# AU-UCR-S0-PUBLICATION-EXECUTION-001 — external evidence receipt

## Receipt identity

- Work item: `AU-UCR-S0-PUBLICATION-EXECUTION-001`
- Scope: **publication-only** (no identity, review, acceptance, or execution advancement)
- Captured at: `2026-10-03T18:35:00Z`
- StarNet repository: `mrrobot787/starnet` (`/workspace/starnet`)
- Recovery worktree: `/workspace/starnet-ucr-s0-recovery-001`
- Governed recovery object: `887b1d9586b005606e1d8985e6c47c70a4a2900e`
- Target branch: `cursor/ucr-s0-recovery-3141`
- Bundle SHA-256: `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07`
- Canonical S0: `cdc793ba738c688ef2493fcd196043bfb3fddd77`
- GOV: `3f2dd71db76ddc89ff2dabad391665f4a381698c`
- Integration target: `origin/feat/harness-backend` @ `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3`
- Quarantined abbreviated commit (excluded): `48f66a7`
- Verification log: `/opt/cursor/artifacts/au-ucr-s0-publication-execution-001-verification.log`
- **Terminal status:** `BLOCKED_PUBLICATION_AUTHORITY`
- **State entered:** none (`RECOVERY_EVIDENCE_PUBLISHED` **not** entered)

## Fail-closed rules

Immutable git objects, bundle digest, and freshly fetched `origin` refs were used for verification.
No repository file or history edits were made. Identity-gated outputs were not run; gated receipts
remain `NOT_PRODUCED`. Remote branch `cursor/ucr-s0-recovery-3141` was absent after refresh; exactly
one normal `git push -u origin cursor/ucr-s0-recovery-3141` was attempted. HTTP 403 is not a
publication receipt. No force, rebase, amend, cherry-pick, or substitution.

## Pre-mutation capture (EV-PEX-00)

| Surface | cwd | top-level | branch | HEAD | status | remotes |
| --- | --- | --- | --- | --- | --- | --- |
| StarNet | `/workspace/starnet` | `/workspace/starnet` | `cursor/ucr-s0-execution-3141` | `cdc793ba738c688ef2493fcd196043bfb3fddd77` | clean | `origin` → `mrrobot787/starnet` |
| Recovery worktree | `/workspace/starnet-ucr-s0-recovery-001` | `/workspace/starnet-ucr-s0-recovery-001` | `cursor/ucr-s0-recovery-3141` | `887b1d9586b005606e1d8985e6c47c70a4a2900e` | clean; ahead 3 of `origin/feat/harness-backend` | same `origin` |

AML (`/workspace`, `mrrobot787/aml`) HEAD `6a5ade4d8d8e98a28f01b76c1ad2d7827dd30c78` — recorded for isolation only; **not used**.

## Read-only remote proof (before any push)

| Step | Result |
| --- | --- |
| `git fetch origin --prune` (StarNet) | completed |
| `git ls-remote origin refs/heads/cursor/ucr-s0-recovery-3141` | empty (read succeeds) |
| `git ls-remote origin refs/heads/feat/harness-backend` | `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3` |

## Evidence index (`EV-PEX-00`..`EV-PEX-12` only)

| Evidence | Exact meaning | Status / result |
| --- | --- | --- |
| `EV-PEX-00` | preflight | `PASS` — constants, paths, bundle artifact, pre-mutation capture |
| `EV-PEX-01` | isolation | `PASS` — StarNet `mrrobot787/starnet`; recovery worktree shares `/workspace/starnet/.git`; AML separate |
| `EV-PEX-02` | quarantine | `RECORDED_EXCLUDED` — `48f66a7` unresolved in StarNet/AML object stores and GitHub commits API; not in recovery ancestry or bundle tip; **explicitly excluded** from publication |
| `EV-PEX-03` | recovery object | `PASS` — `887b1d9586b005606e1d8985e6c47c70a4a2900e` on branch tip (both surfaces); target is ancestor |
| `EV-PEX-04` | bundle | `PASS` — raw SHA-256 `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07`; `git bundle verify` okay; tip `887b1d95…`; requires `0b73cb2f…`; b64 decode matches |
| `EV-PEX-05` | target | `PASS` — three commit objects verified; branch `cursor/ucr-s0-recovery-3141`; integration target `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3` |
| `EV-PEX-06` | authority | `BLOCKED` — `gh` repo permissions `push:false`; principal `cursor[bot]` lacks owner write |
| `EV-PEX-07` | action | `BLOCKED` — one normal push; exit 128; HTTP 403; no force/rebase/amend |
| `EV-PEX-08` | remote ref | `NOT_PUBLISHED` — remote ref absent after fetch/`ls-remote` |
| `EV-PEX-09` | parity | `NOT_ESTABLISHED` — local `887b1d958…`; remote none |
| `EV-PEX-10` | nonmutation | `PASS` — 12/12 S0 canonical blobs match target; GOV addendum blob matches; `feat/harness-backend` remote unchanged; target tree `ae999765…` unchanged; recovery adds only `AU_UCR_S0_HISTORICAL_REVIEW_RECOVERY.md` |
| `EV-PEX-11` | RCA register | `RECORDED` — see separate RCA sections below |
| `EV-PEX-12` | transition | `BLOCKED` — `RECOVERY_EVIDENCE_PUBLISHED` **not entered**; terminal `BLOCKED_PUBLICATION_AUTHORITY` |

Gated identity / review / acceptance receipts: `NOT_PRODUCED` (not requested in this lane).

## RCA register (`EV-PEX-11`) — preserved separately

### missing-origin

Remote canonical lane branches remain absent on `origin` after refresh (`cursor/ucr-s0-execution-3141`,
`cursor/ucr-gov-001-3141`; prereq `PF-02`/`PF-05`). This publication execution publishes only the
governed recovery branch at `887b1d9586b005606e1d8985e6c47c70a4a2900e` and does not recreate missing
origin branches.

### AML-selection

Governed surfaces are `/workspace/starnet` and `/workspace/starnet-ucr-s0-recovery-001` only.
AML repository `/workspace` (`mrrobot787/aml`) was not selected; HEAD remains
`6a5ade4d8d8e98a28f01b76c1ad2d7827dd30c78` with no mutations.

### evidence-ID

This execution uses exactly `EV-PEX-00`..`EV-PEX-12` with no remapping or extras. Historical lanes
document prior evidence-ID remapping defects (`EV-R18`, identity `EV-I` supersession); those are
recorded only as RCA context, not re-mapped here.

## Quarantine record (`EV-PEX-02`)

| Field | Value |
| --- | --- |
| Abbreviated ref | `48f66a7` |
| Resolution | `UNRESOLVED` — not in linked StarNet git objects, AML git, or `repos/mrrobot787/starnet/commits/48f66a7` |
| Location | `NONE_LOCATED` |
| Exclusion | Not ancestor of `887b1d9586b005606e1d8985e6c47c70a4a2900e`; not bundle tip; not pushed |

## Publication probe (not a receipt)

| Step | Result |
| --- | --- |
| Remote pre-check SHA | absent (no `BLOCKED_SHA_MISMATCH`; nothing to compare) |
| `git push -u origin cursor/ucr-s0-recovery-3141` | exit 128; `Permission to mrrobot787/starnet.git denied to cursor[bot]`; HTTP 403 |
| force / rebase / amend / cherry-pick | not attempted |

## Repository mutations (this run)

| Surface | Mutation |
| --- | --- |
| `/workspace/starnet` | **none** |
| `/workspace/starnet-ucr-s0-recovery-001` | **none** |
| `/workspace` (AML) | **none** |
| External artifacts | this file + verification log only |

## Required Cursor Completion Report

| Field | Exact report |
| --- | --- |
| Work item | `AU-UCR-S0-PUBLICATION-EXECUTION-001` |
| Execution mode | Sequential fail-closed; publication-only |
| Terminal status | `BLOCKED_PUBLICATION_AUTHORITY` |
| State transition | `RECOVERY_EVIDENCE_PUBLISHED` **not entered** (`EV-PEX-12` `BLOCKED`) |
| Earliest unresolved gate | Remote publication authority (`EV-PEX-06`/`EV-PEX-07` `BLOCKED`; `EV-PEX-08` `NOT_PUBLISHED`) |
| Identity work | **not run**; gated receipts `NOT_PRODUCED` |
| StarNet repository | `/workspace/starnet`; `origin` → `mrrobot787/starnet` |
| Recovery worktree | `/workspace/starnet-ucr-s0-recovery-001` |
| Local branch / commit | `cursor/ucr-s0-recovery-3141` @ `887b1d9586b005606e1d8985e6c47c70a4a2900e` |
| Remote branch / commit | absent |
| Local/remote parity | `NOT_ESTABLISHED` (`EV-PEX-09`) |
| Bundle digest | `c345df7c56d8605c7c8d25d6cdc8cc437cb1c7124a979c3003ce861434987c07` |
| Canonical S0 / GOV | `cdc793ba738c688ef2493fcd196043bfb3fddd77` / `3f2dd71db76ddc89ff2dabad391665f4a381698c` — nonmutation `PASS` (`EV-PEX-10`) |
| Integration target | `0b73cb2fb9c3046fee800c18337100a6fb0f4ac3` (`origin/feat/harness-backend`) |
| Quarantine `48f66a7` | unresolved; **excluded** (`EV-PEX-02`) |
| Evidence `EV-PEX-00`..`12` | `00`–`05` `PASS`; `02` `RECORDED_EXCLUDED`; `06`–`07` `BLOCKED`; `08` `NOT_PUBLISHED`; `09` `NOT_ESTABLISHED`; `10` `PASS`; `11` `RECORDED`; `12` `BLOCKED` |
| Publication actor | `cursor[bot]` — **no write authority** (`permissions.push=false`) |
| Push result | one normal push failed HTTP 403 |
| AML RCA | separate repo; not selected (`EV-PEX-11`) |
| Artifact references | `/opt/cursor/artifacts/au-ucr-s0-publication-execution-001-evidence.md`; `/opt/cursor/artifacts/au-ucr-s0-publication-execution-001-verification.log` |
| Actions not taken | no force; no identity lane; no in-repo edits |

## Governed conclusion

**`BLOCKED_PUBLICATION_AUTHORITY`**

Local recovery object, bundle integrity, isolation, quarantine exclusion, and canonical
S0/GOV/`feat/harness-backend` nonmutation are verified. An owner-authenticated principal must
perform a single normal push of `cursor/ucr-s0-recovery-3141` at exactly
`887b1d9586b005606e1d8985e6c47c70a4a2900e` before `RECOVERY_EVIDENCE_PUBLISHED` may be entered.
