/* node test/scout.test.js — the pure scout engine (sidecar/scout.js).
   Locks the Scout lane-2 promises: decide() gates by named binding (cold/cooldown/gap/full) and alternates
   kinds; the recipe directive embeds the interests evidence + library + NONE; parseRecipe round-trips a
   well-formed draft and HARD-rejects a broken param/task template, an unknown param key, a near-duplicate,
   and a denylisted shape; NONE is a sentinel; reducers (stage/dismiss/accept/note/stampAttempt/setContext)
   are pure, capped, and dismiss-denylists so an equivalent never re-mints. Deterministic — injected now. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const S = require('../sidecar/scout.js');

const T0 = 1000000000000;
const GAP = S.MINT_MIN_GAP_MS;

const EXISTING = [
  { name: 'Morning Brief', tagline: 'Daily what-changed digest' },
  { name: 'Deep-Dive Research', tagline: 'Sourced brief on a question' }
];
const GEAR = ['dish', 'cabinet', 'notebook', 'workbench', 'studio', 'connector'];

const GOOD = [
  'NAME: Stock Radar',
  'EMOJI: ⊙',
  'TAGLINE: Watchlist movers with the why',
  'BLURB: Scans your tickers, separates noise from real moves, and briefs the drivers with sources.',
  'CATEGORY: research',
  'TAGS: research=0.8, general=0.2',
  'GEAR: dish, teleporter',
  'PARAM: tickers | Watchlist | e.g. NVDA, AMD, TSM',
  'TASK: Check {tickers} for meaningful moves today; lead with what moved and why, cite sources, skip noise.',
  'WHY: you asked about semiconductor stocks and NVDA earnings repeatedly this week'
].join('\n');

/* ---------- decide: named bindings + kind alternation ---------- */
let s = S.fresh(T0);
A.eq(S.decide(s, { now: T0, warm: false }).binding, 'cold', 'a cold station never mints');
A.eq(S.decide(s, { now: T0, warm: true }).binding, 'cooldown', 'no earned runs -> cooldown binds');
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) s = S.noteRun(s, T0);
A.ok(S.decide(s, { now: T0, warm: true }).fire, 'earned runs + warm + never-minted fires');
// stamp a mint, then the gap binds
s = S.stampAttempt(s, 'recipe', { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) s = S.noteRun(s, T0);
A.eq(S.decide(s, { now: T0 + 1, warm: true }).binding, 'gap', 'a second attempt inside the min gap is blocked');
const d1 = S.decide(s, { now: T0 + GAP + 1, warm: true });
A.ok(d1.fire, 'past the gap it fires');
A.eq(d1.kind, 'prospect', 'a tie alternates away from the last kind (last was recipe)');
// fill one kind to its OWN cap: the other kind is chosen; fill both: full binds. The caps DIFFER by kind
// (recipes 6, prospects 3), so looping on a single constant would leave the recipe shelf half empty here.
let full = s;
for (let i = 0; i < S.liveCap('prospect'); i++) full = S.stage(full, { id: 'p' + i, kind: 'prospect', draft: { name: 'x' + i }, why: 'w', fingerprint: 'fp-p' + i }, { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) full = S.noteRun(full, T0);
const d2 = S.decide(full, { now: T0 + GAP + 1, warm: true });
A.eq(d2.kind, 'recipe', 'a full prospect shelf routes the attempt to recipes');
for (let i = 0; i < S.liveCap('recipe'); i++) full = S.stage(full, { id: 'r' + i, kind: 'recipe', draft: { name: 'y' + i }, why: 'w', fingerprint: 'fp-r' + i }, { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) full = S.noteRun(full, T0);
A.eq(S.decide(full, { now: T0 + 2 * GAP + 2, warm: true }).binding, 'full', 'both shelves full -> full binds');
// the caps are PER KIND and recipes get the deeper shelf: a recipe draft is a cheap offer to skim, a
// prospect is a whole agent joining the crew, so a deep prospect queue would nag rather than help.
A.eq(S.liveCap('recipe'), 6, 'the recipe shelf holds six undecided drafts');
A.eq(S.liveCap('prospect'), 3, 'the prospect shelf stays at three');
A.eq(S.liveCap('unknown-kind'), S.MAX_LIVE, 'an unknown kind falls back to the default cap');
// a 6-deep recipe shelf must SURVIVE a save/load round-trip — normalize() used to clip on a constant
// derived from the old single cap, which would have silently dropped live drafts on the way back in.
let deep = S.fresh(T0);
for (let i = 0; i < 6; i++) deep = S.stage(deep, { id: 'd' + i, kind: 'recipe', draft: { name: 'd' + i }, why: 'w', fingerprint: 'fp-d' + i }, { now: T0 });
A.eq(S.normalize(JSON.parse(JSON.stringify(deep)), T0).staged.filter(x => x.kind === 'recipe').length, 6, 'six live recipe drafts survive normalize()');

/* ---------- lane E: COLD-START — a pushed dossier buys exactly ONE day-one recipe attempt ---------- */
let cs = S.fresh(T0);
A.eq(S.decide(cs, { now: T0, warm: false, dossierWarm: true }).binding, 'cold', 'cold-start needs at least one qualifying run (runsSinceMint 0 stays cold)');
cs = S.noteRun(cs, T0);
const csFire = S.decide(cs, { now: T0, warm: false, dossierWarm: true });
A.ok(csFire.fire, 'cold interests + a pushed dossier + one run fires the cold-start attempt');
A.eq(csFire.kind, 'recipe', 'the cold-start is forced to kind:recipe (the personalized-recipe wow moment)');
A.eq(csFire.coldStart, true, 'the decision is flagged coldStart so the ambient half can ledger + spend it');
A.eq(S.decide(cs, { now: T0, warm: false }).binding, 'cold', 'no dossier -> cold as before (back-compat)');
A.eq(S.decide(cs, { now: T0, warm: false, dossierWarm: false }).binding, 'cold', 'an empty dossier does not unlock');
// the ATTEMPT spends the one-shot — staged, rejected, and NONE alike (stampAttempt {coldStart:true})
const csSpent = S.stampAttempt(cs, 'recipe', { now: T0, coldStart: true });
A.eq(csSpent.coldStartDone, true, 'the cold-start attempt spends the one-shot');
let csAgain = S.noteRun(csSpent, T0 + 1);
A.eq(S.decide(csAgain, { now: T0 + GAP + 1, warm: false, dossierWarm: true }).binding, 'cold', 'a spent cold-start never re-fires — the normal warmth floor rules again');
// a normal (warm) attempt does NOT spend the cold-start unlock
const warmStamp = S.stampAttempt(S.fresh(T0), 'recipe', { now: T0 });
A.eq(warmStamp.coldStartDone, false, 'a normal attempt leaves the cold-start unlock intact');
// the flag survives persistence; an old save without it defaults false
A.eq(S.normalize(JSON.parse(JSON.stringify(csSpent)), T0).coldStartDone, true, 'coldStartDone round-trips normalize');
A.eq(S.normalize({ v: 1 }, T0).coldStartDone, false, 'an old save without the flag hydrates to false (back-compat)');
// a full recipe shelf blocks even the cold-start (never one past the recipe cap)
let csFull = S.noteRun(S.fresh(T0), T0);
for (let i = 0; i < S.liveCap('recipe'); i++) csFull = S.stage(csFull, { id: 'cr' + i, kind: 'recipe', draft: { name: 'z' + i }, why: 'w', fingerprint: 'fp-z' + i }, { now: T0 });
csFull = S.noteRun(csFull, T0);
A.eq(S.decide(csFull, { now: T0 + GAP + 1, warm: false, dossierWarm: true }).binding, 'full', 'a full recipe shelf binds the cold-start at full');

/* ---------- buildRecipeDirective ---------- */
const dir = S.buildRecipeDirective({
  interestsBlock: '• stock research (seen 4×) — e.g. "NVDA earnings"',
  existingRecipes: EXISTING, gearKeys: GEAR, launchedOften: ['Morning Brief']
});
A.ok(dir.indexOf('NVDA earnings') >= 0, 'the directive embeds the interest evidence');
A.ok(dir.indexOf('Deep-Dive Research') >= 0, 'the directive lists the existing library');
A.ok(/NONE/.test(dir), 'the directive offers NONE');
A.ok(dir.indexOf('Morning Brief') >= 0, 'the launch-history hint is embedded');

/* ---------- FLAGSHIP CROSS-WIRE: the direction block (open quests + north star) rides the directive ---------- */
const dirWithDirection = S.buildRecipeDirective({
  interestsBlock: '• stock research (seen 4×) — e.g. "NVDA earnings"',
  directionBlock: 'NORTH STAR: automate my weekly stock brief\nOPEN QUESTS (the Commander\'s committed next steps — advance one, never duplicate one):\n• ship the earnings-day digest',
  existingRecipes: EXISTING, gearKeys: GEAR
});
A.ok(dirWithDirection.indexOf('automate my weekly stock brief') >= 0, 'the directive embeds the north star');
A.ok(dirWithDirection.indexOf('ship the earnings-day digest') >= 0, 'the directive embeds the open quest slate');
A.ok(/never .*duplicates an open quest/i.test(dirWithDirection), 'the directive forbids duplicating an open quest');
A.ok(/advance an open quest or the north star/i.test(dirWithDirection), 'the directive invites advancing a quest/star in WHY');
// a directive with no direction (empty block) stays byte-clean — no dangling header (back-compat / cold station).
A.ok(S.buildRecipeDirective({ interestsBlock: 'x', existingRecipes: [], gearKeys: GEAR }).indexOf('CURRENT DIRECTION') < 0, 'no direction block -> no direction header');

/* ---------- parseRecipe: round-trip ---------- */
const good = S.parseRecipe(GOOD, { existingRecipes: EXISTING, gearKeys: GEAR });
A.ok(good && !good.none && good.draft, 'a well-formed reply parses to a draft');
A.eq(good.draft.name, 'Stock Radar', 'name carried');
A.eq(good.draft.category, 'research', 'category carried');
A.eq(good.draft.tags, { research: 0.8, general: 0.2 }, 'tags clamp to the real lanes');
A.eq(good.draft.gear, ['dish'], 'unknown gear keys are soft-dropped (advisory, never a reject)');
A.eq(good.draft.params.length, 1, 'params carried');
A.eq(good.draft.params[0].key, 'tickers', 'param key carried');
A.ok(good.draft.task.indexOf('{tickers}') >= 0, 'the task template carries the token');
A.eq(good.draft.source, 'scout', 'the draft is stamped as scout-born');
A.ok(/semiconductor/.test(good.why), 'the grounded WHY is carried');

/* ---------- parseRecipe: HARD rejections ---------- */
A.ok(S.parseRecipe('NONE', {}) && S.parseRecipe('NONE', {}).none, 'NONE parses to the sentinel');
A.eq(S.parseRecipe('NAME: X', {}), null, 'a partial draft is rejected');
A.eq(S.parseRecipe(GOOD.replace('{tickers}', 'the watchlist'), { existingRecipes: [], gearKeys: GEAR }), null, 'a declared param missing from the task template is rejected');
A.eq(S.parseRecipe(GOOD.replace('Check {tickers}', 'Check {tickers} in {timeframe}'), { existingRecipes: [], gearKeys: GEAR }), null, 'an undeclared {token} in the task is rejected');
A.eq(S.parseRecipe(GOOD.replace('PARAM: tickers', 'PARAM: Bad Key!'), { existingRecipes: [], gearKeys: GEAR }), null, 'an illegal param key is rejected');
const dupName = S.parseRecipe(GOOD.replace('Stock Radar', 'Morning Brief'), { existingRecipes: EXISTING, gearKeys: GEAR });
A.eq(dupName, null, 'an exact name clash with the library is rejected');
const denied = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, denylist: [S.fingerprint('Stock Radar Watchlist movers with the why')] });
A.eq(denied, null, 'a denylisted fingerprint never re-mints');
// tags fallback: garbage tags -> honest general
const noTags = S.parseRecipe(GOOD.replace('TAGS: research=0.8, general=0.2', 'TAGS: vibes=high'), { existingRecipes: [], gearKeys: GEAR });
A.eq(noTags.draft.tags, { general: 1 }, 'invalid tags degrade to general, never invented lanes');

/* ---------- parseRecipe: WHY GROUNDING (mirrors interests.parse's evidence guard) ---------- */
const CORPUS = '• stock research (seen 4×) — e.g. "NVDA earnings"\n• you asked about semiconductor stocks';
const grounded = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, grounding: CORPUS });
A.ok(grounded && grounded.draft, 'a WHY citing real evidence passes the grounding guard');
const invented = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, grounding: 'kubernetes cluster upgrades and yaml drift' });
A.eq(invented, null, 'a WHY citing NOTHING in the grounding corpus is rejected (invented pitch dies here)');
const ungated = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR });
A.ok(ungated && ungated.draft, 'no grounding corpus provided -> the guard stays off (back-compat)');

