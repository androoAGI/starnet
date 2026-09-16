# 0.12.0 preparation — overhaul, bug closure and upgrade acceptance

Prepared September 15, 2026 EDT / September 16 UTC. Baseline: `90d6f0111931ec3991aaba28d580422b4b02a81b`; public base: `v0.11.2` at `69baf91a5b2c22230f87e614da6a72882278bc6c`. This is a preparation snapshot, not a frozen release candidate or a release-readiness claim.

## What is prepared

- [scope.json](scope.json): 178 commits since the public tag, including 44 non-merge commits touching product code/assets; all 66 classified customer/owner records and recent unmerged branch observations. These are overlapping scopes, not 178 user-facing features.
- [BUG_DISPOSITION.md](BUG_DISPOSITION.md): the seven still-open reports, four source-fixed reports added since the tag, and the evidence needed to close each gap.
- [ACCEPTANCE.md](ACCEPTANCE.md): a concrete combined-build, saved-station, installer and release checklist.
- [RELEASE_NOTES_DRAFT.md](RELEASE_NOTES_DRAFT.md): proposed public language grounded in merged source, with unfinished overhaul additions explicitly held.
- Two previously unregistered public reports are now durable records: #14 Telegram delegation and #17 local-model conversation latency. The generated bug index includes them. No public issue was changed and no customer message was sent.
- Preparation checks passed: fast gate 783/783, customer campaign 34/34, focused prompt checks 30 assertions, register validation and document hygiene. These are baseline results; final combined-build acceptance remains owed.

Done for this preparation lane means these artifacts are reviewable, the register validates, available regression checks are recorded, and remaining claims have explicit evidence requirements. It does not mean every user bug is resolved.

## Current release state

GitHub distribution reads confirm 0.11.2 is the latest published release (September 11, 20:16:08 UTC). Local desktop pins remain 0.11.2. Old 0.10.0/0.10.1 drafts are separate historical artifacts; this task does not alter them.

The canonical integration-tree readiness command, read at 2026-09-16T01:14:49Z, returned:

```text
NOT READY — 5 reasons
1. Ledger: 2 open P1 findings.
2. Bug register: 5 open P1 reports on trunk.
3. Guardian: RED at 90d6f011.
4. Beginner: PASS belongs to aa20ee26, not current trunk.
5. Installed smoke: tested binary source does not equal current trunk.
```

That five-report count predates the two imports in this lane; the preparation register has seven open P1 reports. Do not substitute a new worktree's empty, gitignored findings directory for the canonical ledger. A later receipt can supersede this snapshot; preserve its source and timestamp.

Guardian's 00:26 UTC cycle passed fast, HTTP, adversarial, screenshot capture and journeys. Golden and behavioral audit gates exited 3. Its audit log reports 44/47 assertions passed with one soft skip, including failures for `summon/awareness-gaze-only` and `approval/files-cap-owned`. Open ledger fingerprints are `9dc2a1df` (zoned-body containment) and `a558b4db` (file capability ownership). The current awareness failure and older containment finding are separate observations; neither is automatically dismissed by an approved visual overhaul. Review the actual baseline images before accepting golden changes.

## What has landed versus what is still moving

| Area | Baseline contains | Final acceptance owed |
| --- | --- | --- |
| Station appearance | Industrial default materials, command bridge, shell/floor choices, initial station-minion skin | The final prop, skin, lighting, starter-station and Build combination |
| Personal progress | Intent-led onboarding, arrival, personal journeys/goals and outcome reviews | Fresh-user path and migration of existing goals/progress |
| Everyday use | Compact bubbles, transcript ordering, secondary panel repairs, XP/rating recovery | Combined UI at normal/enlarged scale and after restart |
| Reliability | Browser card discovery, account recovery controls, task/session lifecycle repairs, smaller greeting prompts and Ollama output bound | Exact reported entry points and candidate installer behavior |

Recent leading overhaul tips observed through Git, without opening another agent's workspace:

| Branch | Observed tip | Work visible in commits |
| --- | --- | --- |
| `agent/station-default-0915` | `1f87ef828` | Furnished presets, starter composition, Build browsing and onboarding/tour changes |
| `agent/prop-coordination-0914` | `708cb4f63` | Remastered props/structural art, seated geometry, labels and animated skin integration |
| `agent/sprite-reimagine-0914` | `bcba24697` | Skin motion sets, grounded strides, cardinal facing and movement cadence |

These tips share work and may contain copied or cherry-picked changes; lack of ancestry is not proof that every change is missing. `scope.json` lists other recent tips, including website/marketing and subordinate prop lanes. This is an inventory, not an instruction to merge all branches. Reconcile final product diffs and owner-selected tips after the current merges finish; never add their commit counts together or merge subordinate lanes blindly.

## Priority order

1. **Now:** retain the complete report inventory, close missing evidence gaps, draft release copy and upgrade acceptance, identify final screenshots/manual pages, and run baseline regressions. This lane has started that work.
2. **As merges land:** reconcile inclusion at the exact combined SHA, check website mirror and source locks, investigate both behavioral failures, review new visual goldens, then run full combined gates and live user paths.
3. **Freeze:** prepare all five 0.12.0 version pins and final notes through the existing release procedure, earn fresh post-bump evidence, build the exact signed candidate, test 0.11.2 upgrades and clean installs on supported platforms, then obtain the final readiness verdict.
4. **Release operation:** follow [RELEASE_RUNBOOK.md](../../RELEASE_RUNBOOK.md) for the draft train, exact-draft T0/G1, publication decision, updater canary and source/feed verification. This preparation request does not publish or tag a release.

The ordinary 12-hour source and 48-hour installed acceptance requirements remain applicable. The owner waived their duration for **0.11.2 only**. Likewise, the prior release disposition of unresolved reports is historical evidence, not a new 0.12.0 acceptance decision.

## Scope limits

The fresh external census covers all GitHub issues updated since September 11, including closed issues. #15 is a feature request (station templates/community gallery/AI building), not a bug closure requirement; furnished presets do not establish a community gallery or AI station builder. Prior support reports are represented through sanitized tracked records. No fresh private-mailbox read was available in this session, so this is not a complete census of unseen support email. Re-read GitHub and the support inbox before freeze and again before publication.

The running seeded baseline was inspected at `http://127.0.0.1:9276`: UPLINK became ONLINE, the live feed connected, and WORK → QUESTS opened the Now/Goals/Progress/History panel. This proves only baseline startup/navigation. No final overhaul, paid provider, physical Mac, user account or installed upgrade was exercised by that UI check. Validation details are in [VALIDATION.md](VALIDATION.md).
