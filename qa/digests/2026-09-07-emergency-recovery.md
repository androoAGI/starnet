# Emergency-stop recovery — 2026-09-07

Customer report: Windows 0.10.13, source SHA 1846fcadc58e294a798dd2ae4598dc766e7f84c2.
Bug register: 8f911536. The shipped desktop loads executable-embedded frontend assets;
serving a patched installed-folder safety.js did not establish that the webview loaded it.

The new GET /api/halt aggregate and POST /api/halt/resume {confirm:true} clear only
cron, Night Shift and loop halt flags. Each lift persists before changing live state.
Failures are returned by subsystem with HTTP 503 and ok:false. The endpoint does not
write the autonomy posture, workshop grants, cron arm intent or individual job settings.
Existing stopped conversations and individually paused jobs remain individually controlled.

System now contains a stop/resume toggle. A stopped station exposes Resume Automation
in the top bar after boot. Hydration and polling only read. Every action re-reads all
three backend flags before reporting success; partial failures stay visible in System.
The retired stop-only hotkey remains absent. Desktop and website source mirrors agree.

## Live seeded proof

Launched this lane with node dev/seed.js --keep on 127.0.0.1:9217, without a model key.
This is a real sidecar and real frontend; the HTTP endpoints were not mocked.

1. Before repair, POST /api/halt left /api/cron, /api/nightshift/status and /api/loops
   each reporting halted:true. The old frontend provided no coordinated recovery.
2. Restarted the same seeded workspace on the new source. The top bar showed RESUME
   AUTOMATION. Clicking it cleared all three persisted files: cron.halt.json halted:false,
   nightshift.state.json haltedAt:0, loops.halt.json halted:false.
3. Opened SYSTEM and clicked STOP AUTOMATION. All three files recorded a halt. Restarted
   the same sidecar, reloaded the browser, and observed RESUME AUTOMATION again.
4. Replaced ONLY the owned scratch workspace's loops.halt.json with a directory to force
   a real write failure. Clicked Resume. The UI showed "Could not resume: loops";
   GET /api/halt showed cron:false, nightshift:false, loops:true. No success toast.
5. Restored that scratch file, clicked Resume in System, and verified the recovery control
   disappeared and System returned to STOP AUTOMATION. No production data was changed.
6. Computed styles showed the System control using the station palette (background
   rgb(12,7,4), border rgb(185,121,28)); hidden recovery/retry controls had display:none.
   This caught and fixed the existing .bb display rule overriding the hidden attribute.

## Automated evidence

- test/emergency-control.test.js: hydration never posts; dedicated explicit resume;
  authoritative read-back; partial failure; unknown/offline state; hidden-control paint.
- test/emergency-recovery.http.test.js: real host stop/restart/resume across all three;
  durable write failure and retry independently for each subsystem; permission/posture
  bytes, leash counters, disabled scheduling and arm intent preserved; cron ticks resume.
- test/loops.e2e.test.js: dedicated resume after restart launches another real runOnce
  iteration against the local deterministic provider. Legacy per-loop recovery remains covered
  by lifecycle-armed.http.test.js.
- test/nightshift-halt.e2e.test.js: both legacy dial resume and dedicated recovery open
  the real Night Shift halt gate.

## Scope of proof

The live UI is the source app in a browser on Windows, not the customer's installed
WebView2 executable. Installer verification and customer recovery remain unconfirmed.
No reinstall, data wipe, public upload or release publication is part of this receipt.
Full gate/build outcomes will be recorded after completion.
