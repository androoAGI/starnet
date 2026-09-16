# Default-station texture import

Imported from the committed `agent/prop-coordination-0914` snapshot `3545e946c`
on 2026-09-15, following the update in **Create Starnet station textures**.

The five capability-v2 images replace `war_intelcab`, `gigs_servercart`,
`comms_dish`, `workbench`, and `studio` in the projection pack. Their manifest
entries, measured alpha crops, export receipts, effect regions, and effect
image bindings travel together. Original generations, cropped exports, and
previous images are retained in `frontend/assets/industrial/capability-v2/`.
Other texture-coordinator changes were not imported.

The station factory, room geometry, and saved placements were not changed by
this import. The live save remains 18 × 11; the user's current placements
include the media studio near the lower-right corner.

Verification: 178 source/export pixel receipts, 184 runtime alpha crops,
projection effect bindings and state guards, 34 screen-light emitters,
1,413 prop-remaster assertions, 69 texture-readiness assertions, and the depth
rendering checks passed. JavaScript syntax and diff whitespace checks passed.
Reloaded the live app at port 18845, inspected all five replacements in the
station, and observed no reported browser errors. No live provider task was run.

The full aggregate gate was not rerun. Its earlier failure remains documented
in `../DEFAULT-STATIONS.md`; this import is not a merge or release claim.
