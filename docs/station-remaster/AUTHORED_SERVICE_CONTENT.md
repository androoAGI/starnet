# Authored service content integration

`frontend/app/authored-service-content.js` adds new painted content for thirteen
batch03 service and transport bodies. It reads only the caller's existing state;
it does not change prop documents, call the harness, modify source images, sample
old sprite pixels, or start a timer.

Load the script before the remaster module and call:

```js
AuthoredServiceContent.draw(g, id, {...e.box, crop:e.crop}, state);
AuthoredServiceContent.regions[id]; // frozen polygons normalized to export PNG
```

The fit and crop contract is identical to `AuthoredPropContent`: `box` has finite
`x,y,width,height` in the current drawing context; optional `crop` is a measured
alpha trim in exported-image pixels. The source exporter crop has already been
subtracted from every stored coordinate. Do not subtract it again. Utility
exports preserve the full original canvas, so their runtime alpha crop matters.
The caller retains world translation, mirror, mount lift, clipping and opacity.
Unsupported IDs or invalid geometry return false; valid IDs return true even
when their truthful state paints no marks. Painter errors propagate after the
context is restored, allowing the existing caller fallback.

Compose the authored body and its content into one reusable plane at full
opacity; apply world opacity once on the final blit. **The airlock iris uses
`destination-over` on that body plane.** Its leaves extend under the opaque ring
and hardware, which mask them without another bitmap or runtime readback. The
plane must contain only this prop, not the station background. All other marks
use `source-over`. The module restores the caller's composite, transform, alpha,
shadow and clip. It never assigns `globalAlpha`.

## Coverage and native state

| ID | Native fields | Authored content |
| --- | --- | --- |
| outbox | `crates`, `work` | Up to five real uncollected-run crates, exact remaining count; empty conveyor edge motion only while working |
| connector_portal | `bound`, `state`, numeric `fired` | Bound couplers, UNBOUND/OFFLINE/LINKING/ONLINE/ERROR plate, actual online call pulse |
| jukebox | `live` | Steady connected lamp tubes and LINK plate; stationary source record |
| airlock | `door` | Open retracted iris, fully closed iris, distinct partly jammed iris and cosmetic jam spark |
| pub_publishpress | `work`, `scanning` | Pressure shoe within the new throat and RUN/SCAN lamp panel; empty output tray |
| pub_outboundchute | `work`, `scanning` | Fixed glass-edge illumination and hopper lip reflection; no capsule |
| pub_mailpod | `work`, `scanning` | Powered indicator lenses; both bays remain vacant |
| intake | `work`, `scanning` | Front feed-cylinder catch and status lens; empty hopper and output |
| bay | `agentId`, `dockName`, `work`, `scanning` | Live bound name on new gantry screen and roller catches; empty berth |
| merger | `work`, `scanning` | Catches rotating on fixed source cylinders; no transported or combined jobs |
| splitter | `work`, `scanning` | Fixed end-cylinder catches; neutral deflector, no invented selected branch |
| joiner | `work`, `scanning` | Cylinder catches; neutral stop sockets and no invented held items |
| loop | `work`, `scanning` | Cylinder catches; no invented pass count, tally lamps or BACK/DONE selection |

The native state projection lives in `PropSprites.draw`: it constructs `o.work`,
`o.agentId`, `o.dockName`, `o.door`, `o.scanning` and `o.still`, then supplies the
outbox count, connector poll status/call decay and Spotify connection boolean.
`now` is the caller's millisecond frame clock. `still:true` freezes every
time-dependent mark; door geometry always follows the supplied state. There is
no timer-driven door transition. Missing/invalid door values retain the native
open default. A connection never claims music is playing. A fixed three-coupler
portal is hardware anatomy, not three tools; `toolCount` is not inferred.

Outbox count accepts only finite, nonnegative numeric values. It floors fractions
and caps at `Number.MAX_SAFE_INTEGER`. Rendering stays bounded regardless of the
count. The distinct shipped pallet already painted by world remains world-owned;
do not conflate it with `crates` (uncollected ReturnStore runs).

Bay name input is live, capped at 64 characters and stripped of control codes.
No placeholder identity is invented when the name is missing. The existing
world bay-name pass remains responsible for station-scale readability.

