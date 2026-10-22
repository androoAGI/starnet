/* AGENT OS — linewatch.js : "watch your factory work" (line watch, owner-approved 2026-09-23). PURE + testable.

   Three read-outs for the LIVE floor, each a fold of real harness state — never a guess:

   1. BAY STATUS (create().status) — the lamp every bound bay wears:
        WORKING  amber pulse — the sidecar CONFIRMED a run at THIS dock (agent.run.start paired with the
                 workitem.placed that named the dock; the same FIFO pairing basis the floor's ship logic uses).
                 Never claimed from a placement alone (the COMMS run-status honesty law).
        PAUSED   cyan — a step-through test is paused after this dock (the session's own answer).
        FAILED   red — the LAST run at this dock ended error / refusal / max_iters / budget, until the next
                 success there or the Commander acks it (click). Seeded after a reload from the server's
                 per-dock last outcome (GET /api/routing/lines/stats `docks`).
        WAITING  a crate is queued at this dock: placed, not yet started, while the agent is busy elsewhere (or
                 for a short grace right after placement). A placement whose run never starts is NOT shown as
                 waiting forever — that would be a lie about a queue the server no longer holds.
        IDLE     dim — none of the above.
      Priority: WORKING > PAUSED > FAILED > WAITING > IDLE.

   2. CRATE CARD (crateCard) — what a crate on a belt IS: the job, its line, where it came from / is going, the
      run working it (agent, live reconciled cost) or its recorded outcome. Only fields the harness proved; a
      crate whose run has not started says so.

   3. LINE PLATE text (plateLines / statsRow) — the per-line numbers from GET /api/routing/lines/stats.

   No DOM, no clock, no rng: the caller injects nowMs. A `LineWatch` global in the browser, module.exports in node. */
