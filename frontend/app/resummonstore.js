/* AGENT OS — resummonstore.js : P3.1 "RUN THIS AGAIN?" — the re-summon signal.

   Retention fast-follow: right after the Commander rated the hero's work 👍 on a real interactive run, the station
   offers ONCE, lightly, to run that same shape of work again — tied to the SAME agent and the run's directive. One
   tap PRE-FILLS a fresh run (selects that agent's stream + seeds the composer with the directive) and NEVER auto-runs
   it: the Commander edits and sends. It is not a new unearned suggestion surface — it rides a run the Commander just
   rated, so the work-earned floor is already satisfied.

   It is a READ-ONLY citizen modelled exactly on bottlestore.js (the R5 "bottle it?" offer):

     • ONE POST-RUN BEAT AT A TIME — rides Chat.nudge (the shared gold-inset gentle-aside family). A live run, the
       awakening/intake, a focused Dialogue panel, or an open rate/turn-in control DEFERS the offer (bounded retry,
       bottlestore-style); nudge()'s own clearNudge() keeps it from ever stacking with a suggestion/seed/curiosity ask.
       It LOSES the slot gracefully — if the moment never frees, it quietly expires (asks for nothing).
     • DECIDED CARD VANISHES — the nudge's choice row removes itself on either pick (COMMS law).
     • DISMISS = STOP FOREVER (memory-overhaul law) — every decided run (re-summoned OR waved off) latches into a
       persisted per-run denylist so that run is NEVER re-offered, this session or any later one.
     • TRUTHFUL — only a 👍 ('great') verdict triggers it (👌/👎 never do); only a real interactive TASK run that did
       work, with a real directive; never a cron/unattended run. Hero-only.
     • NO XP, NO EMIT — a read-only citizen: it mints nothing and never touches U.bus. Fed by a DIRECT call from
       chat.js rateWork (the 👍/👌/👎 verdict never rides the bus), like bottlestore/confbeats.

   The GATE + the beat + the persisted denylist live here (its pure halves are node-exported for the test); the actual
   pre-fill (select agent + seed composer) is deps injected by app.js. */
