/* sidecar/cost.js — token/cost accounting.
   estimate(usage, model)  -> { usd, tokens }                      (live, during stream)
   reconcile(usage, model) -> { usd, tokensIn, tokensOut, reasoningTokens, cachedTokens, cacheWriteTokens }  (authoritative)
   resolveUsage(usage)     -> { uncachedIn, cacheRead, cacheWrite, out, reasoning } | null   (the ONE count resolver)
   Provider-reported cost (`usage.cost` in dollars, or xAI's `usage.cost_in_usd_ticks`,
   1 USD = 1e10 ticks) always wins; otherwise dollars are
   computed from the catalog priceOf(model) (per-million in/out). Reasoning + cached tokens
   are tracked separately so the "truthful cost" ledger stays honest. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).cost = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /* THE ONE USAGE RESOLVER (usage receipts, cost audit 2026-11-08). An adapter's `usage` event (providers/provider.js)
     -> the five counts every reader shares: { uncachedIn, cacheRead, cacheWrite, out, reasoning }. The per-call receipt
     (usage-receipts.js) and reconcile below both read them HERE, so a receipt and a booking can never disagree.
       prompt_tokens is the TRUE input total; a cache read and a cache write are a breakdown OF it, so the three input
         buckets are clamped to sum to it (as inputUsd prices them) and a provider whose details contradict its own
         total can never make a negative count.
       a cache write is the adapters' normalized prompt_tokens_details.cache_creation_tokens (Anthropic, Claude Code,
         Codex), else the raw cache_write_tokens an OpenAI-shaped wire passes through (OpenRouter, OpenAI).
       reasoning is what the adapter says (reasoning_tokens, or the OpenAI-shaped completion_tokens_details).
     No usage -> null: a count is never made up. Pricing is NOT read from here (inputUsd keeps its own buckets), so this
     resolver can name a field without moving a single dollar. */
  function resolveUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const total = Math.max(0, num(usage.prompt_tokens));
    const d = (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object') ? usage.prompt_tokens_details : {};
    const cacheRead = Math.max(0, Math.min(num(d.cached_tokens), total));
    const write = d.cache_creation_tokens != null ? d.cache_creation_tokens : d.cache_write_tokens;
    const cacheWrite = Math.max(0, Math.min(num(write), total - cacheRead));
    const reasoning = num(usage.reasoning_tokens || (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens));
    return { uncachedIn: total - cacheRead - cacheWrite, cacheRead: cacheRead, cacheWrite: cacheWrite,
      out: Math.max(0, num(usage.completion_tokens)), reasoning: Math.max(0, reasoning) };
  }

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
        const counts = resolveUsage(usage);   // the ONE resolver: the same counts a usage receipt records for this call
        const cached = counts ? counts.cacheRead : 0;
        const reasoning = counts ? counts.reasoning : 0;
        const reported = providerCostUsd(usage);
        const providerCost = reported != null;
        const price = providerCost ? null : catalogPrice(model);
        const tokensIn = num(usage && usage.prompt_tokens);
        const tokensOut = num(usage && usage.completion_tokens);
        const usd = providerCost ? reported : (price ? inputUsd(usage, price) + tokensOut * price.out / 1e6 : 0);
        return {
          usd: usd,
          tokensIn: tokensIn,
          tokensOut: tokensOut,
          reasoningTokens: reasoning,
          cachedTokens: cached,
          cacheWriteTokens: counts ? counts.cacheWrite : 0,   // the input written to the prompt cache (part of tokensIn)
          costSource: providerCost ? 'provider' : (price ? 'catalog' : 'unpriced'),
          providerCost: providerCost,
          catalogPriced: !!price,
          unpriced: !providerCost && !price && (tokensIn + tokensOut > 0)
        };
      }
    };
  }

  return { makeCostEngine, resolveUsage };
});
