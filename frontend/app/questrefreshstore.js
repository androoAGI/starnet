/* AGENT OS — questrefreshstore.js : the QUEST V3 standing-refresh engine's frontend citizen.

   The sidecar owns a standing quest-refresh engine (sidecar/questrefresh.js + the ambient half in
   sidecar/index.js): every 24h (and on the caught-up fast path) it re-derives the Commander's NORTH STAR
   and mints step-quests toward it, recording an honest ledger of every attempt (minted / rejected: why /
   skipped: why). Two routes expose it:
     • GET  /api/quests/refresh      → { northStar, lastCycleAt, dueAt, due, why, binding, inFlight, ledger }
     • POST /api/quests/refresh/run  → force a cycle NOW ({ started:true } or the honest reason why not)

   Until this store nothing in the frontend called EITHER route — the north star, the "what the refresher
   tried and why" ledger, and the manual refresh were invisible. This thin live store is their browser-side
   read+write surface. It POLLS the status route on the station's tick cadence — THROTTLED (a real network
   fetch at most every POLL_MS, and immediately after a run) so the tick never floods the sidecar — and
   caches the last-good status, so a fetch failure keeps the previous view (the truthful-degradation idiom
   every sibling store uses: workshopstore / questledgerstore).

   Truthful telemetry: every field the panel shows is real engine state read off this cache — nothing is
   synthesized. NO U.bus emits (the frozen shared/events.js contract is owned elsewhere). node-exportable. */
