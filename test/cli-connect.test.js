'use strict';
/* test/cli-connect.test.js — the terminal's /connect (bin/lib/connect.js + the page's provider.key verb). Locks:
     1. the list IS the app's: SETTINGS › AI & MODELS's PROVIDERS and PROVIDER_GROUPS (frontend/app/stationui.js) — every
        provider, its name, endpoint and blurb, the groups and their order. A provider added to the app fails here until
        the terminal lists it too
     2. each row says only what the station proves (KEY SAVED is presence, a link shows its balance, Claude Code / Ollama
        what their checks found, CHECKING… before they answer); each provider connects its app way (sign-in, link, key)
     3. saveKey: the station's page path is used whole; an older station says so; a station with no page and no
        keychain proves the key first and keeps it only once proven (a refused key is never handed over)
     4. the page's provider.key verb (frontend/app/stationcommands.js): the key is collected once from the slot, proven and
        kept through the app's own Harness.validateAndSetKey; a page that cannot keep it (a browser tab of the desktop
        station) or finds the slot taken never answers, so it cannot out-race the page that saves it */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const A = require('./_assert.js');
const C = require('../bin/lib/connect.js');

/* 1. the app's list, read from the app's own source */
const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
const block = (start) => { const i = src.indexOf(start); const j = src.indexOf('];', i); return src.slice(i + start.length - 1, j + 1); };
const appProviders = (new Function('return ' + block('const PROVIDERS = [').replace(/\/\/[^\n]*/g, '')))();
const appGroups = (new Function('return ' + block('const PROVIDER_GROUPS = [')))();
A.eq(C.PROVIDERS.map(p => [p.id, p.name, p.endpoint, p.blurb]), appProviders.map(p => [p.id, p.name, p.endpoint, p.blurb]), 'every provider of the app, its name, endpoint and blurb, in its order');
A.eq(C.GROUPS.map(g => [g.id, g.label, g.note, g.ids || null]), appGroups.map(g => [g.id, g.label, g.note, g.ids || null]), 'the app\'s four groups');
A.ok(appProviders.every(p => p.live), 'every app provider is live (none is "coming soon" here)');
const grouped = C.ordered().map(p => p.id);
A.eq(grouped.slice(0, 6), ['starnet', 'codex', 'grok', 'kimi', 'claude-cli', 'openrouter'], 'the groups in order: credits, subscriptions, then keys');
A.eq(grouped.slice(-2), ['ollama', 'custom'], 'your own models last');
A.eq(grouped.length, appProviders.length, 'none dropped, none twice');

/* 2. status + flows */
const f = { configured: new Set(['openrouter', 'codex', 'custom']), credits: { state: 'linked', balanceUsd: 4.5 }, claude: { installed: true, loggedIn: true }, ollama: false };
const P = id => C.PROVIDERS.find(p => p.id === id);
A.eq(C.status(P('openrouter'), f), ['● KEY SAVED', 'ok'], 'a saved key: KEY SAVED (presence, never "working")');
A.eq(C.status(P('anthropic'), f)[0], '○ NO KEY', 'no key');
A.eq(C.status(P('codex'), f)[0], '● SIGNED IN', 'a sign-in held');
A.eq(C.status(P('grok'), f)[0], '○ NOT SIGNED IN', 'no sign-in');
A.eq(C.status(P('starnet'), f)[0], '● LINKED · $4.50', 'a link shows its balance');
A.eq(C.status(P('starnet'), { credits: { state: 'linkable' } })[0], '○ NOT LINKED', 'not linked');
A.eq(C.status(P('claude-cli'), f)[0], '● SIGNED IN', 'Claude Code signed in');
A.eq(C.status(P('claude-cli'), { claude: { installed: false } })[0], '○ CLAUDE CODE NOT INSTALLED', 'Claude Code missing');
A.eq(C.status(P('claude-cli'), { claude: null })[0], '○ COULDN’T CHECK CLAUDE CODE', 'a check that failed says so');
A.eq(C.status(P('claude-cli'), {})[0], '◐ CHECKING CLAUDE CODE…', 'before the check answers');
A.eq([C.status(P('ollama'), f)[0], C.status(P('ollama'), { ollama: true })[0]], ['○ NOT ANSWERING', '● REACHABLE'], 'Ollama: what its check found');
A.eq([C.status(P('custom'), f)[0], C.status(P('custom'), {})[0]], ['● ENDPOINT SAVED', '○ NO ENDPOINT'], 'custom: an endpoint');
A.eq(['starnet', 'codex', 'grok', 'kimi', 'claude-cli', 'ollama', 'custom', 'openrouter', 'gemini'].map(C.flowOf), ['credits', 'device', 'device', 'device', 'claude', 'local', 'custom', 'key', 'key'], 'each provider connects its app way');
A.eq(C.brainOf('grok'), { id: 'grok', flow: 'device', path: 'grok' }, 'a device sign-in is the awakening\'s');
A.eq(C.brainOf('anthropic'), null, 'a key provider is no sign-in');
A.eq(C.need(P('codex')), 'ChatGPT subscription', 'a sign-in says its subscription');
A.eq(C.need(P('groq')), 'fast inference', 'a key provider its blurb');
A.eq(['chatgpt', 'Claude', 'claude code', 'OPENAI', 'grok', 'openai api', 'kimi', 'warp', ''].map(w => (C.find(w) || {}).id || null), ['codex', 'claude-cli', 'claude-cli', 'openai', 'grok', 'openai', 'kimi', null, null], 'a typed name finds its provider');
A.eq([C.normEndpoint('localhost:1234/v1'), C.normEndpoint('api.example.com/v1'), C.normEndpoint(''), C.normEndpoint('http://')], ['http://localhost:1234/v1', 'https://api.example.com/v1', '', null], 'an endpoint as the app stores it');

