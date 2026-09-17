---
fingerprint: ebe2861a
slug: unavailable-oauth-model-catalog-clears-the-saved
title: Unavailable OAuth model catalog clears the saved model selection
surface: providers
severity: P1
status: open
found: 2026-09-17
lane: release-0120-prep-0915
fix:
origin: audit
---

# Unavailable OAuth model catalog clears the saved model selection

## Symptom

After restarting the installed 0.12.1 candidate, the commander's saved Codex model was blank. The agent roster, conversations, histories, station and other compared settings remained intact.

## Repro

In the installed app, choose an available Codex model. Make the catalog request return HTTP 200 with `{models:[], error:'temporary catalog failure'}` and refresh the model dock. The saved agent model becomes empty despite no user selection change. Restore the real transport and original model after the controlled test. Offline fallback catalog rows exercise the same authority mistake through sibling providers.

## Evidence

Official Windows 0.12.1 installer SHA-256 `03458b3af97eca364c7228609708e6c8640e1b1ac26f07abd31f6f9b069003db`, source `9bf98816021fc0d74d4e35c47ec9a1a06b9f2948`. The release lane's `.dogfood/release-recovery/official-0121-data-preservation-original-failure.json` records the failed agent-setting comparison; `official-0121-agent-settings-diff.json` isolates the model field. `catalog-failure-before.json` reproduces the clearing in the actual installed UI with an explicit HTTP 200 error fixture, then restores the original selection. The precise initial startup response was not captured; a subsequent live catalog includes the original model.

Anchors: `frontend/app/modeldock.js` catalog confirmation; `frontend/app/harness.js` catalog normalization; `sidecar/index.js` public catalog serialization; `test/model-provider-reconcile.test.js`; `test/model-catalog-truth.test.js`.

## Verdict

Open release blocker. HTTP success alone does not prove catalog availability. Error envelopes and provider-marked offline seeds must preserve the selected model; a successful live catalog may still invalidate a genuinely removed model. Candidate 0.12.1 is held before publication. No customer recovery is inferred.
