/* node test/nightshift-chosen-autonomy.test.js — bug 41b2d015: CHOSEN AWAY AUTONOMY ACTS (no usage wall).

   THE BUG (sweep/onboarding, 2026-10-20): at the awakening's "while you're away, how much should i run on my own?" a
   new Commander picks "Quietly do small jobs" (or "Run free"), and the station answered "I'll start once I've seen a
   few of your runs or learned a little more about you." The posture they chose stayed OFF until the station had 4
   recent runs or 4 known dossier areas, with no setting to lift it — a usage wall on the onboarding path
   (DECISIONS: full power from minute one, no grind/unlock/usage walls).

   THE CHANGE: the act floor is GROUNDING, not a breadth count — one current GROUNDED aim or one recent user run. The
   trust line holds (AUTONOMY_DRIVER_PLAN §2: only confirmed beliefs cross the acting line; dossier.js WEIGHTS): a goals
   area held only by SEEDS — the quick-setup chip's canned purpose, a thin run, any doc copy — never makes the station
   hot, so a Commander who gave the awakening nothing of their own still sees the hold (that hold is the open owner
   ruling on the bug). The per-job anti-slop guard (grounding veto, confidence gate, self-critique) is unchanged.

   Drives the REAL path end to end, no sidecar boot (sidecar/index.js is never required or run):
     · the REAL DossierStore (frontend/app/dossierstore.js) seeds the dossier from the awakening's purpose.md and
       POSTs the beliefs snapshot it really sends to /api/autonomy/posture (captured from its fetch);
     · the REAL sidecar host code — commanderPosture, nightshiftPrecheck and nightshiftReadinessView, sliced out of
       sidecar/index.js by their declarations — stores that snapshot + the picked preset's posture and gates on it;
     · the REAL night-shift driver (sidecar/nightshift-driver.js) ticks with that precheck: away + chosen posture → a
       beat FIRES (before the fix it declined with binding 'readiness' and never reached the beat);
     · the REAL NightReport.postureOutlook speaks the awakening line from that status — no "I'll start once…" hold;
     · section 6 runs the REAL onboarding.js short conversation against a stubbed brain into that same DossierStore,
       so the weight each awakening write carries (a thin read's BELIEF lines, the dig after "Help me figure that
       out") is what the host gates on — never a hand-built snapshot.
   The floor stays honest: with nothing of the Commander's to cite (no grounded aims, no runs) it still stands down
   pre-spend — the canned "Code & build" chip included, in step with the station's own shared V3 verdict
   (no-direction) — and the copy names the one thing that grounds a job, never a count of areas. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Autopilot = require('../frontend/app/autopilot.js');
const Autonomy = require('../frontend/app/autonomy.js');
const Dossier = require('../frontend/app/dossier.js');
const Understanding = require('../frontend/app/understanding.js');
const NR = require('../frontend/app/nightreport.js');
const nightshift = require('../sidecar/nightshift.js');
const { makeNightshiftDriver } = require('../sidecar/nightshift-driver.js');

const ROOT = path.resolve(__dirname, '..');
const sidecarSrc = readSidecarSource();
const dossierStoreSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'dossierstore.js'), 'utf8');

// ---- the REAL host code, sliced by declaration (length-guarded: fnBody does not parse regex literals) ----
const postureSrc = A.fnBody(sidecarSrc, 'const commanderPosture = {');
const precheckSrc = A.fnBody(sidecarSrc, 'function nightshiftPrecheck()');
const viewSrc = A.fnBody(sidecarSrc, 'function nightshiftReadinessView()');
for (const [name, body] of [['commanderPosture', postureSrc], ['nightshiftPrecheck', precheckSrc], ['nightshiftReadinessView', viewSrc]]) {
  A.ok(body.length > 200 && body.length < 8000, 'extracted the real ' + name + ' from sidecar/index.js (' + body.length + ' chars)');
}
// both act paths gate on the SAME engine readiness the precheck uses — no private bar of their own.
for (const header of ['async function runNightshiftBeat(', 'async function runNightshiftActShift(']) {
  const body = A.fnBody(sidecarSrc, header);
  A.ok(body.length > 500 && body.length < 40000, 'extracted ' + header);
  A.ok(/Autopilot\.readiness\(/.test(body) && /rd\.tier !== 'hot'/.test(body) && !/activityCount\s*>=\s*\d/.test(body), header + ' gates on Autopilot.readiness (one shared floor)');
}

// one host: the real commanderPosture + precheck + readiness view over stubbed capability reads (a provider IS wired;
// budget is clear) and an injected recent-user-run count (the context-pack evidence; a fresh station has none).
function makeHost(runs) {
  const ctx = vm.createContext({
    Autopilot, Autonomy,
    fs: { mkdirSync() {} }, saveResilient() {}, loadResilient() { return null },
    WORKSPACES: '/ws', AUTONOMY_POSTURE_FILE: '/ws/_commander.autonomy.json',
    budget: { check: () => null }, NIGHTSHIFT_AGENT: 'agent',
    cronProviderFor: () => 'openrouter', cronModelFor: () => 'test/model', cronHasCredential: () => true, cronKeyFor: () => 'k',
    nightshiftUserRunCount: () => runs
  });
  return vm.runInContext(postureSrc + ';\n' + precheckSrc + '\n' + viewSrc + '\n({ commanderPosture, nightshiftPrecheck, nightshiftReadinessView })', ctx);
}

// the beliefs snapshot the REAL DossierStore sends after the awakening commits its docs (app.js applyAgentConfig →
// DossierStore.syncDocs → pushToSidecar → POST /api/autonomy/posture { beliefs }). `said` = the beliefs the
// conversation itself writes FIRST (onboarding.js: DossierStore.upsert('goals', { weight: 'synth'|'stated'|'seed' })
// lands BEFORE purpose.md commits, so the doc seed then dedupes to nothing).
function realStore() {
  const posts = [];
  const ctx = vm.createContext({
    Dossier, Understanding,
    fetch: (url, opts) => { posts.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); }
  });
  const store = vm.runInContext(dossierStoreSrc + '\nDossierStore', ctx);
  store.init({});
  const snapshot = () => { const last = posts.filter(p => p.url === '/api/autonomy/posture' && p.body && p.body.beliefs).pop(); return last ? last.body.beliefs : null; };
  return { store, snapshot };
}
function awakeningSnapshot(docs, said) {
  const { store, snapshot } = realStore();
  for (const [dim, belief] of (said || [])) store.upsert(dim, belief);
  store.syncDocs(docs, { canonical: true });
  return snapshot();
}

const NOW = Date.now();
function driverFor(host) {
  let state = nightshift.fresh(NOW);
  const ledger = [];
  let beats = 0;
  const driver = makeNightshiftDriver({
    getState: () => state, setState: (s) => { state = s; },
    getPosture: () => host.commanderPosture.summary(),
    lastActivity: () => NOW - 2 * 3600000,           // the Commander stepped away two hours ago
    isHalted: () => false, concurrencyFree: () => true,
    precheck: () => host.nightshiftPrecheck(),
    beat: () => { beats++; return new Promise(() => {}); },   // the pipeline itself is not under test: reaching it is
    newAbort: () => new AbortController(), now: () => NOW,
    ledger: (e) => ledger.push(e), emit: () => {}, agentId: 'agent',
    awayThresholdMs: 15 * 60000, beatIntervalMs: 45 * 60000
  });
  return { driver, ledger, beats: () => beats, state: () => state };
}

const OUTLOOK_BUILD = (n) => 'While you’re away I’ll do up to ' + NR.plural(n, 'small job') + ' a day; each arrives as a new session in your rail.';

/* ===== 1. a SEED never grounds acting: quick setup — the canned "Code & build" chip, then "Quietly do small jobs" ===== */
// (review of 41b2d015) the canned chip writes purpose.md only, so goals holds ONE 'seed' belief. The station's own shared
// V3 verdict says it has no direction; the night shift must agree and stand down pre-spend, never act on a canned line.
const CHIP = 'Help me write, debug, and ship software.';   // onboarding.js fallbackPurposeStep 'Code & build'
for (const preset of ['build', 'free']) {
  const snap = awakeningSnapshot({ purpose: CHIP });
  A.ok(snap && Array.isArray(snap.known) && snap.known.indexOf('goals') >= 0, preset + ' chip: the purpose.md seed reaches the snapshot the sidecar receives');
  A.eq(snap.beliefs.goals.map(b => b.weight), ['seed'], preset + ' chip: the goals area holds only the doc seed');
  A.ok(snap.ready && snap.ready.ok === false && snap.ready.reasons.indexOf('no-direction') >= 0, preset + ' chip: the shared V3 verdict in the same snapshot says no direction');
  const host = makeHost(0);
  host.commanderPosture.set(null, snap);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), preset));
  A.eq(host.commanderPosture.summary().actsUnattended, true, preset + ' chip: the chosen preset permits acting unattended');

  A.eq(host.nightshiftPrecheck(), { ok: false, reason: 'readiness' }, preset + ' chip: a seed-only aim does NOT clear the pre-spend gate');
  const view = host.nightshiftReadinessView();
  A.eq([view.tier, view.goalsUsable, view.goalsStale], ['warm', false, false], preset + ' chip: status reads warm — a known area, not a grounded aim (and never "stale")');
  const d = driverFor(host);
  const r = d.driver.applyTick(NOW);
  A.eq([r.fired, r.binding, d.beats(), d.state().beatsUsedToday], [false, 'readiness', 0, 0], preset + ' chip: the away tick declines BEFORE spending any leash');
  A.eq(NR.readinessPlain(view), 'I’ll start once you tell me in your own words what you want help with, or I’ve seen one of your runs.', preset + ' chip: the awakening line names the requirement — their own words, or one run');
  A.ok(/has no aim it can act on yet/.test(NR.readinessText(view)) && !/doesn’t know/.test(NR.readinessText(view)), preset + ' chip: SETTINGS › AUTONOMY says it has no aim it can act on (a canned line grounds nothing) — never that it does not know what they want');
}

