/* node test/credential-store.remove-rotate.e2e.test.js — doneMeans 1: a provider key removed or rotated in Settings leaves
   every consumer at once (credential-store lane, step S2; family B1, credential sources).

   THE BUG (probe-remove-desktop, probe R5). The desktop shell starts the sidecar with the OS keychain's provider keys in its
   environment, each in both spellings (src-tauri main.rs sidecar_command, set_sidecar_branded_env). A removal in Settings
   deletes the keychain entry and pushes { provider, key: '' } to POST /api/key; the push emptied the sidecar's keychain
   layer, but the environment copy kept serving the removed key: the push answered configured:true, GET /api/providers
   kept the provider configured, Run Now answered 200 and the upstream received the removed key. A rotation left the old
   key in the environment too, a cleared key pool came back from it, and a bare OS export of the same provider
   (ANTHROPIC_API_KEY set for another tool) outranked the Settings key because the env layer reads the bare name first.

   THE FIX. Under the shell's marker (STARNET_DESKTOP_SHELL=1) index.js adopts each pair the shell wrote into the credential
   store's keychain layer and deletes both spellings from process.env before anything else loads (credential-store.js
   adoptSpawnCredentials), so the store is the key's only holder and the push changes it everywhere. A user's own export
   (one spelling, two values, a bare name) stays in the env layer; without the marker nothing is adopted.

   A REAL sidecar, booted the way the shell boots it (the marker, the IPC token, every key and pool in both spellings), a
   recording upstream for Anthropic, OpenRouter, CUSTOM and Mistral, and the shell's own pushes (POST /api/key with the IPC
   token, the body harness.js setKey sends through harness_store_provider_key). test/helpers/env-probe.js, preloaded through
   NODE_OPTIONS, reports which of the sidecar's own environment variables hold a key (by digest, never a value). Rows:
     1. desktop: every routine runs on the shell's key; the REMOVE push answers configured:false and /api/providers agrees
        at once; Run Now, the scheduled fire, /v1 and the Telegram connect gate refuse with their credential refusal before
        any upstream request; no request after the REMOVE carries the removed key; process.env holds neither spelling. A
        rotation makes Run Now, /v1 and the scheduled fire send the new key, and no request or variable carries the old
        one. A CUSTOM REMOVE keeps the keyless endpoint and never sends the removed key. A cleared key pool stays cleared.
        A single-spelling export stays in the env layer, survives its REMOVE, and the answer and the log name it.
     2. desktop + a bare OS export (D1, decision 4): before any push the routine sends the keychain key; after the REMOVE
        the export serves, the answer and /api/providers say credentialSource 'environment' with envName, the log names it,
        and the keychain key is never sent again.
     3. browser and headless (no marker): the branded pair stays in the environment and keeps serving; a page REMOVE
        refuses the routine and the page key is never sent again; a page REMOVE beside the env key leaves keySource
        'environment'; /api/key takes no push without the shell's token. And doneMeans 1 as it reads, on a browser: the
        Anthropic key is the page's alone, and its REMOVE reaches /api/providers, Run Now and the scheduled fire at once.
     4. IN FLIGHT (step S3, decision 7): a run already going when its key is removed or replaced. The upstream holds the
        run's first turn until the test has made the change, then asks for a tool; the run's next call is its second turn.
        a. browser: a page-key CUSTOM routine, Run Now, the page REMOVEs its copy: turn 2 never goes out and the run ends
           'error' with the in-flight sentence (red at a3af8dafd: turn 2 carried the removed key)
        b. desktop: a keychain CUSTOM routine and the shell's REMOVE push: the same
        c. desktop: the shell ROTATES the OpenRouter key mid-run: the run ends with the sentence, and the next scheduled fire
           sends the new key
        d. browser: the page's own /api/run sends its key in the body, and the page REMOVEs its copy mid-run: a key the
           caller sent is its own, so turn 2 goes out on it and the run ends done
        e. desktop (review r1): a second turn on the same conversation, posted while the first is held, waits in runOnce's
           one-turn-at-a-time queue with the key handleRun resolved for it; the shell's REMOVE lands while both wait. The first
           stops at its next call, and the queued turn is stopped before its first call, catalog read included (RED at
           0c9c1583f: no layer held its key when its run started, so it was never watched and ran to done on the removed key)
        No request after a change carries the removed or replaced key, and the stopped run sends no post-run pass on it. */
'use strict';
const A = require('./_assert.js');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Reg = require('../sidecar/providers/registry.js');
const EC = require('../sidecar/engine-credential.js');

