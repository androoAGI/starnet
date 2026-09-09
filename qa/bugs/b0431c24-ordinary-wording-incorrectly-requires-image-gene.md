---
fingerprint: b0431c24
slug: ordinary-wording-incorrectly-requires-image-gene
title: Ordinary wording incorrectly requires image generation
surface: providers
severity: P1
status: fixed
found: 2026-09-09
lane: image-intent-0909
fix: e6cdd0f1a
origin: customer
report: support-screenshot-2026-09-09
affected: Unknown customer build; reproduced on trunk 41253b0bd
family: image-intent
installer: unverified
recovery: unconfirmed
---

# Ordinary wording incorrectly requires image generation

## Symptom

A customer reports phrases triggering an OpenRouter image requirement on another conversation provider. The screenshot omits the original prompt and build.

## Repro

With no media credential, submit "Draw a distinction between TCP and UDP" as a task. Before repair, the running sidecar emits an image-task error and ends with zero model turns. Docker-image and profile-picture coding requests also match the old classifier.

## Evidence

On trunk 41253b0bd, live /api/run returned agent.run.error followed by agent.run.end with reason error, turns 0 and usd 0 for the TCP/UDP prompt. The classifier in sidecar/image-task.js used unanchored keyword proximity and bare draw/illustrate matches. After repair, test/image-task.test.js passes 55 assertions and test/image-task.e2e.test.js passes 63 assertions through a real sidecar with local synthetic model/image responses.

## Verdict

Only direct visual-content requests enter the host image gate. Ambiguous wording and code/vector/text media use the ordinary model/tool path. The separate managed-credits repair did not fix this classifier. Installer verification and customer recovery remain unconfirmed.

## Regression

Before: the non-image TCP/UDP task failed before the model ran. After: five false-trigger prompts reach the configured custom conversation endpoint and finish without an image, both with and without STUDIO. Direct image requests still fail for a missing route or missing produced artifact and succeed with a saved PNG. Unit coverage includes quoted/discussed instructions, negation, cross-sentence matches and code/vector/text media.

## Sibling coverage

{
  "adapters": [
    {
      "target": "custom conversation without media credentials",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "five ordinary prompts reach configured model and complete as text",
      "gate": "http"
    },
    {
      "target": "OpenRouter image route",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "explicit requests still require produced image artifacts",
      "gate": "http"
    },
    {
      "target": "Codex, Anthropic, Gemini and managed conversation adapters",
      "state": "blocked",
      "reason": "The provider-independent classifier is covered; ordinary-prompt end-to-end runs on these adapters were not separately exercised."
    }
  ],
  "entrypoints": [
    {
      "target": "POST /api/run task admission",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "ordinary prompts with and without STUDIO do not enter the image gate",
      "gate": "http"
    },
    {
      "target": "Telegram, Discord, routines and delegated workers",
      "state": "blocked",
      "reason": "These share runOnce but their individual ingress paths were not exercised for this report."
    }
  ],
  "displays": [
    {
      "target": "run error and terminal event stream",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "no image error and done terminal for ordinary text",
      "gate": "http"
    },
    {
      "target": "installed desktop failure card",
      "state": "blocked",
      "reason": "No rebuilt installer or customer retest was performed."
    }
  ],
  "lifecycle": [
    {
      "target": "admission through completion",
      "state": "covered",
      "test": "test/image-task.e2e.test.js",
      "scenario": "text-only completion accepted without an image artifact; explicit image prose-only success rejected",
      "gate": "http"
    },
    {
      "target": "persisted sessions after restart",
      "state": "not-applicable",
      "reason": "Classification is computed from latest user text for each run; this repair changes no persisted state."
    }
  ]
}
