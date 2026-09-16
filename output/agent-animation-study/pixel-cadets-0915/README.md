# Approved pixel cadet family

The user approved the silver and green fronts in `../chrome-cadets-0915/pixel-revision/`, then requested the remaining colors and complete animation frames. This batch replaces only `android`, `blank_blue`, `blank_green`, `blank_red`, and `blank_amber`. The earlier smooth chrome batch remains paused and must not be published.

The front artwork was generated/edited with built-in ImageGen. Blue, red and amber use the approved green front as the edit reference; `front-prompts.json` records that palette-only request. The earlier approved source prompts remain in the pixel-revision folder. PixelLab V3 produces eight directions from the normalized approved fronts. PixMiniMax generates the walk, sitting and typing poses from those exact directional inputs; job records preserve descriptions and source paths.

Runtime geometry remains 19 px standing height: 76 px visible source height, 144×144 master canvas, feet at source y=112. Frames are packed without independent per-frame resizing so motion does not breathe in size. The existing distance-driven stride, facing and planted-foot speech behavior is retained.

`run-motion.mjs` runs inside the functions tool environment, not Node. It resumes durable jobs, limits service concurrency, and consumes `reset-requests.json` for individual corrections. Do not run multiple schedulers. `queue-diagonal-fix.cjs` requests a fixed final pose for a drifting diagonal. `contact.cjs` creates review sheets: rotations, eight walk rows, four sitting poses, then four typing frames.

Before publishing: run `validate-stage.cjs`, visually review every selected frame and write the per-character `review.json` records. `publish.cjs` requires those records and installs the complete five-color family into both frontend and website/app. The live preview's **Cadet colors** button selects all five.

Verification commands:

```
node output/agent-animation-study/pixel-cadets-0915/validate-stage.cjs
node output/agent-animation-study/validate-catalog.cjs --final
node output/agent-animation-study/validate-motion-inputs.cjs --final
node output/agent-animation-study/motion-polish-19px/test-motion.cjs
npm run test:fast
```

Live verification belongs in the seeded station at http://127.0.0.1:18814/agent-station-demo.html?propSet=projection after publishing and reloading. Generation completion alone is not live proof.
