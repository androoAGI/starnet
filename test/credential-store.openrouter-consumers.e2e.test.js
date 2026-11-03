/* node test/credential-store.openrouter-consumers.e2e.test.js — doneMeans 2 (credential-store lane, step S6; family B1,
   credential sources; gh#146, gh#89): one OpenRouter credential feeds every station-side consumer, and it is sent only to the
   endpoint saved with it.

   THE BUG. Each consumer read whichever source its own code named. STT read only the legacy runtimeKey alias, so a key a
   browser page saved left /api/stt/status at cloud:false (probe P2) and a voice note with no page header had no OpenRouter
   leg. web_search's paid rung armed only on the run's own OpenRouter key or the alias, so a page key or a bare
   OPENROUTER_API_KEY never reached it, and on a run on another provider it sent that run's model id to OpenRouter. It armed on
   StarNet-credits runs too, spending a BYOK key on a run the image route keeps off every BYOK key. And STT, TTS and the rung
   dialed https://openrouter.ai whatever endpoint the key was saved with, so a key kept for a proxy left for the public host.

   THE FIX. credentialFor('openrouter') is the one credential (sidecar/credential-store.js CONSUMERS): the key, the endpoint
   saved with it and its rank. A run on OpenRouter uses its own key and endpoint; any other BYOK run takes the station's; a
   credits run never arms the rung (decision 2). Rank (decision 1) keeps billing where it was: a 'gap' credential, a key a page
   saved or a bare env key, comes last in the image route and after the local engine in the STT ladder, and never changes
   /api/stt/status.preferred.

   REAL sidecars, booted through test/helpers/outbound-edge.js, a preload that passes loopback and answers everything else 503
   on record, and a recording upstream at one path per endpoint. NEVER RUN THIS WITHOUT THE PRELOAD: the voice legs and the
   rung would reach the real openrouter.ai, Mojeek and DuckDuckGo. This file sets it, and stops if the edge did not come up.
   The keyless engines get 503 there and SKYNET_WEB_READER=0, so web_search reaches its OpenRouter rung; the Edge voice is off
   (SKYNET_EDGE_TTS=0) and so is the local engine (STARNET_LOCAL_VOICE=0), so /api/tts and /api/stt reach the keyed leg.

   Rows:
     1. THREE SOURCES, one credential {K, U}: a browser page saves it; a desktop's keychain holds it (the shell's spawn pair and
        its pushed endpoint); a headless operator sets OPENROUTER_API_KEY and OPENROUTER_BASE. For each: /api/stt/status says
        cloud:true; a CUSTOM run's web_search reaches the rung at U with Bearer K and OpenRouter's search model; image_generate
        on a station with no other image route reaches U; /api/stt with no page header reaches U; /api/tts with no page key
        reaches U/audio/speech.
     2. A run ON OpenRouter arms the rung with its own key, endpoint and model.
     3. CREDITS: a desktop with a keychain OpenRouter key and a linked StarNet account: a credits run's web_search tries the
        free engines and never arms the station's key.
     4. GUARDS (decision 1): a page-saved key leaves /api/stt/status.preferred as it was, and does not displace a station
        OpenAI image route (image-task.e2e keeps its rows too). A TTS leg that dials a public host is answered at the edge: the
        row that proves the edge sees the voice legs' own dispatcher, which is the RED below.
     5. LIVE VOICE (decision 6), through its real routes: an OpenAI key saved with a gateway reads composed, says why, is refused
        and never reaches the fixed realtime URL; a key saved with the default endpoint still opens natively.
     6. NO REQUEST carrying a key went anywhere but its own endpoint: at the upstream, and at the edge.
     7. IN FLIGHT (review r1): a CUSTOM run on its own body key, its first tooled turn held at the model while the page REMOVEs or
        rotates its OpenRouter copy: web_search's paid rung and image_generate send neither the removed nor the rotated-away key
        and say why; the run goes on, and the next run's rung sends the new key (RED at bfca6be28: both tools sent the removed key,
        and the rotation's rung the old one).

   RED at trunk a3af8dafd, run with this file and the preload copied into a scratch checkout: the first failure is the page
   row's /api/stt/status (cloud:false, probe P2), then no page or bare-env key arms the rung, so U sees no web-plugin call; TTS
   sends K to openrouter.ai, recorded at the edge instead of U; STT and the rung send the desktop's K there too; the credits
   run arms the alias; and Live Voice reads native and posts the gateway's key to api.openai.com. The image rows pass at trunk
   (its #146 second rung) and are guards, as is `preferred`. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const EC = require('../sidecar/engine-credential.js');
const Reg = require('../sidecar/providers/registry.js');

const EDGE = path.join(__dirname, 'helpers', 'outbound-edge.js');
const IPC = 'credential-store-consumers-ipc-0123456789abcdef';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const K = {
  page: 'sk-or-v1-PAGE-copy-key-0123456789abcdefghijklmnop',
  keychain: 'sk-or-v1-KEYCHAIN-key-0123456789abcdefghijklmno',
  env: 'sk-or-v1-OPERATOR-ENV-key-0123456789abcdefghijkl',
  run: 'sk-or-v1-RUN-OWN-key-0123456789abcdefghijklmnopq',
  credits: 'sk-or-v1-KEYCHAIN-BESIDE-CREDITS-0123456789abcd',
  guard: 'sk-or-v1-PAGE-BESIDE-OPENAI-0123456789abcdefghij',
  model: 'custom-MODEL-key-0123456789abcdefghijklmnopqrs',
  openai: 'sk-proj-PAGE-OPENAI-key-0123456789abcdefghijklm',
  device: 'starnet-device-token-0123456789abcdefghijklmnop',
  flight: 'sk-or-v1-PAGE-key-REMOVED-MID-RUN-0123456789abcd',
  flight2: 'sk-or-v1-PAGE-key-ROTATED-IN-MID-RUN-0123456789a'
};
// where each key may go: the path of the endpoint it was saved with
const HOME = { [K.page]: '/page/', [K.keychain]: '/keychain/', [K.env]: '/env/', [K.run]: '/run/', [K.credits]: '/credits/', [K.guard]: '/guard/', [K.model]: '/model/',
  [K.openai]: '/openai/', [K.device]: '/cloud/', [K.flight]: '/inflight/', [K.flight2]: '/inflight/' };
// section 7 (in flight): a run whose prompt carries a held marker has its first tooled turn wait at the model until the test opens it
const gates = new Map();
const hold = marker => { let open; gates.set(marker, new Promise(r => { open = r; })); return open; };
const WEB_HIT = 'https://example.test/found-by-the-openrouter-rung';
const SPOKEN = Buffer.alloc(480, 1);

function sse(res, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0 } }) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const json = (res, value, status) => { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
// a model's turn: the tool its prompt names, then a sentence once the tool has answered
function modelTurn(res, body) {
  const said = JSON.stringify(body.messages || []);
  if ((body.messages || []).some(m => m && m.role === 'tool')) return sse(res, { content: 'The tool has answered.' }, 'stop');
  const call = (name, args) => sse(res, { tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
  const answer = () => {
    if (said.includes('SEARCH-THE-WEB')) return call('web_search', { query: 'where the station credential goes' });
    if (said.includes('an image of a blue cube')) return call('image_generate', { prompt: 'a blue cube' });
    return sse(res, { content: 'Nothing to do.' }, 'stop');
  };
  const held = [...gates.keys()].find(m => said.includes(m));
  return (held && Array.isArray(body.tools) && body.tools.length) ? gates.get(held).then(answer) : answer();
}
function recorder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw) || {}; } catch (_) { body = {}; }
      seen.push({ path: req.url, key: String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), body });
      if (/\/models(?:\?|$)/.test(req.url)) return json(res, { data: [{ id: 'test/model', context_length: 8000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] });
      // the linked StarNet account: its balance and metering, around the same model
      if (/^\/cloud\//.test(req.url) && /\/balance/.test(req.url)) return json(res, { balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && /\/(?:debit|credit)$/.test(req.url)) return json(res, { ok: true, balanceUsd: 50 });
      if (/^\/cloud\//.test(req.url) && !/\/chat\/completions$/.test(req.url)) return json(res, { entries: [] });
      if (/\/audio\/speech$/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'audio/pcm;rate=24000;channels=1' }); return res.end(SPOKEN); }
      if (/\/images\/generations$/.test(req.url)) return json(res, { data: [{ b64_json: PNG_B64 }], usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } });
      if (!/\/chat\/completions$/.test(req.url)) { res.writeHead(404); return res.end(); }
      if (Array.isArray(body.plugins)) return json(res, { choices: [{ message: { content: '1. The rung — ' + WEB_HIT + ' — it answered', annotations: [] } }] });
      if (Array.isArray(body.modalities) && body.modalities.includes('image')) return json(res, { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG_B64 } }] } }] });
      if (raw.includes('input_audio')) return json(res, { choices: [{ message: { content: 'heard at the saved endpoint' } }] });
      modelTurn(res, body);
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: 'http://127.0.0.1:' + server.address().port })));
}

// nothing the test runner exports may stand in for a key, an endpoint or a link
const AMBIENT = ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY', 'GROQ_BASE_URL',
  'GEMINI_BASE_URL', 'GOOGLE_AI_BASE_URL', 'GROQ_BASE', 'OPENAI_BASE', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL',
  'KEY_POOL_OPENROUTER', 'DESKTOP_SHELL', 'IPC_TOKEN', 'CREDITS_URL', 'CREDITS_TOKEN', 'CLOUD_URL', 'FALLBACK_MODELS', 'DEFAULT_MODEL'];
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
function station(label, env, seed) {
  const blank = {};
  for (const n of AMBIENT) { blank[n] = ''; blank['STARNET_' + n] = ''; blank['SKYNET_' + n] = ''; }
  const prior = String(process.env.NODE_OPTIONS || '').trim();
  const fx = SidecarFixture.create({ prefix: 'cs-consumers-' + label + '-', timeoutMs: 45000, env: Object.assign(blank, {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_AUX_BUDGET: '0',
    ...pair('WEB_READER', '0'), ...pair('EDGE_TTS', '0'), ...pair('LOCAL_VOICE', '0'),
    NODE_OPTIONS: (prior ? prior + ' ' : '') + '--require=' + EDGE
  }, env) });
  const edgeFile = path.join(fx.workspace, 'outbound-edge.jsonl');
  const edge = () => { try { return fs.readFileSync(edgeFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
  return {
    fx,
    async start() {
      if (seed) seed(fx.workspace);
      await fx.start({ STARNET_TEST_EDGE_OUT: edgeFile });
      if (!edge().some(e => e.edge === 'ready')) throw new Error(label + ': the outbound edge did not come up: refusing to run a station that could reach the internet');
    },
    edge: () => edge().filter(e => e.host),
    push: body => fx.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    engineKey: body => fx.json('POST', '/api/providers/engine-key', body),
    sttStatus: () => fx.json('GET', '/api/stt/status').then(r => r.body),
    // the speech routes, with no page key: only the station's own credential can answer
    stt: () => fx.request('/api/stt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: Buffer.from('spoken words').toString('base64'), format: 'webm' }) })
      .then(r => r.json()),
    tts: body => fx.request('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, type: String(r.headers.get('content-type') || ''), bytes: Buffer.from(await r.arrayBuffer()) })),
    sdp: provider => fx.request('/api/realtime/session?provider=' + provider, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' }),
    run: body => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async r => { A.eq(r.status, 200, label + ': the run streams'); return (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); })
  };
}
const ended = events => (events.filter(e => e.name === 'agent.run.end').pop() || { payload: {} }).payload.reason;
const toolOk = (events, name) => { const r = events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'call_' + name); return r ? r.payload.ok : 'no result'; };

(async () => {
  if (!fs.existsSync(EDGE)) { A.ok(false, 'test/helpers/outbound-edge.js is missing: this file never boots a station without it'); return A.report('credential-store.openrouter-consumers.e2e'); }
  const up = await recorder();
  const stations = [];
  const boot = async s => { stations.push(s); await s.start(); return s; };
  const at = where => up.base + '/' + where + '/api/v1';
  const custom = (agentId, content, extra) => Object.assign({ provider: 'custom', baseUrl: up.base + '/model/v1', key: K.model, model: 'test/model', agentId, messages: [{ role: 'user', content }] }, extra);
  // what the model at this path was last told a tool answered
  const toolAnswer = prefix => {
    const told = up.seen.filter(r => r.path.startsWith(prefix) && (r.body.messages || []).some(m => m.role === 'tool')).pop();
    return told ? String(told.body.messages.filter(m => m.role === 'tool').pop().content) : '';
  };

  // every station-side consumer, on the station's one credential `key` saved with the endpoint at /<where>/
  async function everyConsumer(s, who, key, where) {
    const prefix = '/' + where + '/';
    const here = () => up.seen.filter(r => r.path.startsWith(prefix));
    const status = await s.sttStatus();
    A.eq(status && status.cloud, true, who + ': /api/stt/status reports cloud:true (a key a page saved read false, probe P2)');

    const web = await s.run(custom('web-' + where, 'SEARCH-THE-WEB'));
    const rung = here().filter(r => Array.isArray(r.body.plugins));
    A.eq(rung.map(r => [r.key, r.body.model, r.path]), [[key, 'openai/gpt-4o-mini', prefix + 'api/v1/chat/completions']],
      who + ': a CUSTOM run\'s web_search reaches the rung at the saved endpoint, with the saved key and OpenRouter\'s search model, never the run\'s');
    A.eq([toolOk(web, 'web_search'), ended(web)], [true, 'done'], who + ': ...and the search answers from it');
    A.ok(toolAnswer('/model/').includes(WEB_HIT), who + ': ...and the model gets the rung\'s result: ' + toolAnswer('/model/').slice(0, 160));
    A.ok(['www.mojeek.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'].every(h => s.edge().some(e => e.host === h)), who + ': the free engines were tried first, and answered 503 at the edge: the rung stays the last in its chain');

    const image = await s.run(custom('image-' + where, 'Generate an image of a blue cube', { isTask: true, placed: ['studio'] }));
    const drawn = here().filter(r => Array.isArray(r.body.modalities) && r.body.modalities.includes('image'));
    A.eq(drawn.map(r => [r.key, r.path]), [[key, prefix + 'api/v1/chat/completions']], who + ': image_generate on a station with no other image route reaches the saved endpoint with the saved key');
    A.eq([toolOk(image, 'image_generate'), ended(image)], [true, 'done'], who + ': ...and the image earns done');

    const heard = await s.stt();
    const listened = here().filter(r => JSON.stringify(r.body).includes('input_audio'));
    A.eq(listened.length > 0 && listened.every(r => r.key === key && r.path === prefix + 'api/v1/chat/completions'), true, who + ': /api/stt with no page header reaches the saved endpoint with the saved key (' + listened.length + ' calls)');
    A.eq(heard && heard.text, 'heard at the saved endpoint', who + ': ...and transcribes');

    const spoken = await s.tts({ text: 'A sentence for ' + who + ', with no page key.' });
    const said = here().filter(r => /\/audio\/speech$/.test(r.path));
    A.eq(said.map(r => [r.key, r.path]), [[key, prefix + 'api/v1/audio/speech']], who + ': /api/tts with no page key reaches U/audio/speech with the saved key');
    A.ok(/^audio\//.test(spoken.type) && spoken.bytes.length > 0, who + ': ...and the sentence is spoken (' + spoken.type + ')');

    A.eq(s.edge().filter(e => e.credentials.some(c => c.includes(key))).map(e => e.host + e.path), [], who + ': nothing carrying the saved key left for any other host');
  }

  try {
    /* ================= 1. the page's copy, and 2. a run on OpenRouter ================= */
    {
      const s = await boot(station('page', {}));
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.page, baseUrl: at('page') })).status, 200, 'page: the browser page saves the OpenRouter key with its endpoint');
      await everyConsumer(s, 'page', K.page, 'page');

      const before = up.seen.length;
      const own = await s.run({ provider: 'openrouter', baseUrl: at('run'), key: K.run, model: 'test/model', agentId: 'run-on-openrouter', messages: [{ role: 'user', content: 'SEARCH-THE-WEB' }] });
      const rung = up.seen.slice(before).filter(r => Array.isArray(r.body.plugins));
      A.eq(rung.map(r => [r.key, r.body.model, r.path]), [[K.run, 'test/model', '/run/api/v1/chat/completions']], 'a run ON OpenRouter arms the rung with its own key, endpoint and model, never the station\'s');
      A.eq(ended(own), 'done', '...and ends done');
    }

    /* ================= 1. the desktop keychain ================= */
    {
      const s = await boot(station('desktop', { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('OPENROUTER_KEY', K.keychain) }));
      const model = await s.push({ provider: 'custom', baseUrl: up.base + '/model/v1' });
      const pushed = await s.push({ provider: 'openrouter', baseUrl: at('keychain') });
      A.eq([model.status, pushed.status, pushed.body && pushed.body.credentialSource], [200, 200, 'keychain'], 'desktop: the shell hands over the endpoints; the key is the keychain\'s');
      await everyConsumer(s, 'desktop', K.keychain, 'keychain');
    }

    /* ================= 1. the headless operator's environment ================= */
    {
      const s = await boot(station('headless', { OPENROUTER_API_KEY: K.env, OPENROUTER_BASE: at('env') }));
      await everyConsumer(s, 'headless', K.env, 'env');
    }

    /* ================= 3. a StarNet-credits run never arms the station's key ================= */
    {
      const seed = ws => {
        fs.mkdirSync(path.join(ws, '.secrets'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.secrets', 'credits.json'), JSON.stringify({ url: up.base + '/cloud', deviceToken: K.device, accountId: 'acct-fixture', linkedAt: 1 }));
      };
      const s = await boot(station('credits', { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('OPENROUTER_KEY', K.credits), STARNET_CLOUD_URL: up.base + '/cloud', STARNET_CREDITS_TOKEN: K.device }, seed));
      A.eq((await s.push({ provider: 'openrouter', baseUrl: at('credits') })).status, 200, 'credits: the shell hands over the OpenRouter endpoint');
      const before = up.seen.length;
      const credits = await s.run({ provider: 'starnet', model: 'test/model', agentId: 'credits-run', messages: [{ role: 'user', content: 'SEARCH-THE-WEB' }] });
      A.ok(up.seen.slice(before).some(r => r.path.startsWith('/cloud/') && /\/chat\/completions$/.test(r.path) && r.key === K.device), 'credits: the run is on the linked account, with its device token');
      A.ok(['www.mojeek.com', 'html.duckduckgo.com', 'lite.duckduckgo.com'].every(h => s.edge().some(e => e.host === h)), 'credits: its web_search ran, and the free engines answered 503 at the edge');
      A.eq(up.seen.slice(before).filter(r => Array.isArray(r.body.plugins) || r.key === K.credits).map(r => r.path), [], 'credits: the station\'s OpenRouter key is never armed on a credits run (decision 2), at its own endpoint');
      A.eq(s.edge().filter(e => e.credentials.some(c => c.includes(K.credits))).map(e => e.host + e.path), [], 'credits: ...nor anywhere else (the alias used to arm the rung here, at openrouter.ai)');
      A.ok(/every search engine declined/.test(toolAnswer('/cloud/')), 'credits: with the free engines down the model is told so honestly, and no paid rung answered: ' + toolAnswer('/cloud/').slice(0, 160));
      A.eq(ended(credits), 'done', 'credits: ...and the run ends done');
    }

    /* ================= 4. guards: where a page-saved key must NOT reach ================= */
    {
      const s = await boot(station('guards', {}));
      const nothing = await s.sttStatus();
      A.eq((await s.engineKey({ provider: 'openrouter', key: K.guard, baseUrl: at('guard') })).status, 200, 'guards: the page saves an OpenRouter key');
      const saved = await s.sttStatus();
      A.eq([saved.preferred, saved.local, saved.native], [nothing.preferred, nothing.local, nothing.native], 'guards: a page-saved key does not change /api/stt/status.preferred (decision 1: ' + nothing.preferred + ')');
      A.eq([nothing.cloud, saved.cloud, saved.available], [false, true, true], 'guards: ...while it says what the station can do: cloud and available');

      A.eq((await s.engineKey({ provider: 'openai', key: K.openai, baseUrl: up.base + '/openai/v1' })).status, 200, 'guards: the page saves an OpenAI key too');
      const before = up.seen.length;
      const kept = await s.run(custom('image-kept', 'Generate an image of a blue cube', { isTask: true, placed: ['studio'] }));
      const fresh = up.seen.slice(before);
      A.eq(fresh.filter(r => /\/images\/generations$/.test(r.path)).map(r => [r.key, r.path]), [[K.openai, '/openai/v1/images/generations']], 'guards: the image keeps the station\'s OpenAI route (#146: a route that already rendered keeps billing where it did)');
      A.eq(fresh.filter(r => Array.isArray(r.body.modalities) && r.body.modalities.includes('image')).length, 0, 'guards: ...and the page-saved OpenRouter key is not spent');
      A.eq(ended(kept), 'done', 'guards: ...and the image earns done');

      // 5. decision 6, through the real routes: this OpenAI key was saved with another endpoint
      const voice = (await s.fx.json('GET', '/api/realtime/status?provider=openai')).body;
      A.eq([voice.mode, voice.connected, voice.available], ['composed', true, false], 'Live Voice: an OpenAI key saved with a gateway reads composed, still connected');
      A.ok(/saved with another endpoint/.test(String(voice.note)), 'Live Voice: ...and the status says why: ' + voice.note);
      const refused = await s.sdp('openai');
      A.eq(refused.status, 501, 'Live Voice: the session is refused, and composed voice serves');
      A.eq(s.edge().filter(e => e.credentials.includes('Bearer ' + K.openai)).map(e => e.host + e.path), [], 'Live Voice: ...and the key never reached the fixed realtime URL');
    }

    /* ================= 4. the edge sees the voice legs ================= */
    {
      const s = await boot(station('edge', {}));
      A.eq((await s.engineKey({ provider: 'openai', key: K.openai })).status, 200, 'edge: the page saves an OpenAI key with no endpoint of its own');
      const r = await s.tts({ text: 'A sentence for the public host.' });
      A.eq(r.status, 200, 'edge: /api/tts answers (the 200-always media contract)');
      A.eq(s.edge().filter(e => e.credentials.includes('Bearer ' + K.openai)).map(e => e.host + e.path), Array(3).fill('api.openai.com/v1/audio/speech'),
        'edge: the transient 503 uses the shared ladder\'s two bounded retries, all through the same credential-scoped voice dispatcher');
      const declined = JSON.parse(r.bytes.toString('utf8'));
      A.eq([declined.fallback, declined.retried], [true, true], 'edge: the actual response reports its failed, retried voice ladder');
      A.ok(declined.outcome.legs.some(leg => leg.engine === 'openai' && leg.code === 'upstream_unavailable' && leg.http === 503),
        'edge: the typed outcome retains the synthetic OpenAI 503, rather than claiming generated speech');

      // 5. the same key, saved with the default endpoint, is what native voice is for
      const voice = (await s.fx.json('GET', '/api/realtime/status?provider=openai')).body;
      A.eq([voice.mode, voice.connected, voice.available, 'note' in voice], ['native', true, true, false], 'Live Voice: a key saved with the default endpoint still opens natively');
      await s.sdp('openai');
      A.ok(s.edge().some(e => e.host + e.path === 'api.openai.com/v1/realtime/calls' && e.credentials.includes('Bearer ' + K.openai)), 'Live Voice: ...and the call goes to the realtime URL with that key, answered at the edge');
    }

    /* ================= 7. IN FLIGHT (review r1): the key leaves a run that is going, its tools included ================= */
    // A CUSTOM run on its own body key whose tools read the station's OpenRouter credential once, as it started. The model's first
    // tooled turn is held at the upstream while the page changes its copy; then it asks for the tool. Red at bfca6be28: web_search's
    // paid rung and image_generate each sent the removed key to its endpoint, and the run ended 'done' on it.
    {
      const s = await boot(station('inflight', {}));
      const U = at('inflight');
      const removedFor = tool => EC.credentialError({ id: 'openrouter', label: Reg.getProviderProfile('openrouter').label, kind: 'removed', what: 'this run', tool, env: 'OPENROUTER_API_KEY' });
      const waitFor = async (pred, label) => { for (let i = 0; i < 300; i++) { if (pred()) return; await new Promise(r => setTimeout(r, 100)); } A.ok(false, label + ': timed out waiting'); };
      const midRun = async (marker, content, extra, change) => {
        const open = hold(marker);
        const running = s.run(custom('inflight-' + marker.toLowerCase(), marker + ' ' + content, extra));
        await waitFor(() => up.seen.some(r => r.path.startsWith('/model/') && JSON.stringify(r.body.messages || []).includes(marker) && Array.isArray(r.body.tools) && r.body.tools.length),
          'in flight, ' + marker + ': the run\'s first tooled turn reached the model');
        const changed = await change();
        const mark = up.seen.length, edgeMark = s.edge().length;
        open();
        const events = await running;
        return { events, changed, after: up.seen.slice(mark), edgeAfter: s.edge().slice(edgeMark) };
      };
      const save = key => s.engineKey({ provider: 'openrouter', key, keyPool: [], baseUrl: U });
      const remove = () => s.engineKey({ provider: 'openrouter', key: '', keyPool: [], baseUrl: '' });
      const toolText = (events, name) => { const r = events.find(e => e.name === 'agent.tool_result' && e.payload.callId === 'call_' + name); return r ? String(r.payload.summary || '') + ' ' + String(r.payload.error || '') : ''; };

      // a. web_search's paid rung, removed mid-run
      A.eq((await save(K.flight)).status, 200, 'in flight: the page saves its OpenRouter key with its endpoint');
      const web = await midRun('INFLIGHT-WEB', 'SEARCH-THE-WEB', { isTask: true }, remove);
      A.eq(web.changed.body && web.changed.body.keySource, 'none', 'in flight, web_search: the page REMOVEs its copy while the run\'s first turn is held');
      A.eq(web.after.filter(r => r.key === K.flight).map(r => r.path), [], 'in flight, web_search: no request after the REMOVE carries the removed key (bfca6be28: the rung sent it with plugins:[web])');
      A.ok(toolAnswer('/model/').includes(removedFor('web_search')), 'in flight, web_search: the search tells the model why the paid rung was passed over: ' + toolAnswer('/model/').slice(0, 300));
      A.eq(ended(web.events), 'done', 'in flight, web_search: the run is on its own key, and goes on to done');

      // b. image_generate, removed mid-run
      A.eq((await save(K.flight)).status, 200, 'in flight: the page saves the key again');
      const image = await midRun('INFLIGHT-IMAGE', 'Generate an image of a blue cube', { isTask: true, placed: ['studio'] }, remove);
      A.eq(image.after.filter(r => r.key === K.flight).map(r => r.path), [], 'in flight, image_generate: no request after the REMOVE carries the removed key (bfca6be28: it posted modalities:[image] with it)');
      A.eq(toolOk(image.events, 'image_generate'), false, 'in flight, image_generate: the call is refused');
      A.ok(toolAnswer('/model/').includes(removedFor('the STUDIO image route')), 'in flight, image_generate: ...with the sentence: ' + toolAnswer('/model/').slice(0, 300));

      // c. a rotation: the rung sends neither the rotated-away key nor, in this run, the new one; the next run uses the new one
      A.eq((await save(K.flight)).status, 200, 'in flight: the page saves the key a third time');
      const rotated = await midRun('INFLIGHT-ROTATE', 'SEARCH-THE-WEB', { isTask: true }, () => save(K.flight2));
      A.eq(rotated.after.filter(r => r.key === K.flight || r.key === K.flight2).map(r => r.path), [], 'in flight, a rotation: the run in flight sends neither key from its rung');
      A.ok(toolAnswer('/model/').includes(removedFor('web_search')), 'in flight, a rotation: ...and says why');
      const next = await s.run(custom('inflight-after-rotation', 'SEARCH-THE-WEB', { isTask: true }));
      A.eq(up.seen.filter(r => Array.isArray(r.body.plugins) && r.key === K.flight2).map(r => r.path), [U.replace(up.base, '') + '/chat/completions'], 'in flight, a rotation: the next run\'s rung sends the new key, at the saved endpoint');
      A.eq(ended(next), 'done', '...and ends done');
      A.eq(s.edge().filter(e => e.credentials.some(c => c.includes(K.flight) || c.includes(K.flight2))).map(e => e.host + e.path), [], 'in flight: neither key went to any other host');
    }

    /* ================= 6. no request carried a key anywhere but its own endpoint ================= */
    const strays = up.seen.filter(r => r.key && HOME[r.key] && !r.path.startsWith(HOME[r.key])).map(r => r.key.slice(0, 24) + ' -> ' + r.path);
    A.eq(strays, [], 'no request carried a key to an endpoint it was not saved with (' + up.seen.length + ' requests)');
    A.ok(!up.seen.some(r => r.path.startsWith('/model/') && r.key && r.key !== K.model), 'the CUSTOM model never saw an OpenRouter key');
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + stations.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of stations) await s.fx.dispose().catch(() => {});
    up.server.closeAllConnections && up.server.closeAllConnections();
    await new Promise(r => up.server.close(r));
  }
  A.report('credential-store.openrouter-consumers.e2e');
})();
