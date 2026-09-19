---
fingerprint: 95d13aaf
slug: ambiguous-permission-and-routine-acknowledgement
title: Ambiguous permission and routine acknowledgements report unproven changes
surface: autonomy
severity: P1
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Ambiguous permission and routine acknowledgements report unproven changes

## Symptom

Control stores accepted any truthy reply without explicit success or an authoritative resulting state. Routine wiring reduced malformed HTTP 200 to success.

## Repro

Return HTTP 200 with {} for bypass disable and routine creation. Before: FULL BYPASS appears off while actually on; proposal disappears although no routine exists.

## Evidence

`test/routine-acknowledgement.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

Permissions require explicit success plus the requested state; routine creation requires an explicit persisted job identity. Ambiguity preserves authority and proposals and exposes failure. Live browser and acknowledgement matrices pass. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
