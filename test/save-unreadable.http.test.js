'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const fixture = SidecarFixture.create({ entry: path.join(__dirname, 'helpers/save-read-fault-host.cjs'), timeoutMs: 20000 });
  const primary = path.join(fixture.workspace, 'audit.save.json');
  const control = path.join(fixture.workspace, 'save-read-fault.json');
  const doc = { schema: 'starnet.save', version: 5, updatedAt: 100, agent: { id: 'audit', name: 'RETAIN ME' } };
  try {
    await fixture.start();
    const saved = await fixture.json('POST', '/api/save', doc);
    assert.equal(saved.body.ok, true);
    const bytes = fs.readFileSync(primary, 'utf8');
    fs.writeFileSync(control, JSON.stringify({ file: 'audit.save.json' }));
    const locked = await fixture.json('GET', '/api/save?agent=audit');
    assert.equal(locked.status, 503, 'unreadable existing save must not be a successful empty station');
    assert.equal(locked.body.unreadable, true);
    assert.equal((await fixture.json('POST', '/api/save', { ...doc, updatedAt: 200 })).body.ok, false);
    assert.equal(fs.readFileSync(primary, 'utf8'), bytes, 'primary retained byte for byte');
    fs.unlinkSync(control);
    assert.equal((await fixture.json('GET', '/api/save?agent=audit')).body.save.agent.name, 'RETAIN ME');

    fs.renameSync(primary, primary + '.bak');
    fs.writeFileSync(control, JSON.stringify({ file: 'audit.save.json.bak' }));
    assert.equal((await fixture.json('GET', '/api/save?agent=audit')).status, 503, 'unreadable sole backup is unknown, not absent');
    const refused = await fixture.json('POST', '/api/save', { ...doc, updatedAt: 200, agent: { id: 'audit', name: 'EMPTY REPLACEMENT' } });
    assert.equal(refused.body.ok, false, 'write must not eclipse unreadable last copy');
    assert.equal(fs.existsSync(primary), false);
    assert.equal(fs.readFileSync(primary + '.bak', 'utf8'), bytes);
    fs.unlinkSync(control);
    await fixture.restart();
    const recovered = await fixture.json('GET', '/api/save?agent=audit');
    assert.equal(recovered.body.save.agent.name, 'RETAIN ME');
    assert.equal(recovered.body.recovery.kind, 'recovered', 'missing-main backup recovery is disclosed');
    assert.equal((await fixture.json('GET', '/api/save?agent=new')).body.save, null, 'genuinely new station remains empty');
    console.log('save unreadable HTTP: primary/backup faults, refused writes, byte preservation, restart and recovery disclosure PASS');
  } finally { await fixture.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
