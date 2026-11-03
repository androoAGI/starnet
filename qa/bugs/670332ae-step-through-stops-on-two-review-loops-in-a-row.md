---
fingerprint: 670332ae
slug: step-through-stops-on-two-review-loops-in-a-row
title: STEP THROUGH stops on two review loops in a row
surface: world
severity: P2
status: fixed
found: 2026-10-12
lane: conveyor-final-runtime
fix: 28d32bbfa
origin: audit
---

# STEP THROUGH stops on two review loops in a row

## Symptom

STEP THROUGH on a line with two review loops in a row, both sending work back to the drafter, stopped with "the test stopped before style: the line loops back to style" on the outer loop's second pass, while RUN ONE REAL JOB finished the same line. The test reported a line fault that does not exist.

## Repro

1. drafter > factcheck > LOOP1 > style > LOOP2 > publisher > OUTBOX, both back lanes to the drafter.
2. STEP THROUGH with pause none; LOOP2 says revise once.
3. Before 3caf05fea `sidecar/routing/steptest.js` resolveNext set `looping = d.again`, so LOOP1 letting work out closed LOOP2's pass too.
Regression: `test/routing.steptest.test.js` two-gate case (3 failures before).
4. Wave 2 review regression of 3caf05fea: a session the OLD engine persisted (only `W.looping`, no `W.openLoops`), paused mid-pass in a loop whose body is two or more steps (drafter > editor > reviewer > LOOP back to drafter). The first CONTINUE after the update wrote `W.openLoops = {}`, an empty object reads as "no gate open", and the next hop stopped: "the test stopped before REVIEWER: the line loops back to reviewer". Rewind/rerun onto a step saved before the update broke the same way.
Regression: `test/routing.steptest.test.js` legacy case (4 failures before; the old "legacy" case started a fresh session, so it never exercised one).

## Evidence

Fix 3caf05fea: the step test keeps the open gates per gate (openLoops, a plain object that survives the JSON-cloned, persisted walk state); a session saved before keeps its old flag. routing.steptest 175, routing.steptest.multibay 28, steptest-restart-spend 21 OK. Live on the isolated station (real model): Line S, session st_a2b34c88-2b1 state done, hops p50 > p52(approved) > p54 > p55(revise) > p50 > p52(approved) > p54 > p55(revise), exhausted to the OUTBOX. C:\Users\andro\gen-trees\_final-shots\wave2-runtime\b01-b02-live-evidence.json.

Wave 2 repair 28d32bbfa: `sidecar/routing/steptest.js` resolveNext keeps a legacy session's openLoops UNSET and reads its old flag until a gate decides; from there its gates are tracked (the old single-flag meaning at that point). routing.steptest 188, routing.steptest.multibay 28, routing.steptest.e2e 59, steptest-restart-spend 21 OK; the reviewer's repro script now ends done. Live on the isolated station (real model, gemini flash lite): a drafter > editor > reviewer > LOOP line posted to the sidecar, STEP THROUGH pause every, reviewer edited to VERDICT: revise, paused after the drafter's second run, graceful quit, openLoops stripped from steptest.sessions.json (and .bak), restart (reloaded: openLoops undefined, looping true), CONTINUE through editor > reviewer (approved) > publisher: state done, walk drafter > editor > reviewer > drafter > editor > reviewer > publisher, $0.022. C:\Users\andro\gen-trees\_final-shots\wave2-runtime-r2\r1-legacy-steptest-live.json. A legacy session on a TWO-gate line behaves as the old engine did (it is not upgraded into the per-gate tracking until a gate decides); only sessions started after the update get it from the start.

## Verdict

Fixed in source on agent/conveyor-final-runtime (3caf05fea; its legacy-session regression 28d32bbfa). Live-proven.
Line-job-runner family invariant: I2: the shared typed-stop walk keeps each open review gate across consecutive loops; chain.join-loop and line-stops.invariant own the family.
