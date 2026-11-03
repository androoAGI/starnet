/* Durable terminal-job receipts. A completed stage and a current belt path cannot
   prove a shipment: loops revisit stages and COPY branches meet before one output.
   Only the chain's OUTBOX callback may mint a receipt, backed by its exact run rows.
   Clock and persistence are injected; failed persistence never publishes a count. */
'use strict';
const { note: failNote } = require('../failopen.js');
// TYPED OUTCOMES: a shipped job's every step SUCCEEDED, by its run row's outcome (a provider-cut 'done' never ships)
const RunOutcome = require('../../frontend/app/runoutcome.js');
const id = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
// Match the floor identity grammar persisted by runstore, the receipt's proof authority.
const propId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const time = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const keyOf = r => JSON.stringify([r.lineId, r.entryRunId]);
/* PROVEN WORK — the one productive-work predicate (a successful tool, or an artifact): the receipt below and line-stats' shippedRow
   read this, so the tests and the receipts can never judge "productive" two ways (wave 2 review, conveyor-backend-11) */
const provenWork = r => Number(r && r.toolsOk) > 0 || (Array.isArray(r && r.artifacts) && r.artifacts.length > 0);
/* RETENTION (runtime audit 2026-10-12): SHIPPED counts receipts since the caller's local midnight, yet every shipment rewrote and
   re-validated the WHOLE history inside chain.advance, and nothing pruned it (50 000 receipts = 0.4-2 s per job). A save keeps
   BOTH bounds (runtime repair 2026-10-12 — an age alone still let a busy line hold ~50 000 receipts in 7 days):
     • the last 48 hours — any local midnight is under 25 hours back (a DST day included), the rest is clock slack; the stats
       route never reads a window older than this;
     • at most the newest SHIPMENT_KEEP_MAX receipts — every save is bounded (~60 ms at the cap, measured with the real domain
       store). When the cap has bound and a stats window starts before the oldest receipt kept, SHIPPED there is a LOWER BOUND
       and line-stats says so (shippedAtLeast) — never a count that quietly lost jobs.
   Pruning runs only after ensure() read a valid history, so an unreadable, corrupt or invalid file still refuses every write. */
const SHIPMENT_KEEP_MS = 48 * 60 * 60 * 1000;
const SHIPMENT_KEEP_MAX = 5000;
// receipts minted while the history could not be read, held in memory until it can (bounded: past it a job is not counted, and
// missedAt() says when the last such job shipped, so line-stats reports SHIPPED as a lower bound for a window that holds it)
const HELD_MAX = 500;
function keepWindow(list, at) {
  const recent = list.filter(x => x.at >= at - SHIPMENT_KEEP_MS);
  if (recent.length <= SHIPMENT_KEEP_MAX) return recent;
  // the newest by time (a stable sort keeps same-millisecond receipts in the order they were made)
  return recent.slice().sort((a, b) => a.at - b.at).slice(recent.length - SHIPMENT_KEEP_MAX);
}
const validReceipt = r => !!r && typeof r === 'object' && !Array.isArray(r) && propId(r.lineId) && id(r.entryRunId) && id(r.terminalRunId) && propId(r.outboxId) && time(r.at);
const receiptView = r => ({ lineId: r.lineId, entryRunId: r.entryRunId, terminalRunId: r.terminalRunId, outboxId: r.outboxId, at: r.at });
function cleanShipments(value) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(value) ? value : []) {
    if (!validReceipt(r)) continue;
    const key = keyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(receiptView(r));
  }
  return out;
}
// Persistence must not discard malformed evidence and later overwrite it with a
// guessed repair. Exact duplicate copies mean one receipt; conflicting copies
// of the same job cannot choose their own OUTBOX, terminal run or timestamp.
function validateShipments(value) {
  if (!Array.isArray(value)) throw new Error('shipment history is not an array');
  const out = [], seen = new Map();
  for (let i = 0; i < value.length; i++) {
    const r = value[i];
    if (!validReceipt(r)) throw new Error('shipment history has an invalid receipt at row ' + i);
    const clean = receiptView(r), key = keyOf(clean), previous = seen.get(key);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(clean)) throw new Error('shipment history has conflicting duplicate receipts at row ' + i);
      continue;
    }
    seen.set(key, clean); out.push(clean);
  }
  return out;
}
// Domain-store defaults are legitimate only for an absent file. Unreadable,
// corrupt and invalid reads carry [] too, but never authorize a replacement.
function loadShipmentReceipts(store) {
  const read = store.load();
  if (!read || !['ok', 'recovered', 'absent'].includes(read.status) || !Array.isArray(read.value)) {
    throw new Error('shipment history could not be read (' + ((read && read.status) || 'unknown') + ')');
  }
  return validateShipments(read.value);
}
/* THE CLEAN-JOB RULE — one predicate for the receipt below and for the chain's line-output authority (chain.js cleanJob), so
   the floor's released product, SHIPPED and SEND TO judge a job the same way. rows: run rows of the job's stream, NEWEST-FIRST
   (runStore order). The entry run is an exact boundary, including when adjacent jobs on the same channel started in the same
   millisecond. Returns the job's rows (entry onward) when every one of them ended `done`, is not a step test and carries a
   valid runId; otherwise null — never a guess (no stream, no entry row, a non-array). Pure. */
