/* node test/spend.test.js - pure spend/model bookkeeping helpers. */
'use strict';
const A = require('./_assert.js');
const S = require('../sidecar/spend.js');

// effective model: prefer the loop's surfaced model, then requested model, then provider/default fallbacks.
A.eq(S.effectiveModel({ result: { model: 'fallback/model' }, requestedModel: 'primary/model', usingCodex: false, defaultModel: 'env/model' }), 'fallback/model', 'result.model wins after a fallback');
A.eq(S.effectiveModel({ result: {}, requestedModel: '  primary/model  ', usingCodex: false, defaultModel: 'env/model' }), 'primary/model', 'requested model is trimmed');
A.eq(S.effectiveModel({ result: {}, requestedModel: '', usingCodex: true, codexDefaultModel: 'gpt-5.3-codex', defaultModel: 'env/model' }), 'gpt-5.3-codex', 'Codex empty model records the Codex default');
A.eq(S.effectiveModel({ result: {}, requestedModel: '', usingCodex: false, defaultModel: '' }), '(unknown)', 'unknown is explicit only as last resort');

// final USD: backfill only unpriced metered zero-dollar usage when a price becomes available.
const priceOf = model => model === 'cold/model' ? { in: 1, out: 2 } : null;
const usd = S.effectiveUsd({ usd: 0, unpricedUsage: [{ model: 'cold/model', tokensIn: 1000, tokensOut: 500 }], priceOf });
A.ok(Math.abs(usd - 0.002) < 1e-12, 'cold-catalog usage backfills from a now-warm price');
A.eq(S.effectiveUsd({ usd: 0.042, unpricedUsage: [{ model: 'cold/model', tokensIn: 1000, tokensOut: 500 }], priceOf }), 0.042, 'existing provider cost is never double-added');
A.eq(S.effectiveUsd({ usd: 0, unmetered: true, unpricedUsage: [{ model: 'cold/model', tokensIn: 1000, tokensOut: 500 }], priceOf }), 0, 'unmetered subscription usage stays out of metered USD');



A.eq(S.effectiveRunUsd({ usd: 1.025, mediaUsd: .025, unmetered: true }), .025, 'paid media does not turn subscription estimates into charged dollars');
A.eq(S.effectiveRunUsd({ usd: 1.025, mediaUsd: .025, unmetered: false }), 1.025, 'metered conversation and media sum once');
A.eq(S.effectiveRunUsd({ usd: 1, mediaUsd: 0, unmetered: true }), 1, 'subscription-only legacy estimate semantics unchanged');
A.report('spend.test');
