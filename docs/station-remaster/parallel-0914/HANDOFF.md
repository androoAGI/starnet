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

The user approved the existing exporter on 14 September. Seven verified transparent PNGs are now in `frontend/assets/industrial/parallel-0914/exports/`. The original lane images remain intact as provenance, including failed model extraction attempts. `export-checks.json` records source/output SHA-256, exact crop, alpha counts and zero RGB changes; `handoff-manifest.json` maps each view to its footprint and proposed world envelope. Use the exports for import, not the RGB source candidates.

The exporter is `dev/industrial-textures/export-parallel-0914.cjs`, using the existing light-neutral flood-fill rule from the owner's prop-art-tools.cjs. Inspected enclosed background seeds are lowtable `(950,500)` and filter `(540,580)` in original source pixels. Tank is exported from the intact RGB generation rather than the faint-alpha model extraction. All seven decoded exports have genuine zero-alpha background and fully opaque retained art; no partial-alpha dust, resampling, RGB repaint or nonuniform stretch. Source-pixel moving-region coordinates must subtract the export crop's left/top before use; the handoff preserves the crop for this reason.

All designs were visually inspected, and worker metadata records source dimensions, alpha checks, proposed world envelopes, interaction anchors and unresolved animation. Exact built-in image generation prompts and intact sources are retained in each lane. User acceptance and in-station verification remain separate from file generation. The coordinator comparison page is `frontend/prop-parallel-review.html`; it previews proposed scale, not station lighting or live simulation.

Export verification: script syntax passed; all seven PNGs were decoded and checked for alpha, unchanged source hashes and unchanged RGB. The live comparison page loaded 7/7 transparent exports; dark-background inspection checked silhouettes and enclosed holes. These checks prove asset cleanup, not running-station seating, mounting, routing or animation behavior.

No runtime, shared contract, original atlas or live save was changed by these lanes. Full test:fast and live runtime gates remain the integration owner's next-stage checks; no merge-to-trunk claim is made.
