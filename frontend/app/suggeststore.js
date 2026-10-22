/* AGENT OS — suggeststore.js : the browser wiring for ONGOING SUGGESTIONS (the recurring counterpart to the
   one-time First Pitch). Slice 3 of "the agent that points you."

   Where pitchstore.js fires ONCE (the graduation beat), this keeps the reverse value-flow alive: as the station
   keeps learning about its Commander (the dossier grows via curiosity/the interview), the agent occasionally
   offers ONE fresh, tailored, buildable idea — gently. It reuses the pure pitch engine for content
   (Pitch.buildDirective / parsePitch) and the same reason-only model path (Harness.chat, placed:[]) so the idea
   is grounded in what the agent genuinely knows (the live system prompt carries the dossier block).

   "Putting the pieces together" = anti-nag coordination. This does NOT pop the heavy Dialogue panel; it renders a
   GENTLE COMMS nudge (Chat.nudge), and it shares chat.js's single post-run beat slot with the curiosity nudge —
   chat.js cedes that one beat to a due suggestion (SuggestStore.willSuggest → fire) BEFORE asking curiosity, so
   the agent never stacks an idea and a question on the same task. The cadence (cooldown + per-session cap +
   only-when-the-dossier-grew) lives in the pure Pitch.shouldSuggest; this is just the live glue + the counter.

   Discipline mirrors curiositystore.js / pitchstore.js: READ-ONLY citizen of U.bus (subscribes to count tasks,
   NEVER emits), self-persists its own key (no save.js change), node-exportable for its test. */
