/* AGENT OS — bottlestore.js : R5 "BOTTLE A RUN" — save what actually worked as a reusable recipe.

   The marketplace grows from real successes: when an INTERACTIVE run went well — the Commander rated the hero's
   work 👍 — and that run was NOT itself launched from a recipe, the station offers, once, to bottle the directive
   as a custom recipe. One tap opens the R2 editor pre-filled with a deterministic proposal (Recipes.mintFromRun);
   nothing auto-saves — the user confirms/edits/saves there. Mirrors the agent-skill sourceRunId "save what worked"
   seam, and the confbeats.js discipline exactly:

     • ONE POST-RUN BEAT AT A TIME — rides Chat.nudge (the shared gentle-aside / gold-inset family). A live run, the
       awakening/intake, a focused Dialogue panel, or an open rate/turn-in control DEFERS the offer (bounded retry,
       confbeats-style); nudge()'s own clearNudge() keeps it from ever stacking with a suggestion/seed/curiosity ask.
     • DECIDED CARD VANISHES — the nudge's choice row removes itself + vanishes the prompt on either pick (COMMS law).
     • DISMISS = STOP FOREVER (memory-overhaul law) — every decided run (bottled OR waved off) latches into a
       persisted per-run denylist so that run is NEVER re-offered, this session or any later one.
     • TRUTHFUL — never offers for a recipe-launched run (it already IS a recipe), a non-task / no-work run, a
       cron/unattended run, or a run with no real directive. Only a 👍 verdict triggers it (👌/👎 never do).
     • NO XP, NO EMIT — a read-only citizen: it mints nothing on trigger and never touches U.bus. Fed by a DIRECT
       call from chat.js rateWork (the 👍/👌/👎 verdict never rides the bus), like confbeats.onFeedback.

   The heavy lifting (name/param derivation) is Recipes.mintFromRun (pure, node-tested). This store is the GATE +
   the beat + the persisted denylist. Its pure halves (shouldOffer / decisions) are node-exported for the test. */
