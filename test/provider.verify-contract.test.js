'use strict';
const A = require('./_assert.js');
const { selectProvider } = require('../sidecar/providers/factory.js');
const Reg = require('../sidecar/providers/registry.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function main() {
  for (const p of Reg.listProviderProfiles({ public: false })) {
    const adapter = selectProvider({ provider: p.id, key: 'fixture-key', token: 'fixture-token', baseUrl: 'http://fixture.invalid/v1', fetch: async () => response({}, 401) });
    A.eq(typeof adapter.verifyCredential, 'function', p.id + ' implements the required verification seam');
  }
  A.eq((await makeReplayProvider().verifyCredential()).credentialVerified, false, 'replay can never verify a remote account');
  for (const id of ['openai', 'anthropic', 'gemini', 'openrouter', 'codex', 'grok', 'kimi', 'perplexity']) {
    let status = 200, calls = 0, last;
    const fetch = async (url, init) => {
      calls++; last = { url, init };
      const body = id === 'openrouter' && url.endsWith('/auth/key') ? { data: { label: 'fixture' } } :
        id === 'codex' ? { models: [{ slug: 'fixture' }] } : id === 'gemini' ? { models: [{ name: 'models/fixture', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'fixture' }] };
      return response(body, status);
    };
    const adapter = selectProvider({ provider: id, key: 'fixture-key', token: 'fixture-token', baseUrl: 'http://fixture.invalid/v1', fetch });
    const good = await adapter.verifyCredential({ signal: new AbortController().signal });
    A.eq(good.credentialVerified, true, id + ' fresh native authenticated fixture proves the supplied credential');
    A.ok(last.init.signal && last.init.redirect === 'error', id + ' deadline and no redirect on credential check');
    const before = calls;
    status = 401;
    const rejected = await adapter.verifyCredential({});
    A.ok(calls > before && !rejected.credentialVerified && rejected.status === 'rejected' && rejected.httpStatus === 401,
      id + ' later401 cannot use previous verified/catalog state');
    status = 403;
    A.eq((await adapter.verifyCredential({})).status, 'rejected', id + '403 retained');
    status = 529;
    A.eq((await adapter.verifyCredential({})).status, 'unavailable', id + 'server failure is not a credential rejection');
  }
  const fallback = selectProvider({ provider: 'perplexity', key: 'bad', fetch: async () => response({}, 401) });
  const models = await fallback.listModels();
  A.ok(models.length && models.every(m => m.fallback), 'static compatible roster declares fallback on every row');
  A.eq((await fallback.verifyCredential()).credentialVerified, false, 'static roster cannot approve garbage key');
  const empty = selectProvider({ provider: 'openai', key: 'k', fetch: async () => response({ data: [] }) });
  A.eq((await empty.verifyCredential()).credentialVerified, false, 'empty200 is not proof');
  const offline = selectProvider({ provider: 'gemini', key: 'k', fetch: async () => { throw new Error('fixture offline'); } });
  A.eq((await offline.verifyCredential()).status, 'unreachable', 'network failure remains separate');
  let inferred = 0;
  const custom = selectProvider({ provider: 'custom', key: 'bad', baseUrl: 'http://fixture.invalid/v1', fetch: async url => {
    if (url.endsWith('/models')) return response({ data: [{ id: 'fixture' }] });
    inferred++; return response({ error: { message: 'bad key' } }, 401);
  } });
  const check = await custom.verifyCredential({ signal: new AbortController().signal });
  A.ok(inferred === 1 && check.status === 'rejected', 'public custom catalog must prove its keyed inference wire');
  const local = selectProvider({ provider: 'custom', baseUrl: 'http://fixture.invalid/v1', fetch: async () => response({ data: [{ id: 'fixture' }] }) });
  const health = await local.verifyCredential();
  A.ok(health.ok && health.reachable && !health.credentialVerified, 'keyless endpoint health does not invent a credential');
  let activated = 0;
  const lazy = selectProvider({ provider: 'codex', tokenProvider: async () => { activated++; return 'fixture-token'; }, fetch: async () => response({ models: [{ slug: 'fixture' }] }) });
  A.eq((await lazy.verifyCredential()).credentialVerified, true, 'lazy OAuth verifier uses the activated token adapter');
  A.eq(activated, 1, 'verification activates token once');
  A.report('provider verification: local fixtures only, no real account claim');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
