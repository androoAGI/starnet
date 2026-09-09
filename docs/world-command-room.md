# Command-room vertical slice — 2026-09-09

Preview: `http://127.0.0.1:9207/?commandroom=1`. The regular URL retains the prior station view.

This is a presentation layer over the saved station, not a replacement save or a standalone mock game. The spawn room receives recessed observation glazing, deck trenches and docking outlines, structural fixtures, a new command console and cabinet, a navigation table with real crew positions, and proximity-operated bulkheads derived only from passable geometry. NOVA receives a PixelLab operator with eight-direction walking, seated poses, actual seated typing and one-shot control reaches. Light response is clipped to sprite alpha; screen emission uses the existing live workstation data.

The operator retains its identity outside the command room. Other crew retain their selected skins. Rotated or mounted equipment uses its existing renderer. Capability bindings, footprints, navigation, conveyors and saved room topology are unchanged. Reduced motion freezes decorative animation and snaps proximity doors. Canvas loss invalidates cached architecture and light responses.

Art provenance: PixelLab character `5b6708fe-4e1b-4798-8493-b15684974b60`, seated state `6bc43ce3-ea30-46b7-8fe6-5b4c24052a43`, console `b04660ca-a27e-4125-a123-81da74697517`, cabinet `1e5fc7fe-d6c8-4315-b17d-aaa8a7e13be9`. Original master frames and metadata live under `frontend/assets/command-room/`. Runtime typing composites animated upper-body pixels over the fixed seated pelvis; generated animation must not straighten the legs. Per-track opaque bounds anchor feet to the floor.

Verification so far: isolated contract regression covers opt-in asset loading, disjoint doorway spans, sealed topology, proximity, geometry immutability, truthful screen intensity, seated identity and reach-on-arrival. Live browser proof observed walking and typing during the local scripted-provider harness run, unchanged saved station and route hash, no browser exceptions. Refit/reduced-motion/canvas-loss/reload proof passed with 46 saved props and one successful renderer recovery. These are lane-level checks, not a production or whole-project quality verdict.

Entry points: `frontend/app/commandroom.js`, narrow draw hooks in `frontend/app/world.js`, opt-in script loaded before World. Generated website mirror comes from `npm run sync:website`.
