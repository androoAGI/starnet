# Furnished default and station builds

Preview: http://127.0.0.1:18845/

Branch: `agent/station-default-0915`, based on the texture coordinator's committed
remaster at `2133aeb0a`. This is an isolated source preview, not an installed release.

## Behavior

- A new station starts with the file cabinet, web dish, workbench, memory server,
  media studio, one adoptable agent workstation, and two plants.
- The default is an 18 × 11 room with a clear central walkway. Existing saved
  stations do not go through the new-station composition factory.
- All equipment and both plants back onto the north wall at row 1. The workstation
  sits on the center axis, with files/memory and the terminal to the left,
  media/web to the right, and plants at the two ends. The remaining floor is open.
- The latest projection-corrected prop art loads without a query parameter.
  Explicit classic, approved-sheet, and casing-draft comparisons remain available.
- The optional tutorial explains the actual equipment and offers a real file task.
  It never opens the placement loop or creates duplicate props. Tool execution
  still depends on the existing access settings and configured services.
- REFIT → STATION BUILDS contains the default plus five alternatives:

| Build | Rooms (excluding corridors) | Intended use |
| --- | ---: | --- |
| Quiet Retreat | 2 | Solo work and a reading/rest room |
| Creative Studio | 3 | Writing, design, media, and review |
| Research Station | 3 | Investigation and a reference library |
| Engineering Station | 5 | Implementation, review, research, and rest |
| Operations Station | 5 | Planning, research, review, and reference |

All five essentials stay in the central room. Room names and furnishings suggest
uses; templates do not hire agents, configure workflows, or imply running work.
Applying requires choosing a build and confirming the replacement. The previous
layout is backed up in the current browser's local storage before replacement;
failure to store that backup prevents the change. The picker can restore that
backup after reopening. REFIT also offers single-step Undo/Redo. Conversations and
roster remain outside this layout operation; existing desk owners retain desks.

## Verification

Composition refinement: worldmodel passed 536 assertions and all six template
connectivity/placement checks passed. Applied the revised default through the
live picker at port 18845, inspected the finished room, observed the saved-layout
notification, and verified all eight final prop positions against the factory
in the server's scratch save. Earlier screenshots below precede this refinement.

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
