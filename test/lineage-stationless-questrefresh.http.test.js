/* node test/lineage-stationless-questrefresh.http.test.js — a fresh install that is opened and closed once must
   still onboard: the quest-refresh boot tick is the SECOND stationless writer (#123; same class as the
   2026-08-25 E-STOP case in lineage-stationless-halt.http.test.js, reached through a different writer).

   THE BUG: armQuestRefresh schedules a boot catch-up tick ~3 s after boot. questRefreshTick gates on the
   autonomy posture and SKYNET_QUEST_REFRESH, never on a station existing, and a never-cycled state is always
   due — so on the very FIRST boot it stamps the cycle and persists _station.questrefresh.json (+ .bak via
   saveResilient), then records the honest 'skipped' (no key) ledger entry. workspace-lineage's
   `_(?:station|commander).*.json` alternative counted those two files as prior-station evidence, so the NEXT
   boot showed PRIOR STATION DATA FOUND with nothing recoverable. START FRESH quarantined them, but the
   following boot's tick wrote them straight back: open-once-close-once = stranded on every restart.

   THE RATCHET: boot the REAL host against an empty temp workspace (no key, zero spend; HOME/APPDATA
   sandboxed so the dev machine's real legacy roots never leak in as evidence), let the real boot tick write
   its bookkeeping, restart the host, and require GET /api/lineage to say onboardingAllowed:true. This drives
   the real writer — any future stationless quest-refresh write that re-enters STATE_EVIDENCE fails here, not
   on a user's machine. NOT in test:fast (child-process boot + the 3 s timer). Run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const QUESTREFRESH_FILE = '_station.questrefresh.json';

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-lineage-questrefresh-'));
  const appData = path.join(sandbox, 'appdata');
  const ws = path.join(appData, 'ai.skynet.harness', 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  // Sandbox every root the lineage inspector can look sideways into — the dev machine's REAL profile must
  // never supply evidence to this test (same isolation as lineage-stationless-halt.http.test.js). The quest
  // refresh stays ARMED (it is the writer under test); every key source its cycle could resolve is blanked so
  // it takes the no-credential 'skipped' path — no provider call, zero spend.
  const baseEnv = Object.assign({}, process.env, {
    LOCALAPPDATA: appData, APPDATA: appData,
    HOME: sandbox, USERPROFILE: sandbox,
    SKYNET_WORKSPACES: ws, SKYNET_LIVE_PRICES: '0', SKYNET_QUEST_REFRESH: '1',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENROUTER_KEY: '', OPENROUTER_API_KEY: ''
  });
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
        if (!settled && /already in use/i.test(out)) {
          settled = true; try { child.kill(); } catch (_) {}
          if (attemptsLeft > 0) resolve(boot(port + 1, attemptsLeft - 1));
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
  function waitForFile(file, ms) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (fs.existsSync(file)) return resolve();
        if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + file));
        setTimeout(tick, 100);
      };
      tick();
    });
  }
  let child = null;
  try {
    // ---- SESSION 1: virgin workspace; the boot catch-up tick fires on its own ~3 s in (no request needed) ----
    let booted = await boot(9180 + (process.pid % 40), 20);
    child = booted.child; let port = booted.port;
    const B = () => 'http://' + HOST + ':' + port;
    let apiToken = await bootToken(B(), B());
    const j = async (m, p) => {
      const headers = { Origin: B() };
      if (apiToken) headers['X-StarNet-Token'] = apiToken;
      const r = await fetch(B() + p, { method: m, headers });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    const first = await j('GET', '/api/lineage');
    A.eq(first.status, 200, 'GET /api/lineage -> 200');
    A.eq(first.body.lineage.onboardingAllowed, true, 'a virgin workspace onboards');
    // the second persist (the 'skipped' ledger note) snapshots the first into .bak — once .bak exists both are down.
    await waitForFile(path.join(ws, QUESTREFRESH_FILE + '.bak'), 20000);
    await stop(child); child = null;
    A.eq(fs.existsSync(path.join(ws, QUESTREFRESH_FILE)), true, 'fixture is real: the boot tick wrote ' + QUESTREFRESH_FILE + ' with no key and no station');
    A.eq(fs.existsSync(path.join(ws, QUESTREFRESH_FILE + '.bak')), true, 'fixture is real: saveResilient left the .bak sibling too');
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(ws, QUESTREFRESH_FILE), 'utf8')).state; } catch (_) {}
    A.eq(!!(state && Array.isArray(state.ledger) && state.ledger.some(e => e && e.outcome === 'skipped')), true, 'the cycle took the no-credential path (honest skipped entry, zero spend)');

    // ---- SESSION 2: the boot that used to strand the user on PRIOR STATION DATA FOUND ----
    booted = await boot(port + 1, 20);
    child = booted.child; port = booted.port;
    apiToken = await bootToken(B(), B());
    const second = await j('GET', '/api/lineage');
    A.eq(second.status, 200, 'GET /api/lineage after restart -> 200');
    A.eq(second.body.lineage.priorInstallEvidence, false, 'quest-refresh bookkeeping from a stationless boot is not prior-station evidence');
    A.eq(second.body.lineage.onboardingAllowed, true, 'open-once-close-once still onboards (the stranded-install class, quest-refresh writer)');
    await stop(child); child = null;
    A.report('lineage-stationless-questrefresh.http.test');
  } finally {
    await stop(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
