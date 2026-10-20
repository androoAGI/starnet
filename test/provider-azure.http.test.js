'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  let requests = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'base-model-not-a-deployment' }] }));
    }
    requests++;
    assert.equal(req.url, '/openai/v1/chat/completions');
    assert.equal(req.headers.authorization, undefined);
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    const status = req.headers['api-key'] !== 'test-valid' ? 401 : body.model !== 'deployed-name' ? 404 : 200;
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: 'OK', role: 'assistant' } }] } : { error: { message: 'upstream-secret-not-for-client' } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'azure-test-', timeoutMs: 20000, env: { STARNET_CRON_ENABLED: '0' } });
  try {
    await fixture.start();
    const profiles = await fixture.json('GET', '/api/providers');
    assert.ok(JSON.stringify(profiles.body).includes('Azure Foundry'));
    const check = (key, model = 'deployed-name') => fixture.json('POST', '/api/providers/validate', { provider: 'azure', baseUrl, key, model });
    const missing = await check('test-valid', '');
    assert.equal(missing.body.credentialVerified, false);
    assert.equal(requests, 0);
    const valid = await check('test-valid');
    assert.equal(valid.body.credentialVerified, true);
    assert.equal(valid.body.baseUrl, baseUrl + '/openai/v1');
    assert.equal(valid.body.model, 'deployed-name');
    const countBeforeProbe = requests;
    const probe = await fixture.json('POST', '/api/providers/probe', { provider: 'azure', baseUrl, key: 'test-valid' });
    assert.equal(probe.body.credentialVerified, false, 'catalog alone never verifies deployment access');
    assert.equal(requests, countBeforeProbe, 'background probe makes no inference request');
    const badKey = await check('test-invalid');
    assert.equal(badKey.body.credentialVerified, false);
    assert.match(badKey.body.error, /HTTP 401/);
    const badDeployment = await check('test-valid', 'not-deployed');
    assert.equal(badDeployment.body.credentialVerified, false);
    assert.match(badDeployment.body.error, /HTTP 404/);
    assert.ok(!JSON.stringify([valid.body, badKey.body, badDeployment.body]).includes('test-valid'));
    assert.ok(!JSON.stringify(badKey.body).includes('upstream-secret'));
    console.log('provider-azure.http.test: OK');
  } finally {
    await fixture.dispose();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
