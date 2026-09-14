# Authored machinery layer contract

`frontend/app/authored-prop-motion.js` is an optional, self-contained drawing module.
It has no legacy sprite callbacks, fetches, clocks, DOM dependencies, or body texture
ownership. The caller must supply the final newly authored **empty mechanism body**,
then draw these new moving parts over it. Do not register an image with a baked arm
or carriage still present: that would create two mechanisms.

Load it before the authored prop renderer. Register an ID (or `id:s` view key) once
when its final PNG has decoded:

```js
AuthoredPropMotion.register('fabricator', {
  kind: 'gantry', sourceWidth: exportWidth, sourceHeight: exportHeight,
  clip: authoredOpening, period: 2400,
  from: leftRailCenter, to: rightRailCenter, size: headBox,
  layer: 'carriage'
}, {carriage: newDecodedHeadImage});
```

Every point, clip polygon, and size refers to the **entire exported image** (0–1),
before runtime alpha-bound cropping. Widths use source width and heights use source
height. The carriage layer should have mechanically cropped transparent padding;
it fits uniformly into `size` and is never stretched.

`setup({resolveLayer(id, name) { ... }})` may supply a decoded image instead of the
optional registration map. It must be synchronous; the parent owns loading and
error handling. `ready(id)` remains false for a missing or undecoded carriage.

After painting the body, with the same facing/mirror transform still applied:

```js
AuthoredPropMotion.draw(ctx, id, {
  x: propX + entry.box.x, y: propY + entry.box.y,
  width: entry.box.width, height: entry.box.height,
  crop: entry.crop
}, state);
```

The `box` is the fitted alpha body in world pixels. Its crop has exported-image
pixel coordinates `{x,y,width,height}`. If the exporter already made a tight PNG,
the runtime crop can be omitted. The mapping subtracts its offset exactly once.
Nonuniform fitting and invalid bounds return false. Caller context state, clip,
opacity, and transform are preserved. The caller owns any glass or rail foreground
that must overlay a moving part after this draw.

Supported configurations all require `sourceWidth`, `sourceHeight`, `clip`, and
`period` (milliseconds):

| Kind | Additional geometry | New animation |
| --- | --- | --- |
| `gantry` | `from`, `to`, `size`, `layer` | Decoded authored carriage travels smoothly along its rail and returns. |
| `tube` | `from`, `to`, `size` | New capped metal capsule moves through only the clipped glass aperture. |
| `arm` | `shoulder`, `rest`, `pickup`, `place`, `upper`, `fore`, `thickness`, `joint`, `tool`, `bend` | New rigid links and joints pick/place with an opening pincer. |

For the arm, all five scalar dimensions use a fraction of **source width**; points
use normalized x/y as usual. `bend` is +1 or −1, selecting elbow side. Reachable
target positions must be measured from the final authored base. Unreachable targets
are clamped mechanically, never implemented by stretching the links. Optional
`palette` accepts six-digit hex `dark`, `edge`, `metal`, `light`, `accent` values.
The defaults are painted charcoal hardware, grey edges, and restrained brass.

Only `state.work === true` advances a mechanism. `still` or `reducedMotion` parks
every moving part, including the pincer. Missing, invalid, negative, or idle clocks
cannot imply work. The caller must provide per-instance real activity; animation
phase is decorative mechanics, never a progress fraction, fabricated output, or a
transport/job count. No package appears in the new packing arm's grasp by default.

`sample(id, box, state)` returns world-space carriage/capsule centers or arm joint
positions for deterministic geometry checks. It draws nothing. `validate`,
`register`, `unregister`, and `ready` let the parent integrate without changing its
manifest loader contract.

## Verification boundary

The focused test checks cropping, equal scale, complete work/idle/reduced-motion
cycles, fixed arm lengths, attachment, clipping order, image aspect, failure/context
restoration, and missing optional assets. Run:

```text
node --check frontend/app/authored-prop-motion.js
node test/authored-prop-motion.test.js
```

This module alone is **not** a completed prop remaster. Final artwork geometry,
runtime script wiring, actual activity delivery, native-scale review, and live app
proof belong to the integration lane. No shipped manifest entries are changed here.
