/* node test/quest-log-window.test.js — the QUEST LOG window contract (2026-08-13).

   Locks the four repairs of the quest-log lane so they cannot silently regress:
     1. NO FLASHING — journeystore compares a serialized SIGNATURE, never object identity, against
        polled JSON (identity never holds for a fresh JSON.parse; that guard was the 4s repaint loop).
        And every quest store's background poke is a DATA poke (rerender('quests', false)) — a poll
        must never play the body crossfade over a panel the Commander is reading.
     2. REFRESH FOLLOWS ITS CYCLE — the store runs a BOUNDED settle-watch on real status; the panel
        carries no blind setTimeout guess, and the outcome reads in plain language.
     3. A QUEST STARTS IN ITS OWN SESSION — work/ledger GO routes to 'session' (never the TASK BOARD),
        idempotent by title, composer PREFILLED never sent, ledger quests bind their OWN agent.
     4. QUESTS LEAD THE PANEL — quests, then goal settings and bookkeeping; kind badges name the source;
        the window is a steady-height shell so a data poke cannot re-centre it mid-read.

   stationui.js is browser-flow — like outbox-window.test.js we lock its invariants by reading the
   shipped source. quests.js IS pure and node-loadable, so its contract is asserted by execution. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const station = read('frontend/app/stationui.js');
const journey = read('frontend/app/journeystore.js');
const refresh = read('frontend/app/questrefreshstore.js');
const css = read('frontend/css/app.css');
const motion = read('frontend/css/motion.css');

/* ---- 1. the flashing stays dead: signature guard + data pokes ---- */
A.ok(/function signatureOf/.test(journey) && /JSON\.stringify\(journey\)/.test(journey), 'journeystore compares a serialized signature (identity never holds for polled JSON — the 4s repaint bug)');
A.ok(/sig === lastSig/.test(journey), 'an unchanged journey (same signature, new object) repaints NOTHING');
A.eq((journey.match(/lastSig = null/g) || []).length >= 2, true, 'BOTH reset paths clear the signature (a re-init must not suppress the first repaint)');
A.ok(/function rerender\(key, swap\)/.test(station), 'StationUI.rerender accepts the data-poke form (swap=false → no body crossfade)');
for (const f of ['goalstore', 'journeystore', 'maintqueststore', 'stationqueststore', 'workqueststore', 'queststatestore', 'questledgerstore', 'questrefreshstore']) {
  const src = read('frontend/app/' + f + '.js');
  A.ok(!/StationUI\.rerender\('quests'\)(?!, )/.test(src.replace(/StationUI\.rerender\('quests', false\)/g, '')), f + ': every background poke is a DATA poke (rerender(\'quests\', false)) — no crossfade blink from a poll');
}

/* ---- 2. refresh follows its cycle to the end, boundedly ---- */
A.ok(/SETTLE_MAX_MS/.test(refresh) && /SETTLE_POLL_MS/.test(refresh), 'the settle-watch is BOUNDED (poll cadence + hard ceiling — never an unbounded spinner)');
A.ok(/if \(out\.started\) watchSettle\(\)/.test(refresh), 'a started refresh is FOLLOWED (watchSettle), not guessed at');
A.ok(/finally \{ watching = false; poke\(\); \}/.test(refresh), 'the watch pokes on give-up too — the button always comes back');
const buildFn = station.slice(station.indexOf('function buildQuests'), station.indexOf('function journeyHtml'));
A.ok(!/setTimeout\([^)]*rerender\('quests'\)/.test(buildFn), 'the panel carries NO blind re-render timer (the stuck-REFRESHING… bug)');
A.ok(/the station had nothing it could honestly ground/.test(station), 'a rejected cycle reads in plain language (the engine wording rides the tooltip)');

