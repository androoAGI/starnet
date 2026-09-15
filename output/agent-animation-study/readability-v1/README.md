# Secret Agent readability comparison

One revised south-facing standing pose, generated with built-in ImageGen from the previous industrial Secret Agent. Source: exec-028aed27-90b9-4e19-b9a3-17a17ee4fe63.png (copied as source.png).

Intent: retain slim adult proportions and 18-world-pixel body height, enlarge facial/hand features modestly, use broad matte charcoal planes and readable lapels instead of fine noisy texture. No new animation tracks are claimed.

Packing: crop generated alpha bounds, uniformly resize to 76px high, center on 144x144 transparent canvas at y36 (feet112). Revised width34 versus previous31; world widths8.05 versus7.34, both heights18. No horizontal stretch.

The existing real seeded StarNet dev entry now loads an isolated snapshot of app/world.js with a render-only comparison pair. These mannequins are not roster members and do not produce activity or work events. They enter the actual entity depth pass, use the same sampled local light, and share the same floor line. Normal camera2x and close camera4x affect the entire station equally. User pan/zoom remains available. No production world.js changes.

Live proof: both actual tracks drawn (industrial_secretagent.rot.south and readability_secretagent.rot.south), comparison=drawn, normal zoom2 and close zoom4. Visually checked against live desks/chairs, aligned feet and head heights. Browser error log empty. Normal five-agent roster retained.

Build helpers: ../build-readability.cjs packs the artwork; ../wire-readability.cjs recreates the isolated world snapshot and entry wiring. Website mirror includes all runtime assets.