// FLAGSHIP CROSS-WIRE grounding: a WHY that cites the north star / an open quest is grounded ONLY when the
// direction block is folded into the corpus (as the index.js call site does) — proving the guard still bites.
// WHY tokens (advances/shipping/digest/quest/toward/weekly/brief/north/star) are all ABSENT from CORPUS, so the
// guard rejects it under interests/activity grounding — then passes once the direction block supplies those tokens.
const QUEST_WHY = GOOD.replace(/^WHY:.*$/m, 'WHY: this advances the shipping digest quest toward the weekly brief north star');
A.eq(S.parseRecipe(QUEST_WHY, { existingRecipes: [], gearKeys: GEAR, grounding: CORPUS }), null, 'a WHY citing a quest/star is REJECTED when only interests/activity ground it (invented-pitch guard holds)');
const DIRECTION_CORPUS = CORPUS + '\nNORTH STAR: automate my weekly stock brief\n• ship the shipping digest';
const questGrounded = S.parseRecipe(QUEST_WHY, { existingRecipes: [], gearKeys: GEAR, grounding: DIRECTION_CORPUS });
A.ok(questGrounded && questGrounded.draft, 'the same WHY passes once the direction block is in the grounding corpus');

/* ---------- reducers ---------- */
let r = S.fresh(T0);
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) r = S.noteRun(r, T0);
r = S.stage(r, { id: 'a1', kind: 'recipe', draft: good.draft, why: good.why, fingerprint: good.fingerprint }, { now: T0 });
A.eq(r.staged.length, 1, 'stage appends the item');
A.eq(r.runsSinceMint, 0, 'stage spends the cadence');
A.eq(r.lastKind, 'recipe', 'stage stamps the kind');
const afterDismiss = S.dismiss(r, 'a1', { now: T0 + 1 });
A.eq(afterDismiss.staged.length, 0, 'dismiss removes the item');
A.ok(afterDismiss.denylist.indexOf(good.fingerprint) >= 0, 'dismiss denylists the fingerprint');
const reparse = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, denylist: afterDismiss.denylist });
A.eq(reparse, null, 'the dismissed shape never re-mints (deny feeds parse)');
const afterAccept = S.accept(r, 'a1', { now: T0 + 1 });
A.eq(afterAccept.staged.length, 0, 'accept removes the item');
A.eq(afterAccept.denylist.length, 0, 'accept never denylists');
A.eq(S.dismiss(r, 'nope', { now: T0 }).staged.length, 1, 'dismissing an unknown id is a no-op');

