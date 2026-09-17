---
fingerprint: 08eece34
slug: startup-load-reopens-closed-tray-window
title: Completing startup loading reopens a window closed to the tray
surface: release
severity: P1
status: open
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: audit
---

# Completing startup loading reopens a window closed to the tray

## Symptom

The exact signed 0.12.0 candidate remains resident after close-to-tray but exposes a visible StarNet window again. This blocks release acceptance.

## Repro

On a fresh Windows runner, install the signed candidate, enable close-to-tray while stopped, launch, wait for a visible window and healthy sidecar, then send WM_CLOSE. Observe the resident window for twelve seconds before using a second launch to reveal it.

## Evidence

GitHub Actions run 35170115068, lifecycle job 105039776050, failed only close-to-tray. The installer SHA-256 is `2a76c0bf547a780f6c5e48a9b8376a04f229453bf226f9488799e84efebc4f65`. Both the resident and revealed snapshots contain visible window 393576 owned by the original shell PID 8816. The startup log confirms the close-to-tray branch. Idle close/relaunch and updater smoke passed. Original receipt and log remain at `.dogfood/release-recovery/g1-official/` and `g1-official-job.log`.

The native `src-tauri/src/main.rs` page-load callback calls `window.show()` for both Started and Finished, and again for later page loads. A close hides the window but does not cancel subsequent startup reveals. The correction gates initial reveal on Finished, consumes that permission once, and cancels it when CloseRequested occurs.

## Regression

`src-tauri/src/window_visibility.rs` exercises initial reveal, close before completion, reload after close, and start-minimized behavior. `test/desktop-lifecycle-preferences.test.js` verifies that the native event handlers use those decisions. The unchanged installed G1 matrix remains the acceptance test; unit tests do not close this record.

## Verdict

Open pending corrected native-binary and exact-installer proof. The failed 0.12.0 draft must remain unpublished. Per `docs/RELEASE_RUNBOOK.md`, preserve its already-built tag and cut 0.12.1 for the corrected overhaul.
