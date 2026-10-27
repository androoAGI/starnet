/* node test/context.price-tier-window.test.js — a long run never crosses its model's long-context PRICE TIER
   (context-cost-1023).

   0.13.5 sized every run from a cold catalog: the Anthropic adapter answered 200000 for every model, Gemini and the
   OpenAI-compatible adapters the cold 131072 guess. 0.14.0 reads the REAL window (1M on Gemini Pro, 2M on grok) and
   folds at 65% of it, so a long session sent 200k-650k-token turns — past the prompt size where Gemini Pro and grok
   bill a higher rate (200k) and Haiku 5.5 bills 5x (100K), which prices.js does not price: the cost meter and every
   spend cap under-reported. Locked here:
     A. prices.promptTierTokens names exactly the tier boundaries prices.js documents, on any route, and 0 elsewhere;
     B. makeContext's windowCeiling caps the working window (threshold + tail), read LIVE so a fallback's model brings
        its own ceiling; a smaller real window (a local model) and a linear-priced 1M model keep their real window;
     C. through the real loop, a 1M-window Gemini Pro run with the ceiling folds before any request reaches 200k
        tokens (without it the same run sends a request past 200k);
     D. index.js builds the run's context manager with the live ceiling;
     E. the ceiling is applied when the window is READ, so a fallback onto a tier model whose catalog is cold (the loop
        re-sizes only on a reported window) is still held under it;
     F. promptTierCeiling: an unmetered route and OpenRouter (it books the billed usage.cost, so every tier is priced)
        keep the whole window, as OpenRouter runs did on 0.13.5;
     G. the voice-slot planner measures "fits without a fold" against the same capped window the voice run works in.
   test/context.price-tier.e2e.test.js proves the index.js wiring through a booted sidecar. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const prices = require('../sidecar/providers/prices.js');
const { makeContext, RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCostEngine } = require('../sidecar/cost.js');

(async () => {
  // ---- A. the documented tier boundaries ----
  {
    const T = prices.promptTierTokens;
    A.eq(typeof T, 'function', 'prices.js exports promptTierTokens');
    for (const id of ['claude-haiku-5-5', 'claude-haiku-5.5', 'claude-haiku-5-5-20261001', 'anthropic/claude-haiku-5.5']) {
      A.eq(T(id), 100000, 'Haiku 5.5 bills 5x above a 100K prompt: ' + id);
    }
    for (const id of ['gemini-2.5-pro', 'gemini-3-pro-preview', 'gemini-3.1-pro', 'models/gemini-2.5-pro', 'google/gemini-2.5-pro', 'gemini-pro-latest']) {
      A.eq(T(id), 200000, 'Gemini Pro bills a higher rate above a 200k prompt: ' + id);
    }
    for (const id of ['grok-4.6', 'grok-4.20-0309-reasoning', 'grok-build', 'x-ai/grok-4.5']) {
      A.eq(T(id), 200000, 'grok bills 2x at a 200k+ prompt: ' + id);
    }
    // linear-priced models, models with no documented tier, local models: no ceiling (their real window is kept)
    for (const id of ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-5-5', 'claude-haiku-4-5', 'gemini-2.5-flash', 'gemini-3.5-flash',
      'gpt-5.4', 'llama3.1:8b', 'qwen3:8b', 'deepseek-v4-pro', '', null, undefined]) {
      A.eq(T(id), 0, 'no documented tier -> no ceiling: ' + JSON.stringify(id));
    }
    // every boundary named here is one the price table documents in its own row comments (never invented)
    const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'providers', 'prices.js'), 'utf8');
    A.ok(/claude-haiku-5\[-\.\]5\/i,\s+\{ in: 0\.10, out: 0\.50 \}\],\s+\/\/ prompts <= 100K tokens/.test(src), 'the Haiku 5.5 row documents its 100K tier');
    A.ok(/gemini-3\\\.1-pro\/i,\s+\{ in: 2\.00, out: 12\.00 \}\],\s+\/\/ <=200k prompt tier/.test(src), 'the Gemini 3.1 Pro row documents its 200k tier');
    A.ok(/gemini-2\\\.5-pro\/i,\s+\{ in: 1\.25, out: 10\.00 \}\],\s+\/\/ base tier; >200k prompt bills higher/.test(src), 'the Gemini 2.5 Pro row documents its 200k tier');
    A.ok(/<200k-prompt tier \(the >=200k tier bills 2x/.test(src), 'the xAI table documents its 200k tier');
  }

  // ---- B. the manager's window ceiling ----
  {
    const D = RUN_CONTEXT_DEFAULTS;
    const gem = makeContext(Object.assign({ contextLimit: 1048576, windowCeiling: 200000 }, D));
    A.eq(gem.contextLimit, 200000, 'a 1M Gemini Pro run works in a 200k window');
    A.eq(gem.thresholdTokens(), 130000, 'it folds at 65% of 200k (130k), not of 1M (681k)');
    A.eq(gem.tailBudgetTokens(), 40000, 'its verbatim tail is 20% of 200k (40k), not 210k');
    A.eq(gem.shouldCompact({ prompt_tokens: 140000 }), true, 'a 140k prompt is due a fold');
    const haiku = makeContext(Object.assign({ contextLimit: 200000, windowCeiling: 100000 }, D));
    A.eq([haiku.contextLimit, haiku.thresholdTokens()], [100000, 65000], 'Haiku 5.5 works in 100K and folds at 65K');
    const local = makeContext(Object.assign({ contextLimit: 32768, windowCeiling: 200000 }, D));
    A.eq(local.contextLimit, 32768, 'a smaller real window (a local model) is kept: the ceiling only ever lowers');
    const linear = makeContext(Object.assign({ contextLimit: 1000000, windowCeiling: 0 }, D));
    A.eq(linear.contextLimit, 1000000, 'no tier (Opus / Sonnet 4.6+, linear price): the real 1M window is kept');
    const unset = makeContext(Object.assign({ contextLimit: 1000000 }, D));
    A.eq(unset.contextLimit, 1000000, 'no ceiling passed: every legacy caller is unchanged');
    const unknown = makeContext(Object.assign({ contextLimit: 0, windowCeiling: 200000 }, D));
    A.eq(unknown.contextLimit, 0, 'an unknown window stays unknown (the ceiling never invents one)');
    const broken = makeContext(Object.assign({ contextLimit: 1000000, windowCeiling: () => { throw new Error('boom'); } }, D));
    A.eq(broken.contextLimit, 1000000, 'a throwing ceiling never wedges the run');

    // LIVE: a fallback swaps the model, then the loop re-resolves the window with setContextLimit
    let model = 'gemini-2.5-pro';
    const live = makeContext(Object.assign({ contextLimit: 1048576, windowCeiling: () => prices.promptTierTokens(model) }, D));
    A.eq(live.contextLimit, 200000, 'live: Gemini Pro starts in 200k');
    model = 'claude-sonnet-4-6';
    A.eq(live.setContextLimit(1000000), 1000000, 'live: a fallback to a linear-priced 1M model gets its real window');
    A.eq(live.contextLimit, 1000000, 'live: and exposes it');
    model = 'claude-haiku-5-5';
    A.eq(live.setContextLimit(200000), 100000, 'live: a fallback to Haiku 5.5 is held under its 100K tier');
    A.eq(live.thresholdTokens(), 65000, 'live: and folds at 65K');
  }

  // ---- C. the real loop: a long 1M-window Gemini Pro run stays under its 200k tier ----
  async function longRun(windowCeiling) {
    const ctx = makeContext(Object.assign({ contextLimit: 1048576, windowCeiling }, RUN_CONTEXT_DEFAULTS));
    const sent = [];
    let turn = 0;
    const provider = { priceOf: () => null, contextLimit: () => 1048576, stream: async function* (req) {
      turn++;
      const est = ctx.estimateMessages(req.messages);
      sent.push(est);
      if (turn <= 16) {
        yield { type: 'tool_start', index: 0, id: 'c' + turn, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'REPORT' }; yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'stop' };
    } };
    const compacts = [];
    const res = await runAgentLoop({
      messages: [{ role: 'system', content: 'You are an auditor.' }, { role: 'user', content: 'Read every file and report.' }],
      provider, cost: makeCostEngine({ priceOf: () => null }), context: ctx, contextLimit: 1048576,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
      dispatch: async (c) => ({ ok: true, content: 'file ' + c.id + ' ' + 'x'.repeat(60000) }),   // ~15k tokens a turn
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async () => ({ summary: '## Active Task\nRead files.', usd: 0, tokens: 0 }),
      microCompaction: false, model: 'gemini-2.5-pro', agentId: 'a', runId: 'r', limits: { maxIters: 30 }
    });
    return { res, sent, compacts, max: Math.max.apply(null, sent) };
  }
  {
    const without = await longRun(0);
    A.eq(without.res.reason, 'done', 'setup: the run without a ceiling completes');
    A.ok(without.max > 200000, 'setup: without the ceiling the same run sends a request past the 200k tier (' + without.max + ' tokens)');
    const capped = await longRun(() => prices.promptTierTokens('gemini-2.5-pro'));
    A.eq(capped.res.reason, 'done', 'with the ceiling the run completes');
    A.ok(capped.compacts.length >= 1, 'with the ceiling the run folded (' + capped.compacts.length + ' folds)');
    A.ok(capped.max < 200000, 'with the ceiling no request reached the 200k tier (largest ' + capped.max + ' tokens)');
  }

  // ---- D. index.js builds the run's context manager with the live ceiling (the run site boots a sidecar: source lock) ----
  {
    const src = readSidecarSource();
    A.ok(/const \{ promptTierCeiling \} = require\('\.\/providers\/prices\.js'\);/.test(src), 'index.js imports promptTierCeiling');
    A.ok(src.indexOf('const runWindowCeiling = () => promptTierCeiling(activeProviderId, model, providerUnmetered);') > 0,
      'the ceiling reads the run\'s live route, model and unmetered flag (all swapped by onFallback)');
    const ceilAt = src.indexOf('const runWindowCeiling = ');
    A.ok(ceilAt > src.indexOf('let providerUnmetered = ') && ceilAt > src.indexOf('let activeProviderId = providerId;')
      && src.indexOf('if (typeof next.unmetered === \'boolean\') providerUnmetered = next.unmetered;') > ceilAt
      && src.indexOf('activeProviderId = next.providerId || activeProviderId;') > ceilAt,
      'providerUnmetered and activeProviderId are the run\'s live bindings (declared before the ceiling, swapped by onFallback after it)');
    A.ok(src.indexOf('const ctxMgr = makeContext(Object.assign({ contextLimit: CONTEXT_LIMIT_OVERRIDE || knownRunWindow || COLD_CATALOG_CONTEXT_TOKENS, windowCeiling: runWindowCeiling }, RUN_CONTEXT_DEFAULTS));') > 0,
      'the run\'s context manager is built with the ceiling');
  }

  // ---- E. the ceiling is applied when READ, so a fallback onto a tier model with a COLD catalog is still held under it ----
  // loop.js re-sizes the window on a fallback only when the new provider reports one (nl > 0); a fallback provider's
  // catalog is never warmed, so a cold one reports 0. index.js's live bindings are mirrored here exactly.
  async function fallbackRun(o) {
    let model = o.from.model, activeProviderId = o.from.providerId, providerUnmetered = !!o.from.unmetered;
    const ctx = makeContext(Object.assign({ contextLimit: o.from.window,
      windowCeiling: () => prices.promptTierCeiling(activeProviderId, model, providerUnmetered) }, RUN_CONTEXT_DEFAULTS));
    const sentFrom = [], sentTo = [];
    let fromTurn = 0, toTurn = 0;
    const reply = function* (id, est, more) {
      if (more) {
        yield { type: 'tool_start', index: 0, id, name: 'read' }; yield { type: 'tool_args', index: 0, chunk: '{}' };
        yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', delta: 'REPORT' }; yield { type: 'usage', usage: { prompt_tokens: est, completion_tokens: 2, total_tokens: est + 2 } }; yield { type: 'done', finishReason: 'stop' };
    };
    const primary = { priceOf: () => null, contextLimit: () => o.from.window, stream: async function* (req) {
      fromTurn++;
      if (fromTurn > o.from.turns) throw new Error('Our servers are currently overloaded. Please try again later.');
      const est = ctx.estimateMessages(req.messages); sentFrom.push(est);
      yield* reply('p' + fromTurn, est, true);
    } };
    const next = { priceOf: () => null, contextLimit: () => o.to.window, stream: async function* (req) {
      toTurn++;
      const est = ctx.estimateMessages(req.messages); sentTo.push(est);
      yield* reply('f' + toTurn, est, toTurn <= 3);
    } };
    const compacts = [];
    const res = await runAgentLoop({
      messages: [{ role: 'system', content: 'You are an auditor.' }, { role: 'user', content: 'Read every file and report.' }],
      provider: primary, cost: makeCostEngine({ priceOf: () => null }), context: ctx, contextLimit: o.from.window,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
      dispatch: async (c) => ({ ok: true, content: 'file ' + c.id + ' ' + 'x'.repeat(60000) }),   // ~15k tokens a turn
      emit: (nm, p) => { if (nm === 'agent.compact') compacts.push(p); },
      summarize: async () => ({ summary: '## Active Task\nRead files.', usd: 0, tokens: 0 }),
      microCompaction: false, model, agentId: 'a', runId: 'r', limits: { maxIters: 40 }, sleep: async () => {},
      fallbacks: [{ provider: next, providerId: o.to.providerId, model: o.to.model, unmetered: !!o.to.unmetered }],
      // index.js onFallback, field for field
      onFallback: ({ next: n }) => {
        if (!n) return;
        activeProviderId = n.providerId || activeProviderId;
        if (n.model) model = n.model;
        if (typeof n.unmetered === 'boolean') providerUnmetered = n.unmetered;
      }
    });
    return { res, ctx, sentFrom, sentTo, compacts, maxFrom: Math.max.apply(null, sentFrom), maxTo: Math.max.apply(null, sentTo) };
  }
  {
    // Opus 4.7 on a direct key (1M, linear price: no ceiling) grows past 200k, is overloaded, falls back to Gemini 2.5 Pro
    // on a Gemini key whose catalog this process has not loaded (contextLimit 0)
    const r = await fallbackRun({ from: { providerId: 'anthropic', model: 'claude-opus-4-7', window: 1000000, turns: 20 },
      to: { providerId: 'gemini', model: 'gemini-2.5-pro', window: 0 } });
    A.eq(r.res.reason, 'done', 'cold fallback: the run completes');
    A.ok(r.maxFrom > 200000, 'setup: the Opus leg (no tier) grew past 200k before the fallback (' + r.maxFrom + ' tokens)');
    A.ok(r.sentTo.length >= 4, 'setup: the Gemini Pro fallback answered the rest of the run (' + r.sentTo.length + ' calls)');
    A.ok(r.maxTo < 200000, 'cold fallback: no Gemini Pro request reached its 200k tier (sent ' + r.sentTo.join(', ') + ')');
    A.ok(r.compacts.length >= 1, 'cold fallback: the run folded before the first Gemini Pro call (' + r.compacts.length + ' folds)');
    A.eq([r.ctx.contextLimit, r.ctx.thresholdTokens(), r.ctx.tailBudgetTokens()], [200000, 130000, 40000],
      'cold fallback: the manager works in the new model\'s 200k ceiling (window, fold point, tail)');
  }
  {
    // a SuperGrok sign-in (unmetered: no $ caps, so no ceiling) on a 2M grok falls back to an xAI API key (metered) whose
    // catalog is cold: the metered leg is held under grok's 200k tier
    const r = await fallbackRun({ from: { providerId: 'grok', model: 'grok-4.20-0309-reasoning', window: 2000000, turns: 20, unmetered: true },
      to: { providerId: 'xai', model: 'grok-4.20-0309-reasoning', window: 0, unmetered: false } });
    A.eq(r.res.reason, 'done', 'unmetered -> metered cold fallback: the run completes');
    A.ok(r.maxFrom > 200000, 'setup: the subscription leg kept its whole window (' + r.maxFrom + ' tokens)');
    A.ok(r.maxTo < 200000, 'unmetered -> metered cold fallback: no API-key request reached the 200k tier (sent ' + r.sentTo.join(', ') + ')');
    A.eq(r.ctx.contextLimit, 200000, 'unmetered -> metered cold fallback: the manager works in 200k');
  }
  {
    // the reverse never RAISES a window past what is known: a capped Gemini Pro run falling back to a cold Opus keeps 200k
    const r = await fallbackRun({ from: { providerId: 'gemini', model: 'gemini-2.5-pro', window: 1048576, turns: 6 },
      to: { providerId: 'anthropic', model: 'claude-opus-4-7', window: 0 } });
    A.eq(r.res.reason, 'done', 'capped -> cold linear fallback: the run completes');
    A.eq(r.ctx.contextLimit, 200000, 'capped -> cold linear fallback: the last known (capped) window is kept, never the raw 1M');
  }

  // ---- F. a route whose meter books the provider's BILLED cost needs no ceiling (OpenRouter keeps its 0.13.5 window) ----
  {
    const C = prices.promptTierCeiling;
    A.eq(typeof C, 'function', 'prices.js exports promptTierCeiling');
    A.eq(C('gemini', 'gemini-2.5-pro', false), 200000, 'a Gemini key prices from the catalog: Gemini Pro is held under 200k');
    A.eq(C('xai', 'grok-4.6', false), 200000, 'an xAI key: grok is held under 200k');
    A.eq(C('anthropic', 'claude-haiku-5-5', false), 100000, 'an Anthropic key: Haiku 5.5 is held under 100K');
    A.eq(C('starnet', 'google/gemini-2.5-pro', false), 200000, 'StarNet credits price from the catalog: held under the tier');
    A.eq(C('anthropic', 'claude-opus-4-7', false), 0, 'a linear-priced model has no ceiling on any route');
    for (const id of ['google/gemini-2.5-pro', 'x-ai/grok-4-fast', 'anthropic/claude-haiku-5.5']) {
      A.eq(C('openrouter', id, false), 0, 'OpenRouter books its billed usage.cost (every tier priced): ' + id + ' keeps its whole window');
      A.eq(C('OpenRouter ', id, false), 0, 'the route id is matched loosely: ' + id);
    }
    A.eq(C('grok', 'grok-4.6', true), 0, 'an unmetered route (subscription / local) has no ceiling');
    A.eq(C('', 'gemini-2.5-pro', false), 200000, 'an unknown route prices from the catalog: held under the tier');
    // the billed cost the exemption relies on is real: OpenRouter asks for it and cost.js books it over the catalog
    const orSrc = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'providers', 'openrouter.js'), 'utf8');
    A.ok(/stream: true, usage: \{ include: true \}/.test(orSrc), 'openrouter.js asks for the billed usage.cost on every call');
    const billed = makeCostEngine({ priceOf: () => ({ in: 1.25, out: 10 }) }).reconcile({ prompt_tokens: 300000, completion_tokens: 1000, total_tokens: 301000, cost: 0.76 }, 'google/gemini-2.5-pro');
    A.eq([billed.usd, billed.costSource], [0.76, 'provider'], 'a 300k-token OpenRouter call is booked at its billed (tier) price, not the base row');
    // an OpenRouter Gemini Pro run works in its real 1M window, exactly as on 0.13.5
    const orRun = makeContext(Object.assign({ contextLimit: 1048576, windowCeiling: () => C('openrouter', 'google/gemini-2.5-pro', false) }, RUN_CONTEXT_DEFAULTS));
    A.eq([orRun.contextLimit, orRun.thresholdTokens()], [1048576, 0.65 * 1048576], 'an OpenRouter Gemini Pro run folds at 65% of its real window, as on 0.13.5');
  }

  // ---- G. the voice-slot planner sizes "fits without a fold" with the same ceiling the voice run will work in ----
  {
    const route = require('../sidecar/voice-chat-route.js');
    const src = readSidecarSource();
    const at = src.indexOf('async function applyVoiceTurnRoute(');
    const apply = at > 0 ? src.slice(at, src.indexOf('\n}\n', at)) : '';
    A.ok(/const tierCeiling = promptTierCeiling\(tProvider, setting\.model, !!\(getProviderProfile\(tProvider\) \|\| \{\}\)\.unmetered\);/.test(apply),
      'applyVoiceTurnRoute reads the voice model\'s ceiling on the voice route (unmetered: none)');
    A.ok(/const runLimit = \(tierCeiling > 0 && limit > tierCeiling\) \? tierCeiling : limit;/.test(apply), 'the planner window is the real window capped by that ceiling');
    A.ok(/target: \{ credentialOk, contextLimit: runLimit, /.test(apply), 'the planner is handed the capped window');
    // the plan that window gives: an 80k conversation does not move to a Haiku 5.5 voice slot that would fold it at 65K
    const tierCeiling = prices.promptTierCeiling('anthropic', 'claude-haiku-5-5', false), limit = 200000;
    const runLimit = (tierCeiling > 0 && limit > tierCeiling) ? tierCeiling : limit;
    const facts = { setting: { provider: 'anthropic', model: 'claude-haiku-5-5' }, main: { provider: 'anthropic', model: 'claude-opus-4-7' },
      target: { credentialOk: true, contextLimit: runLimit }, promptTokens: 80000, compactAt: RUN_CONTEXT_DEFAULTS.compactAt };
    const plan = route.planVoiceRoute(facts);
    A.eq([plan.route, plan.reason], ['main', 'too_large'], 'an 80k conversation stays on the agent\'s model rather than folding on Haiku 5.5');
    const small = route.planVoiceRoute(Object.assign({}, facts, { promptTokens: 20000 }));
    A.eq(small.route, 'voice', 'a 20k conversation still moves to the Haiku 5.5 voice slot');
    const voiceRun = makeContext(Object.assign({ contextLimit: limit, windowCeiling: tierCeiling }, RUN_CONTEXT_DEFAULTS));
    A.eq(voiceRun.shouldCompact({ prompt_tokens: 20000 + route.PROMPT_OVERHEAD_TOKENS }), false, 'and that voice run does not fold it');
    const orFacts = Object.assign({}, facts, { setting: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, main: { provider: 'openrouter', model: 'anthropic/claude-opus-4.7' } });
    const orCeil = prices.promptTierCeiling('openrouter', 'anthropic/claude-haiku-5.5', false);
    A.eq(route.planVoiceRoute(Object.assign({}, orFacts, { target: { credentialOk: true, contextLimit: (orCeil > 0 && limit > orCeil) ? orCeil : limit } })).route, 'voice',
      'on OpenRouter (billed cost, no ceiling) the same 80k conversation moves to the voice slot, as on 0.13.5');
  }

  A.report('context.price-tier-window.test');
})().catch(e => { console.log('FAIL: context.price-tier-window.test threw -- ' + (e && e.stack || e)); process.exit(1); });
