---
fingerprint: 6c6c34e1
slug: openai-image-model-selected-for-comms
title: OpenAI image model is routed through a chat completion path
surface: providers
severity: P2
status: fixed
found: 2026-09-16
lane: release-0120-prep-0915
fix: 7a9349aa071c8fd97f04b520333d37d821f55c69
origin: customer
report: support-2026-09-12-openai-image-model-comms
affected: StarNet 0.11.2 macOS arm64; gpt-image-2 selected while using COMMS/provider setup
family: image-versus-chat-routing
installer: unverified
recovery: unconfirmed
---

# OpenAI image model is routed through a chat completion path

## Symptom

The reported image-generation setup sends an image model through a conversational provider path and produces repeated upstream server errors. Diagnostics name gpt-image-2 and a configured credential; switching provider labels alone did not produce an image.

## Repro

Select an OpenAI image-only model in the prior general agent model picker and request image generation. Compare the corrected Studio image path against the ordinary agent chat-model picker using controlled image endpoint responses.

## Evidence

September 12 private diagnostics refreshed September 16. Repair 7a9349aa071c8fd97f04b520333d37d821f55c69 is included in immutable v0.12.0. frontend/app/modeldock.js:109 excludes image-only OpenAI models from agent chat choices; sidecar/image-task.js and sidecar/tools/builtin/image.js route the image task through Studio/native Images API. No matching reporter retest was received.

## Verdict

Source-fixed and included. Installer-specific image-generation behavior and reporter recovery remain unverified; general package ancestry is not promoted to either outcome.

## Regression

Before the repair, image-only selections could enter the chat path. The repaired image-task HTTP test exercises the native OpenAI Images endpoint and verifies a real saved PNG before the run can claim done; provider/tool tests cover the image call and result handling. The affected customer's real API request was not replayed.

## Sibling coverage

{"adapters":[{"target":"native OpenAI Images request","state":"covered","test":"test/image.test.js","scenario":"image generation transport and returned artifacts","gate":"fast"}],"entrypoints":[{"target":"Studio image task from a real sidecar run","state":"covered","test":"test/image-task.e2e.test.js","scenario":"native Images API response produces a saved PNG and artifact-backed completion","gate":"http"}],"displays":[{"target":"affected installed agent model picker","state":"blocked","reason":"Source filter is present; this reporter has not retested the exact candidate installer."}],"lifecycle":[{"target":"recorded image task run metadata","state":"covered","test":"test/runstore.test.js","scenario":"image task modality persists with its recorded run","gate":"fast"}]}
