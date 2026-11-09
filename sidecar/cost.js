/* sidecar/cost.js — token/cost accounting.
   estimate(usage, model)  -> { usd, tokens }                      (live, during stream)
   reconcile(usage, model) -> { usd, tokensIn, tokensOut, reasoningTokens, cachedTokens, cacheWriteTokens }  (authoritative)
   cacheRates(model)       -> { read, write, published } | null    (the route's cache prices, fresh-input units)
   resolveUsage(usage)     -> { uncachedIn, cacheRead, cacheWrite, cacheWrite5m?, cacheWrite1h?, out, reasoning } | null
                                                                                         (the ONE count resolver)
   writeSplit(cc, write)   -> { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } | null   (a reported tier split)
   writeUnits(write, cc, cache) -> a cache write in fresh-input units, per tier when the split was reported
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
       the write's tier split (cacheWrite5m / cacheWrite1h, W1.13) only when the provider reported one that adds up to
         the write counted here (writeSplit): Anthropic and Claude Code report usage.cache_creation; OpenRouter, the
         managed route and OpenAI report one aggregate, and get no split.
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
    const counts = { uncachedIn: total - cacheRead - cacheWrite, cacheRead: cacheRead, cacheWrite: cacheWrite };
    const split = writeSplit(d.cache_creation, cacheWrite);
    if (split) { counts.cacheWrite5m = split.ephemeral_5m_input_tokens; counts.cacheWrite1h = split.ephemeral_1h_input_tokens; }
    counts.out = Math.max(0, num(usage.completion_tokens));
    counts.reasoning = Math.max(0, reasoning);
    return counts;
  }

  /* THE WRITE'S TIER SPLIT (W1.13 cache TTL plumbing). Anthropic splits cache_creation_input_tokens by tier in
     usage.cache_creation — { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } (claude-api skill,
     shared/prompt-caching.md:208); the adapters carry it as prompt_tokens_details.cache_creation. Trusted only when both
     counts are reported and add up to the write being counted or priced: a split is never inferred, and one that
     contradicts its own aggregate is ignored. -> the split, or null. */
  function writeSplit(cc, write) {
    if (!cc || typeof cc !== 'object') return null;
    const m5 = cc.ephemeral_5m_input_tokens, h1 = cc.ephemeral_1h_input_tokens;
    const count = v => typeof v === 'number' && isFinite(v) && v >= 0;
    if (!count(m5) || !count(h1) || m5 + h1 !== write) return null;
    return { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 };
  }
  /* A cache write in fresh-input units: each tier at its own rate (prices.js write5m 1.25x / write1h 2x,
     prompt-caching.md:144) when the split was reported and the family publishes both rates; otherwise the whole write
     at the family's write rate — exactly the pre-W1.13 product, so every route without a split books what it did. */
  function writeUnits(write, cc, cache) {
    const c = cache || NO_CACHE;
    const split = (c.write5m != null && c.write1h != null) ? writeSplit(cc, write) : null;
    if (split) return split.ephemeral_5m_input_tokens * c.write5m + split.ephemeral_1h_input_tokens * c.write1h;
    return write * c.write;
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
      // the per-tier write rates, when the family publishes both (prices.js: anthropic)
      if (c !== NO_CACHE && rate(p.cache.write5m) != null && rate(p.cache.write1h) != null) { c.write5m = rate(p.cache.write5m); c.write1h = rate(p.cache.write1h); }
      return (i || o) ? { in: i, out: o, cache: c } : null;
    }
    function rate(v) { return (v != null && isFinite(Number(v)) && Number(v) >= 0) ? Number(v) : null; }
    /* INPUT dollars, cache-aware. usage.prompt_tokens stays the TRUE token count — context gauges and the
       ledger read it, and lying about tokens to fix a dollar figure would be the worse trade — so the
       discount lives HERE in the money math and nowhere else. Anthropic bills a cache read at ~0.1x and a
       write at ~1.25x (prices.js CACHE); an unmodelled family falls back to 1.0x, i.e. exactly the behaviour
       from before any adapter requested caching.
       The three buckets are clamped to sum to prompt_tokens, so a provider reporting details inconsistent
       with its own total can never manufacture a negative charge. A write the API split by tier prices each tier at
       its own rate (writeUnits: 5-minute 1.25x, 1-hour 2x); an all-5-minute split books the very same float as before. */
    function inputUsd(usage, p) {
      const total = num(usage && usage.prompt_tokens);
      if (total <= 0) return 0;
      const d = (usage && usage.prompt_tokens_details) || {};
      const read = Math.max(0, Math.min(num(d.cached_tokens), total));
      const write = Math.max(0, Math.min(num(d.cache_creation_tokens), total - read));
      return ((total - read - write) + read * p.cache.read + writeUnits(write, d.cache_creation, p.cache)) * p.in / 1e6;
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
      },
      /* THE ROUTE'S CACHE PRICES (W2.1 batched ageing weighs a batch with them): what reading and writing one cached
         prompt token costs next to a fresh one, from the very catalog row that prices the call (W1.13: `write` is the
         dearest tier the cache switch asks for). null = unpriced (a sign-in, a local model, a cold catalog): nothing to
         weigh. published: false = the row names no cache rates, so the call books them at 1.0x (NO_CACHE) and the
         prices here say nothing about the route's real cache. */
      cacheRates(model) {
        const p = catalogPrice(model);
        if (!p) return null;
        return { read: p.cache.read, write: p.cache.write, published: p.cache !== NO_CACHE };
      }
    };
  }

  return { makeCostEngine, resolveUsage, writeSplit, writeUnits };
});