/* ===== 2. THE ASK: the Commander's OWN words at the awakening, then "Quietly do small jobs" — it acts, no usage bar ===== */
const MISSION = 'Ship the pricing page and keep the sprite loader fast.';
for (const [label, weight] of [['confirmed synthesis', 'synth'], ['own words', 'stated']]) {
  for (const preset of ['build', 'free']) {
    const tag = preset + ' ' + label;
    const snap = awakeningSnapshot({ purpose: MISSION }, [['goals', { text: MISSION, source: 'onboarding', weight: weight }]]);
    A.eq(snap.beliefs.goals.map(b => b.weight), [weight], tag + ': the purpose lands as ONE grounded goals belief (the doc seed dedupes)');
    const host = makeHost(0);
    host.commanderPosture.set(null, snap);
    host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), preset));
    const sum = host.commanderPosture.summary();

    A.eq(host.nightshiftPrecheck(), { ok: true }, tag + ': a grounded aim clears the pre-spend gate with zero runs (the old bar wanted 4 areas or 4 runs)');
    const view = host.nightshiftReadinessView();
    A.eq([view.tier, view.goalsUsable, view.goalsStale], ['hot', true, false], tag + ': status readiness is hot on the grounded aim alone');

    const d = driverFor(host);
    const sd = d.driver.statusDecision(NOW);
    A.eq([sd.fire, sd.binding], [true, null], tag + ': status says a beat would fire now (no readiness hold)');
    const r = d.driver.applyTick(NOW);
    A.eq([r.fired, r.binding], [true, null], tag + ': the away tick FIRES the chosen posture');
    A.eq(d.beats(), 1, tag + ': the act pipeline was actually entered');
    A.eq(d.state().beatsUsedToday, 1, tag + ': the beat spent one unit of the daily leash, as any real beat does');
    A.ok(!d.ledger.some(e => e.kind === 'decline' && e.binding === 'readiness'), tag + ': no readiness decline was ledgered');

    const outlook = NR.postureOutlook(Object.assign({ active: true, binding: sd.binding, buildMode: 'build', draftReason: null, leashPerDay: sum.leashPerDay }, { readiness: view }));
    A.eq(outlook, OUTLOOK_BUILD(sum.leashPerDay), tag + ': the awakening line says what it will do, with no "I’ll start once…" hold');
    A.eq(NR.readinessText(view), '', tag + ': SETTINGS › AUTONOMY shows no still-learning line');
  }
}

