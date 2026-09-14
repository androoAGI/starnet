# Parallel prop production — 14 September 2026

The user requested parallel production in the new station aesthetic. This batch adds three isolated asset workers to the existing texture owner. It does not change the owner's live preview or imply approval of generated designs.

## Ownership

| Worker | Branch | Exclusive IDs |
| --- | --- | --- |
| Storage | agent/prop-storage-0914 | bookshelf, boxes |
| Crew furniture | agent/prop-crew-0914 | couch, lowtable (south and east) |
| Utility equipment | agent/prop-utility-0914 | filter, tank |

The original texture task retains console, consoleL, industrial_locker, industrial_drawerbank, industrial_supplycart, industrial_toolcaddy, plant, and runtime/atlas/integration ownership. Its workspace is `C:/Users/andro/gen-trees/industrial-textures-0912`, with the seeded preview at http://127.0.0.1:18792/?propReview=crate.

The eight approved existing raster IDs remain crate, desk, desk2, chair, bridge_consolebank, bridge_tacticaltable, bridge_equipmentbay, and bridge_deckperimeter.

## Visual contract

The approved crate supplies finish and readability; workstation.png supplies the camera; bridge-reference.png supplies the environment. Feed the actual images to the built-in image generation tool. Distinct forms and materials should serve each object's purpose while fitting the industrial station. The crate is not a universal shape template.

Reimagine full objects, including controls and display graphics. The earlier props-v2 casing drafts are rejected. Existing procedural geometry supplies footprint and interaction contracts only. Preserve source aspect ratio and genuine alpha; never stretch nonuniformly or rotate an elevated bitmap to invent a facing.

## Delivery contract

Each lane owns a directory under `frontend/assets/industrial/parallel-0914/` and provenance under `docs/station-remaster/parallel-0914/`. Supply each supported facing independently, original generated source, exact prompt, export metadata, world envelope, floor-contact point, and interaction/seat anchors in 12-pixel tile units. Stateful artwork must identify moving regions and unresolved runtime work.

The integration owner imports selected art and verifies actual station lighting, placement, seating, routing and animations. Asset inspection alone does not establish this. No trunk merge, release or installation is part of this asset handoff.

## Acceptance state

All three workers completed the first batch: six designs, seven authored views. Commits are storage `4354709868934f7a6089e1436604e22c1c32d3f9`, crew `b63885e13`, and utility `9cb96b26a1229bdd779517b7d4d0de39200946f7`. They are merged only into the isolated coordinator branch. The original texture task received every lane handoff and retains live integration ownership.

Six source images remain RGB with baked checkerboards, including after targeted built-in background extraction attempts. Tank has genuine RGBA but faint peripheral alpha residue. Do not consume these candidates as final runtime sprites. A question requesting explicit permission to use the existing non-imagegen exporter is pending in the coordination task; no such edits were performed here.

All designs were visually inspected, and worker metadata records source dimensions, alpha checks, proposed world envelopes, interaction anchors and unresolved animation. Exact built-in image generation prompts and intact sources are retained in each lane. User acceptance and in-station verification remain separate from file generation. The coordinator comparison page is `frontend/prop-parallel-review.html`; it previews proposed scale, not station lighting or live simulation.

No runtime, shared contract, original atlas or live save was changed by these lanes. Full test:fast and live runtime gates remain the integration owner's next-stage checks; no merge-to-trunk claim is made.
