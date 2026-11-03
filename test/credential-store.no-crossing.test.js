/* node test/credential-store.no-crossing.test.js — a credential never crosses providers, layers or endpoints (credential-store
   lane; family B1, credential sources). Step S4 landed its first rows, the KEY POOLS; step S6 the dialer census (sections 4
   to 6, below the pool rows' story); step S7 the complete pairs (section 7); step S8 the channel rows (section 8).

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

   THE DIALERS (step S6). A key has to reach its endpoint on every path out of this process, not just the run's. At trunk STT, TTS
   and web_search's rung dialed https://openrouter.ai whatever endpoint the key was saved with; a key the page sent to TTS went to
   the endpoint of the STATION's key; and native Live Voice posted an OpenAI key saved with a gateway to api.openai.com.
   4. THE MODULE DIALERS. Every leg (the three STT legs, the three TTS legs, the web rung, Live Voice, the image route) built with
      the real module over the store's consumerDeps(), the function index.js uses, with fetch faked only at the network, over
      every combination of a provider's layers: a key, an endpoint, both or neither in the keychain, the environment and the page
      copy. Keys a page sends with one request, a run on OpenRouter and a StarNet-credits run are rows of their own. THE ORACLE
      reads the station's description, never the store: see homeOf.
   5. THE ONE CREDENTIAL: credentialFor's key, endpoint, source and rank (decision 1) by where the key came from.
   6. THE CENSUS, over the sidecar's own source: a provider host stands only in the registry's profiles and each adapter's default
      constant; every place a provider credential leaves this process has a row; a function that reads a key reads the endpoint
      for that provider; and index.js builds each module-level dialer from consumerDeps. So a new dialer cannot go unseen.

   THE PAIR (step S7, golden deltas D3 and D4; probes P3b and P3c, gh#137, gh#113). key(id, '') and baseUrl(id, '') were two
   answers, so a CUSTOM env key with no endpoint hid the page's saved pair, and every routine was refused beside it. Sending that
   env key to the page's endpoint would be the crossing this file exists to forbid (it is what PR #141 did): the page's endpoint
   was saved for the page's key. The rule: the station's own choice is the first layer, in key order, whose key has a usable
   endpoint, used whole; a keyless lower pair replaces nobody's key; a key a caller passes is never swapped; and no shape of
   baseUrl hands a key an endpoint saved for another key, except the two station-wide overrides.
   7. THE PAIR TABLE. Every combination of the three station layers (a key, an endpoint, backups, or nothing) for a keyed cloud
      provider, CUSTOM, a keyless local one, StarNet's linked account and a sign-in, each built by index.js's own wiring, under
      each shape the wrappers are called in: the station's own (runKey undefined, no caller key: a gate); a key handed in as the
      run key (the scheduled fire, Run Now, a line hop); a key as the caller's with no run key (a hub's secrets(), the fallback
      loop, the catalog); a record handing a key back; a key sent in this request; each with and without an endpoint named beside
      it; a keyless run. Each key is every layer's and one no layer holds. THE ORACLE reads the station's description, never
      the store (pairChoice, pairHome). A gate's pair and the pair the run goes out on are asked of runOnceCore's own lines, and
      the pool beside each is the pool table's rule, so an env pool beside a chosen page pair is a row here. resolve() answers
      the same for each, with its source, its rank and what is missing. index.js's own refusal says the state resolve names.

   On a tree without sidecar/credential-store.js (trunk), sections 1 and 2 run over trunk's own resolvers lifted from its
   index.js (trunkImpl) and report the crossings there. Trunk ignores the shell's marker, so the spawn stations are left
   out on such a tree, section 3 needs the store, which its failure says, section 4 builds the same modules with trunk's own
   wiring (consumersOf) and section 5 needs the store too. At trunk a3af8dafd the first failure is the pool table's: 8864 of its
   14280 runs cross, in 15 of the 17 run shapes (all but the two where a key is sent with a pool of its own, which trunk honoured),
   then R1, R6, the REMOVE rows and the OpenRouter alias rows of section 2. Section 4 then reports where trunk sent each key: 489
   of its 1024 rows cross, in 15 legs. Section 6 names the hard-coded hosts in media-service.js and web.js, and its wiring rows
   fail. The image route rows and section 5 are tip-only: trunk's route lives inside index.js, and it has no credentialFor.
   Section 7 runs its wrapper rows over trunk's resolvers too: 1216 of its 33978 rows cross there, in 8 shapes (a CUSTOM station's own
   key and endpoint are {en, ''} beside the page's pair; a key handed in with no run key goes to the page's endpoint, or misses
   its own; the env pool rides a keyless run). Its resolve() and refusal rows need the store, and are tip-only. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Reg = require('../sidecar/providers/registry.js');
const ImageTask = require('../sidecar/image-task.js');
const { makeMediaService } = require('../sidecar/media-service.js');
const { makeRealtimeVoice } = require('../sidecar/realtime-voice.js');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
const { makeImageTools } = require('../sidecar/tools/builtin/image.js');
const G = require('./helpers/credential-store-sandbox.js');
const { readSidecarIndex, sidecarTopLevelFunction, sidecarSourceFiles } = require('./helpers/source.js');

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
const poolBlock = opens > 0 ? ((/\n    const pool = providerRuntimeKeyPool\([\s\S]*?;\n/.exec(core.slice(opens)) || [''])[0]) : '';
A.ok(/const pool = providerRuntimeKeyPool\(providerId, /.test(poolBlock), 'fixture: runOnceCore\'s rotation pool statement is found');
const runLines = new Function('o', 'key', 'providerId', 'normalizeProvider', 'providerRuntimeKey', 'providerRuntimeBaseUrl', 'providerRuntimeKeyPool', 'credStore',
  "'use strict';" + callerLine + pairLines + watchLine + poolBlock + '\nreturn { callerCredential, runKey, baseUrl, pool };');
const normalizeProvider = v => Reg.normalizeProviderId(v, 'openrouter');
function run(api, p, o) {
  // Current production gets its real ownership/admission/readiness authority. The old-source control
  // contract predates the credential store and only its historic holds/fromStation reads use this fallback.
  const credStore = api.credStore || { holds: (id, k) => (typeof api.holds === 'function' ? api.holds(id, k) : false), fromStation: () => false };
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
const report = (out, what, tally, kind) => {
  const first = label => out.bad.find(b => b.includes(' / ' + label + ': '));
  const shapes = Array.from(out.byShape.entries()).map(([label, n]) => n + ' x ' + first(label));
  A.eq(out.bad.length, 0, what + ' (' + tally + ')' +
    (out.bad.length ? ': ' + out.bad.length + ' cross, in ' + shapes.length + ' ' + kind + ':\n  ' + shapes.join('\n  ') : ''));
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
  report(out, 'a key pool rides only its own layer\'s key, a key sent in this request only a pool sent with it, and never a caller\'s endpoint',
    out.rows + ' runs, ' + out.rotating + ' of them with backups to rotate onto', 'run shapes');
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

/* ================= 4. the module dialers (S6): each sends a key only to the endpoint saved with it ================= */
// what each module-level dialer is built with: the store's consumerDeps(), the function index.js uses. On a tree without the
// store, trunk's own wiring of the same modules, as its index.js wrote it, so the same rows report where trunk sent each key.
const consumersOf = api => (api.credStore ? api.credStore.consumerDeps() : {
  media: { providerRuntimeKey: api.key, providerRuntimeBaseUrl: api.baseUrl, getRuntimeKey: () => api.alias() },
  realtime: { hasCredential: p => !!api.key(p, '') },
  webRung: run => { const k = run.providerId === 'openrouter' ? run.runKey : api.alias(); return k ? { apiKey: k, model: run.model } : null; }
});
const AUDIO = Buffer.from('spoken words');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// the network, and nothing else: the free engines answer 503, every other call is recorded and succeeds
const net = calls => async (url, init) => {
  const u = String(url), h = (init && init.headers) || {};
  if (/mojeek\.com|duckduckgo\.com/.test(u)) return { ok: false, status: 503, headers: { get: () => '' }, text: async () => '' };
  let body = {}; try { body = JSON.parse(String(init && init.body)) || {}; } catch (_) { body = {}; }
  calls.push({ url: u, key: String(h.Authorization || h['x-goog-api-key'] || '').replace(/^Bearer\s+/, ''), model: body.model });
  return { ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, arrayBuffer: async () => Buffer.from('CLIP'), text: async () => 'v=0\r\n',
    json: async () => (/:generateContent/.test(u) ? { candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('pcm').toString('base64'), mimeType: 'audio/L16;rate=24000' } }] } }] }
      : { text: 'heard', choices: [{ message: { content: '1. Hit — https://example.test/hit — found', images: [{ image_url: { url: 'data:image/png;base64,' + PNG.toString('base64') } }] } }] }) };
};
const mediaFor = (api, calls, root) => makeMediaService(Object.assign({
  workspaces: root, fs, fsp, fetch: net(calls),
  edgetts: { enabled: () => false, resolveVoice: () => 'v', synth: async () => Buffer.alloc(0) },
  localVoice: { status: () => ({ available: false }), defaultVoice: () => 'v', edgeVoiceFor: () => 'v' },
  nativeStt: { status: () => ({ available: false }) },
  readBody: async req => req.__body, readBodyBuffer: async () => Buffer.alloc(0),
  normalizeProviderId: v => Reg.normalizeProviderId(v, ''), env: () => '', processEnv: {}, redact: String, logger: { error() {}, warn() {}, log() {} },
  now: () => 1784000000000, monotonicNow: () => performance.now(), randomUUID: () => crypto.randomUUID()
}, consumersOf(api).media));
const tts = (media, body) => media.handleTts({ headers: {}, __body: JSON.stringify(Object.assign({ text: 'Census sentence ' + crypto.randomUUID() }, body)) }, {
  headersSent: false, writableEnded: false, destroyed: false, on() {}, writeHead() { this.headersSent = true; }, end() { this.writableEnded = true; } });
