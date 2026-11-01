---
fingerprint: 0d10e82b
slug: station-test-line-claims-an-unconfirmed-onward-h
title: station.test_line claims an unconfirmed onward hand-off for a failed test
surface: world
severity: P2
status: fixed
found: 2026-10-12
lane: conveyor-final-runtime
fix: 8968a9269
origin: audit
---

# station.test_line claims an unconfirmed onward hand-off for a failed test

## Symptom

The lead tested a line, a step errored and the status was problem, yet station.test_line still said "tested X: problem ($0.04) — onward hand-off unconfirmed" and told the lead to check the job again (a failed job is never handed on), and listed destinations as bare machine ids ([{ lineId: 'p37' }]) the lead could not name.

## Repro

1. A line with SEND TO; a step on it fails.
2. The lead calls station.test_line on it.
3. Before 8968a9269 `sidecar/tools/builtin/station.js` reported `o.onwardDestinations` for any job, unnamed.
Regression: `test/station-builder-lineops.test.js` (3 failures before).

## Evidence

Fix 8968a9269: only a job that reached its OUTBOX reports unconfirmed destinations, each named through station.line_ref (the page's own line naming) with its OUTBOX id when the route gives one. station-builder-lineops 66, station-tools 80, builder-lend, line-test-stop, station-builder, payload.budget OK. Not live-proven through a lead run. The sample route's own onwardDestinations still lacks the OUTBOX id (seams-06 / conveyor-ui-17, owned by the release-review lane).

## Verdict

Fixed in source on agent/conveyor-final-runtime (8968a9269); unit-proven. Residual (wave 2 review): on a line with two OUTBOXes where only one sends, a job that reaches the other one still reports an unconfirmed hand-off, because the route lists every SEND TO of the line; filed as 3ee2d13a (open, the route line belongs to the release-review lane: seams-06 / conveyor-ui-17).

Reconciled 2026-10-27 (reliability wave 1, quick win 37): `8968a9269` is an ancestor of trunk and first released in v0.13.5. The residual is closed too: 3ee2d13a was fixed in `28cc8a595` (same release), so the route names only the SEND TO of the OUTBOX the job reached.
