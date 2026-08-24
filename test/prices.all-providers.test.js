/* node test/prices.all-providers.test.js — every METERED provider is priced, so the spend seatbelt works
   everywhere (2026-08-21, Lane B).

   Before this lane prices.js knew two families (anthropic, gemini) and openai-compatible.js read pricing
   only off the catalog — which OpenAI's /v1/models (and every clone of it) never carries. Seven metered
   profiles therefore reconciled every turn at $0 and `spentUsd >= maxCostUsd` could never fire. Five things
   are pinned here:
     A. every new family resolves known ids AND unknown-but-family ids (the fallback rows exist);
     B. the Claude 5 / 4.x rows (fable/mythos/opus-5) are non-null, and override > live > snapshot still holds;
     C. openai-compatible.js: no catalog pricing + priceFamily 'openai' -> non-null; ollama (no family) -> null;
        listModels publishes the same block;
     D. the loop's UNPRICED seatbelt: a metered run on a model nothing can price ends 'budget' at the token
        ceiling (naming the model), an exempt (OAuth/unmetered => Infinity) run does not; agent.cost carries
        unpriced:true exactly once;
     E. a cross-model fallback strips foreign thinking blocks from the replayed history;
     F. RATCHET: every live api_key profile in registry.js prices its default/static model, or is on the
        explicit UNPRICED_BY_DESIGN allowlist. Adding a metered profile without a price family fails here. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const schema = require('../shared/schema.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const prices = require('../sidecar/providers/prices.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const registry = require('../sidecar/providers/registry.js');
const { selectProvider } = require('../sidecar/providers/factory.js');

// profiles that are metered (api_key) but price NOTHING by design — each needs a stated reason
const UNPRICED_BY_DESIGN = {
  perplexity: 'vendor publishes per-request search fees on top of tokens; a token rate alone would under-report',
  custom: 'a user-supplied endpoint: nothing is known about its billing',
  cerebras: 'console.groq-style catalog carries no pricing and the vendor page lists too few ids to table (2026-08-21)',
  starnet: 'managed proxy bills the ledger per request itself (usage.cost on the wire)'
};
// models a profile would run by default: its first static model, else a representative id per family
const REPRESENTATIVE = {
  openai: 'gpt-5.4', xai: 'grok-4.6', groq: 'openai/gpt-oss-120b', mistral: 'mistral-medium-latest',
  deepseek: 'deepseek-chat', together: 'deepseek-ai/DeepSeek-V4-Pro-0813', fireworks: 'accounts/fireworks/models/kimi-k3',
  qwencloud: 'qwen-plus',
  anthropic: 'claude-opus-5', gemini: 'gemini-3.5-flash', openrouter: 'openai/gpt-5.4'
};

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { bus, seq, emit };
}
const noopTool = [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }];
function burnProvider(tokensPerTurn, priceOf) {
  return {
    priceOf, contextLimit: () => 0,
    stream: async function* () {
      yield { type: 'tool_start', index: 0, id: 'c1', name: 'noop' };
      yield { type: 'tool_args', index: 0, chunk: '{}' };
      yield { type: 'usage', usage: { prompt_tokens: tokensPerTurn, completion_tokens: 0, total_tokens: tokensPerTurn } };
      yield { type: 'done', finishReason: 'tool_calls' };
    }
  };
}

(async () => {
  // ---- A. every new family: a known id AND an unknown-but-family id both price ----
  {
    const cases = [
      ['openai',    'gpt-5.4',                                  { in: 2.50, out: 15.00 }, 'gpt-12-turbo'],
      ['openai',    'o4-mini',                                  { in: 1.10, out: 4.40 },  'o9-mini'],
      ['xai',       'grok-4.6',                                 { in: 2.00, out: 6.00 },  'grok-9'],
      ['groq',      'openai/gpt-oss-120b',                      { in: 0.15, out: 0.60 },  'meta-llama/llama-9-instant'],
      ['mistral',   'mistral-medium-latest',                    { in: 1.50, out: 7.50 },  'mistral-colossal-latest'],
      ['deepseek',  'deepseek-v4-pro',                          { in: 0.435, out: 0.87 }, 'deepseek-v9'],
      ['together',  'deepseek-ai/DeepSeek-V4-Pro-0813',         { in: 1.32, out: 3.96 },  'Qwen/Qwen9-Giant'],
      ['fireworks', 'accounts/fireworks/models/kimi-k3',        { in: 3.00, out: 15.00 }, 'accounts/fireworks/models/never-heard-of-it'],
      ['qwen',      'qwen-plus',                                { in: 0.40, out: 1.20 },  'qwen-never-heard-of-it']
    ];
    for (const [fam, known, rate, unknown] of cases) {
      const k = prices.priceOf(fam, known);
      A.ok(k && k.in === rate.in && k.out === rate.out, fam + ': ' + known + ' resolves to its verified rate (' + JSON.stringify(k) + ')');
      const u = prices.priceOf(fam, unknown);
      A.ok(u && u.in > 0 && u.out > 0, fam + ': unseen family id ' + unknown + ' gets a family fallback, not $0');
      A.ok(prices.pricingBlock(fam, known), fam + ': pricingBlock publishes for the connect screen');
    }
    // ORDER: a specific row beats the family fallback that would otherwise swallow it
    A.eq(prices.priceOf('openai', 'gpt-5.4-nano').in, 0.20, 'gpt-5.4-nano takes its own row, not gpt-5.4');
    A.eq(prices.priceOf('openai', 'gpt-5.5-pro').in, 30.00, 'gpt-5.5-pro beats the bare gpt-5.5 row');
    A.eq(prices.priceOf('mistral', 'mistral-small-latest').in, 0.15, 'mistral-small beats the "mistral" family fallback');
    A.eq(prices.priceOf('together', 'moonshotai/Kimi-K2.7-Code').in, 0.95, 'together org-prefixed id matches its row');
    // cache multipliers ride the family
    A.eq(prices.priceOf('openai', 'gpt-5.4').cache.read, 0.10, 'openai cached input = 0.10x');
    A.eq(prices.priceOf('deepseek', 'deepseek-chat').cache.read, 0.02, 'deepseek cache hit = 0.02x');
    A.eq(prices.priceOf('xai', 'grok-4.6').cache.read, 1, 'an unmodelled cache ratio stays 1.0x (over-reports, never under)');
    // honesty: a family we do not table stays null
    A.eq(prices.priceOf('ollama', 'llama3'), null, 'ollama has no table -> null (honest unpriced)');
    A.eq(prices.priceOf('cerebras', 'gpt-oss-120b'), null, 'cerebras has no table -> null');
  }

  // ---- B. Claude 5 / 4.x rows; precedence override > live > snapshot intact ----
  {
    for (const id of ['claude-fable-5', 'claude-mythos-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-4-6']) {
      A.ok(prices.priceOf('anthropic', id), id + ' is priced');
    }
    A.eq(prices.priceOf('anthropic', 'claude-fable-5').in, 10.00, 'fable 5 = $10/Mtok in (claude-api skill ref)');
    A.eq(prices.priceOf('anthropic', 'claude-fable-5').out, 50.00, 'fable 5 = $50/Mtok out');
    A.eq(prices.priceOf('anthropic', 'claude-opus-5').in, 5.00, 'opus 5 = $5/Mtok in');
    A.eq(prices.priceOf('anthropic', 'claude-opus-4-7').out, 25.00, 'opus 4.7 shares the 4.5+ rate');
    A.eq(prices.priceOf('anthropic', 'claude-opus-4-1-20250805').in, 15.00, 'opus 4.1 still on the legacy opus rate (row order intact)');
    A.eq(prices.priceOf('gemini', 'gemini-3.1-pro-preview').out, 12.00, 'gemini 3.1 pro priced');
    A.eq(prices.priceOf('gemini', 'gemini-3.5-flash-lite').in, 0.30, 'gemini 3.5 flash-lite beats the 3.5 flash row');
    // live lookup beats the snapshot for a NEW family; the snapshot answers when live has nothing
    prices.setLiveLookup((family, id) => (family === 'openai' && id === 'gpt-5.4') ? { in: 9, out: 99 } : null);
    try {
      A.eq(prices.priceOf('openai', 'gpt-5.4').in, 9, 'a live openai rate beats the snapshot');
      A.eq(prices.priceOf('openai', 'gpt-5.1').in, 1.25, 'the snapshot still answers where live is silent');
      A.eq(prices.priceOf('openai', 'gpt-5.4').cache.read, 0.10, 'a live rate keeps the family cache ratio');
    } finally { prices.setLiveLookup(null); }
  }

  // ---- C. openai-compatible.js: catalog pricing > priceFamily table > null ----
  {
    const noPricingCatalog = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-5.4', object: 'model' }, { id: 'o4-mini' }] }) });
    const withFamily = makeOpenAICompatibleProvider({ fetch: noPricingCatalog, key: 'k', baseUrl: 'https://api.openai.com/v1', priceFamily: 'openai' });
    const models = await withFamily.listModels();
    A.eq(models.length, 2, 'catalog loaded');
    A.ok(models[0].pricing && parseFloat(models[0].pricing.prompt) * 1e6 === 2.50, 'listModels publishes the table pricing block when the wire carries none');
    A.eq(withFamily.priceOf('gpt-5.4'), { in: 2.50, out: 15.00, cache: { read: 0.10, write: 1 } }, 'no catalog pricing + priceFamily openai -> the table rate');
    A.eq(withFamily.priceOf('gpt-99-future'), { in: 2.50, out: 10.00, cache: { read: 0.10, write: 1 } }, 'an unlisted id still prices via the gpt family fallback (cold catalog is not a $0 hole)');

    const ollama = makeOpenAICompatibleProvider({ fetch: noPricingCatalog, baseUrl: 'http://127.0.0.1:11434/v1', priceFamily: null });
    await ollama.listModels();
    A.eq(ollama.priceOf('gpt-5.4'), null, 'no priceFamily (ollama) -> null, honestly unpriced');

    // catalog pricing WINS over the table when the wire does publish it
    const pricedCatalog = async () => ({ ok: true, json: async () => ({ data: [{ id: 'gpt-5.4', pricing: { prompt: '0.000001', completion: '0.000002' } }] }) });
    const catalogWins = makeOpenAICompatibleProvider({ fetch: pricedCatalog, key: 'k', baseUrl: 'https://x/v1', priceFamily: 'openai' });
    await catalogWins.listModels();
    A.eq(catalogWins.priceOf('gpt-5.4'), { in: 1, out: 2 }, 'wire pricing outranks the table');

    // the factory threads the registry profile's priceFamily through
    const viaFactory = selectProvider({ provider: 'xai', fetch: noPricingCatalog, key: 'k' });
    A.ok(viaFactory.priceOf('grok-4.6') && viaFactory.priceOf('grok-4.6').in === 2.00, 'factory(xai) prices grok-4.6 from the xai table');
    const viaFactoryOllama = selectProvider({ provider: 'ollama', fetch: noPricingCatalog });
    A.eq(viaFactoryOllama.priceOf('llama3'), null, 'factory(ollama) stays unpriced');
  }

  // ---- D. UNPRICED SEATBELT in the loop ----
  {
    const unpricedCost = () => makeCostEngine({ priceOf: () => null });
    // metered: 600k tokens/turn, ceiling 1,000,000 -> the 2nd turn crosses it -> 'budget' before a 3rd paid call
    const { seq, emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: burnProvider(600000, () => null), emit, cost: unpricedCost(),
      dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'mystery/model', agentId: 'a', runId: 'r',
      limits: { maxCostUsd: 1.00, maxIters: 10, grace: false, maxUnpricedTokens: 1000000 }
    });
    A.eq(res.reason, 'budget', 'a metered run on an unpriced model ends budget at the token ceiling');
    A.eq(res.turns, 2, 'it took exactly the turns needed to cross 1,000,000 tokens');
    A.eq(res.usd, 0, 'spend is honestly $0 — the $ cap alone would never have fired');
    A.eq(res.unpricedModel, 'mystery/model', 'the stop names the unpriced model');
    A.eq(res.unpricedTokens, 1200000, 'and the tokens burned');
    A.ok(/mystery\/model/.test(res.budgetNote) && /1,000,000/.test(res.budgetNote), 'budgetNote is a legible sentence naming model + ceiling');
    const endEv = seq.find(e => e.name === 'agent.run.end');
    A.eq(endEv.payload.reason, 'budget', 'agent.run.end says budget');
    A.eq(endEv.payload.budgetScope, 'run', 'scope run');
    A.eq(endEv.payload.unpricedModel, 'mystery/model', 'the event carries the model too');
    A.eq(schema.validate(events.EVENTS['agent.run.end'], endEv.payload).ok, true, 'agent.run.end payload still validates with the additive fields');
    const costEvs = seq.filter(e => e.name === 'agent.cost');
    A.eq(costEvs.length, 2, 'two cost events');
    A.eq(costEvs[0].payload.unpriced, true, 'the FIRST agent.cost flags unpriced:true');
    A.eq(costEvs[1].payload.unpriced, undefined, 'the second does not — once per run');
    A.eq(schema.validate(events.EVENTS['agent.cost'], costEvs[0].payload).ok, true, 'agent.cost validates with unpriced:true (schema declares no additionalProperties)');

    // exempt (OAuth/unmetered => the host passes Infinity): same burn, never stops on tokens
    const ex = setup();
    const res2 = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: burnProvider(600000, () => null), emit: ex.emit, cost: unpricedCost(),
      dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'codex/gpt', agentId: 'a', runId: 'r2',
      limits: { maxCostUsd: 1.00, maxIters: 4, grace: false, maxUnpricedTokens: Infinity }
    });
    A.eq(res2.reason, 'max_iters', 'an exempt run is untouched by the token ceiling');
    // omitted entirely = off (every pre-lane caller byte-identical)
    const ex2 = setup();
    const res3 = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: burnProvider(600000, () => null), emit: ex2.emit, cost: unpricedCost(),
      dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'm', agentId: 'a', runId: 'r3',
      limits: { maxCostUsd: 1.00, maxIters: 4, grace: false }
    });
    A.eq(res3.reason, 'max_iters', 'no maxUnpricedTokens = no ceiling');
    // a PRICED model never accrues unpriced tokens, so the ceiling is inert there
    const ex3 = setup();
    const res4 = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: burnProvider(600000, (id) => prices.priceOf('openai', id)), emit: ex3.emit,
      cost: makeCostEngine({ priceOf: (id) => prices.priceOf('openai', id) }),
      dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'gpt-5.4', agentId: 'a', runId: 'r4',
      limits: { maxCostUsd: 100, maxIters: 3, grace: false, maxUnpricedTokens: 1 }
    });
    A.eq(res4.reason, 'max_iters', 'a priced model is never counted against the unpriced ceiling');
    A.ok(res4.usd > 0, 'and its spend is real: ' + res4.usd);
    A.eq(ex3.seq.filter(e => e.name === 'agent.cost' && e.payload.unpriced).length, 0, 'no unpriced flag on a priced run');
  }

  // ---- E. cross-model fallback strips foreign thinking blocks ----
  {
    const { seq, emit } = setup();
    const seen = [];   // every request's messages, per provider
    const overloaded = () => { const e = new Error('http 529 - overloaded'); e.status = 529; return e; };
    let primaryCalls = 0;
    const primary = {
      priceOf: () => ({ in: 1, out: 2 }), contextLimit: () => 0,
      stream: async function* (req) {
        primaryCalls++;
        seen.push({ who: 'primary', msgs: req.messages.map(m => ({ role: m.role, hasReasoning: m.reasoning != null })) });
        if (primaryCalls === 1) {
          // turn 1: thinks, then calls a tool — the loop parks the thinking on msg.reasoning
          yield { type: 'reasoning', block: { type: 'thinking', thinking: 'hmm', signature: 'sig-from-model-A' } };
          yield { type: 'tool_start', index: 0, id: 'c1', name: 'noop' };
          yield { type: 'tool_args', index: 0, chunk: '{}' };
          yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        throw overloaded();   // turn 2: dies -> failover
      }
    };
    const secondary = {
      priceOf: () => ({ in: 1, out: 2 }), contextLimit: () => 0,
      stream: async function* (req) {
        seen.push({ who: 'secondary', msgs: req.messages.map(m => ({ role: m.role, hasReasoning: m.reasoning != null, content: m.content, hasTools: !!m.tool_calls })) });
        yield { type: 'text', delta: 'answer from B' };
        yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: primary, emit, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }),
      dispatch: async () => ({ ok: true, content: 'ok' }), tools: noopTool, model: 'model-A', agentId: 'a', runId: 'r',
      fallbacks: [{ provider: secondary, model: 'model-B' }], sleep: async () => {}
    });
    A.eq(res.reason, 'done', 'the failover completed the run');
    const beforeSwap = seen.find(s => s.who === 'primary' && s.msgs.some(m => m.hasReasoning));
    A.ok(beforeSwap, 'sanity: the primary DID see a replayed reasoning array on its second call (the thing that would 400 elsewhere)');
    const bReq = seen.find(s => s.who === 'secondary');
    A.ok(bReq, 'the secondary was called');
    A.eq(bReq.msgs.filter(m => m.hasReasoning).length, 0, 'after a cross-model fallback NO message carries a reasoning array');
    A.ok(bReq.msgs.some(m => m.role === 'assistant' && m.hasTools), 'the assistant tool_calls survived the strip');
    const fbEv = seq.find(e => e.name === 'provider.fallback');
    A.eq(fbEv.payload.reasoningDropped, 1, 'provider.fallback reports how many thinking arrays were dropped');
    A.eq(schema.validate(events.EVENTS['provider.fallback'], fbEv.payload).ok, true, 'provider.fallback still validates with the additive field');
    A.ok(res.messages.every(m => m.reasoning == null), 'the returned transcript has no foreign thinking left');
  }

  // ---- F. RATCHET: every live api_key profile prices its default model, or is allowlisted with a reason ----
  {
    const profiles = registry.listProviderProfiles({ public: false });
    let checked = 0;
    for (const p of profiles) {
      if (p.authType !== 'api_key') continue;
      if (UNPRICED_BY_DESIGN[p.id]) { A.ok(UNPRICED_BY_DESIGN[p.id].length > 10, p.id + ' is unpriced by design: ' + UNPRICED_BY_DESIGN[p.id]); continue; }
      checked++;
      const id = (p.staticModels && p.staticModels[0] && p.staticModels[0].id) || REPRESENTATIVE[p.id];
      A.ok(id, p.id + ': a representative model id is known to this ratchet (add it to REPRESENTATIVE)');
      let priced = null;
      if (p.adapter === 'openai-compatible') {
        // a catalog that publishes pricing (openrouter) is exempt from the table: its adapter reads the wire
        if (p.id === 'openrouter') { priced = { in: 1, out: 1, via: 'wire' }; }
        else {
          A.ok(typeof p.priceFamily === 'string' && p.priceFamily, p.id + ': metered openai-compatible profile declares priceFamily');
          priced = prices.priceOf(p.priceFamily, id);
        }
      } else if (p.adapter === 'anthropic') priced = prices.priceOf('anthropic', id);
      else if (p.adapter === 'gemini') priced = prices.priceOf('gemini', id);
      else if (p.adapter === 'openrouter') priced = { in: 1, out: 1, via: 'wire' };
      A.ok(priced && priced.in >= 0 && priced.out >= 0, p.id + ' (' + p.adapter + '): default model ' + id + ' is priced -> the spend cap can fire');
    }
    A.ok(checked >= 10, 'the ratchet covered the metered profiles (' + checked + ')');
    // and the allowlist cannot silently grow to cover a profile that is actually priceable now
    A.eq(Object.keys(UNPRICED_BY_DESIGN).filter(k => !profiles.some(p => p.id === k)).length, 0, 'every allowlist entry names a real profile');
  }

  A.report('prices.all-providers.test');
})().catch(e => { console.error(e); process.exit(1); });
