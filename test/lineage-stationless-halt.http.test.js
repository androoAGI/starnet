/* node test/lineage-stationless-halt.http.test.js — a fresh install that is opened and closed once must
   still onboard (2026-08-25 stranded-user class).

   THE BUG: the desktop shell fires POST /api/halt (the E-STOP) on EVERY clean quit. handleHalt durably
   writes loops.halt.json + nightshift.state.json (+ cron.halt.json when armed) even when no station was
   ever created. workspace-lineage counted those bookkeeping files as prior-station evidence, so the NEXT
   boot showed PRIOR STATION DATA FOUND with nothing recoverable — Retry could never succeed, and START
   FRESH only held until the next quit re-wrote the files. Open-once-close-once = stranded forever.

   THE RATCHET: boot the REAL host against an empty temp workspace (no key, zero spend; HOME/APPDATA
   sandboxed so the dev machine's real legacy roots never leak in as evidence), fire the exact quit-path
   E-STOP, restart the host, and require GET /api/lineage to say onboardingAllowed:true. This drives the
   real writers — any future stationless boot/halt write that re-enters STATE_EVIDENCE fails here, not on
   a user's machine. NOT in test:fast (child-process boot). Run via `npm run test:http`.

   #123 (2026-10-17): the same class from a BOOT timer. The QUEST REFRESH boot look (3 s after listen) stamped
   _station.questrefresh.json + .bak on a station-less workspace, which matched the `_station.*` evidence family.
   This ratchet used to boot with SKYNET_QUEST_REFRESH=0, which hid it — so session 1 now runs with the quest
   refresh ON and waits past its boot look before the quit: the tick must write nothing, and the restart must
   still onboard. */
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

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lineage-halt-'));
  const appData = path.join(sandbox, 'appdata');
  const ws = path.join(appData, 'ai.skynet.harness', 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  // Sandbox every root the lineage inspector can look sideways into — the dev machine's REAL profile must
  // never supply evidence to this test (same isolation as workspace-lineage.http.test.js).
  const baseEnv = Object.assign({}, process.env, {
    LOCALAPPDATA: appData, APPDATA: appData,
    HOME: sandbox, USERPROFILE: sandbox,
    SKYNET_WORKSPACES: ws, SKYNET_LIVE_PRICES: '0',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
  });
  // the quest refresh stays ON (its default): its boot look is one of the stationless writers under test (#123)
  delete baseEnv.SKYNET_QUEST_REFRESH; delete baseEnv.STARNET_QUEST_REFRESH;
  function boot(port, attemptsLeft) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [INDEX], {
        env: Object.assign({}, baseEnv, { SKYNET_PORT: String(port) }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', settled = false;
      const onData = d => {
        out += d.toString();
        if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
        if (!settled && BIND_REFUSED.test(out)) {
          settled = true; try { child.kill(); } catch (_) {}
          if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, attemptsLeft - 1)));
          else reject(new Error('no free port'));
        }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', e => { if (!settled) { settled = true; reject(e); } });
      setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 9000);
    });
  }
  function stop(child) {
    return new Promise(resolve => {
      if (!child || child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      try { child.kill(); } catch (_) { resolve(); }
      setTimeout(resolve, 3000);
    });
  }
  let child = null;
  try {
    // ---- SESSION 1: virgin workspace, the quit path fires the E-STOP (exactly what the Tauri shell does) ----
    let booted = await boot(await allocatePort(), 20);
    const bootedAt = Date.now();   // the listen banner: the quest-refresh boot look is armed 3 s after it
    child = booted.child; let port = booted.port;
    const B = () => 'http://' + HOST + ':' + port;
    let apiToken = await bootToken(B(), B());
    const j = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json', Origin: B() };
      if (apiToken) headers['X-StarNet-Token'] = apiToken;
      const r = await fetch(B() + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    const first = await j('GET', '/api/lineage');
    A.eq(first.status, 200, 'GET /api/lineage -> 200');
    A.eq(first.body.lineage.onboardingAllowed, true, 'a virgin workspace onboards');
    // #123: let the quest-refresh boot look fire (3 s after listen) BEFORE the quit — the E-STOP must not mask it.
    const lookDone = bootedAt + 4000;
    if (Date.now() < lookDone) await new Promise(r => setTimeout(r, lookDone - Date.now()));
    A.eq(fs.existsSync(path.join(ws, '_station.questrefresh.json')), false, 'the quest-refresh boot look writes nothing on a station-less workspace');
    const halt = await j('POST', '/api/halt', {});
    A.eq(halt.status, 200, 'quit-path E-STOP -> 200');
    A.eq(halt.body.nightshiftHaltPersisted, true, 'the E-STOP durably wrote its night-shift bookkeeping');
    A.eq(halt.body.loopsHaltPersisted, true, 'the E-STOP durably wrote its loops bookkeeping');
    await stop(child); child = null;
    A.eq(fs.existsSync(path.join(ws, 'loops.halt.json')), true, 'fixture is real: the halt file exists on disk');
    A.eq(fs.existsSync(path.join(ws, 'nightshift.state.json')), true, 'fixture is real: the night-shift state file exists on disk');

    // ---- SESSION 2: the boot that used to strand the user on PRIOR STATION DATA FOUND ----
    booted = await boot(await allocatePort(), 20);
    child = booted.child; port = booted.port;
    apiToken = await bootToken(B(), B());
    const second = await j('GET', '/api/lineage');
    A.eq(second.status, 200, 'GET /api/lineage after restart -> 200');
    A.eq(second.body.lineage.priorInstallEvidence, false, 'E-STOP bookkeeping from a stationless session is not prior-station evidence');
    A.eq(second.body.lineage.onboardingAllowed, true, 'open-once-close-once still onboards (the stranded-install class)');
    await stop(child); child = null;
    A.report('lineage-stationless-halt.http.test');
  } finally {
    await stop(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
