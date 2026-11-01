/* node test/provider.catalog-cache.test.js — the process-wide model catalog (sidecar/providers/catalog-cache.js).
   A run builds a fresh adapter; before this cache every adapter but OpenRouter kept its /models list to itself, so the
   run's context manager (built before the first request) always saw a COLD catalog: Gemini and the OpenAI-compatible
   family read 0 and the run assumed 131072 (a 1M Gemini folded at ~85k), Anthropic read an invented 200000 (real: 1M),
   native Ollama read 0 and the run assumed 131072 against a 65536 window (fold point ABOVE the window), and every fresh
   adapter re-fetched /models on its first stream. Every case here drives the REAL path index.js takes: the factory's
   selectProvider with the cache attached, and the exact runWindow() the run setup awaits. Fake fetch, fake clock. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
delete process.env.SKYNET_OLLAMA_MAX_CTX; delete process.env.SKYNET_OLLAMA_NUM_CTX; delete process.env.SKYNET_OLLAMA_WAIT_NOTE_MS;
const factory = require('../sidecar/providers/factory.js');
const CC = require('../sidecar/providers/catalog-cache.js');
const oc = require('../sidecar/providers/openai-compatible.js');

const clock = { t: 1000, now() { return this.t; } };
const MIN = 60 * 1000;
const cache = CC.makeCatalogCache({ clock });
A.ok(factory.attachCatalogCache(cache) === cache, 'the factory takes the cache (index.js attaches it at boot)');

const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
const SSE = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n';
const sse = () => new Response(SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const settle = () => new Promise(r => setTimeout(r, 10));
async function drain(p, req) { for await (const _ of p.stream(req)) { /* the turn itself is not under test */ } }
const hi = model => ({ model, messages: [{ role: 'user', content: 'hi' }] });

