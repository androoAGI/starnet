---
fingerprint: a555c9a4
slug: windows-output-folder-default-location
title: Windows OPEN FOLDER opens Explorer at its default location
surface: release
severity: P1
status: fixed
found: 2026-11-15
lane: contribution/windows-open-folder
fix: 51dfe04e6f7c37a18d6038190f9936a1e67f4978
origin: owner
report: Owner desktop usability report with sanitized reproduction in this pull request
affected: Windows x64 StarNet 0.15.0
family: output-folder-navigation
installer: unverified
recovery: unconfirmed
---

# Windows OPEN FOLDER opens Explorer at its default location

## Symptom

A completed output opens in its default application or Explorer opens its default location. The user cannot reach the actual containing directory with one clear click.

## Repro

1. On Windows, produce a report in a trusted project with spaces, for example E:\Example Workspace\Creator Project\mission-004-quality-review\LEAD_QUALITY_REPORT.md.
2. Open the completed file card in COMMS or MY WORK > DELIVERABLES.
3. Before the fix, the icon-only folder action may pass the entire /select,<path> string as one quoted Rust process argument and Explorer fails to select the file. Image cards can lack the action.
4. After the fix, click OPEN FOLDER once: Explorer opens the actual parent and selects the file. OPEN FILE remains distinct.

## Evidence

Production regression anchors: test/windows-output-folder.test.js, test/desktop-artifact-open.test.js and src-tauri/src/reveal.rs. The unchanged resolver still rejects missing, protected and unauthorized paths.

The original Rust Explorer invocation was replayed against a real Windows path with spaces and opened an unrelated default directory while process creation succeeded. The repaired native API selected real Markdown, PNG, SVG and Python files. Actual Tauri desktop acceptance used an isolated synthetic station: COMMS and DELIVERABLES selected the correct files; an agent-relative report and visible missing-file error were verified. Full optimized build and bundled-code integrity passed. The same approved production payload was subsequently installed locally after a verified cold backup: actual COMMS and DELIVERABLES each selected the report in Explorer, with additional PNG, SVG and Python navigation checks. Existing agents, models, conversations, permissions and project outputs were compared with the backup. This is local whole-app acceptance, not a signed-installer or reporter-confirmed recovery claim. Private captures, logs, station data and absolute customer paths are deliberately excluded.

## Verdict

Source fix 51dfe04e6f7c37a18d6038190f9936a1e67f4978. Native Windows reveal uses Unicode shell APIs rather than command-line switch parsing. The existing path resolver is unchanged. Windows folder navigation no longer asks a second host confirmation; OPEN FILE and external URL confirmations remain, and other platforms retain their reveal confirmation. No agent capability, shell access or filesystem grant is added. Official installer and reporter-confirmed recovery remain unverified.

## Regression

Before: Explorer argument quoting can navigate to its default location, folder controls are hidden or missing on sibling cards, and failed reveals silently copy the path. After: visible OPEN FOLDER invokes the native reveal once, preserves project/agent context and reports the native error. OPEN FILE remains separate. The production-renderer regression and native module tests cover these bounds.

## Sibling coverage

{
  "adapters": [
    {
      "target": "Windows Explorer shell selection",
      "state": "covered",
      "test": "test/desktop-artifact-open.test.js",
      "scenario": "Windows reveal routes to the bounded native module after existing resolver authorization; OPEN FILE gate remains separate",
      "gate": "fast"
    },
    {
      "target": "macOS and Linux reveal",
      "state": "blocked",
      "reason": "Non-Windows confirmation and reveal branches are unchanged; no physical non-Windows desktop was tested."
    }
  ],
  "entrypoints": [
    {
      "target": "COMMS file, image, media and recap cards",
      "state": "covered",
      "test": "test/windows-output-folder.test.js",
      "scenario": "Production renderers expose a one-click native folder action, retain project/agent path context, suppress duplicate calls, and show missing/denied errors",
      "gate": "fast"
    },
    {
      "target": "MY WORK DELIVERABLES",
      "state": "covered",
      "test": "test/windows-output-folder.test.js",
      "scenario": "Production location actions keep OPEN FOLDER and OPEN FILE separate and resolve the saved project location",
      "gate": "fast"
    },
    {
      "target": "delegated worker receipts",
      "state": "blocked",
      "reason": "The receipt calls the same existing folderButton seam; no separate actual delegated run was started for this navigation repair."
    }
  ],
  "displays": [
    {
      "target": "Desktop COMMS and DELIVERABLES",
      "state": "blocked",
      "reason": "Actual Windows Tauri debug and optimized desktop apps were manually verified with a synthetic profile. Native Explorer selected Markdown, PNG, SVG, Python and an agent report. Those UI clicks are not a registered automated gate."
    },
    {
      "target": "default-width DELIVERABLES layout",
      "state": "blocked",
      "reason": "Actual 550px panel was visually checked after placing folder/copy controls below the filename. No automated geometry assertion is claimed."
    },
    {
      "target": "browser website fallback",
      "state": "blocked",
      "reason": "Browser COPY PATH branch is unchanged and the generated mirror was synchronized. The new renderer regression exercises the native bridge; no separate actual browser fallback click is claimed."
    }
  ],
  "lifecycle": [
    {
      "target": "missing or invalid deliverable",
      "state": "covered",
      "test": "test/windows-output-folder.test.js",
      "scenario": "Missing/denied native errors are visible; a failed reveal does not silently copy the path or open the file",
      "gate": "fast"
    },
    {
      "target": "repeated clicks",
      "state": "covered",
      "test": "test/windows-output-folder.test.js",
      "scenario": "Concurrent reveal clicks are suppressed and the control recovers after completion",
      "gate": "fast"
    },
    {
      "target": "official signed installer upgrade",
      "state": "blocked",
      "reason": "No signed installer was built. A locally compiled whole-app payload has separate private deployment/rollback records; it is not an official installer verification."
    }
  ]
}