/* ---- 3. a quest starts in its own session ---- */
const stationFns = station.slice(station.indexOf('function questGoDest'), station.indexOf('function buildQuests'));
A.ok(/return 'session'/.test(station) && !/GO ▸ task board/.test(station), 'work/ledger quests route to their OWN session — the TASK BOARD misroute is dead');
A.ok(/function questOpenSession/.test(station) && /\.find\(s => s && !s\.archived && s\.title === title\)/.test(station), 'START QUEST is idempotent by title (a second click returns to the same conversation)');
A.ok(/Chat\.prefill\(/.test(station.slice(station.indexOf('function questOpenSession'), station.indexOf('function questSessionTitle') + 4000)), 'the ask is PREFILLED, never sent — no fabricated turns');
A.ok(/q\.agentId && String\(q\.agentId\)/.test(station), 'a ledger quest binds its OWN agent; agent-less kinds fall to the hero');
A.ok(/q\.id === 'st:crew'/.test(stationFns) && /return 'recruit'/.test(stationFns), 'the recruit quest routes to Recruitment Bay, never Refit');
A.ok(/App\.openSummonBay/.test(station.slice(station.indexOf("body.querySelectorAll('.q-go')"), station.indexOf("body.querySelectorAll('.q-attest-yes')"))), 'the recruit destination opens the real Recruitment Bay surface');
A.ok(/case 'prop':[\s\S]{0,120}return 'refit'/.test(stationFns), 'a capability contract routes to the placement surface');
A.ok(/case 'fact':|case 'attest':/.test(stationFns), 'fact and attest ledger contracts have a real action destination');

/* ---- 4. quests lead the panel; the shell holds steady ---- */
const renderStart = station.indexOf("body.innerHTML = '<div class=\"gx gx-quests\">");
const render = station.slice(renderStart, station.indexOf("const journeyFail", renderStart));
const orderOk = render.indexOf('journalHtml') < render.indexOf('questRefreshHtml()') && render.indexOf('questRefreshHtml()') < render.indexOf('journeyHtml()');
A.ok(orderOk, 'panel order: quests → goal settings → bookkeeping (the briefing and action lead the window)');
A.ok(/QUEST_KIND_TAG/.test(station) && /FOR YOU/.test(station), 'cards carry a kind badge naming which real source minted them');
A.ok(/className: 'quests-win'/.test(station), 'the window declares the steady-height shell class');
A.ok(/\.term\.quests-win \{ --con-h:/.test(css), 'quests-win RESTATES --con-h (declared only on .term.console — an undefined var would silently fall back to content-fit)');
A.ok(/\.gx-quests \.q-grid \{ grid-template-columns: repeat\(auto-fill/.test(motion), 'the quest grid follows the window width at its CANONICAL rule in motion.css (app.css copies are silent no-ops)');
A.ok(/align-items: stretch/.test(motion), 'cards in a row share a height — one action baseline per row');

/* ---- 5. THE GOAL TRACK — the active goal drawn as a path, before refresh controls ---- */
A.ok(/function questTrackHtml/.test(station), 'the goal track has its own renderer');
const trackFn = station.slice(station.indexOf('function questTrackHtml'), station.indexOf('function QSS_CELEBRATING'));
A.ok(render.indexOf('questTrackHtml(arcs)') >= 0 && render.indexOf('questTrackHtml(arcs)') < render.indexOf('questRefreshHtml()'),
  'the track leads goal settings, before the refresh controls');
A.ok(/const isArc = q =>/.test(station) && /const rest = qs\.filter\(q => !isArc\(q\)\)/.test(station),
  'arc quests are MOVED out of the card grid — the path is never printed twice');
/* the ordering bug this test exists for: Quests.build() returns open.concat(done), so a COMPLETED
   milestone jumps to the end of the array. A path rendered in that order shows step 1 after step 4. */
A.ok(/GoalStore\.activeGoal/.test(trackFn) && /\.sort\(\(a, b\) => at\(a\.milestoneId\) - at\(b\.milestoneId\)\)/.test(trackFn),
  'track nodes are re-sorted into the goal tree’s own milestone order (build() returns open-then-done)');
A.ok(/isDone \? 'done' : \(s\.isNext \? 'now' : 'ahead'\)/.test(trackFn), 'three honest node states: behind you (done), the one you are on (now), ahead');
A.ok(/YOU ARE HERE/.test(trackFn) && /RUNNING/.test(trackFn), 'the live front is named in words; a bound build in flight says RUNNING');
A.ok(/next && !next\.inFlight/.test(trackFn), 'ACCEPT is withheld while the step’s bound build is running (a second accept would double-mint it)');
A.ok(/goal\.pct/.test(trackFn) && /goal\.done/.test(trackFn) && /goal\.total/.test(trackFn), 'the meter reads the engine’s real done/total/pct — never an invented number');
/* Check the EMITTED markup, not the prose around it: the comments legitimately discuss the no-unlock rule,
   and grepping them made the guard fire on its own rationale. Strip comments, then assert on what ships. */
const trackEmitted = trackFn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
A.ok(!/locked|unlock|LOCKED|TIER \d/i.test(trackEmitted), 'NOTHING the track RENDERS claims to be locked — the log reveals order, it never gates (standing law)');
A.ok(/q-track-empty/.test(trackFn) && /SET A GOAL/.test(trackFn), 'with no goal the track teaches what it is and offers the real door, never an empty frame');
A.ok(/GoalStore\.unplannedGoal/.test(trackFn) && /GOAL SAVED/.test(trackFn), 'a saved dossier goal appears in YOUR GOAL even before a milestone path exists');
A.ok(/PLAN THIS GOAL/.test(trackFn), 'an unplanned saved goal offers the explicit path-planning action');
const savedGoalRule = css.match(/\.q-track-saved \.q-track-goal\s*\{([^}]*)\}/);
A.ok(savedGoalRule && /color:\s*var\(--gold\)/.test(savedGoalRule[1]) && !/var\(--ink\)/.test(savedGoalRule[1]),
  'the saved goal title uses a visible track foreground, never the near-black inverted-text token');
/* A FINISHED path is not an empty one. Goals.project surfaces nothing for a completed goal, so without
   this the band snapped back to "no goal path yet" the instant the last milestone landed — telling a
   Commander who had just finished a goal that they never had one. */
A.ok(/evo\.goalsReached/.test(trackFn) && /' reached<\/b>'/.test(trackFn),
  'a completed path is ACKNOWLEDGED with the engine’s real goals-reached count, never reset to "no goal yet"');
A.ok(/SET THE NEXT GOAL/.test(trackFn), 'after a goal is reached the door invites the NEXT one');
A.ok(/q-track-reached-band/.test(trackFn) && /\.q-track-reached-band/.test(css), 'the finished band keeps the gold rail it earned');
A.ok(/\.q-track \{/.test(css) && /\.q-node-now \.q-node-dot/.test(css), 'the track ships its CSS layer');
A.ok(/const milestones = rest\.filter/.test(station) && /<details class="q-milestones\b[^"]*"><summary>/.test(station), 'lifetime milestones live in a collapsed shelf instead of inflating the current OPEN list');
/* the payoff: what the path cashes out in. The stage NAME must come from the engine, never a copy of the
   ladder in the frontend — and it must not read as an unlock, because evolution grants nothing. */
A.ok(/evo\.next/.test(trackFn) && !/DRIFT|VECTOR|ORBIT|CONSTELLATION|DEEP FIELD/.test(trackFn),
  'the payoff names the SIDECAR’s next stage (evolution.next) and never hardcodes the ladder in the UI');
A.ok(/never your tools/.test(trackEmitted), 'the payoff states the expressive-only boundary in the same breath');
const jstore = read('sidecar/journey-store.js');
A.ok(/function evolutionName/.test(jstore) && /next: evolutionName\(n \+ 1\)/.test(jstore),
  'evolutionFor exposes `next` from ONE naming formula (name and next cannot drift apart)');

/* ---- the pure engine: per-dimension WHY (executed, not grepped) ---- */
const Quests = require('../frontend/app/quests.js');
const dims = [
  { key: 'stack', label: 'Stack & tools', known: false },
  { key: 'pain', label: 'Pain points', known: false },
  { key: 'schedule', label: 'Schedule & cadence', known: false },
  { key: 'brand_new_dim', label: 'Brand new', known: false }
];
const built = Quests.build({ dossierDims: dims });
const descs = built.filter(q => q.kind === 'dossier').map(q => q.desc);
A.eq(descs.length, 4, 'one quest per dossier dimension');
A.eq(new Set(descs.slice(0, 3)).size, 3, 'known dimensions carry DISTINCT explanations (nine identical sentences read as one wall)');
A.ok(/every agent on the station will know this about you/.test(descs[3]), 'an unknown dimension keeps the honest generic line rather than an invented claim');

/* Execute the production journal renderer and its actual selection callbacks. The shell only models
   the two button collections; business state still comes through the real renderer's QuestStore seam. */
const vm = require('node:vm');
let questRows = [
  { id: 'st:crew', kind: 'station', title: 'Recruit a specialist', desc: 'Bring another mind aboard.', reward: 'A larger crew', status: 'open' },
  { id: 'ds:stack', kind: 'dossier', title: 'Your <tools>', desc: 'Share your tools.', reward: 'Better context', status: 'open' }
];
let rendered = '', buttons = {}, focused = '';
const list = { scrollTop: 0 };
const viewDescription = { textContent: '' };
const body = {
  dataset: {}, classList: { add() {} },
  querySelector: s => s === '.q-mission-list' ? list : s === '.q-view-description' ? viewDescription : null,
  querySelectorAll: s => buttons[s] || [],
  get innerHTML() { return rendered; },
  set innerHTML(html) {
    rendered = html; buttons = { '.q-filter': [], '.q-mission': [], '[data-quest-view]': [], '.q-view-panel': [] };
    for (const id of ['available', 'goals', 'progress', 'completed']) {
      buttons['.q-view-panel'].push({ id: 'q-view-' + id, hidden: false });
      buttons['[data-quest-view]'].push({ dataset: { questView: id }, attributes: {},
        setAttribute(k, v) { this.attributes[k] = v; },
        addEventListener(event, fn) { this[event === 'click' ? 'click' : 'keydown'] = fn; },
        focus() { focused = id; }
      });
    }
    for (const m of html.matchAll(/<button class="(q-filter|q-mission(?: selected)?)" ([^>]+)>/g)) {
      const data = /data-(category|quest-select)="([^"]*)"/.exec(m[2]);
      if (!data) continue;
      const key = data[1] === 'category' ? 'category' : 'questSelect';
      buttons[m[1] === 'q-filter' ? '.q-filter' : '.q-mission'].push({
        dataset: { [key]: data[2] },
        addEventListener(_event, handler) { this.click = handler; },
        focus() { focused = data[2]; }
      });
    }
  }
};
const ctx = vm.createContext({ body, QuestStore: { view: () => ({ quests: questRows }) },
  esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  QUEST_KIND_TAG: { station: 'STATION', dossier: 'ABOUT YOU' }, GO_LABEL: {},
  questGoDest: () => null, questCompletesWhen: () => 'the recorded condition is met', workshopGrantOn: () => false,
  questTrackHtml: () => '', lifeGoalsHtml: () => '', questRefreshHtml: () => '', journeyHtml: () => '',
  rerender: () => ctx.buildQuests(body)
});
const journalSource = station.slice(station.indexOf('  function buildQuests(body)'), station.indexOf('    // COMMANDER JOURNEY writes')) + '\n}';
vm.runInContext(journalSource, ctx);
ctx.buildQuests(body);
A.eq(body.dataset.questView, 'available', 'available quests lead on first open');
const beforeTab = rendered;
buttons['[data-quest-view]'][1].click();
A.eq(body.dataset.questView, 'goals', 'Goals tab selects its own view');
A.eq(rendered, beforeTab, 'tab changes do not rebuild forms or discard entered values');
A.eq(buttons['.q-view-panel'].filter(p => !p.hidden).map(p => p.id).join(','), 'q-view-goals', 'only the selected panel is exposed');
ctx.buildQuests(body);
A.eq(body.dataset.questView, 'goals', 'background refresh preserves the selected tab');
buttons['[data-quest-view]'][1].keydown({ key: 'ArrowRight', preventDefault() {} });
A.eq(body.dataset.questView, 'progress', 'arrow keys move to the next tab');
A.eq(focused, 'progress', 'keyboard selection moves focus with the tab');
buttons['[data-quest-view]'][0].click();
A.eq(body.dataset.questSelected, 'st:crew', 'journal initially selects the first available quest');
A.eq((rendered.match(/class="gx-tro q-card /g) || []).length, 1, 'journal renders exactly one open briefing, not nine competing cards');
buttons['.q-mission'][1].click();
A.eq(body.dataset.questSelected, 'ds:stack', 'selecting a mission replaces the briefing');
A.eq(focused, 'ds:stack', 'keyboard focus returns to the selected mission');
A.ok(rendered.includes('Your &lt;tools&gt;') && !rendered.includes('Your <tools>'), 'quest titles stay escaped in the list and briefing');
list.scrollTop = 120;
ctx.buildQuests(body);
A.eq(body.dataset.questSelected, 'ds:stack', 'background data pokes retain the selected quest');
A.eq(list.scrollTop, 120, 'background data pokes retain the mission-list scroll');
buttons['.q-filter'].find(b => b.dataset.category === 'station').click();
A.eq(body.dataset.questSelected, 'st:crew', 'category changes choose a quest in that category');
A.eq(buttons['.q-mission'].length, 1, 'category filters exclude unrelated quests');
buttons['.q-filter'].find(b => b.dataset.category === 'missions').click();
A.ok(rendered.includes('No quests in this category'), 'an empty category has an explicit recovery state');
buttons['.q-filter'].find(b => b.dataset.category === 'all').click();
questRows[0].status = 'done';
ctx.buildQuests(body);
A.eq(body.dataset.questSelected, 'ds:stack', 'completion advances selection to a remaining open quest');
A.ok(rendered.includes('id="q-view-completed"'), 'completed quests remain accessible in history');
questRows = [];
ctx.buildQuests(body);
A.ok(rendered.includes('All caught up'), 'zero open quests has an honest empty state');
questRows = [
  { id: 'q:first', kind: 'ledger', title: 'First', status: 'open', executionMode: 'commander', contract: { type: 'attest' } },
  { id: 'q:second', kind: 'ledger', title: 'Second', status: 'open', executionMode: 'commander', contract: { type: 'attest' } }
];
body._questDrafts = new Map([['q:first', { evidence: 'First quest evidence', reason: 'First reason' }]]);
ctx.buildQuests(body);
A.ok(rendered.includes('id="q-evidence-q:first"') && rendered.includes('First quest evidence'), 'evidence drafts use stable quest-specific field IDs');
buttons['.q-mission'][1].click();
A.ok(rendered.includes('id="q-evidence-q:second"') && !rendered.includes('First quest evidence'), 'switching quests never puts the first quest evidence into the second');
buttons['.q-mission'][0].click();
A.ok(rendered.includes('First quest evidence'), 'returning to a quest restores its own evidence draft');
ctx.JourneyStore = { status: () => ({ progression: { level: 7 } }) };
ctx.buildQuests(body);
A.ok(rendered.includes('<strong>7</strong><span>Commander'), 'journal level reads Commander progression, not crew XP or a fabricated score');
vm.runInContext(station.slice(station.indexOf('  function windowDirty(w)'), station.indexOf('  function requestCloseTerm')), ctx);
const draftWindow = { querySelector: selector => selector === '.term-body' ? body : null };
body._questDrafts.set('q:first', { evidence: 'Unsaved result', dirty: true });
A.eq(ctx.windowDirty(draftWindow), true, 'a draft in another mission still triggers the existing unsaved-close guard');
body._questDrafts.set('q:first', { evidence: '', dirty: false });
A.eq(ctx.windowDirty(draftWindow), false, 'recorded or clean cached fields do not block closing');
// Mixed-goal snapshots must not present every metric as belonging to the current focus.
vm.runInContext(station.slice(station.indexOf('  function journeyHtml()'), station.indexOf('  function lifeGoalsHtml()')), ctx);
let journeySnapshot = {
  activeGoal: { id: 'g1', text: 'Learn <piano>', done: 1, total: 3, next: 'Practice' },
  goals: [{ id: 'g2', text: 'Change careers' }],
  metrics: [
    { id: 'm1', label: 'Practice', goalId: 'g1', current: 1, target: 10 },
    { id: 'm2', label: 'Applications', goalId: 'g2', current: 2, target: 20 },
    { id: 'm3', label: 'Hours', current: 3, target: 30 },
    { id: 'm4', label: 'Legacy', goalId: 'missing', current: 0, target: 1 }
  ]
};
ctx.JourneyStore = { status: () => journeySnapshot };
const progressMarkup = ctx.journeyHtml();
A.ok(progressMarkup.includes('Goal: Learn &lt;piano&gt;'), 'focused metric uses the actual goal and escapes its title');
A.ok(progressMarkup.includes('Goal: Change careers'), 'another goal metric keeps its own goal label');
A.ok(progressMarkup.includes('General metric · no linked goal'), 'unlinked metrics never imply a focused goal association');
A.ok(progressMarkup.includes('Linked to another goal'), 'missing goal records do not invent a goal title');
A.ok(progressMarkup.includes('Linked to your current focus: Learn &lt;piano&gt;'), 'metric editor explains the same focus used by metric creation');
journeySnapshot = { metrics: [] };
A.ok(ctx.journeyHtml().includes('No focused goal. This metric will be tracked independently'), 'no-focus editor explains that the new metric will be independent');
A.report('quest-log-window.test');
