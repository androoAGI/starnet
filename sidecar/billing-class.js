/* sidecar/billing-class.js — WHO PAYS for a model call, and every limit that follows from it. One table.

   Every billing decision used to be made inline, each site with its own reading of a provider profile: ten
   `getProviderProfile(...).unmetered` reads, three copies of the managed rule, the Codex/device-OAuth exemption, the aux
   ceiling's adapter rule, and the loop's `usage.subscription === true`. They drifted: a ChatGPT, Grok or Kimi sign-in
   reports no subscription flag, so the per-run sign-in seatbelt never counted a single one of their calls.

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
     classifierFor(providerId)           a per-attempt classifier: the route's payer, which an attempt's usage can refine
     auxCeilingRoute(route)              may this route's background passes meet the aux token ceiling
     runBillingFor({ providerId, callerCapUsd, ceilingUsd, perRunUsd })   a run's payer and its $ cap before admission
     spendPoolCapFor({ runCapUsd, policy, perRunUsd })                    the run family's pool cap
     fallbackBillingFor({ providerId, runManaged, runCapUsd, callerCapUsd, perRunUsd, unpricedTokens })   a provider
                                         fallback's limits, or null when it would move the run to another payer
     evaluationBillingFor({ providerId, perRunUsd, managedDefaultUsd, shippedDefaultUsd })   a skill evaluation's
   Each is a move of the expression it replaced in sidecar/index.js; test/billing-class.parity.test.js holds every one to
   the golden snapshot taken from the base source (test/fixtures/billing-class.golden.json).

   PURE: no clock, no IO, no ambient state (lint-determinism). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).billingClass = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLASSES = Object.freeze(['metered', 'managed', 'subscription', 'local']);
  const POLICY = Object.freeze({
    metered: Object.freeze({ dollarCaps: true, managedAdmission: false, unpricedTokenCeiling: true, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: true, mediaDollarsCrossRun: false, imageUnknownCaps: true, ledgerMetered: true }),
    managed: Object.freeze({ dollarCaps: true, managedAdmission: true, unpricedTokenCeiling: true, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: true, mediaDollarsCrossRun: false, imageUnknownCaps: true, ledgerMetered: true }),
    subscription: Object.freeze({ dollarCaps: false, managedAdmission: false, unpricedTokenCeiling: false, signInTokenCeiling: true, auxTokenCeiling: true, promptTier: false, mediaDollarsCrossRun: true, imageUnknownCaps: true, ledgerMetered: false }),
    local: Object.freeze({ dollarCaps: false, managedAdmission: false, unpricedTokenCeiling: false, signInTokenCeiling: false, auxTokenCeiling: false, promptTier: false, mediaDollarsCrossRun: true, imageUnknownCaps: true, ledgerMetered: false })
  });

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
      return function billingClassOfAttempt(usage) { return billingClassOf({ providerId, profile, usage, managed }); };
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
        perCall: perCallRoute(profileOf(o.providerId)), runCapUsd };
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
          maxUnpricedTokens: policy.unpricedTokenCeiling ? o.unpricedTokens : Infinity
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
    return { classOf, policyOf, classifierFor, auxCeilingRoute, runBillingFor, spendPoolCapFor, fallbackBillingFor, evaluationBillingFor };
  }

  return { CLASSES, POLICY, billingClassOf, managedRoute, perCallRoute, routeClasses, spendPoolCapFor, makeBilling };
});
