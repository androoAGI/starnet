# Merge review — 2026-09-15

Owner explicitly requested review, required checks, and integration into trunk. This is source integration, not publication or an installer release.

## Reviewed candidate

Application source `2df00fd71`, source-lock candidate `d4f96ea7e`, based on trunk `545ddd30f746ec7132a7252afdf85942ace7df04`.

Reviewed the world geometry/physical-segment checks, build selection and saved-size rotation, prop anchoring and seating, lighting preparation/invalidation, texture loading/fallbacks, saved-layout migration, renderer depth integration, and bounded prop caches. Checked entrypoint ordering, mirrored website files, shared-contract and backend scope. No unresolved merge-blocking finding was identified in those reviewed paths. This is not a claim that every possible custom layout or hardware configuration is bug-free.

## Integration decisions

- Kept trunk's latest tactile base floor and revised material assets. The projection prop set and remastered shell/corner implementations remain intact.
- Retained trunk's newer material labels and suggested palettes alongside the doorway-clearance and saved-table migration changes.
- Refreshed the generated source lock after resolving the binary floor and lock-file conflicts.
- Removed a stale inherited status-line delta from this lane so merging does not touch trunk's existing uncommitted operational notes. Their bytes were backed up separately before integration.
- No changes relative to trunk in `sidecar/`, `shared/`, or `package.json`; no credential migration or external release action.

## Live review

Reloaded the synchronized source on port 18797: UPLINK ONLINE, LIVE feed, 17 rooms, 16 halls, 3068 tiles and 159 objects. In Refit, found the workbench through the placed-object selector and observed its 2×1 floor footprint at X=13, Y=2. Flip enabled Undo; Undo restored the original edit state (Undo disabled, Redo available). Prior live doorway, seating, cache and responsive receipts are retained in this directory.

## Scope retained

The projection prop pack and study skins remain preview-selectable. Saved agent assignments are not randomized. Installed-build smoke, release authority and extended hardware/soak coverage are release tasks, not represented as completed by this source merge. The final gate counts and integration SHA belong in the merge receipt.
