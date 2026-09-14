# StarNet approved prop art direction

## Canonical visual reference

**Follow-up owner review:** the projection-correction TV, two arcades and pool table are accepted; aquarium is improved. Preserve these. The previous couch was rejected because its visible seat depth/camera did not match the neighboring recliners. A replacement generated from both recliners has now been inspected in the saved lounge; owner acceptance remains pending. Do not treat the rejected rear-view couch as an accepted camera reference.

**Latest owner correction (2026-09-14): the runtime deployment of this sheet was rejected. Only the crate, workstation desk and chair were accepted in-station. The sheet remains a material/style reference, NOT camera, physical-scale or integration approval. Match the accepted three props' horizontal axes, visible top planes and grounded contact. Rebuild incompatible source projections; do not use source aspect ratio to invent world dimensions. This correction supersedes conflicting camera instructions below.**

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
- Match projection and physical proportions to the accepted in-station crate, workstation and chair. A nearby sheet object is only a material/design reference until it passes the same room check.
- Props must remain recognizable at their fitted game size. Review broad silhouettes, major value shapes, and material identity beside the actual crew and approved crate/workstation.

Avoid photographic microtexture, realistic fabric weave, dense scratches/rivets, noisy surface treatment, excessive gloss, giant neon bloom, or a new cute/cartoon/voxel treatment. Do not treat “more detail” as an improvement to this approved style.

## Production rules

1. Reuse the approved sheet's actual artwork wherever possible. Cutting out a sprite must preserve its interior RGB, silhouette, and proportions. Verify the background and edges rather than assuming an RGBA file has usable transparency.
2. New generations must receive the accepted crate, workstation and chair as primary projection references. Use the complete sheet only as secondary material/style guidance when useful; its rejected cameras must not be copied. Supply a native geometry guide or in-station context when available. Text descriptions alone are insufficient.
3. Generate bitmap prop artwork with the built-in image tool. Do not substitute hand-drawn canvas bodies for these approved raster designs. Animation layers must preserve the same visual treatment and remain bounded to their intended surfaces.
4. Never overwrite the approved master. Keep variants and their prompts separate. A new output is a candidate until its appearance has been compared against the accepted anchors in the actual room at playable display sizes.
5. Keep visual approval, export verification, and live integration verification separate. A clean alpha edge does not establish correct floor contact, scale, facing, sitting, interaction, or animation.
6. Sheet cell dimensions are layout, not authoritative world footprints. Fit each prop to the native placement contract without stretching. Correct an incompatible silhouette deliberately; do not globally enlarge the catalog or silently alter collision/seating.
7. Preserve real capability and activity signals. Screens and effects must not invent task progress, balances, results, or other backend state.

## Reusable generation preamble

> Projection references: the accepted in-station crate, workstation and chair. Material/design reference: the StarNet full prop sheet. Preserve its painted industrial palette and readable detail, while matching the accepted anchors' floor axes, visible top planes, physical scale and contact. Use the supplied native geometry guide to preserve the footprint and facing. Make only the requested object or correction. Do not reinterpret it as a photographic product render. Return raster artwork with clean transparency. The output still requires visual review in its real station placement.

## Next production stages

The opt-in projection-correction pass now contains 173 revised views across 157 props plus the three unchanged accepted anchors, covering all 160 catalog props. Each cohort was inspected in the running room fixture and the couch was inspected in the saved lounge. `projection-correction/coverage.json` records coverage; the README and cohort receipts record remaining proportion differences. This is generated-art coverage, not owner approval or full animation acceptance. Re-author functional/animation surfaces when source changes require it; do not infer that work from green loading checks. The new couch and catalog remain candidates for owner review.
