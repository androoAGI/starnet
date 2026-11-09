'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-client-source-'));
  fs.writeFileSync(path.join(root, 'meeting.md'), '# Client meeting\nCompleted the launch milestone.\n');
  const fixture = SidecarFixture.create({ prefix: 'starnet-document-http-', env: {
    SKYNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
  } });
  const j = (m, p, b) => fixture.json(m, p, b);
  const staged = async () => (await j('GET', '/api/discovery')).body.staged.filter(f => f.kind === 'client-update');
  try {
    await fixture.start();
    assert.equal((await fetch(fixture.baseUrl + '/api/discovery/sources')).status, 403);
    assert.equal((await j('POST', '/api/discovery/sources', { root, enabled: true })).status, 400);
    assert.equal((await j('GET', '/api/discovery/sources')).body.approvedRoots.length, 0, 'selection must not mint permission');
    // trusting a folder is confirmed at the desk (GHSA-2hpj #1): the code this station printed, as the person types it
    assert.equal((await fixture.deskJson('POST', '/api/projects/bless', { path: root })).body.ok, true);
    await j('POST', '/api/discovery/scan');
    assert.equal((await staged()).length, 0, 'approved folder alone is not document-discovery consent');
    const configured = await j('POST', '/api/discovery/sources', { root, enabled: true });
    assert.equal(configured.body.ok, true);
    assert.equal(configured.body.grantsChanged, false);
    const scanned = await j('POST', '/api/discovery/scan');
    assert.equal(scanned.body.documents.staged, 1);
    let item = (await staged())[0];
    assert.equal(item.evidence[0].path, 'meeting.md');
    assert.equal(item.evidence[0].quote, 'Completed the launch milestone.');
    const beforeValidation = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'discovery.state.json'), 'utf8'));
    const ledgerBefore = (await j('GET', '/api/recommendations?surface=discovery&limit=10')).body.entries;
    const validation = await j('POST', '/api/discovery/decide', { id: item.id, decision: 'validate' });
    assert.equal(validation.body.ok, true);
    assert.equal(validation.body.validated, true);
    assert.equal((await staged())[0].id, item.id, 'validation retains the candidate until launch succeeds');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'discovery.state.json'), 'utf8')), beforeValidation, 'validation does not mutate discovery state');
    assert.deepEqual((await j('GET', '/api/recommendations?surface=discovery&limit=10')).body.entries, ledgerBefore, 'validation emits no acceptance transition');
    await fixture.restart();
    const restored = (await j('GET', '/api/discovery/sources')).body.sources[0];
    assert.equal(restored.root, root);
    assert.ok(restored.lastScanAt > 0);
    assert.equal((await staged())[0].id, item.id, 'candidate and citations survive a real sidecar restart');
    assert.equal((await j('POST', '/api/discovery/decide', { id: item.id, decision: 'dismiss' })).body.ok, true);
    await fixture.restart();
    await j('POST', '/api/discovery/scan');
    assert.equal((await staged()).length, 0, 'decline survives a real sidecar restart');
    fs.writeFileSync(path.join(root, 'meeting.md'), 'Completed the client launch and published the handoff.\n');
    await j('POST', '/api/discovery/scan');
    item = (await staged())[0];
    assert.ok(item);
    fs.writeFileSync(path.join(root, 'meeting.md'), 'Completed another milestone after review.\n');
    assert.equal((await j('POST', '/api/discovery/decide', { id: item.id, decision: 'validate' })).status, 409, 'validation rejects stale citations before launch');
    assert.ok((await staged()).some(f => f.id === item.id), 'failed validation is read-only');
    assert.equal((await j('POST', '/api/discovery/decide', { id: item.id, decision: 'accept' })).status, 409, 'stale citation cannot launch work');
    await j('POST', '/api/discovery/scan');
    await j('POST', '/api/discovery/sources', { enabled: false });
    assert.equal((await staged()).length, 0, 'source pause clears its offers');
    await fixture.restart();
    assert.equal((await j('GET', '/api/discovery/sources')).body.sources[0].enabled, false);
    await j('POST', '/api/discovery/scan');
    assert.equal((await staged()).length, 0);
    await j('POST', '/api/discovery/sources', { root, enabled: true });
    await j('POST', '/api/discovery/scan');
    item = (await staged())[0];
    await j('POST', '/api/permissions/revoke', { key: 'path:' + root });
    assert.equal((await j('POST', '/api/discovery/decide', { id: item.id, decision: 'validate' })).status, 409);
    assert.equal((await j('POST', '/api/discovery/decide', { id: item.id, decision: 'accept' })).status, 409);
    assert.equal((await staged()).length, 0, 'revoked sources disappear immediately');
    await j('POST', '/api/discovery/sources', { remove: true });
    await fixture.restart();
    assert.equal((await j('GET', '/api/discovery/sources')).body.sources.length, 0);
    console.log('discovery-documents.http: auth, explicit consent, evidence, restart, decline, stale acceptance, pause and revoke passed');
  } finally { await fixture.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
