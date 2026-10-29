/* node test/boot-security.test.js
   Fast boot-level security checks for the real sidecar authority boundary. */
'use strict';

const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function boot(port, workspaces, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, {
        STARNET_PORT: String(port),
        STARNET_WORKSPACES: workspaces,
        // the token-gated-POST probe below uses /api/budget/resume{day}; shipped pool defaults are UNGOVERNED
        // (2026-07-23 budget-legibility pass — resume on an ungoverned scope 409s), so govern the day pool here.
        STARNET_BUDGET_PER_DAY: '40'
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) {
        settled = true;
        resolve({ child, port });
      }
      if (!settled && BIND_REFUSED.test(out)) {
        settled = true;
        try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, workspaces, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill(); } catch (_) {}
        reject(new Error('boot timeout; output:\n' + out));
      }
    }, 30000);
  });
}

function extractBootToken(html) {
  const m = String(html || '').match(/window\.__STARNET_API_TOKEN__\s*=\s*"([^"]+)"/);
  return m ? m[1] : '';
}

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-bootsec-'));
  const booted = await boot(await allocatePort(), ws, 20);
  const { child, port } = booted;
  const B = 'http://' + HOST + ':' + port;

  try {
    const index = await (await fetch(B + '/')).text();
    const browserToken = extractBootToken(index);
    A.ok(browserToken.length >= 32, 'browser-mode index.html carries the API token at boot');

    fs.mkdirSync(path.join(ws, 'agent'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'agent', 'deliverable.html'), '<script>fetch("/api/session",{method:"POST"})</script>');
    const activeFileUrl = B + '/api/file?agent=agent&path=' + encodeURIComponent('deliverable.html');
    const unauthActiveFile = await fetch(activeFileUrl, { headers: { Origin: B } });
    A.eq(unauthActiveFile.status, 403, 'same-origin active deliverable cannot be read without the API token');
    const activeFile = await fetch(activeFileUrl, { headers: { Origin: B, 'X-StarNet-Token': browserToken } });
    A.eq(activeFile.status, 200, 'tokened active deliverable can still be downloaded');
    A.ok(/^attachment\b/.test(activeFile.headers.get('content-disposition') || ''), 'script-capable deliverable is forced to attachment');
    A.ok(/sandbox/.test(activeFile.headers.get('content-security-policy') || ''), 'script-capable deliverable carries sandbox CSP');

    const activeDeliverableSession = await fetch(B + '/api/session', {
      method: 'POST',
      headers: { Origin: B, Referer: B + '/api/file?agent=agent&path=deliverable.html' }
    });
    A.eq(activeDeliverableSession.status, 403, 'same-origin active deliverable cannot mint API authority');

    const freeGetSession = await fetch(B + '/api/session');
    A.eq(freeGetSession.status, 403, 'GET /api/session is not freely retrievable');

    const noOriginSession = await fetch(B + '/api/session', { method: 'POST' });
    A.eq(noOriginSession.status, 403, 'POST /api/session without token is refused');

    const tokenedSession = await fetch(B + '/api/session', {
      method: 'POST',
      headers: { Origin: B, 'X-StarNet-Token': browserToken }
    });
    A.eq(tokenedSession.status, 200, 'POST /api/session with token succeeds');
    const tokenedSessionBody = await tokenedSession.json().catch(() => ({}));
    A.eq(tokenedSessionBody.token, undefined, 'POST /api/session never returns the API token');

    const unauthBudget = await fetch(B + '/api/budget/status', { headers: { Origin: B } });
    A.eq(unauthBudget.status, 403, 'sensitive GET without token is refused');

    const unauthSave = await fetch(B + '/api/save?agent=agent', { headers: { Origin: B } });
    A.eq(unauthSave.status, 403, 'sensitive save GET without token is refused');

    const browserBudget = await fetch(B + '/api/budget/status', {
      headers: { Origin: B, 'X-StarNet-Token': browserToken }
    });
    A.eq(browserBudget.status, 200, 'trusted browser flow can read budget with the boot token');

    const browserResume = await fetch(B + '/api/budget/resume', {
      method: 'POST',
      headers: { Origin: B, 'X-StarNet-Token': browserToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'day' })
    });
    A.eq(browserResume.status, 200, 'trusted browser flow can perform token-gated POSTs');

    const tauriOrigin = 'http://tauri.localhost';
    const tauriBudget = await fetch(B + '/api/budget/status', {
      headers: { Origin: tauriOrigin, 'X-StarNet-Token': browserToken }
    });
    A.eq(tauriBudget.status, 200, 'Tauri trusted flow can read token-gated GETs');

    const sse = await fetch(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(browserToken), {
      headers: { Origin: B }
    });
    A.eq(sse.status, 200, 'browser EventSource flow can authenticate with token query');
    try { if (sse.body && sse.body.cancel) await sse.body.cancel(); } catch (_) {}
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }

  A.report('boot-security.test');
})().catch(e => { console.log('FAIL: boot-security.test threw - ' + ((e && e.stack) || e)); process.exit(1); });
