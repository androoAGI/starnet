---
fingerprint: 8f911536
slug: persisted-e-stop-cannot-be-resumed-from-the-desk
title: Persisted E-STOP cannot be resumed from the desktop control
surface: autonomy
severity: P1
status: fixed
found: 2026-09-07
lane: estop-recovery-0907
fix: acdf5160c
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

Source repaired by the dedicated halt-state/resume API and state-backed UI. Live seeded browser
proof includes stop, restart, a real partial write failure, and explicit retry. The affected
installed executable and customer recovery remain unverified; no reinstall or wipe occurred.

## Regression

Before: the 0.10.13 control only halted; current source had no coordinated recovery. Persisted
cron, Night Shift, and loop flags stayed halted across restart in the live seeded reproduction.
After: test/emergency-recovery.http.test.js proves stop/restart/explicit resume and individual
write failures across all three, preserving posture, permission records, arm intent and leash
accounting. test/emergency-control.test.js proves read-only hydration and truthful partial/offline
UI states. qa/digests/2026-09-07-emergency-recovery.md records real browser button interactions.


## Sibling coverage

{
  "adapters": [
    {"target":"cron scheduler","state":"covered","test":"test/emergency-recovery.http.test.js","scenario":"armed timer resumes; disabled scheduling stays off; durable failures remain halted","gate":"http"},
    {"target":"night shift","state":"covered","test":"test/nightshift-halt.e2e.test.js","scenario":"dedicated resume opens the halt gate without a dial write","gate":"http"},
    {"target":"loop driver","state":"covered","test":"test/loops.e2e.test.js","scenario":"stop/restart/dedicated resume launches another real loop iteration","gate":"http"}
  ],
  "entrypoints": [
    {"target":"System toggle and top-bar recovery","state":"covered","test":"test/emergency-control.test.js","scenario":"explicit stop/resume, authoritative recheck, partial failure and unavailable state","gate":"fast"},
    {"target":"legacy routine/loop resume","state":"covered","test":"test/lifecycle-armed.http.test.js","scenario":"legacy resume rejects failed durable writes","gate":"http"},
    {"target":"individual conversations/groups","state":"not-applicable","reason":"The aggregate clears only the three unattended subsystem halts; individually stopped conversations retain their own resume controls."}
  ],
  "displays": [
    {"target":"browser DOM","state":"covered","test":"test/emergency-control.test.js","scenario":"state labels, failure copy, and hidden recovery after success; live seeded clicks additionally recorded in digest","gate":"fast"},
    {"target":"Windows installed WebView2","state":"blocked","reason":"Source browser proof is complete, but the reporter executable has not been replaced and retested; installed UI proof remains pending."},
    {"target":"Mac installed WKWebView","state":"blocked","reason":"This Windows host cannot execute the Mac installer; release acceptance must verify the embedded control there."}
  ],
  "lifecycle": [
    {"target":"stop/restart/explicit resume","state":"covered","test":"test/emergency-recovery.http.test.js","scenario":"all three durable halts survive restart; hydration does not resume; explicit recovery persists","gate":"http"},
    {"target":"partial durable failures and retry","state":"covered","test":"test/emergency-recovery.http.test.js","scenario":"each subsystem independently fails closed and reports HTTP 503; retry clears only remaining halts","gate":"http"},
    {"target":"offline browser","state":"covered","test":"test/emergency-control.test.js","scenario":"unverified result becomes CHECK STOP STATE; retry only reads","gate":"fast"}
  ]
}
