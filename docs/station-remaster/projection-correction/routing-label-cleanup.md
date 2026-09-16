# Work-bay annotation cleanup

Source change is limited to the routing-label sections of `frontend/app/world.js`. The existing `propsprites.js` bay nameplates were already bounded to their props and are unchanged.

At overview (fewer than 1.5 CSS pixels per station pixel), each visible room rectangle receives one count of its actual routing findings. Warning brackets remain on every affected prop. At normal zoom, findings on the same prop share one concise label. Both modes place text inside the intersection of the real room rectangle and visible canvas, with bounded collision placement. There is no upward stacking into space.

Clicking a warned prop selects its original full instructions, wrapped in a canvas-bounded phosphor tag. The selected tag stays at least 12 CSS pixels tall per glyph at low zoom. Existing bay assignment, intake sample and channel actions remain unchanged; REFIT remains the full-detail editing surface. Extreme authored descriptions explicitly point to REFIT when they exceed the available screen. Hover opens no new window. Selection clears on another click or floor recompile.

The compiler findings, server-confirmed feed state and severity are unchanged. Aggregation counts findings, including multiple findings on one prop; it does not imply a count of affected agents or rooms. Offscreen props do not float labels onto the viewport. Narrow spaces that cannot contain a tag retain warning brackets.

Validation: `node --check frontend/app/world.js`, `node test/routing-label-layout.test.js`, `node test/routing-nag-parity.test.js` (12 assertions), and `node test/bay-name-legibility.test.js`. The new regression checks aggregation, original detail preservation, pan/zoom/DPI, local/world origin translation, actual draw adapter, crowded bottom-right placement, no-data/offscreen/tiny-room cases, and unchanged click/feed seams.

The existing `node test/guidedline.test.js` also passes all 267 assertions. Parent owns the live before/after check at `http://127.0.0.1:18794/?propSet=projection&skinSet=study` and the combined full gate. This receipt does not claim that live verification has occurred.
