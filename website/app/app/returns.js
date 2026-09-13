/* STARNET — returns.js : the RETURN RITUAL engine (Game session, Phase G2 / Layer 5).

   Pure decision logic for the "while you were away" loop: which finished runs count as UNATTENDED
   WORK the Commander hasn't collected yet, the durable lastSeenAt heartbeat that defines "away",
   and the pending-crate ledger the OUTBOX renders from. No IO, no clock, no DOM — the caller
   (returnstore.js) owns localStorage + fetch + the live beat; node tests drive this directly.

   HONESTY RULES (Part 4 laws):
     • A digest row is a REAL run row from the sidecar's append-only run history (/api/runs) —
       never synthesized, never padded. reason 'done' only: a max_iters/budget/error run is SLAG
       and already has its own post-mortem path.
     • "Away" is defined by the persisted lastSeenAt heartbeat. A FRESH state (lastSeenAt 0 —
       first ever session) digests NOTHING: no prior attendance means nothing was missed.
     • Once a run is folded, its pending crate prevents re-listing; after rating, its compact digested id
       preserves that guarantee. Dismissed = gone from the digest, not from the OUTBOX. The ledger cap
       matches the sidecar's complete in-memory history
       horizon, so the display cap can never silently discard a rateable run. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Returns = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIGEST_CAP = 8;       // visual morning-summary cap only; every eligible row is still crated below
  const PENDING_CAP = 10000;  // equals runstore RAM/history replay horizon: no hidden 24-run loss boundary
  const DIGESTED_CAP = 10000;
  const TITLE_MAX = 90;

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }

  // hydrate a persisted blob (or null/corrupt) into a sane state object.
  function hydrate(raw) {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const pending = Array.isArray(s.pending) ? s.pending.filter(r => r && typeof r === 'object' && r.runId).slice(0, PENDING_CAP) : [];
    const pendingIds = new Set(pending.map(r => String(r.runId)));
    return {
      v: 1,
      lastSeenAt: Math.max(0, num(s.lastSeenAt)),
      // Unacknowledged CLOSED intervals survive attendance heartbeats and interrupted catch-up reads.
      awayRanges: Array.isArray(s.awayRanges) ? s.awayRanges.filter(r => r && num(r.since) > 0 && num(r.until) >= num(r.since)).map(r => ({ since: r.since, until: r.until })) : [],
      pending,
      // A pending row itself is the anti-relist proof; retaining its id here as well only doubles storage.
      digested: Array.isArray(s.digested) ? s.digested.filter(id => typeof id === 'string' && id && !pendingIds.has(id)).slice(-DIGESTED_CAP) : []
    };
  }

  // the attendance stamp — monotonic (a stale timer tick can never move it backwards).
  function heartbeat(state, nowMs) {
    const s = hydrate(state);
    s.lastSeenAt = Math.max(s.lastSeenAt, num(nowMs));
    return s;
  }

  /* unattended(state, runs, sinceMs?) -> digest rows.
     runs = /api/runs rows (newest-first): { runId, agentId, reason, turns, tokens, usd, title, ts, model }.
     Filters: finished clean ('done'), landed AFTER the away boundary, not already digested, not
     already pending. sinceMs is the PREVIOUS session's lastSeenAt, passed explicitly because the
     caller has usually already heartbeat-ed the live state to "now" (using the live stamp would
     filter everything out — the bug the explicit boundary exists to prevent). Defaults to the
     state's own lastSeenAt for callers that compute before stamping. Boundary 0 (first-ever
     session) -> [] always: no prior attendance means nothing was "missed". */
  function unattended(state, runs, sinceMs) {
    const s = hydrate(state);
    const since = (typeof sinceMs === 'number' && isFinite(sinceMs)) ? Math.max(0, sinceMs) : s.lastSeenAt;
    if (since <= 0) return [];                             // first-ever session: nothing was "missed"
    if (!Array.isArray(runs)) return [];
    const digested = {}; for (const id of s.digested) digested[id] = true;
    const pending = {}; for (const r of s.pending) pending[r.runId] = true;
    const out = [];
    for (const r of runs) {
      if (!r || typeof r !== 'object') continue;
      if (r.internal) continue;                           // recommendation reasoning is not work to collect/rate
      const runId = str(r.runId); if (!runId) continue;
      if (r.reason !== 'done') continue;                   // slag has its own post-mortem path
      if (num(r.ts) <= since) continue;                    // happened while attended (or before)
      if (digested[runId] || pending[runId]) continue;     // once listed, never re-listed
      out.push({
        runId: runId,
        agentId: str(r.agentId) || 'agent',
        title: str(r.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX),
        routine: '',                                       // matchRoutines() fills this best-effort
        usd: Math.max(0, num(r.usd)),
        turns: Math.max(0, num(r.turns)),
        ts: num(r.ts),
        streamId: str(r.streamId)                          // joins the crate to its readable transcript session
      });
    }
    return out;
  }

  // best-effort routine naming: a cron-fired run's recorded title IS the job's prompt (the tick
  // driver sends the prompt as the user message), so a whitespace-normalized match names the row.
  // Purely cosmetic — an unmatched row keeps its honest title.
  function matchRoutines(rows, jobs) {
    if (!Array.isArray(rows) || !Array.isArray(jobs) || !jobs.length) return rows || [];
    const norm = t => str(t).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
    const byPrompt = {};
    for (const j of jobs) { if (j && j.prompt && j.name) byPrompt[norm(j.prompt)] = str(j.name); }
    for (const r of rows) { const hit = byPrompt[norm(r.title)]; if (hit) r.routine = hit; }
    return rows;
  }

  // Fold freshly-digested rows onto the pending ledger. Pending is itself the anti-relist proof; the compact
  // digested id ring is populated only when a crate resolves, avoiding two copies of every unattended run.
  function fold(state, rows) {
    const s = hydrate(state);
    for (const r of (rows || [])) {
      if (!r || !r.runId) continue;
      if (s.digested.indexOf(r.runId) !== -1) continue;
      if (!s.pending.some(p => p.runId === r.runId)) s.pending.push(r);
    }
    if (s.digested.length > DIGESTED_CAP) s.digested = s.digested.slice(-DIGESTED_CAP);
    while (s.pending.length > PENDING_CAP) s.pending.shift();
    return s;
  }

  // a crate was collected (the run got its rating) — drop it from the pending ledger.
  function resolve(state, runId) {
    const s = hydrate(state);
    s.pending = s.pending.filter(p => p.runId !== runId);
    if (runId && s.digested.indexOf(runId) === -1) s.digested.push(runId);
    if (s.digested.length > DIGESTED_CAP) s.digested = s.digested.slice(-DIGESTED_CAP);
    return s;
  }

  function pendingCount(state) { return hydrate(state).pending.length; }
  function oldestPending(state) { const s = hydrate(state); return s.pending.length ? s.pending[0] : null; }

  return { hydrate, heartbeat, unattended, matchRoutines, fold, resolve, pendingCount, oldestPending, DIGEST_CAP, PENDING_CAP };
});