const PROBE = path.join(__dirname, 'helpers', 'env-probe.js');
const IPC = 'credential-store-remove-rotate-ipc-0123456789abcdef';
const V1 = 'credential-store-remove-rotate-v1-bearer-0123456789';
const K = {
  ant: 'sk-ant-api03-SHELL-SPAWN-anthropic-0123456789abcdefABCDEF',
  or: 'sk-or-v1-SHELL-SPAWN-openrouter-0123456789abcdef0123456789',
  or2: 'sk-or-v1-ROTATED-openrouter-0123456789abcdef0123456789ab',
  cu: 'custom-SHELL-SPAWN-key-0123456789abcdefghij',
  mis: 'mistral-USER-EXPORT-one-spelling-0123456789',
  pool: 'sk-ant-api03-POOL-one-0123456789abcdefABC,sk-ant-api03-POOL-two-0123456789abcdefABC',
  kc: 'sk-ant-api03-KEYCHAIN-d1-0123456789abcdefABCDEF',
  os: 'sk-ant-api03-OS-EXPORT-d1-0123456789abcdefABCDEF',
  h: 'sk-ant-api03-HEADLESS-both-spellings-0123456789abcd',
  pg: 'sk-or-v1-PAGE-COPY-openrouter-0123456789abcdef012345',
  pga: 'sk-ant-api03-PAGE-COPY-anthropic-0123456789abcdefAB',
  pgAlone: 'sk-ant-api03-PAGE-KEY-ALONE-0123456789abcdefABCDEF',
  // the in-flight rows (section 4)
  ifPage: 'custom-INFLIGHT-page-copy-0123456789abcdefghij',
  ifKc: 'custom-INFLIGHT-keychain-0123456789abcdefghijk',
  ifOr: 'sk-or-v1-INFLIGHT-keychain-openrouter-0123456789abcd',
  ifOr2: 'sk-or-v1-INFLIGHT-ROTATED-openrouter-0123456789abcd',
  ifBody: 'sk-or-v1-INFLIGHT-page-body-key-0123456789abcdef01',
  ifQ: 'sk-or-v1-INFLIGHT-QUEUED-keychain-0123456789abcdef'
};
const sha = v => crypto.createHash('sha256').update(String(v).trim(), 'utf8').digest('hex');
const MODELS = { anthropic: 'claude-test', openrouter: 'test/model', custom: 'local-model', mistral: 'mistral-test' };
const AGENTS = { ant: 'anthropic', orr: 'openrouter', cus: 'custom', mis: 'mistral' };
const sentence = (id, what, kind) => {
  const p = Reg.getProviderProfile(id);
  return EC.credentialError({ id, label: p.label, kind: kind || 'key', what, env: p.keyEnv.find(n => /_API_KEY$/.test(n)) || p.keyEnv[0] });
};
// a run in flight whose key went: engine-credential.js credentialError kind 'removed' (S3)
const inFlightSentence = id => sentence(id, 'this run', 'removed');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the recording upstream: Anthropic's /v1/messages and every OpenAI-compatible /chat/completions ----
// In-flight rows (section 4): hold(marker) holds a run's FIRST turn — a request with tools whose prompt carries the marker and
// no tool result yet — until the test opens it, then answers with one read-only tool call; the run's next turn (the tool's
// result in its messages) is answered with text.
const runTurn = (body, marker) => body.includes(marker) && body.includes('"tools":[');
const toolTurn = body => body.includes('"role":"tool"');
function recorder() {
  const seen = [];
  const gates = new Map();
  const sse = (res, chunks) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const auth = String(req.headers.authorization || '');
      seen.push({ url: req.url, key: String(req.headers['x-api-key'] || '') || auth.replace(/^Bearer\s+/i, ''), body: raw });
      const held = [...gates.keys()].find(m => runTurn(raw, m));
      if (held && /\/chat\/completions/.test(req.url)) {
        const usage = { prompt_tokens: 3, completion_tokens: 2 };
        if (toolTurn(raw)) return sse(res, [{ choices: [{ delta: { content: 'turn two ran' }, finish_reason: 'stop' }], usage }]);
        let tools = [];
        try { tools = (JSON.parse(raw).tools || []).map(t => (t && t.function && t.function.name) || ''); } catch (_) {}
        const name = ['notebook_read', 'routine_list', 'skill_list', 'station_inspect'].find(n => tools.includes(n)) || tools[0] || 'notebook_read';
        return gates.get(held).opened.then(() => sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_inflight', type: 'function', function: { name, arguments: '{}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }]));
      }
      if (/\/models(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: Object.values(MODELS).map(id => ({ id, type: 'model', context_length: 8000 })) }));
      }
      if (/\/messages(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"routine ran"}}\n\n' +
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
      }
      if (/\/chat\/completions/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'routine ran' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
      }
      res.writeHead(404); res.end();
    });
  });
  // hold(marker) -> open(): the first turn of the run whose prompt carries `marker` waits until open() is called
  const hold = marker => { let open; const opened = new Promise(r => { open = r; }); gates.set(marker, { opened }); return open; };
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, hold, base: 'http://127.0.0.1:' + server.address().port })));
}

// what set_sidecar_branded_env writes: the SKYNET_ name and its STARNET_ spelling, one value
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
// nothing the test runner exports may stand in for a key or an endpoint
const AMBIENT = ['ANTHROPIC_API_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'MISTRAL_API_KEY', 'OPENAI_API_KEY',
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENROUTER_BASE', 'MISTRAL_BASE_URL', 'CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL',
  'KEY_POOL_ANTHROPIC', 'KEY_POOL_OPENROUTER', 'KEY_POOL_CUSTOM', 'DESKTOP_SHELL', 'IPC_TOKEN', 'API_KEY', 'V1_KEY', 'DEFAULT_MODEL'];
function blank() {
  const env = {};
  for (const n of AMBIENT) { env[n] = ''; env['STARNET_' + n] = ''; env['SKYNET_' + n] = ''; }
  return env;
}

