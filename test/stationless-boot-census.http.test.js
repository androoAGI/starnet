/* node test/stationless-boot-census.http.test.js — a fresh install with every scheduler armed still onboards, and nothing a
   station-less session or a WAKE cut short leaves behind can trap it in Recovery Mode.

   THE CLASS (2026-08-25 stranded-user, #123 2026-10-17, gh#101 / gh#65 family): whether a workspace "has a station" used
   to be a filename regex (workspace-lineage STATE_EVIDENCE), so ANY station-scoped file a station-less writer left became
   "prior station data" and the next boot showed PRIOR STATION DATA FOUND with nothing to recover:
   - the quit-path E-STOP (the desktop shell fires POST /api/halt on EVERY clean quit) wrote halt bookkeeping;
   - the quest-refresh boot look stamped _station.questrefresh.json (#123: fixed for that one writer, by a gate that read
     the same regex);
   - an ARMED NIGHT SHIFT's first tick writes a decline row to autonomy.ledger.jsonl — that row alone trapped the install,
     and it turned the #123 gate back on, so the quest-refresh file came back by cascade;
   - the station-scoped routes WAKE calls before its first save (the permission, posture and journey lock-downs, the memory
     wipe, the scout pushes, dossier and goals) each write a regex file, so a WAKE cut short trapped the next boot.
   Each was patched writer by writer; the next writer re-opened the trap. Now the station record decides
   (sidecar/station-record.js): a workspace holds a station once its record says one was founded — the station file's
   first accepted save — or a save or roster file is on disk (P1). Soft bookkeeping, whoever writes it, never makes one.

   Drives the REAL host against an empty temp workspace (no key, zero spend; HOME/APPDATA sandboxed so the dev machine's
   real legacy roots never leak in; providers on a dead loopback), with cron and the night shift armed through the env
   (1 s ticks, a 1 ms away threshold) and the quest refresh and environment discovery on (their defaults):
   1. ONBOARDING ROW — the page's pre-onboarding reads, a wait past every boot look and several ticks, the quit-path
      E-STOP, a restart: GET /api/lineage must allow onboarding, with station.state none. The quest-refresh look writes
      nothing on the way.
   2. CLIENT-ROUTE ROW — before any station is founded, the routes WAKE calls before its first save, plus the scout,
      dossier and goals pushes, then a restart: still onboards, station.state none.
   3. PLANT ROW — after those boots (the record exists), the station-scoped bookkeeping files any future writer could
      leave are planted (never a save or roster: those are a station by P1), then a restart: still onboards.
   (The unattended-writer guard adds the completeness census: nothing a no-client session writes is station state.)
   NOT in test:fast (child-process boots). Run via `npm run test:http`. */
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the station-scoped bookkeeping files a station-less writer could leave: one per STATE_EVIDENCE family a route or a tick
// reaches today (scout, the Commander dials, routines, loops, night focus, personalization), plus the night-shift ledger
const PLANTS = ['scout.state.json', '_commander.autonomy.json', 'cron.jobs.json', 'loops.json', 'nightfocus.state.json', 'personalization.json', 'autonomy.ledger.jsonl'];

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-stationless-census-'));
  const appData = path.join(sandbox, 'appdata');
  const ws = path.join(appData, 'ai.skynet.harness', 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  // Sandbox every root the lineage inspector can look sideways into — the dev machine's REAL profile must
  // never supply evidence to this test (same isolation as workspace-lineage.http.test.js).
  const baseEnv = Object.assign({}, process.env, {
    LOCALAPPDATA: appData, APPDATA: appData, XDG_DATA_HOME: appData,
    HOME: sandbox, USERPROFILE: sandbox,
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, SKYNET_LIVE_PRICES: '0', STARNET_LIVE_PRICES: '0',
    SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
    // hermetic: no live provider catalog, cloud, credits or Edge voice traffic from a gate
    SKYNET_OPENROUTER_BASE: 'http://127.0.0.1:1', STARNET_OPENROUTER_BASE: 'http://127.0.0.1:1',
    STARNET_CLOUD_URL: 'http://127.0.0.1:1', STARNET_CREDITS_URL: 'http://127.0.0.1:1', STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0', SKYNET_EDGE_TTS_PROBE: '0',
    STARNET_DESKTOP_SHELL: '0', STARNET_DEV: '0', SKYNET_DEV: '0',
    // EVERY SCHEDULER ARMED: cron and the night shift on 1 s ticks, the night shift's away threshold at 1 ms
    SKYNET_CRON_ENABLED: '1', STARNET_CRON_ENABLED: '1', SKYNET_CRON_TICK_MS: '1000', STARNET_CRON_TICK_MS: '1000',
    SKYNET_NIGHTSHIFT_ENABLED: '1', STARNET_NIGHTSHIFT_ENABLED: '1', SKYNET_NIGHTSHIFT_TICK_MS: '1000', STARNET_NIGHTSHIFT_TICK_MS: '1000',
    SKYNET_NIGHTSHIFT_AWAY_MS: '1', STARNET_NIGHTSHIFT_AWAY_MS: '1', SKYNET_NIGHTSHIFT_BEAT_MS: '1000', STARNET_NIGHTSHIFT_BEAT_MS: '1000',
    SKYNET_LOOP_TICK_MS: '5000', STARNET_LOOP_TICK_MS: '5000'
  });
  // the quest refresh and environment discovery stay ON (their defaults): their boot looks are station-less writers under test
  for (const k of ['SKYNET_QUEST_REFRESH', 'STARNET_QUEST_REFRESH', 'SKYNET_ENV_DISCOVERY', 'STARNET_ENV_DISCOVERY']) delete baseEnv[k];
  function boot(port, attemptsLeft) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [INDEX], {
        env: Object.assign({}, baseEnv, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '', settled = false;
      const onData = d => {
        out += d.toString();
        if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, output: () => out }); }
        if (!settled && BIND_REFUSED.test(out)) {
          settled = true; try { child.kill(); } catch (_) {}
          if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, attemptsLeft - 1)));
          else reject(new Error('no free port'));
        }
      };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('error', e => { if (!settled) { settled = true; reject(e); } });
      child.on('close', code => { if (!settled) { settled = true; reject(new Error('sidecar exited before it was up (' + code + ')' + ':\n' + out)); } });
      setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout; output:\n' + out)); } }, 30000).unref();
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
  async function session() {
    const booted = await boot(await allocatePort(), 20);
    child = booted.child;
    const B = 'http://' + HOST + ':' + booted.port;
    const apiToken = await bootToken(B, B);
    const j = async (m, p, body) => {
      const headers = { 'Content-Type': 'application/json', Origin: B };
      if (apiToken) headers['X-StarNet-Token'] = apiToken;
      const r = await fetch(B + p, { method: m, headers, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text(); let v; try { v = JSON.parse(t); } catch (_) { v = t; }
      return { status: r.status, body: v };
    };
    return { j, bootedAt: Date.now(), output: booted.output };
  }
  async function onboards(label) {
    const s = await session();
    const r = await s.j('GET', '/api/lineage');
    A.eq(r.status, 200, label + ': GET /api/lineage -> 200');
    const lineage = (r.body && r.body.lineage) || {};
    A.eq(lineage.onboardingAllowed, true, label + ': the workspace still onboards (' + JSON.stringify(lineage.evidence) + ')');
    A.eq(lineage.station && lineage.station.state, 'none', label + ': its station record says no station was founded (' + JSON.stringify(lineage.station) + ')');
    return s;
  }
  try {
    // ---- 1. ONBOARDING ROW: a virgin workspace, every scheduler armed, the page's pre-onboarding reads, the E-STOP ----
    let s = await session();
    const first = await s.j('GET', '/api/lineage');
    A.eq(first.status, 200, 'GET /api/lineage -> 200');
    A.eq(first.body.lineage.onboardingAllowed, true, 'a virgin workspace onboards');
    // the page's pre-onboarding boot reads (app.js init(): hooks, plugins, save + lineage) and the dials a fresh page reads
    for (const route of ['/api/hooks', '/api/plugins', '/api/save?agent=agent', '/api/autonomy/posture', '/api/cron', '/api/loops', '/api/scout', '/api/discovery']) {
      const r = await s.j('GET', route);
      A.ok(r.status < 500, 'the page\'s pre-onboarding read ' + route + ' answers (' + r.status + ')');
    }
    // past the quest-refresh (3 s) and discovery (5 s) boot looks, and several cron and night-shift ticks
    const looksDone = s.bootedAt + 9000;
    if (Date.now() < looksDone) await sleep(looksDone - Date.now());
    A.eq(fs.existsSync(path.join(ws, '_station.questrefresh.json')), false, 'the quest-refresh boot look writes nothing on a station-less workspace (#123), even after the night shift has ticked');
    const halt = await s.j('POST', '/api/halt', {});
    A.eq(halt.status, 200, 'quit-path E-STOP -> 200');
    A.eq(halt.body.nightshiftHaltPersisted, true, 'the E-STOP durably wrote its night-shift bookkeeping');
    A.eq(halt.body.loopsHaltPersisted, true, 'the E-STOP durably wrote its loops bookkeeping');
    await stop(child); child = null;
    A.eq(fs.existsSync(path.join(ws, 'loops.halt.json')), true, 'fixture is real: the halt file exists on disk');
    A.eq(fs.existsSync(path.join(ws, 'nightshift.state.json')), true, 'fixture is real: the night-shift state file exists on disk');

    // ---- the boot that used to strand the user on PRIOR STATION DATA FOUND ----
    s = await onboards('restart after an armed station-less session');

    // ---- 2. CLIENT-ROUTE ROW: WAKE's lock-downs before its first save (app.js wake), and the pushes a fresh page makes ----
    const routes = [
      ['POST', '/api/permissions/revoke', { key: 'cabinet:write' }],                                                  // PermissionsStore.reset
      ['POST', '/api/autonomy/posture', { posture: { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 }, resumeHalt: false }],   // AutonomyStore.reset
      ['POST', '/api/journey', { op: 'journey.reset', epoch: Date.now() }],                                           // JourneyStore.reset
      ['POST', '/api/memory/reset', { agent: 'agent' }],                                                              // Harness.memoryReset
      ['POST', '/api/scout/context', { customClasses: [{ name: 'Census class' }] }],
      ['POST', '/api/scout/telemetry', { kind: 'recipe.launch', id: 'census-recipe', name: 'Census recipe' }],
      ['POST', '/api/dossier', { block: 'COMMANDER DOSSIER\n- census' }],
      ['POST', '/api/goals', { goal: null }]
    ];
    for (const [m, route, body] of routes) {
      const r = await s.j(m, route, body);
      A.ok(r.status < 500, m + ' ' + route + ' answers on a station-less workspace (' + r.status + ')');
    }
    const routeFiles = ['scout.state.json', '_commander.autonomy.json', '_commander.dossier.json', '_commander.goals.json'].filter(n => fs.existsSync(path.join(ws, n)));
    A.eq(routeFiles.length, 4, 'fixture is real: the routes wrote their station-scoped files (' + routeFiles.join(', ') + ')');
    await stop(child); child = null;
    s = await onboards('restart after WAKE\'s pre-save routes (a WAKE cut short)');
    await stop(child); child = null;

    // ---- 3. PLANT ROW: any future station-less writer's file, under the record ----
    for (const name of PLANTS) fs.writeFileSync(path.join(ws, name), /\.jsonl$/.test(name) ? '{"v":1}\n' : '{"v":1}');
    s = await onboards('restart with every station-scoped bookkeeping file planted (' + PLANTS.join(', ') + ')');
    await stop(child); child = null;
    A.report('stationless-boot-census.http.test');
  } finally {
    await stop(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
