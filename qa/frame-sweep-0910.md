# Full frame sweep — 2026-09-10

Audited 4,195 PNG frames across 941 tracks and 38 shipped sets (36 selectable skins plus two legacy sets). No missing/orphaned/empty frames, canvas-edge clipping or greater-than-30-percent within-track height outliers were found. Reviewed all 13 contact sheets.

Visual review caught two defects: Turtle north walk faces forward, and Wizard northwest staff disappears or extends above the hat. Regenerated those two eight-frame tracks with image_gen against their existing rotation references; reviewed and imported all 16 replacement frames. Source sheets and prompt specifications are in dev/frame-sweep-sources.

All 36 selectable skins passed the live drawBody sweep across 284 directions. Both corrected skins were rechecked after installation: all 16 directions passed pose-count, closed-pivot, walk/idle scale and foot-baseline checks. The design regression fails 16 assertions against the original frames and passes all 56 on the repaired frames. Sprite assets, walk motion, detached props and website mirror tests pass. Full gate and merge receipt are recorded in qa/STATUS.md.

This is a targeted frame review, not a guarantee against every possible visual defect. Local raw evidence: .worldshots/frame-sweep-0910, frame-sweep-live.log and frame-repairs-live.log.
