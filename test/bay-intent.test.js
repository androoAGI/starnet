/* node test/bay-intent.test.js — EVERY DOOR INTO THE BAY NAMES ITS INTENT (wave-1 comms-owner-arbiter, gh#117).

   gh#117 (v0.13.3, macOS): "I've built an additional desk and computer, but when I open Recruitment Bay to create another agent,
   the only available option is 'DEPLOY TO SKYNET.' Underneath, it says 're-specs SKYNET instead — no new crew member.'"
   The bay (marketplace.js) is opened by several doors, and each picked its own mode from a bag of flags (mode / tab / summon);
   the nameplate ignored the mode, so a class list that could only re-spec still read RECRUITMENT BAY (audit: "The Recruitment Bay
   title ignores mode"). Now Marketplace.open takes an intent, one frozen table (Marketplace.INTENTS) decides the mode, the tab and
   whether the bay recruits, and the nameplate follows what the view can do:
     1. the table: recruit → pick + summon on the class list; the recipe doors → the MY WORK library; respec → deploy on the classes;
     2. a context without an intent (an older caller) is read the old way and held to the same table;
     3. the nameplate: RECRUITMENT BAY only where the bay can recruit; MY WORK on the library; CLASSES on a re-spec-only list —
        never RECRUITMENT BAY over a view whose only key re-specs the agent you have;
     4. every Marketplace.open call in frontend/ names a known intent, and the CREW › RECRUIT door names 'recruit'.
   The live bay (RECRUIT key on screen, titles per door) is proven in test/comms-owner.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const ctx = vm.createContext({ console });
vm.runInContext(read('frontend/app/marketplace.js') + '\nthis.Marketplace = Marketplace;', ctx);
const M = ctx.Marketplace;
const plain = o => (o === undefined ? null : JSON.parse(JSON.stringify(o)));

/* ---------- 1. the table ---------- */
A.ok(M && M.INTENTS && typeof M.intentOf === 'function' && typeof M.titleFor === 'function', 'Marketplace exports its door intents (INTENTS, intentOf, titleFor)');
const T = M.INTENTS || {};
A.eq(Object.keys(T).sort(), ['first-value', 'recipe-launch', 'recipe-mint', 'recipes', 'recruit', 'respec'], 'six intents');
A.eq(plain(T.recruit), { mode: 'pick', tab: 'agents', summon: true }, 'recruit: the class list in RECRUIT mode');
for (const k of ['recipes', 'recipe-launch', 'recipe-mint', 'first-value']) A.eq(plain(T[k]), { mode: 'deploy', tab: 'recipes', summon: false }, k + ': the MY WORK recipe library');
A.eq(plain(T.respec), { mode: 'deploy', tab: 'agents', summon: false }, 'respec: the class list in RE-SPEC mode');
A.ok(Object.isFrozen(T) && Object.isFrozen(T.recruit), 'the table is frozen');

/* ---------- 2. legacy contexts are read the old way ---------- */
if (M.intentOf) {
  A.eq(M.intentOf({ intent: 'recruit', mode: 'deploy' }), 'recruit', 'a named intent wins over a stray flag');
  A.eq(M.intentOf({ intent: 'nonsense', mode: 'pick' }), 'recruit', 'an unknown intent falls back to the flags');
  A.eq(M.intentOf({ mode: 'pick', summon: true }), 'recruit', 'legacy pick → recruit');
  A.eq(M.intentOf({ mode: 'deploy', tab: 'recipes' }), 'recipes', 'legacy deploy + recipes tab → recipes');
  A.eq(M.intentOf({ tab: 'recipes', firstValue: {} }), 'first-value', 'legacy first-value form');
  A.eq(M.intentOf({ mode: 'deploy', tab: 'recipes', launchSeed: { id: 'x' } }), 'recipe-launch', 'legacy launch seed');
  A.eq(M.intentOf({ mode: 'deploy', tab: 'recipes', recipeMint: {} }), 'recipe-mint', 'legacy bottle editor');
  A.eq(M.intentOf({ mode: 'deploy' }), 'respec', 'legacy deploy on the classes → respec');
  A.eq(M.intentOf(null), 'respec', 'no context → respec (the class list, honestly titled)');
}

/* ---------- 3. the nameplate follows what the view can do ---------- */
if (M.titleFor) {
  A.eq(M.titleFor({ mode: 'pick', summon: true }, 'agents', true), 'RECRUITMENT BAY', 'the recruit door’s bay is the RECRUITMENT BAY');
  A.eq(M.titleFor({ mode: 'deploy' }, 'agents', true), 'CLASSES', 'gh#117: a class list that can only re-spec is never titled RECRUITMENT BAY');
  A.eq(M.titleFor({ mode: 'deploy' }, 'recipes', true), 'MY WORK', 'the recipe library wears its dock button’s name (LABEL LAW)');
  A.eq(M.titleFor({ mode: 'deploy', tab: 'recipes' }, 'agents', false), 'CLASSES', 'a recipe door whose library did not load lands on the class list — still never RECRUITMENT BAY');
  A.eq(M.titleFor({ mode: 'pick' }, 'agents', true), 'CLASSES', 'a pick list that does not recruit (no summon) is not the RECRUITMENT BAY either');
}

/* ---------- 4. every door names a known intent ---------- */
{
  const files = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); } })(path.join(ROOT, 'frontend'));
  const doors = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel === 'frontend/app/marketplace.js') continue;
    const src = fs.readFileSync(f, 'utf8');
    const re = /\bMarketplace\.open\(\{/g; let m;
    while ((m = re.exec(src))) doors.push({ file: rel, line: src.slice(0, m.index).split('\n').length, head: src.slice(m.index, m.index + 260) });
  }
  A.ok(doors.length >= 5, 'the scan finds the bay’s doors (' + doors.length + ')');
  for (const d of doors) {
    const im = /\bintent\s*:\s*(?:'([a-z-]+)'|\(startTab === 'recipes'\) \? 'recipes' : 'respec')/.exec(d.head);
    A.ok(!!im && (!im[1] || !!T[im[1]]), d.file + ':' + d.line + ' names a known intent');
  }
  const app = read('frontend/app/app.js');
  const recruitDoor = A.fnBody(app, '  function openSummonBayWith(classSeed) {');
  A.ok(/intent: 'recruit'/.test(recruitDoor), 'the CREW › RECRUIT door (openSummonBay → openSummonBayWith) opens the bay with intent: recruit');
  // sliced from the function that wires it (enterGame), never a match anywhere in app.js (review 10-27)
  const wiring = A.fnBody(app, '  function enterGame(opts) {');
  A.ok(wiring.length > 1000 && wiring.length < app.length / 2, 'app.js enterGame (the floor wiring) sliced');
  A.ok(/bbRecruit\.onclick = openSummonBay;/.test(wiring), 'and #bb-recruit is that door (wired as the floor comes up)');
}

A.report('bay-intent');