/* ===== 2b. doc seeds never add up to grounding: purpose + context + operating manual, all copied, no words of their own ===== */
{
  const snap = awakeningSnapshot({ purpose: CHIP, context: 'Solo founder building a pixel-art agent harness.', manual: 'Never push without asking.' });
  A.eq(snap.known.slice().sort(), ['goals', 'identity', 'standing_orders'], 'three docs seed three areas');
  A.ok(Object.keys(snap.beliefs).every(k => snap.beliefs[k].every(b => b.weight === 'seed')), 'every one of them is a seed');
  const host = makeHost(0);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), 'build'), snap);
  A.eq(host.nightshiftPrecheck(), { ok: false, reason: 'readiness' }, 'three seeded areas, no grounded aim, no runs → still stands down (seeds never cross the acting line)');
  // one real run is its own grounding (the activity path), seeds or not
  const ran = makeHost(1);
  ran.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), 'build'), snap);
  A.eq(ran.nightshiftPrecheck(), { ok: true }, 'the same seeded station with one recent user run clears the gate (the run is the grounding)');
}

/* ===== 3. the floor stays honest: nothing of the Commander's to cite → stand down pre-spend, name the one thing needed ===== */
{
  const host = makeHost(0);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), 'build'), { known: [], beliefs: {} });
  A.eq(host.nightshiftPrecheck(), { ok: false, reason: 'readiness' }, 'no aims and no runs → the pre-spend gate still stands down (the grounding veto would accept nothing)');
  const view = host.nightshiftReadinessView();
  A.eq([view.tier, view.hotRunsMin], ['cold', 1], 'status names the one-run bar');
  const d = driverFor(host);
  const r = d.driver.applyTick(NOW);
  A.eq([r.fired, r.binding, d.beats(), d.state().beatsUsedToday], [false, 'readiness', 0, 0], 'the cold tick declines BEFORE spending any leash');
  const text = NR.readinessText(view);
  A.eq(text, 'still learning you — it has no aim it can act on yet and it has 0 of 1 recent run; to act on its own it needs either your current aims or 1 recent run', 'readinessText names the grounding bar exactly');
  A.ok(!/areas|of 4|\b4\b|a few/.test(text), 'readinessText carries no area count and no usage ladder');
  A.eq(NR.readinessPlain(view), 'I’ll start once you tell me in your own words what you want help with, or I’ve seen one of your runs.', 'the plain hold names one answer or one run, never "a few of your runs"');
  A.ok(!/a few|few real tasks/.test(NR.bindingPhrase('readiness')), 'the readiness binding phrase asks for one answer or one task, not "a few"');
}

