---
fingerprint: 8873fd77
slug: retry-status-labels-a-refused-or-unresolvable-pr
title: Retry status labels a refused or unresolvable provider connection as a timeout
surface: providers
severity: P2
status: open
found: 2026-10-20
lane: sweep/onboarding
fix:
origin: audit
---

# Retry status labels a refused or unresolvable provider connection as a timeout

## Symptom

While a run retries against a provider that refuses the connection, the COMMS presence line reads "▮ WORKING retry 5/6 in 16s (timeout) — model 33s". Nothing timed out. The connection was refused instantly, and the final error correctly says ECONNREFUSED. The label points the user at slowness instead of an unreachable endpoint.

## Repro

1. Station on a mock OpenRouter; stop the mock's listener (connection refused).
2. Send any task; read `[id*=presence]` during the retries.

## Evidence

Live (station QUASAR, 2026-10-20): `▮ WORKING retry 5/6 in 16s (timeout) — model 33s`, then the run error `fetch failed (ECONNREFUSED 127.0.0.1)`.

Source: `sidecar/providers/errorClass.js:388` `if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED|UND_ERR/i.test(transportCode(err))) return 'timeout';`. The reason string is printed verbatim by `frontend/app/chat.js:459` waitNoteText.

## Verdict

_Filled in when the bug leaves the backlog: what was true, and why it is closed._

## Notes

Still open. Reconciled 2026-10-27 (reliability wave 1, quick win 37): `e1b3dfffd` (an ancestor of trunk, first released in v0.14.0) relabels the retry line "(unreachable)" for ECONNREFUSED / ENOTFOUND / EAI_AGAIN (`sidecar/loop.js` retryReasonOf; test/loop.retry-events.test.js). The unreachable error class itself (no failover, an honest sentence per host, one DNS retry, "retry 1/1") is `54bd1ab19` on agent/provider-conformance-suite, not merged. Close this record when that lands.
