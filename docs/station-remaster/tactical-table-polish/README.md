# Low tactical table and screen light

Preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler

The current replacement is a low table with a deeper visible top plane, thin fascia and short broad supports. The owner rejected the earlier long-legged, excessively front-facing version. The selected generated PNG is `frontend/assets/industrial/tactical-table-polish/bridge_tacticaltable.png`; the runtime copy is `frontend/assets/industrial/projection-correction/bridge_tacticaltable.png`. The existing 7 x 4 footprint, 84 x 55 maximum world box and floor anchor are retained. The image's aspect ratio is preserved. No procedural prop body was added.

Generated with Codex's built-in image tool. [Initial prompt](prompt.md), [low-support prompt using the approved desk reference](low-table-prompt.md), [camera-angle follow-up](low-table-angle-prompt.md), [source and crop receipts](integration.json). The first short-support draft still had too little visible top depth and was not installed. The selected source is `sources/bridge_tacticaltable-low-v2.png`; previous candidates are retained. Owner acceptance is pending.

Latest revision verification: reloaded Kepler and inspected at command-room framing and close zoom. Short broad feet replace the long slim legs; more tabletop depth is visible; the front edge is lower relative to the floor contact. Screen overlay and light origin were remapped to the new glass polygon. Live diagnostics reported 184 views and zero failures. Projection export, alpha-geometry, effects and screen-light tests were rerun for this revision. Lighting settings were not changed in this revision.

Screen light now uses the same screen regions and state gates as the visible overlays. It combines multiple displays into an area-weighted source, retains each display's color, emits from static navigation glass even when unoccupied, reduces spill from dim standby screens, and supports screen props missing from the legacy emitter list. Fully dark screens emit no light. Generated display content remains static; work and occupancy animations still require their existing state. Raster crop, mount lift and mirroring remain part of source placement.

Projection lighting was softened in the live CRT lab, then copied back: ambient lift 0.12 to 0.10; wall material gain 0.90 to 0.86; room 0.64 to 0.60; pool 1.00 to 0.96. Lamp reach remains 1.50. CRT grain and physical wall fixtures remain active. Screen spill is scaled by visible phosphor power with a 1.35 local gain; it is not a global exposure increase.

## Earlier lighting implementation verification, 2026-09-15

Reloaded Kepler command room and inspected at room framing and close zoom. The tabletop is foreshortened, front fascia is thin, front legs and shorter exposed rear supports are visible, and floor remains visible through the open underside. Cyan light is visible on the adjacent floor. The back-wall console and existing chairs remain in place. Live asset diagnostics: 184 views, zero failures, density 6.

Passed: projection screen-light tests (31 screen prop types, standby/active power, combined source, missing legacy emitter, fully dark suppression); projection effects; projection assets (178 exports); runtime alpha geometry (184 views); prop industrial remaster (1,413 assertions); prop light response (8 cases); WorldLight (127 assertions); WorldRenderer; industrial textures (301 assertions); projection depth/alpha/open-leg gaps; Kepler layout and conveyor routing. `git diff --check` passed.

This is focused verification, not a full release-gate claim. No trunk merge was performed.

Rebuild in order from the worktree root: `node dev/industrial-textures/import-tactical-table-polish.cjs`, `node dev/industrial-textures/build-projection-correction.cjs`, `node dev/industrial-textures/build-projection-load-geometry.cjs`, `node dev/industrial-textures/build-projection-effects.cjs`, `node dev/industrial-textures/audit-prop-sharpness.cjs`.
