/* STARNET — nightnudge.js : the LIVE-SESSION unseen-drafts nudge (Night Shift visibility, 2026-07-13).

   THE GAP IT CLOSES: the MORNING REPORT (nightreportstore.js) only fires on app-CLOSURE absence (its localStorage
   heartbeat). But the night-shift driver's away detection is SERVER-side (lastUserActivityAt) — so an app left OPEN
   while the Commander is away still fires beats, and reason-only drafts pile up on the desk with NOTHING surfaced
   until a close/reopen. That silence recreates the "it never does anything" complaint.

   THE FIX: while the app is open, poll the drafts the night shift left and, when N+ of them are UNSEEN, surface ONE
   gentle COMMS nudge ("the night shift left N drafts — review?") that opens the NIGHT SHIFT panel. Discipline:
     • "seen" is DURABLE — a lastSeenDraftAt stamp (our own localStorage key), advanced whenever the drafts are
       actually surfaced (the morning report renders them, this nudge is acknowledged, or the panel re-opens a report).
       So the two paths never double-announce the same drafts.
     • ONE nudge per page session (anti-nag), and it rides Chat.nudge → obeys one-beat-at-a-time + vanish() on
       decision. It stands down when ANY other beat holds the slot (Chat.beatBusy) — never stacks on a visible beat.
     • Composes NOTHING itself: the unseen predicate is the pure engine's NightReport.unseenDrafts (node-tested).
       Every claim maps to a route field (truthful telemetry). NEVER emits on U.bus; fail-open everywhere (a down
       route → no nudge, never a fake one). */
