# Station remaster — authoritative direction, 2026-09-13

Andrew stopped and rejected the white/minimal station texture exploration. The attached [bridge reference](bridge-reference.png) is the visual authority for station surfaces and props. The earlier armory attachment remains a compatible secondary reference. The clean blank white Cadet request applies to the character; it does not authorize turning the environment into white ceramic or removing its industrial character.

## Approved prop standard — latest instruction

Andrew explicitly approved `frontend/assets/industrial/calibration/crate.png` in the running station and requested that every catalog prop follow it. Its readable original silhouette, broad cool steel panels, restrained wear and clear functional parts are the prop finish standard. The bridge supplies the world context; its density must not turn each small prop into an ornate miniature cabinet. The full scope is all 160 catalog IDs, retaining the eight already approved raster props and remastering the other 152 with their supported authored views.

The September 14 correction supersedes the casing-only pass: reimagine each complete object, including its silhouette, construction, controls, screens and animation. The old sprite establishes purpose and interaction contracts, NOT a tracing template. The crate sets finish and readability, not the shape of every object. Fit new art uniformly to the physical envelope and verify its contact point beside the approved furniture and agent; never rotate an elevated bitmap to invent another view.

The `props-v2` casing drafts do not count as completed remasters. They remain available only at `?propReview=skins`. The default `props-v3` manifest contains complete newly authored views. Screen-mode props use new display artwork with occupancy-driven power and phosphor animation; they never composite the old procedural screen. Real task/activity signals still come from the existing world model. Static props must have no moving or stateful internal layers. The current ledger is `props-v3/coverage.json`, distinguishing accepted existing pieces from new designs awaiting review. A generated file alone never establishes acceptance.

## Preserve the reference

- Near-black gunmetal, charcoal plates and heavy structural bulkheads.
- Dense, purposefully arranged mechanical detail: recessed channels, vents, ribs, cabling, fasteners, layered casings and keyboards.
- Restrained weathering and worn edges. Crisp image sampling must preserve this texture instead of smoothing it into broad flat panels.
- Muted amber/brass hardware, worn hazard markings and warm utility lights, with cyan/teal screens.
- Fixed overhead oblique camera, horizontal long edges, consistent vertical rise and grounded silhouettes.
- Deep recesses, contact shadows and strong structural weight, while preserving readable movement and interaction.

Diversity comes from construction and function within this palette: plate layouts, grate density, service ribs, equipment housings, display arrangements, worn edge treatment and restrained accent placement. It does not come from unrelated material styles or bright white furniture.

## Proportions and implementation

Use the existing 12-world-pixel tile as the measurement basis. Inspect each object beside the Cadet, its seat, its neighboring furniture and room shell. Keep correctly authored directional views and fit visible art to its actual placement footprint. Avoid rotating upright front views into sideways objects. Agent proportion changes remain a later pass.

The rejected white station experiments are preserved reversibly in Git and isolated agent worktrees. They are not active preview assets. The main preview rendering was restored to the previously verified industrial state from 0d0c6cd06, keeping the blank white Cadet. No new generation should continue from the rejected floor/wall atlases or use the Cadet as the station material palette.

Restart the art pass from this bridge reference, one representative asset at a time, with reference fidelity and in-station scale checked before expanding to the complete catalog.
