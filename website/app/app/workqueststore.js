/* STARNET — workqueststore.js : the live wiring around the pure WorkQuests engine (G1c).

   Turns an ACCEPTED idea into a trackable multi-step build. It owns what the pure engine can't:
     • the MINT — pitchstore/suggeststore call WorkQuestStore.accept(parsed, ctx) the instant the Commander hits
       "build it". For a recipe with still-missing required params, the store resolves the live gap list
       (Recipes.requiredMissing) so each becomes a real step; a runnable recipe / workflow build gets the single
       run-completion step. If the accepted idea is SEEDBORN, it carries G3a's SeedCredit line onto the card.
     • the RUN BINDING — a "build it" kicks off a fresh hero run (launchRecipe / launchDirective → Chat.send).
       The launched run has no synchronously-returned id, so the store claims the NEXT hero agent.run.start
       after an accept as the build's run (a short arming window). On that start it ticks every gap step (the
       build genuinely launched, gaps folded into the directive) and binds the runId; on the run's clean end it
       completes the final step → the quest goes DONE, riding QuestState's gold celebration. Honest completion:
       the build actually ran — no claim button.

   Self-persists to its own localStorage key (rides the backup prefix, like stationqueststore — no save.js
   change). The projection (quests()) is joined into QuestStore.view. NOTHING MINTS XP (the xp.js law): the
   payout is the real build + the shared celebration; XP still flows only from rating the finished work. NEVER
   emits on U.bus (subscription only). */
