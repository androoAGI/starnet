---
fingerprint: 81209ef7
slug: exported-modeldock-helpers-depend-on-a-browser-g
title: Exported ModelDock helpers depend on a browser global
surface: providers
severity: P2
status: fixed
found: 2026-11-03
lane: agent/batch3-runtime-fixtures-1103
fix: fb33da958e1b8998a661e793d8a5f0a0aa44129a
origin: audit
---

# Exported ModelDock helpers depend on a browser global

## Symptom

The exported ModelDock model helpers throw SK is not defined when used through CommonJS, breaking model selection, reasoning and tier consumers outside the browser.

## Repro

Require frontend/app/modeldock.js from Node and execute its provider-aware exports. Existing test/image-task.test.js, test/model-provider-reconcile.test.js, test/model-reasoning-presets.test.js, test/grok-reasoning-truth.test.js, test/reasoning-dials.test.js and test/model-tier-badges.test.js exercise the actual exported functions.

## Evidence

Frozen candidate 5acb0819a full FAST failed all six files on the missing SK global. The repaired modules load the same generated provider registry through CommonJS. All six focused checks pass: 87, 73, 3248, 40, 57 assertions and 3 tier subtests. Receipts: gen-trees/_logs/codex-overnight-1103/batch3-5acb0819a-fast.normalized.log and batch3-root-focused-01.log. Independent source review confirmed browser registry ordering and unchanged normalization options.

## Verdict

Source-fixed in fb33da958e1b8998a661e793d8a5f0a0aa44129a. No fake process-global registry was added to the tests. The browser uses its existing registry and the shipped website mirror is synchronized. Combined immutable gates and installed acceptance remain with the integration candidate.
