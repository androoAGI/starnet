---
fingerprint: 2a9cb952
slug: doctor-forces-unsupported-reasoning
title: Live Doctor overrides selected model reasoning with none
surface: providers
severity: P1
status: fixed
found: 2026-09-08
lane: report-0110-0908
fix: 72a8a3043c263cd53ed353daed2042e256c8e236
origin: customer
report: Sanitized customer report copied by owner into local task on 2026-09-07
affected: StarNet v0.11.0; ChatGPT/Codex; GPT-6 Astra Medium; Trusted Project; Ask; customer OS unknown
family: execution-configuration
installer: unverified
recovery: unconfirmed
---

# Live Doctor overrides selected model reasoning with none

## Symptom

Live Doctor overrides selected model reasoning with none.

## Evidence

Production probes hard-code none in both Live Doctor and channel setup. The Codex adapter transmits it unchanged, reproducing the reported HTTP 400.

## Repro

Run test/report-0110-regressions.test.js (Codex probe scenario) and test/live-doctor.e2e.test.js. Configure Medium on the selected agent.

## Regression

Before: synthetic Codex wire returned HTTP 400 for none; real-host Doctor did not transmit Medium. After: Codex probe and real-host Doctor preserve Medium and complete.

## Sibling coverage

{
  "adapters": [
    {
      "target": "Codex",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "strict unsupported-none response becomes successful Medium request",
      "gate": "fast"
    },
    {
      "target": "OpenRouter",
      "state": "covered",
      "test": "test/live-doctor.e2e.test.js",
      "scenario": "selected Medium reaches the local provider over real sockets",
      "gate": "http"
    },
    {
      "target": "other OAuth and API-key adapters",
      "state": "blocked",
      "reason": "Shared probe configuration changes but no external account inference was performed."
    }
  ],
  "entrypoints": [
    {
      "target": "Live Doctor",
      "state": "covered",
      "test": "test/live-doctor.e2e.test.js",
      "scenario": "confirmed diagnostic probes complete with selected reasoning",
      "gate": "http"
    },
    {
      "target": "channel connection probe",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "production probeChannelRunConfig uses configured Medium on Codex",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "installed Doctor panel",
      "state": "blocked",
      "reason": "Source-side real-host response proved; no installer was rebuilt."
    }
  ],
  "lifecycle": [
    {
      "target": "bounded probe completion",
      "state": "covered",
      "test": "test/report-0110-regressions.test.js",
      "scenario": "probe returns ok after done event and releases timer",
      "gate": "fast"
    },
    {
      "target": "external Astra backend",
      "state": "blocked",
      "reason": "The real adapter was exercised with a synthetic response; no customer credential or external model call was used."
    }
  ]
}

## Verification limits

HTTP gate: 104/104 green; customer journeys: 30/30 green. Source fixes and local fixture/browser proof do not establish installed-desktop verification or customer recovery. Full fast gate: 732/732 green on source commit 72a8a3043 with the reviewed source hash refresh. Logs: dev/report-fast-locked.log, dev/report-http.log, dev/report-customer-journeys.log; live browser evidence: dev/report-live.log (local, ignored).
