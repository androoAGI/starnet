---
fingerprint: 4bc5d562
slug: hydration-regression-depends-on-host-scheduling
title: Hydration regression depends on host scheduling
surface: release
severity: P2
status: fixed
found: 2026-09-10
lane: cleanup-0112-0910
fix: 5262e4a2943e72e2ce147f6fa804fd1b859df211
origin: audit
---

# Hydration regression depends on host scheduling

## Symptom

The full fast gate stopped at browser hydration with only three scripted probes; an unchanged standalone rerun passed. Host scheduling consumed the fixture's 400ms wall-clock budget.

## Repro

Run npm run test:fast on a loaded host. The affected assertion is in test/browser.test.js: navigate keeps polling a hydrating page. The before-fix failure is .dogfood/cleanup-final-fast.log at step 315/753.

## Evidence

The unchanged rerun passed 306 assertions. The repaired test advances a bounded local timer queue, retaining the actual 400ms product settle budget and testing the same hydration script. .dogfood/cleanup-browser-clock.log passes 306 assertions. No experimental timer API or newer Node requirement was added.

## Verdict

Source QA repair verified; complete final candidate gate receipts are recorded in docs/AUDIT_0.11.1_FOR_0.11.2.md.