function station(label, up, env) {
  const probeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-env-probe-'));   // holds env.json only; removed in finally
  const probeFile = path.join(probeDir, 'env.json');
  const prior = String(process.env.NODE_OPTIONS || '').trim();
  const fx = SidecarFixture.create({ prefix: 'cs-remove-rotate-' + label + '-', timeoutMs: 45000, env: Object.assign(blank(), {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    STARNET_CRON_TICK_MS: '400', SKYNET_CRON_TICK_MS: '400',
    STARNET_TELEGRAM_API_BASE: 'http://127.0.0.1:9', SKYNET_TELEGRAM_API_BASE: 'http://127.0.0.1:9',
    ANTHROPIC_BASE_URL: up.base + '/v1', STARNET_OPENROUTER_BASE: up.base + '/api/v1', MISTRAL_BASE_URL: up.base + '/v1',
    NODE_OPTIONS: (prior ? prior + ' ' : '') + '--require=' + PROBE,
    STARNET_TEST_ENV_PROBE_OUT: probeFile, STARNET_TEST_ENV_PROBE_SHA256: Object.values(K).concat(K.pool.split(',')).map(sha).join(',')
  }, env) });
  // the scheduler is armed before boot, so a routine due in a second really fires
  fs.writeFileSync(path.join(fx.workspace, 'cron.armed.json'), JSON.stringify({ version: 1, armed: true }));
  const api = {
    fx, up, probeDir,
    push: body => fx.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    providers: async () => { const r = await fx.json('GET', '/api/providers'); const m = {}; for (const p of (r.body.providers || [])) m[p.id] = p; return m; },
    engineKey: body => fx.json('POST', '/api/providers/engine-key', body),
    runNow: id => fx.json('POST', '/api/cron/run', { id }),
    v1: model => fetch(fx.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + V1 },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'V1-' + model + ' say done' }] }) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    // which of the sidecar's own environment variables hold this value (by digest), and every branded name it has
    env: () => { try { return JSON.parse(fs.readFileSync(probeFile, 'utf8')); } catch (_) { return null; } },
    holders: v => { const e = api.env(); return e ? (e.holders[sha(v)] || []) : null; },
    routines: {},
    async setup(agents) {
      const roster = Object.keys(agents).map(id => ({ agentId: id, name: id.toUpperCase(), system: 'x', provider: agents[id], model: MODELS[agents[id]] }));
      A.eq((await fx.json('POST', '/api/roster', { agents: roster, updatedAt: Date.now() })).status, 200, label + ': roster saved');
      for (const id of Object.keys(agents)) {
        const made = await fx.json('POST', '/api/cron', { name: 'routine ' + id, prompt: 'ROUTINE-' + id.toUpperCase() + ' say done', schedule: 'every 1h',
          agentId: id, provider: agents[id], model: MODELS[agents[id]], runsLine: false });
        this.routines[id] = made.body && made.body.job && made.body.job.id;
      }
      A.ok(Object.values(this.routines).every(Boolean), label + ': routines created');
    },
    // a routine whose prompt carries `marker` (the in-flight rows hold its first turn)
    async routine(agentId, marker) {
      const made = await fx.json('POST', '/api/cron', { name: 'in flight ' + marker, prompt: marker + ' look at your notes, then say done', schedule: 'every 1h',
        agentId, provider: AGENTS[agentId], model: MODELS[AGENTS[agentId]], runsLine: false });
      const id = made.body && made.body.job && made.body.job.id;
      A.ok(!!id, label + ': routine ' + marker + ' created');
      return id;
    },
    // a routine due in a second: what the scheduler did with it — the upstream request it sent, or its blocked record
    async scheduled(agentId, marker) {
      const made = await fx.json('POST', '/api/cron', { name: 'scheduled ' + marker, prompt: marker + ' say done', schedule: 'in 1s',
        agentId, provider: AGENTS[agentId], model: MODELS[AGENTS[agentId]], runsLine: false });
      const id = made.body && made.body.job && made.body.job.id;
      for (let i = 0; i < 120; i++) {
        await sleep(250);
        const sent = up.seen.filter(s => s.body.includes(marker));
        if (sent.length) return { sent };
        const job = ((await fx.json('GET', '/api/cron')).body.jobs || []).find(j => j.id === id);
        if (job && job.lastReason === 'blocked_config') return { blocked: job };
      }
      return { timedOut: true };
    }
  };
  return api;
}
const keysSince = (up, n) => up.seen.slice(n).map(s => s.key).filter(Boolean);
const lastKeyFor = (up, marker) => { const hit = up.seen.filter(s => s.body.includes(marker)).pop(); return hit ? hit.key : '(no request)'; };
const endOf = text => (String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter(e => e && e.name === 'agent.run.end').pop() || {}).payload || {};
const errorsOf = text => String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter(e => e && e.name === 'agent.run.error').map(e => e.payload && e.payload.message);
// the run turns the upstream saw for `marker` (requests with tools: never an internal tool-free pass)
const turnsOf = (up, marker) => up.seen.filter(r => runTurn(r.body, marker));
async function waitFor(pred, label) {
  for (let i = 0; i < 240; i++) { if (pred()) return true; await sleep(250); }
  A.ok(false, label + ': timed out waiting');
  return false;
}

