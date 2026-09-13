# First industrial minion pass (superseded)

Andrew rejected this dark minion on 2026-09-13. The current `station_minion` skin is **Clean Cadet**, with a completely blank white face; see [the new style reference](../clean-style/README.md). The notes below record the earlier design and its verification only.

The first industrial preview used a compact worker android with weathered charcoal and warm-grey armor, muted brass hardware, black joint seals and a narrow cyan visor. Its bridge and workshop references are historical context for this rejected character, not the style target for future character or station revisions.

The skin is an additive catalog entry. Existing saved skins and the normal application's Cadet default remain available. New industrial preview saves select Station Minion; existing preview saves keep the user's selection.

## Art and assembly

- Built-in imagegen produced the transparent design master, retained at `C:/Users/andro/.codex/generated_images/01a0976c-e264-7f13-a581-78c904716b14/exec-3402f087-43bf-47b2-9e1a-6ad2550d632f.png`.
- `minion-reference.png` alongside this document is the compact reference submitted to PixelLab v3: 64px body height centered in a transparent 96px canvas.
- PixelLab idle character: `3ab47da1-1471-4795-9a85-ec6891445965`; seated state: `910a521a-72d2-4eb2-b4ee-5813e34f2a44`.
- Walk: eight-frame `walking-8-frames` template, all eight directions; group `ae300c78-78e4-4ee4-9e53-c992f503a9b7`.
- Typing: v3 custom, four generated frames plus its reference, four cardinal directions; group `7e18f3d2-f252-41dd-8a6c-c1d6f3150169`.
- 96 shipped PNGs: eight rotations, 64 walk frames, four seated poses, 20 typing frames. No chair or workstation is painted into the body.
- Packaging: `node dev/industrial-textures/prepare-minion.cjs <extracted-group-directory>` (requires Sharp). Download the completed PixelLab group's ZIP into ignored `dev/industrial-textures/minion-source/`, extract it there, and pass that directory containing `Idle/` and `Seated/`.
- Every shipped frame uses a transparent 92px RGBA canvas, center x=46 and exclusive floor line y=69. A common 0.6875 scale gives a 44px south silhouette; catalog scale 0.385 renders it at 16.94 world pixels. Walk scale is uniform per direction, with idle-locked horizontal alignment. Frames retain their authored gait; no per-frame height normalization or procedural recoloring.

## Design prompt (built-in imagegen)

Use case: stylized-concept. Asset type: one transparent full-body game character sprite for StarNet. Image 1 (bridge) and image 2 (workshop) are the SOLE visual style references. Image 3 (existing tiny white cadet sprite) is only a body-scale and pose reference, not a color or style reference. Design the station's small industrial minion: a compact bipedal worker android, rounded chamfered gunmetal helmet with a recessed black faceplate and one narrow horizontal cyan visor slit. Worn charcoal and medium warm-grey steel shell plates, restrained brass fasteners and edge scuffs, black flexible elbow and knee joints, simple armored chest, small practical utility belt, compact gloves, sturdy short boots. Distinct head, torso, two arms and two legs with readable gaps; approachable through proportions but eerie, utilitarian, no smile or human face. Keep roughly the existing cadet's head-to-body proportions (about 3.5 heads tall), a little broader shoulders, no oversized head or huge armor. The character must remain readable at only 18 pixels tall in a top-down game. Match the detailed, weathered industrial surfaces of the station. Camera high overhead oblique from south, front-facing neutral standing pose, both feet planted on a common baseline, arms resting slightly away from torso, perfect horizontal shoulder axis, no isometric tilt. Complete centered figure on genuinely transparent alpha background. No floor, chair, machinery, props held in hands, weapons, text, glow outside silhouette, cast shadow or painted checkerboard. Use light-catching steel edges to separate the dark body from a charcoal floor. Cyan only in visor; small muted ochre accents on hardware.

## PixelLab direction prompt

A compact bipedal station-worker android with a gunmetal helmet, black faceplate, narrow cyan visor, worn warm-grey charcoal armor, restrained brass fasteners, black joint seals, short sturdy boots and a utility belt. Preserve the supplied character's identity, proportions, material colors and details in every direction. Small unarmed industrial worker; cyan visor is on the front only, back of helmet is plain steel. High top-down station camera.

Settings: humanoid, v3 reference, eight directions, 96px, high top-down, selective outline, high detail.

## Seated-state prompt

Same exact station-worker android, helmet, body scale, charcoal armor, brass hardware and cyan visor. Sit upright at a workstation on an invisible chair. Hips and knees bent about ninety degrees, both boots pointing forward and resting on the ground; forearms extended a little forward with hands ready to type on an invisible keyboard. Maintain original head size and body width; shorter overall silhouette comes only from bent legs. No chair, table, keyboard, new equipment, floor or shadow. Transparent background. Preserve the original high top-down camera and each view direction.

## Typing prompt

The seated station-worker android quietly types on an invisible workstation keyboard. Keep hips seated and boots grounded. Only the hands and forearms make small alternating typing movements. Hold the helmet, torso and suit design steady. Preserve identical body scale, camera, facing direction and cyan visor throughout the loop. No chair, table, keyboard, effects, floor or shadow. Transparent background.

## Verification

Verified in the dev-seeded app at `http://127.0.0.1:18792/` on 2026-09-13:

- Selected Station Minion through NOVA's dossier. After restarting the preview sidecar and reloading, the picker still reports `aria-pressed="true"`; the saved backend document reports `doc.agent.skin = "station_minion"`. All 19 station props remain present.
- The actual served `rot_south.png` and animated `walk_south_2.png` / `walk_south_5.png` decode at 92px; the live station shows the new body standing and roaming. No browser errors were captured. [Live picker screenshot](minion-live-picker.jpg).
- The real `SPRITES` renderer loads 24 tracks / 96 frames at scale 0.385. Native canvas checks exercise idle, walking, sitting and typing in all four cardinal directions; every walking and typing direction produces distinct rendered frames. Seated and typing art were verified through this renderer, not through a live provider work run. [Renderer receipt](minion-renderer-proof.json).
- Focused asset, walking-build, seated-facing, direction-detail, loading, detached-prop, world skin-switch and dossier accessibility checks pass. The unchanged runtime retains its normal fallbacks for optional actions without bespoke frames.
- Pre-integration `npm run test:fast` on `b1a66481f`: `run-fast-tests: OK — 772 step(s) green`. After syncing other agents' changes, the combined sprite audit and website mirror check also pass.
- Post-integration `npm run test:fast` on trunk `0b35b46e91a80ecaa7c39a7fcec5fae512157a86`: `run-fast-tests: OK — 772 step(s) green`, exit 0. Raw logs are retained locally under `dev/industrial-textures/minion-source/test-fast.log` and `test-fast-trunk.log` in the retained preview worktree.
- The reviewed frontend catalog hash was refreshed in the source audit ledger; all existing claim verdicts were preserved. This is a skin verification, not a station-wide readiness claim.
