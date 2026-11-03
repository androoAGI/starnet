/* node test/credential-store.pool-binding.e2e.test.js — a key pool rotates only behind its own layer's key (credential-store
   lane, step S4; family B1, credential sources; golden delta D2).

   THE BUG (probes R1 and R6). A run whose key the upstream refuses (a 401, a rate limit, a spent balance) rotates onto backup
   keys for the same provider before it falls back. At trunk those backup keys were the desktop shell's pushed pool, else the
   operator's env KEY_POOL_<ID>, for ANY run key. A routine on the browser page's CUSTOM key {K, U} that U refused went on to
   send the operator's env pool key to U, the page's endpoint (R1), and an /api/run body key on the desktop rotated onto the
   shell's keychain pool (R6). Each sends one account's key to an endpoint saved for another, and bills an account the run
   was not on.

   THE FIX. A pool rides only its own layer's key: the keychain pool the keychain key, the env KEY_POOL the env key, the page
   copy's backups the page key (credential-store.js keyPool). A key the caller sent in this request gets only a pool sent
   with it (runOnceCore). A pool whose layer holds no key is unused: the keychain pool after the shell's REMOVE, which keeps
   the slot. A refused key with no pool of its own fails over to the run's model and provider fallbacks, never to another
   layer's account.

   REAL sidecars and a recording upstream that answers 401 to the keys a row refuses and streams an answer to every other
   key, at one path per endpoint, so each request's endpoint is on record beside its key. Rows:
     1. headless (no marker; the page's copies saved through /api/providers/engine-key, as a browser page saves them):
        a. R1: the operator's STARNET_KEY_POOL_CUSTOM (no env key) beside the page's CUSTOM {K, U}; U refuses K; Run Now. U
           sees K only, and the run ends error (RED at trunk: K, then the env pool key at U, and the run ended done).
        b. the environment's own pool: MISTRAL_API_KEY, MISTRAL_BASE_URL and STARNET_KEY_POOL_MISTRAL. The env key, refused,
           rotates onto the env pool at the env endpoint, and the run ends done.
        c. the page's own pool: the page's GROQ {Kg, [Kg2], Ug}. Kg, refused, rotates onto Kg2 at Ug.
        d. a pool sent with a body key: /api/run DEEPSEEK {Kd, [Kd2], Ud}. Kd, refused, rotates onto Kd2 at Ud.
        e. a body key sent with no pool and no endpoint, beside the operator's STARNET_KEY_POOL_DEEPSEEK and DEEPSEEK_BASE_URL
           (no env key), so the run goes to the station's own endpoint for it: refused, it never rotates onto the env pool (RED
           at trunk: the env pool key went out after it, to the same endpoint). A body that names its OWN endpoint was kept off
           the station's pool at trunk already, by runOnceCore's guard (the station's pool never rotates onto an endpoint the
           caller named), which S4 keeps.
     2. desktop (the shell's marker, its IPC token and its spawn pair for OpenRouter):
        a. R6: the shell pushed the CUSTOM endpoint U6 and a pool [P1], no key; /api/run sends its own CUSTOM key Kb with a
           model fallback and an OpenRouter provider fallback; U6 refuses Kb. U6 sees Kb on the model and on its fallback
           model, never P1, and the run ends done on OpenRouter's keychain key at OpenRouter's endpoint (RED at trunk: Kb,
           then P1).
        b. the shell pushes a CUSTOM key Kc; Run Now; U6 refuses Kc. The keychain pool rides the keychain key: Kc, then P1.
        c. the shell's REMOVE (key '', the endpoint kept, as it sends it): the push answers alternateCount 1 (the slot it
           keeps), and the keyless CUSTOM routine, refused, never rotates onto P1 (RED at trunk: it did, and ended done).
   Every request any row sent carries its key only to the endpoint that key belongs with, and neither env pool beside
   another layer's key is ever sent. Rows 1a, 1e, 2a and 2c are RED at trunk (a3af8dafd; R1's is the first failure: U saw K,
   then the env pool key); 1b, 1c, 1d and 2b pass there, and are the guards the binding keeps. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const IPC = 'credential-store-pool-binding-ipc-0123456789abcdef';
const K = {
  page: 'custom-PAGE-COPY-key-K-0123456789abcdefghij',            // 1a: refused
  envPool: 'custom-OPERATOR-ENV-POOL-key-E2-0123456789abcde',     // 1a: must never be sent
  mis: 'mistral-ENV-key-0123456789abcdefghijklmnop',              // 1b: refused
  misPool: 'mistral-ENV-POOL-key-0123456789abcdefghijk',
  groq: 'gsk_PAGE-key-0123456789abcdefghijklmnopq',               // 1c: refused
  groqPool: 'gsk_PAGE-POOL-key-0123456789abcdefghijkl',
  ds: 'sk-deepseek-BODY-key-0123456789abcdefghij',                // 1d: refused
  dsPool: 'sk-deepseek-BODY-POOL-key-0123456789abcd',
  dsLone: 'sk-deepseek-BODY-NO-POOL-key-0123456789ab',            // 1e: refused
  dsEnvPool: 'sk-deepseek-OPERATOR-ENV-POOL-0123456789a',          // 1e: must never be sent
  body: 'custom-CALLER-BODY-key-Kb-0123456789abcdefg',            // 2a: refused
  kcPool: 'custom-KEYCHAIN-POOL-key-P1-0123456789abcde',          // 2a: never sent; 2b: sent after Kc
  kc: 'custom-KEYCHAIN-key-Kc-0123456789abcdefghijk',             // 2b: refused
  or: 'sk-or-v1-KEYCHAIN-openrouter-0123456789abcdef0123'         // 2a: the provider fallback
};
const REFUSED = new Set([K.page, K.mis, K.groq, K.ds, K.dsLone, K.body, K.kc, '']);
const MODELS = { custom: 'local-model', mistral: 'mistral-test', groq: 'groq-test', deepseek: 'deepseek-test', openrouter: 'test/model' };
// where each key may go: the path of the endpoint it belongs with
const HOME = { [K.page]: '/u/', [K.mis]: '/m/', [K.misPool]: '/m/', [K.groq]: '/g/', [K.groqPool]: '/g/', [K.ds]: '/d/', [K.dsPool]: '/d/',
  [K.dsLone]: '/d/', [K.body]: '/u6/', [K.kcPool]: '/u6/', [K.kc]: '/u6/', [K.or]: '/or/', '': '/u6/' };

function recorder() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (/\/models(?:\?|$)/.test(req.url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: Object.values(MODELS).concat(['local-model-2']).map(id => ({ id, context_length: 8000 })) }));
      }
      seen.push({ path: req.url, key, body: raw });
      if (!/\/chat\/completions/.test(req.url)) { res.writeHead(404); return res.end(); }
      if (REFUSED.has(key)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'invalid api key', code: 401 } }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, seen, base: 'http://127.0.0.1:' + server.address().port })));
}

// nothing the test runner exports may stand in for a key, a pool or an endpoint
const AMBIENT = ['ANTHROPIC_API_KEY', 'OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_BASE', 'MISTRAL_BASE_URL', 'GROQ_BASE_URL', 'DEEPSEEK_BASE_URL', 'CUSTOM_OPENAI_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL', 'KEY_POOL_CUSTOM', 'KEY_POOL_MISTRAL', 'KEY_POOL_GROQ', 'KEY_POOL_DEEPSEEK', 'KEY_POOL_OPENROUTER', 'DESKTOP_SHELL', 'IPC_TOKEN',
  'FALLBACK_MODELS', 'DEFAULT_MODEL'];
const pair = (name, value) => ({ ['SKYNET_' + name]: value, ['STARNET_' + name]: value });
function station(label, env) {
  const blank = {};
  for (const n of AMBIENT) { blank[n] = ''; blank['STARNET_' + n] = ''; blank['SKYNET_' + n] = ''; }
  const fx = SidecarFixture.create({ prefix: 'cs-pool-binding-' + label + '-', timeoutMs: 45000, env: Object.assign(blank, {
    STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: ''
  }, env) });
  return {
    fx,
    push: body => fx.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) })),
    engineKey: body => fx.json('POST', '/api/providers/engine-key', body),
    async routine(agentId, provider, marker) {
      const made = await fx.json('POST', '/api/cron', { name: 'pool ' + marker, prompt: marker + ' say done', schedule: 'every 1h', agentId, provider, model: MODELS[provider], runsLine: false });
      const id = made.body && made.body.job && made.body.job.id;
      A.ok(!!id, label + ': routine ' + marker + ' created');
      return id;
    },
    runNow: id => fx.json('POST', '/api/cron/run', { id }),
    run: body => fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }))
  };
}
const endOf = text => (String(text || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter(e => e && e.name === 'agent.run.end').pop() || {}).payload || {};
// the requests a run sent: [endpoint path prefix, key], in order
const sentFor = (up, marker) => up.seen.filter(s => s.body.includes(marker)).map(s => [(/^\/[a-z0-9]+\//.exec(s.path) || [s.path])[0], s.key]);
const who = v => (Object.entries(K).find(([, k]) => k === v) || [v ? 'another key' : '(no key)'])[0];
const show = list => JSON.stringify(list.map(([p, k]) => p + who(k)));

(async () => {
  const up = await recorder();
  const stations = [];
  try {
    /* ================= 1. headless: no marker ================= */
    {
      const s = station('headless', {
        STARNET_KEY_POOL_CUSTOM: K.envPool,                                                           // 1a: an env pool with no env key
        MISTRAL_API_KEY: K.mis, MISTRAL_BASE_URL: up.base + '/m/v1', STARNET_KEY_POOL_MISTRAL: K.misPool,   // 1b: the env layer's own pool
        STARNET_KEY_POOL_DEEPSEEK: K.dsEnvPool, DEEPSEEK_BASE_URL: up.base + '/d/v1'                  // 1e: an env pool beside a body key
      });
      stations.push(s);
      await s.fx.start();
      await s.fx.json('POST', '/api/cron/arm', { enabled: false });
      A.eq((await s.fx.json('POST', '/api/roster', { agents: [['cus', 'custom'], ['mis', 'mistral'], ['grq', 'groq']].map(([id, p]) => ({ agentId: id, name: id, system: 'x', provider: p, model: MODELS[p] })), updatedAt: Date.now() })).status,
        200, 'headless: roster saved');
      const savedCu = await s.engineKey({ provider: 'custom', key: K.page, keyPool: [], baseUrl: up.base + '/u/v1' });
      const savedGq = await s.engineKey({ provider: 'groq', key: K.groq, keyPool: [K.groqPool], baseUrl: up.base + '/g/v1' });
      A.eq([savedCu.status, savedGq.status], [200, 200], 'headless: the page saves its CUSTOM pair and its GROQ key with a backup');

      // a. R1
      const r1 = await s.runNow(await s.routine('cus', 'custom', 'POOL-R1'));
      A.eq(show(sentFor(up, 'POOL-R1')), show([['/u/', K.page]]), 'R1: U sees the page key only, never the operator\'s env pool key (trunk sent it to U after K was refused)');
      A.eq([r1.status, endOf(r1.text).reason], [200, 'error'], 'R1: refused, the run ends error: it has no backups of its own to rotate onto');
      // b. the env key rotates on the env pool, at the env endpoint
      const rb = await s.runNow(await s.routine('mis', 'mistral', 'POOL-ENV'));
      A.eq(show(sentFor(up, 'POOL-ENV')), show([['/m/', K.mis], ['/m/', K.misPool]]), 'env: the env key, refused, rotates onto the env KEY_POOL at the env endpoint');
      A.eq(endOf(rb.text).reason, 'done', 'env: ...and the run ends done');
      // c. the page key rotates on the page's backups, at the page endpoint
      const rc = await s.runNow(await s.routine('grq', 'groq', 'POOL-PAGE'));
      A.eq(show(sentFor(up, 'POOL-PAGE')), show([['/g/', K.groq], ['/g/', K.groqPool]]), 'page: the page key, refused, rotates onto the page\'s backups at the page endpoint');
      A.eq(endOf(rc.text).reason, 'done', 'page: ...and the run ends done');
      // d. a pool sent with a body key rotates
      const rd = await s.run({ provider: 'deepseek', model: MODELS.deepseek, key: K.ds, keyPool: [K.dsPool], baseUrl: up.base + '/d/v1', agentId: 'body', messages: [{ role: 'user', content: 'POOL-BODY say done' }] });
      A.eq(show(sentFor(up, 'POOL-BODY')), show([['/d/', K.ds], ['/d/', K.dsPool]]), 'body: a key sent with its own pool rotates onto that pool, at the endpoint it sent');
      A.eq([rd.status, endOf(rd.text).reason], [200, 'done'], 'body: ...and the run ends done');
      // e. a body key sent with no pool never rotates onto the env pool beside it, at the station's own endpoint for it
      const re = await s.run({ provider: 'deepseek', model: MODELS.deepseek, key: K.dsLone, agentId: 'body', messages: [{ role: 'user', content: 'POOL-LONE say done' }] });
      A.eq(show(sentFor(up, 'POOL-LONE')), show([['/d/', K.dsLone]]), 'body: a key sent with no pool never rotates onto the operator\'s env KEY_POOL at the station\'s endpoint (trunk sent the env pool key there after it)');
      A.eq(endOf(re.text).reason, 'error', 'body: ...refused, the run ends error');
    }

    /* ================= 2. desktop: the shell's marker ================= */
    {
      const s = station('desktop', { STARNET_DESKTOP_SHELL: '1', ...pair('IPC_TOKEN', IPC), ...pair('OPENROUTER_KEY', K.or), STARNET_OPENROUTER_BASE: up.base + '/or/api/v1' });
      stations.push(s);
      await s.fx.start();
      await s.fx.json('POST', '/api/cron/arm', { enabled: false });
      A.eq((await s.fx.json('POST', '/api/roster', { agents: [{ agentId: 'cus', name: 'cus', system: 'x', provider: 'custom', model: MODELS.custom }], updatedAt: Date.now() })).status, 200, 'desktop: roster saved');
      const endpoint = await s.push({ provider: 'custom', baseUrl: up.base + '/u6/v1' });
      const pooled = await s.push({ provider: 'custom', keyPool: [K.kcPool] });
      A.eq([endpoint.status, pooled.status, pooled.body && pooled.body.alternateCount], [200, 200, 1], 'desktop: the shell pushes the CUSTOM endpoint and a pool, with no key');

      // a. R6: a body key never rides the keychain pool; it fails over to its model and provider fallbacks
      const r6 = await s.run({ provider: 'custom', model: MODELS.custom, key: K.body, agentId: 'cus', fallbackModels: ['local-model-2'],
        fallbackProviders: [{ provider: 'openrouter', model: MODELS.openrouter }], messages: [{ role: 'user', content: 'POOL-R6 say done' }] });
      A.eq(show(sentFor(up, 'POOL-R6')), show([['/u6/', K.body], ['/u6/', K.body], ['/or/', K.or]]),
        'R6: the body key, refused, goes to its fallback model and then to its OpenRouter fallback on that provider\'s own key and endpoint, never onto the keychain pool (trunk rotated onto it)');
      A.eq([r6.status, endOf(r6.text).reason], [200, 'done'], 'R6: ...and the run ends done on the provider fallback');
      // b. the keychain key rotates on the keychain pool, at the keychain endpoint
      const keyed = await s.push({ provider: 'custom', key: K.kc });
      A.eq(keyed.body && [keyed.body.configured, keyed.body.credentialSource, keyed.body.alternateCount], [true, 'keychain', 1], 'desktop: the shell pushes a CUSTOM key');
      const id = await s.routine('cus', 'custom', 'POOL-KC');
      const rb = await s.runNow(id);
      A.eq(show(sentFor(up, 'POOL-KC')), show([['/u6/', K.kc], ['/u6/', K.kcPool]]), 'keychain: the keychain key, refused, rotates onto the keychain pool at the keychain endpoint');
      A.eq(endOf(rb.text).reason, 'done', 'keychain: ...and the run ends done');
      // c. after the shell's REMOVE the slot it keeps is unused
      const removed = await s.push({ provider: 'custom', key: '', baseUrl: up.base + '/u6/v1' });
      A.eq(removed.body && [removed.body.configured, removed.body.credentialSource, removed.body.alternateCount], [true, 'none', 1],
        'REMOVE: the answer still counts the pool the shell keeps (CUSTOM stays configured, keyless, at its endpoint)');
      const rc = await s.runNow(await s.routine('cus', 'custom', 'POOL-REMOVED'));
      A.eq(show(sentFor(up, 'POOL-REMOVED')), show([['/u6/', '']]), 'REMOVE: the keyless routine, refused, never rotates onto the keychain pool its layer no longer has a key for (trunk did)');
      A.eq(endOf(rc.text).reason, 'error', 'REMOVE: ...and the run ends error');
    }

    // every request carried its key only to the endpoint it belongs with; neither env pool beside another layer's key went out
    const strays = up.seen.filter(s => !Object.prototype.hasOwnProperty.call(HOME, s.key) || !s.path.startsWith(HOME[s.key])).map(s => who(s.key) + ' -> ' + s.path);
    A.eq(strays, [], 'no request carried a key to an endpoint it does not belong with (' + up.seen.length + ' requests)');
    A.ok(!up.seen.some(s => s.key === K.envPool || s.key === K.dsEnvPool), 'no env pool key that sat beside another layer\'s key was ever sent');
  } catch (e) {
    A.ok(false, 'e2e threw: ' + ((e && e.stack) || e) + '\n' + stations.map(s => s.fx.output().slice(-2500)).join('\n----\n'));
  } finally {
    for (const s of stations) await s.fx.dispose().catch(() => {});
    up.server.closeAllConnections && up.server.closeAllConnections();
    await new Promise(r => up.server.close(r));
  }
  A.report('credential-store.pool-binding.e2e');
})();
