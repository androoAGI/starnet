# Animated skin integration — 2026-09-15

Preview: http://127.0.0.1:18797/?propSet=projection&skinSet=study

Imported the completed `agent-demo/catalog.json`, referenced frames, and motion renderer from the `sprite-reimagine-0914` lane at `bcba24697`. This is a frozen import, not a link to that lane's ongoing output directory. No other lane was modified and no integration merge was performed.

- 34 remastered skins, all with cardinal standing, walking, sitting and north-facing typing tracks.
- Four intentionally retained originals: Heisenberg, Rick, Minion and Pikachu.
- 3,099 referenced PNG files checked, including byte parity with the website mirror.
- Opt-in study selection now chooses complete animation sets instead of forcing a standing image over every activity. Remastered bodies use the authoring lane's 19-world-pixel height and its grounded walk-frame/stride corrections.
- Rotated booths use vertical cushion slots, the proper side-facing pose, and body/booth overlap. Manual review holds the real seated state for 60 seconds.

`animated-skin-cycles.json`: 42 real walk-to-seat/bed, settle, release and walk-away cycles, zero reported failures, using the remastered Silver Cadet. These cover all supported seating orientations and mirrors, not every skin/furniture combination. `animated-booth-west.png` shows the authored west-facing seated sprite in the side booth. Temporary render-pose diagnostics visible in that screenshot were removed after inspection.

`catalog-interactions.json`: previous 382 orientation/mirror interaction checks. These exercise controlled arrivals, not full walks for every non-seat prop. `live-cycles.json` predates the final side-booth overlap change. Any older screenshot without a visible seated body is not evidence of seated alignment.

The default station was reloaded and visually checked with the new mixed crew and skin picker. Its saved roster and station layout were not changed. This remains a local opt-in preview, not a release or an installer verification.

`animated-room-performance.json`: an eight-second sample of the nine-prop seating fixture at 1031×912, DPR 1, scale 1.853. Render callback p95 was 1 ms, frame interval p95 8.4 ms, with zero render faults. This is not a whole-catalog or large-station performance claim.

The integration keeps legacy lighting geometry intact. Regression contracts were updated for complete animation tracks, vertical booth cushions, and post-separation gait measurement; no failed checks were skipped.

Final uninterrupted `npm run test:fast`: **793/793 steps green**, tested HEAD `708cb4f63758e68bcd7c6d0596ae764d1f6ff7f9`. See `verification.json` for the log SHA-256. The standalone import check also passed for all 3,099 referenced frames.
