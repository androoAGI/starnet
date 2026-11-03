/* sidecar/routing/line-stats.js — the PER-LINE numbers the floor's INBOX plate and the Workflow panel header show
   ("watch your factory work", line watch 2026-09-23), folded from the durable run rows. Server truth only:

     • runs     — run rows stamped with this line (runstore `lineId`, set by the host that dispatched the run: hub
                  entry/hop, routine entry/hop, step test) that FINISHED since the caller's `since` (its local
                  midnight — the same window the station's SHIPPED TODAY counter polls /api/runs with).
     • shipped  — durable terminal-job receipts minted when the chain actually reaches its OUTBOX.
                  Productive work (successful tools/artifacts) and clean run outcomes are checked at that moment.
                  Every job counts once; later floor edits cannot rewrite its history. No receipt = no claim. Receipts
                  are kept for the retention window (line-shipments SHIPMENT_KEEP_MS): SHIPPED counts those inside it.
                  An unreadable receipt history makes it null (unknown, never 0) with shippedUnknown = why, on the answer
                  and on each line; every other number still counts. A window the history may be missing jobs from (the
                  newest-SHIPMENT_KEEP_MAX cap bound inside it, or a job shipped past the in-memory hold while the history
                  was unreadable — o.shipmentsMissedAt) answers its count with shippedAtLeast: true — a lower bound.
     • failed   — the dead runs (reason error / refusal / max_iters / budget: the set the floor turns into slag) whose outcome FAILED.
     • unfinished — the rest of that dead-run set: a refused run, one a spend cap or a step limit ended (review 9.3: each was counted
                  FAILED, and the bay lamp lit FAILED · BUDGET in the failure red — the floor says them in their own word).
     • medianMs — the median recorded durationMs of those runs (null with no timed run).
     • tests    — step-through test / try-this-step hops (run rows the host stamped stepTest). A test is NOT a job:
                  it is counted here and never in runs / shipped / failed / medianMs (sweep 2026-09-25). Its $ is in
                  usdToday — tests are real runs that count against the LINE BUDGET.
     • usdToday / capUsdPerDay — the LINE BUDGET ledger (line-spend.js, the $ the daily cap is enforced against)
                  and the line's clamped maxUsdPerDay (null = no daily cap set). The ledger's day is the UTC day
                  index it enforces by; `spendDay: 'utc'` says so rather than pretending it is the local day — on the
                  answer AND on every line entry, so a consumer holding one line still knows which day its $ is.
   Plus `docks`: each bay's LAST recorded outcome (newest row stamped with that dockId, any day), which is what a
   bay lamp reads after a reload to stay FAILED until the next success.

   PURE (sidecar determinism law): no clock, no I/O — the route passes rows (newest-first), the plan's lines and
   the ledger/limits readers. Never throws on a malformed row; a row it cannot read is skipped, never guessed. */
'use strict';

const { cleanShipments, provenWork, SHIPMENT_KEEP_MAX } = require('./line-shipments.js');
const FAILED_REASONS = ['error', 'refusal', 'max_iters', 'budget'];
const FAILED = new Set(FAILED_REASONS);

// TYPED OUTCOMES: a row shipped only when its outcome SUCCEEDED; it failed when its outcome is a failure — the same four
// FAILED_REASONS for an old row, and a 'done' end an error the run raised outranks (frontend/app/runoutcome.js)
const RunOutcome = require('../../frontend/app/runoutcome.js');
const FAILED_OUTCOMES = new Set(['failed', 'refused', 'out_of_budget', 'step_limit']);
const shippedRow = r => !!r && RunOutcome.ofRow(r).ok && provenWork(r);
const failedRow = r => !!r && (FAILED.has(r.reason) || FAILED_OUTCOMES.has(RunOutcome.ofRow(r).outcome));
// review 9.3: a dead row that did not FAIL (a refusal, a spend cap, a step limit) is counted apart: the line's FAILED is failures alone
const unfinishedRow = r => failedRow(r) && RunOutcome.ofRow(r).outcome !== 'failed';
const fin = v => (typeof v === 'number' && isFinite(v)) ? v : null;

function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/* lineStats({ rows, lines, since, spentToday(lineId)->$, capOf(lineId)->$|null, shipments:[terminal-job receipts], shippedUnknown?:why,
               shipmentsMissedAt?:ms — the newest time a productive job shipped without a receipt (line-shipments missedAt) })
     rows  — run rows NEWEST-FIRST (runStore.list order); may span more than `since` (older rows only feed `docks`)
     lines — the compiled plan's line list ([{ lineId, propIds? }]); a line with no runs still answers zeros
   -> { since, spendDay: 'utc', lines: [{ lineId, runs, shipped, failed, unfinished, tests, medianMs, usdToday, capUsdPerDay, spendDay }], docks } */
