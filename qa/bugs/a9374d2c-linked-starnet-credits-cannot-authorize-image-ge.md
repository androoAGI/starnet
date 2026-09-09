---
fingerprint: a9374d2c
slug: linked-starnet-credits-cannot-authorize-image-ge
title: Linked StarNet credits cannot authorize image generation
surface: providers
severity: P1
status: fixed
found: 2026-09-09
lane: managed-image-repair-0909
fix: 05fbfbd28
origin: customer
report: support-image-route-2026-09-09
affected: v0.10.13 Windows desktop; also reproduced on trunk 76d06117d
family: managed-media
installer: unverified
recovery: unconfirmed
---

# Linked StarNet credits cannot authorize image generation

## Symptom

A linked credits-only station refuses an image task and asks the customer to connect OpenRouter, despite having a StarNet credential.

## Repro

1. Save a funded station link; configure no OpenRouter key.
2. Run a StarNet agent with STUDIO and request an image.
3. Original ImageTask.resolveRoute rejects before any provider call with openrouter-key-required.

## Evidence

The new test/managed-image.e2e.test.js fails against the original router with the exact customer-facing OpenRouter-key blocker and an error terminal. With the repair, the actual sidecar saves and serves the fixture PNG, returns done, and repeats after restart. Running the same journey with STARNET_TEST_CLOUD_ROOT pointed at a local starnet-cloud checkout exercises its actual createApp and SQLite ledger: an upstream image cost of 0.02 debits exactly 0.025 with configured 1.25 margin. Credentials are disposable and the upstream image response is synthetic; no customer account or live vendor call was used.

## Verdict

The desktop router only recognized OpenRouter credentials; the cloud already supports image modalities and meters non-streamed image completions. Managed media now uses the linked credential and endpoint together, independently of a conversation endpoint override. StarNet runs fail closed when that route is missing, and no longer instruct customers to connect OpenRouter. No cloud source change is needed. The local cloud checkout used for ledger proof was 518e6ce. The same proof also passed through node dev/seed.js --keep. Installer verification and reporter recovery remain unverified.

## Regression

Before: the real sidecar emitted the original blocker with a saved managed link. After: managed-only image generation writes a real PNG and serves identical bytes, survives sidecar restart, and uses the linked route after a custom-provider switch. HTTP 402/503 and successful responses containing no image cannot earn done. Original OpenRouter and missing-route regressions remain covered.

## Sibling coverage

{
  "adapters": [
    {
      "target": "StarNet managed media",
      "state": "covered",
      "test": "test/managed-image.e2e.test.js",
      "scenario": "credits-only image, exact fixture debit, failure responses",
      "gate": "http"
    },
    {
      "target": "OpenRouter BYOK",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "direct key image generation and artifact completion",
      "gate": "http"
    },
    {
      "target": "Gemini, Codex, Anthropic and custom conversation providers",
      "state": "covered",
      "test": "test/image-task.test.js",
      "scenario": "all resolve linked managed media independently of conversation credentials",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "direct run",
      "state": "covered",
      "test": "test/managed-image.e2e.test.js",
      "scenario": "POST /api/run generates through saved managed media route",
      "gate": "http"
    },
    {
      "target": "routine, sample, Telegram and Discord",
      "state": "blocked",
      "reason": "These share runOnce and the repaired media resolver; image-specific executions through their ingress were not separately exercised."
    }
  ],
  "displays": [
    {
      "target": "artifact download and terminal",
      "state": "covered",
      "test": "test/managed-image.e2e.test.js",
      "scenario": "saved PNG served through /api/file and artifact-backed done",
      "gate": "http"
    },
    {
      "target": "installed Windows desktop",
      "state": "blocked",
      "reason": "No rebuilt signed installer or customer device retest is available."
    }
  ],
  "lifecycle": [
    {
      "target": "restart and provider switch",
      "state": "covered",
      "test": "test/managed-image.e2e.test.js",
      "scenario": "saved link reused after restart; custom conversation uses managed image token",
      "gate": "http"
    },
    {
      "target": "missing credential or endpoint",
      "state": "covered",
      "test": "test/image-task.test.js",
      "scenario": "missing managed route fails closed without switching to BYOK",
      "gate": "fast"
    }
  ]
}