const search = (rung, calls) => makeWebTools({ openrouter: rung, lookup: null, politeMinGapMs: 0, fetchImpl: net(calls) }).webSearch('census', {}).catch(() => null);

// one provider's credential by layer: 'k' a key, 'u' an endpoint, in the keychain (a push), the environment and the page copy
function stationOf(p, kc, en, pg) {
  const prof = Reg.getProviderProfile(p);
  const env = {}, patch = {}, rec = {};
  if (kc.includes('k')) patch.key = 'kc';
  if (kc.includes('u')) patch.baseUrl = U.kc;
  if (en.includes('k')) env[prof.keyEnv[0]] = 'en';
  if (en.includes('u')) env[prof.baseUrlEnv[0]] = U.en;
  if (pg.includes('k')) rec.key = 'pg';
  if (pg.includes('u')) rec.baseUrl = U.pg;
  return { p, desc: { kc, en, pg }, label: p + ' K:' + (kc || '-') + ' E:' + (en || '-') + ' P:' + (pg || '-'),
    sc: { env, pushes: kc ? [[p, patch]] : [], kept: { on: !!kc }, page: pg ? { [p]: Object.assign(rec, { rev: 'r1' }) } : undefined } };
}
/* THE ORACLE reads the station's description, never the store. The key a station-side consumer sends: keychain, then
   environment, then page. Where a key may go: the keychain endpoint and the env URL are station-wide overrides; the page
   endpoint goes only with the page's own key, over the env URL; else the provider's default. */
const stationKey = d => (d.kc.includes('k') ? 'kc' : d.en.includes('k') ? 'en' : d.pg.includes('k') ? 'pg' : '');
const homeOf = (d, p, key) => (d.kc.includes('u') ? U.kc : (key === 'pg' && d.pg.includes('k') && d.pg.includes('u')) ? U.pg : d.en.includes('u') ? U.en : Reg.getProviderProfile(p).baseUrl);
function stationsFor(p) {
  const out = [];
  const envShapes = (Reg.getProviderProfile(p).baseUrlEnv || []).length ? ['', 'k', 'ku', 'u'] : ['', 'k'];
  for (const kc of ['', 'k', 'ku', 'u']) for (const en of envShapes) for (const pg of ['', 'k', 'ku', 'u']) {
    const st = stationOf(p, kc, en, pg);
    st.api = impl(st.sc);
    for (const [id, patch] of st.sc.pushes) st.api.push(id, patch);
    out.push(st);
  }
  return out;
}
const hear = m => m.transcribeAudioBuffer(AUDIO, 'webm');
const say = p => m => m.synthesizeForAgent({ text: 'census', only: p, noEdge: true });
// each station-key leg: its name, its provider, what it dials after the endpoint, and how it is driven
const LEGS = [
  ['STT Groq', 'groq', '/audio/transcriptions', hear], ['STT OpenAI', 'openai', '/audio/transcriptions', hear], ['STT OpenRouter', 'openrouter', '/chat/completions', hear],
  ['TTS OpenRouter', 'openrouter', '/audio/speech', say('openrouter')], ['TTS Gemini', 'gemini', '/models/', say('gemini')], ['TTS OpenAI', 'openai', '/audio/speech', say('openai')]
];
// a key the page sent with one request: TTS's three legs, by the provider it names, and STT's OpenRouter leg
const PAGE_LEGS = [['TTS OpenRouter', 'openrouter', '/audio/speech'], ['TTS Gemini', 'gemini', '/models/'], ['TTS OpenAI', 'openai', '/audio/speech'], ['STT OpenRouter', 'openrouter', '/chat/completions']];

