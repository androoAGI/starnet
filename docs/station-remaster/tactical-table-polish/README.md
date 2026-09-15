# Compact low tactical console and screen light

Preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler

The current replacement is a compact low console regenerated from the approved desk reference. Its small navigation screen is inset into a broad matte tabletop, with a short front fascia and recessed support shoes. The owner rejected grounded-v3 as too big and too high. The selected generated PNG is `frontend/assets/industrial/tactical-table-polish/bridge_tacticaltable.png`; the runtime copy is `frontend/assets/industrial/projection-correction/bridge_tacticaltable.png`. The display envelope is now 50 x 28 world pixels at offset (17,20), replacing 84 x 55 at (0,-7). Actual aspect-preserving artwork measures 50 x 19.47 world pixels: 40% narrower and about 63% less image height than the previous runtime image. The existing saved 7 x 4 placement reservation and floor-contact line remain; this is a visual size correction, not a saved collision-footprint migration. No procedural prop body was added.

Generated with Codex's built-in image tool. [Current compact-console prompt](compact-table-prompt.md), [previous pool-table geometry prompt](grounded-table-prompt.md), [initial prompt](prompt.md), [low-support prompt](low-table-prompt.md), [camera-angle follow-up](low-table-angle-prompt.md), [source and crop receipts](integration.json). The selected source is `sources/bridge_tacticaltable-compact-v4.png`; previous candidates are retained. Owner acceptance is pending.

Latest revision verification: reloaded Kepler and inspected at command-room framing and close zoom. The console is around 1.3 times a desk's width rather than over twice its width; the support shoes meet the existing floor contact and the inset screen is smaller than the physical tabletop. Screen overlay and light origin were remapped to the new glass rectangle. The existing rigid-prop lighting response and emission remain active. Live diagnostics reported 184 views and zero failures. Projection export, alpha-geometry, effects and screen-light tests passed for this revision. Global lighting settings were not changed.

Screen light now uses the same screen regions and state gates as the visible overlays. It combines multiple displays into an area-weighted source, retains each display's color, emits from static navigation glass even when unoccupied, reduces spill from dim standby screens, and supports screen props missing from the legacy emitter list. Fully dark screens emit no light. Generated display content remains static; work and occupancy animations still require their existing state. Raster crop, mount lift and mirroring remain part of source placement.

Projection lighting was softened in the live CRT lab, then copied back: ambient lift 0.12 to 0.10; wall material gain 0.90 to 0.86; room 0.64 to 0.60; pool 1.00 to 0.96. Lamp reach remains 1.50. CRT grain and physical wall fixtures remain active. Screen spill is scaled by visible phosphor power with a 1.35 local gain; it is not a global exposure increase.

## Earlier lighting implementation verification, 2026-09-15

Reloaded Kepler command room and inspected at room framing and close zoom. The tabletop is foreshortened, front fascia is thin, front legs and shorter exposed rear supports are visible, and floor remains visible through the open underside. Cyan light is visible on the adjacent floor. The back-wall console and existing chairs remain in place. Live asset diagnostics: 184 views, zero failures, density 6.

Passed: projection screen-light tests (31 screen prop types, standby/active power, combined source, missing legacy emitter, fully dark suppression); projection effects; projection assets (178 exports); runtime alpha geometry (184 views); prop industrial remaster (1,413 assertions); prop light response (8 cases); WorldLight (127 assertions); WorldRenderer; industrial textures (301 assertions); projection depth/alpha/open-leg gaps; Kepler layout and conveyor routing. `git diff --check` passed.

This is focused verification, not a full release-gate claim. No trunk merge was performed.

Rebuild in order from the worktree root: `node dev/industrial-textures/import-tactical-table-polish.cjs`, `node dev/industrial-textures/build-projection-correction.cjs`, `node dev/industrial-textures/build-projection-load-geometry.cjs`, `node dev/industrial-textures/build-projection-effects.cjs`, `node dev/industrial-textures/audit-prop-sharpness.cjs`.
