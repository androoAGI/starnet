# Furniture and fitness art handoff

Fourteen prop IDs are complete as 26 individually authored views. All finals are PNGs in `frontend/assets/industrial/batch03/crew/`. Original generated sources, exact prompts, export receipts, and native contracts are preserved in this directory. `furniture-generation.json` names every original generator output and input reference. Built-in image generation was used for every view; no upright bitmap was rotated or mirrored during packaging.

| Prop | Authored filenames | Native footprint |
| --- | --- | --- |
| quarters_lockerbank | quarters_lockerbank.png | 3 x 1 |
| glasstable | glasstable.png, glasstable-r3.png | 3 x 1 / 1 x 3 |
| dinertable | dinertable.png, dinertable-r3.png | 3 x 2 / 2 x 3 |
| booth | booth.png, booth-r1.png, booth-r3.png | 2 x 1 / 1 x 2 |
| dinerchair | dinerchair.png, dinerchair-r1.png, dinerchair-r2.png, dinerchair-r3.png | 1 x 1 |
| podchair | podchair.png, podchair-r1.png, podchair-r2.png, podchair-r3.png | 1 x 1 |
| loungetable | loungetable.png, loungetable-r3.png | 2 x 1 / 1 x 2 |
| longtable | longtable.png, longtable-r3.png | 3 x 1 / 1 x 3 |
| punchbag / punchbag_r | punchbag.png, punchbag_r.png | 1 x 2 |
| benchpress / benchpress_r | benchpress.png, benchpress_r.png | 3 x 1 |
| recliner / recliner_r | recliner.png, recliner_r.png | 1 x 1 |

The rendering follows the current painted strategy-game direction: broad restrained tones, clear edges, deliberate sparse highlights, and varied enamel, laminate, wood, tinted glass, cloth and rubber. The glass is opaque painted blue-gray with restrained reflection marks, rather than physically refractive transparency. Table tops are empty. Equipment shows no external work-state claims.

## Authored surfaces and coordinate conventions

Each `.json` and `.export.json` contains `authoredGeometry`. Its regions include relevant table/seat support polygons, back or near-arm occlusion polygons, bench pads, bag body bounds and swing pivots. They are manual visual annotations of the new painted surfaces, explicitly approximate rather than live-validated geometry.

Every region is available in four coordinate systems: `cropNormalized` uses the final tight PNG; `sourcePixels` uses the intact generated canvas; `sourceNormalized` uses the full original canvas; `worldPixels` uses a uniform centered-X, bottom-aligned fit in the native envelope. World units use 12 pixels per tile. These conversions are computed, preserving the source aspect. `furniture-regions.json` is the editable normalized annotation source; `annotate-furniture.py` computes the other forms.

Do not assume old generic surface-rise constants identify the newly drawn top. For example, the south glass top's near support edge measures world y5.147, and the south lounge top's near support edge y6.386. Complete fit measurements are in `furniture-verification.json` and the individual receipts.

The south booth is a rear view with its seat hidden behind the backrest. Native claim foot anchors remain (6,10) and (18,10), separately from visible back occlusion. Turned booths have newly visible seat polygons and near-end foreground regions. Rear chair drawings provide occlusion surfaces or visible seat slivers rather than invented visible seat planes. The paired recliners preserve fixed west/east openings, native feet (4,10)/(8,10), lift2, and distinct foreground arms. Owner must verify all body placements against these new surfaces.

Punch bags are static neutral key art only. Native cosmetic sway has three sampled frames and must be restored by the integration owner. `movingBagAndChain` rectangles isolate the hanging section from the mast; use the PNG alpha inside those rectangles and rotate around `swingPivot`. Keep the mast and ballast base fixed. The chain must move with the bag. No motion is implemented by this asset-only handoff.

## Verification and remaining integration work

All 26 final files passed `verify-furniture.py`: RGBA alpha0/255, source/output SHA matches, exact prompts present, authored region metadata present, and zero source RGB changes in the exported crop. Authorized extraction only changes connected background alpha and crop. Interior gaps between table stretchers, chair frames and bag straps were inspected and cleared with explicit source-coordinate seeds. Original source pixels are preserved in the source PNGs.

Seven review sheets (`review-quarters_lockerbank`, `review-booth`, `review-glasstable-r3`, `review-dinerchair-r1`, `review-podchair-r1`, `review-punchbag`, `review-punchbag_r`) show all 26 at larger and native-envelope thumbnail sizes. Sources were inspected individually.

Some designs fill less than the entire inherited native envelope because their new silhouettes differ. Particularly the south booth is 24 x 10.448 within 24 x 19, the south diner chair is 7.807 x 16 within 11 x 16, and the punch bags are about12 x 21 within12 x 30. These are visible proportion differences, not a claim of exact geometry parity. Owner must decide presentation bounds/anchor placement or request art revisions after live body-scale QA. The measured new geometry is provided so these differences are not hidden by stretching.

No runtime, shared manifest, prior asset, or website mirror was changed. No live integration, animation, seating correctness, acceptance, or completed test gate is claimed. Integration owner must verify body scale, seat occlusion, mounted-object support, all offered views, pathfinding and bag motion in the running app.
