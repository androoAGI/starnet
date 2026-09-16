# Five capability props — visual refresh

Rebuilt the Build starter set with five individually generated transparent PNGs. The approved crate, workstation desk and chair were supplied as camera/material references. Prompts and source hashes are retained beside this report.

| Capability | Prop | Visible change |
| --- | --- | --- |
| Files | Intel Cabinet | Three large archive drawers, legible lock, olive panels and heavy feet |
| Web | Dish | Four broad bowl sections, thick mounting yokes and a grounded base |
| Terminal | Workbench | Wooden top, open knee space, strong legs, tools and diagnostic screen |
| Memory | Server Cart | Two blue removable modules, top display, push handle and casters |
| Images | Studio | Cream enclosure, large plum display, cartridges, lens and output slot |

The native build footprints and render envelopes are unchanged. Exports are uniformly fitted, without stretching. Cropping removes empty margins; retained RGBA pixels are identical to the image-generation sources. Original assets are preserved under `frontend/assets/industrial/capability-refresh/before/`.

Screen and status-light masks were remapped to the new art. The workbench display uses the existing work signal; result indicators still require actual results. No global brightness, capability routing or activity truth changed.

## Verification

- Live World on port 18796: all five normal placements and three supported mirrors; all eight character walks arrived, no footprint conflicts or asset failures. These props have no furniture seating/use planner, so the audit correctly reports interaction `none`.
- `live-checks.json` records the measured cases; `live-room.png` is a live screenshot. Close inspection also checked the new props under the existing CRT and lighting.
- Asset validation: 178 exports preserve source pixels, footprints and receipts; runtime alpha geometry: 184 views match source hashes.
- Effect validation: 88 overlays stay inside their masks, respond to active/idle state and freeze deterministically; 34 screen types pass light-origin and power checks.
- Full fast gate result is recorded after completion below.

This is a local visual candidate, not a claim of user art approval or station-wide release readiness. Original capability behavior is preserved; no external tool action was triggered merely to animate the art.

Preview: http://127.0.0.1:18796/?propSet=projection&skinSet=study&remasterAudit=1&capabilityReview=1

## Completed regression gate

`npm run test:fast`: **793 steps green**, exit 0. Runtime/art source commit: `935b5957b` (subsequent commits record screenshots only). Log: `dev/.scratch-workspace/capability-refresh-test-fast.log`.

## Normal furnished station

Run `node dev/launch-capability-default-station.mjs` to view the existing 33-region, 159-prop layout with all five refreshed capability props in the central observatory. The geometry is copied into a separate preview save; the original layout save is preserved. The WEB and MEMORY variants are replaced with the refreshed dish and server cart using their native footprints. All five placements pass the model's collision/floor checks.

URL: http://127.0.0.1:18797/?propSet=projection&skinSet=study
