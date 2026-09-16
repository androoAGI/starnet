# Storage and furniture projection triage

Read-only coordinator snapshot. No new art or runtime edits. Native footprints use12px tiles; standing rectangles below are `(x,y,width,height)` in world pixels. Correct floor axes and visible top planes from the accepted crate/workstation/chair; the full sheet is material reference only.

## wide-storage

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| bookshelf | 2×1 | (-1,-9,26,22) | 26.00×30.39 | regenerate |
| shelf | 4×1 | (0,-14,53,26) | 53.00×50.32 | regenerate |
| industrial_drawerbank | 3×1 | (0,-3,36,15) | 36.00×38.86 | regenerate |
| arc_indexwall | 4×1 | (-1,-13,50,23) | 50.00×45.12 | regenerate |

- **bookshelf:** Rebuild as a low wide wooden bookcase: visible top plane, two broad shelf cavities, grouped books. Current tall front elevation plus top plant makes native fit only 18.82px wide instead of26.
- **shelf:** Four-tile shelf needs a horizontal53×26 envelope; current nearly square bay is physically too tall when made53px wide.
- **industrial_drawerbank:** Three-tile drawer bank must be a low36×15 horizontal bank; current two-column upright chest becomes38.86px tall.
- **arc_indexwall:** Four-tile archive index needs a low wide wall of drawers. Current square cabinet expands to45.12px tall against23 native.

## deep-storage

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| rackV | 1×2 | (-1,-12,14,36) | 14.00×15.94 | regenerate |
| industrial_servicecab | 1×2 | (0,-5,12,29) | 12.00×12.17 | regenerate |
| war_intelcab | 1×2 | (0,-7,17,31) | 17.00×15.00 | regenerate |
| safe | 1×2 | (-1,-8,18,32) | 18.00×23.45 | regenerate |

- **rackV:** Native is a narrow1×2 server tower with blade and LED rows, not open shelving. Re-author slim14×36 silhouette and real north-south depth.
- **industrial_servicecab:** Native1×2 footprint and12×29 envelope require deep narrow cabinet; current square front compresses to12.17px high.
- **war_intelcab:** Native1×2 intelligence cabinet needs narrow17×31 body and deep top; current wide console shrinks to17×15.
- **safe:** Native1×2 safe needs depth along screen y and18×32 body; current short front-heavy safe is only23.45px tall at width18. Preserve wheel/lock face with more receding body.

## medium-storage

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| industrial_locker | 2×1 | (0,-12,24,24) | 24.00×36.22 | regenerate |
| rack | 2×1 | (0,-14,29,26) | 29.00×39.24 | regenerate |
| vault | 3×2 | (-3,-5,44,29) | 44.00×45.71 | regenerate |

- **industrial_locker:** Two-tile24×24 locker is drawn as narrow tall55×83 silhouette; native fit loses one third of width. Re-author broader locker with anchor camera.
- **rack:** Two-tile server bank native29×26 is wider than current68×92 tower. Re-author broad rack while preserving server function and bounded status surfaces.
- **vault:** Three-by-two vault native44×29 is much wider/lower than77×80 square safe source. Re-author wide heavy vault with visible top depth.

## angled-small-storage

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| industrial_toolcaddy | 1×1 | (1,2,10,10) | 10.00×9.62 | regenerate |
| gigs_servercart | 1×1 | (1,-6,16,18) | 16.00×20.92 | regenerate |
| boxes | 2×1 | (0,-1,24,13) | 24.00×19.95 | regenerate |

- **industrial_toolcaddy:** Current tray and wheel axes are diagonally yawed. Match accepted workstation horizontal front edge; retain tools and1×1 footprint.
- **gigs_servercart:** Current laptop-cart top and frame are diamond-yawed. New source needed to make horizontal front with visible north-south top depth; bounds cannot unyaw.
- **boxes:** Current three cartons make tall dense cluster. Spread broad box masses over2×1 native24×13 envelope with consistent accepted floor axes.

## wide-work-surfaces

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| industrial_bench | 3×1 | (0,0,36,12) | 27.70×17.00 | regenerate |
| lowtable | 3×1 | (-1,-5,38,17) | 30.35×18.00 | regenerate |
| glasstable | 3×1 | (0,-6,36,18) | 27.51×18.00 | regenerate |
| bench | 4×1 | (-1,-14,54,26) | 54.00×40.97 | regenerate |

- **industrial_bench:** Current three-tile cushion body is too deep/square: native fit width19.56 vs36. Re-author wide backless seat, preserve blue upholstery.
- **lowtable:** Current image full-width fit is too tall for38×17; existing correction further narrows to30.35. Re-author long shallow top and supported feet; matching east view and mount anchors required.
- **glasstable:** Current top fits only27.51px of36 native width at18 high. Re-author horizontal broad shallow glass top with matching east view and mount anchors.
- **bench:** Four-tile54×26 work bench is only34.27px wide when constrained to native height. Re-author broad work surface, grouped tools, clear standing front.

## shared-table-surfaces

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| dinertable | 3×2 | (-1,3,38,22) | 31.88×24.00 | regenerate |
| bar | 4×1 | (-1,-12,50,24) | 50.00×43.00 | regenerate |
| industrial_roundtable | 2×1 | (0,-4,24,16) | 24.00×25.88 | regenerate |

- **dinertable:** Native dinerTop is a separate butcher-block table; source bakes two red chairs. Re-author standalone3×2 table and2×3 east view; keep native mounted-child support independent.
- **bar:** Native4×1 bar has open standing front, panelled counter and integrated back shelf. Source bakes stools and becomes43px tall vs24 native. Re-author50×24 clear-front bar.
- **industrial_roundtable:** Current nearly circular top projects too deeply; whole source native fit becomes14.84px wide instead24. Re-author shallower ellipse and low pedestal with accepted overhead camera.

