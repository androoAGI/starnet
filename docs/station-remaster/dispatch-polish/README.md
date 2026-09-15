# Kepler inbox, outbox and lighting polish

Preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler

The inbox (`intake`) now has a shallow receiving hopper, readable inward chevrons and a lower right roller outlet. The outbox has a straight horizontal inlet, compact side housing and empty collection tray. Both remain generated PNG artwork with their existing 2 x 2 footprints, world bounds and floor anchors. This is a visual candidate for owner review, not an assertion of final art approval.

The first generated replacements were rejected during the live conveyor check: the outbox inlet was too low and the inbox outlet too high. Selected v2 sources correct those connections in the artwork. Original runtime sprites are retained in `before/`; first candidates and selected masters are retained in `sources/`. The importer crops transparent margins, preserving the retained RGBA pixels. It does not rotate, stretch or repaint the machines. Exposure is 1.12. Generated prompts and hash receipts are stored alongside this document.

Indicator regions were remapped to the new lens slots. Their existing work/pending state gates remain in force; the artwork contains no fabricated completed packages or success labels.

## Lighting calibration

Measured in the running CRT lab and copied back to projection defaults:

| Control | Before | Selected |
| --- | ---: | ---: |
| Room light | 0.56 | 0.64 |
| Pool light | 0.92 | 1.00 |
| Lamp reach | 1.30 | 1.50 |
| Material ambient lift | 0.08 | 0.12 |
| Wall material gain | 0.82 | 0.90 |

Ambient lift is now exposed in the lab for reproducible tuning. The existing physical wall fixtures, occlusion, room colors and CRT grain remain active. Broader pools and modest fill improve the darker deck and back wall response. Classic defaults are unchanged.

## Verification, 2026-09-15

The live Kepler preview was reloaded after the selected assets and defaults were built. Fabrication was inspected at room framing and close zoom: both roller connections now meet their adjacent horizontal belt; the outbox no longer presents a diagonal ramp. Command was inspected at room framing for back wall and floor illumination. The live DOM reported 184 prepared prop views, zero failures, density 6, and 6,276,460 cached pixels.

Passed after the final asset import:

- `node test/projection-correction-assets.test.js`: 178 exports, retained pixels, footprints and receipts.
- `node test/projection-load-geometry.test.js`: 184 runtime alpha crops and source hashes.
- `node test/projection-prop-effects.test.js`: bindings, state gates and crop mapping.
- `node test/worldlight.test.js`: 127 assertions.
- `node test/worldrenderer.test.js`: depth order, camera and renderer lifecycle.
- `node --test test/kepler-showcase.test.js`: legal props, reachable rooms and routed intake-to-outbox line.

These focused checks do not constitute a full release gate. The earlier aggregate run has known planning-authority failures documented in the camera audit; it was not rerun or represented as passing here. No merge to trunk was performed.

Rebuild in order: `import-dispatch-polish.cjs`, `build-projection-correction.cjs`, `build-projection-load-geometry.cjs`, `build-projection-effects.cjs`, `audit-prop-sharpness.cjs` from `dev/industrial-textures/`.