No capsule ID, branch choice, barrier state, pass count or loop cap is currently
supplied by native `o`. Those semantics are **pending real state plumbing**, not
simulated by this module. Work/scanning can only energize empty machinery. The
pressure shoe is a new small mechanism inside the blank throat; the source's
parked platen is preserved. No source-image motion or baked sheet is reused.

## Measured geometry

Storage/control coordinates were derived from the export polygons in
`batch03/storage/publication-anchors.json`, `batch03/storage/media-anchors.json`
and `batch03/control/anchors.json`. Transport starts from
`batch03/utility/transport-content-regions.json`; cylinder and nameplate regions
were refined against the actual exported PNGs to avoid the rails, divider
islands, stop sockets and empty cargo surfaces. These are source pixels, never
old native-painter coordinates.

| Export | PNG dimensions | Exporter crop origin | Refined working area in exported pixels |
| --- | --- | --- | --- |
| storage/outbox | 1095 × 1139 | 60,76 | Mouth 315,104–772,429; cargo 360,549 / 725,549 / 745,929 / 338,929 |
| storage/connector_portal | 602 × 1622 | 159,29 | Status 168,220–377,289; three socket interiors from publication anchors |
| storage/jukebox | 783 × 1395 | 121,30 | Status 296,626–486,668; side tubes 53,394–94,591 and 682,394–726,591 |
| control/airlock | 1176 × 1132 | 39,39 | Iris ellipse center 588,565; radii 358,359, under original opaque frame |
| storage/pub_publishpress | 1160 × 1204 | 27,41 | Throat 391,615–767,655; original empty output tray reserved |
| storage/pub_outboundchute | 743 × 1593 | 112,57 | Glass 279,570–397,1223; illumination at fixed side edges |
| storage/pub_mailpod | 1430 × 976 | 30,24 | Lamp interiors 404,366–424,386 and 1004,366–1024,386 |
| utility/intake | 1298 × 1212 | 0,0 | Front cylinder 394,733–603,798; screen 846,830–913,873 |
| utility/bay | 1232 × 1277 | 0,0 | Screen 379,121–855,181; west/east cylinders only |
| utility/merger | 1512 × 1040 | 0,0 | Upper/lower inlet and east output cylinders |
| utility/splitter | 1464 × 1075 | 0,0 | Outer end cylinders only; no deflector motion |
| utility/joiner | 1511 × 1041 | 0,0 | Two inlet and one output cylinder region; stops untouched |
| utility/loop | 1145 × 1374 | 0,0 | Inlet and both outlet cylinders; tower untouched |

Full polygon measurements are exposed as `regions` for fixture/integration QA.
The source union was imported from coordinator `f320356c3` via lane merge
`4d38dbea8`. No source or manifest changes are included in this layer commit.
Utility alpha crops from export receipts are intake `(17,13,1265,1180)`, bay
`(3,27,1226,1200)`, merger `(26,31,1460,929)`, splitter `(24,16,1417,1027)`, joiner
`(30,59,1451,911)`, loop `(12,8,1120,1334)`.

## Verification and limits

`node test/authored-service-content.test.js`: **186 assertions passed**. The
focused checks cover native meanings, bounded counts, idle emptiness, no inferred
playback/route/tallies, frozen motion, context restoration, crop mapping, source
dimensions and absence of bitmap readbacks/old callbacks. JS syntax checks pass.

The owned dev page `/dev/authored-service-fixture.html` loads all thirteen actual
exports, renders labeled idle/active/jammed inputs and offers reduced motion,
35% grouped opacity and family selection. Its explicit **Run pixel checks**
button executes browser-only raster checks including iris center state, outer
frame occlusion, empty publication bays, empty loop/join semantics and opacity.
Readback exists only in this on-demand QA helper, never in the product module or
animation loop.

Browser proof is pending coordinator execution: the child's prior browser was
unavailable and `cua.listBrowsers()` returned `[]` on this task. No live proof or
pixel-check pass is claimed here. The source exports were visually inspected;
their transparent corner/airlock-center alpha was independently checked. Root
owns main-runtime wiring, station-scale validation, source-sensitive combined
gate and website mirroring. No full gate was run for this bounded task.