/* ---------- ledger: every outcome recorded, capped ---------- */
let l = S.fresh(T0);
l = S.note(l, { kind: 'recipe', outcome: 'rejected', reason: 'near-duplicate of Morning Brief', title: 'Daily Digest' }, { now: T0 });
A.eq(l.ledger.length, 1, 'note appends a ledger entry');
A.eq(l.ledger[0].outcome, 'rejected', 'the outcome is recorded');
for (let i = 0; i < S.LEDGER_CAP + 10; i++) l = S.note(l, { kind: 'pass', outcome: 'none', reason: 'r' + i }, { now: T0 + i });
A.eq(l.ledger.length, S.LEDGER_CAP, 'the ledger caps FIFO');
A.eq(l.ledger[l.ledger.length - 1].reason, 'r' + (S.LEDGER_CAP + 9), 'the newest entries survive the cap');

/* ---------- context push: bounded, never trusted raw ---------- */
let cx = S.setContext(S.fresh(T0), {
  customClasses: [{ name: 'Songsmith', tagline: 'lyrics and hooks' }, { bad: true }],
  customRecipes: new Array(200).fill({ name: 'X', tagline: 'y' }),
  worksignalSummary: 'w'.repeat(500), topRecommendation: 'researcher'
}, { now: T0 });
A.eq(cx.context.customClasses.length, 1, 'malformed context rows are dropped');
A.eq(cx.context.customRecipes.length, 80, 'context lists are capped');
A.ok(cx.context.worksignalSummary.length <= 200, 'context strings are clipped');
A.eq(cx.context.topRecommendation, 'researcher', 'the recruiter top pick rides the context');

