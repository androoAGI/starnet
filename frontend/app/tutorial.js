/* STARNET — tutorial.js : THE FIRST COMMAND + coachmarks + Field Manual (diegetic onboarding, P0–P3).

   The mind that just woke up (onboarding.js) keeps talking — and teaches the Commander the ONE
   real loop. It opens with the KIT-OUT: the floor is REAL, so a fresh station is compute-only and the
   Commander must PLACE the capability gear (cabinet→FILES · dish→WEB · workbench→TERMINAL · server→
   MEMORY) — each placement genuinely hands the agent that power (heroCaps → the run's real tools). Most
   beats speak in COMMS (Chat.typeLine); the placement guidance is a floating coach bubble over REFIT
   (which covers COMMS). Choices are Chat.choices.

   Honest by mandate (this serves the polish-audit through-line "make the one real loop visible +
   shrink what lies"): it names the crew as echoes, never fakes a number, and — crucially — only runs
   the first real job AFTER the Commander has placed the CABINET, so the file write+read (fs.write +
   fs.read, fs.write consent-gated) executes against tools that ACTUALLY EXIST. A fresh station grants
   none of these out of the box (the moat — sidecar/capability/office.js + capgate F1), so the kit-out
   is what makes the consent→execute→prove demo true instead of an app-lie. The bus-timed beats
   (agent.run.start / permission.prompt / agent.run.end) then narrate the genuine run, never a sim.

   Lifecycle: fires once, right after the awakening lands (app.js passes Onboarding.start({ taught })).
   Fully skippable; a self-owned localStorage flag (starnet.tutorial.v1) means it never repeats.
   P2 = just-in-time coachmarks (seen()/markSeen()); P3 = the Field Manual codex + Station Briefing. */
'use strict';

/* DON'T BURY THE MAP — pure geometry, hoisted out of the IIFE so the gate can actually exercise it
   (test/coach-dodge.test.js), the same shape stationui.js uses for clampTerminalSize.

   finishUp() spawns BOTH the FIRST STEPS brief and the ⚑ QUESTS coachmark, and both want the bottom-left:
   the brief clamps against #left/#chat-panel, the coach clamps against the viewport, and neither knew the
   other existed — so at 1280×720 the coach (z 99000) landed square on the checklist (z 1300) the tour had
   just handed over. The brief is the DURABLE surface, so the COACH dodges.

   Four candidates in preference order, and one is only taken if it BOTH clears the brief and fits on
   screen — a fallback that merely "probably" clears is how a short viewport ends up overlapping anyway.
   ABOVE comes first: it keeps the bubble in the same column as the ring it belongs to (these fire on
   bottom-bar anchors) and off COMMS. If nothing clean fits, leave the box where the anchor put it rather
   than fling it somewhere worse. `box` is mutated and returned; `brief` is a visual-px rect. */
function dodgeRect(box, brief, vw, vh) {
  const clears = b => b.left + box.w <= brief.left || b.left >= brief.right || b.top + box.h <= brief.top || b.top >= brief.bottom;
  const fits = b => b.left >= 8 && b.left + box.w <= vw - 8 && b.top >= 8 && b.top + box.h <= vh - 8;
  if (clears(box)) return box;
  const tries = [
    { left: box.left,                top: brief.top - box.h - 12 },   // above — same column as the anchor, clear of COMMS
    { left: brief.right + 12,        top: box.top },                  // right of it
    { left: box.left,                top: brief.bottom + 12 },        // below
    { left: brief.left - box.w - 12, top: box.top }                   // left of it
  ];
  for (const c of tries) if (clears(c) && fits(c)) { box.left = c.left; box.top = c.top; return box; }
  return box;
}

/* ================= LANE 2 — CONNECT YOUR WORLD (the tour's last beat) =================
   Pure (top-level, outside the IIFE like dodgeRect, so the gate can require() it). Topic → connector map. Matching rides TopicMatch.coverage (the ONE matcher every shelf uses) over the
   Commander's GOALS beliefs; each topic is a handful of single-token labels so "run my newsletter" finds
   email and "grow the site" finds website. Order is priority order; the list is capped at 3. With no
   matching goal the generic top-3 (gmail · google-calendar · google-docs) is offered instead. */
const CONNECT_TOPICS = [
  { topic: 'email',    words: ['email', 'emails', 'inbox', 'gmail', 'newsletter', 'mailing'], ids: ['gmail'] },
  { topic: 'website',  words: ['website', 'site', 'landing', 'webflow', 'wix', 'blog'],      ids: ['webflow', 'wix'] },
  { topic: 'calendar', words: ['calendar', 'schedule', 'scheduling', 'meetings', 'booking'], ids: ['google-calendar'] },
  { topic: 'docs',     words: ['docs', 'document', 'documents', 'writing', 'notes', 'drafts'], ids: ['google-docs'] }
];
const CONNECT_GENERIC = ['gmail', 'google-calendar', 'google-docs'];
const CONNECT_LABEL = { gmail: 'Gmail', webflow: 'Webflow', wix: 'Wix', 'google-calendar': 'Google Calendar', 'google-docs': 'Google Docs' };
function wordHits(word, corpus) {
  if (typeof TopicMatch !== 'undefined' && TopicMatch.coverage) return TopicMatch.coverage(word, corpus) > 0;
  return String(corpus || '').toLowerCase().indexOf(String(word).toLowerCase()) !== -1;   // node shim / load-order fallback
}
// pure: goal texts → ordered connector ids (≤3). Exported on the node shim so the gate pins it.
function connectOffers(texts) {
  const corpus = (Array.isArray(texts) ? texts : []).map(t => String(t || '')).join(' ').toLowerCase();
  const out = [];
  if (corpus.trim()) {
    const hit = CONNECT_TOPICS.filter(t => t.words.some(w => wordHits(w, corpus)));
    // every matched topic gets its FIRST connector before any topic gets a second (wix never crowds out calendar)
    for (let rank = 0; rank < 2; rank++) for (const t of hit) {
      const id = t.ids[rank];
      if (id && out.length < 3 && out.indexOf(id) === -1) out.push(id);
    }
  }
  return out.length ? out : CONNECT_GENERIC.slice();
}
// READ-BACK truth: the FIRST STEPS connector step counts only a connector the host lists as `up`.
function connectorUp(list) { return Array.isArray(list) && list.some(c => c && c.state === 'up'); }

