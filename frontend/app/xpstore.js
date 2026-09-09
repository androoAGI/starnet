/* STARNET — xpstore.js : the live wiring that turns REAL harness events into agent + station growth.

   Subscribes (read-only) to the U.bus event spine — every harness event is already re-emitted there
   by harness.js — runs each outcome through the pure Xp engine, mutates the persisted agent.stats and
   the station rollup, saves, and fires the in-world celebration (a gold level-up pulse + a dossier toast).

   It NEVER emits a bus event: the frozen shared/events.js contract is owned elsewhere and stays untouched.
   Celebration is a direct call into World + StationUI, so the lint-emits gate has nothing to catch. */
'use strict';
const XpStore = (() => {
  let getAgent = () => null;
  let allAgents = null;          // S4: every agent whose trophy case needs reconciling at boot (optional)
  let station = null;            // the station-wide rollup stats (same shape as an agent's .stats)
  let persistFn = () => {};
  let credentialFn = () => {};   // S3: fired ONLY when an agent's coarse track record actually changes
  let wired = false;

  // the real events that feed growth. Only explicit turn-in memory.feedback mints XP; operational events
  // update counters/milestones so the dossier still shows shipped work without leveling from chatter.
  const FEED = ['agent.run.end', 'agent.tool_result', 'memory.write', 'memory.used', 'memory.feedback', 'workitem.delivered', 'channel.delivery'];

  function eventAgentId(payload) {
    const id = payload && typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    return id || 'agent';
  }

  function isSatisfactionFeedback(name, payload) {
    if (name !== 'memory.feedback' || typeof Xp === 'undefined' || !Xp.scoreEvent) return false;
    const sc = Xp.scoreEvent(name, payload || {});
    return !!(sc && sc.quality !== null && sc.quality !== undefined);
  }

  function resolveAgent(agentId) {
    let a = null;
    try { a = getAgent(agentId); } catch (_) { a = null; }
    if (!a && agentId === 'agent') { try { a = getAgent(); } catch (_) {} }   // back-compat for old no-arg callers
    return a || null;
  }

  function growthEpoch() {
    const hero = resolveAgent('agent');
    return Math.max(1, Math.floor(Number(hero && hero.createdAt) || 1));
  }

  function pushToWorld(a) {
    if (typeof World === 'undefined' || !World.setXp || typeof Xp === 'undefined') return;
    World.setXp(a && a.id ? a.id : 'agent', a && a.stats ? Xp.compute(a.stats) : null);   // station headline now rides the top-bar chip (pushTopbar)
  }

  // the always-on STATION level chip in the top bar — the colony's headline number.
  function pushTopbar() {
    // Agent feedback remains crew XP. Only the Journey read-model writes Commander level.
    try { if (typeof Topbar !== 'undefined' && Topbar._paintXp) Topbar._paintXp(); } catch (_) {}
  }

  // The canvas HUD and top-bar chip have direct setters, but the left crew manifest renders its "Lv N" text
  // from the roster snapshot handed to StationUI. Refresh that snapshot only when the displayed level changes;
  // ordinary run/XP events stay cheap and do not rebuild the rail.
  function refreshCrewLevel() {
    if (!allAgents || typeof StationUI === 'undefined' || !StationUI.setRoster) return;
    try {
      const list = allAgents();
      if (Array.isArray(list)) StationUI.setRoster(list);
    } catch (_) {}
  }

  function celebrateAgent(a, level) {
    if (typeof World !== 'undefined' && World.pulseLevelUp) World.pulseLevelUp(a && a.id ? a.id : 'agent', level);
    if (typeof SFX !== 'undefined' && SFX.level) { try { SFX.level(); } catch (_) {} }
    // NO StationUI.notify (notification diet, 2026-08-18): a level-up is flavor the world already tells —
    // pulse + sting + the COMMS broadcast below. The NOTIFICATIONS bell is reserved for things that need you.
    // COMMS: a terse ambient station broadcast — the codename tinted with the agent's suit colour (the one
    // established colour exception). Not a beat-slot card; coalesced + in-game-gated inside Chat.broadcast.
    if (typeof Chat !== 'undefined' && Chat.broadcast) {
      const nm = String((a && a.name) || 'AGENT').toUpperCase();
      try { Chat.broadcast(nm + ' REACHED LEVEL ' + level, { highlight: nm, tint: (a && a.color) || null }); } catch (_) {}
    }
    if (typeof Tutorial !== 'undefined' && Tutorial.onLevelUp) Tutorial.onLevelUp(level);   // first-touch coachmark: what leveling means
  }
  function celebrateStation(level) {
    pushTopbar();
    // The Commander chip must not celebrate an agent-feedback level.
    // NO StationUI.notify (notification diet): the gold chip pulse + the new level number ARE the announcement.
  }
  // a milestone's short trophy title for the broadcast. Read from
  // the xp.js catalogue rather than a second hand-kept map: the labels ARE the trophy-case labels, so the badge
  // the Commander sees lit and the name the broadcast shouts cannot drift apart. Slug-case is the last resort.
  function milestoneLabel(id) {
    if (typeof Xp !== 'undefined' && Array.isArray(Xp.MILESTONES)) {
      const m = Xp.MILESTONES.find(x => x && x.id === id);
      if (m && m.label) return String(m.label);
    }
    return String(id || '').toUpperCase().replace(/_/g, ' ');
  }
  function announceMilestone(id) {
    // G3a: a milestone lands with its own sting — grander than a quest, smaller than a level-up (was mute).
    if (typeof SFX !== 'undefined' && SFX.milestone) { try { SFX.milestone(); } catch (_) {} }
    // NO StationUI.notify (notification diet): the sting + trophy-case badge + COMMS broadcast carry it.
    // COMMS: the trophy broadcast — rarer than a level, so the brighter gold treatment.
    if (typeof Chat !== 'undefined' && Chat.broadcast) {
      const nm = milestoneLabel(id);
      try { Chat.broadcast('TROPHY EARNED · ' + nm, { highlight: nm, tone: 'gold' }); } catch (_) {}
    }
  }

  // fold one real event into BOTH the agent's stats and the station rollup (same engine, same path).
  function onEvent(name, payload, opts) {
    opts = opts || {};
    const agentId = eventAgentId(payload);
    const a = resolveAgent(agentId);
    if (!a || typeof Xp === 'undefined') return { applied: false, credentialChanged: false };
    if (!a.stats) a.stats = Xp.fresh();
    if (!station) station = Xp.fresh();
    const ev = { name, payload: payload || {} };

    /* S3 — republish the roster ONLY when this agent's COARSE credential moves (a tier crossing or a band
       flip), never on every XP tick. Xp.credential is quantized precisely so this key is stable across the
       hundreds of ordinary events a working agent emits; without the before/after comparison this would fire
       a full /api/roster POST (every agent's whole composed system prompt) on every single run. */
    const credBefore = (Xp.credential && a.stats) ? Xp.credential(a.stats).key : '';
    const ra = Xp.applyEvent(a.stats, ev); a.stats = ra.stats;
    const rs = Xp.applyEvent(station, ev); station = rs.stats;
    if (Xp.credential) {
      const credAfter = Xp.credential(a.stats).key;
      const credentialChanged = credAfter !== credBefore;
      if (credentialChanged && !opts.silent) { try { credentialFn(a.id || agentId, credAfter); } catch (_) {} }
      opts.credentialChanged = credentialChanged;
    }

    if (!opts.silent) {
      pushToWorld(a);
      pushTopbar();

      if (ra.awards.levelUp) { refreshCrewLevel(); celebrateAgent(a, ra.awards.levelTo); }
      for (const id of ra.awards.milestones) announceMilestone(id);   // agent-scoped milestones
      if (rs.awards.levelUp) celebrateStation(rs.awards.levelTo);
    }

    // persist at run end (captures counters) and on explicit user turn-in feedback/level-up/milestone. Feedback can
    // arrive after the run stream has closed, so it must persist on its own even when it does not level up.
    if (!opts.noPersist && (name === 'agent.run.end' || isSatisfactionFeedback(name, payload) || ra.awards.levelUp || rs.awards.levelUp || ra.awards.milestones.length || rs.awards.milestones.length)) { try { persistFn(); } catch (_) {} }
    return {
      applied: !(ra.awards.duplicate && rs.awards.duplicate),
      agentApplied: !ra.awards.duplicate,
      credentialChanged: !!opts.credentialChanged,
      agentId: a.id || agentId
    };
  }

  /* S4 — BACKFILL the trophy case at boot. A save written before a badge existed already holds the record that
     earns it, so without this the case shows a locked badge whose unlock hint the dossier above it has visibly
     already met. Silent by design (Xp.reconcile's `earned` list is deliberately not announced): these are past
     facts being recognized, not moments — announcing would fire a burst of gold TROPHY EARNED broadcasts at
     boot for work done weeks ago. No persist here either; the reconciled stats ride the next ordinary save,
     and the call is idempotent, so a boot that never saves simply reconciles again next time. */
  function reconcileTrophies() {
    if (typeof Xp === 'undefined' || !Xp.reconcile) return;
    let list = [];
    try { list = (allAgents ? allAgents() : null) || []; } catch (_) { list = []; }
    if (!list.length) { const hero = resolveAgent('agent'); if (hero) list = [hero]; }   // no roster hook → at least the hero
    for (const ag of list) { if (ag && ag.stats) { try { ag.stats = Xp.reconcile(ag.stats).stats; } catch (_) {} } }
    if (station) { try { station = Xp.reconcile(station).stats; } catch (_) {} }
  }

  // Read a stable, paged snapshot of the durable sidecar run log. `through` freezes the first page's
  // server-clock horizon, while `beforeRunId` walks backward without losing runs beyond the API page cap.
  async function loadRunHistory(since, fetchFn) {
    const get = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!get) throw new Error('run history fetch unavailable');
    const rows = [];
    let cursor = '', snapshotAt = 0;
    for (let page = 0; page < 20; page++) {
      let url = '/api/runs?agent=*&limit=500&since=' + encodeURIComponent(String(since || 0));
      if (cursor) url += '&beforeRunId=' + encodeURIComponent(cursor) + '&through=' + encodeURIComponent(String(snapshotAt));
      const res = await get(url, { cache: 'no-store' });
      if (!res || !res.ok) throw new Error('run history HTTP ' + (res && res.status));
      const body = await res.json();
      if (!body || !Array.isArray(body.runs) || !Number.isFinite(body.snapshotAt)) throw new Error('invalid run history response');
      if (!snapshotAt) snapshotAt = body.snapshotAt;
      rows.push(...body.runs);
      const next = typeof body.nextCursor === 'string' ? body.nextCursor : '';
      if (!next) return { runs: rows, snapshotAt };
      if (next === cursor) throw new Error('run history cursor did not advance');
      cursor = next;
    }
    throw new Error('run history exceeded pagination bound');
  }

  async function syncRunHistory(since, loader) {
    let snapshot;
    try { snapshot = await (loader ? loader(since) : loadRunHistory(since)); }
    catch (e) { console.warn('[xp] run history catch-up', e); return { applied: 0, failed: true }; }
    const rows = snapshot && Array.isArray(snapshot.runs) ? snapshot.runs.slice() : [];
    const snapshotAt = snapshot && Number.isFinite(snapshot.snapshotAt) ? snapshot.snapshotAt : 0;
    if (!snapshotAt) return { applied: 0, failed: true };
    rows.sort((a, b) => (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0));
    let applied = 0, credentialChanged = false;
    const touched = new Set();
    for (const row of rows) {
      if (!row || isInternalRun(row) || !row.runId || !row.agentId) continue;
      const result = onEvent('agent.run.end', {
        agentId: String(row.agentId), runId: String(row.runId), reason: row.clarifying ? 'clarifying' : String(row.reason || 'error'),
        turns: Number(row.turns) || 0, tokens: Number(row.tokens) || 0, usd: Number(row.usd) || 0,
        _historyToolsOk: Math.max(0, Number(row.toolsOk) || 0)
      }, { silent: true, noPersist: true });
      if (!result || !result.applied) continue;
      applied++;
      credentialChanged = credentialChanged || result.credentialChanged;
      touched.add(result.agentId);
    }
    // Everything in this frozen snapshot now sits behind the watermark, so its run receipts are no longer
    // needed for future boots. Retain only receipts for concurrent live runs that were not in the snapshot.
    const checkpointed = new Set(rows.filter(r => r && r.runId).map(r => String(r.runId)));
    const compact = stats => {
      if (stats && stats.receipts && Array.isArray(stats.receipts.runs)) {
        stats.receipts.runs = stats.receipts.runs.filter(id => !checkpointed.has(String(id)));
      }
    };
    compact(station);
    let roster = [];
    try { roster = (allAgents ? allAgents() : null) || []; } catch (_) { roster = []; }
    for (const a of roster) compact(a && a.stats);
    station.runSyncAt = snapshotAt;
    for (const id of touched) { const a = resolveAgent(id); if (a) pushToWorld(a); }
    pushTopbar();
    if (touched.size) refreshCrewLevel();
    if (credentialChanged) { try { credentialFn(); } catch (_) {} }
    try { persistFn(); } catch (_) {}
    return { applied, snapshotAt };
  }

  function isInternalRun(row) {
    if (!row) return false;
    if (row.internal) return true;
    const streamId = String(row.streamId || '');
    return ['nightshift-', 'nightshift-act-', 'cron-', 'workshop-'].some(prefix => streamId.indexOf(prefix) === 0);
  }

  // Rating history mirrors run-history pagination, but carries the server-canonical feedback entries.
  async function loadRatingHistory(since, fetchFn) {
    const get = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!get) throw new Error('rating history fetch unavailable');
    const rows = [];
    let cursor = '', snapshotAt = 0;
    for (let page = 0; page < 20; page++) {
      let url = '/api/growth/ratings?limit=500&since=' + encodeURIComponent(String(since || 0)) + '&epoch=' + encodeURIComponent(String(growthEpoch()));
      if (cursor) url += '&beforeRunId=' + encodeURIComponent(cursor) + '&through=' + encodeURIComponent(String(snapshotAt));
      const res = await get(url, { cache: 'no-store' });
      if (!res || !res.ok) throw new Error('rating history HTTP ' + (res && res.status));
      const body = await res.json();
      if (!body || !Array.isArray(body.ratings) || !Number.isFinite(body.snapshotAt)) throw new Error('invalid rating history response');
      if (!snapshotAt) snapshotAt = body.snapshotAt;
      rows.push(...body.ratings);
      const next = typeof body.nextCursor === 'string' ? body.nextCursor : '';
      if (!next) return { ratings: rows, snapshotAt };
      if (next === cursor) throw new Error('rating history cursor did not advance');
      cursor = next;
    }
    throw new Error('rating history exceeded pagination bound');
  }

  async function syncRatingHistory(since, loader) {
    let snapshot;
    try { snapshot = await (loader ? loader(since) : loadRatingHistory(since)); }
    catch (e) { console.warn('[xp] rating history catch-up', e); return { applied: 0, failed: true }; }
    const ratings = snapshot && Array.isArray(snapshot.ratings) ? snapshot.ratings.slice() : [];
    const snapshotAt = snapshot && Number.isFinite(snapshot.snapshotAt) ? snapshot.snapshotAt : 0;
    if (!snapshotAt) return { applied: 0, failed: true };
    ratings.sort((a, b) => (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0));
    let applied = 0, credentialChanged = false;
    const touched = new Set();
    for (const rating of ratings) for (const entry of ((rating && rating.entries) || [])) {
      const result = onEvent('memory.feedback', entry, { silent: true, noPersist: true });
      if (!result || !result.applied) continue;
      applied++; credentialChanged = credentialChanged || result.credentialChanged; touched.add(result.agentId);
    }
    station.ratingSyncAt = snapshotAt;
    for (const id of touched) { const a = resolveAgent(id); if (a) pushToWorld(a); }
    pushTopbar();
    if (touched.size) refreshCrewLevel();
    if (credentialChanged) { try { credentialFn(); } catch (_) {} }
    try { persistFn(); } catch (_) {}
    return { applied, snapshotAt };
  }

  // Persist the verdict first, then fold only the server-returned canonical entries. A duplicate may still
  // repair a browser projection that missed the original acknowledgement; Xp receipts make that replay safe.
  async function recordWorkRating(rating, fetchFn) {
    const post = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!post) return { ok: false, error: 'rating service unavailable' };
    let res, body;
    try {
      res = await post('/api/growth/ratings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, rating || {}, { epoch: growthEpoch() }))
      });
      body = res ? await res.json() : null;
    } catch (_) { body = null; }
    if (!res || !res.ok || !body || !body.ok || !body.rating || !Array.isArray(body.rating.entries)) {
      const status = Number(res && res.status) || 0;
      const reason = String(body && body.error || '');
      // Read rejected responses too. Keep UI copy actionable without exposing arbitrary storage paths.
      let error = 'Rating was not saved — try again.';
      if (!res) error = 'Cannot reach the rating service — try again.';
      else if (reason === 'station generation changed; reload before rating') error = 'Station changed — reload the app before rating this work.';
      else if (reason === 'rateable run not found') error = 'This task is not in the saved run history, so it cannot be rated.';
      else if (reason === 'run did not produce rateable agent work') error = 'This task did not finish with rateable work.';
      else if (status === 401 || status === 403) error = 'Rating connection was rejected — reload the app and try again.';
      else if (status === 503 || (body && body.growthUnavailable)) error = 'Rating history is unavailable — try again after restarting the app.';
      else if (status >= 500) error = 'The rating service could not save this rating — try again.';
      return { ok: false, error, status };
    }
    let applied = false;
    for (const entry of body.rating.entries) {
      const result = onEvent('memory.feedback', entry, { noPersist: true });
      applied = !!(result && result.applied) || applied;
    }
    station.ratingSyncAt = Math.max(Number(station.ratingSyncAt) || 0, Number(body.rating.ts) || 0);
    try { persistFn(); } catch (_) {}
    return { ok: true, duplicate: !!body.duplicate, applied, rating: body.rating };
  }

  function init(opts) {
    opts = opts || {};
    if (opts.getAgent) getAgent = opts.getAgent;
    if (opts.agents) allAgents = opts.agents;                  // S4: the whole registry, so a specialist's case is reconciled too
    if (opts.persist) persistFn = opts.persist;
    if (opts.onCredential) credentialFn = opts.onCredential;   // S3: app.js re-pushes the roster so the dispatch briefing stays true
    // resumed rollup from the save, else a fresh one. NB: fall back to fresh (not the prior in-memory
    // station) so creating a NEW agent mid-session doesn't inherit the previous colony's XP.
    station = (opts.station && typeof opts.station === 'object') ? opts.station : (typeof Xp !== 'undefined' ? Xp.fresh() : null);
    const a = resolveAgent('agent');
    if (a && !a.stats && typeof Xp !== 'undefined') a.stats = Xp.fresh();   // seed new OR migrated-but-empty agents
    reconcileTrophies();   // …then light whatever the record already earned, before anything renders it
    pushToWorld(a);
    pushTopbar();
    if (!wired && typeof U !== 'undefined' && U.bus) {
      for (const n of FEED) U.bus.on(n, p => { try { onEvent(n, p); } catch (e) { console.warn('[xp]', n, e); } });
      wired = true;
    }
    const since = Number(opts.syncSince);
    const ratingSince = Number(opts.syncRatingsSince);
    if (station && Number.isFinite(since) && since > 0 && !Number.isFinite(Number(station.runSyncAt))) station.runSyncAt = since;
    if (station && Number.isFinite(ratingSince) && ratingSince > 0 && !Number.isFinite(Number(station.ratingSyncAt))) station.ratingSyncAt = ratingSince;
    const runSync = Number.isFinite(since) && since > 0 ? syncRunHistory(since, opts.loadRuns) : Promise.resolve({ applied: 0, skipped: true });
    return runSync.then(run => {
      const ratingSync = Number.isFinite(ratingSince) && ratingSince > 0
        ? syncRatingHistory(ratingSince, opts.loadRatings)
        : Promise.resolve({ applied: 0, skipped: true });
      return ratingSync.then(ratings => ({ applied: (run.applied || 0) + (ratings.applied || 0), run, ratings, failed: !!(run.failed || ratings.failed) }));
    });
  }

  // the station-wide rollup, included in the save envelope by App.persist()
  function stationStats() { return station; }

  return { init, stationStats, onEvent, loadRunHistory, syncRunHistory, loadRatingHistory, syncRatingHistory, recordWorkRating };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { XpStore };
