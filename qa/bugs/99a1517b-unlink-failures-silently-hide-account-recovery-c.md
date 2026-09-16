---
fingerprint: 99a1517b
slug: unlink-failures-silently-hide-account-recovery-c
title: Unlink failures silently hide account recovery controls
surface: onboarding
severity: P1
status: fixed
found: 2026-09-15
lane: credits-unlink-recovery
fix: 02332ee85
origin: customer
report: Private support email, 2026-09-15: unlink reports completion but no new link option appears
affected: Customer build and operating system unknown; related failure paths reproduced in source 0.11.2
family: recovery-truth
installer: unverified
recovery: unconfirmed
---

# Unlink failures silently hide account recovery controls

## Symptom

A customer reports attempting to unlink an old account but seeing no option to link the funded account afterward. The affected build, operating system and exact UI state are not available. The payment and account allocation were independently checked; this record concerns account-link recovery, not a missing payment.

## Repro

1. Open Settings → Providers → STORE with a synthetic saved device link.
2. Make the desktop credential-clear command reject, or make `/api/credits/unlink` return HTTP 500 with `ok:false`.
3. Click UNLINK and CONFIRM UNLINK. Before the repair the old panel returns without an error.
4. Separately, successfully unlink but fail the next `/api/credits/linkable` read. Before the repair STORE becomes empty with no retry or link control.
5. Execute `node test/credits-store-recovery.test.js` for native failures, malformed/failed acknowledgments, unavailable status, retry, pending state and out-of-order reads.

## Evidence

The production handlers in `frontend/app/stationui.js` previously discarded unlink errors with `.catch(() => wireCredits(body))`. They did not inspect `Harness.api.post`'s `{ok,status,j}` envelope. STORE treated every status-read failure as unconfigured, then treated a failed linkability read as unavailable and left the panel blank.

Live seeded source verification used synthetic accounts and controlled failures at the native/HTTP boundary. No customer credentials or balances were changed. Before repair a rejected credential-clear command returned `This station is linked to your account. UNLINK` with no error. After repair the same rejection displayed `Could not clear the saved account credential. Unlink was not completed.` An HTTP unlink failure displayed `Could not confirm that unlink completed.` A linkability outage displayed `Could not check your account connection` with RETRY.

The new regression fails against the pre-repair source because the expected credential-clear error is absent. The repaired source passes. Existing `test/credits-link.test.js` passed 95 assertions and `test/paid-link-lifecycle.e2e.test.js` passed six scenarios, including delayed responses and restart.

The seeded running app also completed the ordinary account switch: UNLINK and CONFIRM exposed LINK STATION, the new pairing code was confirmed in the local synthetic cloud, and STORE showed the synthetic funded account with a $25 balance. The customer-journey gate passed all 34 journeys. These are source-level results; they do not establish recovery on the affected installation.

All 782 fast-list steps passed across the initial 445 successful steps and a 337-step continuation. The initial run stopped on the required website-mirror equality check; `sync:website` regenerated the two changed JavaScript copies, the equality check passed, and the continuation reran that check through the end of the manifest. The mirror verifier and bug-register validator also passed.

## Verdict

The independently reproduced UI error handling and stale-read defects are repaired in this lane. Keep the customer report open: these controlled failures have not been correlated to the original machine, and no affected-installer or customer-recovery claim is made. The ordinary success path was already functional; a successful happy-path test alone did not resolve the report.

## Regression

### 0.12.0 preparation reconciliation — 2026-09-16

Source repair `02332ee85` is included through integration `90d6f0111`. Fresh ancestry inspection confirms the preparation baseline contains it; the earlier lane-only wording is historical. This does not correlate the original customer machine or prove an installed update. Keep the report open and use `docs/releases/0.12.0/BUG_DISPOSITION.md` for remaining acceptance.

`test/credits-store-recovery.test.js` executes the production STORE functions with the real ArmConfirm helper. It covers native rejection and synchronous failure; HTTP 500, negative/missing unlink acknowledgments and network failure; unavailable/malformed account status; failed linkability reads and retry; delayed reads; pending-state repaint; successful unlink; and explicit BYOK-only absence. Errors remain visible across redraws and never expose raw native errors. Pairing starts a new operation and clears the previous unlink warning.

## Sibling coverage

{
  "adapters": [
    {"target":"desktop credential clear and sidecar HTTP acknowledgment","state":"covered","test":"test/credits-store-recovery.test.js","scenario":"native rejection, synchronous throw, HTTP error and incomplete acknowledgment","gate":"fast"},
    {"target":"physical operating-system credential stores","state":"blocked","reason":"Controlled boundary failures prove UI handling; the customer's operating system and exact installer are unavailable."}
  ],
  "entrypoints": [
    {"target":"Settings STORE unlink and read retry","state":"covered","test":"test/credits-store-recovery.test.js","scenario":"confirmed unlink failure remains actionable and retry restores linking after read failure","gate":"fast"},
    {"target":"first-run account switching","state":"covered","test":"test/credits-store-recovery.test.js","scenario":"native failures and negative or incomplete unlink acknowledgments cannot start pairing; a positive acknowledgment can","gate":"fast"}
  ],
  "displays": [
    {"target":"STORE progress, errors and link controls","state":"covered","test":"test/credits-store-recovery.test.js","scenario":"pending and error state survive repaint and late old-account reads cannot hide linking","gate":"fast"}
  ],
  "lifecycle": [
    {"target":"device-link persistence and delayed replies","state":"covered","test":"test/paid-link-lifecycle.e2e.test.js","scenario":"unlink wins over unfinished pairing and keychain recovery through restart","gate":"http"},
    {"target":"affected customer installation","state":"blocked","reason":"No affected-build reproduction or customer recovery evidence; record remains open."}
  ]
}
