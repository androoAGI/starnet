'use strict';
/* A late token refresh must not restore an OAuth grant after the connector is retargeted. */
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const preload = path.join(__dirname, 'fixtures', 'oauth-refresh-race-preload.cjs').replace(/\\/g, '/');
  const fixture = SidecarFixture.create({
    prefix: 'starnet-oauth-refresh-race-', timeoutMs: 20000,
    env: { DEFAULT_MODEL: 'replay', OPENROUTER_KEY: '', NODE_OPTIONS: '--require=' + JSON.stringify(preload) }
  });
  const original = { id: 'oauth-race', transport: 'http', url: 'https://audit.example.com/original', oauth: true, enabled: false };
  const stateFile = path.join(fixture.workspace, 'connectors', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 2, configs: [original], oauth: { byId: { 'oauth-race': {
      accessToken: 'AUDIT_OLD_GRANT', refreshToken: 'AUDIT_REFRESH', expiresAt: 1,
      tokenEndpoint: 'https://audit.example.com/token', clientId: 'audit-client'
    } }, clients: {} }
  }));
  const importConnector = cfg => fixture.json('POST', '/api/config/import', {
    envelope: { starnetExport: 1, sections: { connectors: [cfg] } }
  });
  try {
    await fixture.start();
    const connecting = importConnector(Object.assign({}, original, { enabled: true }));
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(path.join(fixture.workspace, 'refresh-started')) && Date.now() < deadline) await sleep(25);
    A.ok(fs.existsSync(path.join(fixture.workspace, 'refresh-started')), 'the original connector refresh is in flight');

    const retarget = await importConnector(Object.assign({}, original, { url: 'https://audit.example.com/replacement', enabled: false }));
    A.eq(retarget.status, 200, 'replacement connector is durably imported during the old refresh');
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    A.eq(state.oauth.byId['oauth-race'], undefined, 'retarget removes the old OAuth grant before the refresh completes');

    fs.writeFileSync(path.join(fixture.workspace, 'refresh-release'), '1');
    await connecting;
    await sleep(100);
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    A.eq(state.configs.find(c => c.id === 'oauth-race').url, 'https://audit.example.com/replacement', 'late refresh does not overwrite replacement config');
    A.eq(state.oauth.byId['oauth-race'], undefined, 'late refresh does not resurrect the old grant');
  } finally {
    await fixture.dispose();
  }
  A.report('connector-oauth-refresh-race.e2e.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
