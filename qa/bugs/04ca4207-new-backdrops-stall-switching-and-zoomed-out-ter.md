---
fingerprint: 04ca4207
slug: new-backdrops-stall-switching-and-zoomed-out-ter
title: New backdrops stall switching and zoomed-out terrain rendering
surface: world
severity: P1
status: fixed
found: 2026-09-11
lane: agent/backdrop-performance-0910
fix: 2c041bbe69124eda1f60a6eb5a11cc44676028cb
origin: owner
report: Owner reports the new backdrops make StarNet laggy
affected: a625182bd; exact owner artifact not supplied
family: backdrop-performance
installer: verified
installerVersion: 0.11.2 canary
installerSha256: 7c4170b3a4d95f51f0880083f697a356bf9b66677b8a962a1994084c765aa363
installerEvidence: qa/evidence/backdrop-performance-0911/installed-smoke.json and installed-live.json plus installed-4k.json, installed-minzoom.json and installed-recovery.json; exact clean source 2c041bbe6, installed executable f533b788e08656fa694e053b6bbb4a352cf357b066344e6cd54b6f9cf2121ca7; isolated Windows canary, not a public release.
recovery: unconfirmed
---

# New backdrops stall switching and zoomed-out terrain rendering

## Symptom

The owner reports lag after selecting the refreshed backdrops. Large scenes can freeze interaction while loading, and zoomed-out ground scenery can make camera movement sluggish.

## Repro

1. Launch an isolated seeded station with `node dev/seed.js --keep` and open Cinema at 1920×1080 or 3840×2160.
2. Select Ocean, Night City, Moon and Forest through Appearance; drag and zoom the camera.
3. Profile the shared `SpaceBG.draw` and `Terrain.draw` calls with the world's actual `imageSmoothingEnabled=false` setting. Separate cold build, warm submission, final GPU readback and whole-app frame intervals.
4. Repeat with `scripts/qa/backdrop-performance-live.mjs` against its CDP port. This drives real Appearance, Cinema, drag and wheel controls and records pixels and runtime errors.

## Evidence

Before repair, the live seeded renderer's corrected nearest-neighbour benchmark measured 4K City cold build 3798 ms and Ocean 6364 ms. Forest at scale 0.3 took 56.2 ms median / 61.1 ms p95 per draw at 1080p and 236.5 / 257.8 ms at 4K. The earlier default-smoothing probe is retained separately and is not the world-mode baseline. Raw local evidence: `.dogfood/backdrop-performance/before-nearest.json`, `forest-before.cpuprofile`, and the live control sweep. In `frontend/app/spacebg.js`, `rebuild` synchronously called procedural builders; `frontend/app/terrain.js` regenerated placement and drew every overlapping tree on each frame.

## Verdict

Fixed and verified in the isolated Windows canary. Bounded worker lanes build sky artwork; static world-space terrain plates are rendered off-thread and reused for camera movement. New viewport/zoom/footprint requests replace queued work, and stale replies/bitmaps are disposed. Failed or unsupported workers retain a direct compatibility path; terrain still caches its plate there. Fast 771/771, customer journeys 34/34 and visual regression 16/16 passed. All six installed scenes passed real selection, drag, zoom and cache-loss recovery, including a 4K emulated viewport. At the actual minimum UI zoom 0.5, installed 4K Forest terrain submission p95 was 0.1 ms, whole-app frame p95 8.3 ms, maximum 62.5 ms, with zero observed long tasks or render errors during the sampled drag. The owner's successful retest remains unconfirmed.

## Regression

`test/backdrop-bake.test.js` exercises the real dispatcher: cold terrain enqueues without generating sprites on the UI thread, 100 small pans require one bake and one blit each, zoom and clearing changes request new artwork, 500 requests retain only the latest queued view, and cancellation/error/timeout paths dispose resources. `test/canvas-loss-recovery.test.js` retains the source recovery contract. After repair, the same corrected renderer benchmark measured Forest p95 0.2 ms at both 1080p and 4K, with real terrain pixels present. City/Ocean 4K first draw returned within 0.4 ms while worker completion remained asynchronous; the sampled timer gap stayed at or below 18.1 ms. These are renderer/interaction-thread measurements, not a claim that every device runs the whole app at a particular frame rate.

The scale-0.3 probe is explicitly a renderer stress case below the main UI's minimum. A separate original-module scratch-canvas measurement in the same Windows WebView at the real minimum 0.5 measured Forest p95 18.4 ms at 1080p and 97.9 ms at 4K. This original module was instantiated separately; the installed application's repaired renderer was not replaced. The actual installed minimum-zoom drag is recorded independently in installed-minzoom.json. All portable receipts and their content hashes are in qa/evidence/backdrop-performance-0911/manifest.json.

## Sibling coverage

{
  "adapters": [{"target":"sky and ground worker lanes","state":"covered","test":"test/backdrop-bake.test.js","scenario":"bounded queues, cancellation, fallback and bitmap disposal","gate":"fast"}],
  "entrypoints": [{"target":"shared world and refit terrain dispatcher","state":"covered","test":"test/backdrop-bake.test.js","scenario":"cached pans, zoom and clearing invalidation","gate":"fast"},{"target":"Appearance thumbnails","state":"covered","test":"test/backdrop-preview.test.js","scenario":"worker rendering, disposal, closed dialogs and unsupported fallback","gate":"fast"}],
  "displays": [{"target":"affected owner system","state":"blocked","reason":"Exact owner backdrop/display combination and successful retest have not been supplied. Live Cinema and high-resolution renderer probes are recorded separately."},{"target":"physical Apple Silicon","state":"blocked","reason":"No physical Mac is available in this lane; compatible rendering is retained but hardware recovery is unconfirmed."}],
  "lifecycle": [{"target":"GPU/cache loss","state":"covered","test":"test/canvas-loss-recovery.test.js","scenario":"sky and terrain invalidation plus world recovery wiring","gate":"fast"},{"target":"stale async reply after scene change or cancellation","state":"covered","test":"test/backdrop-bake.test.js","scenario":"cancelled epochs and late forest reply cannot replace the selected scene","gate":"fast"}]
}
