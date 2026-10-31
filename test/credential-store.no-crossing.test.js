/* node test/credential-store.no-crossing.test.js — a credential never crosses providers, layers or endpoints (credential-store
   lane; family B1, credential sources). Step S4 lands its first rows, the KEY POOLS. The dialer census (S6), the complete-
   pair rows (S7) and the channel rows (S8) join it later.

   THE CROSSING (probes R1 and R6). A key pool is one layer's backup keys for that layer's own key. At trunk the keychain
   pool (the desktop shell's push, or its spawn pair) and the operator's env KEY_POOL_<ID> rode ANY run key: a page key the
   upstream refused rotated onto the operator's env pool at the page's endpoint (R1), an /api/run body key onto the keychain
   pool (R6), a keyless run or another layer's key onto either. That sends one account's key to an endpoint saved for
   another, and bills an account the run was never on.

   THE RULE (step S4, golden delta D2): the keychain pool rides only the keychain key, the env KEY_POOL only the env key,
   the page copy's backups only the page key; a key a caller sent in this request gets only a pool sent with it; a pool
   whose layer holds no key is unused (the keychain pool after the shell's REMOVE: the shell keeps that slot); and the
   station's pool never rotates onto an endpoint the caller named (runOnceCore's guard, kept).

   1. THE POOL TABLE. Every combination of the three station layers, each holding a key, backup keys, both or neither: the
      keychain pushed, or adopted from the shell's spawn pair under its marker, then left alone, REMOVEd or rotated; the
      operator's environment; the page copy with and without its endpoint. For a keyed cloud provider (Anthropic), CUSTOM,
      a keyless local one (Ollama), StarNet's linked account and a sign-in (Grok). Each station is built as production
      builds it: index.js's own adoption statement, store construction and one-line functions over the store
      (test/helpers/credential-store-sandbox.js wiredImpl). Each run is resolved by runOnceCore's OWN lines, lifted from
      index.js and executed: who the caller is, the run's key and endpoint, the S3 watch's sent-by-caller mark, and the
      rotation's pool statement. Run shapes: the station's own run; a gate's key handed in (Run Now, the scheduled fire);
      each layer's key handed back (a record, a channel); a channel's own key no layer holds; a record naming an endpoint;
      a keyless body naming one; a key sent in this request, without a pool and with one; a pool sent with no key (a page
      that keeps backups but no key of its own); a caller passed over for another provider.
      THE ORACLE reads the station's description, never the store: a run may rotate onto the pool sent with a key it sent
      in this request; else onto nothing when its endpoint is not the station's own for its key; else onto the first
      non-empty pool of a layer that holds the run's key (keychain, environment, page); never onto the run key itself.
      runOnceCore rotates only providers whose profile has credentialPool; for the others (Ollama, StarNet, the sign-ins)
      the rows check the answer a rotation would get from the same lines.
   2. NAMED ROWS: the probes' R1 and R6, a desktop REMOVE that leaves the keychain pool's slot unused, OpenRouter's alias
      (a headless STARNET_OPENROUTER_KEY is the environment's key, so its KEY_POOL rides it, as credrotate.e2e needs), and a
      key two layers hold (each layer's pool is that key's own; the first with backups serves).
   3. HELD (S3's in-flight watch): a key in a pool is held only while its layer holds a key, so a run that rotated onto it
      stops at its next call once that key is removed; and the push still answers the size of the pool it keeps.

   On a tree without sidecar/credential-store.js (trunk), sections 1 and 2 run over trunk's own resolvers lifted from its
   index.js (trunkImpl) and report the crossings there. Trunk ignores the shell's marker, so the spawn stations are left
   out on such a tree, and section 3 needs the store, which the last failure says. At trunk a3af8dafd the first failure is
   the table's: 8864 of its 14280 runs cross, in 15 of the 17 run shapes (all but the two where a key is sent with a pool of
   its own, which trunk honoured), then R1, R6, the REMOVE rows and the OpenRouter alias rows of section 2. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const Reg = require('../sidecar/providers/registry.js');
const G = require('./helpers/credential-store-sandbox.js');
const { readSidecarIndex, sidecarTopLevelFunction } = require('./helpers/source.js');

const ROOT = path.resolve(__dirname, '..');
const HAS_STORE = fs.existsSync(path.join(ROOT, 'sidecar', 'credential-store.js'));
const impl = HAS_STORE ? G.wiredImpl() : G.trunkImpl({ indexText: readSidecarIndex(), root: ROOT });
const U = G.U;

/* ---- runOnceCore's own lines, lifted from index.js and executed ---- */
const core = sidecarTopLevelFunction('runOnceCore');
const grab = (re, label) => { const m = re.exec(core); A.ok(!!m, 'fixture: runOnceCore\'s ' + label + ' is found'); return m ? m[0] : ''; };
const callerLine = grab(/\n  const callerCredential = [^\n]+;/, 'caller line');
const pairLines = grab(/\n  const runKey = providerRuntimeKey\(providerId, [^\n]+;\n  const baseUrl = providerRuntimeBaseUrl\(providerId, [^\n]+;/, 'key and endpoint lines');
const watchLine = (/\n  const runKeyWatch = [^\n]+;/.exec(core) || [''])[0];   // S3: the key the caller sent in this request
const opens = core.indexOf('primaryProfile.credentialPool) {\n');
const closes = core.indexOf('.filter(s => s && s !== runKey);\n', opens);
const poolBlock = opens > 0 && closes > opens ? core.slice(core.indexOf('\n', opens), closes + '.filter(s => s && s !== runKey);'.length) : '';
A.ok(/const pool = providerRuntimeKeyPool\(providerId, /.test(poolBlock), 'fixture: runOnceCore\'s rotation pool statement is found');
const runLines = new Function('o', 'key', 'providerId', 'normalizeProvider', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerRuntimeKeyPool', 'credStore',
  "'use strict';" + callerLine + pairLines + watchLine + poolBlock + '\nreturn { callerCredential, runKey, baseUrl, pool };');
const normalizeProvider = v => Reg.normalizeProviderId(v, 'openrouter');
function run(api, p, o) {
  const credStore = { holds: (id, k) => (typeof api.holds === 'function' ? api.holds(id, k) : false) };
  return runLines(o, o.key, p, normalizeProvider, api.key, api.baseUrl, api.keyPool, credStore);
}

/* ---- the stations, and what each layer holds by their description ---- */
const clean = list => Array.from(new Set((list || []).map(k => String(k || '').trim()).filter(Boolean))).slice(0, 8);
// desc: { keychain, environment, page: { keys: [...], pool: [...] } } — the oracle's whole view of the station
function station(p, K, via, event, E, P) {
  const prof = Reg.getProviderProfile(p);
  const keyEnv = (prof.keyEnv || [])[0];
  const poolName = 'KEY_POOL_' + p.toUpperCase();
  const env = {}, pushes = [];
  if (via === 'spawn') {
    env.STARNET_DESKTOP_SHELL = '1';
    if (K.includes('k')) { env['STARNET_' + keyEnv] = 'kc'; env['SKYNET_' + keyEnv] = 'kc'; }
    if (K.includes('p')) { env['STARNET_' + poolName] = 'kc.p'; env['SKYNET_' + poolName] = 'kc.p'; }
  } else if (K) {
    const patch = {};
    if (K.includes('k')) patch.key = 'kc';
    if (K.includes('p')) patch.keyPool = ['kc.p'];
    pushes.push([p, patch]);
  }
  if (event === 'remove') pushes.push([p, { key: '' }]);
  if (event === 'rotate') pushes.push([p, { key: 'kc2' }]);
  if (E.includes('k')) env[keyEnv] = 'en';
  if (E.includes('p')) env['STARNET_' + poolName] = 'en.p';
  const rec = {};
  if (P.includes('k')) rec.key = 'pg';
  if (P.includes('p')) rec.keyPool = ['pg.p'];
  if (P.includes('u')) rec.baseUrl = U.pg;
  const sc = { env, pushes, kept: { on: !!K }, page: P ? { [p]: Object.assign(rec, { rev: 'r1' }) } : undefined,
    linked: p === 'starnet' ? { url: 'http://li.test', apiKey: 'li' } : undefined };
  const desc = {
    keychain: { keys: [event === 'rotate' ? 'kc2' : event === 'remove' ? '' : (K.includes('k') ? 'kc' : '')], pool: K.includes('p') ? ['kc.p'] : [] },
    environment: { keys: [E.includes('k') ? 'en' : ''], pool: E.includes('p') ? ['en.p'] : [] },
    page: { keys: [P.includes('k') ? 'pg' : ''], pool: P.includes('p') ? ['pg.p'] : [] }
  };
  return { sc, desc, label: p + ' K:' + (K || '-') + (K ? '/' + via + (event ? '/' + event : '') : '') + ' E:' + (E || '-') + ' P:' + (P || '-') };
}
// a run's shape: the options runOnceCore is handed
const SHAPES = [
  ['the station\'s own run', () => ({})],
  ['a gate\'s key (Run Now, the scheduled fire)', (api, p) => ({ key: api.key(p, '') })],
  ['the keychain key handed back', () => ({ key: 'kc' })], ['the rotated keychain key handed back', () => ({ key: 'kc2' })],
  ['the env key handed back', () => ({ key: 'en' })], ['the page key handed back', () => ({ key: 'pg' })],
  ['a channel\'s own key', () => ({ key: 'fo' })],
  ['the page key handed back with an endpoint', () => ({ key: 'pg', baseUrl: U.ex })],
  ['a keyless body naming an endpoint', () => ({ baseUrl: U.ex })],
  ['the keychain key sent in this request', () => ({ key: 'kc', keyInRequest: true })],
  ['the env key sent in this request', () => ({ key: 'en', keyInRequest: true })],
  ['the page key sent in this request', () => ({ key: 'pg', keyInRequest: true })],
  ['a body key no layer holds (R6)', () => ({ key: 'fo', keyInRequest: true })],
  ['the page key sent with a pool', () => ({ key: 'pg', keyInRequest: true, keyPool: ['sent.p'] })],
  ['a body key sent with a pool', () => ({ key: 'fo', keyInRequest: true, keyPool: ['sent.p'] })],
  ['a pool sent with no key', (api, p) => ({ key: api.key(p, ''), keyPool: ['sent.p'] })],
  ['a caller passed over for another provider', () => ({ provider: 'nosuch-provider', key: 'fo', keyInRequest: true, keyPool: ['sent.p'] })]
];
// THE ORACLE: the pool this run may rotate onto, from the station's description
function allowed(desc, o, r, api, p) {
  if (r.callerCredential && o.keyInRequest === true) return clean(o.keyPool).filter(k => k !== r.runKey);
  if (r.baseUrl !== api.baseUrl(p, '', r.runKey)) return [];
  if (!r.runKey) return [];
  for (const layer of ['keychain', 'environment', 'page']) {
    const l = desc[layer];
    if (l.keys.includes(r.runKey) && l.pool.length) return clean(l.pool).filter(k => k !== r.runKey);
  }
  return [];
}
function check(st, shapes, out) {
  const p = st.p;
  const api = impl(st.sc);
  for (const [id, patch] of st.sc.pushes) api.push(id, patch);
  out.stations++;
  for (const [label, make] of shapes) {
    const o = make(api, p);
    const r = run(api, p, o);
    const want = allowed(st.desc, o, r, api, p);
    out.rows++;
    if (want.length) out.rotating++;
    if (JSON.stringify(r.pool) === JSON.stringify(want)) continue;
    out.bad.push(st.label + ' / ' + label + ': runs on ' + (r.runKey || '(no key)') + ' at ' + (r.baseUrl || '(no endpoint)') +
      ', may rotate onto [' + want.join(',') + '] but got [' + r.pool.join(',') + ']');
    out.byShape.set(label, (out.byShape.get(label) || 0) + 1);
  }
  return api;
}
// the crossings, counted per run shape, with the first of each shape: one shape's many rows never hide another's
const report = (out, what) => {
  const first = label => out.bad.find(b => b.includes(' / ' + label + ': '));
  const shapes = Array.from(out.byShape.entries()).map(([label, n]) => n + ' x ' + first(label));
  A.eq(out.bad.length, 0, what + ' (' + out.rows + ' runs, ' + out.rotating + ' of them with backups to rotate onto)' +
    (out.bad.length ? ': ' + out.bad.length + ' cross, in ' + shapes.length + ' run shapes:\n  ' + shapes.join('\n  ') : ''));
};

/* ================= 1. the pool table ================= */
{
  const out = { stations: 0, rows: 0, rotating: 0, bad: [], byShape: new Map() };
  const PROVIDERS = ['anthropic', 'custom', 'ollama', 'starnet', 'grok'];
  for (const p of PROVIDERS) {
    const keyed = !!(Reg.getProviderProfile(p).keyEnv || []).length;
    const Ks = [['', '', '']];
    for (const K of ['k', 'p', 'kp']) for (const via of (keyed ? ['push', 'spawn'] : ['push'])) for (const event of ['', 'remove', 'rotate']) Ks.push([K, via, event]);
    for (const [K, via, event] of Ks) for (const E of (keyed ? ['', 'k', 'p', 'kp'] : ['', 'p'])) for (const P of ['', 'k', 'ku', 'p', 'kp', 'kup']) {
      if (via === 'spawn' && K.includes('p') && E.includes('p')) continue;   // the shell writes both spellings of KEY_POOL_<ID>: no export beside it
      if (via === 'spawn' && !HAS_STORE) continue;                           // trunk ignores the marker (S2's rows)
      check(Object.assign(station(p, K, via, event, E, P), { p }), SHAPES, out);
    }
  }
  // 2 keyed providers x 384 stations (240 without the spawn ones, which a tree without the store leaves out) + 3 x 120
  A.ok(out.stations === (HAS_STORE ? 1128 : 840) && out.rows === out.stations * SHAPES.length && out.rotating > 1500,
    'fixture: the table runs every station and every run shape (' + out.stations + ' stations, ' + out.rows + ' runs, ' + out.rotating + ' with backups)');
  report(out, 'a key pool rides only its own layer\'s key, a key sent in this request only a pool sent with it, and never a caller\'s endpoint');
}

/* ================= 2. named rows ================= */
{
  const one = (sc, desc, p, o) => { const api = impl(sc); for (const [id, patch] of sc.pushes || []) api.push(id, patch); const r = run(api, p, o); return { r, want: allowed(desc, o, r, api, p), api }; };
  const none = { keys: [''], pool: [] };
  // R1: an operator env KEY_POOL_CUSTOM (no env key) and the page's CUSTOM pair {K, U}; a routine's Run Now on the page key
  {
    const sc = { env: { STARNET_KEY_POOL_CUSTOM: 'en.p' }, page: { custom: { key: 'pg', baseUrl: U.pg, rev: 'r1' } }, pushes: [] };
    const { r } = one(sc, { keychain: none, environment: { keys: [''], pool: ['en.p'] }, page: { keys: ['pg'], pool: [] } }, 'custom', { key: 'pg' });
    A.eq([r.runKey, r.baseUrl, r.pool], ['pg', U.pg, []], 'R1: a routine on the page key {K, U} never rotates onto the operator\'s env KEY_POOL at U (trunk sent it there)');
  }
  // R6: the desktop shell pushed a CUSTOM endpoint U and a pool, no key; an /api/run body sends its own key
  {
    const sc = { env: {}, kept: { on: true }, pushes: [['custom', { baseUrl: U.kc, keyPool: ['kc.p'] }]] };
    const { r } = one(sc, { keychain: { keys: [''], pool: ['kc.p'] }, environment: none, page: none }, 'custom', { key: 'fo', keyInRequest: true });
    A.eq([r.runKey, r.baseUrl, r.pool], ['fo', U.kc, []], 'R6: a body key never rotates onto the keychain pool (trunk rotated onto it at the keychain endpoint)');
    const own = run(impl(Object.assign({}, sc, { pushes: [] })), 'custom', { key: 'fo', keyInRequest: true, keyPool: ['sent.p'] });
    A.eq(own.pool, ['sent.p'], 'R6: ...while a pool it sends with its key is its own');
  }
  // a desktop REMOVE: the keychain pool's slot stays (the shell keeps it), unused; a keyless CUSTOM run goes out on no pool
  for (const p of ['anthropic', 'custom']) {
    const sc = { env: { CUSTOM_OPENAI_BASE_URL: U.en }, kept: { on: true }, pushes: [[p, { key: 'kc', keyPool: ['kc.p'] }], [p, { key: '' }]] };
    const { r, api } = one(sc, { keychain: { keys: [''], pool: ['kc.p'] }, environment: none, page: none }, p, {});
    A.eq([r.runKey, r.pool], ['', []], p + ': after the shell\'s REMOVE the keychain pool it keeps is unused (trunk rotated a keyless run onto it)');
    if (HAS_STORE) A.eq(api.keychainValues().pools, [['kc.p']], p + ': ...while the store still holds the slot the shell keeps');
  }
  // OpenRouter's alias: a headless STARNET_OPENROUTER_KEY is the environment's key, and its KEY_POOL rides it (credrotate.e2e)
  {
    const env = { STARNET_OPENROUTER_KEY: 'br', STARNET_KEY_POOL_OPENROUTER: 'en.p' };
    const desc = { keychain: none, environment: { keys: ['br'], pool: ['en.p'] }, page: none };
    for (const [label, o, want] of [['the station\'s own run', {}, ['en.p']], ['a gate\'s key', { key: 'br' }, ['en.p']], ['a body key no layer holds', { key: 'fo', keyInRequest: true }, []],
      ['the export\'s key sent in this request', { key: 'br', keyInRequest: true }, []]]) {
      const { r, want: oracle } = one({ env, pushes: [] }, desc, 'openrouter', o);
      A.eq([r.pool, oracle], [want, want], 'openrouter alias, ' + label + ': the env KEY_POOL rides the branded export (the environment\'s key) and nothing else');
    }
    // ...and the bare name beside it: both are the environment's keys
    const both = one({ env: Object.assign({ OPENROUTER_KEY: 'en' }, env), pushes: [] }, desc, 'openrouter', { key: 'en' });
    A.eq(both.r.pool, ['en.p'], 'openrouter alias: the bare OPENROUTER_KEY beside the branded one is the environment\'s key too');
    // a push makes the keychain's key: the env pool stays the env key's
    const pushed = one({ env, pushes: [['openrouter', { key: 'kc' }]] }, { keychain: { keys: ['kc'], pool: [] }, environment: { keys: ['br'], pool: ['en.p'] }, page: none }, 'openrouter', {});
    A.eq([pushed.r.runKey, pushed.r.pool, pushed.want], ['kc', [], []], 'openrouter: a pushed keychain key never rides the env KEY_POOL');
  }
  // one key in two layers (the page saved the operator's own key): each layer's pool is that key's; the first with backups serves
  {
    const page = { anthropic: { key: 'same', keyPool: ['pg.p'], rev: 'r1' } };
    const a = one({ env: { ANTHROPIC_API_KEY: 'same' }, page, pushes: [] }, { keychain: none, environment: { keys: ['same'], pool: [] }, page: { keys: ['same'], pool: ['pg.p'] } }, 'anthropic', {});
    A.eq([a.r.runKey, a.r.pool, a.want], ['same', ['pg.p'], ['pg.p']], 'one key in the environment and the page copy: the page\'s backups are that key\'s own');
    const b = one({ env: { ANTHROPIC_API_KEY: 'same', STARNET_KEY_POOL_ANTHROPIC: 'en.p' }, page, pushes: [] }, { keychain: none, environment: { keys: ['same'], pool: ['en.p'] }, page: { keys: ['same'], pool: ['pg.p'] } }, 'anthropic', {});
    A.eq([b.r.pool, b.want], [['en.p'], ['en.p']], '...and with backups in both, the environment\'s (key order) serve');
  }
}

/* ================= 3. held: a pool is held only while its layer holds a key (S3's in-flight watch) ================= */
// said last, so on a tree without the store the first failure is the table's own: the pools trunk's runs rotate onto
if (!HAS_STORE) A.ok(false, 'this tree has no sidecar/credential-store.js: sections 1 and 2 ran over index.js\'s own resolvers (trunk), and section 3 needs the store');
if (HAS_STORE) {
  const api = impl({ env: {}, kept: { on: true }, pushes: [] });
  api.push('anthropic', { key: 'kc', keyPool: ['kc.p'] });
  A.eq([api.holds('anthropic', 'kc'), api.holds('anthropic', 'kc.p')], [true, true], 'held: the keychain key and its pool');
  const answer = {};
  api.push('anthropic', { key: '' }, answer);
  A.eq([api.holds('anthropic', 'kc'), api.holds('anthropic', 'kc.p')], [false, false], 'held: after the shell\'s REMOVE neither is, so a run that rotated onto the pool stops at its next call');
  A.eq(answer.alternateCount, 1, '...while the push still answers the size of the pool the shell keeps (alternateCount)');
  api.push('anthropic', { key: 'kc2' });
  A.eq(api.holds('anthropic', 'kc.p'), true, 'held: a new keychain key takes the pool back');
  const env = impl({ env: { STARNET_KEY_POOL_ANTHROPIC: 'en.p' }, pushes: [] });
  const envKeyed = impl({ env: { ANTHROPIC_API_KEY: 'en', STARNET_KEY_POOL_ANTHROPIC: 'en.p' }, pushes: [] });
  A.eq([env.holds('anthropic', 'en.p'), envKeyed.holds('anthropic', 'en.p')], [false, true], 'held: an env KEY_POOL with no env key is unused; with one it is held');
  const page = impl({ env: {}, page: { custom: { keyPool: ['pg.p'], baseUrl: U.pg, rev: 'r1' } }, pushes: [] });
  A.eq(page.holds('custom', 'pg.p'), false, 'held: a page copy\'s backups with no page key are unused');
  A.eq([api.holds('custom', 'kc.p'), envKeyed.holds('openai', 'en.p')], [false, false], 'held: never another provider\'s pool');
}

A.report('credential-store.no-crossing');
