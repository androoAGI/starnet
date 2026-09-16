# Depth and distance presentation

Owner feedback: the detailed walls become noisy at overview, the station lacks convincing depth, and some props feel pasted onto the deck.

## Changes

- Projection-view station plates now use cached reductions in half-size steps before the final screen draw. This reduces aliasing of small hardware at overview while retaining the original detailed plate at close zoom. Alpha, world rectangle, door painter order and collision geometry remain unchanged. Repainting or losing a canvas invalidates its reduced plates.
- Projection sharpening was reduced from 0.28 to 0.08. Grain is 0.06; the existing restrained scan/film treatment remains. These values were exercised and read back in the live CRT lab.
- Deck material gain is 1.04, interior wall gain 0.82. Exterior exposure falls from 0.52 at deck height to 0.24 at the hull foot. Interior room/pool light strengths are 0.56/0.92, with ambient darkness unchanged. The darker exterior and more legible occupied deck separate the station's planes. These are the live-lab values; station and catalog share the bake defaults.
- Floor-standing projection props receive a small cached contact shadow derived from opaque pixels near the actual foot of their silhouette, at strength 0.28. Open gaps between table/chair feet remain open. Surface-mounted props, wall-mounted props and decals receive no new floor contact. Existing cast shadows remain and use smooth resampling in the projection view. Readback failure drops this optional contact layer instead of breaking the prop draw.
- The lab refreshes its sliders when the asynchronous material profile becomes ready; its corridor-height range now includes the actual 30px value. Previously the text receipt and visible sliders could disagree.
- A close view exposed oversized countertop accessories: the coffee machine's display envelope is now 7×10 world pixels and the mug's 4×4. Their 1×1 placement cells, original PNGs and surface contact anchors are preserved. A reproducible display-fit step applies the same adjustments on catalog rebuild; export receipts retain the original source envelopes.

No prop PNGs, skin PNGs, station layout, prop rotations, seat geometry, capabilities or backend work states were changed. The prior full-catalog review remains coverage evidence, not blanket aesthetic approval.

## Live checks

Checked the running seeded demo at `http://127.0.0.1:18794/?propSet=projection&skinSet=study` in cinema overview, room-scale lounge/observatory, and close view after reload. Distant wall texture is calmer, exterior cladding recedes beneath the deck, close paneling remains present, and the lounge furniture stays aligned to its existing footprint. The browser error log was empty at the final normal-demo check. CRT-lab values were read back before copying them into defaults.

This pass addresses distance sampling, light separation and grounding. It does not establish that every prop's artistic perspective is perfect, and it does not add new character poses.

## Checks and limits

Passing focused checks: real-canvas pyramid selection/reuse/invalidation, transparent void and opaque deck preservation, retained close detail, contact at separated feet without filling the leg gap, absent contact for floating silhouettes; 301 material contracts; 726 prop contracts; 194 hull assertions; 52 seam assertions; world-renderer contracts; eight local-light-response tests. Final syntax and whitespace checks pass.

`npm run test:fast` was attempted and again reported planning-authority failures in the finite-claims audit: tracked audit expected true but returned false, planning status expected PASS but returned BLOCKED, and the terminal's open-work assertion failed. The failing run was interrupted after those failures; no full-suite pass or release-ready claim is made. Its local log is `depth-test-fast.log` (ignored by git). The newly added real-canvas test was run separately after the aggregate run started.

Reduced plates add cached render memory (a complete half-size pyramid is less than one third of its source plate's pixels). They do not scan pixels or allocate continuously while the camera is stationary. No controlled frame-rate improvement is claimed from this visual pass.
