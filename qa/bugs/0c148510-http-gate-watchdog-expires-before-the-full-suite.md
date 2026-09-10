---
fingerprint: 0c148510
slug: http-gate-watchdog-expires-before-the-full-suite
title: HTTP gate watchdog expires before the full suite finishes
surface: release
severity: P2
status: fixed
found: 2026-09-10
lane: cleanup-0112-0910
fix: 5262e4a2943e72e2ce147f6fa804fd1b859df211
origin: audit
---

# HTTP gate watchdog expires before the full suite finishes

## Symptom

The complete HTTP gate is terminated at its aggregate 15-minute watchdog despite all completed tests reporting success. Guardian also applies a 15-minute outer deadline.

## Repro

Run npm run test:http on this Windows host. .dogfood/cleanup-final-http.log and .dogfood/cleanup-synced-http.log both exit 124 at 900000ms, at different late-suite points. package.json owns the child deadline; scripts/qa/guardian.mjs, scripts/qa/closer.mjs and scripts/phase2.mjs own outer runners.

## Evidence

The entire unchanged test/http.list completed 108/108 in .dogfood/cleanup-http-diagnostic.log in just over 15 minutes. The HTTP child now gets 20 minutes and Guardian, Closer and Phase 2 get 21 minutes for that step through scripts/lib/run-command.mjs, preserving explicit operator overrides. Individual test timeouts, assertions, fast-gate timeout, and test lists are unchanged. test/qa-guardian.test.js verifies outer/child budget ordering and override behavior (102 assertions); test/timeout.test.js passes six assertions.

## Verdict

Source QA repair and focused checks verified. Normal complete gates are rerun on the frozen final candidate; the earlier 15-minute failures and longer diagnostic result remain retained and separately labeled.
