# 0.12.0 preparation follow-through — September 16, 2026 UTC

Owned branch: `agent/release-0120-prep-0915`, based on integration `90d6f0111`. These are source and audit repairs before the final overhaul merges. The initial preparation inventory and validation remain historical snapshots.

## Completed source work

| Change | Commit | Observable proof |
| --- | --- | --- |
| Trusted channel leads receive the briefing for their actual granted delegation tools | `887210a7b` | Real sidecar: the same saved lead and specialist complete desktop and Telegram dispatch; worker output returns to the parent; persisted binding works after restart. 82 assertions pass. Workers remain unable to delegate recursively. |
| Live gaze audit measures movement immediately around actual gaze calls | `346377c0b` | Live seeded audit: 47/47 assertions pass, no instrumentation errors. Regression detects position, target, path and state mutations and fails on a missing/duplicate instrumentation seam. |
| Interactive continuation ratings use each run's saved origin | `da0658486` | GitHub #18 reproduced before repair: 11 failed assertions. Repaired integration: 57 pass, including actual routine execution → interactive reply → durable rating → restart → idempotent retry. Internal/scheduled/ambiguous legacy runs retain their restrictions. |

The gaze change repairs an inference in the audit, not world movement code. A separate crowded-floor campaign observed 20 bodies over 180 samples: 62 occupied-waypoint snapshots, no containment violations, 34 natural gaze calls and 380 exercised calls without movement mutation. A deliberate one-pixel movement fault was detected and restored. An occupied waypoint is therefore insufficient evidence that a gaze caused movement. The canonical containment and file-capability findings remain open; passing a new seed does not establish what happened in their original runs.

## Intake and bug disposition

GitHub issues updated since the public 0.11.2 publication were freshly read, including closed reports. New #18 is recorded as source-fixed in `qa/bugs/09f0e9fa-interactive-replies-in-scheduled-conversations-c.md`; installed delivery and customer recovery remain unverified. #17's latest reply asks about setup and cost control, without confirming recovery. #14 remains open in the local register despite public closure: the briefing repair and executed parity test do not establish the original missing-tool cause.

The initial 66-report snapshot now has one additional customer report: 67 total, 60 source-fixed and 7 open. Private support intake is still unavailable in this task's connected tools. No public issue, email or customer account was changed.

## Verification receipts

Evidence lives under `.dogfood/release-followthrough/` in this owned worktree:

- `telegram-before.log`, `telegram-after.log`: missing briefing before repair; 82 assertions after repair.
- `rating-before.log`, `rating-after.log`: 11 failures before repair; expanded 57-assertion campaign after repair.
- `audit-before.log`, `audit-repeat.log`, `audit-after.log`, `audit-after-report.json`: three live audit passes, including the repaired instrumentation.
- `crowded.log`: 20-body containment and causal gaze proof. Detailed report: `.dogfood/release-0112-pointer/crowded-closeout/report.json`.
- Focused checks: prompt diet 7 unit + 23 sidecar assertions; XP store 107; run store 95; shared work-rating control 5.

Full fast and HTTP gates are pending on the final source snapshot. The earlier follow-through gate was deliberately stopped after new intake #18 required another source change; it is not a final receipt. No station-wide readiness claim is made.

## Remaining work that needs a later candidate or external evidence

- Final owner-selected overhaul merges, combined layout/save migration acceptance and refreshed screenshots.
- Canonical Guardian findings and golden-image review on that combined candidate; exact-candidate Beginner and installed smoke.
- Private support intake and affected-account evidence for unexplained usage and historical managed Sonnet failure.
- Real llama3.2:3b measurements, affected authenticated browser campaign, native account recovery and physical Mac boot acceptance.
- Signed 0.12.0 packaging, actual 0.11.2 → 0.12.0 upgrade, required source/installed soaks and final `qa:ready` receipt.

Use [ACCEPTANCE.md](ACCEPTANCE.md) for the complete release checklist. These source repairs do not waive any of those checks, bump the release version or publish an update.
