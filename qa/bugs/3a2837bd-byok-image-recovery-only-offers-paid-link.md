---
fingerprint: 3a2837bd
slug: byok-image-recovery-only-offers-paid-link
title: BYOK image recovery omits the supported OpenRouter key option
surface: providers
severity: P2
status: open
found: 2026-09-10
lane: audit-0112-0910
fix:
origin: audit
---

# BYOK image recovery omits the supported OpenRouter key option

## Symptom

A BYOK user without a media route is told only to link a StarNet account even though connecting a separate OpenRouter key is supported by the resolver.

## Repro

Run node scripts/qa/audit-0112/byok-recovery.cjs. On a disposable unlinked station, submit an explicit image task using a custom conversation provider, with studio available and no OpenRouter media key. The pre-inference error says to link this station to your StarNet account.

## Evidence

qa/evidence/0.11.2-audit/audit-byok-recovery.json captures the actual sidecar admission error and zero-turn error terminal. sidecar/image-task.js:44 supports a station OpenRouter key for non-managed runs but sidecar/image-task.js:67 offers only the StarNet-link remedy. sidecar/tools/builtin/image.js:181 repeats the link-only recovery. test/image-task.test.js currently asserts that narrowed wording.

## Verdict

Open. Distinguish managed-link failures from BYOK missing-media-credential failures. Offer both supported setup paths to BYOK users, with specific reconnect guidance for a managed selection. Keep provider credentials scoped and do not silently change billing routes.
