/* node test/provider.openai-compatible.test.js - generic chat/completions provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const line = obj => 'data: ' + JSON.stringify(obj);
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

module.exports = (async () => {
  // text, usage, finish, and request/header shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const sse = [
        line({ choices: [{ delta: { content: 'Hel' } }] }),
        line({ choices: [{ delta: { content: 'lo' } }] }),
        line({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
        line({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://example.test/v1/', includeUsage: true });
    const evs = await collect(p, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream');
    A.eq(evs.find(e => e.type === 'usage').usage.total_tokens, 5, 'usage event streams');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'finish is normalized');
    A.eq(calls[0].url, 'https://example.test/v1/chat/completions', 'posts to chat/completions');
    A.eq(calls[0].init.headers.Authorization, 'Bearer KEY', 'api key is sent as bearer auth');
    A.eq(JSON.parse(calls[0].init.body).stream_options, { include_usage: true }, 'optional usage include is wired');
  }

  // tool-call streaming
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"q":' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    A.eq(evs.find(e => e.type === 'tool_start').name, 'web_search', 'tool_start carries name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'tool args concatenate');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'tool finish is normalized');
  }

  // model catalog parsing and no-auth local shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: 'local-model', context_length: 1234, supported_parameters: ['tools'] }] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://127.0.0.1:11434/v1' });
    const models = await p.listModels();
    A.eq(calls[0].url, 'http://127.0.0.1:11434/v1/models', 'lists /models');
    A.eq(calls[0].init.headers.Authorization, undefined, 'no auth header when no key');
    A.eq(models[0].id, 'local-model', 'catalog id parsed');
    A.eq(p.contextLimit('local-model'), 1234, 'context length from catalog');
    A.eq(p.supportsTools('local-model'), true, 'tool support from supported_parameters');
  }

  // provider profile paths can override the default /chat/completions and /models endpoints
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') {
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://example.test/root/', chatPath: 'responses', modelsPath: 'catalog/models' });
    await collect(p, { model: 'm', messages: [] });
    await p.listModels();
    A.eq(calls[0].url, 'https://example.test/root/responses', 'custom chat path is honored');
    A.eq(calls[1].url, 'https://example.test/root/catalog/models', 'custom models path is honored');
  }

  // usage reporting defaults ON (no includeUsage passed) and can be opted out explicitly
  {
    const mkFetch = (calls) => async (url, init) => {
      calls.push({ url, init });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const onCalls = [];
    const pOn = makeOpenAICompatibleProvider({ fetch: mkFetch(onCalls), baseUrl: 'http://local/v1' });
    await collect(pOn, { model: 'm', messages: [] });
    A.eq(JSON.parse(onCalls[0].init.body).stream_options, { include_usage: true }, 'usage include defaults ON');

    const offCalls = [];
    const pOff = makeOpenAICompatibleProvider({ fetch: mkFetch(offCalls), baseUrl: 'http://local/v1', includeUsage: false });
    await collect(pOff, { model: 'm', messages: [] });
    A.eq(JSON.parse(offCalls[0].init.body).stream_options, undefined, 'usage include opts out with explicit false');
  }

  // reasoning_effort wiring: profile hint sends it (clamped to the wire scale), no hint omits it,
  // and effort 'none' always omits it
  {
    const mkFetch = (calls) => async (url, init) => {
      calls.push({ url, init });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const hinted = [];
    const pHint = makeOpenAICompatibleProvider({ fetch: mkFetch(hinted), baseUrl: 'http://local/v1', reasoningEffort: 'max', sendReasoningEffort: true });
    await collect(pHint, { model: 'm', messages: [] });
    A.eq(JSON.parse(hinted[0].init.body).reasoning_effort, 'high', 'profile-hinted reasoning effort is sent, clamped to the wire scale');

    const perReq = [];
    const pReq = makeOpenAICompatibleProvider({ fetch: mkFetch(perReq), baseUrl: 'http://local/v1', reasoningEffort: 'medium', sendReasoningEffort: true });
    await collect(pReq, { model: 'm', messages: [], reasoningEffort: 'low' });
    A.eq(JSON.parse(perReq[0].init.body).reasoning_effort, 'low', 'per-request effort overrides the instance default');

    const unhinted = [];
    const pNo = makeOpenAICompatibleProvider({ fetch: mkFetch(unhinted), baseUrl: 'http://local/v1', reasoningEffort: 'medium' });
    await collect(pNo, { model: 'm', messages: [] });
    A.eq(JSON.parse(unhinted[0].init.body).reasoning_effort, undefined, 'no hint and no catalog proof -> reasoning_effort stays off the wire');

    const offCalls = [];
    const pOff = makeOpenAICompatibleProvider({ fetch: mkFetch(offCalls), baseUrl: 'http://local/v1', reasoningEffort: 'none', sendReasoningEffort: true });
    await collect(pOff, { model: 'm', messages: [] });
    A.eq(JSON.parse(offCalls[0].init.body).reasoning_effort, undefined, 'effort none omits the param entirely');
  }

  // catalog-proven reasoning model sends the effort even without a profile hint
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ data: [{ id: 'thinky', supportsReasoning: true }] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1', reasoningEffort: 'medium' });
    await p.listModels();
    await collect(p, { model: 'thinky', messages: [] });
    const post = calls.find(c => c.init && c.init.method === 'POST');
    A.eq(JSON.parse(post.init.body).reasoning_effort, 'medium', 'catalog-declared reasoning model gets the effort param');
    A.eq(p.reasoningEfforts('thinky').indexOf('high') >= 0, true, 'reasoningEfforts(id) exposes the wire scale for a reasoning model');
    A.eq(p.reasoningEfforts('unknown'), ['none'], 'unknown model exposes only reasoning off');
  }

  // unsupported-param self-heal: a 400 naming an optional param retries without it and is remembered per model
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      if (body.stream_options !== undefined) {
        return new Response(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }), { status: 400 });
      }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    await collect(p, { model: 'm', messages: [] });
    const posts = () => calls.filter(c => c.init && c.init.method === 'POST');   // catalog re-warm GETs interleave
    A.eq(posts().length, 2, 'rejected optional param retries once without it');
    A.eq(JSON.parse(posts()[1].init.body).stream_options, undefined, 'retry body dropped the rejected param');
    await collect(p, { model: 'm', messages: [] });
    A.eq(posts().length, 3, 'drop is remembered per model - later calls skip the param up front');
    A.eq(JSON.parse(posts()[2].init.body).stream_options, undefined, 'remembered drop keeps the param off the wire');
  }

  // tools are NEVER silently dropped - a provider that rejects tools must fail the run honestly
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { message: 'tools is not supported' } }), { status: 400 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    let err = null;
    try { await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'x' } }] }); }
    catch (e) { err = e; }
    A.eq(!!err, true, 'tools rejection surfaces as an error, never a silent degrade');
    const toolPosts = calls.filter(c => c.init && c.init.method === 'POST');
    A.eq(toolPosts.every(c => JSON.parse(c.init.body).tools !== undefined), true, 'no retry ever removed the tools payload');
  }

  // supported_parameters without 'tools' stays unknown (null), not false — only an explicit 'tools' entry is positive proof
  {
    const fetchImpl = async () => new Response(JSON.stringify({
      data: [
        { id: 'with-tools', supported_parameters: ['tools', 'temperature'] },
        { id: 'without-tools', supported_parameters: ['temperature', 'top_p'] },
        { id: 'bare' }
      ]
    }), { status: 200 });
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const models = await p.listModels();
    const byId = id => models.find(m => m.id === id);
    A.eq(byId('with-tools').supportsTools, true, 'supported_parameters containing tools => true');
    A.eq(byId('without-tools').supportsTools, null, 'supported_parameters without tools => unknown, not false');
    A.eq(byId('bare').supportsTools, null, 'no supported_parameters => unknown');
  }

  // profile-level tool capability is the fallback when the catalog is silent; catalog booleans win
  {
    const fetchImpl = async (url, init) => {
      if (init && init.method === 'POST') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ data: [{ id: 'tooly', supported_parameters: ['tools'] }, { id: 'bare' }] }), { status: 200 });
    };
    const pDeny = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1', supportsTools: false });
    A.eq(pDeny.supportsTools('anything'), false, 'cold catalog falls back to the profile assertion');
    await pDeny.listModels();
    A.eq(pDeny.supportsTools('tooly'), true, 'catalog-declared tool support beats the profile fallback');
    A.eq(pDeny.supportsTools('bare'), false, 'catalog silence falls back to the profile assertion');
    const pNull = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    A.eq(pNull.supportsTools('anything'), null, 'no profile assertion stays honestly unknown');
  }

  // static catalog fallback: fills in only when the live endpoint yields nothing; a real catalog wins
  {
    const statics = [{ id: 'sonar', context_length: 128000, supportsTools: false, supportsReasoning: false }];
    const emptyFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const pEmpty = makeOpenAICompatibleProvider({ fetch: emptyFetch, baseUrl: 'http://api/v1', staticModels: statics });
    const fromStatic = await pEmpty.listModels();
    A.eq(fromStatic.length, 1, 'empty live catalog falls back to the static roster');
    A.eq(pEmpty.contextLimit('sonar'), 128000, 'static roster carries context limits (compaction works)');
    A.eq(pEmpty.supportsTools('sonar'), false, 'static roster carries capability facts');
    A.eq(pEmpty.priceOf('sonar'), null, 'static roster stays honestly unpriced');

    const liveFetch = async () => new Response(JSON.stringify({ data: [{ id: 'real-model' }] }), { status: 200 });
    const pLive = makeOpenAICompatibleProvider({ fetch: liveFetch, baseUrl: 'http://api/v1', staticModels: statics });
    const fromLive = await pLive.listModels();
    A.eq(fromLive.map(m => m.id).join(','), 'real-model', 'a live catalog always wins over the static roster');
  }

  /* ---- a FAILED boot probe must not become a permanent cache hit ----
     `if (catalog) return catalog` treated the [] a failure stores as a hit, so maybeRewarmCatalog — added
     precisely because "an empty catalog stays empty forever" — called straight into that early return. One
     offline launch then zeroed priceOf() for the life of the process (every turn 'unpriced', the ledger
     recording $0 for real spend, the day/global caps never firing) and contextLimit() (no compaction
     threshold). Asserted here for the generic adapter; gemini.js and anthropic.js share the exact shape. ---- */
  {
    let calls = 0, healthy = false, t = 0;
    const fetchImpl = async (url) => {
      if (!String(url).endsWith('/models')) throw new Error('unexpected ' + url);
      calls++;
      if (!healthy) return { ok: false, status: 500, statusText: 'boom', json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-x', context_length: 128000, pricing: { prompt: '0.000003', completion: '0.000015' } }] }) };
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', clock: { now: () => t } });
    A.eq((await p.listModels()).length, 0, 'a failed boot probe yields an empty catalog');
    A.eq(p.contextLimit('gpt-x'), 0, 'and no context limit');
    A.eq(p.priceOf('gpt-x'), null, 'and no price — every turn would be unpriced');
    healthy = true; t = 10 * 60 * 1000;                 // endpoint recovers, the rewarm throttle expires
    A.eq((await p.listModels()).length, 1, 'a later call RE-FETCHES instead of returning the cached empty array');
    A.ok(calls >= 2, 'the /models endpoint was actually probed again');
    A.eq(p.contextLimit('gpt-x'), 128000, 'the context limit recovers');
    A.eq(p.priceOf('gpt-x').in, 3, 'and so does pricing, so the ledger stops recording $0');
  }

  A.report('provider.openai-compatible.test');
})();