'use strict';
const SuggestStore = (() => {
  const KEY = 'starnet.suggest.v1';
  const RECENT_CAP = 8;    // remember the last N pitched-idea fingerprints so the agent never re-pitches the same idea
  const DECLINED_TITLE_CAP = 24;  // …and the readable titles behind them, for the directive's exclusion list
  const TITLE_CHARS = 90;         // one clause each — the directive stays bounded no matter how long a title got
  let state = null;        // { v:1, lastFamiliarity, tasksSinceLast, recent:[fp], declined:[fp] }
  let deps = {};           // accessors/actions injected by app.js
  let sessionShown = 0;    // ideas shown THIS session (in-memory; resets each app run)
  let firing = false;      // re-entrancy guard while an idea is mid-flight
  let pendingChain = null; // G1c: a just-unlocked capability label to chain a follow-up idea off (one-shot, in-memory)
  let goalProgressed = false; // Tier 2: a goal milestone just completed → allow ONE suggestion on progress (not only familiarity growth). One-shot, in-memory.
  let acceptedRecommendation = null, acceptedRunId = null;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof Pitch !== 'undefined' && state;

  // a stable fingerprint of an idea (its title), so a re-pitched same/near-same idea is recognised and skipped:
  // lowercase, keep alphanumeric tokens >=3 chars, sort + unique → reordered/padded restatements still match.
  function fingerprint(title) {
    const toks = String(title == null ? '' : title).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  function seenRecently(fp) { return !!fp && ((Array.isArray(state.recent) && state.recent.indexOf(fp) >= 0) || (Array.isArray(state.declined) && state.declined.indexOf(fp) >= 0)); }
  /* THE TITLES, ALONGSIDE THE FINGERPRINTS (2026-08-05). The fingerprint is a sorted token bag — perfect for the
     dedup test, unreadable as prompt text. Keeping the human title beside it is what lets the exclusion list ride
     the DIRECTIVE (see excludeTitles below) instead of only filtering the reply after the aux call is paid for.
     Additive + bounded, and hydrate tolerates its absence, so an existing store upgrades in place. */
  function pushBounded(arr, v, cap) {
    if (!Array.isArray(arr)) return [v];
    const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1);   // re-seen → move to the front of the eviction queue
    arr.push(v);
    while (arr.length > cap) arr.shift();
    return arr;
  }
  function rememberIdea(fp, title) {
    if (!fp) return;
    if (!Array.isArray(state.recent)) state.recent = [];
    state.recent.push(fp);
    while (state.recent.length > RECENT_CAP) state.recent.shift();
    const t = String(title == null ? '' : title).trim().slice(0, TITLE_CHARS);
    if (t) state.recentTitles = pushBounded(state.recentTitles, t, RECENT_CAP);
  }
  function rememberDeclined(fp, title) {
    if (!fp) return;
    if (!Array.isArray(state.declined)) state.declined = [];
    if (state.declined.indexOf(fp) < 0) state.declined.push(fp);
    while (state.declined.length > 200) state.declined.shift();
    const t = String(title == null ? '' : title).trim().slice(0, TITLE_CHARS);
    if (t) state.declinedTitles = pushBounded(state.declinedTitles, t, DECLINED_TITLE_CAP);
  }
  /* what the model must not propose again: everything already pitched, and everything explicitly refused. The
     DECLINED half leads — "never suggest this" is a decision, and it is the one the Commander would be most
     annoyed to see ignored. De-duped, newest-last, bounded by the directive's own cap. */
  /* ── THE EVIDENCE CONTRACT (rec perfection W2) ──────────────────────────────────────────────────────────
     groundQuote(raw) → the quote the nudge may SPEAK, or '' .

     A model asked for the Commander's own words will supply something whether or not it has them. So the quote
     is checked against the station's real belief pool with the SAME token-overlap veto autojobs applies to its
     GROUNDS line (Autopilot.grounded / flattenBeliefs — resolved lazily, exactly as autojobs.js does it,
     because script order is not guaranteed). Two deliberate refusals, both fail-CLOSED:
       · no engine and no pool → no quote. A check that could not run has not passed.
       · no overlap → no quote. The nudge then says precisely what it said before this contract existed.
     This is the strictest gate in the lane and it should be: this is the one string the station would speak
     back as «because you said "…"», and that sentence must never be something they did not say. */
  function groundQuote(raw) {
    const q = String(raw == null ? '' : raw).trim();
    if (!q || q.length < 4) return '';
    const A = (typeof Autopilot !== 'undefined' && Autopilot) ? Autopilot : null;
    if (!A || !A.grounded || !A.flattenBeliefs) return '';
    let pool = [];
    try { pool = A.flattenBeliefs(deps.getBeliefs ? (deps.getBeliefs() || {}) : {}) || []; } catch (_) { pool = []; }
    if (!pool.length) return '';
    let ok = false;
    try { ok = !!A.grounded(q, pool); } catch (_) { ok = false; }
    return ok ? q.slice(0, 200) : '';
  }
  /* the Commander's goal's NEXT unfinished milestone, or '' (rec perfection W2). The server-side evidence pack
     carries the active GOAL; the milestone tree is decomposed and tracked in the browser, so this is the one
     thing the pack structurally cannot know. Fail-open at every step: no store, no goal, no decomposition →
     '' → the directive is byte-identical to before. */
  function nextMilestone() {
    try {
      const u = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) ? UnderstandingStore.read() : null;
      const nx = u && u.goal && u.goal.next;
      return nx ? String(nx) : '';
    } catch (_) { return ''; }
  }
  // the receipt line, in the ONE grammar (recommend.js whyLine): «because you said "…"». Fail-open to the plain
  // quoted form if the spine module is not loaded — the words are the Commander's either way.
  function citeLine(quote) {
    const cited = 'you said “' + quote + '”';
    try { if (typeof Recommend !== 'undefined' && Recommend.whyLine) return Recommend.whyLine({ why: cited }); } catch (_) {}
    return 'because ' + cited;
  }

  function excludeTitles() {
    const dec = Array.isArray(state.declinedTitles) ? state.declinedTitles : [];
    const rec = Array.isArray(state.recentTitles) ? state.recentTitles : [];
    const out = []; const seen = {};
    for (const t of dec.concat(rec)) { const k = t.toLowerCase(); if (!k || seen[k]) continue; seen[k] = 1; out.push(t); }
    return out;
  }
  function ledgerPost(body) {
    try {
      const f = (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch : null;
      if (f) f('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    } catch (_) {}
  }

  function hydrate(raw) {
    const s = { v: 1, lastFamiliarity: null, tasksSinceLast: 0, recent: [], declined: [], recentTitles: [], declinedTitles: [] };
    if (raw && typeof raw === 'object') {
      if (Number.isFinite(raw.lastFamiliarity)) s.lastFamiliarity = raw.lastFamiliarity;
      if (Number.isFinite(raw.tasksSinceLast) && raw.tasksSinceLast >= 0) s.tasksSinceLast = raw.tasksSinceLast;
      if (Array.isArray(raw.recent)) s.recent = raw.recent.filter(x => typeof x === 'string').slice(-RECENT_CAP);
      if (Array.isArray(raw.declined)) s.declined = raw.declined.filter(x => typeof x === 'string').slice(-200);
      // additive (2026-08-05): absent in a pre-upgrade store, which simply means an empty exclusion list until
      // the next idea fires — never a hydrate failure.
      if (Array.isArray(raw.recentTitles)) s.recentTitles = raw.recentTitles.filter(x => typeof x === 'string').slice(-RECENT_CAP);
      if (Array.isArray(raw.declinedTitles)) s.declinedTitles = raw.declinedTitles.filter(x => typeof x === 'string').slice(-DECLINED_TITLE_CAP);
    }
    return s;
  }

  // opts: { getSystem(), getCaps(), getRecentTask(), launchRecipe(recipe,values), launchDirective(text) }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    sessionShown = 0; firing = false; pendingChain = null; goalProgressed = false; acceptedRecommendation = null; acceptedRunId = null;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) { U.bus.on('agent.run.start', onRunStart); U.bus.on('agent.run.end', onRunEnd); }
  }
  function onRunStart(p) { if (acceptedRecommendation && !acceptedRunId && p && (p.agentId || 'agent') === 'agent') { acceptedRunId = String(p.runId || ''); if (acceptedRunId) ledgerPost({ id: acceptedRecommendation, state: 'started', reason: 'accepted' }); } }

  // G1c QUEST CHAINING: a station quest just closed a capability gap (a prop landed → a real capability is live).
  // Arm a ONE-SHOT follow-up so the NEXT natural suggestion (which already rides the cooldown + session cap) is
  // grounded in that fresh capability — "the dish is live, want NOVA to build the price-watcher?". This never
  // FORCES a beat: it only flavors the next due suggestion. If the gate never opens, it drops silently on the
  // next fire (anti-nag; never a queued nag). The latest unlock wins (a stale chain is superseded, not stacked).
  function armChain(capLabel) {
    const c = String(capLabel == null ? '' : capLabel).trim();
    if (c) pendingChain = c.slice(0, 24);
  }

  // GROWTH Tier 2 (§5, ADDITIVE OR): a goal milestone just advanced — a moment worth a fresh idea even if the
  // dossier's familiarity didn't grow. willSuggest() ORs this in ALONGSIDE the existing gates (session cap +
  // cooldown + graduation stay in force); it never bypasses a cap, it only satisfies the "something new to say"
  // clause. One-shot: consumed on the next fire (or dropped if the gate never opens — never a queued nag).
  function noteGoalProgress() { goalProgressed = true; }

  const pitchDone = () => (typeof PitchStore !== 'undefined' && PitchStore.done) ? PitchStore.done() : false;
  function summary() { return (typeof DossierStore !== 'undefined' && DossierStore.summary) ? DossierStore.summary() : null; }
  function familiarityNow() { const s = summary(); return s && Number.isFinite(s.familiarity) ? s.familiarity : null; }

  // THE COUNTER (read-only on the bus): every clean hero task advances the cooldown — independent of whether a
  // beat is actually shown. Also lazily establishes the familiarity baseline once the First Pitch has happened, so
  // ongoing ideas fire only on growth ABOVE what the agent already knew at graduation.
  function onRunEnd(p) {
    if (!ready()) return;
    p = p || {};
    if (acceptedRecommendation && acceptedRunId && String(p.runId || '') === acceptedRunId) {
      const completed = p.reason === 'done';
      ledgerPost({ id: acceptedRecommendation, state: completed ? 'completed' : 'declined', reason: completed ? 'completed' : 'bad_quality' });
      ledgerPost({ id: acceptedRecommendation, outcome: { runId: acceptedRunId, quality: completed ? 1 : -1, completedAt: Date.now() } });
      acceptedRecommendation = null; acceptedRunId = null;
    }
    if (p.reason !== 'done') return;
    if ((p.agentId || 'agent') !== 'agent') return;
    state.tasksSinceLast = (state.tasksSinceLast || 0) + 1;
    if (state.lastFamiliarity == null && pitchDone()) {
      const fam = familiarityNow();
      if (fam != null) state.lastFamiliarity = fam;   // baseline = what it knew when it graduated
    } else if (state.lastFamiliarity != null) {
      // RE-FLOOR on a DROP: if familiarity fell below the baseline (e.g. a dossier dim was ADDED so the fraction
      // shrank — 5→7 dims — or a belief was forgotten), lower the baseline to now. Otherwise a one-time denominator
      // change could leave familiarity permanently ≤ baseline and freeze ongoing ideas forever for pre-existing saves.
      const fam = familiarityNow();
      if (fam != null && fam < state.lastFamiliarity) state.lastFamiliarity = fam;
    }
    save();
  }

  // the sync gate chat.js consults in its single post-run beat slot (read-only — no mutation, no model call).
  function willSuggest() {
    if (!ready() || firing) return false;
    const sum = summary();
    const known = sum ? sum.known : [];
    const fam = sum && Number.isFinite(sum.familiarity) ? sum.familiarity : 0;
    // V3 §6: the shared readiness gate (fail-closed — no provable readiness, no idea). Same read pitchstore uses.
    let rd = { ready: false, why: 'no-readiness-read' };
    try {
      if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) {
        const r = UnderstandingStore.readiness();
        if (r) rd = { ready: !!r.ready, why: (r.reasons && r.reasons[0]) || '' };
      }
    } catch (_) {}
    const gate = Pitch.shouldSuggest({
      firstPitchDone: pitchDone(),
      knownDims: known,
      familiarity: fam,
      lastFamiliarity: (state.lastFamiliarity == null ? fam : state.lastFamiliarity),   // no baseline yet → nothing-new
      tasksSinceLast: state.tasksSinceLast || 0,
      sessionShown: sessionShown,
      ready: rd.ready, readyWhy: rd.why
    });
    if (gate.go) return true;
    // Tier 2 (§5 ADDITIVE OR): if the ONLY thing holding the idea back is "nothing new" and a goal milestone just
    // advanced, that progress IS the new thing — let it through. Every OTHER gate (graduation/require-dims/session
    // cap/cooldown) still applies (a non-'nothing-new' reason still blocks), so no cap is ever bypassed.
    if (goalProgressed && gate.reason === 'nothing-new') return true;
    return false;
  }

  // run the idea directive → parse → render a GENTLE nudge → route "build it". Awaitable for the test. Called by
  // chat.js only when willSuggest() is true and the shared beat slot is free.
  async function fire() {
    if (firing || !ready()) return;
    if (typeof Harness === 'undefined' || !Harness.chat) return;
    if (typeof Chat === 'undefined' || !Chat.nudge) return;
    firing = true;
    // G1c: consume any armed chain ONCE — this fire either uses it or it's dropped (never carried to a later beat).
    const chain = pendingChain; pendingChain = null;
    goalProgressed = false;   // Tier 2: the goal-progress "something new" allowance is spent on THIS fire (one-shot)
    try {
      const recipes = (typeof Recipes !== 'undefined' && Recipes.list)
        ? Recipes.list().map(r => ({ id: r.id, name: r.name, tagline: r.tagline })) : [];
      const caps = deps.getCaps ? deps.getCaps() : [];
      // R3 BELIEF PROBE: when a north-star-critical belief's confidence has sagged, aim this idea at it —
      // the accept/decline below then silently corroborates or counter-evidences that belief (drift detection
      // with zero new asks). Fail-open: no UnderstandingStore / no sagging belief → the normal un-aimed idea.
      let probe = null;
      try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.probeTarget) probe = UnderstandingStore.probeTarget(); } catch (_) {}
      /* THE STALENESS GUARD ON THE PROBE (quality loop Q3, wired here in W2). The probe aims this idea at a
         belief whose confidence has SAGGED — and the directive tells the model to build for that belief while
         never mentioning it. That is fine for a merely under-corroborated belief, and wrong for a genuinely
         STALE one: aiming a pitch at something the station itself cannot stand behind is the confident bad
         recommendation Q3 exists to prevent, and the arc lane already refuses it (it asks "still true?"
         instead). So a stale probe target is DROPPED and this idea goes out un-aimed rather than aimed at a
         memory we would not assert. Fail-open: no engine / nothing to read → the probe rides as before. */
      if (probe && probe.belief) {
        try {
          if (typeof RecQuality !== 'undefined' && RecQuality.staleness) {
            const uRead = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.read) ? UnderstandingStore.read() : null;
            const st = RecQuality.staleness(probe.belief, Date.now(), uRead, probe.dim);
            if (st && st.stale) probe = null;
          }
        } catch (_) {}
      }
      const directive = Pitch.buildDirective({ recipes, capabilities: caps, recentTask: deps.getRecentTask ? deps.getRecentTask() : '', unlockedCapability: chain || '', probe: probe, exclude: excludeTitles(), wantEvidence: true, nextMilestone: nextMilestone() });
      const system = deps.getSystem ? deps.getSystem() : '';
      // evidence:true (W2): the ongoing suggestion is the station guessing what would help next; the learned
      // topics (with their verbatim quotes) and open threads are the grounding it was being denied.
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true, evidence: true });
      const parsed = (res && !res.error) ? Pitch.parsePitch(res.text) : null;
      if (!parsed) { state.tasksSinceLast = 0; save(); return; }   // model hiccup → back off a full cooldown, don't hammer

      // already pitched this idea before? skip it WITHOUT spending the session — but also advance the growth baseline
      // so a repeat needs FURTHER dossier growth before it can fire again. Otherwise a low-diversity model that keeps
      // returning the same idea would burn an aux-model call every cooldown forever; this caps that to once per growth.
      const fp = fingerprint(parsed.title);
      if (seenRecently(fp)) { const fam = familiarityNow(); if (fam != null) state.lastFamiliarity = fam; state.tasksSinceLast = 0; save(); return; }

      /* THE GROUNDING VETO ON THE QUOTE (rec perfection W2). The model was asked for the Commander's OWN words
         this pitch stands on. A model that cannot find them will invent them — so the quote is kept ONLY when it
         shares real significant-token overlap with what the station actually knows (autopilot.js grounded(), the
         same veto autojobs uses on its GROUNDS line, over the same {dim:[text]} belief pool). No overlap → the
         quote is DROPPED and the nudge speaks exactly as it did before this contract existed: the model's own
         WHY line, never framed as the Commander's speech. Fail-CLOSED on a missing engine or an empty pool: a
         check that cannot run has not passed, and this is the one field that would be spoken back as "you said". */
      const groundedQuote = groundQuote(parsed.evidence);
      const why = parsed.why ? (' ' + parsed.why) : '';
      const gap = parsed.gap ? (' i’d need one thing from you: ' + parsed.gap) : '';
      // G3a seed callout: an idea that reuses a Commander-saved seed credits it inline (a credit line,
      // never a separate beat) — the mint→pitch loop, spoken closed.
      let credit = '';
      if (typeof SeedCredit !== 'undefined' && parsed.build && parsed.build.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const c = SeedCredit.creditForRecipe(Recipes.get(parsed.build.recipeId));
        if (c) credit = ' ' + c;
      }
      /* THE RECEIPT, when there is one. A grounded quote is the Commander's own words, so it is spoken in the
         ONE grammar every other recommendation surface uses (recommend.js whyLine → «because you said "…"»);
         an ungrounded or absent one renders nothing at all, and the line is byte-identical to today's. */
      const receipt = groundedQuote ? (' ' + citeLine(groundedQuote)) : '';
      const line = '✦ a fresh idea — ' + Pitch.titleSentence(parsed.title) + why + receipt + credit + gap;   // shared title→sentence join (no double period)
      const recommendationId = 'suggest:' + fp + ':' + Date.now();
      let rd = null; try { rd = (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.readiness) ? UnderstandingStore.readiness() : null; } catch (_) {}
      /* THE LEDGER MUST NOT CALL THE MODEL'S OWN PROSE A QUOTE (2026-08-05).
         `parsed.why` is the WHY line the aux model wrote about its own pitch. It was posted as
         `{ type: 'context', quote: parsed.why }` — the same shape the study and thread channels use for a
         VERBATIM fragment they located in the Commander's words. Every downstream reader of this ledger
         (evidenceCoverage, the preference fold, and the W2 evidence contract that will decide which citations
         may be spoken as "because you said") then sees a quote-typed row that nobody ever said. Type it for what
         it is: MODEL-AUTHORED RATIONALE. Nothing here is deleted — the text is still recorded, and a reader that
         wants it can have it; it simply can never again be mistaken for evidence.
         RESIDUAL, stated rather than hidden: recommendation-ledger.normalizeEntry stores `text` into its `quote`
         column (`quote: clip(e.quote || e.text, 280)`), so the STRING still lands there. The `type` is what
         discriminates, and typing it honestly is the whole fix available without reshaping the stored row —
         which belongs to W2's evidence contract, not to this slice. */
      /* …AND THE GROUNDED QUOTE IS REAL EVIDENCE, so it rides as a real quote-typed row beside that rationale
         (W2 completes what W3's typing fix opened): the row now distinguishes what the MODEL said about its
         pitch from what the COMMANDER said that the pitch stands on. Only a quote that survived the veto is
         ever written — evidenceCoverage counts grounded citations, never model prose wearing their clothes. */
      const evidenceRows = [];
      if (groundedQuote) evidenceRows.push({ id: 'suggest-evidence', type: 'quote', quote: groundedQuote });
      if (parsed.why) evidenceRows.push({ id: 'suggest-rationale', type: 'rationale', text: parsed.why });
      ledgerPost({ id: recommendationId, surface: 'suggest', kind: (parsed.build && parsed.build.kind) || 'idea', title: parsed.title,
        target: (parsed.build && parsed.build.recipeId) || '', evidence: evidenceRows,
        readiness: rd ? { ready: !!rd.ready, reasons: rd.reasons || [] } : { ready: false, reasons: ['missing'] }, modelVersion: 'suggest-v2' });
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // G3a: the idea beat gets its soft chime (was mute)
      Chat.nudge(line, [{ label: 'let’s build it', value: 'build' }, { label: 'not now', value: 'no', skip: true }, { label: 'never suggest this', value: 'never', skip: true }], choice => {
        const accepted = !!(choice && choice.value === 'build');
        // R3: settle the probe — the choice on an AIMED idea is evidence about the belief it was aimed at
        // (accept corroborates, decline counter-evidences). An un-aimed idea settles nothing.
        if (probe) { try { if (typeof UnderstandingStore !== 'undefined' && UnderstandingStore.noteProbe) UnderstandingStore.noteProbe(probe.dim, accepted); } catch (_) {} }
        // THE OUTCOME LOOP (quality loop, Q2): a built idea SPAWNS A RUN, so nothing is credited here — the
        // pending stamp is claimed by that run and the run's own outcome (a clean finish, and the Commander's
        // 👍/👌/👎 on it) is the evidence. A click is not a result. Declines/defers settle immediately.
        // THE STAMP IS ARMED OFF THE LAUNCH, NOT OFF THE CLICK (fixed 2026-08-04): doBuild refuses while the
        // agent is mid-run, and arming first left the stamp waiting for a run this offer never started — the
        // Commander's next unrelated manual run then claimed it. Arm only when a run really kicked off.
        /* ⚠ AN ORDERING DEPENDENCY THIS RELIES ON, NAMED SO IT IS NOT BROKEN BY ACCIDENT: arming AFTER the launch
           is only safe because the run's id arrives ASYNCHRONOUSLY. chat.js claims the pending stamp inside the
           stream's `onRunId` callback (RUN_META, recClaimRun), which fires after the network round-trip — well
           after doBuild() has returned and the noteAccept below has run. If onRunId ever became synchronous with
           Chat.send(), claimForRun would run against a still-empty `pending` and every suggestion-spawned run
           would silently lose its attribution. Locked by recqualitystore.test §10. */
        const rq = (typeof RecQualityStore !== 'undefined') ? RecQualityStore : null;
        if (accepted) { acceptedRecommendation = recommendationId; acceptedRunId = null; ledgerPost({ id: recommendationId, state: 'accepted', reason: 'accepted' });
          const launched = doBuild(parsed);
          if (launched) {
            if (rq && rq.noteAccept) { try { rq.noteAccept({ channel: 'suggest', dim: probe ? probe.dim : '', spawnsWork: true, id: recommendationId }); } catch (_) {} }
          }
          /* A REFUSED LAUNCH IS A REAL EVENT, AND IT WAS SILENT (fixed 2026-08-04). doBuild returns false when
             the stream is busy — the guard above correctly stops the attribution stamp being armed on work that
             never started, but then NOTHING happened: the loop learned nothing and the Commander was told
             nothing. They tapped "let's build it" and the beat simply vanished.
             What the harness can honestly say is exactly what a "not now" says — right idea, wrong moment — so
             that is the outcome folded, and the chip settles with one short line naming the real reason.
             `acceptedRecommendation` is cleared for the same reason the stamp is not armed: no run started, so
             the next unrelated run must not be recorded (onRunStart) as this recommendation's work.
             The ledger gets the same truth: NEXT.accepted permits `declined`, and the ledger's own fold
             (recommendation-ledger.js) explicitly treats declined/wrong_time as NEUTRAL, not negative — the
             exact "right idea, wrong moment" shape this is. Leaving the row terminal at `accepted` would have
             counted a launch that never happened as a positive preference signal forever.
             NOTE this branch keys on `launched` ALONE — a successful launch with RecQualityStore absent must
             never take the refused path (it would clear the accept and lie to the Commander mid-run). */
          else {
            acceptedRecommendation = null; acceptedRunId = null;
            ledgerPost({ id: recommendationId, state: 'declined', reason: 'wrong_time' });
            if (rq && rq.noteDecline) { try { rq.noteDecline({ channel: 'suggest', dim: probe ? probe.dim : '' }, true); } catch (_) {} }
            try { if (typeof Chat !== 'undefined' && Chat.localLine) Chat.localLine('stream’s busy — ask me again after this run'); } catch (_) {}
          } }
        else if (choice && choice.value === 'never') { rememberDeclined(fp, parsed.title); save(); ledgerPost({ id: recommendationId, state: 'declined', reason: 'wrong_thing' });
          if (rq && rq.noteDecline) { try { rq.noteDecline({ channel: 'suggest', dim: probe ? probe.dim : '' }, false); } catch (_) {} } }
        else { ledgerPost({ id: recommendationId, state: 'deferred', reason: 'wrong_time' });
          if (rq && rq.noteDecline) { try { rq.noteDecline({ channel: 'suggest', dim: probe ? probe.dim : '' }, true); } catch (_) {} } }
      });

      sessionShown++;                                   // spend this session's single idea (anti-nag)
      rememberIdea(fp, parsed.title);                   // record the idea so it's never re-pitched as a "fresh idea"
      const fam = familiarityNow();
      if (fam != null) state.lastFamiliarity = fam;     // advance the baseline so the NEXT idea needs further growth
      state.tasksSinceLast = 0;                         // restart the cooldown
      save();
    } catch (_) {
    } finally {
      firing = false;
    }
  }

  // "build it" → a real run starts immediately. Same routing as the First Pitch: a fully-runnable recipe launches;
  // a recipe that still needs its gap (or an unknown recipe) becomes the gap-asking directive — never an empty
  // template. (Kept local rather than shared so pitchstore.js stays untouched.)
  /* RETURNS WHETHER A RUN ACTUALLY STARTED. Both launch paths refuse while the agent is mid-run (Chat.send
     silently no-ops when Chat.isBusy()), and the outcome loop's attribution stamp is armed off this answer —
     so a "build it" that launched NOTHING used to leave the stamp armed, and the Commander's next unrelated
     manual run claimed it and moved this channel's weight on work it never caused. FAIL-CLOSED on purpose: a
     launcher that does not report `true` is treated as "no run started", because an unprovable launch must
     never become an attributed outcome. */
  function doBuild(parsed) {
    try {
      // G1c: the accepted idea becomes a trackable WORK quest (multi-step, rides the QuestState celebration).
      // Minted BEFORE the launch so the store can claim the run the launch kicks off. Additive, best-effort.
      try { if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.accept) WorkQuestStore.accept(parsed); } catch (_) {}
      const b = parsed.build || {};
      if (b.kind === 'recipe' && b.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const r = Recipes.get(b.recipeId);
        const missing = r ? ((typeof Recipes.requiredMissing === 'function') ? Recipes.requiredMissing(r, {}) : []) : ['_unknown'];
        if (r && deps.launchRecipe && !missing.length) return deps.launchRecipe(r, null) === true;
      }
      const gapLine = parsed.gap ? (' First, ask me: ' + parsed.gap + '.') : '';
      const directive = "Let's build it — " + parsed.title + '.' + gapLine;
      if (deps.launchDirective) return deps.launchDirective(directive) === true;
      if (typeof Chat !== 'undefined' && Chat.send && !Chat.isBusy()) { Chat.send(directive); return true; }
      return false;
    } catch (_) { return false; }
  }

  // S2: a brand-new hero starts fresh (no baseline, no cooldown carryover). Own key, like curiositystore.
  function reset() { state = { v: 1, lastFamiliarity: null, tasksSinceLast: 0, recent: [], declined: [] }; sessionShown = 0; firing = false; pendingChain = null; goalProgressed = false; acceptedRecommendation = null; acceptedRunId = null; try { localStorage.removeItem(KEY); } catch (_) {} }

  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onRunEnd, willSuggest, fire, armChain, noteGoalProgress, _state: () => state, _session: () => sessionShown, _chain: () => pendingChain };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { SuggestStore };
