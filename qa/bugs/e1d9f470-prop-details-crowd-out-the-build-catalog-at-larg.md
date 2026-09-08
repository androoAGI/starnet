---
fingerprint: e1d9f470
slug: prop-details-crowd-out-the-build-catalog-at-larg
title: Prop details crowd out the build catalog at larger UI scales
surface: world
severity: P2
status: fixed
found: 2026-09-07
lane: prop-panel-0907
fix: c6f77fff4
origin: customer
report: Owner relayed customer screenshot on 2026-09-07
affected: Build and platform unknown
family: prop-catalog-layout
installer: unverified
recovery: unconfirmed
---

# Prop details crowd out the build catalog at larger UI scales

## Symptom

Selected prop details occupy the bottom of the Build Kit while the gallery shrinks to a thin strip.

## Repro

1. Open Build Station, then Props and Decoration.
2. Select BIG SCREEN at 1366 x 768 with 115% text size.
3. Observe the gallery and selected-prop card heights; repeat with larger text.

## Evidence

Owner supplied Screenshot 2026-09-07 161249.png. Seeded live reproduction at 1366 x 768, 115% text scale: gallery 92.86 visual pixels, inspector 185.53 pixels. Layout anchor: frontend/css/refit-kit.css:112.

## Verdict

Source repair committed as c6f77fff4 and verified in the seeded running app. The compact summary retains the name, appearance/ability classification, dimensions and actions; full descriptions remain under About this prop. Installer and customer recovery remain unverified.

## Regression

Before: seeded 1366 x 768 at 115% scale, gallery 92.86px and inspector 185.53px.
After: gallery 184px and inspector 110.25px. Live DOM checks passed for decoration,
workstations/workflows, and abilities at 1366x768/115%, 1280x720/150%,
1024x600/130%, 1920x1080/100%, and 562x619/150%. Gallery scrolling and
About this prop -> Back to props (including focus restoration) passed in all 15 cases.
No browser warnings or exceptions. Scale was emulated with the production body zoom
and reciprocal CSS variable; physical device/installer behavior was not tested.
Local evidence: .tmp/prop-panel-proof/.prop-layout-proof.mjs and .prop-layout-results.json in the isolated lane.
Fast gate stopped at 83/731 (media-service missing dependency). npm ci then failed
with ENOSPC. Customer journeys failed at 12/30 (Telegram owner-pair acknowledgement).
Resume: dependencies installed successfully; all 30 customer journeys passed, and the
committed layout passed the 15 live cases again. Fast-gate completion pending.


## Sibling coverage

{"adapters":[{"target":"desktop and website CSS mirrors","state":"blocked","reason":"Mirrors synchronized and seeded browser verified; packaged WebView not tested."}],"entrypoints":[{"target":"Props: decoration, workstations/workflows, abilities; About and Back","state":"blocked","reason":"All 15 live DOM combinations passed; no registered automated layout scenario yet."}],"displays":[{"target":"short, narrow, desktop and 100-150% text scales","state":"blocked","reason":"Five viewport/scale combinations passed live emulation; physical customer display and installer unverified."}],"lifecycle":[{"target":"reload and catalog/detail transitions","state":"blocked","reason":"Fresh page loads and detail/back focus verified live; no registered layout lifecycle test."}]}

