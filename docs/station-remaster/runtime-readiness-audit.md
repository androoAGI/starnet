# Remaster runtime audit — 2026-09-15

The catalog audit and full test gate are complete for this lane. **Overview performance still needs optimization before claiming consistently smooth large stations.** The graphics were not regenerated or globally relit during this pass.

Tested runtime commit: `6ccc54eb6a5391607282a4ef361750283cdfc2c7`. Subsequent report-only changes do not change the tested runtime. Preview: http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler . The audit used a separately seeded sidecar on port 18796; its layouts and interactions did not overwrite the user's Kepler save.

## Catalog and physical interaction

- **160 types, 208 authored directions, 382 direction/flip cases:** zero footprint mismatches, fixture placement conflicts, asset load failures or controlled interaction failures.
- **375 actual walk arrivals.** Seven rear approaches are correctly excluded because wall-mounted props have their rear edge outside walkable floor. The exact cases and reasons are retained in the receipt.
- **24 assigned-workstation, 40 seat, 2 bed and 46 approach cases** ran the real planner/arrival paths. Remaining 270 cases have no such character interaction. Arrival is deliberately controlled; independent walking uses the actual simulation ticks. This is not proof of every autonomous scheduling choice.
- Inspected screenshots from **all 35 catalog rooms**, with an approved desk/chair/crate reference corner in each. This covers every authored direction in the actual World renderer with the remaster, lighting and CRT active. Per-room observations and screenshot hashes are in the [machine-readable receipt](runtime-audit-2026-09-15.json).
- Wall fixtures, flat rugs/markings, intentional holograms and small table-mounted objects were reviewed according to their intended support type. Workflow-machine warnings in the catalog are expected because those isolated props are not connected to belts or providers. They were not hidden to manufacture a clean screenshot.

Fixed east/west interaction sides for mirrored desks and approach props, and mirrored recliner sitter direction/offset. Updated the catalog's tactical table metadata to the real **5 x 3** footprint. Corrected fixture construction to preserve nonblocking flags: its earlier rug/plant stalls were a fixture defect, not a gait or lighting failure. The corrected cases were rerun live.

## Screen sizes, zoom and performance

Twelve measured combinations: **800 x 600, 1280 x 800, 1920 x 1080**, each at overview and command-room zoom, with 47-prop Kepler and a **188-prop, 16-region, 68-belt-tile** layout made of four separated Kepler modules. One active actor; DPR 1; two-second warm-up followed by an eight-second sampling window. Timings include the actual World frame callback, not an isolated sprite benchmark. Other application activity was not controlled.

All twelve cases retained visible prop silhouettes, room boundaries and screen lighting, with **zero recorded raster failures, rendering fault state or lighting context losses**. The browser error log was empty. Small overview decorations naturally become less identifiable; close room views restore detail. The dev audit panel can cover the upper scene on small screens and is absent from the normal preview.

Also checked the normal Kepler preview at 800 x 600: all four room buttons remain reachable, but its fixed review header obscures the upper command room. Resizing preserves the previous camera scale until Whole station is clicked again. Those are remaining responsive-preview polish items, recorded in normal-800-overview.png; the viewport was restored afterward. They are not prop-orientation failures.

| Viewport | Props | Camera | Scale | Callback p50 / p95 ms | Frame interval p50 / p95 ms |
| --- | ---: | --- | ---: | ---: | ---: |
| 800 x 600 | 47 | overview | 0.841 | 3.7 / 22.8 | 12.5 / 25 |
| 800 x 600 | 47 | command room | 1.624 | 2.4 / 3.6 | 8.3 / 12.5 |
| 800 x 600 | 188 | overview | 0.408 | 9.1 / 34.8 | 16.7 / 37.4 |
| 800 x 600 | 188 | command room | 1.624 | 4.5 / 6.3 | 8.4 / 16.7 |
| 1280 x 800 | 47 | overview | 1.122 | 3.3 / 19 | 12.5 / 20.9 |
| 1280 x 800 | 47 | command room | 2.165 | 3.2 / 6.8 | 12.5 / 20.8 |
| 1280 x 800 | 188 | overview | 0.544 | 10.3 / 52.2 | 20.9 / 54.2 |
| 1280 x 800 | 188 | command room | 2.165 | 4.1 / 5.7 | 8.3 / 12.6 |
| 1920 x 1080 | 47 | overview | 1.514 | 3.2 / 19.5 | 12.5 / 20.9 |
| 1920 x 1080 | 47 | command room | 2.923 | 2.4 / 3.5 | 8.3 / 16.6 |
| 1920 x 1080 | 188 | overview | 0.734 | 7.5 / 30.9 | 16.6 / 29.3 |
| 1920 x 1080 | 188 | command room | 2.923 | 4.9 / 6.7 | 8.3 / 12.5 |

Close-view callback p95 is **3.5–6.8 ms**. Kepler overview p95 is **19–22.8 ms**; four-module overview p95 is **30.9–52.2 ms**. Therefore the audit does **not** pass a consistent 60-fps overview target. The next performance investigation should profile the full overview frame, including work outside WorldRenderer's narrower timing window, and then repeat this same matrix. A screenshot or zero render faults does not establish smoothness.

## Full gate

`npm run test:fast` exited **0** at the tested commit:

`run-fast-tests: OK — 793 step(s) green`

Elapsed approximately **7 minutes 46 seconds**, within the unchanged 900,000-ms timeout. Log: `dev/.scratch-workspace/remaster-final-test-fast.log`; SHA-256: `03cb6a464f6e13da03a4379aab9f2d6052f826995a3a1db075615c4af4302f31`.

The previous planning audit repeatedly decoded large binary-bearing source sets. Claims checks now scan in bounded chunks, sharing immutable-candidate observations while preserving fresh injected-reader checks; parity tests cover binary data, chunk boundaries and Unicode. The mechanical source lock was refreshed to the reviewed graphics surface without changing claim verdicts or live-proof assertions. Also corrected stale lighting/seat test contracts, existing font/fetch contract gaps, and regenerated the local website mirror. Nothing was published.

## Remaining limits

Study-skin dedicated walk/sit artwork remains incomplete. This audit does not certify every character skin/pose, unconfigured backend workflow, many-agent load, arbitrary crowded user layout, GPU, DPR or long-duration session. No release-readiness or product-perfection controller receipt is claimed, and this lane has not been merged to trunk.

Raw local evidence is under `dev/.scratch-workspace/remaster-audit-evidence/`: final catalog replay, corrected traversal tail, merged per-case walks, 35 catalog screenshots, 12 viewport screenshots and the performance matrix. Failed earlier traversal receipts remain there for traceability; they are not used as passing evidence.
