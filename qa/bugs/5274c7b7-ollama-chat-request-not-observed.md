---
fingerprint: 5274c7b7
slug: ollama-chat-request-not-observed
title: Ollama run times out with no chat POST observed by reporter
surface: providers
severity: P2
status: open
found: 2026-09-16
lane: release-0120-prep-0915
fix:
origin: customer
report: support-2026-09-16-ollama-no-chat-post
affected: StarNet 0.11.2 Windows; Ollama 0.5.7; qwen2.5:7b; loopback 127.0.0.1:11434
family: local-provider-transport
installer: unverified
recovery: unconfirmed
---

# Ollama run times out with no chat POST observed by reporter

## Symptom

A no-tool request for an exact short answer reportedly times out after roughly ten minutes. The reporter observes model discovery and a second TCP connection with no bytes, but no chat POST. Direct native and OpenAI-compatible non-streaming requests succeed on the same machine. This is distinct from the small-model verbosity report.

## Repro

On the reported Windows/Ollama versions, capture all loopback HTTP traffic while sending a no-tool exact-answer prompt. Correlate the request with the failing run and compare the identical payload through bundled Node fetch and a direct client. The affected installation and packet capture are not available locally.

## Evidence

Fresh private intake read on 2026-09-16 reports provider_stream/timeout and durationMs 605102. Candidate anchors: sidecar/providers/openai-compatible.js:344 and test/provider.openai-compatible.test.js. A controlled local HTTP probe using the installed Node v22.23.2, production Ollama factory and native fetch observed GET /v1/models followed by all four expected chat POSTs, including a 128 KiB context; replies completed in 5-17 ms. Receipt: .dogfood/release-recovery/ollama-request-wire.json. This mock server is not Ollama 0.5.7 and does not establish customer recovery.

## Verdict

Open P2 under the engineering rule for uncorrelated reports. Do not attribute a missing request to model size or close this as the existing verbosity fix. Obtain the sanitized capture, startup/provider configuration and exact request payload size; reproduce with the affected Ollama/runtime before assigning a cause or source fix.
