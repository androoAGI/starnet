---
fingerprint: 84e26970
slug: approved-agent-sprites-remain-behind-preview-swi
title: Approved agent sprites remain behind preview switch in normal desktop
surface: world
severity: P1
status: fixed
found: 2026-09-16
lane: agent/release-0120-prep-0915
fix: df4d1ba25
origin: owner
report: Owner release acceptance, September 16 2026
affected: 0.12.0 local candidate 725664380
family: production-skin-activation
installer: unverified
recovery: unconfirmed
---

# Approved agent sprites remain behind preview switch in normal desktop

## Symptom

The rebuilt station has new props but agents and portraits still show the old artwork.

## Repro

1. Install candidate 725664380 and open an existing station normally, without a skinSet query.
2. Inspect the crew floor and portraits.
3. Observe that saved skin IDs still resolve to legacy DATA.SKINS sets. The selected art is visible only in the localhost study preview.

## Evidence

`.dogfood/release-recovery/sprites-before.json` records the real Tauri origin, preview=false, all 26 saved skin IDs, resolved legacy sets/scales, and legacy portrait datasets. `frontend/app/skin-study-preview.js` installs the selected manifest only when skinSet=study; the normal registry and manifest lacked the production selection and full animation tracks.

## Verdict

Source fix df4d1ba25 promotes the approved roster and complete motion tracks, maps existing IDs without rewriting saves, and aligns leader loading, scaling, portraits, and preload. The retired duplicate minionchar resolves to approved Station Minion. Source proof passes; final installed acceptance remains required.

## Regression

`test/world-immersion-characters.test.js` executes the production registry and renderer: all 37 selected sets, exact approved frame bytes/order, all four walking directions, measured foot placement, and fallback/leader resolution. `scripts/qa/installed-graphics.mjs` requires actual installed draw tracks and loaded portraits with preview disabled.

## Sibling coverage

{
  "adapters": [{"target":"normal sprite loader","state":"covered","test":"test/world-immersion-characters.test.js","scenario":"full selected tracks load and draw without preview hooks","gate":"fast"}],
  "entrypoints": [{"target":"persisted and default skin IDs","state":"covered","test":"test/world-immersion-characters.test.js","scenario":"saved IDs resolve to approved sets and fallback is approved Android","gate":"fast"}],
  "displays": [{"target":"floor and animation scale","state":"covered","test":"test/world-immersion-characters.test.js","scenario":"selected native scale and per-frame floor contact","gate":"fast"},{"target":"installed portraits and picker","state":"blocked","reason":"Requires final installed candidate verification."}],
  "lifecycle": [{"target":"installed restart with saved station","state":"blocked","reason":"Requires rebuilt candidate and persisted identity comparison."}]
}
