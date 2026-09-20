'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeConnectorVault } = require('../sidecar/connector-vault.js');

(async () => {
  const keyHex = 'ab'.repeat(32);
  const app = SidecarFixture.create({ env: { STARNET_CONNECTOR_ENCRYPTION_KEY: keyHex }, timeoutMs: 20000 });
  const file = path.join(app.workspace, 'connectors/state.json');
  const state = { version: 2, configs: [{ id: 'audit-fixture', enabled: false, transport: 'http', url: 'http://127.0.0.1:1' }], oauth: { byId: {}, clients: {} } };
  try {
    makeConnectorVault({ fs, path, keyHex }).write(file, state);
    fs.writeFileSync(file, 'null');
    const backup = fs.readFileSync(file + '.bak', 'utf8');
    for (let boot = 0; boot < 2; boot++) {
      await app.start();
      const response = await app.json('GET', '/api/connectors');
      assert.equal(response.status, 200);
      assert.match(response.body.credentialStorage.error, /locked/);
      assert.equal(response.body.credentialStorage.encrypted, false);
      assert.equal(fs.readFileSync(file, 'utf8'), 'null', 'boot preserves invalid main');
      assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup, 'boot preserves last-good encrypted backup');
      await app.stop();
    }
    fs.copyFileSync(file + '.bak', file);
    await app.start();
    const recovered = await app.json('GET', '/api/connectors');
    assert.equal(recovered.body.credentialStorage.error, null);
    assert.equal(recovered.body.credentialStorage.encrypted, true);
    assert.equal(makeConnectorVault({ fs, path, keyHex }).load(file).configs.length, 1);
    console.log('connector-vault-invalid.http: PASS (startup, visible locked state, restart, preserved backup, explicit recovery)');
  } finally { await app.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
