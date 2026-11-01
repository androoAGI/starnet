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
     per-run limit; verdict: the cross-run check's answer ({ scope, usd, cap } | { unknown } | { hold } | null).
     -> why not, or ''. A call whose price nobody knows yet can still pass a limit; only a limit already reached stops it. */
  function mediaSpendStop(o) {
    o = o || {};
    const spent = Math.max(0, num(o.spentUsd)) + Math.max(0, num(o.pendingUsd));
    const money = n => '$' + Math.max(0, num(n)).toFixed(2);
    if (typeof o.capUsd === 'number' && isFinite(o.capUsd) && spent >= o.capUsd) return 'this run has spent ' + money(spent) + ' of its ' + money(o.capUsd) + ' spending limit';
    const v = o.verdict;
    if (!v) return '';
    if (v.unknown) return 'the spending limits you set can\u2019t be checked right now';
    if (v.hold) return 'the calls already running on this run\u2019s shared limit leave no room for it';
    return 'the ' + String(v.scope || 'spending') + ' spending limit is reached' + (typeof v.cap === 'number' ? ' (' + money(v.usd) + ' of ' + money(v.cap) + ')' : '');
  }
  /* #164: what a run's two spend rows say about its media. A generation with no provider figure and no catalog price books $0,
     which is not a known $0: the row is marked unpriced (its usd is a floor), and a subscription run that made one is
     not reported as a run with no dollar spend. */
  function mediaRunFlags(o) {
    o = o || {};
    const unknownMedia = num(o.mediaUnpriced) > 0;
    return { unmetered: !!o.runUnmetered && num(o.mediaUsd) === 0 && !unknownMedia, unpriced: !!o.runUnpriced || unknownMedia };
  }
  return { UNKNOWN_MODEL, cleanModel, effectiveModel, effectiveUsd, effectiveRunUsd, priceDollars, mediaSpendStop, mediaRunFlags };
});