/* ===== 4. ONE recent user run grounds acting on its own (empty dossier) ===== */
{
  const host = makeHost(1);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), 'build'), { known: [], beliefs: {} });
  A.eq(host.nightshiftPrecheck(), { ok: true }, 'one recent user run is grounding enough (the old bar wanted 4)');
  A.eq(host.nightshiftReadinessView().tier, 'hot', 'status reads hot on one run');
}

/* ===== 5. stale aims are named as stale, not as unknown ===== */
{
  const old = NOW - (Autopilot.STALE_MS + 86400000);
  const host = makeHost(0);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), 'build'), { known: ['goals'], beliefs: { goals: [{ text: 'ship the beta', createdAt: old, updatedAt: old }] } });
  A.eq(host.nightshiftPrecheck(), { ok: false, reason: 'readiness' }, 'aims past the recency window with no runs → stand down (recency still gates acting)');
  const view = host.nightshiftReadinessView();
  A.eq([view.goalsUsable, view.goalsStale], [false, true], 'status flags the aims as stale (additive goalsStale)');
  A.ok(/too old to act on/.test(NR.readinessText(view)) && !/doesn’t know your aims/.test(NR.readinessText(view)), 'stale aims are named as too old, never as unknown');
  A.ok(/what you want help with now/.test(NR.readinessPlain(view)), 'the plain hold asks for current aims');
  // SETTINGS › AUTONOMY renders the stand-down WHY (the binding phrase) right beside readinessText: on stale aims the two
  // must agree — never "the station has nothing of yours" next to "the aims it has for you are too old to act on".
  const d = driverFor(host);
  const sd = d.driver.statusDecision(NOW);
  const pm = NR.panelModel({ status: { active: true, away: true, beatsUsedToday: 0, leashPerDay: 3, binding: sd.binding, readiness: view }, tzOffsetMin: 0 });
  A.eq(sd.binding, 'readiness', 'stale aims: the live status binds on readiness');
  A.ok(/too old to act on/.test(pm.readinessText), 'stale panel: the readiness line names the aims as too old');
  A.ok(/no current aim/.test(pm.why) && !/nothing of yours|doesn’t know/.test(pm.why), 'stale panel: the WHY line says no CURRENT aim (true beside "too old"), never "nothing of yours"');
}

