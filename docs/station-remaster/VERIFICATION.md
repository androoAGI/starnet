# Bridge remaster preview — September 13, 2026

## Implemented coverage

The attached bridge is the art authority: charcoal gunmetal, layered mechanical construction, fine wear, restrained brass and amber hardware, cyan displays. The blank white Cadet stays as requested.

- 24 distinct floor materials with an 8 × 8 game-tile repeat, seven authored wall-bay materials, and exterior shell cladding.
- Front, side and rear workstation views; west mirrors the physical east view. Broad desks occupy 3 × 1 or 1 × 3 tiles, and saved compact variants keep 2 × 1 or 1 × 2. Cabinet floor contact and standing height are fitted separately from monitor overhang.
- Directional prop chairs, matching workstation approach positions, and a refresh when authored textures finish loading.
- Dark mechanical conveyor casings, correct travel direction through straight runs and all eight bends. Existing real work-state gating is preserved.
- Native detail and material revisions across the 160-entry prop catalog, including 12 new cosmetic props: locker, drawer bank, supply cart, tool caddy, planter, partition, bench, round table, service cabinet, service panel, floor vent, and cable tray.
- Selected material, paint, detail level, negative world coordinates and wall phase remain effective. The complete classic renderer remains available with ?textures=classic. A failed required image falls back as one pack rather than displaying a partial mix.

This is a running visual remaster candidate. Existing catalog props combine native geometry and material detail; they are not 160 independently authored raster images. Matching the reference exactly and final aesthetic approval remain visual judgments.

## Evidence

The actual 47-asset pack was decoded and rendered by dev/industrial-textures/verify-render.cjs. It passed 6,400 alpha samples, eight chair orientations, workstation aspect and floor contact, 24 distinct floor fingerprints, seven distinct wall fingerprints, emissive-screen placement, shell masking, negative-world phase and classic/missing-asset fallback. Wall-continuity mean pixel error was zero; the bridge retained 309 reachable deck tiles.

Focused suites passed: industrial texture contract (288 assertions), prop remaster (1,413), prop rotation (605), async texture-ready seating (69), seat recovery (54), movement continuity (15), conveyors (154), and world surfaces (643).

Live browser proof at http://127.0.0.1:18792/:
- The app reported industrial / bridge-remaster / resolution 6, UPLINK ONLINE and FEED LIVE.
- REFIT showed all floor selections. GRATE applied to the actual room, then Undo restored it.
- PIPEWORK applied to the actual room walls, then Undo restored them.
- A new SERVICE CABINET placed on the deck; Undo restored the layout.
- DESK rotated through south, west, north and east with the corresponding 3 × 1 / 1 × 3 readout. An east-facing desk was placed and visually inspected, then undone.
- DONE saved the original station layout after these reversible checks.

The seed server is a local development preview. No provider task execution is claimed.

## Reproduction and review

- Run node dev/seed.js --keep with SKYNET_PORT=18792.
- The native verification and contact-sheet scripts use @napi-rs/canvas. Asset preparation uses Sharp.
- Run node dev/industrial-textures/render-remaster-review.cjs to refresh the floors, walls and workstation sheets under dev/.scratch-workspace/remaster-review.
- Generation prompts and asset provenance are in PROMPTS.md and FLOOR-PROMPTS.md.
- PNG encoding is normalized through Sharp for native decoder compatibility without repainting source pixels.
- The full repository gate is npm run test:fast; its final result is recorded in the delivery report and local dev/industrial-textures/remaster-test-fast.log.
