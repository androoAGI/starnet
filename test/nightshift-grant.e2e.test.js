/* node test/nightshift-grant.e2e.test.js — real sidecar proof for the DIAL-IS-THE-CONSENT fix (2026-07-13).

   THE BUG: at dial initiative:'free' reach:'sandbox' (buildsUnattended) with no away-workshop grant, every
   night-shift beat silently degraded to a reason-only draft — "dial at max, station never builds". The fix:
   POST /api/autonomy/posture records the night-shift agent's grant through the SAME workshopStore authority,
   never overriding an explicit per-agent decision, and GET /api/nightshift/status names the build-vs-draft
   mode + the readiness detail so a degraded/cold station SAYS so.

   Proves, against the ACTUAL sidecar (no model calls needed — these are pure consent/telemetry routes):
     · a build-capable dial write AUTO-GRANTS the undecided default agent (disk-provable, restart-safe);
     · the grant is recorded as AUTO (provenance) and the autonomy ledger notes it;
     · an EXPLICIT revoke via POST /api/workshop/grant survives any later dial write (the dial never overrides);
     · /api/nightshift/status tells the truth: buildMode/draftReason track posture×grant, readiness is present;
     · a below-build dial write does NOT grant. */
'use strict';

const A = require('./_assert.js');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function setPosture(B, headers, initiative, reach) {
  const r = await fetch(B + '/api/autonomy/posture', { method: 'POST', headers, body: JSON.stringify({ posture: { initiative, reach, leashPerDay: 6 } }) });
  return r.json();
}
async function status(B, headers) { return (await fetch(B + '/api/nightshift/status', { headers })).json(); }
function wsRecord(ws) { try { return JSON.parse(fs.readFileSync(path.join(ws, 'agent.workshop.json'), 'utf8')); } catch (_) { return null; } }

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-nsgrant-e2e-'));
  const env = { SKYNET_WORKSPACES: ws, SKYNET_DEV: '1' };
  let { child, port } = await boot(await allocatePort(), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };

    // ===== 1. a BELOW-build dial write does NOT grant (reach observe → buildsUnattended false). =====
    let j = await setPosture(B, headers, 'leash', 'observe');
    A.ok(j.ok === true, 'posture route accepts the dial write');
    A.ok(j.workshopGranted === false, 'reach observe: no auto-grant (workshopGranted:false)');
    A.ok(wsRecord(ws) === null || wsRecord(ws).grant !== true, 'reach observe: nothing granted on disk');
    let st = await status(B, headers);
    A.eq(st.buildMode, 'draft', 'reach observe: status says draft mode');
    A.eq(st.draftReason, 'reach', 'reach observe: the draft reason names REACH');
    A.ok(st.readiness && typeof st.readiness.tier === 'string', 'status exposes the readiness detail (tier present)');
    A.ok(Number.isFinite(st.readiness.hotDimsMin) && Number.isFinite(st.readiness.hotRunsMin), 'readiness names both hot bars');

    // ===== 2. the BUILD-capable dial write IS the consent: auto-grant, provenance, ledger note, honest status. =====
    j = await setPosture(B, headers, 'free', 'sandbox');
    A.ok(j.workshopGranted === true, 'dial free/sandbox: the posture write auto-granted the away workshop');
    const rec = wsRecord(ws);
    A.ok(rec && rec.grant === true && rec.grantAuto === true && rec.grantExplicit !== true, 'the grant is on DISK, marked auto (not explicit)');
    st = await status(B, headers);
    A.eq(st.buildMode, 'build', 'dial free/sandbox + grant: status says BUILD mode');
    A.eq(st.draftReason, null, 'build mode carries no draft reason');
    A.eq(st.workshopGranted, true, 'status exposes the recorded grant');
    const led = await (await fetch(B + '/api/autonomy/ledger?source=nightshift', { headers })).json();
    const entries = (led && led.entries) || [];
    A.ok(entries.some(e => e && e.reason === 'workshop-grant:auto'), 'the autonomy ledger recorded the auto-grant honestly');

    // ===== 3. the grant SURVIVES a sidecar restart (durable consent, not a session flag). =====
    try { child.kill(); } catch (_) {}
    await new Promise(r => setTimeout(r, 400));
    ({ child, port } = await boot(await allocatePort(), env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    st = await status(B, headers);
    A.eq(st.workshopGranted, true, 'the auto-grant survives a restart');
    A.eq(st.buildMode, 'build', 'build mode survives a restart');

    // ===== 4. an EXPLICIT revoke stands — the dial NEVER overrides the Commander's per-agent decision. =====
    await fetch(B + '/api/workshop/grant', { method: 'POST', headers, body: JSON.stringify({ agentId: 'agent', on: false }) });
    j = await setPosture(B, headers, 'free', 'sandbox');
    A.ok(j.workshopGranted === false, 'after an explicit OFF, a dial write does NOT re-grant');
    const rec2 = wsRecord(ws);
    A.ok(rec2 && rec2.grant === false && rec2.grantExplicit === true, 'the explicit revoke is on disk and marked explicit');
    st = await status(B, headers);
    A.eq(st.buildMode, 'draft', 'revoked: status honestly says draft mode');
    A.eq(st.draftReason, 'no-workshop-grant', 'revoked: the draft reason names the missing grant');
  } finally {
    try { child.kill(); } catch (_) {}
  }
  A.report('nightshift-grant.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
