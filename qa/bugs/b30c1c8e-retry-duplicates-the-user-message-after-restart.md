---
fingerprint: b30c1c8e
slug: retry-duplicates-the-user-message-after-restart
title: Retry duplicates the user message after restart
surface: sessions
severity: P1
status: fixed
found: 2026-09-07
lane: overnight-retry-history-0907
fix: 1611844713cfb4d88061ace1f786040436c59605
origin: audit
---

# Retry duplicates the user message after restart

## Symptom

A successful retry displays one user message until restart, then the same message appears twice. The recovered provider request executes once.

## Repro

1. Start a seeded isolated91c sidecar with a loopback provider returning HTTP503.
2. Send one message and let the failed run settle.
3. Restore provider responses and click Try again.
4. Restart the sidecar and reopen the conversation: two user rows precede one successful reply.

## Evidence

Original live receipt: `C:/Users/andro/gen-trees/release-0110/.bugloops/overnight-20260907/candidate-91c427f24/provider-original-repro/provider-recovery.json`. Two user rows have distinct sourceRunId values, while the provider log records only one successful request.

Anchor: `sidecar/index.js:17224` appends the user directive unconditionally for each execution; `frontend/app/chat.js` retryLast only suppresses its local echo.

## Verdict

Backend finalization appended a user directive for every execution while the browser suppressed only its local retry echo. Retry now carries the original user run reference; the host verifies stream, agent and text before reusing that durable row. The original live restart reproduction passes in the owned repair. The HTTP regression fails on91c and passes with the fix; repeated retries, intentional equal messages, changed text and cross-stream references are covered. Full branch/integration gates and rebuilt installed verification remain release prerequisites.
