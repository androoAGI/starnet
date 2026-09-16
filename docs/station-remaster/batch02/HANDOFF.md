# Material-diverse station prop collection

This collection answers the request to produce many more props with materials suited to their function. The wooden bookshelf replaces the previous metallic proposal. Furniture, accessories, plants, lab equipment and archive fixtures share the station camera and level of detail while using wood, cloth, paper, ceramic, glass and colored finishes.

## Collection and provenance

All 44 assigned designs are exported: 12 storage/accessories, 12 crew furniture, 12 utility, and eight boards/archive fixtures. The pool table also has an empty-playfield variant for real animated balls, making 45 final PNGs. `frontend/prop-batch-review.html` reads the generated `frontend/assets/industrial/batch02/catalog.json`; its count reflects files actually exported, not live acceptance. Regenerate that catalog with `node dev/industrial-textures/catalog-batch02.cjs` after collecting revisions.

Final transparent PNGs live in `frontend/assets/industrial/batch02/{storage,crew,utility,coordinator}/`. Original images, exact generation prompts and export records live under this documentation directory. Coordinator export records are alongside its final PNGs. Retained subject RGB is unchanged; source and output hashes bind each record to the exact files. Some coordinator sources retain their generated near-opaque alpha rather than being forced to binary alpha.

Coordinator collection checks verified all 45 source/output hash pairs against export metadata, positive transparent and opaque pixel counts, and zero recorded subject RGB changes. The catalog independently decoded all 44 selected images and checked alpha. All four groups were inspected in the browser review page, including the last three utility props. Review-page JavaScript and coordinator exporter/catalog syntax checks passed.

## Runtime handoff

The original texture task owns runtime integration in `industrial-textures-0912`. Asset production and export checks do not establish seat alignment, table mounting, animation, occlusion, station lighting or user acceptance. Follow each lane's README and per-prop metadata; preserve native physical footprints and uniformly fit artwork.

- Prefer the wooden batch02 bookshelf over the earlier metal design.
- Use `crew/pooltable-clean.png` for animated balls and cues. Keep the decorated original as an alternate.
- Use the revised broad bunk and its documented quilt region for sleeper occlusion. The static empty bed cannot prove occupied behavior.
- Round table and stool were regenerated against the owner's measured table envelope and seated-character alignment. Crew commits `df6fc2337` and `27ea5df43` contain the corrected geometry and measured source landmarks. Stool near seat rim maps to world y2.7 (target3), feet11. Round table uniformly fits to width23.36 in its24px envelope; near tabletop rim maps to y4.08 and floor12. The original texture task still owns final live seat/mount confirmation.
- Mission board, trophy case, inbox, calendar and index labels intentionally carry no invented task or achievement state. Their surfaces are available for real content.
- Artwork review is available by group, at full detail, over transparency checkerboards, and at four times the proposed world envelope. That scale preview does not simulate the running station.

Only merge into trunk after the owner completes live checks and the required `npm run test:fast` gate. This art collection has not been merged to trunk by the coordinator.
