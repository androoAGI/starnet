# Satin cadets and normal station pace

The five cadets retain 19 px standing height and the previous front silhouette dimensions (silver differs by one source pixel, 0.25 world px). Built-in ImageGen edits reduce specular hotspots and anatomical shading. `front-prompts.json` records the front edits; `rotation-repair-prompt.json` records the blue/red rotation cleanup. Sources are saved here, with alpha preserved. Crop, resize and atlas packing are mechanical.

PixelLab supplies eight rotations and motion frames. `full-motion/<skin>/rotation.json` and `jobs/` retain provenance. The blue/red repair sheets remove accidental eye dots and mechanical seams; their front frames remain the original revised fronts. `pack-rotation-repairs.cjs` extracts equal cells and preserves each existing rotation's width and 76 source-pixel height.

`run-motion.mjs` runs in the tool orchestration environment, not Node. It resumes durable jobs, uses at most ten concurrent generations, and requires north seating before typing. Do not run two schedulers. Walking pins the neutral ending; the exact original input is selected as the last frame to avoid endpoint artifacts. Reset requests retain superseded jobs in history.

After generation stops: run `fix-loop-boundaries.cjs --select`, then `pack-walk-repairs.cjs --select`, `validate-stage.cjs`, and `contact.cjs <skin>` for all five. The second selection step is essential: 20 diagonal tracks and three front tracks use the edited sheets recorded in `walk-repairs.json`. The crop bounds ignore isolated alpha specks so no frame unexpectedly shrinks. Visually review all selected frames before writing review.json and running `publish.cjs`. Publication updates frontend and website mirrors together and preserves unrelated skins.

All 65 motion jobs completed, with 400 selected cadet frames. `walk-repair-prompts.json` and `front-walk-repair-prompts.json` record built-in ImageGen edits correcting torso-facing drift and stray wrist markings. A requested optional narrowing of the silver seated knees was rejected by output moderation; its existing complete seated/typing set remains selected, as recorded in `seat-refinement-unavailable.json`. Do not reroute that rejected edit through another generator.

The station pace fix removes the unintended sprite-height multiplier from travel speed and avoids applying turn alignment twice. Distance still drives gait phase; sharp turns plant the feet. `test-pace.cjs` checks all 38 skins at normal cruise speed and the existing motion regression checks facing, pauses and speech grounding.
