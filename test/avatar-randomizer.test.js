/* node test/avatar-randomizer.test.js — Recruitment Bay avatar randomization behavior + wiring. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'); const path = require('path');
const AvatarRandomizer = require('../frontend/app/avatar-randomizer.js');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('frontend/app/app.js');
const mkt = read('frontend/app/marketplace.js');
const html = read('frontend/index.html');

A.eq(AvatarRandomizer.pick(['bear', 'robot', 'alien'], ['bear'], () => 0), 'robot',
  'randomization chooses from unused skins when at least one is available');
A.eq(AvatarRandomizer.pick(['bear', 'robot', 'alien'], ['bear'], () => 0.999), 'alien',
  'the complete unused pool is reachable');
A.eq(AvatarRandomizer.pick(['bear', 'robot'], ['bear', 'robot'], () => 0), 'bear',
  'when every skin is used, randomization falls back to the full valid catalog');
A.eq(AvatarRandomizer.pick(['bear', 'robot'], ['bear', 'robot'], () => 0.999), 'robot',
  'the complete fallback pool is reachable');
A.eq(AvatarRandomizer.pick([], ['bear'], () => 0.5), null,
  'an empty skin catalog fails closed without inventing an avatar');
A.eq(AvatarRandomizer.pick(['bear', 'bear', 'robot'], [], () => 0.999), 'robot',
  'duplicate catalog entries do not distort selection');
A.eq(AvatarRandomizer.pick(['bear', 'robot'], [], () => NaN), 'bear',
  'an invalid random value safely selects the first candidate');

A.ok(html.indexOf('app/avatar-randomizer.js') < html.indexOf('app/marketplace.js'),
  'the pure randomizer loads before the Recruitment Bay');
A.ok(/usedSkins:\s*\(\)\s*=>\s*liveAgents\(\)\.map/.test(app),
  'the Recruitment Bay receives used skins from the live crew registry');
A.ok(/class="bb sm mkt-randomize-skin"/.test(mkt),
  'the Appearance panel renders a randomize button');
A.ok(/AvatarRandomizer\.pick\(ids, used, Math\.random\)/.test(mkt),
  'the button delegates selection to the tested unused-first helper');
A.ok(/pickedSummonSkin\s*=\s*next/.test(mkt) && /showSkin\(next\)/.test(mkt),
  'randomization updates both the summon payload state and live preview');

A.report('avatar-randomizer.test');