/* ---------- engagement telemetry: launch counters, capped + ranked ---------- */
let u = S.fresh(T0);
u = S.noteLaunch(u, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 });
u = S.noteLaunch(u, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 + 1 });
u = S.noteLaunch(u, { id: 'fix-bug', name: 'Fix a Bug' }, { now: T0 + 2 });
A.eq(u.usage.launches['morning-brief'].n, 2, 'repeat launches count up');
A.eq(S.topLaunched(u, 5), ['Morning Brief', 'Fix a Bug'], 'topLaunched ranks by count, ties newest-first');
A.eq(S.noteLaunch(u, { id: '' }, { now: T0 }).usage.launches['morning-brief'].n, 2, 'a bad launch record is a no-op');
let uc = S.fresh(T0);
for (let i = 0; i < S.USAGE_CAP + 8; i++) uc = S.noteLaunch(uc, { id: 'r' + i, name: 'R' + i }, { now: T0 + i });
uc = S.noteLaunch(uc, { id: 'heavy', name: 'Heavy' }, { now: T0 + 1000 });
uc = S.noteLaunch(uc, { id: 'heavy', name: 'Heavy' }, { now: T0 + 1001 });
A.ok(Object.keys(uc.usage.launches).length <= S.USAGE_CAP, 'launch counters cap at USAGE_CAP');
A.ok(!!uc.usage.launches['heavy'] && uc.usage.launches['heavy'].n === 2, 'the recent heavy hitter survives eviction and keeps its count');
// usage survives a hydrate round-trip
const ur = S.normalize(JSON.parse(JSON.stringify(u)), T0);
A.eq(ur.usage.launches['fix-bug'].n, 1, 'usage round-trips normalize');

