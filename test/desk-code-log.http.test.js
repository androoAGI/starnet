/* node test/desk-code-log.http.test.js — A CONSOLE THAT IS A LOG KEEPS NO DESK CODE (final review #9, 2026-11-08).

   The review's live repro: on a bare station run by pm2, the client key asked for FULL BYPASS, got the desk challenge, read
   the six digits from ~/.pm2/logs and replayed them: FULL BYPASS on. Now a station whose console is kept (pm2, stderr
   redirected to a file or a socket) does not write the code; it says what is waiting and how to confirm it. An operator
   who wants the code in the log anyway says so with STARNET_DESK_CODE_TO_LOG=1. A station in a terminal, or whose console
   is a pipe to the program that started it (the `starnet` terminal, the tests), is unchanged.

   The real sidecar, bare (browser mode). */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { station, cleanup, freePort, sleep, HOST, API } = require('./helpers/desk-station.js');
const { seedActiveStation } = require('./helpers/station.js');

const CODE_LINE = /Type code \d{6} in the StarNet page/;

async function bypassAsk(call, tok) {
  return call(tok, 'POST', '/api/permissions/bypass', { on: true });
}

(async () => {
  const roots = [];
  const fresh = () => { const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-code-log-')); seedActiveStation(ws); roots.push(ws); return ws; };
  let st = null;
  try {
    // 1. pm2: its console is saved to a log, so no code is written there
    st = await station(fresh(), { pm_id: '0' }, 'bare');
    const r = await bypassAsk(st.call, st.CLIENT);
    A.eq(r.status, 403, 'pm2: the client key cannot turn FULL BYPASS on by itself');
    const ch = r.body && r.body.deskConfirm;
    A.ok(ch && ch.mode === 'page' && ch.code, 'pm2: it gets the page challenge');
    await sleep(400);
    const out = st.child.out();
    A.ok(!CODE_LINE.test(out), 'final review #9: pm2 keeps no desk code in its log');
    A.ok(/saved by pm2, so its code is not written here/.test(out) && out.indexOf(ch.code) >= 0, 'the log says what is waiting (its label) and why there is no code');
    A.ok(/STARNET_DESK_CODE_TO_LOG=1/.test(out) && /run the station in a terminal/.test(out), 'and how to confirm it');
    const p = await st.call(st.CLIENT, 'GET', '/api/permissions');
    A.eq(p.body && p.body.masterBypass, false, 'FULL BYPASS stays off');
    await st.stop(); st = null;

    // 2. the operator's own choice: codes in the log anyway
    st = await station(fresh(), { pm_id: '0', STARNET_DESK_CODE_TO_LOG: '1' }, 'bare');
    const r2 = await st.viaDesk('POST', '/api/permissions/bypass', { on: true });
    A.eq(r2.status, 200, 'with STARNET_DESK_CODE_TO_LOG=1 the code is in the log and confirms');
    await st.stop(); st = null;

    // 3. an ordinary piped console (the tests, the starnet terminal's child) is unchanged
    st = await station(fresh(), {}, 'bare');
    const r3 = await st.viaDesk('POST', '/api/permissions/bypass', { on: true });
    A.eq(r3.status, 200, 'a console that is a pipe still shows the code');
    await st.stop(); st = null;

    // 4. stderr redirected to a file (npm start 2> station.log, nohup, a service): no code in the file
    const ws = fresh();
    const port = await freePort();
    const logFile = path.join(ws, 'station-err.log');
    const fd = fs.openSync(logFile, 'w');
    const prof = path.join(ws, '_appdata'); fs.mkdirSync(prof, { recursive: true });
    const env = Object.assign({}, process.env, { SKYNET_PORT: String(port), STARNET_PORT: String(port), SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
      SKYNET_EDGE_TTS_PROBE: '0', STARNET_CLAUDE_BIN: path.join(prof, 'none.cmd'), SKYNET_AUX_BUDGET: '0', SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '',
      LOCALAPPDATA: prof, APPDATA: prof, XDG_DATA_HOME: prof, SKYNET_API_TOKEN: API });
    delete env.STARNET_DESK_CODE_TO_LOG; delete env.SKYNET_DESK_CODE_TO_LOG; delete env.pm_id; delete env.PM2_HOME; delete env.pm_err_log_path;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'index.js')], { env, stdio: ['ignore', 'pipe', fd] });
    let exited = false; child.on('close', () => { exited = true; });
    let outBuf = '';
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('boot timeout')), 150000);
      child.stdout.on('data', d => { outBuf += d.toString(); if (/Open in your browser:\s+http:\/\/127\.0\.0\.1:\d+/.test(outBuf)) { clearTimeout(t); resolve(); } });
      child.on('close', c => { clearTimeout(t); reject(new Error('exited ' + c + '\n' + outBuf.slice(-2000))); });
    });
    try {
      const B = 'http://' + HOST + ':' + port;
      const page = await (await fetch(B + '/')).text();
      const m = /window\.__STARNET_API_TOKEN__=("[^"]*")/.exec(page);
      const CLIENT = m ? JSON.parse(m[1]) : '';
      const r4 = await fetch(B + '/api/permissions/bypass', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': CLIENT, Origin: B }, body: JSON.stringify({ on: true }) });
      A.eq(r4.status, 403, 'file: the challenge is given');
      await sleep(500);
      const logged = fs.readFileSync(logFile, 'utf8');
      A.ok(!CODE_LINE.test(logged) && !CODE_LINE.test(outBuf), 'final review #9: a console redirected to a file keeps no desk code');
      A.ok(/kept in a log, so its code is not written here/.test(logged), 'the file says why: ' + logged.slice(-400));
    } finally {
      try { child.kill(); } catch (_) { /* gone */ }
      for (let i = 0; i < 60 && !exited; i++) await sleep(100);
      await sleep(300);
      try { fs.closeSync(fd); } catch (_) { /* closed */ }
    }
  } catch (e) {
    A.ok(false, 'threw: ' + (e && e.stack || e) + (st ? '\n' + st.child.out().slice(-2000) : ''));
  } finally {
    if (st) await st.stop();
    for (const ws of roots) cleanup(ws);
  }
  A.report('desk-code-log.http.test');
})();
