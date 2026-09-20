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

    const overrides = { run: 0, agent: 0, day: 0, global: 0 };
    const live = new Map();          // runId -> $ spent so far this run (in-flight, not yet in the ledger)
    const liveAgentOf = new Map();   // runId -> agentId, so per-agent live spend can be summed (the 'agent' scope)
    const emitted = new Set();       // `${runId}:${scope}:${level}` already announced — de-dup PER RUN so each run's
                                     // own bus sees the crossing that affects it (cleared per run in clearLive).

    function accounting() {
      return ledger && typeof ledger.health === 'function' ? ledger.health() : { complete: true, durable: true };
    }
    function unknown() { const h = accounting(); return !h.complete || !h.durable; }
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
    function check(runId, agentId, spentThisRun, now, emit) {
      now = num(now) || clock.now();
      noteLive(runId, spentThisRun);
      if (runId != null && agentId != null && String(agentId) !== '') liveAgentOf.set(String(runId), String(agentId));
      const governed = ['agent', 'day', 'global'].find(scope => capOf(baseCaps, scope) != null);
      if (governed && unknown()) return { scope: governed, unknown: true, code: 'spend_history_unavailable' };
      const t = totals(now, agentId);
      const ev = evaluate(baseCaps, t, overrides);
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
      if (runId != null && ledger && typeof ledger.beginRun === 'function' && !ledger.beginRun(runId, agentId)) {
        return { unknown: true, code: 'spend_history_unavailable' };
      }
      return null;
    }

    // one-click resume: grant another `amount` (default = the scope's base cap) of headroom for the rest of the
    // session, and let that scope warn again. Returns the new effective cap (or null if the scope is ungoverned).
    function resume(scope, amount, meta) {
      if (unknown()) return null;
      if (SCOPES.indexOf(scope) < 0) return null;
      const base = capOf(baseCaps, scope);
      if (base == null) return null;
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

    function status(now) {
      now = num(now) || clock.now();
      const t = totals(now);
      const mk = scope => { const base = capOf(baseCaps, scope); return base == null ? null : { usd: unknown() ? null : num(t[scope]), cap: base + num(overrides[scope]), base }; };
      return { caps: Object.assign({}, baseCaps), overrides: Object.assign({}, overrides), live: sumLive(), day: mk('day'), global: mk('global'), accounting: accounting() };
    }

    return { check, resume, noteLive, clearLive, setCaps, status, caps() { return Object.assign({}, baseCaps); } };
  }

  return { evaluate, makeBudget, WARN_FRAC };
});
