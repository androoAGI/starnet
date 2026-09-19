---
fingerprint: dde8e66f
slug: late-permission-responses-replace-newer-authorit
title: Late permission responses replace newer authority and survive store reinitialization
surface: safecell
severity: P1
status: fixed
found: 2026-09-19
lane: agent/systemic-bugs-0919
fix: 8eb87b0d3
origin: audit
---

# Late permission responses replace newer authority and survive store reinitialization

## Symptom

Permission reads and mutations had no shared generation or write ownership; late callbacks reintroduced revoked grants and older bypass state.

## Repro

Hold a real browser permissions GET, revoke cabinet:write, release the older response. Before: browser held the grant while the server did not. Also test reverse read completion, queued writes, reinitialization and rejection.

## Evidence

`test/permissions-authority.test.js`; `qa/evidence/systemic-bugs-0919/`. Production-browser proof: `dev/systemic-bugs-proof.mjs` (applicable UI cases).

## Verdict

All permission mutations serialize in submission order. Reads await outstanding mutations and apply only in the current generation; old instance callbacks are inert. Live browser cache agrees with the actual revoked server grant. Full combined gates are recorded in the systemic audit report. Source-level repair does not establish affected-installer or customer recovery.
