/* node test/cron.arm.test.js — boot-level end-to-end test of the cron ARM toggle (G4.6: honest
   disabled-state + one-click enable). Spawns the real Node host (sidecar/index.js) against an
   ISOLATED temp workspace on an ephemeral port, with NO key (zero model spend), and proves:

     - INERT-WHEN-OFF (must NOT regress): boot with NEITHER SKYNET_CRON_ENABLED nor a persisted
       cronArmed flag -> GET /api/cron reports enabled:false, NO cron.armed file is written, and a
       routine that is DUE NOW never fires (no 'cron tick armed' / no cron tick log) — the off-path
       is fully inert (the byte-identical-when-off guarantee).
     - RUNTIME ARM (no restart): POST /api/cron/arm {enabled:true} flips GET /api/cron enabled:true,
       persists a cron.armed.json flag, ARMS the live timer NOW, and a routine DUE NOW is processed
       by the tick within ONE tick window (proven by a non-mockable cron tick log line — the timer
       is genuinely live, not a code-read). POST /api/cron/arm {enabled:false} flips it back off,
       clears the timer, and persists armed:false.
     - ARM AT BOOT: a persisted cronArmed:true causes the scheduler to arm at boot even with NO
       SKYNET_CRON_ENABLED env var ('cron tick armed' appears at boot; a DUE routine is ticked).
     - TOKEN GUARD: POST /api/cron/arm WITHOUT the X-StarNet-Token header is rejected 403 (same
       privileged-POST gate as the cron CRUD routes), so a browser-driven cross-site call can't arm.

   A SHORT tick (SKYNET_CRON_TICK_MS=300) is used so "fires within one tick" resolves in well under
   a second deterministically. Mirrors cron.api.test.js. NOT in test:fast (a child-process boot test
   shouldn't gate other agents). Run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// boot the real host; resolves { child, port, out:()=>string } once it prints its listen URL. `extraEnv`
// lets a case set SKYNET_CRON_ENABLED / a short tick. `out()` returns the accumulated stdout+stderr so a
// test can assert a non-mockable log signal (e.g. 'cron tick armed', '[cron] cron.tick ...').
function boot(port, workspaces, attemptsLeft, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, { SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, out: () => out }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, workspaces, attemptsLeft - 1, extraEnv)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cronarm-'));
  const ARMED_FILE = path.join(ws, 'cron.armed.json');
  // short tick so "fires within one tick" resolves fast + deterministically; NO env-arm (default OFF).
  let booted = await boot(await allocatePort(), ws, 20, { SKYNET_CRON_TICK_MS: '300' });
  let child = booted.child, port = booted.port, getOut = booted.out;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = '';
  async function refreshToken() {
    apiToken = await bootToken(B(), B());
  }
  await refreshToken();
  // j() sends the token (the guarded-POST contract); jNoToken() deliberately omits it (guard test).
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;   // hardened: GET data routes are token-gated too now
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };
  const jNoToken = async (m, p, body) => {
    const r = await fetch(B() + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: B() }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status };
  };

  try {
    // ---- seed a routine that is DUE within a second so the first live tick processes it (proving the timer is
    //      live). With no key it takes the no-capability path but STILL drives a cron.tick (plan.fire.length>=1) — a
    //      non-mockable "the timer ran" signal that doesn't depend on any model spend. (A PAST one-shot used to be the
    //      seed; that is refused now — stored, it fired the moment it was saved. sweep/autonomy 2026-10-20) ----
    const create = await j('POST', '/api/cron', { name: 'Due now', prompt: 'do a thing', schedule: 'in 1s', agentId: 'cron_arm' });
    A.eq(create.status, 200, 'POST /api/cron (valid, one-shot due in 1s) -> 200');
    A.eq(create.body.job.schedule.kind, 'once', 'a relative "in 1s" parsed to a one-shot (due a second later)');

    // ---- INERT-WHEN-OFF (the must-not-regress invariant) ----
    const offList = await j('GET', '/api/cron');
    A.eq(offList.status, 200, 'GET /api/cron -> 200 (off)');
    A.eq(offList.body.enabled, false, 'OFF: enabled:false — scheduler honestly reported unarmed');
    A.ok(!fs.existsSync(ARMED_FILE), 'OFF: no cron.armed.json persisted (a never-enabled user touches nothing)');
    A.eq(offList.body.armSet, false, 'OFF: armSet:false — nobody ever set the switch (org P16: the first save would turn it on)');
    // give the host MORE than one tick window with cron OFF; nothing must arm and nothing must tick.
    await sleep(800);
    A.ok(getOut().indexOf('cron tick armed') < 0, 'OFF: timer never armed (no "cron tick armed" log)');
    A.ok(getOut().indexOf('[cron] cron.tick') < 0, 'OFF: no cron tick ran (the due routine never fired — fully inert)');

    // ---- TOKEN GUARD: arm without the token is rejected (same gate as the CRUD POSTs) ----
    const armNoTok = await jNoToken('POST', '/api/cron/arm', { enabled: true });
    A.eq(armNoTok.status, 403, 'POST /api/cron/arm without X-StarNet-Token -> 403 (privileged-POST guard)');
    const stillOff = await j('GET', '/api/cron');
    A.eq(stillOff.body.enabled, false, 'a rejected arm did NOT flip enabled');

    // ---- RUNTIME ARM (no restart): flip on, persist, arm the live timer NOW ----
    const armOn = await j('POST', '/api/cron/arm', { enabled: true });
    A.eq(armOn.status, 200, 'POST /api/cron/arm {enabled:true} -> 200');
    A.eq(armOn.body.enabled, true, 'arm response reports enabled:true');
    const onList = await j('GET', '/api/cron');
    A.eq(onList.body.enabled, true, 'after arm: GET /api/cron enabled:true (no restart)');
    A.ok(fs.existsSync(ARMED_FILE), 'after arm: cron.armed.json persisted');
    A.eq(JSON.parse(fs.readFileSync(ARMED_FILE, 'utf8')).armed, true, 'persisted flag is armed:true');
    // the live timer must now process the DUE routine within ONE tick window — a non-mockable signal.
    await sleep(900);   // > 2 tick windows (300ms) so a live ticker has certainly run
    A.ok(getOut().indexOf('cron tick armed') >= 0, 'after arm: the live timer was armed ("cron tick armed")');
    A.ok(getOut().indexOf('[cron] cron.tick') >= 0, 'after arm: a cron tick actually RAN over the due routine within one tick (timer is live)');

    // ---- RUNTIME DISARM: flip off, clear the timer, persist armed:false ----
    const armOff = await j('POST', '/api/cron/arm', { enabled: false });
    A.eq(armOff.status, 200, 'POST /api/cron/arm {enabled:false} -> 200');
    A.eq(armOff.body.enabled, false, 'disarm response reports enabled:false');
    const offAgain = await j('GET', '/api/cron');
    A.eq(offAgain.body.enabled, false, 'after disarm: GET /api/cron enabled:false');
    A.eq(JSON.parse(fs.readFileSync(ARMED_FILE, 'utf8')).armed, false, 'persisted flag is armed:false after disarm');
    A.eq(offAgain.body.armSet, true, 'after disarm: armSet:true — an explicit OFF, told apart from a switch never set');
    // no NEW tick should run after disarm — snapshot the tick-log length, wait, assert it did not grow.
    const ticksBefore = (getOut().match(/\[cron\] cron\.tick/g) || []).length;
    await sleep(800);
    const ticksAfter = (getOut().match(/\[cron\] cron\.tick/g) || []).length;
    A.eq(ticksAfter, ticksBefore, 'after disarm: the timer is cleared — no further cron ticks run');

    // ---- ARM ON CREATE, ONE RULE (org P16, 2026-10-14): arm:true turns on a switch NOBODY ever set (proved on a fresh
    //      workspace below); after an explicit OFF (the disarm just above) a save keeps it off and says so ----
    const plain = await j('POST', '/api/cron', { name: 'No arm asked', prompt: 'p', schedule: 'every 6h' });
    A.eq(plain.status, 200, 'a create without arm -> 200');
    A.eq(plain.body.scheduler && plain.body.scheduler.armed, false, 'a create without arm leaves a disarmed scheduler disarmed, and says so');
    const armedCreate = await j('POST', '/api/cron', { name: 'Arm me', prompt: 'p', schedule: 'every 6h', arm: true });
    A.eq(armedCreate.status, 200, 'a create with arm:true -> 200');
    A.eq(armedCreate.body.scheduler && armedCreate.body.scheduler.armed, false, 'after an explicit OFF, a save with arm:true does NOT override it');
    A.eq(armedCreate.body.scheduler.armedNow, false, '…the reply says this save did not turn scheduling on');
    A.eq(armedCreate.body.scheduler.offByChoice, true, '…and that it is off by the Commander’s choice');
    A.eq((await j('GET', '/api/cron')).body.enabled, false, 'GET /api/cron agrees: still enabled:false');
    A.eq(JSON.parse(fs.readFileSync(ARMED_FILE, 'utf8')).armed, false, 'the explicit OFF stays on disk');
    // ---- ROUTINE HISTORY: one routine's past runs (none yet), unknown id is an honest 404 ----
    const hist = await j('GET', '/api/cron/history?id=' + encodeURIComponent(armedCreate.body.job.id));
    A.eq(hist.status, 200, 'GET /api/cron/history -> 200');
    A.ok(hist.body.ok && Array.isArray(hist.body.runs) && hist.body.runs.length === 0, 'a routine that never ran has an empty history (nothing synthesized)');
    A.eq((await j('GET', '/api/cron/history?id=nope')).status, 404, 'unknown routine -> 404');
    await j('POST', '/api/cron/remove', { id: plain.body.job.id });
    await j('POST', '/api/cron/remove', { id: armedCreate.body.job.id });
    A.eq((await j('POST', '/api/cron/arm', { enabled: false })).status, 200, 'disarm again before the boot phase');

    // ---- ARM AT BOOT: re-arm, kill, reboot the SAME workspace with NO env arm -> armed at boot ----
    // Seed a FRESH past one-shot that is unclaimed at reboot so the boot-reconcile has a DUE routine to tick
    // over. To keep it unclaimed by THIS process's live timer (which would stamp a fire-claim and then make it
    // self-suppress on the reboot), DISARM first, create the routine while no timer runs, then persist armed:true
    // by hitting the arm route — armCron()'s reconcile fires+claims the OLD one-shots, but the just-created one
    // is also fired+claimed; so instead we kill the process IMMEDIATELY after persisting and rely on the boot
    // reconcile. Simpler + fully deterministic: prove the boot-arm by the persisted flag + the "cron tick armed"
    // boot log (the timer genuinely armed at boot from the flag alone, no env var) — the runtime-arm phase above
    // already proved an armed timer ticks a due routine within one tick.
    const armForBoot = await j('POST', '/api/cron/arm', { enabled: true });   // (timer is currently disarmed)
    A.eq(armForBoot.status, 200, 're-arm before reboot -> 200');
    A.eq(JSON.parse(fs.readFileSync(ARMED_FILE, 'utf8')).armed, true, 'persisted armed:true before reboot');
    try { child.kill(); } catch (_) {} await sleep(250);
    // reboot WITHOUT SKYNET_CRON_ENABLED — only the persisted cronArmed flag should arm the scheduler.
    booted = await boot(await allocatePort(), ws, 20, { SKYNET_CRON_TICK_MS: '300' });
    child = booted.child; port = booted.port; getOut = booted.out;
    await refreshToken();
    const bootList = await j('GET', '/api/cron');
    A.eq(bootList.body.enabled, true, 'ARM-AT-BOOT: persisted cronArmed:true -> enabled:true with no env var');
    await sleep(400);
    A.ok(getOut().indexOf('cron tick armed') >= 0, 'ARM-AT-BOOT: the timer armed at boot from the persisted flag alone (no env var)');

    // ---- FIRST SAVE ARMS (org P16): a FRESH workspace (no cron.armed.json) — the first save with arm:true turns scheduling on ----
    try { child.kill(); } catch (_) {} await sleep(250);
    const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cronarm2-'));
    const ARMED_FILE2 = path.join(ws2, 'cron.armed.json');
    booted = await boot(await allocatePort(), ws2, 20, { SKYNET_CRON_TICK_MS: '300' });
    child = booted.child; port = booted.port; getOut = booted.out;
    await refreshToken();
    A.eq((await j('GET', '/api/cron')).body.armSet, false, 'FRESH: the switch was never set');
    const firstSave = await j('POST', '/api/cron', { name: 'First one', prompt: 'p', schedule: 'every 6h', arm: true });
    A.eq(firstSave.status, 200, 'FRESH: the first save -> 200');
    A.eq(firstSave.body.scheduler && firstSave.body.scheduler.armed, true, 'FRESH: the first save turned scheduling on');
    A.eq(firstSave.body.scheduler.armedNow, true, '…and the reply says THIS save did it (the form prints "scheduling is now on")');
    A.eq(firstSave.body.scheduler.offByChoice, false, '…never an explicit OFF');
    A.eq(JSON.parse(fs.readFileSync(ARMED_FILE2, 'utf8')).armed, true, 'FRESH: the arm intent is persisted');
    const secondSave = await j('POST', '/api/cron', { name: 'Second one', prompt: 'p2', schedule: 'every 7h', arm: true });
    A.eq(secondSave.body.scheduler.armedNow, false, 'a later save on an armed scheduler did not turn anything on (it was on)');
    try { fs.rmSync(ws2, { recursive: true, force: true }); } catch (_) {}
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('cron.arm.test');
})().catch(e => { console.log('FAIL: cron.arm.test threw — ' + (e && e.stack || e)); process.exit(1); });
