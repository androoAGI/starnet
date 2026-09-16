# Completed motion from existing new-style characters

Heisenberg and Rick now each have 80 selected frames: eight standing views, eight walking frames in each of eight directions, four seated views, and four north-facing typing frames. Runtime standing height remains 19 px. Both frontend and website mirrors use these assets.

Built-in ImageGen completed animation from the existing skin-study-0914 designs. Prompts and provenance are in rotation-prompts.json, walk-prompts.json and jobs/*.json. Packing only crops, resizes and anchors generated raster frames; rotations were mechanically normalized to 76 source pixels. All 160 packed frames were visually inspected in the contact sheets.

Live verification: seeded app at http://127.0.0.1:18814/agent-station-demo.html?propSet=projection. Heisenberg and Rick were assigned through the live skin controls to normal roaming crew. Both rendered at 19 px, with zero backward frames observed; Heisenberg covered five walk directions and Rick five. Foot contact differed by approximately one third of a world pixel from pixel-grid snapping. No console errors were observed. This is sampled live verification, not a claim every possible transition was observed.

Validation: catalog 36 redesigned sets / 2 retained sets / 2880 selected redesigned frames; input provenance 375 tracks with no stale inputs; contact checks 2400 walking frames; motion regression 570 cases; pace check all 38 skins at cruise speed 28. Full repository gate output is test-fast.log.

## Remaining blocker — not all 38 complete

Direct missing-animation requests for Minion and Pikachu were rejected by the image service output moderation (category other). Request IDs and operations are recorded in blocked-motion.json. These rejected requests were not rerouted. Their existing assets are preserved, not replaced with generic characters. The strict completion audit reports 36/38 complete and 48 missing frames. Earlier rejected redesign prompts are distinct from these existing-art animation requests; Heisenberg and Rick animation requests succeeded.
