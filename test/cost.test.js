/* node test/cost.test.js — token/cost accounting. */
'use strict';
const A = require('./_assert.js');
const { makeCostEngine } = require('../sidecar/cost.js');

const priceOf = id => id === 'm' ? { in: 1, out: 2 } : null; // $1 / 1M in, $2 / 1M out
const ce = makeCostEngine({ priceOf });

// estimate from catalog pricing
const e = ce.estimate({ prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }, 'm');
A.ok(Math.abs(e.usd - (1000 * 1 + 500 * 2) / 1e6) < 1e-12, 'estimate usd from catalog pricing');
A.eq(e.tokens, 1500, 'estimate total tokens');

// provider-reported cost overrides the catalog estimate
A.eq(ce.estimate({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.042 }, 'm').usd, 0.042, 'provider cost wins');

// reconcile splits reasoning + cached out
const r = ce.reconcile({
  prompt_tokens: 1000, completion_tokens: 500,
  prompt_tokens_details: { cached_tokens: 200 }, reasoning_tokens: 50
}, 'm');
A.eq(r.tokensIn, 1000, 'reconcile tokensIn');
A.eq(r.tokensOut, 500, 'reconcile tokensOut');
A.eq(r.cachedTokens, 200, 'cached tokens tracked separately');
A.eq(r.reasoningTokens, 50, 'reasoning tokens tracked separately');
A.ok(Math.abs(r.usd - 2000 / 1e6) < 1e-12, 'reconcile usd');
A.eq(r.costSource, 'catalog', 'catalog-priced reconcile is labeled');
A.eq(r.unpriced, false, 'catalog-priced usage is not unpriced');

const pc = ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.042 }, 'm');
A.eq(pc.usd, 0.042, 'provider cost wins in reconcile');
A.eq(pc.costSource, 'provider', 'provider-priced reconcile is labeled');
A.eq(ce.reconcile({ prompt_tokens: 1, completion_tokens: 1, cost: '0.125' }, 'm').usd, 0.125, 'numeric string provider cost is preserved');

// xAI reports cost as USD ticks (1 USD = 1e10 ticks) — normalized into real dollars
const ticks = ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost_in_usd_ticks: 420000000 }, 'm');
A.ok(Math.abs(ticks.usd - 0.042) < 1e-12, 'xAI cost_in_usd_ticks normalizes to USD');
A.eq(ticks.costSource, 'provider', 'ticks-priced reconcile is labeled provider');
A.ok(Math.abs(ce.estimate({ prompt_tokens: 1, cost_in_usd_ticks: 420000000 }, 'unknown').usd - 0.042) < 1e-12, 'ticks cost wins in estimate too');
A.eq(ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.05, cost_in_usd_ticks: 420000000 }, 'm').usd, 0.05, 'dollar cost field wins over ticks when both present');
A.eq(ce.reconcile({ prompt_tokens: 100, completion_tokens: 20, cost_in_usd_ticks: 'junk' }, 'unknown').costSource, 'unpriced', 'non-numeric ticks are ignored, not billed');

// reasoning via completion_tokens_details fallback
A.eq(ce.reconcile({ prompt_tokens: 1, completion_tokens: 1, completion_tokens_details: { reasoning_tokens: 7 } }, 'm').reasoningTokens, 7, 'reasoning via completion_tokens_details');

// unknown model + no cost -> 0 usd (never guess)
A.eq(ce.estimate({ prompt_tokens: 100 }, 'unknown').usd, 0, 'no price + no cost -> 0 usd');
const unpriced = ce.reconcile({ prompt_tokens: 100, completion_tokens: 20 }, 'unknown');
A.eq(unpriced.usd, 0, 'unpriced reconcile stays zero before catalog evidence');
A.eq(unpriced.costSource, 'unpriced', 'unpriced usage is labeled');
A.eq(unpriced.unpriced, true, 'unpriced usage is marked for final backfill');

// null usage is safe
A.eq(ce.estimate(null, 'm').usd, 0, 'null usage estimate -> 0');
A.eq(ce.estimate(null, 'm').tokens, 0, 'null usage tokens -> 0');
A.eq(ce.reconcile(null, 'm').tokensIn, 0, 'null usage reconcile -> 0');

