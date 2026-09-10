---
fingerprint: 20a0796e
slug: turtle-rear-walk-faces-forward-and-wizard-staff
title: Turtle rear walk faces forward and wizard staff flickers
surface: world
severity: P2
status: open
found: 2026-09-10
lane: skin-motion-0910
fix:
origin: unknown
---

# Turtle rear walk faces forward and wizard staff flickers

## Symptom

Turtle faces the viewer while walking north. Wizard northwest walking alternates between a missing staff and a staff sticking above its hat.

## Repro

Compare ninjaturtle.walk.north with ninjaturtle.rot.north and inspect all voidwizard.walk.north-west frames. Run test/sprite-direction-details.test.js against e80acf63d assets: 16 failures.

## Evidence

The 4,195-frame disk audit and 13 contact sheets exposed both mismatches despite existing scale/alignment tests passing. Before images are recoverable from e80acf63d. Local detailed comparisons: .worldshots/frame-sweep-0910/turtle-detail.png and wizard-detail.png. Repaired sheets and deterministic import: dev/frame-sweep-sources and dev/import_frame_sweep.py.

## Verdict

Two generated eight-frame replacements match the intended rear view and staff placement. Only 16 frame assets and their website mirrors changed; source validation in progress.

## Regression

The old frames fail 16 design assertions; replacements pass all 56 assertions in test/sprite-direction-details.test.js. The running local app renders both repaired skins in all 16 directions with stable size and floor height, distinct poses and closed pivot cycles.
