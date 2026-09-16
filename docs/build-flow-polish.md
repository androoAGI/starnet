# Build Mode flow polish — 2026-09-15

This pass removes interruptions and makes tool ownership predictable. It preserves
the approved station geometry, textures and existing editor controls.

- Opening Build Mode starts in the library. Help remains available on request.
- Categories start in browse mode. Conveyor layouts arm only when a layout card
  is chosen; clicking the category or its library button cannot stamp a remembered
  layout. Re-clicking the active category preserves the current view.
- Search resumes without arming a prop. Queries survive editing and cancellation;
  prop and conveyor library scroll positions are retained.
- R/M change the pending prop while placing. Hovered furniture is eligible for
  keyboard rotation only while browsing. Opening a placed prop's actions cancels
  the previous placement tool.
- One Escape cancels a move gesture, half-connected belt or armed copy, releases
  pointer capture and returns to browsing without exiting Build Mode.
- Equipment placement and preset selection do not open configuration dialogs.
  Generic Build Mode coach bubbles are quiet; real placement progress and the
  explicit First Command tutorial remain connected to their existing hooks.
- Workflow checklists require an explicit configuration action. Routing warnings
  remain available during conveyor editing/configuration, without interrupting
  furniture or room browsing. Backend validation is unchanged.

## Verification

Live preview at `http://127.0.0.1:18845`:

- Opened Conveyors with no armed tool, selected layout or floating checklist.
- Searched for a diner chair, placed it, then rotated the pending preview. Clicking
  the placed chair confirmed it retained its original south-facing orientation.
- Moved that chair through its action panel, armed Copy, canceled with one Escape,
  and undid the two test edits. Search resumed with the original query intact.
- Placed a Bay without a configuration modal, generic coach or checklist. Undid
  the temporary Bay; the undo button returned to disabled.
- Checked the Rooms and Surfaces entry controls and cancellation, and the library
  at 390×844. Reset the viewport afterward.

Focused checks pass: `refit-flow-polish`, `refit-card-stack` (68), `kitout` (33),
`tutorial-connect-beat` (22), `refit-footprint`, `refit-junction-cards` (117),
`refit-run-gate` (23), `refit-testride-intake` (29), and `station-templates`.
The new behavioral test exercises the actual keyboard/tool functions and verifies
that suppressing generic coaching still records placement progress.

`npm run test:fast` again reported the existing planning-authority failures in
`qa-product-perfect-claims.test.js`: expected PASS, received BLOCKED, and missing
wave-verdict explanation. Stopped that owned test after recording the failures;
the runner exited 1. Log: `.dogfood/build-interactions/flow-polish-test-fast.log`.
No integration merge or full-green claim.
