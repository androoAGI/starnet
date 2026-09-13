---
fingerprint: c095c750
slug: shared-query-refresh-cannot-retire-a-stalled-pre
title: Shared query refresh cannot retire a stalled predecessor
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

# Shared query refresh cannot retire a stalled predecessor

## Symptom

Retry can remain pending behind an old unfinished JSON request instead of making a fresh request.

## Repro

Start QuerySpine cron refresh with an unsettled transport; invalidate and refresh again. Wire calls stay at 1 and pending stays true. Harness.api.get has no application deadline.

See qa/seam-audit-0912/REPORT.md finding A9 for exact scope and repair criteria.

## Evidence

Code anchor: frontend/app/queryspine.js:91. Receipt: `query-refresh-waits-on-hung-predecessor` in qa/seam-audit-0912/probe-results.json or ui-observations.json. Source baseline 091d6e7f3; product files unchanged through fa85f521f. Repro code is qa/seam-audit-0912/probe.cjs and controlled UI fixture server is fault-proxy.cjs. Evidence class and coverage limits are explicit in the report; no installer proof claimed.

## Verdict

Open audit finding. No product fix or customer recovery is claimed.
