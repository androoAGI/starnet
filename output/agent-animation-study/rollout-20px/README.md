# Industrial skin rollout — 19 px baseline

The user revised the approved standing height to 19 world pixels on September 15. Preserve this size while improving anatomy, identity, camera perspective and grounded motion.

Ultron, Skeleton, Plague Doctor, Secret Agent and Void Wizard retain their previously reviewed full motion. The catalog pipeline adds 29 redesigned motion sets, including Pepe, Fallout 1 Vault Dweller, Teddy Bear, Ghostface and Morpheus. Completed, visually reviewed sets are enabled through the real station's **Live agent skin** and **Next five skins** controls. `frontend/agent-demo/catalog.json` records the current verified status; `motion-progress.json` records generation progress, which is not visual approval.

Each redesigned standing source is packed uniformly to 76 visible pixels in a 144px transparent master, feet at row 112, scale 19/76. Width follows the design's proportions; sprites are not stretched into a common box. Pepe retains a wider frog face. Teddy Bear was regenerated with a smaller head and human-like torso/leg proportions.

`inputs.json` records selected ImageGen files, copied here as `<id>-source.png`. `build-rollout-fronts.cjs` packs the references and candidates, updates the isolated manifest, and mirrors the assets. `front-comparison.png` shows earlier candidates above the new group at equal standing height.

All 34 redesigned sets have eight rotations, 64 directional walking frames, four cardinal seated poses and four north typing frames: 2,720 selected frames total. Every selected set received a visual contact-sheet review; regenerated tracks preserve the corrected directional references.

All 38 designs are selectable on actual station bodies at 19 px, comprising 34 redesigned sets and four retained originals. The historical rollout-20px directory name is retained to preserve asset paths; catalog.json is the height authority (19 px). The final asset and input validators passed; the full project test gate is recorded separately in ../test-fast-19px.log.

Four requested redesigns were rejected by ImageGen: Heisenberg, Rick, Minion and Pikachu. They retain their existing art and animation at a measured 19px standing height and are explicitly labelled **existing art**. `blocked-redesigns.json` preserves the returned reasons. They must not be counted as redesigned, and the rejected requests must not be routed through a different image generator to bypass the rejection.

## Current pipeline

`prepare-catalog-front.cjs` packs the selected ImageGen front; PixelLab V3 generates eight rotations, then `prepare-catalog-refs.cjs` packs aligned directional references. `run-catalog-motion.mjs` runs inside the tools orchestration environment, saving each MiniMax job before polling. It resumes from `queue.json` and `jobs/*.json`; do not run multiple schedulers. `reset-requests.json` can request a replacement for a completed or failed track, preserving its prior job in history.

`pack-catalog-minimax.cjs` packs generated frames without reshaping them, updates the selected manifest and mirrors both app copies. Walking selects eight frames per direction, sitting selects one final frame per cardinal direction, typing selects four north-facing frames. `contact-catalog.cjs` and `contact-catalog-seats.cjs` show the actual selected frames for visual inspection. Only then set `full-motion/<id>/review.json` approval flags and run `publish-catalog-review.cjs`.

Capybara's V3 rotations invented gray hip equipment twice. Built-in ImageGen removed it from a four-column, two-row rotation sheet, saved as `capybara-rotation-clean-source.png`. `pack-capybara-rotations.cjs` mechanically crops that sheet and preserves the original front. `prepare-catalog-refs.cjs` uses this correction automatically. The old rotations remain in `full-motion/capybara/rejected-equipment-rotations`; they must not be activated.

Capybara's south walk also received a built-in ImageGen cleanup for magenta arm-edge corruption (`capybara-south-clean-source.png`). Run `pack-capybara-walk-cleanup.cjs` after packing its raw MiniMax jobs to select the cleaned frames; it uses one scale across all eight cells and a consistent foot anchor.

Ultron Droid's V3 southwest reference duplicated its back-left view. Built-in ImageGen supplied the correct front-left view (`ultrondroid-south-west-source.png`); `pack-catalog-rotation-override.cjs` packs it to the same 76px master height. `rotation-overrides.json` makes the correction reproducible through `prepare-catalog-refs.cjs`. Its southwest walk was regenerated from this corrected reference.

Run `validate-catalog.cjs --final` after all approvals. It checks selected frame counts, nonempty alpha, clipping, 76px standing height, row112 foot anchor, distinct walking frames, canonical portrait aliases and app mirrors. Real station motion evidence is recorded separately in `live-*.json`; tests and packed frame counts alone do not prove the live result.

Also run `validate-motion-inputs.cjs --final`: every selected MiniMax job's unchanged input frame must match its current directional reference, or the current north seated frame for typing. This detects motion accidentally generated from superseded artwork.

Do not rerun the older `pack-catalog-motion.cjs`, `pack-approved-motion.cjs`, `wire-readability.cjs` or `build-station-demo.cjs` over this result: they restore earlier selections or overwrite the current review controls.
