# Approved sheet production pass

**Superseded by owner visual rejection on 2026-09-14.** The deployment below passed mechanical rendering checks but failed in-station orientation, proportions and convincing physical integration. Only crate, workstation desk and chair were accepted. Do not treat this historical delivery record as current visual approval. Corrective work is tracked in `../projection-correction/`.

The owner's approved 160-cell master remains unchanged at `frontend/assets/industrial/complete-sheet/starnet-props-full-sheet.png` (SHA256 `e68ef0d3711e9164a3aff5333b98522ed6fdcb4bc7654929e333cb2ff2b97ea9`). This set now supplies the default local station renderer.

## Delivered

- 160 catalog props and 184 authored PNG views; native orientation and collision footprints preserved.
- 151 primary sprites preserve the master's actual pixels. Nine targeted repairs fix floor vents/trays, stackable tables, service receptacles, a recliner and walk-over projections. The 24 facing exports include two targeted replacements. Sources, exact prompts and extraction receipts are retained in the sibling `crew` and `storage` folders.
- Source RGB and retained alpha are unchanged. Packaging removes detached translucent haze, isolates cells and tight crops. No body painting, recoloring, stretching or photoreal regeneration of the catalog.
- Uniform display fits use the approved silhouettes. Seat height caps are calibrated against the station cadet; the couch retains cushions and a readable back. Tables have ten hash-bound surface mappings across six native hosts. The running station and builder consume these mappings without changing saved layout records.
- The internal operator chair uses the same chair artwork. Desk side/back assemblies containing a chair do not receive another automatic chair.
- Screens follow occupancy/connection state. Source-based utility effects retain the new bodies; real result/count signals remain live. This is an artwork pass, not a claim of new simulation capabilities. Translucent steam/plasma shapes remain fixed with restrained illumination.

## Local test

The seeded server was started from this worktree on **http://127.0.0.1:18793/** with `node dev/seed.js --keep`. Its prop gallery is `/prop-atlas.html`; `/approved-prop-check.html` runs the complete browser render verification. The gallery uses a fixed two display pixels per world pixel and includes crew/crate scale references, facing, animation and placement controls. This server is separate from the original port 18792.

No provider credentials were copied into this new preview workspace. The visual station is usable; running provider-backed agent jobs requires the normal provider setup.

## Verification

- Browser: 160 props, 184/184 loaded views, all 208 native rotations rendered, deterministic still frames, ten table mappings resolved, no rendering failures. Live station loaded online without browser console errors. Visually inspected couch/crew scale, wooden table contact, bookshelf, coffee, desk and aquarium.
- `node test/approved-sheet-assets.test.js`: 2,505,451 retained pixels compare exactly to their generating source RGBA; all exported hashes, source dimensions, native footprints and uniform aspect ratios pass.
- Eleven focused fast-gate suites pass, including rotations, anchors, mounts, seat recovery, industrial art, screen state and the remaster contract (699 assertions).
- `node test/authored-surface-mounts.test.js` and `node dev/industrial-textures/approved-sheet-effects.test.cjs` pass.
- Full `npm run test:fast` was attempted. An initial dependency visibility mismatch was corrected by using the existing shared node_modules junction. The later run failed in `qa-product-perfect-claims.test.js`: its release-surface lock rejects the changed frontend. That already-failing step was stopped; the full suite is **not green**. No release authority records were rewritten and no trunk merge was performed. Concurrent intermediate commits also caused a HEAD consistency assertion in that attempt; do not treat that log as a final-commit release receipt.

## Rebuild the packaged set

Run in order from this worktree with Node and `sharp` available:

```text
node dev/industrial-textures/extract-approved-sheet.cjs
node dev/industrial-textures/extract-approved-facings.cjs
node dev/industrial-textures/extract-approved-repairs.cjs
node dev/industrial-textures/build-approved-manifest.cjs
node test/approved-sheet-assets.test.js
```

The repair extraction intentionally replaces nine initial cells. Run it after primary extraction. Surface mappings are bound to exact output hashes; changing a source requires reinspection before updating those mappings. These assets are ready for the owner's local visual test, not a release or trunk-merge approval.