const Tutorial = (() => {
  const KEY = 'starnet.tutorial.v1';
  let state = load();
  let active = false, wired = false, finished = false, replayMode = false;
  let agentName = 'AGENT';
  // one-shot latches so a repeated bus event can never double-narrate a beat
  let sawStart = false, sawPermission = false, sawEnd = false, sawDeny = false;
  let cleanRunId = null;   // the demo run's id — captured ONLY on a clean, un-denied finish (it gates the handoff pitch)
  let stallTimer = null;   // failsafe: if the real run never reaches the bus (sidecar down / bad key), narrate honestly instead of freezing
  // THE KIT-OUT (the floor is REAL): the first lesson is the moat — the Commander PLACES the capability gear
  // (cabinet→FILES · dish→WEB · workbench→TERMINAL · server→MEMORY) and each placement hands the agent a genuine
  // power (heroCaps → the run's real tools), so the first real job runs against tools that actually exist.
  let kitMode = false, kitNeeded = null, kitComplete = false, kitWasOpen = false, kitPollTimer = null;
  let kitHold = false, kitFlashTimer = null, kitFocusKey = null, kitReadyTimer = null;   // kit-out: flash-hold + the current sub-step's spotlight key + the post-flash "ready" timer

  function load() {
    let r = null;
    try { r = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
    if (!r || r.v !== 1) r = { v: 1 };
    if (typeof r.firstCommandDone !== 'boolean') r.firstCommandDone = false;
    if (!r.seen || typeof r.seen !== 'object') r.seen = {};
    if (!r.brief || typeof r.brief !== 'object') r.brief = {};          // P3 first-steps progress
    if (typeof r.briefDismissed !== 'boolean') r.briefDismissed = false;
    if (typeof r.briefComplete !== 'boolean') r.briefComplete = false;
    return r;
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  const hasChat = () => typeof Chat !== 'undefined' && Chat.typeLine && Chat.localLine && Chat.choices;
  const seg = (t, cps, hold) => ({ text: t, cps: cps || 46, holdAfter: hold || 0 });
  function say(segs, onDone) {            // an agent line (or lines) in COMMS, via the awakening typewriter
    if (!hasChat()) { if (onDone) onDone(); return; }
    Chat.typeLine(typeof segs === 'string' ? [seg(segs)] : segs, onDone);
  }
  function sfx(n) { try { if (typeof SFX !== 'undefined' && SFX[n]) SFX[n](); } catch (_) {} }

  /* ---- overlay coordinate law: anchor rects are VISUAL px; our overlays (spot/ring/bubble/brief) are
     fixed body children whose style px may or may not be re-scaled by body.style.zoom (TEXT SIZE) —
     engines disagree (Chromium re-multiplies fixed children by the zoom, WebKit renders them 1:1).
     Trusting the zoom VALUE therefore misaims on one engine or the other (the "ring on the wrong
     button" report). So MEASURE the live behavior instead: a hidden fixed probe of style-width 100
     reports its rendered width, and visual/style is exactly the divisor every overlay needs. */
  let scaleProbe = null;
  function overlayScale() {
    if (!scaleProbe || !document.body.contains(scaleProbe)) {
      scaleProbe = document.createElement('div');
      scaleProbe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:0;visibility:hidden;pointer-events:none;';
      document.body.appendChild(scaleProbe);
    }
    const w = scaleProbe.getBoundingClientRect().width;
    return w > 0 ? w / 100 : 1;
  }

  /* ---- spotlight: a soft scrim with a cut-out hole over the surface being discussed ----
     The hole is a positioned div whose huge box-shadow IS the scrim; pointer-events:none so the
     highlighted control stays fully clickable underneath (chips, the consent buttons, etc.). */
  let spot = null, spotEl = null;
  function place(r) {
    const pad = 6, z = overlayScale();
    spot.style.left = (r.left / z - pad) + 'px'; spot.style.top = (r.top / z - pad) + 'px';
    spot.style.width = (r.width / z + pad * 2) + 'px'; spot.style.height = (r.height / z + pad * 2) + 'px';
  }
  function reposition() { if (spot && spotEl) place(spotEl.getBoundingClientRect()); }
  function spotlight(sel) {
    clearSpot();
    const el = (typeof sel === 'string') ? document.querySelector(sel) : sel;
    if (!el) return;
    spot = document.createElement('div'); spot.className = 'tut-spot';
    spotEl = el; place(el.getBoundingClientRect());
    document.body.appendChild(spot);
    window.addEventListener('resize', reposition);
  }
  function clearSpot() {
    if (spot) { window.removeEventListener('resize', reposition); spot.remove(); spot = null; spotEl = null; }
  }

  /* The floating "skip intro" corner button was REMOVED per Andrew (2026-07-20): it read as
     dev chrome sitting in the titlebar corner, and v0.6.1's law is onboarding-is-never-skipped.
     The in-panel dialogue outs (res.skip → finishUp) remain the bail path — no-gating holds. */

  /* ================= THE FIRST COMMAND ================= */
  // The demo is fs.write + fs.read — but the fresh station is COMPUTE-ONLY (the moat: web/files/terminal must be
  // PLACED, see sidecar/capability/office.js + capgate F1). So the FIRST lesson is the kit-out: the Commander
  // places the real capability gear, the agent genuinely gains files (heroCaps → fs.read/fs.write), and ONLY THEN
  // does this run — so the walk → consent → execute → prove loop is real, never an app-lie. fs.write requires
  // consent, so the Commander still sees the genuine consent gate; placing the CABINET first is what makes it true.
  const TASK = 'write the line "starnet online" to a file called hello.txt, then read it back and show me';

  // the capability gear the kit-out walks through, in order. `grant` is the power-word grantLabelForProp returns
  // when its prop lands; `prop` is the catalog id we point at. The display LABEL and the CATEGORY tab are resolved
  // from the LIVE catalog at runtime (resolveKit) so the coach can never name a prop or tab that doesn't exist —
  // the root of the old "the CABINET"/"REFIT button" drift. FILES is first so the fs demo that follows is honest.
  // (COMPUTE isn't here — always-on freebie + a synthetic desk; a SEATED workstation is editable so it doesn't
  // fire onPropPlaced, but the WORKBENCH does, which is why TERMINAL can ride the placement loop. Note the
  // workbench lives under WORKSTATIONS, the other three under CAPABILITY — resolveKit carries that, so the loop
  // guides the category switch instead of stranding the Commander.)
  const KIT_SPEC = [
    { grant: 'FILES',    prop: 'war_intelcab',    label: 'INTEL CAB',   power: 'FILES',      got: 'files equipment placed. it supports reading and writing files within your allowed folders.' },
    { grant: 'WEB',      prop: 'comms_dish',      label: 'DISH',        power: 'the WEB',    got: 'web equipment placed. it supports search and browsing; service setup and access settings still apply.' },
    { grant: 'TERMINAL', prop: 'workbench',       label: 'WORKBENCH',   power: 'a TERMINAL', got: 'terminal equipment placed. it supports commands and checks, subject to your access settings.' },
    { grant: 'MEMORY',   prop: 'gigs_servercart', label: 'SERVER CART', power: 'MEMORY',     got: 'memory equipment placed. it supports saving and retrieving notes and procedures.' }
  ];
  let KIT = KIT_SPEC.slice();   // resolveKit() rebuilds this with live labels/categories at kit start

  const hasDialogue = () => typeof Dialogue !== 'undefined';
  // a felt list: ["FILES","WEB","TERMINAL"] -> "FILES, WEB and TERMINAL"
  function listWords(a) { a = (a || []).slice(); if (a.length <= 1) return a[0] || ''; const last = a.pop(); return a.join(', ') + ' and ' + last; }
  // a Dialogue narration beat that no-ops gracefully if the panel is gone (keeps the async chains safe)
  function dsay(text, cps, hold) { return hasDialogue() ? Dialogue.say([seg(text, cps, hold)]) : Promise.resolve(); }

  function firstCommand(opts) {
    // Automatic onboarding is one-shot. The Field Manual may deliberately replay the same real tour.
    if (state.firstCommandDone && !(opts && opts.replay)) return;
    if (!hasChat()) return;
    agentName = (opts && opts.name) || agentName;
    replayMode = !!(opts && opts.replay);
    active = true; finished = false; sawStart = sawPermission = sawEnd = sawDeny = false; cleanRunId = null;   // C1: un-latch finishUp for this fresh run (it's symmetric with the saw-flags; without it a prior agent's completed lesson left finishUp a no-op)
    kitMode = false; kitComplete = false; kitWasOpen = false; kitNeeded = null;
    wireBus();
    // The handoff from the awakening: the DIALOGUE panel is already open (onboarding's closeOut left it up).
    // Offer the tour EXPLICITLY — a clear "SHOW ME AROUND" vs "dive in myself" choice, not a buried chip. This
    // kills the old rhetorical "where do we begin?" self-answer the Commander found confusing.
    if (!hasDialogue()) { finishUp(true); return; }   // no panel → don't trap the Commander in a half-built tour
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('let’s take one real burden off your list. give me notes, messages, or an approved folder and i’ll make a useful draft you can review. you can also take the optional station tour.', 44, 0)],
      options: [
        ...(typeof FirstValue !== 'undefined' ? [{ label: '▸ MAKE SOMETHING USEFUL (recommended)', value: 'value' }] : []),
        { label: 'SHOW ME AROUND', value: 'tour' },
        { label: 'I’ll dive in myself', value: 'skip', skip: true }
      ]
    }).then(res => {
      if (!active) return;
      if (res.value === 'value') {
        // A concrete first task owns the handoff: do not overlay the connector pitch or a second coach.
        finishUp(true, true);
        if (FirstValue.open() === false && hasChat()) Chat.localLine('open RECIPES to choose a useful first task. the optional tool tour is still in the field manual.');
        return;
      }
      if (res.skip) return finishUp(true);
      beatShowAround();
    });
  }

  /* Optional equipment tour. The walk illustrates the workstation, not a tool-access check.
     Profiles and Full Access may already supply tools, so never narrate a fabricated failed attempt. */
  function beatShowAround() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();                 // clear COMMS so the walk + the agent are fully visible
    try { if (typeof World !== 'undefined' && World.setActivity) World.setActivity('task'); } catch (_) {}   // send the hero to its desk (pure roleplay — emits no run, claims no work)
    try { if (typeof World !== 'undefined' && World.camPushIn) World.camPushIn(); } catch (_) {}
    rpWalkPoll(0);
  }
  function rpWalkPoll(tries) {
    if (!active) return;
    let arrived = false;
    try { const d = (typeof World !== 'undefined' && World.dbg) ? World.dbg() : null; arrived = !!(d && d.goal === 'work' && d.sitting); } catch (_) {}
    if (arrived || tries > 60) return rpArrived();        // ~6s failsafe @100ms — never freeze waiting on the walk
    setTimeout(() => rpWalkPoll(tries + 1), 100);
  }
  async function rpArrived() {
    if (!active) return;
    if (hasDialogue()) Dialogue.open({ name: agentName });
    try { World.say('my desk.'); } catch (_) {}
    await dsay('this is my workstation. start by telling me what you want done in COMMS. you don’t need to build a conveyor for a normal task.', 44, 360);
    if (!active) return;
    try { if (World.truthPulse) World.truthPulse(); World.say('tools for the task.'); } catch (_) {}
    await dsay('props with ability badges provide tools, like files, web or a terminal. decoration changes how the station looks.', 44, 360);
    if (!active) return;
    await dsay('you only need the abilities your work uses. ABILITIES shows my current access — your settings may already provide the tools without extra props.', 44, 280);
    if (!active) return;
    beatKitInvite();
  }
  function beatKitInvite() {
    if (!active) return;
    if (!hasDialogue()) return beatKitIntro();
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('want to try placing equipment? this optional tour demonstrates four abilities. matching badges are alternatives — you don’t need every prop, and you can stop whenever you like.', 44, 0)],
      options: [
        { label: '▸ TRY THE EQUIPMENT TOUR', value: 'go' },
        { label: 'I’ll explore on my own', value: 'skip', skip: true }
      ]
    }).then(res => { if (!active) return; if (res.skip) return finishUp(true); beatKitIntro(); });
  }

  /* ---- THE KIT-OUT: a guided, GLOW-DRIVEN placement loop. One self-rescheduling tick (kitTick) is the whole
     goal system: each pass it reads the live UI and lights exactly the single next control along the real path —
     BUILD dock ▸ REFIT STATION ▸ ⚇ PROP ▸ the right CATEGORY tab ▸ the exact gear tile — naming each with the
     REAL catalog label. A category switch, a placement, or closing REFIT all advance it cleanly: no stale copy,
     no covered buttons, no freeze. resolveKit() pins the labels/categories to the live catalog so they can't drift. */
  const q = sel => document.querySelector(sel);
  const CATLABEL = { workstation: 'WORKSTATIONS', workflow: 'WORKFLOW', capability: 'CAPABILITY', isolation: 'ISOLATION' };
  function resolveKit() {
    const cat = (typeof PropSprites !== 'undefined' && PropSprites.CATALOG) ? PropSprites.CATALOG : [];
    const grantOf = id => (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(id) : null;
    return KIT_SPEC.map(s => {
      const c = cat.find(x => x.id === s.prop) || cat.find(x => grantOf(x.id) === s.grant) || null;
      return Object.assign({}, s, {
        prop: c ? c.id : s.prop,
        label: c ? c.label : s.label,
        cat: c ? c.cat : 'capability',
        catLabel: c ? (CATLABEL[c.cat] || String(c.cat).toUpperCase()) : 'CAPABILITY'
      });
    });
  }

  function beatKitIntro() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();              // reveal the bottom bar so the BUILD-dock glow is visible
    kitMode = true; kitComplete = false; kitWasOpen = false; kitHold = false; kitFocusKey = null;
    KIT = resolveKit();
    kitNeeded = new Set(KIT.map(k => k.grant));
    try { if (typeof World !== 'undefined' && World.say) World.say('build me a floor.'); } catch (_) {}
    kitTick();                                        // the loop takes over: glow BUILD ▸ REFIT STATION, then guide inside
  }
  // the goal loop. Catches REFIT open/close from any path; self-clears on finishUp/teardown.
  function kitTick() {
    if (!active || !kitMode) return;
    const open = !!(typeof Build !== 'undefined' && Build.isOpen && Build.isOpen());
    if (open && !kitWasOpen) { kitWasOpen = true; clearSpot(); kitFocusKey = null; }       // just entered REFIT — drop the bottom-bar scrim
    else if (!open && kitWasOpen) { kitWasOpen = false; return kitClosedDuringPlace(); }   // just left REFIT
    if (open) kitInRefit(); else kitGuideToRefit();
    kitPollTimer = setTimeout(kitTick, 180);
  }
  function nextKit() { return kitNeeded ? KIT.find(k => kitNeeded.has(k.grant)) : null; }

  // OUTSIDE REFIT: light the REAL path into the builder — the BUILD dock, then REFIT STATION once that dock opens.
  function kitGuideToRefit() {
    const station = q('#bb-build');
    const menuOpen = !!(station && station.getClientRects().length);   // REFIT STATION is only visible once its dock is open
    if (menuOpen) kitFocus(station, 'now hit ⌂ REFIT STATION — that opens REFIT, where you build my floor.', 'to-refit-station', { scrim: true, zone: 'bottom' });
    else kitFocus(q('.bb-group[data-group="build"] .bb-grp'), 'open the ⚒ BUILD dock down in the bar, then ⌂ REFIT STATION — that’s where you kit me out.', 'to-refit-grp', { scrim: true, zone: 'bottom' });
  }

  // INSIDE REFIT: compute the single next sub-step and glow exactly that control, named with the REAL label + tab.
  function kitInRefit() {
    if (kitHold) return;                              // a "✓ placed" flash is breathing — don't fight it
    const k = nextKit();
    if (!k) return beatKitReady();
    const tool = (q('.refit-tool.active') || {}).dataset;
    if (!tool || tool.tool !== 'prop')
      return kitFocus(q('.refit-tool[data-tool="prop"]'), 'tap PROPS (key 6) in the build panel — that opens the gear menu.', 'step-prop');
    const abilities = q('[data-prop-section="abilities"]');
    const offerReq = kitNeeded && kitNeeded.size < KIT.length && typeof Build !== 'undefined' && !!Build.requisition;
    if (abilities) {
      if (!abilities.classList.contains('active')) return kitFocus(abilities, 'open ABILITIES — these props add real tools.', 'step-abilities');
      const core = q('.refit-core-card[data-prop="' + k.prop + '"]');
      if (!core) return kitFocus(q('[data-access-cap="' + WorldModel.capForProp(k.prop) + '"]'), 'choose ' + k.power + ' in the core tool access row.', 'step-core-ability');
      return kitFocus(core, 'choose ' + k.power + ' (' + k.label + '), then click a clear tile in my room to place it.', 'step-tile-' + k.prop + (offerReq ? '-req' : ''),
        offerReq ? { action: { label: '⚡ requisition the rest', onClick: runRequisition } } : undefined);
    }
    // all capability + workstation gear is on the ⚙ SYSTEMS tier; if they wandered into ✦ DECOR, bring them back
    const tierActive = q('.refit-tier.active'), tierFn = q('.refit-tier-functional');
    if (tierFn && tierActive && tierActive !== tierFn)
      return kitFocus(tierFn, 'switch to ⚙ SYSTEMS — the gear that grants powers lives here, not in DECOR.', 'step-tier');
    const catA = (q('.refit-propcat.active') || {}).dataset;
    const categoryMenu = q('.refit-category-menu');
    if ((!catA || catA.cat !== k.cat) && categoryMenu && !categoryMenu.open)
      return kitFocus(q('#refit-category-trigger'), 'open CATEGORY, then choose ' + k.catLabel + ' — that’s where ' + k.label + ' lives.', 'step-category-picker');
    if (!catA || catA.cat !== k.cat)
      return kitFocus(q('.refit-propcat[data-cat="' + k.cat + '"]'), 'choose ' + k.catLabel + ' — that’s where ' + k.label + ' lives.', 'step-cat-' + k.cat);
    // right tool, right tier, right tab — light the exact tile, named with its REAL catalog label.
    // COMPRESSION: the first placement teaches the loop; reps 2–4 teach nothing new. Once one needed cap is
    // down, every remaining tile step carries a one-tap "requisition the rest" — the agent places its own
    // remaining gear through the REAL path (Build.requisition), each landing scored by the normal hook.
    return kitFocus(q('.refit-proptile[data-prop="' + k.prop + '"]'),
      'pick ' + k.label + ' (' + k.power + '), then click a spot in my room to drop it in.' + (offerReq ? ' — or say the word and i’ll requisition the rest myself.' : ''),
      'step-tile-' + k.prop + (offerReq ? '-req' : ''),
      offerReq ? { action: { label: '⚡ requisition the rest', onClick: runRequisition } } : undefined);
  }
  // "requisition the rest" — the agent places its own remaining gear through the REAL placement path
  // (Build.requisition → station.addProp at a validated tile). Each landing fires the normal placement hook
  // (build.js → onPropPlaced → kitOnPropPlaced), so the loop scores/flashes/completes exactly as if the
  // Commander dropped it by hand. Staggered so each ✓ + chime reads; a floor with no clear tile for a piece
  // degrades honestly back to hand placement (the tick re-lights that tile).
  function runRequisition() {
    if (!active || !kitMode || !kitNeeded) return;
    const left = KIT.filter(k => kitNeeded.has(k.grant));
    if (!left.length) return;
    clearCoach(); kitFocusKey = null;
    let di = 0;
    for (const k of left) {
      setTimeout(() => {
        if (!active || !kitMode || !kitNeeded || !kitNeeded.has(k.grant)) return;   // hand-placed meanwhile / tour over
        const res = (typeof Build !== 'undefined' && Build.requisition) ? Build.requisition(k.prop) : null;
        if (!res || !res.ok) kitFlash('no clear floor for ' + k.label + ' — drop it by hand wherever you like.');
      }, 260 + (di++) * 820);
    }
  }
  // a placement landed (build.js → onPropPlaced → here). grant is the power-word, or null for inert decor.
  // Forgiving + order-free: any needed cap checks off; a spare or decor just flashes a nudge. The tick re-lights
  // the next step automatically once the flash clears — so this only scores the placement, it never has to re-aim.
  function kitOnPropPlaced(grant) {
    if (!active || !kitMode) return;
    tickBrief('build');
    if (!grant) { kitFlash('decoration placed. to try an ability in this tour, choose equipment with an ability badge.'); return; }
    if (!kitNeeded.has(grant)) {
      kitFlash('another ' + grant + ' prop placed. matching badges are alternatives, so extra copies add no new tools.');
      if (!nextKit()) kitReadyTimer = setTimeout(() => { kitReadyTimer = null; if (active && kitMode) beatKitReady(); }, 1700);
      return;
    }
    kitNeeded.delete(grant);
    const k = KIT.find(x => x.grant === grant);
    kitFlash('✓ ' + (k ? k.power : grant) + ' — ' + (k ? k.got : ''));
    if (!nextKit()) kitReadyTimer = setTimeout(() => { kitReadyTimer = null; if (active && kitMode) beatKitReady(); }, 1700);   // else: the tick lights the next step after the flash
  }
  function beatKitReady() {
    if (!active || !kitMode || kitComplete) return;   // latch: the tick + the post-flash timer both reach here — run once
    kitComplete = true;
    kitFocus(q('#refit-done'), 'that’s the whole kit — files, web, a terminal, memory. hit ✓ DONE up top to step back out.', 'step-done');
    // kitTick sees REFIT close → kitClosedDuringPlace → (all placed) → beatFullyEquipped
  }
  // REFIT closed during the kit-out. The tutorial's COMPLETION CONDITION is "every capability prop placed" —
  // when that's met we celebrate + offer an optional real-job demo, then END. If they closed early we never
  // dead-end (Theme 3): name what's wired vs still dark and offer to keep going or stop here. The Commander's
  // floor, always.
  function kitClosedDuringPlace() {
    if (!active) return;
    clearCoach(); clearSpot();
    clearKitTimers();
    kitHold = false; kitFocusKey = null;
    const allPlaced = kitComplete || (kitNeeded && kitNeeded.size === 0);
    if (allPlaced) { kitMode = false; return beatFullyEquipped(); }
    // closed before the kit is complete — honest accounting, then a path forward (never a trap)
    kitMode = false;
    const placed = KIT.filter(k => kitNeeded && !kitNeeded.has(k.grant)).map(k => k.grant);
    const left = KIT.filter(k => kitNeeded && kitNeeded.has(k.grant)).map(k => k.grant);
    const have = placed.length ? 'you’ve placed equipment for ' + listWords(placed) + '. ' : 'no equipment placed in this tour yet. you can still talk to me in COMMS. ';
    const dark = left.length ? 'remaining tour examples: ' + listWords(left) + '.' : '';
    if (!hasDialogue()) return placed.length ? beatEquippedPartial() : finishUp(true);
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg(have + dark + ' continue the optional tour?', 44, 0)],
      options: [
        { label: '▸ CONTINUE THE TOUR', value: 'go' },
        { label: placed.length ? 'That’s enough for now' : 'Skip for now', value: 'skip', skip: true }
      ]
    }).then(res => {
      if (!active) return;
      if (res.skip) return placed.length ? beatEquippedPartial() : finishUp(true);
      if (hasDialogue()) Dialogue.close();
      kitMode = true; kitWasOpen = false; kitHold = false; kitFocusKey = null;   // re-arm; the tick re-lights the path back in
      kitTick();
    });
  }

  /* THE BAIL — the kit-out is opt-IN, so it must be opt-OUT-able at any moment (sandbox law: never a mode the
     Commander can't leave). Before this, the only exits were "place all four" or "open REFIT then close it":
     a Commander who accepted the tour and changed their mind at the very first step — the BUILD-dock glow,
     OUTSIDE REFIT — had no dismiss button and no Esc, just a permanent half-dimmed station.
     Inside REFIT we simply close it and let the tick take the normal exit (REFIT owns Esc there); outside, we
     run the same accounting directly. Either way the Commander lands on kitClosedDuringPlace's honest
     "here's what's wired, here's what's still dark — keep going or stop here" choice, never a dead end. */
  function kitBail() {
    if (!active || !kitMode) return;
    sfx('click');
    if (typeof Build !== 'undefined' && Build.isOpen && Build.isOpen() && Build.close) { Build.close(); return; }   // kitTick sees the close → kitClosedDuringPlace
    kitWasOpen = false;
    kitClosedDuringPlace();
  }

  // FULLY EQUIPPED — the completion beat. Every capability prop is placed; the agent is whole. Offer the
  // optional "watch me actually use it" demo, then hand the Commander the free station. This is where the
  // tutorial ENDS (the user's bar: end the tour when full capability is placed).
  function beatFullyEquipped() {
    if (!active) return;
    sfx('level');
    if (!hasDialogue()) return beatCommand();
    Dialogue.open({ name: agentName });
    Dialogue.node({
      lines: [seg('you’ve tried equipment for files, web, terminal and memory. that’s the placement loop. ABILITIES shows which tools i can use with my current settings. choose what your real tasks need.', 44, 460)],
      options: [
        { label: '▸ Watch me use it on a real job', value: 'demo' },
        { label: 'I’ve got it from here', value: 'done', skip: true }
      ]
    }).then(res => { if (!active) return; if (res.value === 'demo') return beatCommand(); finishUp(false); });
  }
  // they stopped with SOME gear placed — a real, partial agent. Acknowledge honestly and bow out (no nag).
  function beatEquippedPartial() {
    if (!active) return;
    dsay('you can add equipment in REFIT whenever a task needs it. for now, tell me what you want done in COMMS.', 44, 320).then(() => finishUp(false));
  }

  // THE OPTIONAL DEMO — the real fs.write + fs.read loop, now that the agent is genuinely equipped. The panel
  // CLOSES so the real run (the consent gate, the tool lines) is visible in COMMS; the bus-timed beats narrate
  // the genuine run, never a sim. Reached only from beatFullyEquipped, so the Commander already opted in — no
  // extra chip, straight to the run.
  function beatCommand() {
    if (!active) return;
    if (hasDialogue()) Dialogue.close();                 // reveal COMMS so the real loop is watchable
    demoPreflight().then(ready => {
      if (!active) return;
      if (!ready.ok) return beatSidecarDown(ready.why);  // can't actually run → own it in words, no scary error, no 8s freeze
      spotlight('#chat-panel');
      say([
        seg('watch, then. i’ll use the files you just gave me — write a line, read it back — right here on your machine.', 46, 380),
        seg('  and watch me stop to ask before i touch anything. heading to my station now.', 46, 0)
      ], () => { clearSpot(); if (typeof Chat.send === 'function') Chat.send(TASK); armStall(); });   // hand off to the REAL loop (+ a failsafe if it never reaches the bus)
    });
  }
  // the demo is a REAL run — only attempt it when it can actually land: a configured brain AND a reachable sidecar.
  // Without both, Chat.send throws a raw "no key" / "cannot reach the STARNET sidecar" line and the run never walks
  // (the user's "the end test fails" report). Preflight, and if it can't run, narrate the truth and teach on.
  function demoPreflight() {
    const model = (typeof Harness !== 'undefined' && Harness.getModel) ? Harness.getModel() : '';
    const prov = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
    const cfg = (typeof Harness !== 'undefined' && Harness.configured) ? Harness.configured() : false;
    if (!model || (prov !== 'codex' && !cfg)) return Promise.resolve({ ok: false, why: 'brain' });
    if (typeof fetch === 'undefined') return Promise.resolve({ ok: false, why: 'sidecar' });
    let ctrl = null, to = null;
    try { ctrl = new AbortController(); to = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 2500); } catch (_) {}
    // require the literal 'ok' body, not just a 200 — a static host with a catch-all 200 (serving index.html for
    // /api/health) would otherwise pass preflight and then throw the raw "cannot reach the sidecar" on /api/run.
    return fetch('/api/health', ctrl ? { signal: ctrl.signal } : undefined)
      .then(r => (r && r.ok) ? r.text().catch(() => '') : '')
      .then(t => { if (to) clearTimeout(to); return { ok: String(t).trim() === 'ok', why: 'sidecar' }; })
      .catch(() => { if (to) clearTimeout(to); return { ok: false, why: 'sidecar' }; });
  }
  function beatSidecarDown(why) {
    if (!active) return;
    const line = (why === 'brain')
      ? 'one honest thing before i fake anything: i don’t have a brain wired up yet — no model or key set — so i can’t actually run this. set one in CONNECT, then point me at a real job and watch the loop for real.'
      : 'and… i can’t reach my own hands yet. the local sidecar — the thing that actually runs me (`npm start`) — isn’t answering, so nothing ran and i won’t pretend it did. start it up, then give me a real job and watch the whole loop.';
    say([seg(line, 44, 480)], beatGauge);
  }
  /* ---- the kit-out spotlight: a coach bubble PINNED to a safe zone (.tut-coach.kit — so it can never cover the
     control it points at, the old "guidance covers the buttons" bug) + a pulsing ring on the exact target + an
     optional scrim. Only rebuilds when the sub-step KEY changes; between rebuilds the ring just tracks the live
     element (no per-tick flicker). The live target is re-queried each tick, so a palette re-render can't strand it. */
  function kitFocus(target, text, key, opts) {
    opts = opts || {};
    if (key === kitFocusKey && coach && coach.bubble && coach.kit) { coach.anchor = target || null; return; }   // same step — just retarget the live ring
    kitFocusKey = key;
    clearCoach();
    if (opts.scrim && target) spotlight(target); else clearSpot();
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach kit ' + (opts.zone === 'bottom' ? 'kit-bottom' : 'kit-top') + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    bubble.appendChild(who); bubble.appendChild(body);
    // an optional one-tap ACTION in the bubble (the coach is the only UI visible over REFIT) — used by the
    // kit-out's "requisition the rest" offer. Reuses the .tut-coach-ok button styling.
    if (opts.action && opts.action.label) {
      const act = document.createElement('button'); act.className = 'tut-coach-ok'; act.type = 'button'; act.textContent = opts.action.label;
      act.onclick = () => { sfx('click'); try { if (opts.action.onClick) opts.action.onClick(); } catch (_) {} };
      bubble.appendChild(act);
    }
    // THE VISIBLE WAY OUT (see kitBail). Every kit-out step carries it, because the coach is the only UI the
    // Commander can reach over the scrim — without it, accepting the tour was a one-way door.
    const bail = document.createElement('button'); bail.className = 'tut-coach-bail'; bail.type = 'button'; bail.textContent = '✕ not now';
    bail.onclick = kitBail;
    bubble.appendChild(bail);
    document.body.appendChild(bubble);
    let ring = null;
    if (target) { ring = document.createElement('div'); ring.className = 'tut-ring' + (reduceMotion() ? ' no-anim' : ''); document.body.appendChild(ring); }
    // Esc bails too — but only when nothing else claims the key, matching briefKey's guard below. Inside
    // REFIT, build.js's own Esc closes the builder and kitTick reads that close as the very same exit
    // (double-handling would fire kitClosedDuringPlace twice and stack two dialogue nodes); over an open
    // station panel, Esc belongs to the panel — the bottom bar stays live under the scrim, so a Commander
    // really can open one mid-kit-out, and one keypress must not both close it and end the tour.
    const onKey = e => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.refit-overlay') || document.querySelector('#terms .term')) return;
      kitBail();
    };
    window.addEventListener('keydown', onKey);
    coach = { bubble, ring, anchor: target, raf: 0, onKey, kit: true };
    placeCoach();
    sfx('open');
  }
  // a transient "✓ placed / spare / decor" acknowledgement — pinned top, no ring. Holds the loop for a beat so the
  // win reads before the tick re-lights the next target.
  function kitFlash(text) {
    kitHold = true; kitFocusKey = 'flash';
    clearCoach(); clearSpot();
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach kit kit-top' + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    bubble.appendChild(who); bubble.appendChild(body);
    document.body.appendChild(bubble);
    coach = { bubble, ring: null, anchor: null, raf: 0, onKey: null, kit: true };
    sfx('truth');
    if (kitFlashTimer) clearTimeout(kitFlashTimer);
    kitFlashTimer = setTimeout(() => { kitHold = false; kitFocusKey = null; }, 1600);
  }

  /* ---- bus-timed beats: the real run drives the rest of the lesson ----
     util.js's bus has no off(); every handler is guarded by `active` so post-tutorial runs are ignored. */
  function wireBus() {
    if (wired || typeof U === 'undefined' || !U.bus) return;
    wired = true;
    U.bus.on('agent.run.start', () => { if (active && !sawStart) { sawStart = true; clearStall(); onRunStart(); } });
    U.bus.on('permission.prompt', () => { tickBrief('approve'); if (active && !sawPermission) { sawPermission = true; onPermission(); } });
    U.bus.on('permission.response', p => { if (active && p && p.decision === 'deny') sawDeny = true; });   // so onRunEnd narrates a Deny honestly, never "i ran it and showed you the result"
    // FIRST-STEPS "give a command" tracks any CLEAN run (tutorial or not) — outside the active guard so it keeps
    // working for the whole session; gated on reason==='done' so an errored run no longer falsely ticks it.
    // The NARRATION (onRunEnd) is separate, active-guarded, and branches on the real outcome.
    U.bus.on('agent.run.end', p => {
      if (p && p.reason === 'done') tickBrief('command');
      if (active && !sawEnd) { sawEnd = true; clearStall(); onRunEnd(p); }
    });
  }
  function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
  // armed right after Chat.send(TASK): if neither run.start nor run.end has fired, the run never reached the
  // sidecar (it isn't running, or the key's bad) — so the agent NEVER walked. Own that honestly and finish the
  // lesson in words instead of leaving the Commander staring at a frozen "i'm heading to my station".
  function armStall() {
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!active || sawStart || sawEnd) return;
      sawEnd = true;   // latch so a very-late bus event can't double-narrate
      say([
        seg('huh — i didn’t actually move. i can’t reach my own hands yet.', 44, 420),
        seg('  the sidecar isn’t running, or the key’s off — so nothing ran, and i won’t pretend it did. start it up and tap me again. here’s the rest in words for now:', 44, 0)
      ], beatGauge);
    }, 8000);
  }

  // the agent is now walking to the desk (chat.js set World.setActivity('task') the instant the chip fired)
  function onRunStart() {
    if (!active) return;
    say([seg('there i go. that desk is where i actually go to work — for real, on your machine. this isn’t a cutscene.', 44, 0)]);
  }
  // the real consent prompt has just appeared in COMMS (harness emits on the bus around when chat.js draws the row).
  // Copy avoids spatial words ("below") so it stays correct under trunk's pinned-reply COMMS ordering after a sync.
  function onPermission() {
    if (!active) return;
    say([
      seg('stop — see that prompt? before i touch anything that matters, it surfaces right here and waits for you.', 44, 360),
      seg('  approve once, always, or kill it. that pause is your hand on the switch. go ahead — approve it.', 44, 0)
    ]);
  }
  // wrap-up: tell the TRUTH about what actually happened. agent.run.end fires for done/stop/limit/error, and a
  // Deny ends the run without writing anything — so we never assert "ran it and showed you the result" unless it
  // genuinely did. Each path still lands on beatGauge so the lesson completes; only a clean run earns the win.
  function onRunEnd(p) {
    if (!active) return;
    const reason = p && p.reason;
    let line;
    if (sawDeny) {
      line = 'and you killed it — good. that wasn’t for show: your “deny” stuck, nothing got written, and the run stopped cold. that pause is your hand on the switch, every time.';
    } else if (reason === 'done') {
      cleanRunId = (p && p.runId) || null;   // a clean, un-denied demo run — the ONLY ticket to the handoff pitch
      const did = sawPermission
        ? 'i walked over, asked your permission first, ran it, and showed you the result instead of just claiming it.'
        : 'i walked over, ran it right here on your machine, and showed you the result instead of just claiming it.';
      line = 'and… done. that was the whole loop, for real: ' + did;
    } else {
      // the run reached the desk but didn't finish clean (error / stopped / limit) — never claim a result we don't have.
      line = 'and… that one didn’t land — it errored out before it finished. that’s the honest part: it’s real, so real things can fail sometimes. the loop’s still the loop — ask, i work, i prove it, you stay in control.';
    }
    setTimeout(() => { if (active) say([seg(line, 42, 600)], beatGauge); }, 500);
  }
  // every post-run beat early-outs on !active, so a "skip intro" mid-run halts the chain cleanly
  function beatGauge() {
    if (!active) return;
    say([seg('that little bank by my desk is my memory filling up — green fine, red means i’m losing the early stuff.', 42, 0)], beatCrew);
  }
  function beatCrew() {
    if (!active) return;
    spotlight('#left');
    say([
      seg('one honest thing, because i won’t lie to you: right now it’s just me.', 42, 360),
      seg('  the others in that crew list are echoes — minds you haven’t recruited yet. recruit one and it takes a station of its own — and i start handing it the pieces. that’s the real job: i grow the crew, then i point it.', 42, 0)
    ], () => { clearSpot(); beatWork(); });
  }
  // UX audit finding 6 (2026-07-15): the tour taught capabilities/consent/crew/quests but never the WORK
  // vocabulary — recipes, tasks, routines, channels just sat in the dock unexplained. ONE beat, both paths
  // (it runs before the pitch/classic fork so a delivered pitch can't skip it).
  function beatWork() {
    if (!active) return;
    say([
      seg('four doors you’ll actually use, all in the bottom bar: ❒ RECIPES is ready-made work — launch one and it lands on ☑ TASKS, where everything i’m doing lives.', 42, 360),
      seg('  put any job on a schedule and it becomes a ⏱ ROUTINE. and ✉ CHANNELS puts me in your pocket — message me from telegram or slack like anyone else.', 42, 0)
    ], beatHandoff);
  }
  function beatHandoff() {
    if (!active) return;
    say([seg('that’s the shape of it: ask, i work, i prove it, you stay in control.', 44, 420)], () => {
      if (!active) return;
      // THE GRADUATION HANDOFF. The demo was a real completed task, so if the station also knows enough about
      // its Commander, the agent ends the tour by POINTING — the First Pitch fires right here instead of the
      // dead-end "go on, i'm yours to point" (a beginner has no idea where to point; that's the whole reason
      // the pitch exists). The auto pitch path correctly stood down while the tour's panel was up
      // (dialogue-open guard); this is the tour handing it the stage deliberately at its close. Falls back to
      // the classic close whenever the pitch can't land (skipped/denied/failed demo, cold dossier, no brain,
      // model hiccup) — the tour never stalls on it, and the un-fired pitch stays armed for a later real task.
      const classicClose = () => {
        if (!active) return;
        // (the WORK-dock orientation lives in beatWork() just before this — don't repeat it here.)
        say([seg('you’ve already kitted me out and seen me work. your next moves stay pinned under ⚑ QUESTS in the ▤ WORK dock — recruit a specialist, lay a belt, bind a portal. go on. i’m yours to point.', 44, 0)],
          () => Chat.choices([{ label: '▸ START COMMANDING', value: 'done' }], () => finishUp(false)));
      };
      const offered = (cleanRunId && typeof PitchStore !== 'undefined' && PitchStore.offerAtHandoff)
        ? PitchStore.offerAtHandoff(cleanRunId) : Promise.resolve(false);
      Promise.resolve(offered).then(delivered => {
        if (!active) return;
        if (delivered) return finishUp(false);   // the pitch (and any "let's build it" run) IS the handoff
        classicClose();
      }, classicClose);
    });
  }

  // clear every kit-out timer in one place so finishUp/teardown/close can't leak one (the teardown contract).
  function clearKitTimers() {
    if (kitPollTimer) { clearTimeout(kitPollTimer); kitPollTimer = null; }
    if (kitFlashTimer) { clearTimeout(kitFlashTimer); kitFlashTimer = null; }
    if (kitReadyTimer) { clearTimeout(kitReadyTimer); kitReadyTimer = null; }
  }

  function finishUp(skipped, valueHandoff) {
    if (finished) return; finished = true;        // idempotent: a late START-COMMANDING click after a skip can't re-run this
    active = false; kitMode = false; clearStall(); clearSpot(); clearCoach();
    clearKitTimers();   // drop the kit-out poll + flash + ready timers if they bailed mid-placement
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();   // reveal COMMS — the tour is over
    // release the roleplay sit (the tour walked the hero to its desk via setActivity('task')); only when no
    // REAL run drove it (a demo's post-run state is owned by the harness — don't yank it).
    if (!sawStart) { try { if (typeof World !== 'undefined' && World.setActivity) World.setActivity('idle'); } catch (_) {} }
    state.firstCommandDone = true;
    if (skipped && !replayMode) state.briefDismissed = true;     // replay never rewrites the saved first-steps preference
    save();
    if (valueHandoff) { replayMode = false; return; }
    if (replayMode) {
      replayMode = false;
      if (hasChat()) Chat.localLine(skipped ? 'quick tour closed — your progress is unchanged.' : 'quick tour complete — your progress is unchanged.');
      return;
    }
    if (skipped) { if (hasChat()) Chat.localLine('right. i’m here when you need me — just type. the field manual’s in the bottom bar when you want it.'); }
    else { sfx('level'); if (!state.briefDismissed && !state.briefComplete) setTimeout(showBrief, 600); }   // hand them the first-steps map
    // THE FLOOR — the tour NEVER ends in silence, the skip path included. Two guaranteed beats, both
    // one-shot: (1) the station offers one concrete first move (PitchStore.offerStarter — generated from
    // the dossier when the brain is live, the quest-log pointer when it isn't; moot if the handoff pitch
    // already delivered), and (2) a coachmark points at the quest log itself — the map says NOTHING glowed
    // at tour end, so a skipper never even learned quests exist. Anchored on the always-visible WORK dock
    // button (never a hidden menu item — the dock-menu spotlight trap).
    // LANE 2 (2026-08-22): "Connect your world" — ONE beat between the checklist and the starter pitch. It
    // reads the dossier GOALS and offers ≤3 connectors by topic; a pick routes into the EXISTING catalog
    // sign-in (no new window, no new visual language). The starter pitch waits for the answer because COMMS
    // chips are ONE layer — Chat.choices() clears any prior row, so firing both at once would eat the offer.
    // Replay never runs it (progress unchanged) and a missing Chat/sidecar falls straight through.
    const afterConnect = () => {
      if (typeof PitchStore !== 'undefined' && PitchStore.offerStarter) PitchStore.offerStarter();
      showCoach('quests', '.bb-group[data-group="work"] .bb-grp',
        'your next moves are pinned under ▤ WORK ▸ ⚑ QUESTS — real progress, tracked as quests. the same dock holds ❒ RECIPES (ready-made jobs), ☑ TASKS (where running work lives) and ∞ AUTOMATION (routines & loops — standing work). nothing in there is ever gated.');
    };
    setTimeout(() => beatConnect(afterConnect), skipped ? 900 : 1400);
  }

  function goalTexts() {
    try {
      if (typeof DossierStore === 'undefined' || !DossierStore.beliefs) return [];
      return (DossierStore.beliefs('goals') || []).map(b => (b && b.text) || '').filter(Boolean);
    } catch (_) { return []; }
  }
  function beatConnect(next) {
    const done = () => { try { next(); } catch (_) {} };
    if (!hasChat() || state.connectOffered) return done();
    state.connectOffered = true; save();                  // one-shot, like every other tour beat
    const ids = connectOffers(goalTexts());
    const items = ids.map(id => ({ label: '⧉ ' + (CONNECT_LABEL[id] || id), value: id }))
      .concat([{ label: 'not now', value: 'skip', skip: true, quiet: true }]);
    say([seg('one more thing. i can reach further than this room — wire a door and i work inside your real tools. the lamp only goes green when the host proves the link.', 44, 0)], () => {
      const row = Chat.choices(items, item => {
        if (!item || item.skip) return done();
        // the CLICK proves nothing — the FIRST STEPS connector step ticks only from the read-back (watchConnectors).
        try { if (typeof StationUI !== 'undefined' && StationUI.connectorJump) StationUI.connectorJump(item.value); } catch (_) {}
        watchConnectors();
        done();
      });
      if (row) {
        row.classList.add('comms-connect-beat');
        row.querySelectorAll('.choice').forEach((b, i) => { if (items[i] && !items[i].skip) b.dataset.connector = items[i].value; });
      }
    });
  }
  // READ-BACK: the `connector` step is marked done only when /api/connectors lists a connector the host
  // proved `up` — never from a click or a sign-in popup opening. Bounded poll (a sign-in takes a minute, not
  // an hour), re-armed on every game entry so a connection made later still lands.
  let connPollTimer = null, connPollLeft = 0;
  function watchConnectors(polls) {
    if (briefDone('connector') || typeof Harness === 'undefined' || !Harness.api || !Harness.api.get) return;
    connPollLeft = Number.isFinite(polls) ? polls : 60;   // ~5 min at 5s after a pick; ONE read on game entry
    if (connPollTimer) return;
    const tick = () => {
      connPollTimer = null;
      if (briefDone('connector') || connPollLeft-- <= 0) return;
      Promise.resolve(Harness.api.get('/api/connectors')).then(j => {
        if (connectorUp(j && j.connectors)) { tickBrief('connector'); return; }
        connPollTimer = setTimeout(tick, 5000);
      }, () => { connPollTimer = setTimeout(tick, 5000); });
    };
    tick();
  }

  function seen(key) { return !!state.seen[key]; }
  function markSeen(key) { state.seen[key] = true; save(); }

  /* ================= P2 — JUST-IN-TIME COACHMARKS =================
     One short, agent-voiced hint the first time the Commander touches a surface. Unlike the First
     Command's focused scrim, these DON'T block — a small panel glued to the surface + a soft ring, so
     you keep building while you read. Fired by DIRECT calls (build.js / app.js / xpstore.js), never a
     bus emit, so the owned shared/events.js contract + the lint-emits gate stay untouched. Each fires
     once ever (persisted on show), is suppressed during the First Command, and respects reduced-motion. */

  function reduceMotion() { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; } }
  function agentLabel() {                 // the live agent name from the topbar, so a coach reads in-voice
    const e = document.getElementById('gt-agent');
    const n = e && e.textContent && e.textContent.trim();
    return (n && n !== '—') ? n : (agentName !== 'AGENT' ? agentName : 'your agent');
  }

  let coach = null;   // { bubble, ring, anchor, raf, onKey }
  function clearCoach() {
    if (!coach) return;
    if (coach.raf) cancelAnimationFrame(coach.raf);
    if (coach.onKey) window.removeEventListener('keydown', coach.onKey);
    if (coach.ring) coach.ring.remove();
    if (coach.bubble) coach.bubble.remove();
    coach = null;
  }
  // measure the live brief and hand the geometry to the pure dodgeRect above. No-op when no brief is showing.
  function dodgeBrief(box, vw, vh) {
    if (!briefEl || !document.contains(briefEl)) return box;
    const z = overlayScale(), r0 = briefEl.getBoundingClientRect();
    if (!r0.width || !r0.height) return box;
    return dodgeRect(box, { left: r0.left / z, top: r0.top / z, right: r0.right / z, bottom: r0.bottom / z }, vw, vh);
  }
  // glue the bubble (and ring) to the anchor every frame — survives camera/layout shifts and self-clears
  // the moment the surface is gone (e.g. REFIT closed out from under a REFIT coach).
  function placeCoach() {
    if (!coach) return;
    const a = coach.anchor, b = coach.bubble;
    // anchor rects/viewport are visual px; ring+bubble style px convert by the MEASURED overlay scale
    // (not the raw zoom value — engines disagree on whether fixed children re-scale under body zoom).
    const z = overlayScale();
    // kit-out coaches are CSS-pinned to a safe zone (.tut-coach.kit); only the ring tracks the live target, and a
    // momentarily-missing target (palette re-render) just hides the ring rather than tearing down the bubble.
    if (coach.kit) {
      if (coach.ring) {
        if (a && document.contains(a)) {
          const r = a.getBoundingClientRect(), p = 5;
          coach.ring.style.display = '';
          coach.ring.style.left = (r.left / z - p) + 'px'; coach.ring.style.top = (r.top / z - p) + 'px';
          coach.ring.style.width = (r.width / z + p * 2) + 'px'; coach.ring.style.height = (r.height / z + p * 2) + 'px';
        } else { coach.ring.style.display = 'none'; }
      }
      coach.raf = requestAnimationFrame(placeCoach);
      return;
    }
    if (a && !document.contains(a)) { clearCoach(); return; }
    if (a) {
      const r0 = a.getBoundingClientRect();
      const r = { left: r0.left / z, top: r0.top / z, bottom: r0.bottom / z, width: r0.width / z, height: r0.height / z };
      if (coach.ring) { const p = 5; coach.ring.style.left = (r.left - p) + 'px'; coach.ring.style.top = (r.top - p) + 'px'; coach.ring.style.width = (r.width + p * 2) + 'px'; coach.ring.style.height = (r.height + p * 2) + 'px'; }
      const bw = b.offsetWidth || 300, bh = b.offsetHeight || 90, gap = 12;
      const vw = (window.innerWidth || 1280) / z, vh = (window.innerHeight || 800) / z;   // fallback so a 0×0 report can't fling it off-screen
      const left = Math.max(8, Math.min(r.left, vw - bw - 8));               // clamp-min last: never below 8, even in a narrow window
      let top = r.bottom + gap;
      if (top + bh > vh - 8) top = Math.max(8, r.top - bh - gap);            // flip above if it would clip the bottom
      const box = dodgeBrief({ left, top, w: bw, h: bh }, vw, vh);
      b.style.left = box.left + 'px'; b.style.top = box.top + 'px';
    }
    coach.raf = requestAnimationFrame(placeCoach);
  }
  function showCoach(key, anchorSel, text, opts) {
    opts = opts || {};
    if (active || seen(key)) return;     // never during the First Command; once ever
    // don't paint over an open panel (e.g. the Field Manual) — defer (not marked seen) until it's closed.
    // EXCEPT a one-shot whose trigger never re-fires (level-up): show it over the panel rather than lose it forever.
    // Same rule for REFIT's first-run card (.refit-firstrun): it now waits for the tour to finish, so the very
    // open that finally shows it is also the one that fires the 'build' coachmark — defer rather than stack.
    // (.refit-firstrun, not .refit-guide: the bay/workstation/flow/junction/connector editors share that class,
    // and the WORKFLOW coaches fire from commitPropStamp BEFORE openPropEditor runs — suppressing on the bare
    // class would silently kill the whole belt-teach chain.)
    if (!opts.overTerms && (document.querySelector('#terms .term') || document.querySelector('.refit-firstrun'))) return;
    markSeen(key);                       // mark on SHOW so an ignored hint still never repeats
    clearCoach();
    const anchor = anchorSel ? (typeof anchorSel === 'string' ? document.querySelector(anchorSel) : anchorSel) : null;
    const bubble = document.createElement('div');
    bubble.className = 'tut-coach' + (reduceMotion() ? ' no-anim' : '');
    bubble.setAttribute('role', 'status'); bubble.setAttribute('aria-live', 'polite');   // announce the hint to assistive tech
    const who = document.createElement('div'); who.className = 'tut-coach-who'; who.textContent = agentLabel();
    const body = document.createElement('div'); body.className = 'tut-coach-body'; body.textContent = text;
    const ok = document.createElement('button'); ok.className = 'tut-coach-ok'; ok.textContent = opts.ok || '✓ got it';
    ok.onclick = () => { sfx('click'); clearCoach(); };
    bubble.appendChild(who); bubble.appendChild(body); bubble.appendChild(ok);
    document.body.appendChild(bubble);
    let ring = null;
    if (anchor) { ring = document.createElement('div'); ring.className = 'tut-ring' + (reduceMotion() ? ' no-anim' : ''); document.body.appendChild(ring); }
    const onKey = e => { if (e.key === 'Escape') clearCoach(); };
    window.addEventListener('keydown', onKey);
    coach = { bubble, ring, anchor, raf: 0, onKey };
    placeCoach();
    sfx('open');
  }

  /* ---- the catalog: one direct hook per surface (callers guard with typeof Tutorial) ---- */
  function onBuildOpen() {
    if (kitMode) return;   // during the guided kit-out, kitTick drives REFIT — don't stack the generic coachmark on top
    showCoach('build', '#refit-tools',
      'this is REFIT. PROP adds equipment or decoration. ROOMS organize your station. LINES connect agents into repeatable workflows. choose what your work needs — you can already ask for help in COMMS.');
  }
  function onEquipmentInspect() { if (!kitMode) clearCoach(); }
  /* WORKFLOW COACHES (2026-07-05 belt-teach): each routing prop teaches ITS role in the two-trip story the
     first time it's placed — one line, at the moment of need, in the agent's voice. Each has its own
     seen-key so the whole chain gets taught exactly once, piece by piece, never as a wall of text. */
  const WF_COACH = {
    intake: 'that’s the INBOX — outside work (a DM, a routine) physically arrives here. belt it toward a BAY and you’ll watch the job ride in.',
    bay: 'a BAY is one agent’s personal dock — jobs land there, and every finished result ships out from it. it works with no belts at all; click it to pick whose dock it is.',
    outbox: 'the OUTBOX is the loading dock — every job we actually FINISH ships a crate here onto the pallet. hit ▸ PREVIEW to watch the whole loop once.',
    filter: 'a FILTER sorts UNOWNED work by what it is — code down one lane, research down another. work that already belongs to someone rides straight home past it. click it to set the lanes.',
    splitter: 'a SPLITTER spreads unowned work across its lanes — several agents working the same stream in parallel. it needs at least two out-going lanes.',
    // truthful telemetry (2026-07-26 mechanic removal): a merger is a LANE FUNNEL — it never batches or combines
    merger: 'a MERGER is a lane funnel — several lanes converge into one and every crate rides straight on, K in K out. it tidies the lanes; it never combines the jobs riding them.'
  };
  function onPropPlaced(propType) {
    const grant = (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(propType) : null;
    if (kitMode) return kitOnPropPlaced(grant);   // the kit-out owns placement while it runs
    if (WF_COACH[propType]) { tickBrief('build'); showCoach('wf-' + propType, '#refit-palette', WF_COACH[propType]); return; }
    tickBrief('build');
    let msg;
    // HONEST (truthful-telemetry): a fresh solo station is COMPUTE-ONLY, so placing a cap-prop genuinely UNLOCKS
    // that power for the hero (heroCaps picks it up) — it did NOT "already come with it". Frame it as a real unlock.
    if (grant === 'COMPUTE') {                   // compute is the always-on freebie; a desk just gives the body a real seat to work at
      msg = 'that’s a workstation — compute’s already mine (i can always think), so this just gives my body a real desk to walk to and work at. other equipment supports files, web, commands and memory. add what your work needs.';
    } else if (grant) {                          // cabinet/dish/workbench/server: a REAL unlock on the solo station
      msg = 'that placed ' + grant + ' equipment. one matching prop covers that ability in its workspace; you don’t need every variant. select it to see who can use it and whether access is already available.';
    } else {                                     // inert decor
      msg = 'nice. the gear that grants a power wears its name — a workbench gives me a TERMINAL, a dish reaches the WEB, a cabinet opens FILES. the rest is yours to decorate.';
    }
    showCoach('prop', '#refit-palette', msg);
  }
  function onBeltPlaced() {
    tickBrief('belt');
    showCoach('belt', '#refit-test',
      'belts show real work moving between us. want to see it without waiting for a message? hit ▸ PREVIEW — i’ll send dummy crates down the line so you can watch them sort.');
  }
  function onConnectorPlaced() {
    tickBrief('build'); tickBrief('connector');
    showCoach('connector', '#refit-palette',
      'that’s a portal — it wires me to a live tool server. the panel here lists them; bind one and its powers show up in my hands. the lamp says it’s alive: green good, red broken.');
  }
  function onLevelUp() {
    tickBrief('level');
    showCoach('levelup', '#tb-station',
      'my crew level grew from your feedback. your COMMANDER level here tracks recorded progress toward your goals. open QUEST LOG for your journey, or my dossier → GROWTH for my track record.',
      { overTerms: true });   // a level transition fires exactly once — show it even over an open panel rather than drop it
  }

  /* ================= P3 — STATION BRIEFING (first-steps checklist) =================
     A small, dismissible in-game checklist that ticks off REAL first actions. NOT a gate — a soft map,
     skippable, sandbox-friendly. Auto-completes and bows out; reopenable from the Field Manual. */

  const STEPS = [
    { k: 'command',   label: 'Give your agent a command' },
    { k: 'approve',   label: 'Approve a tool request' },
    { k: 'build',     label: 'Place a piece of gear in REFIT' },
    { k: 'belt',      label: 'Lay a conveyor belt' },
    { k: 'connector', label: 'Bind a connector portal' },
    { k: 'channel',   label: 'Connect a messaging channel (✉ CHANNELS)' },
    { k: 'level',     label: 'Grow a crew member to Level 2' }
  ];
  const briefDone = k => !!state.brief[k];
  const briefCount = () => STEPS.reduce((n, s) => n + (briefDone(s.k) ? 1 : 0), 0);
  const briefAll = () => briefCount() === STEPS.length;

  let briefEl = null, briefDoneTimer = 0, briefResize = null, briefKey = null;
  // sit just RIGHT of the interactive left rail (crew + workstreams), over the stage gutter — never
  // covering the rail's controls. Recomputed on resize. Falls back to a fixed inset if the rail is absent.
  function placeBrief() {
    if (!briefEl) return;
    // rects/innerWidth are visual px; the brief's style px convert by the MEASURED overlay scale.
    const z = overlayScale();
    const rail = document.getElementById('left');
    const railRight = rail && rail.getBoundingClientRect ? rail.getBoundingClientRect().right / z : 0;
    const comms = document.getElementById('chat-panel');
    const vw = (window.innerWidth || 1280) / z;
    const commsLeft = comms && comms.getBoundingClientRect ? comms.getBoundingClientRect().left / z : vw;
    const bw = briefEl.offsetWidth || 246;
    let left = railRight > 0 ? railRight + 12 : 14;
    left = Math.min(left, commsLeft - bw - 12, vw - bw - 12);   // never overlap COMMS or run off the right edge (narrow windows)
    briefEl.style.left = Math.max(8, left) + 'px';
  }
  function renderBrief() {
    if (!briefEl) return;
    briefEl.querySelector('.tut-brief-count').textContent = briefCount() + '/' + STEPS.length;
    const list = briefEl.querySelector('.tut-brief-list');
    list.innerHTML = '';
    for (const s of STEPS) {
      const li = document.createElement('li');
      li.className = 'tut-brief-item' + (briefDone(s.k) ? ' done' : '');
      const box = document.createElement('span'); box.className = 'tut-brief-box'; box.textContent = briefDone(s.k) ? '✓' : '▫';
      const lbl = document.createElement('span'); lbl.textContent = s.label;
      li.appendChild(box); li.appendChild(lbl); list.appendChild(li);
    }
  }
  function dismissBrief() { state.briefDismissed = true; save(); sfx('click'); hideBrief(); }
  function showBrief() {
    if (state.briefDismissed || state.briefComplete) return;
    if (document.querySelector('#terms .term')) return;   // don't cover an open panel — onEnterGame re-offers later
    if (briefEl) { renderBrief(); return; }
    const game = document.getElementById('screen-game');
    if (!game || !game.classList.contains('active')) return;   // game room only
    briefEl = document.createElement('div'); briefEl.className = 'tut-brief' + (reduceMotion() ? ' no-anim' : '');
    briefEl.setAttribute('role', 'status'); briefEl.setAttribute('aria-live', 'polite');
    const head = document.createElement('div'); head.className = 'tut-brief-head';
    const title = document.createElement('span'); title.className = 'tut-brief-title'; title.textContent = '▸ FIRST STEPS';
    // scope the live-region to the count so each tick announces "3/6", not a re-read of all six rows
    const count = document.createElement('span'); count.className = 'tut-brief-count'; count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-atomic', 'true');
    const x = document.createElement('button'); x.className = 'tut-brief-x'; x.title = 'dismiss'; x.textContent = '✕';
    x.onclick = dismissBrief;
    head.appendChild(title); head.appendChild(count); head.appendChild(x);
    const list = document.createElement('ul'); list.className = 'tut-brief-list'; list.setAttribute('aria-live', 'off');   // suppress full-list re-read on each tick (the count carries the delta)
    const foot = document.createElement('div'); foot.className = 'tut-brief-foot'; foot.textContent = 'reopen any time — § FIELD MANUAL in the ▣ SYSTEM dock';
    briefEl.appendChild(head); briefEl.appendChild(list); briefEl.appendChild(foot);
    document.body.appendChild(briefEl);
    placeBrief();
    briefResize = () => placeBrief(); window.addEventListener('resize', briefResize);
    // Esc dismisses (matching the coachmark) — but not while REFIT or another panel owns Esc
    briefKey = e => { if (e.key === 'Escape' && !document.querySelector('.refit-overlay') && !document.querySelector('#terms .term')) dismissBrief(); };
    window.addEventListener('keydown', briefKey);
    renderBrief();
  }
  function hideBrief() {
    if (briefDoneTimer) { clearTimeout(briefDoneTimer); briefDoneTimer = 0; }
    if (briefResize) { window.removeEventListener('resize', briefResize); briefResize = null; }
    if (briefKey) { window.removeEventListener('keydown', briefKey); briefKey = null; }
    if (briefEl) { briefEl.remove(); briefEl = null; }
  }
  function tickBrief(k) {
    if (!state.brief[k]) {
      state.brief[k] = true; save();
      if (briefEl) {
        renderBrief();
        const item = briefEl.querySelectorAll('.tut-brief-item')[STEPS.findIndex(s => s.k === k)];
        if (item && !reduceMotion()) item.classList.add('flash');
        sfx('truth');
      }
    }
    if (briefAll() && !state.briefComplete) {
      state.briefComplete = true; save();
      if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('first steps complete — you’ve got the controls', 'gold');
      if (briefEl) {
        briefEl.classList.add('complete');
        const t = briefEl.querySelector('.tut-brief-title'); if (t) t.textContent = '✓ FIRST STEPS COMPLETE';
        briefDoneTimer = setTimeout(hideBrief, 4200);
      }
    }
  }

  /* ================= P3 — FIELD MANUAL (the reopenable handbook) =================
     SYSTEM dock → stationui window → this chapter renderer. Equipment labels come from
     WorldModel; examples are instructions to try, never badges claiming completed work. */

  function fmEntry(tag, title, body) {
    const t = tag ? '<span class="fm-tag">' + tag + '</span>' : '';
    return '<section class="fm-entry">' + t + '<h3 class="fm-entry-h">' + title + '</h3><div class="fm-entry-b">' + body + '</div></section>';
  }
  function fmAction(target, label) {
    return '<button type="button" class="fm-action" data-fm-open="' + target + '">' + label + ' ↗</button>';
  }
  function fmMission(title, text) {
    return '<aside class="fm-mission"><span class="fm-eyebrow">TRY THIS</span><h3>' + title + '</h3><p>' + text + '</p></aside>';
  }
  const FM_TABS = ['FIRST MISSION', 'CONTROLS', 'CREW', 'GEAR', 'LINES', 'PROGRESS', 'HELP'];
  function fmContent(tab) {
    if (tab === 'FIRST MISSION') {
      return '<p class="fm-lead">You command the station. Your crew does real work on your computer. Start with one useful result.</p>'
        + '<div class="fm-route" aria-label="The work cycle"><span>GIVE A JOB</span><i aria-hidden="true">→</i><span>FOLLOW THE RUN</span><i aria-hidden="true">→</i><span>CHECK THE RESULT</span></div>'
        + fmEntry('01', 'Choose your objective', 'Open <b>COMMS</b>, the chat panel, and pick the agent on the line. Say what you want, give the material to work from, and describe the finished result.')
        + fmMission('Turn rough notes into a plan', '<b>“Turn these notes into a checklist for tomorrow. Put the most important task first. Keep it under ten items: [paste your notes].”</b> Replace the bracketed text with your notes, then send. This first job needs no connector or production line.')
        + fmEntry('02', 'Stay on the channel', 'Watch the reply and tool activity in COMMS. If the agent needs context, answer in the conversation. If an approval appears, read the proposed action and choose whether to allow it. Movement around the station accompanies activity; the run details tell you what actually happened.')
        + fmEntry('03', 'Inspect the payoff', 'Read the checklist and ask for a revision if it misses the mark. For jobs that create files or apps, use <b>WORK › DELIVERABLES</b> and <b>OPEN</b> the result. A finished run is your cue to inspect the work.')
        + '<div class="fm-actions">' + fmAction('comms', 'GO TO COMMS') + fmAction('deliverables', 'OPEN DELIVERABLES') + '</div>'
        + '<p class="fm-note">Need an idea? <b>WORK › RECIPES</b> has ready-made jobs. Every chapter is available now; read in any order. The quick tour below is optional.</p>';
    }
    if (tab === 'CONTROLS') {
      const keys = [['0', 'Select / inspect'], ['1', 'Room'], ['2', 'Hallway'], ['3', 'Surface'], ['4', 'Move'], ['5', 'Delete'], ['6', 'Props'], ['7', 'Belt'], ['8', 'Copy'], ['9', 'Layouts']];
      return '<p class="fm-lead">Your control deck: chat to give orders, the bottom menus to manage the station, REFIT to build.</p>'
        + fmEntry('CHAT', 'Send a command', '<kbd>Enter</kbd> sends. <kbd>Shift + Enter</kbd> adds a line. Type <kbd>/</kbd> to browse slash commands. Use the agent picker in COMMS to choose who receives your message.')
        + '<div class="fm-map"><div><b>CREW</b><span>Agents, recruitment, your Commander dossier.</span></div><div><b>WORK</b><span>Tasks, deliverables, recipes, automation, quests.</span></div><div><b>BUILD</b><span>Refit the station, manage abilities, connect channels.</span></div><div><b>SYSTEM</b><span>This manual, settings, updates, notifications.</span></div></div>'
        + '<h3 class="fm-subhead">BUILD › REFIT STATION</h3><p class="fm-note">These keys work while REFIT is open and you are not typing in a field.</p>'
        + '<dl class="fm-keys">' + keys.map(([key, label]) => '<div><dt><kbd>' + key + '</kbd></dt><dd>' + label + '</dd></div>').join('') + '</dl>'
        + fmEntry(null, 'Camera &amp; editing', '<kbd>Space + drag</kbd> pans; the scroll wheel zooms. <kbd>F</kbd> fits the station. <kbd>R</kbd> rotates supported props; <kbd>Shift + R</kbd> rotates back; <kbd>M</kbd> mirrors. <kbd>Ctrl / ⌘ + Z</kbd> undoes; add <kbd>Shift</kbd> to redo. <kbd>Esc</kbd> backs out of the current card, placement, or tool before leaving REFIT.')
        + fmMission('Make room for an idea', 'Open REFIT, press <kbd>1</kbd> and drag out a room. Press <kbd>6</kbd>, choose a prop, then click the floor to place it. Use Undo to reverse an edit.')
        + fmAction('refit', 'ENTER REFIT');
    }
    if (tab === 'CREW') {
      return '<p class="fm-lead">Give each crew member a clear role. Pick the right agent for the job, then keep its conversation together.</p>'
        + fmEntry('ROSTER', 'Recruit &amp; configure', '<b>CREW › RECRUIT</b> adds an agent. In <b>CREW › AGENTS</b>, inspect its identity, model, abilities, and configuration. The model belongs to the agent, so changing it affects that agent across its chats.')
        + fmEntry('COMMS', 'Direct messages &amp; group work', 'Choose an agent in COMMS for a direct conversation. Use <b>Add agents</b> to bring crew into a group conversation. Use <b>Sessions</b> to return to an earlier conversation and its run history.')
        + fmEntry('WORK', 'Know where a job lives', '<b>TASKS</b> holds planned board work. Chats, routines, and while-away runs live as <b>Sessions in COMMS</b>; not every conversation becomes a board task. <b>DELIVERABLES</b> is where you find produced outputs.')
        + fmEntry('VOICE', 'Talk to your crew', 'Use the microphone in COMMS to speak, or the hands-free control for a live conversation. <b>SYSTEM › SETTINGS › Live Voice</b> configures voice and microphone options, including different voices for individual agents.')
        + '<p class="fm-note">every crew member you recruit is a real, separate agent with its own identity, workspace, memory, and sessions. Specialists own their desk; other equipment is shared through the station’s overseer.</p>'
        + '<div class="fm-actions">' + fmAction('agents', 'INSPECT CREW') + fmAction('tasks', 'OPEN TASKS') + '</div>';
    }
    if (tab === 'GEAR') {
      const gear = [
        ['desk', 'WORKSTATION', 'A desk, console, or pixel rig gives an agent a work position. A routed BAY needs a computer in its room.'],
        ['war_intelcab', 'CABINET', 'File tools: read and write within the agent’s configured reach. Includes safes, vaults, racks, and shelves.'],
        ['comms_dish', 'DISH', 'Web search and page access. Uplinks and beacons provide the same capability.'],
        ['gigs_servercart', 'SERVER', 'Persistent notebook and reusable skill procedures. Relay stacks and cores also provide memory.'],
        ['connector_portal', 'CONNECTOR PORTAL', 'Tools from a bound connector. Connect the service in ABILITIES and check its status; placing a portal alone does not sign you in.'],
        ['workbench', 'WORKBENCH', 'Run terminal commands and verification tools under the agent’s configured permissions and reach.'],
        ['studio', 'MEDIA STUDIO', 'Image generation and image analysis. Available providers and their configuration determine which operations can run.'],
        ['jukebox', 'JUKEBOX', 'Spotify search and playback controls. Requires Spotify to be connected in ABILITIES.']
      ];
      return '<p class="fm-lead">Equipment gives the station abilities. Inspect a prop’s capability label before you place it.</p>'
        + '<div class="fm-gear-grid">' + gear.map(([prop, title, text]) => fmEntry(typeof WorldModel !== 'undefined' ? WorldModel.grantLabelForProp(prop) : null, title, text)).join('') + '</div>'
        + fmEntry('DECOR', 'Make the station yours', 'Plants, rugs, and other decoration shape the atmosphere. They do not grant tools. Workflow machines such as bays and splitters have their own job: see LINES.')
        + fmEntry('ACCESS', 'Equipment &amp; permission are separate', 'A prop grants a CAPABILITY — what an agent can attempt, not blanket consent. Profiles, shared equipment, and Full Power can also supply abilities. Check the agent’s actual tool readout in <b>AGENTS</b> and the settings in <b>ABILITIES</b>. Settings &gt; Permissions decides whether an action asks or runs without another prompt.')
        + fmEntry('ASK / FULL POWER', 'Choose how much control to hand over', 'In restricted modes, local file reads and private notebook saves do not prompt. Other actions may ask unless already approved or FULL ACCESS is on. ASK and narrower reach modes retain their restrictions. <b>FULL POWER is host-wide</b>: protected files, arbitrary commands, visible apps, and screen/input control are in scope. It does not supply missing credentials, disconnected services, or OS privileges.')
        + fmAction('connectors', 'OPEN ABILITIES');
    }
    if (tab === 'LINES') {
      return '<p class="fm-lead">Turn repeatable work into a production line. You can still give ordinary jobs in COMMS without building belts.</p>'
        + '<div class="fm-route"><span>INBOX<small>work arrives</small></span><i aria-hidden="true">→</i><span>BAY<small>agent + instructions</small></span><i aria-hidden="true">→</i><span>OUTBOX<small>output leaves</small></span></div>'
        + fmEntry('01', 'Place the stations', 'In REFIT, open <b>PROPS › WORKFLOW</b> and place an INBOX, BAY, and OUTBOX. Click the BAY in SELECT mode to assign an agent and define its step. Its room needs a computer.')
        + fmEntry('02', 'Connect the route', 'Press <kbd>7</kbd> for BELT. <b>Click one machine, then another</b> to lay a connection automatically; dragging lays tiles by hand. Connect INBOX → BAY, then BAY → OUTBOX. Inspect the route and fix any flagged breaks.')
        + fmEntry('03', 'Give the line a source', '<b>BUILD › CHANNELS</b> connects incoming messages. <b>WORK › AUTOMATION</b> manages routines and loops. Configure the source and destination for the workflow; an inbox marked <b>NO FEED</b> has no source feeding it.')
        + fmEntry('TEST', 'A test crate is a rehearsal', 'Use <b>TEST</b> in REFIT to watch sample crates travel. That checks the visible route; it does not prove a real agent completed a job. Run real work and inspect its session and output afterward.')
        + fmEntry('BRANCHES', 'Add steps when you need them', '<b>FILTER</b> selects by tag. <b>MERGER</b> brings lanes together. <b>SPLITTER</b> fans work into branches and needs at least two outgoing lanes. Assign agents to bays, not to belt tiles.')
        + fmMission('Start with a layout', 'Press <kbd>9</kbd> for <b>LAYOUTS</b> in REFIT, choose a starter line, and place it. Inspect the bays and feed before running your job.')
        + '<p class="fm-note"><b>Recipes = WHAT.</b> A job to launch. <b>Skills = HOW.</b> Reusable instructions. <b>Routines = WHEN.</b> Scheduled work. <b>Loops = UNTIL.</b> Repeated work with a stopping condition.</p>'
        + fmAction('automation', 'OPEN AUTOMATION');
    }
    if (tab === 'PROGRESS') {
      return '<p class="fm-lead">The campaign is your real life. Set a goal, take useful steps, and record what changed.</p>'
        + fmEntry('YOU', 'Commander progress', 'Open <b>WORK › QUESTS</b> to reach the QUEST LOG. Define a life goal and what success means. Record completed actions and metrics as you go. Confirm the outcome when it actually happens: finishing the plan alone does not complete the goal.')
        + fmMission('Name a finish line you can recognize', '<b>Goal:</b> play a song for a friend. <b>Success:</b> play the whole song without stopping. <b>First step:</b> practise the chorus. Record the practice now; confirm the goal after the performance.')
        + fmEntry('CREW', 'Agent experience', 'Positive feedback on agent work grows that agent’s XP. Your Commander journey and the crew’s track record are separate. Neither level locks capabilities behind a grind.')
        + fmEntry('NEXT STEP', 'Keep the plan useful', 'Use the QUEST LOG to report progress, extend a plan, or defer a suggestion that does not fit. The station can suggest a next action; you decide whether it belongs in your life.')
        + fmAction('quests', 'OPEN QUEST LOG');
    }
    return '<p class="fm-lead">When the station stalls, follow the evidence. Start with the message beside the job.</p>'
      + fmEntry('NO REPLY', 'Check the connection', 'Open <b>SYSTEM › SETTINGS</b> and check the selected provider’s sign-in or key. Check the agent’s model in COMMS. Read the error before retrying; a missing connection needs fixing first.')
      + fmEntry('WAITING', 'Look for a decision', 'Return to the job’s COMMS session. Answer a context question or approve or deny the pending action. An unanswered question is not a running tool.')
      + fmEntry('MISSING TOOL', 'Check ability &amp; reach', 'Inspect the agent in <b>CREW › AGENTS</b>. In <b>BUILD › ABILITIES</b>, check toolsets and connector status. Equipment, permissions, service sign-in, and operating-system access each affect what can run.')
      + fmEntry('COLD LINE', 'Inspect feed, bay, and route', 'In REFIT, check the inbox feed, bay assignment, room computer, and belt connections. A sample crate moving does not establish that a real job ran.')
      + fmEntry('WHERE IS IT?', 'Find the session or output', 'Return to <b>COMMS › Sessions</b> for the conversation. Open <b>WORK › DELIVERABLES</b> for generated files and apps. Check <b>TASKS</b> if it was planned board work.')
      + fmEntry('STOP', 'Interrupt work', 'Use the stop control in COMMS for the current run. Stopping a run does not undo actions it already completed; inspect the result before starting again.')
      + '<div class="fm-actions">' + fmAction('settings', 'OPEN SETTINGS') + fmAction('comms', 'RETURN TO COMMS') + '</div>';
  }
  function fillFieldManual(body) {
    if (!body) return;
    let curTab = 'FIRST MISSION';
    body.classList.add('fm-body');
    const render = () => {
      const page = FM_TABS.indexOf(curTab);
      body.innerHTML =
        '<header class="fm-cover"><span class="fm-eyebrow">STARNET / COMMANDER HANDBOOK</span><h2>WELCOME ABOARD.</h2><p>A field guide to getting things done.</p></header>'
        + '<nav class="fm-tabs" aria-label="Manual chapters">' + FM_TABS.map((t, i) => '<button type="button" class="fm-tab' + (t === curTab ? ' on' : '') + '" aria-pressed="' + (t === curTab ? 'true' : 'false') + '" data-t="' + t + '">' + String(i + 1).padStart(2, '0') + ' · ' + t + '</button>').join('') +
        '</nav><article class="fm-content" aria-label="' + curTab + '"><div class="fm-chapter"><span class="fm-eyebrow">CHAPTER ' + (page + 1) + ' / ' + FM_TABS.length + '</span><h2>' + curTab + '</h2></div>' + fmContent(curTab)
        + (curTab === 'FIRST MISSION' ? '<button class="fm-action fm-replay" type="button">REPLAY QUICK TOUR</button>' : '')
        + '</article><nav class="fm-pager" aria-label="Chapter navigation">'
        + (page > 0 ? '<button type="button" class="fm-action" data-fm-page="' + (page - 1) + '">← ' + FM_TABS[page - 1] + '</button>' : '<span>YOUR STATION. YOUR PACE.</span>')
        + (page < FM_TABS.length - 1 ? '<button type="button" class="fm-action" data-fm-page="' + (page + 1) + '">' + FM_TABS[page + 1] + ' →</button>' : '') + '</nav>';
      const turn = t => {
        curTab = t; sfx('click'); render(); body.scrollTop = 0;
        const selected = body.querySelector('.fm-tab.on');
        if (selected) selected.focus({ preventScroll: true });
      };
      body.querySelectorAll('.fm-tab[data-t]').forEach(b => { b.onclick = () => turn(b.dataset.t); });
      body.querySelectorAll('[data-fm-page]').forEach(b => { b.onclick = () => turn(FM_TABS[Number(b.dataset.fmPage)]); });
      body.querySelectorAll('[data-fm-open]').forEach(b => { b.onclick = () => {
        if (typeof StationUI === 'undefined') return;
        const target = b.dataset.fmOpen;
        StationUI.closeTerm('manual');
        if (target === 'comms') { const input = document.getElementById('chat-input'); if (input) input.focus(); }
        else if (target === 'refit') { const build = document.getElementById('bb-build'); if (build) build.click(); }
        else StationUI.openTerm(target);
      }; });
      const replay = body.querySelector('.fm-replay');
      if (replay) replay.onclick = () => { sfx('click'); replayFirstCommand(); };
    };
    render();
  }

  function replayFirstCommand() {
    if (active) return false;
    hideBrief(); clearCoach(); clearSpot();
    // The manual is a real floating window; close it before opening the Dialogue tour so it cannot cover the lesson.
    try { if (typeof StationUI !== 'undefined' && StationUI.closeTerm) StationUI.closeTerm('manual'); } catch (_) {}
    firstCommand({ name: agentName, replay: true });
    return active;
  }

  /* lifecycle entry from app.js enterGame: arm the bus ticks (even for skippers/returners) and, for a
     returning user mid-progress, re-offer the first-steps map. Fresh users get it from finishUp instead. */
  function onEnterGame() {
    wireBus();
    if (state.firstCommandDone && !state.briefDismissed && !state.briefComplete) setTimeout(showBrief, 900);
    if (state.firstCommandDone) watchConnectors(1);   // a connector wired since last visit ticks the step from the read-back
  }

  // full teardown for DISCONNECT (app.js): drop every body-appended overlay + its loop/listeners so none
  // leak onto the title screen (a live coachmark otherwise keeps a self-rescheduling rAF + a keydown bound).
  function teardown() {
    active = false; kitMode = false; clearStall();
    clearKitTimers();
    if (connPollTimer) { clearTimeout(connPollTimer); connPollTimer = null; }   // the read-back poll can't outlive the session
    clearCoach(); clearSpot(); hideBrief();
    if (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen()) Dialogue.close();
  }

  // A NEW Commander is a new onboarding owner, not a returning user. Clear this module's one-shot key and every
  // in-memory latch after tearing down overlays/listeners, so the fresh hero genuinely receives the tour and
  // first-steps map instead of inheriting the previous Commander's completed tutorial.
  function reset() {
    teardown();
    try { localStorage.removeItem(KEY); } catch (_) {}
    state = load();
    active = false; wired = false; finished = false; replayMode = false; agentName = 'AGENT';
    sawStart = false; sawPermission = false; sawEnd = false; sawDeny = false; cleanRunId = null;
    kitMode = false; kitNeeded = null; kitComplete = false; kitWasOpen = false; kitHold = false; kitFocusKey = null;
    return state;
  }

  // G1c coordination — is the tutorial ACTIVELY coaching right now (a live coach bubble / the kit-out loop /
  // the awakening tour)? The deferred BUILD-dock glow (dockglow.js) checks this and stands down while true —
  // the tutorial's own targeting always wins, so the two never glow different controls at once.
  function isCoaching() { return !!(active || kitMode || coach); }

  return {
    firstCommand, replayFirstCommand, spotlight, seen, markSeen, _state: () => state,
    onBuildOpen, onEquipmentInspect, onPropPlaced, onBeltPlaced, onConnectorPlaced, onLevelUp, clearCoach,
    onEnterGame, fillFieldManual, showBrief, tickBrief, teardown, reset, isCoaching, watchConnectors
  };
})();

// browser-safe node shim (guarded exactly like stationui.js) so the gate can unit-test the pure geometry
if (typeof module !== 'undefined' && module.exports) module.exports = { dodgeRect, connectOffers, connectorUp };