'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LineWatch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FAILED = { error: true, refusal: true, max_iters: true, budget: true };   // the floor's dead-run (slag) set
  const WAIT_GRACE_MS = 5000;      // a fresh placement reads WAITING briefly even when its agent is idle (dispatch lag)
  const PENDING_MAX = 16;          // per agent — bounded like every floor latch
  const PENDING_TTL_MS = 30 * 60 * 1000;
  const RUNS_MAX = 400;
  const ACK_MAX = 64;
  const str = v => (v == null ? '' : String(v));
  const fin = v => (typeof v === 'number' && isFinite(v)) ? v : null;

  function create(opts) {
    opts = opts || {};
    // entryDock(agentId) -> the dock unaddressed routed work for this agent enters at (plan.entryDock), used only
    // when a routed placement names no dock (an older event / a routine with no FIRES AT) — the router's own read.
    const entryDock = typeof opts.entryDock === 'function' ? opts.entryDock : () => null;
    const pending = new Map();   // agentId -> [{ workitemId, dockId, lineId, kind, steptest, t }] oldest first
    const runs = new Map();      // runId -> { runId, agentId, dockId, lineId, workitemId, steptest, startedAt, usd, error, ended }
    const liveAt = new Map();    // dockId -> Set(runId) running there now
    const lastOut = new Map();   // dockId -> { runId, agentId, reason, failed, at, error, seeded }
    const byWorkitem = new Map();// workitemId -> runId (the run that picked this crate up)
    const acked = [];            // runIds of failures the Commander cleared (bounded, oldest dropped)
    let step = null;             // { state, sessionId, lineId, pausedDock, runningDock }

    function dockFor(p) {
      if (p.dockId) return str(p.dockId);
      if (p.kind === 'directive') return null;   // a COMMS order is not work AT a dock
      const d = entryDock(str(p.agentId));
      return d ? str(d) : null;
    }
    function agentLive(aid) { for (const r of runs.values()) if (r.agentId === aid && !r.ended) return true; return false; }
    function trimRuns() {
      if (runs.size <= RUNS_MAX) return;
      for (const [k, r] of runs) { if (runs.size <= RUNS_MAX) break; if (r.ended) runs.delete(k); }
    }

    function onEvent(name, p, nowMs) {
      p = p || {};
      const now = fin(nowMs) || 0;
      if (name === 'workitem.placed') {
        const aid = str(p.agentId); if (!aid || !p.workitemId) return;
        const q = pending.get(aid) || [];
        if (q.some(x => x.workitemId === str(p.workitemId))) return;   // an echo (local + SSE) — one crate, one entry
        q.push({ workitemId: str(p.workitemId), dockId: dockFor(p), lineId: p.lineId ? str(p.lineId) : null, kind: str(p.kind), steptest: p.steptest ? str(p.steptest) : null, preview: p.preview ? str(p.preview).slice(0, 120) : null, t: now });
        while (q.length > PENDING_MAX) q.shift();
        pending.set(aid, q);
        return;
      }
      if (name === 'workitem.superseded') {
        const wid = str(p.workitemId);
        for (const [aid, q] of pending) { const i = q.findIndex(x => x.workitemId === wid); if (i >= 0) { q.splice(i, 1); if (!q.length) pending.delete(aid); } }
        return;
      }
      if (name === 'agent.run.start') {
        const rid = str(p.runId), aid = str(p.agentId);
        if (!rid || !aid || runs.has(rid)) return;   // observed twice (local harness + SSE echo)
        const q = pending.get(aid);
        // WHICH crate this run picked up (sweep 2026-09-25): the run start names its crate (workitemId) or its bay
        // (dockId) when the host knows it — an agent crewing two bays must light the bay it really works at, never the
        // bay of its oldest crate. Only a start that names neither falls back to the OLDEST placement for the agent.
        let wi = -1;
        if (q && q.length) {
          if (p.workitemId) wi = q.findIndex(x => x.workitemId === str(p.workitemId));
          if (wi < 0 && p.dockId) wi = q.findIndex(x => x.dockId === str(p.dockId));
          if (wi < 0) wi = 0;
        }
        const w = wi >= 0 ? q.splice(wi, 1)[0] : null;
        if (q && !q.length) pending.delete(aid);
        const rec = { runId: rid, agentId: aid, dockId: w ? w.dockId : null, lineId: w ? w.lineId : null, workitemId: w ? w.workitemId : null,
          steptest: w ? w.steptest : null, preview: w ? w.preview : null, startedAt: now, usd: 0, error: null, ended: null };
        runs.set(rid, rec);
        if (rec.workitemId) { byWorkitem.set(rec.workitemId, rid); if (byWorkitem.size > RUNS_MAX) byWorkitem.delete(byWorkitem.keys().next().value); }
        if (rec.dockId) { const s = liveAt.get(rec.dockId) || new Set(); s.add(rid); liveAt.set(rec.dockId, s); }
        trimRuns();
        return;
      }
      if (name === 'agent.cost') {
        const r = runs.get(str(p.runId)); const u = fin(p.usd);
        if (r && u != null && u > 0) r.usd += u;   // agent.cost is RECONCILED by contract — never an estimate
        return;
      }
      if (name === 'agent.run.error') {
        const r = runs.get(str(p.runId)); if (r && p.message) r.error = str(p.message).slice(0, 240);
        return;
      }
      if (name === 'agent.run.end') {
        const r = runs.get(str(p.runId));
        // a run the snapshot reconcile stood down ('unknown' — it was not listed live, e.g. mid provider-retry) still
        // reports its REAL end when it arrives: that end is the truth the lamp owes (sweep 2026-09-25 — a failed run
        // whose end was ignored left the bay IDLE instead of FAILED). Only a real end already recorded is final.
        if (!r || (r.ended && r.ended.reason !== 'unknown')) return;
        const reason = str(p.reason) || 'done';
        r.ended = { reason, at: now, usd: fin(p.usd), turns: fin(p.turns) };
        if (r.dockId) {
          const s = liveAt.get(r.dockId); if (s) { s.delete(r.runId); if (!s.size) liveAt.delete(r.dockId); }
          lastOut.set(r.dockId, { runId: r.runId, agentId: r.agentId, reason, failed: !!FAILED[reason], at: now, error: r.error, seeded: false });
        }
      }
    }

    /* the server's per-dock LAST outcome (lines/stats `docks`) — fills what this page never observed (a reload, a
       run that ended while the link was down). A locally observed end is never overwritten by an older answer. */
    function seedOutcomes(docks) {
      if (!docks || typeof docks !== 'object') return;
      for (const d of Object.keys(docks)) {
        const o = docks[d]; if (!o || !o.runId) continue;
        const cur = lastOut.get(d);
        if (cur && !cur.seeded) continue;          // the live floor saw a newer end itself
        if (liveAt.has(d)) continue;
        lastOut.set(d, { runId: str(o.runId), agentId: o.agentId || null, reason: str(o.reason), failed: !!o.failed, at: null, error: null, seeded: true });
      }
    }
    /* the snapshot reconcile (world.js): the server's live run ids. A run this page thinks is live that the server no
       longer lists ended while we were not looking — stop claiming WORKING (its outcome arrives via seedOutcomes). */
    function reconcileLive(liveRunIds, nowMs, graceMs) {
      if (!Array.isArray(liveRunIds)) return;
      const live = new Set(liveRunIds.map(str)), now = fin(nowMs), grace = fin(graceMs) || 0;
      for (const r of runs.values()) {
        if (r.ended || live.has(r.runId)) continue;
        if (now != null && now - r.startedAt < grace) continue;   // the snapshot may predate this run's start
        r.ended = { reason: 'unknown', at: null, usd: null, turns: null };
        if (r.dockId) { const s = liveAt.get(r.dockId); if (s) { s.delete(r.runId); if (!s.size) liveAt.delete(r.dockId); } }
      }
    }
    function ack(dockId) {
      const o = lastOut.get(str(dockId));
      if (!o || !o.failed || acked.indexOf(o.runId) >= 0) return false;
      acked.push(o.runId); while (acked.length > ACK_MAX) acked.shift();
      return true;
    }
    function setAcked(ids) { acked.length = 0; for (const id of (Array.isArray(ids) ? ids : []).slice(-ACK_MAX)) acked.push(str(id)); }
    /* a step-through session (GET /api/routing/steptest answer). Paused -> the dock that just finished holds PAUSED. */
    function setStepTest(s) {
      if (!s || typeof s !== 'object' || (s.state !== 'running' && s.state !== 'paused')) { step = null; return; }
      const hops = Array.isArray(s.hops) ? s.hops : [];
      const after = (s.paused && typeof s.paused.afterHop === 'number') ? hops[s.paused.afterHop] : null;
      step = { state: s.state, sessionId: str(s.id), lineId: s.lineId ? str(s.lineId) : null,
        pausedDock: (s.state === 'paused' && after && after.dockId) ? str(after.dockId) : null,
        runningDock: (s.running && s.running.dockId) ? str(s.running.dockId) : null };
    }

    function status(dockId, nowMs) {
      const d = str(dockId), now = fin(nowMs) || 0;
      const live = liveAt.get(d);
      if (live && live.size) {
        let r = null; for (const id of live) { const x = runs.get(id); if (x && (!r || x.startedAt < r.startedAt)) r = x; }
        if (r) return { state: 'working', runId: r.runId, agentId: r.agentId, since: r.startedAt, usd: r.usd, count: live.size };
      }
      if (step && step.pausedDock === d) return { state: 'paused', sessionId: step.sessionId, lineId: step.lineId };
      const o = lastOut.get(d);
      if (o && o.failed && acked.indexOf(o.runId) < 0) return { state: 'failed', runId: o.runId, agentId: o.agentId, reason: o.reason, error: o.error };
      let queued = 0, oldest = null;
      for (const [aid, q] of pending) for (const w of q) {
        if (w.dockId !== d || now - w.t > PENDING_TTL_MS) continue;
        if (!(agentLive(aid) || now - w.t < WAIT_GRACE_MS)) continue;
        queued++; if (!oldest || w.t < oldest.t) oldest = w;
      }
      if (queued) return { state: 'waiting', queued, since: oldest.t, workitemId: oldest.workitemId };
      return { state: 'idle' };
    }
    function runOfWorkitem(wid) { const id = byWorkitem.get(str(wid)); return id ? runs.get(id) || null : null; }
    function run(rid) { return runs.get(str(rid)) || null; }
    function lastOutcome(dockId) { return lastOut.get(str(dockId)) || null; }
    function ackedIds() { return acked.slice(); }
    function snapshot() {
      const p = {}; for (const [a, q] of pending) p[a] = q.map(x => x.workitemId + '@' + x.dockId);
      const l = {}; for (const [d, s] of liveAt) l[d] = [...s];
      const o = {}; for (const [d, x] of lastOut) o[d] = x.reason + (x.failed ? '!' : '');
      return { pending: p, live: l, last: o, step, acked: acked.slice() };
    }
    return { onEvent, seedOutcomes, reconcileLive, ack, setAcked, ackedIds, setStepTest, status, runOfWorkitem, run, lastOutcome, snapshot };
  }

  /* ---------- the crate card: which fields the harness can PROVE about one crate ----------
     payload — the crate's own payload (workitem.placed fields for inbound/handoff crates; world.js adds runId/
               agentId/dockId/lineId/reason to the product + slag crates it ships)
     ctx     — { run: LineWatch run record | null, row: the server's run row (GET /api/runs?runId=) | null,
                 nowMs, agentName(aid), dockName(dockId), lineName(lineId), usd(n) }
   -> { kind, title, rows: [[label, value]...], state, runBy: agentId|null, actions: { transcript: {agentId, runId}|null, workflow: {lineId, dockId, sessionId}|null } } */
  function crateCard(payload, ctx) {
    const p = payload || {}, c = ctx || {};
    const agentName = typeof c.agentName === 'function' ? c.agentName : (a => str(a).toUpperCase());
    const dockName = typeof c.dockName === 'function' ? c.dockName : (d => 'BAY ' + str(d));
    const lineName = typeof c.lineName === 'function' ? c.lineName : (l => typeof Pipeline !== 'undefined' && Pipeline.lineWord ? Pipeline.lineWord(l) : 'LINE ' + str(l));
    const usd = typeof c.usd === 'function' ? c.usd : (n => '$' + (+n || 0).toFixed(4));
    const run = c.run || null, row = c.row || null;
    const box = p.box || (p.outbound ? 'product' : 'ore');
    const handoff = !p.outbound && p.kind === 'chain';
    const kind = box === 'slag' ? 'FAILED RUN' : p.outbound ? 'FINISHED WORK' : handoff ? 'HANDOFF' : (p.steptest ? 'STEP TEST' : 'INBOUND JOB');
    const rows = [];
    // the crate's OWN text first (the redacted preview the sidecar placed it with), then the run's placement, then the
    // run row's title — skipping a hop's generic handoff header, which names the mechanism, not the job
    const rowTitle = row && row.title && !/^PIPELINE HANDOFF\b/i.test(String(row.title)) ? row.title : '';
    const title = str(p.preview || (run && run.preview) || rowTitle || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    rows.push([handoff ? 'CARRIES' : p.outbound ? 'WORKED ON' : 'JOB', title || (p.outbound ? 'the finished run' : 'no text recorded for this crate')]);
    const lineId = p.lineId || (run && run.lineId) || (row && row.lineId) || null;
    rows.push(['LINE', lineId ? lineName(lineId) : 'none — a direct order']);
    const dockId = p.dockId || (run && run.dockId) || (row && row.dockId) || null;
    let from, to;
    if (p.outbound) { from = dockId ? dockName(dockId) : (p.agentId ? agentName(p.agentId) : 'a bay'); to = box === 'slag' ? 'off the line (scrap)' : 'OUTBOX'; }
    else if (handoff) { from = p.fromDock ? dockName(p.fromDock) : (p.from ? agentName(p.from) : 'the upstream bay'); to = dockId ? dockName(dockId) : agentName(p.agentId); }
    else { from = p.kind === 'directive' ? 'COMMS (direct order)' : 'INBOX'; to = dockId ? dockName(dockId) : agentName(p.agentId); }
    rows.push(['ROUTE', from + ' ▸ ' + to]);
    let state = 'pending';
    const aid = (run && run.agentId) || (row && row.agentId) || p.agentId || null;
    const now = fin(c.nowMs) || 0;
    const ended = (row && row.reason) || (run && run.ended && run.ended.reason !== 'unknown' ? run.ended.reason : null);
    const rid = (run && run.runId) || (row && row.runId) || p.runId || null;
    if (!rid && !ended) {
      rows.push(['RUN', p.outbound ? 'run record not loaded' : 'not started yet — waiting at ' + to]);
    } else if (!ended) {
      state = 'running';
      const secs = run && fin(run.startedAt) != null ? Math.max(0, Math.round((now - run.startedAt) / 1000)) : null;
      rows.push(['RUN', agentName(aid) + ' · WORKING' + (secs != null ? ' ' + secs + 's' : '')]);
      rows.push(['COST', run && run.usd > 0 ? usd(run.usd) + ' so far (reconciled)' : 'no reconciled cost yet']);
    } else {
      state = FAILED[ended] ? 'failed' : 'done';
      const u = row && fin(row.usd) != null ? row.usd : (run && run.ended && fin(run.ended.usd) != null ? run.ended.usd : null);
      rows.push(['RUN', agentName(aid) + ' · ' + (FAILED[ended] ? 'FAILED (' + ended + ')' : ended.toUpperCase())
        + (row && fin(row.durationMs) ? ' · ' + (Math.round(row.durationMs / 100) / 10) + 's' : '')]);
      if (u != null) rows.push(['COST', usd(u)]);
      if (FAILED[ended]) {
        const why = (run && run.error) || (row && (row.error || [row.failureStage, row.failureCode].filter(Boolean).join(' · '))) || (p.postmortem ? str(p.postmortem) : '');
        rows.push(['WHY', why ? str(why).slice(0, 200) : 'the run ended ' + ended + ' — no reason recorded']);
      } else {
        const out = row && row.deliveryText ? str(row.deliveryText).replace(/\s+/g, ' ').trim() : '';
        rows.push(['RESULT', out ? out.slice(0, 160) + (out.length > 160 ? '…' : '') : 'recorded in the transcript']);
      }
    }
    const transcript = (rid && aid) ? { agentId: aid, runId: rid } : null;
    const sess = p.steptest || (run && run.steptest) || null;
    const workflow = (lineId || sess) ? { lineId: lineId || null, dockId: dockId || null, sessionId: sess } : null;
    // runBy: the agent the RUN row names — only once a run is proven (started or recorded), so the card's skin thumb
    // shows who WORKED it, never who a queued crate is merely addressed to
    const runBy = (rid || ended) && aid ? aid : null;
    return { kind, title, rows, state, runBy, actions: { transcript, workflow: sess ? workflow : null } };
  }

  /* ---------- the per-line numbers, as text ---------- */
  /* ONE MONEY FORMAT (walk 10-14: TODAY read '$0.000' beside a '$0.0001' job): the station's canonical spend formatter (util.js
     U.usd — sub-dime keeps 4 decimals, cents above) wherever it is loaded; the old 3-decimal form only where it is not (node). */
  const fmtUsd = n => (typeof U !== 'undefined' && U && typeof U.usd === 'function') ? U.usd(+n || 0) : '$' + ((+n || 0) >= 1 ? (+n).toFixed(2) : (+n || 0).toFixed(3));
  const fmtDur = ms => ms == null ? '—' : ms < 1000 ? ms + 'ms' : ms < 60000 ? (Math.round(ms / 100) / 10) + 's' : (Math.round(ms / 6000) / 10) + 'm';
  /* the INBOX plate text — null when the server has not answered for this line:
       [0] the one-line plate that sits on the floor at rest (the counts you watch move);
       [1] the $ + time line; [2] the whole reading in one line (the hover glance — never a window) */
  /* THE $ DAY IS SAID (2026-09-24): the line-spend ledger keeps the UTC day (line-stats spendDay:'utc') while the run
     counts beside it are the LOCAL day — a $ cell that just said TODAY claimed a window it does not read. When the
     server says spendDay 'utc', the $ is labelled (UTC). */
  const utcDay = s => !!(s && s.spendDay === 'utc');
  /* SHIPPED UNKNOWN (runtime audit 2026-10-12): the server answers shipped:null when the shipment history could not be read — an
     unknown count, never a 0 ("(null | 0)" printed 0 SHIPPED, the very lie the server stopped telling). ? at rest, why on the glance. */
  /* AT LEAST (runtime repair 2026-10-12): shippedAtLeast = the saved history may be missing jobs from today (more than it keeps, or
     shipped while it could not be read) — the count is a lower bound, read N+. */
  const shippedText = s => (s.shipped == null ? '?' : String(s.shipped | 0) + (s.shippedAtLeast ? '+' : ''));
  function plateLines(s) {
    if (!s || typeof s !== 'object') return null;
    const a = (s.runs | 0) + ' RUN' + ((s.runs | 0) === 1 ? '' : 'S') + ((s.tests | 0) > 0 ? ' · ' + (s.tests | 0) + ' TEST' + ((s.tests | 0) === 1 ? '' : 'S') : '') + ' · ' + shippedText(s) + ' SHIPPED · ' + (s.failed | 0) + ' FAILED';
    const day = utcDay(s) ? ' TODAY (UTC)' : ' TODAY';
    const b = fmtUsd(s.usdToday) + (s.capUsdPerDay != null ? ' / ' + fmtUsd(s.capUsdPerDay) : '') + day + (s.medianMs != null ? ' · ~' + fmtDur(s.medianMs) + '/RUN' : '');
    return [a, b, 'TODAY · ' + a + ' · ' + b.replace(day, utcDay(s) ? ' (UTC DAY)' : '') + (s.capUsdPerDay == null ? ' · NO DAILY CAP' : '') + (s.shipped == null ? ' · SHIPMENT HISTORY UNREADABLE' : '')];
  }
  // the Workflow panel header row: labelled cells
  function statsRow(s) {
    if (!s || typeof s !== 'object') return null;
    return [
      ['RUNS', String(s.runs | 0)], ['SHIPPED', shippedText(s)], ['FAILED', String(s.failed | 0)],
      // step tests are counted APART (they are not jobs) — shown only when there were some, since their $ is in $ TODAY
      ...((s.tests | 0) > 0 ? [['TESTS', String(s.tests | 0)]] : []),
      [utcDay(s) ? '$ TODAY (UTC)' : '$ TODAY', fmtUsd(s.usdToday) + (s.capUsdPerDay != null ? ' / ' + fmtUsd(s.capUsdPerDay) : ' · no cap')],
      ['MEDIAN', s.medianMs != null ? fmtDur(s.medianMs) + '/run' : '—']
    ];
  }
  // local midnight for a given epoch ms (the window the SHIPPED counter uses) — the caller passes Date.now()
  function localMidnight(epochMs) { const d = new Date(epochMs); d.setHours(0, 0, 0, 0); return d.getTime(); }

  return { create, crateCard, plateLines, statsRow, localMidnight, fmtUsd, fmtDur, FAILED, WAIT_GRACE_MS };
});