## remaining-seat

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| podchair | 1×1 | (1,-5,10,17) | 10.00×10.92 | regenerate |

- **podchair:** Current wide egg source only10.92px tall when width10; native body10×17. Re-author narrower upright egg with visible seat plane; all s,w,n,e facings need matching seat/foreground anchors.

## bounds-first

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| quarters_lockerbank | 3×1 | (-1,-20,38,32) | 38.00×34.16 | reuse-bounds-first |
| trophycase | 2×2 | (-1,-6,26,30) | 26.00×29.47 | reuse-bounds-first |
| industrial_supplycart | 2×1 | (1,-11,22,23) | 22.00×22.59 | reuse-bounds-first |
| gigs_partsbin | 2×1 | (-1,-7,26,19) | 26.00×20.61 | reuse-bounds-first |
| goldcrate | 2×1 | (-1,-10,26,22) | 26.00×20.36 | reuse-bounds-first |
| workbench | 2×1 | (-1,-15,30,27) | 30.00×26.51 | reuse-bounds-first |
| bunk | 2×2 | (0,-2,24,26) | 24.00×25.46 | reuse-bounds-first |
| sidetable | 1×1 | (0,-3,12,15) | 12.00×14.08 | reuse-bounds-first |
| longtable | 3×1 | (-1,-6,38,18) | 38.00×19.99 | reuse-bounds-first |
| loungetable | 2×1 | (0,-6,24,18) | 24.00×17.23 | reuse-bounds-first |
| booth | 2×1 | (0,-7,24,19) | 24.00×18.42 | reuse-bounds-first |
| dinerchair | 1×1 | (1,-4,11,16) | 11.00×15.81 | reuse-bounds-first |
| stool | 1×1 | (1,0,10,11) | 10.00×11.88 | reuse-bounds-first |
| beanbag | 1×1 | (-1,1,14,11) | 14.00×11.28 | reuse-bounds-first |

- **quarters_lockerbank:** Near native aspect:38×34.16 vs38×32. Try native envelope/contact and room comparison first; only regenerate if cap depth still fails accepted camera.
- **trophycase:** 26×29.47 nearly native26×30 and horizontal frame. Keep source first; earned trophy content must remain truthful and masks independent.
- **industrial_supplycart:** 22×22.59 nearly native22×23; axes are horizontal. Retain source and calibrate wheel contact.
- **gigs_partsbin:** 26×20.61 vs26×19 is a small fit discrepancy. Retain open-bin source first; keep fill contents decorative/runtime contract distinct.
- **goldcrate:** 26×20.36 fits26×22; horizontal lid axes and broad form are plausible. Compare directly to accepted crate without recoloring approved gold material.
- **workbench:** 30×26.51 almost native30×27; visibly overhead tool surface and horizontal frame. Keep source first, confirm contact/standing edge.
- **bunk:** 24×25.46 nearly native24×26. Keep body first; validate bed orientation and sleeper occlusion in room.
- **sidetable:** Bare repair12×14.08 fits native12×15. Keep source; re-anchor tabletop support from actual ellipse, not old source coordinates.
- **longtable:** Bare primary38×19.99 vs native38×18 is10% height mismatch. First constrain native envelope and inspect34.22px fitted width; regenerate only if room requires full38 span. East view especially needs separate fit review.
- **loungetable:** 24×17.23 nearly native24×18. Keep broad ellipse first and update authored mount support for both views.
- **booth:** 24×18.42 nearly native24×19 with visible cushion plane. Keep first, evaluate actual facing and seated body/near-edge occlusion; side views separately.
- **dinerchair:** 11×15.81 nearly native11×16. Keep and compare seat plane to accepted chair in all facings.
- **stool:** 10×11.88 vs10×11 small height mismatch; keep source and correct floor contact.
- **beanbag:** 14×11.28 nearly native14×11, broad top depression reads correctly. Keep first.

## recent-correction

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| recliner | 1×1 | (-3,-7,17,19) | 17.00×19.00 | retain-current-candidate |
| recliner_r | 1×1 | (-2,-7,17,19) | 17.00×19.00 | retain-current-candidate |

- **recliner:** Recent opposed source correction already uses17×19 native envelope. Do not regenerate preemptively while couch is being fixed; room seating check still required.
- **recliner_r:** Recent opposed source correction already uses17×19 native envelope. Keep distinct left/right sources; no bitmap rotation.

## protected-anchor-context

| ID | Footprint | Native standing rectangle | Current rendered envelope W×H | Action |
|---|---|---|---|---|
| desk | 3×1 | (-1,-11,38,23) | 38.00×28.40 | defer |
| desk2 | 3×1 | (-1,-11,38,23) | 38.00×36.46 | defer |

- **desk:** Canonical3-tile desk is not accepted compact two-tile workstation fallback. Do not replace the accepted live fallback. Audit canonical s,w,n,e separately only when scheduled.
- **desk2:** Canonical3-tile desk2 source is narrower/taller than native38×23. Requires later full directional workstation task; do not confuse with accepted compact workstation render.

## Verification limits

The JSON contains exact image hashes, all supported native views and uniform-fit dimensions. Source previews were inspected against actual accepted anchors. No in-station visual acceptance is claimed. Bounds-first items are candidates for a fit/contact pass before spending generation calls; matching aspect alone is not camera approval.
