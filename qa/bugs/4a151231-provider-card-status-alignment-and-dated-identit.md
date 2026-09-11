---
fingerprint: 4a151231
slug: provider-card-status-alignment-and-dated-identit
title: Provider card status alignment and dated identity artwork
surface: providers
severity: P2
status: open
found: 2026-09-11
lane: agent/providers-polish-0910
fix:
origin: owner
report: Owner screenshot and provider polish request, 2026-09-10
affected: Source 61528ba95; installed version unknown
family: provider-settings-presentation
installer: unverified
recovery: unconfirmed
---

# Provider card status alignment and dated identity artwork

## Symptom

Owner screenshot shows provider statuses offset beside actions, generic dots instead of the overseer provider logos, and an emoji link action. Affected source baseline: 61528ba95; screenshot installer version not supplied.

## Repro

1. Open Settings > Providers.
2. Compare NOT SIGNED IN, KEY SAVED and NOT LINKED alignment with the action buttons.
3. Compare provider artwork with new overseer creation.

## Evidence

Anchors: frontend/app/stationui.js:4342; test/provider-connections-ui.test.js; test/settings-codex-row.test.js.

Live seeded app on :18917, branch agent/providers-polish-0910: DOM receipt `{logos:18, alignment:true, animation:"ov-orbit", overflow:false}`. Reduced motion receipt `none`; narrow viewport overflow check `true` (all cards fit). Add-key editor opened; invalid credential was rejected by validation. A disposable saved-key fixture through Harness.setKey rendered `KEY SAVED · NOT VERIFIED`, grid column 2, then was cleared. StarNet action opened Store. Local evidence: dev/providers-proof.log, dev/providers-desktop.png. Focused existing contracts passed 54 and 26 assertions.

## Verdict

Implemented on the isolated lane. Source gate pending; installed delivery and owner recovery remain unverified.

## Sibling coverage

{
  "adapters": [
    {
      "target": "OAuth, API key, local and managed providers",
      "state": "covered",
      "test": "test/provider-connections-ui.test.js",
      "scenario": "provider status and action contracts",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "Settings provider cards and inline key editor",
      "state": "covered",
      "test": "test/settings-codex-row.test.js",
      "scenario": "Codex provider card action contract",
      "gate": "fast"
    }
  ],
  "displays": [
    {
      "target": "desktop, narrow viewport, reduced motion",
      "state": "blocked",
      "reason": "Live DOM checks passed; no registered automated geometry scenario. Installed desktop not rebuilt."
    }
  ],
  "lifecycle": [
    {
      "target": "saved-key and keyless rerenders",
      "state": "blocked",
      "reason": "Live disposable key fixture passed; no registered automated layout scenario."
    }
  ]
}