(async () => {
  /* (a) ONE list per (provider, base URL, key): a fresh adapter answers synchronously from the list another instance
     loaded, and its first stream no longer re-fetches /models. */
  {
    let models = 0;
    const fetch = async (url) => { if (/\/models$/.test(url)) { models++; return json({ data: [{ id: 'm', context_length: 200000 }] }); } return sse(); };
    const sel = () => factory.selectProvider({ provider: 'custom', fetch, key: 'K-a', baseUrl: 'https://a.test/v1' });
    const p1 = sel();
    A.eq(p1.contextLimit('m'), 0, 'cold: nothing has loaded this endpoint yet, so the window is unknown (never invented)');
    await p1.listModels();
    const p2 = sel();
    A.eq(p2.contextLimit('m'), 200000, 'a FRESH adapter (the next run) knows the window synchronously');
    A.eq(await CC.runWindow(p2, 'm'), 200000, 'the run is built with the real window, not the 131072 guess');
    await drain(p2, hi('m')); await settle();
    A.eq(models, 1, 'its first stream did not re-fetch /models (one fetch across both adapters)');
  }

  /* (b) Gemini: inputTokenLimit 1048576 on 2.x/3.x. Before: the run assumed 131072 every run (folding at ~85k). */
  {
    let pages = 0;
    const fetch = async (url) => {
      if (/\/models(\?|$)/.test(url)) { pages++; return json({ models: [{ name: 'models/gemini-2.5-pro', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }] }); }
      throw new Error('no stream in this case');
    };
    const sel = () => factory.selectProvider({ provider: 'gemini', fetch, key: 'g-key' });
    const cold = sel();
    A.eq(cold.contextLimit('gemini-2.5-pro'), 0, 'cold Gemini: unknown');
    A.eq(await CC.runWindow(cold, 'gemini-2.5-pro'), 1048576, 'a cold run setup waits briefly and learns the real 1M window');
    A.eq(pages, 1, 'one /models read');
    const next = sel();
    A.eq(next.contextLimit('gemini-2.5-pro'), 1048576, 'the next run\'s fresh adapter knows it at once');
    A.eq(next.contextLimit('models/gemini-2.5-pro'), 1048576, 'under the prefixed id too');
    A.eq(await CC.runWindow(next, 'gemini-2.5-pro'), 1048576, 'and its run setup does not wait or fetch');
    A.eq(pages, 1, 'still one /models read');
  }

  /* (c) Anthropic: the Models API reports max_input_tokens (no context_window field). Before: an invented 200000, cold
     AND warm, so every Claude 4.6+ run folded at 130k of a 1M window. */
  {
    let reads = 0;
    const fetch = async () => { reads++; return json({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', max_input_tokens: 1000000, max_tokens: 128000 }] }); };
    const sel = () => factory.selectProvider({ provider: 'anthropic', fetch, key: 'sk-ant-c' });
    const cold = sel();
    A.eq(cold.contextLimit('claude-opus-5-5'), 0, 'cold Anthropic: unknown, not an invented 200000');
    A.eq(await CC.runWindow(cold, 'claude-opus-5-5'), 1000000, 'run setup learns max_input_tokens');
    const listed = await sel().listModels();
    A.eq(listed[0].context_length, 1000000, 'the model dock reads the same 1M (gauge and fold point agree)');
    A.eq(listed[0].max_completion_tokens, null, 'max_tokens is NOT mapped here (raising the 32000 output cap is a separate decision)');
    A.eq(sel().contextLimit('claude-opus-5-5'), 1000000, 'a fresh adapter knows it synchronously');
    // explicit listModels stays a LIVE read: the key check must never be answered from a cached list
    const before = reads;
    let status = 401;
    const revoked = factory.selectProvider({ provider: 'anthropic', key: 'sk-ant-c', fetch: async () => { reads++; return json({ type: 'error', error: { type: 'authentication_error' } }, status); } });
    A.eq(await revoked.listModels(), [], 'the same key, now refused: a fresh instance\'s listModels goes to the wire');
    A.eq(revoked.catalogHttpStatus(), 401, 'and the key check still sees the refusal status');
    A.eq(reads, before + 1, 'one live read');
    A.eq(revoked.contextLimit('claude-opus-5-5'), 1000000, 'while a run on that instance still reads the shared list');
    status = 200;
  }

  /* (d) Field coverage: every spelling a server REPORTS its window under, and never a trained maximum it does not serve. */
  {
    const n = row => oc._internals.normalizeModel(row).context_length;
    A.eq(n({ id: 'qwen', object: 'model', owned_by: 'vllm', max_model_len: 32768 }), 32768, 'vLLM/SGLang max_model_len (the SERVED window)');
    A.eq(n({ id: 'mistral-large-latest', owned_by: 'mistralai', type: 'base', max_context_length: 131072 }), 131072, 'Mistral max_context_length');
    A.eq(n({ id: 'x', max_input_tokens: 400000 }), 400000, 'max_input_tokens');
    A.eq(n({ id: 'llama-x', context_window: 131072 }), 131072, 'Groq/DeepSeek context_window (unchanged)');
    A.eq(n({ id: 'm', context_length: 64000 }), 64000, 'context_length (unchanged)');
    A.eq(n({ id: 'gguf', owned_by: 'llamacpp', meta: { n_ctx_train: 131072 } }), 0, 'llama.cpp n_ctx_train is a TRAINED maximum: never read');
    A.eq(n({ id: 'qwen3-8b', object: 'model', type: 'llm', arch: 'qwen3', quantization: 'Q4_K_M', state: 'not-loaded', max_context_length: 131072 }), 0,
      'LM Studio row: max_context_length is its trained maximum, and an unloaded model stays unknown');
    A.eq(n({ id: 'qwen3-8b', type: 'llm', arch: 'qwen3', quantization: 'Q4_K_M', state: 'loaded', max_context_length: 131072, loaded_context_length: 8192 }), 8192,
      'LM Studio row: the window it LOADED the model at');
    A.eq(n({ id: 'gpt-6.1-sol', object: 'model', owned_by: 'openai' }), 0, 'OpenAI publishes no window: still unknown (no vendor table here)');
  }

  /* (f) Codex: the account's live list reports context_window; a run's adapter never lists. Before: a flat 272000. */
  {
    const fetch = async () => json({ models: [{ slug: 'gpt-6.1-sol', context_window: 400000, priority: 1 }, { slug: 'gpt-x-nowin', priority: 2 }] });
    const sel = () => factory.selectProvider({ provider: 'codex', fetch, token: 'tok-1' });
    const fresh = sel();
    A.eq(fresh.contextLimit('gpt-6.1-sol'), 272000, 'before any listing: the documented default');
    const rows = await sel().listModels();
    A.eq(rows.find(m => m.id === 'gpt-x-nowin').context_length, 272000, 'the dock row for a slug that reports nothing is unchanged');
    const run = factory.selectProvider({ provider: 'codex', fetch, token: 'tok-2-rotated' });
    A.eq(run.contextLimit('gpt-6.1-sol'), 400000, 'a run adapter (even on a rotated token) reads the window the listing REPORTED');
    A.eq(run.contextLimit('gpt-x-nowin'), 272000, 'a slug that reported none keeps the default (nothing invented)');
    A.eq(run.contextLimit('gpt-5.5'), 272000, 'a curated slug the list did not report keeps its row');
  }

  /* (g) TTL + failure back-off on a fake clock: stale-while-revalidate, ONE refresh at a time, a failed refresh keeps the
     old list, and a warm list that lacks an id refreshes once (a model released after the list loaded). */
  {
    let models = 0, mode = 'v1';
    const fetch = async (url) => {
      if (/\/models$/.test(url)) {
        models++;
        if (mode === 'fail') return json({ error: { message: 'down' } }, 500);
        const data = [{ id: 'm', context_length: 100000 }];
        if (mode === 'v2') data.push({ id: 'new', context_length: 50000 });
        return json({ data });
      }
      return sse();
    };
    const sel = () => factory.selectProvider({ provider: 'custom', fetch, key: 'K-g', baseUrl: 'https://g.test/v1' });
    await sel().listModels();
    A.eq(models, 1, 'loaded once');
    clock.t += 11 * MIN;   // past the 10-minute TTL
    const p = sel();
    A.eq(p.contextLimit('m'), 100000, 'past the TTL the old list still answers synchronously');
    mode = 'fail';
    await drain(p, hi('m'));
    await drain(sel(), hi('m'));
    await settle();
    A.eq(models, 2, 'exactly ONE refresh was kicked for the aged list (the second stream joined, not re-fetched)');
    A.eq(sel().contextLimit('m'), 100000, 'a refresh that answered HTTP 500 keeps the old list');
    await drain(sel(), hi('m')); await settle();
    A.eq(models, 2, 'inside the failure back-off: no refetch');
    clock.t += 2 * MIN;
    mode = 'v2';
    await drain(sel(), hi('m')); await settle();
    A.eq(models, 3, 'past the back-off: one refetch');
    A.eq(sel().contextLimit('new'), 50000, 'a model the refresh added is known');
    // a warm list without the asked id: one throttled refresh
    clock.t += 2 * MIN;
    const q = sel();
    A.eq(q.contextLimit('later-model'), 0, 'an id the list lacks is unknown...');
    await settle();
    A.eq(models, 4, '...and kicks ONE refresh (the list is older than the back-off)');
    q.contextLimit('later-model'); q.contextLimit('later-model'); await settle();
    A.eq(models, 4, 'repeated asks inside the back-off do not refetch');
    clock.t += 90 * 1000; q.contextLimit('later-model'); await settle();
    A.eq(models, 4, 'the miss gap doubled (120s): an id the endpoint never lists cannot re-fetch every minute');
    clock.t += 40 * 1000; q.contextLimit('later-model'); await settle();
    A.eq(models, 5, 'past the doubled gap: one more');
  }
  // consecutive failures back off exponentially (an endpoint with no usable /models is not asked every minute)
  {
    let models = 0;
    const fetch = async (url) => { if (/\/models$/.test(url)) { models++; return json({ error: { message: 'no such route' } }, 404); } return sse(); };
    const sel = () => factory.selectProvider({ provider: 'custom', fetch, key: 'K-g2', baseUrl: 'https://g2.test/v1' });
    await drain(sel(), hi('m')); await settle();
    A.eq(models, 1, 'first stream: one background load (fails)');
    clock.t += 61 * 1000; await drain(sel(), hi('m')); await settle();
    A.eq(models, 2, 'past the 60s back-off: one retry (fails again)');
    clock.t += 61 * 1000; await drain(sel(), hi('m')); await settle();
    A.eq(models, 2, 'the back-off doubled to 120s: no retry at 61s');
    clock.t += 60 * 1000; await drain(sel(), hi('m')); await settle();
    A.eq(models, 3, 'past 120s: one retry');
  }

  /* (g, OpenRouter) its module-level CATALOG was never refreshed after the first load. */
  {
    const or = require('../sidecar/providers/openrouter.js');
    let reads = 0, extra = false;
    const fetch = async (url) => {
      if (/\/models$/.test(url)) { reads++; const data = [{ id: 'a/m', context_length: 128000, supported_parameters: ['tools'] }]; if (extra) data.push({ id: 'b/new', context_length: 262144, supported_parameters: ['tools'] }); return json({ data }); }
      return sse();
    };
    const sel = () => or.makeOpenRouterProvider({ fetch, key: 'or-k' });   // index.js's boot warm builds it directly
    await sel().listModels();
    A.eq(reads, 1, 'OpenRouter catalog loaded');
    A.eq(sel().contextLimit('a/m'), 128000, 'shared module catalog answers');
    extra = true;
    clock.t += 2 * MIN;
    A.eq(sel().contextLimit('b/new'), 0, 'a model listed after the load: unknown at first');
    await settle();
    A.eq(reads, 2, 'the miss kicked one refresh');
    A.eq(sel().contextLimit('b/new'), 262144, 'and the refreshed catalog knows it');
    clock.t += 11 * MIN;
    await drain(sel(), { model: 'a/m', messages: [{ role: 'user', content: 'hi' }] }); await settle();
    A.eq(reads, 3, 'past the TTL a stream refreshes the catalog once');
    A.eq(cache.windowFact('https://openrouter.ai/api/v1', 'b/new'), 262144, 'OpenRouter loads feed the window facts too');
  }

  /* (h) Isolation: a second key never reuses the first key's list, but reads the windows the endpoint REPORTED; the
     cache holds a fingerprint, never the key. */
  {
    let models = 0;
    const fetch = async (url) => { if (/\/models$/.test(url)) { models++; return json({ data: [{ id: 'iso', context_length: 77000 }] }); } return sse(); };
    const SECRET = 'sk-live-ISOLATION-SECRET-123456';
    await factory.selectProvider({ provider: 'custom', fetch, key: SECRET, baseUrl: 'https://h.test/v1' }).listModels();
    const other = factory.selectProvider({ provider: 'custom', fetch, key: 'sk-other-key-999', baseUrl: 'https://h.test/v1' });
    A.eq(other.contextLimit('iso'), 77000, 'the endpoint-reported window is a fact about the model, shared');
    await drain(other, hi('iso')); await settle();
    A.eq(models, 2, 'but the second key loads its OWN list');
    const scope = cache.scopeOf('custom', 'https://h.test/v1', SECRET);
    A.ok(scope.indexOf(SECRET) < 0 && /\|[0-9a-f]{16}$/.test(scope), 'a scope carries a 16-hex fingerprint, never the key: ' + scope);
    A.ok(JSON.stringify(cache.peek(scope)).indexOf(SECRET) < 0, 'a cached entry never contains the key');
    A.ok(cache.scopeOf('custom', 'https://h.test/v1', 'sk-other-key-999') !== scope, 'two keys, two scopes');
  }

  /* (i) Native Ollama: the run window is the SERVED window min(trained max, 65536 ceiling), read from ONE /api/show the
     whole process shares. Before: 131072 at setup (fold point 85,197 above the 65,536 window) and one /api/show per
     instance (plus one per installed model on every fresh catalog load). */
  {
    let show = 0, models = 0;
    const fetch = async (url) => {
      if (/\/api\/show$/.test(url)) { show++; return json({ model_info: { 'qwen3.context_length': 131072 }, capabilities: ['completion', 'tools'] }); }
      if (/\/api\/ps$/.test(url)) return json({ models: [] });
      if (/\/v1\/models$/.test(url)) { models++; return json({ data: [{ id: 'm:8b' }] }); }
      if (/\/api\/chat$/.test(url)) return new Response('{"message":{"role":"assistant","content":"ok"},"done":false}\n{"done":true,"done_reason":"stop","prompt_eval_count":10,"eval_count":1}\n', { status: 200 });
      throw new Error('unexpected ' + url);
    };
    const sel = () => factory.selectProvider({ provider: 'ollama', fetch, baseUrl: 'http://127.0.0.1:11434/v1' });
    const first = sel();
    A.eq(first.contextLimit('m:8b'), 0, 'cold: unknown');
    A.eq(await CC.runWindow(first, 'm:8b'), 65536, 'run setup learns the SERVED window (trained 131072, ceiling 65536)');
    A.eq(show, 1, 'from one /api/show');
    const second = sel();
    A.eq(second.contextLimit('m:8b'), 65536, 'the next run\'s adapter knows it synchronously');
    await drain(second, { model: 'm:8b', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 't', parameters: { type: 'object', properties: {} } } }], isTask: true });
    await settle();
    A.eq(show, 1, 'no second /api/show for the same server and model inside the TTL');
    A.ok(models <= 1, '/v1/models read at most once across both adapters (' + models + ')');
    const pinned = factory.selectProvider({ provider: 'ollama', fetch, baseUrl: 'http://127.0.0.1:11434/v1' });
    A.eq(pinned.contextLimit('m:8b'), 65536, 'each instance applies its own ceiling to the shared trained maximum');
  }

  /* runWindow itself: a known window never waits; an unknown one waits at most waitMs and the timer is always cleared. */
  {
    let warmed = 0;
    A.eq(await CC.runWindow({ contextLimit: () => 32000, warmCatalog: () => { warmed++; } }, 'x'), 32000, 'known: answered at once');
    A.eq(warmed, 0, 'and warmCatalog was not called');
    const t0 = process.hrtime.bigint();
    const hold = setInterval(() => {}, 1000);   // the bound's timer is unref'd (it must never keep a sidecar alive): hold the test open
    A.eq(await CC.runWindow({ contextLimit: () => 0, warmCatalog: () => new Promise(() => {}) }, 'x', { waitMs: 40 }), 0, 'a catalog that never answers: unknown after the bound');
    clearInterval(hold);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    A.ok(ms < 1000, 'the wait is bounded (' + Math.round(ms) + 'ms)');
    A.eq(await CC.runWindow({ contextLimit: () => 0, warmCatalog: async () => { throw new Error('boom'); } }, 'x'), 0, 'a failing warm is fail-open: unknown, never a throw');
    A.eq(await CC.runWindow({ contextLimit: () => 0 }, 'x'), 0, 'an adapter without warmCatalog (claude-cli) answers as before');
    A.eq(CC.RUN_WINDOW_WAIT_MS, 1500, 'the run setup bound');
  }

  /* (j) A LIVE LIST IS AUTHORITATIVE for the ids it lists, and a reported window ages out with the TTL. Before: a window
     an endpoint once reported outlived the endpoint's own later answer, so a run was built over the real window. */
  {
    // LM Studio's /api/v0 on a CUSTOM card: loaded at 32768, then ejected (it JIT-loads at its default, often 4096)
    let loaded = true;
    const lmRow = () => Object.assign({ id: 'qwen3-8b', object: 'model', type: 'llm', arch: 'qwen3', quantization: 'Q4_K_M', compatibility_type: 'gguf', max_context_length: 131072 },
      loaded ? { state: 'loaded', loaded_context_length: 32768 } : { state: 'not-loaded' });
    const lmFetch = async (url) => { if (/\/models$/.test(url)) return json({ data: [lmRow()] }); return sse(); };
    const lm = () => factory.selectProvider({ provider: 'custom', fetch: lmFetch, key: '', baseUrl: 'http://localhost:1234/api/v0' });
    await lm().listModels();
    A.eq(await CC.runWindow(lm(), 'qwen3-8b'), 32768, 'LM Studio: the run is built on the window it LOADED the model at');
    loaded = false;
    clock.t += 11 * MIN;
    const dock = await lm().listModels();   // a live read: the endpoint's current answer for this id is "no window"
    A.eq(dock[0].context_length, 0, 'the ejected model\'s live row reports no window');
    A.eq(lm().contextLimit('qwen3-8b'), 0, 'a fresh adapter no longer reads the window the earlier list reported');
    A.eq(await CC.runWindow(lm(), 'qwen3-8b'), 0, 'so the run is NOT built over the 4096 it will be JIT-loaded at (was 32768)');
    A.eq(cache.windowFact('http://localhost:1234/api/v0', 'qwen3-8b'), 0, 'the listed id lost its old window fact');

    // a local port swapped from vLLM (max_model_len) to llama.cpp serving the same id (n_ctx_train is never read)
    let server = 'vllm';
    const swapFetch = async (url) => {
      if (/\/models$/.test(url)) return server === 'vllm' ? json({ data: [{ id: 'm', object: 'model', owned_by: 'vllm', max_model_len: 32768 }] })
        : json({ data: [{ id: 'm', owned_by: 'llamacpp', meta: { n_ctx_train: 131072 } }] });
      return sse();
    };
    const port = () => factory.selectProvider({ provider: 'custom', fetch: swapFetch, key: '', baseUrl: 'http://localhost:8000/v1' });
    await port().listModels();
    A.eq(port().contextLimit('m'), 32768, 'vLLM era: max_model_len');
    server = 'llamacpp';
    await port().listModels();   // inside the TTL: still the endpoint's own current answer
    A.eq(port().contextLimit('m'), 0, 'llama.cpp now serves it and reports no window: unknown, not the vLLM 32768');
    A.eq(await CC.runWindow(port(), 'm'), 0, 'and the run is not built on it');

    // a duplicate row that reports no window never erases the one the same list reports
    cache.noteWindows('https://dup.test/v1', [{ id: 'd', context_length: 50000 }, { id: 'd' }]);
    A.eq(cache.windowFact('https://dup.test/v1', 'd'), 50000, 'one list, one id: its reported window stands');

    // An OAuth adapter lists nothing of its own, so nothing revalidated the window the dock's listing saw: past the TTL
    // it no longer answers, and the run setup's warm reads the endpoint again (one /models) instead of trusting it.
    let grokReads = 0, grokWindow = 256000;
    const grokFetch = async (url) => { if (/\/models$/.test(url)) { grokReads++; return json({ data: [{ id: 'grok-9', context_length: grokWindow }] }); } return sse(); };
    const grok = tok => factory.selectProvider({ provider: 'grok', fetch: grokFetch, token: tok });
    await grok('tok-dock').listModels();
    A.eq(grok('tok-run-1').contextLimit('grok-9'), 256000, 'OAuth: a run adapter reads the window the dock\'s listing reported');
    grokWindow = 131072;
    clock.t += 11 * MIN;
    const late = grok('tok-run-2');
    A.eq(late.contextLimit('grok-9'), 0, 'past the TTL the old report answers nothing (was 256000)');
    A.eq(await CC.runWindow(late, 'grok-9'), 131072, 'the run setup re-reads the endpoint and is built on its CURRENT window');
    A.eq(grokReads, 2, 'with one /models read');
    A.eq(grok('tok-run-3').contextLimit('grok-9'), 131072, 'and the next run reads the fresh report synchronously');
    A.eq(grokReads, 2, 'without another read');

    // Codex has no warm: past the TTL its run reads the curated row again (exactly as before this cache)
    const cxFetch = async () => json({ models: [{ slug: 'gpt-6.1-sol', context_window: 128000, priority: 1 }] });
    await factory.selectProvider({ provider: 'codex', fetch: cxFetch, token: 'cx-dock' }).listModels();
    A.eq(factory.selectProvider({ provider: 'codex', fetch: cxFetch, token: 'cx-run' }).contextLimit('gpt-6.1-sol'), 128000, 'Codex: the reported window inside the TTL');
    clock.t += 11 * MIN;
    A.eq(factory.selectProvider({ provider: 'codex', fetch: cxFetch, token: 'cx-run-2' }).contextLimit('gpt-6.1-sol'), 272000, 'past the TTL: the documented default, as before');
  }

  /* A /models that never answers cannot pin the scope or hold every later run on the wait: the shared load times out
     into the failure back-off. */
  {
    const hung = CC.makeCatalogCache({ clock, loadTimeoutMs: 50 });
    factory.attachCatalogCache(hung);
    let models = 0;
    const fetch = async (url) => { if (/\/models$/.test(url)) { models++; return new Promise(() => {}); } return sse(); };
    const sel = () => factory.selectProvider({ provider: 'custom', fetch, key: 'K-hang', baseUrl: 'https://hang.test/v1' });
    const hold = setInterval(() => {}, 1000);
    const ms = t => Number(process.hrtime.bigint() - t) / 1e6;
    let t = process.hrtime.bigint();
    A.eq(await CC.runWindow(sel(), 'm', { waitMs: 400 }), 0, 'a hung /models: the first run gives up at the load timeout, window unknown');
    A.ok(ms(t) < 350, 'bounded (' + Math.round(ms(t)) + 'ms)');
    t = process.hrtime.bigint();
    A.eq(await CC.runWindow(sel(), 'm', { waitMs: 400 }), 0, 'the next run: still unknown');
    A.ok(ms(t) < 40, 'and it does not wait again: the endpoint is in its back-off (' + Math.round(ms(t)) + 'ms)');
    A.eq(models, 1, 'no second request to the hung endpoint inside the back-off');
    clearInterval(hold);
    factory.attachCatalogCache(cache);
  }

  /* index.js wiring (the run-build site cannot be required: it boots a sidecar). The cache is attached at boot, and the
     run's context manager is built from the awaited runWindow, after every provider swap. */
  {
    const src = readSidecarSource();
    A.ok(/attachCatalogCache\(makeCatalogCache\(\{ clock: \{ now: \(\) => Date\.now\(\) \} \}\)\)/.test(src), 'index.js attaches ONE cache with the real clock at boot');
    const waitAt = src.indexOf('const knownRunWindow = CONTEXT_LIMIT_OVERRIDE ? 0 : await catalogRunWindow(provider, model);');
    // windowCeiling: the model's long-context price-tier boundary (context-cost-1023; test/context.price-tier-window.test.js)
    const ctxAt = src.indexOf('const ctxMgr = makeContext(Object.assign({ contextLimit: CONTEXT_LIMIT_OVERRIDE || knownRunWindow || COLD_CATALOG_CONTEXT_TOKENS, windowCeiling: runWindowCeiling }, RUN_CONTEXT_DEFAULTS));');
    A.ok(waitAt > 0 && ctxAt > waitAt, 'the run awaits its window, then builds its context from it');
    A.ok(src.lastIndexOf('provider = selectProvider(', ctxAt) < waitAt, 'every provider swap (key rotation) happens before the window is read');
    A.ok(src.indexOf('contextLimit: CONTEXT_LIMIT_OVERRIDE || provider.contextLimit(model) || COLD_CATALOG_CONTEXT_TOKENS') < 0, 'the cold synchronous read is gone');
  }

  A.report('provider.catalog-cache.test');
})().catch(e => { console.log('FAIL: provider.catalog-cache.test threw -- ' + (e && e.stack || e)); process.exit(1); });