async function moduleDialers(root) {
  const out = { rows: 0, bad: [], byShape: new Map() };
  const stations = {};
  for (const p of ['groq', 'openai', 'gemini', 'openrouter']) stations[p] = stationsFor(p);
  // want: the dials a row may make, [[endpoint + what follows it, key, model?]]; a row with no key makes none
  const same = (got, want) => got.length === want.length && want.every((w, i) => got[i].url.startsWith(w[0]) && got[i].key === w[1] && (w.length < 3 || got[i].model === w[2]));
  const row = (st, leg, calls, want) => {
    out.rows++;
    if (same(calls, want)) return;
    out.bad.push(st.label + ' / ' + leg + ': may dial ' + JSON.stringify(want.map(w => w.slice(0, 2))) + ' but dialed ' + JSON.stringify(calls.map(c => [c.url, c.key])));
    out.byShape.set(leg, (out.byShape.get(leg) || 0) + 1);
  };
  for (const [leg, p, after, drive] of LEGS) for (const st of stations[p]) {
    const calls = [], key = stationKey(st.desc);
    await drive(mediaFor(st.api, calls, root));
    row(st, leg, calls, key ? [[homeOf(st.desc, p, key) + after, key]] : []);
  }
  for (const [leg, p, after] of PAGE_LEGS) for (const st of stations[p]) for (const sent of ['pg', 'fo']) {
    const calls = [], media = mediaFor(st.api, calls, root);
    if (leg.startsWith('TTS')) await tts(media, { key: sent, keyProvider: p });
    else await media.transcribeAudioBuffer(AUDIO, 'webm', sent);
    row(st, leg + ', a key the page sent (' + sent + ')', calls, [[homeOf(st.desc, p, sent) + after, sent]]);
  }
  for (const st of stations.openrouter) {
    const key = stationKey(st.desc), c = consumersOf(st.api);
    let calls = [];
    await search(c.webRung({ providerId: 'custom', runKey: 'cus', baseUrl: U.ex, model: 'cus/model' }), calls);
    row(st, 'the web rung on a run on another provider', calls, key ? [[homeOf(st.desc, 'openrouter', key) + '/chat/completions', key, 'openai/gpt-4o-mini']] : []);
    calls = [];
    await search(c.webRung({ providerId: 'openrouter', runKey: 'rk', baseUrl: U.ex, model: 'or/model' }), calls);
    row(st, 'the web rung on a run on OpenRouter', calls, [[U.ex + '/chat/completions', 'rk', 'or/model']]);
    calls = [];
    await search(c.webRung({ providerId: 'starnet', runKey: 'li', baseUrl: 'http://li.test/v1', model: 'or/model' }), calls);
    row(st, 'the web rung on a StarNet-credits run', calls, []);
  }
  const liveVoice = Reg.getProviderProfile('openai').liveVoice;
  for (const st of stations.openai) {
    const key = stationKey(st.desc), calls = [];
    const voice = makeRealtimeVoice(Object.assign({ fetch: net(calls), profileFor: p => (Reg.getProviderProfile(p) || {}).liveVoice || null, resolveCredential: async p => st.api.key(p, ''), safetySeed: 'census' }, consumersOf(st.api).realtime));
    const native = !!key && homeOf(st.desc, 'openai', key) === Reg.getProviderProfile('openai').baseUrl;
    const status = voice.status('openai');
    await voice.createCall('v=0\r\n', 'openai');
    row(st, 'Live Voice', calls, native ? [[liveVoice.url, key]] : []);
    out.rows++;
    const blocked = !!key && !native;
    if (blocked !== /saved with another endpoint/.test(String(status.note || '')) || (blocked && status.mode !== 'composed')) {
      out.bad.push(st.label + ' / Live Voice\'s status: ' + JSON.stringify([status.mode, status.note || '']));
      out.byShape.set('Live Voice\'s status', (out.byShape.get('Live Voice\'s status') || 0) + 1);
    }
  }
  A.ok(out.rows > 900, 'fixture: the dialer table runs every leg over every station (' + out.rows + ' rows)');
  report(out, 'a keyed dialer sends a key only to the endpoint saved with it', out.rows + ' rows', 'legs');

  // a sign-in's bearer is minted for the realtime URL and is no key saved with an endpoint: a stale endpoint never blocks it
  {
    const api = impl({ env: {}, kept: { on: true }, pushes: [] }), calls = [];
    api.push('codex', { baseUrl: U.kc });
    const voice = makeRealtimeVoice(Object.assign({ fetch: net(calls), profileFor: p => (Reg.getProviderProfile(p) || {}).liveVoice || null, resolveCredential: async () => 'bearer', safetySeed: 'census' }, consumersOf(api).realtime, { hasCredential: () => true }));
    await voice.createCall('v=0\r\n', 'codex');
    A.eq(calls.map(c => [c.url, c.key]), [[liveVoice.url, 'bearer']], 'Live Voice: a ChatGPT sign-in still opens natively beside a stale pushed endpoint');
  }
  if (!HAS_STORE) return;   // trunk's image route lives inside index.js's studioRouteFor; its #146 rows are guards, in the e2e

  // the image route: the station's one OpenRouter credential, with the endpoint saved with it, on a station with no other route
  {
    const bad = [];
    for (const st of stations.openrouter) {
      const key = stationKey(st.desc);
      const r = ImageTask.resolveRoute(Object.assign({ providerId: 'custom', runKey: 'cus', providerBaseUrl: U.ex }, consumersOf(st.api).imageRoute()));
      const want = key ? [true, 'openrouter', key, homeOf(st.desc, 'openrouter', key)] : [false, undefined, undefined, undefined];
      if (JSON.stringify([r.ok, r.provider, r.key, r.baseUrl]) !== JSON.stringify(want)) bad.push(st.label + ': ' + JSON.stringify(r));
    }
    A.eq(bad, [], 'the image route takes the one OpenRouter credential at the endpoint saved with it (' + stations.openrouter.length + ' stations)');
    const st = stationOf('openrouter', '', '', 'ku');
    const api = impl(st.sc), calls = [];
    const route = ImageTask.resolveRoute(Object.assign({ providerId: 'custom', runKey: 'cus' }, consumersOf(api).imageRoute()));
    const T = makeImageTools({ openrouter: { apiKey: route.key, model: 'm', baseUrl: route.baseUrl, provider: route.provider, protocol: route.protocol }, fsp, pathMod: path, root, fetchImpl: net(calls) });
    await T.generateTool.run({ prompt: 'census' }, { agentId: 'census', emit: () => {} });
    A.eq(calls.map(c => [c.url, c.key]), [[U.pg + '/chat/completions', 'pg']], 'the image tool dials that endpoint with that key');
  }
}

