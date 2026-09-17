'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const backend = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
function region(source, marker, closing) {
  const start = source.indexOf(marker), end = source.indexOf(closing, start);
  if (start < 0 || end < start) throw Error('Production function not found: ' + marker);
  return source.slice(start, end + closing.length);
}
let models = [], failure = null;
const sandbox = {
  ensureCodexAccessToken: async () => { if (failure) throw failure; return 'fixture-token'; },
  forceRefreshCodexAccessToken: async () => 'fixture-token',
  ensureOAuthAccessToken: async () => { if (failure) throw failure; return 'fixture-token'; },
  selectProvider: () => ({ listModels: async () => models }),
  oauthProviders: { grok: {}, kimi: {} },
  listModelsForProvider: async () => { if (failure) throw failure; return models; },
  globalThis: {},
};
const publicBody = region(backend, 'function publicModel(m)', '\n}\n');
const codexBody = region(backend, 'async function handleCodexModels(', '\n}\n');
const oauthBody = region(backend, 'async function handleOAuthModels(', '\n}\n');
const api = vm.runInNewContext(publicBody + codexBody + oauthBody + '\n({publicModel,handleCodexModels,handleOAuthModels})', sandbox);
async function response(handler, id) {
  let status, body;
  await handler({}, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } }, id);
  return { status, body };
}
module.exports = (async () => {
  models = [{ id: 'offline-seed', fallback: true }, { id: 'live-model' }];
  A.eq(api.publicModel(models[0]).fallback, true, 'generic catalog serialization retains offline provenance');
  A.eq(api.publicModel(models[1]).fallback, false, 'live generic model is not marked as fallback');
  for (const provider of ['codex', 'grok', 'kimi']) {
    const handler = provider === 'codex' ? api.handleCodexModels : api.handleOAuthModels;
    const good = await response(handler, provider);
    A.eq(good.status, 200, provider + ' catalog contract stays HTTP 200');
    A.eq(good.body.models[0].fallback, true, provider + ' serialized seed remains unconfirmed');
    A.eq(good.body.models[1].fallback, false, provider + ' serialized live model retains live provenance');
    failure = new Error('temporary authentication/catalog outage');
    const failed = await response(handler, provider);
    A.eq(failed.status, 200, provider + ' failure still uses the HTTP 200 error contract');
    A.eq(failed.body.error, failure.message, provider + ' failure carries its error body');
    failure = null;
  }
  let payload;
  const browser = vm.runInNewContext(
    region(frontend, '  function normalizeModel(m)', '\n  }\n') +
    'const MODEL_CATALOG_TIMEOUT_MS=6000;\n' +
    region(frontend, '  async function fetchModelCatalog(', '\n  }\n') + '\n({fetchModelCatalog})',
    { AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => payload }) });
  payload = { models: [{ id: 'seed', fallback: true }] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models'))[0].fallback, true, 'Harness keeps row fallback metadata');
  payload = { fallback: true, models: [{ id: 'seed' }] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models'))[0].fallback, true, 'Harness keeps response fallback metadata');
  payload = { models: [], error: 'catalog unavailable' };
  let error;
  try { await browser.fetchModelCatalog('/api/models/custom', 'models'); } catch (e) { error = e; }
  A.eq(error && error.message, 'catalog unavailable', 'Harness rejects an error envelope instead of proving an empty catalog');
  payload = { models: [] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models')).length, 0, 'a successful empty catalog remains a real empty result');
  A.report('model-catalog-truth.test');
})().catch(error => { console.error(error); process.exitCode = 1; });
