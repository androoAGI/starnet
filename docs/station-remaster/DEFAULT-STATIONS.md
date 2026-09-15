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

Cozy seating refinement: moved the couch away from the north wall and centered
the TV against that wall across the rug. Moved the small table into the right
half of the lounge and added two diner chairs facing inward (east/west authored
views). Template furniture now accepts an optional facing. Applied and visually
inspected in the live preview, observed the save acknowledgment, and verified
the saved chair facings plus unchanged home/workroom furniture and conveyors.
Seven-template tests and syntax/diff checks pass. The saved proof is
`.dogfood/station-cozy/seating-saved.json`.

## Creative Studio — September 15

Refined Creative Studio into an L-shaped three-room build: approved home,
wood-floored design studio to the north, and a dedicated draft/review room to
the east. Every room remains 18×11. The studio has an easel, desk, reference
shelves, drawers, plants, and a table with two inward-facing chairs. The review
room includes a straight Inbox → Draft Bay → Review Bay → Outbox line with
eight real conveyor tiles. Both step briefs are prefilled; agents remain
unassigned. This prepares the workflow without claiming that work has run.

Applied through the live picker on 18845 and inspected the layout and both
step editors. Observed save acknowledgment and compared all saved rooms,
furniture, step briefs, and conveyors to the remastered factory. The preview
is left showing Creative Studio. Saved evidence:
`.dogfood/station-creative/creative-saved.json`. No browser errors reported.

Seven-template tests pass for classic and remastered catalogs, including the
two unassigned-bay warnings, clean routing after test assignments, inbox
delivery to the drafter, drafter-to-reviewer handoff, reviewer output, and all
eight connected belt tiles. Worldmodel passes 536 assertions; syntax and diff
checks pass. The existing full-gate failure above remains; it was not rerun.
No merge, release, or real provider execution was performed.

## Build Mode and preset gallery — September 15

Station presets now have a persistent, prominent entry inside the build panel.
The workspace title is BUILD MODE, the exit action says SAVE & EXIT, and
CONVEYOR LINES is distinct from whole-station presets. The landing panel offers
furniture, expansion, and workflow entry points. Active tools display contextual
instructions above their options and an explicit STOP PLACING / BACK TO SELECT
action. Existing tool shortcuts remain available.

The preset gallery uses the shared phosphor glass palette, rounded cards,
supersampled floor plans, room/workflow counts from each actual template,
selected-state checks, and persistent back/apply controls. Descriptions scroll
with the gallery; replacement explanation and the existing two-step apply
confirmation remain visible. On screens up to 700px wide, the build panel is a
compact bottom sheet and camera framing reserves its actual height. Narrow
Undo/Redo controls now occupy separate grid cells.

Live checks at 909×913, 600×760, and 390×760 verified preset selection,
confirmation without applying, back navigation, room guidance, stop placement,
furniture search (couch), conveyor selection, and camera framing. The viewport
override was reset. The saved Creative Studio was compared exactly with the
pre-check snapshot in `.dogfood/build-mode-glass/before.json`; UI verification
did not change the station. Existing stale-save alerts after restarting the
preview were resolved with Reload current station. Final browser errors: none.

Focused checks pass: seven templates, refit card stack (68), junction cards
(117), run gate (23), test-ride intake (29), real footprint edit parity,
mobile controls (26), control theming (173), syntax, and whitespace. The earlier
full-gate failure remains; the full gate was not rerun and no merge was made.

## Placement feedback and click-to-edit — September 15

Clicking a prop now opens a shared glass action panel with Move, Rotate, Copy,
and a two-step Delete action. Configurable equipment retains a separate entry
to its existing agent assignment or workflow settings. The panel shows saved
dimensions and facing, disables rotation for fixed artwork, and preserves the
saved footprint when rotating. Move and Copy keep their Back to Select control
visible even though those tools have no catalog options.

Placement previews now name blocking props, explain off-floor placement in
plain language, and show a facing arrow plus the rotation shortcut for rotatable
props. Rejected placement clicks use the same explanation as the preview.

Live verification on 18845 exercised Rotate, Copy, Move, confirmed Delete,
Undo for each operation, and the existing agent assignment picker. Compared
the final saved Creative Studio exactly against the original station snapshot:
`.dogfood/build-interactions/before.json` and `restored.json`. After reloading,
verified Back to Select during Move and matching off-floor preview/click
messages. Left the prop action panel open for review. Browser errors: none.

Focused checks pass: card stack (68), junction cards (117), real footprint edit
parity, control theming (173), syntax, and whitespace. The inherited full-gate
failure recorded above remains; no full-gate rerun or merge was performed.
