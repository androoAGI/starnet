---
fingerprint: 4a19c050
slug: product-line-workbench-standing-grant-scope
title: Product Line Workbench access differs from a direct interactive run
surface: autonomy
severity: P2
status: wontfix
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: customer
report: support-2026-09-13-product-line-workbench
affected: StarNet 0.11.2 Windows 11; unattended Product Line; direct agent Workbench and standing execution approval enabled
family: unattended-workbench-policy
installer: unverified
recovery: unconfirmed
---

# Product Line Workbench access differs from a direct interactive run

## Symptom

A direct agent can execute a shell command but its unattended Product Line stage cannot. The customer asks whether a standing Workbench grant should allow scoped execution without Full Access.

## Repro

Compare an ASK-mode interactive agent run with an unattended line containing that same agent and only a standing workbench:execute approval. Compare separately with an explicitly authorized scheduled routine carrying its own unattended workbench grant.

## Evidence

September 13 private report refreshed September 16. The current host intentionally passes no unattendedGrants into the autonomous chain. sidecar/index.js:9863 documents the chain-grants contract; sidecar/inputpolicy.js:120 and sidecar/permissions.js:138 require host-recorded per-routine authority, rather than deriving it from cached interactive consent. test/inputpolicy.test.js and test/permissions.test.js cover the restrictive path.

## Verdict

Current release behavior is deliberate scope separation, not a missing shell adapter. A standing interactive approval does not authorize unattended Product Line execution. A routine with its explicit terminal grant is the supported scoped unattended path. A Product Line-specific authority mechanism is not promised by this release. Do not silently widen permissions or claim that the same agent's interactive AVAILABLE display authorizes every surface.
