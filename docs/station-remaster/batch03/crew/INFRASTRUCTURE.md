# Painted infrastructure handoff

Five new prop IDs, seven individually generated views. Built-in image generation only. Camera/design references were owner workstation and calibration crate; the batch03 bench was the main painted rendering reference. New functional forms were authored from native placement contracts, without old sprite tracing. Full original sources and exact prompts, including superseded proportion candidates, remain beside this file.

Final assets live in `frontend/assets/industrial/batch03/crew/`:

| File | Native footprint | Visual envelope | Measured uniform fit | Bottom/contact |
| --- | --- | --- | --- | --- |
| industrial_partition.png | 3 x 1 | 36 x 21 at (0,-9) | 36 x 19.071 | y12 |
| industrial_partition-r1.png | 1 x 3 west | 8 x 44 at (2,-9) | 8 x 43.85 | y35 |
| industrial_partition-r3.png | 1 x 3 east | 8 x 44 at (2,-9) | 7.806 x 44 | y35 |
| industrial_servicecab.png | 1 x 2 | 12 x 29 at (0,-5) | 12 x 27.078 | y24 |
| industrial_wallpanel.png | 2 x 1 | 24 x 23 at (0,-13) | 24 x 20.649 | y10 wall contact |
| industrial_floorvent.png | 2 x 1 | 22 x 10 at (1,1) | 22 x 8.429 | y11 flat visual edge |
| industrial_cabletray.png | 3 x 1 | 36 x 6 at (0,3) | 36 x 5.615 | y9 flat visual edge |

World coordinates use 12 pixels per tile. Fits are mathematical measurements of alpha-cropped sources placed uniformly inside the native envelope, centered in X and bottom-aligned. No nonuniform stretching or bitmap rotation was performed. Partition west/east were independently generated and corrected; small design differences remain between the separate drawings. The final west was generated from the final east as its opposite-facing reference, preserving comparable geometry.

The floor grille and cable channel are flat plans: native inventory supports r0, r1, r2, r3 with exact quarter-turn transforms. Only the south source is required by the structure manifest. These transforms are valid for flat patterns and must not be used for upright objects. Partition supports south/west/east only; service cabinet and wall panel support south only.

The service panel requires a wall host and is nonblocking. Partition and service cabinet block their placement rectangles. Floor grille and channel remain beneath bodies and props and do not block. None has a seat anchor, table surface, or sampled work-state animation; no invented status glow was baked in.

The previously authorized alpha exporter changes connected background alpha and tight crop only, retaining RGB verbatim. Floor grille source had near-opaque RGBA and faint distant residue, normalized at alpha160. Wall panel source had a baked light neutral checker: connected neutral background removal used threshold190, with dark perimeter intact. All other final sources use solid-white background extraction at235. Interior duct spaces stay dark and opaque. No enclosed background holes required additional seeds.

`infrastructure-verification.json` verifies all seven RGBA assets, alpha values0/255, source/output hashes, and zero RGB changes. `review-industrial_partition.png` and `review-industrial_servicecab.png` were visually inspected at larger size and native-envelope thumbnail size. Standalone source images were also inspected.

No runtime, shared manifest, original prop art, or website mirror was edited. These are art handoffs, not claims of live integration or user acceptance. Owner must still verify wall contact, partition occlusion and pathfinding, floor ordering, and every offered facing in the running app. No test gate was run for these unintegrated asset-only commits; root/owner owns integration validation.