'use strict';
const WorkQuestStore = (() => {
  const KEY = 'starnet.workquests.v1';
  const ARM_MS = 8000;   // after an accept, the next hero run.start within this window IS the build's run
  let state = null;
  let bound = false;
  let armedId = null, armedAt = 0;   // the freshly-minted quest awaiting its launched run (id + accept time)

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof WorkQuests !== 'undefined' && state;

  // W6 DEDUP: a normalized-title fingerprint (lowercase, alnum tokens >=3 chars, sorted+unique) so an accept for
  // a build already in flight returns the EXISTING quest instead of minting a second identical card. Mirrors the
  // mint-ledger/suggeststore fingerprint. Only LIVE quests count (a completed/dismissed/stalled one may re-mint).
  function titleFp(s) {
    const toks = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    return Array.from(new Set(toks)).sort().join(' ');
  }
  function liveQuestByTitle(title) {
    const fp = titleFp(title);
    if (!fp || !state || !state.quests) return null;
    for (const id of Object.keys(state.quests)) {
      const q = state.quests[id];
      if (!q || q.completedAt != null || q.dismissedAt != null || q.stalledAt != null) continue;
      if (titleFp(q.title) === fp) return id;
    }
    return null;
  }
  const nowMs = () => (typeof Date !== 'undefined' ? Date.now() : 0);
  function poke() { try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); } catch (_) {} }

  /* ---------- the MINT: an accepted idea → a trackable build ----------
     parsed = the Pitch.parsePitch object ({ title, build:{ kind, recipeId } , gap }). ctx (optional) = {}. The
     store resolves the live gap list + the seed credit; the pure engine shapes the steps. */
  function accept(parsed) {
    if (!ready() || !parsed) return null;
    // W6: an identical build is already in flight → return the EXISTING quest, don't mint a duplicate card. Re-arm
    // it so the next launched run still binds (an accept is still a "build it now" intent), but no second quest.
    const dupId = liveQuestByTitle(parsed.title);
    if (dupId) { armedId = dupId; armedAt = nowMs(); return dupId; }
    const b = parsed.build || {};
    let recipeId = null, gaps = [];
    if (b.kind === 'recipe' && b.recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
      const r = Recipes.get(b.recipeId);
      if (r) {
        recipeId = r.id;
        // the still-missing REQUIRED params (nothing filled yet) → one step each. requiredMissing returns keys;
        // pair each with its human label from the recipe's param form so the step reads plainly.
        try {
          const missing = (typeof Recipes.requiredMissing === 'function') ? Recipes.requiredMissing(r, {}) : [];
          const byKey = {}; for (const p of (r.params || [])) byKey[p.key] = p;
          gaps = (missing || []).map(k => ({ key: k, label: 'fill: ' + ((byKey[k] && byKey[k].label) || k) }));
        } catch (_) { gaps = []; }
      }
    }
    // G3a seed callout: an accepted idea reusing a Commander-saved seed credits it on the card (a credit line).
    let credit = '';
    try {
      if (typeof SeedCredit !== 'undefined' && recipeId && typeof Recipes !== 'undefined' && Recipes.get) {
        const c = SeedCredit.creditForRecipe(Recipes.get(recipeId));
        if (c) credit = c;
      }
    } catch (_) {}
    const id = WorkQuests.mint(state, { title: parsed.title, recipeId, gaps, credit }, nowMs());
    if (id) { armedId = id; armedAt = nowMs(); save(); poke(); }
    return id;
  }

  /* ---------- the RUN BINDING: claim the launched run, tick the steps ---------- */
  function onRunStart(p) {
    if (!ready() || !p) return;
    if ((p.agentId || 'agent') !== 'agent') return;              // only the hero's own build run
    if (!armedId || (nowMs() - armedAt) > ARM_MS) { armedId = null; return; }
    const id = armedId; armedId = null;
    if (!p.runId) return;
    // the build genuinely launched → tick every gap step (the gaps were folded into the launch directive) and
    // bind the runId so run.end can complete the final step.
    const q = state.quests[id];
    if (q && Array.isArray(q.steps)) {
      for (const st of q.steps) { if (st.key.indexOf('gap:') === 0) WorkQuests.tickStep(state, id, st.key, nowMs()); }
    }
    WorkQuests.bindRun(state, id, p.runId);
    save(); poke();
  }
  // a terminal reason other than 'done' means the bound run ended without finishing. The honest reasons the
  // sidecar emits (slaglog.js / runstore REASONS): error | budget | max_iters | refusal are FAILURES; the
  // build stalled. 'cancelled' is a deliberate human stop — resolve it too, but quietly (never nag).
  const STALL_REASONS = { error: 1, budget: 1, max_iters: 1, refusal: 1 };
  // a bound build run's own error text (agent.run.error lands before its run.end), so the stalled beat can name a KNOWN
  // cause — a refused StarNet link, an empty wallet, a model the key can't use — instead of "send it again, report it".
  const runErrText = new Map();   // runId -> message; only for runs a build is bound to, read (and dropped) at that run's end
  function onRunError(p) {
    if (!ready() || !p || !p.runId || !WorkQuests.questForRun(state, p.runId)) return;
    runErrText.set(p.runId, String(p.message || ''));
    if (runErrText.size > 64) runErrText.delete(runErrText.keys().next().value);
  }
  function onRunEnd(p) {
    if (!ready() || !p) return;
    const errText = p.runId ? runErrText.get(p.runId) : undefined;
    if (p.runId) runErrText.delete(p.runId);
    const id = WorkQuests.questForRun(state, p.runId);
    if (!id) return;                                              // no bound build for this run — nothing to do
    if (p.reason === 'done') {
      // complete every remaining open step ('launch' + 'run') → the quest flips DONE (QuestState celebrates).
      const q = state.quests[id];
      let changed = false;
      if (q && Array.isArray(q.steps)) for (const st of q.steps) { if (!st.done && WorkQuests.tickStep(state, id, st.key, nowMs())) changed = true; }
      if (changed) { save(); poke(); }
      return;
    }
    // NON-done terminal end → resolve the bound quest so it never orphans open with zero feedback. Mark it
    // STALLED (never mark steps complete — the honesty law) and release the run binding so a fresh "build it"
    // re-runs it clean. A failure surfaces ONE honest, neutral beat naming the reason (the warn family — never
    // the gold celebration). A human 'cancelled' resolves silently (a deliberate stop must not nag).
    const q = state.quests[id];
    if (!q || q.completedAt != null || q.dismissedAt != null || q.stalledAt != null) return;
    if (!WorkQuests.stall(state, id, p.reason, nowMs())) return;
    save(); poke();
    if (STALL_REASONS[p.reason]) stallBeat(p.reason, q.title, errText);
  }

  // the one honest, player-facing beat for a stalled build — reuses SlagLog's real post-mortem copy (title +
  // fix), routed through the SHARED StationUI.notify toast in the neutral WARN family (no gold, no new toast
  // system). Falls back to a plain reason line if SlagLog isn't loaded. An errored run's own message is classified
  // exactly as world.js classifies it for the SLAG post-mortem (Friendly kind + message), so both say the same door.
  function stallBeat(reason, title, errText) {
    let msg;
    try {
      let error = null;
      if (reason === 'error' && errText && typeof Friendly !== 'undefined' && Friendly.friendlyError) {
        try { const v = Friendly.friendlyError(new Error(errText)); error = v ? { kind: v.kind, msg: v.userMessage } : null; } catch (_) { error = null; }
      }
      const d = (typeof SlagLog !== 'undefined' && SlagLog.diagnose) ? SlagLog.diagnose(reason, { error }) : null;
      if (d) msg = 'build “' + (title || 'a build') + '” ' + d.title + ' — ' + d.fix;
    } catch (_) {}
    if (!msg) msg = 'build “' + (title || 'a build') + '” stopped (' + reason + ') — adjust and re-run.';
    try { if (typeof StationUI !== 'undefined' && StationUI.notify) StationUI.notify(msg, 'warn'); } catch (_) {}
  }

  // sync() is a no-op resolver (work quests advance on the run bus events, not a re-read) — kept for the shared
  // buildQuests heartbeat symmetry, and it lets a stale arm expire cheaply.
  function sync() {
    if (!ready()) return;
    if (armedId && (nowMs() - armedAt) > ARM_MS) armedId = null;
  }

  /* ---------- the projection consumed by QuestStore.view ---------- */
  function quests() { return ready() ? WorkQuests.project(state) : []; }
  function openCount() { return ready() ? WorkQuests.openCount(state) : 0; }

  function dismiss(id) {
    if (!ready() || !id) return false;
    const ok = WorkQuests.dismiss(state, id, nowMs());
    if (ok) { if (armedId === id) armedId = null; save(); }
    return ok;
  }
  const isDismissed = id => ready() ? WorkQuests.isDismissed(state, id) : false;

  /* ---------- lifecycle ---------- */
  function bind() {
    if (bound) return;
    if (typeof U !== 'undefined' && U.bus && U.bus.on) {
      U.bus.on('agent.run.start', onRunStart);   // subscription only — NEVER an emit (the frozen contract stands)
      U.bus.on('agent.run.error', onRunError);
      U.bus.on('agent.run.end', onRunEnd);
      bound = true;
    }
  }
  function init() {
    state = (typeof WorkQuests !== 'undefined') ? WorkQuests.hydrate(load()) : null;
    armedId = null; armedAt = 0;
    bind();
  }
  function reset() { state = null; armedId = null; armedAt = 0; runErrText.clear(); try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, sync, accept, quests, openCount, dismiss, isDismissed, reset,
    _onRunStart: onRunStart, _onRunEnd: onRunEnd, _armed: () => armedId };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { WorkQuestStore };
