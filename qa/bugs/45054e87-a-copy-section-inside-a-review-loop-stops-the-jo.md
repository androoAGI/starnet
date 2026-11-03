---
fingerprint: 45054e87
slug: a-copy-section-inside-a-review-loop-stops-the-jo
title: A COPY section inside a review loop stops the job on its second pass
surface: world
severity: P2
status: fixed
found: 2026-10-12
lane: conveyor-final-runtime
fix: d3bf4937d
origin: audit
---

# A COPY section inside a review loop stops the job on its second pass

## Symptom

A line with a COPY section inside a review loop (INBOX > drafter > COPY split > two crew > JOINER > reviewer > LOOP back to the drafter > OUTBOX) stopped with "⚠ the work line stopped early — the line loops back to factcheck" the first time the reviewer said revise, so the job never got its second review. The same line finished when its branches ran one after another.

## Repro

1. Build the line above with every step crewed; the reviewer answers VERDICT: revise once, then approved.
2. RUN ONE REAL JOB (or SEND IT A JOB in WORKFLOWS).
3. Before d3bf4937d the job stops after the first review: runBatch in `sidecar/routing/chain.js` refused any visited branch (`if (visited[k]) return { refused: ... }`) without reading the open loop pass.
Regression: `test/chain-audit-1010.test.js` section 6 (4 failures on the old code, parallel only; the one-after-another walk already passed).

## Evidence

Fix d3bf4937d: runBatch reads the loop pass like the sequential hop and counts those hops off the stage ceiling. test/chain-audit-1010.test.js 145 assertions OK; chain.join-loop, chain, chain.limits, chain.multibay, routing.chain-seam.e2e, splitter-divide, joined-product-truth OK. Live on the isolated station (real model): Line L, reviewer never approves, LOOP max 1 — job-c630b4bd4e90 DONE, 8 steps, both COPY branches started within 7 ms of each other on both passes. C:\Users\andro\gen-trees\_final-shots\wave2-runtime\b01-looped-copy-line-done-8-steps.jpg and b01-b02-live-evidence.json.

## Verdict

Fixed in source on agent/conveyor-final-runtime (d3bf4937d). Combined fast/HTTP gates are owned by the coordinator.
Line-job-runner family invariant: I2: a COPY section may repeat within its drawn loop pass; the shared walk keeps branch accounting, loop bounds, and typed stops.
