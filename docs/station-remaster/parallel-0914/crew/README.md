# Crew furniture design candidates

Three separately authored designs: couch back view, low table south view, and low table east view. Built-in image generation used the approved crate, workstation and bridge references. The armory reference was inspected for context. Exact prompts and image identities are in this directory.

**These candidates are not runtime-ready: all three generated PNGs are RGB, with painted checkerboard backgrounds and no transparent pixels.** One built-in couch extraction edit also failed to produce alpha. The first design was retained unchanged. Parent owns the pending authorized export, combined review and integration.

The sofa uses graphite woven upholstery, protected steel arm caps and small brass hardware. Its broad rear back panel faces the viewer; existing three cushion seat anchors and sofa-in-front y-sort must remain. The low table pairs a broad dark steel slab with restrained bronze edging and short trestles. The east view is separately generated from the south design, never a rotated elevation.

The native world contracts are in `manifest.json`: 12 pixels per tile, sofa 5x1, table south 3x1 and east 1x3. Bounds are proposed native-envelope fit targets, not verified placement results. Preserve uniform aspect ratio and inspect alpha bounding boxes after export. The low table surface must remain on the shared SURFACE_RISE=8 plane. This is especially important for mounted props; do not move the mounting plane to make a short table appear lower.

Visual review: each original inspected at native resolution, and `scale-review.png` inspected at 1x and 4x physical envelope size. Broad couch/back, three cushions, table leg gap and material correspondence remain legible; the painted background is visibly unacceptable. The east image has modest perspective taper and must be judged in station. Scale sheet contains whole uncut originals; an alpha-bound fit will differ. No screenshots are claimed as live integrated evidence.

No runtime, catalog, shared manifest, original props-v3 or website mirror edits. No full test gate run for these unintegrated art-only drafts, per parent handoff direction. Owner must verify sitter occlusion, mounted-table contact, facings and app test gate at integration.
