# World seating and refit repair — 2026-09-10

Scope: the three world-view defects reproduced against 2aa8305c0. Source changes only; installed desktop recovery is unverified.

- Unreachable desks: hero and crew stand in place while real work remains active. Retry pathfinding at a bounded interval; refits clear the retry delay. Hero refits no longer teleport to a moved desk. Same-tile crew centring walks the fractional distance instead of treating an empty route as failure.
- Desk facing: crew arrival uses the derived desk facing. Sprite selection respects that direction, using a directional seated pose where the skin lacks matching typing art. A working body with no seat renders standing. Existing north-facing typing remains animated.
- Furniture refits: crew releases shared seat claims, render offsets and leisure references for removed/moved/rotated props or interrupted trips. Comparison uses world coordinates, preserving occupants of unchanged couches when the station origin shifts. Unrelated work state is preserved.

Regression coverage: test/world-seat-recovery.test.js executes production movement/refit helpers against real station geometry (23 assertions); test/world-immersion-characters.test.js executes the actual sprite renderer with native sprite masters (7 tests, including all cardinal work facings and standing workers). Existing path-smoothing tests pass 22 assertions.

Live evidence in this lane's .bugloops/world-audit directory:
- before.json: unreachable crew jumped 294.24 px, south-side desk rendered north, deleted couch retained a sitter.
- result.json: jump 0 px; crew faces its desk (blank.sit.south); deletion releases seating and deleted-prop references on the next update.
- regressions.json: all seven checks pass, including hero and crew recovery through a new hallway, normal couch seating, an unchanged couch across origin expansion, and moved-couch cleanup. Crew maximum recovery step 0.87 px. Hero retains the existing final chair centring adjustment. Opaque canvas readback [49,46,46,255]; browser exceptions and warnings empty.

The live harness serves the production files in the seeded app with temporary browser-only exports for deterministic updates and inspection. No production debug exports were added. The installed binary and the user's saved station were not tested or modified.

Final source candidate 707d28291: full fast gate 753/753 green, exit 0. Customer journeys 34/34 green. All 12 original hallway routes completed with zero wall crossings. All 288 work poses across 36 skins/four directions rendered with correct facing. Bed wakeup 70 assertions and the 19 related world/crew/sprite test steps passed. The first gate exposed a stale source manifest; a later attempt caught an exact source-sequence compatibility check in bed wakeup. Both were corrected before the successful full rerun; no tests were skipped.