/* ---------- outcome telemetry (lane B): rate-the-work verdicts folded per recipe ---------- */
let rt = S.fresh(T0);
rt = S.noteLaunch(rt, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 });
rt = S.noteRated(rt, { id: 'morning-brief', verdict: 'great' }, { now: T0 + 1 });
rt = S.noteRated(rt, { id: 'morning-brief', verdict: 'great' }, { now: T0 + 2 });
rt = S.noteRated(rt, { id: 'morning-brief', verdict: 'miss' }, { now: T0 + 3 });
A.eq(rt.usage.launches['morning-brief'].rated.great, 2, 'great verdicts count up');
A.eq(rt.usage.launches['morning-brief'].rated.miss, 1, 'miss verdicts count up');
A.eq(rt.usage.launches['morning-brief'].n, 1, 'a rating never inflates the launch count');
A.eq(S.noteRated(rt, { id: 'morning-brief', verdict: 'amazing' }, { now: T0 }).usage.launches['morning-brief'].rated.great, 2, 'an unknown verdict is a no-op (clamped enum)');
A.eq(S.noteRated(rt, { id: '' }, { now: T0 }).usage.launches['morning-brief'].rated.great, 2, 'an idless rating is a no-op');
// a rating on an id the launch ping missed still creates its entry (a real verdict is never dropped)
const rOnly = S.noteRated(S.fresh(T0), { id: 'ghost', verdict: 'ok' }, { now: T0 });
A.eq(rOnly.usage.launches['ghost'].rated.ok, 1, 'a rating on an unseen id creates the entry');
A.eq(rOnly.usage.launches['ghost'].n, 0, 'the created entry does not fake a launch count');
// a later launch never erases the outcome counters
const rKeep = S.noteLaunch(rt, { id: 'morning-brief', name: 'Morning Brief' }, { now: T0 + 4 });
A.eq(rKeep.usage.launches['morning-brief'].rated.great, 2, 'a launch preserves the rated counters');
// old persisted state (no rated field) hydrates to zero counters, never a crash
const legacy = S.normalize({ v: 1, usage: { launches: { 'fix-bug': { name: 'Fix a Bug', n: 3, lastAt: T0 } } } }, T0);
A.eq(legacy.usage.launches['fix-bug'].rated.great, 0, 'an old save without rated hydrates to zeros (back-compat)');
// rated counters survive a hydrate round-trip
const rr = S.normalize(JSON.parse(JSON.stringify(rt)), T0);
A.eq(rr.usage.launches['morning-brief'].rated.miss, 1, 'rated counters round-trip normalize');
// launchHints: the directive hint annotates "(rated well)" only when the Commander's verdicts earn it
A.eq(S.launchHints(rt, 5), ['Morning Brief (rated well)'], 'launchHints annotates >=2 great and great>miss');
A.eq(S.launchHints(u, 5), ['Morning Brief', 'Fix a Bug'], 'launchHints without ratings matches topLaunched (no invented praise)');
let rMiss = S.noteLaunch(S.fresh(T0), { id: 'x', name: 'X' }, { now: T0 });
rMiss = S.noteRated(rMiss, { id: 'x', verdict: 'great' }, { now: T0 });
A.eq(S.launchHints(rMiss, 5), ['X'], 'one great alone does not earn the annotation (needs >=2)');
A.eq(S.topLaunched(rt, 5), ['Morning Brief'], 'topLaunched stays names-only (locked contract untouched)');