/* ================= 5. the one credential, and its rank (decision 1) ================= */
function rankRows() {
  const cred = (sc, p) => { const api = impl(sc); for (const [id, patch] of sc.pushes || []) api.push(id, patch); return api.credStore.credentialFor(p || 'openrouter'); };
  const shell = v => ({ STARNET_DESKTOP_SHELL: '1', STARNET_OPENROUTER_KEY: v, SKYNET_OPENROUTER_KEY: v });
  const def = Reg.getProviderProfile('openrouter').baseUrl;
  for (const [label, sc, want] of [
    ['the desktop\'s spawn key', { env: shell('kc'), kept: { on: true } }, ['kc', def, 'primary', 'keychain']],
    ['a pushed key', { env: {}, kept: { on: true }, pushes: [['openrouter', { key: 'kc', baseUrl: U.kc }]] }, ['kc', U.kc, 'primary', 'keychain']],
    ['a headless STARNET_OPENROUTER_KEY', { env: { STARNET_OPENROUTER_KEY: 'br', STARNET_OPENROUTER_BASE: U.br } }, ['br', U.br, 'primary', 'environment']],
    ['a headless SKYNET_OPENROUTER_KEY', { env: { SKYNET_OPENROUTER_KEY: 'sk' } }, ['sk', def, 'primary', 'environment']],
    ['a bare OPENROUTER_KEY', { env: { OPENROUTER_KEY: 'en', OPENROUTER_BASE: U.en } }, ['en', U.en, 'gap', 'environment']],
    ['a bare OPENROUTER_API_KEY', { env: { OPENROUTER_API_KEY: 'en2' } }, ['en2', def, 'gap', 'environment']],
    ['a branded OPENROUTER_API_KEY, which the alias never covered', { env: { STARNET_OPENROUTER_API_KEY: 'br2' } }, ['br2', def, 'gap', 'environment']],
    ['the page copy', { env: {}, page: { openrouter: { key: 'pg', baseUrl: U.pg, rev: 'r1' } } }, ['pg', U.pg, 'gap', 'page']],
    ['a branded export the shell\'s REMOVE leaves behind', { env: { STARNET_OPENROUTER_KEY: 'br' }, kept: { on: true }, pushes: [['openrouter', { key: '' }]] }, ['br', def, 'gap', 'environment']],
    ['nothing', { env: {} }, ['', '', 'gap', 'none']]
  ]) {
    const c = cred(sc);
    A.eq([c.key, c.baseUrl, c.rank, c.source], want, 'credentialFor(openrouter), ' + label);
  }
  A.eq(cred({ env: {} }, 'nosuch-provider').key, '', 'credentialFor: an unknown provider has no credential, never OpenRouter\'s');
  const api = impl({ env: {} });
  A.eq(api.credStore.endpointFor('nosuch-provider', 'k'), '', 'endpointFor: an unknown provider has no endpoint');
  A.eq(api.credStore.consumerDeps().webRung({ providerId: 'openrouter', runKey: '', baseUrl: U.ex, model: 'm' }), null, 'webRung: a run on OpenRouter with no key arms nothing');
  A.eq(Object.keys(api.credStore.consumerDeps()).sort(), ['imageRoute', 'media', 'realtime', 'webRung'], 'consumerDeps: the dependencies of every module-level dialer');
  A.eq(Object.keys(api.credStore.consumerDeps().media).sort(), ['credentialFor', 'endpointFor', 'providerRuntimeKey'], '...and the voice legs have no other way to reach a credential');
}

