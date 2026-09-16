---
fingerprint: 4a108286
slug: desktop-bundle-drops-required-calibration-textur
title: Desktop bundle drops required calibration texture and disables graphical refresh
surface: release
severity: P1
status: fixed
found: 2026-09-16
lane: agent/release-0120-prep-0915
fix: d1848af00
origin: owner
report: Owner installer report, September 16 2026
affected: 0.12.0 local candidate fd55ee2b2
family: packaged-runtime-asset-closure
installer: unverified
recovery: unconfirmed
---

# Desktop bundle drops required calibration texture and disables graphical refresh

## Symptom

The 0.12.0 installer shows the old station materials and props although the graphical refresh is merged.

## Repro

1. Install candidate `fd55ee2b2` and open the station with the default graphics settings.
2. Attach to the installed WebView and await `IndustrialTextures.ready` and `PropRemaster.ready`.
3. Observe `IndustrialTextures.status()`: requested true, loaded false, failed calibration/crate. The document reports texturePack=fallback and textureRevision=native.

## Evidence

Live installed capture: `.dogfood/release-recovery/installed-before.json` and `installed-before.png`. Origin `http://tauri.localhost`; shell and sidecar identify clean `fd55ee2b26fcb30ebc9397f43af429d4b25ebb5d`; executable SHA-256 `d39e448078e5b1aaa43d51c56f2bbce3fbbbc5b41c308d4ecd8aa9ca6611144d`.

`frontend/app/industrialtextures.js` constructs a required request for calibration/crate.png; `scripts/stage-frontend-dist.mjs` omitted that folder. The new production-loader regression in `test/frontend-dist-staging.test.js` fails three checks before the staging correction and passes all 301 assertions afterward. A deliberately omitted crate still reproduces global fallback, proving the detector catches the defect.

## Verdict

Package the required calibration texture. Source regression passes; installed acceptance must additionally show loaded=true, no failed textures, enabled remastered props, and bridge-remaster in the actual Tauri WebView.

## Regression

`test/frontend-dist-staging.test.js` executes the production texture loader using only existing assets accepted by the packaging filter, including dynamically assembled URLs.

## Sibling coverage

{
  "adapters": [{"target":"packaged desktop asset filter","state":"covered","test":"test/frontend-dist-staging.test.js","scenario":"execute the production loader with only staged, existing assets","gate":"fast"}],
  "entrypoints": [{"target":"local and CI desktop builds","state":"covered","test":"test/frontend-dist-staging.test.js","scenario":"all desktop build paths stage the same required texture set","gate":"fast"}],
  "displays": [{"target":"industrial textures and prop enablement","state":"covered","test":"test/frontend-dist-staging.test.js","scenario":"pack loads and isRemaster is true; missing crate reproduces global fallback","gate":"fast"}],
  "lifecycle": [{"target":"clean package rebuild","state":"covered","test":"test/frontend-dist-staging.test.js","scenario":"required assets survive the packaging filter and exist in source","gate":"fast"},{"target":"installed reload and restart","state":"blocked","reason":"Requires the rebuilt candidate and actual installed WebView proof."}]
}
