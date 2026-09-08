---
fingerprint: 48c51661
slug: file-approval-omits-mutation
title: File approval hides the proposed edit and patch payload
surface: safecell
severity: P1
status: fixed
found: 2026-09-08
lane: report-0110-0908
fix: 72a8a3043c263cd53ed353daed2042e256c8e236
origin: customer
report: Sanitized customer report copied by owner into local task on 2026-09-07
affected: StarNet v0.11.0; ChatGPT/Codex; GPT-6 Astra Medium; Trusted Project; Ask; customer OS unknown
family: informed-approval
installer: unverified
recovery: unconfirmed
---

# File approval hides the proposed edit and patch payload

## Symptom

File approval hides the proposed edit and patch payload.

## Evidence

consentSummary returned only path for edits; pathless patches were cut to 80 characters. The separate tool-call record is also capped.

## Repro

Run test/report-0110.e2e.test.js in Trusted Project / Ask with the 6000-character edit and 8000-character patch.

## Regression

Before: file approval has a path or shortened JSON rather than mutation arguments. After: full redacted JSON reaches the approval card. Seeded browser proof: expanded disclosure contained 8071 characters including FINAL_PAYLOAD_MARKER, with scrollHeight 5353 and clientHeight 320. Real-host deny preserves bytes; approval writes exact replacement and restart preserves it.

## Sibling coverage

{
  "adapters": [
    {
      "target": "file tools",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "write append edit patch preserve payload past summary cap",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "Trusted Project / Ask",
      "state": "covered",
      "test": "test/report-0110.e2e.test.js",
      "scenario": "real write approval, edit approve and deny, patch deny",
      "gate": "http"
    },
    {
      "target": "messaging channels",
      "state": "blocked",
      "reason": "The existing channel presentation still limits approval text to 600 characters; expanding that UI is outside this browser repair."
    }
  ],
  "displays": [
    {
      "target": "installed desktop",
      "state": "blocked",
      "reason": "Seeded browser disclosure was expanded and its 8071 characters and final marker read back; no installer rebuilt."
    }
  ],
  "lifecycle": [
    {
      "target": "approve deny and restart",
      "state": "covered",
      "test": "test/report-0110.e2e.test.js",
      "scenario": "deny preserves bytes; exact approved edit survives restart",
      "gate": "http"
    },
    {
      "target": "legacy already-truncated prompts",
      "state": "blocked",
      "reason": "Past run summaries cannot reconstruct argument bytes that were never retained."
    }
  ]
}

## Verification limits

HTTP gate: 104/104 green; customer journeys: 30/30 green. Source fixes and local fixture/browser proof do not establish installed-desktop verification or customer recovery. Full fast gate: 732/732 green on source commit 72a8a3043 with the reviewed source hash refresh. Logs: dev/report-fast-locked.log, dev/report-http.log, dev/report-customer-journeys.log; live browser evidence: dev/report-live.log (local, ignored).
