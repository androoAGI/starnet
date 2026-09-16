'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const Plan = require('../frontend/js/sprite-load-plan.js');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'frontend', 'assets', 'sprites', 'manifest.json'), 'utf8'));
const grouped = Plan.groupTracks(manifest.sprites);
const all = Object.entries(manifest.sprites);
const planned = Object.values(grouped).flat();
const initial = Plan.initialTracks(grouped, ['blank', 'ultron', 'blank']);
const totalFrames = Plan.frameCount(all);
const initialFrames = Plan.frameCount(initial);
const loaderSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'assets.js'), 'utf8');
const worldSource = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'world.js'), 'utf8');
const appHtml = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');

A.eq(planned.length, all.length, 'every valid manifest track belongs to exactly one set');
A.ok(grouped.blank && grouped.ultron, 'default skin and station leader have loadable sets');
A.eq(initial.length, grouped.blank.length + grouped.ultron.length, 'startup plan de-duplicates requested sets');
A.ok(initialFrames > 0 && initialFrames < totalFrames * 0.12, 'startup fetches less than twelve percent of sprite frames');
A.ok(totalFrames > 3000, 'budget assertion covers the expanded production manifest rather than a fixture');
A.eq(Plan.groupTracks({ broken: 'not-an-array', 'valid.rot.south': ['valid.png'] }),
  { valid: [['valid.rot.south', ['valid.png']]] }, 'malformed tracks cannot crash or pollute a load plan');
A.ok(/tracksBySet = SpriteLoadPlan\.groupTracks\(man\.sprites\)/.test(loaderSource), 'runtime uses the tested manifest planner');
A.ok(/primeTrack = defSet \+ '\.rot\.south'/.test(loaderSource) && /await loadTrack\(primeTrack, primePaths\)/.test(loaderSource),
  'runtime prioritizes one renderable default pose before the full animation set');
A.ok(/Promise\.all\(\[loadSet\(defSet\), loadSet\(leaderSet\)\]\)/.test(loaderSource), 'full default and selected station-leader sets continue warming in the background');
A.ok(/SPRITES\.loading/.test(worldSource) && /get loading\(\)/.test(loaderSource),
  'the world suppresses the procedural body only while the real startup skin is actively loading');
A.ok(/assets\/sprites\/approved_android\/rot_south\.png/.test(appHtml) && /fetchpriority="high"/.test(appHtml),
  'the default first-paint pose is preloaded at high priority');
A.ok(/if \(!loadedSets\.has\(set\)\) \{ loadSet\(set\); return null; \}/.test(loaderSource), 'an unseen skin starts one lazy load and renders the honest fallback meanwhile');

// COLD-START RACE: enterGame intentionally does not await SPRITES.init() before World.start(), so the first
// paint can request every persisted crew skin while manifest.json is still in flight. The old loader started
// and memoized an empty job at that point. Default/maintainer art loaded because init explicitly requests it
// after planning; existing non-default agents stayed on the tiny fallback forever, while changing to a new skin
// after boot worked immediately. Pre-plan and missing-plan lookups must return before setJobs can be consulted or
// populated, leaving the next animation frame free to retry against the completed manifest.
const loadSetBody = (/function loadSet\(set\)\s*\{([\s\S]*?)\n  \}/.exec(loaderSource) || [])[1] || '';
A.ok(/let tracksBySet = null/.test(loaderSource), 'uninitialized tracks are distinct from a planned empty manifest');
const readyGuard = loadSetBody.indexOf('if (!tracksBySet) return Promise.resolve(false)');
const trackGuard = loadSetBody.indexOf('if (!tracks.length) return Promise.resolve(false)');
const memoLookup = loadSetBody.indexOf('if (setJobs[key]) return setJobs[key]');
A.ok(readyGuard >= 0 && trackGuard > readyGuard && memoLookup > trackGuard,
  'pre-manifest and missing-set requests return before memoization, so cold-start crew skins can retry');

A.report('sprite-loading.test');
