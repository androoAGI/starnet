---
fingerprint: 8b22d414
slug: saved-fallback-changes-model-without-switching-p
title: Saved fallback changes model without switching provider
surface: providers
severity: P1
status: open
found: 2026-09-11
lane: release-0112-finalprep-0911
fix:
origin: customer
report: https://github.com/androoAGI/starnet/issues/12
affected: 0.11.0 source on Windows
family: provider-fallback
installer: unverified
recovery: unconfirmed
---

# Saved fallback changes model without switching provider

## Symptom

After Codex reaches its quota, a saved OpenRouter fallback model is sent to Codex and fails as unsupported. Manually selecting OpenRouter works for the reporter.

## Repro

Reported sequence: select Codex as primary, save OpenRouter model `z-ai/glm-5.3-flash` in Settings fallback chain, then exhaust the primary quota. Observe provider/model in the failed continuation. This review has not yet reproduced the sequence in a running application.

## Evidence

[GitHub #12](https://github.com/androoAGI/starnet/issues/12), read September 11, 2026; open with no comments or recovery confirmation. Reported source starts `58dc520de`.

Current-source anchors: `frontend/app/stationui.js:5411` populates the fallback picker from the OpenRouter catalog and saves model strings; `sidecar/fallbackchain.js` validates string entries. `sidecar/index.js:16167` assembles model fallbacks using `fallbackModels.map(m => ({ provider, model: m }))`, retaining the primary provider instance. Explicit per-run provider fallbacks are a separate path and do not establish that Settings routes correctly.

## Verdict

Open. The inspected source is consistent with the reported failure; no source fix, installer proof or customer recovery is established. This report was absent from the original seven-report release census.

## Regression

Required: a controlled Codex quota failure followed by the saved OpenRouter route, asserting provider, model, credential/base URL and completed result. Cover saved-chain restart, missing fallback credentials, explicit per-run routes, and same-provider/environment defaults. Existing `test/fallback-chain.test.js` is not proof of this cross-provider execution.

## Sibling coverage
