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
     wipe, the scout pushes, dossier and goals) each write a regex file, so a WAKE cut short trapped the next boot;
   - and WAKE pushes its crew (POST /api/roster, enterGame's pushRoster) at once, while CloudSave holds the first save for
     its 1.2 s debounce. A roster file is hard proof to every reader, record or not, so that push alone trapped the next boot.
   Each was patched writer by writer; the next writer re-opened the trap. Now the station record decides
   (sidecar/station-record.js): a workspace holds a station once its record says one was founded — the station file's
   first accepted save — or a save or roster file is on disk (P1). Soft bookkeeping, whoever writes it, never makes one, and
   hard proof is never written before a founding: the roster's one write path holds the crew in RAM until the founding save
   writes it (sidecar/index.js agentRosterHeld).

   And every unattended writer (the night shift, environment discovery, the quest refresh) now stands down until a station
   is founded (the live record's station()), so a station-less session leaves nothing ANY build reads as a station: an
   older build has no record to ask, and a downgrade must not open on PRIOR STATION DATA FOUND either.

   Drives the REAL host against an empty temp workspace (no key, zero spend; HOME/APPDATA sandboxed so the dev machine's
   real legacy roots never leak in; providers on a dead loopback), with cron and the night shift armed through the env
   (1 s ticks, a 1 ms away threshold) and the quest refresh and environment discovery on (their defaults):
   1. ONBOARDING ROW — the page's pre-onboarding reads, a wait past every boot look and several ticks, the shell's whole
      quit (the E-STOP, then the graceful stop), a restart: GET /api/lineage must allow onboarding, with station.state
      none. Each unattended writer's own file is absent on the way, including one no reader counts as station state.
      COMPLETENESS — THE RATCHET FOR EVERY UNATTENDED WRITER: the census of every file that no-client session wrote, taken
      after the ticks and again after the quit, holds nothing a reader without the record calls station state (an older
      build's gate, and this build's own fallback: workspace-lineage over the same names with no .station.json beside
      them, plus the update snapshots). A background writer that writes station state before a station exists fails
      here, not on a user's machine. (The night shift's decline row in autonomy.ledger.jsonl was the last one.)
      UPDATE ROW — in that session, before onboarding, POST /api/update/prepare with no station-save journal in the page:
      there is nothing to protect, so the installer gets its receipt (station none, no snapshot) and update-snapshots
      gets nothing — a bundle there read as a prior install to every build's gate.
   2. CLIENT-ROUTE ROW — before any station is founded, the routes WAKE calls before its first save, plus the scout,
      dossier and goals pushes, and every route that writes the roster (WAKE's own push as the page sends it, the no-page
      approval and personality controls, a roster reset), then a restart: no roster file was written, still onboards,
      station.state none.
   3. PLANT ROW — after those boots (the record exists), the station-scoped bookkeeping files any future writer could
      leave are planted (never a save or roster: those are a station by P1), then a restart: still onboards.
   4. FOUNDING ROW — on that same session: past the boot looks and several ticks, soft evidence on disk has turned no
      unattended writer back on (the old gate read the regex it guarded, so one evidence file re-opened it: the cascade);
      WAKE pushes its crew, which is held; then the station file's first accepted write founds the station and writes that
      crew, and the next tick runs with no restart.
   NOT in test:fast (child-process boots). Run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');
const { inspectWorkspaceLineage } = require('../sidecar/workspace-lineage.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// the station-scoped bookkeeping files a station-less writer could leave: one per STATE_EVIDENCE family a route or a tick
// reaches today (scout, the Commander dials, routines, loops, night focus, personalization), plus the night-shift ledger
const PLANTS = ['scout.state.json', '_commander.autonomy.json', 'cron.jobs.json', 'loops.json', 'nightfocus.state.json', 'personalization.json', 'autonomy.ledger.jsonl'];
// each unattended writer's own first file. Not every one is station state to a reader (discovery's is not), so the
// completeness census alone could not see that writer run.
const UNATTENDED_FILES = [['the night shift', 'autonomy.ledger.jsonl'], ['the quest refresh', '_station.questrefresh.json'], ['environment discovery', 'discovery.state.json']];

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
  // the process ended by itself (the real quit path): true, or false once the bound passes
  function exited(proc, ms) {
    return new Promise(resolve => {
      if (proc.exitCode !== null) return resolve(true);
      const t = setTimeout(() => resolve(false), ms);
      proc.once('exit', () => { clearTimeout(t); resolve(true); });
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
  // THE CENSUS: every file and folder in the workspace (what a session wrote), and the update snapshots beside it
  const snapshotsDir = path.join(path.dirname(ws), 'update-snapshots');
  function census(dir, rel, out) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { out.push(r + '/'); census(path.join(dir, e.name), r, out); } else out.push(r);
    }
    return out;
  }
  const snapshotFiles = () => (fs.existsSync(snapshotsDir) ? fs.readdirSync(snapshotsDir).sort() : []);
  // what a reader WITHOUT the station record calls station state here — an older build's onboarding gate, and this build's
  // own fallback: the onboarding gate over the same names with no .station.json beside them (names are all either reads),
  // plus the update snapshots. Built from names only, in a separate folder, so the live workspace is never touched.
  let views = 0;
  function noRecordReaderSees() {
    const view = path.join(sandbox, 'no-record-view-' + (++views), 'workspaces');
    fs.mkdirSync(view, { recursive: true });
    for (const e of fs.readdirSync(ws, { withFileTypes: true })) {
      if (e.name === '.station.json') continue;
      if (e.isDirectory()) fs.mkdirSync(path.join(view, e.name)); else fs.writeFileSync(path.join(view, e.name), '');
    }
    return inspectWorkspaceLineage({ fs, path, platform: process.platform, workspaceRoot: view, candidateRoots: [], snapshotsRoot: snapshotsDir });
  }
  function completeness(label) {
    const seen = noRecordReaderSees();
    A.eq(seen.evidence, [], label + ': nothing in it is what a reader without the station record calls station state (census: ' + census(ws, '', []).join(', ') + ')');
  }
  function standsDown(label, skip) {
    for (const [writer, file] of UNATTENDED_FILES) {
      if (file !== skip) A.eq(fs.existsSync(path.join(ws, file)), false, label + ': ' + writer + ' stood down (' + file + ' was not written)');
    }
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
    standsDown('past the boot looks and several ticks on a station-less workspace (#123)');
    // COMPLETENESS: every unattended writer has had its look by now (the boot looks, cron and night-shift ticks, a loop tick)
    completeness('the no-client session with every scheduler armed');

    // ---- UPDATE ROW: the Update Center's prepare before onboarding, the page holding no station-save journal ----
    const prepared = await s.j('POST', '/api/update/prepare', { targetVersion: '9.9.9', browserStore: { 'starnet.byok.model': 'test/model' } });
    A.eq(prepared.status, 200, 'a pre-onboarding update prepare -> 200');
    const receipt = prepared.body && prepared.body.receipt;
    A.ok(prepared.body && prepared.body.ok === true && !!receipt, 'the installer still gets its receipt (' + JSON.stringify(prepared.body) + ')');
    A.eq(receipt && [receipt.station, receipt.snapshot, receipt.frozen], ['none', null, true], 'the receipt says there was no station to protect and names no snapshot, under the same barrier');
    A.eq(snapshotFiles(), [], 'nothing was written to update-snapshots: no recovery bundle, no receipt file');
    const held = await s.j('GET', '/api/update/status');
    A.eq(held.body && [held.body.frozen, held.body.receipt && held.body.receipt.station], [true, 'none'], 'the barrier holds, its receipt in memory');
    const thawed = await s.j('POST', '/api/update/cancel', {});
    A.eq(thawed.body && thawed.body.frozen, false, 'and a failed install thaws it as before');

    const halt = await s.j('POST', '/api/halt', {});
    A.eq(halt.status, 200, 'quit-path E-STOP -> 200');
    A.eq(halt.body.nightshiftHaltPersisted, true, 'the E-STOP durably wrote its night-shift bookkeeping');
    A.eq(halt.body.loopsHaltPersisted, true, 'the E-STOP durably wrote its loops bookkeeping');
    // the shell's stop (src-tauri stop_station): on Windows a kill alone would keep gracefulShutdown's writers out of the census
    const quit = await s.j('POST', '/api/lifecycle/quit', {});
    A.eq(quit.status, 202, 'the quit asks the station to shut down');
    A.eq(await exited(child, 8000), true, 'the station ran its graceful shutdown to the end');
    await stop(child); child = null;
    A.eq(fs.existsSync(path.join(ws, 'loops.halt.json')), true, 'fixture is real: the halt file exists on disk');
    A.eq(fs.existsSync(path.join(ws, 'nightshift.state.json')), true, 'fixture is real: the night-shift state file exists on disk');
    completeness('the whole session, the update prepare and the quit included');

    // ---- the boot that used to strand the user on PRIOR STATION DATA FOUND ----
    s = await onboards('restart after an armed station-less session and a pre-onboarding update prepare');

    // ---- 2. CLIENT-ROUTE ROW: WAKE's lock-downs before its first save (app.js wake), the pushes a fresh page makes, and every
    // route that writes the roster, WAKE's own push first, exactly as pushRoster sends it before CloudSave's first save lands ----
    const rosterFile = path.join(ws, 'agent.roster.json');
    const crew = (name, stamp) => ({ agents: [{ agentId: 'agent', system: 'You are ' + name + '.', name, model: '', provider: 'openrouter', role: 'orchestrator', approvalMode: 'ask', executionProfile: 'station-gear', track: '', workshop: false, skills: [], reasoningEffort: 'medium' }],
      updatedAt: stamp, saveRevision: 0, saveClient: 'census-window', rosterBase: { known: [], changed: ['agent'] } });
    const routes = [
      ['POST', '/api/permissions/revoke', { key: 'cabinet:write' }],                                                  // PermissionsStore.reset
      ['POST', '/api/autonomy/posture', { posture: { v: 1, initiative: 'wait', reach: 'sandbox', leashPerDay: 3 }, resumeHalt: false }],   // AutonomyStore.reset
      ['POST', '/api/journey', { op: 'journey.reset', epoch: Date.now() }],                                           // JourneyStore.reset
      ['POST', '/api/memory/reset', { agent: 'agent' }],                                                              // Harness.memoryReset
      ['POST', '/api/scout/context', { customClasses: [{ name: 'Census class' }] }],
      ['POST', '/api/scout/telemetry', { kind: 'recipe.launch', id: 'census-recipe', name: 'Census recipe' }],
      ['POST', '/api/dossier', { block: 'COMMANDER DOSSIER\n- census' }],
      ['POST', '/api/goals', { goal: null }],
      ['POST', '/api/roster', crew('CENSUS', Date.now())],                                                            // enterGame's pushRoster
      ['POST', '/api/agent/approval', { agentId: 'agent', mode: 'full' }],                                           // the no-page controls
      ['POST', '/api/agent/personality', { agentId: 'agent', personality: 'blunt', system: 'You are CENSUS, blunt.' }],
      ['POST', '/api/config/reset', { section: 'roster' }]
    ];
    for (const [m, route, body] of routes) {
      const r = await s.j(m, route, body);
      A.ok(r.status < 500, m + ' ' + route + ' answers on a station-less workspace (' + r.status + ')');
      if (route === '/api/roster') A.eq([r.body && r.body.ok, r.body && r.body.held], [true, true], 'WAKE\'s crew push is taken and held, not written (' + JSON.stringify(r.body) + ')');
      if (route.startsWith('/api/agent/')) A.eq([r.status, r.body && r.body.via], [200, 'roster'], m + ' ' + route + ' reaches the roster\'s write path (' + JSON.stringify(r.body) + ')');
    }
    A.eq(fs.existsSync(rosterFile), false, 'no roster file: before a founding nothing writes hard proof, whichever route asked');
    const routeFiles = ['scout.state.json', '_commander.autonomy.json', '_commander.dossier.json', '_commander.goals.json'].filter(n => fs.existsSync(path.join(ws, n)));
    A.eq(routeFiles.length, 4, 'fixture is real: the routes wrote their station-scoped files (' + routeFiles.join(', ') + ')');
    await stop(child); child = null;
    s = await onboards('restart after WAKE\'s pre-save routes (a WAKE cut short)');
    await stop(child); child = null;

    // ---- 3. PLANT ROW: any future station-less writer's file, under the record ----
    for (const name of PLANTS) fs.writeFileSync(path.join(ws, name), /\.jsonl$/.test(name) ? '{"v":1}\n' : '{"v":1}');
    const planted = noRecordReaderSees().evidence.filter(e => e.kind === 'current-workspace');
    A.ok(planted.length === 1 && planted[0].count >= PLANTS.length, 'the census is not vacuous: a reader without the record calls the planted files station state (' + JSON.stringify(planted) + ')');
    const ledgerFile = path.join(ws, 'autonomy.ledger.jsonl');
    const plantedLedger = fs.readFileSync(ledgerFile, 'utf8');   // before the boot: a decline is logged once, on its first tick
    s = await onboards('restart with every station-scoped bookkeeping file planted (' + PLANTS.join(', ') + ')');

    // ---- 4. FOUNDING ROW: soft evidence turns no unattended writer back on; the first accepted save does, live ----
    const pastLooks = s.bootedAt + 6500;
    if (Date.now() < pastLooks) await sleep(pastLooks - Date.now());
    A.eq(fs.readFileSync(ledgerFile, 'utf8'), plantedLedger, 'soft evidence on disk starts no night-shift tick: the ledger is as it was planted');
    standsDown('with every evidence file planted, past the boot looks and several ticks', 'autonomy.ledger.jsonl');
    const wakeStamp = Date.now();
    const waking = await s.j('POST', '/api/roster', crew('CENSUS', wakeStamp));
    A.eq([waking.body && waking.body.held, fs.existsSync(rosterFile)], [true, false], 'WAKE\'s crew push is held until the founding (' + JSON.stringify(waking.body) + ')');
    const at = Date.now();
    const saved = await s.j('POST', '/api/save', { schema: 'starnet.save', version: 6, updatedAt: at, _saveRevision: 0, _saveDirty: true, _saveClient: 'census-window',
      agent: { id: 'agent', name: 'CENSUS', createdAt: at }, agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    A.ok(saved.body && saved.body.ok === true, 'the station file\'s first accepted write lands (' + JSON.stringify(saved.body) + ')');
    const founded = await s.j('GET', '/api/lineage');
    A.eq(founded.body.lineage.station && founded.body.lineage.station.state, 'active', 'and founds the station');
    let landed = null; try { landed = JSON.parse(fs.readFileSync(rosterFile, 'utf8')); } catch (_) {}
    A.eq(landed && [landed.updatedAt, landed.agents.map(a => a.name)], [wakeStamp, ['CENSUS']], 'and the founding save writes the crew held for it, with its stamp');
    const after = await s.j('POST', '/api/roster', crew('CENSUS', Date.now()));
    A.eq([after.body && after.body.ok, after.body && after.body.held], [true, undefined], 'once a station is founded a push is written at once');
    const tickRan = () => fs.readFileSync(ledgerFile, 'utf8').split('\n').some(line => { try { return JSON.parse(line).source === 'nightshift'; } catch (_) { return false; } });
    const deadline = Date.now() + 8000;
    while (!tickRan() && Date.now() < deadline) await sleep(100);
    A.ok(tickRan(), 'the next night-shift tick runs with no restart: the stand-down reads the live record, never a boot-time answer');
    await stop(child); child = null;
    A.report('stationless-boot-census.http.test');
  } finally {
    await stop(child);
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });
