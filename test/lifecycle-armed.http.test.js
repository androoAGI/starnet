/* node test/lifecycle-armed.http.test.js — Lane 4D: end-to-end proof of GET /api/lifecycle/armed, the ONE
   aggregate the desktop tray supervisor polls to decide whether closing the window may keep the sidecar alive.
   Spawns the real Node host against an ISOLATED temp workspace on an ephemeral port, NO key (zero model spend):

     - DISABLED STATE IS INERT: a fresh boot with nothing armed reports armed:false and every category
       honestly not-armed — so the tray quits the whole app on window close (no hidden daemon).
     - ARMING A ROUTINE FLIPS IT TRUE: create a routine + POST /api/cron/arm {enabled:true} -> armed:true,
       categories.routines.armed:true with the real count, and a human "N routine(s) armed" reason string.
     - NIGHT-SHIFT HALT TRUTHFULNESS: an armed night shift counts as armed work; after POST /api/halt the
       durable NS halt means it is NOT doing work — nightshift.armed stays true (timer up) but halted:true and
       the AGGREGATE goes armed:false (the tray must never hold the process for a frozen shift).
     - CRON E-STOP HALT IS DURABLE (M1): POST /api/halt with an armed recurring routine -> GET /api/cron says
       enabled:true + halted:true, lifecycle armed:false, no further ticks; RESTART the host -> still halted
       (armed intent kept, timer down); explicit POST /api/cron/arm {enabled:true} lifts the halt and re-arms.
     - TOKEN GUARD: GET without the X-StarNet-Token header is rejected 403 (GET data routes are token-gated).

   NOT covered (honest): a channels-connected reason — connecting a real channel needs a live platform endpoint
   or a bespoke mock; channel connectivity is covered by channels.telegram.e2e.test.js, and the snapshot reads
   the same channelStatusPayload those tests prove. Short tick (SKYNET_CRON_TICK_MS=300). NOT in test:fast
   (child-process boot). Run via `npm run test:http`. Mirrors cron.arm.test.js. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
      if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, workspaces, attemptsLeft - 1, extraEnv));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lifecycle-'));
  const HALT_FILE = path.join(ws, 'cron.halt.json');
  const LOOPS_HALT_FILE = path.join(ws, 'loops.halt.json');
  let booted = await boot(8990 + (process.pid % 40), ws, 20, { SKYNET_CRON_TICK_MS: '300' });
  let child = booted.child; let port = booted.port; let getOut = booted.out;
  const B = () => 'http://' + HOST + ':' + port;
  let apiToken = await bootToken(B(), B());
  const j = async (m, p, body) => {
    const headers = { 'Content-Type': 'application/json', Origin: B() };
    if (apiToken) headers['X-StarNet-Token'] = apiToken;
    const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
    return { status: r.status, body: v };
  };
  const jNoToken = async (m, p) => {
    const r = await fetch(B() + p, { method: m, headers: { Origin: B() } });
    return { status: r.status };
  };

  try {
    // ---- DISABLED STATE IS INERT ----
    const off = await j('GET', '/api/lifecycle/armed');
    A.eq(off.status, 200, 'GET /api/lifecycle/armed -> 200');
    A.eq(off.body.armed, false, 'fresh boot: armed:false (nothing requires a background process)');
    A.ok(off.body.categories && off.body.categories.routines && off.body.categories.channels && off.body.categories.nightshift && off.body.categories.terminals, 'all background-work categories present in the snapshot');

    // ---- RAW-SOCKET SHAPE RATCHET (the shell's close decision reads these exact bytes) ----
    // The desktop supervisor parses the raw response with a minimal parser: status line, blank
    // line, JSON body. Node chunk-framing this response made every close probe read Ambiguous —
    // the shell then failed open into the tray on EVERY window close and left an unopenable
    // background process (0.10.x zombie). This endpoint must stay un-chunked forever.
    {
      const net = require('net');
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        const s = net.connect(port, HOST, () => {
          s.write('GET /api/lifecycle/armed HTTP/1.1\r\nHost: ' + HOST + '\r\nX-StarNet-Token: ' + apiToken + '\r\nConnection: close\r\n\r\n');
        });
        s.on('data', d => chunks.push(d));
        s.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        s.on('error', reject);
        setTimeout(() => reject(new Error('raw armed probe timed out')), 4000);
      });
      A.ok(/^HTTP\/1\.1 200 /.test(raw), 'raw armed probe answers 200');
      A.ok(/content-length:/i.test(raw), 'armed response declares an explicit Content-Length');
      A.ok(!/transfer-encoding/i.test(raw), 'armed response is never chunk-framed (shell parser reads raw bytes)');
      const rawBody = raw.split('\r\n\r\n')[1] || '';
      const parsed = JSON.parse(rawBody.trim());
      A.eq(parsed.armed, false, 'raw body after the header break is directly JSON-parseable, as the shell assumes');
    }
    A.eq(off.body.categories.terminals, { armed: false, count: 0 }, 'fresh boot reports no attached terminal work');
    A.eq(off.body.categories.routines.armed, false, 'routines not armed on a fresh boot');
    A.eq(off.body.categories.channels.armed, false, 'no channel connected on a fresh boot');
    A.eq(off.body.categories.nightshift.armed, false, 'night shift not armed on a fresh boot');
    A.ok(Array.isArray(off.body.reasons) && off.body.reasons.length === 0, 'no reasons when nothing is armed');

    // ---- TOKEN GUARD ----
    const noTok = await jNoToken('GET', '/api/lifecycle/armed');
    A.eq(noTok.status, 403, 'GET /api/lifecycle/armed without X-StarNet-Token -> 403 (token-gated)');

    // ---- ARMING A ROUTINE FLIPS IT TRUE (recurring, so ticks never consume it) ----
    const create = await j('POST', '/api/cron', { name: 'Daily digest', prompt: 'summarize', schedule: '0 9 * * *', agentId: 'lc_test' });
    A.eq(create.status, 200, 'POST /api/cron (valid recurring routine) -> 200');
    const armOn = await j('POST', '/api/cron/arm', { enabled: true });
    A.eq(armOn.status, 200, 'POST /api/cron/arm {enabled:true} -> 200');
    const on = await j('GET', '/api/lifecycle/armed');
    A.eq(on.body.armed, true, 'after arming a routine: armed:true (the process must survive window close)');
    A.eq(on.body.categories.routines.armed, true, 'routines category armed:true');
    A.ok(on.body.categories.routines.count >= 1, 'routines count reflects the real routine (>=1)');
    A.ok(on.body.reasons.some(r => /routine/.test(r)), 'a human "routine(s) armed" reason is surfaced for the tray');

    // A saved paused routine has no unattended work. It must not keep an idle desktop
    // resident or claim "1 routine armed", including after the process reloads its store.
    const routineId = create.body.job.id;
    const paused = await j('POST', '/api/cron/update', { id: routineId, patch: { enabled: false } });
    A.eq(paused.status, 200, 'pause the only routine');
    A.eq(paused.body.job.enabled, false, 'pause persisted the disabled state');
    const pausedLife = await j('GET', '/api/lifecycle/armed');
    A.eq(pausedLife.body.categories.routines.count, 0, 'paused routine is not counted as armed');
    A.eq(pausedLife.body.armed, false, 'only a paused routine does not keep the desktop resident');
    A.eq(pausedLife.body.reasons, [], 'paused routine leaves no misleading tray reason');
    try { child.kill(); } catch (_) {} await sleep(250);
    booted = await boot(port + 100, ws, 20, { SKYNET_CRON_TICK_MS: '300' });
    child = booted.child; port = booted.port; getOut = booted.out;
    apiToken = await bootToken(B(), B());
    A.eq((await j('GET', '/api/lifecycle/armed')).body.armed, false, 'paused-only station stays idle after restart');
    A.eq((await j('POST', '/api/cron/update', { id: routineId, patch: { enabled: true } })).status, 200, 'resume the routine');
    A.eq((await j('GET', '/api/lifecycle/armed')).body.categories.routines.count, 1, 'resumed routine is counted again');
    const otherRoutine = await j('POST', '/api/cron', { name: 'Paused digest', prompt: 'summarize', schedule: '0 10 * * *', agentId: 'lc_test' });
    A.eq(otherRoutine.status, 200, 'create a second saved routine');
    A.eq((await j('POST', '/api/cron/update', { id: otherRoutine.body.job.id, patch: { enabled: false } })).status, 200, 'pause only the second routine');
    A.eq((await j('GET', '/api/lifecycle/armed')).body.categories.routines.count, 1, 'mixed saved routines count only the enabled job');

    // ---- NIGHT-SHIFT HALT TRUTHFULNESS: an armed-but-HALTED shift is not armed work ----
    // Arm the night shift by raising the dial (posture write arms the timer with no restart)…
    const posture = await j('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 2 } });
    A.eq(posture.status, 200, 'POST /api/autonomy/posture (initiative:leash) -> 200');
    const nsOn = await j('GET', '/api/lifecycle/armed');
    A.eq(nsOn.body.categories.nightshift.armed, true, 'raised dial: nightshift.armed:true (timer live)');
    A.ok(nsOn.body.reasons.some(r => /Night shift/i.test(r)), 'a "Night shift armed" reason is surfaced');
    // …then E-STOP. The durable NS halt freezes beats while the timer stays armed — the aggregate must NOT
    // count a frozen shift as armed work. (The same POST also durably halts cron — asserted in the next phase.)
    const halt = await j('POST', '/api/halt', {});
    A.eq(halt.status, 200, 'POST /api/halt (E-STOP) -> 200');
    A.eq(halt.body.terminalStops, 0, 'E-STOP reports the exact number of attached terminal trees it asked to stop');
    A.eq(halt.body.cronHaltPersisted, true, 'E-STOP proves the routine halt reached durable storage');
    A.eq(halt.body.loopsHaltPersisted, true, 'E-STOP proves the loops halt reached durable storage');
    const nsHalted = await j('GET', '/api/lifecycle/armed');
    A.eq(nsHalted.body.categories.nightshift.halted, true, 'after E-STOP: nightshift.halted:true (durable stand-down)');
    A.eq(nsHalted.body.categories.nightshift.armed, true, 'after E-STOP: NS timer still armed (halt freezes beats, not the timer)');
    A.eq(nsHalted.body.armed, false, 'TRUTHFULNESS: halted night shift + halted routines = armed:false (tray may fully quit)');

    // ---- CRON E-STOP HALT (M1): durable, visible, survives restart, lifts only on explicit resume ----
    const cronAfterHalt = await j('GET', '/api/cron');
    A.eq(cronAfterHalt.body.enabled, true, 'after E-STOP: arm INTENT preserved (enabled:true)');
    A.eq(cronAfterHalt.body.halted, true, 'after E-STOP: GET /api/cron reports halted:true (the panel can say "paused")');
    A.eq(nsHalted.body.categories.routines.armed, false, 'after E-STOP: routines category armed:false (timer is down)');
    A.eq(nsHalted.body.categories.routines.halted, true, 'after E-STOP: routines category names the halt');
    A.ok(fs.existsSync(HALT_FILE), 'after E-STOP: cron.halt.json persisted (halt survives restart)');
    // no NEW cron tick may run while halted — snapshot the tick-log count, wait > 2 tick windows, assert flat.
    const ticksBefore = (getOut().match(/\[cron\] cron\.tick/g) || []).length;
    await sleep(800);
    const ticksAfter = (getOut().match(/\[cron\] cron\.tick/g) || []).length;
    A.eq(ticksAfter, ticksBefore, 'halted: the cron timer is genuinely down (no further ticks fire)');

    // ---- RESTART: the halt is durable (armed intent kept, timer stays down) ----
    try { child.kill(); } catch (_) {} await sleep(250);
    booted = await boot(port + 100, ws, 20, { SKYNET_CRON_TICK_MS: '300' });
    child = booted.child; port = booted.port; getOut = booted.out;
    apiToken = await bootToken(B(), B());
    const rebootCron = await j('GET', '/api/cron');
    A.eq(rebootCron.body.enabled, true, 'REBOOT: arm intent persisted (enabled:true)');
    A.eq(rebootCron.body.halted, true, 'REBOOT: still halted (cron.halt.json read at boot)');
    const rebootLife = await j('GET', '/api/lifecycle/armed');
    A.eq(rebootLife.body.armed, false, 'REBOOT: aggregate still armed:false — a halted station never holds the tray open');
    A.ok(getOut().indexOf('cron tick armed') < 0, 'REBOOT: the timer did NOT arm at boot while halted');

    // The dossier mirrors beliefs through the posture route during normal page load. That background write is
    // not Commander consent to resume autonomous work and must leave both durable E-STOPs intact.
    const beliefsOnly = await j('POST', '/api/autonomy/posture', { beliefs: { known: [], beliefs: {} } });
    A.eq(beliefsOnly.body.postureWritten, false, 'beliefs-only sync reports that no autonomy dial was written');
    const afterBeliefsSync = await j('GET', '/api/lifecycle/armed');
    A.eq(afterBeliefsSync.body.categories.routines.halted, true, 'beliefs-only page-load sync preserves the routines E-STOP');
    A.eq(afterBeliefsSync.body.categories.nightshift.halted, true, 'beliefs-only page-load sync preserves the night-shift E-STOP');
    A.eq(afterBeliefsSync.body.armed, false, 'beliefs-only page-load sync cannot silently resume background work');
    const postureMirror = await j('POST', '/api/autonomy/posture', { posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 2 }, resumeHalt: false });
    A.eq(postureMirror.body.postureWritten, true, 'boot mirror may refresh the server posture');
    A.eq(postureMirror.body.resumeRequested, false, 'boot mirror explicitly denies resume consent');
    const afterPostureMirror = await j('GET', '/api/lifecycle/armed');
    A.eq(afterPostureMirror.body.categories.routines.halted, true, 'boot posture mirror preserves the routines E-STOP');
    A.eq(afterPostureMirror.body.categories.nightshift.halted, true, 'boot posture mirror preserves the night-shift E-STOP');

    // ---- EXPLICIT RESUME: POST /api/cron/arm lifts the halt and re-arms NOW ----
    const resume = await j('POST', '/api/cron/arm', { enabled: true });
    A.eq(resume.status, 200, 'resume: POST /api/cron/arm {enabled:true} -> 200');
    A.eq(resume.body.halted, false, 'resume: halt lifted (halted:false in the arm response)');
    const resumed = await j('GET', '/api/lifecycle/armed');
    A.eq(resumed.body.categories.routines.armed, true, 'resume: routines armed again');
    A.eq(resumed.body.categories.routines.halted, false, 'resume: halt flag cleared in the snapshot');
    A.ok(getOut().indexOf('cron tick armed') >= 0, 'resume: the live timer actually re-armed ("cron tick armed")');

    // ---- DURABLE-WRITE FAILURE: immediate RAM halt remains effective, but the response never claims restart safety ----
    // The first successful E-STOP halted loops even though none existed. Explicitly unhalt, then create one live loop
    // so both autonomous schedulers have work to stand down during the injected EISDIR failure.
    const loopUnhalt = await j('POST', '/api/loops/control', { action: 'unhalt' });
    A.eq(loopUnhalt.status, 200, 'setup: loops explicitly unhalted');
    const loopCreate = await j('POST', '/api/loops', { name: 'Durability probe', objective: 'summarize the local fixture' });
    A.eq(loopCreate.status, 200, 'setup: a live loop is created');
    const cronBeforeFault = fs.readFileSync(HALT_FILE);
    const loopsBeforeFault = fs.readFileSync(LOOPS_HALT_FILE);
    fs.unlinkSync(HALT_FILE); fs.mkdirSync(HALT_FILE);          // rename-over-directory => EISDIR/EPERM on durable save
    fs.unlinkSync(LOOPS_HALT_FILE); fs.mkdirSync(LOOPS_HALT_FILE);

    const failedHalt = await j('POST', '/api/halt', {});
    A.eq(failedHalt.status, 200, 'write failure: E-STOP still succeeds for the live process');
    A.eq(failedHalt.body.cronHaltPersisted, false, 'write failure: response denies durable routine halt');
    A.eq(failedHalt.body.loopsHaltPersisted, false, 'write failure: response denies durable loops halt');
    const failedCronNow = await j('GET', '/api/cron');
    const failedLoopsNow = await j('GET', '/api/loops');
    A.eq(failedCronNow.body.halted, true, 'write failure: routines are still halted immediately in RAM');
    A.eq(failedLoopsNow.body.halted, true, 'write failure: loops are still halted immediately in RAM');
    A.eq(failedLoopsNow.body.armed, false, 'write failure: the live loop timer still comes down');

    // Restore the prior durable false records and restart: because the response said persistence failed, resumption is
    // truthful rather than a hidden reversal. The earlier success-path restart already proves true flags stay halted.
    try { child.kill(); } catch (_) {} await sleep(250);
    fs.rmdirSync(HALT_FILE); fs.writeFileSync(HALT_FILE, cronBeforeFault);
    fs.rmdirSync(LOOPS_HALT_FILE); fs.writeFileSync(LOOPS_HALT_FILE, loopsBeforeFault);
    booted = await boot(port + 100, ws, 20, { SKYNET_CRON_TICK_MS: '300' });
    child = booted.child; port = booted.port; getOut = booted.out;
    apiToken = await bootToken(B(), B());
    const failedRebootCron = await j('GET', '/api/cron');
    const failedRebootLoops = await j('GET', '/api/loops');
    A.eq(failedRebootCron.body.halted, false, 'failed durable routine halt is absent after restart, matching its false receipt');
    A.eq(failedRebootLoops.body.halted, false, 'failed durable loops halt is absent after restart, matching its false receipt');
    A.eq(failedRebootLoops.body.armed, true, 'the live loop resumes after the unpersisted halt, exactly as warned');

    // A repaired store can be stamped by the next E-STOP even though the previous process had already set its RAM
    // flags. Then prove explicit resume paths fail closed when clearing those durable flags cannot be saved.
    const repairedHalt = await j('POST', '/api/halt', {});
    A.eq(repairedHalt.body.cronHaltPersisted, true, 'storage recovery: the next E-STOP durably stamps routines');
    A.eq(repairedHalt.body.loopsHaltPersisted, true, 'storage recovery: the next E-STOP durably stamps loops');
    const cronHaltedBytes = fs.readFileSync(HALT_FILE);
    const loopsHaltedBytes = fs.readFileSync(LOOPS_HALT_FILE);
    fs.unlinkSync(HALT_FILE); fs.mkdirSync(HALT_FILE);
    fs.unlinkSync(LOOPS_HALT_FILE); fs.mkdirSync(LOOPS_HALT_FILE);
    const cronResumeFailure = await j('POST', '/api/cron/arm', { enabled: true });
    const loopResumeFailure = await j('POST', '/api/loops/control', { action: 'unhalt' });
    A.eq(cronResumeFailure.status, 500, 'cron resume fails when its durable halt cannot be cleared');
    A.eq(loopResumeFailure.status, 500, 'loop resume fails when its durable halt cannot be cleared');
    const stillHaltedCron = await j('GET', '/api/cron');
    const stillHaltedLoops = await j('GET', '/api/loops');
    A.eq(stillHaltedCron.body.halted, true, 'failed cron resume leaves the live halt in force');
    A.eq(stillHaltedLoops.body.halted, true, 'failed loop resume leaves the live halt in force');
    fs.rmdirSync(HALT_FILE); fs.writeFileSync(HALT_FILE, cronHaltedBytes);
    fs.rmdirSync(LOOPS_HALT_FILE); fs.writeFileSync(LOOPS_HALT_FILE, loopsHaltedBytes);
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('lifecycle-armed.http.test');
})().catch(e => { console.log('FAIL: lifecycle-armed.http.test threw — ' + (e && e.stack || e)); process.exit(1); });