function cleanJobRows(rows, key) {
  const k = key || {};
  if (!Array.isArray(rows) || !id(k.entryRunId) || !id(k.streamId) || !propId(k.lineId)) return null;
  const entry = rows.findIndex(x => x && x.runId === k.entryRunId && x.streamId === k.streamId && x.lineId === k.lineId);
  if (entry < 0) return null;
  const job = rows.slice(0, entry + 1).filter(x => x && x.streamId === k.streamId && x.lineId === k.lineId);
  if (!job.length || job.some(x => x.stepTest === true || !RunOutcome.ofRow(x).ok || !id(x.runId))) return null;
  return job;
}
function makeLineShipments(options) {
  const o = options || {}, now = typeof o.now === 'function' ? o.now : () => 0;
  const load = typeof o.load === 'function' ? o.load : () => [];
  const save = typeof o.save === 'function' ? o.save : () => {};
  const runsFor = typeof o.runsFor === 'function' ? o.runsFor : () => [];
  let receipts = null;
  /* HELD (runtime repair 2026-10-12): a productive job that ships while the history cannot be read used to be dropped for good, so
     once the file was readable again SHIPPED showed a definite number that left it out. Its receipt is now held here and written by
     the first record() or snapshot() after a VALIDATED read (never over the unreadable bytes). Held in memory only: a restart
     before the history is readable again loses them, and the '?' tip says exactly that. */
  const held = [];
  let missedAt = null;
  function ensure() {
    if (!receipts) { try { receipts = validateShipments(load()); } catch (e) { failNote('line-shipments.load', e); throw e; } }
    return receipts;
  }
  function hold(receipt) {
    if (held.some(x => keyOf(x) === keyOf(receipt))) return;
    if (held.length >= HELD_MAX) {
      missedAt = Math.max(missedAt || 0, receipt.at);
      failNote('line-shipments.held', new Error('more than ' + HELD_MAX + ' shipments while the history could not be read: the rest are not counted'));
      return;
    }
    held.push(receipt);
  }
  // current + add (new keys only), kept to the window, persisted — or nothing changes and the cached authority is dropped
  function commit(current, add, at) {
    const have = new Set(current.map(keyOf)), fresh = [];
    for (const x of add) { const k = keyOf(x); if (!have.has(k)) { have.add(k); fresh.push(x); } }
    if (!fresh.length) return true;
    const next = keepWindow(current.concat(fresh), at);
    try { save(next); } catch (e) {
      // Main may already contain next even though its read-back failed. Re-load
      // authority before another write; an old cache could erase that commit.
      receipts = null; failNote('line-shipments.persist', e); return false;
    }
    receipts = next;
    return true;
  }
  function record(rec) {
    const r = rec || {}, at = now();
    if (!propId(r.lineId) || !id(r.entryRunId) || !id(r.streamId) || !propId(r.outboxId) || !id(r.agentId)
      || (r.dockId != null && !propId(r.dockId)) || !time(at)) return false;
    // a PARTIAL joined job (a COPY branch failed or never reached the JOINER — chain.js out.partial) is never a clean product, even
    // when every run row that exists ended done: a hop refused before it ran writes none (runtime repair 2026-10-12)
    if (r.partial) return false;
    // an UNAPPROVED job (a review loop used all its passes without the verdict it waits for — chain.js out.unapproved, GitHub #122) went
    // on to its OUTBOX, but SHIPPED counts clean work: nobody approved it, so it mints no receipt (it is still delivered, and says so)
    if (r.unapproved) return false;
    let current = null; try { current = ensure(); } catch (_) { current = null; }
    const key = keyOf(r);
    if (current && current.some(s => keyOf(s) === key)) return true;
    let rows;
    try { rows = runsFor(r.streamId); } catch (e) { failNote('line-shipments.runs', e); return false; }
    // the job's own rows, every one clean (the shared rule above — the chain's line-output authority reads the same one)
    const job = cleanJobRows(rows, r);
    if (!job) return false;
    // Keep the existing productive-work rule. Talk-only answers can be delivered
    // but do not manufacture SHIPPED work; one productive job counts once.
    if (!job.some(provenWork)) return false;
    const terminal = job.find(x => x.agentId === r.agentId && (!r.dockId || x.dockId === r.dockId));
    if (!terminal) return false;
    const receipt = { lineId: r.lineId, entryRunId: r.entryRunId, terminalRunId: terminal.runId, outboxId: r.outboxId, at };
    // unreadable: never written over — held until a validated read (true = persisted, so a held receipt answers false)
    if (!current) { hold(receipt); return false; }
    const ok = commit(current, held.concat([receipt]), at);
    if (ok) held.length = 0; else hold(receipt);
    return ok;
  }
  /* the PERSISTED history (an unreadable one throws: SHIPPED unknown). Held receipts are written first; one that still cannot be
     written (the save failing) is never published from memory — missedAt() then covers it, so SHIPPED reads as a lower bound. */
  function snapshot() {
    const current = ensure();
    if (held.length && commit(current, held.slice(), now())) held.length = 0;
    return cleanShipments(ensure());
  }
  // the newest time a productive job shipped that the saved history does not hold (still held, or past the hold), or null
  function missed() {
    let at = missedAt || 0;
    for (const r of held) if (r.at > at) at = r.at;
    return at || null;
  }
  /* DID THIS JOB COUNT IN SHIPPED? (rc walk #30, 2026-10-13: the Workflow panel said "✓ DELIVERED" beside "SHIPPED 0" — a
     text-only answer is delivered but, by the productive-work rule above, never a receipt). The job's own answer, read from
     the same receipts SHIPPED counts: true = its receipt is in the saved history, or held to be written once the history
     reads again (counted then) · false = the history was read and holds no receipt for it · null = the history cannot be
     read and nothing is held for it (unknown, never false). runIds: the job's run ids (any of them may be its entry run). */
  function jobShipped(lineId, runIds) {
    const ids = new Set((Array.isArray(runIds) ? runIds : []).map(String));
    if (!propId(lineId) || !ids.size) return null;
    const mine = r => r.lineId === lineId && ids.has(r.entryRunId);
    if (held.some(mine)) return true;
    let current;
    try { current = ensure(); } catch (_) { return null; }   // (ensure already noted why the history is unreadable)
    return current.some(mine);
  }
  return { record, snapshot, held: () => held.length, missedAt: missed, jobShipped };
}
module.exports = { cleanShipments, validateShipments, makeLineShipments, loadShipmentReceipts, cleanJobRows, provenWork, SHIPMENT_KEEP_MS, SHIPMENT_KEEP_MAX };
