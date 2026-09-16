# Clean Cadet art prompts

Generated with the built-in imagegen tool, then animated with PixelLab v3 and its walking template. No CLI image-generation fallback was used. The selected master is `cadet-master.png` and has real transparent alpha. The interim cyan-visor version was superseded by Andrew's explicit choice of a completely blank white face.

## Initial design (reference: the existing plain white Cadet)

Use case: style-transfer. Asset type: transparent character sprite design master for StarNet. The supplied image is the existing plain white Cadet and is the identity, silhouette, body proportion and pose reference. Redesign THIS white cadet with a clean, crisp line-art-informed pixel-game aesthetic. Keep the small smooth rounded white head, plain faceless expression, simple white torso, white arms and legs, short white boots, and the original slender compact body. About 3.3 heads tall. It must immediately read as the same plain white station minion, now more deliberately drawn. Use broad uncluttered ivory-white and cool light-grey panels, very thin consistent slate-grey contour and panel lines, a few dark grey flexible joints, restrained cool grey dimensional shading. A tiny pale-cyan horizontal visor slit is the only luminous accent; it sits directly within the white face, NOT in a large black faceplate. Reduce visual noise: no weathering, scratches, rust, brass, exposed machinery, tactical armor, bulky shoulders, utility belt, weapons, chest symbols, text or extra attachments. Clean rounded chamfers with precise geometric seams; matte finish, no glossy chrome. The white surfaces should make up roughly eighty percent of the body. Calm, slightly uncanny utilitarian humanoid rather than a toy or cartoon mascot. Preserve the existing cadet's proportions and readable gaps between its two arms, torso and two legs. High top-down overhead oblique camera, facing south toward viewer, shoulders perfectly level, neutral standing pose, both feet planted on the same baseline. One complete centered figure on genuinely transparent alpha, generous empty margins, no floor, cast shadow, glow outside the silhouette, room, props or painted checkerboard. Crisp edges and clear simple forms that remain legible at 17 pixels tall in the game. This character establishes the new clean white / graphite / restrained cyan material language for later station texture work.

## Final face edit

Use case: precise-object-edit. Edit the supplied clean white StarNet cadet design. Make exactly one change: remove the cyan horizontal visor completely and replace that entire visor area with the same smooth uninterrupted matte white surface and soft dimensional shading as the surrounding face. The face must be totally blank, with no eyes, mouth, visor, sensor, markings, indentation, badge, or glowing accents. Preserve the oval head shape, the entire white-and-cool-grey body, thin slate panel lines, pose, proportions, scale, pixel-game line aesthetic, camera and genuinely transparent alpha background exactly. Do not add anything. This is a plain faceless white minion with a clean modern line aesthetic.

## Alpha correction

Use case: background-extraction. Extract the ONE white faceless character from this image onto a genuinely transparent alpha background. The gray checkerboard is unwanted painted background: remove ALL of it, including between the arms and body and between the legs. The output background must have alpha=0, not gray pixels, not a checkerboard picture, not solid black or white. Preserve ONLY the character's opaque white and grey body and dark outline. Keep its completely blank white face, pose, proportions, sharp panel lines and body colors unchanged. No visor, eyes, mouth, logos, shadows or extra details. Full figure centered, generous transparent margins. Produce a usable transparent game sprite PNG.

## PixelLab directional character

Character `5bf9146e-4013-42ec-b6a4-680e75139e24`, humanoid, v3 reference, eight directions, 96px high top-down. The reference body is 64px tall on a transparent 96px canvas. Reference mode uses the supplied style and ignores outline/detail hints.

The SAME clean, plain-white faceless minion in the reference. Slim compact humanoid, smooth completely blank white oval head with NO eyes, NO mouth, NO visor or face markings in any direction. Broad simple matte ivory-white shell panels, precise thin slate-grey contour and panel lines, restrained light-grey shading, a few dark-grey joints. Plain uncluttered white torso, white arms and legs, short white boots. No weathering, grime, metal texture, color accents, lights, antennae, helmet attachments or tactical armor. Keep the original reference's body build and head size exactly; distinguish back view by its plain back shell, not a face. Crisp clean pixel-game line aesthetic. High top-down station camera.

Walking: `walking-8-frames` template for all eight directions, named `walk`, group `28e342a1-c46b-4da2-a414-78783df8ab89`.

## Seated state

State `02a00d5b-cc01-4d8b-ab3a-538633562f1e`, named `Seated`, preserving the reference palette.

Keep this exact clean plain-white minion, with its completely blank white oval face: NO visor, eyes, mouth, markings, light, color accents or face panel. Preserve the same head size, white shell panels, thin slate-grey lines and dark-grey joints. Sit upright on an invisible station chair, knees bent ninety degrees and short boots forward, hands slightly forward ready to type at an invisible workstation. Keep the original body width and camera for each view. Only bend the arms and legs into the sitting pose. No chair, keyboard, table, ground, shadow or equipment. Transparent alpha background, crisp clean lines and simple shading; no weathering or mechanical detail.

## Typing

PixelLab v3 custom, four generated frames plus a reference, all four cardinal directions, `typing`, group `cb5c1a2e-9837-4aea-a4b4-7dec76374b05`.

The SAME plain white faceless cadet sits and types quietly on an invisible workstation keyboard. Keep the completely blank uninterrupted white oval face: no eyes, visor, mouth, sensors or markings in any frame. Preserve the white shell panels, thin grey seams, simple shading, original head size and body build. Keep the torso, head, hips and feet steady in the seated pose; only small alternating hand and forearm movements. No chair, table, keyboard, objects, ground, shadow, effects, colors or added details. Transparent alpha background. Seamless small typing loop.
