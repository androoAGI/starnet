/* node test/run-wire.v1.test.js — /v1 refuses a pair it cannot run, and runs the selected agent's effort (run-wire-resolver
   lane, review round 3).

   Through the production HTTP adapter (sidecar/openai-compat.js makeOpenAiCompat) wired with the seams index.js really
   hands it (resolveWire, hasCredential, credentialError, lifted out of its makeOpenAiCompat call) over the real v1WireFor /
   runWireFor and the real provider registry normaliser:
     - a STARNET_V1_PROVIDER this station does not know ('olama', 'antrhopic', 'open-router') is REFUSED: 503
       model_not_configured, no run. It used to normalise to '' and borrow the Overseer's provider, so a typo sent generic
       /v1 to that cloud provider with its credential, and nothing was logged;
     - STARNET_V1_PROVIDER set without STARNET_V1_MODEL names no model: it is said once in the log, never silently;
     - a resolved provider the station holds no credential for (STARNET_V1_PROVIDER=anthropic, no Anthropic key) answers
       503 provider_not_configured before any run starts — the prompt used to go out unauthenticated;
     - a session-header request that selects a roster agent runs as 'api-<session>' (not on the roster), so the run now
       carries that agent's effort as its own: runOnceCore's resolution used to give it the Overseer's;
     - POST /api/run (the same family, review round 4) refuses a body's provider this station does not know with a 400,
       where its normalizeProvider re-homed it on openrouter with the station's key. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { sidecarFunctionSource, readSidecarSource } = require('./helpers/source.js');
const RunWire = require('../sidecar/run-wire.js');
const Reg = require('../sidecar/providers/registry.js');
const { makeOpenAiCompat } = require('../sidecar/openai-compat.js');

const normalizeProviderId = v => Reg.normalizeProviderId(v, '');
const normalizeProvider = v => Reg.normalizeProviderId(v, 'openrouter');
let ENVV = {}, keys = {};
const warns = [];
const agentRoster = new Map();
const deps = {
  agentRoster, RunWire, codexTokens: { access_token: 'codex-token' }, normalizeProviderId, normalizeProvider,
  registryProviderUsesCodex: p => normalizeProviderId(p) === 'codex',
  providerRuntimeKey: (id, k) => { const p = normalizeProvider(id); return p === 'codex' ? '' : (String(k || '').trim() || keys[p] || ''); },
  providerRuntimeBaseUrl: () => '',
  providerHasCredential: (id, key) => (normalizeProvider(id) === 'codex' ? true : !!String(key || '').trim()),
  providerCredentialError: id => 'connect a ' + id + ' API key',
  ENV: n => ENVV[n] || '', CODEX_DEFAULT_MODEL: 'gpt-codex-default',
  console: { warn: m => warns.push(String(m)), log() {} }
};
const names = ['runWireEnv', 'runWireFor', 'runWireOfRun', 'v1WireFor'];
const host = new Function(...Object.keys(deps), names.map(n => sidecarFunctionSource(n)).join('\n') + '\nreturn {' + names.join(', ') + '};')(...Object.values(deps));

// the seams index.js hands makeOpenAiCompat, lifted from its own call and evaluated over the host
const SRC = readSidecarSource();
const at = SRC.indexOf('const openaiCompat = makeOpenAiCompat({');
const CALL = at < 0 ? '' : SRC.slice(at, SRC.indexOf('\n});', at));
const scope = Object.assign({}, deps, { v1WireFor: host.v1WireFor });
const seam = name => { const m = new RegExp('\\n  ' + name + ': (.+),\\n').exec(CALL); return m ? new Function(...Object.keys(scope), 'return (' + m[1] + ');')(...Object.values(scope)) : undefined; };
A.ok(CALL.length > 100 && typeof seam('resolveWire') === 'function', 'fixture: index.js composes the /v1 surface with its resolveWire');

const KEY = 'run-wire-v1-test-key-123456';
const readBody = async req => { let s = ''; for await (const c of req) s += c; return s; };

(async () => {
  agentRoster.set('agent', { name: 'NOVA', model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'xhigh' });
  agentRoster.set('scout', { name: 'SCOUT', model: '', provider: '', reasoningEffort: 'high' });   // unpinned, its own class effort

  // ---- 1. v1WireFor: an unknown STARNET_V1_PROVIDER is refused, a known one (or none) runs ----
  for (const typo of ['olama', 'antrhopic', 'open-router']) {
    ENVV = { V1_MODEL: 'some-model', V1_PROVIDER: typo };
    const w = host.v1WireFor('api-x', false);
    A.eq([w.ok, w.provider, w.model], [false, '', ''], 'STARNET_V1_PROVIDER ' + JSON.stringify(typo) + ' is refused, never re-homed on the Overseer\'s provider');
    A.ok(new RegExp('STARNET_V1_PROVIDER "' + typo + '" is not a provider this station knows').test(w.error || ''), '...and the refusal names it: ' + w.error);
  }
  for (const [given, want] of [['', 'openrouter'], ['claude', 'anthropic'], ['OpenAI ', 'openai']]) {
    ENVV = { V1_MODEL: 'some-model', V1_PROVIDER: given };
    const w = host.v1WireFor('api-x', false);
    A.eq([w.ok, w.provider, w.model, w.source], [true, want, 'some-model', 'env'], 'STARNET_V1_PROVIDER ' + JSON.stringify(given) + ' runs on ' + want);
  }
  ENVV = { V1_MODEL: 'some-model', V1_PROVIDER: 'olama' };
  A.eq([host.v1WireFor('scout', true).ok, host.v1WireFor('scout', true).model], [true, 'gpt-5.5'], 'a selected roster agent never reads STARNET_V1_*: it runs its own pair');

  // ---- 2. a provider with no model is said once, never silently ----
  ENVV = { V1_PROVIDER: 'anthropic' };
  const w2 = host.v1WireFor('api-x', false);
  host.v1WireFor('api-y', false);
  A.eq([w2.ok, w2.provider, w2.model], [true, 'codex', 'gpt-5.5'], 'STARNET_V1_PROVIDER alone names no model: the station default runs');
  A.eq(warns.length, 1, 'it is logged once: ' + warns.join(' / '));
  A.ok(/STARNET_V1_PROVIDER is set \("anthropic"\) without STARNET_V1_MODEL/.test(warns[0] || ''), '...naming the variable it ignores: ' + warns[0]);

  // ---- 3. the production adapter answers a wire it cannot run before any run ----
  const ran = [];
  let reserved = 0;
  const api = makeOpenAiCompat({
    now: () => 1000, newId: (() => { let i = 0; return () => 'id' + (++i); })(), apiKey: () => KEY, readBody,
    runOnce: async o => { ran.push(o); o.emit('agent.run.start', { runId: o.runId }); o.emit('agent.token', { delta: 'ok' }); o.emit('agent.run.end', { reason: 'done' }); },
    resolveProviderKey: p => deps.providerRuntimeKey(p, ''), resolveBaseUrl: () => '',
    roster: () => [...agentRoster].map(([agentId, a]) => ({ agentId, name: a.name })),
    resolveWire: seam('resolveWire'), hasCredential: seam('hasCredential'), credentialError: seam('credentialError'),
    requestReservations: { run: async () => { reserved++; throw Object.assign(new Error('reserved'), { code: 'reservation_failed' }); } }
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (pathName, body, headers) => {
    const r = await fetch(base + pathName, { method: 'POST', headers: Object.assign({ Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
    return { status: r.status, json, text };
  };
  const chat = (extra, headers) => post('/v1/chat/completions', Object.assign({ model: 'starnet-agent', stream: false, messages: [{ role: 'user', content: 'hi' }] }, extra || {}), headers);
  try {
    A.ok(typeof seam('hasCredential') === 'function', 'index.js hands /v1 the credential check');
    ENVV = { V1_MODEL: 'llama3', V1_PROVIDER: 'olama' };
    for (const [label, call] of [['sync', () => chat()], ['streamed', () => chat({ stream: true })], ['/v1/runs', () => post('/v1/runs', { input: 'hi' })],
      ['keyed', () => chat({}, { 'Idempotency-Key': 'k-1' })]]) {
      const r = await call();
      A.eq([r.status, r.json && r.json.error && r.json.error.code], [503, 'model_not_configured'], 'a ' + label + ' request on an unknown STARNET_V1_PROVIDER is answered 503 model_not_configured');
      A.ok(/"olama"/.test((r.json && r.json.error && r.json.error.message) || ''), '...with the refusal: ' + r.text.slice(0, 200));
    }
    A.eq([ran.length, reserved], [0, 0], 'no run started and no request was reserved');

    ENVV = { V1_MODEL: 'claude-sonnet-4-5', V1_PROVIDER: 'anthropic' };
    keys = { openrouter: 'sk-or' };
    for (const [label, call] of [['sync', () => chat()], ['streamed', () => chat({ stream: true })], ['/v1/runs', () => post('/v1/runs', { input: 'hi' })]]) {
      const r = await call();
      A.eq([r.status, r.json && r.json.error && r.json.error.code], [503, 'provider_not_configured'], 'a ' + label + ' request on a provider with no credential is answered 503 provider_not_configured');
      A.ok(/connect a anthropic API key/.test((r.json && r.json.error && r.json.error.message) || ''), '...naming the remedy: ' + r.text.slice(0, 200));
    }
    A.eq(ran.length, 0, 'the prompt never left unauthenticated');
    keys = { openrouter: 'sk-or', anthropic: 'sk-ant' };
    const ok = await chat();
    A.eq([ok.status, ran[0] && ran[0].provider, ran[0] && ran[0].model, ran[0] && ran[0].key], [200, 'anthropic', 'claude-sonnet-4-5', 'sk-ant'], 'with the key it runs');

    // ---- 4. a session-header request that selects a roster agent runs that agent's effort ----
    ENVV = {}; ran.length = 0;
    const s = await chat({ model: 'scout' }, { 'X-StarNet-Session-Id': 'sess1' });
    const run = ran[0] || {};
    A.eq([s.status, run.agentId, run.provider, run.model, run.reasoningEffort], [200, 'api-sess1', 'codex', 'gpt-5.5', 'high'],
      "the session run carries scout's own effort (high), not the Overseer's (xhigh)");
    A.eq(host.runWireOfRun(run).reasoningEffort, 'high', "...and runOnceCore's resolution runs it at that effort");
    ran.length = 0;
    await chat({ model: 'scout' });   // a chat completion with no header derives a session from its first turn: api-<hash>
    A.eq([/^api-/.test((ran[0] && ran[0].agentId) || ''), ran[0] && host.runWireOfRun(ran[0]).reasoningEffort], [true, 'high'], "a derived-session chat completion runs scout's effort too");
    ran.length = 0;
    await post('/v1/runs', { model: 'scout', input: 'hi' });
    for (let i = 0; i < 50 && !ran.length; i++) await new Promise(r => setTimeout(r, 10));
    A.eq([ran[0] && ran[0].agentId, ran[0] && host.runWireOfRun(ran[0]).reasoningEffort], ['scout', 'high'], 'a /v1/runs request with no session runs as scout, at the same effort');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }

  // ---- 5. POST /api/run (COMMS, `starnet run`, ACP) refuses a provider this station does not know (review round 4) ----
  // handleRun's own source, run until it refuses or passes the provider check. Its normalizeProvider falls back to
  // openrouter, so `starnet run --provider olama --model llama3` ran openrouter/llama3 on the station's own key before
  // runOnceCore could refuse it (r4-unknown-provider.js). Past the check, a stub `require` stops it with a marker.
  {
    const PAST = 'past the provider check';
    let sent = {};
    const handleRun = new Function('readBody', 'agentRoster', 'normalizeProviderId', 'normalizeProvider', 'runWireFor', 'overseer', 'runStore', 'require',
      sidecarFunctionSource('handleRun') + '\nreturn handleRun;')(
      async () => JSON.stringify(sent), agentRoster, normalizeProviderId, normalizeProvider, (id, ex) => host.runWireFor(id, ex),
      { resumeReviews() {} }, { all: () => [] }, () => { throw new Error(PAST); });
    const apiRun = async body => {
      sent = body;
      let status = 0, text = '';
      await handleRun({}, { headersSent: false, writeHead(s) { status = s; }, end(t) { text = String(t == null ? '' : t); } });
      return { status, text };
    };
    for (const typo of ['olama', 'open-router', 'chatgpt']) {
      const r = await apiRun({ provider: typo, model: 'llama3', agentId: 'agent', messages: [{ role: 'user', content: 'hi' }] });
      A.eq(r.status, 400, '/api/run with provider ' + JSON.stringify(typo) + ' is refused (400), never run on openrouter');
      A.eq(r.text, 'provider "' + typo + '" is not a provider this station knows', '...and says which provider: ' + r.text);
    }
    for (const known of ['openrouter', 'OpenRouter', ' codex ', 'openai-codex', '', undefined]) {
      const r = await apiRun({ provider: known, model: 'llama3', agentId: 'agent', messages: [] });
      A.ok(r.status === 409 && r.text.indexOf(PAST) >= 0, '/api/run with provider ' + JSON.stringify(known) + ' passes the provider check: ' + r.status + ' ' + r.text);
    }
  }

  A.report('run-wire.v1: /v1 refuses a pair it cannot run, and runs the selected agent\'s effort');
})().catch(e => { A.ok(false, 'run-wire.v1 threw: ' + ((e && e.stack) || e)); A.report('run-wire.v1'); });
