# New tabletop mounting

The new drawings do not share the old fixed eight-pixel surface height. In a deep
east-facing table, a child on its back tile belongs on the back portion of the
projected tabletop. Applying the front edge height to every row makes the rear
objects float. An object's visible base can also end above its footprint bottom,
so physical row depth and rendered body contact are separate measurements.

Load `authored-surface-calibration.js`, then `authored-surface-mounts.js`. Root wiring:

```js
const surfaceMounts = AuthoredSurfaceMounts.create({
  viewGeometry: (type, view) => PropRemaster.viewGeometry(type, view),
  ruleFor: type => PropSprites.spec(type)
});
surfaceMounts.setLayout(geo.props); // on layout rederive; uses the same LOCAL tile frame

// Call only after worldmodel.mountOf confirms this is surface-mounted.
const placement = surfaceMounts.placementFor(f);
const lift = placement.lift;
// Or surfaceMounts.liftFor(f) when only the render lift is needed.
```

The geometry callback returns `null` for missing, classic, failed or unloaded
authored bodies. A valid response contains `{box,crop,spec}`: the fitted body box
in local world pixels, the measured exported alpha crop `{x,y,width,height}`, and
the loaded view spec with `image`, `sourceWidth`, `sourceHeight`, `footprint`.
An optional `surfaceSupport` array supplies four TL/TR/BR/BL corners normalized to
the **exported PNG canvas**; the structured form is
`{space:'export-normalized',points:[...]}`. Otherwise the exact image name,
dimensions and optional export hash must match the checked-in calibration.
The solver transforms that exported coordinate space through the actual alpha
crop and fit. It never derives body scale from the uncropped image dimensions.

Six current mount hosts have ten calibrated views: round table, side table,
low table, glass table, lounge table and long table. Glass/lounge/long supports
come from the crew lane's new per-view `authoredGeometry` receipts. Round/side/low
were inspected against their current exported PNGs; their annotations use clear
tabletop interior. The calibration preserves exact source-image hashes and native
boxes for proof. The diner table remains excluded because its catalog does not
permit surface mounting; this helper does not change placement rules.

For a child's physical row, `v = (child.y + child.h - host.y) / host.h`. Interpolate
the left and right side rails at that depth. Solve `u` from the child's actual
rendered base X on that cross-section, then interpolate its Y. This bilinear
projection preserves the child's X and uses its actual newly authored body base
when available. The lift is `unlifted body base Y - target tabletop Y`. Small
negative lifts are valid: a rear child sometimes needs to move down onto the new
surface. Only bounded valid geometry is accepted; other cases fall back to eight.

The host is the last native surface in the supplied layout that wholly contains
the child footprint, matching worldmodel's existing host selection. Saved host
fields are never trusted or written. User mirroring reflects the support around
the host's native width and composes with the existing authored projection. The
current table facing set is S/E; unsupported saved facings can use S only when
its actual loaded footprint agrees. Upright bitmaps are never rotated by this module.

There is a required sorting sibling change. A deep table's back-row child currently
sorts at its own row bottom plus 0.5, before the whole table, so the table can cover
it. For an authored placement, use `placement.sortY`: the native host bottom plus
0.5 and a small increasing child-depth term. This draws children after their host
and in back-to-front order without moving any collision or pathfinding rectangle.

Use the same lift everywhere the parent previously subtracted `SURFACE_RISE`:
body/base and foreground drawing, selection/outline bounds, hit/occlusion boxes,
emissive origins and any labels. Keep the current no-shadow rule for mounted
children. Leave worldmodel's `mountOf` as the authority: on a bare floor, the
caller still passes zero lift. `liftFor` intentionally defaults to eight for
caller-confirmed mounts whose host/pack is unavailable.

The module is pure except for transient `setLayout` snapshots, with no canvas
readback, clock, random state, DOM, persistent fields or event changes. The live
fixture at `/dev/authored-mount-fixture.html` reads source alpha once at load and
compares new support against the legacy fixed lift. Its labelled scenarios use
the real mug/caddy art in all table views; they do not modify a saved station.

`node test/authored-surface-mounts.test.js` passes 251 assertions over ten actual
calibrated source views and both mirror states, including contact equality,
depth, child body offsets, native host ordering, unchanged layout, stale image,
missing renderer, out-of-bounds, invalid crop and hostile oversized geometry.
`verify-authored-surface-mounts.cjs` creates an offline actual-source composite and
placement receipt. These checks do not establish live station or installed-build
acceptance. Root owns that final integration check and the combined gate.

The helper's seeded sidecar serves the fixture at
`http://127.0.0.1:8938/dev/authored-mount-fixture.html` (HTTP 200 verified). Its CUA
session exposed no browser surfaces, so UI clicks and live canvas inspection
remain unverified here. The offline proof sheet was inspected: legacy rear mugs
float above the glass table; authored rear/centre/front mugs sit on its glass
surface. Four before/after cases include twelve actual source-art placements.
