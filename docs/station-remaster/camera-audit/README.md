# Camera and lighting review — September 15, 2026

Live station: <http://127.0.0.1:18795/?propSet=projection&skinSet=study&showcase=kepler>

Browsable catalog findings: <http://127.0.0.1:18795/prop-camera-audit.html>

## Delivered corrections

Four generated PNG replacements are integrated: workbench south, long table south,
tactical table south, and toolbox south. Workbench and tactical table were generated
twice: the first workbench retained too much frontal mass, and the first tactical
table had insufficient depth for the 7×4 footprint. The selected workbench uses a
low tool rail; the selected tactical table has a deeper octagonal top and shallow
front apron. The table's mounting polygon now follows its larger top, and the
toolbox has a smaller 10×7 display envelope. Placement footprints did not change.
Workbench material exposure is 1.35 so its top remains distinguishable from the
tread floor. It is a cached renderer adjustment; exported source RGBA is preserved.

The original generated RGBA files, selected crops, exact prompts and integration
receipts are retained in this lane. Rebuild with `import-camera-audit.cjs`,
`build-projection-correction.cjs`, `build-projection-load-geometry.cjs`, then
`build-projection-effects.cjs` under `dev/industrial-textures/`.
Later correction groups replace previous receipt entries; they do not inflate
coverage. The catalog remains 160 types / 184 exports, with 173 revised exports.

## Catalog audit

Inspected eight labeled source contact sheets spanning all 184 views, then inspected
the four correction candidates in the running Kepler rooms. `audit.json` records
every view individually:

- 29 views need projection correction; one couch placement needs a north-facing view.
- 11 additional views need a native-size room comparison before a confident verdict.
- Seven owner-accepted anchor views are explicitly preserved.
- Four corrected candidates require owner approval.
- 132 source checks show no obvious camera conflict; they are not live approval.

The dominant remaining problems are table/pedestal undersides, near-profile seating,
the bar's shallow top, frontal camera tripods, and the missing rear-facing couch.
This audit is an actionable queue, not a claim that the whole catalog is perfected.

## Lighting

The projection preview uses stronger physical wall fixtures and softer virtual room
fill. Source positions, wall visibility, room connectivity and the bake are unchanged.
Command/lab fixtures are cool; quarters fixtures are warm. Screen spill from the
decorative command bank and tactical table is stronger and reaches nearby surfaces.
The material profile uses fixtureTint .14, propTint .65, propLift .85 and a bounded
deck ambient lift .08, keeping the exterior wall shade separate. Existing area-light
samples and occlusion provide soft boundaries; no new synthetic work states or
performance claims are introduced. The 0.11.2 CRT profile remains unchanged.

## Verification and limits

Inspected the updated overview, command, fabrication and lounge views in the live
seeded app. Checked the workshop table/toolbox combination and tactical-table footprint.
The audit page loads and filters the current export set. This is qualitative visual
review, not owner acceptance or an RTX/GPU benchmark.

Focused checks passed: projection-correction-assets (173 source-preserving exports),
projection-load-geometry (184 measured alpha crops), projection-prop-effects,
authored-surface-mounts (262 assertions), WorldLight (127 assertions), worldrenderer,
prop-light-response, worldlight-receiver, projection-depth-rendering and Kepler
placement/routing. Syntax and diff checks passed.

`npm run test:fast` reached existing finite-claims/planning-authority failures:
`tracked finite claims audit passes planning authority` expected true, got false;
`planning status is explicitly PASS` expected PASS, got BLOCKED. It was stopped
after those failures; no full-suite pass or release-readiness claim is made.
The partial log is at `dev/.scratch-workspace/camera-audit/test-fast.log`.
