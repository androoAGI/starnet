---
fingerprint: 1619dab8
slug: cli-app-launch-e2e-keeps-running-for-minutes-aft
title: cli-app-launch e2e keeps running for minutes after a failed assertion instead of exiting
surface: release
severity: P2
status: open
found: 2026-10-27
lane: gate-seams
fix:
origin: unknown
---

# cli-app-launch e2e keeps running for minutes after a failed assertion instead of exiting

## Symptom

When `test/cli-app-launch.e2e.test.js` fails its "the app (started for another terminal) brought its station up" assertion, the test does not finish: it runs on until the gate runner's step bound kills it (120 s at the time; it is now on `test/slow.list` for its healthy 52-71 s runtime, so a repeat would run until 600 s). The two HTTP-gate steps right after it then failed in that run, which suggests the app it launched in the background was still holding resources when they started.

## Repro

1. On Windows, under heavy machine load (other agent gates running, under 1 GB free RAM), run `npm run test:http` on `agent/gate-seams` until the station-up assertion of `test/cli-app-launch.e2e.test.js` fails (not reproduced on demand: every healthy run passes in 52-71 s).
2. Observe the FAIL line, then no further output from the step until the runner's timeout kills its process tree.
3. Healthy reference: `node scripts/run-test-list.mjs test/http.list cli-app-launch` passes 37 assertions.

## Evidence

`C:/Users/andro/gen-trees/_logs/gate-seams-http-1.log` (full HTTP gate on agent/gate-seams, 2026-10-27), lines 997-999: `FAIL: the app (started for another terminal) brought its station up`, then `run-test-list: step 218/261 TIMED OUT after 120.0s — killing its process tree: node test/cli-app-launch.e2e.test.js`. Step 219 `test/interrupted-run-in-history.test.js` then failed with `Error: sidecar boot timeout`, and step 220 `test/procledger.windows-orphan.test.js` failed (`wrapper and grandchild are both in the process table`). Healthy runtimes of the same step: 61.7 s (gate-seams-http-rerun-1.log), 71.0 s (gate-seams-http-slowsteps-1.log), 52.7 s (gate-seams-http-2.log). Not root-caused: the test's `finally` (lines 231-237) kills its terminals, the lock-file pid and the station owner, so the open question is what runs between the failed assertion and that `finally` (the later `waitFor` / `stationUp` waits) and whether a background app outlives it.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
