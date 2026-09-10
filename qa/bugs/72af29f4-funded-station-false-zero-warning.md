---
fingerprint: 72af29f4
slug: funded-station-false-zero-warning
title: Funded working station still displays a zero-credit warning
surface: providers
severity: P1
status: open
found: 2026-08-24
lane: reliability-followup
fix:
origin: customer
report: support-2026-08-24-funded-station-false-zero-warning
affected: Windows, reported 2026-08-23/24; exact build and affected account balance receipt unavailable
family: recovery-truth
installer: unverified
recovery: unconfirmed
---

# Funded working station still displays a zero-credit warning

## Symptom

The station works but a zero-credit warning contradicts the funded account.

## Repro

On the reported linked station compare current authoritative balance, selected execution provider and banner after refresh/restart.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/credits-link.test.js

Release verification 2026-09-06 re-read the original support thread. The reporter explicitly identified Windows and described a zero-credit notification on every input while work continued and purchased credits were consumed. The thread contains no authoritative balance snapshot or later recovery receipt. Candidate bd65c7737 passes the full fast and HTTP gates, including the paid-link lifecycle regressions; this does not correlate the original account to one of the repaired mechanisms.

## Verdict

Keep open pending authoritative balance/banner reproduction or customer retest. Matching fixes in v0.10.13 are not proof of the same cause.

## Regression

Exact before/after customer reproduction is pending; see Repro and Verdict.

2026-09-05, source repair `c364e991d`: a real sidecar request waiting on account history
returned its old account's zero after unlink (failed before the repair). The status route
now rejects the stale account snapshot, and retired adapters cannot emit account warnings.
Local admission holds no longer overwrite the service-observed balance or its observation
time used by status/diagnostics. Registered coverage: `test/paid-link-lifecycle.e2e.test.js`
and `test/credits.test.js`. This fixes proven mechanisms, but an affected-account/banner
receipt is still required to correlate the original customer report.

## Sibling coverage

{
  "adapters": [
    {"target":"exact affected provider or renderer","state":"blocked","reason":"The customer failure has not been reproduced on the affected configuration; baseline tests are corroboration only."}
  ],
  "entrypoints": [
    {"target":"reported user path","state":"blocked","reason":"On the reported linked station compare current authoritative balance, selected execution provider and banner after refresh/restart."}
  ],
  "displays": [
    {"target":"reported error and recovery UI","state":"blocked","reason":"Capture the actual failure and follow the offered recovery; a connected label or nearby passing test is insufficient."}
  ],
  "lifecycle": [
    {"target":"recovery and restart","state":"blocked","reason":"Requires a before/after receipt for this symptom on the affected artifact, followed by restart and the same operation."}
  ]
}

## September 10 release follow-through

An isolated in-memory account exercised the real managed gateway and upstream, returning 200 and a 0.000683 debit equal to the run receipt. The affected funded account and its rendered balance/warning were not available. No customer ledger was edited and this neighboring gateway proof does not close the false-zero UI report.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