/* ================= 7. complete pairs (S7, golden deltas D3 and D4): one choice, whole, and no shape crosses ================= */
// one provider's station: what each layer holds, by letter ('k' a key, 'u' an endpoint, 'p' backup keys), for the oracle to read
function pairStation(p, K, E, P) {
  const prof = Reg.getProviderProfile(p);
  const env = {}, patch = {}, rec = {};
  if (K.includes('k')) patch.key = 'kc';
  if (K.includes('u')) patch.baseUrl = U.kc;
  if (K.includes('p')) patch.keyPool = ['kc.p'];
  if (E.includes('k')) env[prof.keyEnv[0]] = 'en';
  if (E.includes('u')) env[prof.baseUrlEnv[0]] = U.en;
  if (E.includes('p')) env['STARNET_KEY_POOL_' + p.toUpperCase()] = 'en.p';
  if (P.includes('k')) rec.key = 'pg';
  if (P.includes('u')) rec.baseUrl = U.pg;
  if (P.includes('p')) rec.keyPool = ['pg.p'];
  return { p, K, E, P, label: p + ' K:' + (K || '-') + ' E:' + (E || '-') + ' P:' + (P || '-'),
    sc: { env, pushes: K ? [[p, patch]] : [], kept: { on: !!K }, page: P ? { [p]: Object.assign(rec, { rev: 'r1' }) } : undefined,
      linked: p === 'starnet' ? { url: 'http://li.test', apiKey: 'li' } : undefined } };
}
const LINKED_URL = 'http://li.test/v1';
const signIn = p => Reg.getProviderProfile(p).authType === 'oauth_device_code';
const layersHolding = s => [['keychain', s.K, 'kc'], ['environment', s.E, 'en'], ['page', s.P, 'pg']].filter(l => l[1].includes('k'));
const pageKey = s => s.P.includes('k') ? 'pg' : null;
// THE ORACLE. Where a key may go, and from which layer that endpoint comes: the keychain endpoint and the env URL are station-wide;
// the page's endpoint goes only with the page's own key, over the env URL; a keyless one only with a keyless run, under the env URL
function pairHomeOf(s, key) {
  const prof = Reg.getProviderProfile(s.p);
  if (s.p === 'starnet') return [LINKED_URL, 'linked'];
  if (s.K.includes('u')) return [U.kc, 'keychain'];
  if (key && key === pageKey(s) && s.P.includes('u')) return [U.pg, 'page'];
  if (s.E.includes('u')) return [U.en, 'environment'];
  if (!key && s.P.includes('u') && !s.P.includes('k')) return [U.pg, 'page'];
  return prof.baseUrl ? [prof.baseUrl, 'default'] : ['', 'none'];
}
const pairHome = (s, key) => pairHomeOf(s, key)[0];
// the station's own choice: the first layer, in key order, whose key has a usable endpoint; none: the first layer's key
function pairChoice(s) {
  if (s.p === 'starnet') return { key: 'li', layer: 'linked' };
  const needsUrl = !!Reg.getProviderProfile(s.p).requiresBaseUrl;
  const held = layersHolding(s).map(l => ({ layer: l[0], key: l[2] }));
  return held.find(h => !needsUrl || pairHome(s, h.key)) || held[0] || { key: '', layer: 'none' };
}
// the backups a run on this key rotates onto when it runs on the station's own endpoint for it: its own layer's (the pool table's rule)
function pairPool(s, key) {
  if (!key) return [];
  const own = [['K', 'kc'], ['E', 'en'], ['P', 'pg']].find(([l, k]) => k === key && s[l].includes('k') && s[l].includes('p'));
  return own ? [key + '.p'] : [];
}
const pairShapes = p => {
  const prof = Reg.getProviderProfile(p);
  const E = ['', 'p'].concat((prof.keyEnv || []).length ? ['k', 'kp'] : [], (prof.baseUrlEnv || []).length ? ['u'] : [], (prof.keyEnv || []).length && (prof.baseUrlEnv || []).length ? ['ku', 'kup'] : []);
  return { K: ['', 'k', 'u', 'ku', 'p', 'kp', 'kup'], E, P: ['', 'k', 'u', 'ku', 'p', 'kup'] };
};
function pairRows() {
  const out = { stations: 0, rows: 0, bad: [], byShape: new Map() };
  const row = (st, shape, got, want) => {
    out.rows++;
    if (JSON.stringify(got) === JSON.stringify(want)) return;
    out.bad.push(st.label + ' / ' + shape + ': ' + JSON.stringify(got) + ', not ' + JSON.stringify(want));
    out.byShape.set(shape, (out.byShape.get(shape) || 0) + 1);
  };
  const missingOf = (st, choice, key, url, source) => {
    const prof = Reg.getProviderProfile(st.p);
    if (prof.requiresBaseUrl && !url) return source === 'environment' ? 'unpaired' : 'baseUrl';
    return (prof.keyRequired && !key) ? 'key' : '';
  };
  for (const p of ['anthropic', 'custom', 'ollama', 'starnet', 'grok']) {
    const sh = pairShapes(p);
    for (const K of sh.K) for (const E of sh.E) for (const P of sh.P) {
      const st = pairStation(p, K, E, P);
      const api = impl(st.sc);
      for (const [id, patch] of st.sc.pushes) api.push(id, patch);
      out.stations++;
      const choice = pairChoice(st), home = pairHome(st, choice.key);
      const namedOk = p !== 'starnet' && !signIn(p);   // StarNet and the sign-ins never take a named endpoint
      // ---- the station's own choice: a gate reads this pair, and the run goes out on it ----
      row(st, 'the station\'s own key', api.key(p, ''), choice.key);
      row(st, 'the station\'s own endpoint', api.baseUrl(p, ''), home);
      row(st, 'the station\'s own endpoint, asked for its key (cronHasCredential)', api.baseUrl(p, '', api.key(p, '')), home);
      for (const [shape, o] of [['the run a gate admits (Run Now, the scheduled fire, a line hop)', { key: api.key(p, '') }], ['the station\'s own run', {}]]) {
        const r = run(api, p, o);
        row(st, shape, [r.runKey, r.baseUrl, r.pool], [choice.key, home, pairPool(st, choice.key)]);
      }
      // ---- every key under every shape: each goes only to its own home, and is never swapped ----
      for (const k of ['kc', 'en', 'pg', 'fo']) {
        const want = pairHome(st, k);
        const held = layersHolding(st).some(l => l[2] === k);
        if (p !== 'starnet') row(st, 'an explicit key is never swapped', api.key(p, k), k);
        row(st, 'the run key', api.baseUrl(p, '', k), want);
        row(st, 'the caller\'s key with no run key (a hub\'s secrets(), the fallback loop, the catalog)', api.baseUrl(p, '', undefined, k), want);
        row(st, 'a record handing it back', api.baseUrl(p, '', k, k), want);
        row(st, 'sent in this request', api.baseUrl(p, '', k, k, true), want);
        row(st, 'a record naming an endpoint beside it', api.baseUrl(p, U.ex, k, k), namedOk && !held ? U.ex : want);
        row(st, '...with no run key', api.baseUrl(p, U.ex, undefined, k), namedOk && !held ? U.ex : want);
        row(st, 'sent in this request with an endpoint', api.baseUrl(p, U.ex, k, k, true), namedOk ? U.ex : want);
      }
      // ---- no key sent: a body or a record naming an endpoint, and a keyless run ----
      row(st, 'a keyless caller naming an endpoint', api.baseUrl(p, U.ex), namedOk && !choice.key ? U.ex : home);
      if (p !== 'starnet') row(st, 'a keyless run', api.baseUrl(p, '', ''), pairHome(st, ''));
      if (!HAS_STORE) continue;
      // ---- the one resolution says the same, and what is missing ----
      const source = p === 'starnet' ? 'linked' : signIn(p) ? 'sign-in' : choice.layer;
      const r = api.credStore.resolve(p);
      row(st, 'resolve', [r.key, r.baseUrl, r.keyPool, r.source, r.endpointSource, r.rank, r.complete, r.missing],
        [choice.key, home, pairPool(st, choice.key), source, pairHomeOf(st, choice.key)[1], (choice.key && choice.key === 'kc') ? 'primary' : 'gap',
          !missingOf(st, choice, choice.key, home, source), missingOf(st, choice, choice.key, home, source)]);
      if (p !== 'starnet') {
        const own = api.credStore.resolve(p, { explicitKey: 'fo' });
        row(st, 'resolve, a caller\'s own key', [own.key, own.baseUrl, own.keyPool, own.source, own.missing, own.rank],
          ['fo', pairHome(st, 'fo'), [], 'explicit', missingOf(st, null, 'fo', pairHome(st, 'fo'), 'explicit'), 'gap']);
        const sent = api.credStore.resolve(p, { explicitKey: choice.key || 'fo', explicitBaseUrl: U.ex, explicitPool: ['sent.p'], inRequest: true });
        row(st, 'resolve, sent in this request with its endpoint and pool', [sent.baseUrl, sent.keyPool], [namedOk ? U.ex : pairHome(st, choice.key || 'fo'), ['sent.p']]);
        const bare = api.credStore.resolve(p, { explicitKey: choice.key || 'fo', inRequest: true });
        row(st, 'resolve, sent in this request with no pool', bare.keyPool, []);
      }
      if (p === 'custom') {
        const said = api.refusal(p, 'this routine');
        const unpaired = !home && choice.layer === 'environment';
        row(st, 'the refusal says what resolve names', [/^CUSTOM_OPENAI_KEY is set in the environment/.test(said), /saved without a key/.test(said)],
          [unpaired, unpaired && P.includes('u') && !P.includes('k')]);
      }
    }
  }
  A.ok(out.stations === 882 && out.rows > (HAS_STORE ? 35000 : 30000), 'fixture: the pair table runs every station under every shape (' + out.stations + ' stations, ' + out.rows + ' rows)');
  report(out, 'the station\'s own choice is a complete pair, a key is never swapped, and no shape hands a key an endpoint saved for another', out.rows + ' rows', 'shapes');

  // the rows the probes named, one by one
  const P3B = pairStation('custom', '', 'k', 'ku'), P3C = pairStation('custom', '', 'k', 'u');
  const b = impl(P3B.sc), c = impl(P3C.sc);
  A.eq([b.key('custom', ''), b.baseUrl('custom', ''), b.presence('custom').unattendedReady, b.presence('custom').keySource], ['pg', U.pg, true, 'station'], 'P3b: the station\'s own choice is the page pair, whole, and presence says so');
  A.eq([b.baseUrl('custom', '', 'en'), b.baseUrl('custom', '', undefined, 'en'), b.baseUrl('custom', U.pg, 'en', 'en')], ['', '', ''], 'P3b: THE ENV KEY NEVER REACHES THE PAGE ENDPOINT, under any shape, named or not (PR #141 sent it there)');
  A.eq([c.key('custom', ''), c.baseUrl('custom', ''), c.presence('custom').unattendedReady], ['en', '', false], 'P3c: a keyless page URL replaces no key, and the env key never goes to it');
  const pooled = impl(pairStation('custom', '', 'kp', 'ku').sc);
  A.eq([pooled.keyPool('custom'), run(pooled, 'custom', { key: 'pg' }).pool], [[], []], 'an env KEY_POOL beside a chosen page pair never rotates behind it (S4 landed first for this)');
  const keychain = impl(pairStation('custom', 'k', '', 'ku').sc);
  keychain.push('custom', { key: 'kc' });
  A.eq([keychain.key('custom', ''), keychain.baseUrl('custom', '')], ['pg', U.pg], 'a keychain key with no endpoint is the same case, and the keychain endpoint would have paired it');
  keychain.push('custom', { baseUrl: U.kc });
  A.eq([keychain.key('custom', ''), keychain.baseUrl('custom', '')], ['kc', U.kc], '...once it has one the keychain key serves again: only a key with no endpoint is looked past');
  const cloud = impl(pairStation('anthropic', '', 'k', 'ku').sc);
  A.eq([cloud.key('anthropic', ''), cloud.baseUrl('anthropic', '')], ['en', Reg.getProviderProfile('anthropic').baseUrl], 'a provider with a default endpoint keeps its env key: a page key never outranks a usable one');
}

