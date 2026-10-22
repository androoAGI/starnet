/* AGENT OS — stationquests.js : the PURE station-quest generator (G1b).

   The killer generator: a REAL capability failure becomes playable direction. When an agent reaches
   for a tool its room can't grant (a `capdenied`, or — the richer signal — a `agent.tool_call` whose
   capability its room doesn't hold), the station mints a fix-it quest:

     "⚑ NOVA reached for the web — place a DISH in her bay"

   …resolved from the LIVE catalog (the store passes in the real prop label), and it COMPLETES the
   instant the gap truly closes on the floor (the room gains a prop granting that capability). Placement
   is the completion signal — never a claim button. It gates NOTHING and mints NO XP (the honest-quest +
   XP laws): it only reveals what to build next.

   THE STATE (mirrors queststate.js's shape so the two engines never diverge in style): a small durable
   record, one entry per (agentId, capability) — repeats never duplicate. `record()` folds a freshly
   detected gap into it (first sight stamps firstSeenAt); `refresh()` re-reads whether each open gap is
   now granted and flips it done (completedAt stamped). Dismissal = STOP FOREVER (the anti-nag law): a
   waved-off gap never re-renders and never re-fires, even if the same tool is reached for again.

   PURE + node-testable (mirrors quests.js / queststate.js): no Date.now / Math.random — the caller
   injects the clock and the "is this cap granted now?" predicate. The browser store (stationqueststore.js)
   owns all the live reads (U.bus subscription, World.heroCaps, the catalog label); this file owns only
   the deterministic fold + the projection into the shared Quests shape. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.StationQuests = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fresh() { return { v: 1, gaps: {} }; }

  // the stable id for a (agent, capability) gap — the dedup key AND the quest id the QuestState engine
  // folds through (so completion rides G1a's celebration for free). Sanitized so a hand-edited save or a
  // weird agentId can never inject a broken id.
  const clean = s => String(s == null ? '' : s).replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 48);
  function gapId(agentId, cap) { return 'sq:' + clean(agentId) + ':' + clean(cap); }

  // defensively rebuild a persisted slice: every entry re-validated, junk dropped (never a crash on a bad save).
  function hydrate(raw) {
    const s = fresh();
    if (!raw || typeof raw !== 'object') return s;
    const gaps = (raw.gaps && typeof raw.gaps === 'object') ? raw.gaps : {};
    for (const id of Object.keys(gaps)) {
      const r = gaps[id];
      if (!id || !r || typeof r !== 'object') continue;
      const first = Number(r.firstSeenAt);
      if (!Number.isFinite(first)) continue;
      const agentId = clean(r.agentId), cap = clean(r.cap);
      if (!agentId || !cap) continue;
      // null must round-trip as null — Number(null) is 0 (finite!), which would resurrect an open gap
      // as "completed/dismissed at epoch". Guard the null case explicitly before coercing.
      const comp = r.completedAt == null ? NaN : Number(r.completedAt);
      const dis = r.dismissedAt == null ? NaN : Number(r.dismissedAt);
      s.gaps[id] = {
        agentId, cap,
        capLabel: String(r.capLabel || cap).slice(0, 24),
        propLabel: String(r.propLabel || '').slice(0, 24),
        agentLabel: String(r.agentLabel || agentId).slice(0, 40),
        firstSeenAt: first,
        completedAt: Number.isFinite(comp) ? comp : null,
        dismissedAt: Number.isFinite(dis) ? dis : null
      };
    }
    return s;
  }

  /* fold a freshly detected gap into the state (in place, like Dossier.upsert / QuestState.fold).
     g = { agentId, cap, capLabel, propLabel, agentLabel } — the store resolves capLabel/propLabel/agentLabel
     from the LIVE catalog + roster (never hardcoded). Rules:
       • one entry per (agentId, cap) — a repeat of the same reach NEVER duplicates (idempotent update of
         the labels only; the firstSeenAt / completion history is preserved).
       • a DISMISSED gap is never re-created — waved off = stop forever, even if the tool is reached again.
       • recording a gap that's ALREADY done (a stale detection after the prop was placed) is a no-op — the
         completion stands.
     Returns the entry's id (so the store can log), or null when nothing was recorded (dismissed / invalid). */
  function record(state, g, now) {
    if (!state || !state.gaps || !g) return null;
    const agentId = clean(g.agentId), cap = clean(g.cap);
    if (!agentId || !cap) return null;
    const id = gapId(agentId, cap);
    const existing = state.gaps[id];
    if (existing && existing.dismissedAt != null) return null;   // dismissed = stop forever
    if (existing) {
      // refresh the human-facing labels (the catalog is the source of truth) but keep the history.
      if (g.capLabel) existing.capLabel = String(g.capLabel).slice(0, 24);
      if (g.propLabel) existing.propLabel = String(g.propLabel).slice(0, 24);
      if (g.agentLabel) existing.agentLabel = String(g.agentLabel).slice(0, 40);
      return id;
    }
    state.gaps[id] = {
      agentId, cap,
      capLabel: String(g.capLabel || cap).slice(0, 24),
      propLabel: String(g.propLabel || '').slice(0, 24),
      agentLabel: String(g.agentLabel || agentId).slice(0, 40),
      firstSeenAt: now,
      completedAt: null,
      dismissedAt: null
    };
    return id;
  }

  /* re-check every OPEN gap against the live floor and flip the newly-closed ones done. `granted(entry)`
     is the store's predicate — "does <agentId>'s room now grant <cap>?" (World.heroCaps). Completion is the
     REAL thing happening (a prop was placed), never a claim. Returns the entries that transitioned this
     refresh (so the store can log); the actual open→done CELEBRATION rides QuestState's fold over the
     projection (below) — this engine never plays sound, exactly like quests.js. */
  function refresh(state, granted, now) {
    const closed = [];
    if (!state || !state.gaps || typeof granted !== 'function') return closed;
    for (const id of Object.keys(state.gaps)) {
      const e = state.gaps[id];
      if (!e || e.dismissedAt != null || e.completedAt != null) continue;
      let ok = false;
      try { ok = !!granted(e); } catch (_) { ok = false; }
      if (ok) { e.completedAt = now; closed.push(e); }
    }
    return closed;
  }

  // wave a gap off forever. Returns true only when it actually took (a known, not-already-dismissed gap).
  // Unlike dossier quests these are ALWAYS dismissible — a fix-it suggestion the Commander waves off must
  // stop nagging even though the real gap is still open (the sandbox law: the station suggests, never pushes).
  function dismiss(state, id, now) {
    if (!state || !state.gaps || !id) return false;
    const e = state.gaps[id];
    if (!e || e.dismissedAt != null) return false;
    e.dismissedAt = now;
    return true;
  }

  const isDismissed = (state, id) => !!(state && state.gaps && id && state.gaps[id] && state.gaps[id].dismissedAt != null);

  /* project the state into the shared Quests shape (kind 'station-gap'), so these ride the EXACT same
     quest-log render + QuestState fold (→ G1a celebration) as every other quest — one quest shape, never a
     second parallel system. A dismissed gap is omitted entirely (stop forever). Open gaps carry the
     honest "place a <PROP LABEL> in its bay" direction; done gaps read as closed. Deterministic ordering:
     open before done, then by firstSeenAt (stable). Every quest names a REAL reward and gates nothing. */
  function project(state) {
    if (!state || !state.gaps) return [];
    const entries = Object.keys(state.gaps).map(id => Object.assign({ id }, state.gaps[id]))
      .filter(e => e.dismissedAt == null);
    entries.sort((a, b) => {
      const ad = a.completedAt != null ? 1 : 0, bd = b.completedAt != null ? 1 : 0;
      if (ad !== bd) return ad - bd;                 // open first
      return (a.firstSeenAt || 0) - (b.firstSeenAt || 0);
    });
    return entries.map(e => {
      const done = e.completedAt != null;
      const who = e.agentLabel || e.agentId;
      const prop = e.propLabel || (e.capLabel + ' prop');
      return {
        id: e.id,
        kind: 'station-gap',
        title: done
          ? (who + ' can reach ' + e.capLabel + ' now')
          : (who + ' reached for ' + e.capLabel + ' — place a ' + prop + ' in its bay'),
        desc: done
          ? 'done — the ' + prop + ' is on its floor.'
          : 'its run hit a wall: the room grants no ' + e.capLabel + '. drop a ' + prop + ' in its bay and it can do this for real.',
        reward: 'the ' + e.capLabel + ' capability, live on the floor',
        status: done ? 'done' : 'open'
      };
    });
  }

  // how many gaps are currently OPEN (drives the MISSION BOARD pin count + pulse). Dismissed + done excluded.
  function openCount(state) {
    if (!state || !state.gaps) return 0;
    let n = 0;
    for (const id of Object.keys(state.gaps)) {
      const e = state.gaps[id];
      if (e && e.dismissedAt == null && e.completedAt == null) n++;
    }
    return n;
  }

  return { fresh, hydrate, gapId, record, refresh, dismiss, isDismissed, project, openCount };
});
