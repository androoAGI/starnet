---
fingerprint: f964344e
slug: an-explicit-recovery-fails-closed-while-the-stat
title: An explicit recovery fails closed while the station browser is open
surface: onboarding
severity: P2
status: fixed
found: 2026-11-02
lane: agent/station-lifecycle-record-1031
fix: 65944dc92
origin: audit
---

# An explicit recovery fails closed while the station browser is open

## Symptom

On Windows, with the station browser open, a Commander picks a station on the recovery screen and presses RECOVER. The service restarts, but the chosen station does not come back. The screen stays on "recovery accepted", and the only trace is a failed recovery in the boot log and the recovery report. It is a race with the orphaned browser dying, so it looks random.

## Repro

1. On Windows, on trunk b14923ca2, boot a sidecar with a recoverable station in a legacy root, then open the station browser with `POST /api/browser/view/open`.
2. `POST /api/lineage/recover` with that candidate. It answers 202, and the sidecar exits 75.
3. Boot again at once, as the desktop guardian does.

`node test/start-fresh-browser.e2e.test.js` reproduces it against b14923ca2, in its RECOVERY row.

## Evidence

- At b14923ca2, both lifecycle routes ended with `setTimeout(() => process.exit(75), 150)` (sidecar/index.js 13281 and 13302). That skips `gracefulShutdown`, the only place the station browser is closed, and the browser's durable profile (`.browser-profile`) lives inside the generation the next boot renames.
- On Windows an open handle under a folder refuses its rename with EPERM. A scratch probe showed that for a file node had open and for a child process's working directory.
- `test/start-fresh-browser.e2e.test.js` against b14923ca2, a real Chrome on the real profile path, five runs:
  - "the moment the sidecar is gone, nothing holds the station profile" failed in all three runs that checked it, on both routes.
  - The recovery itself failed in 3 of the 5 runs. The two whose boot line was captured read: "[recovery] automatic station recovery failed closed: EPERM: operation not permitted, rename '...\workspaces' -> '...\workspaces.recovery-rollback-20261102213650186'". The other 2 runs passed. In one of those the process listing, 2 to 3 s after the exit, already found nothing on the profile, so an orphan appears to outlive the sidecar by only seconds here, and the outcome depends on how fast the respawn is.
- This was only run on Windows. Linux and macOS do not refuse such a rename, so there the failure should not appear, and an orphan could write into the moved folder instead. Neither was tested.

## Verdict

Fixed by 65944dc92 (lane station-lifecycle-record, step 4). `POST /api/lineage/recover` and `POST /api/lineage/start-fresh` now close the station browser, end any orphan on its profile (the same sweep as RESET STATION BROWSER, run only when the profile's lock says something holds it), and leave through `gracefulShutdown(why, 75)`. A close or a sweep that does not finish is bounded at 12 s and never blocks the request; a rename that still fails is reported as before.

At the tip, `test/start-fresh-browser.e2e.test.js` passes on both routes, with nothing holding the profile the moment the sidecar is gone. `test/start-fresh-generation.test.js` pins the order for both routes, with the transport faked.

The planner's note suspected this and asked for a record only if it reproduced. It did.
