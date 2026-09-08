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

The isolated acceptance station runs at `http://127.0.0.1:9207` using
`node dev/seed.js --keep`. It started with three rooms, three connecting halls, 43 props,
50 belt tiles and three crew members. The fixture compiler reported zero routing warnings.
The local scripted model runs at port 9208; it is an explicit test provider, not an external
model quality demonstration. `dev/world-next-seed.cjs` validates without writing by default
and refuses to overwrite an unrelated scratch workspace.

Observed in the running app on 2026-09-07/08:

- Viewed the new materials, practical fixtures, wall occlusion and crew depth in the world
  and REFIT. Eighteen deck materials and seven industrial wall finishes have new painters.
- Changed COMMAND from cobalt alloy to sterile hex through SURFACE, used Undo and Redo,
  then DONE. The live station reported `floorMat: hex` and `floorStyle: sterile`.
- Used the catalog's TURN control to place a chair. The live station reported 44 props and
  `p50: { t: chair, x: 22, y: 19, r: 1 }`.
- Drew a new HAB room and a two-tile-wide connecting corridor in REFIT. The saved live world
  reported four rooms, four halls, a 540 x 506 rendering extent and 47 light sources. Undoing
  both additions restored the original three-room, three-hall layout with 44 props.
- Activated CRT LAB's Clean preset with the keyboard and observed dust, scan, grain and
  aberration become zero. Restored World II phosphor and observed dust 0.35 and scan 0.26.
- Observed EMBER in the transfer corridor and later in the conservatory while crew were
  idle or walking, without inventing a working state.
- Sent `Run the world proof` in COMMS. The real sidecar run
  `79d6546e-057f-4703-b6ab-80c8d30b0803` displayed WORKING then RUN COMPLETE, executed the
  filesystem tool, and wrote the 1,782-byte `agent/world-next-proof.html` file. Its saved-file
  link was present and clicked; an inline browser view of the downloaded file was not proven.
- Stopped only this worktree's sidecar and restarted with `--keep`. DOM diagnostics again
  reported the hex deck, rotated chair, 44 props, 50 belt tiles, NOVA/EMBER/FERN and an online
  event connection. The artifact remained on disk.
- One warm 120-frame sample at high quality reported 42 light sources, zero dropped sources,
  about 6.8 MB of lighting caches, rendering median 2.1 ms and p95 2.8 ms. This measures the
  instrumented rendering pass on this machine; it excludes earlier simulation/background
  work and is not a whole-frame, large-station or cross-hardware performance guarantee.

Independent review caught and corrected raised-source occlusion, exact chunk masks,
context recovery, full lamp collection and atmosphere controls. The focused checks cover
68 lighting assertions, 309 material assertions, display ordering and lifecycle, material
seams, hulls, room lighting, CRT probes, canvas recovery and agent clicking.

`npm run test:fast` passed all **734 steps** at committed candidate
`d4525026ce618128b5e8b10b1f3f751204a991f3`. The local log is
`dev/world-next-fast-final.log`. The website mirror is synchronized. The required source
manifest was mechanically re-locked; all 37 reviewed claims and their verdicts were preserved.

This document is not a release-readiness or completed-migration receipt. Installed Windows/macOS
packages, real paid model providers, full production saves and every rare mechanic have not
been replayed in this acceptance session. Art superiority over other games is not asserted.

For a direct visual comparison, append `?world=classic` to the preview URL. The new renderer
is the default; `?worldlab=1` adds a read-only development diagnostic panel, and `?crtlab=1`
opens the existing art-tuning controls with a World II phosphor preset.
