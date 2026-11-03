/* node test/redact.known-values.test.js — redact() coverage added by the 2026-09-25 secrets audit:
   known-VALUE scrubbing (shapeless secrets), JSON-quoted credential fields, the missing vendor shapes, and the
   collector that feeds the known-value layer from the sidecar's live stores.
   The last section is the PROVIDER PART of that list (credential-store lane, step S5): the credential store's
   secretValues(), over a station built by index.js's own wiring and read through index.js's own held lists
   (test/helpers/credential-store-sandbox.js wiredImpl and heldValues). Every layer's keys and pools, the environment's
   included, and the credential parts of every endpoint a layer holds, never a whole URL; a placeholder env key of a
   provider that takes no key stays ordinary text (decision 8); the helper-environment list stays the one trunk held. On a
   tree without the store (trunk) that section reports one failure and the rest still runs. */
'use strict';
const A = require('./_assert.js');
const { redact, setKnownSecretSource } = require('../sidecar/context.js');
const { collectSecretValues } = require('../sidecar/secret-values.js');

// ---- JSON-quoted credential fields (cat codex/tokens.json used to pass straight through) ----
{
  const tokensJson = JSON.stringify({ access_token: 'opaqueAccess123456', refresh_token: 'opaqueRefresh987654', id_token: 'opaqueId555555', client_secret: 'cs-plain-value-1' }, null, 2);
  const out = redact(tokensJson);
  for (const v of ['opaqueAccess123456', 'opaqueRefresh987654', 'opaqueId555555', 'cs-plain-value-1']) A.ok(out.indexOf(v) < 0, 'JSON-quoted field value scrubbed: ' + v);
  A.ok(/"refresh_token": "\[redacted-secret\]"/.test(out), 'the JSON stays readable around the marker');
  A.ok(redact("password: 'hunter22'").indexOf('hunter22') < 0, 'single-quoted YAML value scrubbed');
  A.eq(redact('api_key=abcd1234&x=1'), 'api_key=[redacted-secret]&x=1', 'unquoted query-string form unchanged');
  A.eq(redact('the token budget is fine'), 'the token budget is fine', 'prose mentioning "token" is untouched');
}

// ---- vendor shapes that were missing ----
{
  const samples = {
    discord: 'MTA5ODc2NTQzMjEwOTg3NjU0Mw.GAbCdE.abcdefghijklmnopqrstuvwxyz0123456789ab',
    slackApp: 'xapp-1-A0123456789-1234567890123-abcdef0123456789',
    slackRefresh: 'xoxe-1-My0xLTEyMzQ1Njc4OTAtMTIzNDU2',
    matrix: 'syt_YWxpY2U_ZlUJyXvZaOqPaQwRyNeF_1a2b3c',
    googleRefresh: '1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    groq: 'gsk_abcdefghijklmnopqrstuvwxyz012345',
    perplexity: 'pplx-abcdefghijklmnopqrstuvwxyz0123',
    notion: 'ntn_abcdefghijklmnopqrstuvwxyz0123456',
    linear: 'lin_api_abcdefghijklmnopqrstuvwxyz0123',
    sendgrid: 'SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789',
    triggerSecret: 'whk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_'
  };
  for (const [name, v] of Object.entries(samples)) A.ok(redact('value: ' + v + ' end').indexOf(v) < 0, 'vendor shape scrubbed: ' + name);
  A.eq(redact('see docs.example.com/a.b.c for v1.2.3'), 'see docs.example.com/a.b.c for v1.2.3', 'ordinary dotted text survives the Discord shape');
}

