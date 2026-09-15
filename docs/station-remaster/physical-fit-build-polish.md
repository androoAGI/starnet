# Physical fit, depth and build polish — 2026-09-15

Local preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler

## Changes

- Projection tactical table: 5×3 physical footprint, selection outline and placement validation. Exact old 7×4 saves migrate once by (+1,+1), preserving centre and bottom contact. Classic assets and custom saved dimensions retain their existing rules.
- Picking reads cached sprite alpha at the actual prepared bounds. Visible crowns outside the floor rectangle are selectable; transparent padding and gaps are not. Unavailable/custom art keeps native floor-box picking. A byte mask is cached once per loaded raster, rather than reading canvas pixels on pointer movement.
- Build mode: direct dragging from Select; an object action panel with Move, supported Rotate/Flip, Copy, Configure, Delete and Deselect; an object finder that centres the camera; optional exact grid coordinates; rendered placement/move ghosts; sharper library previews; shared floor-contact shadows, with viewport culling. Workflow setup panels appear with workflow tools instead of interrupting decoration. The Kepler header no longer covers the build toolbar.
- Distant architecture uses quieter levels from the existing mip chain. Close detail, alpha, crew and prop rasters are unchanged. No additional global exposure or grain adjustment.
- The authored couch back was hiding all but the seated character's head. Its calibrated 6-pixel perch now lifts the sitter artwork while keeping the floor/sort anchor and cushion claim. Study standing-frame fallback can use that perch only behind this occluding back; open chairs still require a real sit frame before lifting.
- Kepler seating: side chairs moved against the compact tactical table; redundant command chair removed because its assigned desk supplies the working chair; navigation chair faces its desk and sits on the adjacent row; lounge profile seats face inward. Both the preset and this local saved layout were corrected.

## Live verification

Used the seeded sidecar and actual editor. Verified Select drag, click-to-move, rotation changing a desk from 3×1 south to 1×3 west, Copy, refusal of overlapping copy placement, valid copy placement, Delete, Undo, Escape cancellation and Configure opening the workstation assignment panel. All temporary test edits were undone. Used the new object finder and coordinate fields for the final seating corrections; DONE reported the layout saved. The sidecar save contains table (24,9,5,3), chairs at (23,10)/(29,10), navigation chair (33,5,north), and no redundant command chair.

Opt-in localhost `&fitAudit=1` exposes a review panel. Walk buttons invoke actual obstacle-aware navigation. The seat fixture borrows the existing actor, supplies a local review scope and runs the real claim/planner/arrival/render path; it deliberately controls arrival for reproducibility. It is not evidence that autonomous scheduling naturally selected every seat. Live couch and profile-chair checks reported `seated`, with the actual prop ID. The couch screenshot showed head and shoulders above the back and lower-body occlusion after calibration. Review controls are absent from the normal URL.

Raster diagnostics: 184 views, zero load failures, density 6. Existing catalog audit covered frame bottoms and floor contact; wall fixtures, floating decor and tabletop objects retain their intentional exceptions. This is not a claim of manually playtesting all 184 views or every skin/pose combination.

## Tests and limits

Passed focused checks: world model (514 assertions); new remaster physical-fit migration/alpha picking; real refit footprint parity; editor card stack (68) and junction cards (117); projection assets (178 exports), depth/filtering, alpha geometry (184), effects (160 props/184 views), screen light (31 types); authored tabletop mounts (262 assertions over 10 views and both mirrors); prop anchors (93); world seating recovery (58); sprite sit facing (147), side recliners (33), walking (6,034); skin study asset isolation and Kepler layout/routing. Changed JavaScript passes syntax checks and the diff passes whitespace checks.

`npm run test:fast` did not pass: the existing planning-authority audit reports BLOCKED / finite-claims failures and the aggregate run reached its 900,000 ms timeout. Raw log: `dev/.scratch-workspace/remaster-fit-test-fast.log` in this worktree. No trunk merge or full release-ready claim.

Study skins still use their available orientation artwork where dedicated sit/walk frames are absent. This pass fixes floor/sort/perch integration, not a complete character-animation asset set. Visual owner acceptance and full-catalog playtesting remain separate from these verified changes.