/* CACHE-AWARE INPUT PRICING. anthropic.js asks for prompt caching, so cached prompt tokens are a majority of
   the input bill on a real run — pricing them at the fresh rate would overstate every cached run. The token
   COUNT stays whole (context gauges read it); only the dollars are discounted. */
{
  // $1/M in, $2/M out, reads at 0.1x and writes at 1.25x.
  const cached = makeCostEngine({ priceOf: id => id === 'c' ? { in: 1, out: 2, cache: { read: 0.1, write: 1.25 } } : null });

  // 1000 in = 200 fresh + 700 read + 100 write -> 200 + 70 + 125 = 395 billable-equivalent.
  const u = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 700, cache_creation_tokens: 100 } };
  const r = cached.reconcile(u, 'c');
  A.ok(Math.abs(r.usd - (395 + 1000) / 1e6) < 1e-12, 'cache reads bill 0.1x and writes 1.25x');
  A.eq(r.tokensIn, 1000, 'the TOKEN count stays whole — only the dollars are discounted');
  A.eq(r.cachedTokens, 700, 'cachedTokens still reported for the ledger');
  A.ok(Math.abs(cached.estimate(u, 'c').usd - (395 + 1000) / 1e6) < 1e-12, 'estimate applies the same discount as reconcile');

  // Same usage priced WITHOUT published cache rates must be unchanged from the pre-caching behaviour.
  const flat = makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) });
  A.ok(Math.abs(flat.reconcile(u, 'x').usd - (1000 + 1000) / 1e6) < 1e-12, 'an unmodelled family still prices cached tokens at the fresh rate (over-reports, never under)');

  // A provider contradicting its own total must not be able to manufacture a negative charge.
  const bogus = { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 9999, cache_creation_tokens: 9999 } };
  A.ok(Math.abs(cached.reconcile(bogus, 'c').usd - 10 / 1e6) < 1e-12, 'detail fields are clamped to prompt_tokens — no negative charge');
  A.ok(cached.reconcile(bogus, 'c').usd >= 0, 'billed dollars are never negative');

  // A real billed figure from the provider still outranks all of this.
  A.eq(cached.reconcile({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.042, prompt_tokens_details: { cached_tokens: 900 } }, 'c').usd,
    0.042, 'provider-reported cost still wins over cache-aware catalog math');

  // Zero-cache usage prices exactly as it did before caching existed.
  A.ok(Math.abs(cached.reconcile({ prompt_tokens: 1000, completion_tokens: 500 }, 'c').usd - 2000 / 1e6) < 1e-12, 'usage with no cache details is unaffected');
}

/* The rates have to actually reach cost.js through the real catalog, not just through a test stub. */
{
  const prices = require('../sidecar/providers/prices.js');
  // W1.13: plus the per-tier write rates (5-minute 1.25x, 1-hour 2x; claude-api skill prompt-caching.md:144) that price
  // a write the API split by tier (cost.js writeUnits)
  A.eq(prices.priceOf('anthropic', 'claude-opus-4-5').cache, { read: 0.10, write: 1.25, write5m: 1.25, write1h: 2.00 }, 'anthropic prices carry cache rates');
  A.eq(prices.priceOf('gemini', 'gemini-2.5-pro').cache, { read: 0.25, write: 1.00 }, 'gemini prices carry cache rates');
  A.eq(prices.priceOf('anthropic', 'nope-not-a-model'), null, 'an unmatched id is still honestly unpriced');
}

/* resolveUsage — the ONE split of a call's usage that the ledger (reconcile) and the usage receipts share (W1.1):
   prompt_tokens is the TRUE total; cache reads and cache writes come out of it; the rest is uncached input. */
{
  const { resolveUsage } = require('../sidecar/cost.js');
  A.eq(resolveUsage({ prompt_tokens: 1000, completion_tokens: 60, reasoning_tokens: 20, prompt_tokens_details: { cached_tokens: 700, cache_creation_tokens: 200 } }),
    { uncachedIn: 100, cacheRead: 700, cacheWrite: 200, out: 60, reasoning: 20 }, 'a call split: uncached / cache read / cache write / out / reasoning');
  A.eq(resolveUsage({ prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 300 } }).cacheWrite, 300,
    'an OpenAI-style cache_write_tokens is a cache write too');
  A.eq(resolveUsage({ prompt_tokens: 1000, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 4 } }).reasoning, 4, 'reasoning via completion_tokens_details');
  A.eq(resolveUsage({ prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 90, cache_creation_tokens: 500 } }),
    { uncachedIn: 0, cacheRead: 90, cacheWrite: 10, out: 1, reasoning: 0 }, 'detail fields are clamped to the total: never a negative uncached count');
  A.eq([resolveUsage(null), resolveUsage('x')], [null, null], 'no usage is no counts (unknown), never zeros');
  const withWrite = ce.reconcile({ prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200, cache_creation_tokens: 300 } }, 'm');
  A.eq([withWrite.cachedTokens, withWrite.cacheWriteTokens], [200, 300], 'reconcile now reports cache writes beside cache reads');
  A.ok(Math.abs(withWrite.usd - 2000 / 1e6) < 1e-12, '...and its dollars are unchanged by the new field (a model with no cache rates prices every input token fresh)');
  A.eq(ce.reconcile(null, 'm').cacheWriteTokens, 0, 'null usage: no cache writes');
}

A.report('cost.test');
