/* node test/hosted-request-bytes.test.js — HOSTED REQUEST BYTES STAY THE BYTES (local-runtime-profile lane, done-means c).

   The local-runtime-profile lane changes how StarNet treats a model server on THIS computer or THIS network (one send,
   then local_timeout; a local connect ceiling; endpoint facts). None of that may reach a hosted provider. This file
   pins the exact request every hosted adapter sends: the URL, the headers and the body BYTES, built by the real
   adapters (through the real factory) against a fake fetch that answers catalogs and records each chat request.

   Fixed requests per provider: a plain chat, a turn with tools (and a prior tool round), a turn with a reasoning
   effort, and a turn carrying an image. Providers: OpenAI, OpenRouter, Anthropic, Gemini, Codex, the StarNet managed
   proxy, and a CUSTOM endpoint on a public host (by name and by public IP).

   test/fixtures/hosted-request-bytes.json was written at 0b8441064, BEFORE any lane change, and is compared byte for
   byte. Re-writing it (STARNET_WRITE_HOSTED_FIXTURE=1) is only right for an intended hosted change: it defeats the
   point of this file otherwise. No network: the fake fetch answers everything. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const factory = require('../sidecar/providers/factory.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'hosted-request-bytes.json');

const TOOLS = [
  { type: 'function', function: { name: 'fs_read', description: 'Read a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'workspace path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } }
];
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SYSTEM = { role: 'system', content: 'You are a StarNet agent. Answer briefly.' };

const REQUESTS = {
  plain: () => ({ messages: [SYSTEM, { role: 'user', content: 'hello there' }] }),
  tools: () => ({
    messages: [SYSTEM,
      { role: 'user', content: 'read notes.md and search for its title' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"notes.md"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '# Station notes\nline two' },
      { role: 'user', content: 'now search' }],
    tools: TOOLS, isTask: true
  }),
  reasoning: () => ({ messages: [SYSTEM, { role: 'user', content: 'think about 17 * 23' }], reasoningEffort: 'high' }),
  image: () => ({ messages: [SYSTEM, { role: 'user', content: [{ type: 'text', text: 'what is in this picture?' }, { type: 'image_url', image_url: { url: PNG } }] }] })
};

// One catalog row the CUSTOM endpoints list, so their reasoning path is the one a real catalog drives.
const CUSTOM_MODELS = { data: [{ id: 'm-reason', object: 'model', supportsReasoning: true, context_length: 32768 }] };

const PROVIDERS = [
  { id: 'openai', model: 'gpt-5.4', opts: { key: 'sk-test-openai-000000' } },
  { id: 'openrouter', model: 'anthropic/claude-sonnet-4.5', opts: { key: 'sk-or-test-000000', referer: 'https://starnet.example' } },
  { id: 'anthropic', model: 'claude-sonnet-4-5', opts: { key: 'sk-ant-test-000000' } },
  { id: 'gemini', model: 'gemini-2.5-pro', opts: { key: 'gemini-test-key-000000' } },
  { id: 'codex', model: 'gpt-5.4-codex', opts: { token: 'codex-test-token-000000' } },
  { id: 'starnet', model: 'openai/gpt-5.4', opts: { key: 'snk-test-000000', baseUrl: 'https://cloud.starnet.example/v1' }, req: { runId: 'run-fixture-1' } },
  { id: 'custom', label: 'custom-public-name', model: 'm-reason', opts: { key: 'custom-key-000000', baseUrl: 'https://llm.example.com/v1' }, models: CUSTOM_MODELS },
  { id: 'custom', label: 'custom-public-ip', model: 'm-reason', opts: { baseUrl: 'http://203.0.113.10:8000/v1' }, models: CUSTOM_MODELS }
];

function plainHeaders(h) {
  const out = {};
  if (!h) return out;
  if (typeof h.forEach === 'function' && typeof h.get === 'function') h.forEach((v, k) => { out[String(k).toLowerCase()] = String(v); });
  else for (const k of Object.keys(h)) out[String(k).toLowerCase()] = String(h[k]);
  const sorted = {};
  for (const k of Object.keys(out).sort()) sorted[k] = out[k];
  return sorted;
}

function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

// The fake network: a GET is a catalog read; a request with a body is a chat request, recorded and then cancelled
// (the caller's controller aborts, so every adapter ends the stream as a clean cancel after exactly one request).
function makeFetch(entry, sink, ctl) {
  return async (url, init) => {
    init = init || {};
    if (init.body == null) {
      const body = entry.models || { data: [], models: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    sink.push({ method: String(init.method || 'GET'), url: String(url), headers: plainHeaders(init.headers), body: String(init.body) });
    if (ctl.current) ctl.current.abort();
    throw abortError();
  };
}

async function buildAll() {
  const out = [];
  for (const entry of PROVIDERS) {
    for (const name of Object.keys(REQUESTS)) {
      const sink = [];
      const ctl = { current: null };
      const p = factory.selectProvider(Object.assign({ provider: entry.id, fetch: makeFetch(entry, sink, ctl) }, entry.opts));
      if (typeof p.listModels === 'function') { try { await p.listModels(); } catch (_) { /* a catalog the fake cannot shape: none */ } }
      const ac = new AbortController();
      ctl.current = ac;
      const req = Object.assign({ model: entry.model, stream: true, signal: ac.signal }, REQUESTS[name](), entry.req || {});
      let error = '';
      try { for await (const ev of p.stream(req)) void ev; } catch (e) { error = String((e && e.message) || e); }
      out.push({ case: (entry.label || entry.id) + '/' + name, requests: sink, error });
    }
  }
  return out;
}

