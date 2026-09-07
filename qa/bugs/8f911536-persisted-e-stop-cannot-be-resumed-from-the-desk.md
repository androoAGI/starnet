---
fingerprint: 8f911536
slug: persisted-e-stop-cannot-be-resumed-from-the-desk
title: Persisted E-STOP cannot be resumed from the desktop control
surface: autonomy
severity: P1
status: open
found: 2026-09-07
lane: estop-recovery-0907
fix:
origin: customer
report: Owner-relayed Windows report, 2026-09-07
affected: Windows 0.10.13, build 1846fcadc58e294a798dd2ae4598dc766e7f84c2
family: emergency-stop
installer: unverified
recovery: unconfirmed
---

# Persisted E-STOP cannot be resumed from the desktop control

## Symptom

Customer on Windows 0.10.13 remains E-STOP halted across restarts; clicking the top-right control does not resume automation, while interactive chat works. Local installed-folder patch did not restore operation.

## Repro

1. Stop the station with POST /api/halt or the 0.10.13 button. 2. Restart using the same workspace. 3. Try the stop-only control again: all three durable halt flags remain engaged. Current source had removed the control without adding coordinated recovery.

## Evidence

Exact affected source SHA: 1846fcadc58e294a798dd2ae4598dc766e7f84c2. src-tauri/src/main.rs builds WebviewUrl::App(index.html); installed-folder HTTP scripts are not the executable-embedded UI. Live seeded baseline on port 9217: /api/cron, /api/nightshift/status and /api/loops each reported halted:true. test/emergency-recovery.http.test.js exercises the new real host recovery seam.

## Verdict

Repair in progress. Source, installer behavior, and customer recovery are tracked separately.

## Regression



## Sibling coverage


