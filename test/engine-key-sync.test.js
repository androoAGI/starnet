/* node test/engine-key-sync.test.js — the browser page hands the station its provider key (#89).

   #89: in the browser build (npm start + a browser — every Linux install) a key saved in SETTINGS lived only in this
   page's localStorage, so routines, Run Now, the night shift and line hops — which run with no page attached — had no
   key while chat worked. Locks, executing the REAL harness.js functions in a sandbox:
     · saving / backing up / pointing a provider at an endpoint POSTs that provider's FULL config to
       /api/providers/engine-key; REMOVE posts the empty config (the station clears its copy)
     · every page boot re-hands what this browser holds as a BOOT hand-over carrying the station revision this page
       last proved — the station keeps a newer change another origin made (localhost vs 127.0.0.1 are separate
       localStorage), so an older page can never put back a key the Commander rotated or removed
     · a save or REMOVE that could not reach the station is remembered as pending and retried at the next boot (a
       failed REMOVE used to be forgotten while the station kept spending on the key); a 4xx refusal is not retried
     · the desktop app (keychain), dev (server-held key) and the sign-in providers never send a key
     · it NEVER rejects: the key is saved in this browser either way; a refusal / dead station resolves { ok:false,
       error } — worded for what failed (a failed REMOVE says the station KEEPS using its copy, never "chat works") —
       and SETTINGS, the backup pool, the endpoint editor, the keyless REMOVE and onboarding all show that warning */
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
const SYNC = 'starnet.byok.engineSync.';
const OK_BODY = { ok: true, provider: 'x', applied: true, persisted: true, keySource: 'station', unattendedReady: true, rev: 'rev1' };

function sandbox(opts) {
  opts = opts || {};
  const store = new Map(Object.entries(opts.storage || {}));
  const posts = [];
  const warns = [];
  // respond(body, n) -> { status, body } | 'throw' — per request, so one sandbox can play a failure then a retry
  const respond = opts.respond || (() => opts.fetchThrows ? 'throw' : { status: opts.status || 200, body: opts.body || OK_BODY });
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
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      const r = respond(body, posts.length);
      if (r === 'throw') throw new TypeError('Failed to fetch');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) };
    }
  };
  const api = vm.runInNewContext(helpers + keyFns + '\n({ setKey, setKeyPool, setDesktopConfigured, syncEngineKey, syncEngineKeysOnBoot, engineConfigOf })', scope);
  const sync = p => { const v = store.get(SYNC + p); return v == null ? null : JSON.parse(v); };
  return { api, posts, warns, store, sync };
}