/* ================= 6. the census: where a credential can leave this process ================= */
// a file's lines with comments blanked, so a line number holds and a host named in a comment is not code
function codeLines(text) {
  let inBlock = false;
  return text.split('\n').map(line => {
    let l = line;
    if (inBlock) { const e = l.indexOf('*/'); if (e < 0) return ''; l = ' '.repeat(e + 2) + l.slice(e + 2); inBlock = false; }
    if (/^\s*\/\*/.test(l) && !l.includes('*/')) { inBlock = true; return ''; }
    if (/^\s*\/\*.*\*\/\s*$/.test(l) || /^\s*\/\//.test(l)) return '';
    return l.replace(/\s\/\/ .*$/, '');
  });
}
const PROVIDER_HOST = /openrouter\.ai\/api|api\.openai\.com|api\.groq\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com|api\.x\.ai|api\.mistral\.ai|api\.deepseek\.com|api\.together\.xyz|api\.fireworks\.ai|api\.perplexity\.ai|api\.cerebras\.ai/;
// a provider host may stand only in the registry's profiles and each adapter's one default constant. A JWT claim's name is not a host.
const HOST_ALLOWED = [
  ['sidecar/providers/registry.js', /./], ['sidecar/providers/anthropic.js', /^\s*const DEFAULT_BASE = /], ['sidecar/providers/gemini.js', /^\s*const DEFAULT_BASE = /],
  ['sidecar/providers/openrouter.js', /^\s*const BASE = /], ['sidecar/realtime-voice.js', /^const OPENAI_REALTIME_URL = /],
  ['sidecar/tools/builtin/image.js', /^\s*const (?:DEFAULT_OR_URL|DEFAULT_OPENAI_IMAGE_URL) = /]
];
const JWT_CLAIM = /\['https:\/\/api\.openai\.com\/(?:auth|profile)'\]/;
/* EVERY PLACE A PROVIDER CREDENTIAL LEAVES: a provider adapter built (selectProvider) or a credential header written. Each has a
   row, which names the dialer and where its key and endpoint come from; section 4 drives the module-level ones. A new site with
   no row fails here, whoever adds it. An adapter under sidecar/providers/ dials what selectProvider built it with. */
const DIALERS = {
  'sidecar/index.js runOnceCore': 'the run adapter, pool rotation and provider fallbacks: one resolution of the key and the endpoint for it',
  'sidecar/index.js providerForRunConfig': 'the station default\'s billed calls (routing fixes, drafted lines): a run config\'s own pair',
  'sidecar/index.js probeChannelRunConfig': 'the channel connect probe: channelRunConfigFor\'s pair',
  'sidecar/index.js runQuestRefreshCycle': 'the quest refresh: cronKeyFor and the endpoint beside it',
  'sidecar/index.js handleLiveDoctor': 'the Live Doctor: the station\'s pair',
  'sidecar/index.js verifyProviderPair': 'the shared probe/validate verifier: a request candidate rides its endpoint; a saved probe resolves its actual saved pair',
  'sidecar/index.js listModelsForProvider': 'the catalog listing: the pair',
  'sidecar/index.js handleCodexModels': 'a sign-in\'s catalog: no API key',
  'sidecar/index.js oauthAccountProvider': 'a sign-in\'s adapter: no API key',
  'sidecar/embed.js embedOpenAI': 'the embedder: embedderFor\'s pair',
  'sidecar/embed.js embedGemini': 'the embedder: embedderFor\'s pair',
  'sidecar/media-service.js ttsSynthKeyed': 'TTS\'s OpenRouter, Gemini and OpenAI legs (section 4)',
  'sidecar/media-service.js sttTranscribe': 'STT\'s Groq and OpenAI legs (section 4)',
  'sidecar/media-service.js transcribeAudioBuffer': 'STT\'s OpenRouter leg (section 4)',
  'sidecar/realtime-voice.js createCall': 'Live Voice (section 4)',
  'sidecar/tools/builtin/web.js openrouterSearch': 'web_search\'s OpenRouter rung (section 4)',
  'sidecar/tools/builtin/image.js orPost': 'the image route, OpenRouter (section 4)',
  'sidecar/tools/builtin/image.js openAIImagePost': 'the image route, OpenAI: resolveRoute\'s key and endpoint',
  'sidecar/tools/builtin/image.js openAIEditPost': 'the image route, OpenAI: resolveRoute\'s key and endpoint',
  'sidecar/tools/builtin/image.js codexImagePost': 'the image route, a sign-in: no API key'
};
// what these send is not a provider key; each has its own store (the plan's notDoing)
const NOT_PROVIDER_KEYS = ['sidecar/channels/matrix.transport.js', 'sidecar/channels/slack.transport.js', 'sidecar/credits-link.js', 'sidecar/credits.js', 'sidecar/maps/community.js',
  'sidecar/mcp/account.js', 'sidecar/mcp/github-device.js', 'sidecar/mcp/transport.google.js', 'sidecar/mcp/transport.http.js', 'sidecar/tools/builtin/keys.js', 'sidecar/tools/builtin/spotify.js', 'sidecar/userprops.js'];
const NOT_PROVIDER_SITES = ['sidecar/tools/builtin/web.js jinaFetch'];   // the KEYS tab's Jina key
const DIALS = /\bselectProvider\(\{|['"`]Bearer ['"`]\s*\+|['"]x-api-key['"]\s*\]?\s*[:=]|['"]x-goog-api-key['"]\s*\]?\s*[:=]/;
/* THE PAIR RULE. A top-level index.js function that reads a provider's key also reads the endpoint for that same provider, so a
   key is never sent to an endpoint resolved for another. The feeders the plan names hand that pair to runOnce or an adapter:
   channel hubs, group turns, overseer review, the dev hub, workers' providerAuth (runOnceCore), /v1, runtime/agent. */
const KEY_ONLY = {
  runWireEnv: 'whether a key exists, never sent',
  resolveProviderCredential: 'Live Voice\'s bearer: the blocker (consumerDeps().realtime) stands in front of its one fixed URL',
  cronKeyFor: 'a gate\'s key: cronHasCredential checks it, and the run resolves the endpoint for it'
};
const FEEDERS = { 'channel hubs': ['channelRunConfigFor'], 'group turns': ['groupSessions'], 'overseer review': ['tickOverseer'], 'the dev hub': ['devHubSecrets'],
  'workers\' providerAuth': ['runOnceCore'], '/v1': ['openaiCompat'], 'runtime/agent': ['handleRuntimeAgent'], 'the Live Doctor': ['handleLiveDoctor'], 'the catalog and the probe': ['listModelsForProvider', 'verifyProviderPair'], 'the embedder': ['embedderFor'] };
/* 8. THE CHANNEL ROWS (step S8). A channel's own credential is resolved as an explicit key for ITS provider and nowhere else, over a
   station of every provider class, each layer holding a key and an endpoint of its own, built by index.js's own wiring. THE ORACLE
   reads the row: on the bot's provider its own key at its own endpoint, with no station pool; on any other provider exactly what
   the station resolves with no channel at all, so an own key can reach no other provider. Then the shapes of an entry: an
   endpoint-only one a station key never rides, an own key no longer held that is refused and never swapped, and the accounts that
   take no channel credential. Tip only: the channel layer has no form at trunk. */
function channelRows() {
  const OWN = 'bot-own-key-0123456789abcdef', OWNU = 'http://bot-own.test/v1';
  const PROVIDERS = ['anthropic', 'openrouter', 'custom', 'ollama'];
  const STATION = p => ({ env: { [{ anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY', custom: 'CUSTOM_OPENAI_KEY', ollama: 'OLLAMA_API_KEY' }[p]]: 'en', [{ anthropic: 'ANTHROPIC_BASE_URL', openrouter: 'OPENROUTER_BASE', custom: 'CUSTOM_OPENAI_BASE_URL', ollama: 'OLLAMA_BASE_URL' }[p]]: U.en, ['STARNET_KEY_POOL_' + p.toUpperCase()]: 'en.p' },
    page: { [p]: { key: 'pg', baseUrl: U.pg, keyPool: ['pg.p'], rev: 'r1' } }, pushes: [[p, { key: 'kc', keyPool: ['kc.p'] }]] });
  const stationFor = (p, q) => {
    const sc = STATION(p), other = q === p ? {} : STATION(q);
    const api = impl({ env: Object.assign({}, sc.env, other.env), page: Object.assign({}, sc.page, other.page) });
    for (const [id, patch] of sc.pushes.concat(other.pushes || [])) api.push(id, patch);
    return api;
  };
  let rows = 0;
  for (const p of PROVIDERS) for (const q of PROVIDERS) {
    const api = stationFor(p, q), id = 'telegram';
    const put = api.credStore.putChannel(id, { provider: p, key: OWN, baseUrl: OWNU });
    A.eq(put.credential.ref, 'channel', 'fixture: ' + p + ': the bot\'s own key is its own');
    const view = api.credStore.channel(id, { provider: p, credential: put.credential });
    const got = api.credStore.resolve(q, { channel: Object.assign({ provider: p }, view) });
    if (q === p) {
      A.eq([got.key, got.baseUrl, got.keyPool, got.source], [OWN, OWNU, [], 'channel'], p + ': a bot\'s own key goes to its own endpoint, with no station pool, whatever the layers hold');
    } else {
      const station = api.credStore.resolve(q);
      A.eq([got.key, got.baseUrl, got.keyPool, got.source], [station.key, station.baseUrl, station.keyPool, station.source], p + ' -> ' + q + ': a bot\'s own credential is not there on another provider');
      A.ok(got.key !== OWN && got.baseUrl !== OWNU, p + ' -> ' + q + ': neither its key nor its endpoint crosses');
    }
    rows++;
  }
  const api = stationFor('custom', 'custom');
  // an endpoint-only entry: a station key never rides it, and a keyless run does
  const endpointOnly = api.credStore.putChannel('discord', { provider: 'custom', baseUrl: OWNU });
  const seen = api.credStore.channel('discord', { provider: 'custom', credential: endpointOnly.credential });
  A.eq([seen.key, seen.baseUrl, endpointOnly.keyPersisted], ['', OWNU, undefined], 'an endpoint-only entry holds no key');
  const rode = api.credStore.resolve('custom', { channel: Object.assign({ provider: 'custom' }, seen) });
  A.ok(rode.baseUrl !== OWNU && rode.key === 'kc', 'a station key never rides a bot\'s endpoint: ' + JSON.stringify([rode.key, rode.baseUrl]));
  const keyless = impl({ env: {} });
  const k2 = keyless.credStore.putChannel('discord', { provider: 'custom', baseUrl: OWNU });
  A.eq(keyless.credStore.resolve('custom', { channel: Object.assign({ provider: 'custom' }, keyless.credStore.channel('discord', { provider: 'custom', credential: k2.credential })) }).baseUrl, OWNU, '...and a keyless run does');
  // an own key no longer held is refused, never swapped for the station's
  for (const keyLost of ['session', 'gone']) {
    const r = api.credStore.resolve('custom', { channel: { provider: 'custom', key: '', baseUrl: OWNU, keyLost } });
    A.eq([r.key, r.baseUrl, r.keyPool, r.complete, r.missing], ['', '', [], false, 'channel-key'], keyLost + ': a bot whose own key is lost is refused, beside three station keys');
    A.eq(api.credStore.resolve('anthropic', { channel: { provider: 'custom', keyLost } }).missing, api.credStore.resolve('anthropic').missing, keyLost + ': ...on its own provider only');
  }
  /* ONE TEST FOR A BOT'S OWN KEY, ON EVERY PATH THAT JUDGES IT (review r1). A key a station layer holds AS ITS KEY (stationHeld,
     the test the connect gate's channelConnectCredential uses) is the station's: the bot follows it, live. A backup key in a
     layer's pool is not the station's to hand a bot: the bot keeps the key it was given as its own (an explicit key, never
     swapped, no station pool), so the key the connect proved is the key the bot runs. Asked of the connect (putChannel), of a
     page save and a push that bring the key in (convertChannels), and of the boot (reconcileChannels 1b; 2 is in
     test/channels.secrets.test.js, which boots over a real channel file). Red at 86ff765db, where these paths counted a pool
     entry as the station's (holds), so a bot given a station backup key ran on the station's primary, another account. */
  const LAYER_KEYS = ['kc', 'en', 'pg'], POOL_KEYS = ['kc.p', 'en.p', 'pg.p'];
  const judged = [];
  for (const k of LAYER_KEYS.concat(POOL_KEYS)) {
    const want = LAYER_KEYS.includes(k) ? 'station' : 'channel';
    judged.push(['connect', k, api.credStore.putChannel('slack', { provider: 'custom', key: k }).credential.ref, want]);
    const boot = stationFor('custom', 'custom');
    const r = boot.credStore.reconcileChannels([{ id: 'slack', provider: 'custom', credential: null, key: k, baseUrl: '', carries: true }], {});
    judged.push(['boot 1b', k, (r.credentials.slack || {}).ref, want]);
  }
  // a bot's own key the page or the shell then saves: as the layer's key it converts; as a backup in a pool it stays the bot's
  for (const [how, bring, want] of [
    ['a page save of it as the page key', s => s.credStore.putPage('custom', { key: 'own-x', keyPool: [] }, {}), 'station'],
    ['a page save of it as a backup', s => s.credStore.putPage('custom', { key: 'pg-new', keyPool: ['own-x'] }, {}), 'channel'],
    ['a push of it as the keychain key', s => s.push('custom', { key: 'own-x' }), 'station'],
    ['a push of it as a backup', s => s.push('custom', { keyPool: ['own-x'] }), 'channel']
  ]) {
    const s = stationFor('custom', 'custom');
    const put = s.credStore.putChannel('signal', { provider: 'custom', key: 'own-x' });
    A.eq(put.credential.ref, 'channel', 'fixture: ' + how + ': the bot is given a key no layer holds');
    bring(s);
    // a conversion tells the host to point the record at the station (index.js channelsFollowStation answers true here) and
    // deletes the entry, so the record as it was reads 'gone'; a bot that keeps its key still reads it
    const view = s.credStore.channel('signal', { provider: 'custom', credential: put.credential });
    judged.push(['convert', how, view.key === 'own-x' ? 'channel' : (view.keyLost === 'gone' ? 'station' : 'lost'), want]);
  }
  A.eq(judged.filter(j => j[2] !== j[3]).map(j => j[0] + ' ' + j[1] + ': ' + j[2] + ' (want ' + j[3] + ')'), [],
    'a key a station layer holds as its key is the station\'s, on every path; a backup key in a pool is the bot\'s own, on every path');
  A.eq(judged.length, 16, 'fixture: every path and every key ran');
  A.eq(api.credStore.putChannel('slack', { provider: 'anthropic', key: 'kc' }).credential.ref, 'channel', 'the same value on another provider is another key');
  // StarNet's linked account and a sign-in take no channel credential, in any shape
  for (const p of ['starnet', 'codex', 'grok', 'kimi']) {
    const r = api.credStore.putChannel('matrix', { provider: p, key: OWN, baseUrl: OWNU });
    A.eq([r.credential, r.keyPersisted, api.credStore.channel('matrix', { provider: p, credential: r.credential })], [{ ref: 'station' }, undefined, { key: '', baseUrl: '', keyLost: '' }], p + ': takes no channel credential');
  }
  A.eq(rows, 16, 'fixture: every provider pair ran');
}
function census() {
  const hosts = [], sites = new Set(), owners = new Map();
  for (const f of sidecarSourceFiles()) {
    const top = f.rel === 'sidecar/index.js';
    let fn = '';
    codeLines(f.text).forEach((l, i) => {
      const m = top ? (/^(?:async )?function\*? (\w+)\(/.exec(l) || /^(?:const|let) (\w+) = /.exec(l)) : /^\s*(?:async )?function\*? (\w+)\(/.exec(l);
      if (m) fn = m[1];
      if (PROVIDER_HOST.test(l) && !JWT_CLAIM.test(l) && !HOST_ALLOWED.some(([rel, re]) => rel === f.rel && re.test(l))) hosts.push(f.rel + ':' + (i + 1) + ' ' + l.trim().slice(0, 110));
      if (DIALS.test(l)) {
        const site = f.rel + ' ' + fn;
        if (!f.rel.startsWith('sidecar/providers/') && !NOT_PROVIDER_KEYS.includes(f.rel) && !NOT_PROVIDER_SITES.includes(site)) sites.add(site);
      }
      if (top && !/^function providerRuntime/.test(l)) {
        const own = owners.get(fn) || { keys: new Set(), urls: new Set() };
        for (const a of l.matchAll(/\bproviderRuntimeKey\(([^,)]+)/g)) own.keys.add(a[1]);
        for (const a of l.matchAll(/\bproviderRuntimeBaseUrl\(([^,)]+)/g)) own.urls.add(a[1]);
        owners.set(fn, own);
      }
    });
  }
  A.eq(hosts, [], 'no provider host stands in code outside the registry\'s profiles and each adapter\'s default constant');
  A.eq(Array.from(sites).filter(s => !DIALERS[s]).sort(), [], 'every place a provider credential leaves this process has a census row');
  A.eq(Object.keys(DIALERS).filter(s => !sites.has(s)).sort(), [], 'every census row still names a dialer');
  const unpaired = [];
  for (const [fn, own] of owners) {
    const lone = Array.from(own.keys).filter(k => !own.urls.has(k));
    if (lone.length && !KEY_ONLY[fn]) unpaired.push(fn + ' reads ' + lone.join(', ') + '\'s key with no endpoint for it');
  }
  A.eq(unpaired, [], 'THE PAIR RULE: a function that reads a provider\'s key reads the endpoint for that provider');
  A.eq(Object.keys(KEY_ONLY).filter(fn => !(owners.get(fn) || { keys: new Set() }).keys.size).sort(), [], 'every key-only exception still reads a key');
  for (const [name, fns] of Object.entries(FEEDERS)) {
    A.ok(fns.every(fn => owners.has(fn) && owners.get(fn).keys.size > 0 && owners.get(fn).urls.size > 0), name + ': ' + fns.join(', ') + ' read the pair');
  }

  // a hub's per-message read is one resolve of the bot's own credential (S8)
  A.ok(/credStore\.resolve\(provider, \{ channel: r \}\)/.test(sidecarTopLevelFunction('channelHubSecrets')), 'channel hubs: a hub\'s per-message read is one resolve');
  for (const fn of ['startTelegram', 'startDiscord', 'startGenericChannel']) A.ok(/secrets: \(\) => channelHubSecrets\(/.test(sidecarTopLevelFunction(fn)), 'channel hubs: ' + fn + ' reads it');

  // index.js builds every module-level dialer from consumerDeps, and hands it no other way to a credential. Read as index.js's own
  // text (readSidecarIndex): this row is about how index.js wires the modules, wherever those modules live.
  const idx = codeLines(readSidecarIndex()).join('\n');
  const built = open => { const at = idx.indexOf(open); return at < 0 ? '' : idx.slice(at, idx.indexOf('\n});', at)); };
  A.ok(/\nconst stationConsumers = credStore\.consumerDeps\(\);\n/.test(idx), 'index.js takes its dialers\' dependencies from one consumerDeps() call');
  const media = built('const media = makeMediaService({'), voice = built('const realtimeVoice = makeRealtimeVoice({');
  A.ok(/\.\.\.stationConsumers\.media,/.test(media) && !/providerRuntimeKey|providerRuntimeBaseUrl|getRuntimeKey|credStore/.test(media), 'the media service is wired from consumerDeps, and nothing else hands it a credential');
  A.ok(/\.\.\.stationConsumers\.realtime,/.test(voice) && !/hasCredential:/.test(voice), 'Live Voice is wired from consumerDeps');
  A.ok(/\.\.\.stationConsumers\.imageRoute\(\),/.test(sidecarTopLevelFunction('studioRouteFor')), 'the image route is wired from consumerDeps');
  A.ok(!/stationOpenRouterKey|stationOpenRouterFill/.test(sidecarTopLevelFunction('studioRouteFor')), '...with one credential: the #146 second rung is gone');
  A.ok(/\n  const webRung = stationConsumers\.webRung\(\{ providerId, runKey, baseUrl, model \}\);\n/.test(core) && /\n    openrouter: webRung, keyGone: toolKeyGone\(webRung, 'web_search'\),\n/.test(core),
    'the web rung is wired from consumerDeps (and watched in flight: loop.credential-live)');
  A.ok(!/\bruntimeKey\b/.test(idx), 'the runtimeKey alias is gone from index.js');
}

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cs-no-crossing-'));
  try {
    await moduleDialers(root);
    if (HAS_STORE) rankRows();
    if (HAS_STORE) channelRows();
    pairRows();
    census();
  } catch (e) {
    A.ok(false, 'the dialer sections threw: ' + ((e && e.stack) || e));
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
  A.report('credential-store.no-crossing');
})();
