/* AGENT OS — questledgerstore.js : the QUEST V2 backend ledger's frontend citizen (plan §C).

   The sidecar now OWNS a durable, agent-aware quest ledger (sidecar/quest-store.js, routes /api/quests*).
   This thin live store is its browser-side read+write surface. It POLLS GET /api/quests on the station's
   existing 1s tick cadence — but THROTTLED (a real network fetch at most every POLL_MS, and immediately
   after a confirm/dismiss write) so the tick never floods the sidecar. It caches the last-good ledger, so a
   fetch failure keeps the previous list (never a crash, never a blanked log) — the truthful-degradation idiom
   every sibling store uses (workshopstore/stationqueststore).

   It hands the ledger to the pure Quests engine as a NEW splice input (kind:'ledger'), shaped into the shared
   quest shape so the rows, the QuestState open→done celebration, and the dismiss path all work with ZERO new
   celebration code. `ledgerKind` carries the backend kind ('generated'|'work'|'user') for the row copy without
   colliding with the v1 'work' kind's handlers.

   Writes:
     • confirm(id, ok, note) → POST /api/quests/confirm — the Commander's attest verdict (yes→done, no→declineNote).
     • dismiss(id)           → POST /api/quests/dismiss  — wave a ledger quest off forever (backend denylist).
   Both refetch immediately so the row reflects the verdict without waiting for the next poll.

   It also surfaces a pending attest (an agent proposed completion with evidence) as ONE COMMS beat via the
   shared Chat.nudge lifecycle — one beat per attest, guarded so it never interrupts a live post-run beat
   (falls back to the ambient Chat.broadcast line). The row-level confirm is the primary surface; the beat
   is the glance that points the Commander at it.

   NO U.bus emits (the frozen shared/events.js contract is owned elsewhere). node-exportable for its test. */
