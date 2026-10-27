---
fingerprint: 159d44fc
slug: a-first-task-that-fails-at-the-provider-consumes
title: A first task that fails at the provider consumes the hand-off with no retry
surface: onboarding
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/onboarding
fix: d4d64e972
origin: audit
---

# A first task that fails at the provider consumes the hand-off with no retry

## Symptom

A beginner reaches YOUR FIRST TASK, types the task and presses "Start this task →" while the provider is unreachable. After 1:45 of retries COMMS says "⚠ StarNet is running fine, but it couldn't reach the AI provider … Try again", but there is no retry control, the composer is empty, ArrowUp does not recall the message, and the YOUR FIRST TASK review never comes back. To "try again" they must retype their first task (or find the ⧉ copy button on their own bubble).

## Repro

1. Fresh station, onboard to YOUR FIRST TASK (any path).
2. Take the provider down (connection refused), type a task, press Start this task.
3. Wait for RUN FAILED; inspect the error row, the composer and the dialogue panel.

## Evidence

Live (station QUASAR, 2026-10-20): presence `■ RUN FAILED · 1:45`; error row `⚠ StarNet is running fine, but it couldn't reach the AI provider … Try again; if it keeps failing, switch provider or model in SETTINGS. ⧉ fetch failed (ECONNREFUSED 127.0.0.1)`; `{"btns":["⧉"],"input":""}`; ArrowUp left the composer `""`.

Code: `frontend/app/pitchstore.js` `startHandoff` sets `state.handoffPending = false; state.starterDone = true` as soon as the run is launched, before its outcome is known.

## Verdict

Fixed in `d4d64e972` (2026-10-23; an ancestor of trunk, first released in v0.14.0) for the harm the record names: the first task that YOUR FIRST TASK sends goes into the composer's own ArrowUp recall (PitchStore.startHandoff -> Chat.rememberSent), so a first run that fails at the provider is retried with ArrowUp and Enter, never retyped; a launch that did not go out still puts the task back in the composer. Not changed: the YOUR FIRST TASK panel does not come back after a failed run, and the error row gains no new retry key. Regression: test/first-task-recall.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
