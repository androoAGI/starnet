# Command-room vertical slice — 2026-09-09

Preview: `http://127.0.0.1:9207/?commandroom=1`. The regular URL retains the prior station view.

This is a presentation layer over the saved station, not a replacement save or a standalone mock game. The spawn room receives recessed observation glazing, deck trenches and docking outlines, structural fixtures, a new command console and cabinet, a navigation table with real crew positions, and proximity-operated bulkheads derived only from passable geometry. NOVA receives a PixelLab operator with eight-direction walking, seated poses, actual seated typing and one-shot control reaches. Light response is clipped to sprite alpha; screen emission uses the existing live workstation data.

The operator retains its identity outside the command room. Other crew retain their selected skins. Rotated or mounted equipment uses its existing renderer. Capability bindings, footprints, navigation, conveyors and saved room topology are unchanged. Reduced motion freezes decorative animation and snaps proximity doors. Canvas loss invalidates cached architecture and light responses.

Art provenance: PixelLab character `5b6708fe-4e1b-4798-8493-b15684974b60`, seated state `6bc43ce3-ea30-46b7-8fe6-5b4c24052a43`, console `b04660ca-a27e-4125-a123-81da74697517`, cabinet `1e5fc7fe-d6c8-4315-b17d-aaa8a7e13be9`. Original master frames and metadata live under `frontend/assets/command-room/`. Runtime typing composites animated upper-body pixels over the fixed seated pelvis; generated animation must not straighten the legs. Per-track opaque bounds anchor feet to the floor.

Verification so far: isolated contract regression covers opt-in asset loading, disjoint doorway spans, sealed topology, proximity, geometry immutability, truthful screen intensity, seated identity and reach-on-arrival. Live browser proof observed walking and typing during the local scripted-provider harness run, unchanged saved station and route hash, no browser exceptions. Refit/reduced-motion/canvas-loss/reload proof passed with 46 saved props and one successful renderer recovery. These are lane-level checks, not a production or whole-project quality verdict.

Entry points: `frontend/app/commandroom.js`, narrow draw hooks in `frontend/app/world.js`, opt-in script loaded before World. Generated website mirror comes from `npm run sync:website`.

## Final verification receipt

- `npm run test:fast`: `run-fast-tests: OK — 739 step(s) green` (`.tmp/command-final-fast.log`).
- Final lighting-query guard and source receipt: six focused steps passed (`.tmp/command-light-final.log`), covering claims authority, renderer, light geometry/receivers and the command-room contract.
- Final live load: `.uishots-immersion-command-delivery/live-proof.json`; WebGL camera lit (`frameSum: 83`), zero uncaught exceptions and zero dropped light sources. The lighting guard reduced this scene's sample-cache misses from 68 to 22 per frame; no universal FPS claim is made.
- Live work: `.uishots-command-final/proof.json`; `activity: task`, `command.type.north`, and actual harness tool/deliverable tallies. The local scripted provider executed the real filesystem tool. Initial actor placement at the desk was test setup, not fabricated run state.
- Live interaction: `.uishots-command-interactions/proof.json`; `command.reach.north` during the existing `post` goal at `(186,59)`. The tested bulkhead changed `open: 0 -> 1 -> 0` as the real body moved far/near/far; the proximity setup used the existing debug placement helper.
- Recovery: `.uishots-command-recovery/live-proof.json`; 46 props, unchanged saved geometry and routing hash, reduced motion, refit and renderer recovery/reload passed.
- The full gate initially encountered Windows `EBUSY` during Chromium profile cleanup after all graphics assertions passed. The test now requests orderly browser shutdown before its existing cleanup; isolated retry and full rerun passed.

Source commits: `296e78fef` (slice), `b0bf211b3` (real board survey and test cleanup), `aad31a429` (lighting-query guard). Final source receipt: `c1a59c4f5`. No integration-tree merge or production release was performed.
