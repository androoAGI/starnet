---
fingerprint: 9256a771
slug: viewport-black-after-idle
title: Customer viewport becomes blank after ten to twenty minutes
surface: world
severity: P1
status: fixed
found: 2026-08-24
lane: reliability-followup
fix: 57112a690f8174f3ba3f3ac33fe786d07fa51c5d
origin: customer
report: support-2026-08-24-viewport-black-after-idle
affected: Windows, reported 2026-08-24; exact build, GPU and display configuration unavailable
family: durability-and-visibility
installer: unverified
recovery: unconfirmed
---

## September 11 engineering disposition

Engineering work closed for the reproduced permanently dead stage canvas: the live pre-fix frame dropped from 87.41% visible pixels to 0% while the old cache watchdog remained blind. The repaired stage rebuild and later installed fault-injection checks restored visible frames; bounded installed idle also passed. The original customer GPU/driver trigger remains unconfirmed. Customer confirmation is not a prerequisite for this source closure. `recovery: unconfirmed` remains unchanged, and no new installer-specific outcome is inferred. Earlier open/pending statements below are historical and are superseded by this engineering decision. See `docs/releases/0.11.2/PUBLIC_RELEASE.md`.


# Customer viewport becomes blank after ten to twenty minutes

## Symptom

The station viewport becomes blank after approximately 10-20 minutes.

## Repro

Run the affected customer station idle for 20 minutes at its actual window size and display scale. Capture renderer diagnostics and saved state before reloading.

## Evidence

docs/EMAIL_BUG_FOLLOWUP_2026-09-04.md; test/station-recovery.e2e.test.js

Release verification 2026-09-06 re-read the original support thread: Windows was explicitly identified; the viewport went black or white after 10–20 minutes while agents kept working, and restart restored it temporarily. The owner's signed Windows bd65c7737 process was launched at about 01:00 UTC on 2026-09-07 and native Computer Use inspection after 01:20 UTC showed the station visibly rendering and its camera moving between crew. This is a successful spot check after prolonged uptime, not continuous monitoring or a retest on the affected customer's GPU. No historical cause or customer recovery is inferred.

## Verdict

Current disposition: Engineering work closed for the reproduced permanently dead stage canvas: the live pre-fix frame dropped from 87.41% visible pixels to 0% while the old cache watchdog remained blind. The repaired stage rebuild and later installed fault-injection checks restored visible frames; bounded installed idle also passed. The original customer GPU/driver trigger remains unconfirmed.

Historical investigation notes (superseded for engineering closure):

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
    {
      "target": "canvas recovery",
      "state": "covered",
      "test": "test/canvas-loss-recovery.test.js",
      "scenario": "offscreen canvas loss recovers rather than remaining black",
      "gate": "fast"
    },
    {
      "target": "stage 2D context",
      "state": "covered",
      "test": "test/stage-context-loss.test.js",
      "scenario": "visible-stage watchdog rebuilds a permanently dead context",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "CRT GPU context loss",
      "state": "covered",
      "test": "test/crt-context-loss.e2e.test.mjs",
      "scenario": "real browser context loss retains visible rendering",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "affected customer GPU and display scale",
      "state": "blocked",
      "reason": "Affected-customer retest remains unconfirmed; this does not prevent closing the independently reproduced and verified source repair under the owner decision of September 11."
    }
  ],
  "lifecycle": [
    {
      "target": "stage recovery lifecycle",
      "state": "covered",
      "test": "test/stage-context-loss.test.js",
      "scenario": "replacement canvas restores render and input wiring",
      "gate": "fast"
    }
  ]
}

## September 10 release follow-through

The installed Windows canary fbaab109f passed twenty minutes idle with no blank frames, then recovered from deliberate canvas-cache loss, WebGL context loss and stage failure. The receipt records recovery counters and frame samples. This bounded check does not reproduce the customer GPU/driver configuration or satisfy the separate 48-hour installed soak.

Current receipts and remaining acceptance: [0.11.2 follow-through](../../docs/releases/0.11.2/FOLLOWTHROUGH.md). Status remains open pending the affected configuration.
