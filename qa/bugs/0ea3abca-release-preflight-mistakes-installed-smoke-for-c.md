---
fingerprint: 0ea3abca
slug: release-preflight-mistakes-installed-smoke-for-c
title: Release preflight mistakes installed smoke for completed soak
surface: release
severity: P1
status: fixed
found: 2026-09-11
lane: agent/release-0112-finalprep-0911
fix: b9c5539556fc2d36e0992290c4dd8efb08720b82
origin: audit
---

# Release preflight mistakes installed smoke for completed soak

## Symptom

Release preflight prints PASS for an installed soak immediately after a short installed smoke check. The operator has not supplied 48 hours of elapsed acceptance or its workload evidence.

## Repro

1. Run the real installed smoke on a target-version canary.
2. Run `node scripts/release-preflight.mjs --version 0.11.2 --json`.
3. Before repair, the `soak` row reads PASS solely because `qa/installed/last-smoke.json` is fresh, GREEN and has the target version.

## Evidence

Live integration preflight on 61528ba95 reproduced `soak: PASS` using the installed smoke from 2026-09-11T02:49:17.353Z. The receipt has nine short checks and no duration/workload fields. Raw before/after CLI evidence is retained in the final-preparation worktree `.dogfood/finalprep/`. `test/release-preflight.test.js` failed before the repair: expected WARN for a fresh smoke's soak verdict, got PASS.

## Verdict

Source repair separates `installed-smoke` from `soak`. A current smoke may pass its own row; installed soak acceptance remains explicitly owed for manual evidence review. The checker does not infer a waiver. Status matching also requires exact GREEN, and future or invalid timestamps cannot pass smoke freshness. Existing readiness failures still stop the cut. No installed runtime behavior is changed.

## Regression

The registered `test/release-preflight.test.js` suite passes 104 assertions, including fresh smoke versus missing soak duration, wrong-version/stale receipts, invalid/future dates and a misleading NOT_GREEN status. `test/release-ritual.test.js` passes 64 assertions. The live preflight rerun uses the same actual integration smoke receipt; its soak row must remain WARN.
