/* sidecar/billing-class.js — WHO PAYS for a model call, and every limit that follows from it. One table.

   Every billing decision used to be made inline, each site with its own reading of a provider profile: ten
   `getProviderProfile(...).unmetered` reads, three copies of the managed rule, the Codex/device-OAuth exemption, the aux
   ceiling's adapter rule, and the loop's `usage.subscription === true`. They drifted: a ChatGPT, Grok or Kimi sign-in
   reports no subscription flag, so the per-run sign-in seatbelt never counted a single one of their calls (a ChatGPT plan
   burned through a day and a half of runs uncounted). Now the loop asks every booked attempt its class.

   FOUR PAYERS (billingClassOf):
     'metered'       the Commander's own key: real dollars per call.
     'managed'       StarNet credits: the starnet relay on a linked station, or every metered run on an operator's
                     CREDITS_URL deployment (the operator fronts the keys there). Reserved and settled on that account.
     'subscription'  a sign-in plan: ChatGPT (Codex), Grok OAuth, Kimi OAuth, and Claude Code when its call reports a
                     subscription login. Nothing is billed per call; every call draws on the plan's usage window.
     'local'         a local model (Ollama): nothing is billed and no allowance is drawn.
   A profile marked `unmetered` is a plan when it signs in and local when it has no auth at all. Claude Code is a PER-CALL
   route: its login type is known only once a call reports it, so BEFORE any call it is 'metered' (an API-key login
   bills) and its attempts decide after. Any call whose usage says `subscription` drew on a sign-in, whatever the route.

   POLICY is the one table per payer, and every decision reads it:
     dollarCaps            PER RUN, the run family's spend pool, the per-agent/day/global pools and the aux dollar check
     managedAdmission      the run reserves its cap against the managed account before its first call
     unpricedTokenCeiling  the per-run token ceiling for usage nothing can price (STARNET_MAX_UNPRICED_TOKENS)
     signInTokenCeiling    the per-run sign-in seatbelt (STARNET_MAX_SUBSCRIPTION_TOKENS): every attempt of this payer counts
     auxTokenCeiling       the 24-hour background token ceiling (#105). Route-level: a route that MAY sign in keeps it
     promptTier            the run's window stops at the model's long-context price tier (prices.js promptTierCeiling)
     mediaDollarsCrossRun  #164: only the run's media dollars meet the cross-run limits (its own calls spend none)
     imageUnknownCaps      #164: images of unknown cost are counted (spend.js: 10 per run family, 50 in 24 hours)
     ledgerMetered         the run's ledger row counts toward the metered dollar totals (a row's unmetered = !ledgerMetered)

   The host binds what only it knows ONCE (makeBilling: the provider profile table, whether StarNet credits are
   configured, the CREDITS_URL deployment) and every call site asks the bound object:
     classOf / policyOf(providerId)      a route's payer before any call, and its POLICY row
     classifierFor(providerId)           the per-attempt classifier the loop calls on every booked attempt (o.billingClassOf,
                                         fb.billingClassOf): the route's payer, which an attempt's usage can refine. It carries
                                         the route's class before any call (.cls) and whether its calls decide it (.perCall)
     auxCeilingRoute(route)              may this route's background passes meet the aux token ceiling
     runBillingFor({ providerId, callerCapUsd, ceilingUsd, perRunUsd })   a run's payer and its $ cap before admission
     spendPoolCapFor({ runCapUsd, policy, perRunUsd })                    the run family's pool cap
     fallbackBillingFor({ providerId, runManaged, runCapUsd, callerCapUsd, perRunUsd, unpricedTokens })   a provider
                                         fallback's limits, or null when it would move the run to another payer
     evaluationBillingFor({ providerId, perRunUsd, managedDefaultUsd, shippedDefaultUsd })   a skill evaluation's
     runRowClass({ routes, attempts }) / bookedClass(cls, unmetered)     what a finished run's ledger row says it was
     auxRowClass(route, signedIn)        what a housekeeping or one-shot row says it was
   Each is a move of the expression it replaced in sidecar/index.js; test/billing-class.parity.test.js holds every one to
   the golden snapshot taken from the base source (test/fixtures/billing-class.golden.json).
   makeGovernor({ budget, auxTokenGate, classOfProvider }).admit(kind, o) is the ONE admission every paid call path asks
   before its call (a run's turns, an image, the run-end passes, skill review and curator, the night shift, quest refresh,
   station one-shots, skill evaluation): it routes by POLICY to the mechanisms, which stay where they are.

   PURE: no clock, no IO, no ambient state (lint-determinism). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).billingClass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLASSES = Object.freeze(['metered', 'managed', 'subscription', 'local']);
  // most-paying first: a run that ran on several payers is booked as the one that costs the Commander most
  const PAYING_ORDER = Object.freeze(['managed', 'metered', 'subscription', 'local']);
  const POLICY = Object.freeze({
    metered: Object.freeze({ dollarCaps: true, managedAdmission: false, unpricedTokenCeiling: true, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: true, mediaDollarsCrossRun: false, imageUnknownCaps: true, ledgerMetered: true }),
    managed: Object.freeze({ dollarCaps: true, managedAdmission: true, unpricedTokenCeiling: true, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: true, mediaDollarsCrossRun: false, imageUnknownCaps: true, ledgerMetered: true }),
    subscription: Object.freeze({ dollarCaps: false, managedAdmission: false, unpricedTokenCeiling: false, signInTokenCeiling: true, auxTokenCeiling: true, promptTier: false, mediaDollarsCrossRun: true, imageUnknownCaps: true, ledgerMetered: false }),
    local: Object.freeze({ dollarCaps: false, managedAdmission: false, unpricedTokenCeiling: false, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: false, mediaDollarsCrossRun: true, imageUnknownCaps: true, ledgerMetered: false })
  });
  function isClass(c) { return typeof c === 'string' && CLASSES.indexOf(c) >= 0; }

  /* WHO IS MANAGED (issue #6, 2026-08-30): only a run whose spend lands on the managed account. On a device-LINKED
     station that is solely the 'starnet' relay (a BYOK run pays its own vendor); on an env STARNET_CREDITS_URL deployment
     the operator fronts every metered run's keys, so all of them do. A plan or a local model never touches managed credit. */
  function managedRoute(providerId, creditsConfigured, creditsUrl) {
    return !!creditsConfigured && (providerId === 'starnet' || !!creditsUrl);
  }
  // Claude Code: one route, two payers — a subscription login books $0, an API-key login books the CLI's reported cost
  function perCallRoute(profile) { return !!profile && !profile.unmetered && profile.adapter === 'claude-cli'; }

  // billingClassOf({ providerId?, profile, usage?, managed? }) -> one of CLASSES. profile: the route's registry profile
  // (null: an unknown route, metered); usage: the attempt's usage event (absent: before any call); managed: managedRoute.
  function billingClassOf(o) {
    o = o || {};
    const profile = o.profile || null, usage = o.usage || null;
    if (usage && usage.subscription === true) return 'subscription';   // the adapter says this call drew on a sign-in
    if (profile && profile.unmetered) return profile.authType === 'none' ? 'local' : 'subscription';
    return o.managed ? 'managed' : 'metered';
  }
  // every payer a route's calls can have: its class before any call, and a sign-in for a per-call route
  function routeClasses(profile, managed) {
    if (!profile) return [];
    const before = billingClassOf({ profile, managed });
    return perCallRoute(profile) && before !== 'subscription' ? [before, 'subscription'] : [before];
  }

  /* THE RUN FAMILY'S POOL (bug d3a76db3): the run's own finite cap; a lead that PER RUN does not cap (a plan, a local
     model) still bounds the metered crew it starts by the PER RUN setting. */
  function spendPoolCapFor(o) {
    o = o || {};
    const runCapUsd = o.runCapUsd, perRunUsd = o.perRunUsd, exempt = !!(o.policy && !o.policy.dollarCaps);
    return (runCapUsd > 0 && isFinite(runCapUsd)) ? runCapUsd
      : ((exempt && perRunUsd > 0 && isFinite(perRunUsd)) ? perRunUsd : Infinity);
  }

  /* runRowClass({ routes, attempts }) -> the class a finished run's rows carry: what its calls really were.
     routes: every route the run ran on, in order ({ cls, perCall }: the run's classifier, then each provider fallback's);
     attempts: the classes its booked attempts reported (the loop's result.billingClasses). A route with a fixed payer (a
     key, StarNet credits, a sign-in plan, a local model) counts at it, whatever its attempts did. A per-call route (Claude
     Code) counts at what its attempts reported when it is the run's only route; otherwise, or when none reported, at its
     class before any call (metered: unknown is never a sign-in). The most-paying class wins. */
  function runRowClass(o) {
    o = o || {};
    const routes = (Array.isArray(o.routes) ? o.routes : []).filter(r => r && isClass(r.cls));
    const attempts = (Array.isArray(o.attempts) ? o.attempts : []).filter(isClass);
    const seen = [];
    for (const r of routes) {
      if (r.perCall && routes.length === 1 && attempts.length) seen.push.apply(seen, attempts);
      else seen.push(r.cls);
    }
    for (const c of PAYING_ORDER) if (seen.indexOf(c) >= 0) return c;
    return 'metered';
  }
  /* the class a LEDGER ROW carries once its media is counted (#164 spend.js mediaRunFlags): a plan or local run whose images
     cost dollars books them as metered spend, so that row is metered. unmetered stays true exactly for subscription|local. */
  function bookedClass(cls, unmetered) {
    const c = isClass(cls) ? cls : 'metered';
    return (!POLICY[c].ledgerMetered && !unmetered) ? 'metered' : c;
  }

  /* makeBilling({ profileOf(id) -> profile|null, creditsConfigured: () => bool, creditsUrl }) -> the host's one binding.
     creditsConfigured is read at each decision, as the inline rules read credits.configured(): a relink can change it. */
  function makeBilling(ctx) {
    ctx = ctx || {};
    const profileOf = typeof ctx.profileOf === 'function' ? ctx.profileOf : function () { return null; };
    const creditsConfigured = typeof ctx.creditsConfigured === 'function' ? ctx.creditsConfigured : function () { return !!ctx.creditsConfigured; };
    const creditsUrl = ctx.creditsUrl;
    function managedFor(providerId) { return managedRoute(providerId, creditsConfigured(), creditsUrl); }
    function classOf(providerId) { return billingClassOf({ providerId, profile: profileOf(providerId), managed: managedFor(providerId) }); }
    function policyOf(providerId) { return POLICY[classOf(providerId)]; }
    // the per-attempt classifier: the route's profile and payer are fixed when the run starts on it; each attempt's usage decides the rest
    function classifierFor(providerId) {
      const profile = profileOf(providerId), managed = managedFor(providerId);
      const classify = function billingClassOfAttempt(usage) { return billingClassOf({ providerId, profile, usage, managed }); };
      classify.cls = billingClassOf({ providerId, profile, managed });   // the route's payer before any call (runRowClass)
      classify.perCall = perCallRoute(profile);
      return classify;
    }
    /* issue #105: the background token ceiling is PER ROUTE and route-level. A local model draws on no allowance; a plan
       does; Claude Code's sign-in is known only per call, so that route qualifies and its rows decide. */
    function auxCeilingRoute(route) {
      return routeClasses(profileOf(route), false).some(c => POLICY[c].auxTokenCeiling);
    }
    /* A RUN'S PAYER AND ITS PER-RUN $ CAP (before managed admission clamps it to the wallet). The caller's explicit cap
       (o.maxCostUsd — a delegated worker's perWorker) is honoured on every payer; otherwise PER RUN caps a dollar payer,
       and a plan or local run is not stopped at an imaginary figure (2026-07-23, Andrew-approved). A line hop's remaining
       $ ceiling only ever LOWERS a dollar payer's cap (QA 2026-10-02). */
    function runBillingFor(o) {
      o = o || {};
      const cls = classOf(o.providerId), policy = POLICY[cls];
      let runCapUsd = (o.callerCapUsd > 0 && isFinite(o.callerCapUsd)) ? o.callerCapUsd
        : (!policy.dollarCaps ? Infinity
        : ((o.perRunUsd > 0 && isFinite(o.perRunUsd)) ? o.perRunUsd : Infinity));
      if (policy.dollarCaps && typeof o.ceilingUsd === 'number' && isFinite(o.ceilingUsd) && o.ceilingUsd >= 0 && !(runCapUsd <= o.ceilingUsd)) runCapUsd = Math.max(0.01, o.ceilingUsd);
      return { providerId: o.providerId, cls, policy, unmetered: !policy.ledgerMetered, managed: policy.managedAdmission,
        perCall: perCallRoute(profileOf(o.providerId)), runCapUsd, classify: classifierFor(o.providerId) };
    }
    /* A PROVIDER FALLBACK's billing: null when it would move the run to another payer (it cannot borrow a reservation from
       another payer or spend managed credit without admission); else the limits the loop swaps in on it — its own PER RUN
       unless the caller capped the run, never above the run's cap, and the unpriced ceiling only where dollars are metered. */
    function fallbackBillingFor(o) {
      o = o || {};
      const cls = classOf(o.providerId), policy = POLICY[cls];
      if (policy.managedAdmission !== !!o.runManaged) return null;
      const unmetered = !policy.ledgerMetered;
      return { providerId: o.providerId, cls, policy, unmetered, perCall: perCallRoute(profileOf(o.providerId)),
        entry: {
          unmetered,
          maxCostUsd: Math.min(o.runCapUsd, (o.callerCapUsd > 0 && isFinite(o.callerCapUsd)) ? o.callerCapUsd : !policy.dollarCaps ? Infinity : (o.perRunUsd > 0 ? o.perRunUsd : Infinity)),
          maxUnpricedTokens: policy.unpricedTokenCeiling ? o.unpricedTokens : Infinity,
          billingClassOf: classifierFor(o.providerId)   // the loop classifies this route's attempts with it (the sign-in seatbelt)
        } };
    }
    /* A SKILL EVALUATION's billing: its payer by the same rule as a run, and the cap each case run gets — the Commander's
       PER RUN, else the ceiling the station gives a run nobody capped (the managed default, issue #53), else the shipped
       default; a plan or local model gets no dollar cap. */
    function evaluationBillingFor(o) {
      o = o || {};
      const cls = classOf(o.providerId), policy = POLICY[cls];
      const perRunCapUsd = !policy.dollarCaps ? undefined
        : (o.perRunUsd > 0 && isFinite(o.perRunUsd)) ? o.perRunUsd
        : (o.managedDefaultUsd > 0 && isFinite(o.managedDefaultUsd)) ? o.managedDefaultUsd : o.shippedDefaultUsd;
      return { providerId: o.providerId, cls, policy, unmetered: !policy.ledgerMetered, managed: policy.managedAdmission, perRunCapUsd };
    }
    /* the class a HOUSEKEEPING row carries (a run-end pass, a quest refresh, a skill review or curator, a station one-shot): its
       route's payer, and a sign-in when one of its calls reported one (Claude Code's login is known only per call) */
    function auxRowClass(route, signedIn) { return billingClassOf({ providerId: route, profile: profileOf(route), usage: signedIn ? { subscription: true } : null, managed: managedFor(route) }); }
    return { classOf, policyOf, classifierFor, auxCeilingRoute, runBillingFor, spendPoolCapFor, fallbackBillingFor, evaluationBillingFor, runRowClass, bookedClass, auxRowClass };
  }

  /* ONE GOVERNOR (spend-governor S2): every paid call path asks admit(kind, o) before it calls a model, and the answer follows
     the route's payer (POLICY) with ONE error rule. It was nine blocks of their own: three readings of a check that throws
     (proceed, refuse, note and proceed), a dollar cap on calls that spend no dollars (a ChatGPT plan's one-shot and night
     shift), and no admission at all for the skill curator.
       a dollar payer (metered, managed)  budget.check (budget.js): the day/agent/global pools, strict and soft as before. A run's
                                          own check (kind 'run') asks its family's spend pool first (o.pool, run-spend-pool.js):
                                          the pool's hold or 'run' stop is its answer, and a call the pools then stop gives its
                                          reservation back.
       a sign-in plan, a local model      no dollar check: nothing either spends is dollars.
       an image (kind 'media')            budget.check whoever's run makes it: an image is paid in dollars (#164).
       a BACKGROUND kind                  first, the host's 24-hour background token gate for its route (auxgovernor.js, #105): the
                                          kinds whose rows that ceiling counts (CEILING_KINDS). The gate is route-level, so Claude
                                          Code keeps it and a key or a local model never meets it. A call the Commander triggered
                                          (trigger 'commander': a rating's review, REFRESH QUESTS) runs past it; its row still counts.
     A check that THROWS refuses (gate 'check'), never "not blocked": the refusal reads as unknown spend, so every reader of a
     verdict fails closed, and it names its exit. -> null (admitted), the pool's own verdict, or a refusal { gate: 'dollars' |
     'tokens' | 'check', kind, cls, why, exit, ...the verdict }. budget.check is asked with no clock (its own); this stays pure. */
  const KINDS = Object.freeze({
    run: Object.freeze({ background: false }),                    // a run's own calls, every turn (runOnceCore runBudget)
    media: Object.freeze({ background: false, dollars: true }),   // an image a run generates (makeMediaSpendCheck crossRun)
    aux: Object.freeze({ background: true }),                     // the run-end passes, decided together (auxgovernor.js decide)
    'skill-review': Object.freeze({ background: true }),          // a run-end nudge; a rating's review is the Commander's
    'skill-curator': Object.freeze({ background: true }),
    'quest-refresh': Object.freeze({ background: true }),         // the automatic look; REFRESH QUESTS is the Commander's
    nightshift: Object.freeze({ background: false }),             // the pre-spend check; its beats are runs (the per-run seatbelt)
    oneshot: Object.freeze({ background: false }),                // NOT RIGHT? / SET IT UP FOR ME: a press
    'skill-evaluation': Object.freeze({ background: false })      // EVALUATE: before each case run and each of its calls
  });
  const LIMITS = 'SETTINGS › SPENDING LIMITS';
  function refusalWords(r) {
    const n = v => (Number(v) || 0).toLocaleString('en-US'), usd = v => '$' + (Number(v) || 0).toFixed(2);
    if (r.gate === 'tokens') return { why: 'the 24-hour background token ceiling is reached on this route (' + n(r.used) + ' of ' + n(r.ceiling) + ' tokens)',
      exit: 'it lifts as the 24 hours roll on, or raise BACKGROUND TOKEN CEILING in an agent’s MEMORY tab (0 = off)' };
    if (r.gate === 'check') return { why: 'the spending check failed (' + r.error + ')', exit: 'restart StarNet; ' + LIMITS + ' shows what the spend record holds' };
    // budget.js names the way out of every refusal over unknown spend (unknownExit): COUNT AS or the charge, a restart, the files
    if (r.unknown) return { why: 'spend history is unavailable (' + (r.cause || 'unknown') + ')', exit: r.exit ? String(r.exit) : 'see ' + LIMITS };
    return { why: 'the ' + (r.scope || 'spending') + ' spending cap is reached' + (typeof r.cap === 'number' ? ' (' + usd(r.usd) + ' of ' + usd(r.cap) + ')' : ''),
      exit: 'RESUME it or raise it in ' + LIMITS };
  }
  /* makeGovernor({ budget, auxTokenGate(providerId) -> { blocked, used, ceiling }, classOfProvider(providerId) -> class,
     onError(kind, e)? }). onError notes what a refused check threw; it must not throw (the host's failNote never does). */
  function makeGovernor(deps) {
    deps = deps || {};
    const budget = deps.budget, auxTokenGate = deps.auxTokenGate, classOfProvider = deps.classOfProvider;
    const onError = typeof deps.onError === 'function' ? deps.onError : function () {};
    function refuse(kind, cls, gate, verdict) {
      const r = Object.assign({}, verdict, { gate, kind, cls });
      return Object.assign(r, refusalWords(r));
    }
    // a check that threw: noted, the reservation it held handed back (that failure noted too), and refused
    function failed(kind, cls, e, pool) {
      onError(kind, e);
      if (pool) { try { pool.withdraw(); } catch (w) { onError(kind, w); } }
      return refuse(kind, cls, 'check', { unknown: true, code: 'spend_history_unavailable', cause: 'check', error: String((e && e.message) || e || 'unknown error').slice(0, 200) });
    }
    function admit(kind, o) {
      o = o || {};
      const k = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
      let cls = 'metered';
      try {
        if (!k) throw new Error('no paid call path named ' + String(kind));
        if (!k.dollars) { const c = classOfProvider(o.providerId); if (isClass(c)) cls = c; }   // an unknown answer reads as a key: the strictest
      } catch (e) { return failed(kind, cls, e); }
      // the token gate first: it is the one a figure that drops on its own clears, so a caller can wait on it alone (the
      // automatic quest look stops before it stamps its cadence only for this one)
      if (k.background && o.trigger !== 'commander' && typeof auxTokenGate === 'function') {
        let g = null;
        try { g = auxTokenGate(o.providerId); } catch (e) { return failed(kind, cls, e); }
        if (g && g.blocked) return refuse(kind, cls, 'tokens', { ceiling: g.ceiling, used: g.used });
      }
      if (k.dollars || POLICY[cls].dollarCaps) {
        let reserved = false;
        try {
          if (o.pool) { const pooled = o.pool.admit(); if (pooled) return pooled; reserved = true; }
          const b = budget.check(o.runId == null ? null : o.runId, o.agentId, Number(o.spentUsd) || 0, o.now, o.emit || null, o.receiptMeta);
          if (b) { if (reserved) { reserved = false; o.pool.withdraw(); } return refuse(kind, cls, 'dollars', b); }
        } catch (e) { return failed(kind, cls, e, reserved ? o.pool : null); }
      }
      return null;
    }
    return { admit, kinds: Object.keys(KINDS) };
  }

  return { CLASSES, PAYING_ORDER, POLICY, KINDS, billingClassOf, managedRoute, perCallRoute, routeClasses, spendPoolCapFor, runRowClass, bookedClass, makeBilling, makeGovernor };
});
