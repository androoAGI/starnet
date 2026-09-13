---
fingerprint: ecb3df69
slug: outbox-run-review-can-display-another-run-answer
title: Outbox run review can display another run answer
surface: sessions
severity: P2
status: open
found: 2026-09-13
lane: agent/seam-audit-0912-b
fix:
origin: audit
affected: 091d6e7f3 source
installer: unverified
recovery: unconfirmed
---

# Outbox run review can display another run answer

## Symptom

A review crate can pair its original request and rating target with a later answer from the same session.

## Repro

Execute the unchanged rendering block with crate runId A and a transcript containing request/answer A followed by request/answer B. It displays request A and answer B. This is a source reproduction, not a paid live transcript.

See qa/seam-audit-0912/REPORT.md finding A7 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/windows/outbox.js:127. Receipt: `outbox-output-attributed-to-wrong-run` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Open audit finding. No product fix or customer recovery is claimed.