// ---- known-value layer ----
{
  A.eq(redact('plain shapeless ABCdef123456'), 'plain shapeless ABCdef123456', 'no source registered: shapeless value passes (baseline)');
  let live = ['ABCdef123456', 'short', ' padded-secret-value ', 'ABCdef123456-longer-variant'];
  setKnownSecretSource(() => live);
  A.eq(redact('echo -> ABCdef123456'), 'echo -> [redacted-secret]', 'a registered shapeless value is scrubbed');
  A.eq(redact('ABCdef123456-longer-variant'), '[redacted-secret]', 'longest match first: no partial tail survives');
  A.eq(redact('short and sweet'), 'short and sweet', 'values under 8 chars are ignored (too collision-prone)');
  A.ok(redact('x padded-secret-value y').indexOf('padded-secret-value') < 0, 'registered values are trimmed before matching');
  const nested = redact({ a: ['in array ABCdef123456'], b: { c: 'deep ABCdef123456' }, n: 5 });
  A.eq(nested, { a: ['in array [redacted-secret]'], b: { c: 'deep [redacted-secret]' }, n: 5 }, 'objects and arrays are scrubbed recursively');
  live = ['rotated-new-key-000111'];
  A.ok(redact('now rotated-new-key-000111').indexOf('rotated') < 0, 'the source is read live: a rotated key is covered immediately');
  setKnownSecretSource(() => { throw new Error('store locked'); });
  A.eq(redact('sk-or-v1-abcdefghijklmnop'), '[redacted-key]', 'a throwing source degrades to shape redaction, never a crash');
  setKnownSecretSource(null);
}

// ---- object copies never re-create __proto__ ----
{
  const parsed = JSON.parse('{"__proto__": {"polluted": true}, "ok": "v"}');
  const out = redact(parsed);
  A.eq(Object.keys(out), ['ok'], 'a parsed __proto__ member is dropped from the redacted copy');
  A.ok(out.polluted === undefined && Object.getPrototypeOf(out) === Object.prototype, 'the copy is not re-parented');
}

// ---- the collector over the sidecar's real store shapes ----
{
  const vals = collectSecretValues([
    { values: ['provider-key-aaaa', '', null, ['pool-key-bbbb', 'pool-key-cccc']] },
    { keyed: { telegram: { token: 'tg-token-dddd', model: 'm', ownerId: '12345' }, slack: { token: 'xoxb-part-eeee xapp-part-ffff' } } },
    { keyed: { access_token: 'codex-access-gggg', refresh_token: 'codex-refresh-hhhh', last_refresh: '2026-01-01', auth_mode: 'chatgpt' } },
    { keyed: { byId: { gh: { accessToken: 'oauth-at-iiii', refreshToken: 'oauth-rt-jjjj', tokenEndpoint: 'https://x/token' } }, clients: { 'https://as': { clientId: 'public-id', clientSecret: 'client-sec-kkkk' } } } },
    { keyed: [{ id: 'c1', url: 'https://mcp.example', token: 'conn-token-llll', headers: { 'X-Custom': 'hdr-val-mmmm' }, env: { ANYTHING: 'env-val-nnnn' } }], allUnder: ['headers', 'env'] },
    { keyed: [{ id: 'acme-api', name: 'Acme API', envVar: 'ACME_API_KEY', key: 'svc-key-oooo', last4: 'oooo' }] }
  ]);
  for (const v of ['provider-key-aaaa', 'pool-key-bbbb', 'pool-key-cccc', 'tg-token-dddd', 'xoxb-part-eeee', 'xapp-part-ffff', 'codex-access-gggg', 'codex-refresh-hhhh', 'oauth-at-iiii', 'oauth-rt-jjjj', 'client-sec-kkkk', 'conn-token-llll', 'hdr-val-mmmm', 'env-val-nnnn', 'svc-key-oooo'])
    A.ok(vals.indexOf(v) >= 0, 'collected: ' + v);
  for (const v of ['m', '12345', 'https://x/token', 'public-id', 'https://mcp.example', 'Acme API', 'ACME_API_KEY', 'chatgpt', '2026-01-01'])
    A.ok(vals.indexOf(v) < 0, 'non-secret config is NOT collected: ' + v);
  A.eq(collectSecretValues(null), [], 'no sources -> nothing');
  const cyclic = { token: 'cyc-token-pppp' }; cyclic.self = cyclic;
  A.ok(collectSecretValues([{ keyed: cyclic }]).indexOf('cyc-token-pppp') >= 0, 'a cyclic object is walked with a depth cap, not a hang');
}

