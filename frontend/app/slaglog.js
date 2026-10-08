/* STARNET — slaglog.js : the SLAG post-mortem — wasted-spend, turned into a lesson.

   The standout teaching mechanic of the floor economy. Every run that burns real dollars
   without producing a deliverable (agent.run.end reason ∈ max_iters | budget | error |
   refusal) is diagnosed into a plain-English { title, cause, fix } pointing at a REAL,
   actionable cause — so the factory "optimise the line" instinct gets aimed at the genuinely
   valuable skill: operating real agents cheaply and well. (You don't get punished for the
   waste; you get told why it happened and what to change.)

   Pure heuristic over the signals already on the bus — the run's end reason, its turn count
   (agent.run.end.turns), and the most recent reconciled cache ratio (agent.cost.cachedTokens
   / tokensIn, the prompt-cache "smelter" temperature). No fabricated specifics: when a signal
   is unknown the wording stays general rather than inventing a number.

   Dependency-free + deterministic (no DOM / time / rng): a `SlagLog` global in the browser,
   module.exports under node — unit-testable headless like floorstats.js / ctxgauge.js. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SlagLog = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLD_CACHE = 0.15;   // below this the prompt-cache is basically cold (the smelter is dark)
  // FriendlyError kinds whose message already names the real door (friendlyerror.js KINDS, retryable:false).
  // Absent on purpose: unknown + server_error (plausibly StarNet's own fault — those keep "report it").
  const KNOWN_ERROR_KINDS = { billing: 1, managed_credit: 1, managed_credit_link: 1, auth: 1, no_model: 1, oauth: 1, grok_oauth_unavailable: 1,
    quota_exhausted: 1, model_not_found: 1, context_overflow: 1, content_policy_blocked: 1, capdenied: 1,
    spotify_not_connected: 1, stale_session: 1, spend_unknown: 1 };
  // …and the retryable kinds whose message names a door that is NOT StarNet's bug: an unanswered StarNet balance check,
  // a provider's outage or rate limit, an agent still busy with its last run. Their own message is the fix; a resend in a
  // moment CAN go through, so the cause must not say it won't (2026-10-08: a refused link / an unanswered balance check
  // became "copy the diagnostics … report it"). network + timeout stay generic with unknown/server_error.
  const RETRY_ERROR_KINDS = { managed_credit_unavailable: 1, provider_server_error: 1, provider_unreachable: 1, rate_limit: 1, agent_busy: 1 };

  function clampFrac(n) { n = Number(n); if (!isFinite(n) || n < 0) return 0; return n > 1 ? 1 : n; }

  // reason + run signals -> a real, fixable post-mortem. ctx = { cacheFrac, turns, usd, error: { kind, msg } }, all optional.
  function diagnose(reason, ctx) {
    ctx = ctx || {};
    const turns = Math.max(0, ctx.turns | 0);
    const cacheKnown = ctx.cacheFrac != null && isFinite(Number(ctx.cacheFrac));
    const cachePct = Math.round(clampFrac(ctx.cacheFrac) * 100);
    switch (reason) {
      case 'max_iters':
        return { reason, title: 'looped without finishing',
          cause: 'The agent ran ' + (turns ? 'all ' + turns + ' turns' : 'its full iteration budget') + ' but never closed out the task.',
          fix: 'Tighten the ask, or give its bay the tool it kept reaching for — a cabinet for files, a console for compute.' };
      case 'budget':
        // a StarNet run whose ceiling was the WALLET (agent.run.end budgetCapIsBalance — admission clamped it to the
        // reported balance): raising a budget buys nothing there, and COMMS already says "add credits" for the same stop
        if (ctx.atBalance === true)
          return { reason, title: 'used the rest of the StarNet balance',
            cause: 'The run used what was left on your StarNet balance before it delivered.',
            fix: 'Add credits under SETTINGS → AI & MODELS to keep going, or split the work into smaller work-items.' };
        if (cacheKnown && Number(ctx.cacheFrac) < COLD_CACHE)
          return { reason, title: 'budget cap on a cold cache',
            cause: 'The run hit its cap with the prompt-cache cold (' + cachePct + '%), so repeated input could not reuse much cache.',
            fix: 'Keep the system prompt + memory fence STABLE so repeated input can reuse cache.' };
        return { reason, title: 'hit the budget cap',
          cause: 'The run reached its envelope before it delivered.',
          fix: 'Raise the budget for this kind of order, or split it into smaller work-items.' };
      case 'error':
        // the run's OWN error, already classified by the caller (FriendlyError over its agent.run.error message):
        // a KNOWN cause — an empty provider wallet, a model the key can't use, a missing key — names its real
        // fix. "send it again, then report it" is wrong there: a resend hits the same wall and the "bug" is the
        // account (2026-10-07: three Anthropic "credit balance is too low" runs became a quest telling the
        // Commander to report StarNet).
        if (ctx.error && ctx.error.msg && KNOWN_ERROR_KINDS[ctx.error.kind])
          return { reason, title: 'errored out',
            cause: 'The run stopped before doing any work, for a reason a resend will not fix.',
            fix: String(ctx.error.msg) };
        if (ctx.error && ctx.error.msg && RETRY_ERROR_KINDS[ctx.error.kind])
          return { reason, title: 'errored out',
            cause: 'The run was stopped by a temporary problem outside the task, so a resend in a moment can go through.',
            fix: String(ctx.error.msg) };
        return { reason, title: 'errored out',
          cause: 'The run failed partway, so no useful work was produced.',
          // no "agent log" exists and the cause is often the station's own bug (first-hour walk 2026-09-28): name
          // what a person can actually do — see the failed step, send it again, report it if it repeats.
          fix: 'Open the agent’s RECORD tab to see which step failed, then send the request again. If it fails the same way, copy the diagnostics from the failed reply and report it.' };
      case 'refusal':
        return { reason, title: 'the model refused',
          cause: 'The model declined the task, so no work was produced.',
          fix: 'Rephrase the request, or route this lane to an agent equipped for it.' };
      default:
        return { reason: reason || 'unknown', title: 'unproductive run',
          cause: 'A run ended without a deliverable.',
          fix: 'Review the run and adjust the task or the bay.' };
    }
  }

  // a single-line summary for a notification/HUD line: "looped without finishing — Tighten the ask…"
  function line(diag) {
    if (!diag) return '';
    return diag.title + ' — ' + diag.fix;
  }

  // a small ring of the most-recent post-mortems (for a reviewable SLAG LOG surface).
  function create(cap) {
    cap = cap > 0 ? (cap | 0) : 20;
    let recent = [];
    function record(reason, ctx) {
      const d = diagnose(reason, ctx);
      // which agent's run died — the maintenance quest needs it to tell when THAT line runs clean again
      if (ctx && ctx.agentId) d.agentId = String(ctx.agentId);
      recent.push(d);
      if (recent.length > cap) recent = recent.slice(-cap);
      return d;
    }
    function reset() { recent = []; }
    return { record, recent: () => recent.slice(), reset };
  }

  return { diagnose, line, create, COLD_CACHE };
});
