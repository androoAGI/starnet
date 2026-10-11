/* sidecar/cost.js — token/cost accounting.
   estimate(usage, model)  -> { usd, tokens }                      (live, during stream)
   reconcile(usage, model) -> { usd, tokensIn, tokensOut, reasoningTokens, cachedTokens, cacheWriteTokens,
                                weightedTokens, unbilled }  (authoritative)
   Provider-reported cost (`usage.cost` in dollars, or xAI's `usage.cost_in_usd_ticks`,
   1 USD = 1e10 ticks) always wins; otherwise dollars are
   computed from the catalog priceOf(model) (per-million in/out). Reasoning + cached tokens
   are tracked separately so the "truthful cost" ledger stays honest.
   UNBILLED usage (2026-10-11): a Claude Code SUBSCRIPTION turn books $0 (nothing is billed per call), so no $ cap
   ever sees it. The provider flags such a turn usage.subscription === true; reconcile marks it unbilled and weighs its
   tokens (UNBILLED_WEIGHTS: uncached input 1, cache write 2, cache read 0.1, output 5) so the subscription usage
   limit has a measure. An ESTIMATE of relative load, never Anthropic's own meter. A free model that reports cost 0
   WITHOUT the flag is not unbilled — only the explicit flag counts. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cost = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
  // the weights behind weightedTokens (subscription usage limit). Relative load of each token kind, mirroring the
  // published Anthropic price ratios (cache read ~0.1x, cache write ~1.25-2x, output ~5x of fresh input).
  const UNBILLED_WEIGHTS = Object.freeze({ input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 });

  // A family whose cache rates are not published prices cached tokens exactly like fresh ones — the
  // pre-caching behaviour, and the direction that can only ever OVER-report a spend seatbelt.
  const NO_CACHE = { read: 1, write: 1 };

  function makeCostEngine(opts) {
    opts = opts || {};
    const priceOf = opts.priceOf;

    // Provider-reported real billed cost, normalized to USD. `usage.cost` is already dollars
    // (OpenRouter). xAI reports `usage.cost_in_usd_ticks` where 1 USD = 10^10 ticks
    // (docs.x.ai/developers/cost-tracking). Returns null when the provider reported nothing.
    function providerCostUsd(usage) {
      if (!usage) return null;
      if (usage.cost != null && isFinite(Number(usage.cost))) return Number(usage.cost);
      if (usage.cost_in_usd_ticks != null && isFinite(Number(usage.cost_in_usd_ticks))) return Number(usage.cost_in_usd_ticks) / 1e10;
      return null;
    }
    function hasProviderCost(usage) { return providerCostUsd(usage) != null; }
    function catalogPrice(model) {
      const p = priceOf && priceOf(model);
      if (!p) return 0;
      const i = num(p.in != null ? p.in : p.prompt);
      const o = num(p.out != null ? p.out : p.completion);
      const c = (p.cache && isFinite(Number(p.cache.read)) && isFinite(Number(p.cache.write)))
        ? { read: Number(p.cache.read), write: Number(p.cache.write) } : NO_CACHE;
      return (i || o) ? { in: i, out: o, cache: c } : null;
    }
    /* INPUT dollars, cache-aware. usage.prompt_tokens stays the TRUE token count — context gauges and the
       ledger read it, and lying about tokens to fix a dollar figure would be the worse trade — so the
       discount lives HERE in the money math and nowhere else. Anthropic bills a cache read at ~0.1x and a
       write at ~1.25x (prices.js CACHE); an unmodelled family falls back to 1.0x, i.e. exactly the behaviour
       from before any adapter requested caching.
       The three buckets are clamped to sum to prompt_tokens, so a provider reporting details inconsistent
       with its own total can never manufacture a negative charge. */
    function inputUsd(usage, p) {
      const total = num(usage && usage.prompt_tokens);
      if (total <= 0) return 0;
      const d = (usage && usage.prompt_tokens_details) || {};
      const read = Math.max(0, Math.min(num(d.cached_tokens), total));
      const write = Math.max(0, Math.min(num(d.cache_creation_tokens), total - read));
      return ((total - read - write) + read * p.cache.read + write * p.cache.write) * p.in / 1e6;
    }
    function dollars(usage, model) {
      const reported = providerCostUsd(usage);
      if (reported != null) return reported;
      const p = catalogPrice(model);
      if (!p) return 0;
      return inputUsd(usage, p) + num(usage && usage.completion_tokens) * p.out / 1e6;
    }
    function totalTokens(usage) {
      if (!usage) return 0;
      return num(usage.total_tokens) || (num(usage.prompt_tokens) + num(usage.completion_tokens));
    }

    return {
      estimate(usage, model) {
        return { usd: dollars(usage, model), tokens: totalTokens(usage) };
      },
      reconcile(usage, model) {
        const cached = num(usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens);
        const reasoning = num(usage && (usage.reasoning_tokens ||
          (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens)));
        const reported = providerCostUsd(usage);
        const providerCost = reported != null;
        const price = providerCost ? null : catalogPrice(model);
        const tokensIn = num(usage && usage.prompt_tokens);
        const tokensOut = num(usage && usage.completion_tokens);
        const usd = providerCost ? reported : (price ? inputUsd(usage, price) + tokensOut * price.out / 1e6 : 0);
        // weighted tokens: the three input buckets clamped to sum to prompt_tokens exactly as inputUsd clamps them
        const d = (usage && usage.prompt_tokens_details) || {};
        const wRead = Math.max(0, Math.min(num(d.cached_tokens), tokensIn));
        const wWrite = Math.max(0, Math.min(num(d.cache_creation_tokens), tokensIn - wRead));
        const uncached = Math.max(0, tokensIn - wRead - wWrite);
        const W = UNBILLED_WEIGHTS;
        const weightedTokens = Math.round(uncached * W.input + wWrite * W.cacheWrite + wRead * W.cacheRead + Math.max(0, tokensOut) * W.output);
        return {
          usd: usd,
          tokensIn: tokensIn,
          tokensOut: tokensOut,
          reasoningTokens: reasoning,
          cachedTokens: cached,
          costSource: providerCost ? 'provider' : (price ? 'catalog' : 'unpriced'),
          providerCost: providerCost,
          catalogPriced: !!price,
          unpriced: !providerCost && !price && (tokensIn + tokensOut > 0),
          cacheWriteTokens: num(d.cache_creation_tokens),
          weightedTokens: weightedTokens,
          unbilled: !!(usage && usage.subscription === true) && (tokensIn + tokensOut) > 0
        };
      }
    };
  }

  return { makeCostEngine, UNBILLED_WEIGHTS };
});
