'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture');

(async () => {
  const host = SidecarFixture.create({ env: { SKYNET_DEV: '1', SKYNET_CRON_TICK_MS: '300' } });
  const json = (m, p, b) => host.json(m, p, b);
  const read = name => fs.existsSync(path.join(host.workspace, name)) ? fs.readFileSync(path.join(host.workspace, name), 'utf8') : null;
  const permissions = () => Object.fromEntries(['_commander.autonomy.json', 'cron.armed.json', 'cron.jobs.json', 'loops.json', ...fs.readdirSync(host.workspace).filter(n => n.endsWith('.workshop.json'))].map(n => [n, read(n)]));
  const status = async value => {
    const r = await json('GET', '/api/halt');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.values(r.body.subsystems).map(s => s.halted), [value, value, value]);
    for (const route of ['/api/cron', '/api/nightshift/status', '/api/loops']) assert.equal((await json('GET', route)).body.halted, value, route);
  };
  try {
    await host.start();
    assert.equal((await host.request('/api/halt', { headers: { 'X-StarNet-Token': '' } })).status, 403);
    assert.equal((await json('POST', '/api/halt/resume', {})).status, 400);
    // Deliberately leave scheduling OFF: resume must not silently arm it.
    await json('POST', '/api/cron/arm', { enabled: false });
    await json('POST', '/api/autonomy/posture', { posture: { initiative: 'wait', reach: 'sandbox', leashPerDay: 2 } });
    const before = permissions();
    assert.equal((await json('POST', '/api/halt', {})).body.cronHaltPersisted, true);
    await status(true);
    await host.restart();
    await status(true);
    await json('POST', '/api/autonomy/posture', { posture: { initiative: 'wait', reach: 'sandbox', leashPerDay: 2 }, resumeHalt: false });
    await status(true);
    const beforeResume = permissions();
    const nsBefore = JSON.parse(read('nightshift.state.json'));
    const resumed = await json('POST', '/api/halt/resume', { confirm: true });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.ok, true);
    await status(false);
    assert.deepEqual(permissions(), beforeResume, 'resume changes no permissions, posture, arm intent or job state');
    assert.equal((await json('GET', '/api/cron')).body.enabled, false);
    const nsAfter = JSON.parse(read('nightshift.state.json'));
    for (const field of ['day', 'beatsUsedToday', 'lastBeatAt']) assert.equal(nsAfter[field], nsBefore[field], field);
    assert.deepEqual(Object.keys(permissions()).filter(n => n.endsWith('.workshop.json')), Object.keys(before).filter(n => n.endsWith('.workshop.json')), 'no new workshop grant record');
    await host.restart();
    await status(false);
    // Each failed durable write leaves ONLY that subsystem halted, exposes its failure, and is retryable.
    for (const [name, file] of [['cron', 'cron.halt.json'], ['nightshift', 'nightshift.state.json'], ['loops', 'loops.halt.json']]) {
      await json('POST', '/api/halt', {});
      const target = path.join(host.workspace, file), bytes = fs.readFileSync(target);
      fs.unlinkSync(target); fs.mkdirSync(target);
      try {
        const failed = await json('POST', '/api/halt/resume', { confirm: true });
        assert.equal(failed.status, 503, name);
        assert.equal(failed.body.ok, false);
        assert.ok(failed.body.errors[name]);
        assert.equal(failed.body.subsystems[name].halted, true);
        for (const other of ['cron', 'nightshift', 'loops'].filter(k => k !== name)) assert.equal(failed.body.subsystems[other].halted, false);
      } finally { fs.rmdirSync(target); fs.writeFileSync(target, bytes); }
      assert.equal((await json('POST', '/api/halt/resume', { confirm: true })).body.ok, true);
      await status(false);
    }
    // Armed intent survives the same cycle and the real timer starts ticking again.
    await json('POST', '/api/cron/arm', { enabled: true });
    await json('POST', '/api/halt', {});
    await host.restart(); await status(true);
    assert.equal((await json('GET', '/api/cron')).body.enabled, true);
    await json('POST', '/api/halt/resume', { confirm: true });
    await new Promise(r => setTimeout(r, 650));
    const cron = (await json('GET', '/api/cron')).body;
    assert.equal(cron.halted, false);
    assert.ok(cron.health.lastTickAt > 0, 'real scheduler tick resumed');
    console.log('PASS emergency recovery: stop/restart/resume, three partial failures, permission preservation, real cron tick');
  } finally { await host.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
