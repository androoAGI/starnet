/* node test/engine-key-sync.test.js — the browser page hands the station its provider key (#89).

   #89: in the browser build (npm start + a browser — every Linux install) a key saved in SETTINGS lived only in this
   page's localStorage, so routines, Run Now, the night shift and line hops — which run with no page attached — had no
   key while chat worked. Locks, executing the REAL harness.js functions in a sandbox:
     · saving / backing up / pointing a provider at an endpoint POSTs that provider's FULL config to
       /api/providers/engine-key; REMOVE posts the empty config (the station clears its copy)
     · every page boot re-hands what this browser already holds — and never removes anything (another browser's save
       must survive a browser that holds nothing)
     · the desktop app (keychain), dev (server-held key) and the sign-in providers never send a key
     · it NEVER rejects: the key is saved in this browser either way; a refusal / dead station resolves { ok:false,
       error } and SETTINGS shows that warning beside the success */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const harness = read('frontend', 'app', 'harness.js');
const slice = (src, from, to) => { const a = src.indexOf(from), b = src.indexOf(to, a + 1); A.ok(a >= 0 && b > a, 'harness.js still has ' + from.trim().slice(0, 40)); return src.slice(a, b); };
const helpers = slice(harness, '  function normalizeProviderId(provider) {', '  function providerNeedsKey(provider) {');
const keyFns = slice(harness, '  const setKey = (k, provider) => {', '  // #62: no provider key contains whitespace');

function sandbox(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.storage || {}));
  const posts = [];
  const warns = [];
  const scope = {
    JSON, Promise, Set, Array, String, Number, Math, Object,
    DESKTOP: !!opts.desktop, DEVMODE: !!opts.dev, selectionRevision: 0,
    LS: { key: 'starnet.byok.key', keyPool: 'starnet.byok.keyPool', model: 'starnet.byok.model', prov: 'starnet.byok.prov', baseUrl: 'starnet.byok.baseUrl', effort: 'starnet.byok.reasoningEffort' },
    _configured: false, _configuredByProvider: {}, _alternateCountByProvider: {},
    getProv: () => 'openrouter', getBaseUrl: () => '',
    invoke: () => Promise.resolve(true),
    console: { warn: m => warns.push(String(m)), log() {} },
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
      key: i => Array.from(store.keys())[i] || null,
      get length() { return store.size; }
    },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      if (opts.fetchThrows) throw new TypeError('Failed to fetch');
      const status = opts.status || 200;
      const body = opts.body || { ok: true, provider: 'x', persisted: true, keySource: 'station', unattendedReady: true };
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    }
  };
  const api = vm.runInNewContext(helpers + keyFns + '\n({ setKey, setKeyPool, setDesktopConfigured, syncEngineKey, syncEngineKeysOnBoot, engineConfigOf })', scope);
  return { api, posts, warns, store };
}

