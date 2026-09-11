---
fingerprint: 8b22d414
slug: saved-fallback-changes-model-without-switching-p
title: Saved fallback changes model without switching provider
surface: providers
severity: P1
status: fixed
found: 2026-09-11
lane: release-0112-finalprep-0911
fix: 44c6b4952cd1e468f7caaf4d7ead804dc280cc40
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

Source fixed in 44c6b4952. Saved catalog fallbacks now use OpenRouter's endpoint and credential when leaving Codex or another provider. StarNet keeps its existing managed route; explicit per-run models and environment chains keep their primary provider. Paid fallback limits, auxiliary routing and ledger classification follow the active provider. Fallbacks cannot cross managed-credit payer boundaries without admission. Installer and customer recovery remain unconfirmed.

## Regression

`test/saved-provider-fallback.e2e.test.js` boots the real sidecar and both adapters against loopback upstreams with synthetic credentials. Before the fix it failed because the OpenRouter request never reached its endpoint. Afterward it completes on the saved GLM model with the OpenRouter credential, persists across restart, records actual paid cost as metered, and enforces dollar and unpriced-token ceilings. It proves saved-empty, environment and explicit-model precedence, and refuses to borrow Codex authentication when OpenRouter is disconnected. No real account quota was consumed.

## Sibling coverage

{"adapters":[{"target":"Codex to OpenRouter","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"real adapters, synthetic quota error, separate credentials, metered ledger and budget ceilings","gate":"http"},{"target":"other providers and managed accounts","state":"blocked","reason":"Exact cross-provider execution is proven for Codex/OpenRouter; no live managed-account transition was exercised."}],"entrypoints":[{"target":"Settings fallback API and interactive run","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"saved chain execution, explicit model override and empty/environment defaults","gate":"http"}],"displays":[{"target":"installed Settings and COMMS","state":"blocked","reason":"The new signed installer build is running; source HTTP and copy checks are not installed UI proof."}],"lifecycle":[{"target":"restart and disconnected fallback","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"repeat after restart and after removing the synthetic OpenRouter credential","gate":"http"}]}