/* ---------- sweep: an undecided draft expires on the interests horizon, un-wedging the mint pipeline ---------- */
A.eq(S.DRAFT_TTL_MS, 14 * 86400000, 'the draft TTL is the same 14-day horizon interests decay over');
let sw = S.fresh(T0);
sw = S.stage(sw, { id: 'stale', kind: 'recipe', draft: { name: 'Old Radar' }, why: 'w', fingerprint: 'fp-stale' }, { now: T0 });
const SWEEP_AT = T0 + S.DRAFT_TTL_MS + 1;                 // one ms past the TTL for the T0 draft
sw = S.stage(sw, { id: 'fresh', kind: 'recipe', draft: { name: 'New Radar' }, why: 'w', fingerprint: 'fp-fresh' }, { now: SWEEP_AT });
const swept = S.sweep(sw, SWEEP_AT);
A.eq(swept.staged.length, 1, 'the aged-out draft is evicted, the fresh one kept');
A.eq(swept.staged[0].id, 'fresh', 'the surviving draft is the fresh one');
const expiredNotes = swept.ledger.filter(e => e.outcome === 'expired');
A.eq(expiredNotes.length, 1, 'each eviction writes exactly one expired ledger note');
A.eq(expiredNotes[0].kind, 'recipe', 'the expired note carries the drafted kind');
A.eq(expiredNotes[0].title, 'Old Radar', 'the expired note names the drafted title');
// expiry is NOT a dismissal — the fingerprint is NOT denylisted, so an equivalent draft may legitimately re-mint.
A.eq(swept.denylist.length, 0, 'expiry never denylists — an equivalent draft may re-mint once the interest recurs');
A.ok(swept.denylist.indexOf('fp-stale') < 0, 'the expired fingerprint is not on the denylist');
// a boundary draft exactly AT the TTL survives (strict older-than), and a sweep with nothing stale is a no-op.
let edge = S.stage(S.fresh(T0), { id: 'edge', kind: 'prospect', draft: { name: 'Edge' }, why: 'w', fingerprint: 'fp-edge' }, { now: T0 });
A.eq(S.sweep(edge, T0 + S.DRAFT_TTL_MS).staged.length, 1, 'a draft exactly at the TTL is kept (strict older-than eviction)');
const noop = S.sweep(swept, SWEEP_AT);
A.eq(noop.staged.length, swept.staged.length, 'a sweep with nothing stale drops nothing');
A.eq(noop.ledger.length, swept.ledger.length, 'a no-op sweep writes no ledger note');
// decide() un-wedges: both shelves full of STALE drafts bind at 'full'; after the sweep clears them it fires again.
let wedged = S.fresh(T0);
for (let i = 0; i < S.liveCap('prospect'); i++) wedged = S.stage(wedged, { id: 'wp' + i, kind: 'prospect', draft: { name: 'p' + i }, why: 'w', fingerprint: 'fp-wp' + i }, { now: T0 });
for (let i = 0; i < S.liveCap('recipe'); i++) wedged = S.stage(wedged, { id: 'wr' + i, kind: 'recipe', draft: { name: 'r' + i }, why: 'w', fingerprint: 'fp-wr' + i }, { now: T0 });
for (let i = 0; i < S.MINT_EVERY_RUNS; i++) wedged = S.noteRun(wedged, T0);
const wedgeAt = T0 + S.DRAFT_TTL_MS + S.MINT_MIN_GAP_MS + 1;
A.eq(S.decide(wedged, { now: wedgeAt, warm: true }).binding, 'full', 'stale drafts filling both shelves wedge minting at binding:full');
const unwedged = S.sweep(wedged, wedgeAt);
A.eq(unwedged.staged.length, 0, 'the sweep clears every aged-out draft off both shelves');
A.ok(S.decide(unwedged, { now: wedgeAt, warm: true }).fire, 'decide() fires again once the sweep un-wedges the shelves');
// a re-minted equivalent of an EXPIRED draft is NOT blocked by parse (expiry left the denylist untouched).
const remint = S.parseRecipe(GOOD, { existingRecipes: [], gearKeys: GEAR, denylist: swept.denylist });
A.ok(remint && remint.draft, 'an equivalent of an expired draft re-mints (expiry did not denylist it)');

