# StarNet approved prop art direction

## Canonical visual reference

The owner explicitly approved the complete prop sheet: “that sprite sheet is exactly what I am going for.” This approval applies to its visual style. It does not assert that the individual assets are already cut out, mapped, animated, or integrated.

**Master:** `frontend/assets/industrial/complete-sheet/starnet-props-full-sheet.png`

**SHA-256:** `e68ef0d3711e9164a3aff5333b98522ed6fdcb4bc7654929e333cb2ff2b97ea9`

**Source prompt:** `docs/station-remaster/scale-calibration/entire-sheet.prompt.txt`

The actual approved image is the authority. Earlier photoreal sources, parallel batches, calibration alternatives, and numeric camera descriptions do not override what is visible in this sheet. The three room references remain secondary context for the surrounding station.

## Preserve the visible design

- Dark, grounded industrial science fiction with clear silhouettes and substantial, readable components.
- Broad painted material planes, deep recesses, restrained bevels and controlled edge highlights. Detail supports the main shape instead of covering every surface.
- Charcoal and desaturated olive structures, selective aged brass accents, and bounded cyan/teal displays. Match the sheet's actual contrast and color relationships.
- Real material variety: stained wood, colored upholstery, paper, ceramic, rubber, glass and foliage. Do not turn every object into a metal cabinet.
- Match the camera and proportions of the nearest approved object in the sheet. Do not impose a different perspective because an older prompt specified an angle.
- Props must remain recognizable at their fitted game size. Review broad silhouettes, major value shapes, and material identity beside the actual crew and approved crate/workstation.

Avoid photographic microtexture, realistic fabric weave, dense scratches/rivets, noisy surface treatment, excessive gloss, giant neon bloom, or a new cute/cartoon/voxel treatment. Do not treat “more detail” as an improvement to this approved style.

## Production rules

1. Reuse the approved sheet's actual artwork wherever possible. Cutting out a sprite must preserve its interior RGB, silhouette, and proportions. Verify the background and edges rather than assuming an RGBA file has usable transparency.
2. Any new generation, alternate facing, repaired occlusion layer, or extension must receive this exact sheet as its primary visual input. Also supply the specific matching object when available. Text descriptions alone are insufficient.
3. Generate bitmap prop artwork with the built-in image tool. Do not substitute hand-drawn canvas bodies for these approved raster designs. Animation layers must preserve the same visual treatment and remain bounded to their intended surfaces.
4. Never overwrite the approved master. Keep variants and their prompts separate. A new output is a candidate until its appearance has been compared against the master at actual display size.
5. Keep visual approval, export verification, and live integration verification separate. A clean alpha edge does not establish correct floor contact, scale, facing, sitting, interaction, or animation.
6. Sheet cell dimensions are layout, not authoritative world footprints. Fit each prop to the native placement contract without stretching. Correct an incompatible silhouette deliberately; do not globally enlarge the catalog or silently alter collision/seating.
7. Preserve real capability and activity signals. Screens and effects must not invent task progress, balances, results, or other backend state.

## Reusable generation preamble

> Primary visual reference: the owner-approved StarNet full prop sheet supplied with this request. Match that exact painted industrial game-sprite style, camera, silhouette construction, material treatment, palette and density of detail. Use the closest object in the sheet as the local design reference. Preserve its broad readable forms at the specified final game dimensions. Make only the requested new object, facing, or change. Do not reinterpret it as a photographic product render or introduce a different art style. Return production raster artwork with clean transparency; preserve the established world placement and functional surfaces.

## Next production stages

Separate and map the sheet into individual assets; verify every cell's identity rather than assuming perfect generation order. Create missing facings and any necessary moving/occluding layers from the approved artwork. Then integrate and inspect scale, floor contact, interactions and animation in the running station. Extend walls, floors, doors and fixtures using the same master only after the prop treatment is preserved.