'use strict';
const QuestLedgerStore = (() => {
  const POLL_MS = 4000;        // throttle: a live /api/quests fetch at most this often (the 1s tick calls sync() freely)
  let cache = [];              // last-good SHAPED ledger quests (open + done; dismissed filtered out)
  let lastFetch = 0;           // ms of the last SUCCESSFUL fetch (0 = force next sync to fetch)
  let inflight = false;        // one fetch at a time — a slow response never stacks
  const notified = new Set();  // attest keys we've already surfaced a beat for this page session (anti-nag)
  const seenOpen = new Set();  // open quest ids observed this session — a NEW one (mint) fires a toast + COMMS line
  let seededOnce = false;      // the FIRST successful fetch seeds seenOpen SILENTLY (the boot backlog must not toast-storm)

  // shape ONE backend record into the shared quest shape the projection/rows/fold consume. Guarded so a junk
  // record degrades to a safe row rather than throwing (fail-soft, like the sibling stores' normalizers).
  function shape(r) {
    const c = (r && r.contract && typeof r.contract === 'object') ? r.contract : {};
    // a pending attest = present AND not yet confirmed (confirmed:null). A confirmed/declined attest is history.
    const at = (r && r.attest && typeof r.attest === 'object' && r.attest.confirmed == null) ? {
      agentId: r.attest.agentId || null,
      evidence: String(r.attest.evidence == null ? '' : r.attest.evidence),
      at: Number(r.attest.at) || 0
    } : null;
    return {
      id: String(r.id),
      kind: 'ledger',                                  // one kind for the whole ledger (handlers/dismiss route on this)
      ledgerKind: (r && r.kind) || 'user',             // the backend kind — for the "completes when" copy only
      title: String((r && r.title) || r.id),
      desc: String((r && r.desc) || ''),
      reward: String((r && r.reward) || 'a real outcome'),
      status: (r && r.status === 'done') ? 'done' : 'open',
      contract: { type: String(c.type || 'attest'), key: String(c.key == null ? '' : c.key) },
      steps: Array.isArray(r && r.steps) ? r.steps.map(s => ({ key: String(s && s.key || ''), label: String((s && (s.label != null ? s.label : s.key)) || ''), done: !!(s && s.done), note: (s && s.note) || '' })) : [],
      attest: at,
      declineNote: (r && r.declineNote && typeof r.declineNote === 'object') ? { at: Number(r.declineNote.at) || 0, note: String(r.declineNote.note || '') } : null,
      groundedIn: (r && r.groundedIn) || null,
      agentId: (r && r.agentId) || null,
      completedBy: (r && r.completedBy) || null,
      domain: (r && r.domain) || null,
      goalId: (r && r.goalId) || null,
      milestoneId: (r && r.milestoneId) || null,
      executionMode: (r && r.executionMode) || (c.type === 'attest' ? 'commander' : 'agent'),
      whyNow: String((r && r.whyNow) || ''),
      disposition: r && r.disposition || null
    };
  }

  // rebuild the cache from a fetched ledger: drop dismissed (they never render), keep open + done (a done quest
  // must stay so QuestState.fold sees its open→done edge and celebrates it for free).
  function apply(records) {
    const arr = Array.isArray(records) ? records : [];
    cache = arr.filter(r => r && r.id && r.status !== 'dismissed').map(shape);
    detectNewQuests();
  }

  // §E surfacing: a newly-APPEARED open quest (a mint the agent just committed) must be SEEN without opening the
  // QUEST LOG. The very first successful fetch of a session seeds the seen-set SILENTLY (the boot backlog is not
  // "new"); every later fetch announces only ids not seen before. Session-local — no persistence (the notify
  // record is the receipt, and the ledger itself is durable server-side).
  function detectNewQuests() {
    const openNow = cache.filter(q => q.status === 'open');
    if (!seededOnce) { for (const q of openNow) seenOpen.add(q.id); seededOnce = true; return; }
    for (const q of openNow) {
      if (seenOpen.has(q.id)) continue;
      seenOpen.add(q.id);
      announceNewQuest(q);
    }
  }
  // ONE glance per new quest: a terse ambient COMMS line (Chat.broadcast — Lane 1's queue means it is never
  // dropped by the celebration coalesce). NO StationUI.notify (notification diet, 2026-08-18): the quest log
  // is the quest surface — the bell is reserved for things that need the Commander. Guarded: in a headless/test
  // context (no Chat) this is a silent no-op, never a throw.
  function announceNewQuest(q) {
    const title = String((q && q.title) || (q && q.id) || 'a quest').replace(/\s+/g, ' ').trim() || 'a quest';
    if (typeof Chat !== 'undefined' && typeof Chat.broadcast === 'function') { try { Chat.broadcast('NEW QUEST · ' + title.toUpperCase(), { highlight: title.toUpperCase(), tone: 'gold' }); } catch (_) {} }
  }

  async function refetch() {
    if (inflight) return;
    inflight = true;
    try {
      const res = await fetch('/api/quests', { cache: 'no-store' });   // hardened window.fetch attaches the apiauth token
      if (res.ok) {
        const j = await res.json().catch(() => null);
        if (j && j.ok && Array.isArray(j.quests)) { apply(j.quests); lastFetch = Date.now(); maybeBeat(); }
      }
    } catch (_) { /* fail-soft: keep the last-good cache, never blank the log */ }
    finally { inflight = false; }
  }

  // THROTTLED poll — safe to call every tick + every quest-log render. Only actually hits the network once the
  // POLL_MS window has elapsed since the last good fetch (or on the very first call / after a write reset it).
  function sync() {
    if (Date.now() - lastFetch >= POLL_MS) refetch();   // fire-and-forget; the cache read stays synchronous
  }

  // ---- synchronous reads (the projection + the panel consume these off the last-good cache) ----
  function quests() { return cache.slice(); }                                   // non-dismissed, shaped
  function pendingAttests() { return cache.filter(q => q.status === 'open' && q.attest); }

  // ---- writes (both force an immediate refetch so the row reflects the verdict now) ----
  async function confirm(id, ok, note) {
    let out = { ok: false };
    try {
      const res = await fetch('/api/quests/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: String(id), ok: !!ok, note: note == null ? '' : String(note) }) });
      const j = await res.json().catch(() => null);
      out = { ok: !!(res.ok && j && j.ok !== false) };
    } catch (_) { out = { ok: false }; }
    lastFetch = 0; await refetch();   // immediate: the attest badge clears (yes→done, no→open again) without waiting a poll
    return out;
  }
  async function dismiss(id) {
    let out = { ok: false };
    try {
      const res = await fetch('/api/quests/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: String(id) }) });
      const j = await res.json().catch(() => null);
      out = { ok: !!(res.ok && j && j.ok !== false) };
    } catch (_) { out = { ok: false }; }
    lastFetch = 0; await refetch();   // immediate: the row vanishes from the cache on the next apply()
    return out;
  }

  function paused(q, now) {
    const d = q && q.disposition;
    return !!(d && (d.type === 'blocked' || d.type === 'too_big' || (d.type === 'later' && Number(d.snoozeUntil) > (now == null ? Date.now() : now))));
  }
  async function writeAction(path, body) {
    let out;
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      out = await res.json();
      if (!res.ok) out = { ok: false, error: out && out.error || 'quest update failed' };
    } catch (_) { out = { ok: false, error: 'quest service unavailable' }; }
    lastFetch = 0; await refetch();
    if (out && out.ok && typeof JourneyStore !== 'undefined' && JourneyStore.sync) await JourneyStore.sync(true);
    return out;
  }
  function disposition(id, type, reason) {
    return writeAction('/api/quests/disposition', { id, disposition: type, reason: String(reason || ''),
      snoozeUntil: type === 'later' ? Date.now() + 24 * 3600000 : null });
  }
  function report(id, evidence) { return writeAction('/api/quests/report', { id, evidence: String(evidence || '') }); }

  // surface a newly-observed pending attest as ONE gentle COMMS beat (the shared nudge lifecycle → one beat at a
  // time, decided beats vanish()). Deduped per attest-key for the page session (anti-nag). Guarded: if a real
  // beat/turn is live (Chat.isBusy) we DON'T claim the moment — we fall back to the ambient broadcast line, which
  // is coalesced + in-game-gated inside Chat and never competes with the post-run ask chain.
  function maybeBeat() {
    if (typeof Chat === 'undefined') return;
    for (const q of pendingAttests()) {
      const key = q.id + '@' + (q.attest ? q.attest.at : 0);
      if (notified.has(key)) continue;
      notified.add(key);
      surfaceAttestBeat(q);
      break;   // one beat at a time — the rest wait for their own tick
    }
  }
  function surfaceAttestBeat(q) {
    const ev = String((q.attest && q.attest.evidence) || '').replace(/\s+/g, ' ').trim();
    const evShort = ev.length > 120 ? ev.slice(0, 117) + '…' : ev;
    const title = String(q.title || q.id).toUpperCase();
    // the moment is claimed when a run is live OR any ask beat / unanswered task question holds the COMMS slot
    // (Chat.beatBusy) — a confirm nudge stacked over a pending clarifying question wiped its answer chips
    // (the duplicate-popups bug, 2026-07-19). Blocked → the ambient ticker line instead.
    const busy = ((typeof Chat.isBusy === 'function') ? Chat.isBusy() : false)
      || ((typeof Chat.beatBusy === 'function') ? Chat.beatBusy() : false);
    let shown = null;
    if (!busy && typeof Chat.nudge === 'function') {
      if (typeof SFX !== 'undefined' && SFX.idea) { try { SFX.idea(); } catch (_) {} }
      const line = '⚑ your agent reports a quest complete — “' + (evShort || q.title) + '”. confirm it?';
      shown = Chat.nudge(line, [{ label: 'Confirm ✓', value: 'yes' }, { label: 'Review in QUEST LOG', value: 'log', skip: true }], choice => {
        if (choice && choice.value === 'yes') { confirm(q.id, true).then(() => { if (typeof StationUI !== 'undefined' && StationUI.rerender) StationUI.rerender('quests', false); }); }   // the click was in COMMS — the open log repaints as a data poke, no blink
        else if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('quests');   // Review → open the log where the row's confirm lives
      });
    }
    if (!shown && typeof Chat.broadcast === 'function') {   // nudge refused (a question/beat won the race) → same ambient fallback as busy
      try { Chat.broadcast('QUEST READY TO CONFIRM · ' + title, { highlight: title }); } catch (_) {}
    }
  }

  // init on enter-game: a clean fetch so the first quest-log render already has the ledger (the tick keeps it fresh).
  // seededOnce resets so the incoming ledger seeds the new-quest baseline silently (no toast-storm on enter).
  function init() { cache = []; lastFetch = 0; notified.clear(); seenOpen.clear(); seededOnce = false; refetch(); }
  // a fresh Commander inherits no ledger cache (mirrors the sibling stores' reset).
  function reset() { cache = []; lastFetch = 0; notified.clear(); seenOpen.clear(); seededOnce = false; }

  return { init, sync, quests, pendingAttests, confirm, dismiss, disposition, report, paused, reset, _shape: shape, _apply: apply, _seededOnce: () => seededOnce };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { QuestLedgerStore };
