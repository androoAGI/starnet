'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const A = require('./_assert.js');
const src = fs.readFileSync(require.resolve('../frontend/app/app.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../frontend/index.html'), 'utf8');
assert.match(html, /class="prov" data-prov="azure"/);
assert.match(html, /id="in-azure-deployment"/);

async function attempt({ endpoint = 'https://resource.openai.azure.com', deployment = 'enterprise-deployment', rejected = false } = {}) {
  const elements = {};
  for (const id of ['in-name', 'connect-msg', 'in-base-url', 'in-model', 'in-key', 'in-azure-deployment']) elements[id] = { value: '', textContent: '' };
  elements['in-base-url'].value = endpoint;
  elements['in-azure-deployment'].value = deployment;
  elements['in-model'].value = 'foreign-openrouter-model';
  elements['in-key'].value = 'synthetic-test-key';
  const seen = { connects: [], preflights: 0 };
  const Harness = { connectAzure: async config => { seen.connects.push(config); if (rejected) throw new Error('Azure rejected deployment'); } };
  const run = Function('Harness', 'elements', 'seen', `
    const el=id=>elements[id], SFX={boot(){},open(){}}, stopCodexPoll=()=>{}, stopStarnetLinkPoll=()=>{}, stopStarnetBalancePoll=()=>{}, wakeBtnBusy=()=>{};
    const normalizeProviderId=p=>p, isOAuthProviderId=()=>false, pickedProvider='azure';
    const preflightWire=async()=>{seen.preflights++;return {ok:false,why:'intentional test stop before ceremony'}};
    ${A.fnBody(src, 'function providerNeedsBaseUrl(')}
    ${A.fnBody(src, 'async function onWakeAttempt(')}
    return onWakeAttempt();
  `);
  await run(Harness, elements, seen);
  return { ...seen, message: elements['connect-msg'].textContent };
}

(async () => {
  let result = await attempt({ endpoint: '' });
  assert.match(result.message, /Azure resource endpoint/);
  assert.equal(result.connects.length, 0);
  result = await attempt({ deployment: '' });
  assert.match(result.message, /Azure deployment name/);
  assert.equal(result.connects.length, 0, 'a foreign model ID never fills in for a missing deployment');
  result = await attempt();
  assert.deepEqual(result.connects, [{ baseUrl: 'https://resource.openai.azure.com', key: 'synthetic-test-key', model: 'enterprise-deployment' }]);
  assert.equal(result.preflights, 1);
  await assert.rejects(attempt({ rejected: true }), /Azure rejected deployment/);

  const elements = { 'model-count': { textContent: '' }, 'in-model': { value: '', placeholder: '' }, 'in-azure-deployment': { value: '' } };
  const load = Function('elements', 'Harness', `
    const el=id=>elements[id], normalizeProviderId=p=>p, pickedProvider='azure';
    const localStorage={getItem:()=>null}; let genesisModels=[],genesisOffline=true;
    const updateHint=()=>{};
    ${A.fnBody(src, 'async function loadModels(')}
    return loadModels('azure');
  `);
  await load(elements, { listModels: () => { throw new Error('Azure onboarding must not use a public model catalog'); } });
  assert.equal(elements['in-model'].value, '', 'no fabricated public model default');
  assert.match(elements['model-count'].textContent, /Azure deployment name/);
  console.log('genesis-azure.test: OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
