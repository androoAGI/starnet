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