'use strict';
const ResummonStore = (() => {
  const KEY = 'starnet.resummon.v1';      // the per-run decision denylist (re-summoned/dismissed) — self-persisted
  const RETRY_MS = 7000;                  // blocked-offer retry cadence (bounded), cloned from bottlestore/away-digest
  const SETTLE_MS = 900;                  // let the rate control vanish before the offer slots in (bottlestore SETTLE)
  const MAX_DECIDED = 200;                // cap the persisted ledger (FIFO) so a long-lived station can't grow it forever
  let state = null;                       // { v:1, decided: { [runId]: 'again'|'dismissed' } }
  let deps = {};                          // { runInfo(runId), prefillRun({agentId, directive}) } injected by app.js
  let wired = false;

  function load() { try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
  function save() { try { if (state) localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} }

  function hydrate(raw) {
    const s = { v: 1, decided: {} };
    if (raw && typeof raw === 'object' && raw.decided && typeof raw.decided === 'object') {
      for (const k of Object.keys(raw.decided)) {
        const val = raw.decided[k];
        if (val === 'again' || val === 'dismissed') s.decided[k] = val;
      }
    }
    return s;
  }

  // PURE gate: given the fire-once ledger, a verdict, and the run's honest info, may we offer to re-run THIS run?
  // Truthful + fire-once: only a 👍 ('great') verdict, only a real interactive TASK run that did work, never a
  // cron/unattended run, never one already decided, and only with a real directive to seed. Exported for the test.
  //   info = { isTask, cron, directive, didWork }
  function shouldOffer(s, verdict, info) {
    if (!s || !info) return false;
    if (verdict !== 'great') return false;                 // only 👍 — 👌/👎 never re-offer
    if (info.cron) return false;                           // cron/unattended runs are never offered (truthful)
    if (!info.isTask) return false;                        // pure chat did no real work — nothing to re-run
    if (!info.didWork) return false;                       // a task that produced no real tool-work / deliverable
    if (!String(info.directive || '').trim()) return false;// no real directive → nothing honest to pre-fill
    return true;
  }
  // has this run already been decided (re-summoned or dismissed)? A decided run NEVER re-offers. Exported for the test.
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
  // behind it. Mirrors bottlestore.slotBusy() + the wider post-run slot guards. Losing the slot here = the offer
  // retries (transient) or quietly expires — it never STACKS a second beat on a live one.
  function slotBusy() {
    const blocked = (typeof Chat === 'undefined' || !Chat.nudge)
      || (Chat.isBusy && Chat.isBusy())
      || (typeof Onboarding !== 'undefined' && Onboarding.isRunning && Onboarding.isRunning())
      || (typeof Intake !== 'undefined' && Intake.isRunning && Intake.isRunning())
      || (typeof Dialogue !== 'undefined' && Dialogue.isOpen && Dialogue.isOpen());
    if (blocked) return true;
    try {
      const log = (typeof document !== 'undefined') ? document.getElementById('chat-log') : null;
      // a rate/turn-in control OR any live gentle nudge (.cmsg.nudge — a suggestion/seed/curiosity/bottle beat) holds
      // the one slot → defer behind it, never stack (COMMS "one post-run beat at a time").
      if (log && log.querySelector('.cmsg.work-rate, .turnin-rate, .turnin-item, .cmsg.nudge')) return true;
    } catch (_) {}
    return false;
  }

  // one bounded attempt at speaking the offer for `runId` (carrying its agent + directive). A blocked moment retries
  // (the offer can be DELAYED; if the slot never frees it quietly expires — it asks for nothing, like a pride notice).
  function attempt(runId, info, tries) {
    if (!state || !runId) return;
    if (isDecided(state, runId)) return;                   // decided while we waited (dismiss-once) → drop
    if (slotBusy()) { if (tries > 0) setTimeout(() => attempt(runId, info, tries - 1), RETRY_MS); return; }
    const who = String(info.agentName || info.agentId || 'that agent');
    const line = '↻ that one landed. run it again' + (who && who !== 'agent' ? ' with ' + who : '') + '? — i’ll pre-fill it so you can tweak and send; nothing runs until you do.';
    try {
      Chat.nudge(line, [
        { label: 'run it again', value: 'again' },
        { label: 'not now', value: 'dismiss', skip: true }
      ], item => {
        if (!item || item.value === 'dismiss') { latch(state, runId, 'dismissed'); save(); return; }   // wave-off → stop forever
        // RUN IT AGAIN: latch (so it never re-offers), then PRE-FILL a fresh run — select the run's agent + seed the
        // composer with its directive. Nothing auto-sends: the Commander edits and hits send. Pre-fill is deps-injected.
        latch(state, runId, 'again'); save();
        try { if (deps.prefillRun) deps.prefillRun({ agentId: info.agentId || 'agent', directive: info.directive || '' }); } catch (_) {}
      });
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }   // the soft notice chime (shared with ideas)
    } catch (_) {}
  }

  // a real 👍/👌/👎 work verdict on the HERO's run landed (the DIRECT hand-off from chat.js rateWork — this verdict
  // never rides the bus). Gate on shouldOffer off the run's HONEST info, then — deferred past the rate control's
  // vanish — offer at most once. runInfo(runId) supplies { isTask, cron, directive, didWork, agentId, agentName }.
  function onVerdict(runId, verdict, agentId) {
    if (!state || !runId) return;
    if ((agentId || 'agent') !== 'agent') return;          // hero-only: the re-summon beat is about the hero's own run
    if (isDecided(state, runId)) return;                   // already decided → never again
    const info = deps.runInfo ? deps.runInfo(runId) : null;
    if (!shouldOffer(state, verdict, info)) return;
    setTimeout(() => {
      if (isDecided(state, runId)) return;                 // re-check after the settle (a concurrent decision wins)
      attempt(runId, info, 25);
    }, SETTLE_MS);
  }

  // opts: { runInfo(runId), prefillRun({agentId, directive}) } — app.js supplies both (runInfo reads chat.js's
  // RUN_META for the run's honest task/cron/directive/agent facts + Chat.runDidWork; prefillRun selects the agent's
  // stream via App.selectAgent then seeds the composer via Chat.prefill — never auto-running).
  function init(opts) {
    deps = opts || {};
    state = hydrate(load());
    wired = true;
  }

  // S2/new-hero: a fresh station re-earns every re-summon offer. Own key (like bottlestore.reset()).
  function reset() { state = hydrate(null); try { localStorage.removeItem(KEY); } catch (_) {} }

  // onVerdict is public: chat.js rateWork hands its direct (never-on-the-bus) verdict here.
  // _-prefixed handles are for the deterministic node test (harmless in the browser).
  return { init, reset, onVerdict, shouldOffer, isDecided, latch, _state: () => state, _hydrate: hydrate, _wired: () => wired };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { ResummonStore };
