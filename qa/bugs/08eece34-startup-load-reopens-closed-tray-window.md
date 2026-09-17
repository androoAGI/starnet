---
fingerprint: 08eece34
slug: startup-load-reopens-closed-tray-window
title: Completing startup loading reopens a window closed to the tray
surface: release
severity: P1
status: fixed
found: 2026-09-16
lane: release-0120-prep-0915
fix: 9c3b7819c
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

Fixed in the installed private 0.12.1 candidate `9bf98816021fc0d74d4e35c47ec9a1a06b9f2948`. The unchanged native close-to-tray matrix passes (`.dogfood/release-recovery/native-0121-tray-matrix.json`): the resident window is hidden, shell and sidecar stay alive, and a second launch reveals the same process. A separate real reload probe fails on the original 0.12.0 binary and passes on the corrected binary (`tray-reload-before-verified.json`, `tray-reload-after-native-0121.json`). The corrected private installer SHA-256 is `df29aee4897397d8912c7ded5136fc30d85dd7e9b1cd10718f058c3865e4c4ae`; this is not the future official signed release artifact.

The failed 0.12.0 draft remains unpublished and is labeled superseded. Its already-built tag is retained per `docs/RELEASE_RUNBOOK.md`; the overhaul proceeds as 0.12.1. Exact official signed-artifact acceptance remains owed before publication. This disposition is recorded after native verification, separately from the frozen application source.
