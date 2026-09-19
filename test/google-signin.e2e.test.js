'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { ENDPOINTS } = require('../sidecar/mcp/transport.google.js');
const { makeConnectorVault } = require('../sidecar/connector-vault.js');
const keyHex = '17'.repeat(32);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-google-signin-', timeoutMs: 30000, env: {
    STARNET_GOOGLE_DESKTOP_CLIENT_JSON: JSON.stringify({ installed: { client_id: '123456-starnettest.apps.googleusercontent.com' } }),
    STARNET_DEFAULT_MODEL: 'replay', STARNET_OPENROUTER_KEY: '',
    STARNET_CONNECTOR_ENCRYPTION_KEY: keyHex,
    NODE_OPTIONS: '--require=' + path.join(__dirname, 'fixtures/google-signin-preload.cjs').replace(/\\/g, '/')
  } });
  const file = name => path.join(fixture.workspace, name);
  const statePath = file('connectors/state.json');
  const disk = () => makeConnectorVault({ fs, path, keyHex }).load(statePath);
  const start = async (id = 'gmail') => {
    const result = await fixture.json('POST', '/api/connectors/oauth/start', { id });
    assert.equal(result.status, 200);
    const auth = new URL(result.body.url);
    assert.equal(auth.origin, 'https://accounts.google.com');
    assert.equal(auth.searchParams.get('client_id'), '123456-starnettest.apps.googleusercontent.com');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    if (id === 'google-docs' || id === 'google-sheets') {
      const scopes = new Set(auth.searchParams.get('scope').split(' '));
      assert.ok(!scopes.has('https://www.googleapis.com/auth/drive.readonly'), 'Docs/Sheets must not request whole-Drive read access');
      assert.ok(scopes.has('https://www.googleapis.com/auth/drive.file'), 'minimal Drive account probe permission retained');
      assert.ok(scopes.has('https://www.googleapis.com/auth/' + (id === 'google-docs' ? 'documents' : 'spreadsheets')));
    }
    assert.equal(auth.searchParams.get('redirect_uri'), fixture.baseUrl + '/api/connectors/oauth/callback');
    assert.ok(!auth.searchParams.has('client_secret'));
    fs.writeFileSync(file('google-challenge'), auth.searchParams.get('code_challenge'));
    return { state: auth.searchParams.get('state'), attemptId: result.body.attemptId };
  };
  const callback = async (attempt, code) => {
    const response = await fixture.request('/api/connectors/oauth/callback?state=' + attempt.state + '&code=' + encodeURIComponent(code));
    return response.text();
  };
  try {
    await fixture.start();
    const cards = (await fixture.json('GET', '/api/connectors/catalog')).body.connectors.filter(c => c.googleApi);
    assert.equal(cards.length, 5); assert.ok(cards.every(c => c.signInAvailable));
    assert.ok(!JSON.stringify(cards).includes('123456-starnettest'));
    const first = await start();
    assert.match(await callback(first, 'gmail:good'), /Gmail connected/);
    assert.match(await callback(first, 'gmail:good'), /expired/);
    assert.equal(disk().oauth.byId.gmail.account.email, 'google-fixture@example.invalid');
    assert.equal(disk().configs.find(c => c.id === 'gmail').url, ENDPOINTS.gmail);
    assert.equal(disk().oauth.byId.gmail.tokenEndpointAuthMethod, 'none');
    const original = JSON.stringify(disk().oauth.byId.gmail);
    const denied = await start();
    const deniedPage = await fixture.request('/api/connectors/oauth/callback?state=' + denied.state + '&error=access_denied');
    assert.match(await deniedPage.text(), /Sign-in failed/);
    assert.match(await callback(denied, 'gmail:good'), /expired/);
    assert.equal(JSON.stringify(disk().oauth.byId.gmail), original, 'denied consent keeps the old grant and consumes the pending state');
    assert.match(await callback(await start(), 'gmail:partial'), /permissions needed/);
    assert.equal(JSON.stringify(disk().oauth.byId.gmail), original, 'partial consent preserves the working grant');
    assert.match(await callback(await start(), 'gmail:no-refresh'), /incomplete/);
    assert.equal(JSON.stringify(disk().oauth.byId.gmail), original, 'missing refresh token preserves the working grant');
    const cancelled = await start();
    await fixture.json('POST', '/api/connectors/oauth/cancel', { id: 'gmail', attemptId: cancelled.attemptId });
    assert.match(await callback(cancelled, 'gmail:good'), /expired/);
    const held = await start();
    const inFlight = callback(held, 'gmail:hold');
    for (let i = 0; i < 200 && !fs.existsSync(file('google-held')); i++) await sleep(20);
    assert.ok(fs.existsSync(file('google-held')));
    await fixture.json('POST', '/api/connectors/oauth/cancel', { id: 'gmail', attemptId: held.attemptId });
    fs.writeFileSync(file('google-release'), 'yes');
    assert.match(await inFlight, /cancelled/);
    assert.equal(JSON.stringify(disk().oauth.byId.gmail), original, 'cancelling during exchange preserves the working grant');
    fs.writeFileSync(file('google-write-fail'), 'yes');
    assert.match(await callback(await start(), 'gmail:good'), /could not be saved/);
    assert.equal(JSON.stringify(disk().oauth.byId.gmail), original, 'failed persistence preserves the working grant');
    fs.unlinkSync(file('google-write-fail'));
    for (const id of ['google-drive', 'google-calendar', 'google-docs', 'google-sheets']) assert.match(await callback(await start(id), id + ':good'), /connected/);
    await fixture.stop();
    const state = disk(); state.oauth.byId.gmail.expiresAt = 1;
    makeConnectorVault({ fs, path, keyHex }).write(statePath, state);
    await fixture.start();
    await fixture.json('POST', '/api/connectors/refresh', { id: 'gmail' });
    assert.ok(fs.existsSync(file('google-refreshed')));
    assert.equal(disk().oauth.byId.gmail.accessToken, 'GOOGLE_REFRESHED_TEST');
    const rows = (await fixture.json('GET', '/api/connectors')).body.connectors;
    assert.equal(rows.find(c => c.id === 'gmail').state, 'up');
    assert.ok(!JSON.stringify(rows).includes('GOOGLE_ACCESS_TEST') && !JSON.stringify(rows).includes('GOOGLE_REFRESHED_TEST'));
    for (const f of [statePath, statePath + '.bak']) assert.ok(!fs.readFileSync(f, 'utf8').includes('GOOGLE_'), 'credentials encrypted in both disk copies');
    const protectedBefore = fs.readFileSync(statePath, 'utf8');
    await fixture.restart({ STARNET_CONNECTOR_ENCRYPTION_KEY: '' });
    const locked = (await fixture.json('GET', '/api/connectors')).body;
    assert.match(locked.credentialStorage.error, /locked/);
    assert.equal((await fixture.json('POST', '/api/connectors/oauth/start', { id: 'gmail' })).status, 503);
    assert.equal(fs.readFileSync(statePath, 'utf8'), protectedBefore, 'missing key preserves encrypted credentials');
    await fixture.restart();
    assert.equal((await fixture.json('GET', '/api/connectors')).body.credentialStorage.encrypted, true);
    fs.writeFileSync(file('google-revoked'), 'yes');
    await fixture.json('POST', '/api/connectors/refresh', { id: 'gmail' });
    const revoked = (await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'gmail');
    assert.notEqual(revoked.state, 'up', 'revoked credentials never claim connected');
    const removed = await fixture.json('POST', '/api/connectors/remove', { id: 'gmail' });
    assert.equal(removed.body.removed, true);
    await fixture.restart();
    assert.equal(disk().oauth.byId.gmail, undefined);
    assert.ok(!disk().configs.some(c => c.id === 'gmail'));
    const futureState = JSON.stringify({ ...disk(), version: 99 });
    fs.writeFileSync(statePath, futureState);
    await fixture.restart();
    assert.match((await fixture.json('GET', '/api/connectors')).body.credentialStorage.error, /not recognized/);
    assert.equal(fs.readFileSync(statePath, 'utf8'), futureState, 'unknown state version cannot be migrated over');
    assert.ok(!fixture.output().includes('GOOGLE_ACCESS_TEST') && !fixture.output().includes('GOOGLE_REFRESH_TEST'));
    console.log('google-signin.e2e: PASS (five services, native PKCE callback, partial/denied refresh consent, replay, cancellation during exchange, write failure, restart, refresh, revocation, removal, redaction)');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
