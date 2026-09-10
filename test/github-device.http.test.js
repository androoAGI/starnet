'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const preload = path.join(__dirname, 'fixtures/github-device-preload.cjs').replace(/\\/g, '/');
  const fixture = SidecarFixture.create({ prefix: 'starnet-github-device-', timeoutMs: 30000,
    env: { DEFAULT_MODEL: 'replay', OPENROUTER_KEY: '', NODE_OPTIONS: '--require=' + preload } });
  try {
    await fixture.start();
    const start = await fixture.json('POST', '/api/connectors/oauth/start', { id: 'github', attemptId: 'github_test_1' });
    assert.equal(start.status, 200);
    assert(!JSON.stringify(start).includes('FIXTURE_DEVICE'));
    const cancel = await fixture.json('POST', '/api/connectors/oauth/cancel', { id: 'github', attemptId: 'github_test_1' });
    assert.equal(cancel.status, 200);
    assert.equal((await fixture.json('POST', '/api/connectors/oauth/device/poll', { attemptId: 'github_test_1' })).body.state, 'error');
    await fixture.json('POST', '/api/connectors/oauth/start', { id: 'github', attemptId: 'github_test_2' });
    await sleep(5100);
    const done = await fixture.json('POST', '/api/connectors/oauth/device/poll', { attemptId: 'github_test_2' });
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'connected');
    assert.equal(done.body.toolCount, 1);
    const stateFile = path.join(fixture.workspace, 'connectors/state.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(saved.oauth.byId.github.accessToken, 'FIXTURE_ACCESS');
    assert.equal(saved.oauth.byId.github.account.login, 'fixture-user');
    assert.equal(saved.configs.find(c => c.id === 'github').token, '');
    const publicState = await fixture.json('GET', '/api/connectors');
    assert(!JSON.stringify(publicState).includes('FIXTURE_ACCESS'));
    assert(!JSON.stringify(done).includes('FIXTURE_REFRESH'));
    await fixture.stop(); await fixture.start();
    const restored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(restored.oauth.byId.github.refreshToken, 'FIXTURE_REFRESH');
    const live = await fixture.json('GET', '/api/connectors');
    assert.equal(live.body.connectors.find(c => c.id === 'github').state, 'up');
    // Replacing a working PAT must never destroy the last credential when the OAuth save fails.
    await fixture.json('POST', '/api/connectors', { id: 'github', label: 'GitHub', transport: 'http',
      url: 'https://api.githubcopilot.com/mcp', token: 'FIXTURE_OLD_PAT', oauth: false, enabled: true });
    const beforeFailure = fs.readFileSync(stateFile, 'utf8');
    assert.equal(JSON.parse(beforeFailure).configs.find(c => c.id === 'github').token, 'FIXTURE_OLD_PAT');
    const failPreload = path.join(__dirname, 'fixtures/connector-state-write-fail-preload.cjs').replace(/\\/g, '/');
    await fixture.restart({ NODE_OPTIONS: '--require=' + preload + ' --require=' + failPreload, STARNET_TEST_FAIL_CONNECTOR_STATE: '1' });
    await fixture.json('POST', '/api/connectors/oauth/start', { id: 'github', attemptId: 'github_test_failure' });
    await sleep(5100);
    const failed = await fixture.json('POST', '/api/connectors/oauth/device/poll', { attemptId: 'github_test_failure' });
    assert.equal(failed.body.state, 'error');
    assert.match(failed.body.error, /could not be saved/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeFailure);
    assert.equal((await fixture.json('GET', '/api/connectors')).body.connectors.find(c => c.id === 'github').state, 'up');
    await fixture.restart({ NODE_OPTIONS: '--require=' + preload, STARNET_TEST_FAIL_CONNECTOR_STATE: '0' });
    assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeFailure);
    console.log('github-device.http: real routes, cancellation, durable tokens, restart and public secret redaction passed');
  } finally { await fixture.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
