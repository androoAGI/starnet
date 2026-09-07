---
fingerprint: c2a6c3c8
slug: once-routine-reported-missing
title: Customer reports an ONCE routine absent from Active Routines
surface: autonomy
severity: P1
status: open
found: 2026-09-01
lane: reliability-followup
fix:
origin: customer
report: support-2026-09-01-once-routine-reported-missing
affected: Windows 11 v0.10.12; version corrected by reporter in follow-up on 2026-09-01
family: durability-and-visibility
installer: unverified
recovery: unconfirmed
---

# Customer reports an ONCE routine absent from Active Routines

## Symptom

INBOX creation appears successful but the routine cannot be found in Active Routines.

## Repro

Customer path: create an ONCE routine from INBOX, open Active Routines, then restart. Current source reproduces related confirmation races but not the historical disappearance.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/cron.api.test.js

Release verification 2026-09-06 re-read the original support thread and attached Markdown report. The reporter corrected v0.9.0 to v0.10.12 and identified Windows 11. INBOX → FIRES AT RESEARCHER → ONCE returned success twice, while AUTOMATION showed NO ROUTINES YET, including after restart. No job ID, save/list response, or later recovery confirmation was supplied. The exact candidate bd65c7737 passes the full 101-suite HTTP gate; those local fixtures do not establish the historical disappearance's cause.

## Verdict

Keep historical disappearance open. 2b976f5f3 repairs false confirmation and preserves drafts after ambiguous saves; docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md explicitly says historical loss did not reproduce. Need affected job id and sanitized save/list diagnostics.

## Regression

Exact before/after customer reproduction is pending; see Repro and Verdict.

2026-09-05 local recheck on source `94bff3a5f`: the real INBOX UI passed create/readback,
stale-arm, lost acknowledgement, missing-row and duplicate cases. Restarting the seeded
sidecar with `--keep` preserved exactly one named ONCE routine visible in Active Routines.
See `qa/digests/2026-09-05-release-blockers.md`. Historical disappearance and installer/customer
recovery remain unverified; no closure inferred from this passing local path.

## Sibling coverage

{
  "adapters": [
    {"target":"exact affected provider or renderer","state":"blocked","reason":"The customer failure has not been reproduced on the affected configuration; baseline tests are corroboration only."}
  ],
  "entrypoints": [
    {"target":"reported user path","state":"blocked","reason":"Customer path: create an ONCE routine from INBOX, open Active Routines, then restart. Current source reproduces related confirmation races but not the historical disappearance."}
  ],
  "displays": [
    {"target":"reported error and recovery UI","state":"blocked","reason":"Capture the actual failure and follow the offered recovery; a connected label or nearby passing test is insufficient."}
  ],
  "lifecycle": [
    {"target":"recovery and restart","state":"blocked","reason":"Requires a before/after receipt for this symptom on the affected artifact, followed by restart and the same operation."}
  ]
}
