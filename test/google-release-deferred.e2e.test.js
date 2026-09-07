'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { ENDPOINTS } = require('../sidecar/mcp/transport.google.js');
const { RELEASE_DEFERRED, isWorkspaceUrl } = require('../sidecar/mcp/google-client.js');

(async () => {
  assert.equal(RELEASE_DEFERRED, true);
  assert.equal(isWorkspaceUrl('https://gmail.googleapis.com.evil.invalid/x'), false);
  assert.equal(isWorkspaceUrl('https://www.googleapis.com/other/v1'), false);
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-deferred-', timeoutMs: 30000, env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/google-deferred-network.cjs').replace(/\\/g, '/')
  } });
  const configs = Object.entries(ENDPOINTS).map(([id, url]) => ({ id, url, transport: 'http', oauth: true, enabled: true }));
  configs.push({ id: 'legacy-google', url: 'https://gmailmcp.googleapis.com/mcp/v1', transport: 'http', oauth: true, enabled: true });
  const state = { version: 2, configs, oauth: { clients: {}, byId: Object.fromEntries(configs.map(c => [c.id, {
    accessToken: 'DEFERRED_TEST_ACCESS', refreshToken: 'DEFERRED_TEST_REFRESH', expiresAt: 1,
    tokenEndpoint: 'https://oauth2.googleapis.com/token', clientId: '123456-starnettest.apps.googleusercontent.com'
  }])) } };
  const statePath = path.join(fixture.workspace, 'connectors/state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
  const check = async () => {
    const catalog = (await fixture.json('GET', '/api/connectors/catalog')).body;
    const cards = catalog.connectors.filter(c => c.googleApi);
    assert.equal(cards.length, 5);
    assert.ok(cards.every(c => c.releaseDeferred && c.signInAvailable === false && /deferred/.test(c.signInMessage)));
    assert.ok(catalog.groups.flatMap(g => g.connectors).filter(c => c.googleApi).every(c => c.releaseDeferred));
    const rows = (await fixture.json('GET', '/api/connectors')).body.connectors;
    for (const cfg of configs) {
      const row = rows.find(c => c.id === cfg.id);
      assert.ok(row && row.releaseDeferred && !row.enabled && row.state === 'down');
      assert.equal(row.toolCount, 0);
      assert.equal(row.oauthAuthorized, false);
      assert.equal(row.credentialSaved, true);
      const oauth = await fixture.json('POST', '/api/connectors/oauth/start', { id: cfg.id });
      assert.equal(oauth.status, 503);
      assert.equal(oauth.body.code, 'google_release_deferred');
      const reload = await fixture.json('POST', '/api/connectors/refresh', { id: cfg.id });
      assert.equal(reload.body.releaseDeferred, true);
    }
    assert.ok(!JSON.stringify(rows).includes('DEFERRED_TEST_ACCESS'));
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), state, 'boot, sign-in and reload preserve saved preferences and grants');
    assert.equal(fs.existsSync(path.join(fixture.workspace, 'google-network-attempt')), false, 'no initialization or token refresh reaches Google');
  };
  try {
    await fixture.start();
    await check();
    const manual = await fixture.json('POST', '/api/connectors', { id: 'custom-name', transport: 'http', url: ENDPOINTS.gmail, oauth: true });
    assert.equal(manual.status, 503);
    const client = await fixture.json('POST', '/api/connectors/oauth/client', { id: 'gmail', clientId: 'test-client', clientSecret: 'test-secret' });
    assert.equal(client.status, 503);
    await fixture.restart();
    await check();
    const removed = await fixture.json('POST', '/api/connectors/remove', { id: 'gmail' });
    assert.equal(removed.body.removed, true);
    await fixture.restart();
    assert.ok(!(await fixture.json('GET', '/api/connectors')).body.connectors.some(c => c.id === 'gmail'));
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).oauth.byId.gmail, undefined);
    console.log('google-release-deferred: PASS (five services, legacy/custom endpoints, no network, preserved grants, restart, removal)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
