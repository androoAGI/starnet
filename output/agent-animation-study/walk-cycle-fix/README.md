# Walk-cycle fix (2026-09-17)

Replaces the MiniMax `animate_image` walk frames of the 34 redesigned `approved_*` skins with
skeleton-driven Pixellab `animate_character` cycles (template `walking-8-frames`). The MiniMax
tracks kept a static reference frame, so most characters took one step and then stood, or slid
with their legs together (62 of 288 tracks had a leg spread of 6px or less).

## Result

- 33 of 34 sets installed with an alternating 8-frame cycle in all 8 directions.
- `capybara` is NOT installed: both template runs re-invented grey hip gear and a maroon drape
  that the grey/red and palette scrubs cannot remove. Production keeps the previous frames until
  an ImageGen cleanup pass (same treatment its rotations got). See `capybara/walk.json`.
- The 4 retained-original skins (heisenberg, ricksanchez, pikachu, minion) are out of scope.

## Pipeline

1. Pick the Pixellab character that matches production art (`get_character`, compare east
   rotation colour to `rot_east.png`; cadet skins are the pixel-cadet family).
2. `animate_character` with `template_animation_id: walking-8-frames`, one call per direction,
   all 8 directions at once (10 concurrent job slots; one character at a time). Poll
   `https://api.pixellab.ai/mcp/characters/<id>/spritesheet` until it stops answering 423.
   Pixellab dedups template+direction: to regenerate a direction, `delete_animation` first.
3. Write `<set>/walk.json` (character id, animation ids + `?t=` tokens, optional `mirror`,
   `scrub`, `badFrames`), then `node pack-template-walk.cjs <set> [--force]`.
4. The packer scales the 96px Pixellab frame to the production 76px standing height, anchors it
   to the rotation bbox on the 144x144 canvas, runs the quality gates (identity, colour drift,
   silhouette area, facing flips), repairs bad frames from the opposite-phase frame, writes
   `<set>/contact.png` + `report.json`, and installs `frontend/assets/sprites/approved_<id>/
   walk_<dir>_1..8.png` plus the `agent-demo/approved-motion` copy.
5. `node repoint-manifests.cjs` — sets that predate the 1..8 layout (android, bear, blank_*,
   pepe, vaultboy) listed `walk_<dir>_0..7` / `_repair_` files in all THREE pointer files
   (`frontend/assets/sprites/manifest.json`, `frontend/agent-demo/manifest.json`, and the
   selected-refresh record `frontend/assets/skin-study-0914/runtime-motion.json`, which
   test/world-immersion-characters.test.js compares byte-for-byte to the manifest); the manifest
   is what the runtime loads, so the new frames were invisible until repointed. The old files were
   then deleted (`list-orphans.cjs` finds them; test/sprite-assets.test.js fails on any shipped PNG
   the manifest cannot reach). Pre-existing `approved-motion/<id>/walk_<dir>_0.png` demo files stay.
6. `npm run sync:website`, `node output/agent-animation-study/validate-catalog.cjs --final`,
   `node test/sprite-walk-motion.test.js`, `npm run test:fast`.

## Known weak spots

- Cadet family (blank_*, android, ultrondroid, robot): walk shading harsher than the standing art.
- ultrondroid, masterchief: the template slims chunky builds while walking.
- plaguedoctor, voidwizard: robes read as trousers in some frames.
- grimreaper: scythe blade missing on E/W; NW, W, SE are mirrors of the opposite-hand track.
- morpheus, vaultboy: second half of the south cycle is a mirror of the first.
- xenomorph NW, station_minion E, ghostface NE: mirrored from the opposite-hand track.
