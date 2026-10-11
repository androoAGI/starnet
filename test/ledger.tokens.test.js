/* node test/ledger.tokens.test.js — the ledger's weighted SUBSCRIPTION tokens (2026-10-11).
   weightedTokens is written ONLY when > 0, so every billed/free row keeps its exact old shape (old ledgers and the
   field-by-field ledger.test.js stay byte-identical); tokensForDay sums it over the trailing day window for the daily
   subscription usage limit, from every row that carries it — metered or not — and no $ aggregate ever reads it. */
'use strict';
const A = require('./_assert.js');
const { makeLedger } = require('../sidecar/ledger.js');

function memIo(seed) { const rows = (seed || []).slice(); return { rows, readAll() { return rows.slice(); }, append(e) { rows.push(e); } }; }

{
  let t = 1000;
  const io = memIo();
  const L = makeLedger({ io, clock: { now: () => t }, dayMs: 10000 });
  const billed = L.record({ runId: 'b', agentId: 'a', turns: 1, usd: 0.5, tokens: 100 });
  A.eq(Object.keys(billed), ['runId', 'agentId', 'turns', 'usd', 'tokens', 'model', 'unmetered', 'ts'], 'a billed row has exactly the old keys');
  A.eq(Object.keys(L.record({ runId: 'z', agentId: 'a', turns: 1, usd: 0, tokens: 0, weightedTokens: 0 })), ['runId', 'agentId', 'turns', 'usd', 'tokens', 'model', 'unmetered', 'ts'], 'weightedTokens 0 is not written');
  A.eq(L.record({ runId: 'j', agentId: 'a', usd: 0, weightedTokens: -5 }).weightedTokens, undefined, 'a negative figure is junk, not written');
  A.eq(L.record({ runId: 'n', agentId: 'a', usd: 0, weightedTokens: 'lots' }).weightedTokens, undefined, 'a non-number is junk, not written');
  const sub = L.record({ runId: 's1', agentId: 'a', turns: 2, usd: 0, tokens: 67000, weightedTokens: 10500.4 });
  A.eq(sub.weightedTokens, 10500, 'a subscription row carries its weighted tokens, rounded');
  A.eq(io.rows[io.rows.length - 1].weightedTokens, 10500, 'and it is persisted through io.append');
  A.eq(L.tokensForDay(), 10500, 'tokensForDay sums the window');
  t = 5000;
  L.record({ runId: 's2', agentId: 'b', usd: 0, unmetered: true, weightedTokens: 4000 });
  A.eq(L.tokensForDay(), 14500, 'an unmetered row with the field counts too (the field only exists on subscription use)');
  A.eq(L.usdForDay(), 0.5, 'no $ aggregate reads weighted tokens');
  A.eq(L.totalUsd(), 0.5, 'lifetime $ unchanged');
  A.eq(L.tokensForDay(11500), 4000, 'an explicit now slides the window past the first row (ts 1000 <= 11500 - 10000)');
  A.eq(L.tokensForDay(20000), 0, 'and past every row');
}

// survives a restart: a reloaded ledger sums the persisted field; old rows without it read 0
{
  const io = memIo([{ runId: 'old', agentId: 'a', turns: 1, usd: 1, tokens: 5, model: 'm', unmetered: false, ts: 900 },
    { runId: 'sub', agentId: 'a', turns: 1, usd: 0, tokens: 5, model: 'm', unmetered: false, ts: 950, weightedTokens: 7000 },
    { runId: 'junk', agentId: 'a', turns: 1, usd: 0, tokens: 5, model: 'm', unmetered: false, ts: 960, weightedTokens: 'x' }]);
  const L = makeLedger({ io, clock: { now: () => 1000 }, dayMs: 10000 });
  A.eq(L.tokensForDay(), 7000, 'a reloaded ledger keeps its weighted tokens; old and junk rows read 0');
}

// the header documents the field
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'sidecar', 'ledger.js'), 'utf8');
  A.ok(/tokensForDay\(now\?\) -> number/.test(src) && /weightedTokens \(additive/.test(src), 'the ledger header documents weightedTokens + tokensForDay');
}

A.report('ledger.tokens');
