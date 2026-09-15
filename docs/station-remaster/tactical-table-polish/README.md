# Raised tactical table and screen light

Preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler

The rejected tactical table was almost an overhead panel with no legs. Its replacement has a foreshortened top, thin fascia, four supports and transparent open knee space. The selected generated PNG is `frontend/assets/industrial/tactical-table-polish/bridge_tacticaltable.png`; the runtime copy is `frontend/assets/industrial/projection-correction/bridge_tacticaltable.png`. The existing 7 x 4 footprint, 84 x 55 maximum world box and floor anchor are retained. The image's aspect ratio is preserved. No procedural prop body was added.

Generated with Codex's built-in image tool using the previous table and approved console bank as references. [Full prompt](prompt.md), [source and crop receipts](integration.json). Original and selected source PNGs are retained alongside the export. Owner acceptance is pending.

Screen light now uses the same screen regions and state gates as the visible overlays. It combines multiple displays into an area-weighted source, retains each display's color, emits from static navigation glass even when unoccupied, reduces spill from dim standby screens, and supports screen props missing from the legacy emitter list. Fully dark screens emit no light. Generated display content remains static; work and occupancy animations still require their existing state. Raster crop, mount lift and mirroring remain part of source placement.

Projection lighting was softened in the live CRT lab, then copied back: ambient lift 0.12 to 0.10; wall material gain 0.90 to 0.86; room 0.64 to 0.60; pool 1.00 to 0.96. Lamp reach remains 1.50. CRT grain and physical wall fixtures remain active. Screen spill is scaled by visible phosphor power with a 1.35 local gain; it is not a global exposure increase.

## Live verification, 2026-09-15

Reloaded Kepler command room and inspected at room framing and close zoom. The tabletop is foreshortened, front fascia is thin, front legs and shorter exposed rear supports are visible, and floor remains visible through the open underside. Cyan light is visible on the adjacent floor. The back-wall console and existing chairs remain in place. Live asset diagnostics: 184 views, zero failures, density 6.

Passed: projection screen-light tests (31 screen prop types, standby/active power, combined source, missing legacy emitter, fully dark suppression); projection effects; projection assets (178 exports); runtime alpha geometry (184 views); prop industrial remaster (1,413 assertions); prop light response (8 cases); WorldLight (127 assertions); WorldRenderer; industrial textures (301 assertions); projection depth/alpha/open-leg gaps; Kepler layout and conveyor routing. `git diff --check` passed.

This is focused verification, not a full release-gate claim. No trunk merge was performed.

Rebuild in order from the worktree root: `node dev/industrial-textures/import-tactical-table-polish.cjs`, `node dev/industrial-textures/build-projection-correction.cjs`, `node dev/industrial-textures/build-projection-load-geometry.cjs`, `node dev/industrial-textures/build-projection-effects.cjs`, `node dev/industrial-textures/audit-prop-sharpness.cjs`.
