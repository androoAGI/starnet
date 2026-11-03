/* sidecar/budget.js — cross-run spend governance over the ledger. Closes the two runaway-cost
   holes the parity study flagged that the reference harness never had: a per-DAY ceiling and a GLOBAL pool shared
   across every agent/subagent. (The per-RUN ceiling stays the loop's own maxCostUsd hard stop;
   this layer owns the cross-run scopes, which need the persisted ledger to evaluate.)

   Two parts:
   • evaluate(caps, totals, overrides?) -> pure decision. Given the effective spend per scope and the
     base caps (+ session overrides from one-click "resume"), reports which scope (if any) is at/over
     cap and which are in the warn band. No state, no clock, no emit — trivially testable.
   • makeBudget({ caps, ledger, clock, dayMs?, warnFrac? }) -> the stateful governor the host wires in:
     tracks in-flight (live) run spend, emits `budget.threshold` once per (scope, level) crossing,
     applies session-scoped resume overrides, and answers check()/status(). An optional
     resumeGuard can veto extra headroom, which lets managed-credit hosts fail closed before
     budget.resume can continue an exhausted paid path.

   Caps are SOFT: hitting one ends the current run with reason 'budget' (the loop's existing terminal
   reason) and emits a threshold; the Commander clicks "resume", which bumps that scope's override for
   the session so work continues. Any cap may be null/Infinity = ungoverned. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).budget = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WARN_FRAC = 0.8;
  // evaluate() priority order, NARROWEST first: a run's own per-agent overage is reported before the
  // shared day/global pools (so a blocked run names the most specific reason it stopped). 'run' stays
  // vestigial here (the per-run ceiling is the loop's own maxCostUsd hard stop; totals never carry it).
  const SCOPES = ['run', 'agent', 'day', 'global'];
  // the scopes the `budget.threshold` bus event may carry — its payload enum is FROZEN to these three in
  // shared/events.js (owned, additive-only). 'agent' is deliberately ABSENT: the per-agent cap BLOCKS the
  // run (→ reason 'budget', like any pool) but emits no threshold, so we never push an out-of-contract event.
  const THRESHOLD_SCOPES = ['run', 'day', 'global'];
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function capOf(caps, scope) {
    const c = caps && caps[scope];
    return (typeof c === 'number' && isFinite(c) && c > 0) ? c : null;   // null/0/Infinity/absent = ungoverned
  }
  // the pools a strict refusal can name, by the label SETTINGS › SPENDING LIMITS gives each
  const LIMIT_NAMES = { agent: 'PER AGENT', day: 'PER DAY', global: 'GLOBAL' };
  const LIMITS_PAGE = 'SETTINGS › SPENDING LIMITS';
  /* The way out of a refusal over unknown spend, for its cause (spend-governor S3): no refusal is permanent. An interrupted
     run that had no per-run limit is counted in one click (COUNT AS) or by its charge; a failed save is replayed by a restart;
     an unreadable record is fixed on disk. Any of them also clears when that limit is set to 0. The loop and the governor
     both say this (loop.js stopForSpend, billing-class.js refusalWords). */
  function unknownExit(cause, scope, countAsUsd) {
    const zero = 'set ' + (LIMIT_NAMES[scope] || 'that limit') + ' to 0';
    if (cause === 'write') return 'restart StarNet: it replays the spend it could not save';
    if (cause === 'unsettled' || cause === 'damaged') return (num(countAsUsd) > 0 ? 'press COUNT AS $' + num(countAsUsd).toFixed(2) + ' or enter its charge' : 'enter its charge') + ' in ' + LIMITS_PAGE + ', or ' + zero;
    return 'restart StarNet; if it stays, fix the spend files in your workspaces folder, or ' + zero + ' in ' + LIMITS_PAGE;
  }

  // PURE: caps {run?,day?,global?} (base), totals {run?,day?,global?} ($ already accrued for each scope),
  // overrides {run?,day?,global?} (session resume headroom added to the base cap). Returns the first scope
  // at/over its effective cap (priority run<day<global), the per-scope breakdown, and the warn-band scopes.
  function evaluate(caps, totals, overrides) {
    caps = caps || {}; totals = totals || {}; overrides = overrides || {};
    const out = { blocked: null, scopes: {}, warn: [] };
    for (const scope of SCOPES) {
      const base = capOf(caps, scope);
      if (base == null) continue;
      const cap = base + num(overrides[scope]);
      const usd = num(totals[scope]);
      const frac = cap > 0 ? usd / cap : 0;
      out.scopes[scope] = { usd, cap, frac };
      if (frac >= 1) { if (!out.blocked) out.blocked = scope; }
      else if (frac >= WARN_FRAC) out.warn.push(scope);
    }
    return out;
  }

  function makeBudget(opts) {
    opts = opts || {};
    let baseCaps = Object.assign({}, opts.caps || {});
    const ledger = opts.ledger;
    const clock = opts.clock || { now() { return 0; } };
    const dayMs = opts.dayMs || DAY_MS;
    const warnFrac = (typeof opts.warnFrac === 'number') ? opts.warnFrac : WARN_FRAC;
    const resumeGuard = (typeof opts.resumeGuard === 'function') ? opts.resumeGuard : null;
    /* STRICT vs SOFT scopes (authorized 2026-09-23 default). Any chosen cap refuses while spend history is
       uncertain, including an item with an estimate or a recorded per-run cap: neither proves what was charged.
       Bounds remain recovery information until the Commander explicitly settles them. A shipped-soft-only rail
       proceeds with unknown history, and no governed cap introduces no history refusal. */
    const strictScope = (typeof opts.strictScope === 'function') ? opts.strictScope : () => true;

    const overrides = { run: 0, agent: 0, day: 0, global: 0 };
    const live = new Map();          // runId -> $ spent so far this run (in-flight, not yet in the ledger)
    const liveAgentOf = new Map();   // runId -> agentId, so per-agent live spend can be summed (the 'agent' scope)
    const emitted = new Set();       // `${runId}:${scope}:${level}` already announced — de-dup PER RUN so each run's
                                     // own bus sees the crossing that affects it (cleared per run in clearLive).

    function accounting() {
      return ledger && typeof ledger.health === 'function' ? ledger.health() : { complete: true, durable: true };
    }
    function unknown() { const h = accounting(); return !h.complete || !h.durable; }
    // WHY history is unknown when it lists nothing to count: 'write' (a restart replays the journaled settlement) or 'read'
    // (the spend record itself could not be read). Open receipts are items, counted at their bounds (unknownState).
    function unknownCause() {
      const h = accounting();
      if (h.writeError) return 'write';
      if (h.readError !== 'UNSETTLED_SPEND') return 'read';
      return h.damagedLines > 0 && h.damagedLines === h.unsettledRuns ? 'damaged' : 'unsettled';
    }
    /* Unknown item estimates for readback/recovery only. A timestamp, agent, prior run cap or damaged-line
       assumption cannot waive a chosen cap's strict uncertainty refusal. COUNT AS remains an explicit attestation. */
    function itemIn(scope, item, now, agentId) {
      if (scope === 'day') return !(num(item.ts) > 0) || num(item.ts) > now - dayMs;
      if (scope === 'agent') return !item.agentId || agentId == null || String(agentId) === '' || item.agentId === String(agentId);
      return true;
    }
    function boundUsd(item) { return item && item.bound && num(item.bound.usd) > 0 ? num(item.bound.usd) : null; }
    function unknownState(now, agentId) {
      if (!unknown()) return null;
      const h = accounting();
      if (h.writeError || h.readError !== 'UNSETTLED_SPEND' || !ledger || typeof ledger.unknownItems !== 'function') return { listed: false };
      let items = null;
      try { items = ledger.unknownItems(); } catch (_) { items = null; }
      if (!Array.isArray(items)) return { listed: false };
      const per = {};
      for (const scope of ['agent', 'day', 'global']) {
        const p = { items: 0, unbounded: 0, countedUsd: 0, countAsUsd: null };
        for (const item of items) {
          if (!item || !itemIn(scope, item, now, agentId)) continue;
          p.items++;
          const b = boundUsd(item);
          if (b != null) p.countedUsd += b;
          else { p.unbounded++; if (p.countAsUsd == null && item.countAs && num(item.countAs.usd) > 0) p.countAsUsd = num(item.countAs.usd); }
        }
        per[scope] = p;
      }
      return { listed: true, items, per };
    }
    function sumLive() { let t = 0; for (const v of live.values()) t += num(v); return t; }
    // live $ for ONE agent: sum the in-flight runs whose runId maps to that agentId (the calling run included).
    function sumLiveForAgent(agentId) {
      let t = 0;
      for (const [rid, usd] of live) if (liveAgentOf.get(rid) === agentId) t += num(usd);
      return t;
    }
    function noteLive(runId, usd) { if (runId != null) live.set(String(runId), num(usd)); }
    function clearLive(runId) {
      if (runId == null) return;
      const rk = String(runId);
      live.delete(rk);
      liveAgentOf.delete(rk);
      for (const k of emitted) if (k.indexOf(rk + ':') === 0) emitted.delete(k);   // forget this run's announced crossings
    }

    // cross-run $ for each governed scope. liveTotal already includes the calling run (noteLive ran first),
    // and the ledger holds only FINISHED runs, so completed + all-live double-counts nothing. When agentId is
    // given, also report the per-agent total (this agent's finished ledger spend + its own in-flight runs).
    function totals(now, agentId) {
      const liveTotal = sumLive();
      const t = {
        day: (ledger ? ledger.usdForDay(now) : 0) + liveTotal,
        global: (ledger ? ledger.totalUsd() : 0) + liveTotal
      };
      // per-agent total ONLY when that scope is governed — avoids per-agent work (and a usdForAgent dependency)
      // for every run when no per-agent cap is set; fail-open if the ledger predates usdForAgent.
      if (capOf(baseCaps, 'agent') != null && agentId != null && String(agentId) !== '') {
        const aid = String(agentId);
        const recorded = (ledger && typeof ledger.usdForAgent === 'function') ? ledger.usdForAgent(aid) : 0;
        t.agent = recorded + sumLiveForAgent(aid);
      }
      return t;
    }

    // Consulted by the loop's guards each turn BEFORE any paid call. Records this run's live spend, emits any
    // fresh warn/cap crossings via the per-run `emit`, and returns null to proceed or { scope, usd, cap } to stop.
    // receiptMeta (optional, object or getter) rides into the dispatch receipt — see ledger.beginRun.
    function check(runId, agentId, spentThisRun, now, emit, receiptMeta) {
      now = num(now) || clock.now();
      noteLive(runId, spentThisRun);
      if (runId != null && agentId != null && String(agentId) !== '') liveAgentOf.set(String(runId), String(agentId));
      const governed = ['agent', 'day', 'global'].find(scope => capOf(baseCaps, scope) != null);
      // a broken classifier fails CLOSED: every governed scope counts as strict
      const strictOf = scope => { try { return !!strictScope(scope); } catch (_) { return true; } };
      const strict = ['agent', 'day', 'global'].find(scope => capOf(baseCaps, scope) != null && strictOf(scope)) || null;
      const softOnly = !!governed && !strict;
      if (governed && unknown()) {
        if (strict) {
          const cause = unknownCause(), u = unknownState(now, agentId);
          const first = u && u.listed && u.items.find(item => item && item.countAs && num(item.countAs.usd) > 0);
          const countAsUsd = first ? num(first.countAs.usd) : null;
          return { scope: strict, unknown: true, code: 'spend_history_unavailable', cause,
            ...(countAsUsd != null ? { countAsUsd } : {}), exit: unknownExit(cause, strict, countAsUsd) };
        }
        // Only the unchosen soft rail is governed: retain the dispatch receipt and proceed with unknown history.
        if (runId != null && ledger && typeof ledger.beginRun === 'function') ledger.beginRun(runId, agentId, receiptMeta);
        return null;
      }
      const ev = evaluate(baseCaps, totals(now, agentId), overrides);
      if (emit) {
        for (const scope of THRESHOLD_SCOPES) {   // never emit the 'agent' scope — not in the frozen budget.threshold enum
          const s = ev.scopes[scope];
          if (!s) continue;
          const level = s.frac >= 1 ? 'cap' : (s.frac >= warnFrac ? 'warn' : null);
          if (!level) continue;
          const key = (runId == null ? '' : String(runId)) + ':' + scope + ':' + level;   // per-run de-dup
          if (emitted.has(key)) continue;
          emitted.add(key);
          try { emit('budget.threshold', { scope, usd: s.usd, cap: s.cap }); } catch (_) {}
        }
      }
      if (ev.blocked) { const s = ev.scopes[ev.blocked]; return { scope: ev.blocked, usd: s.usd, cap: s.cap }; }
      if (runId != null && ledger && typeof ledger.beginRun === 'function' && !ledger.beginRun(runId, agentId, receiptMeta)) {
        if (!softOnly) { const cause = unknownCause(); return { unknown: true, code: 'spend_history_unavailable', cause, exit: unknownExit(cause, strict) }; }
      }
      return null;
    }

    // one-click resume: grant another `amount` (default = the scope's base cap) of headroom for the rest of the
    // session, and let that scope warn again. Returns the new effective cap (or null if the scope is ungoverned, or
    // has uncertain spend: resume never turns an estimate into an accepted charge).
    function resume(scope, amount, meta) {
      if (SCOPES.indexOf(scope) < 0) return null;
      const base = capOf(baseCaps, scope);
      if (base == null) return null;
      if (unknown()) return null;   // headroom cannot settle an uncertain charge
      const inc = (typeof amount === 'number' && isFinite(amount) && amount > 0) ? amount : base;
      const currentCap = base + num(overrides[scope]);
      const nextCap = currentCap + inc;
      if (resumeGuard) {
        let allowed = false;
        try {
          allowed = resumeGuard({
            scope, amount: inc, baseCap: base, currentCap, nextCap,
            status: status(clock.now()), meta: meta || {}
          });
        } catch (_) {
          allowed = false;
        }
        if (allowed === false || (allowed && allowed.ok === false)) return null;
      }
      overrides[scope] += inc;
      for (const k of emitted) if (k.endsWith(':' + scope + ':warn') || k.endsWith(':' + scope + ':cap')) emitted.delete(k);   // let every run re-warn
      return base + overrides[scope];
    }

    function setCaps(caps) { baseCaps = Object.assign({}, caps || {}); emitted.clear(); }

    // Known totals stay unknown until settlement. Estimated totals/bounds are separate recovery information;
    // they never imply that a chosen cap is safely enforceable. `unknown` sums the open items.
    function status(now) {
      now = num(now) || clock.now();
      const t = totals(now);
      const u = unknownState(now, null);
      const mk = scope => {
        const base = capOf(baseCaps, scope);
        if (base == null) return null;
        const p = u && u.listed ? u.per[scope] : null;
        const usd = !u ? num(t[scope]) : null;
        const estimatedUsd = u && p && !p.unbounded ? num(t[scope]) + p.countedUsd : null;
        return Object.assign({ usd, cap: base + num(overrides[scope]), base }, estimatedUsd != null ? { estimatedUsd } : {}, p && p.items ? { unknownItems: p.items, countedUsd: p.countedUsd } : {});
      };
      const out = { caps: Object.assign({}, baseCaps), overrides: Object.assign({}, overrides), live: sumLive(), day: mk('day'), global: mk('global'), accounting: accounting() };
      if (u && u.listed) out.unknown = { items: u.per.global.items, unbounded: u.per.global.unbounded, countedUsd: u.per.global.countedUsd };
      return out;
    }

    return { check, resume, noteLive, clearLive, setCaps, status, caps() { return Object.assign({}, baseCaps); } };
  }

  return { evaluate, makeBudget, unknownExit, LIMIT_NAMES, WARN_FRAC };
});
