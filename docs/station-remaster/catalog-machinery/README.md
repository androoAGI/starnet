# Machinery catalog camera corrections

Eight new south-facing PNG candidates generated with the built-in image tool. The first production sheet established the forms; a second image edit corrected five silhouette proportions that failed the width-fit tolerance. Both full unmodified sources and exact prompts are preserved. The original source supplies tube, cryopod and comms_uplink; the edited source supplies tank, fabricator, vat, industrial_servicecab and incubator. The first utility cohort remains byte-identical.

The exporter uses the native footprint and original world-pixel envelope for each prop. It rejects a silhouette if uniform fitting achieves less than 90% of the envelope width or exceeds its height. One tile is 12 world pixels. No generated source is stretched, repainted, rotated or resized in a production PNG.

| ID | Footprint | Native envelope | Actual uniform fit | Width coverage |
|---|---|---|---|---|
| tank | 2x1 | 27x24 | 27.00x23.92 | 100% |
| tube | 2x1 | 26x15 | 25.50x15.00 | 98.1% |
| fabricator | 3x2 | 44x28 | 42.92x28.00 | 97.5% |
| vat | 3x2 | 41x28 | 38.47x28.00 | 93.8% |
| industrial_servicecab | 1x2 | 12x29 | 10.84x29.00 | 90.4% |
| cryopod | 1x2 | 12x30 | 12.00x28.21 | 100% |
| incubator | 1x2 | 14x33 | 13.35x33.00 | 95.4% |
| comms_uplink | 2x2 | 19x35 | 17.22x35.00 | 90.6% |

`integration.json` uses the previous utility schema, including id, view, image, source dimensions, footprint, world bounds, full-export normalized contact, measured uniform fit, source/output SHA256 and exact source crop. Contact is the bottom edge of the last source row with alpha >=180; retained soft fringe may extend below it. Alpha cleanup clears loose haze farther than three source pixels from the opaque body. Every output RGB byte and every retained RGBA byte is checked against its exact source coordinate; all eight have zero mismatches. Production exports retain genuine source transparency.

Rebuild with `node dev/industrial-textures/build-catalog-machinery.cjs`. The generated `game-scale-proof.png` was visually inspected: old2x, new2x and new4x at actual world size. Only the proof is resampled. No live-world acceptance is claimed.

The new forms restore source-native identity as well as camera: tank is a broad water vessel, tube is a horizontal pneumatic barrel, fabricator is an apparel gantry with cloth feed and output hopper, vat is a shallow wax basin with candle tray, servicecab is a closed cabinet, cryopod is an upright frosted occupant chamber, incubator is a green culture column with a suspended specimen, and comms_uplink is an open lattice mast with real transparent gaps. Uplink's native footprint is 2x2, not 1x2.

Integration must preserve native physical placement and capability contracts. New images invalidate old image-specific motion regions. Records carry `effects:false` pending remapping: water/under-rim light for tank; passage/gauge activity for tube; moving head/process cues for fabricator; wax heat cues for vat; calm vitals for cryopod; specimen/motes for incubator; work-driven equipment cues for uplink. The closed service cabinet is static. Source artwork does not prove active work, parcel counts, or connection state. Source-specific animations and live occupant/parcel overlap remain integration work; no runtime/main-manifest/save edits are included here.
