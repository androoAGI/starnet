# Projection and study-skin polish, items 2–7

Demo: <http://127.0.0.1:18794/?propSet=projection&skinSet=study>
Catalog: <http://127.0.0.1:18794/prop-catalog-review.html?propSet=projection>

## Delivered

2. Removed the saved booth's unsupported north facing; its south-facing seat now faces the dining table. Preserved the accepted crate, compact workstation and chair. Native directions are checked against the actual catalog.
3. Corrected three desk2 footprints and added a complete furnished-room review: 160 types, 208 supported directions, 35 rooms, actual surface and wall mounting, crew and accepted props as scale references. The saved demo contains 159 placements across 53 types. The catalog is a temporary fixture, not additional furniture written into the saved station.
4. Calibrated projection floors to 0.92 and walls to 0.90 in the live CRT lab. Study skins use a cached display-only tone adjustment that preserves alpha and black outlines; all 152 source PNGs remain unchanged. Precomputed exact alpha crops replace expensive startup readback where valid; the loader retains a fallback for older packs.
5. At overview zoom, routing warnings are grouped by room; normal zoom shows compact summaries and selection reveals the full instructions. Underlying routing state and actions are unchanged.
6. Integrated source-bound effects for 88 prop types; the other 72 have explicit quiet/existing-effect classifications. Screens, scans, indicators and result effects follow actual state. Decorative water, steam and plasma may animate independently. This is not a complete set of articulated mechanical animations.
7. Assigned room purposes/materials and added 15 furnishings for the archive, signal room, crew support, maintenance and work areas. Geometry, conveyor paths and access remain intact. The launcher applies this only to its isolated demo save and creates a versioned backup before writing.

## Verification

The coordinator inspected screenshots of all 35 catalog rooms in the running browser. The final UI reported 208/208 directions available and rendered, 160 types, zero loader failures. The separate browser sweep covers all rooms in idle and powered fixture states with no missing artwork, placement conflict or surface fallback. Powered/frozen and powered/moving controls were also exercised visually. These are fixture states, not evidence that backend jobs ran.

The main demo was reloaded at its normal URL and inspected in cinema overview: revised room furnishings/materials and compact routing labels are visible, and the study panel links to the complete catalog. This is a visual review pass, not owner approval of every asset.

Focused checks pass: 159-placement layout/circulation validation; 184 source alpha crops and hashes; 726 prop contracts; 301 material contracts; 538 workstation-state assertions; study-skin hash/anchor and tone checks; routing-label layout; projection-effect state/crop/bounds tests; 88 real-canvas effect pixel checks; catalog coverage of 76 layouts and 38 table-mounted cases. Final syntax checks and `git diff --check` pass.

Observed local diagnostics:

| Measure | Before | After |
| --- | ---: | ---: |
| Reserved prop cache | 26.44 MiB | 10.90 MiB |
| Loaded PNG views | 184 | 184 |
| Loader failures | 0 | 0 |
| Readiness after diagnostic script start | 15,028 ms | 13,260 ms |

Final visible-tab rAF sample: 180 intervals, median 8.4 ms, p95 16.6 ms, maximum 16.8 ms, never hidden during the sample. This measures browser callback cadence, not GPU frame time. Earlier cadence was sampled under different system load, so no controlled speedup is claimed. Initial loading remains noticeable.

## Release limits

The aggregate `npm run test:fast` run failed planning-authority/finite-claims checks in `qa-product-perfect-claims` and exceeded its 900,000 ms timeout. The combined branch needs its release-surface/planning-authority audit refreshed; no authority receipt was changed to manufacture a pass. The full gate is **not green**, and this branch is not claimed release-ready or merged to trunk. Local output is in `polish-test-fast.log` (ignored by git).

Item 1 was outside the requested 2–7 scope: the 38 study skins still have standing directions only, without new walking or seated poses.

After any projection source-image change, rebuild `runtime-geometry.json` with `node dev/industrial-textures/build-projection-load-geometry.cjs`; its focused test rejects stale image hashes. Source changes also require updated effect bindings and renewed in-room review.
