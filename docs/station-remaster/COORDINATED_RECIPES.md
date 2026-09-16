# Coordinated prop integration recipe

`dev/industrial-textures/integrate-coordinated-batch03.cjs` reads the actual batch03
exports and original source PNGs, checks their export receipts and hashes, and
builds a manifest patch. This helper owns the recipe only; it does not edit the
runtime renderer, simulation, source artwork, or coverage acceptance ledger.

The snapshot is `dev/industrial-textures/coordinated-batch03-recipes.json`.
It represents all 122 coordinator-owned catalog IDs, including explicitly missing
sources. The root's 18 equipment/communications/lab IDs, eight approved IDs and
twelve previous authored IDs are excluded. Repaints never add another catalog ID.

Commands, run from the integration owner's **isolated** worktree:

```powershell
# Refresh data and print eligible/pending views without changing the app.
node dev/industrial-textures/integrate-coordinated-batch03.cjs --write-recipe

# Write a separate reviewable patch; no application changes.
node dev/industrial-textures/integrate-coordinated-batch03.cjs --patch dev/.scratch-workspace/coordinated-prop-patch.json

# Apply supported views. Authored content5 is included: parent confirmed wiring.
node dev/industrial-textures/integrate-coordinated-batch03.cjs --apply

# Once the parent's new service renderer is wired, opt in to its thirteen views.
node dev/industrial-textures/integrate-coordinated-batch03.cjs --apply --enable-service

# A comma-separated subset can be reviewed/applied independently.
node dev/industrial-textures/integrate-coordinated-batch03.cjs --apply --ids stool,glasstable
```

`--from-recipe` reads the saved snapshot rather than rebuilding it. Source export
hashes are checked before any mutation either way. The script copies exact PNG
bytes and merges only eligible views; it preserves unrelated manifest entries,
alternate facings and currently integrated pending props. It never marks coverage
complete. The root updates that ledger after combined validation.

All geometry starts with the native structure manifest. The generated JSON keeps
the original source dimensions, export dimensions, source-to-export crop,
exported alpha bounds, native rectangle, uniform fit and world contact separately.
Utility exports often preserve the original canvas; using their full width for
the body fit would make them too small. `exportNormalized` guides refer to the PNG
canvas; `fitNormalized` guides subtract its remaining alpha padding and refer to
the fitted body. Runtime motion regions use the latter. Original source positions
and their documentary references remain available for recalibration.

Native facing semantics are r0 south, r1 west, r2 north, r3 east. `-r1` and `-r3`
files are independently authored views. An `_r` suffix is a distinct catalog ID.
No upright image is rotated to manufacture an alternate projection. Native flat
floor assets retain their existing quarter-turn renderer; only their south source
appears in the structure manifest.

Tables retain new support/near-edge polygons and their measured world height in
`mountSupport`, separately from the legacy generic eight-pixel rise. The near edge
does not establish a universal height for all projected contact points. Chairs,
booths and furniture keep independently measured support/occlusion guides where
the art lane supplied them. The root must wire those to actual mounted props and
cadets, then check the placements in the station.

New mug, radio, pool-table, bunk, vending and coffee annotations are tied to exact
export hashes. The helper inspected their corrected PNGs before choosing those
regions. A future source change invalidates the annotation instead of silently
reusing coordinates. The new bar has taps and a brass rail without its old light
strip; the new minifridge has an analog dial instead of the prior light aperture.
Both remain pending new motion. No old masks or painters are emitted by this recipe.

Five boards/archive props use the confirmed `content` mode and its actual state
contract. Thirteen service props remain opt-in until the parent lands the new
service renderer. Other animated bodies preserve their native triggers and new
region ledgers as pending work, not static substitutes. The exact current counts
come from the script output rather than this document.

Verification for this helper is script syntax, actual PNG/header/hash/receipt
mapping, direction and alpha-fit geometry checks, and a disposable application
fixture proving stale-source rejection, byte-preserving copies, no overwrite of
unrelated/pending views, and idempotence. This is not a live station or installed
build acceptance claim. Parent owns the combined test gate and real scale,
seating, layering, animation, reduced-motion and performance checks.
