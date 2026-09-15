# Furnished default and station builds

Preview: http://127.0.0.1:18845/

Branch: `agent/station-default-0915`, based on the texture coordinator's committed
remaster at `2133aeb0a`. This is an isolated source preview, not an installed release.

## Behavior

- A new station starts with the file cabinet, web dish, workbench, memory server,
  media studio, one adoptable agent workstation, and two plants.
- The default uses the original rectangular 18 × 11 room (198 tiles).
  Keep these dimensions for future layout refinements: the user explicitly rejected
  widening the default. Existing saved stations
  do not go through the new-station composition factory.
- The user-approved live arrangement is preserved in the default factory and
  [approval fixture](../../test/fixtures/station-default-approved.json): desk at
  (8,1), files at (1,0), workbench at (3,1), dish at (14,0), memory at (1,9),
  media at (14,8), and plants at (0,0)/(17,0). Later approval supersedes the
  earlier request to put all furniture along the back wall.
- Template corridors connect to the rectangular footprint on all four sides.
  All six template layouts retain reachable rooms.
- The latest projection-corrected prop art loads without a query parameter.
  Explicit classic, approved-sheet, and casing-draft comparisons remain available.
- The five essentials now use the workstation-derived capability-v2 replacements
  from texture-coordinator snapshot `3545e946c`. See
  [import verification](capability-v2/DEFAULT-IMPORT.md) for scope and evidence.
- The optional tutorial explains the actual equipment and offers a real file task.
  It never opens the placement loop or creates duplicate props. Tool execution
  still depends on the existing access settings and configured services.
- REFIT → STATION BUILDS contains the default plus five alternatives:

| Build | Rooms (excluding corridors) | Intended use |
| --- | ---: | --- |
| Quiet Retreat | 2 | Home + library/lounge to the south |
| Creative Studio | 3 | Home between a writing/design studio and review room |
| Research Station | 3 | Home + northern analysis lab and eastern archive |
| Engineering Station | 5 | Home + workshop, review, analysis, and lounge |
| Operations Station | 5 | Home + archive, communications, planning, and review |

All five essentials stay in the central room. Room names and furnishings suggest
uses; templates do not hire agents, configure workflows, or imply running work.
Every added room is also 18 × 11, with four or five furnishings and clear door
approaches. Added desks follow the active catalog (three tiles wide with the
remastered art); the approved existing home desk retains its saved footprint.
Applying requires choosing a build and confirming the replacement. The previous
layout is backed up in the current browser's local storage before replacement;
failure to store that backup prevents the change. The picker can restore that
backup after reopening. REFIT also offers single-step Undo/Redo. Conversations and
roster remain outside this layout operation; existing desk owners retain desks.

## Verification

Preset completion: applied all five alternatives through the live picker,
inspected each in the station, and compared each saved backend layout with its
factory using the active remastered prop catalog. Counts were 12/17/18/25/26
props for Retreat/Creative/Research/Engineering/Operations. No browser errors
were reported. Receipts and saved layouts are in `.dogfood/station-presets/`.
Restored the approved default afterward and verified its furniture/room against
the pre-test snapshot. Model checks cover classic and remastered desk widths,
approved-home preservation, room sizes, connected rooms, all prop approaches,
clear entrances in added rooms, ownership, undo/redo, and persistence.

Composition refinement: worldmodel passed 536 assertions and all six template
connectivity/placement checks passed. Applied the revised default through the
live picker at port 18845, inspected the finished room, observed the saved-layout
notification, and verified the rectangular geometry and all eight final prop positions
against the factory in the server's scratch save. Every prop's front approach is
reachable through the projected navigation graph. The enlarged live view was
inspected for wall joins and prop spacing. Earlier screenshots below precede
this refinement. The aggregate gate below remains failed; it was not rerun for
these layout changes.

Final focused checks passed: station template connectivity, catalog footprints,
all five grants, desk ownership, rejected invalid placements, save round-trips,
Undo/Redo; worldmodel (538 assertions); onboarding and equipment-tour regressions;
control theming (173) and tooltips (495); prop remaster (1,413), industrial materials
(301), texture readiness (69), projection effects/depth, furnished layout and real
canvas room connections (408). JavaScript syntax and `git diff --check` passed.

Live browser evidence under `.dogfood/station-default/`:

- `receipt.json`: all five additional builds applied through picker controls,
  real floor grants, desk binding, backup, restore, Undo, and reload.
- `tutorial-receipt.json`: equipment explanation names all five actual grants,
  props unchanged, placement never opened, backup available after reload, acknowledged
  durable writes, and zero browser exceptions.
- `default-station.png`, `station-build-picker.png`, five named build screenshots,
  `tutorial-equipment.png`, and `picker-narrow.png` were inspected.
- The picker fits an 800 × 700 viewport with text scaling: left/right 24/776,
  top/bottom 42/658, no horizontal overflow.

An earlier interrupted/reused QA browser profile displayed a save conflict. The
final fresh-profile test explicitly drained save requests, verified a selected
build after reload, restored the default, and received successful save acknowledgments.

The aggregate `npm run test:fast` attempt failed the texture branch's existing
planning-authority / finite-claims assertions in `qa-product-perfect-claims` and
reached its 900,000 ms timeout. `station-default-fast.log` contains the output.
The full gate is **not green**; no integration merge or release was performed.
Real provider execution and the installed desktop build were not verified here.

## Cozy Workshop — September 15

Added a seventh choice, COZY WORKSHOP: the approved home between an 18×11
wood-floored workroom to the north and an 18×11 lounge to the south. The lounge
has a sofa, rug, coffee corner, shelves, plants, and a bed. The workroom uses
the existing `front_desk` blueprint: Inbox → Bay → Outbox, with two connected
three-tile conveyor runs. The bay is unassigned; the picker explains that the
user assigns an agent. No agent recruitment or task execution is implied.
Picker schematics now include real belt tiles.

Applied through the live picker at 18845, inspected the full station and bay
assignment dialog, observed the save acknowledgment, and compared the saved
rooms, props, and belts exactly against the remastered factory. The preview
is left showing this cozy build. Snapshot receipts are in
`.dogfood/station-cozy/`. A stale save alert encountered before applying was
resolved with the app's Reload current station control; subsequent saves passed.

Seven-preset tests pass for both sprite catalogs, including approved-home
preservation, room sizes, entrances, walking paths, persistence, and conveyor
compilation. The fresh line reports only UNBOUND_BAY; assigning a test agent
in the model yields zero routing errors and energizes all six belt tiles.
Worldmodel passes 536 assertions; blueprints pass 2,180. Syntax/diff checks
pass and the live browser reports no errors. The full gate above was not
rerun; no merge, release, or real provider job was performed.
