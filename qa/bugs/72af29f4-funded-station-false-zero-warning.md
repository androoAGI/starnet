---
fingerprint: 72af29f4
slug: funded-station-false-zero-warning
title: Funded working station still displays a zero-credit warning
surface: providers
severity: P1
status: fixed
found: 2026-08-24
lane: reliability-followup
fix: c364e991d8d9c0c4d446c9978b8d31c33fcbe09d
origin: customer
report: support-2026-08-24-funded-station-false-zero-warning
affected: Windows, reported 2026-08-23/24; exact build and affected account balance receipt unavailable
family: recovery-truth
installer: unverified
recovery: unconfirmed
---

## September 11 engineering disposition

Engineering work closed for the reproduced stale-account zero balance, retired-adapter warning and admission-hold balance corruption mechanisms. Live before/after sidecar requests and installed-sidecar regressions prove these repairs. The original account correlation remains unknown. Customer confirmation is not a prerequisite for this source closure. `recovery: unconfirmed` remains unchanged, and no new installer-specific outcome is inferred. Earlier open/pending statements below are historical and are superseded by this engineering decision. See `docs/releases/0.11.2/PUBLIC_RELEASE.md`.


# Funded working station still displays a zero-credit warning

## Symptom

The station works but a zero-credit warning contradicts the funded account.

## Repro

On the reported linked station compare current authoritative balance, selected execution provider and banner after refresh/restart.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/credits-link.test.js

Release verification 2026-09-06 re-read the original support thread. The reporter explicitly identified Windows and described a zero-credit notification on every input while work continued and purchased credits were consumed. The thread contains no authoritative balance snapshot or later recovery receipt. Candidate bd65c7737 passes the full fast and HTTP gates, including the paid-link lifecycle regressions; this does not correlate the original account to one of the repaired mechanisms.

## Verdict

Current disposition: Engineering work closed for the reproduced stale-account zero balance, retired-adapter warning and admission-hold balance corruption mechanisms. Live before/after sidecar requests and installed-sidecar regressions prove these repairs. The original account correlation remains unknown.

Historical investigation notes (superseded for engineering closure):

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
    {
      "target": "linked credit service",
      "state": "covered",
      "test": "test/paid-link-lifecycle.e2e.test.js",
      "scenario": "delayed old-account balance cannot replace current link state",
      "gate": "http"
    }
  ],
  "entrypoints": [
    {
      "target": "status after unlink or replacement",
      "state": "covered",
      "test": "test/paid-link-lifecycle.e2e.test.js",
      "scenario": "pending account replies lose authority after unlink and replacement",
      "gate": "http"
    }
  ],
  "displays": [
    {
      "target": "affected account banner",
      "state": "blocked",
      "reason": "Affected-customer retest remains unconfirmed; this does not prevent closing the independently reproduced and verified source repair under the owner decision of September 11."
    }
  ],
  "lifecycle": [
    {
      "target": "link and balance across restart",
      "state": "covered",
      "test": "test/paid-link-lifecycle.e2e.test.js",
      "scenario": "funded diagnostics and unlink state survive restart",
      "gate": "http"
    },
    {
      "target": "local admission holds",
      "state": "covered",
      "test": "test/credits.test.js",
      "scenario": "holds do not overwrite service-observed balance",
      "gate": "fast"
    }
  ]
}

## September 10 release follow-through

An isolated in-memory account exercised the real managed gateway and upstream, returning 200 and a 0.000683 debit equal to the run receipt. The affected funded account and its rendered balance/warning were not available. No customer ledger was edited and this neighboring gateway proof does not close the false-zero UI report.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.

## September 11 packaged-sidecar check

The installed Windows canary executable was hash-verified as 7f6c7b005, then its bundled Node executable and installed sidecar ran the six paid-link lifecycle scenarios in isolated temporary profiles. Pairing/keychain-recovery races, stale account zero balances, replacement and diagnostics passed with simulated upstream services. This is stronger bundle coverage, not affected-account or Mac keychain recovery. Logs: release preparation worktree `.dogfood/customer-execution/bundled-paid-link.log`.
