---
fingerprint: 25120f27
slug: projects-overview-remains-loading-after-a-valid
title: Projects overview remains loading after a valid nonempty response
surface: sessions
severity: P1
status: open
found: 2026-09-18
lane: projects-loading-0918
fix:
origin: customer
report: Owner-forwarded support report, 2026-09-18
affected: 0.12.3 Windows 11 x64
family: projects-rendering
installer: unverified
recovery: unconfirmed
---

# Projects overview remains loading after a valid nonempty response

## Symptom

Projects stays at loading projects after adding even a tiny folder; Diagnostics records an unhandled page rejection although the trusted-project backend responds.

## Repro

1. Boot an isolated seeded station.
2. Add an existing folder through Projects > ADD.
3. Observe GET /api/projects return a nonempty projects array while the rail stays loading.

## Evidence

Live baseline 882897d52: valid nonempty HTTP response, zero project rows, loading projects text, and ReferenceError: st is not defined in renderProjectsOverview. The same defective expression exists in tag v0.12.3. Local receipts: .dogfood/projects/before.json and after.json. Regression anchor: test/projects-view.test.js.

## Verdict

The overview incorrectly referenced a session-only status variable. Its rejection fallback rendered the same cached rows and threw again. Remove that reference, cache only successfully rendered snapshots, and contain cached-renderer failures. No persistence or permission changes. Installer and affected-customer recovery remain unverified.

## Regression

The baseline live app reproduces the exact symptom and ReferenceError; patched live app lists the same stored root with zero page exceptions. Production-renderer tests cover trusted/revoked rows, stale rows on network failure, terminal recovery text on renderer failures, retry recovery, and a genuinely empty ledger.



## Sibling coverage

{
  "adapters": [
    {
      "target": "provider-independent Projects response renderer",
      "state": "covered",
      "test": "test/projects-view.test.js",
      "scenario": "nonempty trusted and revoked overview renders actual accessible rows",
      "gate": "fast"
    }
  ],
  "entrypoints": [
    {
      "target": "Projects tab and Add folder refresh",
      "state": "covered",
      "test": "test/projects-view.test.js",
      "scenario": "successful nonempty response ends loading",
      "gate": "fast"
    },
    {
      "target": "native folder picker",
      "state": "blocked",
      "reason": "Picker itself unchanged; live checks use the typed-folder ADD doorway."
    }
  ],
  "displays": [
    {
      "target": "overview and failed-refresh message",
      "state": "covered",
      "test": "test/projects-view.test.js",
      "scenario": "offline refresh preserves real project rows with stale warning",
      "gate": "fast"
    },
    {
      "target": "Windows packaged WebView2",
      "state": "blocked",
      "reason": "Source proven in seeded Windows Chromium; a rebuilt installer is not part of this source merge."
    }
  ],
  "lifecycle": [
    {
      "target": "render failure and subsequent refresh",
      "state": "covered",
      "test": "test/projects-view.test.js",
      "scenario": "later successful refresh recovers without resetting data",
      "gate": "fast"
    },
    {
      "target": "installed restart and customer state",
      "state": "blocked",
      "reason": "No access to affected installation; installer and customer recovery remain unverified."
    }
  ]
}


