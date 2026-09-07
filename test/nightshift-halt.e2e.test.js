/* node test/nightshift-halt.e2e.test.js — E-STOP DURABLY halts the night shift (the resume-after-cooldown escape).

   THE ESCAPE (found 2026-07-08): the composition root wired isHalted: () => false, so POST /api/halt only aborted
   the one in-flight beat — the leash unit + lastBeatAt were already spent at accept-time, so the ~45-min cooldown
   was the ONLY thing pausing autonomy, and beats RESUMED on their own after the Commander hit the emergency stop.

   This boots the ACTUAL sidecar (no mock provider needed — the halt seam never reaches a model) and proves, over
   HTTP, at the exact seam that was broken:
     · POST /api/halt stamps a DURABLE halt → GET /api/nightshift/status reports halted:true and (once away)
       binding:'halt' — the pure gate the old wiring could never reach.
     · the halt SURVIVES a sidecar restart (a reboot must never silently re-enable overnight spend).
     · a deliberate dial re-write (`resumeHalt:true`) LIFTS the halt — the shift is not wedged forever. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}
function kill(child) { return new Promise(r => { try { child.on('exit', () => r()); child.kill(); } catch (_) { r(); } setTimeout(r, 3000); }); }

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nshalt-ws-'));
  // away threshold 1ms so the pure gates get PAST 'present' and the status binding can truthfully name 'halt'.
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1', SKYNET_NIGHTSHIFT_AWAY_MS: '1' };
  let { child, port } = await boot(8990 + (process.pid % 25), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const status = async () => (await fetch(B + '/api/nightshift/status', { headers })).json();

    // arm the shift by raising the dial (the same call a live station makes) — and confirm the clean baseline.
    const arm = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 3 } }) })).json();
    A.ok(arm.ok === true && arm.nightshiftArmed === true, 'raising the dial arms the night shift');
    let s = await status();
    A.eq(s.halted, false, 'baseline: not halted');

    // ===== 1. E-STOP → the halt is stamped and TRUTHFULLY reported =====
    const halt = await (await fetch(B + '/api/halt', { method: 'POST', headers })).json();
    A.ok(typeof halt.halted === 'number', 'POST /api/halt answered with its honest abort count');
    s = await status();
    A.eq(s.halted, true, 'status reports halted:true after E-STOP');
    await sleep(30);   // let the 1ms away threshold elapse so `present` stops outranking `halt`
    s = await status();
    A.eq(s.binding, 'halt', 'the binding gate is HALT (the pure gate the old isHalted:()=>false could never reach)');

    // ===== 2. the halt SURVIVES a restart (reboot must never silently re-enable overnight spend) =====
    await kill(child);
    ({ child, port } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    s = await status();
    A.eq(s.halted, true, 'the halt survived the sidecar restart (durable, not in-memory)');

    // ===== 3. a background beliefs mirror must NOT impersonate an explicit resume =====
    const beliefsOnly = await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ beliefs: { known: [], beliefs: {} } }) })).json();
    A.eq(beliefsOnly.postureWritten, false, 'beliefs-only posture sync identifies that no dial was written');
    s = await status();
    A.eq(s.halted, true, 'beliefs-only page-load sync does not lift the durable E-STOP');

    // ===== 4. a deliberate dial re-write LIFTS the halt (not wedged forever) =====
    await (await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative: 'leash', reach: 'sandbox', leashPerDay: 3 }, resumeHalt: true }) })).json();
    s = await status();
    A.eq(s.halted, false, 're-writing the autonomy dial lifts the halt');
    A.ok(s.binding !== 'halt', 'the binding is no longer halt (got ' + s.binding + ')');
    await fetch(B + '/api/halt', { method: 'POST', headers });
    const unified = await fetch(B + '/api/halt/resume', { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
    A.eq(unified.status, 200, 'dedicated recovery resumes without writing the dial');
    s = await status();
    A.eq(s.halted, false, 'dedicated recovery clears the night shift halt');
    A.ok(s.binding !== 'halt', 'the real night shift gate is open after dedicated recovery');
  } finally {
    await kill(child);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('nightshift-halt.e2e.test');
})().catch(e => { console.error('nightshift-halt.e2e.test FAILED:', e); process.exit(1); });
