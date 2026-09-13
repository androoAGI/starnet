
# Workstation display animation — 2026-09-13

The approved industrial desk/dual-desk art now has a screen state. Empty glass is dark; a body actually seated at its own workstation powers the authored cyan display and a slow phosphor sweep. Rear views retain the hardware back. The existing footprint, standing height, mirroring, chair approach and seated foot positions do not change.

Physical occupancy is separate from harness activity. The world supplies live.occupied only when the assigned body is sitting within one world pixel of the physical seat, with no walk or target in flight, and this prop is its resolved home desk. A settle beat can therefore power the glass without claiming the agent is working. Real heat/progress still come exclusively through the existing workstationLit/heatFor/deskProgFor path and the compute gate. Classic mode keeps its original work-driven behavior. Reduced motion keeps a stable lit screen.

The industrial loader changes only cyan phosphor pixels. It caches three dark-glass sources and at most 16 small cropped sweep patches per source. Screen compositing uses source-atop so animation cannot alter the furniture alpha/silhouette. World light uses the existing measured screen centroid, mirrored once with the sprite; the bounce now matches cyan glass. No backend schema, task lifecycle, agent pose or save data changes.

## Verification

- test/workstation-screen-state.test.js: 538 assertions, executing the real workstation/seat geometry seam and public prop draw/light API across compact/broad and all facings/mirrors, departure, stale pose, duplicate assignment, physical occupancy versus work, compute denial, and classic behavior.
- dev/industrial-textures/verify-workstation-state.cjs: actual shipped PNGs; 16 compact/broad/mirrored views; 3,379,200 alpha samples unchanged; OFF, ON frames, stable reduced motion, rear view and screen-only animation comparisons pass.
- Existing industrial loader (288), industrial catalog (1,413), and async workstation seat (69) regressions pass.
- Existing native verify-render.cjs passes: approved physical aspect/footprint/floor contact, all 47 assets, material sampling, masks, chair facings and fallback.

Native sheet: dev/.scratch-workspace/workstation-animation/screen-states.png. Run native verification with NODE_PATH pointing at the bundled @napi-rs/canvas dependencies.

## Combined live check

Root integration must reload the preview and observe an assigned desk while its agent is absent (dark), arriving/sitting (cyan glass), then leaving (dark). A real harness task is required to verify heat/status behavior; local seated decoration must not be reported as backend work. Repeat east/west and reduced motion, retaining the saved dimensions. This branch has not run the full fast gate or verified that combined live action.

