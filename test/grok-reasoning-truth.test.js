/* node test/grok-reasoning-truth.test.js — reasoning levels come from the provider's own catalog, end to end.

   2026-09-27 user report: "none of my grok models have reasoning on, like none of them". Two defects stacked:
   the openai-compatible adapter never read xAI's per-model `capabilities.reasoning_effort`, and publicModel()
   flattened the resulting "unknown" to false, so the model dock locked EVERY grok model (and every OpenAI /
   DeepSeek catalog model) to reasoning OFF while they reasoned at their own default anyway.
   This test drives the REAL chain: adapter (xAI-shaped /v1/models, per docs.x.ai's REST reference) -> the
   production publicModel lifted from sidecar/index.js -> the model dock's asModel/options/labels -> the wire. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const factory = require('../sidecar/providers/factory.js');
const { makeOpenAICompatibleProvider, _internals: oc } = require('../sidecar/providers/openai-compatible.js');
const Dock = require('../frontend/app/modeldock.js');

const backend = readSidecarSource();
const start = backend.indexOf('function publicModel(m)');
const publicModel = vm.runInNewContext('(' + backend.slice(start, backend.indexOf('\n}\n', start) + 2) + ')');

// xAI's documented catalog entry shape: capabilities.reasoning_effort = the values the model ACCEPTS
const CATALOG = { object: 'list', data: [
  { id: 'grok-4.7', object: 'model', owned_by: 'xai', context_length: 500000, capabilities: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'high' } },
  { id: 'grok-4.5', object: 'model', owned_by: 'xai', context_length: 500000, capabilities: { reasoning_effort: ['low', 'medium', 'high'], default_reasoning_effort: 'high' } },
  { id: 'grok-4.3', object: 'model', owned_by: 'xai', context_length: 1000000, capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'], default_reasoning_effort: 'low' } },
  { id: 'grok-4.20-0309-reasoning', object: 'model', owned_by: 'xai', capabilities: {} },   // declared: NO dial
  { id: 'grok-build-0.1', object: 'model', owned_by: 'xai' }                                // silent: unknown
] };

function xaiFetch(posts, opts) {
  opts = opts || {};
  return async (url, init) => {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (opts.rejectEffort && body.reasoning_effort !== undefined) {
        return new Response(JSON.stringify({ code: 'invalid-argument', error: 'Model ' + body.model + ' does not support parameter reasoningEffort.' }), { status: 400 });
      }
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
    }
    return new Response(JSON.stringify(opts.catalog || CATALOG), { status: 200 });
  };
}
async function drain(p, req) { for await (const _ of p.stream(req)) { /* consume */ } }

