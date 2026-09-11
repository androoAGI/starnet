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
installer: verified
installerVersion: 0.11.1 private candidate 6e729e4cb
installerSha256: 5baadbf8483e601db257f2b1ce8855fbc494add5db64493f501a3d93e717efeb
installerEvidence: https://github.com/androoAGI/starnet/actions/runs/34569801784
recovery: unconfirmed
---

# Saved fallback changes model without switching provider

## Symptom

After Codex reaches its quota, a saved OpenRouter fallback model is sent to Codex and fails as unsupported. Manually selecting OpenRouter works for the reporter.

## Repro

Reported sequence: select Codex as primary, save OpenRouter model `z-ai/glm-5.3-flash` in Settings fallback chain, then exhaust the primary quota. Observe provider/model in the failed continuation. The real sidecar reproducer and installed-bundle scenario now cover that quota-to-fallback sequence with controlled upstreams.

## Evidence

[GitHub #12](https://github.com/androoAGI/starnet/issues/12), read September 11, 2026; open with no comments or recovery confirmation. Reported source starts `58dc520de`.

Current-source anchors: `frontend/app/stationui.js:5411` populates the fallback picker from the OpenRouter catalog and saves model strings; `sidecar/fallbackchain.js` validates string entries. `sidecar/index.js:16167` assembles model fallbacks using `fallbackModels.map(m => ({ provider, model: m }))`, retaining the primary provider instance. Explicit per-run provider fallbacks are a separate path and do not establish that Settings routes correctly.

## Verdict

Source fixed in 44c6b4952. Saved catalog fallbacks now use OpenRouter's endpoint and credential when leaving Codex or another provider. StarNet keeps its existing managed route; explicit per-run models and environment chains keep their primary provider. Paid fallback limits, auxiliary routing and ledger classification follow the active provider. Fallbacks cannot cross managed-credit payer boundaries without admission. Installed execution passed on the signed candidate; actual customer account recovery remains unconfirmed.

## Installed verification

Private signed build `6e729e4cb2ca151f2ca7f280d500c86393bf0046`, workflow 34569801784, passed this scenario using the installed Node runtime and source-matched installed sidecar. The executable SHA-256 is `28bca2f1196426eec6f4afaefa5a2f5b67cbafd3b354078e889c9d262ee87366`. Controlled provider/MCP endpoints and isolated stations were used; no customer account was contacted. Exact logs and receipts: `qa/evidence/0.11.2-issues-12-13/installer-verification.json`.

## Regression

`test/saved-provider-fallback.e2e.test.js` boots the real sidecar and both adapters against loopback upstreams with synthetic credentials. Before the fix it failed because the OpenRouter request never reached its endpoint. Afterward it completes on the saved GLM model with the OpenRouter credential, persists across restart, records actual paid cost as metered, and enforces dollar and unpriced-token ceilings. It proves saved-empty, environment and explicit-model precedence, and refuses to borrow Codex authentication when OpenRouter is disconnected. No real account quota was consumed.

## Sibling coverage

{"adapters":[{"target":"Codex to OpenRouter","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"real adapters, synthetic quota error, separate credentials, metered ledger and budget ceilings","gate":"http"},{"target":"other providers and managed accounts","state":"blocked","reason":"Exact cross-provider execution is proven for Codex/OpenRouter; no live managed-account transition was exercised."}],"entrypoints":[{"target":"Settings fallback API and interactive run","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"saved chain execution, explicit model override and empty/environment defaults","gate":"http"}],"displays":[{"target":"installed Settings and COMMS","state":"blocked","reason":"Installed backend execution passed; the Settings/COMMS visual path was not separately exercised in the installed WebView."}],"lifecycle":[{"target":"restart and disconnected fallback","state":"covered","test":"test/saved-provider-fallback.e2e.test.js","scenario":"repeat after restart and after removing the synthetic OpenRouter credential","gate":"http"}]}
