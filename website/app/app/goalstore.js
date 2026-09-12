/* STARNET — goalstore.js : the live wiring around the pure GOAL-TREE engine (goals.js) — GROWTH Tier 2.

   The glue that turns a flat dossier goals-belief into a confirmed, persisted PATH the Commander watches fill in:
     • THE DECOMPOSITION FLOW — when a goals-dim belief exists with no goal tree yet, it runs the pure
       Goals.buildDirective through the EXISTING reason-only model path (the same Harness.chat plumbing pitchstore
       uses: placed:[], isTask:false, internal:true), parses the reply (Goals.parseDecomposition, value-floor +
       redact + cap), and offers ONE confirm beat ("here's how I'd break this down — good?") at the LOWEST post-run
       priority (memory turn-in + study proposals win first). Confirm persists the tree; Not-now re-offers ONLY
       after the dossier's goals belief changes (never nags). The confirm panel is a focused Dialogue, like the
       First Pitch — chat.js drives the arbitration through the shared beat slot's arc participant.
     • THE QUEST PROJECTION — the active goal renders as a header + progress meter with its next OPEN milestone as
       an actionable quest (joined into QuestStore.view via Goals.project). Accepting the milestone quest routes
       through the EXISTING work-quest path (WorkQuestStore.accept), binding the real build to the milestone so
       completing the REAL work completes the milestone — never a manual tick.
     • THE CHAINING + EVIDENCE — on every clean run end it re-reads WorkQuestStore's projection; a bound milestone
       whose work quest went done folds the milestone done (Goals.foldMilestoneDone), WRITES the run-summary line
       as evidence, advances the plan bar, surfaces the NEXT milestone quest, and bumps Study salience.
       The life goal stays active until its success condition is explicitly confirmed. Step completion rides queststatestore
       celebration (its open→done fold sees arc-step/arc-goal edges in the shared projection).
     • DRIFT — if the Study Engine retires the source goals belief (dossier.forget), sync() detects the belief is
       gone and retires the goal tree (kept for history, hidden from the active quest log).

   Discipline mirrors studystore.js / workqueststore.js:
   - READ-ONLY citizen of U.bus — subscribes to agent.run.end, NEVER emits (the frozen shared/events.js contract
     is owned elsewhere; lint-emits stays green).
   - Self-persists its OWN localStorage key (the goal trees + the not-now re-offer fingerprints) — no save.js
     change (the established growth-store pattern). Mirrors the active goal to the sidecar (POST /api/goals) so
     server-composed cron runs can see it, exactly like DossierStore.pushToSidecar.
   - node-exportable for its test; all DECISION logic lives in the pure Goals engine, this is the edge. */
