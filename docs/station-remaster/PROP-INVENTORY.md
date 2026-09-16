# Prop remaster coverage ledger

This is the **160-ID baseline**, audited at source `b26e667f5eae02d4d1e0076ab3cfd47f0770ebbc` on 2026-09-13, before the comprehensive prop pass. It records what must survive the redesign. It does **not** certify that all 160 props have new authored artwork or final proportions.

The detailed, complete inventory is [prop-inventory.json](../../dev/industrial-textures/prop-inventory.json). Every ID has its original concept/label, classic and remaster box, offered views and their exact boxes, mirror behavior, collision/mount flags, capability identity, leisure/seat contract, true state inputs, light emitter, sampled animation, source references and current art status. All records intentionally remain baseline-audited rather than accepted.

## What exists

| Family | IDs | Authored raster IDs | Native constructed IDs | IDs with more than one facing |
|---|---:|---:|---:|---:|
| Workstations | 7 | 2 | 5 | 2 |
| Workflow | 8 | 0 | 8 | 0 |
| Capability | 13 | 0 | 13 | 0 |
| Isolation | 1 | 0 | 1 | 0 |
| Command | 2 | 0 | 2 | 0 |
| Screens | 16 | 2 | 14 | 0 |
| Lab | 12 | 0 | 12 | 0 |
| Storage | 10 | 1 | 9 | 0 |
| Comms | 9 | 0 | 9 | 0 |
| Lounge | 21 | 0 | 21 | 0 |
| Decor | 61 | 2 | 59 | 18 |
| **Total** | **160** | **7** | **153** | **20** |

There are **31 functional-tier IDs, 129 cosmetic-tier IDs, 21 capability-mapped IDs, six assignable workstation types, 33 leisure descriptors, 77 light emitters and eight flat decals**. Tier is not authority: `jukebox` remains in the cosmetic lounge category but maps to the actual Spotify capability.

The seven raster IDs are `desk`, `desk2`, `chair`, `bridge_consolebank`, `bridge_tacticaltable`, `bridge_equipmentbay` and `bridge_deckperimeter`. The other 153 already receive industrial material/construction treatment but still use native procedural silhouettes. A raster texture applied inside a native panel does not turn that object into an individually authored prop.

The 20 rotatable IDs expose **208 total catalog views**; 140 IDs remain south-only. Eight of those 20 are flat decals. Only 12 elevated props have multiple projections: desk, desk2, chair, dinerchair, podchair, industrial_partition, booth, lowtable, glasstable, dinertable, loungetable and longtable. Several left/right props are separate IDs, not selectable quarter-turns.

The internal `seatchair` is an additional generated workstation furnishing, **not** one of the 160 palette IDs. Retired `beltH` and `parcels` still render old saves but are not newly placeable. Keep these compatibility drawings when replacing the catalog.

## Animation that must survive

| Behavior | Current source of truth | Retention requirement |
|---|---|---|
| Workstation screen/typing light | Assigned body working state; crew compute eligibility; real activity heat and only published progress | The remaster must turn screens on at the actual seat, animate within screen glass, keep absent progress absent, and keep chair/front alignment in every view. |
| Capability surge | Real matching tool completion, mapped by ToolProps to the granting instance | Preserve 900 ms success accent and distinct red denied/failed cue. Do not pulse every cabinet in every room. |
| Workbench | Room-scoped shell.exec / verify.result | Preserve success/failure and instance scope. |
| Connector | Successful connector poll and actual bound MCP tool activity | Preserve unbound/offline/online states, pulse and removal reconciliation; never show connected merely because a portal was placed. |
| Jukebox | Spotify connected state and actual Spotify tool calls | Keep disconnected hardware dark. Do not infer playback from decorative disc motion. |
| Bay | Assignment/name plus that agent's actual work state | Preserve bound label, unassigned cue, awaiting exclusions and activity. |
| Outbox | Real outbound delivery and pending return count | Preserve 600 ms delivery flash and actual uncollected-crate count. |
| Airlock | Saved open/closed/jammed state | Preserve three distinct iris geometries and jam sparks; geometry must agree with room sealing. |
| Mission board | Open quests, station gap, jammed routines, proposals | Preserve real pin/count/alert inputs. |
| Trophy case | Earned trophies and reached-goal stage | Preserve actual fill/crown records; no decorative achievements. |
| Seats, sofa, recliners, bed | Actual claimed seat or mattress and body state | Preserve cushion claims, approaches, lifted hips, sofa-back occlusion, side arm overlay, and frame/body/quilt split. |

At this baseline the native raster probe finds **94 IDs with default clock motion** and 66 with no motion in the sampled default states. The catalog calls 128 IDs animated; **34 of those show no default clock motion**. Some are intentionally static furniture; some animate only while used or connected. The flag is informational and cannot prove animation retention.

Classic native rendering responds to a work flag on 76 IDs; the current remaster responds on 71. The five differences are desk, desk2 and the three bridge furniture silhouettes. The bridge scenery is explicitly decorative, so a static navigation image is not a lost backend promise. **Desk/desk2 are different:** their raster renderer returns before the old screen drawing, leaving the authored screen lit and static. The generic heat/progress overlays and work-gated floor light still exist, but are not a replacement for actual glass animation. This is a verified baseline gap for the animation lane to repair.

