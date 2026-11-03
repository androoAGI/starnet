---
fingerprint: 32df5ca7
slug: a-hand-off-whose-dispatch-throws-is-dropped-with
title: A hand-off whose dispatch throws is dropped with only a console line
surface: world
severity: P2
status: fixed
found: 2026-10-12
lane: conveyor-final-runtime
fix: 9ccd2ba42
origin: audit
---

# A hand-off whose dispatch throws is dropped with only a console line

## Symptom

A SEND TO hand-off whose dispatch threw (the hub could not be built, or its entry threw) was dropped with only a console line, against the hand-off runner's own rule that every drop is said, and the target line's job record it had already started stayed "running".

## Repro

1. makeHub throws for the target line.
2. A job ships on the sending line.
3. Before e4586a54c the pump() catch in `sidecar/routing/handoff-runner.js` only pushed to the status list and warned.
Regression: `test/routing.handoff.test.js` dispatch-throw block (record stuck running before).

## Evidence

Fix e4586a54c: the record already started is finished with "the hand-off could not start (…)", otherwise the refusal path writes one; the unused item.files/item.input are gone, status() is stated as a diagnostic read, and line-shipments exports the one productive-work predicate line-stats reads. routing.handoff 88, line-stats 269, joined-product-truth, routing.triggers, conveyor-ease 80, station-layout 256 OK. Not live-proven (needs an injected hub fault).

Wave 2 review: e4586a54c finished the target record but left the SENDING job linked as plain sentTo (dispatch links it as soon as the target record starts), so its card read "Sent on to LINE B — that line works on this result next" and the OUTBOX provenance "SENT ON TO LINE B" for a hand-off that never started. Repair 9ccd2ba42 (`sidecar/routing/handoff-runner.js` pump catch): a throw before the target line was entered re-links the sender NOT sent on, with why; a throw after it was entered says "the hand-off broke after it started (…)" and keeps the plain link (the work did reach that line). `test/routing.handoff.test.js` (2 failures before). Unit-proven only: a dispatch throw cannot be produced on a healthy station.

## Verdict

Fixed in source on agent/conveyor-final-runtime (e4586a54c; the sender's link 9ccd2ba42); unit-proven.
Line-job-runner family invariant: I7: the shared job book finishes an admitted SEND TO record once; pre-entry refusal and post-entry stage failure preserve the exact sender link and cause.
