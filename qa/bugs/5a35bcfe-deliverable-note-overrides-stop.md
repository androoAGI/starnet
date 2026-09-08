---
fingerprint: 5a35bcfe
slug: deliverable-note-overrides-stop
title: Deliverable naming instruction conflicts with explicit stop limits
surface: autonomy
severity: P2
status: open
found: 2026-09-08
lane: report-0110-0908
fix:
origin: customer
report: Sanitized customer report copied by owner into local task on 2026-09-07
affected: StarNet v0.11.0; ChatGPT/Codex; GPT-6 Astra Medium; Trusted Project; Ask; customer OS unknown
family: task-scope
installer: unverified
recovery: unconfirmed
---

# Deliverable naming instruction conflicts with explicit stop limits

## Symptom

Deliverable naming instruction conflicts with explicit stop limits.

## Evidence

DELIVERABLE_NOTE_CLAUSE unconditionally requires a naming call after file changes. The tool description repeats it. This contradicts an explicit request for no further actions.

## Repro

Inspect the production prompt and tool description; run the deliverable instruction regression in test/report-0110-regressions.test.js.

## Regression

Before: naming is mandatory after writes. After: both instruction surfaces make it optional and explicitly yield to action limits. No deterministic guarantee of arbitrary model instruction-following or external Astra retest is claimed.

## Sibling coverage

{
  "adapters": [
    {
      "target": "model instructions",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "optional naming clause respects explicit action limits",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "deliverable tool",
      "state": "covered",
      "test": "test/deliverable-note.test.js",
      "scenario": "note remains attributed to the run that made it",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "customer extra approval",
      "state": "blocked",
      "reason": "The original external model trajectory is unavailable; no change to the approval boundary was made."
    }
  ],
  "lifecycle": [
    {
      "target": "external model compliance",
      "state": "blocked",
      "reason": "This fixes the conflicting prompt and tool description. It cannot guarantee that an arbitrary model will follow every instruction."
    }
  ]
}