Other native motion—fish, steam, lamps, scanners, plants and cosmetic screens—is atmospheric, not proof that an agent or provider is working. In particular, the existing filter/junction indicator choices are derived from the frame clock, not real selected-route data. Preserve attractive motion without recasting it as telemetry. The per-prop ledger states which inputs are live.

## Projection and proportion rules

A tile is **12 world pixels**. Catalog width/height are reserved placement rectangles, not an instruction to stretch every visible object to fill its box. A small mug should occupy a small part of its tile. An upright 1×2 cabinet's second tile supplies elevation/drawing room; spinning its bitmap would change its perceived height.

Use one fixed high overhead oblique camera and a consistent contact plane. Author south, east and north views when those are meaningful; west may mirror a properly authored side only when text, lighting and asymmetric hardware allow it. Never rotate an upright front raster 90 degrees.

Real plan footprints may retile: floors, valid table surfaces, the explicit plan set and remaster desks. Other upright boxes remain fixed. Existing saved dimensions take priority over updated catalog defaults; retain compact 2×1 desks and broad 3×1 desks, including 1×2/1×3 side views.

Mounting is a separate contract: six table hosts accept valid objects; mandatory or optional tabletop props lift exactly **8 world pixels**. Wall-mounted panels/racks keep wall-host checks. Floor decals render below bodies and do not create obstacles. Opaque bounds in the JSON are measured alpha extents, not collision bounds or proof of a perfect contact silhouette.

Workstations use an adjacent, walkable, center-out seat anchor. A fractional visual center may move at most half a tile from that safe tile. Single chairs and stools own a real seat claim; recliners use fixed side anchors and near-arm occlusion. Generic `sit:false` does **not** mean a couch or bed has no special body interaction. Multi-tile turned booth seating should be rechecked against its current horizontal cushion-slot planner before promising perfect angled occupation.

## First twelve detail priorities

Desk/desk2 and the generated chair are the animation/calibration reference. After that, these twelve native props most directly raise the station's visible and functional standard:

| ID | Existing concept / default box | First authored detail and behavior target |
|---|---|---|
| console | Compact console / 2×1 | Dense cyan instrument bank; real seated screen sequence; side/rear projections. |
| consoleL | Long console / 3×1 | Distinct long operating surface and secondary panels; preserve centered approach. |
| pixelrig | Media computer / 2×1 | Media-screen identity within dark steel, matching keyboard/seat scale. |
| bench | Broad multi-screen workstation / 4×1 | Long working bench with separate monitor masses; proportional four-tile span. |
| workbench | Code/test tooling bench / 2×1 | Industrial tool board and work surface; instance-scoped shell/verify result effects. |
| bay | Assigned agent dock / 2×2 | Heavy loading dock with readable mouth and assignment panel; real work state. |
| intake | Incoming work dock / 2×2 | Inbound chute, armored collar and carrier contact; distinguish it from outbox. |
| outbox | Finished-result dock / 2×2 | Dispatch conveyor mouth and stacked-product area; live delivery and count layers. |
| rack | File server rack / 2×1 | Layered rails, dense vents and removable modules; file-tool surge. |
| core | Memory core / 1×2 | Tall enclosed data core with legible service spine; memory-tool response. |
| comms_dish | Web/comms antenna / 2×2 | Mechanically credible dish depth, supports and pivot; web-tool surge. |
| connector_portal | MCP connector terminal / 1×2 | Armored integration cabinet with a distinct live status window; exact connection states. |

Then cover remaining capability aliases, command surfaces, lounge/seating, storage/comms, lab, tabletop objects and decals using the complete ledger. Tables, chairs, cabinets, consoles and freestanding machinery need their own projection decisions; diverse concepts must not become the same console recolored.

## Preview and reproducibility

The current preview save was read without changes. Its **19 placed props use only seven catalog types**: desk ×1, desk2 ×4, chair ×6, bridge_consolebank ×2, bridge_equipmentbay ×4, bridge_tacticaltable ×1 and bridge_deckperimeter ×1. The persistent scene therefore cannot prove whole-catalog coverage. The fixture and placements are recorded in the JSON.

Run `node dev/industrial-textures/generate-prop-inventory.cjs --sheet` with `@napi-rs/canvas` available on NODE_PATH. It loads the actual PNG pack, inspects the actual exported catalog, samples all 160 IDs in classic and industrial modes at nine timestamps with work off/on, checks all referenced art paths, and regenerates the machine ledger. Optional contact sheets land in `dev/.scratch-workspace/prop-inventory/{classic,industrial}.png`. These are renderer fixtures, explicitly not live work.

Verification for this documentation lane: 160 unique catalog records, all actual raster assets decoded through the pack, nonempty default art for every ID, source hashes recorded, two native contact sheets visually inspected, and saved preview prop identities matched. No runtime files were edited. No full test gate or new live provider run was performed in this audit lane; root owns the combined runtime checks.
