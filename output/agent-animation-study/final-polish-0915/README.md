# Final motion polish — 2026-09-15

The station review retains the approved 19-world-pixel standing height and 28-unit crew cruise speed.

- Walking anchors the current frame's measured alpha boundary, rather than the standing frame's transparent padding. Across 2,400 available walking frames this removes up to two world pixels of unintended vertical drift without resizing the artwork.
- Approved sets estimate stride from additional side-view foot separation. Standing boot width is excluded; the previous universal ceiling no longer forces long-legged sets to cycle at the shortest cadence. Robes and ambiguous silhouettes retain the established fallback; original retained artwork keeps its previous cadence.
- Ground-gap telemetry now measures the actual drawn boundary, including device-pixel snapping. Review coverage resets when a body's skin changes.
- Cardinal-only walking artwork chooses the closest available facing to actual travel. The live sweep exposed a 72.4-degree mismatch on Pikachu; the corrected fallback is bounded to 45 degrees by 360 heading cases.

Run `node output/agent-animation-study/final-polish-0915/test-contact.cjs` for actual-PNG geometry and timing checks. `contact-validation.json` records each skin. `audit.cjs` produces per-skin contact sheets and coverage in `audit.json`; its currentCycle field records the pre-polish algorithm, not the new renderer.

Coverage: 34 redesigned skins each have 8 standing views, 64 walking frames, 4 sitting views, and 4 north-facing typing frames (2,720 selected frames). Four retained original skins use their existing artwork. They are not newly completed eight-direction sets: Pikachu has four walking directions; Heisenberg, Rick, Minion and Pikachu do not have typing tracks; Minion lacks a sitting track. The renderer uses correctly facing supported fallback poses. Prior generator refusals remain respected. Silver Cadet retains the previously reviewed wider seated stance.

This pass changes rendering and verification only; it does not claim to have generated new artwork or audio lip-sync. Live review and full test results are recorded separately.
