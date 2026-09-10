---
fingerprint: 8993bb79
slug: dismissed-frame-name-suppresses-unrelated-visual
title: Dismissed frame name suppresses unrelated visual changes
surface: release
severity: P1
status: fixed
found: 2026-09-10
lane: cleanup-0112-0910
fix: 0a3a605a9c41ecf944760782a4938ec442d02e6c
origin: audit
---

# Dismissed frame name suppresses unrelated visual changes

## Symptom

A historical panel-name dismissal automatically excuses arbitrarily different pixels on that panel, including a new frame without a reviewed baseline.

## Repro

Call classifyFrames from scripts/golden.mjs with a 2560-byte all-zero settings baseline, all-255 current signature, threshold 1.5 and the settings goldenFrameFingerprint in suppressed. Before the fix flagged is empty and diff 255 is excused.

## Evidence

The controlled classifier probe returned flagged:[] and excused:[{name:settings,diff:255}]. Current integration also auto-excuses four structurally changed glass panels by name. test/golden.test.js now proves total frame replacement, missing baseline, other changed frames and missing frames remain flagged; unchanged frames pass. The classifier retains historical names as context, but uses current pixel difference against the reviewed baseline as authority. No baseline or suppression record was modified.

## Verdict

Source repair and focused regressions verified. Final full-gate receipt is tracked in docs/AUDIT_0.11.1_FOR_0.11.2.md. No installed/customer recovery claim.
