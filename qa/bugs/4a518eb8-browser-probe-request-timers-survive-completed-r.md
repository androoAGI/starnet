---
fingerprint: 4a518eb8
slug: browser-probe-request-timers-survive-completed-r
title: Browser probe request timers survive completed requests
surface: release
severity: P2
status: fixed
found: 2026-09-19
lane: reliability-audit-0919
fix: 9cdfc0ba5
origin: audit
---

# Browser probe request timers survive completed requests

## Symptom

Successful browser probes retain 30-second request timers; disconnected requests also wait for timeout instead of failing immediately.

## Repro

Run `node test/cdp-lifecycle.test.js` for success, protocol rejection, send failure and disconnect. Run the live budget browser probe for the shared production CDP helper.

## Evidence

`qa/evidence/reliability-hardening-0919/cdp-before.log` captures one retained timer after success. Live budget JSON receipts were collected through the repaired helper.

## Verdict

Verified patch clears completed request timers, rejects disconnected pending work, and routes duplicated uiplay/refit request handling through the shared implementation. Full gates pass: 834 fast, 124 HTTP and 139 live journey assertions. Receipt: `qa/evidence/reliability-hardening-0919/validation.json`. Guardian visual diffs remain unresolved; no goldens were dismissed.
