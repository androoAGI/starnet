'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeConnectorVault } = require('../sidecar/connector-vault.js');
const { FILE_SCOPE } = require('../sidecar/mcp/google-client.js');
(async () => {
  const keyHex = '34'.repeat(32);
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-files-', env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_CONNECTOR_ENCRYPTION_KEY: keyHex,
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/google-files-preload.cjs').replace(/\\/g, '/')
  } });
  const file = path.join(fixture.workspace, 'connectors/state.json');
  const vault = () => makeConnectorVault({ fs, path, keyHex });
  const start = async () => {
    const r = await fixture.json('POST', '/api/connectors/oauth/start', { id: 'google-files' });
    assert.equal(r.status, 200);
    const u = new URL(r.body.url);
    assert.equal(u.searchParams.get('scope'), FILE_SCOPE);
    assert.equal(u.searchParams.get('trigger_onepick'), 'true');
    assert.equal(u.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    return u.searchParams.get('state');
  };
  const finish = async (state, code = 'google-files:good', ids = 'doc1,sheet1') => (await fixture.request('/api/connectors/oauth/callback?' + new URLSearchParams({ state, code, picked_file_ids: ids }))).text();
  try {
    await fixture.start();
    const cards = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors;
    assert.equal(cards.find(c => c.id === 'google-files').signInAvailable, true);
    for (const id of ['gmail', 'google-drive', 'google-docs', 'google-sheets', 'google-calendar']) {
      assert.equal((await fixture.json('POST', '/api/connectors/oauth/start', { id })).body.code, 'google_release_deferred');
    }
    assert.match(await finish(await start()), /connected/);
    assert.deepEqual(vault().load(file).oauth.byId['google-files'].pickedFileIds, ['doc1', 'sheet1']);
    const saved = fs.readFileSync(file, 'utf8');
    assert.ok(!saved.includes('GOOGLE_ACCESS_TEST'));
    assert.match(await finish(await start(), 'google-drive:good'), /permissions changed/);
    assert.equal(fs.readFileSync(file, 'utf8'), saved, 'broader grants never replace the limited grant');
    assert.match(await finish(await start(), 'google-files:good', ''), /No Google files selected/);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
    const cancelled = await start();
    await fixture.json('POST', '/api/connectors/oauth/cancel', { id: 'google-files' });
    assert.match(await finish(cancelled), /expired/);
    await fixture.restart();
    const row = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'google-files');
    assert.equal(row.state, 'up');
    assert.equal(row.toolCount, 11);
    assert.equal((await fixture.json('POST', '/api/connectors', { id: 'google-files', transport: 'http', enabled: false })).status, 200);
    assert.equal((await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'google-files').enabled, false);
    assert.equal((await fixture.json('POST', '/api/connectors', { id: 'google-files', transport: 'http', enabled: true })).status, 200);
    assert.equal((await fixture.json('POST', '/api/connectors', { id: 'google-files', transport: 'http', token: 'unexpected' })).status, 503);
    const state = vault().load(file); state.oauth.byId['google-files'].scope += ' https://www.googleapis.com/auth/drive.readonly';
    vault().write(file, state);
    await fixture.restart();
    assert.notEqual((await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'google-files').state, 'up');
    await fixture.json('POST', '/api/connectors/remove', { id: 'google-files' });
    assert.equal(vault().load(file).oauth.byId['google-files'], undefined);
    console.log('google-files: PASS (Picker-only scope, broad deferral, callback, cancellation, encryption, restart, broad-grant rejection, removal)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