(async () => {
  const built = await buildAll();
  if (process.env.STARNET_WRITE_HOSTED_FIXTURE === '1') {
    fs.writeFileSync(FIXTURE, JSON.stringify(built, null, 2) + '\n');
    console.log('wrote ' + FIXTURE + ' (' + built.length + ' cases)');
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  A.eq(built.map(c => c.case), fixture.map(c => c.case), 'the same hosted cases, in the same order');
  for (const c of fixture) {
    const now = built.find(b => b.case === c.case);
    if (!now) { A.ok(false, c.case + ' was built'); continue; }
    A.ok(c.requests.length >= 1, c.case + ': the fixture holds at least one request');
    A.eq(now.requests.length, c.requests.length, c.case + ': the same number of requests');
    A.eq(now.error, c.error, c.case + ': the same stream outcome');
    for (let i = 0; i < c.requests.length; i++) {
      const was = c.requests[i], is = now.requests[i] || {};
      A.eq(is.url, was.url, c.case + ' #' + i + ': same URL');
      A.eq(is.method, was.method, c.case + ' #' + i + ': same method');
      A.eq(is.headers, was.headers, c.case + ' #' + i + ': same headers');
      A.ok(is.body === was.body, c.case + ' #' + i + ': byte-identical body' + (is.body === was.body ? '' : '\n  was: ' + was.body + '\n  now: ' + is.body));
    }
  }
  // the fixture proves what it claims: every hosted adapter, every request shape, real request bodies
  const ids = new Set(fixture.map(c => c.case.split('/')[0]));
  for (const id of ['openai', 'openrouter', 'anthropic', 'gemini', 'codex', 'starnet', 'custom-public-name', 'custom-public-ip']) A.ok(ids.has(id), 'fixture covers ' + id);
  A.ok(fixture.every(c => c.requests.every(r => r.body.length > 50 && r.body.indexOf('StarNet agent') >= 0)), 'every recorded body carries the fixed system prompt');
  A.ok(fixture.filter(c => /\/tools$/.test(c.case)).every(c => c.requests[0].body.indexOf('fs_read') >= 0), 'every tools case carries the tool schemas');
  A.report('hosted-request-bytes.test');
})();
