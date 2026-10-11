/* node test/cost.unbilled.test.js — the WEIGHTED-token measure behind the subscription usage limit (2026-10-11).

   A Claude Code subscription turn books $0 (nothing is billed per call), so every $ guard is blind to it. cost.js
   reconcile weighs such a turn's tokens: uncached input 1, cache write 2, cache read 0.1, output 5 (UNBILLED_WEIGHTS),
   and marks it `unbilled` ONLY when the provider flagged it usage.subscription === true. Pinned here:
     • the weights and the arithmetic (rounded), with the three input buckets clamped exactly like inputUsd clamps them;
     • the flag-only rule: a free model reporting cost 0 WITHOUT the flag is not unbilled, nor is an API-key turn;
     • every pre-existing reconcile field is unchanged (usd, costSource, unpriced, cachedTokens). */
'use strict';
const A = require('./_assert.js');
const { makeCostEngine, UNBILLED_WEIGHTS } = require('../sidecar/cost.js');

const ce = makeCostEngine({ priceOf: () => null });

// ---- the weights ----
A.eq(UNBILLED_WEIGHTS, { input: 1, cacheWrite: 2, cacheRead: 0.1, output: 5 }, 'the published weights');
A.ok(Object.isFrozen(UNBILLED_WEIGHTS), 'the weights cannot be mutated by a caller');

// ---- a subscription turn: the claude-cli adapter's usage shape ----
const sub = { prompt_tokens: 33000, completion_tokens: 500, total_tokens: 33500,
  prompt_tokens_details: { cached_tokens: 30000, cache_creation_tokens: 2000 }, reasoning_tokens: 0, cost: 0, subscription: true };
const c = ce.reconcile(sub, 'sonnet');
A.eq(c.weightedTokens, 1000 * 1 + 2000 * 2 + 30000 * 0.1 + 500 * 5, '1000 + 4000 + 3000 + 2500 = 10,500 weighted');
A.eq(c.weightedTokens, 10500, 'the e2e fixture figure');
A.eq(c.unbilled, true, 'a flagged subscription turn with tokens is unbilled');
A.eq(c.cacheWriteTokens, 2000, 'cacheWriteTokens is reported (additive)');
A.eq([c.usd, c.costSource, c.providerCost, c.unpriced, c.cachedTokens, c.tokensIn, c.tokensOut], [0, 'provider', true, false, 30000, 33000, 500],
  'every existing field is unchanged: $0 provider-reported, not unpriced');

// rounding
A.eq(ce.reconcile({ prompt_tokens: 3, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 3 }, cost: 0, subscription: true }, 'm').weightedTokens, 0, '0.3 rounds to 0');
A.eq(ce.reconcile({ prompt_tokens: 5, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 5 }, cost: 0, subscription: true }, 'm').weightedTokens, 1, '0.5 rounds to 1');

// ---- clamping: inconsistent details never manufacture tokens (or negative ones) ----
{
  // read + write claim more than the prompt total: read clamps to the total, write to what is left (0)
  const over = ce.reconcile({ prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 150, cache_creation_tokens: 50 }, cost: 0, subscription: true }, 'm');
  A.eq(over.weightedTokens, 10, 'read clamps to 100 (x0.1 = 10), write clamps to 0, uncached to 0');
  const writeOver = ce.reconcile({ prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 40, cache_creation_tokens: 500 }, cost: 0, subscription: true }, 'm');
  A.eq(writeOver.weightedTokens, Math.round(40 * 0.1 + 60 * 2), 'write clamps to total - read (60); uncached 0');
  const neg = ce.reconcile({ prompt_tokens: 100, completion_tokens: -5, prompt_tokens_details: { cached_tokens: -10, cache_creation_tokens: -10 }, cost: 0, subscription: true }, 'm');
  A.ok(neg.weightedTokens >= 0 && neg.weightedTokens === 100, 'negative buckets clamp to 0: all 100 count as uncached, negative output adds nothing');
}

// ---- the flag-only rule ----
{
  const noFlag = ce.reconcile(Object.assign({}, sub, { subscription: undefined }), 'm');
  A.eq(noFlag.unbilled, false, 'a free model reporting cost 0 WITHOUT the flag is NOT unbilled');
  A.eq(noFlag.weightedTokens, 10500, 'weightedTokens is still computed (it is the flag that decides)');
  A.eq(ce.reconcile(Object.assign({}, sub, { subscription: 'yes' }), 'm').unbilled, false, 'only subscription === true counts');
  const apiKey = ce.reconcile(Object.assign({}, sub, { subscription: undefined, cost: 0.42 }), 'm');
  A.eq([apiKey.unbilled, apiKey.usd], [false, 0.42], 'an API-key claude-cli turn is billed, never unbilled');
  A.eq(ce.reconcile({ prompt_tokens: 0, completion_tokens: 0, cost: 0, subscription: true }, 'm').unbilled, false, 'a zero-token turn is not unbilled use');
  A.eq(ce.reconcile(null, 'm').unbilled, false, 'null usage is not unbilled');
  A.eq(ce.reconcile(null, 'm').weightedTokens, 0, 'null usage weighs 0');
  const priced = makeCostEngine({ priceOf: () => ({ in: 3, out: 15 }) }).reconcile({ prompt_tokens: 1000, completion_tokens: 100 }, 'm');
  A.eq([priced.unbilled, priced.costSource], [false, 'catalog'], 'a catalog-priced turn is never unbilled');
}

// ---- end to end with the real adapter shape: claude-cli usageChunk sets subscription only on apiKeySource 'none' ----
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'providers', 'claude-cli.js'), 'utf8');
  A.ok(/subscription: subscription \|\| undefined/.test(src), 'the claude-cli adapter carries the flag on its usage object');
  A.ok(src.indexOf('const cacheRead = Number(u.cache_read_input_tokens) || 0') > 0, 'the external meter\'s anchor line is untouched');
}

A.report('cost.unbilled');
