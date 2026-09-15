# Fixed-height Secret Agent anatomy study

Preview: `http://127.0.0.1:18814/agent-proportion-review.html?propSet=projection`

The user explicitly approved the current height. All three new standing masters therefore have exactly 76 visible pixels, drawn at `18/76` in world space. Their common foot line is master row 112. Walking uses the same fixed transform; it is never fitted or resized frame by frame. Natural animation motion changes the projected silhouette slightly.

The preview uses StarNet's WorldModel, StationBake, IndustrialTextures, PropSprites, PropRemaster and SPRITES code. Desks preserve the running development save's 2×1 placement; chairs and plants use their actual one-tile footprints. The projection-correction artwork is shared with the live demo. StationBake.drawBase preserves the high-resolution floor texture at close-up zoom. The optional station-lighting pass is off initially for anatomy inspection. This is an isolated visual fixture, not fabricated agent activity.

## Assets and generation

Artwork was generated using the built-in image generation tool. PixelLab `animate_image` generated one pinned south-facing eight-frame walking cycle per candidate. The extra initial reference frame is archived but excluded from runtime loops. No full directional sets have been generated for these candidates.

- A: `a-source.png`, `a-reference.png`. Moderate build and more adult head-to-body balance. Source generation `exec-9ce7b8e4-8e18-4e6b-8040-e1bbd5bc43d6.png`.
- B: `b-source.png`, `b-reference.png`. Fuller chest, shoulders and limbs. Source generation `exec-fec82c23-6935-4da4-acf8-ac023151e7e9.png`.
- C: `c-source.png`, `c-reference.png`. Stronger overhead projection with broader shading planes. Source generation `exec-6f6428f5-cd14-4fb2-8712-f70f75a6b305.png`.

Runtime assets: `frontend/assets/agent-demo/proportions/{a,b,c}/`, mirrored into `website/app`. The source PNGs and raw animation frames are preserved here. `walk-contact.png` shows every returned frame; `validation.json` records measured silhouettes and confirms no canvas-edge clipping. All three front poses measure exactly 76px tall (18 world pixels). Widths are 29, 34 and 36 master pixels; the current candidate is 31. A changes anatomical distribution more than overall width.

## Final prompt set

Reference roles: the existing south-facing Secret Agent supplies identity; `frontend/assets/industrial/projection-correction/desk.png` supplies station camera and material context. A and C were edited using the fuller B source as an additional character reference. The first oversized-head A draft was rejected.

**A:** Create controlled variant A of the referenced Secret Agent, same identity, industrial pixel art style and final bounding height, but less stocky and more naturally proportioned adult. Shrink the entire head and hair relative to B, narrow torso and arms while preserving substantial calves and boots, shorten jacket hem so the crotch reads just below halfway down, and keep natural arm reach. Front south-facing stance under a moderate overhead orthographic RPG camera; visible crown and upper shoulder planes. Neat dark hair, sunglasses, adult jaw/nose/mouth, matte charcoal suit, white shirt and narrow tie. Crisp angular pixel clusters, restrained stepped tones, dark outlines and clear shoulder/waist/knee landmarks. No smooth rendering or microtexture. One full-body figure on genuine transparency, no objects, text or ground shadow. Final game display remains 18 world pixels.

**B:** One south-facing full-body Secret Agent game sprite, transparent background. Redraw with credible compact adult anatomy, neither slender fashion figure nor large-headed cartoon. Clear adult jaw and small nose, neat dark hair, fuller shoulders/chest/pelvis, natural elbows and hand reach, substantial boots. Overhead orthographic RPG camera with visible crown and shoulder planes and mild foreshortening. Industrial angular pixel clusters, dark contour, matte wool, broad three-value grayscale shading and restrained warm highlights. Black suit, white shirt, black tie and sunglasses. No soft rendering, painted noise, gloss, props, text, border or shadow. Final display height fixed at 18 world pixels; improve readable silhouette rather than height.

**C:** Redraw B as a believable adult industrial pixel-art RPG character viewed more noticeably from above, around 40 degrees downward, to match the desk camera. Same overall height and identity. Show the top planes of crown, shoulders and shoe toes, foreshorten face and legs naturally, eyes looking forward along the ground. Preserve adult jaw, small nose, natural torso, pelvis, arms and weight-bearing stance. Stronger angular clusters and simpler broad matte shading planes. No chibi anatomy, dwarf build, elongated thin legs, smooth rendering, noise, props, words or floor shadow. Final display stays 18 world pixels.

**Walking (all three):** One complete seamless walk-in-place cycle facing south toward viewer throughout. Fixed overhead camera. Alternate natural left/right steps and small opposing arm swings; planted feet briefly bear weight, subtle knee bends and restrained vertical motion. Maintain body proportions, head size, clothing, scale and center position. Do not turn sideways, show the back, change camera, or travel across the canvas. End matching the starting neutral south-facing pose.

These are controlled visual candidates for user evaluation. Prompted head-count ratios are art direction, not a claim of exact generated anatomical measurements.

## Verification

The complete `npm run test:fast` gate passed all 779 steps. Node syntax checks passed for the review and packing scripts. Live browser checks confirmed all four variants load, standing/walking switching, per-candidate close-ups, fixed-height metadata, pause holding the same frame across a lighting change, and the station-lighting toggle. The browser error log was empty. All 30 packed images have transparent margins and no edge clipping. No full-direction or seating revision is claimed.
