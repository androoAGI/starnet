# StarNet world generation II

Owner request: rebuild the 2D world with a generational improvement in material art,
lighting, depth and interaction quality while preserving the complete existing mechanics.

Done means: in the seeded running app, build and repaint connected rooms, place and rotate
props, move through doorways, observe real task activity and an openable artifact, then
restart and recover the same station. The new material and lighting passes must remain
consistent between REFIT and the live world. The full fast gate must pass. Art superiority
over other games remains an owner judgment, not a test result.

Implementation boundary: the existing world model, capability/routing compiler, save format,
agent simulation and prop/sprite behavior are retained. New surface and illumination engines
consume their geometry and display list. The renderer may never invent work state.

The first implementation uses the current browser canvas infrastructure so the established
Tauri packaging, input mapping, sprite anchors and GPU CRT recovery remain usable. A future
GPU scene backend can consume the same render passes without moving simulation or authority
back into drawing code. This is a deliberate implementation choice, not a claim that an
external game engine was installed.

## Visual direction

- Cold blue-grey structural steel; warm ivory/amber practical fixtures; bounded cyan machinery.
- Broad quiet material areas, authored panel joins, recessed mechanisms and small highlights.
- Light sources illuminate only surfaces they can reach; wall geometry blocks light.
- Clear feet contact and furniture depth; readable work labels above the illumination pass.
- Existing floor/wall paint choices, sprite style and CRT identity remain meaningful.

## Mechanics preservation inventory

| Domain | Existing authority retained | Required observations |
| --- | --- | --- |
| Rooms, halls, doors, paint | WorldModel + StationBake geometry | REFIT/world parity, undo, reload |
| Props, rotation, mounting | PropSprites + PropAnchor | footprint, rotation, seat/bed occlusion |
| Crew | World simulation + SPRITES | feet anchors, containment, navigation |
| Tool grants | existing capability projection | props still resolve real capabilities |
| Conveyor and junctions | Pipeline + Conveyor | routing/validation and actual cargo |
| Runs, handoffs, approvals | existing harness events | real run start/end; disconnected state |
| Goals, quests, trophies | existing durable stores | current projection remains wired |
| Chat, voice, connectors | existing panels and services | unchanged entry points stay accessible |
| Save and recovery | existing save envelope | station/roster survive restart |

## Evidence

Implementation and verification results will be recorded here as they are observed. This
document is not a release-readiness or completed-migration receipt.
