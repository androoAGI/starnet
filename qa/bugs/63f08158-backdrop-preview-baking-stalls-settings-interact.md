---
fingerprint: 63f08158
slug: backdrop-preview-baking-stalls-settings-interact
title: Backdrop preview baking stalls settings interaction
surface: world
severity: P2
status: fixed
found: 2026-09-09
lane: agent/glass-demo-0909
fix: db3ae6bb4
origin: audit
---

# Backdrop preview baking stalls settings interaction

## Symptom

The first Appearance visit can freeze interaction while backdrop thumbnail assets are baked, including while the user changes text size.

## Repro

Run scripts/qa/glass-interactions-live.cjs against an isolated seeded app in a fresh Chrome context. It opens Appearance, changes text size to 145%, and records the main-thread tasks and CPU samples.

## Evidence

Cold-browser traces before: longest task 1439-1559ms; getImageData consumed 1231ms of sampled CPU time. CPU-backed scratch canvases reduced the longest task to 345ms. The remaining bake is moved to a worker using the unchanged Terrain.paintSample and SpaceBG.paintSample. test/backdrop-preview.test.js covers reply disposal, stale closed dialogs, timeout, unsupported/error fallback, and bounded allocation. Final live worker trace is recorded in qa/evidence/glass-interactions-0909.json.

## Verdict

GPU readbacks and synchronous procedural sample generation ran on the UI thread. The same rendering functions now run in a worker with CPU-backed scratch canvases. Compatibility fallback preserves real thumbnails when a worker cannot run. Awaiting final candidate checks; installed desktop remains unverified.
