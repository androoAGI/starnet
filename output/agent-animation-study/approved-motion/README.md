# Approved industrial agent motion

The user approved readability-v1 Secret Agent proportions and requested all five revised skins moving in the actual dev station.

## Included

Secret Agent, Ultron, Skeleton, Plague Doctor, Void Wizard. Each has eight standing directions, eight 8-frame walk cycles, four cardinal seated poses, and a four-frame north-facing typing loop: 400 selected runtime frames across105 tracks. Idle breathing uses the existing renderer. The 525 packed PNGs retain input frames and seat-transition source frames for audit; the runtime uses only final seated poses.

All standing directions have76 visible source pixels at scale18/76:18 world pixels. All masters144x144, standing feet112. Walking frames keep a fixed scale/anchor; their visible height varies73–81px with natural steps. No per-frame fit normalization or clipping.

## Provenance and cleanup

The approved fronts are preserved exactly for south. PixelLab V3 reference rotations supplied seven other views per skin; normalized96x96 directional references are retained. animate_image generated closed walk loops with identical start/end references, seated transitions, and typing loops. jobs.json records the65 selected jobs; initial-jobs.json and corrections.json retain original/retry history.

Ultron north and Plague Doctor front/rear seat poses were rerolled for clearer bending. Two side-seat outputs had unwanted furniture, while their retries lost the seated pose. Built-in ImageGen cleaned the furniture from the correctly seated originals. The cleaned source images and seat-cleanups.json are retained; mechanical packing preserves the seated height. Only the final seated frames are overridden.

## Runtime

The same real seeded dev server at http://127.0.0.1:18814/agent-station-demo.html?propSet=projection now maps all five actual roster agents to approved_<skin>. These are moving pathfinding bodies, not the comparison mannequins. Front comparisons remain optional, hidden by default. Follow selects real camera tracking. No agent work events or provider runs were fabricated or triggered.

Demo-only sprite rendering exposes observed frame indices. Demo world rendering records actual walk poses, frame changes and travel in the panel's data-motion attribute. Seated typing now uses its own foot padding and chair lift, just like seated idle.

Live verification observed all five using approved_* walking tracks and changing position: Ultron15 distinct rendered walk frames/28.03 world units, Skeleton20/53.67, Plague Doctor17/33.94, Secret Agent40/43.27, Void Wizard34/26.83 in the first sample. Inspected the actual station and roster portraits. A startup readiness race found in the live check was fixed by waiting for SPRITES.ready before ensuring the required sets.

## Reproduction

1. prepare-approved-motion.cjs downloads and packs normalized rotation references from rotations.json.
2. pack-approved-motion.cjs --final packs completed motion jobs, installs the manifest and portrait aliases, and mirrors assets.
3. clean-approved-seats.cjs applies the two generated cleanups after packing and mirrors them.
4. validate-approved-motion.cjs checks alpha bounds, standing height, foot anchor and clipping.

Runtime code is isolated in frontend/agent-demo and mirrored under website/app. No integration-tree merge or production-world change.

## September 15 walk and floor-contact correction

The original pinned front/back cycles frequently raised both feet together or barely stepped. Replaced all ten north/south loops with PixelLab PixMiniMax alternating-step cycles. `walk-fixes.json` preserves the eleven new job results and selections. Skeleton west also had solid-black rear limbs: ImageGen repaired the generated nine-cell strip, with the unchanged reference frame retained. The source is `walk-fixes/skeleton-west-clean-source.png`; the final packed strip is `walk-fixes/skeleton-west-clean.png`.

Standing art and height remain unchanged at 18 world pixels. Approved boots now sit 0.25 world pixels above their contact anchor instead of 3. Grounding uses the actual standing height and a narrower, stronger contact. Walk stride calculation excludes the 68 transparent rows in the master and invalidates its cache when scale changes. Movement speed scales from the legacy 35px body size to the approved body height so the smaller crew walks at a readable cadence.

After the original reproduction steps, run `pack-walk-fixes.cjs --activate`, then `pack-skeleton-walk-cleanup.cjs`, then `validate-approved-motion.cjs`. The cleanup uses a single source scale across all poses and preserves each original pose's alignment. Final validation: 525 packed frames, 40 unchanged 76px standing rotations, walking heights 73–80px, no clipped content. The panel revision is `grounded-walks-0915`; `data-motion` records actual render height, ground gap, speed, pose and travel.
