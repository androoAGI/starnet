---
fingerprint: 12203375
slug: glass-panel-height-resets-on-reopen
title: Glass panel height resets after closing and reopening
surface: world
severity: P2
status: open
found: 2026-09-10
lane: audit-0112-0910
fix:
origin: audit
---

# Glass panel height resets after closing and reopening

## Symptom

The new glass height control resizes the visible window but loses that choice when the window is recreated.

## Repro

Run node scripts/qa/audit-0112/live-probes.cjs against the seeded station. Open Settings at 1280x900, use ArrowUp twice on Resize panel height, close, reopen. The measured height changes 420 to 512 then returns to 420.

## Evidence

qa/evidence/0.11.2-audit/audit-live-probes.json records the real DOM-control round trip with zero page errors. frontend/app/glass-demo.js:118 creates per-node state with height:null; the pull-control handlers only write s.height. frontend/app/stationui.js:516 already owns durable termSize, but the new control bypasses it. test/glass-interactions.test.js and the live sweep cover resizing and reopen independently rather than preservation of the chosen height.

## Verdict

Open. Persist docked height per window key through the established window preferences; restore with viewport clamping. Keep maximize distinct from the remembered normal height. Verify close/reopen, minimize/restore, page reload and changed DPI. No layout redesign is needed.