'use strict';
const NightDraftNudge = (() => {
  const KEY = 'starnet.nightdrafts.seen.v1';   // durable lastSeenDraftAt (our OWN key — never races the report's)
  const MIN_UNSEEN = 2;          // N: a single draft is a weak nudge; 2+ is "the night shift left N drafts"
  const DELAY_MS = 6000;         // let the floor + COMMS + the MORNING REPORT (which may mark drafts seen) settle first
  const POLL_MS = 60000;         // re-check cadence while the app is open (idiom: nightreportstore's heartbeat interval)
  let fired = false;             // ONE nudge per page session (survives enterGame re-entry)
  let pollTimer = 0;
  let wired = false;
  let scheduled = 0;

  function loadStamp() { try { return Number(localStorage.getItem(KEY)) || 0; } catch (_) { return 0; } }
  function lastSeen() { return loadStamp(); }
  // advance the durable "seen" mark. Monotonic (never moves backward), so a stale/older ts can't un-see newer drafts.
  function markSeen(ts) {
    const t = Number(ts) || Date.now();
    try { const cur = loadStamp(); if (t > cur) localStorage.setItem(KEY, String(t)); } catch (_) {}
  }

  async function getJSON(url) {
    try { const r = await fetch(url, { cache: 'no-store' }); if (!r || !r.ok) return null; return await r.json(); }
    catch (_) { return null; }
  }

  // the guarded check: fetch the drafts, compute the UNSEEN set via the pure engine, and — if N+ are unseen and no
  // other beat owns the slot — surface ONE nudge. Fail-open: any missing dependency simply skips (never a fake beat).
  async function check() {
    if (fired) { stopPolling(); return; }
    // THE ONE RETURN REPORT lists drafted ideas in the single briefing — no second nudge about them
    try { if (typeof Briefing !== 'undefined' && Briefing.ownsReturn && Briefing.ownsReturn()) { fired = true; stopPolling(); return; } } catch (_) {}
    if (typeof NightReport === 'undefined' || typeof Chat === 'undefined' || !Chat.nudge) return;
    // only when the tab is actually being looked at — a nudge fired into a hidden tab is noise the Commander misses.
    try { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; } catch (_) {}
    // never stack on a live beat (memory turn-in / study card / suggestion / dialogue panel / another nudge).
    try { if (Chat.beatBusy && Chat.beatBusy()) return; } catch (_) {}

    const seen = lastSeen();
    const res = await getJSON('/api/nightshift/drafts?limit=20');
    const drafts = (res && Array.isArray(res.drafts)) ? res.drafts : [];
    let unseen; try { unseen = NightReport.unseenDrafts(drafts, seen); } catch (_) { return; }
    if (!unseen || unseen.length < MIN_UNSEEN) return;
    // re-check the guards right before firing (the fetch was async — a beat may have claimed the slot meanwhile).
    if (fired) return;
    try { if (Chat.beatBusy && Chat.beatBusy()) return; } catch (_) {}
    // the SHARED session ask budget (one-memory lane): "review?" is a proactive consent ask, so it spends the
    // same bounded budget the spine's channels do. A spent budget just waits — the drafts are still on the desk,
    // the morning report still lists them, and the next session's quieter moment offers this again.
    try { if (Chat.askBudgetSpent && Chat.askBudgetSpent()) return; } catch (_) {}

    fired = true;          // spend the session's single nudge even if later dismissed (anti-nag)
    try { if (Chat.spendAsk) Chat.spendAsk(); } catch (_) {}   // …and one unit of the shared budget
    stopPolling();
    const n = unseen.length;
    const newestAt = Number(unseen[0] && unseen[0].at) || Date.now();   // the mark to set once it's acknowledged
    const body = '◈ while you were away, autonomy left ' + n + ' draft' + (n === 1 ? '' : 's') + ' on your desk — review?';
    Chat.nudge(body, [{ label: 'review', value: 'go' }, { label: 'later', value: 'no', skip: true }], item => {
      // either choice ACKNOWLEDGES these drafts → mark them seen so neither this nudge nor the morning report
      // re-announces the same set. 'review' also opens the NIGHT SHIFT panel where the decision trail + report live.
      markSeen(newestAt);
      if (item && item.value === 'go') {
        try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('settings', 'autonomy'); } catch (_) {}
      }
    });
    try { if (typeof World !== 'undefined' && World.say) World.say('◈ left ' + n + ' draft' + (n === 1 ? '' : 's') + ' on your desk'); } catch (_) {}
  }

  function stopPolling() { if (pollTimer) { try { clearInterval(pollTimer); } catch (_) {} pollTimer = 0; } }
  // schedule a near-immediate check (debounced) — used when the tab regains focus/visibility (the Commander is back).
  function poke() { if (fired) return; if (scheduled) return; try { scheduled = setTimeout(() => { scheduled = 0; check().catch(() => {}); }, 400); } catch (_) {} }

  /* init({ enabled, agentId }) — called from enterGame alongside NightReportStore.init. enabled:false (the awakening)
     never nudges (a first session has no accumulated night's work). Deferred behind DELAY_MS so it never races the
     floor/COMMS boot OR the morning report (which, when it fires, marks the same drafts seen first). */
  function init(opts) {
    opts = opts || {};
    if (!wired && typeof window !== 'undefined' && window.addEventListener) {
      wired = true;
      try { window.addEventListener('focus', poke); } catch (_) {}
      try { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { try { if (document.visibilityState === 'visible') poke(); } catch (_) {} }); } catch (_) {}
    }
    if (opts.enabled === false) return;   // the awakening: no baseline of unattended work yet
    if (typeof setTimeout === 'function') setTimeout(() => { check().catch(() => {}); }, DELAY_MS);
    stopPolling();
    if (typeof setInterval === 'function') pollTimer = setInterval(() => { check().catch(() => {}); }, POLL_MS);
  }

  // a fresh Commander (S2/new-hero) inherits no seen-state and no spent nudge.
  function reset() { fired = false; stopPolling(); try { localStorage.removeItem(KEY); } catch (_) {} }

  // test/inspection seam: force ONE check now, optionally resetting the session flag / seeding the seen mark. The
  // DOM round-trip proof uses this to prove a seeded unseen set produces exactly one nudge (no 15-minute wait).
  function _check(o) {
    o = o || {};
    if (o.reset) fired = false;
    if (Number.isFinite(Number(o.seen))) { try { localStorage.setItem(KEY, String(Number(o.seen))); } catch (_) {} }
    return check();
  }

  return { init, reset, markSeen, lastSeen, _check, _state: () => ({ fired }) };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { NightDraftNudge };
