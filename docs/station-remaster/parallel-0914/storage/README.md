# Storage artwork handoff — 2026-09-14

Two new original designs: `bookshelf` and `boxes`, each south-facing on a 2 × 1 tile footprint. One tile = 12 world pixels. The storage lane does not own drawerbank or supplycart.

**Not runtime-ready:** built-in image_gen generated RGB PNGs containing painted checkerboards, despite explicit transparent-background requests. A bookshelf extraction edit also returned RGB. Sources remain intact. No scripted alpha removal was performed. The owner must extract, inspect edge quality and contact, then approve or regenerate before integrating.

The final candidate images are `frontend/assets/industrial/parallel-0914/storage/bookshelf.png` and `boxes.png`. Their sibling `manifest.json` is a handoff ledger using `candidates`, deliberately not an active runtime `props` manifest. It records source sizes, exact alpha counts, world envelopes, anchor proposals and hole notes.

`prompts.json` preserves every prompt, exact supplied reference path and original output path. `bookshelf-alpha-attempt.png` preserves the unsuccessful extraction result; the first bookshelf design was retained because the extraction attempt increased wear.

Native inspection verified coherent dark industrial materials and complete new silhouettes. The bookshelf has two open rows of manuals and binders; boxes uses three closely packed cases with distinct hardware. `game-scale-qa.png` uniformly fits untouched source images into their world envelopes, downscales for inspection, then magnifies 7×. It proves the checkerboard problem and demonstrates the shelf rows / asymmetric box cluster at that scale. It is QA only, not an alternate source or a live station capture.

Bookshelf envelope: x=-1, y=-9, width=26, height=22; bottom contact y=13. Boxes: x=0, y=-1, width=24, height=13; bottom contact y=12. Both center at x=12. Actual contact alignment after alpha extraction still requires owner review. Use uniform fit and bottom-center alignment, never nonuniform stretching or rotated elevated bitmaps. Shelf leisure remains standing south approach. Boxes retain optional 8-world-pixel table lift. Both artwork layers are static with no authored status or animation.

No runtime, shared files, props-v3 files, website mirrors or other worktrees changed. No live integration or user acceptance claimed. Parent/owner owns integration and its test:fast gate.
