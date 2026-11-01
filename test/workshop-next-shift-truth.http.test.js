/* node test/workshop-next-shift-truth.http.test.js — the away-workshop card never promises a shift the scheduler
   will not run (sweep/autonomy 2026-10-20).

   THE LIE (found live): GET /api/workshop/backlog derived `nextShiftAt` from the workshop routine's own
   enabled+nextRunAt and never looked at the scheduler. Turn scheduling OFF (POST /api/cron/arm false) or press the
   E-STOP, and the agent dossier's workshop card kept counting down "next shift in 6h" to a fire that cannot happen —
   while GET /api/cron, the ROUTINES panel and the apps list all said routines are off. The route now withholds the
   clock and names WHY (`shiftsPaused`: 'scheduler-off' | 'halted'), from the same live cronArmed/cronHalted state
   the ROUTINES panel reads. Real isolated sidecar; no provider is needed (nothing may fire). */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function bootSidecar(port, workspaces, attempts) {
  return new Promise((resolve, reject) => {
    const appSandbox = path.join(workspaces, '_appdata');
    const env = Object.assign({}, process.env);
    for (const k of Object.keys(env)) if (/^(STARNET_|SKYNET_|HERMES_|OPENROUTER_)/i.test(k)) delete env[k];
    Object.assign(env, {
      SKYNET_PORT: String(port), SKYNET_WORKSPACES: workspaces, SKYNET_DEV: '1', SKYNET_QUEST_REFRESH: '0',
      SKYNET_CLOUD_URL: '', SKYNET_CREDITS_URL: '', SKYNET_EDGE_TTS: '0', SKYNET_LIVE_PRICES: '0',
      LOCALAPPDATA: appSandbox, APPDATA: appSandbox, XDG_DATA_HOME: appSandbox
    });
    if (!path.resolve(workspaces).startsWith(path.resolve(os.tmpdir())) || port === 8787) throw new Error('refusing a non-isolated sidecar');
    const child = spawn(process.execPath, [INDEX], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.includes('http://' + HOST + ':' + port)) { settled = true; resolve({ child, port }); }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attempts > 0) resolve(allocatePort().then(next => bootSidecar(next, workspaces, attempts - 1)));
        else reject(new Error('no free sidecar port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 15000);
  });
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-workshop-next-'));
  let child = null;
  try {
    let port;
    ({ child, port } = await bootSidecar(await allocatePort(), ws, 30));
    const B = 'http://' + HOST + ':' + port;
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = async (route, body) => (await fetch(B + route, { method: 'POST', headers, body: JSON.stringify(body) })).json();
    const card = async () => (await fetch(B + '/api/workshop/backlog?agent=agent', { headers })).json();

    const g = await post('/api/workshop/grant', { agentId: 'agent', on: true });
    A.ok(g.ok === true, 'granting the away workshop succeeds (and arms scheduling)');
    const on = await card();
    A.ok(on.granted === true && !!Date.parse(on.nextShiftAt), 'scheduling ON: the card carries the shift routine\'s real next fire');
    A.eq(on.shiftsPaused || null, null, 'scheduling ON: nothing is paused');

    const off = await post('/api/cron/arm', { enabled: false });
    A.ok(off.ok === true && off.enabled === false, 'scheduling turned OFF');
    const c1 = await card();
    A.eq(c1.nextShiftAt, null, 'scheduling OFF: no next-shift clock for a fire that cannot happen');
    A.eq(c1.shiftsPaused, 'scheduler-off', 'scheduling OFF: the card is told why');

    await post('/api/cron/arm', { enabled: true });
    const halt = await fetch(B + '/api/halt', { method: 'POST', headers, body: '{}' });
    A.eq(halt.status, 200, 'E-STOP engaged');
    const c2 = await card();
    A.eq(c2.nextShiftAt, null, 'E-STOP: no next-shift clock while the scheduler is stood down');
    A.eq(c2.shiftsPaused, 'halted', 'E-STOP: the card is told why');

    // the frontend renders the reason instead of a countdown (source guard on the one consumer of nextShiftAt)
    const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
    A.ok(/j\.shiftsPaused === 'halted'/.test(ui) && /j\.shiftsPaused/.test(ui.slice(ui.indexOf('function renderWsLive'), ui.indexOf('function renderWsLive') + 4000)), 'the workshop card renders shiftsPaused before any countdown');
  } finally {
    try { if (child) child.kill(); } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('workshop-next-shift-truth.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
