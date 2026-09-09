---
fingerprint: 96921b22
slug: standard-text-size-leaves-everyday-controls-and
title: Standard text size leaves everyday controls and labels hard to read
surface: world
severity: P2
status: open
found: 2026-09-09
lane: agent/glass-demo-0909
fix:
origin: owner
report: Owner reports widespread complaints about STANDARD readability, 2026-09-09, in the local glass UI task
affected: 0.11.0 source and local demo; affected customer installer versions unknown
family: standard-readability
installer: unverified
recovery: unconfirmed
---

# Standard text size leaves everyday controls and labels hard to read

## Symptom

Users need enlarged text to read ordinary labels and controls, while enlarging everything makes other parts too large. The owner requests a balanced normal-size interface.

## Repro

1. Use STANDARD (100%) in Appearance and open CREW, SESSIONS and COMMS.
2. Inspect ALL/AUTOMATED, crew state, model metadata and session ages.
3. Open Settings, Agent Dossier, Tasks and Build. Read small navigation labels, helper text and control captions without increasing TEXT SIZE.

## Evidence

Before-fix live DOM at the local demo: crew status/level and summary 11px; ALL/AUTOMATED 11px; COMMS model metadata 11px and effort 10px; Settings rail labels 13px and backdrop names 11px; dossier agent state 10px and prompt-file descriptions 12px; Tasks explanatory note 12px. STANDARD body zoom was exactly 1. Legacy inline captions and component styles defeat a single inherited body font size. Source anchor and regression: test/readability.test.js. Shared implementation: frontend/css/readability.css.

## Regression

The registered readability gate bounds metadata, controls, prose and agent-name sizes, checks primary entry-point coverage, and prevents repairing text with viewport zoom or universal icon-affecting rules. Live before/after geometry and interaction verification is recorded in dev/GLASS_DEMO.md.

## Verdict

Shared source repair and seeded-browser verification completed at STANDARD, with compact/wide viewport and enlarged-text checks. See dev/GLASS_DEMO.md for the before/after receipt, passing focused checks and 32 customer-journey suites. Full fast remains blocked by the pre-existing release-manifest failures. Installed application verification and owner acceptance remain separate from source repair.

## Sibling coverage

{"adapters":[{"target":"shared browser/desktop frontend typography","state":"covered","test":"test/readability.test.js","scenario":"shared stylesheet entry point, bounded role tokens and no global magnification","gate":"fast"}],"entrypoints":[{"target":"crew, sessions, COMMS, settings, dossier, tasks and build text roles","state":"covered","test":"test/readability.test.js","scenario":"critical small-text role coverage","gate":"fast"}],"displays":[{"target":"standard and enlarged text in the seeded browser","state":"blocked","reason":"Live geometry checks are recorded separately; no registered browser geometry gate."},{"target":"installed Windows and macOS at multiple DPI settings","state":"blocked","reason":"No installed artifacts or customer hardware were verified in this source pass."}],"lifecycle":[{"target":"saved text-size choices and fresh automatic preference","state":"covered","test":"test/readability.test.js","scenario":"existing preference meaning and automatic default are preserved","gate":"fast"}]}
