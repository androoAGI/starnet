---
fingerprint: 9256a771
slug: viewport-black-after-idle
title: Customer viewport becomes blank after ten to twenty minutes
surface: world
severity: P1
status: open
found: 2026-08-24
lane: reliability-followup
fix:
origin: customer
report: support-2026-08-24-viewport-black-after-idle
affected: Windows, reported 2026-08-24; exact build, GPU and display configuration unavailable
family: durability-and-visibility
installer: unverified
recovery: unconfirmed
---

# Customer viewport becomes blank after ten to twenty minutes

## Symptom

The station viewport becomes blank after approximately 10-20 minutes.

## Repro

Run the affected customer station idle for 20 minutes at its actual window size and display scale. Capture renderer diagnostics and saved state before reloading.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/station-recovery.e2e.test.js

Release verification 2026-09-06 re-read the original support thread: Windows was explicitly identified; the viewport went black or white after 10–20 minutes while agents kept working, and restart restored it temporarily. The owner's signed Windows bd65c7737 process was launched at about 01:00 UTC on 2026-09-07 and native Computer Use inspection after 01:20 UTC showed the station visibly rendering and its camera moving between crew. This is a successful spot check after prolonged uptime, not continuous monitoring or a retest on the affected customer's GPU. No historical cause or customer recovery is inferred.

## Verdict

Keep open pending exact reproduction/retest. Matching v0.10.13 rendering repairs are documented in the support follow-up, but no exact customer artifact or recovered session was verified.

## Regression

Exact before/after customer reproduction is pending; see Repro and Verdict.

2026-09-05 local recheck on source `94bff3a5f`: seeded Chromium recovered from three simulated
cached-canvas losses and one dead stage context. Recovery counters advanced and visible pixels
returned without reloading, with zero uncaught browser exceptions. See
`qa/digests/2026-09-05-release-blockers.md`. This is not the affected customer's installer,
GPU/display configuration, or a reproduction of its 10–20-minute failure; status stays open.

## Sibling coverage

{
  "adapters": [
    {"target":"exact affected provider or renderer","state":"blocked","reason":"The customer failure has not been reproduced on the affected configuration; baseline tests are corroboration only."}
  ],
  "entrypoints": [
    {"target":"reported user path","state":"blocked","reason":"Run the affected customer station idle for 20 minutes at its actual window size and display scale. Capture renderer diagnostics and saved state before reloading."}
  ],
  "displays": [
    {"target":"reported error and recovery UI","state":"blocked","reason":"Capture the actual failure and follow the offered recovery; a connected label or nearby passing test is insufficient."}
  ],
  "lifecycle": [
    {"target":"recovery and restart","state":"blocked","reason":"Requires a before/after receipt for this symptom on the affected artifact, followed by restart and the same operation."}
  ]
}

## September 10 release follow-through

The installed Windows canary fbaab109f passed twenty minutes idle with no blank frames, then recovered from deliberate canvas-cache loss, WebGL context loss and stage failure. The receipt records recovery counters and frame samples. This bounded check does not reproduce the customer GPU/driver configuration or satisfy the separate 48-hour installed soak.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
