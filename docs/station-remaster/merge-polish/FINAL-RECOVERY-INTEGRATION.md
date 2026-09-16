# Final remaster recovery integration — 2026-09-16

Candidate: 22947ff11 (combined with trunk b3ddb487a). Scope is the remaster renderer
recovery/performance follow-up, not a new artwork pass or a claim that all product
release blockers are closed.

The shared renderer now checks the actual high-resolution and zoom-reduced plates.
Lost reductions rebuild from intact source; lost high detail falls back to native
geometry; full loss rebuilds material rasters from retained images before rebaking.
The watchdog batches alpha witnesses and uses asynchronous snapshots, with a
bounded synchronous backstop if the encoder stalls. Dedicated CPU sentinel reads
never read directly from a rendering canvas. Temporary snapshots are released and
stale callbacks cannot overwrite a fresh bake.

The latest integrated doorway clearance, couch layering, workstation clipping,
new default graphics and station-building changes are preserved. The review
fixture was updated to use current doorway foot anchors; its old hard-coded
center expected an unreachable point inside the raised doorway margin.

## Live verification

All tests below ran in the real seeded sidecar at :18797 using the integrated
shipping-default graphics, without the old skin-study override. Existing user
catalog tab was not modified. Local test layouts are disposable and unsaved.

- Default 24-prop station: frame callback p95 1.8 ms, interval p95 4.3 ms.
- 96-prop / 32-region enlarged station: six 20-second samples, callback p95
  4.9–7.8 ms and interval p95 8.4–14.6 ms. Zero render faults. Lighting cache
  remained 53,319,744 bytes across all six windows.
- Close zoom on that enlarged station: callback p95 2.5 ms, interval p95 4.3 ms,
  zero render faults and no raster failures.
- Doorways: 12/12 live arrival checks passed; zero samples behind wall shoulders.
- Repeated loss at overview: LOD 125 / 262 ms, full materials+station+sky 1516 ms,
  another LOD 72 ms, high-detail 276 ms; all five detected and recovered.
- Customer journeys: 139/139 assertions PASS before the final audit-only coordinate
  and font corrections. No product navigation or backend behavior changed after it.

The previous 159-prop/large mixed-crew study measurements remain recorded in
RENDERER-LAG.md. They are a different scene and host-load condition; no direct
like-for-like speedup ratio is claimed. These new samples exceed 60 FPS at p95
under the tested conditions, not a guarantee on every machine or an installed
binary benchmark. Full cache recovery entails a one-time rebake, not a zero-time
operation. A failed close-zoom LOD test wiped zero LOD canvases (none were being
used); it was rerun at overview with actual reductions and passed.

The earlier planning gate failures came from the source lock naming old renderer
bytes. Only releaseSurface hashes were refreshed against committed source; claim
verdicts and terminal readiness rules were not changed. The final full gate and
post-merge results are appended after completion.

`qa:ready` remains separately blocked by existing ledger/bug P1 items, missing
Guardian and Beginner receipts, and no installed-executable smoke. These are not
waived by the renderer integration. No installer, public update or deployment was
created in this task.

Full 1280x720 fitted overview (96 props): callback p95 4.7 ms, frame interval p95 8.4 ms, zero render faults. See polish-fullsize-live.json.

Pre-merge npm run test:fast: PASS 808/808, exit 0 on 22947ff11. Log: dev/.scratch-workspace/polish-final-fast3.log. Source remained frozen throughout this complete run.
