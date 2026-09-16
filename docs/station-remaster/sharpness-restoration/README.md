# Prop sharpness restoration — September 15

The owner reported a blurry workstation at close zoom and requested a catalog audit, while explicitly approving the lighting and asking for slightly more wall coverage.

Seven source views fell below the six-source-pixels-per-world-pixel close-zoom budget: desk south/north, crate south, chair south, partition west, large rug and deck perimeter. Eight labeled plates covering all 184 exports were visually inspected, followed by individual inspection of the seven low-resolution sources and browser comparisons at 6x. The desk, crate and chair were the clearest blur outliers.

All seven now use built-in image-generation fidelity restorations. The importer preserves RGBA pixels and crops transparent margins only. Previous runtime PNGs remain in `frontend/assets/industrial/sharpness-restoration/before/`; generated masters, prompts, hashes and export rectangles are retained. The initial four-view sheet's perimeter remained too small, so a separate larger frame was generated. Footprints and world bounds are unchanged. Uniform fitting preserves source proportions; these are new candidate rasters, not pixel-identical upscales or renewed owner approval.

The projection renderer now caches props at 6x instead of 4x, matching the camera maximum. The original 12-million-pixel budget remains enforced. Live browser DOM diagnostics report every prepared view, failures, cache density and allocated pixel count after loading. These measurements describe asset preparation, not visual acceptance.

Lighting uses the existing profile without changing CRT, grain, ambient, original fixture positions, gains or colors. A fixed physical-grid infill option adds a smaller, weaker practical only between existing lamps on suitable back walls. In the actual Kepler geometry it adds **one** source: `wall:24,0` in command, radius 49.2 world pixels and base gain 0.48. Housing, visibility and wall checks are the same as existing fixtures. Other candidate positions are rejected by the real room geometry; no invisible source is invented.

## Verification

- Live Kepler command inspected at room and maximum zoom: desk controls/contours are clearer, floor contact is retained, CRT grain remains, and the additional back-wall fixture is visible.
- Final live load: 184 views, zero preparation failures, cache density 6, 6,276,640 allocated pixels. Fabrication crates also inspected at maximum zoom beside the unchanged floor and locker.
- Source comparison page: `/prop-sharpness-audit.html`, seven before/after pairs at 1x, 3x and 6x; all 184 records available.
- Runtime alpha/hash geometry, all source-pixel receipts, effect bindings/state contracts, tabletop mounts, prop contracts, depth rendering, wall-fixture planning, lighting and renderer focused checks pass.
- Every source's measured alpha rectangle now supports 6x without enlargement; this is enforced in the runtime-geometry test. Source resolution alone does not prove style, camera or in-room quality. The earlier camera audit remains open for its separately identified concerns.
- The previous aggregate `test:fast` attempt stopped on existing planning-authority failures recorded in `dev/.scratch-workspace/camera-audit/test-fast.log`; no full-suite green or merge is claimed here.

## Rebuild

Run `import-sharpness-restoration.cjs`, `build-projection-correction.cjs`, `build-projection-load-geometry.cjs`, `build-projection-effects.cjs`, then `audit-prop-sharpness.cjs` from `dev/industrial-textures/`, with the repository root as the working directory. Existing checked-in source masters make the importer reproducible without generation.