function lineStats(o) {
  o = o || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const since = fin(o.since) || 0;
  const spentToday = typeof o.spentToday === 'function' ? o.spentToday : () => 0;
  const capOf = typeof o.capOf === 'function' ? o.capOf : () => null;
  const byLine = new Map();
  for (const l of (Array.isArray(o.lines) ? o.lines : [])) {
    const id = l && l.lineId != null ? String(l.lineId) : '';
    if (id && !byLine.has(id)) byLine.set(id, { lineId: id, runs: 0, shipped: 0, failed: 0, unfinished: 0, tests: 0, _ms: [] });
  }
  const docks = {};
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    // the bay's LAST outcome: rows are newest-first, so the first row stamped with a dock is its latest run. Its reason is the
    // outcome-aware RunOutcome.reasonOf (review 4.3: a bay the provider cut read 'done' beside failed:false, exactly as a succeeded
    // one — station.layout / station.map told the lead it finished), and the row's outcome code rides beside it (additive)
    if (r.dockId && !docks[r.dockId] && r.runId) {
      docks[r.dockId] = { runId: String(r.runId), agentId: r.agentId || null, reason: RunOutcome.reasonOf(r), outcome: RunOutcome.ofRow(r).outcome, failed: failedRow(r), ts: fin(r.ts) };
    }
    const ts = fin(r.ts);
    if (!r.lineId || ts == null || ts <= since) continue;
    const L = byLine.get(String(r.lineId));
    if (!L) continue;   // a line that is no longer on the floor has no plate to feed
    if (r.stepTest === true) { L.tests++; continue; }   // a test hop is not a job the line ran, shipped or failed
    L.runs++;
    if (unfinishedRow(r)) L.unfinished++;
    else if (failedRow(r)) L.failed++;
    const ms = fin(r.durationMs);
    if (ms != null && ms > 0) L._ms.push(ms);
  }
  /* SHIPPED UNKNOWN (runtime audit 2026-10-12): the host says the receipt history could not be read (o.shippedUnknown = why).
     Then SHIPPED is null on every line, with the reason — never 0 (that is "no receipts", a different fact) — and every other
     number still counts: none of them depends on the receipts. Absent shipments without the flag answer 0, as before. */
  const unknown = (typeof o.shippedUnknown === 'string' && o.shippedUnknown.trim()) ? o.shippedUnknown.trim().slice(0, 240) : null;
  /* AT LEAST (runtime repair 2026-10-12): a receipt that may be missing from this window makes every line's SHIPPED a lower bound —
     the history at its count cap whose oldest receipt is newer than `since` (anything the cap dropped is older than that receipt,
     maybe still inside the window), or a job that shipped past the hold while the history could not be read, inside the window.
     Which line it belonged to is not known, so every line says so; the count itself is still every receipt that IS there. */
  let atLeast = false;
  if (!unknown) {
    const list = cleanShipments(o.shipments);
    for (const receipt of list) {
      const L = byLine.get(receipt.lineId);
      if (L && receipt.at > since) L.shipped++;
    }
    const oldest = list.reduce((m, r) => (m == null || r.at < m ? r.at : m), null);
    const missed = fin(o.shipmentsMissedAt);
    atLeast = (list.length >= SHIPMENT_KEEP_MAX && oldest != null && oldest > since) || (missed != null && missed > since);
  }
  const lines = [];
  for (const L of byLine.values()) {
    let usd = 0, cap = null;
    try { usd = fin(spentToday(L.lineId)) || 0; } catch (_) { usd = 0; }
    try { const c = fin(capOf(L.lineId)); cap = (c != null && c > 0) ? c : null; } catch (_) { cap = null; }
    const line = { lineId: L.lineId, runs: L.runs, shipped: unknown ? null : L.shipped, failed: L.failed, unfinished: L.unfinished, tests: L.tests, medianMs: median(L._ms), usdToday: Math.round(usd * 1e6) / 1e6, capUsdPerDay: cap, spendDay: 'utc' };
    if (unknown) line.shippedUnknown = unknown;   // on each line too, the way spendDay rides both: a consumer holding one line knows why
    if (atLeast) line.shippedAtLeast = true;
    lines.push(line);
  }
  const answer = { since, spendDay: 'utc', lines, docks };
  if (unknown) answer.shippedUnknown = unknown;
  if (atLeast) answer.shippedAtLeast = true;
  return answer;
}

module.exports = { lineStats, median, shippedRow, failedRow, FAILED_REASONS };
