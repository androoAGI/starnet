# Corridor doorway finish

The north room/corridor mouths had a separate native row renderer; the structural texture pass did not cover it. Their reveals now sample the approved viewport steel uprights, with directional shading. Coping ends sample the approved crown texture. Both use six samples per world pixel to match the high-resolution wall bake.

Passage boundaries, floor repaint, neighboring wall shoulders, depth anchors, and classic fallback are preserved. The entity occlusion clip follows the same subpixel silhouette as the new art. No capability props, lighting settings or station save data changed.

Verified in the running default station on port 18797: the observatory entrance and a wood-paneled room entrance use the new finish. Screenshots are retained here. Browser error log was empty. Industrial texture tests cover source identity, an untouched open throat, paired reveal geometry and classic fallback; station bake tests exercise authored returns and preserve occluder bounds/depth anchors.

These screenshots verify appearance; they are not a claim that every character traversal has been observed.

Full gate: npm run test:fast passed all 793 steps, exit 0, runtime commit 72b2cd537. Log: dev/.scratch-workspace/doorway-refresh-test-fast.log. SHA-256: cd5d806ff86823189410a0e055934528cccc48b9cee708fd5ae2d9555ba48792. Focused industrialtextures: 336 assertions; stationbake.chunk: 180 assertions.