'use strict';
const QuestRefreshStore = (() => {
  const POLL_MS = 6000;         // throttle: a live /api/quests/refresh fetch at most this often (24h engine — no need to poll hard)
  let cache = null;             // last-good status object (null until the first successful fetch)
  let lastFetch = 0;            // ms of the last SUCCESSFUL fetch (0 = force next sync to fetch)
  let inflight = false;         // one fetch at a time — a slow response never stacks
  let running = false;          // a manual run POST is in flight (button guard, distinct from the engine's own inFlight)
  const beaten = new Set();     // normalized proposed-star texts we've already surfaced a confirm beat for (anti-nag, session-local)
  const nrm = t => String(t == null ? '' : t).toLowerCase().replace(/\s+/g, ' ').trim();

  // shape the status JSON into a stable read shape, guarding every field so a junk/partial payload degrades
  // to a safe view rather than throwing (fail-soft, like the sibling stores' normalizers).
  function shape(j) {
    if (!j || typeof j !== 'object') return null;
    const ns = (j.northStar && typeof j.northStar === 'object' && String(j.northStar.text || '').trim())
      ? {
          text: String(j.northStar.text).trim(),
          groundedIn: String(j.northStar.groundedIn || ''),
          at: Number(j.northStar.at) || 0,
          source: j.northStar.source === 'goal' ? 'goal' : 'model',
          status: j.northStar.status === 'proposed' ? 'proposed' : 'adopted'
        }
      : null;
    const ledger = Array.isArray(j.ledger) ? j.ledger.filter(e => e && typeof e === 'object').map(e => ({
      at: Number(e.at) || 0,
      outcome: String(e.outcome || ''),
      reason: String(e.reason || ''),
      title: String(e.title || '')
    })) : [];
    return {
      enabled: j.enabled !== false,
      northStar: ns,
      lastCycleAt: Number(j.lastCycleAt) || 0,
      dueAt: Number(j.dueAt) || 0,
      due: !!j.due,
      why: j.why || null,
      binding: j.binding || null,
      inFlight: !!j.inFlight,
      openCount: Number(j.openCount) || 0,
      ledger: ledger
    };
  }

  async function refetch() {
    if (inflight) return;
    inflight = true;
    try {
      const res = await fetch('/api/quests/refresh', { cache: 'no-store' });   // hardened window.fetch attaches the apiauth token
      if (res.ok) {
        const j = await res.json().catch(() => null);
        const s = shape(j);
        if (s) { cache = s; lastFetch = Date.now(); maybeBeat(); }
      }
    } catch (_) { /* fail-soft: keep the last-good cache, never blank the panel */ }
    finally { inflight = false; }
  }

  // surface a PROPOSED (inferred, unconfirmed) north star as ONE COMMS turn-in beat — "your north star looks
  // like: X — confirm or correct?" (the NS-6 turn-in idiom). One beat per distinct proposal for the session
  // (anti-nag); guarded so a live post-run beat is never interrupted (falls back to an ambient broadcast line).
  // The inline confirm/decline in the DIRECTION card is the primary surface; this beat is the glance to it.
  function maybeBeat() {
    if (typeof Chat === 'undefined') return;
    const ns = cache && cache.northStar;
    if (!ns || ns.status !== 'proposed' || !ns.text) return;
    const key = nrm(ns.text);
    if (!key || beaten.has(key)) return;
    beaten.add(key);
    // the moment is claimed when a run is live OR any ask beat / unanswered task question holds the COMMS slot
    // (Chat.beatBusy) — stacking this confirm over a pending clarifying question read as "popup after popup"
    // and its choices() wiped the question's own answer chips (live-caught 2026-07-19). Blocked → ambient line.
    const busy = ((typeof Chat.isBusy === 'function') ? Chat.isBusy() : false)
      || ((typeof Chat.beatBusy === 'function') ? Chat.beatBusy() : false)
      // the SHARED session ask budget (one-memory lane): this confirm is a proactive consent ask, so a spent
      // budget routes it to the SAME ambient fallback a busy moment does — the DIRECTION card in the quest log
      // remains the primary confirm surface either way, so nothing is lost, only not shouted.
      || ((typeof Chat.askBudgetSpent === 'function') ? Chat.askBudgetSpent() : false);
    let shown = null;
    if (!busy && typeof Chat.nudge === 'function') {
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }
      const line = 'your north star looks like: “' + ns.text + '”. is that the direction to steer your quests by?';
      shown = Chat.nudge(line, [{ label: 'Confirm ✓', value: 'yes' }, { label: 'Not quite', value: 'no' }, { label: 'Open QUEST LOG', value: 'log', skip: true }], choice => {
        if (choice && choice.value === 'yes') { verdict('confirm').then(afterVerdict); }
        else if (choice && choice.value === 'no') { verdict('decline').then(afterVerdict); }
        else if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('quests');
      });
      // a nudge that actually claimed the slot spends one unit of the shared budget (a refused one spent nothing)
      if (shown && typeof Chat.spendAsk === 'function') { try { Chat.spendAsk(); } catch (_) {} }
    }
    if (!shown && typeof Chat.broadcast === 'function') {   // nudge refused (a question/beat won the race) → same ambient fallback as busy
      try { Chat.broadcast('YOUR MAIN GOAL — CONFIRM? · ' + String(ns.text).toUpperCase()); } catch (_) {}
    }
  }
  function afterVerdict() { if (typeof StationUI !== 'undefined' && StationUI.rerender) { try { StationUI.rerender('quests', false); } catch (_) {} } }
  function poke() { try { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); } catch (_) {} }

  /* FOLLOW THE CYCLE TO ITS END (2026-08-13). Starting a refresh is not finishing one: the POST returns
     `started` in milliseconds while the engine works for seconds afterwards, and `inFlight` only clears on a
     later fetch. The panel used to paint REFRESHING… and re-render once on a blind 3.5s timer, so a cycle that
     outlived the guess left the button disabled and labelled REFRESHING… with no outcome — which is what
     "refresh quests barely works" looked like. Now the store watches its own cycle: bounded polls of the real
     status until the engine reports it is no longer in flight, then ONE re-render carrying the recorded
     outcome. Bounded (never an unbounded spinner) and it pokes on give-up too, so the control always comes
     back — truthfully labelled by whatever the engine actually reported. */
  const SETTLE_POLL_MS = 1200, SETTLE_MAX_MS = 45000;
  let watching = false;
  async function watchSettle() {
    if (watching) return;
    watching = true;
    const started = Date.now();
    try {
      while (Date.now() - started < SETTLE_MAX_MS) {
        await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
        lastFetch = 0;
        await refetch();
        if (!isRunning()) break;   // the engine says the cycle is done — its ledger row is now the truth
      }
    } catch (_) { /* fail-soft: the poke below still frees the control */ }
    finally { watching = false; poke(); }
  }

  // THROTTLED poll — safe to call every tick + every quest-log render. Only actually hits the network once the
  // POLL_MS window has elapsed since the last good fetch (or on the very first call / after a run reset it).
  function sync() {
    if (Date.now() - lastFetch >= POLL_MS) refetch();   // fire-and-forget; the cache read stays synchronous
  }

  // ---- synchronous read (the panel consumes this off the last-good cache) ----
  function status() { return cache; }
  function isRunning() { return running || !!(cache && cache.inFlight); }

  // ---- write: force a refresh cycle NOW (the REFRESH QUESTS button). Honest reply: { ok, started, error }.
  // Immediately refetches so the ledger/inFlight reflect the launch without waiting for the next poll.
  async function run() {
    if (running) return { ok: false, started: false, error: 'a refresh is already running' };
    running = true;
    let out = { ok: false, started: false, error: 'refresh failed' };
    try {
      const res = await fetch('/api/quests/refresh/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await res.json().catch(() => null);
      out = j && typeof j === 'object' ? { ok: !!j.ok, started: !!j.started, error: j.error || '' } : out;
    } catch (_) { out = { ok: false, started: false, error: 'could not reach the station' }; }
    finally { running = false; lastFetch = 0; await refetch(); }   // immediate: inFlight/ledger reflect the launch now
    if (out.started) watchSettle();   // and then follow it to the end, so the outcome lands without a re-open
    return out;
  }

  // ---- write: the Commander's verdict on a PROPOSED (inferred) north star (POST /api/quests/refresh/northstar).
  // confirm → it becomes the adopted star; decline → denylisted + dropped. Immediate refetch so the card/label
  // reflect the verdict now. Returns { ok, applied, northStar, northStarProposed }.
  async function verdict(decision) {
    const dec = decision === 'confirm' ? 'confirm' : 'decline';
    let out = { ok: false };
    try {
      const res = await fetch('/api/quests/refresh/northstar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: dec }) });
      const j = await res.json().catch(() => null);
      out = j && typeof j === 'object' ? j : out;
    } catch (_) { out = { ok: false }; }
    lastFetch = 0; await refetch();   // immediate: the "unconfirmed" tag clears (confirm) or the star reverts (decline)
    return out;
  }

  // init on enter-game: a clean fetch so the first quest-log render already has the status (the tick keeps it fresh).
  function init() { cache = null; lastFetch = 0; running = false; beaten.clear(); refetch(); }
  // a fresh Commander inherits no cached status (mirrors the sibling stores' reset).
  function reset() { cache = null; lastFetch = 0; running = false; watching = false; beaten.clear(); }

  return { init, sync, status, isRunning, run, verdict, reset, _shape: shape };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestRefreshStore };
