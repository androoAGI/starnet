# Projection correction — lounge review

The owner rejected the deployed sheet's orientation and scale. The sheet remains the material/style authority; only the crate, workstation and chair were accepted in the station. This is a correction candidate, not completion or owner approval of the catalog.

Review the saved station at `http://127.0.0.1:18793/?propSet=projection`. The ordinary URL retains the earlier set for comparison. `prop-atlas.html?propSet=projection&set=new` filters the eight revised props; `approved-prop-check.html?propSet=projection` reports loading and geometry checks. None of these routes change the saved layout.

## Scope

Eight revised primary views: couch, pool table, TV, aquarium, two arcade cabinets, and the opposed recliners. Unchanged images and metadata are copied byte-for-byte from the prior set, including the accepted anchors. The saved two-tile desk continues to use the existing compact workstation fallback; the canonical three-tile desk is not a substitute for that accepted render.

Sources use Codex's built-in image tool. Prompts are adjacent to this file. The build script only crops and removes loose low-alpha fringe, preserving all retained RGBA pixels. It does not repaint or stretch the art. `exports.json` binds outputs to source hashes, crop rectangles, physical bounds and contact points. Rebuild with `node dev/industrial-textures/build-projection-correction.cjs` from the worktree root.

## Corrections and iteration

- Rebuilt the TV with horizontal edges and a low support; its fitted height is 24 world pixels, replacing the previous 44.24-pixel tower.
- Gave the pool table horizontal rails and a readable felt plane. The first fit shrank its width to 40.77; the revised envelope permits the full 50-pixel width, including its narrow border outside the four-tile footprint. Bottom contact remains y=24.
- Rebuilt the recliners as opposed views with visible seat tops. Their seat-plane depth/width is approximately 0.60, close to the accepted chair's approximately 0.63. They retain the native 19-pixel standing height.
- Rejected the first couch from the group source. Rejected the next front-facing wide couch because it faced away from the saved TV. `couch-north-source.png` is the current back view, with blue cushions on the far side and a dark near panel. Actual uniform fit is 62 by 15.61, not the requested source ratio. It remains visually shallow; do not claim that a prompt's dimensions were achieved.
- Rejected the first front-on aquarium and then the overhead tray-like revision. `fishtank-balanced-source.png` restores a substantial front glass face beneath a visible top surface, fitting uniformly to 26 by 19.75 world pixels. Keep source history distinct from the selected export.
- Added optional physical contact coordinates so retained alpha fringe cannot lift the opaque feet. Legacy entries retain their existing fit.
- Corrected mounted-child draw ordering to follow the host's authored sort depth. Covered by actual world/builder ordering regression tests; a live far-row mount demonstration is still outstanding.

## Evidence and limits

The saved lounge was inspected through the actual running station renderer, at whole-room and close zoom, with the owner's existing prop positions and station lighting. The TV's yaw and height, pool-table width, opposed recliner directions, and north-facing couch were visually checked. The room was not reseeded.

Focused checks: 726 remaster assertions, 262 authored-mount assertions, 117 mount assertions, and candidate export tests preserving every retained pixel and all unchanged assets. Browser runtime check: 184/184 loaded views, 208 rotations rendered, ten authored tabletop views resolved, zero reported loading failures. These are technical checks, not visual approval. The earlier full fast gate has a release-claims snapshot failure; this lane is not merged to trunk.

The remaining catalog has not passed the owner's new geometry standard. Long narrow table fits still need correction; changed tabletop surfaces need new authored support points. The couch's dormant seating contract is unchanged (`sit:false`); future activation requires live occupant/foreground checking. Old image-specific aquarium effects are disabled on this candidate because their anchors do not match the new source. Full-catalog completion and functional animation acceptance are not claimed.
