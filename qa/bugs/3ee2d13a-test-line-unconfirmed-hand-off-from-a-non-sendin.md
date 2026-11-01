---
fingerprint: 3ee2d13a
slug: test-line-unconfirmed-hand-off-from-a-non-sendin
title: station.test_line claims an unconfirmed onward hand-off for a job that landed in a non-sending OUTBOX
surface: world
severity: P2
status: fixed
found: 2026-10-13
lane: conveyor-final-runtime
fix: 28cc8a595
origin: audit
---

# station.test_line claims an unconfirmed onward hand-off for a job that landed in a non-sending OUTBOX

## Symptom

On a line with two OUTBOXes where only one has SEND TO, the lead tests the line and the job reaches the OTHER OUTBOX. The job is never handed on, yet station.test_line reports sentOnTo { state: 'unconfirmed' }, tells the lead to "Check this job again", and its summary ends "— onward hand-off unconfirmed". The residual of 0d10e82b (wave 2 review of conveyor-backend-10): that fix stopped the claim for a failed or stopped test only.

## Repro

1. Line A: INBOX > step > two OUTBOXes (a FILTER or splitter picks one); only OUTBOX 1 has SEND TO Line B.
2. station.test_line { line: 'A', job } with a job the line routes to OUTBOX 2.
3. chain onShipped -> `Pipeline.sendToOf(plan, line, dock, outboxId)` returns null, so no sentTo is ever linked; but the sample route (`sidecar/index.js` runSampleJob, the `onward.onwardDestinations = Object.values(plan.sendTo).filter(s => s.fromLine === line)` line) lists every SEND TO of the line, whatever OUTBOX was reached, and the job is o.ok, so `sidecar/tools/builtin/station.js` testLineTool reports the destination as unconfirmed.
The same route line also drops each destination's OUTBOX id (plan.sendTo values carry none; the id is the map key): seams-06 / conveyor-ui-17.

## Evidence

Traced by the wave 2 review (conveyor-backend-10 half fixed). `test/station-builder-lineops.test.js` now pins the route's real shape today ([{ lineId }] with no OUTBOX id, named, nothing invented) next to the keyed shape the route's repair will send. Not fixed here: the onwardDestinations line in sidecar/index.js is owned by the release-review lane (seams-06 / conveyor-ui-17). The fix there: build from the OUTBOX key and keep only the OUTBOX the job reached, e.g. `const st = completed && sampleLineOutcome ? Pipeline.sendToOf(plan, line, sampleLineOutcome.dockId, sampleLineOutcome.outboxId) : null; onward.onwardDestinations = st ? [{ lineId: st.toLine, outboxId: st.outboxId }] : [];` plus a route-level test on a compiled two-OUTBOX plan. The chain already knows the OUTBOX (`sidecar/routing/chain.js` sets out.outboxId from its terminal walk), but the hub's onLineOutcome record (`sidecar/channels/hub.js`, the `const lo = { agentId: line.agentId, …}` line) does not pass it on yet, so sampleLineOutcome has no outboxId: that line needs `if (line.outboxId) lo.outboxId = String(line.outboxId);` (additive) as part of the same fix.

## Verdict

Fixed in `28cc8a595` (2026-10-15; an ancestor of trunk, first released in v0.13.5). The hub's line outcome carries the chain's outboxId, and the sample route keeps only the SEND TO of the OUTBOX the job reached (each destination names its OUTBOX); when the OUTBOX is unknown it keeps the old list. A job that lands in a non-sending OUTBOX now claims no onward hand-off (`sidecar/index.js` runSampleJob onwardDestinations). Regression: test/station-builder-lineops.test.js (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
