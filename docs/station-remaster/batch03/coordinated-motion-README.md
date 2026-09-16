# Painted prop motion handoff

`coordinated-motion-recipes.json` combines 64 prop recipes: 11 control, 8 habitat, 21 media/treasury, 12 utility and 12 accessories. These are measured integration instructions, not implemented animations. The original station texture task owns runtime changes and live verification.

Each view records the exported PNG path, SHA-256, dimensions and measured nonzero-alpha bounds. Primary `regions`, `screenRegions` and `motion` coordinates normalize the complete exported image. `engineAlphaNormalized` provides coordinates relative to the tight alpha crop used by PropRemaster. Use the latter when drawing against its fitted `box`; utility images have transparent padding, so the two spaces differ. World-pixel rise and displacement values are explicitly separate from normalized coordinates.

`motion` is the primary effect object. Additional layers and `motionEffects`/`screenEffects` retain distinct mechanisms, timing, masks and triggers. A named mode describes the requested behavior; custom modes still need renderer support. Do not treat this file as a drop-in runtime manifest or replace a mechanism with an unrelated pulse. Baked fish, wax, needles and specimens need content isolation, repair or bounded deformation before movement; overlays must not duplicate the painted objects.

Preserve native ambient versus work versus actual tool-result triggers. Idle control displays retain subtle ambient activity, while work increases it. Arcade activity is work-driven; studio result pulses require the real per-instance result signal. Decorative maps, tickers and meters are not harness telemetry. Follow each recipe's native evidence and palette instead of applying a universal cyan glow.

Quiet foliage, incidental sparkles and absent decorative LEDs are explicitly marked intentional static where appropriate. Steady lamps remain steady. Useful paper/thread/paint mechanisms, fish motion, lava motion, plasma arcs and holographic projections remain integration requirements. Floorlight and steamvent art has more visible height than the native flush floor drawings: verify layering or recessed placement without silently changing walkability.

Airlock, jukebox, outbox, connector portal, publication machinery, transport, five content boards, and the original task's equipment/comms/lab set belong to other integration lanes. This file deliberately does not redefine them.

Run `node dev/industrial-textures/collect-coordinated-recipes.cjs` with Sharp available to rebuild the combined file and its validation receipt. The validator checks source identity, dimensions, alpha bounds and normalized region geometry. `frontend/prop-motion-calibration.html` displays measured guides over the exported art for visual inspection. Neither check proves live motion, interaction, collision or application state.