/* ===== 6. THE AWAKENING ITSELF labels what it writes by what the Commander gave (review of 41b2d015) =====
   Sections 1-2 hand-build the beliefs the conversation writes. Here the REAL onboarding.js runs the short conversation
   in a vm against a stubbed brain and writes into the REAL DossierStore; app.js then syncs the committed purpose.md
   (syncDocs canonical) and the snapshot it POSTs is what the real host gates on. The brain's directive invites BELIEF
   lines on every reply, including a thin run's read and the dig after "Help me figure that out" — so a model-written
   goals line there must land as a SEED, or one invented aim makes the station hot and spends the leash unattended. */
const onboardingSrc = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'onboarding.js'), 'utf8');
const WakeMind = require('../frontend/app/wakemind.js');
const DIG_ASK = 'what would you enjoy making first?';
const FALLBACK_ASK = 'what would you like me to help you with?';   // onboarding.js fallbackPurposeStep() for the lead
async function awakeningRun(opening, followUp, brain, extra) {
  extra = extra || {};
  const { store, snapshot } = realStore();
  const commits = [], directives = [];
  let nodes = 0;
  const answerFor = cfg => {
    const first = String((cfg.lines && cfg.lines[0] && cfg.lines[0].text) || '');
    const opts = cfg.options || [];
    if (opts.some(o => o.value === 'loose')) return { value: extra.pace || 'loose', label: extra.pace || 'short' };   // the pace pick (short by default)
    if (first === FALLBACK_ASK && extra.fallback) return extra.fallback;                         // the fallback mission question
    if (/set up an agent/.test(first)) return opening;
    if (first === DIG_ASK) return followUp ? { value: followUp, label: followUp, custom: true } : { value: '', skip: true };
    if (opts.some(o => o.value === 'yes')) return { value: 'yes', label: 'that’s me' };            // "did i read that right?"
    const skip = opts.find(o => o.skip);
    return skip ? { value: '', skip: true } : (opts[0] || { value: '', skip: true });
  };
  const ctx = vm.createContext({
    console, Promise,
    Interview: require('../frontend/app/interview.js'),
    setTimeout: fn => { setImmediate(fn); return 0; }, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    World: {},
    Chat: { beginInterview() {}, endInterview() {}, localLine() {}, typeLine(segs, cb) { if (cb) Promise.resolve().then(cb); return () => {}; }, prefill() {} },
    Dialogue: {
      open() {}, setStage() {}, ink() {}, close() {}, isOpen: () => false, say: async () => {}, answer: () => false,
      node: async cfg => (++nodes > 120 ? new Promise(() => {}) : answerFor(cfg))
    },
    WakeMind,
    Harness: { configured: () => true, chat: async o => { const d = String(o.messages[0].content); directives.push(d); return { text: brain(d) }; } },
    DossierStore: store
  });
  vm.runInContext(onboardingSrc + '\nthis.Onboarding = Onboarding;', ctx);
  ctx.Onboarding.start({ docs: {}, commit: p => commits.push(p), wake: false, name: 'TEST', role: 'orchestrator' });
  for (let i = 0; i < 600 && !commits.some(c => c && c.purpose); i++) await new Promise(r => setImmediate(r));
  const purpose = (commits.find(c => c && c.purpose) || {}).purpose || '';
  store.syncDocs({ purpose }, { canonical: true });   // app.js applyAgentConfig → DossierStore.syncDocs
  return { purpose, directives, snap: snapshot() };
}
const THIN_READ = 'READ: i barely know you yet.\nPURPOSE: learn you fast through real work.\nSTACK: python scripts\nBELIEF goals: wants to learn what an agent can do for them through real work.';
const thinBrain = d => /THE READ/.test(d) ? THIN_READ : 'ACK: got it.\nASK: NONE';
const helpBrain = d => {
  if (/THE READ/.test(d)) return /gave you almost nothing/.test(d) ? THIN_READ : 'READ: you want your level editor shipped.\nPURPOSE: Ship the level editor for your pixel-art game.\nSTACK: NONE';
  if (/"answer"/.test(d)) return 'ACK: a level editor — good, that is concrete.\nASK: NONE\nBELIEF goals: wants to ship the level editor for their pixel-art game.';
  return 'ACK: happy to help you find a start.\nASK: ' + DIG_ASK + '\nBELIEF goals: wants an agent to build their side project.';   // the help turn: they said nothing yet
};
const goalsWeights = snap => ((snap && snap.beliefs && snap.beliefs.goals) || []).map(b => b.weight);
function gateFor(snap, preset) {
  const host = makeHost(0);
  host.commanderPosture.set(null, snap);
  host.commanderPosture.set(Autonomy.applyPreset(Autonomy.fresh(), preset));
  const d = driverFor(host);
  return { pre: host.nightshiftPrecheck(), tick: d.driver.applyTick(NOW), beats: d.beats(), tier: host.nightshiftReadinessView().tier };
}

