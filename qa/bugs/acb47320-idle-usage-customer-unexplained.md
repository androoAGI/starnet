---
fingerprint: acb47320
slug: idle-usage-customer-unexplained
title: Customer cannot explain idle behavior and unexpectedly high usage
surface: autonomy
severity: P1
status: open
found: 2026-09-01
lane: reliability-followup
fix:
origin: customer
report: support-2026-09-01-idle-usage-customer-unexplained
affected: Exact affected build/platform not recorded in sanitized evidence
family: work-and-spend-truth
installer: unverified
recovery: unconfirmed
---

# Customer cannot explain idle behavior and unexpectedly high usage

## Symptom

Customer sees idle agents and unexpected usage without a clear explanation of scheduled work.

## Repro

Collect the affected run ledger, chosen provider/model, armed routines/loops/night shift and expected work cadence, then reconcile usage to actual work.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/provider-recovery.e2e.test.js

## Verdict

Open investigation, not an established billing defect. No customer run ledger was supplied. Seeded idle awaiting orders is not itself a scheduler failure; do not fix by inventing activity or adding arbitrary caps.

Release verification 2026-09-06: the exact bd65c7737 Guardian and 130/130 journey assertions pass, including idle-state truth checks. The owner's installed station reports zero active runs and retains a healthy daily routine after upgrade; that is a different station, not a substitute for the affected customer's usage ledger. No affected-account cost reconciliation or customer recovery can be claimed without the missing run/provider/background-work evidence.

## Regression

Exact before/after customer reproduction is pending; see Repro and Verdict.

## Sibling coverage

{
  "adapters": [
    {"target":"exact affected provider or renderer","state":"blocked","reason":"The customer failure has not been reproduced on the affected configuration; baseline tests are corroboration only."}
  ],
  "entrypoints": [
    {"target":"reported user path","state":"blocked","reason":"Collect the affected run ledger, chosen provider/model, armed routines/loops/night shift and expected work cadence, then reconcile usage to actual work."}
  ],
  "displays": [
    {"target":"reported error and recovery UI","state":"blocked","reason":"Capture the actual failure and follow the offered recovery; a connected label or nearby passing test is insufficient."}
  ],
  "lifecycle": [
    {"target":"recovery and restart","state":"blocked","reason":"Requires a before/after receipt for this symptom on the affected artifact, followed by restart and the same operation."}
  ]
}

## September 10 release follow-through

The installed Windows canary on fbaab109f completed twenty minutes idle with no usage increase, followed by three renderer recovery faults. Real task costs matched their run receipts; an isolated managed gateway probe debited exactly its recorded 0.000683 cost. This does not identify the affected account's unexplained usage. Its run ledger, armed background work and provider receipts remain required.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
