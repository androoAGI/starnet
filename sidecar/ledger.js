/* sidecar/ledger.js — the append-only spend logbook. One immutable line per finished run
   ({ runId, agentId, turns, usd, tokens, ts }), so cumulative spend survives restarts and can
   be questioned across runs/agents/days. This is the missing "cron spend ledger" the reference harness never
   had (parity study, hole #1) and the substrate budget.js governs over.

   PURE given its injected edges: `io` (the disk adapter — readAll/append, provided by the Node
   host) and `clock` (now()). No ambient time/IO here, so it passes lint-determinism and is
   testable headlessly with an in-memory io. The host owns the atomic file append.

   makeLedger({ io, clock, dayMs?, unknownChargeUsd? }) -> {
     record({ runId, agentId, turns, usd, tokens }) -> entry,   // stamps ts, appends, returns it
     recordStrict({ runId, agentId, turns, usd, tokens }) -> entry, // same, but append failure throws
     unsettledRuns() -> receipt[], settleUnsettled(runId, usd, how?) -> entry,   // ended unpriced or interrupted runs;
                                  // how = 'entered' (default: the Commander typed the charge) | 'limit' (counted at its per-run
                                  // limit) | 'recorded' (at the charge a damaged line still records) | 'assumed' (at the assumption)
     unknownItems() -> item[],    // those receipts as the open unknown items, each with the figure it is counted at (below)
     markUnsettled(runId) -> boolean, // move an ended, unpriced dispatch receipt into the same recovery path without writing
     pendingRuns() -> int,        // runs this process dispatched whose spend is not booked yet
     all() -> entry[],            count() -> int,               runCount() -> int,   // rows minus aux rows
     totalUsd() -> number,                                       // every recorded run, ever
     usdSince(ts) -> number,      usdForDay(now?) -> number,     // trailing `dayMs` window
     usdForRun(runId) -> number,  usdForAgent(agentId) -> number,
     recordUnknownImage({ runId, agentId }) -> entry,            // one image whose cost nobody knows (#164)
     unknownImageWindow(now?) -> { ok, times, now, dayMs }       // those in the trailing window; ok false: the log cannot say
   } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).ledger = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The browser does not own spend booking; keep its standalone legacy reader loadable without transport modules.
  const receiptApi = (typeof require === 'function') ? require('./providers/provider.js') : (globalThis.SK && globalThis.SK.providers && globalThis.SK.providers.provider);
  const generationFields = receiptApi ? receiptApi.generationFields : () => ({});
  const makeGenerationReceipt = receiptApi ? receiptApi.makeGenerationReceipt : () => ({ begin: () => () => {}, fields: () => ({}), reset() {} });

  const DAY_MS = 24 * 60 * 60 * 1000;
  const UNKNOWN_MODEL = '(unknown)';
  // who paid for a row (billing-class.js POLICY): its ledgerMetered decides the metered folds. Optional on a row: every row
  // written before it carries none and keeps the legacy rule (unmetered -> not metered). A browser copy without it does too.
  const BillingClass = (typeof require === 'function') ? require('./billing-class.js') : null;
  function knownClass(c) { return !!BillingClass && typeof c === 'string' && BillingClass.CLASSES.indexOf(c) >= 0; }
  /* #164: a run's row says only "some usage was unpriced", once, when the run ends: no count, chat tokens mixed in, and nothing
     until then. So each image whose cost is unknown books its own $0 aux row the moment its call ends. An aux row is built for
     this: journaled and durable like any row, never a run's own booking, and no run counter or dollar total reads it. */
  const UNKNOWN_IMAGE_AUX = 'image-unknown-cost';
  /* THE EXPLICIT UNKNOWN-SPEND STATE (spend-governor S3, customer reports d688ea20). An open receipt is one charge nobody
     recorded, and it used to make ALL spend unknown: one torn line, or a run interrupted three days ago, refused every run
     under any limit the Commander chose until someone settled it. Each open receipt is now an item counted at its BOUND
     (budget.js counts it in every limit that can contain it):
       damaged      a record line that could not be read: the charge it still records ('recorded': the host reads a complete
                    "usd" field off the line), else 'assumed': the largest single charge this ledger records, and never less
                    than UNKNOWN_CHARGE_USD (STARNET_UNKNOWN_CHARGE_USD, default $2). An assumption can undercount: the row
                    says it is one, and the line stays settleable.
       interrupted  a run that stopped before it booked: the per-run limit it started with ('limit'; its last call can run
                    past it). With none it has NO bound, and only such an item can still refuse a limit that covers it.
       evaluation   a skill evaluation run whose call came back unpriced or cut off: the same rule (its receipt names its limit).
     countAs is the one-click figure SPENDING LIMITS offers for EVERY item (COUNT AS): its bound, or the assumption for an item
     with none. Counted in memory only: nothing is written until the Commander settles it, and a counted item is never $0. */
  const UNKNOWN_CHARGE_USD = 2;
  const EVALUATION_RUN_PREFIX = 'skill-eval-';   // skill-evaluation-runner.js names every evaluation run in this namespace
  // how a settlement booked its figure (settleUnsettled); an older build reads anything but 'limit' as 'entered'
  const ATTESTED_AS = ['entered', 'limit', 'recorded', 'assumed'];
  function attestedAsOf(v) { return ATTESTED_AS.indexOf(v) >= 0 ? v : 'entered'; }
  function positiveUsd(v) { return typeof v === 'number' && isFinite(v) && v > 0; }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function modelName(v) { const s = str(v).trim(); return (s || UNKNOWN_MODEL).slice(0, 80); }

  function makeLedger(opts) {
    opts = opts || {};
    const io = opts.io || { readAll() { return []; }, append() {} };
    const clock = opts.clock || { now() { return 0; } };
    const dayMs = opts.dayMs || DAY_MS;
    // the floor of the assumption a damaged line with no readable charge is counted at (0 or invalid: the default; never $0)
    const unknownChargeUsd = positiveUsd(opts.unknownChargeUsd) ? opts.unknownChargeUsd : UNKNOWN_CHARGE_USD;

    // Keep complete history. Unreadable or truncated history is unknown, never fresh headroom.
    // Failed writes stay unhealthy until restart reconciles durable settlement receipts.
    let rows = [];
    let readError = null, writeError = null;
    const pending = new Map();   // exact durable dispatch receipt, not just a live-run flag
    const failedBookings = new Set(); // a known charge may already be journaled; never offer another manual booking
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
        readError: readError || (unsettled.size ? 'UNSETTLED_SPEND' : null), writeError, unsettledRuns: unsettled.size,
        // of those, the unreadable record lines (kind 'damaged'): the refusal names a damaged line, not an interrupted run
        damagedLines: [...unsettled.values()].filter(r => r && r.kind === 'damaged').length
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
      if (typeof meta.managed === 'boolean') out.managed = meta.managed; // absent legacy provenance stays unknown
      if (typeof meta.runCapUsd === 'number' && isFinite(meta.runCapUsd) && meta.runCapUsd > 0) out.runCapUsd = meta.runCapUsd;
      return out;
    }
    function beginRun(runId, agentId, meta) {
      const id = str(runId);
      if (!id || pending.has(id) || typeof io.beginRun !== 'function') return true;
      const receipt = Object.assign({ runId: id, agentId: str(agentId), ts: clock.now() }, receiptMeta(meta));
      try { io.beginRun(Object.assign({}, receipt)); pending.set(id, receipt); return true; }
      catch (e) { writeError = String((e && e.code) || 'ledger_write_failed'); return false; }
    }
    // The host calls this only after dispatch ended without a trustworthy final price. The
    // existing durable receipt already survives a crash; this exposes it for settlement now.
    // A failed booking is different: its known charge may be in a recovery journal already.
    function markUnsettled(runId) {
      const id = str(runId);
      if (!id || failedBookings.has(id)) return false;
      const receipt = pending.get(id);
      if (!receipt) return unsettled.has(id);
      unsettled.set(id, Object.assign({}, receipt));
      pending.delete(id);
      return true;
    }
    // An aux row (a housekeeping call's spend) is booked BESIDE a run, often under that run's id while it is still live
    // (recall embeds land mid-run): it is never the run's own booking, so it never settles or fails the run's receipt.
    // The host still hears of it (io.finishRun) to drop the row's own settlement journal.
    function finishRun(entry) {
      if (!entry.aux) {
        pending.delete(entry.runId);
        failedBookings.delete(entry.runId);
        unsettled.delete(entry.runId);   // called only after a durable append: that row settles the run, as the next boot would read it
      }
      if (typeof io.finishRun !== 'function') return;
      try { io.finishRun(entry); } catch (_) { /* durable ledger row proves settlement on next boot */ }
    }
    function bookingFailed(entry, e) {
      if (!entry.aux) { failedBookings.add(entry.runId); unsettled.delete(entry.runId); }
      writeError = String((e && e.code) || 'ledger_write_failed');
    }

    function makeEntry(e) {
      e = e || {};
      const entry = {
        runId: str(e.runId), agentId: str(e.agentId),
        turns: num(e.turns), usd: num(e.usd), tokens: num(e.tokens),
        ...(num(e.cachedTokens) > 0 ? { cachedTokens: num(e.cachedTokens) } : {}),   // (additive) the cache-served part of `tokens`' input
        model: modelName(e.model),
        ...generationFields(e),
        // a row that names its payer is unmetered exactly when that payer is a sign-in plan or a local model, so an older
        // build's folds (it reads unmetered alone) and this build's agree on the same file
        unmetered: knownClass(e.billingClass) ? !BillingClass.POLICY[e.billingClass].ledgerMetered : !!e.unmetered,
        ...(knownClass(e.billingClass) ? { billingClass: e.billingClass } : {}),   // (additive) metered | managed | subscription | local
        ...(e.unpriced === true ? { unpriced: true } : {}),   // (additive) some usage had no price: usd is a floor, never a proven $0
        ...(e.usageMissing === true ? { usageMissing: true } : {}),   // (additive) a Stop cut a call off before its usage arrived: usd is a floor
        ...(str(e.provider).trim() ? { provider: str(e.provider).trim().slice(0, 40) } : {}),   // (additive) the route a housekeeping pass ran on: the aux token ceiling counts per route
        ...(e.subscription === true ? { subscription: true } : {}),   // (additive) a $0 subscription call: it drew on a sign-in's usage window
        ...(str(e.aux).trim() ? { aux: str(e.aux).trim().slice(0, 40) } : {}),   // (additive) a housekeeping call's spend (reflection, study…), not a run
        ts: num(e.ts) || clock.now()
      };
      // settleUnsettled, not a meter: the Commander settled this run. attestedAs says HOW — 'entered' (they typed the
      // charge from the provider dashboard), 'limit' (they chose to count it at the per-run limit it started with, a
      // figure its last call can run past), 'recorded' (at the charge a damaged line still records) or 'assumed' (at the
      // assumption for a charge nobody can read). Never claim "entered" for a one-click booking.
      if (e.attested === true) {
        entry.attested = true;
        entry.attestedAs = attestedAsOf(e.attestedAs);
        // a settled DAMAGED record line: the row names the exact line (sha256 of its bytes) it resolves, so the host's
        // reader skips that line from now on — the line itself is never rewritten or removed
        if (typeof e.resolvesLine === 'string' && /^[0-9a-f]{64}$/.test(e.resolvesLine)) entry.resolvesLine = e.resolvesLine;
      }
      if (typeof opts.nextId === 'function') entry.entryId = str(opts.nextId());
      return entry;
    }

    function record(e) {
      const entry = makeEntry(e);
      rows.push(entry);
      try { io.append(entry); finishRun(entry); } catch (e) { bookingFailed(entry, e); }
      return entry;
    }

    function recordStrict(e) {
      const entry = makeEntry(e);
      try { io.append(entry); }
      catch (e) { bookingFailed(entry, e); throw e; }
      rows.push(entry);
      finishRun(entry);
      return entry;
    }

    /* The ONE way an interrupted run's unknown spend becomes known: the Commander states what the provider charged, or
       books one of the figures SPENDING LIMITS offers in one click (COUNT AS: its limit, the charge its line records, or the
       assumption), and the row says which (attestedAs). Never automatic. A receipt found unsettled at boot or explicitly marked
       after an unpriced dispatch qualifies; live pending runs still book themselves. The row keeps dispatch time and is
       journaled-then-appended like any strict record; the receipt is removed once the row is durable. */
    function settleUnsettled(runId, usd, how) {
      const id = str(runId);
      const r = unsettled.get(id);
      if (!r || pending.has(id)) throw Object.assign(new Error('that run has no unsettled spend'), { code: 'not_unsettled' });
      if (typeof usd !== 'number' || !isFinite(usd) || usd < 0) throw Object.assign(new Error('the amount must be a number of dollars, 0 or more'), { code: 'bad_usd' });
      try {
        return recordStrict({ runId: id, agentId: r.agentId, turns: 0, tokens: 0, usd, model: r.model, ts: r.ts, attested: true, attestedAs: attestedAsOf(how), resolvesLine: r.kind === 'damaged' ? r.lineHash : undefined });
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
       still counting runs and tokens. count()/all() are deliberately untouched — the run HAPPENED. A row that names its
       payer (billingClass) is read by that payer's POLICY row; makeEntry keeps its unmetered flag in step with it. */
    function metered(r) { return (r && knownClass(r.billingClass)) ? BillingClass.POLICY[r.billingClass].ledgerMetered : !(r && r.unmetered); }
    function sum(pred) { let t = 0; for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (!metered(r)) continue; if (!pred || pred(r)) t += num(r.usd); } return t; }
    // the same folds WITHOUT the metered filter, for a surface that wants "what the provider reported".
    function sumAll(pred) { let t = 0; for (let i = 0; i < rows.length; i++) if (!pred || pred(rows[i])) t += num(rows[i].usd); return t; }
    // the assumption for a charge nobody can read: the largest single charge this ledger records, never under the floor
    function assumedChargeUsd() {
      let most = 0;
      for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (metered(r) && num(r.usd) > most) most = num(r.usd); }
      return Math.max(most, unknownChargeUsd);
    }
    // the open unknown items (see UNKNOWN_CHARGE_USD above): { runId, kind, ts?, agentId?, bound: { usd, source } | null, countAs }
    function unknownItems() {
      if (!unsettled.size) return [];
      let assumed = null;
      const assumption = () => (assumed == null ? (assumed = assumedChargeUsd()) : assumed);
      return [...unsettled.values()].map(r => {
        const kind = r.kind === 'damaged' ? 'damaged' : str(r.runId).indexOf(EVALUATION_RUN_PREFIX) === 0 ? 'evaluation' : 'interrupted';
        const bound = kind === 'damaged'
          ? (positiveUsd(r.recordedUsd) ? { usd: r.recordedUsd, source: 'recorded' } : { usd: assumption(), source: 'assumed' })
          : (positiveUsd(r.runCapUsd) ? { usd: r.runCapUsd, source: 'limit' } : null);
        const item = { runId: str(r.runId), kind, bound, countAs: bound ? Object.assign({}, bound) : { usd: assumption(), source: 'assumed' } };
        if (num(r.ts) > 0) item.ts = num(r.ts);
        if (str(r.agentId)) item.agentId = str(r.agentId);
        return item;
      });
    }

    return {
      health,
      beginRun,
      markUnsettled,
      record,
      recordStrict,
      settleUnsettled,
      unknownItems,
      unsettledRuns() { return [...unsettled.values()].map(r => Object.assign({}, r)); },
      // the Commander's settlement of an interrupted run, or null: { usd, attestedAs } from its attested row (the run
      // history reads this to stop calling a settled run spend-unknown). Newest-first, no copy of the whole log.
      attestedFor(runId) {
        const id = str(runId);
        if (!id) return null;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (r && r.runId === id && r.attested === true) return { usd: num(r.usd), attestedAs: attestedAsOf(r.attestedAs) };
        }
        return null;
      },
      unknownChargeFloorUsd() { return unknownChargeUsd; },   // readback of the actual configured assumption floor, never a measured charge
      pendingRuns() { return pending.size; },
      all() { return rows.map(r => Object.assign({}, r)); },
      count() { return rows.length; },
      // runs, not rows: a housekeeping call's aux row is spend booked beside a run, never a run of its own
      runCount() { let n = 0; for (let i = 0; i < rows.length; i++) if (!(rows[i] && rows[i].aux)) n++; return n; },
      totalUsd() { return sum(null); },
      usdSince(ts) { ts = num(ts); return sum(r => num(r.ts) >= ts); },
      usdForDay(now) { const n = num(now) || clock.now(); return sum(r => num(r.ts) > n - dayMs); },
      usdForRun(runId) { runId = str(runId); return sum(r => r.runId === runId); },
      usdForAgent(agentId) { agentId = str(agentId); return sum(r => r.agentId === agentId); },
      // provider-REPORTED totals, subscription runs included — never feed these to a cap.
      reportedUsd() { return sumAll(null); },
      reportedUsdForRun(runId) { runId = str(runId); return sumAll(r => r.runId === runId); },
      // Tokens the given housekeeping kinds used since ts, per route, where no dollar guard can bind (an unmetered provider, a
      // subscription sign-in): fresh input and output in full, a cache re-read at 1/10, the rule of the per-run seatbelt (loop.js
      // maxSubscriptionTokens). The figure the aux token ceiling reads. A row with no route (booked before routes were recorded) counts nowhere.
      ceilingTokensByProvider(ts, kinds) {
        ts = num(ts);
        const wanted = new Set(Array.isArray(kinds) ? kinds : []);
        const out = {};
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r || !r.provider || !wanted.has(r.aux) || !(r.unmetered || r.subscription) || num(r.ts) < ts) continue;
          const cached = num(r.cachedTokens);
          out[r.provider] = (out[r.provider] || 0) + num(r.tokens) - cached + cached / 10;
        }
        for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
        return out;
      },
      recordUnknownImage(e) {
        e = e || {};
        return record({ runId: e.runId, agentId: e.agentId, turns: 0, usd: 0, tokens: 0, model: 'image', unpriced: true, aux: UNKNOWN_IMAGE_AUX });
      },
      /* Unknown is never fresh headroom: a log that could not be read, a damaged line (it may have been one of these), or a write
         that failed (this count would not survive a restart) is not ok. An interrupted run's receipt is not: its rows are readable. */
      unknownImageWindow(now) {
        const h = health();
        const n = num(now) || clock.now();
        if ((h.readError && (h.readError !== 'UNSETTLED_SPEND' || h.damagedLines > 0)) || !h.durable) return { ok: false, times: [], now: n, dayMs };
        const times = rows.filter(r => r && r.aux === UNKNOWN_IMAGE_AUX && num(r.ts) > n - dayMs).map(r => num(r.ts)).sort((a, b) => a - b);
        return { ok: true, times, now: n, dayMs };
      }
    };
  }

  /* AUX METER (efficiency audit 2026-10-26). The station's housekeeping passes (reflection, failure review, study, thread
     mining, the scout cycle, quest refresh, recall embeddings) each booked their spend ONLY `if (usd)`. A subscription
     route reports $0, so on a ChatGPT/Claude plan every one of those calls drew on the plan and never reached the spend
     log. One meter per pass: every call it ran is booked, $0 included. A call whose usage never arrived (a timeout, an
     abort) leaves a metered row usageMissing and an unpriced model leaves it unpriced (both: usd is a floor, never a
     proven $0), the same metered-only rule the run finalizer uses. The row is tagged `aux` so run counters stay runs.

     makeAuxMeter({ ledger, kind, provider?, rowClass? }) -> {
       stream(provider, req, cost) -> text,   // one streamed completion, metered even when the stream throws
       add(usage, cost, model),               // one finished call (usage null = none arrived)
       book({ runId, agentId, model, unmetered, turns? }) -> entry | null,   // no call ran = no row
       calls(), usd(), tokens()
     }
     rowClass(signedIn) -> the row's payer (the host's billing-class.js auxRowClass for the pass's route: the route's payer, a
     sign-in when one of its calls reported one). The row then carries billingClass and its unmetered follows it; with none
     (a pass that names no route) the caller's unmetered flag stands, as before. */
  // The flags a nested tool loop's aux row carries (the skill review, the curator). A subscription call is named on any route; the
  // floors (an unpriced model, a stream cut before usage) mean something only where dollars are metered.
  function auxLoopFloors(result, unmetered) {
    const out = generationFields(result);
    if (result && result.subscriptionUsed === true) out.subscription = true;
    if (unmetered || !result) return out;
    if (Array.isArray(result.unpricedUsage) && result.unpricedUsage.length) out.unpriced = true;
    if (result.usageMissing === true || (result.reason === 'cancelled' && result.streamCut === true)) out.usageMissing = true;
    return out;
  }
  function makeAuxMeter(o) {
    o = o || {};
    const ledger = o.ledger, kind = str(o.kind).trim() || 'aux', route = str(o.provider).trim();
    const rowClass = typeof o.rowClass === 'function' ? o.rowClass : null;
    const generationReceipt = makeGenerationReceipt();
    let calls = 0, missing = 0, unpriced = false, subscription = false, usd = 0, tokens = 0, cachedTokens = 0;
    function add(usage, cost, model, noteGeneration) {
      (noteGeneration || generationReceipt.begin())(usage && usage.generation_id);
      calls++;
      if (usage && usage.subscription === true) subscription = true;
      let c = null;
      try { c = usage ? cost.reconcile(usage, model) : null; } catch (_) { c = null; }
      if (!c) { missing++; return; }
      usd += num(c.usd); tokens += num(c.tokensIn) + num(c.tokensOut); cachedTokens += num(c.cachedTokens);
      if (c.unpriced) unpriced = true;
    }
    return {
      add,
      async stream(provider, req, cost) {
        const noteGeneration = generationReceipt.begin();
        let out = '', usage = null;
        try {
          // A toolless housekeeping call is one request whose prompt nothing reads again: the adapter may skip the cache write
          // (claude-cli.js oneShotStream). A tool loop re-reads its own prompt every turn and keeps its cache.
          const hasTools = !!(req && Array.isArray(req.tools) && req.tools.length);
          for await (const ev of provider.stream(hasTools ? req : Object.assign({}, req, { neverReread: true }))) {
            if (ev && ev.type === 'text') out += ev.delta;
            else if (ev && ev.type === 'generation') noteGeneration(ev.id);
            else if (ev && ev.type === 'usage') usage = ev.usage;
          }
        } finally { add(usage, cost, req && req.model, noteGeneration); }
        return out;
      },
      book(row) {
        if (!calls || !ledger) return null;
        row = row || {};
        let billingClass = null;
        try { billingClass = rowClass ? rowClass(subscription) : null; } catch (_) { billingClass = null; }   // no payer named: the caller's flag
        if (!knownClass(billingClass)) billingClass = null;
        const unmetered = billingClass ? !BillingClass.POLICY[billingClass].ledgerMetered : !!row.unmetered;
        const entry = ledger.record({ runId: row.runId, agentId: row.agentId, turns: num(row.turns), usd, tokens, cachedTokens, model: row.model, ...(billingClass ? { billingClass } : {}), unmetered,
          unpriced: !unmetered && unpriced, usageMissing: !unmetered && missing > 0, subscription, provider: route, aux: kind, ...generationReceipt.fields() });
        generationReceipt.reset();
        calls = 0; missing = 0; unpriced = false; subscription = false; usd = 0; tokens = 0; cachedTokens = 0;   // booked once: a second book() adds no copy
        return entry;
      },
      calls() { return calls; },
      usd() { return usd; },
      tokens() { return tokens; }
    };
  }

  return { makeLedger, makeAuxMeter, auxLoopFloors, UNKNOWN_CHARGE_USD, ATTESTED_AS };
});
