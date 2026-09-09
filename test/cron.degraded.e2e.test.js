/* node test/cron.degraded.e2e.test.js — EMPTY-STORE FAIL-LOUD (routine hardening item 2, 2026-08-21).
   Boots a real sidecar (child process, isolated temp WORKSPACES — never the real station) against a workspace
   whose cron.jobs.json AND cron.jobs.json.bak are BOTH corrupt and proves:
     · GET /api/cron reports degraded:{ quarantinePath, since } (and the corrupt main was quarantined, not wiped)
     · the scheduler does not tick while degraded (health.lastTickError names the degradation; no tick success)
     · a write that would persist an EMPTY envelope is REFUSED (POST /api/cron/remove on the only job -> 500,
       the store stays non-empty on disk)
     · POST /api/cron/degraded/clear {confirm:true} is the explicit override: clears the flag, persists, ticks again
   Also: a GET /api/cron on a healthy workspace reports degraded:null + maxConsecutiveFailures. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function boot(workspaces, extraEnv) {
  // A failed bind happens after store initialization: retrying the same corrupt fixture
  // would test its already-quarantined state. Choose a free port, and fail any bind race.
  const port = await new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, HOST, () => {
      const selected = reservation.address().port;
      reservation.close(err => err ? reject(err) : resolve(selected));
    });
  });
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1',
        LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
      }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, log: () => out }); }
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        reject(new Error('test port became occupied; fixture was initialized and must not be reused'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 12000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-degraded-'));
  const cronPath = path.join(ws, 'cron.jobs.json');
  // a CORRUPT main AND a corrupt .bak: nothing recoverable. The old behavior loaded [] and persisted the wipe.
  fs.writeFileSync(cronPath, '{"version":1,"jobs":[{"id":"rt_lost","name":"Lost routine",', 'utf8');
  fs.writeFileSync(cronPath + '.bak', 'not json at all', 'utf8');
  // arm the scheduler so the boot reconcile WOULD tick if the degraded gate were missing
  fs.writeFileSync(path.join(ws, 'cron.armed.json'), JSON.stringify({ version: 1, armed: true }), 'utf8');

  let booted = await boot(ws, { SKYNET_CRON_TICK_MS: '1500' });
  let child = booted.child, port = booted.port;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = await bootToken(B(), B());
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': apiToken };
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };

  try {
    const list = await j('GET', '/api/cron');
    A.eq(list.status, 200, 'GET /api/cron -> 200 while degraded');
    A.ok(list.body.degraded && list.body.degraded.quarantinePath, 'degraded:{quarantinePath} surfaced on GET /api/cron');
    A.ok(list.body.degraded && list.body.degraded.since, 'degraded.since stamped');
    A.eq(list.body.jobs.length, 0, 'the phantom list is empty (nothing recoverable)');
    A.eq(typeof list.body.maxConsecutiveFailures, 'number', 'maxConsecutiveFailures exposed');
    A.ok(!fs.existsSync(cronPath), 'the corrupt main was quarantined (moved aside), not overwritten');
    A.ok(fs.existsSync(list.body.degraded.quarantinePath), 'the quarantine path exists on disk: ' + list.body.degraded.quarantinePath);
    A.ok(/DEGRADED/.test(booted.log()), 'boot log shouts DEGRADED');
    A.ok(/boot reconcile SKIPPED/.test(booted.log()), 'boot reconcile was skipped (no tick over a phantom-empty list)');

    // wait past two tick periods: still no successful tick, and health names the degradation
    await sleep(3500);
    const h = await j('GET', '/api/cron');
    A.eq(h.body.health.lastSuccessAt, null, 'no tick succeeded while degraded');
    A.ok(/degraded/.test(String(h.body.health.lastTickError || '')), 'health.lastTickError names the degraded store: ' + h.body.health.lastTickError);
    A.ok(!fs.existsSync(cronPath), 'no tick persisted an empty envelope over the quarantined store');

    // a create is ALLOWED (adds, cannot destroy) — but the degraded flag stays
    const create = await j('POST', '/api/cron', { name: 'New one', prompt: 'hello', schedule: 'every 30m', agentId: 'cron_new' });
    A.eq(create.status, 200, 'creating a routine while degraded -> 200 (an add cannot destroy what is gone)');
    A.ok(fs.existsSync(cronPath), 'the add persisted a NON-empty envelope');
    A.ok((await j('GET', '/api/cron')).body.degraded, 'degraded flag stays after an add (the loss is not yet acknowledged)');

    // removing the only job would persist an EMPTY envelope -> refused
    const rm = await j('POST', '/api/cron/remove', { id: create.body.job.id });
    A.eq(rm.status, 500, 'a remove that would persist an EMPTY envelope over a quarantined store is refused');
    A.ok(/degraded/.test(String(rm.body.error || '')), 'the refusal names the degraded store: ' + rm.body.error);
    const disk = JSON.parse(fs.readFileSync(cronPath, 'utf8'));
    A.eq(disk.jobs.length, 1, 'disk still holds the routine (no empty write happened)');
    A.eq((await j('GET', '/api/cron')).body.jobs.length, 1, 'RAM re-read back to the durable truth after the refused write');

    // explicit override
    const noConfirm = await j('POST', '/api/cron/degraded/clear', {});
    A.eq(noConfirm.status, 400, 'clear without confirm:true -> 400');
    const clear = await j('POST', '/api/cron/degraded/clear', { confirm: true });
    A.eq(clear.status, 200, 'POST /api/cron/degraded/clear {confirm:true} -> 200');
    A.ok(clear.body.quarantinePath, 'the acknowledgement echoes where the quarantined copy lives');
    const after = await j('GET', '/api/cron');
    A.eq(after.body.degraded, null, 'degraded cleared');
    const rm2 = await j('POST', '/api/cron/remove', { id: create.body.job.id });
    A.eq(rm2.status, 200, 'after the override an empty envelope may be persisted again');
    await sleep(3500);
    const h2 = await j('GET', '/api/cron');
    A.ok(h2.body.health.lastSuccessAt != null, 'the scheduler ticks again after the override');
    A.eq(h2.body.health.lastTickError, null, 'tick error cleared');
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  // ---- healthy workspace: degraded:null ----
  {
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-healthy-'));
    const b2 = await boot(ws2);
    try {
      const tok = await bootToken('http://' + HOST + ':' + b2.port, 'http://' + HOST + ':' + b2.port);
      const r = await fetch('http://' + HOST + ':' + b2.port + '/api/cron', { headers: { 'X-StarNet-Token': tok } });
      const v = await r.json();
      A.eq(v.degraded, null, 'a healthy (absent) store is degraded:null');
    } finally {
      try { b2.child.kill(); } catch (_) {}
      await sleep(300);
      try { fs.rmSync(ws2, { recursive: true, force: true }); } catch (_) {}
    }
  }

  A.report('cron.degraded.e2e');
})().catch(e => { console.error(e); process.exit(1); });
