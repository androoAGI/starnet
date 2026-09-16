# East glass-table proportion correction

One new glasstable:e candidate, native footprint1x3, envelope{x:0,y:0,width:12,height:36}. Production PNG is `frontend/assets/industrial/catalog-glass-fix/glasstable-e.png`. The parent owns tabletop integration and live mounting checks.

The selected source's measured alpha>=180 body is443x1319: width/height0.3358605, or height/width2.97743. This is inside1/3 +/-0.025. The exported crop is449x1325. Uniform fitting gives12x35.41203 world pixels atx0,y0.66815; the opaque contact reachesy36, with0.08018px retained fringe below it. No bitmap stretching or rotation was used. Visible slab/frame occupies approximately84% of total height and exposed legs the remaining16%; the usable inner-glass rectangle is intentionally inset from corner fasteners and rails.

`integration.json` follows the prior utility schema and includes `surfaceSupport:{space:'export-normalized',points:[TL,TR,BR,BL]}`. These points were traced on the actual selected source and visually checked in `surface-proof.png`. They describe the conservative clear inner pane. `game-scale-proof.png` shows1x,2x and4x actual world size. The source's interior glass alpha is retained exactly, irrespective of opaque threshold; the cleanup never erases translucent pane pixels.

Rebuild with `node docs/station-remaster/catalog-glass-fix/export.cjs` from the repository root. The script asserts measured opaque aspect, crops/clears detached alpha haze outside a three-pixel body radius, preserves glass interior, verifies all RGB and retained RGBA against the original source, and emits receipts and proofs. All three mismatch counts are zero, including the glass interior specifically. Full source ROI/crop/hashes/contact are in integration.json.

Four built-in image-tool calls were measured rather than trusting requested canvas ratios:

1. `glass.prompt.txt` generated `attempt1-source.png`: opaque460x1765, ratio0.26062, rejected.
2. `widen.prompt.txt` edited it into `attempt2-source.png`: opaque772x1486, ratio0.51952, rejected.
3. `narrow.prompt.txt` edited it into `final-source.png` (historical filename, NOT selected): opaque488x1357, ratio0.35962, rejected as slightly outside tolerance.
4. `final-adjust.prompt.txt` edited that into `selected-source.png`: opaque443x1319, ratio0.33586, selected.

Initial geometry reference: `C:/Users/andro/gen-trees/industrial-textures-0912/dev/.scratch-workspace/prop-structure/glasstable-r3.png`. Material reference: parent `docs/station-remaster/catalog-tables/sheet-source.png`, glass second row. Both were actually inspected and supplied to the initial generation. Subsequent edits used the previous generated source as their target. All generated originals and exact prompts are preserved. No other cohort, runtime module, parent tree, main manifest or live save changed.
