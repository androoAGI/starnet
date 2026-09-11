---
fingerprint: c2a6c3c8
slug: once-routine-reported-missing
title: Customer reports an ONCE routine absent from Active Routines
surface: autonomy
severity: P1
status: fixed
found: 2026-09-01
lane: reliability-followup
fix: 2b976f5f3df07473b2df8963690421f83ce0a45f
origin: customer
report: support-2026-09-01-once-routine-reported-missing
affected: Windows 11 v0.10.12; version corrected by reporter in follow-up on 2026-09-01
family: durability-and-visibility
installer: unverified
recovery: unconfirmed
---

## September 11 engineering disposition

Engineering work closed for the reproduced false routine-creation confirmation and lost-acknowledgement paths. INBOX now confirms the persisted job through a fresh list and preserves the draft on ambiguity. Real UI creation/readback and installed update/restart/due-time checks retained exactly one routine and completed it once. The original missing job cannot be reconstructed without its historical data. Customer confirmation is not a prerequisite for this source closure. `recovery: unconfirmed` remains unchanged, and no new installer-specific outcome is inferred. Earlier open/pending statements below are historical and are superseded by this engineering decision. See `docs/releases/0.11.2/PUBLIC_RELEASE.md`.


# Customer reports an ONCE routine absent from Active Routines

## Symptom

INBOX creation appears successful but the routine cannot be found in Active Routines.

## Repro

Customer path: create an ONCE routine from INBOX, open Active Routines, then restart. Current source reproduces related confirmation races but not the historical disappearance.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/cron.api.test.js

Release verification 2026-09-06 re-read the original support thread and attached Markdown report. The reporter corrected v0.9.0 to v0.10.12 and identified Windows 11. INBOX → FIRES AT RESEARCHER → ONCE returned success twice, while AUTOMATION showed NO ROUTINES YET, including after restart. No job ID, save/list response, or later recovery confirmation was supplied. The exact candidate bd65c7737 passes the full 101-suite HTTP gate; those local fixtures do not establish the historical disappearance's cause.

## Verdict

Current disposition: Engineering work closed for the reproduced false routine-creation confirmation and lost-acknowledgement paths. INBOX now confirms the persisted job through a fresh list and preserves the draft on ambiguity. Real UI creation/readback and installed update/restart/due-time checks retained exactly one routine and completed it once. The original missing job cannot be reconstructed without its historical data.

Historical investigation notes (superseded for engineering closure):

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
    {
      "target": "routine creation",
      "state": "not-applicable",
      "reason": "The repaired persistence/readback contract does not depend on an inference adapter."
    }
  ],
  "entrypoints": [
    {
      "target": "INBOX routine save",
      "state": "covered",
      "test": "test/frontend-fetch-truth-ratchet.test.js",
      "scenario": "creation preserves response status and confirms saved job through a fresh list",
      "gate": "fast"
    },
    {
      "target": "routine API",
      "state": "covered",
      "test": "test/cron.api.test.js",
      "scenario": "persisted routine creation and list contract",
      "gate": "http"
    }
  ],
  "displays": [
    {
      "target": "original customer missing routine view",
      "state": "blocked",
      "reason": "Affected-customer retest remains unconfirmed; this does not prevent closing the independently reproduced and verified source repair under the owner decision of September 11."
    }
  ],
  "lifecycle": [
    {
      "target": "one-shot completion",
      "state": "covered",
      "test": "test/cron.oneshot.test.js",
      "scenario": "one-shot jobs complete and disable after execution",
      "gate": "fast"
    },
    {
      "target": "routine durability",
      "state": "covered",
      "test": "test/cron.durability.test.js",
      "scenario": "persisted scheduling state survives storage transitions",
      "gate": "fast"
    }
  ]
}

## September 10 release follow-through

A Just once routine created through the installed UI survived a canary update, remained visible, fired once and showed completed in Automation. Job 1037758e-f7f3-4a77-9287-2add0002b2fb completed run 9a03ff10-6d92-4cb9-be86-ca44b58d6e5f, delivered ONCE_0112_OK, repeat.completed=1, enabled=false, nextRunAt=null. It remained completed after the next install. This proves the current path on the test station; the affected customer's missing job ID/save and recovery remain required.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
