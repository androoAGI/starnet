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
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'].forEach(id => {
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
  A.eq(factory.normalizeProviderId('', 'openrouter'), 'openrouter', 'fallback is honored');
  A.eq(factory.defaultReasoningEffortForProvider('codex'), 'low', 'codex default reasoning');
  A.eq(factory.defaultReasoningEffortForProvider('ollama'), 'none', 'ollama default reasoning');
  A.eq(factory.providerRequiresKey('openai'), true, 'openai requires a key');
  A.eq(factory.providerRequiresKey('anthropic'), true, 'anthropic requires a key');
  A.eq(factory.providerRequiresKey('gemini'), true, 'gemini requires a key');
  ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras'].forEach(id => {
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

  const p = factory.selectProvider({ provider: 'ollama', fetch: async () => new Response(JSON.stringify({ data: [] }), { status: 200 }) });
  A.ok(p && typeof p.stream === 'function' && typeof p.listModels === 'function', 'factory returns an adapter for OpenAI-compatible profiles');
  for (const id of ['xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras']) {
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

  // Ollama can spend well over 30s loading a local model before it returns response headers. Its profile gets
  // a local-only ceiling; hosted endpoints retain the shared SKYNET_PROVIDER_CONNECT_MS/default policy.
  A.eq(factory.getProviderProfile('ollama').connectTimeoutMs, 300000, 'Ollama allows a five-minute cold model load');
  A.eq(factory.getProviderProfile('openai').connectTimeoutMs, undefined, 'hosted providers keep the shared connect ceiling');
  {
    const previousConnectMs = process.env.SKYNET_PROVIDER_CONNECT_MS;
    process.env.SKYNET_PROVIDER_CONNECT_MS = '10';
    let postAttempts = 0;
    try {
      const fetchImpl = async (url, init) => {
        if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
        postAttempts++;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          })), 40);
          const signal = init.signal;
          const abort = () => {
            clearTimeout(timer);
            reject((signal && signal.reason) || new Error('aborted'));
          };
          if (signal && signal.aborted) abort();
          else if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', abort, { once: true });
        });
      };
      const local = factory.selectProvider({ provider: 'ollama', fetch: fetchImpl });
      for await (const _ of local.stream({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ }
      A.eq(postAttempts, 1, 'Ollama profile override reaches the adapter and prevents the global 10ms guard from retrying');
    } finally {
      if (previousConnectMs == null) delete process.env.SKYNET_PROVIDER_CONNECT_MS;
      else process.env.SKYNET_PROVIDER_CONNECT_MS = previousConnectMs;
    }
  }

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

  /* ---- starnet endpoint truth (2026-08-25 stranded-user incident) ----
     starnet's baseUrl comes ONLY from the device link. Unlinked, it resolves empty — and the adapter used to
     default that to api.openai.com, silently rerouting a managed run (device token as bearer) to OpenAI,
     which answered its bare "invalid model ID" for the routed catalog id. Locked here: an endpointless
     starnet selection refuses with the one real remedy (link the station), a linked one constructs, and the
     profile declares requiresBaseUrl so hasCredential/run admission read an unresolved link as unconfigured. */
  {
    const starnet = factory.getProviderProfile('starnet');
    A.eq(starnet.requiresBaseUrl, true, 'starnet declares requiresBaseUrl (an unresolved link is NOT configured)');
    let threw = null;
    try { factory.selectProvider({ provider: 'starnet', key: 'device-token', fetch: async () => new Response('', { status: 200 }) }); }
    catch (e) { threw = e; }
    A.ok(threw, 'an unlinked starnet selection refuses instead of defaulting to api.openai.com');
    A.ok(/link/i.test(String(threw && threw.message)) && /STARNET/i.test(String(threw && threw.message)), 'the refusal names linking the station');
    const linked = factory.selectProvider({ provider: 'starnet', key: 'device-token', baseUrl: 'https://account.starnetos.example/v1', fetch: async () => new Response('', { status: 200 }) });
    A.ok(linked && typeof linked.stream === 'function', 'a linked starnet (dynamic baseUrl supplied) constructs normally');
  }

  // OUTPUT CEILING (issue #17): Ollama's wire has no ceiling of its own, so its profile declares one and the
  // factory carries it to the adapter; hosted profiles declare none and keep their wire byte-identical.
  A.eq(factory.getProviderProfile('ollama').maxOutputTokens, 4096, 'Ollama profile declares a 4096-token output ceiling');
  A.eq(factory.getProviderProfile('openai').maxOutputTokens, undefined, 'hosted OpenAI-compatible profiles declare no ceiling');
  {
    const wireFor = async (id, env, isTask) => {
      const prev = process.env.SKYNET_OLLAMA_MAX_TOKENS;
      if (env == null) delete process.env.SKYNET_OLLAMA_MAX_TOKENS; else process.env.SKYNET_OLLAMA_MAX_TOKENS = env;
      try {
        let wire = null;
        const p = factory.selectProvider({ provider: id, key: 'k', fetch: async (url, init) => {
          if (init && init.method === 'POST') { wire = JSON.parse(init.body); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        } });
        for await (const _ of p.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }], isTask })) { /* drain */ }
        return wire;
      } finally {
        if (prev == null) delete process.env.SKYNET_OLLAMA_MAX_TOKENS; else process.env.SKYNET_OLLAMA_MAX_TOKENS = prev;
      }
    };
    A.eq((await wireFor('ollama')).max_tokens, 4096, 'an Ollama run carries the profile ceiling as max_tokens');
    A.eq((await wireFor('ollama', '8192')).max_tokens, 8192, 'SKYNET_OLLAMA_MAX_TOKENS overrides the declared ceiling');
    A.eq((await wireFor('ollama', 'junk')).max_tokens, 4096, 'a junk override falls back to the declared ceiling');
    A.eq((await wireFor('ollama', 'Infinity')).max_tokens, 4096, 'a non-finite environment override retains the ceiling');
    A.eq((await wireFor('ollama', null, false)).max_tokens, 512, 'an explicitly casual Ollama turn uses 512 tokens');
    A.eq((await wireFor('ollama', null, true)).max_tokens, 4096, 'an Ollama task retains 4096 tokens');
    A.eq((await wireFor('deepseek', null, false)).max_tokens, undefined, 'hosted casual chat gets no new cap');
    A.eq((await wireFor('deepseek')).max_tokens, undefined, 'a hosted OpenAI-compatible run sends no max_tokens');
  }

  const anthropic = factory.selectProvider({ provider: 'anthropic', fetch: async () => new Response('', { status: 200 }) });
  A.ok(anthropic && typeof anthropic.stream === 'function', 'factory returns Anthropic adapter');
  const gemini = factory.selectProvider({ provider: 'gemini', fetch: async () => new Response('', { status: 200 }) });
  A.ok(gemini && typeof gemini.stream === 'function', 'factory returns Gemini adapter');

  // A configured but unused OAuth fallback must not refresh or send a request.
  for (const provider of ['codex', 'kimi', 'grok']) {
    let refreshed=0, requests=0, headers;
    const p=factory.selectProvider({provider,reasoningEffort:'high', tokenProvider:async()=>{refreshed++;return 'new-token';},fetch:async(_,o)=>{
      if(!o.body) return new Response(JSON.stringify({data:[{id:'discovered-model',context_length:65536,supported_parameters:['reasoning']}]}));
      requests++;headers=o.headers;const b=JSON.parse(o.body);
      A.eq(b.reasoning ? b.reasoning.effort : b.reasoning_effort,provider==='kimi'?undefined:'high','fallback preserves adapter-supported effort behavior');
      return new Response(provider==='codex' ? 'data: {"type":"response.completed","response":{}}\n\n' : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }});
    p.contextLimit('test'); p.supportsTools('test');
    A.eq(refreshed,0,'fallback metadata does not refresh '+provider);
    A.eq(requests,0,'unused fallback does not call '+provider);
    const cancelled=new AbortController();cancelled.abort();
    for await(const e of p.stream({model:'test',messages:[],signal:cancelled.signal})) {}
    A.eq(refreshed,0,'cancel before use skips refresh '+provider);
    for(let i=0;i<2;i++) for await(const e of p.stream({model:'test',messages:[]})) {}
    A.eq(refreshed,1,'successful activation reused '+provider);
    A.eq(requests,2,'both selected calls execute '+provider);
    A.eq(headers.Authorization,'Bearer new-token','fresh credential reaches selected fallback '+provider);
    if(provider!=='codex') {
      await p.listModels();
      A.eq(p.contextLimit('discovered-model'),65536,'activated metadata follows the live catalog '+provider);
      A.eq(refreshed,1,'catalog query reuses authenticated adapter '+provider);
    }
  }
  {
    let count=0;const p=factory.selectProvider({provider:'codex',tokenProvider:async()=>{if(++count===1)throw new Error('refresh unavailable');return 'fresh';},fetch:async()=>new Response('data: {"type":"response.completed","response":{}}\n\n')});
    let failed=false;try{for await(const e of p.stream({messages:[]})) {}}catch(e){failed=e.message==='refresh unavailable';}
    A.ok(failed,'refresh failure is surfaced, never silently successful');
    for await(const e of p.stream({messages:[]})) {}
    A.eq(count,2,'failed activation can recover');
  }
  {
    let release, started, requests = 0;
    const refreshing = new Promise(resolve => { started = resolve; });
    const token = new Promise(resolve => { release = resolve; });
    const p = factory.selectProvider({ provider: 'codex', tokenProvider: () => { started(); return token; }, fetch: async () => {
      requests++; return new Response('data: {"type":"response.completed","response":{}}\n\n');
    } });
    const abort = new AbortController();
    const run = (async () => { for await (const _ of p.stream({ messages: [], signal: abort.signal })) {} return 'stopped'; })();
    await refreshing;
    abort.abort();
    let timer;
    const settled = await Promise.race([run, new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 500); })]);
    clearTimeout(timer);
    A.eq(settled, 'stopped', 'Stop does not wait for an already-running fallback token refresh');
    release('fresh'); await run;
    A.eq(requests, 0, 'cancelled activation never sends inference after refresh finishes');
    for await (const _ of p.stream({ messages: [] })) {}
    A.eq(requests, 1, 'successful background refresh remains usable by a later caller');
  }
  A.report('provider.registry.test');
})();
