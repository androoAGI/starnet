---
fingerprint: c7fa86fc
slug: feedback-run-reference-ambiguous
title: Feedback cards do not identify the run being rated
surface: sessions
severity: P1
status: fixed
found: 2026-09-08
lane: report-0110-0908
fix: 72a8a3043c263cd53ed353daed2042e256c8e236
origin: customer
report: Sanitized customer report copied by owner into local task on 2026-09-07
affected: StarNet v0.11.0; ChatGPT/Codex; GPT-6 Astra Medium; Trusted Project; Ask; customer OS unknown
family: feedback-attribution
installer: unverified
recovery: unconfirmed
---

# Feedback cards do not identify the run being rated

## Symptom

Feedback cards do not identify the run being rated.

## Evidence

workRateControl labels only the agent; an older rating can be delayed or remain visible while another run completes. The stored sourceRunId is captured from the card, not inferred from the most recent run. Live browser reproduction confirmed the old read-run card could appear below the newer write completion. Rating that card learned the old run. No backend ID substitution was observed.

## Repro

Complete two file-tool runs in one session. Inspect an older rating card and compare its target with the run the user intends to rate. Execute the rating-reference regression in test/report-0110-regressions.test.js.

## Regression

Before: rating text contains neither task nor run ID. After: each control identifies the task when available and always the exact run ID; follow-up names that same run. The superseded rating is now retired and cannot return through delayed standalone or memory-review paths. Live retest learned the write run 7bd45d2c-87df-493b-8348-c288fa5ce37e and preserved it after browser reload and sidecar restart.

## Sibling coverage

{
  "adapters": [
    {
      "target": "dossier storage",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "feedback retains write-run ID and directive through save hydration",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "standalone delayed rating",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "prior run is never eligible after a new run in the same stream",
      "gate": "fast"
    },
    {
      "target": "memory review rating",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "delayed deck excludes a superseded rating",
      "gate": "fast"
    },
    {
      "target": "explicit historical outbox rating",
      "state": "blocked",
      "reason": "Historical ratings remain available and now display their exact run ID; no dedicated historical-outbox click scenario was added."
    }
  ],
  "displays": [
    {
      "target": "rating reference",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "task and stable run ID rendered for an older card",
      "gate": "fast"
    },
    {
      "target": "installed desktop",
      "state": "blocked",
      "reason": "Browser two-run proof and reload/restart completed; no installer rebuilt."
    }
  ],
  "lifecycle": [
    {
      "target": "session isolation",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "only a later run in the same stream supersedes a rating",
      "gate": "fast"
    },
    {
      "target": "customer recovery",
      "state": "blocked",
      "reason": "Actual customer run IDs were not supplied; no existing learned records were rewritten."
    }
  ]
}

## Verification limits

HTTP gate: 104/104 green; customer journeys: 30/30 green. Source fixes and local fixture/browser proof do not establish installed-desktop verification or customer recovery. The full fast gate is recorded in the lane verification receipt.
