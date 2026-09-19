---
fingerprint: 46f9dad7
slug: seeded-lifecycle-campaigns-reuse-a-shared-worksp
title: Seeded lifecycle campaigns reuse a shared workspace and inherit stale ownership
surface: release
severity: P2
status: open
found: 2026-09-19
lane: reliability-audit-0919
fix:
origin: unknown
---

# Seeded lifecycle campaigns reuse a shared workspace and inherit stale ownership

## Symptom

An otherwise passing merge candidate intermittently fails its seeded session lifecycle gate with WORKSPACE_BUSY. Independent automated campaigns can also inherit prior campaigns' durable station state.

## Repro

Run two automated `node dev/seed.js --keep` campaigns from the same checkout, or retain its scratch ownership file until its PID is reused by another live process. The launcher previously forced both into `dev/.scratch-workspace`, even when a fixture supplied a separate workspace. `test/dev-seed-isolation.http.test.js` exercises concurrent isolated launches, independent durable saves and same-workspace restart.

## Evidence

The first post-merge fast log stopped at step 776/829 in `test/session-reliability.e2e.test.js`: the shared scratch owner PID 39976 belonged to npm's `test:fast:raw` process, not this sidecar. Trunk was rolled back to its snapshot with unrelated operational edits preserved. The guard correctly refused access; the regression belongs to seeded campaign isolation.

## Verdict

Add explicit `--workspace` support requiring `--keep`, so the launcher cannot clear an explicitly selected directory. Session campaigns allocate a new workspace per invocation and retain it across their own restart. Seeded memory campaigns pass their fixture-owned workspace. Production ownership checks are unchanged. Closure requires the concurrent seed regression and full merge gates.
