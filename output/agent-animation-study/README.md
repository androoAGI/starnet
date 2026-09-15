# Industrial A crew animation study

Review URL: http://127.0.0.1:18814/agent-motion-review.html

Scope: Ultron, Skeleton, Plague Doctor, Secret Agent and Void Wizard from the latest Industrial A concept board. This is a separate visual review, not a production skin replacement or evidence of live agent activity.

The original concept artwork is `../agent-style-studies/industrial-set-02-v2.png`. The built-in image_gen tool extracted its transparent background; `source-alpha.png` preserves that returned artwork. `prepare.cjs` only slices the five separated figures and fits each, without changing aspect ratio, to a 96px reference canvas. PixelLab v3 rotates those exact references; PixelLab template and v3 animation tools generate the motion tracks. Per-job JSON files preserve requests and receipts. `characters.json` preserves character IDs and initial provenance; `frame-urls.json` records returned frame URLs.

Station assets are copied read-only from the other station task: approved-sheet consolebank, crate and monstera from `C:/Users/andro/gen-trees/prop-coordination-0914/frontend/assets/industrial/approved-sheet/`, and its remaster plate floor. The alternate bridge backdrop is the original room reference from `C:/Users/andro/gen-trees/industrial-textures-0912/docs/station-remaster/bridge-reference.png`. These are actual artwork inputs; this preview room is a comparison layout, not a claim that these skins are integrated in the production station.

Default visible character height is approximately 8% above the original Secret Agent's visible height at its existing 2/3 draw scale, rounded to a whole pixel. All candidates retain their source aspect ratio. The preview uses smooth downscaling at game scale, nearest-neighbor enlargement for the close-up, and stable directional reference anchors with offsets for larger padded animation canvases. No per-frame fitting stretches or hides motion.

Use the agent, motion and direction controls to inspect tracks. Pause, step or click an individual frame. Height changes the character-to-environment ratio; zoom changes the whole scene. The original skin remains visible beside the new crew in the texture-room view. A missing track is explicitly shown as missing, with labeled standing fallbacks in the scene.

`sync-frames.cjs` downloads returned frames and builds the local preview manifest. `verify-frames.cjs` checks decoding, nonempty alpha, canvas-edge clipping and distinct images within animation tracks; it writes `frame-validation.json`. Those checks do not replace visual animation review.
