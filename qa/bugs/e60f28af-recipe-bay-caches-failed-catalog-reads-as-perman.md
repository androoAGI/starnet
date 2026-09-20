---
fingerprint: e60f28af
slug: recipe-bay-caches-failed-catalog-reads-as-perman
title: Recipe Bay caches failed catalog reads as permanent empty successes
surface: world
severity: P2
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Recipe Bay caches failed catalog reads as permanent empty successes

## Symptom

Five independent caches converted non-2xx or malformed responses into valid empty collections; retry catches therefore did not run. Some rejection catches cached emptiness too.

## Repro

Read skills, routines, run history, projects and connectors with 403, 503, malformed body, error envelope and network rejection, then restore valid responses.

## Evidence

`test/marketplace-authority.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

One validated collection reader rejects unknown results; failed reads stay retryable and retain prior confirmed values. The live Recipe Bay reopens and re-requests skills after a 503. Verified empty arrays remain cacheable. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
