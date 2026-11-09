'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture');
(async () => {
  const host = SidecarFixture.create({ env: { SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0' } });
  // a dial raise to building grants the night shift's away workshop, so it is confirmed at the desk first (fix-sec2 review2 #9):
  // the Commander's dial write confirms it with the code the station printed, as the person at the station types it
  const write = posture => host.deskJson('POST', '/api/autonomy/posture', { posture, resumeHalt: true });
  const read = async () => (await host.json('GET', '/api/autonomy/posture')).body.summary;
  try {
    await host.start();
    const baseline = { initiative: 'wait', reach: 'observe', leashPerDay: 2 };
    assert.equal((await write(baseline)).body.ok, true);
    await host.json('POST', '/api/halt', {});
    const target = path.join(host.workspace, '_commander.autonomy.json');
    const bytes = fs.readFileSync(target);
    fs.unlinkSync(target); fs.mkdirSync(target);
    try {
      const unconfirmed = await host.json('POST', '/api/autonomy/posture', { posture: { initiative: 'free', reach: 'reach', leashPerDay: 12 }, resumeHalt: true });
      assert.equal(unconfirmed.status, 403); assert.equal(unconfirmed.body.code, 'desk_confirm_required', 'a raise to building is asked at the desk first');
      const failed = await write({ initiative: 'free', reach: 'reach', leashPerDay: 12 });
      assert.equal(failed.status, 503); assert.equal(failed.body.ok, false);
      assert.equal((await read()).initiative, 'wait', 'failed persistence cannot change live authority');
      assert.equal((await host.json('GET', '/api/halt')).body.subsystems.nightshift.halted, true, 'failed write cannot lift emergency stop');
      const beliefs = await host.json('POST', '/api/autonomy/posture', { beliefs: { known: ['goals'], beliefs: {} } });
      assert.equal(beliefs.status, 503, 'belief-only write is also confirmed durably');
    } finally { fs.rmdirSync(target); fs.writeFileSync(target, bytes); }
    await host.restart();
    assert.equal((await read()).initiative, 'wait');
    assert.equal((await write({ initiative: 'leash', reach: 'sandbox', leashPerDay: 6 })).body.ok, true);
    await host.restart();
    const saved = await read();
    assert.equal(saved.initiative, 'leash'); assert.equal(saved.reach, 'sandbox'); assert.equal(saved.leashPerDay, 6);
    console.log('autonomy-confirmation.http: PASS (disk failure, unchanged authority, halt, recovery, restart)');
  } finally { await host.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