module.exports = (async () => {
  // ---- 1. the adapter reads the declared levels (and keeps unknown unknown) ----
  {
    const p = factory.selectProvider({ provider: 'grok', fetch: xaiFetch([]), token: 'fixture-token', baseUrl: 'https://catalog-1.x.ai.test/v1' });
    const byId = Object.fromEntries((await p.listModels()).map(m => [m.id, m]));
    A.eq(byId['grok-4.7'].reasoningEfforts, ['low', 'medium', 'high', 'xhigh'], 'grok-4.7 carries its declared levels');
    A.eq(byId['grok-4.7'].defaultReasoningLevel, 'high', 'and xAI\'s declared default');
    A.eq(byId['grok-4.7'].supportsReasoning, true, 'a declared dial proves the model reasons');
    A.eq(byId['grok-4.3'].reasoningEfforts[0], 'none', 'grok-4.3 declares OFF (it can stop reasoning)');
    A.eq(byId['grok-4.20-0309-reasoning'].reasoningEfforts, [], 'a capabilities block with no levels = no dial');
    A.eq(byId['grok-4.20-0309-reasoning'].supportsReasoning, null, 'no dial proves nothing about reasoning (it may reason anyway)');
    A.eq(byId['grok-build-0.1'].supportsReasoning, null, 'a silent entry stays unknown');
    // Only an xAI-shaped capabilities block declares the dial. Mistral's catalog publishes a capabilities block about
    // chat/tools/vision; reading it as "no dial" dropped Mistral's reasoning_effort once its catalog loaded.
    const norm = require('../sidecar/providers/openai-compatible.js')._internals.normalizeModel;
    const mistral = norm({ id: 'magistral-medium-latest', owned_by: 'mistralai', capabilities: { completion_chat: true, function_calling: true, vision: false } });
    A.eq(mistral.reasoningEffortsDeclared, false, 'a non-xAI capabilities block leaves reasoning unknown (not a declared no-dial)');
    A.eq(norm({ id: 'grok-x', capabilities: {} }).reasoningEffortsDeclared, true, 'xAI\'s empty capabilities block still declares no dial');
    A.eq(norm({ id: 'grok-y', owned_by: 'xai', capabilities: { vision: true } }).reasoningEfforts, [], 'an xAI-owned entry without levels still declares no dial');
    A.eq(p.reasoningEfforts('grok-4.7'), ['low', 'medium', 'high', 'xhigh'], 'reasoningEfforts(id) reports the declared levels exactly');
    A.eq(p.reasoningEfforts('grok-4.20-0309-reasoning'), ['none'], 'a declared no-dial model offers only "send nothing"');
  }

  // ---- 2. the listing contract: publicModel never turns unknown into false ----
  {
    const n = oc.normalizeModel;
    A.eq(publicModel(n({ id: 'plain', object: 'model' })).supportsReasoning, null, 'publicModel keeps an unknown capability null');
    A.eq(publicModel(n({ id: 'no', supportsReasoning: false })).supportsReasoning, false, 'an explicit false still says false');
    A.eq(publicModel(n(CATALOG.data[0])).defaultReasoningLevel, 'high', 'publicModel carries the provider default to the dock');
  }

  // ---- 3. the model dock shows the truth ----
  {
    const p = factory.selectProvider({ provider: 'xai', fetch: xaiFetch([]), key: 'fixture-key', baseUrl: 'https://catalog-2.x.ai.test/v1' });
    const items = {};
    for (const m of await p.listModels()) items[m.id] = Dock._internals.asModel(publicModel(m), 'xai');
    const I = Dock._internals;
    A.eq(I.effortOptionsFor(items['grok-4.7']), ['low', 'medium', 'high', 'xhigh'], 'grok-4.7: the dock offers exactly xAI\'s levels');
    A.ok(!I.effortOptionsFor(items['grok-4.7']).includes('none'), 'grok-4.7: no OFF (xAI: reasoning cannot be disabled)');
    A.eq(I.reasoningPresetsFor(items['grok-4.7']).map(x => x.effort), ['low', 'medium', 'high', 'xhigh'], 'grok-4.7: four presets, MAX reaches xhigh');
    A.eq(I.clampEffortForModel('none', items['grok-4.7']), 'high', 'a stored OFF (the old lock) lands on xAI\'s default, not a fake OFF');
    A.eq(I.clampEffortForModel('max', items['grok-4.5']), 'high', 'grok-4.5 tops out at high');
    A.eq(I.clampEffortForModel('none', items['grok-4.3']), 'none', 'grok-4.3 honors a real OFF');
    A.eq(I.effortShown('none', items['grok-4.3']).label, 'OFF', 'grok-4.3 OFF is labeled OFF');
    A.eq(I.effortShown('none', items['grok-4.20-0309-reasoning']).label, 'AUTO', 'a dial-less model is AUTO (its own default), never OFF');
    A.eq(I.effortShown('none', items['grok-build-0.1']).label, 'AUTO', 'an unknown model is AUTO, never OFF');
    A.eq(I.effortShown('none', { id: 'x', provider: 'kimi', supportsReasoning: false }).label, 'OFF', 'a model KNOWN not to reason keeps OFF');
    A.ok(/Model default/.test(I.selectorLabel('grok-build-0.1', 'none', items['grok-build-0.1'])), 'the accessible name says model default, not "Reasoning off"');
    A.eq(I.selectorLabel('', 'none'), 'Model selector: no model selected, Reasoning off', 'the item-less label is unchanged');
  }

  // ---- 4. the wire sends only what the model accepts ----
  {
    const posts = [];
    const fetch = xaiFetch(posts);
    const base = 'https://wire-1.x.ai.test/v1';
    // the model dock loads the catalog once (a /api/models call) ...
    await factory.selectProvider({ provider: 'grok', fetch, token: 'fixture-token', baseUrl: base }).listModels();
    // ... and every RUN builds a fresh provider whose first request leaves before its own catalog arrives
    const cases = [
      ['grok-4.7', 'xhigh', 'xhigh', 'xhigh passes through (the generic wire scale used to fold it to high)'],
      ['grok-4.7', 'max', 'xhigh', 'max clamps to the model\'s ceiling'],
      ['grok-4.7', 'minimal', 'low', 'minimal clamps UP to the lowest declared level'],
      ['grok-4.7', 'none', undefined, 'OFF the model cannot do is omitted (its default applies), never invented'],
      ['grok-4.5', 'xhigh', 'high', 'grok-4.5 caps at high'],
      ['grok-4.3', 'none', 'none', 'grok-4.3 gets an explicit none (omitting it would mean its default, low)'],
      ['grok-4.20-0309-reasoning', 'medium', undefined, 'a declared no-dial model never gets the param (xAI 400s it)']
    ];
    for (const [model, effort, want, msg] of cases) {
      posts.length = 0;
      await drain(factory.selectProvider({ provider: 'grok', fetch, token: 'fixture-token', baseUrl: base }), { model, messages: [{ role: 'user', content: 'hi' }], reasoningEffort: effort });
      A.eq(posts[0].reasoning_effort, want, model + ' @ ' + effort + ': ' + msg);
    }
  }

  // ---- 5. xAI's camelCase refusal self-heals instead of killing the run ----
  {
    const posts = [];
    const p = makeOpenAICompatibleProvider({ fetch: xaiFetch(posts, { rejectEffort: true, catalog: { data: [] } }), key: 'fixture-key', baseUrl: 'https://wire-2.x.ai.test/v1', sendReasoningEffort: true, reasoningEffort: 'medium', label: 'xAI' });
    await drain(p, { model: 'grok-4-1-fast', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(posts.length, 2, '"does not support parameter reasoningEffort" retries once');
    A.eq(posts[0].reasoning_effort, 'medium', 'the first attempt carried the effort');
    A.eq(posts[1].reasoning_effort, undefined, 'the retry drops it');
    posts.length = 0;
    await drain(p, { model: 'grok-4-1-fast', messages: [{ role: 'user', content: 'again' }] });
    A.eq(posts.length, 1, 'the drop is remembered for the model (no second refusal)');
    A.ok(oc.paramNamed('invalid reasoning effort', 'reasoning_effort'), 'the spaced spelling names the param too');
    A.ok(!oc.paramNamed('invalid tool schema', 'reasoning_effort'), 'an unrelated 400 does not');
  }

  A.report('grok-reasoning-truth.test');
})();
