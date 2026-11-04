---
fingerprint: 7275bbf0
slug: claude-sign-in-refusals-lose-their-specific-post
title: Claude sign-in refusals lose their specific post-mortem guidance
surface: providers
severity: P2
status: fixed
found: 2026-11-03
lane: batch3-next-fixture-repairs-1103
fix: 6aff8f2df
origin: audit
---

# Claude sign-in refusals lose their specific post-mortem guidance

## Symptom

The post-mortem for a refused Claude sign-in request falls back to generic failure reporting instead of keeping the known installation, sign-in or temporary status-check guidance.

## Repro

Run `node test/slag-known-error-kinds.test.js`. The regression passes each of the four Claude CLI refusal kinds through the shipped post-mortem classifier and checks its named-action or retry bucket. The actual host states are independently exercised by `test/provider-cli-admission.http.test.js`.

## Evidence

`gen-trees/_logs/codex-overnight-1103/cli-slag-classification-old.log` records 8 failed assertions against the original classifier. `cli-slag-classification-current.log` records all 226 assertions passing after the repair. The frontend and shipped website mirror contain identical classification changes. These are focused classifier checks, not installed-build or live-account acceptance.

## Verdict

Missing installation and signed-out states now retain named guidance; checking and temporarily unavailable status use the retry bucket. No retry or provider call is dispatched by this presentation change. Combined candidate gates and final independent review remain pending.
