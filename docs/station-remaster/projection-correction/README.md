# Projection correction — lounge and catalog review

The owner rejected the deployed sheet's orientation and scale. The sheet remains the material/style authority. The crate, workstation and chair were accepted initially; follow-up review also accepted this set's TV, two arcades and pool table, and called the aquarium improved. The first rear couch was rejected for its mismatched camera. This remains a correction candidate for the rest of the catalog.

Review the saved station at `http://127.0.0.1:18793/?propSet=projection`. The ordinary URL retains the earlier set for comparison. `prop-atlas.html?propSet=projection&set=new` filters all revised props; `approved-prop-check.html?propSet=projection` reports loading and geometry checks. `prop-room-review.html?propSet=projection` displays the revised groups on station flooring with accepted scale anchors. None of these routes change the saved layout.

## Scope

The lounge correction is followed by furniture, storage, utilities, machinery, workstations, floor pieces, wall displays, specialty equipment and accessories. `catalog-groups.json` selects reproducible export receipts; the output manifest lists every revised view. Unchanged images and metadata are copied byte-for-byte from the prior set, including the accepted anchors. The saved two-tile desk continues to use the existing compact workstation fallback; the canonical three-tile desk is not a substitute for that accepted render.

Sources use Codex's built-in image tool. Prompts are adjacent to this file. The build script only crops and removes loose low-alpha fringe, preserving all retained RGBA pixels. It does not repaint or stretch the art. `exports.json` binds outputs to source hashes, crop rectangles, physical bounds and contact points. Rebuild with `node dev/industrial-textures/build-projection-correction.cjs` from the worktree root.

## Corrections and iteration

- Rebuilt the TV with horizontal edges and a low support; its fitted height is 24 world pixels, replacing the previous 44.24-pixel tower.
- Gave the pool table horizontal rails and a readable felt plane. The first fit shrank its width to 40.77; the revised envelope permits the full 50-pixel width, including its narrow border outside the four-tile footprint. Bottom contact remains y=24.
- Rebuilt the recliners as opposed views with visible seat tops. Their seat-plane depth/width is approximately 0.60, close to the accepted chair's approximately 0.63. They retain the native 19-pixel standing height.
- Rejected the first couch from the group source, then a front-facing couch, then `couch-north-source.png`, whose shallow projection the owner rejected. Current `couch-angle-source.png` is generated directly from both recliners as the geometry/material references. It has substantially deeper seat tops, the same upholstered arm construction, and a lower near back. Actual uniform fit is 62 by 22.75, preserving floor contact y=12. Inspected beside both recliners in the saved lounge; not yet owner-approved.
- Rejected the first front-on aquarium and then the overhead tray-like revision. `fishtank-balanced-source.png` restores a substantial front glass face beneath a visible top surface, fitting uniformly to 26 by 19.75 world pixels. Keep source history distinct from the selected export.
- Added optional physical contact coordinates so retained alpha fringe cannot lift the opaque feet. Legacy entries retain their existing fit.
- Corrected mounted-child draw ordering to follow the host's authored sort depth. Covered by actual world/builder ordering regression tests. The running room fixture demonstrates twelve near/far placements on eight revised table views with authored contact points; these are temporary fixture instances, not saved-world interactions.

## Evidence and limits

Current coverage: **173 revised views across 157 props**, plus the three unchanged accepted anchors, covers all **160 catalog props**. The remaining-prop queue in `coverage.json` is empty. This completes the generated-art pass; it does not establish owner acceptance or full functional animation acceptance.

The eight command candidates are included. Console, consoleL, console bank, large display and tactical table fit within 4.6% of native aspect targets. Bench fits 54×23.69 versus a 54×26 envelope; equipment bay 48×16.80 versus 48×19; holotable 50×27.22 versus 50×34. These three remain shallower than intended and require further visual judgment. Native placement bounds and uniform aspect ratios are preserved. Screen power still follows the existing runtime contract; the isolated room fixture has a labelled screen-art demonstration toggle.

The saved lounge was inspected through the actual running station renderer, at whole-room and close zoom, with the owner's existing prop positions and station lighting. The TV's yaw and height, pool-table width, opposed recliner directions, and north-facing couch were visually checked. The room was not reseeded.

Focused checks: 726 remaster assertions, 262 authored-mount assertions, 117 mount assertions, and candidate export tests preserving every retained pixel and all unchanged assets. Browser runtime check: 184/184 loaded views, 208 rotations rendered, ten authored tabletop views resolved, zero reported loading failures. These are technical checks, not visual approval. The earlier full fast gate has a release-claims snapshot failure; this lane is not merged to trunk.

Owner acceptance of the new catalog is still pending. Four table designs now have both supported orientations and new tabletop contact points; the round and side tables also have fresh support coordinates. The final mug was inspected on twelve near/far positions across the first eight table views and on both additional tables. Matching diner chair, pod chair, booth and diner table facings are included. The running fixture uses StationBake, PropSprites and WorldModel with the accepted compact desk, crate, chair and crew for scale; it does not reproduce every World layer, interaction, or CRT postprocess.

Desk2 and partition west facings use the actual renderer's mirror of the newly authored east view. Both were inspected in the `mirrored-facings` room group. The two unused legacy west PNG entries remain byte-identical for manifest compatibility; the native painter does not select them. Partition east/west occupies 8×35.97 within its native 8×44 envelope, a documented shallow fit. Other residual proportion differences are retained in each cohort's QA receipt. No images were stretched to hide those differences.

The couch's dormant seating contract is unchanged (`sit:false`); future activation requires live occupant/foreground checking. Old image-specific effects are disabled on changed candidates because their anchors do not match the new sources. Owner acceptance and functional animation acceptance are not claimed. Preserve wood, fabric, glass and laminate alongside industrial metal; material uniformity is not the style goal.

All catalog room groups were visually inspected in the running fixture, including floor pieces, wall mounts, archive equipment, specialty machines, accessories and plants. Each group loaded without asset errors. The last plant/decor batch retains approximately 10% envelope underfill on terrarium, plasma globe and holopet; source proportions remain unmodified. Native bounds and collision footprints are preserved throughout.
