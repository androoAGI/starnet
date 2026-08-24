/* node test/provider.registry.test.js - provider profile registry/factory conformance. */
'use strict';
const A = require('./_assert.js');
const factory = require('../sidecar/providers/factory.js');

module.exports = (async () => {
  const ids = factory.PROVIDER_IDS;
  A.ok(ids.indexOf('openrouter') >= 0, 'openrouter is registered');
  A.ok(ids.indexOf('codex') >= 0, 'codex is registered');
  A.ok(ids.indexOf('openai') >= 0, 'openai is registered');
  A.ok(ids.indexOf('anthropic') >= 0, 'anthropic is registered');
  A.ok(ids.indexOf('gemini') >= 0, 'gemini is registered');
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'qwencloud'].forEach(id => {
    A.ok(ids.indexOf(id) >= 0, id + ' is registered');
  });
  A.ok(ids.indexOf('grok') >= 0, 'grok (OAuth) is registered');
  A.ok(ids.indexOf('kimi') >= 0, 'kimi (OAuth) is registered');
  A.ok(ids.indexOf('ollama') >= 0, 'ollama is registered');
  A.ok(ids.indexOf('custom') >= 0, 'custom is registered');

  A.eq(factory.normalizeProviderId('openai-codex', ''), 'codex', 'codex alias normalizes');
  A.eq(factory.normalizeProviderId('openai-compatible', ''), 'custom', 'custom alias normalizes');
  A.eq(factory.normalizeProviderId('claude', ''), 'anthropic', 'anthropic alias normalizes');
  A.eq(factory.normalizeProviderId('google-ai', ''), 'gemini', 'gemini alias normalizes');
  // 'grok' is now the OAuth (subscription) Grok id; the API-key Grok keeps 'x-ai'/'xai'.
  A.eq(factory.normalizeProviderId('grok', ''), 'grok', 'grok is the OAuth Grok id');
  A.eq(factory.normalizeProviderId('x-ai', ''), 'xai', 'x-ai still normalizes to the API-key xAI');
  A.eq(factory.normalizeProviderId('grok-oauth', ''), 'grok', 'grok-oauth alias normalizes to the OAuth Grok');
  A.eq(factory.normalizeProviderId('moonshot', ''), 'kimi', 'moonshot alias normalizes to Kimi');
  A.eq(factory.normalizeProviderId('kimi-oauth', ''), 'kimi', 'kimi-oauth alias normalizes to Kimi');
  A.eq(factory.normalizeProviderId('together-ai', ''), 'together', 'Together alias normalizes');
  A.eq(factory.normalizeProviderId('fireworks-ai', ''), 'fireworks', 'Fireworks alias normalizes');
  A.eq(factory.normalizeProviderId('sonar', ''), 'perplexity', 'Perplexity alias normalizes');
  A.eq(factory.normalizeProviderId('dashscope', ''), 'qwencloud', 'DashScope alias normalizes to qwencloud');
  A.eq(factory.normalizeProviderId('qwen', ''), 'qwencloud', 'qwen alias normalizes to qwencloud');
  A.eq(factory.normalizeProviderId('', 'openrouter'), 'openrouter', 'fallback is honored');
  A.eq(factory.defaultReasoningEffortForProvider('codex'), 'low', 'codex default reasoning');
  A.eq(factory.defaultReasoningEffortForProvider('ollama'), 'none', 'ollama default reasoning');
  A.eq(factory.providerRequiresKey('openai'), true, 'openai requires a key');
  A.eq(factory.providerRequiresKey('anthropic'), true, 'anthropic requires a key');
  A.eq(factory.providerRequiresKey('gemini'), true, 'gemini requires a key');
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'qwencloud'].forEach(id => {
    A.eq(factory.providerRequiresKey(id), true, id + ' requires a key');
  });
  A.eq(factory.providerRequiresKey('ollama'), false, 'ollama is keyless');
  A.eq(factory.providerRequiresBaseUrl('custom'), true, 'custom requires a base URL');

  const profiles = factory.listProviderProfiles();
  const pub = profiles.find(p => p.id === 'openrouter');
  A.ok(pub && Array.isArray(pub.keyEnv) && pub.keyEnv.indexOf('OPENROUTER_KEY') >= 0, 'public profiles include env names only');
  const xai = profiles.find(p => p.id === 'xai');
  A.ok(xai && xai.baseUrl === 'https://api.x.ai/v1' && xai.keyEnv.indexOf('XAI_API_KEY') >= 0, 'xAI public profile exposes official base URL and env names');
  const deepseek = profiles.find(p => p.id === 'deepseek');
  A.ok(deepseek && deepseek.baseUrl === 'https://api.deepseek.com', 'DeepSeek profile uses its non-/v1 base URL');
  const together = profiles.find(p => p.id === 'together');
  A.ok(together && together.baseUrl === 'https://api.together.ai/v1', 'Together profile uses its current official base URL');
  const perplexity = profiles.find(p => p.id === 'perplexity');
  A.ok(perplexity && perplexity.baseUrl === 'https://api.perplexity.ai', 'Perplexity profile uses Sonar base URL');
  const qwencloud = profiles.find(p => p.id === 'qwencloud');
  const rawQwencloud = factory.getProviderProfile('qwencloud');
  A.ok(rawQwencloud && rawQwencloud.adapter === 'openai-compatible', 'QwenCloud uses the openai-compatible adapter');
  A.ok(qwencloud && qwencloud.baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'QwenCloud default base URL is DashScope compatible-mode');
  A.ok(qwencloud && qwencloud.keyEnv.indexOf('DASHSCOPE_API_KEY') >= 0, 'QwenCloud reads DASHSCOPE_API_KEY first');
  A.eq(rawQwencloud.priceFamily, 'qwen', 'QwenCloud declares the qwen price family');
  A.eq(qwencloud.supportsTools, true, 'QwenCloud profile asserts tool support');

  const p = factory.selectProvider({ provider: 'ollama', fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  A.ok(p && typeof p.stream === 'function' && typeof p.listModels === 'function', 'factory returns an adapter for OpenAI-compatible profiles');
  for (const id of ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'qwencloud']) {
    const hosted = factory.selectProvider({ provider: id, fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    A.ok(hosted && typeof hosted.stream === 'function' && typeof hosted.listModels === 'function', 'factory returns OpenAI-compatible adapter for ' + id);
  }

  // provider compatibility facts (sourced from official docs 2026-07)
  const rawPerplexity = factory.getProviderProfile('perplexity');
  A.eq(rawPerplexity.supportsTools, false, 'Perplexity chat completions has no function calling - asserted, not guessed');
  A.eq(rawPerplexity.wireStreamOptions, false, 'Perplexity profile opts out of stream_options');
  A.eq(factory.getProviderProfile('mistral').wireStreamOptions, false, 'Mistral profile opts out of stream_options (strict 422 on extra inputs)');
  ['openai', 'xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'ollama'].forEach(id => {
    A.eq(factory.getProviderProfile(id).wireReasoningEffort, true, id + ' documents the reasoning_effort wire param');
  });
  A.ok(!factory.getProviderProfile('custom').wireReasoningEffort, 'custom endpoints never assume reasoning_effort support');
  A.ok(!factory.getProviderProfile('qwencloud').wireReasoningEffort, 'QwenCloud does not assume OpenAI reasoning_effort on the wire');

  // profile hints reach the adapter: Perplexity refuses tools up front and sends no stream_options
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const pplx = factory.selectProvider({ provider: 'perplexity', fetch: fetchImpl, key: 'K', reasoningEffort: 'medium' });
    A.eq(pplx.supportsTools('sonar-pro'), false, 'Perplexity adapter reports tools unsupported from the profile');
    for await (const _ of pplx.stream({ model: 'sonar-pro', messages: [] })) { /* drain */ }
    const post = calls.find(c => c.init && c.init.method === 'POST');
    const body = JSON.parse(post.init.body);
    A.eq(body.stream_options, undefined, 'Perplexity request carries no stream_options');
    A.eq(body.reasoning_effort, 'medium', 'Perplexity request carries its documented reasoning_effort');

    // Perplexity has no usable /models -> the static Sonar roster (docs-sourced 2026-07) fills the seam
    const roster = await pplx.listModels();
    A.eq(roster.map(m => m.id).join(','), 'sonar,sonar-pro,sonar-reasoning-pro,sonar-deep-research', 'static Sonar roster serves the empty catalog');
    A.eq(pplx.contextLimit('sonar-pro'), 200000, 'Sonar Pro context limit rides the static roster');
    A.eq(roster.every(m => !m.pricing), true, 'Sonar roster is unpriced (search fees make token-only pricing dishonest)');
  }

  // ---- device-OAuth (grok / kimi) profiles + predicate ----
  A.eq(factory.providerUsesDeviceOAuth('grok'), true, 'grok uses the device-OAuth wire');
  A.eq(factory.providerUsesDeviceOAuth('kimi'), true, 'kimi uses the device-OAuth wire');
  A.eq(factory.providerUsesDeviceOAuth('kimi-oauth'), true, 'device-OAuth predicate resolves aliases');
  A.eq(factory.providerUsesDeviceOAuth('codex'), false, 'codex is NOT flagged device-OAuth (keeps its own wire)');
  A.eq(factory.providerUsesDeviceOAuth('xai'), false, 'the API-key xAI is not device-OAuth');
  A.eq(factory.providerUsesDeviceOAuth('openrouter'), false, 'openrouter is not device-OAuth');
  A.eq(factory.providerRequiresKey('grok'), false, 'grok needs no API key (OAuth)');
  A.eq(factory.providerRequiresKey('kimi'), false, 'kimi needs no API key (OAuth)');
  {
    const grok = factory.getProviderProfile('grok');
    A.eq(grok.authType, 'oauth_device_code', 'grok is an oauth_device_code profile');
    A.eq(grok.baseUrl, 'https://api.x.ai/v1', 'grok inference base URL is api.x.ai/v1');
    A.eq(grok.unmetered, true, 'grok is unmetered (subscription)');
    A.eq(grok.adapter, 'openai-compatible', 'grok inference rides the openai-compatible adapter');
    const kimi = factory.getProviderProfile('kimi');
    A.eq(kimi.authType, 'oauth_device_code', 'kimi is an oauth_device_code profile');
    A.eq(kimi.baseUrl, 'https://api.kimi.com/coding/v1', 'kimi inference base URL is api.kimi.com/coding/v1');
    A.eq(kimi.extraHeaders['X-Msh-Platform'], 'kimi_cli', 'kimi profile carries the static X-Msh-* headers');
    // OAuth access token rides in AS the Bearer key, and the profile extraHeaders reach the adapter.
    const kimiProv = factory.selectProvider({ provider: 'kimi', token: 'oauth-access-tok', headers: { 'X-Msh-Device-Id': 'dev-123' }, fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
    A.ok(kimiProv && typeof kimiProv.stream === 'function', 'kimi selects an OpenAI-compatible adapter on an OAuth token');
    const grokRoster = await factory.selectProvider({ provider: 'grok', token: 't', fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) }).listModels();
    A.ok(grokRoster.find(m => m.id === 'grok-4'), 'grok static roster fills the empty catalog');
  }

  const anthropic = factory.selectProvider({ provider: 'anthropic', fetch: async () => new Response('', { status: 200 }) });
  A.ok(anthropic && typeof anthropic.stream === 'function', 'factory returns Anthropic adapter');
  const gemini = factory.selectProvider({ provider: 'gemini', fetch: async () => new Response('', { status: 200 }) });
  A.ok(gemini && typeof gemini.stream === 'function', 'factory returns Gemini adapter');

  A.report('provider.registry.test');
})();
