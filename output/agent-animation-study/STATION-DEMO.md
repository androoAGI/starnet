# Industrial crew inside StarNet

Open `http://127.0.0.1:18814/agent-station-demo.html?propSet=projection` with this worktree's `node dev/seed.js --keep` server.

This is the full StarNet application, with its real seeded roster, movement, collision, furniture, camera and lighting. NOVA wears Ultron; four ordinary development specialists wear Skeleton, Plague Doctor, Secret Agent and Void Wizard. No work events are fabricated. This page creates missing demo specialists in this worktree's development scratch save only.

The demo has its own sprite manifest and renderer copy. The production entry page and original skin PNGs are unchanged. All 795 generated frames are mechanically placed on 144px transparent canvases with a stable per-direction standing anchor. Walking selects the eight animation frames, excluding the extra reference pose. Furniture uses the final seated pose, rather than repeatedly playing the sit-down transition. North-facing typing is available when the actual station state requests it. Idle and sit-down source sequences remain available in the separate frame review.

Default body height is 18 world pixels. The actual old Secret Agent is 41 × 0.404 = 16.564 pixels, so this is 8.67% taller. The previous standalone review used an incorrect 2/3 comparison scale. The height slider preserves aspect ratio; it does not stretch legs or narrow bodies.

Station artwork and its rendering modules were copied read-only from the `prop-coordination-0914` worktree on September 14. These are isolated snapshots under `frontend/agent-demo`, mirrored into `website/app`. Only the required remaster, calibration, approved-sheet and projection-correction asset packs were imported. Run `build-station-demo.cjs` to repack from those source lanes; it does not generate new artwork.

Live checks: all five roster entries survived reload; all five sprites visibly walked in the actual station; cinema view, follow-camera and height slider worked; browser error log was empty. No paid agent task was launched. This is an art evaluation demo, not a claim that every candidate animation has been finalized for shipping.

Validation: HTTP gate passed all 114 steps. The final full fast run passed its first 718 steps, then correctly caught five unregistered portrait PNGs. After adding those manifest entries, all remaining 61 steps plus the website mirror check passed (62 steps in `demo-test-completion.log`). All 779 fast checks therefore passed across the run and focused completion; a fresh uninterrupted full run was not repeated. The claims audit passed 64 assertions. Its Git blob reader now batches by byte size, preserving all checks while avoiding buffer overflow on the larger artwork pack. Runtime manifest validation found 145 industrial tracks, 675 selected runtime frames, uniform 144px RGBA canvases and zero missing files; all 795 generated source frames remain available.