'use strict';
const GoalStore = (() => {
  const KEY = 'starnet.goals.v1';
  const GOAL_CAP = 24;          // keep at most this many goal trees (FIFO by createdAt) — history, never unbounded
  const OFFERED_CAP = 100;      // offered-fingerprint memory (FIFO) — bounded like studystore's resolved set, never unbounded localStorage growth
  let state = null;             // { v, goals:[goalNode], offered:{ beliefFp: 1 }, offeredOrder:[fp] } — offered = decompositions declined/pending, keyed by the belief fingerprint (re-offer only on change)
  let deps = {};                // { getSystem, getName, getCaps } injected by app.js (all optional; fail-open)
  let bound = false;
  let firing = false;           // re-entrancy guard while a decomposition confirm is mid-flight
  let creatingGoal = false;
  /* THE STUBBORN-BELIEF SPEND LEAK (fixed 2026-08-04). A reply that parses to fewer than MIN_PATH milestones is
     unusable, and the old code marked NOTHING offered so a later, better reply could still land — which meant a
     belief the model simply cannot decompose re-paid the aux call at EVERY run end, forever. Two failed attempts
     on one belief fingerprint is enough evidence: mark it offered, so it re-offers only when the belief itself
     changes (exactly what a not-now does). In-memory per session; markOffered is what persists. */
  const DECOMP_FAIL_LIMIT = 2;
  const MIN_PATH = 3;           // the floor the confirm panel itself enforces — a shorter path is a failure here too
  let decompFails = {};         // beliefFingerprint -> consecutive unusable decomposition attempts
  let cachedProposal = null;    // { fp, texts } — the last USABLE decomposition the model produced, keyed by the belief fingerprint. If the beat moment was lost after the (paid) aux call, the next offer for the SAME belief state reuses it instead of re-spending. In-memory only; cleared on confirm/decline/init/reset.
  const journeySyncing = new Set(); // completed milestone outbox keys awaiting sidecar acknowledgement

  const now = () => { try { if (typeof deps.now === 'function') return deps.now(); } catch (_) {} return (typeof Date !== 'undefined' && Date.now) ? Date.now() : 0; };
  const ready = () => typeof Goals !== 'undefined' && state;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  function poke() { try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); } catch (_) {} }
  function capHistory(s) {
    // Completed chapters belong to the Commander. Never evict them to make room for a new goal.
  }

  // defensively rebuild the persisted slice — every goal + milestone re-validated, junk dropped (never a crash).
  function hydrate(raw) {
    const s = { v: 1, goals: [], ideas: [], offered: {}, offeredOrder: [] };
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw.goals)) {
        for (const g of raw.goals) {
          if (!g || typeof g !== 'object' || !g.id) continue;
          const created = Number(g.createdAt);
          if (!Number.isFinite(created)) continue;
          const ms = Array.isArray(g.milestones) ? g.milestones.map(m => ({
            id: String((m && m.id) || ''),
            text: String((m && m.text) || '').slice(0, 140),
            status: (m && m.status === 'done') ? 'done' : 'open',
            questRef: (m && m.questRef != null) ? String(m.questRef) : null,
            evidence: String((m && m.evidence) || '').slice(0, 160),
            source: m && m.source === 'commander' ? 'commander' : 'harness',
            doneAt: (m && Number.isFinite(Number(m.doneAt))) ? Number(m.doneAt) : null,
            journeySyncedAt: (m && m.journeySyncedAt != null && Number.isFinite(Number(m.journeySyncedAt))) ? Number(m.journeySyncedAt) : null
          })).filter(m => m.id) : [];
          if (!ms.length) continue;
          const status = ['done', 'retired', 'paused', 'archived'].includes(g.status) ? g.status : 'active';
          s.goals.push({
            id: String(g.id), text: String(g.text || '').slice(0, 280),
            successCondition: String(g.successCondition || '').slice(0, 500),
            outcomeEvidence: String(g.outcomeEvidence || '').slice(0, 1000),
            motivation: String(g.motivation || '').slice(0, 500),
            constraints: String(g.constraints || '').slice(0, 500),
            journal: (Array.isArray(g.journal) ? g.journal : []).filter(e => e && Number.isFinite(e.at) && e.text).map(e => ({ at: e.at, kind: String(e.kind || 'reflection').slice(0, 30), text: String(e.text).slice(0, 1000) })),
            focusedAt: Number(g.focusedAt) || 0,
            nextMilestoneId: ms.some(m => m.id === g.nextMilestoneId) ? g.nextMilestoneId : null,
            pendingRegistration: !!g.pendingRegistration,
            sourceBeliefId: g.sourceBeliefId == null ? null : String(g.sourceBeliefId),
            status, milestones: ms, createdAt: created,
            updatedAt: Number.isFinite(Number(g.updatedAt)) ? Number(g.updatedAt) : created
          });
        }
      }
      s.ideas = (Array.isArray(raw.ideas) ? raw.ideas : []).filter(i => i && i.id && i.text).slice(0, 100).map(i => ({
        id: String(i.id), text: String(i.text).slice(0, 280), question: String(i.question || '').slice(0, 500),
        learning: String(i.learning || '').slice(0, 1000), createdAt: Number(i.createdAt) || 0,
        goalId: i.goalId ? String(i.goalId) : null, archived: !!i.archived
      }));
      // rebuild the offered set from its FIFO order (capped) — pre-order saves fall back to key iteration once.
      const order = Array.isArray(raw.offeredOrder) ? raw.offeredOrder
        : (raw.offered && typeof raw.offered === 'object') ? Object.keys(raw.offered) : [];
      for (const k of order.slice(-OFFERED_CAP)) {
        const fp = String(k);
        if (fp && !s.offered[fp] && raw.offered && raw.offered[k]) { s.offered[fp] = 1; s.offeredOrder.push(fp); }
      }
    }
    s.goals.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    capHistory(s);
    return s;
  }

  // a stable fingerprint of a goals belief (its id + significant text tokens) — so a not-now decision re-offers
  // ONLY when the belief genuinely CHANGES (new id, or the text was edited), never on every idle tick.
  function beliefFingerprint(b) {
    if (!b) return '';
    const toks = String(b.text == null ? '' : b.text).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return String(b.id || '') + '|' + Array.from(new Set(toks)).sort().join(' ');
  }

  // the live goals-dim beliefs (the decomposition source). [] when the dossier is absent/cold.
  function goalsBeliefs() {
    try {
      if (typeof DossierStore !== 'undefined' && DossierStore.beliefs) { const arr = DossierStore.beliefs('goals'); return Array.isArray(arr) ? arr : []; }
    } catch (_) {}
    return [];
  }

  // A Commander-authored goal can exist before it has a confirmed milestone tree. Surface that state explicitly
  // instead of letting the QUEST LOG claim there is "no goal". Goals already represented by an active/completed
  // tree are excluded; the active projection renders those from the authoritative tree instead.
  function unplannedGoal() {
    if (!ready()) return null;
    const beliefs = goalsBeliefs();
    for (const b of beliefs) {
      if (!b || !b.id || !String(b.text || '').trim()) continue;
      const represented = state.goals.some(g => g && g.sourceBeliefId === String(b.id) && (g.status === 'active' || g.status === 'done'));
      if (!represented) return b;
    }
    return null;
  }

  // mirror the ACTIVE goal to the sidecar (fire-and-forget) so server-composed cron runs can see the current path.
  // Mirrors DossierStore.pushToSidecar exactly: a plain POST, a no-op if unreachable. Only the active goal's text +
  // progress + next step travel (a compact, cron-useful summary — never the whole history).
  function pushToSidecar() {
    if (!ready() || typeof fetch !== 'function') return;
    try {
      const g = Goals.activeGoal(state.goals);
      let payload = null;
      if (g) {
        const pr = Goals.progress(g);
        const next = Goals.nextMilestone(g);
        payload = { id: g.id, text: g.text, done: pr.done, total: pr.total, pct: pr.pct,
          next: next ? next.text : null, milestoneId: next ? next.id : null };
      }
      fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: payload }) }).catch(() => {});
    } catch (_) {}
  }

  /* ---------- THE DECOMPOSITION FLOW ---------- */
  // is there a goals belief with NO goal tree yet, whose decomposition we haven't already offered for THIS belief
  // state? Returns the belief to decompose, or null. Re-offer discipline: an offered/declined belief re-surfaces
  // only when its fingerprint changes (never nags). A belief already bound to an active/done goal is skipped.
  function pendingDecomposition() {
    if (!ready()) return null;
    const beliefs = goalsBeliefs();
    if (!beliefs.length) return null;
    for (const b of beliefs) {
      if (!b || !b.id || !b.text) continue;
      // already has a goal tree (active or done — a shipped goal isn't re-decomposed; a retired one may re-offer)?
      const has = state.goals.some(g => g.sourceBeliefId === String(b.id) && (g.status === 'active' || g.status === 'done'));
      if (has) continue;
      const fp = beliefFingerprint(b);
      if (state.offered[fp]) continue;   // offered/declined for this exact belief state — wait for a change
      return b;
    }
    return null;
  }
  // whether an arc confirm beat is worth ATTEMPTING now (chat.js gates the actual slot). Pure read: a pending
  // belief exists, we're not mid-flight, and the model path is reachable.
  function willOfferDecomposition() {
    if (!ready() || firing) return false;
    if (typeof Harness === 'undefined' || !Harness.chat) return false;
    return !!pendingDecomposition();
  }

  // run the decomposition directive → parse → return { belief, texts } (the proposed path) or null. Awaitable so
  // the test can drive it. Fail-open: a model hiccup / unparseable / under-3-milestone reply yields null and marks
  // NOTHING offered (so a later, better reply can still land) — EXCEPT we DO mark offered when the model gave a
  // usable-but-declined path (handled in the confirm side). Redaction rides via the injected redact dep.
  // SPEND-ONCE: a usable path is CACHED by the belief fingerprint — if the caller lost the beat moment after this
  // (paid) aux call (memory/study claimed it mid-round-trip), the next offer for the SAME belief state reuses the
  // cached path instead of re-calling the model. The cache clears the moment the belief is decided (markOffered).
  async function proposeDecomposition() {
    // NOTE: no `firing` guard here — the offer flow (chat.js offerArc) sets firing BEFORE this call, so
    // gating on it deadlocked the arc into always returning null (re-entry is already blocked by
    // willOfferDecomposition + offerArc's isFiring() entry check).
    if (!ready()) return null;
    if (typeof Harness === 'undefined' || !Harness.chat) return null;
    const belief = pendingDecomposition();
    if (!belief) return null;
    const fp = beliefFingerprint(belief);
    if (cachedProposal && cachedProposal.fp === fp) return { belief, texts: cachedProposal.texts.slice() };   // reuse the already-paid-for path
    // one unusable attempt is a hiccup; DECOMP_FAIL_LIMIT of them is a belief this model cannot decompose —
    // stop paying for it and let a change to the belief re-open it (see DECOMP_FAIL_LIMIT).
    const failed = () => {
      decompFails[fp] = (decompFails[fp] || 0) + 1;
      if (decompFails[fp] >= DECOMP_FAIL_LIMIT) { markOffered(belief); save(); }
      return null;
    };
    try {
      const directive = Goals.buildDirective(belief.text);
      const system = deps.getSystem ? deps.getSystem() : '';
      // evidence:true (W2): a decomposition proposes the MILESTONES of the Commander's own goal — the open
      // threads and recent activity are exactly what makes those milestones theirs rather than generic.
      const res = await Harness.chat({ system, messages: [{ role: 'user', content: directive }], agentId: 'agent', isTask: false, placed: [], internal: true, evidence: true });
      if (!res || res.error) return failed();
      const texts = Goals.parseDecomposition(res.text, { redact: deps.redact });
      if (texts.length < MIN_PATH) return failed();   // under-decomposed / unusable — the confirm panel would drop it anyway
      delete decompFails[fp];
      cachedProposal = { fp, texts: texts.slice() };
      return { belief, texts };
    } catch (_) { return failed(); }
  }

  // CONFIRM a decomposition: persist the goal tree from the (possibly edited) milestone texts, bound to the belief.
  // Returns the new goal node (or null on a too-short/invalid path). Marks the belief offered (so it never re-offers
  // for THIS belief state) and mirrors to the sidecar. The caller (chat.js confirm panel) calls this on "Confirm".
  function confirm(belief, texts) {
    if (!ready() || !belief) return null;
    const goal = Goals.makeGoal(belief.text, texts, belief.id, now());
    if (!goal) { markOffered(belief); return null; }   // an edited-down-to-nothing path still counts as offered (don't loop)
    state.goals.push(goal);
    capHistory(state);
    markOffered(belief);
    // NB the double save(): markOffered persists on its own (its null-path caller has no other save), so this one
    // is redundant for the offered set — it is kept because it is THIS function's save of the pushed goal, and
    // localStorage.setItem of one small object is cheaper than a subtle ordering dependency between the two.
    save(); pushToSidecar(); poke();
    return goal;
  }
  // NOT-NOW: mark this belief state offered so it re-surfaces only after the belief changes (never nags). The
  // Commander can still return to the arc anytime; this just stops the proactive confirm beat for this belief.
  function declineDecomposition(belief) { if (ready() && belief) { markOffered(belief); } }   // markOffered saves
  // record the belief state as decided (FIFO-capped, mirrors studystore's resolved set) + drop the spend-once cache
  // for it — a decided belief's cached path can never leak into a later, different offer.
  // PUBLIC (2026-08-04): the re-confirm card's "not now" chip records the belief state as decided through this
  // same door, so a question the Commander deferred re-surfaces only when the belief itself changes — one
  // not-now discipline for every proactive ask about a goals belief, not two.
  function markOffered(belief) {
    if (!ready() || !belief) return;
    const fp = beliefFingerprint(belief);
    if (!fp) return;
    if (cachedProposal && cachedProposal.fp === fp) cachedProposal = null;
    if (!state.offered[fp]) {
      state.offered[fp] = 1;
      state.offeredOrder.push(fp);
      while (state.offeredOrder.length > OFFERED_CAP) { const old = state.offeredOrder.shift(); delete state.offered[old]; }
    }
    save();   // a decision this durable is never left in memory only (confirm()'s null-path used to drop it)
  }

  /* ---------- THE MILESTONE → WORK-QUEST BINDING ---------- */
  // the bound work quest's projected entry (or null when it no longer projects — dismissed/dead).
  function questEntry(ref) {
    if (ref == null) return null;
    try {
      if (typeof WorkQuestStore === 'undefined' || !WorkQuestStore.quests) return null;
      for (const q of (WorkQuestStore.quests() || [])) if (q && String(q.id) === String(ref)) return q;
    } catch (_) {}
    return null;
  }
  // is a bound work quest still IN FLIGHT (open, not stalled)? A dismissed/absent binding reads false — that is the
  // recovery path: a dead questRef re-offers Accept. Feeds Goals.project (the "in progress" render state).
  function questLive(ref) {
    const e = questEntry(ref);
    return !!(e && e.status === 'open' && !e.stalled);
  }
  // accept the next milestone of the active goal as a real build: route it through the EXISTING work-quest path so
  // completing the real work completes the milestone. Returns the milestone accepted (or null).
  // DOUBLE-SPEND GUARD: a milestone whose bound work quest is still live (or done-awaiting-reconcile) REFUSES a
  // re-accept — a stale UI click can never mint a duplicate build + a duplicate paid run. A stalled/dismissed/dead
  // binding re-accepts cleanly (the recovery path): the fresh work quest re-binds the milestone.
  function acceptMilestone(goalId, milestoneId) {
    if (!ready()) return null;
    const goal = state.goals.find(g => g.id === goalId && g.status === 'active');
    if (!goal) return null;
    const m = goal.milestones.find(x => x && x.id === milestoneId && x.status === 'open');
    if (!m) return null;
    const next = Goals.nextMilestone(goal);
    if (!next || next.id !== m.id) return null;   // only the CURRENT front milestone is acceptable (honest chaining)
    if (m.questRef) {
      const e = questEntry(m.questRef);
      if (e && (e.status === 'done' || (e.status === 'open' && !e.stalled))) return null;   // live build (or done, one reconcile away) — never double-spend
    }
    // route through the work-quest path as a workflow build (the milestone text IS the directive). WorkQuestStore
    // mints a trackable build + returns its id; bind that id to the milestone so its completion folds the milestone.
    let wqId = null;
    try {
      if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.accept) {
        wqId = WorkQuestStore.accept({ title: m.text, build: { kind: 'workflow', recipeId: null } });
      }
    } catch (_) {}
    if (wqId) Goals.bindMilestoneQuest(goal, m.id, wqId);   // no id (store absent/failed) → the milestone stays unbound and Accept re-offers (fail-open)
    save();
    // fire the real run for this milestone (the no-dead-gap promise) — the same launch path the pitch build uses.
    try { if (deps.launchDirective) deps.launchDirective("Let's work toward: " + m.text
      + '\n\nThis step supports my goal: ' + goal.text
      + (goal.successCondition ? '\nThe overall goal is achieved when: ' + goal.successCondition : '')
      + (goal.motivation ? '\nWhy this matters to me: ' + goal.motivation : '')
      + (goal.constraints ? '\nMy constraints: ' + goal.constraints : '')
      + (goal.journal && goal.journal.length ? '\nMy latest reflection: ' + goal.journal.filter(e => e.kind === 'reflection').slice(-1).map(e => e.text).join('') : '')
      + '\nWork on this step, and show the result and anything still unverified. Completing this task does not by itself prove the overall goal is achieved.'); } catch (_) {}
    return m;
  }

  /* ---------- CHAINING + EVIDENCE (the honesty core) ---------- */
  // Save completed milestones locally first, then acknowledge their journey fold. A failed/lost POST remains
  // pending and retries on init or quest sync; the backend's goal+milestone key makes every replay idempotent.
  async function syncJourneyMilestones() {
    if (!ready() || typeof JourneyStore === 'undefined' || !JourneyStore.noteMilestone) return { acknowledged: 0, pending: 0 };
    let acknowledged = 0, pending = 0;
    for (const g of state.goals) {
      if (!g || !Array.isArray(g.milestones)) continue;
      for (let i = 0; i < g.milestones.length; i++) {
        const m = g.milestones[i];
        if (!m || m.status !== 'done' || m.journeySyncedAt != null) continue;
        pending++;
        const key = String(g.id) + ':' + String(m.id);
        if (journeySyncing.has(key)) continue;
        journeySyncing.add(key);
        try {
          const r = await JourneyStore.noteMilestone({
            goalId: g.id, goalText: g.text, milestoneId: m.id, milestoneText: m.text,
            evidence: m.evidence || ('completed: ' + String(m.text || '')).slice(0, 160),
            source: m.source || 'harness', agentId: m.source === 'commander' ? null : 'agent',
            goalDone: false
          });
          if (r && r.ok) { m.journeySyncedAt = now(); acknowledged++; save(); }
        } catch (_) { /* stays pending */ }
        finally { journeySyncing.delete(key); }
      }
    }
    return { acknowledged, pending };
  }
  function queueJourneySync() { syncJourneyMilestones().catch(() => {}); }

  async function setSuccessCondition(goalId, successCondition) {
    const g = ready() && state.goals.find(g => g.id === goalId && g.status === 'active');
    const condition = String(successCondition || '').trim();
    if (!g || condition.length < 4) return { ok: false, error: 'describe the observable result that means this goal is achieved' };
    if (typeof JourneyStore === 'undefined' || !JourneyStore.registerGoal) return { ok: false, error: 'journey service unavailable' };
    const r = await JourneyStore.registerGoal({ id: g.id, text: g.text, successCondition: condition });
    if (r && r.ok) { g.successCondition = condition.slice(0, 500); g.pendingRegistration = false; save(); pushToSidecar(); poke(); }
    return r;
  }

  async function createGoal(text, successCondition, steps, options) {
    if (creatingGoal) return { ok: false, error: 'The goal is being saved.' };
    if (!ready() || typeof JourneyStore === 'undefined' || !JourneyStore.registerGoal) return { ok: false, error: 'journey service unavailable' };
    const title = Goals.scrubSecrets(String(text || '').trim());
    const condition = Goals.scrubSecrets(String(successCondition || '').trim());
    if (title.length < 4 || condition.length < 4) return { ok: false, error: 'enter your goal and an observable success condition' };
    if (state.goals.filter(g => g.status === 'active').length >= GOAL_CAP) return { ok: false, error: 'finish or retire an existing goal before adding another' };
    if (state.goals.length >= 240) return { ok: false, error: 'This device has 240 saved goal chapters. Export your journey before starting a new collection.' };
    const stamp = Math.max(now(), ...state.goals.map(g => (g.createdAt || 0) + 1));
    const g = Goals.makeGoal(title, steps, null, stamp, { userAuthored: true });
    if (!g) return { ok: false, error: 'enter at least one concrete first step' };
    creatingGoal = true;
    // Save the user-authored goal and stable id before the network boundary. A lost response cannot
    // strand the path; the success-condition action retries this id, and sync reconciles an accepted write.
    g.successCondition = condition.slice(0, 500); g.pendingRegistration = true;
    g.focusedAt = Math.max(stamp, ...state.goals.map(g => (g.focusedAt || g.createdAt || 0) + 1));
    g.motivation = cleanNote(options && options.motivation, 500);
    g.constraints = cleanNote(options && options.constraints, 500);
    g.journal = [{ at: stamp, kind: 'started', text: 'Started this goal: ' + title }];
    const idea = options && state.ideas.find(i => i.id === options.ideaId && !i.goalId);
    if (idea) { idea.goalId = g.id; if (idea.learning) g.journal.push({ at: stamp, kind: 'reflection', text: idea.learning }); }
    state.goals.push(g); capHistory(state); save(); pushToSidecar(); poke();
    let r;
    try { r = await JourneyStore.registerGoal({ id: g.id, text: g.text, successCondition: condition }); }
    catch (_) { r = { ok: false }; }
    creatingGoal = false;
    if (r && r.ok) { g.pendingRegistration = false; save(); poke(); return { ...r, goalId: g.id }; }
    return { ok: false, saved: true, goalId: g.id, error: 'goal saved on this device; save its success condition to retry Journey registration' };
  }

  const cleanNote = (text, limit = 1000) => Goals.scrubSecrets(String(text || '').trim()).slice(0, limit);
  function record(g, kind, text) {
    (g.journal || (g.journal = [])).push({ at: now(), kind, text: cleanNote(text) });
    g.updatedAt = now(); save(); pushToSidecar(); poke();
  }
  function setDisposition(id, status, reason) {
    const g = ready() && state.goals.find(g => g.id === id);
    if (!g || !['active', 'paused', 'archived'].includes(g.status) || !['active', 'paused', 'archived'].includes(status) || g.status === status) return false;
    reconcile('');
    if (g.milestones.some(m => m.status === 'open' && questLive(m.questRef))) return false;
    if (status === 'active' && state.goals.filter(g => g.status === 'active').length >= GOAL_CAP) return false;
    g.status = status;
    // Resuming is an explicit choice, independent of an old dossier belief's later retirement.
    if (status === 'active') { g.sourceBeliefId = null; g.focusedAt = Math.max(now(), ...state.goals.map(g => (g.focusedAt || g.createdAt || 0) + 1)); }
    record(g, status === 'active' ? 'resumed' : status, cleanNote(reason) || (status === 'active' ? 'Ready to continue.' : status === 'paused' ? 'Taking a pause.' : 'Keeping this chapter for later.'));
    return true;
  }
  function saveContext(id, motivation, constraints) {
    const g = ready() && state.goals.find(g => g.id === id && ['active', 'paused'].includes(g.status));
    if (!g) return false;
    const why = cleanNote(motivation, 500), limits = cleanNote(constraints, 500);
    if ((g.motivation || '') === why && (g.constraints || '') === limits) return true;
    g.motivation = why; g.constraints = limits;
    record(g, 'context', 'Why it matters: ' + (g.motivation || 'not specified') + '\nConstraints: ' + (g.constraints || 'not specified')); return true;
  }
  function reflect(id, text) {
    const g = ready() && state.goals.find(g => g.id === id);
    if (!g || cleanNote(text).length < 4) return false;
    const last = (g.journal || []).slice(-1)[0];
    if (last && last.kind === 'reflection' && last.text === cleanNote(text) && now() >= last.at && now() - last.at < 5000) return true;
    record(g, 'reflection', text); return true;
  }
  function reviseStep(id, milestoneId, text) {
    const g = ready() && state.goals.find(g => g.id === id && ['active', 'paused'].includes(g.status));
    const m = g && g.milestones.find(m => m.id === milestoneId && m.status === 'open');
    const next = cleanNote(text, 140);
    // Bound work has an immutable objective, even if stalled. Add another step to change that objective.
    if (!m || m.questRef || Goals.lowValue(next) || next === m.text || g.milestones.some(s => s.id !== m.id && s.status === 'open' && s.text.toLowerCase() === next.toLowerCase())) return false;
    const previous = m.text; m.text = next; record(g, 'revised', previous + ' → ' + next); return true;
  }
  function saveIdea(id, text, question, learning) {
    if (!ready()) return false;
    const title = cleanNote(text, 280);
    if (title.length < 4) return false;
    let idea = id && state.ideas.find(i => i.id === id);
    if (id && !idea) return false;
    if (!idea) {
      if (state.ideas.length >= 100) return false;
      const stamp = Math.max(now(), ...state.ideas.map(i => i.createdAt + 1));
      idea = { id: 'idea_' + stamp, createdAt: stamp, goalId: null, archived: false }; state.ideas.push(idea);
    }
    Object.assign(idea, { text: title, question: cleanNote(question, 500), learning: cleanNote(learning) });
    save(); poke(); return idea.id;
  }
  function archiveIdea(id) {
    const idea = ready() && state.ideas.find(i => i.id === id);
    if (!idea) return false;
    idea.archived = !idea.archived; save(); poke(); return true;
  }
  function reviewPrompt(id) {
    const g = ready() && state.goals.find(g => g.id === id);
    if (!g) return '';
    return 'Help me review my goal: ' + g.text + '\nSuccess looks like: ' + g.successCondition
      + '\nSaved chapter status: ' + g.status + (g.outcomeEvidence ? '\nMy reported outcome (not independent verification): ' + g.outcomeEvidence : '\nNo final outcome has been reported.')
      + '\nWhy it matters: ' + (g.motivation || 'not yet specified') + '\nConstraints: ' + (g.constraints || 'not yet specified')
      + '\nPlan:\n' + g.milestones.map(m => '[' + m.status + '] ' + m.text + (m.evidence ? ' — recorded: ' + m.evidence : '')).join('\n')
      + '\nRecent reflections:\n' + (g.journal || []).filter(e => e.kind === 'reflection').slice(-3).map(e => e.text).join('\n')
      + '\nHelp me assess what worked, what is still unverified, and one useful adjustment. Distinguish my reported results from independent verification. Propose changes for me to review; do not change my saved plan.';
  }
  function focusGoal(id) {
    const g = ready() && state.goals.find(g => g.id === id && g.status === 'active');
    if (!g) return false;
    g.focusedAt = Math.max(now(), ...state.goals.map(g => (g.focusedAt || g.createdAt || 0) + 1));
    save(); pushToSidecar(); poke(); return true;
  }

  function chooseNext(goalId, milestoneId) {
    const g = ready() && state.goals.find(g => g.id === goalId);
    if (!Goals.chooseNext(g, milestoneId, now(), questLive)) return false;
    save(); pushToSidecar(); poke(); return true;
  }

  function briefing() { return ready() ? Goals.briefing(state.goals, questLive) : { goal: null, completedGoal: null }; }

  async function confirmOutcome(goalId, evidence) {
    const g = ready() && state.goals.find(g => g.id === goalId && g.status === 'active');
    if (!g || typeof JourneyStore === 'undefined' || !JourneyStore.confirmGoal) return { ok: false, error: 'active goal unavailable' };
    const r = await JourneyStore.confirmGoal({ id: g.id, evidence: String(evidence || '').trim() });
    if (r && r.ok) {
      g.status = 'done'; g.outcomeEvidence = String(evidence || '').trim().slice(0, 1000); g.updatedAt = now();
      save(); pushToSidecar(); poke(); celebrateGoalDone();
    }
    return r;
  }

  async function reportMilestone(goalId, milestoneId, evidence) {
    const g = ready() && state.goals.find(g => g.id === goalId && g.status === 'active');
    const m = g && g.milestones.find(m => m.id === milestoneId && m.status === 'open');
    const note = String(evidence || '').trim();
    if (!m || note.length < 10) return { ok: false, error: 'describe what you did (at least 10 characters)' };
    if (questLive(m.questRef)) return { ok: false, error: 'this step has work in progress; wait for it to finish' };
    if (typeof JourneyStore === 'undefined' || !JourneyStore.noteMilestone) return { ok: false, error: 'journey service unavailable' };
    const r = await JourneyStore.noteMilestone({ goalId: g.id, goalText: g.text, milestoneId: m.id,
      milestoneText: m.text, evidence: note, source: 'commander', agentId: null, goalDone: false });
    if (r && r.ok) {
      Goals.foldMilestoneDone(g, m.id, note, now()); m.source = 'commander'; m.journeySyncedAt = now();
      save(); pushToSidecar(); poke();
    }
    return r;
  }

  function addStep(goalId, text) {
    const g = ready() && state.goals.find(g => g.id === goalId && g.status === 'active');
    const clean = typeof Goals !== 'undefined' ? Goals.scrubSecrets(String(text || '').trim()).slice(0, 140) : '';
    if (!g || Goals.lowValue(clean) || g.milestones.length >= 100) return false;
    if (g.milestones.some(m => m.text.toLowerCase() === clean.toLowerCase() && m.status === 'open')) return false;
    g.milestones.push({ id: g.id + ':m' + (g.milestones.length + 1), text: clean, status: 'open', questRef: null,
      evidence: '', doneAt: null, journeySyncedAt: null });
    g.updatedAt = now(); save(); pushToSidecar(); poke(); return true;
  }

  // after a clean run, re-read WorkQuestStore's projection: any bound milestone whose work quest went DONE folds
  // the step done, writes run-summary evidence, and advances the PLAN bar. This never proves a life outcome.
  // User-performed actions take the separate explicit report path. Fail-open + idempotent.
  function reconcile(runSummary) {
    if (!ready()) return;
    let doneWq = null;
    try {
      if (typeof WorkQuestStore !== 'undefined' && WorkQuestStore.quests) {
        const wq = WorkQuestStore.quests() || [];
        doneWq = {};
        for (const q of wq) if (q && q.id && q.status === 'done') doneWq[String(q.id)] = true;
      }
    } catch (_) { doneWq = null; }
    if (!doneWq) return;
    let changed = false, anyGoalDone = false;
    for (const g of state.goals) {
      if (g.status !== 'active' || !Array.isArray(g.milestones)) continue;
      for (const m of g.milestones) {
        if (!m || m.status !== 'open' || !m.questRef) continue;
        if (!doneWq[String(m.questRef)]) continue;
        const ev = clipEvidence(runSummary, m.text);
        const r = Goals.foldMilestoneDone(g, m.id, ev, now());
        if (r.changed) {
          changed = true; if (r.goalDone) anyGoalDone = true; bumpStudySalience(g, m);
          // Journey progression folds through the durable outbox after this local goal state is saved.
        }
      }
    }
    if (changed) { save(); pushToSidecar(); poke(); queueJourneySync(); }
    if (anyGoalDone) celebrateGoalDone();
  }
  // a goal completing (all milestones done): the whole-arc celebration — sound + a gold toast (a MOMENT, never a
  // beat-slot ask; mirrors queststatestore.celebrate) — plus the suggestion-gate bump (§5). The per-milestone
  // step edges already celebrate via QuestState; this is the capstone for the goal itself.
  function celebrateGoalDone() {
    try { if (typeof SFX === 'object' && SFX.quest) SFX.quest(); } catch (_) {}
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify('◆ goal achieved — your outcome has been recorded.', 'gold'); } catch (_) {}
    noteGoalDone();
  }
  // the evidence line folded onto a completed milestone: prefer a real run summary, else name the milestone.
  function clipEvidence(runSummary, milestoneText) {
    const s = String(runSummary == null ? '' : runSummary).trim();
    if (s) return ('done via: ' + s).slice(0, 160);
    return ('completed: ' + String(milestoneText || '')).slice(0, 160);
  }
  // FEEDBACK LOOP (§5): a milestone completing is a goal-progress note the Tier 1 Study engine can weight. Additive
  // + fail-open — a missing hook is a silent no-op; it never blocks the fold. Uses StudyStore's optional salience
  // hook when present (Tier 1 may or may not expose it), so this store degrades cleanly on an older bundle.
  function bumpStudySalience(goal, milestone) {
    try {
      if (typeof StudyStore !== 'undefined' && typeof StudyStore.noteGoalProgress === 'function') {
        StudyStore.noteGoalProgress({ goalText: goal.text, milestoneText: milestone.text });
      }
    } catch (_) {}
  }
  // a goal completing bumps the suggestion gate too (§5): SuggestStore may fire on goal-progress, not only
  // familiarity growth. Additive OR — a missing hook is a no-op; existing caps/gates are untouched.
  function noteGoalDone() {
    try { if (typeof SuggestStore !== 'undefined' && typeof SuggestStore.noteGoalProgress === 'function') SuggestStore.noteGoalProgress(); } catch (_) {}
  }

  /* ---------- DRIFT: retire a goal whose source belief the Study engine forgot ---------- */
  // if the dossier no longer holds a goal's source belief (a study RETIRE landed), retire the tree. Kept for
  // history, hidden from the active quest log. Only ACTIVE goals retire (a done goal stays a trophy).
  function syncDrift() {
    if (!ready()) return false;
    const liveIds = new Set(goalsBeliefs().map(b => b && b.id ? String(b.id) : '').filter(Boolean));
    let changed = false;
    for (const g of state.goals) {
      if (g.status !== 'active' || g.sourceBeliefId == null) continue;
      if (!liveIds.has(String(g.sourceBeliefId))) { if (Goals.retireBySource(g, g.sourceBeliefId, now())) changed = true; }
    }
    if (changed) { save(); pushToSidecar(); poke(); }
    return changed;
  }

  /* ---------- lifecycle + bus ---------- */
  function onRunEnd(p) {
    if (!ready() || !p) return;
    if (p.reason !== 'done') { return; }             // only a clean run advances the bar / retires on drift
    if ((p.agentId || 'agent') !== 'agent') return;  // hero runs only (a summoned worker never moves the arc)
    // a summary line for the evidence: the ended run's recorded title, if the app injects one.
    let summary = '';
    try { summary = (typeof deps.getRunSummary === 'function') ? String(deps.getRunSummary(p.runId || p.id) || '') : ''; } catch (_) {}
    syncDrift();
    reconcile(summary);
  }
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.run.end', onRunEnd);   // subscription only — NEVER an emit
      bound = true;
    }
  }
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    firing = false; cachedProposal = null; decompFails = {}; journeySyncing.clear();
    bind();
    pushToSidecar();
    queueJourneySync();
  }
  // a brand-new hero starts with no goals (own key; Save.clear only wipes the main envelope — mirrors the siblings).
  function reset() { state = hydrate(null); firing = false; cachedProposal = null; decompFails = {}; journeySyncing.clear(); try { localStorage.removeItem(KEY); } catch (_) {} pushToSidecar(); }

  // re-read on the quest-log heartbeat: retire drift + reconcile completed work before the fold (like the sibling
  // sync()s buildQuests calls). Cheap + idempotent.
  function sync() {
    if (!ready()) return;
    // Recover a successful outcome whose HTTP response or final local save was lost.
    const journey = typeof JourneyStore !== 'undefined' && JourneyStore.status ? JourneyStore.status() : null;
    let changed = false;
    for (const known of (journey && journey.goals || [])) {
      const g = state.goals.find(g => g.id === known.id);
      if (!g || g.status !== 'active') continue;
      if (g.pendingRegistration) { g.pendingRegistration = false; changed = true; }
      if (known.successCondition && g.successCondition !== known.successCondition) { g.successCondition = known.successCondition; changed = true; }
      if (known.status === 'achieved') { g.status = 'done'; g.outcomeEvidence = known.evidence; changed = true; }
    }
    if (changed) { save(); pushToSidecar(); }
    syncDrift(); reconcile(''); queueJourneySync();
  }

  /* ---------- the projection consumed by QuestStore.view ---------- */
  // questLive rides in so an in-flight bound milestone renders IN PROGRESS (no Accept) while a stalled/dismissed/
  // dead binding re-offers Accept (the recovery path) — the render state can never disagree with the accept guard.
  function quests() { return ready() ? Goals.project(state.goals, { questLive }) : []; }
  function activeGoal() { return ready() ? Goals.activeGoal(state.goals) : null; }

  // re-entrancy handle for the confirm flow (chat.js latches it around the focused Dialogue panel).
  function setFiring(v) { firing = !!v; }
  function isFiring() { return firing; }

  return {
    init, reset, sync, quests, activeGoal, unplannedGoal, pushToSidecar,
    willOfferDecomposition, pendingDecomposition, proposeDecomposition, confirm, declineDecomposition, markOffered,
    acceptMilestone, createGoal, focusGoal, chooseNext, briefing, listGoals: () => ready() ? state.goals.slice() : [],
    setDisposition, saveContext, reflect, reviseStep, saveIdea, archiveIdea, reviewPrompt, isCreatingGoal: () => creatingGoal,
    listIdeas: () => ready() ? state.ideas.slice() : [], exportJourney: () => JSON.stringify({ exportedAt: now(), goals: state && state.goals || [], ideas: state && state.ideas || [] }, null, 2),
    reportMilestone, setSuccessCondition, confirmOutcome, addStep, reconcile, syncDrift, setFiring, isFiring, beliefFingerprint, questLive,
    _state: () => state, _onRunEnd: onRunEnd, _syncJourneyMilestones: syncJourneyMilestones
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { GoalStore };
