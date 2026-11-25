---
fingerprint: b1e69bfd
slug: anthropic-api-root
title: The official Anthropic API root sends model discovery to /models
surface: providers
severity: P1
status: fixed
found: 2026-11-25
lane: providers
fix: ab2d997ae6ad594716e5579e03268efa0ce5282d
origin: customer
report: https://github.com/androoAGI/starnet/issues/190
affected: 0.15.0, Windows 10
family: anthropic-onboarding
installer: unverified
recovery: unconfirmed
---

# The official Anthropic API root sends model discovery to /models

## Symptom

The model picker says the catalog is offline. Connecting Anthropic during onboarding returns HTTP 404 with a valid key.

## Repro

1. Set ANTHROPIC_BASE_URL to https://api.anthropic.com before launching StarNet.
2. Choose Anthropic during onboarding and validate a key.

## Evidence

Issue #190 reports HTTP 404 on Windows 10 and a successful retry with the variable unset. Before the fix, test/provider.anthropic.test.js captured a GET to https://api.anthropic.com/models.

## Verdict

The provider now uses its versioned default when the configured address is the official root.

## Regression

The catalog URL assertion failed on the original adapter and passed after the fix. The same test exercises an explicit /v1 and a custom root.

## Sibling coverage

{
  "adapters": [
    {
      "target": "native Anthropic and custom Anthropic root",
      "state": "covered",
      "test": "test/provider.anthropic.test.js",
      "scenario": "catalog request address with official root, explicit version, or custom host",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "Windows onboarding",
      "state": "blocked",
      "reason": "The reported desktop environment and a live API key were unavailable for this source test."
    }
  ],
  "displays": [
    {
      "target": "model picker",
      "state": "not-applicable",
      "reason": "The change only affects the address sent by the provider transport."
    }
  ],
  "lifecycle": [
    {
      "target": "desktop restart with inherited environment",
      "state": "blocked",
      "reason": "The provider input was exercised directly without restarting a Windows installer."
    }
  ]
}
