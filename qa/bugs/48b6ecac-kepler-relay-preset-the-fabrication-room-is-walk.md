---
fingerprint: 48b6ecac
slug: kepler-relay-preset-the-fabrication-room-is-walk
title: Kepler Relay preset: the fabrication room is walkable but not reachable from command
surface: world
severity: P2
status: open
found: 2026-10-27
lane: gate-seams
fix:
origin: unknown
---

# Kepler Relay preset: the fabrication room is walkable but not reachable from command

## Symptom

In the Kepler Relay station preset (the showcase layout built by `dev/kepler-showcase.cjs` and shipped as `frontend/app/kepler-showcase.js`), the fabrication room has walkable floor, but no walkable path connects it to the command room, so a crew member seated in command cannot walk to fabrication. The preset's own regression test has been red since 2026-09-16 and was on no gate list, so nobody saw it.

## Repro

1. Check out `agent/gate-seams` (it changes no file the test reads relative to trunk 5203fa2ee: `frontend/`, `dev/kepler-showcase.cjs` and the test are identical).
2. Run `node test/kepler-showcase.test.js`.
3. Observe `not ok 1 - Kepler preview has legal props, reachable rooms and an intake-to-outbox crew line`, failing assertion `fabrication reachable from command` (`test/kepler-showcase.test.js:32`), exit 1.

## Evidence

`node test/kepler-showcase.test.js` on agent/gate-seams, 2026-10-27: exit 1, TAP `not ok 1`, `error: 'fabrication reachable from command'`, `expected: true`, stack at `test/kepler-showcase.test.js:32:12`. The gate-seams lane's bisect over commits touching `frontend/app` and `dev/kepler-showcase.cjs` (git archive per commit, read-only) named 45fd0b096 (2026-09-16, "merge: synchronize station before seating integration") as the first failing commit; its parent 99dfdad3c passes. That bisect was run by the lane's builder and not repeated for this record. The test is listed in UNGATED in `test/test-list-completeness.test.js` with this record as its reason; gate it on `test/fast.list` once it is green.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._
