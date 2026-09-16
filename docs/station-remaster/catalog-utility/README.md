# Utility catalog camera corrections

Eight new south-facing candidates, generated as one requested production sheet with Codex's built-in image tool. Accepted TV, arcade and crate images supplied as camera/material references. The exact prompt and unmodified generated source are adjacent. No runtime, main manifest or saved station changes are included.

`integration.json` contains one record per individual PNG: source/output hashes, source ROI and final crop, native footprint, world-pixel envelope, full-export normalized contact, measured uniform fit, and export verification. One tile remains 12 world pixels. The listed envelope is not a claim that the generated silhouette fills both dimensions.

Run `node dev/industrial-textures/build-catalog-utility.cjs` from the worktree root to rebuild exports and the review raster. The exporter preserves every RGB byte, and every retained RGBA byte. It only clears loose alpha haze farther than three source pixels from alpha >=180 body pixels, then crops. It never rescales, repaints, rotates or stretches the production PNGs. The sheet already has genuine alpha. Contact Y uses the bottom edge of the last alpha >=180 source row; faint retained fringe may extend below it.

`game-scale-proof.png` was visually inspected. Each cell compares the earlier approved-sheet object at 2x world scale, the new object at 2x, and the new object at 4x. These eight old IDs were unchanged in the parent's projection candidate when audited. Resizing is only for this review raster.

| ID | Physical footprint | Actual uniform image W x H, world pixels |
|---|---|---|
| coffee | 1x1 | 12.31 x 18.00 |
| quarters_minifridge | 1x1 | 11.00 x 18.22 |
| quarters_vending | 1x2 | 17.00 x 27.35 |
| jukebox | 1x2 | 18.00 x 24.02 |
| pixelrig | 2x1 | 30.00 x 25.16 |
| intake | 2x2 | 27.93 x 28.00 |
| core | 1x2 | 14.46 x 31.00 |
| rackV | 1x2 | 14.00 x 34.85 |

Visible corrections: substantial top planes and horizontal fronts; enamel refrigerator and ceramic mug remain distinct from metal machinery; wood-trimmed jukebox; chair-free operator desk with clear knee opening; receiving hopper with a short east output; tall memory core; enclosed blade-server tower rather than an open shelf. Pixelrig, intake and rackV have especially large silhouette changes.

Integration requirements: preserve all native placement, capability, seating and transport contracts. Pixelrig still needs the runtime-provided chair/operator and occupied display semantics; intake still routes real parcels east and needs its live process cues aligned to the new body. Core/rackV remain capability machines. Jukebox activity must follow actual connection state. The crops invalidate previous image-specific screen/motion regions, so records explicitly carry `effects:false` until the owner remaps them. This package does not claim functional animation completion or live acceptance. Native envelopes are unchanged; only new PNGs and optional contact metadata are supplied.

All eight exports pass actual alpha checks and decoded source/output RGB comparison, with zero mismatches. Source sheet, silhouettes and game-size readability reviewed; in-station placement and occupant/parcel overlap remain for the integration owner.