/* ---------- ARCHETYPE MATCHING: the deep-cut pool seeds prospects when the LEARNED interests point at one ---------- */
const SHARED = require('../shared/specialties.js');
const ARCH = SHARED.ARCHETYPES;
A.ok(Array.isArray(ARCH) && ARCH.length >= 5, 'the shared catalog exposes the archetype pool');
// a WARM topic whose words hit an archetype's own text matches it — deterministically, no model.
const priceTopics = [{ label: 'gpu price tracking', weight: 1.2, count: 5 }];
const m1 = S.matchArchetype(ARCH, { topics: priceTopics, existingNames: [], denylist: [] });
A.ok(m1 && m1.archetype && m1.archetype.id === 'broker', 'a warm price-hunting habit matches the broker archetype');
A.ok(m1.why.indexOf('gpu price tracking') >= 0 && m1.why.indexOf('5×') >= 0,
  'the WHY names the real topic and its real observed count (truthful telemetry): ' + m1.why);
// stemming: "translation" (topic) must hit "translates/translate" (archetype text)
const m2 = S.matchArchetype(ARCH, { topics: [{ label: 'japanese document translation', weight: 1.0, count: 3 }], existingNames: [], denylist: [] });
A.ok(m2 && m2.archetype.id === 'translator', 'a translation habit matches the translator archetype (crude stem)');
// gates: a sub-warm topic never summons the long tail; no topics -> null; generic words never match.
A.eq(S.matchArchetype(ARCH, { topics: [{ label: 'gpu price tracking', weight: 0.3, count: 1 }] }), null, 'a one-off mention (below the warm floor) matches nothing');
A.eq(S.matchArchetype(ARCH, { topics: [] }), null, 'no learned topics -> no archetype match');
A.eq(S.matchArchetype(ARCH, { topics: [{ label: 'daily general work', weight: 2, count: 9 }] }), null, 'generic-word topics are stopworded, never a match');
// dedup: an archetype the Commander already HAS (roster/custom/staged name) is never re-pitched…
// derived from the LIVE catalog, never a hardcoded display name: the dedup is name-based, so a class rename
// (2026-08-03 renamed broker -> "Deal Finder") would otherwise silently turn this assertion into a no-op.
// Lower-cased on purpose — the dedup must be case-insensitive.
const brokerName = ARCH.find(a => a.id === 'broker').name;
A.eq(S.matchArchetype(ARCH, { topics: priceTopics, existingNames: [brokerName.toLowerCase()] }), null, 'an already-held archetype is never re-pitched (name dedup, case-insensitive)');
// …and a dismissed shape stays dead (fingerprint denylist, same 0.6 overlap rule as the LLM path).
const deadFp = S.fingerprint('Broker Compare deals & call the buy');
A.eq(S.matchArchetype(ARCH, { topics: priceTopics, denylist: [deadFp] }), null, 'a dismissed archetype shape never re-mints');
// the staged draft is the FULL spec — accepting it mints a complete custom class, nothing half-authored.
const ad = S.archetypeDraft(m1.archetype);
for (const f of ['name', 'emoji', 'tagline', 'blurb', 'purpose', 'manual', 'persona', 'model', 'accent']) {
  A.ok(ad[f] && String(ad[f]).length > 0, 'archetype draft carries a non-empty ' + f);
}
A.ok(Array.isArray(ad.kit) && ad.kit.length > 0 && Array.isArray(ad.skills) && ad.skills.length > 0, 'archetype draft carries the full loadout (kit + skills)');
A.eq(ad.custom, true, 'archetype draft is marked custom (the accept flow saves it as a custom class)');
A.eq(ad.archetypeId, 'broker', 'archetype draft records its provenance (archetypeId)');
A.eq(ad.source, 'archetype', 'archetype draft records its source');
// the sidecar cycle wires the matcher BEFORE the LLM authorship pass (source-lock, mirrors the suite's style).
const fs2 = require('fs'); const path2 = require('path');
const idxSrc = readSidecarSource();
A.ok(/Scout\.matchArchetype\(SharedSpecialties\.ARCHETYPES/.test(idxSrc), 'runScoutCycle consults the archetype matcher on a prospect turn');
A.ok(idxSrc.indexOf('Scout.matchArchetype') < idxSrc.indexOf('ProspectGen.buildDirective'), 'the archetype match runs BEFORE the LLM authorship pass');
A.ok(/for \(const c of \(SharedSpecialties\.ARCHETYPES \|\| \[\]\)\)/.test(idxSrc), 'the LLM near-duplicate guard counts archetypes as existing classes (the model never re-authors one)');
A.ok(/function scoutTakenNames\(\)/.test(idxSrc), 'the matcher dedups against the names the Commander actually HAS (not the catalog itself)');

/* ---------- normalize: corrupt saves degrade, never throw ---------- */
const n = S.normalize({ staged: [{ id: 'ok', kind: 'recipe', draft: { name: 'x' } }, { id: '', kind: 'recipe', draft: {} }, { id: 'bad-kind', kind: 'zork', draft: {} }], denylist: [1, 'fp', ''], ledger: 'nope', runsSinceMint: 'NaN', lastMintAt: -5 }, T0);
A.eq(n.staged.length, 1, 'malformed staged items are dropped on hydrate');
A.eq(n.denylist, ['1', 'fp'], 'denylist entries coerce to strings, empties dropped');
A.eq(n.ledger.length, 0, 'a corrupt ledger degrades to empty');
A.eq(n.runsSinceMint, 0, 'a corrupt counter degrades to 0');
A.eq(n.lastMintAt, 0, 'a negative stamp degrades to 0');

// report() LAST — it is what calls process.exit(fail?1:0). This file used to end in a bare
// console.log, so every assertion failure printed FAIL and STILL exited 0: the fast gate scored
// it green no matter what broke. Never end an _assert.js test any other way.
A.report('scout.test');