'use strict';
const BottleStore = (() => {
  const KEY = 'starnet.bottle.v1';        // the per-run decision denylist (bottled/dismissed) — self-persisted
  const RETRY_MS = 7000;                  // blocked-offer retry cadence (bounded), cloned from confbeats/away-digest
  const SETTLE_MS = 900;                  // let the rate control vanish before the offer slots in (confbeats SETTLE)
  const MAX_DECIDED = 200;               // cap the persisted ledger (FIFO) so a long-lived station can't grow it forever
  let state = null;                       // { v:1, decided: { [runId]: 'bottled'|'dismissed' } }
  let deps = {};                          // { openEditor(proposal), runInfo(runId) } injected by app.js
  let wired = false;

  const LINE = '✦ that one worked. bottle it as a recipe? — i’ll pre-fill the editor from what you just had me do; you confirm and save.';

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  function hydrate(raw) {
    const s = { v: 1, decided: {} };
    if (raw && typeof raw === 'object' && raw.decided && typeof raw.decided === 'object') {
      for (const k of Object.keys(raw.decided)) {
        const val = raw.decided[k];
        if (val === 'bottled' || val === 'dismissed') s.decided[k] = val;
      }
    }
    return s;
  }

  // PURE gate: given the fire-once ledger, a verdict, and the run's honest info, may we offer to bottle THIS run?
  // Truthful + fire-once: only a 👍 ('great') verdict, only a real interactive TASK run that did work, never a
  // recipe-launched run, never a cron/unattended run, never one already decided. Exported for the test.
  //   info = { isTask, fromRecipe, cron, directive, didWork }
  function shouldOffer(s, verdict, info) {
    if (!s || !info) return false;
    if (verdict !== 'great') return false;                 // only 👍 — 👌/👎 never bottle
    if (info.fromRecipe) return false;                     // it already IS a recipe — never re-bottle a recipe launch
    if (info.cron) return false;                           // cron/unattended runs are never offered (truthful law 5)
    if (!info.isTask) return false;                        // pure chat did no real work — nothing to bottle
    if (!info.didWork) return false;                       // a task that produced no real tool-work / deliverable
    if (!String(info.directive || '').trim()) return false;// no real directive → nothing honest to template
    return true;
  }
  // has this run already been decided (bottled or dismissed)? A decided run NEVER re-offers. Exported for the test.
  function isDecided(s, runId) { return !!(s && runId && s.decided && s.decided[runId]); }
  // latch a decision for a run (persisted). FIFO-caps the ledger. Exported for the test.
  function latch(s, runId, decision) {
    if (!s || !runId) return s;
    if (!s.decided) s.decided = {};
    s.decided[runId] = decision;
    const keys = Object.keys(s.decided);
    if (keys.length > MAX_DECIDED) delete s.decided[keys[0]];   // drop the oldest (insertion order)
    return s;
  }

  // is a rate/turn-in control (or another gentle beat) live in the feed? One ask at a time — the offer defers
  // behind it. Mirrors confbeats.rateLive() + the wider post-run slot guards.
  function slotBusy() {
    const blocked = (typeof Chat === 'undefined' || !Chat.nudge)
      || (Chat.isBusy && Chat.isBusy())
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) return true;
    try {
      const log = (typeof document !== 'undefined') ? document.getElementById('chat-log') : null;
      if (log && log.querySelector('.cmsg.work-rate, .turnin-rate, .turnin-item')) return true;   // a rate/turn-in control is live
    } catch (_) {}
    return false;
  }

  // one bounded attempt at speaking the offer for `runId` (carrying its directive). A blocked moment retries
  // (the offer can be DELAYED; if the slot never frees it quietly expires — it asks for nothing, like a pride notice).
  function attempt(runId, directive, tries) {
    if (!state || !runId) return;
    if (isDecided(state, runId)) return;                   // decided while we waited (dismiss-once) → drop
    if (slotBusy()) { if (tries > 0) setTimeout(() => attempt(runId, directive, tries - 1), RETRY_MS); return; }
    try {
      Chat.nudge(LINE, [
        { label: 'bottle it', value: 'bottle' },
        { label: 'not this one', value: 'dismiss', skip: true }
      ], item => {
        if (!item || item.value === 'dismiss') { latch(state, runId, 'dismissed'); save(); return; }   // wave-off → stop forever
        // BOTTLE IT: latch (so it never re-offers), then open the R2 editor pre-filled from the run's directive.
        // Nothing auto-saves — the user confirms/edits/saves in the editor.
        latch(state, runId, 'bottled'); save();
        try {
          const proposal = (typeof Recipes !== 'undefined' && Recipes.mintFromRun)
            ? Recipes.mintFromRun(directive, { runId: runId }) : null;
          if (proposal && deps.openEditor) deps.openEditor(proposal);
        } catch (_) {}
      });
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // the soft notice chime (shared with ideas)
    } catch (_) {}
  }

  // a real 👍/👌/👎 work verdict on the HERO's run landed (the DIRECT hand-off from chat.js rateWork — this verdict
  // never rides the bus). Gate on shouldOffer off the run's HONEST info, then — deferred past the rate control's
  // vanish — offer at most once. runInfo(runId) supplies { isTask, fromRecipe, cron, directive, didWork }.
  function onVerdict(runId, verdict, agentId) {
    if (!state || !runId) return;
    if ((agentId || 'agent') !== 'agent') return;          // hero-only: the bottle offer is about the hero's own work
    if (isDecided(state, runId)) return;                   // already bottled/dismissed → never again
    const info = deps.runInfo ? deps.runInfo(runId) : null;
    if (!shouldOffer(state, verdict, info)) return;
    setTimeout(() => {
      if (isDecided(state, runId)) return;                 // re-check after the settle (a concurrent decision wins)
      attempt(runId, info.directive, 25);
    }, SETTLE_MS);
  }

  // opts: { openEditor(proposal), runInfo(runId) } — app.js supplies both (openEditor opens the R2 editor
  // pre-filled; runInfo reads chat.js's RUN_META for the run's honest task/recipe/cron/directive/work facts).
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    wired = true;
  }

  // S2/new-hero: a fresh station re-earns every bottle offer. Own key (like confbeats.reset()).
  function reset() { state = hydrate(null); try { localStorage.removeItem(KEY); } catch (_) {} }

  // onVerdict is public: chat.js rateWork hands its direct (never-on-the-bus) verdict here.
  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onVerdict, shouldOffer, isDecided, latch, LINE, _state: () => state, _hydrate: hydrate, _wired: () => wired };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { BottleStore };
