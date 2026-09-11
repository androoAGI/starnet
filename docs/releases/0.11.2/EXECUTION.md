# 0.11.2 signed candidate and personal installation — September 11, 2026

The signed 0.11.2 candidate is installed and running in the owner's existing personal Windows StarNet. The final machine readiness receipt is **NOT READY solely for eight unresolved customer P1 reports**. All other readiness categories pass. No public tag, draft, release or updater-feed change has been made. The owner waived ordinary source/installed soak durations; that waiver does not resolve or waive the customer reports.

## Frozen identity

- Integration/source commit: `bb9f0719d9d632575670bc94228cfd72bb06f0ce`.
- Source tree: `736f8e9eed375a74a5c99422c4f2a6027973fbfd`.
- All five version pins: `0.11.2`. Requested merge `c9b6a67f8` is an ancestor.
- Signed Windows installer SHA-256: `71864ab55548c712ebaa0dabedd01db3b9ae937abfb39043f44891f5ffa53f0d` (129,883,888 bytes).
- Installed executable SHA-256: `06f00664e32b65756c5d7223a99626c43a20879ab112a017ede2be8b55915cc9` (17,882,376 bytes); matches the hosted installer acceptance. Authenticode is Valid, signer Andrew Sims.
- Evidence-only documentation commits remain separate from the frozen integration commit; receipts retain their original candidate identities.

## Final verification

| Check | Exact-candidate result |
| --- | --- |
| Source Guardian | All seven gates GREEN, none skipped: 771 fast steps, 113 HTTP steps, 515 adversarial attacks across 234 routes, screenshot sweep, 16 golden frames, 47 behavioral assertions and 139 journey assertions. |
| Beginner | PASS, six UI steps, 96.615 seconds, documented UI-only boundary. |
| Post-merge CI | [Fast 34579965991](https://github.com/androoAGI/starnet/actions/runs/34579965991), [evaluations 34579965922](https://github.com/androoAGI/starnet/actions/runs/34579965922), and [security 34579965958](https://github.com/androoAGI/starnet/actions/runs/34579965958) succeeded at the frozen commit. |
| Signed build | [34577084632](https://github.com/androoAGI/starnet/actions/runs/34577084632): Windows, Linux, Apple Silicon and Intel Mac builds PASS; both Mac notarizations and Intel installed acceptance PASS. |
| Hosted Windows acceptance | [34579476189](https://github.com/androoAGI/starnet/actions/runs/34579476189): clean install/first launch, idle-close, resident tray/reopen, public 0.11.1 populated-station upgrade and restart PASS. Compiled CRT static settings persist; installed smoke 9/9 and bundled provider-fallback/delegated-MCP regressions PASS. |
| Updater preparation | The production assembler verified signatures for Windows x64 and both Mac updater archives. Public 0.11.1 and this candidate retain the same trusted updater key and feed endpoint. The prepared manifest passed hosted feed/version smoke. This is not a completed public automatic update: the candidate feed/assets are unpublished. |
| Personal upgrade | 519 preservation checks PASS after install and again after normal restart; 26 crew, 141 props and 71 conversations preserved, including history and existing settings. Provider credential availability unchanged. Installed WebView smoke 9/9 GREEN. |
| New lifecycle repair | Installed Node plus bundled sidecar pass all 80 real HTTP lifecycle assertions, including paused-only restart, resume and mixed enabled/paused counts, in isolated temporary workspaces. Personal normal launch shows one paused routine, zero active runs, armed false, and native tray `idle (closing quits)`. |

The final pass found a real lifecycle defect: paused saved routines were counted as armed work, falsely keeping an idle desktop resident. Commit `b87bdf26099327e91eae85f9c5b1933ea5dbbe56` corrects that count. It does not establish the cause of the separate customer idle-billing report. The exact historical security finding was a Git commit identifier; only its reviewed fingerprint was allowlisted, and final full-history security passes.

## Personal installation and recovery

The original signed public 0.11.1 installation and closed application data were backed up before replacement. Backup root: `C:\Users\andro\AppData\Local\StarNet-release-backups\0.11.2-a1d334f97-20260911-075150`. The name reflects the earlier preparation checkpoint; the install receipt binds the actual final bb9 candidate. A second consistent pre-upgrade data snapshot is retained under `pre-upgrade` there. Save draining passed before each normal exit. No active task was interrupted.

The installer completed with exit zero. After verification the app was relaunched normally without the temporary WebView debugging flag and left running at `C:\Users\andro\AppData\Local\StarNet\skynet-desktop.exe`.

The preservation comparator accounts for the existing source-defined persona aliases (`direct` to `blunt`, `friendly` to `warm`; 25 canonicalized IDs). All other prior crew fields and conversation content were preserved. Its initial stricter assumptions about persona IDs and the harness revision string were corrected against the source contract; these were comparison errors, not product defects. The private build's harness revision is `bb9f071`, while app version is `0.11.2`. Installed/source JS equality permits only checkout line-ending differences. Private station content and credentials are excluded from portable evidence.

## Public release decision

At 08:50 UTC the exact-candidate `qa:ready` receipt reports:

> NOT READY — Bug register open P0/P1: 8 open blocking bugs (0 P0 · 8 P1).

Guardian, journeys, Beginner and installed smoke all pass. [RELEASE_DISPOSITION.md](RELEASE_DISPOSITION.md) records the eight report-specific uncertainties. They are unresolved historical customer reports, not eight defects reproduced on 0.11.2. Controlled tests and Intel Mac acceptance do not prove recovery on the affected customer accounts or Apple Silicon machine.

Public release remains held under RELEASE_RUNBOOK §0.5. The remaining decision is evidence-backed closure or explicit owner acceptance of those documented uncertainties. Keep the reports open if accepting a release exception; do not weaken the readiness controller or describe the aggregate as READY.

Portable evidence is in `qa/evidence/0.11.2-release-cut-0911/manifest.json`; full raw logs, prepared signed artifacts and private preservation inputs remain in the owned release worktree's ignored `.dogfood/release-0112-cut/` directory.
