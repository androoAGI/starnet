---
fingerprint: f8d479d9
slug: repeated-project-verification-reportedly-consume
title: Repeated project verification reportedly consumes overnight budget
surface: autonomy
severity: P2
status: open
found: 2026-09-19
lane: agent/reliability-audit-0919
fix:
origin: customer
affected: Exact failing build and background-work configuration not supplied in follow-up
family: autonomous-completion-and-cost
report: support-2026-09-17-repeated-verification
installer: unverified
recovery: unconfirmed
---

# Repeated project verification reportedly consumes overnight budget

## Symptom

A September 17 follow-up reports 98 recursive verification runs consuming approximately 98 dollars overnight without producing further project work.

## Repro

Correlate run and tool ledgers, parent IDs, loop/routine configuration, completion checks and provider usage for the affected night. Distinguish separate scheduled passes from in-run verification continuations.

## Evidence

Fresh support follow-up reviewed September 19. sidecar/loopjob.js has dry-stop and red-streak controls and budget accounting; test/loops-endurance.e2e.test.js covers lifecycle but cannot establish this incident cause. Related older uncertainty: acb47320. No affected run ledger was supplied.

## Verdict

Open P2 under the existing uncorrelated-report triage rule; prioritize evidence because reported cost is material. Do not merge this incident into generic idle usage or invent a successful reproduction. Need authorized account reconciliation and exact background-work configuration.
