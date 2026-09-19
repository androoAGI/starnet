---
fingerprint: 759f281c
slug: recipe-readiness-includes-disconnected-and-unaut
title: Recipe readiness includes disconnected and unauthorized connectors
surface: world
severity: P2
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Recipe readiness includes disconnected and unauthorized connectors

## Symptom

The shelf checked connected/status aliases rather than the server-owned state, enabled and authRequired fields; absent aliases admitted unusable connections.

## Repro

Return up, cached, down, disabled, authentication-required and unknown connector rows. Before all six qualified; after only enabled up/cached rows without authRequired qualify.

## Evidence

`test/marketplace-authority.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

Recipe readiness consumes the actual connection contract. The recipe scheduler note also honors halted instead of treating arm intent as runnable. Actual external account recovery is not claimed. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
