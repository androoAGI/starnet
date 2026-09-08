# Approved foundation: world immersion

The owner approved the restored station preview at localhost:9207 and requested a major
improvement in depth, lighting, immersion and characters while retaining its pixel style.
The separate New Horizon experiment remains removed. This work continues the approved
station in agent/world-next-0907; it does not restart the rejected art direction.

Scope: existing deck and wall identities gain dimensional pixel details, actual fixtures
gain penumbra and restrained atmospheric light, and existing crew sprites respond to the
same current-frame light with foot-anchored idle breathing. Geometry, saved layout,
navigation, work signals and furniture pose tracks remain authoritative.

Acceptance: compare normal and cinema views in the running saved station, inspect crew
at close range, measure rendering costs, exercise reduced motion and canvas recovery,
and run the full fast gate after mirroring the frontend. Unit tests alone do not establish
visual quality. Capture artifacts live in .uishots-immersion-before/after locally.

Live checkpoint: the combined material, fixture and crew pass opened with all three
existing crew and 44 props, an online event connection, 42 actual light sources and
zero dropped sources. The browser reported no uncaught exceptions. Reduced-motion
emulation reached the production preference branch. REFIT opened and closed; clearing
the cached station artwork triggered one successful watchdog recovery. Reloading kept
the exact saved rooms/props/belts and routing/capability signature (7bd65e5f prefix).

The CRT pass now uses less additive fade, chromatic separation and grain so the existing
pixel art remains legible. Its development preset reads the canonical renderer values.
Crew and furniture lighting cache sizes are exposed in the renderer's read-only stats;
they are measured counts, never an inferred performance claim.

Furniture uses the same current light sample for a native-pixel, inward highlight and
restrained directional tint. It overlays the original draw in its existing depth slot.
Only 35 rigid silhouettes are eligible; cargo stacks, bedding and other state-dependent
shapes are excluded. Mounted props keep their existing height. The response cache is
capped at 96 entries and 1 MiB, and invalid/lost surfaces fall back to the original art.

Final visual checkpoint: all 42 sources remain active, four physical wall fixtures provide
shafts, and the furniture pass uses 18 cached overlays (265,344 bytes). Across the normal,
cinema and crew captures it reused overlays for 4,225 draws without an allocation failure.
The normal 120-frame headless sample measured 21.1 ms median rendering versus the earlier
20.7 ms baseline; these are software-browser observations, not a hardware frame-rate claim.
The final live editor, reduced-motion, cached-bake recovery and reload checks passed again.
Review caught and corrected a classic-mode shadow fallback: native body rendering remains
active whenever no replacement light sample is available.

Final gate: npm run test:fast passed all 736 steps on the corrected source. The classic
browser check recorded 174 native body draws and 1,950 shadow ellipses with no replacement
appearance argument and no exceptions. Website mirror synchronization is complete.

## Wall balance and sharpening follow-up

The owner requested softer wall shading, a slight brightness correction, and sharpening.
World II wall/floor shade now uses one bounded coverage field rather than stacked edge,
cast and corner bands. At the current settings the north-wall falloff starts around 24%
and corners around 27%, with a 34% maximum. Broad wall bands use lighter existing palette
tones; narrow contact rows remain. Native pixel falloff stays consistent across bake chunks.

A .28 edge-detail pass runs before CRT grain/scanlines, on both GPU and CPU paths. It skips
quiet gradients and clamps each result to existing neighboring colors to avoid halos.
Channel separation is zero at the new default; fixture gain moves only from .82 to .79.
The normal live sample measured 17.8 ms median rendering against the new turn's 18.3 ms
baseline, with no exceptions. Forced GPU loss kept the actual station lit on the CPU path.
An independent real-WebGL check matched GPU/CPU output within 1/255 across 33 cases and
13,635 color-channel comparisons, including curve off/on, borders, colors and quiet fields.

The owner's circled screenshot identified a different defect: the raised wall receiver
was included in the heavy floor ambient, while floor-plane visibility prevented lights
from reaching it. The resulting black stripe was composited over foreground prop tops.
WorldLight now intersects only that heavy ambient with the physical deck footprint in
both the exact-path and mask/chunk branches. The shared receiver stays intact. A live
close-up confirms readable wall panels and cabinet tops with no broad black overlay.
The actual-Canvas regression failed before the fix and passed after: raised-wall alpha
179 -> 41, while deck alpha stays 179 and falls to 89 under its source. It covers a prop
crossing the boundary, empty space, clipped corners and matching chunk boundaries.

The corrected wall source passed the full 738-step fast gate. Live refit, cached-canvas
recovery, reduced motion and reload also passed against the owner's updated 46-prop save.

The owner then requested a darker faded-film finish while retaining the lighting. A .18
source-over matte (#121418) now compresses highlights and midtones toward a slightly lifted
black, followed by .05 fine grain. This common screen pass follows both GPU/CPU warps and
adds no texture allocation. Reduced motion freezes the grain phase. The film is adjustable
in the existing CRT lab and its Clean preset resets it to zero. Live normal/cinema/crew
captures confirm the darker finish retains the corrected wall and equipment readability.

The owner found that matte finish too foggy. The current default removes the gray black
lift and additive fade entirely, and disables the full-frame blurred bloom. A .28 density
curve mixes each pixel with its squared color at the same coordinates, deepening mids
without tint, blur, raised blacks or dimming full-white emitters. Fine grain stays at .05;
physical room/prop lighting, wall receiver correction and .28 sharpening are unchanged.
Normal and close-up live captures confirm readable cabinet tops, darker shadows and clear
screen details, with fade/bloom both zero in the running renderer.
