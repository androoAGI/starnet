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
  return { UNKNOWN_MODEL, cleanModel, effectiveModel, effectiveUsd, effectiveRunUsd, priceDollars };
});