(async () => {
  // 6a. a THIN run (the opening skipped, nothing typed): the read's invented goals BELIEF never grounds acting
  {
    const r = await awakeningRun({ value: '', skip: true }, null, thinBrain);
    A.ok(r.directives.some(d => /THE READ/.test(d) && /gave you almost nothing/.test(d)), 'thin run: the synthesis was asked as a THIN read (the real directive, not a hand-built snapshot)');
    A.ok(r.purpose.length > 0, 'thin run: purpose.md still commits');
    A.ok(goalsWeights(r.snap).length >= 2, 'thin run: the read wrote its BELIEF goals line and its purpose (' + goalsWeights(r.snap).length + ' goals beliefs)');
    A.eq(goalsWeights(r.snap).filter(w => w !== 'seed'), [], 'thin run: every goals belief the awakening wrote is a SEED (the model invented them)');
    A.eq(((r.snap.beliefs.stack) || []).map(b => b.weight), ['seed'], 'thin run: the read’s STACK line is a seed too');
    for (const preset of ['build', 'free']) {
      const g = gateFor(r.snap, preset);
      A.eq([g.pre, g.tier], [{ ok: false, reason: 'readiness' }, 'warm'], preset + ' thin run: the chosen posture holds (warm, not hot)');
      A.eq([g.tick.fired, g.tick.binding, g.beats], [false, 'readiness', 0], preset + ' thin run: the away tick declines before spending any leash');
    }
  }
  // 6b. "Help me figure that out", then nothing typed: the dig reply's invented goals BELIEF never grounds acting
  {
    const r = await awakeningRun({ help: true, label: 'Help me figure that out' }, null, helpBrain);
    A.ok(r.directives.some(d => /THE TUESDAY/.test(d) && /helpRequested/.test(d)), 'help only: the dig reply ran on the help request');
    A.ok(goalsWeights(r.snap).length >= 2, 'help only: the dig and the read wrote goals beliefs (' + goalsWeights(r.snap).length + ')');
    A.eq(goalsWeights(r.snap).filter(w => w !== 'seed'), [], 'help only: every goals belief is a SEED (no words of the Commander’s yet)');
    const g = gateFor(r.snap, 'build');
    A.eq([g.pre, g.tick.fired, g.beats], [{ ok: false, reason: 'readiness' }, false, 0], 'help only: the chosen posture holds, nothing spent');
  }
  // 6c. help first, then their OWN words to the follow-up: what they said grounds acting (the fix never over-corrects)
  {
    const r = await awakeningRun({ help: true, label: 'Help me figure that out' }, 'I want to ship the level editor for my pixel-art game.', helpBrain);
    const goals = (r.snap.beliefs.goals || []);
    const help = goals.find(b => /side project/.test(b.text)), said = goals.find(b => /level editor for their/.test(b.text));
    A.eq([help && help.weight, said && said.weight], ['seed', 'synth'], 'help then words: the help turn’s line is a seed, the answered turn’s line is synth');
    for (const preset of ['build', 'free']) {
      const g = gateFor(r.snap, preset);
      A.eq([g.pre, g.tier, g.tick.fired, g.beats], [{ ok: true }, 'hot', true, 1], preset + ' help then words: the chosen posture acts with zero runs');
    }
  }
  // 6d. their own words at the opening: the dig's and the read's lines are synth and the chosen posture acts
  {
    const r = await awakeningRun({ value: 'I want to ship the level editor for my pixel-art game.', label: 'x', custom: true }, null, helpBrain);
    A.ok(goalsWeights(r.snap).indexOf('synth') >= 0 && goalsWeights(r.snap).indexOf('seed') < 0, 'own words: the goals beliefs are grounded (' + goalsWeights(r.snap).join(',') + ')');
    const g = gateFor(r.snap, 'build');
    A.eq([g.pre, g.tick.fired, g.beats], [{ ok: true }, true, 1], 'own words: the chosen posture acts with zero runs');
  }
  /* 6e-6g. THE FALLBACK MISSION QUESTION (41b2d015 review): quick setup, the keyless wake and a talk whose synthesis could
     not land all ask fallbackPurposeStep. A TYPED answer there is the Commander's own words: it must land as a stated
     goals belief (before the fix it only committed purpose.md, the doc seed held, and the station said it would start
     "once I know what you want help with" right after they typed it). A tapped chip's canned line still holds. */
  const OWN = 'I want to ship the level editor for my pixel-art game.';
  // 6e. QUICK SETUP, typed their own purpose → the chosen posture acts with zero runs
  {
    const r = await awakeningRun({ value: OWN, label: OWN, custom: true }, null, thinBrain, { pace: 'quick' });
    A.ok(!r.directives.some(d => /THE READ/.test(d)), 'quick typed: the quick path asked no synthesis (the fallback question is the only mission beat)');
    A.eq(r.purpose, OWN, 'quick typed: purpose.md holds their words');
    A.eq(goalsWeights(r.snap), ['stated'], 'quick typed: ONE stated goals belief (the purpose.md seed dedupes)');
    for (const preset of ['build', 'free']) {
      const g = gateFor(r.snap, preset);
      A.eq([g.pre, g.tier, g.tick.fired, g.beats], [{ ok: true }, 'hot', true, 1], preset + ' quick typed: the chosen posture acts with zero runs');
    }
  }
  // 6f. QUICK SETUP, tapped the 'Code & build' chip → the canned line is a seed and the posture holds
  {
    const r = await awakeningRun({ value: CHIP, label: 'Code & build' }, null, thinBrain, { pace: 'quick' });
    A.eq(r.purpose, CHIP, 'quick chip: purpose.md holds the chip’s canned line');
    A.eq(goalsWeights(r.snap), ['seed'], 'quick chip: the goals area holds only the doc seed');
    for (const preset of ['build', 'free']) {
      const g = gateFor(r.snap, preset);
      A.eq([g.pre, g.tier, g.tick.fired, g.beats], [{ ok: false, reason: 'readiness' }, 'warm', false, 0], preset + ' quick chip: the chosen posture holds, nothing spent');
    }
  }
  // 6g. SHORT TALK whose synthesis cannot be parsed → the fallback mission question, answered in their own words → acts
  {
    const garbled = d => /THE READ/.test(d) ? 'no tags at all here' : 'ACK: got it.\nASK: NONE';
    const r = await awakeningRun({ value: '', skip: true }, null, garbled, { fallback: { value: OWN, label: OWN, custom: true } });
    A.ok(r.directives.some(d => /THE READ/.test(d)), 'unparseable synthesis: the read was asked');
    A.eq(r.purpose, OWN, 'unparseable synthesis: the fallback question committed their words');
    A.eq(goalsWeights(r.snap), ['stated'], 'unparseable synthesis: their typed mission is ONE stated goals belief');
    const g = gateFor(r.snap, 'build');
    A.eq([g.pre, g.tick.fired, g.beats], [{ ok: true }, true, 1], 'unparseable synthesis, typed mission: the chosen posture acts with zero runs');
  }
  A.report('nightshift-chosen-autonomy.test');
})();
