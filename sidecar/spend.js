/* sidecar/spend.js - pure helpers for honest run spend/model bookkeeping.

   The run host writes two durable rows at run end (ledger + runstore). These helpers keep the
   effective model and final USD calculation in one place so those rows cannot drift. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).spend = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const UNKNOWN_MODEL = '(unknown)';
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  function str(v) { return v == null ? '' : String(v); }
  function cleanModel(v, max) {
    const s = str(v).trim();
    return (s || UNKNOWN_MODEL).slice(0, max || 80);
  }
  function priceDollars(price, tokensIn, tokensOut) {
    if (!price) return 0;
    const inPrice = num(price.in != null ? price.in : price.prompt);
    const outPrice = num(price.out != null ? price.out : price.completion);
    if (!inPrice && !outPrice) return 0;
    return (num(tokensIn) * inPrice + num(tokensOut) * outPrice) / 1e6;
  }

  function effectiveModel(o) {
    o = o || {};
    const result = o.result || {};
    const candidates = [
      result.model,
      o.requestedModel,
      o.usingCodex ? o.codexDefaultModel : '',
      o.defaultModel
    ];
    for (const c of candidates) {
      const s = str(c).trim();
      if (s) return cleanModel(s);
    }
    return UNKNOWN_MODEL;
  }

  // Backfill only genuinely unpriced metered usage: no provider-reported usage.cost, base run USD is
  // still zero, and a catalog price is now available. Subscription/unmetered runs stay out of USD.
  function effectiveUsd(o) {
    o = o || {};
    const base = Math.max(0, num(o.usd));
    if (o.unmetered || base !== 0 || typeof o.priceOf !== 'function') return base;
    const rows = Array.isArray(o.unpricedUsage) ? o.unpricedUsage : [];
    let extra = 0;
    for (const r of rows) {
      const model = cleanModel(r && r.model);
      const tokensIn = num(r && (r.tokensIn != null ? r.tokensIn : r.prompt_tokens));
      const tokensOut = num(r && (r.tokensOut != null ? r.tokensOut : r.completion_tokens));
      if (tokensIn + tokensOut <= 0) continue;
      extra += priceDollars(o.priceOf(model), tokensIn, tokensOut);
    }
    return extra > 0 ? extra : base;
  }

  // Auxiliary media is real metered spend even when the conversation uses a subscription.
  // Keep legacy subscription-only estimates unchanged; mixed runs show only actual dollars.
  function effectiveRunUsd(o) {
    const media = Math.max(0, num(o && o.mediaUsd));
    if (!media) return effectiveUsd(o);
    if (o.unmetered) return media;
    return effectiveUsd(Object.assign({}, o, { usd: Math.max(0, num(o.usd) - media) })) + media;
  }
  /* #164: may this run start a paid generation? spentUsd: what the loop has booked; pendingUsd: media charges it has not
     drained yet (they drain when the turn's tools end, so a second image in one turn must count the first); capUsd: the
     per-run limit; verdict: the cross-run check's answer ({ scope, usd, cap } | { unknown } | null; a hold never gets here:
     makeMediaSpendCheck waits it out). -> why not, or ''. A call whose price nobody knows yet can still pass a limit; only
     a limit already reached stops it. */
  function mediaSpendStop(o) {
    o = o || {};
    const spent = Math.max(0, num(o.spentUsd)) + Math.max(0, num(o.pendingUsd));
    const money = n => '$' + Math.max(0, num(n)).toFixed(2);
    if (typeof o.capUsd === 'number' && isFinite(o.capUsd) && spent >= o.capUsd) return 'this run has spent ' + money(spent) + ' of its ' + money(o.capUsd) + ' spending limit';
    const v = o.verdict;
    if (!v) return '';
    if (v.unknown) return 'the spending limits you set can\u2019t be checked right now';
    return 'the ' + String(v.scope || 'spending') + ' spending limit is reached' + (typeof v.cap === 'number' ? ' (' + money(v.usd) + ' of ' + money(v.cap) + ')' : '');
  }
  /* #164: the run host's answer to image_generate, before it spends. o: readView() the loop's own figures ({ spentUsd,
     maxCostUsd }, or null before it starts); pendingUsd() media charges not drained yet; mediaUsd() every media charge of this
     run; pool the run's spend pool; runId; unmetered: a subscription chat; crossRun(spentUsd) the day/global limits' answer.
     THE POOL'S RULES, not a second set of them:
     - it is told only what the loop has BOOKED. A pending charge reaches it through agent.cost (booked), so handing it the
       pending too counted a second image twice: two $0.20 images under a $0.50 cap read $0.60 and stopped the family early.
       The pending charge counts here, read-only, against the pool's cap.
     - a generation is a call with no price, so while it runs its family's other calls wait, and it waits for theirs: a hold
       means "not yet", never "no". It asks again when the call in flight settles, and only the run's abort ends the wait.
     - a subscription chat's tokens are an estimate against a flat plan, so they are not dollars here. Only what this run's
       media really cost goes to the day/global limits. That run has no per-run limit unless a caller set one (runCapUsd is
       Infinity there), and its media is not booked to the pool: the PER RUN setting does not stop a subscription chat's
       paid images. The day, agent and all-time limits do, and SETTINGS says so.
     An image whose cost nobody knows adds $0 to all of this, so no limit can stop those. SETTINGS says that too. -> why not, or ''. */
  function makeMediaSpendCheck(o) {
    const waitOn = (hold, signal) => new Promise(resolve => {
      if (signal && signal.aborted) return resolve();
      const done = () => { if (signal) signal.removeEventListener('abort', done); resolve(); };
      if (signal) signal.addEventListener('abort', done);
      Promise.resolve(hold).then(done, done);
    });
    return async function mediaSpend(signal) {
      for (;;) {
        const view = o.readView();
        const pendingUsd = Math.max(0, num(o.pendingUsd()));
        const spentUsd = view ? num(view.spentUsd) : Math.max(0, num(o.mediaUsd()) - pendingUsd);
        let verdict = null;
        try {
          if (o.unmetered) verdict = o.crossRun(num(o.mediaUsd()));
          else {
            const family = o.pool.status();
            if (typeof family.capUsd === 'number' && isFinite(family.capUsd) && num(family.spentUsd) + pendingUsd >= family.capUsd) verdict = { scope: 'run', usd: num(family.spentUsd) + pendingUsd, cap: family.capUsd };
            else {
              verdict = o.pool.admit(o.runId, spentUsd, 0);
              if (!verdict) {
                verdict = o.crossRun(spentUsd + pendingUsd);
                if (verdict) o.pool.withdraw(o.runId);   // stopped by a day/global limit: this generation never goes out
              }
            }
          }
        } catch (_) { verdict = { unknown: true }; if (typeof o.onCheckError === 'function') o.onCheckError(_); }
        if (verdict && verdict.hold) {
          await waitOn(verdict.hold, signal);
          if (signal && signal.aborted) return 'the run was stopped while it waited for its other calls to finish';
          continue;
        }
        return mediaSpendStop({ spentUsd, pendingUsd, capUsd: view ? view.maxCostUsd : undefined, verdict });
      }
    };
  }
  /* #164: what a run's two spend rows say about its media. A generation with no provider figure and no catalog price books $0,
     which is not a known $0: the row is marked unpriced (its usd is a floor). A subscription run stays a subscription run
     (the insights fold keeps its tokens and its label); its unpriced flag can only come from the image, since a plan's own
     tokens are never marked unpriced (index.js runUnpriced), and the recap says so. */
  function mediaRunFlags(o) {
    o = o || {};
    const unknownMedia = num(o.mediaUnpriced) > 0;
    return { unmetered: !!o.runUnmetered && num(o.mediaUsd) === 0, unpriced: !!o.runUnpriced || unknownMedia };
  }
  return { UNKNOWN_MODEL, cleanModel, effectiveModel, effectiveUsd, effectiveRunUsd, priceDollars, mediaSpendStop, makeMediaSpendCheck, mediaRunFlags };
});
