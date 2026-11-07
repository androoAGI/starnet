---
fingerprint: b295999b
slug: a-short-lived-process-on-the-old-engine-s-recycl
title: A short-lived process on the old engine's recycled PID gave a false WORKSPACE_BUSY at start
surface: release
severity: P2
status: fixed
found: 2026-11-07
lane: release-0150
fix: b53565c2987ee82a773f3ccac4ceb28a0c38b952
origin: audit
---

# A short-lived process on the old engine's recycled PID gave a false WORKSPACE_BUSY at start

## Symptom

StarNet refused to start with WORKSPACE_BUSY after an earlier engine had gone, and the user saw Retry/Cancel. It happened when a short-lived process held the old engine's recycled PID at the moment of the check.

## Repro

1. Have a workspace claim whose stamped PID belongs to a live short-lived process, as in `test/workspace-owner.test.js`.
2. Start a contender with the real probe (`sidecar/process-identity.js`). `kill(0)` answers alive, then the process exits during the probe, which takes a second or more.
3. Before the fix, the probe's `unknown` verdict in `holderDead` in `sidecar/workspace-owner.js` read as busy, so the boot was refused.

## Evidence

- Pre-tag T0 run 42329619516: idle-close, exit 73, WORKSPACE_BUSY, "PID 3088 is running but its start time could not be read (Get-Process : Cannot find a process...)".
- Real short-lived holder and real probe: 5 of 5 refused before the fix, 5 of 5 proceeded after.
- `test/workspace-owner.test.js` passes on b53565c29 with 135 assertions. The code path is unchanged since 0.14.2.

## Verdict

kill(0) is now asked once more after an unknown verdict. Only ESRCH answers false and a live holder never answers ESRCH, so it is the same proof as the first look.
