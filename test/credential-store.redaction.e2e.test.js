/* node test/credential-store.redaction.e2e.test.js — every secret the credential store holds is redacted, the credential parts of
   its endpoint URLs included, and ordinary text is not (credential-store lane, step S5; family B1, credential sources;
   decision 8).

   THE BUG (probes P4 and providers-echo). redact()'s known-value layer (context.js) and the prompt scrub (prompt-scrub.js)
   held the desktop shell's pushed keys and pools, the OpenRouter alias and the page copy's keys, but nothing from the
   operator's environment and no endpoint at all. A provider key with no vendor prefix set in the environment
   (MISTRAL_API_KEY), a backup key in STARNET_KEY_POOL_<ID>, a CUSTOM_OPENAI_KEY, a token in the path of
   CUSTOM_OPENAI_BASE_URL or in a query, a password before an endpoint's host, and a token in the endpoint a page saved with
   its key all reached the run stream, the transcript and diagnostics raw when a model or an upstream echoed them; on the
   desktop, a key the shell handed over at spawn was not held until the shell pushed it. GET /api/providers answered each
   endpoint whole as currentBaseUrl.

   THE FIX. The provider part of index.js's held list is the store's secretValues(): every layer's keys and pools, the
   environment's included, and the credential parts of every endpoint a layer holds (urlSecretParts: a password before the
   host, a token-shaped path segment, a query value named like a credential or shaped like a token), never a whole URL.
   /api/providers masks those parts where they stand. Decision 8: the environment's key and backups of a provider that
   takes no key (CUSTOM) are held only when they look like a credential, so a local server's placeholder key stays
   ordinary text.

   REAL sidecars and one recording upstream, at a path per station. Rows:
     1. headless (no marker): keys with no recognisable prefix for Mistral, DeepSeek and Together in the environment, a
        backup key in STARNET_KEY_POOL_MISTRAL, a token-shaped CUSTOM_OPENAI_KEY, a token in the path of
        CUSTOM_OPENAI_BASE_URL, ?api_key= in DEEPSEEK_BASE_URL, a password before the host in GROQ_BASE_URL, and the
        page's Fireworks key with a token in the path of the endpoint it was saved with (POST /api/providers/engine-key,
        as a browser page saves it). The model echoes every one bare in its reply: the run stream and /api/transcript carry
        [redacted-secret] in their place. An upstream error echoing them reaches /api/diagnostics without them. GET
        /api/providers masks each credential part of currentBaseUrl where it stands and carries none of the secrets. An
        Azure-style endpoint with no credential (TOGETHER_BASE_URL ...?api-version=2024-02-01) reads as set, there and
        in the stream.
     2. desktop (the shell's marker, its IPC token, its spawn pair for Together, which the store adopts into the
        keychain layer at boot): echoed before any push, the key is redacted.
     3. placeholders (decision 8): CUSTOM_OPENAI_KEY=lm-studio and STARNET_KEY_POOL_CUSTOM=anything. A routine's prompt,
        the workspace file its fs_read call returns and the model's reply all say "lm-studio" and "anything": the
        upstream receives the prompt and the tool result with both words, and Run Now's stream carries the reply intact.
   RED at a3af8dafd: rows 1 and 2 (each env value, the endpoint parts, the page endpoint's token and the adopted key raw
   in the stream, the transcript and diagnostics; currentBaseUrl whole). The page key, the Azure URL and row 3 pass there
   and are the guards: what was held stays held, and what is ordinary text stays text. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const IPC = 'credential-store-redaction-ipc-0123456789abcdef';
// every secret is bare text with no vendor prefix, so only the known-value layer can hide it
const S = {
  mistral: 'Qm9wZ3JhbW1pbmdJc0Z1bjEyMzQ1Njc4OTBhYmNkZWY',            // MISTRAL_API_KEY
  deepseek: 'dsOperatorEnvKey7f3a9c1e5b2d8f4a6c0e9b3dQ',            // DEEPSEEK_API_KEY
  together: 'togetherOperatorEnvKey4e8b2c6a0d9f1e3b5c7a',           // TOGETHER_API_KEY
  mistralPool: 'mistralPoolEntry0c4e8a2f6b1d9e3a7c5f0b8dZ',        // STARNET_KEY_POOL_MISTRAL
  customKey: 'operatorCustomKeyShapeless9876543210ZYXWVU',         // CUSTOM_OPENAI_KEY, shaped like a token
  pathToken: 'pathtok7f3a9c1e5b2d8f4a6c0e9b3d7f1a5c8e2b',          // in CUSTOM_OPENAI_BASE_URL's path
  queryToken: 'qtokA1b2C3d4E5f6G7h8I9j0K1l2M3n4',                  // DEEPSEEK_BASE_URL ?api_key=
  password: 'pw9Z8y7X6w5V4u3T2s1R0qPassWord',                      // GROQ_BASE_URL, before the host
  pageKey: 'pageFireworksKey5d1b7e3a9c0f2468ace13579',              // the page's Fireworks key
  pagePath: 'pagePathTok0a2c4e6g8i1k3m5o7q9s2u4w6y8Z'              // in the endpoint the page saved with it
};
const SHELL = 'shellAdoptedTogetherKey0a9b8c7d6e5f4a3b2c1dX';         // row 2: the desktop shell's spawn pair
const AZURE = 'http://127.0.0.1:9/openai/deployments/gpt-4o/v1?api-version=2024-02-01';
const MODEL = 'local-model';
// two runs the upstream refuses, each echoing some of them in its error: /api/diagnostics keeps 300 characters of a message
// (diagnostics.js MSG_MAX), so each message must fit there raw for its check to mean anything. The later run is listed first.
const FAILS = { 'FAIL-URLS': ['pathToken', 'queryToken', 'password', 'pagePath', 'pageKey'], 'FAIL-KEYS': ['mistral', 'deepseek', 'together', 'mistralPool', 'customKey'] };

// ---- the recording upstream: OpenAI-compatible, one path per station ----
function recorder() {
  const seen = [];
  const usage = { prompt_tokens: 3, completion_tokens: 2 };
  const sse = (res, chunks) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunks.map(c => 'data: ' + JSON.stringify(c) + '\n\n').join('') + 'data: [DONE]\n\n');
  };
  const say = (res, text) => sse(res, [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage }]);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      seen.push({ url: req.url, body: raw });
      if (/\/models(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 8000 }] }));
      }
      if (!/\/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end(); }
      // (the later runs first: a station may quote an earlier directive back in a later run's context)
      const fail = Object.keys(FAILS).find(m => raw.includes(m));
      if (fail) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: fail + ' upstream refused the credentials ' + FAILS[fail].map(k => S[k]).join(' ') } }));
      }
      // one delta: a run's stream is redacted frame by frame
      if (raw.includes('ECHO-ROW')) return say(res, 'ECHO-ROW the model says: ' + Object.values(S).join(' | ') + ' | the readable endpoint ' + AZURE + ' done.');
      if (raw.includes('SHELL-ROW')) return say(res, 'SHELL-ROW the model says: ' + SHELL + ' done.');
      if (raw.includes('PLACEHOLDER-ROW')) {
        if (raw.includes('"role":"tool"')) return say(res, 'PLACEHOLDER-DONE point it at lm-studio, anything works with it.');
        return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_placeholder', type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: 'placeholder-notes.txt' }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }]);
      }
      return say(res, 'done');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: 'http://127.0.0.1:' + server.address().port })));
}

// nothing the test runner exports may stand in for a key, a pool or an endpoint
const AMBIENT = ['ANTHROPIC_API_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY',
  'XAI_API_KEY', 'X_AI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'PERPLEXITY_API_KEY',
  'CEREBRAS_API_KEY', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'OPENROUTER_BASE', 'ANTHROPIC_BASE_URL', 'GEMINI_BASE_URL', 'GOOGLE_AI_BASE_URL',
  'XAI_BASE_URL', 'X_AI_BASE_URL', 'GROQ_BASE_URL', 'MISTRAL_BASE_URL', 'DEEPSEEK_BASE_URL', 'TOGETHER_BASE_URL', 'FIREWORKS_BASE_URL',
  'PERPLEXITY_BASE_URL', 'CEREBRAS_BASE_URL', 'CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL', 'OLLAMA_BASE_URL', 'KEY_POOL_CUSTOM',
  'KEY_POOL_MISTRAL', 'KEY_POOL_TOGETHER', 'KEY_POOL_OPENROUTER', 'DESKTOP_SHELL', 'IPC_TOKEN', 'CREDITS_URL', 'CREDITS_TOKEN', 'FALLBACK_MODELS', 'DEFAULT_MODEL'];
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
function station(label, env) {
  const blank = {};
  for (const n of AMBIENT) { blank[n] = ''; blank['STARNET_' + n] = ''; blank['SKYNET_' + n] = ''; }
  const fx = SidecarFixture.create({ prefix: 'cs-redaction-' + label + '-', timeoutMs: 45000, env: Object.assign(blank, {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0'
  }, env) });
  return {
    fx,
    run: body => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }))
  };
}
const events = text => String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
const endOf = text => (events(text).filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
// the named secrets a text carries raw
const rawIn = (text, secrets) => Object.entries(secrets).filter(([, v]) => String(text).includes(v)).map(([k]) => k);

(async () => {
  const up = await recorder();
  const stations = [];
  try {
    /* ================= 1. headless: every layer's secrets, and the endpoints' credential parts ================= */
    {
      const env = {
        MISTRAL_API_KEY: S.mistral, DEEPSEEK_API_KEY: S.deepseek, TOGETHER_API_KEY: S.together, STARNET_KEY_POOL_MISTRAL: S.mistralPool,
        CUSTOM_OPENAI_KEY: S.customKey, CUSTOM_OPENAI_BASE_URL: up.base + '/t/' + S.pathToken + '/v1',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1?api_key=' + S.queryToken, GROQ_BASE_URL: 'http://operator:' + S.password + '@127.0.0.1:9/v1',
        TOGETHER_BASE_URL: AZURE
      };
      const s = station('headless', env);
      stations.push(s);
      await s.fx.start();
      const saved = await s.fx.json('POST', '/api/providers/engine-key', { provider: 'fireworks', key: S.pageKey, keyPool: [], baseUrl: 'http://127.0.0.1:9/p/' + S.pagePath + '/v1' });
      A.eq(saved.status, 200, 'headless: the page saves its Fireworks key with the endpoint it goes with');

      const r = await s.run({ provider: 'custom', model: MODEL, agentId: 'echo', streamId: 'cs-redaction-echo', messages: [{ role: 'user', content: 'ECHO-ROW say it' }] });
      A.eq([r.status, endOf(r.text).reason], [200, 'done'], 'headless: the CUSTOM run, at the endpoint with a token in its path, completes');
      A.ok(r.text.includes('ECHO-ROW the model says'), 'headless: the model\'s echo reached the run stream (the checks below are not vacuous)');
      A.eq(rawIn(r.text, S), [], 'headless: no env key, env pool entry, endpoint credential part, page key or page endpoint token appears raw in the run stream');
      A.ok(r.text.includes('[redacted-secret]'), 'headless: the stream carries [redacted-secret] in their place');
      A.ok(r.text.includes(AZURE), 'headless: an endpoint with no credential in it (?api-version=2024-02-01) stays readable in the stream');

      const tr = await s.fx.request('/api/transcript?agent=echo&stream=cs-redaction-echo');
      const trText = await tr.text();
      A.ok(tr.status === 200 && trText.includes('ECHO-ROW the model says'), 'headless: /api/transcript holds the run (the check below is not vacuous)');
      A.eq(rawIn(trText, S), [], 'headless: the persisted transcript carries none of them');

      for (const marker of ['FAIL-KEYS', 'FAIL-URLS']) {
        const f = await s.run({ provider: 'custom', model: MODEL, agentId: 'echo', streamId: 'cs-redaction-' + marker.toLowerCase(), messages: [{ role: 'user', content: marker + ' say it' }] });
        A.eq(endOf(f.text).reason, 'error', 'headless: ' + marker + ': the run whose upstream refuses it ends error');
        A.eq(rawIn(f.text, S), [], 'headless: ' + marker + ': the run error in the stream carries none of what the upstream echoed');
      }
      const diag = await s.fx.json('GET', '/api/diagnostics');
      A.ok(diag.status === 200 && diag.text.includes('FAIL-KEYS upstream refused the credentials') && diag.text.includes('FAIL-URLS upstream refused the credentials'),
        'headless: /api/diagnostics holds both run errors (the check below is not vacuous)');
      A.eq(rawIn(diag.text, S), [], 'headless: /api/diagnostics carries none of them');

      const prov = await s.fx.json('GET', '/api/providers');
      const cur = Object.fromEntries(((prov.body && prov.body.providers) || []).map(p => [p.id, p.currentBaseUrl]));
      A.eq([cur.custom, cur.deepseek, cur.groq, cur.fireworks], [up.base + '/t/[redacted-secret]/v1', 'http://127.0.0.1:9/v1?api_key=[redacted-secret]',
        'http://operator:[redacted-secret]@127.0.0.1:9/v1', 'http://127.0.0.1:9/p/[redacted-secret]/v1'],
      'headless: GET /api/providers masks each endpoint\'s credential part where it stands: a path token, ?api_key=, a password before the host, the page endpoint\'s token');
      A.eq(cur.together, AZURE, 'headless: ...and answers an endpoint with no credential in it as set');
      A.eq(rawIn(prov.text, S), [], 'headless: GET /api/providers carries none of the secrets');
    }

    /* ================= 2. desktop: the shell's spawn key, adopted at boot ================= */
    {
      const s = station('desktop', Object.assign({ STARNET_DESKTOP_SHELL: '1', CUSTOM_OPENAI_BASE_URL: up.base + '/dk/v1' }, pair('IPC_TOKEN', IPC), pair('TOGETHER_API_KEY', SHELL)));
      stations.push(s);
      await s.fx.start();
      const r = await s.run({ provider: 'custom', model: MODEL, agentId: 'echo', streamId: 'cs-redaction-shell', messages: [{ role: 'user', content: 'SHELL-ROW say it' }] });
      A.eq([r.status, endOf(r.text).reason], [200, 'done'], 'desktop: the keyless CUSTOM run completes');
      A.ok(r.text.includes('SHELL-ROW the model says'), 'desktop: the model\'s echo reached the run stream (the check below is not vacuous)');
      A.ok(!r.text.includes(SHELL) && r.text.includes('[redacted-secret]'), 'desktop: the key the shell handed over at spawn is redacted before any push');
      const tr = await s.fx.request('/api/transcript?agent=echo&stream=cs-redaction-shell');
      const trText = await tr.text();
      A.ok(trText.includes('SHELL-ROW the model says') && !trText.includes(SHELL), 'desktop: ...and in the persisted transcript');
    }

    /* ================= 3. placeholders (decision 8): ordinary text stays text ================= */
    {
      const s = station('placeholder', { CUSTOM_OPENAI_KEY: 'lm-studio', STARNET_KEY_POOL_CUSTOM: 'anything', CUSTOM_OPENAI_BASE_URL: up.base + '/pl/v1' });
      stations.push(s);
      await s.fx.start();
      await s.fx.json('POST', '/api/cron/arm', { enabled: false });
      A.eq((await s.fx.json('POST', '/api/roster', { agents: [{ agentId: 'plc', name: 'plc', system: 'x', provider: 'custom', model: MODEL }], updatedAt: Date.now() })).status, 200, 'placeholder: roster saved');
      fs.mkdirSync(path.join(s.fx.workspace, 'plc'), { recursive: true });
      fs.writeFileSync(path.join(s.fx.workspace, 'plc', 'placeholder-notes.txt'), 'NOTES the local server takes lm-studio as its key; anything works.\n');
      const made = await s.fx.json('POST', '/api/cron', { name: 'placeholder', prompt: 'PLACEHOLDER-ROW the key is lm-studio and anything goes', schedule: 'every 1h', agentId: 'plc', provider: 'custom', model: MODEL, runsLine: false });
      const id = made.body && made.body.job && made.body.job.id;
      A.ok(!!id, 'placeholder: routine created');
      const rn = await s.fx.json('POST', '/api/cron/run', { id });
      const sent = up.seen.filter(x => x.url.startsWith('/pl/') && x.body.includes('PLACEHOLDER-ROW'));
      const first = sent.find(x => !x.body.includes('"role":"tool"')), second = sent.find(x => x.body.includes('"role":"tool"'));
      A.ok(!!first && first.body.includes('PLACEHOLDER-ROW the key is lm-studio and anything goes'), 'placeholder: the routine\'s prompt reaches the upstream with "lm-studio" and "anything" intact');
      A.ok(!!second && second.body.includes('NOTES the local server takes lm-studio as its key; anything works.'), 'placeholder: the fs_read tool result reaches the upstream with both words intact');
      A.ok(rn.status === 200 && rn.text.includes('PLACEHOLDER-DONE point it at lm-studio, anything works with it.'), 'placeholder: Run Now\'s stream carries the model\'s reply intact');
      A.eq(sent.filter(x => x.body.includes('[redacted-secret]')).length + (rn.text.includes('[redacted-secret]') ? 1 : 0), 0, 'placeholder: nothing on this station is cut out of any text');
      A.eq(endOf(rn.text).reason, 'done', 'placeholder: ...and the run ends done');
    }
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + stations.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of stations) await s.fx.dispose().catch(() => {});
    up.server.closeAllConnections && up.server.closeAllConnections();
    await new Promise(r => up.server.close(r));
  }
  A.report('credential-store.redaction.e2e');
})();
