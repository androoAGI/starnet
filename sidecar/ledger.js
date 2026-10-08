/* sidecar/ledger.js — the append-only spend logbook. One immutable line per finished run
   ({ runId, agentId, turns, usd, tokens, ts }), so cumulative spend survives restarts and can
   be questioned across runs/agents/days. This is the missing "cron spend ledger" the reference harness never
   had (parity study, hole #1) and the substrate budget.js governs over.

   PURE given its injected edges: `io` (the disk adapter — readAll/append, provided by the Node
   host) and `clock` (now()). No ambient time/IO here, so it passes lint-determinism and is
   testable headlessly with an in-memory io. The host owns the atomic file append.

   makeLedger({ io, clock, dayMs? }) -> {
     record({ runId, agentId, turns, usd, tokens }) -> entry,   // stamps ts, appends, returns it
     recordStrict({ runId, agentId, turns, usd, tokens }) -> entry, // same, but append failure throws
     unsettledRuns() -> receipt[], settleUnsettled(runId, usd, how?) -> entry,   // interrupted runs found at boot (io.unsettled);
                                  // how = 'entered' (default: the Commander typed the charge) | 'limit' (counted at its per-run limit)
     pendingRuns() -> int,        // runs this process dispatched whose spend is not booked yet
     all() -> entry[],            count() -> int,
     totalUsd() -> number,                                       // every recorded run, ever
     usdSince(ts) -> number,      usdForDay(now?) -> number,     // trailing `dayMs` window
     usdForRun(runId) -> number,  usdForAgent(agentId) -> number
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).ledger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const UNKNOWN_MODEL = '(unknown)';
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }

  function makeLedger(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const dayMs = opts.dayMs || DAY_MS;

    // Keep complete history. Unreadable or truncated history is unknown, never fresh headroom.
    // Failed writes stay unhealthy until restart reconciles durable settlement receipts.
    let rows = [];
    let readError = null, writeError = null;
    const pending = new Set();
    // An interrupted run's dispatch receipt (io.unsettled) makes ONE run's spend unknown, not the whole logbook:
    // the readable rows stay, history reads incomplete until the Commander settles each run (settleUnsettled).
    const unsettled = new Map();
    try {
      const raw = io.readAll(); if (!Array.isArray(raw)) throw new Error('invalid ledger response'); rows = raw.filter(r => r && typeof r === 'object');
      const open = typeof io.unsettled === 'function' ? io.unsettled() : [];
      for (const r of (Array.isArray(open) ? open : [])) if (r && str(r.runId)) unsettled.set(str(r.runId), Object.assign({}, r, { runId: str(r.runId) }));
    }
    catch (e) { rows = []; unsettled.clear(); readError = String((e && e.code) || 'ledger_read_failed'); }

    function health() {
      return {
        complete: !readError && unsettled.size === 0, durable: !writeError,
        readError: readError || (unsettled.size ? 'UNSETTLED_SPEND' : null), writeError, unsettledRuns: unsettled.size
      };
    }
    // meta (optional object, or a getter for one): what the receipt may name about the dispatch so the Commander can
    // find the charge later. runCapUsd is the run's own per-run limit when it started — never a booked amount.
    function receiptMeta(meta) {
      try { if (typeof meta === 'function') meta = meta(); } catch (_) { meta = null; }
      const out = {};
      if (!meta || typeof meta !== 'object') return out;
      if (str(meta.provider).trim()) out.provider = str(meta.provider).trim().slice(0, 40);
      if (str(meta.model).trim()) out.model = modelName(meta.model);
      if (meta.managed === true) out.managed = true;
      if (typeof meta.runCapUsd === 'number' && isFinite(meta.runCapUsd) && meta.runCapUsd > 0) out.runCapUsd = meta.runCapUsd;
      return out;
    }
    function beginRun(runId, agentId, meta) {
      const id = str(runId);
      if (!id || pending.has(id) || typeof io.beginRun !== 'function') return true;
      try { io.beginRun(Object.assign({ runId: id, agentId: str(agentId), ts: clock.now() }, receiptMeta(meta))); pending.add(id); return true; }
      catch (e) { writeError = String((e && e.code) || 'ledger_write_failed'); return false; }
    }
    function finishRun(entry) {
      unsettled.delete(entry.runId);   // called only after a durable append: that row settles the run, as the next boot would read it
      if (typeof io.finishRun !== 'function') return;
      try { io.finishRun(entry); pending.delete(entry.runId); } catch (_) { /* durable ledger row proves settlement on next boot */ }
    }

    function makeEntry(e) {
      e = e || {};
      const entry = {
        runId: str(e.runId), agentId: str(e.agentId),
        turns: num(e.turns), usd: num(e.usd), tokens: num(e.tokens),
        model: modelName(e.model),
        unmetered: !!e.unmetered,
        ts: num(e.ts) || clock.now()
      };
      // settleUnsettled, not a meter: the Commander settled this run. attestedAs says HOW — 'entered' (they typed the
      // charge from the provider dashboard) or 'limit' (they chose to count it at the per-run limit it started with,
      // a figure its last call can run past). Never claim "entered" for a limit booking.
      if (e.attested === true) {
        entry.attested = true;
        entry.attestedAs = e.attestedAs === 'limit' ? 'limit' : 'entered';
      }
      if (typeof opts.nextId === 'function') entry.entryId = str(opts.nextId());
      return entry;
    }

    function record(e) {
      const entry = makeEntry(e);
      rows.push(entry);
      try { io.append(entry); finishRun(entry); } catch (e) { writeError = String((e && e.code) || 'ledger_write_failed'); }
      return entry;
    }

    function recordStrict(e) {
      const entry = makeEntry(e);
      io.append(entry);
      rows.push(entry);
      finishRun(entry);
      return entry;
    }

    /* The ONE way an interrupted run's unknown spend becomes known: the Commander states what the provider charged.
       Never automatic, never a guessed or lower-bound figure. Only a receipt found unsettled at boot qualifies — a run
       this process dispatched is still live and books itself. The row keeps the dispatch time (its real day) and is
       journaled-then-appended like any strict record; the receipt is removed once the row is durable. */
    function settleUnsettled(runId, usd, how) {
      const id = str(runId);
      const r = unsettled.get(id);
      if (!r || pending.has(id)) throw Object.assign(new Error('that run has no unsettled spend'), { code: 'not_unsettled' });
      if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) throw Object.assign(new Error('the amount must be a number of dollars, 0 or more'), { code: 'bad_usd' });
      try {
        return recordStrict({ runId: id, agentId: r.agentId, turns: 0, tokens: 0, usd, model: r.model, ts: r.ts, attested: true, attestedAs: how === 'limit' ? 'limit' : 'entered' });
      } catch (e) {
        // the settlement journal may already be on disk and replays at the next boot: never offer a second booking
        unsettled.delete(id);
        writeError = String((e && e.code) || 'ledger_write_failed');
        throw Object.assign(new Error('the settlement could not be saved'), { code: 'settle_write_failed' });
      }
    }

    /* METERED dollars only. `unmetered` marks a run paid for by a SUBSCRIPTION (Grok/Kimi OAuth, a
       ChatGPT plan) whose provider-reported figure is an estimate of nothing the Commander was charged.
       The flag was stamped at record time and had ZERO readers on this side, so the same run read two
       different amounts depending on the surface: /api/insights said $0.00 "subscription / unmetered"
       (insights.js honors it) while /api/budget's spentToday + lifetime and the budget governor's day and
       global pools counted the full figure — and that phantom spend then BLOCKED a later real BYOK run with
       reason 'budget' and a CAP HIT note naming money nobody spent. The contract was already written down
       in docs/STARNET_REF_REPLACEMENT_LOOPS.md: exclude unmetered rows from metered USD aggregates while
       still counting runs and tokens. count()/all() are deliberately untouched — the run HAPPENED. */
    function metered(r) { return !(r && r.unmetered); }
    function sum(pred) { let t = 0; for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (!metered(r)) continue; if (!pred || pred(r)) t += num(r.usd); } return t; }
    // the same folds WITHOUT the metered filter, for a surface that wants "what the provider reported".
    function sumAll(pred) { let t = 0; for (let i = 0; i < rows.length; i++) if (!pred || pred(rows[i])) t += num(rows[i].usd); return t; }

    return {
      health,
      beginRun,
      record,
      recordStrict,
      settleUnsettled,
      unsettledRuns() { return [...unsettled.values()].map(r => Object.assign({}, r)); },
      // the Commander's settlement of an interrupted run, or null: { usd, attestedAs } from its attested row (the run
      // history reads this to stop calling a settled run spend-unknown). Newest-first, no copy of the whole log.
      attestedFor(runId) {
        const id = str(runId);
        if (!id) return null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r && r.runId === id && r.attested === true) return { usd: num(r.usd), attestedAs: r.attestedAs === 'limit' ? 'limit' : 'entered' };
        }
        return null;
      },
      pendingRuns() { return pending.size; },
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      totalUsd() { return sum(null); },
      usdSince(ts) { ts = num(ts); return sum(r => num(r.ts) >= ts); },
      usdForDay(now) { const n = num(now) || clock.now(); return sum(r => num(r.ts) > n - dayMs); },
      usdForRun(runId) { runId = str(runId); return sum(r => r.runId === runId); },
      usdForAgent(agentId) { agentId = str(agentId); return sum(r => r.agentId === agentId); },
      // provider-REPORTED totals, subscription runs included — never feed these to a cap.
      reportedUsd() { return sumAll(null); },
      reportedUsdForRun(runId) { runId = str(runId); return sumAll(r => r.runId === runId); }
    };
  }

  return { makeLedger };
});
