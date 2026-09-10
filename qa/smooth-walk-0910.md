# Agent skin movement frames — 2026-09-10

The 36 selectable skins now have 2,304 walk frames across 284 directions, up from
1,704 (+600). Each direction has eight poses; Robot has twelve. Walking still
spends distance on a complete stride. Pivot playback now scales with pose count
so the added frames preserve the previous angular cadence.

## Live evidence

`node dev/smooth-walk-live.mjs` passed all 36 skins in a running seeded sidecar.
It loads each skin through `SPRITES.ensureSkin`, samples `SPRITES.drawBody` across
travel and a complete pivot cycle, and checks the resulting canvas pixels.

- 284 directions rendered their additional distinct poses.
- 284 pivot cycles returned to their initial pose.
- Maximum floor-height spread: 0 pixels.
- Walk/idle height ratios: 0.912–1.111.
- Runtime exceptions: 0.

The local detailed receipt is `.worldshots/smooth-walk/live/receipt.json`.
Contact sheets were reviewed against the original baseline before installation.
The overview GIF is an enlarged artwork preview; the live check uses the actual
production renderer and its smooth downscaling.

## Source and reproduction

`dev/smooth-walk-sources.json` records the PixelLab character and animation groups,
selected frame indices, directional repairs, baseline commit, and color variants.
Four rear-view repairs use the shipped rotation as both custom keyframes. The
Cadet keeps its faceless head; its four colors use the verified original palette
maps. The known Void Wizard northwest pole artifact is removed on import.

With Python and Pillow installed:

1. `python dev/smooth_walk_batch.py <skin>` downloads and stages a contact sheet.
   Use `--cached` to inspect an existing export without another download.
2. Review the staged comparison, then run
   `python dev/smooth_walk_import.py .worldshots/smooth-walk/<skin>.json --install`.
3. After installing `blank`, run `python dev/smooth_walk_variants.py`.
4. Run `node scripts/sync-website-app.mjs` and `node dev/smooth-walk-live.mjs`.

Only walking frames and their playback cadence change. This receipt covers the
skin animation lane, not overall product release readiness or a published build.

## Follow-up frame sweep

The full 4,195-frame audit found two visual defects that size checks cannot detect: Turtle north-facing orientation and Wizard northwest staff continuity. These two cycles now use reviewed built-in imagegen sheets. After bulk regeneration, run `python dev/import_frame_sweep.py --install` to retain them. Source art and prompt specifications: dev/frame-sweep-sources/README.md.
