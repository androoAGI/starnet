# Built-in image-generation prompts

The first workbench and tactical-table outputs were superseded after in-room
inspection. The v2 outputs below are the selected runtime candidates.

Each call used the existing prop as the first edit target, followed by the accepted
desk and crate as camera references (crate then desk for tactical table/toolbox).
Original generated RGBA outputs are preserved under
`frontend/assets/industrial/camera-audit/sources/`. Export receipts retain hashes,
crop bounds, native footprints and tabletop support points. No CLI/API fallback.

## Workbench

Edit the FIRST image into a corrected StarNet workbench game sprite. Images 2 and 3 are APPROVED camera/proportion/style references, preserve them as references only. The current workbench is rejected: it faces the camera like a product photo. Rebuild the FIRST workbench at a much higher camera elevation, matching the near-overhead orthographic camera of the little desk and crate references. Show a deep, broad worktop, rectangular screen axes, vertical uprights, no perspective convergence, no isometric diagonal rotation. The worktop must occupy at least half the object's visible height, while the front drawer/legs must be compressed into a short lower band; the toolboard is shallow in projected height. Preserve dark charcoal/olive painted industrial material, subtle brass edge accents, four readable simple tools, small vise at left and two large drawer shapes. Game sprite painted raster with broad planes, minimal tiny detail, visibly designed for a final 38 x 25 pixel in-game box. No photorealistic microtexture, no fine scratches, no logos, no numbers, no ground, no floor tile, no backdrop, no shadow outside feet. Single object centered, FULL object visible, tight framing with transparent RGBA background. Return only the corrected workbench, not the references or a sheet.

The runtime retains the existing 2×1-tile footprint and 30×27 envelope. Prompt
dimensions are design guidance, not permission to change placement geometry.

## Long table

Correct the camera projection of FIRST IMAGE: StarNet plain long utility table. Images 2 desk and 3 crate are exact approved camera references, not edit targets. Raise the camera strongly toward overhead, showing the tabletop as the dominant shape; nearly all under-table space and crossbar must disappear behind the tabletop. Table has three-tile width and one-tile depth in game. Axis aligned orthographic front-facing game projection: horizontal width edges, vertical receding depth edges, zero perspective convergence and zero diagonal isometric yaw. Tan muted tabletop with a thin worn brass/wood edge and short dark iron legs, same palette/design as first source. The top surface occupies 75 percent of visible sprite height, with only a narrow front apron and small stubby feet showing below it. Readable broad shapes at FINAL 38 x 18 world pixels, subdued hand-painted game raster, no photographic texture, no dense scratches. Bare EMPTY table, no toolbox or objects atop it, no text. Single full object tightly centered on transparent RGBA background, no floor, no scene, no drop shadow. Return only the corrected table.

## Tactical table

Edit FIRST IMAGE into StarNet corrected tactical table sprite. Keep its octagonal rectangular charcoal/brass frame and teal glass star-chart/radar design. Correct rejected camera angle to match references 2 crate and 3 desk: HIGH ELEVATION near-overhead orthographic, axis aligned with horizontal left-right width and vertical receding depth, NO diagonal isometric yaw and NO perspective taper. Its top deck is seven tiles wide and four tiles deep. The top deck occupies roughly 85% of visible object's height. Front chassis is a shallow narrow band; hide the tall pedestal, front console box and most underside. This is a tactical TABLE viewed FROM ABOVE, not a machine viewed from front. Keep broad substantial readable bevels and calm teal bounded emission. Reduce tiny lines and microtexture. Deep dark industrial painted game sprite deliberately designed to read at 84 x 54 game pixels, match material/detail level of the approved small desk and crate. No noisy scratches, photo-real metal, giant bloom, tiny decorative greebles, text, labels, other props, background or floor. Return ONE full sprite tightly centered on transparent RGBA, no cast shadow outside the body.

## Toolbox

Edit FIRST IMAGE red toolbox for StarNet. The current projection is too frontal. Match the HIGH ELEVATION overhead orthographic camera of approved crate image2 and desk image3. Show the top red lid as a broad rectangle taking 65 percent of silhouette height, front panel only a shallow band. Fold the black handle flat against lid, show two simple dark clasps on front. Keep red painted steel and dark handle, simplified readable chunky painted videogame sprite. Axis aligned, horizontal width and vertical receding depth, no diagonal isometric rotation, no vanishing point. Tiny accessory FINAL GAME SIZE 10 x 7 pixels: large clear color shapes, no scratches, no realistic textures, no tiny detail. One entire isolated toolbox, tight centered transparent RGBA background, no table/floor/shadow/text.

## Workbench v2 — selected

References: accepted desk and crate only.

Create a single industrial repair WORKBENCH sprite for the same StarNet game as the two approved reference sprites. Use exactly their elevated orthographic camera; do not include the desk or crate themselves. This bench has a broad dark steel TOP occupying most of the picture: a large empty center work area, a tiny vise attached at the upper left, and a SHORT LOW back rail holding three tools almost lying flat. View nearly from overhead, with the full depth of the countertop visible. The old tall standing pegboard is REMOVED. Do not draw tall front legs, do not draw an under-shelf, do not draw boxes under the bench. Only a shallow narrow front apron with two drawer handles, and tiny feet peeking below. Top slab rectangle width-to-depth about 2:1, total sprite width-to-height about 1.6:1. Width edges exactly horizontal; depth edges exactly vertical; no diagonal isometric angle or perspective taper. Worn charcoal and muted olive, sparse brass bevel accents, readable chunky authored raster shapes, low detail for final 30 by 24 world pixels. Not photographic, no gradients of shiny steel, no micro scratches. Single entire isolated sprite on genuine transparent background, no shadow, no floor, no room, no text.

## Tactical table v2 — selected

References: first tactical-table correction, accepted crate, accepted desk.

Correct only the physical footprint/projection of the FIRST tactical table. Its current top is too wide and shallow. Rebuild the TOP DECK as a substantially DEEPER seven-tile by four-tile octagonal rectangle, viewed from elevated near-overhead orthographic camera matching references2/3. The whole sprite must be about 1.65 times as wide as tall, NOT a wide banner. Increase the front-to-back top surface depth by 40 percent, preserving crisp material shapes rather than stretching pixels. Nearly all visible height should be top deck; the bottom frame only a narrow shallow apron. Preserve exact material design: thick octagonal charcoal frame with brass corners, cyan glass chart with restrained markings, 4 clipped corners. Horizontal width axis, vertical depth axis, no diagonal yaw, no perspective narrowing. Intended world envelope84 wide55 high; deep enough top surface for the48pixel depth footprint. Same dark simple painted game art as references, no photographic texture, no pedestal, no extra bottom console. FULL centered object tight framing on transparent RGBA background, no ground/shadow/text. Return only the corrected sprite.
