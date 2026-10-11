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
   the session so work continues. Any cap may be null/Infinity = ungoverned.

   SUBSCRIPTION USAGE POOL (2026-10-11). A Claude Code subscription run books $0, so none of the $ scopes above
   ever binds on it. A SEPARATE daily pool counts its WEIGHTED tokens (ledger.tokensForDay + every in-flight run):
   • evaluateTokens(capTokens, usedTokens) -> pure { blocked, tokens, cap, frac };
   • makeBudget's tokenCaps { day } / setTokenCaps / checkTokens / resumeTokens / status().tokenDay.
   check()/evaluate() are untouched, so every $ decision is byte-identical. The pool emits NO budget.threshold
   (that event's enum and $ payload are frozen); a stop rides agent.run.end's undeclared budgetUnit:'tokens'.
   It never fails closed: when spend history is unreadable the figure is unknown and the pool does not block
   (it is an estimate, not money — a guess must not brick a subscription the user already pays for). */
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
  function tokenCapOf(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0; }
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

  // PURE: the daily subscription token pool. capTokens 0/null/non-finite = off (never blocks).
  function evaluateTokens(capTokens, usedTokens) {
    const cap = (typeof capTokens === 'number' && isFinite(capTokens) && capTokens > 0) ? capTokens : 0;
    const tokens = Math.max(0, num(usedTokens));
    const frac = cap > 0 ? tokens / cap : 0;
    return { blocked: cap > 0 && tokens >= cap, tokens, cap, frac };
  }

  function makeBudget(opts) {
    opts = opts || {};
    let baseCaps = Object.assign({}, opts.caps || {});
    const ledger = opts.ledger;
    const clock = opts.clock || { now() { return 0; } };
    const dayMs = opts.dayMs || DAY_MS;
    const warnFrac = (typeof opts.warnFrac === 'number') ? opts.warnFrac : WARN_FRAC;
    const resumeGuard = (typeof opts.resumeGuard === 'function') ? opts.resumeGuard : null;
    /* STRICT vs SOFT scopes (2026-09-23, with the shipped $25/day rail). A cap someone CHOSE (env or a saved Budget
       value) is strict: uncertain spend history refuses paid dispatch — fail-closed, never a guessed $0 (the
       spend-authority contract, test/spend-authority.http.test.js). The shipped default day rail is a soft safety
       net nobody chose: when history is uncertain (e.g. a crash left an unsettled receipt) it cannot be enforced
       honestly, but it must not brick every paid run either — so a governed-but-SOFT-only budget proceeds and
       status keeps reporting the spend as unknown. Absent option = every scope strict (existing behaviour). */
    const strictScope = (typeof opts.strictScope === 'function') ? opts.strictScope : () => true;

    const overrides = { run: 0, agent: 0, day: 0, global: 0 };
    // the subscription token pool (weighted tokens): its own base cap, session resume headroom and live tallies
    let tokenCaps = { day: tokenCapOf(opts.tokenCaps && opts.tokenCaps.day) };
    let tokenOverride = 0;
    const liveTokens = new Map();    // runId -> weighted subscription tokens so far this run (in-flight, not yet in the ledger)
    const live = new Map();          // runId -> $ spent so far this run (in-flight, not yet in the ledger)
    const liveAgentOf = new Map();   // runId -> agentId, so per-agent live spend can be summed (the 'agent' scope)
    const emitted = new Set();       // `${runId}:${scope}:${level}` already announced — de-dup PER RUN so each run's
                                     // own bus sees the crossing that affects it (cleared per run in clearLive).

    function accounting() {
      return ledger && typeof ledger.health === 'function' ? ledger.health() : { complete: true, durable: true };
    }
    function unknown() { const h = accounting(); return !h.complete || !h.durable; }
    // WHY history is unknown, so a refusal names the fix that works: 'write' (a restart replays the journaled
    // settlement), 'unsettled' (an interrupted run's charge — settle it in SPENDING LIMITS; a restart changes
    // nothing), or 'read' (the spend record itself could not be read).
    function unknownCause() {
      const h = accounting();
      return h.writeError ? 'write' : (h.readError === 'UNSETTLED_SPEND' ? 'unsettled' : 'read');
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
      liveTokens.delete(rk);
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
      let strict = null;
      try { strict = ['agent', 'day', 'global'].find(scope => capOf(baseCaps, scope) != null && strictScope(scope)) || null; }
      catch (_) { strict = governed; }   // a broken classifier fails CLOSED: every governed scope counts as strict
      const softOnly = !!governed && !strict;
      if (governed && unknown()) {
        if (!softOnly) return { scope: strict, unknown: true, code: 'spend_history_unavailable', cause: unknownCause() };
        // SOFT-only: record the dispatch receipt as usual, then proceed; the rail resumes once history is known.
        if (runId != null && ledger && typeof ledger.beginRun === 'function') ledger.beginRun(runId, agentId, receiptMeta);
        return null;
      }
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
      if (runId != null && ledger && typeof ledger.beginRun === 'function' && !ledger.beginRun(runId, agentId, receiptMeta)) {
        if (!softOnly) return { unknown: true, code: 'spend_history_unavailable', cause: unknownCause() };
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

    // ---- subscription token pool ----
    function sumLiveTokens() { let t = 0; for (const v of liveTokens.values()) t += num(v); return t; }
    // weighted tokens in the trailing day (finished runs from the ledger + every in-flight run), or null when the
    // spend history cannot be read (a read error other than an interrupted run's unknown $ — its rows still read).
    function tokensUsed(now) {
      if (!ledger || typeof ledger.tokensForDay !== 'function') return sumLiveTokens();
      const h = accounting();
      if (h.readError && h.readError !== 'UNSETTLED_SPEND') return null;
      let booked;
      try { booked = num(ledger.tokensForDay(now)); } catch (_) { return null; }
      return booked + sumLiveTokens();
    }
    function tokenCapNow() { return tokenCaps.day > 0 ? tokenCaps.day + tokenOverride : 0; }
    // Consulted beside check() for a run on a subscription lane. Records this run's live weighted tokens, then returns
    // null to proceed or { scope:'day', unit:'tokens', tokens, cap } to stop. Off (cap 0) and unknown history never block.
    function checkTokens(runId, agentId, liveWeighted, now) {
      now = num(now) || clock.now();
      if (runId != null) liveTokens.set(String(runId), Math.max(0, num(liveWeighted)));
      const cap = tokenCapNow();
      if (!(cap > 0)) return null;
      const used = tokensUsed(now);
      if (used == null) return null;
      const ev = evaluateTokens(cap, used);
      return ev.blocked ? { scope: 'day', unit: 'tokens', tokens: Math.round(ev.tokens), cap: ev.cap } : null;
    }
    // one-click RESUME for the token pool: another base cap (or `amount`) of headroom for the session. Returns the new
    // effective cap, or null when the pool is off.
    function resumeTokens(amount) {
      if (!(tokenCaps.day > 0)) return null;
      const inc = (typeof amount === 'number' && isFinite(amount) && amount > 0) ? Math.floor(amount) : tokenCaps.day;
      tokenOverride += inc;
      return tokenCapNow();
    }
    function setTokenCaps(caps) { tokenCaps = { day: tokenCapOf(caps && caps.day) }; }
    function tokenStatus(now) {
      if (!(tokenCaps.day > 0)) return null;
      const used = tokensUsed(now);
      return { tokens: used == null ? null : Math.round(used), cap: tokenCapNow(), base: tokenCaps.day };
    }

    function status(now) {
      now = num(now) || clock.now();
      const t = totals(now);
      const mk = scope => { const base = capOf(baseCaps, scope); return base == null ? null : { usd: unknown() ? null : num(t[scope]), cap: base + num(overrides[scope]), base }; };
      return { caps: Object.assign({}, baseCaps), overrides: Object.assign({}, overrides), live: sumLive(), day: mk('day'), global: mk('global'), accounting: accounting(), tokenDay: tokenStatus(now) };
    }

    return { check, resume, noteLive, clearLive, setCaps, status, caps() { return Object.assign({}, baseCaps); },
      checkTokens, resumeTokens, setTokenCaps, tokenCaps() { return Object.assign({}, tokenCaps); }, tokensUsed };
  }

  return { evaluate, evaluateTokens, makeBudget, WARN_FRAC };
});
