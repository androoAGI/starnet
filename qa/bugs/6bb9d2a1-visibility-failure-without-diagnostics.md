---
fingerprint: 6bb9d2a1
slug: visibility-failure-without-diagnostics
title: Customer reports unusable visibility without build or platform details
surface: onboarding
severity: P2
status: open
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: customer
report: support-2026-09-13-unspecified-visibility-failure
affected: Build, platform, app versus website and affected screen unknown
family: uncorrelated-visibility
installer: unverified
recovery: unconfirmed
---

# Customer reports unusable visibility without build or platform details

## Symptom

A customer reports being unable to see usable StarNet content. The message contains no screenshot, diagnostic, version or specific UI state.

## Repro

Exact reproduction is unavailable. Capture the screen, entry point, StarNet version, display scaling and Boot Guard or native diagnostics without resetting the station.

## Evidence

The September 13 private report and owner request for the running version were reviewed in the September 16 intake refresh. No later diagnostic reply was found by the scoped StarNet search. Investigation anchors: frontend/index.html and test/bootguard.test.js; these are investigation entry points, not evidence of this report's cause.

## Verdict

Open P2 as uncorrelated evidence. Do not merge it into a particular boot, graphics or contrast defect without a matching observation. Passing current graphics checks does not confirm this customer's recovery.
