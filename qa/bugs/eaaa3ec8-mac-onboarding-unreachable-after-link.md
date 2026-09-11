---
fingerprint: eaaa3ec8
slug: mac-onboarding-unreachable-after-link
title: Mac paid onboarding becomes unreachable after reload and relink
surface: onboarding
severity: P1
status: fixed
found: 2026-08-22
lane: reliability-followup
fix: c364e991d8d9c0c4d446c9978b8d31c33fcbe09d
origin: customer
report: https://github.com/androoAGI/starnet/issues/2
affected: Reported Mac installation; exact failing artifact unverified
family: recovery-truth
installer: unverified
recovery: unconfirmed
---

## September 11 engineering disposition

Engineering work closed for the reproduced pairing/keychain recovery races that undid an explicit unlink. Delayed replies now preserve the current link generation through restart; source and packaged-sidecar regressions passed. The physical affected Mac and its original cause remain unconfirmed; no Apple Silicon customer recovery is asserted. Customer confirmation is not a prerequisite for this source closure. `recovery: unconfirmed` remains unchanged, and no new installer-specific outcome is inferred. Earlier open/pending statements below are historical and are superseded by this engineering decision. See `docs/releases/0.11.2/PUBLIC_RELEASE.md`.


# Mac paid onboarding becomes unreachable after reload and relink

## Symptom

Paid onboarding enters reload/unlink recovery and leaves the station unreachable.

## Repro

Customer path: complete linking on Mac, reload, then follow unlink/relink recovery. Exact local hardware reproduction remains unavailable.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/station-recovery.e2e.test.js

## Verdict

Current disposition: Engineering work closed for the reproduced pairing/keychain recovery races that undid an explicit unlink. Delayed replies now preserve the current link generation through restart; source and packaged-sidecar regressions passed. The physical affected Mac and its original cause remain unconfirmed; no Apple Silicon customer recovery is asserted.

Historical investigation notes (superseded for engineering closure):

Keep open in engineering intake despite upstream issue closure. Related station-recovery fixes and tag ancestry do not prove this customer path. Requires physical Mac, exact installer and link-state receipts.

Release verification 2026-09-06: CI 34070924471 built and notarized both Mac architectures for bd65c7737. Intel installed acceptance passed Finder launch, sidecar startup, legacy-state preservation and restart. That fixture does not exercise a paid account or the affected Apple Silicon keychain/relink path. The exact current fast/HTTP gates also pass the paid-link regressions. Physical affected-account acceptance remains outstanding.

## Regression

2026-09-06: owner reports no available Mac tester and requests work from known evidence.
The three pending cloud repairs, including magic-link SameSite session recovery, are now
deployed and verified as documented in `docs/RELEASE_FOLLOWTHROUGH_2026-09-06.md`. Issue #2
was re-read: the original symptom is the native STATION DATA UNREACHABLE screen after
reload/unlink, not merely a browser sign-in redirect. Therefore the cloud cookie repair
is not relabeled as this report's proven cause. Source recovery regressions pass; affected
Apple Silicon recovery remains unconfirmed.

Exact before/after customer reproduction is pending; see Repro and Verdict.

2026-09-05, source repair `c364e991d`: live sidecar reproductions proved that delayed
pairing and keychain-recovery replies both undid an explicit unlink. Both failed before
the repair and now preserve unlink through restart. `test/paid-link-lifecycle.e2e.test.js`
also covers an old balance check arriving after a newer funded pairing, and funded link
diagnostics across restart. `test/credits-link.test.js` covers a consumed confirmation
retried after disk failure, an interrupted unlink with both files left behind, and a stalled
whoami response body. These are registered fast/HTTP regressions. They do not establish
the exact Mac customer's cause; installed Apple Silicon/keychain verification remains open.

## Sibling coverage

{
  "adapters": [
    {
      "target": "pairing and keychain recovery responses",
      "state": "covered",
      "test": "test/paid-link-lifecycle.e2e.test.js",
      "scenario": "delayed pairing and whoami replies cannot undo unlink",
      "gate": "http"
    }
  ],
  "entrypoints": [
    {
      "target": "unlink, replacement and recovery",
      "state": "covered",
      "test": "test/credits-link.test.js",
      "scenario": "interrupted unlink and consumed confirmation retry preserve recoverability",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "affected native Mac UI",
      "state": "blocked",
      "reason": "Affected-customer retest remains unconfirmed; this does not prevent closing the independently reproduced and verified source repair under the owner decision of September 11."
    }
  ],
  "lifecycle": [
    {
      "target": "link state restart",
      "state": "covered",
      "test": "test/paid-link-lifecycle.e2e.test.js",
      "scenario": "unlinked and replacement account state persist through restart",
      "gate": "http"
    }
  ]
}

## September 10 release follow-through

Both Apple Silicon and Intel artifacts built and notarized on candidate afd1da77f (workflow 34535931055). Earlier Intel installed acceptance passed; exact-candidate acceptance is tracked in the release follow-through. No physical Apple Silicon paid-account onboarding/relink or microphone proof was available. Build/notarization cannot close this customer report.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.

## September 11 packaged-sidecar check

The installed Windows canary executable was hash-verified as 7f6c7b005, then its bundled Node executable and installed sidecar ran the six paid-link lifecycle scenarios in isolated temporary profiles. Pairing/keychain-recovery races, stale account zero balances, replacement and diagnostics passed with simulated upstream services. This is stronger bundle coverage, not affected-account or Mac keychain recovery. Logs: release preparation worktree `.dogfood/customer-execution/bundled-paid-link.log`.
