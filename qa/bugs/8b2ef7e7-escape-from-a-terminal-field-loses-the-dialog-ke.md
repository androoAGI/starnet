---
fingerprint: 8b2ef7e7
slug: escape-from-a-terminal-field-loses-the-dialog-ke
title: Escape from a terminal field loses the dialog keyboard boundary
surface: sessions
severity: P2
status: fixed
found: 2026-09-09
lane: agent/glass-demo-0909
fix: e6ecdd986
origin: audit
---

# Escape from a terminal field loses the dialog keyboard boundary

## Symptom

After Escape leaves a settings text field, keyboard focus drops to the page and a second Escape does not close the window.

## Repro

1. Open Settings in the seeded station.
2. Focus its empty search field and press Escape.
3. Press Escape again. Before the repair, the window remains open and focus is on BODY.

## Evidence

Live :9199 before: focusedTag=BODY, insideWindow=false, windows=1 after the second Escape. After: focus remains on the .gd-sheet dialog, then the second Escape reaches guarded close. test/glass-interactions.test.js exercises the actual stationui.js key handler and confirms the field value survives the first Escape.

## Verdict

The shared key handler called blur(), discarding the dialog keyboard boundary. Returning focus to the dialog preserves the two-step Escape behavior and existing unsaved-draft guard. Source repair awaiting final candidate checks; installed desktop not verified.
