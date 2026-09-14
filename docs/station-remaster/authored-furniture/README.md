# Authored furniture mechanics and contact audit

This handoff owns only new furniture motion/configuration modules, isolated review
pages, tests, and evidence. It does not change the shared world, prop renderer,
manifest, seat claims, or mounting pipeline.

## Heavy bag integration

Load `authored-furniture-config.js` before `authored-furniture-motion.js`.
`AuthoredFurnitureConfig.byId` has `punchbag` and `punchbag_r`. Each is calibrated
to its separate newly authored PNG; neither is made by mirroring the other.

```js
const spec = AuthoredFurnitureConfig.byId[id];
AuthoredFurnitureMotion.prepare(id, decodedImage, canvasFactory);
// In the renderer's whole-body plane, after clearing it:
AuthoredFurnitureMotion.draw(ctx, id, {...entry.box, crop: entry.crop}, state);
```

`prepare` returns false for missing/wrong-sized artwork, invalid configuration,
unavailable canvas, or an empty moving layer. Node callers can pass the explicit
spec as its fourth argument. The source PNG is read once. Pixel centers inside
the authored hanging-section polygon move; every other original RGBA pixel belongs
to the fixed body. A narrow chain polygon improves on the source handoff's broad
rectangle so the cantilever face does not move. No RGB is recoloured or synthesized.

Only small cached canvases survive preparation: original body, fixed support, and
hanging chain/bag, at 4 pixels per native world pixel. Both props together retain
24,480 cached pixels. `draw` performs **no source readback or canvas allocation**.
It replaces the complete prop body; do not draw the original body underneath it,
which would leave a second stationary bag. Caller opacity and facing transforms
apply to the result, and context state is restored.

The original bag was an ambient decoration (`animated:true`, three idle/work
frames, `respondsToWorkFlag:false`). Its new neutral-to-neutral cycle is 5,800ms,
with ±0.042-radian ambient sway and ±0.105-radian sway when `work === true`.
`still` or `reducedMotion` returns the cached neutral key art exactly. Motion does
not assert that an agent punched the bag or completed a job. The pivot is fixed;
chain, straps, and leather move as one physical hanging object.

`bounds(id, box)` returns the full swept image envelope. Include it in root's
whole-body cache. Each specification also provides the conservative native frame
`{x:-2.5,y:-8,width:17,height:30}`; physical footprint remains 1×2. Without this
horizontal overscan the outward half of the swing gets clipped at the image edge.

The bench-press pair remains static. Both catalog records say `animated:false`;
neither native painter reads time/work, and the authoring receipts report one
static frame. Adding lifting bars would invent a new behavior, not preserve an
existing animation. Their new art is shown beside the cadet in the proof sheet.

## Verified here

- `node --check` passed for the new modules and review script.
- `node test/authored-furniture-motion.test.js`: **529 assertions passed**.
- `node dev/industrial-textures/verify-authored-furniture.cjs`: both final PNGs
  change under motion, measured support/base pixels remain unchanged, and reduced
  motion is pixel-identical to neutral. Each prop draws 240 frames with zero
  additional source reads or canvas allocations.
- [Motion receipt](motion-receipt.json) binds image hashes and geometry.
- [Native fitness sheet](native-fitness-motion.png) uses the actual public
  `SPRITES.drawBody` with `station_minion` scale0.385, at 4 display pixels per world
  pixel. It was visually inspected. Bags remain readable and their support height
  is proportionate to this cadet; no enlargement is recommended from this proof.

The seeded sidecar serves `/dev/authored-furniture-review.html` on port18816 and
the route returned HTTP200. The worker's CUA surface inventory is empty, so root
must perform the live browser observation. The full gate belongs to the combined
integration candidate. Offline raster proof is not a claim of live world behavior.

## Seat corrections for the integration owner

[The seat audit](native-seat-audit.png) draws real cadets using inherited anchor
values, with newly authored foreground masks where the source supplies them.
[Its measurements](seat-audit.json) retain all source-to-world polygon conversions.
These are body/contact observations, not a patch to the seat planner.

1. **Turned booth slots are wrong.** `planCouchSit` derives slots only from width.
   The 1×2 r1/r3 booth therefore offers one seat despite two authored cushions.
   Allocate two claims along its long y-axis. The current front foot anchor is
   `(6,22)`. Preserving that observed front-seat contact and subtracting the
   measured cushion spacing gives rear-foot candidates **r1 `(6,14.199)`** and
   **r3 `(6,13.677)`**, still with zero lift and west/east facing respectively.
   Those rear candidates require a two-sitter live check before acceptance.
   Source near cushion edges are r1 y7.731/15.532 and r3 y6.977/15.300; do not use
   the same y22 anchor twice or place the second body 12px away without measuring.
   Keep body claims distinct and sort the rear sitter before the nearer sitter.
2. **Foreground artwork must follow the authored view.** `drawSeatFront` currently
   has no dinerchair/podchair branch, and the world guard `!p.r` omits every turned
   seat. Use the final art's per-view near-rim/near-arm regions. The south diner
   chair lip can be isolated by normalized polygon
   `[[.064,.619],[.93,.619],[.94,.670],[.05,.670]]`, world y5.904–6.720. Podchair's
   existing `nearRimOcclusion` is world y6.245–8.517. Redraw only this new artwork
   after the sitter, without invoking old painters.
3. **Keep the tested recliner body anchors initially.** `(4,10,lift2)` west and
   `(8,10,lift2)` east look reasonable beside the newly measured near-arm masks.
   Replace the old `RECLINER_FRONT_Y=3` rectangle/native painter with the new
   polygon: arm crown starts y4.739 west and y4.696 east. A blanket seat lift or
   scale increase is not supported by this comparison. Dinerchair/podchair use
   zero inherited lift; their absent overlay does not by itself prove lift is
   wrong, so verify the new foreground before changing their vertical anchors.

## Table mount contact corrections

The root mounting pipeline should use the actual table support plane. For a child
contact on the **near support edge**, the required rise is `footprintBottom -
edgeY`, measured in world pixels. These replace a blanket rise8 only for that
contact line; contacts deeper on a tabletop must interpolate its support polygon.

| View | Near edge y | Near-edge rise | Change from rise8 |
| --- | ---: | ---: | ---: |
| glasstable south | 5.1476 | 6.8524 | −1.1476 |
| glasstable east | 27.9892 | 8.0108 | +0.0108 |
| dinertable south | 13.4832 | 10.5168 | +2.5168 |
| dinertable east | 22.7550 | 13.2450 | +5.2450 |
| loungetable south | 6.3861 | 5.6139 | −2.3861 |
| loungetable east | 16.9873 | 7.0127 | −0.9873 |
| longtable south | 3.2365 | 8.7635 | +0.7635 |
| longtable east | 24.7945 | 11.2055 | +3.2055 |

These are conversions of the new painted support annotations, not permission to
stretch the tables or to apply the near-edge height to every point on the surface.