(async () => {
  const up = await recorder();
  const stations = [];
  try {
    /* ================= 1. desktop: the shell's keys, removed and rotated ================= */
    {
      const s = station('desktop', up, Object.assign({
        STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), STARNET_API_KEY: V1,
        ...pair('ANTHROPIC_API_KEY', K.ant), ...pair('OPENROUTER_KEY', K.or), ...pair('CUSTOM_OPENAI_KEY', K.cu), ...pair('KEY_POOL_ANTHROPIC', K.pool),
        STARNET_MISTRAL_API_KEY: K.mis    // the user's own export, in one spelling: never the shell's
      }));
      stations.push(s);
      await s.fx.start();
      // the window's hand-over at load: the CUSTOM endpoint, no key (harness.js pushDesktopEndpoints)
      A.eq((await s.push({ provider: 'custom', baseUrl: up.base + '/v1' })).status, 200, 'desktop: the CUSTOM endpoint is handed over');
      await s.setup(AGENTS);
      for (const [agent, key] of [['ant', K.ant], ['orr', K.or], ['cus', K.cu], ['mis', K.mis]]) {
        const ran = await s.runNow(s.routines[agent]);
        A.eq([ran.status, endOf(ran.text).reason], [200, 'done'], 'desktop: Run Now of ' + agent + ' runs: ' + String(ran.text).slice(-200));
        A.eq(lastKeyFor(up, 'ROUTINE-' + agent.toUpperCase()), key, 'desktop: before any push, ' + agent + '\'s routine sends the shell\'s key');
      }

      // ---- REMOVE Anthropic, as the shell does after deleting the keychain entry ----
      let mark = up.seen.length;
      const removed = await s.push({ provider: 'anthropic', key: '', baseUrl: '' });
      A.eq([removed.status, removed.body && removed.body.configured], [200, false], 'desktop: the REMOVE push answers configured:false at once: ' + JSON.stringify(removed.body));
      let prov = await s.providers();
      A.eq(prov.anthropic && prov.anthropic.configured, false, 'desktop: GET /api/providers says anthropic is not configured, at once');
      const refused = await s.runNow(s.routines.ant);
      A.eq([refused.status, refused.body && refused.body.error], [400, sentence('anthropic', 'this routine')], 'desktop: Run Now refuses with the shared credential sentence');
      const v1 = await s.v1('ant');
      A.eq([v1.status, v1.body && v1.body.error && v1.body.error.code], [503, 'provider_not_configured'], '/v1 refuses the removed provider before any run: ' + JSON.stringify(v1.body));
      const fire = await s.scheduled('ant', 'SCHED-ANT-AFTER-REMOVE');
      A.ok(!!fire.blocked && fire.blocked.lastError === sentence('anthropic', 'this scheduled routine'), 'desktop: the scheduled fire is blocked with the shared sentence: ' +
        JSON.stringify(fire.blocked ? { lastReason: fire.blocked.lastReason, lastError: fire.blocked.lastError } : fire));
      const tg = await s.fx.json('POST', '/api/channels/telegram/connect', { token: '123456:REMOVE-ROTATE-TOKEN', agentId: 'ant', provider: 'anthropic', model: MODELS.anthropic });
      A.ok(tg.status === 400 && /cannot run on this station/.test(String(tg.body && tg.body.error)), 'desktop: the Telegram connect gate refuses a bot on the removed key: ' + tg.status + ' ' + JSON.stringify(tg.body));
      A.ok(!keysSince(up, mark).includes(K.ant), 'desktop: no upstream request after the REMOVE carries the removed key (' + keysSince(up, mark).length + ' requests since)');
      A.eq(s.holders(K.ant), [], 'desktop: the sidecar\'s environment holds the removed key under no name (neither spelling)');
      A.eq([removed.body && removed.body.credentialSource, removed.body && removed.body.envName, prov.anthropic && prov.anthropic.credentialSource], ['none', null, 'none'],
        'desktop: the answer and /api/providers say no layer holds an Anthropic key');

      // ---- ROTATE OpenRouter ----
      mark = up.seen.length;
      const rotated = await s.push({ provider: 'openrouter', key: K.or2, baseUrl: '' });
      A.eq([rotated.body && rotated.body.configured, rotated.body && rotated.body.credentialSource], [true, 'keychain'], 'desktop: the rotation answers configured, from the keychain');
      const ranOr = await s.runNow(s.routines.orr);
      A.eq([ranOr.status, lastKeyFor(up, 'ROUTINE-ORR')], [200, K.or2], 'desktop: after the rotation Run Now sends the new key');
      const v1Or = await s.v1('orr');
      A.eq([v1Or.status, lastKeyFor(up, 'V1-orr')], [200, K.or2], '/v1 sends the new key: ' + JSON.stringify(v1Or.body).slice(0, 200));
      const fireOr = await s.scheduled('orr', 'SCHED-ORR-AFTER-ROTATE');
      A.ok(!!fireOr.sent && fireOr.sent.every(r => r.key === K.or2), 'desktop: the scheduled fire sends the new key: ' + JSON.stringify(fireOr.sent ? fireOr.sent.map(r => r.key === K.or2) : fireOr));
      A.ok(!keysSince(up, mark).includes(K.or), 'desktop: no request after the rotation carries the old key');
      A.eq([s.holders(K.or), s.holders(K.or2)], [[], []], 'desktop: neither the old nor the new OpenRouter key is in the sidecar\'s environment');
      // ...and its REMOVE
      mark = up.seen.length;
      const removedOr = await s.push({ provider: 'openrouter', key: '', baseUrl: '' });
      A.eq(removedOr.body && removedOr.body.configured, false, 'desktop: the OpenRouter REMOVE answers configured:false');
      A.eq((await s.providers()).openrouter.configured, false, 'desktop: /api/providers agrees');
      A.eq((await s.runNow(s.routines.orr)).status, 400, 'desktop: the OpenRouter routine is refused');
      A.ok(!keysSince(up, mark).some(k => k === K.or || k === K.or2), 'desktop: no request after it carries either OpenRouter key');

      // ---- CUSTOM REMOVE: the page sends its endpoint with the empty key; a keyless endpoint is still a pair ----
      mark = up.seen.length;
      const removedCu = await s.push({ provider: 'custom', key: '', baseUrl: up.base + '/v1' });
      A.eq([removedCu.body && removedCu.body.configured, removedCu.body && removedCu.body.credentialSource], [true, 'none'], 'desktop: CUSTOM keeps its endpoint, keyless: ' + JSON.stringify(removedCu.body));
      const ranCu = await s.runNow(s.routines.cus);
      A.eq(ranCu.status, 200, 'desktop: the CUSTOM routine runs keyless at its endpoint');
      A.ok(up.seen.slice(mark).some(r => r.body.includes('ROUTINE-CUS')) && !keysSince(up, mark).includes(K.cu), 'desktop: ...and never sends the removed CUSTOM key');
      A.eq(s.holders(K.cu), [], 'desktop: the removed CUSTOM key is in no environment variable');

      // ---- the key pool: adopted, and a cleared pool stays cleared ----
      A.eq(s.holders(K.pool), [], 'desktop: the shell\'s key pool left the environment at boot');
      const cleared = await s.push({ provider: 'anthropic', keyPool: [] });
      A.eq(cleared.body && cleared.body.alternateCount, 0, 'desktop: a pool the shell cleared answers 0 alternates (its spawn copy came back at trunk)');

      // ---- the user's own single-spelling export: the env layer's, named, and it survives a REMOVE ----
      prov = await s.providers();
      A.eq([prov.mistral.credentialSource, prov.mistral.envName], ['environment', 'STARNET_MISTRAL_API_KEY'], 'desktop: a single-spelling export is read from the environment, and named');
      A.eq([prov.custom.credentialSource, prov.anthropic.configured], ['none', false], 'desktop: /api/providers still says what the REMOVEs left');
      A.eq(s.holders(K.mis), ['STARNET_MISTRAL_API_KEY'], 'desktop: the export stays where the user put it');
      const removedMis = await s.push({ provider: 'mistral', key: '', baseUrl: '' });
      A.eq([removedMis.body && removedMis.body.configured, removedMis.body && removedMis.body.credentialSource, removedMis.body && removedMis.body.envName],
        [true, 'environment', 'STARNET_MISTRAL_API_KEY'], 'desktop: its REMOVE answers that the environment still serves, and names the variable');
      A.eq([(await s.runNow(s.routines.mis)).status, lastKeyFor(up, 'ROUTINE-MIS')], [200, K.mis], 'desktop: ...and it does');
      A.ok(/\[credentials\] the MISTRAL key was removed from this station's keychain, but the environment variable STARNET_MISTRAL_API_KEY still holds one/.test(s.fx.output()),
        'desktop: the sidecar log names the variable once');
      A.ok(/credentials: the desktop app's keychain keys for [a-z, ]*anthropic[a-z, ]* and key pools for anthropic are held in memory/.test(s.fx.output()), 'desktop: the boot log says what was adopted (provider ids only)');
      A.ok(!Object.values(K).some(k => s.fx.output().includes(k)), 'desktop: the sidecar log carries no key');
      const left = ((s.env() || {}).branded || []).filter(n => /^(?:STARNET|SKYNET)_(?:ANTHROPIC_API_KEY|OPENROUTER_KEY|CUSTOM_OPENAI_KEY|KEY_POOL_ANTHROPIC)$/.test(n));
      A.eq(left, [], 'desktop: none of the names the shell wrote is left in the environment (both spellings of each)');
    }

    /* ================= 2. desktop + a bare OS export of the same provider (D1, decision 4) ================= */
    {
      const s = station('d1', up, { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('ANTHROPIC_API_KEY', K.kc), ANTHROPIC_API_KEY: K.os });
      stations.push(s);
      await s.fx.start();
      await s.setup({ ant: 'anthropic' });
      let prov = await s.providers();
      A.eq([prov.anthropic.configured, prov.anthropic.credentialSource], [true, 'keychain'], 'D1: before any push the station reads the keychain key');
      A.eq([(await s.runNow(s.routines.ant)).status, lastKeyFor(up, 'ROUTINE-ANT')], [200, K.kc], 'D1: before any push the routine sends the keychain key, not the bare OS export');
      const mark = up.seen.length;
      const removed = await s.push({ provider: 'anthropic', key: '', baseUrl: '' });
      A.eq(removed.body && [removed.body.configured, removed.body.credentialSource, removed.body.envName], [true, 'environment', 'ANTHROPIC_API_KEY'],
        'D1: after the REMOVE the answer says the environment serves, and names the variable');
      prov = await s.providers();
      A.eq([prov.anthropic.configured, prov.anthropic.credentialSource, prov.anthropic.envName], [true, 'environment', 'ANTHROPIC_API_KEY'], 'D1: /api/providers says the same');
      A.eq([(await s.runNow(s.routines.ant)).status], [200], 'D1: the routine runs on the export');
      A.ok(keysSince(up, mark).length > 0 && keysSince(up, mark).every(k => k === K.os), 'D1: after the REMOVE only the export is sent, never the removed keychain key');
      A.ok(/\[credentials\] the ANTHROPIC key was removed from this station's keychain, but the environment variable ANTHROPIC_API_KEY still holds one/.test(s.fx.output()), 'D1: the log names the variable');
      A.eq([s.holders(K.kc), s.holders(K.os)], [[], ['ANTHROPIC_API_KEY']], 'D1: the shell\'s key left the environment at boot; the user\'s export stayed');
    }

    /* ================= 3. browser and headless: no marker ================= */
    {
      const s = station('headless', up, { ...pair('ANTHROPIC_API_KEY', K.h) });
      stations.push(s);
      await s.fx.start();
      await s.setup({ ant: 'anthropic', orr: 'openrouter' });
      A.eq(s.holders(K.h), ['SKYNET_ANTHROPIC_API_KEY', 'STARNET_ANTHROPIC_API_KEY'], 'headless: a branded pair without the marker is never adopted or deleted');
      let prov = await s.providers();
      A.eq([prov.anthropic.configured, prov.anthropic.credentialSource, prov.anthropic.envName], [true, 'environment', 'STARNET_ANTHROPIC_API_KEY'], 'headless: it is the env layer\'s, named');
      A.eq([(await s.runNow(s.routines.ant)).status, lastKeyFor(up, 'ROUTINE-ANT')], [200, K.h], 'headless: the routine runs on it');
      // the page copy, saved then REMOVED in the browser
      const saved = await s.engineKey({ provider: 'openrouter', key: K.pg, keyPool: [], baseUrl: '' });
      A.eq(saved.body && [saved.status, saved.body.keySource, saved.body.credentialSource], [200, 'station', 'page'], 'browser: the page copy is saved, and read from the page layer');
      A.eq([(await s.runNow(s.routines.orr)).status, lastKeyFor(up, 'ROUTINE-ORR')], [200, K.pg], 'browser: the routine runs on the page key');
      const mark = up.seen.length;
      const pageGone = await s.engineKey({ provider: 'openrouter', key: '', keyPool: [], baseUrl: '' });
      A.eq(pageGone.body && [pageGone.status, pageGone.body.keySource, pageGone.body.unattendedReady, pageGone.body.credentialSource], [200, 'none', false, 'none'], 'browser: the page REMOVE answers that nothing serves');
      A.eq((await s.providers()).openrouter.configured, false, 'browser: /api/providers agrees at once');
      const refused = await s.runNow(s.routines.orr);
      A.eq([refused.status, refused.body && refused.body.error], [400, sentence('openrouter', 'this routine')], 'browser: the routine is refused with the shared sentence');
      A.ok(!keysSince(up, mark).includes(K.pg), 'browser: the removed page key is never sent again');
      // a page key beside the operator's env key: the env key keeps serving, before and after the page's REMOVE
      const pageAnt = await s.engineKey({ provider: 'anthropic', key: K.pga, keyPool: [], baseUrl: '' });
      A.eq(pageAnt.body && [pageAnt.body.keySource, pageAnt.body.credentialSource], ['environment', 'environment'], 'headless: the env key outranks a page copy');
      const pageAntGone = await s.engineKey({ provider: 'anthropic', key: '', keyPool: [], baseUrl: '' });
      A.eq(pageAntGone.body && [pageAntGone.body.keySource, pageAntGone.body.credentialSource, pageAntGone.body.envName, pageAntGone.body.unattendedReady],
        ['environment', 'environment', 'STARNET_ANTHROPIC_API_KEY', true], 'headless: the branded env key survives the page REMOVE, and keySource stays environment');
      A.eq([(await s.runNow(s.routines.ant)).status, lastKeyFor(up, 'ROUTINE-ANT')], [200, K.h], 'headless: ...and keeps serving');
      A.eq((await s.push({ provider: 'anthropic', key: '' })).status, 403, 'headless: /api/key takes no push without the shell\'s token');
      A.eq(s.holders(K.h).length, 2, 'headless: the env key is still where the operator put it');
    }
    // doneMeans 1 as it reads, on a browser: the Anthropic key is the page's alone (a guard: this one worked at trunk)
    {
      const s = station('browser', up, {});
      stations.push(s);
      await s.fx.start();
      const saved = await s.engineKey({ provider: 'anthropic', key: K.pgAlone, keyPool: [], baseUrl: '' });
      A.eq(saved.body && [saved.status, saved.body.keySource, saved.body.credentialSource], [200, 'station', 'page'], 'browser: the page saves its Anthropic key');
      await s.setup({ ant: 'anthropic' });
      A.eq([(await s.runNow(s.routines.ant)).status, lastKeyFor(up, 'ROUTINE-ANT')], [200, K.pgAlone], 'browser: the routine runs on the page\'s Anthropic key');
      const mark = up.seen.length;
      const gone = await s.engineKey({ provider: 'anthropic', key: '', keyPool: [], baseUrl: '' });
      A.eq(gone.body && [gone.status, gone.body.keySource, gone.body.unattendedReady, gone.body.credentialSource], [200, 'none', false, 'none'], 'browser: the Anthropic REMOVE answers that nothing serves, at once');
      const prov = (await s.providers()).anthropic;
      A.eq([prov.configured, prov.credentialSource], [false, 'none'], 'browser: GET /api/providers says Anthropic is not configured, at once');
      const refused = await s.runNow(s.routines.ant);
      A.eq([refused.status, refused.body && refused.body.error], [400, sentence('anthropic', 'this routine')], 'browser: Run Now refuses with the shared credential sentence');
      const fire = await s.scheduled('ant', 'SCHED-PAGE-ANT-AFTER-REMOVE');
      A.ok(!!fire.blocked && fire.blocked.lastError === sentence('anthropic', 'this scheduled routine'), 'browser: the scheduled fire is blocked with the shared sentence: ' +
        JSON.stringify(fire.blocked ? { lastReason: fire.blocked.lastReason, lastError: fire.blocked.lastError } : fire));
      A.ok(!keysSince(up, mark).includes(K.pgAlone), 'browser: no upstream request after the REMOVE carries the removed Anthropic key');
    }

    /* ================= 4. in flight (S3, decision 7): the key goes while a run is going ================= */
    // starts the routine, holds its first turn at the upstream, makes the change, then lets the first turn ask for a tool
    async function midRun(s, marker, start, change) {
      const open = up.hold(marker);
      const running = start();
      await waitFor(() => turnsOf(up, marker).length >= 1, 'in flight, ' + marker + ': the run\'s first turn reached the upstream');
      const changed = await change();
      const mark = up.seen.length;
      open();
      const ran = await running;
      return { ran, changed, mark, turns: turnsOf(up, marker) };
    }
    {
      // a. browser: the page's CUSTOM copy is removed while its routine is running
      const s = station('inflight-browser', up, {});
      stations.push(s);
      await s.fx.start();
      const saved = await s.engineKey({ provider: 'custom', key: K.ifPage, keyPool: [], baseUrl: up.base + '/v1' });
      A.eq(saved.body && [saved.status, saved.body.keySource], [200, 'station'], 'in flight, browser: the page saves its CUSTOM pair');
      await s.setup({ cus: 'custom', orr: 'openrouter' });
      const id = await s.routine('cus', 'INFLIGHT-PAGE');
      const r = await midRun(s, 'INFLIGHT-PAGE', () => s.runNow(id), () => s.engineKey({ provider: 'custom', key: '', keyPool: [], baseUrl: '' }));
      A.eq(r.changed.body && [r.changed.status, r.changed.body.keySource], [200, 'none'], 'in flight, browser: the page REMOVE lands while the first turn is held');
      A.eq(r.turns.map(t => t.key === K.ifPage), [true], 'in flight, browser: turn 2 never goes out (at trunk it carried the removed page key)');
      A.eq([r.ran.status, endOf(r.ran.text).reason], [200, 'error'], 'in flight, browser: the run ends error');
      A.eq(errorsOf(r.ran.text), [inFlightSentence('custom')], 'in flight, browser: ...with the in-flight sentence: ' + JSON.stringify(errorsOf(r.ran.text)));
      A.ok(!keysSince(up, r.mark).includes(K.ifPage), 'in flight, browser: no request after the REMOVE carries the removed key, post-run passes included');

      // d. the page's own run sends its key in the body: a key its caller sent is never stopped
      const savedOr = await s.engineKey({ provider: 'openrouter', key: K.ifBody, keyPool: [], baseUrl: '' });
      A.eq(savedOr.body && [savedOr.status, savedOr.body.keySource], [200, 'station'], 'in flight, body key: the page saves its OpenRouter copy (the body key is station-held too)');
      const body = await midRun(s, 'INFLIGHT-BODY',
        () => s.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'orr', provider: 'openrouter',
          model: MODELS.openrouter, key: K.ifBody, isTask: true, messages: [{ role: 'user', content: 'INFLIGHT-BODY look at your notes, then say done' }] }) })
          .then(async res => ({ status: res.status, text: await res.text() })),
        () => s.engineKey({ provider: 'openrouter', key: '', keyPool: [], baseUrl: '' }));
      A.eq(body.changed.body && body.changed.body.keySource, 'none', 'in flight, body key: the page REMOVEs its copy mid-run');
      A.eq(body.turns.map(t => [t.key === K.ifBody, toolTurn(t.body)]), [[true, false], [true, true]], 'in flight, body key: turn 2 goes out on the key the caller sent');
      A.eq([body.ran.status, endOf(body.ran.text).reason, errorsOf(body.ran.text)], [200, 'done', []], 'in flight, body key: the run ends done, never stopped');
    }
    {
      // b, c. desktop: the shell's REMOVE and rotation reach a run that is going
      const s = station('inflight-desktop', up, { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('CUSTOM_OPENAI_KEY', K.ifKc), ...pair('OPENROUTER_KEY', K.ifOr) });
      stations.push(s);
      await s.fx.start();
      A.eq((await s.push({ provider: 'custom', baseUrl: up.base + '/v1' })).status, 200, 'in flight, desktop: the CUSTOM endpoint is handed over');
      await s.setup({ cus: 'custom', orr: 'openrouter' });
      const id = await s.routine('cus', 'INFLIGHT-KEYCHAIN');
      const r = await midRun(s, 'INFLIGHT-KEYCHAIN', () => s.runNow(id), () => s.push({ provider: 'custom', key: '', baseUrl: up.base + '/v1' }));
      A.eq(r.changed.body && [r.changed.status, r.changed.body.credentialSource], [200, 'none'], 'in flight, desktop: the shell\'s REMOVE lands while the first turn is held');
      A.eq(r.turns.map(t => t.key === K.ifKc), [true], 'in flight, desktop: turn 2 never goes out on the removed keychain key');
      A.eq([endOf(r.ran.text).reason, errorsOf(r.ran.text)], ['error', [inFlightSentence('custom')]], 'in flight, desktop: the run ends error with the in-flight sentence');
      A.ok(!keysSince(up, r.mark).includes(K.ifKc), 'in flight, desktop: no request after the REMOVE carries the removed key');

      const rid = await s.routine('orr', 'INFLIGHT-ROTATE');
      const rot = await midRun(s, 'INFLIGHT-ROTATE', () => s.runNow(rid), () => s.push({ provider: 'openrouter', key: K.ifOr2, baseUrl: '' }));
      A.eq(rot.changed.body && [rot.changed.body.configured, rot.changed.body.credentialSource], [true, 'keychain'], 'in flight, rotation: the shell rotates the OpenRouter key while the first turn is held');
      A.eq(rot.turns.map(t => t.key === K.ifOr), [true], 'in flight, rotation: turn 2 never goes out on the rotated-away key');
      A.eq([endOf(rot.ran.text).reason, errorsOf(rot.ran.text)], ['error', [inFlightSentence('openrouter')]], 'in flight, rotation: the run ends error with the in-flight sentence');
      const fire = await s.scheduled('orr', 'SCHED-AFTER-INFLIGHT-ROTATE');
      A.ok(!!fire.sent && fire.sent.length > 0 && fire.sent.every(q => q.key === K.ifOr2), 'in flight, rotation: the next scheduled fire sends the new key: ' + JSON.stringify(fire.sent ? fire.sent.map(q => q.key === K.ifOr2) : fire));
      A.ok(!keysSince(up, rot.mark).includes(K.ifOr), 'in flight, rotation: no request after the rotation carries the old key');
    }
    {
      // e. desktop: a turn queued behind another on the same conversation. handleRun resolved the keychain key when the turn was
      // posted, before the REMOVE; the turn reaches its run only after the one ahead of it ends (runOnce's one-turn-at-a-time queue)
      const s = station('inflight-queued', up, { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC) });
      stations.push(s);
      // Review r2: keep a channel version of this same key by preventing its conversion record from landing. That version
      // must not reclassify a queued station run as a bot-owned run after REMOVE. Disabled, tokenless fixture: no bot traffic.
      const channelRecordFile = path.join(s.fx.workspace, 'channels', 'secrets.json');
      fs.mkdirSync(path.dirname(channelRecordFile), { recursive: true });
      fs.writeFileSync(channelRecordFile, JSON.stringify({ telegram: { provider: 'openrouter', model: MODELS.openrouter, key: K.ifQ, enabled: false } }));
      await s.fx.start();
      // on POSIX a rename ignores the file's own mode, so its folder is read-only too
      fs.chmodSync(channelRecordFile, 0o444);
      if (process.platform !== 'win32') fs.chmodSync(path.dirname(channelRecordFile), 0o555);
      s.restoreSecrets = () => { if (process.platform !== 'win32') fs.chmodSync(path.dirname(channelRecordFile), 0o755); fs.chmodSync(channelRecordFile, 0o644); };
      const adopted = await s.push({ provider: 'openrouter', key: K.ifQ });
      A.eq(adopted.body && adopted.body.configured, true, 'queued: the station adopts the channel key as its primary');
      A.eq(JSON.parse(fs.readFileSync(channelRecordFile, 'utf8')).telegram.credential.ref, 'channel', 'queued: the failed conversion leaves the saved record naming its retained channel version');
      await s.setup({ orr: 'openrouter' });
      const post = marker => s.fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'orr', provider: 'openrouter',
        model: MODELS.openrouter, streamId: 'inflight-queued-stream', isTask: true, messages: [{ role: 'user', content: marker + ' look at your notes, then say done' }] }) })
        .then(async res => ({ status: res.status, text: await res.text() }));
      const open = up.hold('INFLIGHT-QUEUED-FIRST');
      const first = post('INFLIGHT-QUEUED-FIRST');
      await waitFor(() => turnsOf(up, 'INFLIGHT-QUEUED-FIRST').length >= 1, 'in flight, queued: the first turn reached the upstream');
      const second = post('INFLIGHT-QUEUED-SECOND');
      await sleep(1500);
      A.eq(up.seen.filter(r => r.body.includes('INFLIGHT-QUEUED-SECOND')).length, 0, 'in flight, queued: the second turn waits behind the first');
      const removed = await s.push({ provider: 'openrouter', key: '' });
      A.eq(removed.body && removed.body.configured, false, 'in flight, queued: the shell\'s REMOVE lands while both wait');
      const mark = up.seen.length;
      open();
      const [a, b] = await Promise.all([first, second]);
      A.eq([endOf(a.text).reason, errorsOf(a.text)], ['error', [inFlightSentence('openrouter')]], 'in flight, queued: the first run stops at its next call, with the in-flight sentence');
      A.eq([b.status, endOf(b.text).reason, errorsOf(b.text)], [200, 'error', [inFlightSentence('openrouter')]],
        'in flight, queued: the turn posted before the REMOVE is stopped before its first call, with the same sentence (86ff765db: it ran to done on the removed key)');
      A.eq(up.seen.slice(mark).filter(r => r.body.includes('INFLIGHT-QUEUED-SECOND')).length, 0, 'in flight, queued: it sends nothing');
      A.ok(!keysSince(up, mark).includes(K.ifQ), 'in flight, queued: no request after the REMOVE carries the removed key, a catalog read included');
    }
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + stations.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of stations) {
      try { if (s.restoreSecrets) s.restoreSecrets(); }
      catch (e) { A.ok(false, 'fixture channel permissions could not be restored: ' + e.message); }
      await s.fx.dispose().catch(() => {});
      try { fs.rmSync(s.probeDir, { recursive: true, force: true }); } catch (_) {}
    }
    up.server.closeAllConnections && up.server.closeAllConnections();
    await new Promise(r => up.server.close(r));
  }
  A.report('credential-store.remove-rotate.e2e');
})();
