---
fingerprint: 79867817
slug: managed-image-charge-missing-from-run-cost
title: Managed image charge is omitted from run cost receipts
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: audit-0112-0910
fix:
origin: audit
---

# Managed image charge is omitted from run cost receipts

## Symptom

A completed image run reports usd:0 and emits only zero-dollar agent.cost events despite a simulated managed wallet debit of $0.025. This is an accounting disclosure gap in the newly enabled managed-image path; the tested wallet debit itself is correct.

## Repro

Run node scripts/qa/audit-0112/image-ledger.cjs. This extends test/managed-image.e2e.test.js only to capture wallet deltas and emitted cost/end receipts. Use zero-cost conversation responses and an image response with usage.cost=0.02; the simulated gateway debits 0.025 including margin. Repeat after restart.

## Evidence

qa/evidence/0.11.2-audit/audit-image-ledger-0.json and audit-image-ledger-1.json show debit 0.025 and agent.run.end.usd=0. sidecar/tools/builtin/image.js:286 returns content/summary without forwarding response usage; sidecar/loop.js:1228 accounts conversation inference. test/managed-image.e2e.test.js checks the wallet but does not compare its debit with the local run total. These are actual sidecar events against a simulated gateway, not production billing records.

## Verdict

Open. Carry provider-reported media usage and its actual managed charge into attributed local run-cost receipts without issuing a second gateway debit. Include mixed-provider media, failures after billable upstream work, cancellation, retries and restart. Audit budget enforcement as a related unverified gap; this probe did not prove that a particular customer exceeded a configured cap.
