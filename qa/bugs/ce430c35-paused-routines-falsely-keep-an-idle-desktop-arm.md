---
fingerprint: ce430c35
slug: paused-routines-falsely-keep-an-idle-desktop-arm
title: Paused routines falsely keep an idle desktop armed
surface: autonomy
severity: P2
status: fixed
found: 2026-09-11
lane: release-0112-finalprep-0911
fix: b87bdf26099327e91eae85f9c5b1933ea5dbbe56
origin: owner
report: local-personal-station-2026-09-11
affected: Windows personal 0.11.1; candidate a1d334f97 also reproduces
family: lifecycle-truth
installer: unverified
recovery: unconfirmed
---

# Paused routines falsely keep an idle desktop armed

## Symptom

The personal Windows station's native tray reports "1 routine armed" despite its sole routine being paused. Closing the window keeps the idle process resident.

## Repro

Create a recurring routine, arm the scheduler, then pause that routine with POST /api/cron/update using `{id, patch:{enabled:false}}`. GET /api/cron confirms disabled/paused while GET /api/lifecycle/armed incorrectly reports armed:true and count:1. Restart and observe the same discrepancy. Add one enabled and one paused routine: the count incorrectly reports two.

## Evidence

The running personal app reported zero active runs, one paused/disabled job, and lifecycle armed:true with reason "1 routine armed"; native UI Automation read the matching tray tooltip. Its workspace was verified against the current sidecar PID/port and native startup log. `test/lifecycle-armed.http.test.js` reproduces the same API discrepancy on isolated real sidecars. The corrected fixture failed five assertions before the source edit and passes all 80 afterward, including restart and mixed routine counts. Logs are retained in the release preparation worktree `.dogfood/release-0112-cut/paused-before-corrected.log` and `paused-after-corrected.log`.

## Verdict

Source fixed: lifecycleArmedSnapshot counted every persisted routine rather than the enabled jobs the scheduler can execute. The aggregate now excludes disabled jobs. Pausing already aborts the job's active lease after the durable write; this change does not alter pause, resume, scheduler intent, credentials or task execution. Exact installed-owner recovery remains to be verified after the final candidate is installed.

## Regression

`test/lifecycle-armed.http.test.js`: pause persistence, zero armed jobs/reasons, restart, resume and mixed enabled/paused jobs. Existing E-STOP, halt durability, failed durable writes, resume and token-guard assertions remain green.

## Sibling coverage

{"adapters":[{"target":"desktop supervisor lifecycle endpoint","state":"covered","test":"test/lifecycle-armed.http.test.js","scenario":"raw-socket response and truthful enabled-job count","gate":"http"}],"entrypoints":[{"target":"pause/resume routine API","state":"covered","test":"test/lifecycle-armed.http.test.js","scenario":"pause only job and resume without changing scheduler intent","gate":"http"}],"displays":[{"target":"native tray","state":"blocked","reason":"Original tooltip reproduced; exact repaired installer verification follows the build."}],"lifecycle":[{"target":"restart and mixed saved routines","state":"covered","test":"test/lifecycle-armed.http.test.js","scenario":"paused-only station stays idle after restart; mixed count excludes paused jobs","gate":"http"}]}
