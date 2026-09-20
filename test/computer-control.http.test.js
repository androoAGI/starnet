'use strict';
const assert = require('node:assert/strict');
const { SidecarFixture } = require('./helpers/sidecar-fixture');
(async () => {
  const host = SidecarFixture.create({ env: { STARNET_DESKTOP_SHELL: '1', STARNET_COMPUTER_DRIVER: '1' } });
  try {
    await host.start();
    assert.equal((await host.request('/api/computer-control', { headers: { 'X-StarNet-Token': '' } })).status, 403);
    const before = await host.json('GET', '/api/computer-control');
    assert.equal(before.status, 200); assert.equal(before.body.backend, 'win32');
    const bad = await host.json('POST', '/api/computer-control', { action: 'select', backend: 'arbitrary-exe' });
    assert.equal(bad.status, 400);
    assert.equal((await host.json('POST', '/api/computer-control', { action: 'select', backend: 'cua' })).status, 400);
    const off = await host.json('POST', '/api/computer-control', { action: 'select', backend: 'off' });
    assert.equal(off.status, 200); assert.equal(off.body.available, false);
    await host.restart();
    assert.equal((await host.json('GET', '/api/computer-control')).body.backend, 'off');
    assert.equal((await host.json('POST', '/api/computer-control', { action: 'check' })).body.checked, false);
    console.log('PASS computer control HTTP: authenticated settings, invalid selection, missing driver, durable restart');
  } finally { await host.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