/* 3. saveKey */
(async () => {
  const fake = answers => { const calls = []; return { calls, post: async (p, b) => { calls.push([p, b]); const r = answers[p]; return typeof r === 'function' ? r(b) : r || { ok: true, status: 404, json: {} }; } }; };
  let st = fake({ '/api/providers/connect': { ok: true, status: 200, json: { ok: true, store: 'keychain', verified: true } } });
  A.eq(await C.saveKey(st, 'anthropic', 'k1'), { ok: true, store: 'keychain', verified: true }, 'the page path, whole');
  A.eq(st.calls.map(c => c[0]), ['/api/providers/connect'], '...one call');
  st = fake({});
  A.ok(/older than \/connect/.test((await C.saveKey(st, 'anthropic', 'k1')).error), 'an older station says so');
  st = fake({ '/api/providers/connect': { ok: true, status: 409, json: { ok: false, code: 'open-app', error: 'open StarNet, then try again' } } });
  A.eq(await C.saveKey(st, 'anthropic', 'k1'), { ok: false, error: 'open StarNet, then try again' }, 'the desktop station with its window not loaded: its own words');
  st = fake({ '/api/providers/connect': { ok: true, status: 409, json: { ok: false, code: 'no-page' } }, '/api/providers/validate': { ok: true, status: 200, json: { ok: false, credentialVerified: false, error: 'provider rejected this key (HTTP 401)' } } });
  A.eq(await C.saveKey(st, 'groq', 'bad'), { ok: false, error: 'provider rejected this key (HTTP 401)' }, 'no page: a refused key says why');
  A.eq(st.calls.map(c => c[0]), ['/api/providers/connect', '/api/providers/validate'], '...and is never handed over');
  st = fake({ '/api/providers/connect': { ok: true, status: 409, json: { ok: false, code: 'no-page' } }, '/api/providers/validate': { ok: true, status: 200, json: { ok: true, credentialVerified: true } }, '/api/providers/engine-key': { ok: true, status: 200, json: { ok: true, persisted: true } } });
  A.eq(await C.saveKey(st, 'groq', 'good'), { ok: true, store: 'station', verified: true }, 'no page: proven, then kept by the station');
  A.eq(st.calls.map(c => c[0]), ['/api/providers/connect', '/api/providers/validate', '/api/providers/engine-key'], '...in that order');
  A.eq(st.calls[2][1], { provider: 'groq', key: 'good' }, '...the key and its provider');
  st = fake({ '/api/providers/connect': { ok: true, status: 409, json: { ok: false, code: 'no-page' } }, '/api/providers/engine-key': { ok: true, status: 200, json: { ok: true } } });
  A.eq(await C.saveKey(st, 'custom', '', 'http://localhost:1234/v1'), { ok: true, store: 'station', verified: false }, 'a keyless custom endpoint: saved, never "checked"');
  A.eq(st.calls.map(c => c[0]), ['/api/providers/connect', '/api/providers/engine-key'], '...with no key to prove');

  /* 4. the page's verb */
  const pageSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js'), 'utf8');
  function page(o) {
    const log = { fetches: [], acks: [], saved: [], base: [] };
    const ctx = {
      console, setTimeout, Promise, JSON, Object, Array, String, Error, Number, Boolean, Date, Math, RegExp, Map, Set,
      document: { addEventListener() {} },
      Harness: o.harness === null ? undefined : {
        isDesktop: () => !!o.desktopPage,
        setBaseUrl: (u, p) => { log.base.push([u, p]); return Promise.resolve({}); },
        validateAndSetKey: async (k, p) => { if (o.refuse) throw new Error(o.refuse); log.saved.push([k, p]); return { credentialVerified: true, stored: true }; }
      },
      fetch: async (u, init) => {
        const b = JSON.parse(init.body);
        log.fetches.push(u);
        if (u === '/api/station/ack') { log.acks.push(b); return { ok: true, json: async () => ({}) }; }
        if (u === '/api/providers/connect/take') return o.take ? { ok: true, json: async () => o.take } : { ok: false, status: 404, json: async () => ({}) };
        return { ok: false, status: 404 };
      }
    };
    vm.createContext(ctx);
    vm.runInContext(pageSrc + '\n;this.StationCommands = StationCommands;', ctx);
    return { log, run: args => ctx.StationCommands.run('c1', 'provider.key', args) };
  }
  let pg = page({ desktopPage: true, take: { provider: 'anthropic', key: 'sk-ant-1', baseUrl: '' } });
  await pg.run({ provider: 'anthropic', slot: 's1', desktop: true });
  A.eq(pg.log.saved, [['sk-ant-1', 'anthropic']], 'the desktop window keeps it through the app\'s own validateAndSetKey');
  A.eq(pg.log.acks, [{ id: 'c1', ok: true, result: { provider: 'anthropic', store: 'keychain', verified: true, endpointOnly: false } }], '...and answers where it went');
  pg = page({ desktopPage: false, take: { provider: 'anthropic', key: 'sk-ant-1' } });
  await pg.run({ provider: 'anthropic', slot: 's1', desktop: true });
  A.eq([pg.log.fetches, pg.log.saved], [[], []], 'a browser tab of the desktop station: never collects it, never answers');
  pg = page({ desktopPage: true });
  await pg.run({ provider: 'anthropic', slot: 's1', desktop: true });
  A.eq([pg.log.fetches, pg.log.acks], [['/api/providers/connect/take'], []], 'the slot already taken (another page has it): no answer');
  pg = page({ desktopPage: true, refuse: 'provider rejected this key (HTTP 401) — nothing was saved', take: { provider: 'anthropic', key: 'bad' } });
  await pg.run({ provider: 'anthropic', slot: 's1', desktop: true });
  A.eq(pg.log.acks, [{ id: 'c1', ok: false, error: 'provider rejected this key (HTTP 401) — nothing was saved' }], 'a refused key: the app\'s own reason');
  pg = page({ desktopPage: false, take: { provider: 'custom', key: '', baseUrl: 'http://localhost:1234/v1' } });
  await pg.run({ provider: 'custom', slot: 's1', desktop: false });
  A.eq([pg.log.base, pg.log.saved, pg.log.acks[0].result.endpointOnly, pg.log.acks[0].result.store], [[['http://localhost:1234/v1', 'custom']], [], true, 'browser'], 'a browser station\'s page: a keyless custom endpoint is saved as the card saves it');
  pg = page({ harness: null, take: { provider: 'anthropic', key: 'k' } });
  await pg.run({ provider: 'anthropic', slot: 's1', desktop: false });
  A.eq(pg.log.fetches, [], 'a page with no provider keys loaded stays quiet');

  A.report('cli-connect.test');
})().catch(e => { console.error(e); process.exit(1); });
