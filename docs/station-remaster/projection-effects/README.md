# Projection-specific effects handoff

Implementation: frontend/app/projection-prop-effects.js. Review base: 34539ddd3. It classifies all 160 catalog types and 184 supplied views explicitly: 88 types have local effects, 72 have no added effect. Desks keep their accepted existing screen/occupancy implementation; rear and alternate furniture views remain still. coverage.json records every image hash, dimensions, classification, polygons, source/native evidence and effect frame bounds. The demo-membership field is the audited 144-instance snapshot, not a claim about later parent layout edits.

No manifest, contact, surface, source artwork or shared renderer is changed by this module. No network or pixel readback occurs in draw. Fish, wax and specimen movement uses a <=256px source cache built once; other effects use local clipped geometry. Discrete process lights are gated by actual work, belt scanning, connection or result state. Decorative water, steam, lamp and plasma motion does not imply tool activity. It adds no progress values, finance values, packets or music playback claims. Counted pins/trophies only appear for actual supplied counts. A missing count stays empty.

## Exact integration seam (parent-owned files)

Load projection-prop-effects.js before propremaster.js. Keep it conditional at use time to the projection pack; this module must never run against an older same-ID source. `matches(id, view, spec)` checks image name and dimensions, and fails closed. Pass the actual view key, never default an unsupported facing to south in this module.

In PropRemaster.prepare, once im dimensions have been verified and before source is released:

```js
const view = key.split(':')[1];
const projectionHandled = projectionReview &&
  typeof ProjectionPropEffects !== 'undefined' &&
  ProjectionPropEffects.matches(id, view, v);
const projection = projectionHandled
  ? ProjectionPropEffects.prepare(id, view, im, v) : null;
```

Keep `projectionHandled` and `projection` on the entry. For a handled projection, bypass `authoredScreen`, `authoredIndicators`, legacy approved-sheet effects and legacy local motion. This is essential: the old masks use all cyan or saturated pixels and can hit painted casing, paper, liquid and trim. `screenPower` must not trigger the old whole-image mask for these handled views. For all other entries, keep existing behavior. There is no change for accepted compact desks or the chair/crate anchors.

After drawing the entry body, with globalAlpha restored to baseAlpha and source-over composition, call:

```js
if (e.projectionHandled) ProjectionPropEffects.draw(ctx,id,view,{
  x:x+e.box.x, y:y+e.box.y,
  width:e.box.width, height:e.box.height,
  crop:e.crop, sourceWidth:v.sourceWidth, sourceHeight:v.sourceHeight
}, state || {}, e.projection);
```

`e.box` is the already fitted measured-alpha rectangle, not v.bounds. Draw converts full-export normalized polygons through the crop offset exactly once. Keep the context's existing mirror/rotation transform; do not transform the effect data separately. The parent should continue `approvedState` real labels; its broad indicators are absent because the handled entry has none.

Two ambient effects extend beyond the PNG: steamvent and treasury_pnl_holo. Include `frameBounds(id,view)` in culling/cache frame using the same conversion:

```js
const r=ProjectionPropEffects.frameBounds(id,view);
const px=u=>box.x+(u*v.sourceWidth-crop.x)/crop.width*box.width;
const py=u=>box.y+(u*v.sourceHeight-crop.y)/crop.height*box.height;
// Include (px(r.x),py(r.y)) and (px(r.x+r.width),py(r.y+r.height)).
```

These bounds are visual only; never replace floor contact, hit testing, native footprint or mounting with them. Free prepared source caches with `dispose(entry.projection)` on entry retirement.

## State forwarding and truthful limits

propsprites.js:11296 supplies work, occupied, scanning, still, heat/prog; connector state at11299–11305; workbench fired/bad at11307; jukebox live at11309; counts at11310–11312. `fired` must be numeric decay amplitude0..1, never a timestamp/boolean. The current generic capability result at11368 is computed after the painter and does not reach the remaster state. To enable local generic result marks, add before view.fn:

```js
if (f.t !== 'workbench' && f.t !== 'connector_portal') {
  o.fired = propFired(f.id);
  o.bad = !!(o.fired && propPulse[f.id] && propPulse[f.id].bad);
}
```

Do not infer work from result flashes. A denied result may be red while no mechanism operates. Jukebox connection enables its screen only; the module does not pretend connection means a song is playing. `still:true` freezes decorative time at zero but preserves occupied, closed/jammed, work, count and result differences.

Airlock currently changes only the central eye for closed/jammed; articulated iris displacement is not implemented. Publishing/packing/conveyor machines use local state indicators/scans/heat, without fabricated moving products or guessed platen cycles. Native whole-body result/heat overlays outside PropRemaster remain the parent's separate integration decision; this file does not silently remove them. Hologram emitter projects abstract light only, never simulated finance data. Quiet playfields and vending/gacha mechanisms have no per-instance game/purchase state to justify fake shots or dispensing.

## Verification

Run `node test/projection-prop-effects.test.js` for full coverage/hash/source binding, gate distinctions, negative/unknown inputs, crop conversion, context restoration, still time and bounded cache regressions. `node dev/industrial-textures/projection-effects-proof.cjs` generates source/region review pages, and `node dev/industrial-textures/build-projection-effects.cjs` regenerates only explicit bindings/coverage after source review. Parent live verification is required: idle/active/filter parcel/connector offline/error/jukebox disconnected/result failure/still and mounted source positions in rooms. No live-integration success is claimed here.
