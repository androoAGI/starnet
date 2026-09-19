---
fingerprint: 38aad6db
slug: stalled-finite-json-mutations-never-release-thei
title: Stalled finite JSON mutations never release their callers
surface: sessions
severity: P2
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Stalled finite JSON mutations never release their callers

## Symptom

Shared GET exchanges were bounded, but shared POST and DELETE had no header or body deadline.

## Repro

Stall headers and JSON bodies for GET, POST and DELETE; release the reply late. Before: 12/24 lifecycle checks passed; POST/DELETE never timed out.

## Evidence

`test/api-json-lifecycle.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

The shared JSON transport bounds headers plus parsing, aborts timed-out requests, clears timers and never retries writes. Mutation timeout states that completion is unknown. Streaming inference is outside this helper. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
