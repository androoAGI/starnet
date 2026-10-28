---
fingerprint: 159d44fc
slug: a-first-task-that-fails-at-the-provider-consumes
title: A first task that fails at the provider consumes the hand-off with no retry
surface: onboarding
severity: P2
status: open
found: 2026-10-20
lane: sweep/onboarding
fix:
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

_Filled in when the bug leaves the backlog: what was true, and why it is closed._

## Notes

Still open. Reconciled 2026-10-27 (reliability wave 1, quick win 37), review: `d4d64e972` (2026-10-23; an ancestor of trunk, first released in v0.14.0) is a partial fix. The first task YOUR FIRST TASK sends goes into the composer's ArrowUp recall (PitchStore.startHandoff -> Chat.rememberSent), so a first run that fails at the provider can be sent again with ArrowUp and Enter instead of retyped (test/first-task-recall.test.js, passes on this tree). Still as the Symptom says: the composer is empty after the failed run and the YOUR FIRST TASK review never comes back, because `frontend/app/pitchstore.js` startHandoff still sets `state.handoffPending = false; state.starterDone = true` when the run is launched, before its outcome is known. Not re-walked live: whether a "↻ Try again" chip shows under this error on the first-task path (chat.js offerRetry offers one for a retryable verdict such as provider_unreachable). Bringing the review back after a failed run is new UI and needs Andrew's yes; closing this record on the ArrowUp recall alone is his call.
