# Crew material expansion: twelve designs and clean pool variant

All twelve allocated props have complete individual generated designs and inspected transparent exports in `frontend/assets/industrial/batch02/crew/`. Original source PNGs, exact prompts, native contracts and hash-bound export metadata are retained here. Built-in imagegen authored every object; the user-authorized deterministic exporter changes only alpha and crop, preserving every RGB byte.

Materials deliberately vary: walnut bar, cotton-and-timber bed, green felt pool table, burgundy felt/leather poker table, burnt-orange fabric beanbag, wooden stool, moss-green upholstered timber bench, oak round table, walnut side table, ivory ceramic/stainless coffee appliance, blue enamel refrigerator and ochre enamel vending machine. The bridge/workstation were camera/detail references, not universal metal templates.

Each output was inspected at native resolution and on the three dark-background review sheets with a native-envelope thumbnail. All final cutouts have both opaque and transparent pixels and zero partial pixels. Enclosed holes in the beanbag handle, stool and pool table were explicitly checked. Ivory pillow and ceramic shell remain intact. The side-table source uniquely had RGBA alpha252/253 throughout its body plus distant faint residue; the documented alpha160 cutoff produces a solid cutout without modifying RGB.

The bunk was revised into a broad near-square cabin bed. `bunk-source.png` is the final full generated source; `bunk-initial-source.png` and its export record retain the initial narrow design. `bunk-revision.prompt.txt` records the camera/proportion correction. Final cutout is 1120x1133, so uniform fitting now occupies almost all of its 24x26 native envelope without stretching.

`pooltable-clean.png` is a supplemental new imagegen edit with no baked balls or cue. Prefer it for runtime ball overlays. The original decorated pool table remains available. Its clear playable felt spans approximately source x180..1220 and y220..640; the source is 1387x1134, crop x59 y127, 1269x841. Suggested live-ball coordinates require owner review at actual scale.

## Integration contracts and remaining work

No runtime, catalog, shared manifest, owner tree or mirror files were changed. All views use catalog south/r0 only. Physical footprints, native envelopes, floor contacts, animation sampling and anchor descriptions are copied from the owner inventory into each `{id}.json` and export record. Bounds are fitting targets, not live-verified placements. Owner retains animation, seat/mount projection, live verification and integration test gate.

- Bar, pool table, coffee, fridge and vending have native motion/use state. The new PNG alone does not preserve that behavior; do not label all of these static in the runtime manifest. The clean pool table supports separately authored ball overlays.
- Bed must render frame/pillow below sleeper and quilt above. Existing `bunkQuilt` begins at local y+7, x+3 to x+w-3, ending at local y+h-8. Empty bed uses full art; occupied rendering needs a new quilt overlay or native fallback. The supplied whole quilt is flat/empty, without occupancy breathing.
- For the revised bed, the blue/runner quilt occupies approximately full-source x140..1090, y385..960 (source 1204x1306; export crop x41,y80,w1120,h1133). At uniform 24px width and floor y24, this is about world x2.1..22.5, y6.3..18.6. The pillow/head area is above it, about y2.4..6.3. These are mask-planning bounds, not a traced alpha mask. Include the front timber rail in front of the feet; never cover the pillow/head region. Live sleeper head position and breathing require proof before acceptance.
- Bench uses the existing couch planner/back-facing occlusion and cannot be substituted into a front-facing seat mode. Stool requires its existing seat lift and single occupant claim.
- Round/side tables keep SURFACE_RISE=8; mounted objects must be checked against the new drawn top. Coffee remains optionally surface-mounted. No mount plane changes were made.

No full app test gate or live integration claimed for this asset-only lane. Exporter syntax check and per-file alpha/RGB/hash verification passed. Owner should use the individual export receipts and current output files rather than assuming an earlier commit is the final bunk or clean pool revision.