(async () => {
  /* ---- save: the full config rides to the station ---- */
  {
    const s = sandbox({ storage: { 'starnet.byok.keyPool.openrouter': '["alt-1"]' } });
    const r = await s.api.setKey('sk-or-v1-page', 'openrouter');
    A.eq(s.store.get('starnet.byok.key.openrouter'), 'sk-or-v1-page', 'the key is saved in this browser first (chat works either way)');
    A.eq(s.posts.length, 1, 'one hand-over to the station');
    A.eq(s.posts[0].url, '/api/providers/engine-key', 'through the token-gated engine-key route (the page fetch wrapper adds the launch token)');
    A.eq(s.posts[0].body, { provider: 'openrouter', key: 'sk-or-v1-page', keyPool: ['alt-1'], baseUrl: '' }, 'the FULL config: key + backups + endpoint');
    A.eq(r && r.engine && r.engine.ok, true, 'setKey resolves with the station\'s answer');
    A.eq(r.engine.keySource, 'station', 'presence only: where unattended runs get the key');
  }
  /* ---- REMOVE: the empty config clears the station copy ---- */
  {
    const s = sandbox({ storage: { 'starnet.byok.key.anthropic': 'sk-ant-old' } });
    await s.api.setKey('', 'anthropic');
    A.eq(s.posts[0].body, { provider: 'anthropic', key: '', keyPool: [], baseUrl: '' }, 'REMOVE hands over the empty config');
  }
  /* ---- backups and endpoints follow ---- */
  {
    const s = sandbox({ storage: { 'starnet.byok.key.openrouter': 'sk-or-v1-page' } });
    const count = await s.api.setKeyPool(['b1', 'b2'], 'openrouter');
    A.eq(count, 2, 'setKeyPool still resolves the stored count');
    A.eq(s.posts[0].body.keyPool, ['b1', 'b2'], 'a backup-pool change reaches the station with the key');
  }
  /* ---- never rejects; a refusal or a dead station is a truthful warning ---- */
  {
    const refused = sandbox({ status: 500, body: { ok: false, error: 'the station could not save this OpenRouter setting to disk — chat still works' } });
    const r = await refused.api.setKey('sk-or-v1-page', 'openrouter');
    A.eq(r.engine, { ok: false, error: 'the station could not save this OpenRouter setting to disk — chat still works' }, 'the station\'s own refusal reaches the caller verbatim');
    A.ok(refused.warns.length === 1 && refused.warns[0].indexOf('sk-or-v1-page') < 0, 'logged once, never with the key');
    const dead = sandbox({ fetchThrows: true });
    const d = await dead.api.setKey('sk-or-v1-page', 'openrouter');
    A.ok(d.engine.ok === false && /could not be reached/.test(d.engine.error) && /chat in this browser still works/.test(d.engine.error), 'an unreachable station resolves an honest error, never a rejection');
    const bare = sandbox({ status: 403, body: { nope: true } });
    const x = await bare.api.syncEngineKey('openrouter');
    A.ok(x.ok === false && /HTTP 403/.test(x.error), 'a bare 403 names the refusal: ' + x.error);
  }
  /* ---- desktop / dev / sign-in providers never send a key ---- */
  {
    const desk = sandbox({ desktop: true });
    await desk.api.syncEngineKey('openrouter');
    A.eq(desk.posts.length, 0, 'the desktop app keeps keys in the OS keychain: nothing is posted');
    const dev = sandbox({ dev: true, storage: { 'starnet.byok.key.openrouter': 'k' } });
    await dev.api.syncEngineKeysOnBoot();
    A.eq(dev.posts.length, 0, 'dev mode holds the key server-side: nothing is posted');
    const oauth = sandbox();
    for (const p of ['codex', 'grok', 'kimi', 'starnet', 'claude-cli']) await oauth.api.syncEngineKey(p);
    A.eq(oauth.posts.length, 0, 'sign-in / managed providers never send a key');
  }
  /* ---- page boot: re-hand what this browser holds; never remove ---- */
  {
    const s = sandbox({ storage: {
      'starnet.byok.key': 'sk-or-v1-legacy-slot',                    // the pre-scoped OpenRouter slot
      'starnet.byok.key.anthropic': 'sk-ant-page',
      'starnet.byok.baseUrl.custom': 'http://127.0.0.1:1234/v1',      // a keyless endpoint
      'starnet.byok.key.mistral': '',                                  // removed earlier: nothing to hand over
      'starnet.byok.model': 'some/model'
    } });
    await s.api.syncEngineKeysOnBoot();
    const by = Object.fromEntries(s.posts.map(p => [p.body.provider, p.body]));
    A.eq(Object.keys(by).sort(), ['anthropic', 'custom', 'openrouter'], 'boot hands over every provider this browser holds a config for, and only those');
    A.eq(by.openrouter.key, 'sk-or-v1-legacy-slot', 'the legacy OpenRouter slot is read like everywhere else');
    A.eq(by.custom, { provider: 'custom', key: '', keyPool: [], baseUrl: 'http://127.0.0.1:1234/v1' }, 'a keyless endpoint rides too');
    A.ok(!s.posts.some(p => !p.body.key && !p.body.baseUrl && !p.body.keyPool.length), 'boot never sends an empty (REMOVE) config');
  }

  /* ---- wiring the sandbox can't see ---- */
  const initBody = harness.slice(harness.indexOf('async function init()'), harness.indexOf('function normalizeProviderId'));
  A.ok(/if \(!DESKTOP\) \{ syncEngineKeysOnBoot\(\); return; \}/.test(initBody), 'init() hands the saved configs over once per page boot, without awaiting it');
  A.ok(/const stored = await Promise\.resolve\(setKey\(candidate, p\)\);[\s\S]{0,200}engine: stored\.engine/.test(harness), 'validateAndSetKey passes the station\'s answer to SETTINGS');
  A.ok(/writeScoped\(LS\.baseUrl, p, u \|\| ''\);[\s\S]{0,300}return syncEngineKey\(p\);/.test(harness), 'an endpoint saved in the browser reaches the station');
  const station = read('frontend', 'app', 'stationui.js');
  A.ok(/function warnIfStationLacksKey\(res\) \{[\s\S]{0,200}e\.ok === false && e\.error\) notify\('⚠ ' \+ e\.error, 'warn'\)/.test(station), 'SETTINGS shows the station\'s refusal as a warning');
  A.eq((station.match(/warnIfStationLacksKey\(res\);/g) || []).length, 3, 'beside each key save success (add, edit, inline)');
  A.ok(/Promise\.resolve\(h\.setKey\('', row\.provider\)\)\.then\(warnIfStationLacksKey\)/.test(station), 'and after REMOVE');

  A.report('engine-key-sync.test');
})().catch(e => { console.error(e); process.exit(1); });