(async () => {
  /* ---- save: the full config rides to the station ---- */
  {
    const s = sandbox({ storage: { 'starnet.byok.keyPool.openrouter': '["alt-1"]' } });
    const r = await s.api.setKey('sk-or-v1-page', 'openrouter');
    A.eq(s.store.get('starnet.byok.key.openrouter'), 'sk-or-v1-page', 'the key is saved in this browser first (chat works either way)');
    A.eq(s.posts.length, 1, 'one hand-over to the station');
    A.eq(s.posts[0].url, '/api/providers/engine-key', 'through the token-gated engine-key route (the page fetch wrapper adds the launch token)');
    A.eq(s.posts[0].body, { provider: 'openrouter', key: 'sk-or-v1-page', keyPool: ['alt-1'], baseUrl: '' }, 'the FULL config: key + backups + endpoint (an explicit save carries no boot mark)');
    A.eq(r && r.engine && r.engine.ok, true, 'setKey resolves with the station\'s answer');
    A.eq(r.engine.keySource, 'station', 'presence only: where unattended runs get the key');
    A.eq(s.sync('openrouter'), { rev: 'rev1', pending: false }, 'the page remembers the station revision it proved');
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
    const pool = await s.api.setKeyPool(['b1', 'b2'], 'openrouter');
    A.eq(pool && pool.count, 2, 'setKeyPool resolves the stored count…');
    A.eq(pool.engine && pool.engine.ok, true, '…and the station\'s answer, so SETTINGS can warn when routines lack the backups');
    A.eq(s.posts[0].body.keyPool, ['b1', 'b2'], 'a backup-pool change reaches the station with the key');
  }
  /* ---- never rejects; a refusal or a dead station is a truthful warning ---- */
  {
    const refused = sandbox({ status: 500, body: { ok: false, error: 'the station could not save this OpenRouter setting to disk — chat still works' } });
    const r = await refused.api.setKey('sk-or-v1-page', 'openrouter');
    A.ok(r.engine.ok === false && r.engine.error.indexOf('the station could not save this OpenRouter setting to disk — chat still works') === 0, 'the station\'s own refusal reaches the caller verbatim: ' + r.engine.error);
    A.ok(/this page retries the next time it loads$/.test(r.engine.error), '…and says the page will retry it');
    A.eq(refused.sync('openrouter'), { rev: '', pending: true }, 'a failed save is remembered as pending');
    A.ok(refused.warns.length === 1 && refused.warns[0].indexOf('sk-or-v1-page') < 0, 'logged once, never with the key');
    const dead = sandbox({ fetchThrows: true });
    const d = await dead.api.setKey('sk-or-v1-page', 'openrouter');
    A.ok(d.engine.ok === false && /could not be reached/.test(d.engine.error) && /chat in this browser still works/.test(d.engine.error), 'an unreachable station resolves an honest error, never a rejection');
    const bare = sandbox({ status: 403, body: { nope: true } });
    const x = await bare.api.syncEngineKey('openrouter');
    A.ok(x.ok === false && /HTTP 403/.test(x.error), 'a bare 403 names the refusal: ' + x.error);
    A.ok(!/retries/.test(x.error) && bare.sync('openrouter') === null, 'a 4xx refusal is not retried (a retry cannot fix it)');
  }
  /* ---- a failed REMOVE says the station KEEPS the key, and is retried at the next boot ---- */
  {
    const REMOVE_500 = 'the station could not delete its copy of this OpenRouter connection (its log has the reason) — routines and other unattended runs will KEEP using it until a retry succeeds';
    let phase = 'fail';
    const s = sandbox({
      storage: { 'starnet.byok.key.openrouter': 'sk-or-v1-leaked', [SYNC + 'openrouter']: JSON.stringify({ rev: 'r7', pending: false }) },
      respond: () => phase === 'fail' ? { status: 500, body: { ok: false, removing: true, error: REMOVE_500 } } : { status: 200, body: Object.assign({}, OK_BODY, { rev: 'r8' }) }
    });
    const r = await s.api.setKey('', 'openrouter');
    A.eq(s.store.get('starnet.byok.key.openrouter'), '', 'this browser forgot its key');
    A.ok(r.engine.ok === false && r.engine.error.indexOf(REMOVE_500) === 0, 'the warning is the station\'s REMOVE wording: ' + r.engine.error);
    A.ok(!/chat in this browser still works/.test(r.engine.error), 'never "chat still works" after a REMOVE (this browser has no key any more)');
    A.eq(s.sync('openrouter'), { rev: 'r7', pending: true }, 'the failed REMOVE is pending, with the revision it was meant to delete');
    phase = 'ok';
    await s.api.syncEngineKeysOnBoot();
    const retry = s.posts[s.posts.length - 1].body;
    A.eq(retry, { provider: 'openrouter', key: '', keyPool: [], baseUrl: '', boot: true, ifRev: 'r7' }, 'the next boot retries the REMOVE — only if the station still holds what this page meant to delete');
    A.eq(s.sync('openrouter'), { rev: 'r8', pending: false }, 'confirmed: no longer pending');
    const before = s.posts.length;
    await s.api.syncEngineKeysOnBoot();
    A.eq(s.posts.length, before, 'once confirmed, a boot sends nothing for a provider this page holds nothing for');
    const deadRm = sandbox({ fetchThrows: true, storage: { 'starnet.byok.key.openrouter': 'sk-or-v1-x' } });
    const dr = await deadRm.api.setKey('', 'openrouter');
    A.ok(/could not be reached to delete its copy/.test(dr.engine.error) && /keep using it/.test(dr.engine.error) && !/chat in this browser still works/.test(dr.engine.error), 'an unreachable station during REMOVE says routines keep the key: ' + dr.engine.error);
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
  /* ---- page boot: a BOOT hand-over of what this browser holds; never an unasked REMOVE ---- */
  {
    const s = sandbox({ storage: {
      'starnet.byok.key': 'sk-or-v1-legacy-slot',                    // the pre-scoped OpenRouter slot
      'starnet.byok.key.anthropic': 'sk-ant-page',
      [SYNC + 'anthropic']: JSON.stringify({ rev: 'a3', pending: false }),
      'starnet.byok.baseUrl.custom': 'http://127.0.0.1:1234/v1',      // a keyless endpoint
      'starnet.byok.key.mistral': '',                                  // removed earlier (confirmed): nothing to hand over
      [SYNC + 'mistral']: JSON.stringify({ rev: 'm2', pending: false }),
      'starnet.byok.model': 'some/model'
    } });
    await s.api.syncEngineKeysOnBoot();
    const by = Object.fromEntries(s.posts.map(p => [p.body.provider, p.body]));
    A.eq(Object.keys(by).sort(), ['anthropic', 'custom', 'openrouter'], 'boot hands over every provider this browser holds a config for, and only those');
    A.eq(by.openrouter.key, 'sk-or-v1-legacy-slot', 'the legacy OpenRouter slot is read like everywhere else');
    A.eq(by.custom, { provider: 'custom', key: '', keyPool: [], baseUrl: 'http://127.0.0.1:1234/v1', boot: true, ifRev: '' }, 'a keyless endpoint rides too, marked as a boot hand-over');
    A.eq([by.anthropic.boot, by.anthropic.ifRev], [true, 'a3'], 'each boot hand-over carries the revision this page last proved');
    A.ok(!s.posts.some(p => !p.body.key && !p.body.baseUrl && !p.body.keyPool.length), 'boot never sends a REMOVE that is not pending');
  }
  /* ---- a stale answer: the station kept a newer change; this page never adopts its revision ---- */
  {
    const s = sandbox({
      storage: { 'starnet.byok.key.openrouter': 'sk-or-v1-old-origin', [SYNC + 'openrouter']: JSON.stringify({ rev: 'r1', pending: true }) },
      respond: () => ({ status: 200, body: { ok: true, provider: 'openrouter', applied: false, stale: true, changed: false, keySource: 'station', unattendedReady: true } })
    });
    const [res] = await s.api.syncEngineKeysOnBoot();
    A.ok(res.ok === true && res.stale === true, 'a stale boot hand-over is not an error');
    A.eq(s.sync('openrouter'), { rev: 'r1', pending: false }, 'the page keeps its OLD revision (so its older key can never win a later boot) and drops the superseded retry');
  }

  /* ---- wiring the sandbox can't see ---- */
  const initBody = harness.slice(harness.indexOf('async function init()'), harness.indexOf('function normalizeProviderId'));
  A.ok(/if \(!DESKTOP\) \{ syncEngineKeysOnBoot\(\); return; \}/.test(initBody), 'init() hands the saved configs over once per page boot, without awaiting it');
  A.ok(/const stored = await Promise\.resolve\(setKey\(candidate, p\)\);[\s\S]{0,200}engine: stored\.engine/.test(harness), 'validateAndSetKey passes the station\'s answer to SETTINGS');
  A.ok(/writeScoped\(LS\.baseUrl, p, u \|\| ''\);[\s\S]{0,300}return syncEngineKey\(p\)\.then\(engine => \(\{ engine \}\)\);/.test(harness), 'an endpoint saved in the browser reaches the station, and resolves its answer');
  const station = read('frontend', 'app', 'stationui.js');
  A.ok(/function warnIfStationLacksKey\(res\) \{[\s\S]{0,200}e\.ok === false && e\.error\) notify\('⚠ ' \+ e\.error, 'warn', undefined, \{ key: 'engine-key' \}\)/.test(station), 'SETTINGS shows the station\'s refusal as a warning (one toast slot)');
  A.eq((station.match(/warnIfStationLacksKey\(res\);/g) || []).length, 5, 'beside each key save (add, edit, inline), the backup pool and the endpoint editor');
  A.ok(/Promise\.resolve\(h\.setKey\('', row\.provider\)\)\.then\(warnIfStationLacksKey\)/.test(station), 'after REMOVE');
  A.ok(/Promise\.resolve\(h\.setBaseUrl\('', 'custom'\)\)\.then\(warnIfStationLacksKey\)/.test(station), 'and after the keyless CUSTOM endpoint REMOVE');
  A.ok(/const count = \(res && typeof res === 'object'\) \? Number\(res\.count\) \|\| 0 : res;/.test(station), 'the backup-pool toast reads the count out of { count, engine }');
  A.ok(/'stored in this browser and on this station, so routines can use it'/.test(station) && /keyStoreClause\(res\)/.test(station) && !/keyStoreClause\(\)/.test(station),
    'a key the station proved it holds is never described as "stored locally in this browser" only');
  A.ok(/notify, warnIfStationLacksKey, settleNotifs,/.test(station), 'StationUI exports the warning for onboarding');
  const app = read('frontend', 'app', 'app.js');
  A.ok(/if \(Harness\.setBaseUrl\) warnStation\(await Harness\.setBaseUrl\(baseUrl, pickedProvider\)\);/.test(app)
    && /if \(key\) warnStation\(await \(Harness\.validateAndSetKey \? Harness\.validateAndSetKey\(key, pickedProvider\)/.test(app),
    'onboarding (the first connect) shows the same warning when the station could not keep the key');

  A.report('engine-key-sync.test');
})().catch(e => { console.error(e); process.exit(1); });
