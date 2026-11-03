---
fingerprint: 06331054
slug: chatgpt-plan-allowance-copy-hardcodes-a-weekly-r
title: ChatGPT plan-allowance copy hardcodes a weekly reset and never shows the provider's reset time
surface: providers
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/providers
fix: 0c22f4fb0
origin: audit
---

# ChatGPT plan-allowance copy hardcodes a weekly reset and never shows the provider's reset time

## Symptom

A ChatGPT (Codex) user who hits their plan allowance is told it "resets on ChatGPT's own schedule (a ChatGPT subscription resets weekly, not in seconds)". Codex also enforces a rolling multi-hour window, so the allowance may come back in hours; the provider's reset time is never shown.

## Repro

1. Classify `codex http 429 — The usage limit has been reached` (browser or node friendlyerror).
2. Read userMessage.

## Evidence

friendlyError → `quota_exhausted false | Your ChatGPT plan allowance is used up — it resets on ChatGPT's own schedule (a ChatGPT subscription resets weekly, not in seconds). …`. The copy is hardcoded in `frontend/app/friendlyerror.js` quotaMessage (`provider === 'codex' ? ' (a ChatGPT subscription resets weekly, not in seconds)'`) and KINDS.quota_exhausted. `sidecar/providers/codex.js` builds its message from `error.message || error.code` only, so any reset field in the 429 body never reaches the copy; `sidecar/providers/ratelimits.js` itself notes the real answer can be "spent for the next four hours". `test/friendlyerror.test.js:291` and `:642` pin /weekly/, so this was not changed in the sweep. No live Codex 429 body was captured (no exhausted account available) — the multi-hour window is from the repo's own ratelimits.js note and the 07-27 incident record, not from a captured payload.

_Found by the `sweep/providers` lane, 2026-10-20._

## Verdict

Confirmed and fixed on trunk in `0c22f4fb0` (2026-10-23, before the typed-outcomes lane, whose closes list carried it): a spent ChatGPT plan names both its short (hours) and weekly windows, and quotes the provider's own reset time whenever the error carries one (friendlyerror.js quotaResetIn over the message codex.js builds from the 429 body's error.message). The typed-outcomes lane only keeps that copy on the coded path: a station failureCode of quota_exhausted still reaches it (test/friendlyerror-codes.test.js). Residual, unverified: a reset time carried ONLY in a structured 429 field outside error.message is not read — no live Codex 429 body has been captured to show one exists.