// ---- the provider part: what the credential store holds (credential-store lane, step S5) ----
{
  let G = null, CS = null;
  const SV = require('../sidecar/secret-values.js');
  try { G = require('./helpers/credential-store-sandbox.js'); CS = require('../sidecar/credential-store.js'); } catch (_) { G = null; }
  A.ok(!!(G && CS && SV.SECRET_SHAPES), 'S5: the credential store and the redaction shapes it is handed are on this tree');
  if (G && CS && SV.SECRET_SHAPES) {
    const T = {
      mistral: 'Qm9wZ3JhbW1pbmdJc0Z1bjEyMzQ1Njc4OTBh',      // MISTRAL_API_KEY: a keyed provider's env key, no vendor prefix
      mistralPool1: 'mistralPoolOne0c4e8a2f6b1d9e3a7c5f',     // STARNET_KEY_POOL_MISTRAL
      mistralPool2: 'mistralPoolTwo9b3d7f1a5c8e2b6d0a4c',
      anthropicBare: 'anthropicUserExport0123456789abcd',     // a bare ANTHROPIC_API_KEY: the env layer's key
      plainKeyed: 'plainword',                                 // a keyed provider's env key is held whole, whatever it looks like
      alias: 'brandedOpenRouterAlias0123456789ab',            // STARNET_OPENROUTER_KEY: the alias, a keychain value
      customToken: 'customPoolToken0123456789abcdefXY',       // a CUSTOM backup key shaped like a token
      path: 'PathTok0123456789abcdefgh',                       // CUSTOM_OPENAI_BASE_URL /t/<token>/v1
      password: 'pw9Z8y7X6w5V4u3T2s1R0q',                     // GROQ_BASE_URL user:<password>@
      query: 'qtokA1b2C3d4E5f6G7h8I9j0K1l2M3n4',              // DEEPSEEK_BASE_URL ?api_key=
      pageKey: 'pageFireworksKey0123456789abcd',              // the page copy: key, backup, a token in its endpoint
      pagePool: 'pageFireworksBackup0123456789ab',
      pagePath: 'PagePathTok0123456789abcxyz',
      kcKey: 'keychainCerebrasKey0123456789ab',               // the keychain push: key, backup, ?sig= in its endpoint
      kcPool: 'keychainCerebrasBackup012345678',
      kcSig: 'kcSig0a1b2c3d4e5f6g7h8i9j0k1l2'
    };
    const AZURE = 'http://127.0.0.1:9/openai/deployments/gpt-4o/v1?api-version=2024-02-01';
    const env = {
      MISTRAL_API_KEY: T.mistral, STARNET_KEY_POOL_MISTRAL: T.mistralPool1 + ',' + T.mistralPool2, ANTHROPIC_API_KEY: T.anthropicBare,
      PERPLEXITY_API_KEY: T.plainKeyed, STARNET_OPENROUTER_KEY: T.alias,
      CUSTOM_OPENAI_KEY: 'lm-studio', STARNET_KEY_POOL_CUSTOM: 'anything,not-needed,' + T.customToken,
      CUSTOM_OPENAI_BASE_URL: 'http://127.0.0.1:1234/t/' + T.path + '/v1', GROQ_BASE_URL: 'http://operator:' + T.password + '@127.0.0.1:9/v1',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1?api_key=' + T.query, TOGETHER_BASE_URL: AZURE
    };
    const api = G.wiredImpl()({ env, page: { fireworks: { key: T.pageKey, keyPool: [T.pagePool], baseUrl: 'http://127.0.0.1:9/p/' + T.pagePath + '/v1', rev: 'r1' } }, pushes: [] });
    api.push('cerebras', { key: T.kcKey, keyPool: [T.kcPool], baseUrl: 'https://gateway.example/v1?sig=' + T.kcSig });
    const held = G.heldValues(api);
    const known = held.known(), prompt = held.prompt(), child = Array.from(held.childEnv.values());
    const missing = list => Object.keys(T).filter(k => !list.includes(T[k]));
    A.eq(missing(known), [], 'S5: index.js\'s redact() list holds every layer\'s keys and pools, the environment\'s included, and the credential part of every endpoint a layer holds');
    A.eq(missing(prompt), [], 'S5: ...and so does its prompt-scrub list');
    const ordinary = ['lm-studio', 'anything', 'not-needed', 'operator', '2024-02-01', 'gpt-4o', 'deployments', AZURE, env.CUSTOM_OPENAI_BASE_URL,
      env.GROQ_BASE_URL, env.DEEPSEEK_BASE_URL, 'https://gateway.example/v1?sig=' + T.kcSig];
    A.eq(ordinary.filter(v => known.includes(v) || prompt.includes(v)), [], 'S5: neither holds a placeholder env key of a provider that takes no key (decision 8), an ordinary part of an endpoint, or a whole URL');
    A.eq(child.slice().sort(), [T.alias, T.pageKey, T.pagePool, T.kcKey, T.kcPool].sort(),
      'S5: the helper-environment list is the keychain\'s and the page copy\'s keys and pools and the OpenRouter alias, the values trunk held: no environment value, no endpoint part');
    A.eq(held.notes, [], 'S5: no part of the lists failed');

    setKnownSecretSource(() => held.known());
    const out = redact('echo ' + Object.keys(T).map(k => T[k]).join(' / ') + ' end');
    A.eq(Object.keys(T).filter(k => out.includes(T[k])), [], 'S5: redact() scrubs each of them out of a text that prints them bare');
    const plain = 'point the CUSTOM provider at lm-studio, anything works and not-needed does too; the endpoint is ' + AZURE;
    A.eq(redact(plain), plain, 'S5: ...and leaves the placeholders and an endpoint with no credential in it as they were');
    setKnownSecretSource(null);

    // the credential parts of a URL, and the URL masked where they stand (GET /api/providers' currentBaseUrl)
    const parts = u => api.urlSecretParts(u);
    A.eq(parts('http://127.0.0.1:1234/t/' + T.path + '/v1'), [T.path], 'S5: a path segment shaped like a token is a credential part');
    A.eq(parts('http://operator:' + T.password + '@127.0.0.1:9/v1'), [T.password], 'S5: so is the password before the host (the user name is not)');
    A.eq(parts('https://' + T.path + '@git.example/org/repo.git'), [T.path], 'S5: ...unless the user name is shaped like a token');
    A.eq(parts('http://u:p@ss:w0rd-with-at@127.0.0.1/v1'), ['p@ss:w0rd-with-at'], 'S5: a password runs to the authority\'s last @');
    A.eq(parts('http://h.example/v1?api_key=abcd1234&key=k1k2k3k4&model=gpt-4o&sig=' + T.kcSig + '&n=1'), ['abcd1234', 'k1k2k3k4', T.kcSig],
      'S5: a query value named like a credential, whatever its shape');
    A.eq(parts('http://h.example/v1?x=' + T.query), [T.query], 'S5: a query value shaped like a token, whatever its name');
    A.eq(parts('http://h.example/cb#access_token=' + T.query + '&state=abc'), [T.query], 'S5: a fragment parameter too');
    A.eq(parts('http://h.example/v1?token=' + encodeURIComponent('ab+cd/ef=gh12345678')), ['ab%2Bcd%2Fef%3Dgh12345678', 'ab+cd/ef=gh12345678'],
      'S5: an escaped part is held as written and decoded, since a server may echo either');
    A.eq([parts(AZURE), parts(''), parts(null), parts('http://127.0.0.1:11434/v1'), parts('localhost:1234/v1')], [[], [], [], [], []],
      'S5: an Azure-style endpoint (a deployment name, ?api-version=2024-02-01), a local server\'s address and nothing have none');
    A.eq(api.maskedUrl('http://operator:' + T.password + '@127.0.0.1:9/t/' + T.path + '/v1?api_key=' + T.query + '&api-version=2024-02-01'),
      'http://operator:[redacted-secret]@127.0.0.1:9/t/[redacted-secret]/v1?api_key=[redacted-secret]&api-version=2024-02-01',
      'S5: maskedUrl masks each credential part where it stands and keeps the rest as saved');
    A.eq([api.maskedUrl(AZURE), api.maskedUrl(''), api.maskedUrl(undefined)], [AZURE, '', ''], 'S5: ...and returns a URL with none as it is');

    // live: a push changes the list on the very next read
    api.push('cerebras', { key: 'keychainCerebrasRotated01234567' });
    const rotated = G.heldValues(api).known();
    A.ok(rotated.includes('keychainCerebrasRotated01234567') && !rotated.includes(T.kcKey) && rotated.includes(T.kcPool), 'S5: a rotated keychain key is held at once, and the old one no longer');
    // a channel's own credential (S8: the store holds it): its key, and its endpoint by its credential parts
    const chan = 'ChanTok0123456789abcdefghij', chanKey = 'channel-own-key-0123456789';
    api.credStore.putChannel('telegram', { provider: 'custom', key: chanKey, baseUrl: 'http://127.0.0.1:1234/b/' + chan + '/v1' });
    api.credStore.putChannel('telegramBots:123456', { provider: 'custom', baseUrl: 'http://127.0.0.1:9/v1?key=botOwnKey12345678' });
    const withChannels = G.heldValues(api);
    A.ok(withChannels.known().includes(chan) && withChannels.known().includes('botOwnKey12345678') && withChannels.known().includes(chanKey), 'S8: a channel\'s own key and the credential parts of its endpoint are held (a channel\'s and a Telegram bot\'s)');
    A.ok(!Array.from(withChannels.childEnv.values()).some(v => v === chan || v === 'botOwnKey12345678'), 'S5: ...its endpoint parts never in the helper-environment list');
    A.ok(Array.from(withChannels.childEnv.values()).includes(chanKey), 'S8: ...and its own key is, as it was while the record held it');
    api.credStore.dropChannel('telegram');
    A.ok(!G.heldValues(api).known().includes(chanKey), 'S8: a forgotten channel key is held no longer');

    // decision 8 and the environment's read, on a store built directly: an environment this test edits, a clock it moves
    const Reg = require('../sidecar/providers/registry.js');
    const e = {};
    const envFirst = names => { for (const n of names || []) for (const k of [n, 'STARNET_' + n, 'SKYNET_' + n]) { const v = String(e[k] || '').trim(); if (v) return v; } return ''; };
    const make = o => CS.makeCredentialStore(Object.assign({ profile: Reg.getProviderProfile, normalize: v => Reg.normalizeProviderId(v, 'openrouter'),
      normalizeId: v => Reg.normalizeProviderId(v, ''), usesCodex: Reg.providerUsesCodex, linked: () => ({ url: '', apiKey: '' }), envFirst,
      env: s => e['STARNET_' + s] || e['SKYNET_' + s], providerIds: () => Reg.providerIds({ includeInactive: true }), shapes: SV.SECRET_SHAPES }, o || {}));
    const live = make();
    for (const [v, want] of [['not-needed', false], ['lm-studio', false], ['anything', false], ['ollama', false], ['sk-abcdefghijklmnop0123', true], ['customKey0123456789abcdefXYZ', true]]) {
      e.CUSTOM_OPENAI_KEY = v;
      A.eq(live.secretValues().includes(v), want, 'S5 decision 8: CUSTOM_OPENAI_KEY=' + v + (want ? ' looks like a credential, and is held' : ' is ordinary text, never held'));
    }
    delete e.CUSTOM_OPENAI_KEY;
    e.MISTRAL_API_KEY = 'not-needed';
    const pagePlaceholder = make({ page: { get: id => (id === 'custom' ? { key: 'lm-studio' } : null) } });
    A.eq([live.secretValues().includes('not-needed'), pagePlaceholder.secretValues().includes('lm-studio')], [true, true],
      'S5: a keyed provider\'s env key, and a page copy\'s key, are held whole whatever they look like (as page keys were at trunk)');
    let clock = 5000;
    const timed = make({ now: () => clock });
    e.CUSTOM_OPENAI_KEY = 'customKey0123456789abcdefXYZ';
    A.ok(timed.secretValues().includes('customKey0123456789abcdefXYZ'), 'S5: with the host\'s clock the store holds the env key');
    e.CUSTOM_OPENAI_KEY = 'customKeyChanged0123456789abcXYZ';
    clock += 999;
    A.ok(!timed.secretValues().includes('customKeyChanged0123456789abcXYZ'), 'S5: ...and reads the environment layer at most once a second');
    timed.push('cerebras', { key: 'pushedWithinTheSecond0123456789' });
    A.ok(timed.secretValues().includes('pushedWithinTheSecond0123456789'), 'S5: the keychain layer is read live: a push inside that second is held at once');
    clock += 1;
    A.ok(timed.secretValues().includes('customKeyChanged0123456789abcXYZ'), 'S5: a second later the environment is read again');
    const refusal = o => { try { make(o); return ''; } catch (err) { return String(err && err.message); } };
    A.ok(/deps\.shapes\.name must be a function/.test(refusal({ shapes: undefined })), 'S5: a store handed no shapes is refused, never built blind to endpoint parts and placeholders');
    A.ok(/deps\.providerIds must be a function/.test(refusal({ providerIds: undefined })), 'S5: ...as is one that cannot list the providers whose environment it holds');
  }
}

A.report('redact.known-values.test');
