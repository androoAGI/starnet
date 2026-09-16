---
fingerprint: c9201c15
slug: run-metadata-invalidates-reusable-prompt-cache-a
title: Run metadata invalidates reusable prompt cache and unused fallback authentication delays primary requests
surface: providers
severity: P2
status: fixed
found: 2026-09-13
lane: latency-audit-0913
fix: 9b2ce2d35804623e97fa0a081cc11ffddd33d534
origin: owner
report: Owner requested latency repair on 2026-09-13 after a relayed customer slow-response report; specific customer run unavailable
affected: Source 7a087d3be and local v0.11.2 tag; customer version unknown
family: response-latency
installer: unverified
recovery: unconfirmed
---

# Run metadata invalidates reusable prompt cache and unused fallback authentication delays primary requests

## Symptom

Repeated agent replies can take longer than necessary. The reported customer model, effort and build are unknown; these are independently reproduced source-level contributors, not an established diagnosis of that particular customer run.

## Repro

1. Launch the seeded app and send two identical same-conversation requests.
2. Capture provider requests: before repair the 26,506-character system prompts first differ at character 210 (the run ID), invalidating the full Claude system cache boundary.
3. Configure an OAuth fallback and observe admission eagerly refresh its expiring token before the primary request.
4. Run test/prompt-cache-prefix.e2e.test.js and test/provider.registry.test.js for permanent wire and deferred-auth regressions.

## Evidence

Baseline source 7a087d3be; docs/audits/AGENT_LATENCY_2026-09-13.md records live measurements. Defective assembly: sidecar/index.js:16999; cached runtime run ID: sidecar/runtimeinfo.js:53. Fixed regression coverage in test/provider.anthropic.test.js, test/provider.openrouter.test.js, test/provider.registry.test.js and test/prompt-cache-prefix.e2e.test.js. Seeded three-adapter after-proof PASS. Tracked before/after request measurements: qa/evidence/latency-0913/cache-before.json and cache-after.json. The permanent HTTP regression fails on unchanged 7a087d3be (one system block instead of two) and passes on the repair.

## Verdict

Source repair proven: stable system instructions receive their own cache boundary, and OAuth fallbacks authenticate only when selected. All task instructions, capability gates, approvals, history and effort are retained. This fixes the independently reproduced mechanisms; it does not establish the unknown customer run's cause or recovery. Installer and affected-customer recovery remain unverified.

## Regression

Before: identical seeded requests first differed at character 210; native Claude emitted one fully volatile system cache block. After: first differing character is 25,729; explicit adapters cache the stable block independently, all three live adapters retain Task Brief controls and full tool definitions. Unit fallback streams preserve authentication/effort, activate only when selected, reuse a successful refresh, skip cancelled starts, and surface/recover refresh errors. Existing saved fallback HTTP scenarios pass, including credential isolation and restart.

## Sibling coverage

{
  "adapters": [
    {
      "target": "native Claude and Claude via OpenRouter",
      "state": "covered",
      "test": "test/prompt-cache-prefix.e2e.test.js",
      "scenario": "stable cache blocks across run IDs with full task context and tools",
      "gate": "http"
    },
    {
      "target": "generic compatible provider",
      "state": "covered",
      "test": "test/prompt-cache-prefix.e2e.test.js",
      "scenario": "unchanged string wire shape with full task context",
      "gate": "http"
    },
    {
      "target": "Codex Kimi Grok deferred OAuth",
      "state": "covered",
      "test": "test/provider.registry.test.js",
      "scenario": "no unused refresh; selected calls authenticate and preserve supported effort; cancellation and refresh recovery",
      "gate": "fast"
    },
    {
      "target": "other providers real cache efficiency",
      "state": "blocked",
      "reason": "No paid-provider cache or speed benchmark was performed; provider wire formats other than explicit Claude caches are unchanged."
    }
  ],
  "entrypoints": [
    {
      "target": "interactive runOnce via /api/run",
      "state": "covered",
      "test": "test/prompt-cache-prefix.e2e.test.js",
      "scenario": "three-adapter complete task prompt assembly",
      "gate": "http"
    },
    {
      "target": "saved fallback chain",
      "state": "covered",
      "test": "test/saved-provider-fallback.e2e.test.js",
      "scenario": "real adapter credential isolation and overrides",
      "gate": "http"
    },
    {
      "target": "scheduled messaging and delegated callers",
      "state": "blocked",
      "reason": "They share the repaired runOnce assembly; existing customer-journey gates exercise their behavior, but a per-surface real-provider cache-hit comparison is not available."
    }
  ],
  "displays": [
    {
      "target": "installed desktop and affected customer",
      "state": "blocked",
      "reason": "No installer rebuilt or customer run supplied. Seeded live HTTP proves request bytes, not installed WebView rendering or subjective responsiveness."
    }
  ],
  "lifecycle": [
    {
      "target": "saved fallback restart",
      "state": "covered",
      "test": "test/saved-provider-fallback.e2e.test.js",
      "scenario": "saved chain and credential isolation after restart",
      "gate": "http"
    },
    {
      "target": "successive runs and memory recall",
      "state": "covered",
      "test": "test/provider.openrouter.test.js",
      "scenario": "stable cache boundary with changing run context and leading recall; history not mutated",
      "gate": "fast"
    },
    {
      "target": "old recovery checkpoints",
      "state": "not-applicable",
      "reason": "Explicit prefix hints are deliberately omitted for recovered old prompts, preserving their provider-valid checkpoint bytes."
    }
  ]
}
