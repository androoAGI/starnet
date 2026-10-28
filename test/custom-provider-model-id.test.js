/* test/custom-provider-model-id.test.js — GitHub #126: a CUSTOM OpenAI-compatible endpoint (Hive's /v3, LiteLLM, vLLM,
   Together…) could not WAKE with its own vendor/model id ("deepseek-ai/deepseek-v4.1-flash").

   Reproduced on v0.13.5 code, end to end (onboarding WAKE → harness key check → sidecar /api/providers/validate → the
   CUSTOM adapter): onboarding validates the key BEFORE it stores its model pick, and the key check sent the STORED
   pick (or none on a fresh install), so the sidecar tested the key on whatever model the endpoint LISTS FIRST. That
   model 400'd, and the adapter then called it "a routed-catalog model id … switch to STARNET or OPENROUTER" — advice
   that is wrong for an endpoint whose own ids are vendor/model. Separately the Model button humanized the typed id
   ("deepseek ai/deepseek v4.1 flash"), so the Commander read it as StarNet stripping the dashes. Locks:
     1. WAKE checks the key on the model the Commander TYPED (fresh install AND a stale stored custom pick), through the
        real onWakeAttempt / validateAndSetKey / handleProviderValidate / CUSTOM adapter.
     2. A CUSTOM endpoint refusing a vendor/model id never gets the routed-catalog hint; the error names the id sent.
        A direct vendor endpoint keeps the hint (it is right there).
     3. The onboarding Model button shows a typed id verbatim; a catalog display name still reads as a name. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('frontend', 'app', 'app.js');
const harness = read('frontend', 'app', 'harness.js');
const sidecar = readSidecarSource();
const setup = read('frontend', 'app', 'overseer-setup.js');
const modeldock = read('frontend', 'app', 'modeldock.js');
const factory = require('../sidecar/providers/factory.js');
const registry = require('../sidecar/providers/registry.js');

const TYPED = 'deepseek-ai/deepseek-v4.1-flash';
const FIRST_LISTED = 'catalog-org/first-listed-model';
const BASE = 'https://hive.test/v3';

// A Hive-shaped endpoint: /models lists a model this key cannot chat with FIRST; the id the Commander typed works.
function fakeEndpoint(chatModels) {
  return async (url, init) => {
    if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: FIRST_LISTED }, { id: TYPED }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse((init && init.body) || '{}');
    chatModels.push(body.model);
    if (body.model !== TYPED) return new Response(JSON.stringify({ error: { message: 'Invalid Model Name' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
}

// The REAL sidecar route, its provider seams bound to the real registry + factory and the fake endpoint.
function sidecarValidate(endpointFetch) {
  const cleanSrc = /function cleanProviderKey\(v\) \{[^\n]*\}/.exec(sidecar)[0];
  const handle = new Function('readBody', 'normalizeProvider', 'getProviderProfile', 'providerUsesCodex', 'providerUsesDeviceOAuth', 'providerRuntimeBaseUrl', 'providerRequiresKey', 'providerRequiresBaseUrl', 'selectProvider', 'noteKeyCheckFailure',
    cleanSrc + '\n' + A.fnBody(sidecar, 'async function handleProviderValidate(') + '\nreturn handleProviderValidate;')(
    async req => req.body, p => registry.normalizeProviderId(p, 'openrouter'), registry.getProviderProfile, registry.providerUsesCodex,
    registry.providerUsesDeviceOAuth, (id, explicit) => String(explicit || ''), registry.providerRequiresKey, registry.providerRequiresBaseUrl,
    opts => factory.selectProvider(Object.assign({}, opts, { fetch: endpointFetch })), () => {});
  return async body => {
    let out = null;
    await handle({ body: JSON.stringify(body) }, { writeHead() {}, end(s) { out = JSON.parse(s); } });
    return out;
  };
}

// The REAL browser key check (validateAndSetKey + postKeyCheck + keyCheckFailure) over a localStorage-shaped store.
function browserHarness(store, validate, sent) {
  const kcSrc = /function keyCheckFailure\(status, j, text\) \{[\s\S]*?\n  \}/.exec(harness)[0];
  const H = new Function('normalizeProviderId', 'getProv', 'getModel', 'getBaseUrl', 'setKey', 'fetch', 'hasStoredCredential',
    "const cleanKey = k => String(k == null ? '' : k).replace(/[\\s\\u200b-\\u200d\\u2060\\ufeff]+/g, '');\n"
    + kcSrc + '\n' + A.fnBody(harness, 'function keyCheckLine(') + '\n' + A.fnBody(harness, 'async function postKeyCheck(') + '\n' + A.fnBody(harness, 'async function validateAndSetKey(')
    + '\nreturn { validateAndSetKey };')(
    p => registry.normalizeProviderId(p, 'openrouter'), () => store.prov, () => store.model, p => store.baseUrl[p] || '',
    async (k, p) => { store.keys[p] = k; return {}; },
    async (route, init) => { const body = JSON.parse(init.body); sent.push(body); const out = await validate(body); return { ok: true, status: 200, text: async () => JSON.stringify(out) }; },
    p => !!store.keys[p]);
  return Object.assign(H, {
    configured: () => true, hasStoredCredential: () => false, setTotals: () => {},
    getModel: () => store.model, setModel: m => { store.model = m; },
    getProv: () => store.prov, setProv: p => { store.prov = p; },
    setBaseUrl: async (u, p) => { store.baseUrl[p] = u; }
  });
}

// The REAL onboarding WAKE (02 Connect a brain → CUSTOM): endpoint + key + typed model id. Preflight stops it after the key check.
async function wake(store) {
  const sent = [], chatModels = [];
  const Harness = browserHarness(store, sidecarValidate(fakeEndpoint(chatModels)), sent);
  const elements = {};
  for (const id of ['in-name', 'connect-msg', 'in-base-url', 'in-model', 'in-key']) elements[id] = { value: '', textContent: '', innerHTML: '', className: '' };
  elements['in-base-url'].value = BASE; elements['in-model'].value = TYPED; elements['in-key'].value = 'test-only-placeholder-key';
  const seen = { preflight: 0 };
  const run = Function('Harness', 'elements', 'seen', `const el=id=>elements[id],SFX={boot(){},open(){}},stopCodexPoll=()=>{},stopStarnetLinkPoll=()=>{},stopStarnetBalancePoll=()=>{},providerNeedsBaseUrl=p=>p==='custom',isOAuthProviderId=()=>false,providerNeedsKey=()=>false,providerSignupUrl=()=>'',providerLabel=()=>'Custom',esc=x=>x,wakeBtnBusy=()=>{};let pickedProvider='custom',codexConnected=false,prefilledKey='',keyOverwriteConfirmed=false,resumingSaved=null;
    const preflightWire=async()=>{seen.preflight++;return{ok:false,why:'test stop after the key check'}};
    ${A.fnBody(app, 'async function onWakeAttempt(')}
    return onWakeAttempt();`);
  let error = null;
  try { await run(Harness, elements, seen); } catch (e) { error = e; }
  return { sent, chatModels, error, preflight: seen.preflight, store };
}

(async () => {
  // ---- 1. WAKE checks the key on the TYPED model ----
  for (const [label, store] of [
    ['fresh install (stored provider is the openrouter default, no model)', { prov: 'openrouter', model: '', baseUrl: {}, keys: {} }],
    ['an earlier CUSTOM pick is still stored', { prov: 'custom', model: 'old-org/old-model', baseUrl: {}, keys: {} }]
  ]) {
    const r = await wake(store);
    A.eq(r.sent.length, 1, label + ': one key check');
    A.eq(r.sent[0] && r.sent[0].model, TYPED, label + ': the key check carries the typed model id');
    A.eq(r.chatModels, [TYPED], label + ': the endpoint is asked only for the typed model, never its first-listed one');
    A.ok(!r.error, label + ': the key check passes (got ' + (r.error && r.error.message) + ')');
    A.eq(r.preflight, 1, label + ': WAKE goes on to the wire test');
    A.eq(r.store.model, TYPED, label + ': the typed id is stored verbatim, dashes, dots and slash intact');
    A.eq(r.store.prov, 'custom', label + ': on the CUSTOM provider');
    A.eq(r.store.keys.custom, 'test-only-placeholder-key', label + ': and the proven key is stored');
  }
  // Settings' key saves pass no model and keep the old rule: the active provider's current pick.
  {
    const sent = [];
    const H = browserHarness({ prov: 'custom', model: TYPED, baseUrl: { custom: BASE }, keys: {} }, sidecarValidate(fakeEndpoint([])), sent);
    await H.validateAndSetKey('test-only-placeholder-key', 'custom');
    A.eq(sent[0] && sent[0].model, TYPED, 'a caller that names no model still checks on the active provider\'s current pick');
  }

  // ---- 2. a CUSTOM endpoint's own vendor/model ids get no routed-catalog hint ----
  const refuse = async () => new Response(JSON.stringify({ error: { message: 'Invalid Model Name' } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const failOf = async (provider, model) => {
    const p = factory.selectProvider({ provider, fetch: refuse, key: 'k', baseUrl: BASE });
    try { for await (const _ of p.stream({ model, messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { return String(e.message); }
    return '';
  };
  const custom = await failOf('custom', 'vendor-org/model-the-endpoint-refuses');
  A.ok(/Invalid Model Name/.test(custom), 'the endpoint\'s own refusal is kept: ' + custom);
  A.ok(!/routed-catalog|STARNET|OPENROUTER|Switch the provider/i.test(custom), 'a CUSTOM endpoint is never told its vendor/model id is a routed-catalog id: ' + custom);
  A.ok(custom.indexOf('"vendor-org/model-the-endpoint-refuses"') >= 0, 'the error names the exact id that was sent: ' + custom);
  const customBare = await failOf('custom', 'bare-model');
  A.ok(customBare.indexOf('"bare-model"') >= 0 && !/routed-catalog/.test(customBare), 'a slashless id on CUSTOM is named too: ' + customBare);
  const vendor = await failOf('openai', 'openai/gpt-5.6-terra');
  A.ok(/routed-catalog model id/.test(vendor) && /Switch the provider/.test(vendor), 'a direct vendor API keeps the routed-catalog hint: ' + vendor);

  // ---- 3. the onboarding Model button shows a typed id verbatim ----
  {
    const elements = { 'ov-model-name': { textContent: '' }, 'ov-model-detail': { textContent: '' }, 'ov-model-dialog': { open: false } };
    const modelLabel = new Function(A.fnBody(modeldock, 'function modelLabel(') + '\nreturn modelLabel;')();
    const reflect = new Function('el', 'ModelDock', 'renderReasoning', 'let currentModel = {};\n' + A.fnBody(setup, 'function reflectModel(') + '\nreturn reflectModel;')(
      id => elements[id], { labels: { model: modelLabel } }, () => {});
    reflect({ id: TYPED, name: TYPED }, 'custom');
    A.eq(elements['ov-model-name'].textContent, TYPED, 'a typed id (no display name) shows exactly as it will be sent');
    reflect({ id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5' }, 'openrouter');
    A.eq(elements['ov-model-name'].textContent, modelLabel({ id: 'openai/gpt-5.5', name: 'OpenAI: GPT-5.5' }), 'a catalog display name still reads as a name');
  }

  A.report('custom-provider-model-id');
})().catch(e => { console.error(e); process.exitCode = 1; });
