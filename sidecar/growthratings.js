/* sidecar/growthratings.js - durable, idempotent Commander work verdicts.

   A browser save is a projection, not the source of truth for acknowledged feedback. This append-only
   ledger records the canonical rating once per run so XP can be replayed after a stale tab, crash, or
   restored backup. Pure given injected IO/clock; the host owns fsync and HTTP validation. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).growthratings = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERDICTS = new Set(['great', 'ok', 'miss']);
  const SIZES = new Set(['small', 'medium', 'large']);
  const AGENT_RX = /^[A-Za-z0-9_-]{1,40}$/;
  const RUN_MAX = 100;
  const ENTRY_MAX = 64;
  const RAM_ROWS_MAX = 10000;
  function str(v) { return v == null ? '' : String(v); }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  function normalize(raw, ts) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const runId = str(raw.runId).trim().slice(0, RUN_MAX);
    const verdict = str(raw.verdict).trim();
    const epoch = Math.max(1, Math.floor(num(raw.epoch)) || 1);
    if (!runId || !VERDICTS.has(verdict) || !Array.isArray(raw.entries) || !raw.entries.length) return null;
    const entries = [];
    const seen = new Set();
    for (const value of raw.entries) {
      if (entries.length >= ENTRY_MAX) break;
      const e = value && typeof value === 'object' ? value : {};
      const agentId = str(e.agentId).trim();
      const id = str(e.id).trim().slice(0, 180);
      const delta = Math.max(0, Math.min(10, Math.round(num(e.delta))));
      const size = str(e.size).trim();
      const baseId = 'work:' + runId;
      if (!AGENT_RX.test(agentId) || (id !== baseId && id !== baseId + ':' + agentId) || seen.has(agentId)) continue;
      seen.add(agentId);
      entries.push({ agentId, id, runId, delta, reason: 'work_' + verdict, size: SIZES.has(size) ? size : undefined });
    }
    if (!entries.length) return null;
    return { epoch, runId, verdict, entries, ts: Math.max(1, num(ts) || num(raw.ts) || 1) };
  }

  function workSize(run) {
    const tools = Math.max(0, Number(run && run.toolsOk) || 0);
    const usd = Math.max(0, Number(run && run.usd) || 0);
    if (tools >= 6 || usd >= 0.5) return 'large';
    if (tools >= 3 || usd >= 0.08) return 'medium';
    return 'small';
  }

  // Derive attribution exclusively from durable run facts. Browser-supplied deltas/crew are hints at most.
  // A Commander verdict has ONE fixed value: tool count, artifacts, tokens, and spend describe execution shape,
  // not value. Named child run records prove participation; every proven contributor receives the same verdict
  // delta. Size remains legacy receipt telemetry only and never changes XP.
  function deriveRating(run, children, verdict) {
    if (!run || !run.runId || !AGENT_RX.test(str(run.agentId)) || !VERDICTS.has(str(verdict))) return null;
    const runId = str(run.runId).slice(0, RUN_MAX), leadId = str(run.agentId);
    const verdictDelta = 3;
    const entries = [{ agentId: leadId, id: 'work:' + runId, delta: verdictDelta, size: workSize(run) }];
    const byAgent = new Map();
    for (const child of (Array.isArray(children) ? children : [])) {
      const agentId = str(child && child.agentId).trim();
      if (!AGENT_RX.test(agentId) || agentId === leadId || /^sub-/.test(agentId)) continue;
      byAgent.set(agentId, child);
    }
    for (const [agentId, child] of byAgent) {
      entries.push({ agentId, id: 'work:' + runId + ':' + agentId, delta: verdictDelta, size: workSize(child) });
    }
    return { runId, verdict: str(verdict), entries };
  }

  function makeGrowthRatings(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const ramMax = num(opts.ramMax) > 0 ? num(opts.ramMax) : RAM_ROWS_MAX;
    let loaded = [];
    let loadError = null;
    let bootCut = false;   // the bounded boot read dropped older lines (io.readAll() marks its array cutBefore)
    try {
      const raw = io.readAll();
      if (Array.isArray(raw)) for (const row of raw) { const clean = normalize(row, row && row.ts); if (clean) loaded.push(clean); }
      bootCut = !!(raw && raw.cutBefore === true);
    } catch (e) { loadError = e || new Error('rating history unavailable'); }
    const byRun = new Map();
    const keyFor = (epoch, runId) => String(epoch) + ':' + String(runId);
    // The served history window is bounded; first-wins authority is not. Build the decision index from every
    // durable row loaded at boot before trimming the query window, and retain it across in-process evictions.
    for (const row of loaded) if (!byRun.has(keyFor(row.epoch, row.runId))) byRun.set(keyFor(row.epoch, row.runId), row);
    /* WHAT THIS STORE MAY NOT HOLD (save-latch-kill: the station folds the ledger into a save instead of refusing it). The
       served window is bounded: rows evicted from RAM, and rows the bounded boot read cut off (io.readAll's cutBefore —
       every one older than the first row it kept), are not here. gapTs = the newest timestamp that may be missing; a fold
       from a watermark below it cannot prove it applied every rating, so it must not move that watermark (since()). */
    let gapTs = 0;
    let rows = loaded.length > ramMax ? loaded.slice(-ramMax) : loaded;
    if (loaded.length > ramMax) gapTs = Math.max(gapTs, loaded[loaded.length - ramMax - 1].ts);
    if (bootCut) gapTs = Math.max(gapTs, loaded.length ? loaded[0].ts - 1 : Infinity);

    function assertReady() {
      if (!loadError) return;
      const e = new Error('rating history unavailable');
      e.code = 'GROWTH_RATINGS_UNAVAILABLE';
      throw e;
    }

    function record(raw) {
      if (loadError) return { error: 'rating history unavailable', unavailable: true };
      const runId = str(raw && raw.runId).trim().slice(0, RUN_MAX);
      const epoch = Math.max(1, Math.floor(num(raw && raw.epoch)) || 1);
      const existing = byRun.get(keyFor(epoch, runId));
      if (existing) return { rating: existing, duplicate: true };
      // Strictly monotonic timestamps make `since` a lossless watermark even when two tabs rate in one ms.
      const rating = normalize(raw, Math.max(1, num(clock.now()), rows.length ? rows[rows.length - 1].ts + 1 : 1));
      if (!rating) return { error: 'invalid rating' };
      // Append first: a failed durable write must never be acknowledged or enter the RAM source of truth.
      try { io.append(rating); } catch (e) { return { error: (e && e.message) || 'rating persist failed' }; }
      rows.push(rating); byRun.set(keyFor(rating.epoch, rating.runId), rating);
      if (rows.length > ramMax) {
        const gone = rows.splice(0, rows.length - ramMax);
        if (gone.length) gapTs = Math.max(gapTs, gone[gone.length - 1].ts);
      }
      return { rating, duplicate: false };
    }

    function list(o) {
      assertReady();
      o = o || {};
      const limit = Math.max(1, num(o.limit) || 200);
      const since = Math.max(0, num(o.since));
      const through = Math.max(0, num(o.through));
      const beforeRunId = str(o.beforeRunId);
      const epoch = Math.max(1, Math.floor(num(o.epoch)) || 1);
      const out = [];
      let afterCursor = !beforeRunId;
      for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
        const row = rows[i];
        if (row.epoch !== epoch) continue;
        if (!afterCursor) { if (row.runId === beforeRunId) afterCursor = true; continue; }
        if (since && row.ts <= since) continue;
        if (through && row.ts > through) continue;
        out.push(row);
      }
      return out.map(r => JSON.parse(JSON.stringify(r)));
    }

    // every rating of the epoch newer than `since` (and not newer than `through`, when given), OLDEST first, and whether that
    // is provably ALL of them: complete only when nothing this store may lack (gapTs) is newer than `since`. The station's
    // growth fold (sidecar/growth-fold.js) moves a save's watermark only on a complete read — the strict read.
    function since(o) {
      assertReady();
      o = o || {};
      const from = Math.max(0, num(o.since));
      const through = Math.max(0, num(o.through));
      const epoch = Math.max(1, Math.floor(num(o.epoch)) || 1);
      const out = [];
      for (const row of rows) if (row.epoch === epoch && row.ts > from && (!through || row.ts <= through)) out.push(JSON.parse(JSON.stringify(row)));
      out.sort((a, b) => a.ts - b.ts);
      return { ratings: out, complete: !(gapTs > from) };
    }

    return {
      record, list, since,
      get(runId, epoch) { assertReady(); const row = byRun.get(keyFor(Math.max(1, Math.floor(num(epoch)) || 1), str(runId))); return row ? JSON.parse(JSON.stringify(row)) : null; },
      latestTs(epoch) {
        assertReady();
        const want = Math.max(1, Math.floor(num(epoch)) || 1);
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].epoch === want) return rows[i].ts;
        return 0;
      },
      count() { assertReady(); return rows.length; }
    };
  }

  return { makeGrowthRatings, normalize, deriveRating };
});
