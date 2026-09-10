---
fingerprint: 1600dcf0
slug: late-model-catalog-reverts-new-provider-choice
title: Late model catalog response overwrites a newer provider selection
surface: providers
severity: P1
status: open
found: 2026-09-10
lane: audit-0112-0910
fix:
origin: audit
---

# Late model catalog response overwrites a newer provider selection

## Symptom

An outstanding catalog refresh for provider A can overwrite a later choice of provider B and clear its model. This is inherited by 0.11.1, not proven to be introduced by this release or to explain a particular customer account.

## Repro

Run node scripts/qa/audit-0112/live-probes.cjs against the isolated seeded station on port 19312. The controlled browser probe holds the Ollama catalog response, selects StarNet / anthropic/test-model through the shipped Harness setters, then releases the response. The resulting state is ollama / empty model. The browser runs the real released ModelDock module; the catalog transport is fault-injected.

## Evidence

qa/evidence/0.11.2-audit/audit-live-probes.json records chosen starnet / anthropic/test-model and final ollama / empty, with no page errors. frontend/app/modeldock.js:468 captures active before awaiting Promise.all; frontend/app/modeldock.js:226 reconciles that old provider against the current model and calls Harness.setProv(p). The same capture/reconcile sequence exists in v0.11.0. test/model-provider-reconcile.test.js tests sequential reconciliation, not an in-flight provider change.

## Verdict

Open. Fence catalog application by selection generation, agent/session identity and current provider/model. Delayed requests may update their own cache but must not mutate a newer selection. Add browser and deterministic regressions for A-to-B, A-to-B-to-A, same-provider model change, relink, and failure; verify saved selection after restart. Do not infer affected-customer recovery from this synthetic catalog reproduction.
