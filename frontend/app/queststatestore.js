/* AGENT OS — queststatestore.js : the live wiring around the pure queststate.js engine — the quest log's
   durable memory + the completion celebration.

   Self-persists to its own localStorage key (rides the backup prefix, like curiositystore/mintstore — no
   save.js change). sync() is the heartbeat (driven by the station's existing 1s tick + every quest-log
   render): it re-reads the honest projection (QuestStore.view), folds it through the engine, and on every
   open→done edge fires the celebration — the quest sting (SFX.quest), ONE gold StationUI.notify toast
   ('⚑ quest complete — …'), and a brief gold flourish on that quest's row in the QUEST LOG panel.

   Celebration is a MOMENT, not a lingering ask (the COMMS beat rules): nothing queues, nothing waits for
   a click, no post-run beat slot is touched — and NOTHING MINTS XP. Leveling stays locked to user
   feedback on real built work (xp.js law); a quest completing pays out sound + toast + flourish only.

   NEVER emits on U.bus (the frozen shared/events.js contract is owned elsewhere): celebration is a direct
   call into SFX/StationUI, so the lint-emits gate has nothing to catch. */
'use strict';
const QuestStateStore = (() => {
  const KEY = 'starnet.queststate.v1';
  const FLOURISH_MS = 2500;   // the row's gold flash window — a moment, not a state
  let state = null;
  let flourish = {};          // quest id -> celebration deadline (ms). In-memory only: the flash never persists.

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }
  const ready = () => typeof QuestState !== 'undefined' && state;

  // hydrate + take the FIRST fold as the baseline: on a resumed pre-G1a save every already-earned quest is
  // backfilled quietly (the engine never celebrates first sight), so loading the app can't fire a storm.
  function init() {
    state = (typeof QuestState !== 'undefined') ? QuestState.hydrate(load()) : null;
    flourish = {};
    sync();
  }

  function projection() {
    try {
      const v = (typeof QuestStore !== 'undefined' && QuestStore.view) ? QuestStore.view() : null;
      return (v && Array.isArray(v.quests)) ? v.quests : [];
    } catch (_) { return []; }
  }

  // diff the live projection against the durable memory; celebrate each real open→done edge exactly once.
  function sync() {
    if (!ready()) return [];
    const r = QuestState.fold(state, projection(), Date.now());
    if (r.completions.length) {
      save();   // completedAt is durable the instant it happens (the future trophy case reads it)
      for (const c of r.completions) celebrate(c);
    }
    return r.completions;
  }

  // sound + flourish + COMMS line. Direct calls only — no bus, no beat slot, no XP. NO StationUI.notify
  // (notification diet, 2026-08-18): the sting + gold row flash + broadcast carry the moment; the bell doesn't.
  function celebrate(q) {
    flourish[q.id] = Date.now() + FLOURISH_MS;
    // A MILESTONE quest is the trophy of the same name (quests.js 'ms:<id>'): the trophy already stung and announced
    // it, so the quest only flashes in its log (first-hour walk 2026-09-28: QUEST COMPLETE ×3 repeated TROPHY EARNED ×3).
    const mirrorsTrophy = q && (q.kind === 'milestone' || /^ms:/.test(String(q.id || '')));
    if (!mirrorsTrophy) { try { if (typeof SFX === 'object' && SFX.quest) SFX.quest(); } catch (_) {} }
    if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false);   // if the log is open, the row flashes gold NOW (rerender is a no-op when closed)
    if (mirrorsTrophy) return;
    // COMMS: the terse quest-complete broadcast — an ambient system line, not a beat-slot card (coalesced +
    // in-game-gated inside Chat.broadcast, so it never competes with the post-run ask chain).
    if (typeof Chat !== 'undefined' && Chat.broadcast) {
      const t = String(q.title || q.id || '').toUpperCase();
      try { Chat.broadcast('QUEST COMPLETE · ' + t, { highlight: t }); } catch (_) {}
    }
  }

  // wave a quest off forever (only dismissible kinds take — the engine decides). The anti-nag law is ONE
  // law: dismissing a get-to-know-you quest also stops the curiosity nudge for that dimension — the quest
  // log and the gentle question must never disagree about "stop asking".
  function dismiss(quest) {
    if (!ready() || !quest) return false;
    const ok = QuestState.dismiss(state, quest, Date.now());
    if (ok) {
      save();
      delete flourish[quest.id];
      if (quest.kind === 'dossier' && String(quest.id).indexOf('dim:') === 0
        && typeof CuriosityStore !== 'undefined' && CuriosityStore.markDismissed) {
        try { CuriosityStore.markDismissed(String(quest.id).slice(4)); } catch (_) {}
      }
    }
    return ok;
  }

  // ---- read surface (the QUEST LOG panel consumes these) ----
  const visible = quests => ready() ? QuestState.visible(state, quests) : (Array.isArray(quests) ? quests : []);
  const dismissible = q => (typeof QuestState !== 'undefined') ? QuestState.dismissible(q) : false;
  const isDismissed = id => ready() ? QuestState.isDismissed(state, id) : false;
  const isCelebrating = id => (flourish[id] || 0) > Date.now();
  const stateOf = id => ready() ? QuestState.stateOf(state, id) : null;

  // a NEW AGENT starts with no quest history (own key — Save.clear() only wipes starnet.save; mirrors
  // CuriosityStore.reset). The next init() hydrates clean.
  function reset() { state = null; flourish = {}; try { localStorage.removeItem(KEY); } catch (_) {} }

  return { init, sync, dismiss, visible, dismissible, isDismissed, isCelebrating, stateOf, reset };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestStateStore };
