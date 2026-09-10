---
fingerprint: eaaa3ec8
slug: mac-onboarding-unreachable-after-link
title: Mac paid onboarding becomes unreachable after reload and relink
surface: onboarding
severity: P1
status: open
found: 2026-08-22
lane: reliability-followup
fix:
origin: customer
report: https://github.com/androoAGI/starnet/issues/2
affected: Reported Mac installation; exact failing artifact unverified
family: recovery-truth
installer: unverified
recovery: unconfirmed
---

# Mac paid onboarding becomes unreachable after reload and relink

## Symptom

Paid onboarding enters reload/unlink recovery and leaves the station unreachable.

## Repro

Customer path: complete linking on Mac, reload, then follow unlink/relink recovery. Exact local hardware reproduction remains unavailable.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/station-recovery.e2e.test.js

## Verdict

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
    {"target":"exact affected provider or renderer","state":"blocked","reason":"The customer failure has not been reproduced on the affected configuration; baseline tests are corroboration only."}
  ],
  "entrypoints": [
    {"target":"reported user path","state":"blocked","reason":"Customer path: complete linking on Mac, reload, then follow unlink/relink recovery. Exact local hardware reproduction remains unavailable."}
  ],
  "displays": [
    {"target":"reported error and recovery UI","state":"blocked","reason":"Capture the actual failure and follow the offered recovery; a connected label or nearby passing test is insufficient."}
  ],
  "lifecycle": [
    {"target":"recovery and restart","state":"blocked","reason":"Requires a before/after receipt for this symptom on the affected artifact, followed by restart and the same operation."}
  ]
}

## September 10 release follow-through

Both Apple Silicon and Intel artifacts built and notarized on candidate afd1da77f (workflow 34535931055). Earlier Intel installed acceptance passed; exact-candidate acceptance is tracked in the release follow-through. No physical Apple Silicon paid-account onboarding/relink or microphone proof was available. Build/notarization cannot close this customer report.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
