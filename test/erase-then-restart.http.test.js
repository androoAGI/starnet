/* node test/erase-then-restart.http.test.js — ERASE EVERYTHING then a restart shows no prior station, to the app AND to the
   terminal, through the whole chain a user runs.

   THE SCENARIO (gh#101, gh#65, bug 5451970e). On a default Windows install the old station sits in
   %LOCALAPPDATA%\StarNet\workspaces, inside the install folder, and ERASE EVERYTHING never deletes that folder. So "no prior
   station" has to hold as an ANSWER: automatic recovery must not bring it back (fixed in 0.13.5), and `starnet` must not boot
   it. The terminal used to: the app said the computer was clean while bin/starnet.js, asking only whether a save file
   existed, picked the old station's folder (qa/bugs/661cbfea).
   test/station-marker-matrix.test.js asks every reader, in one process, on a workspace no sidecar has booted;
   test/workspace-recovery-fresh-start.http.test.js boots the sidecar and never asks the terminal. This is the chain, in order:

   1. A REAL STATION: the old station in the install-folder root, which the first real boot imports (the reporter's machine).
   2. ERASE: the station stops and its generation is replaced. THE ONE STAND-IN: fresh_start.rs set_aside_for_erase cannot run
      in node, so nativeErase() lays down what it leaves, from the contract the real function is held to
      (test/fixtures/station-record-cases.json nativeMarkers.erase, test/native-process-ownership/tests/station_contract.rs).
      Nothing in the station record is planted: the native door writes none, so the first boot must derive it.
   3. RESTART, TWICE: the real sidecar serves no save, its gate lets the app onboard, the record says erased and automatic
      recovery says why it imported nothing. Between the two boots a window that still holds a copy from before the erase (a
      browser tab, an app window whose storage survived) saves and pushes its crew: the save is refused, the crew is held
      and never written, so the second boot gives the same answers from the record the first one persisted.
   4. THE TERMINAL, AS A SHELL RUNS IT: the real bin/starnet.js with no --workspace, on the record those boots left. `-p` sets a
      new station up on the app's workspace and runs it, and `starnet init` names the same workspace. The old station is
      never booted, and its bytes never change.
   5. BACK IN THE APP: the real sidecar serves the terminal's station. The erase keeps its authority under it, and the old
      station stays available to an explicit recovery only.

   HERMETIC: every profile root points at the fixture's scratch profile, and its child temp folder keeps the scratch guard
   out of the way, so this proves the erase policy and not that guard. Zero spend: OpenRouter is a local mock. */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Save = require('../frontend/app/save.js');
const Safety = require('../sidecar/workspace-safety.js');
const cli = require('../bin/starnet.js');
const contract = require('./fixtures/station-record-cases.json');

const BIN = path.resolve(__dirname, '..', 'bin', 'starnet.js');
const REPO = path.resolve(__dirname, '..');
const DEAD = 'http://127.0.0.1:1';
const OLD = 'SYNTHETIC-OLD-STATION', NEW = 'ATLAS';
const same = (a, b) => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
const parsed = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
// Windows can refuse a directory rename for a moment after the process that held it ended (a late handle, a scanner). The real
// door stops its sidecar and fails closed; a stand-in must not turn that moment into a red gate.
async function renameWhenFree(from, to) {
  for (let tries = 0; ; tries++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (tries >= 50 || !/^(?:EPERM|EBUSY|EACCES)$/.test(String(e && e.code))) throw e;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// a text-only OpenRouter: every chat call answers, whoever asks (a run also makes reflection calls this test never asked for)
function startMockOpenRouter() {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello from the station.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

function terminal(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIN].concat(args), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 90000);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const quiet = {
    STARNET_DEV: '0', SKYNET_DEV: '0', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_LOOP_ENABLED: '0', SKYNET_LOOP_ENABLED: '0', SKYNET_QUEST_REFRESH: '0', STARNET_QUEST_REFRESH: '0',
    STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0', SKYNET_LIVE_PRICES: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CLOUD_URL: DEAD, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_DESKTOP_SHELL: '0', STARNET_SCRATCH_ROOT: '', SKYNET_SCRATCH_ROOT: '',
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-erase-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-erase-fake', OPENROUTER_API_KEY: '',
    OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  };
  const fixture = SidecarFixture.create({ prefix: 'starnet-erase-restart-', timeoutMs: 30000, env: quiet });
  const fixtureRoot = fixture.workspace, profile = fixture.profile;
  const childTemp = path.join(profile, 'runtime-temp');
  fs.mkdirSync(childTemp);
  // os.homedir() reads these, here and in every child: nothing below can reach the real profile
  process.env.HOME = process.env.USERPROFILE = profile;
  const profileEnv = { APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile, HOME: profile, USERPROFILE: profile, TMP: childTemp, TEMP: childTemp, TMPDIR: childTemp };
  Object.assign(fixture.env, profileEnv);
  const desktop = cli.desktopWorkspaces(profileEnv, process.platform);
  const bare = cli.bareWorkspaces(profileEnv, process.platform);
  // macOS: the bare sidecar's default IS the desktop root, so the old station lives in an ordinary legacy root
  const legacy = same(bare, desktop) ? path.join(profile, '.local', 'share', 'StarNet', 'workspaces') : bare;
  fixture.workspace = desktop;
  fs.mkdirSync(desktop, { recursive: true });
  const recordFile = path.join(desktop, '.station.json'), markerFile = path.join(desktop, '.fresh-start.json');
  const oldSave = path.join(legacy, 'agent.save.json');

  write(oldSave, { version: 1, agentId: 'agent', updatedAt: 1000, savedAt: 1000, doc: {
    schema: 'starnet.save', version: Save.CURRENT, updatedAt: 1000,
    agent: { id: 'agent', name: OLD, provider: 'replay', model: 'test/replay', createdAt: 900 },
    station: { rooms: [{ id: 'old-command' }], props: [] }, workstreams: [], activeId: 'general', generalId: 'general'
  } });
  write(path.join(legacy, 'agent.roster.json'), { version: 1, agents: [{ agentId: 'agent', name: OLD }] });
  const oldBytes = fs.readFileSync(oldSave);
  const oldUntouched = label => A.ok(fs.readFileSync(oldSave).equals(oldBytes), label + ': the old station\'s bytes are untouched');

  /* What fresh_start.rs set_aside_for_erase leaves, and what main.rs asks it to acknowledge: every legacy root
     (legacy_workspace_paths) plus the update snapshots. .migrated and the marker, pretty JSON, and no station record. */
  async function nativeErase(at) {
    const marker = Object.assign({}, contract.nativeMarkers.erase, { at: String(at), acknowledgedRoots:
      Safety.workspaceCandidates({ path, env: profileEnv, platform: process.platform, homedir: () => profile })
        .concat([path.join(REPO, 'sidecar', 'workspaces'), path.join(REPO, 'workspaces')])
        .filter(root => !same(root, desktop)).concat([path.join(path.dirname(desktop), 'update-snapshots')]) });
    const parent = path.dirname(desktop), stage = path.join(parent, '.workspaces-fresh-stage-' + at), aside = path.join(parent, '.erasing-station-' + at);
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, '.migrated'), '1');
    fs.writeFileSync(path.join(stage, '.fresh-start.json'), JSON.stringify(marker, null, 2));
    await renameWhenFree(desktop, aside);
    await renameWhenFree(stage, desktop);
    fs.rmSync(aside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return fs.readFileSync(markerFile, 'utf8');
  }
  async function showsNoPriorStation(label, at) {
    const save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.status, 200, label + ': GET /api/save answers');
    A.eq(save.body.save, null, label + ': the erased station is not served, and neither is the old one');
    const lineage = save.body.lineage || {};
    A.eq([lineage.onboardingAllowed, lineage.priorInstallEvidence, lineage.evidence], [true, false, []], label + ': the gate shows no prior station (' + JSON.stringify(lineage.evidence) + ')');
    A.eq(lineage.station && [lineage.station.state, lineage.station.generationId], ['erased', null], label + ': the record says this workspace was erased (' + JSON.stringify(lineage.station) + ')');
    A.ok(fixture.output().includes('AUTO_RECOVERY_ERASED'), label + ': automatic recovery says the erase is why it imported nothing');
    A.ok(!fixture.output().includes('AUTO_RECOVERY_TARGET_IS_SCRATCH'), label + ': the erase policy refused it, not the scratch guard');
    const rec = parsed(recordFile);
    A.eq(rec && [rec.state, rec.eraseAuthority, rec.reset && rec.reset.kind, rec.reset && rec.reset.at], ['erased', true, 'erase', at], label + ': and that record is durable, its reset read from the native marker');
    oldUntouched(label);
  }

  let failure = null;
  try {
    // ---- 1. A REAL STATION: the first boot imports the one station on this machine, and its record says so ----
    await fixture.start();
    let save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save && save.body.save.agent && save.body.save.agent.name, OLD, 'the first boot imports the install-folder station, as it did on the reporter\'s machine');
    A.eq(save.body.lineage && save.body.lineage.station && save.body.lineage.station.state, 'active', 'and the record says this workspace holds a station');
    await fixture.stop();

    // ---- 2. ERASE EVERYTHING: the station stopped, the generation replaced ----
    const erasedAt = Date.now();
    const markerBytes = await nativeErase(erasedAt);
    A.eq(fs.readdirSync(desktop).sort(), ['.fresh-start.json', '.migrated'], 'fixture is real: the native door leaves the seal and its marker, no record');
    A.ok(fs.existsSync(oldSave), 'fixture is real: the install folder keeps the old station (ERASE never deletes it)');

    // ---- 3. RESTART, TWICE ----
    await fixture.start();
    await showsNoPriorStation('the first boot after ERASE', erasedAt);
    A.eq(read(markerFile), markerBytes, 'the first boot leaves the native marker byte-identical');
    const recordBytes = read(recordFile);
    // a window from before the erase: resumeInto, enterGame's pushRoster and CloudSave's save, its revision its own
    const stale = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: Save.CURRENT, updatedAt: 1500, _saveRevision: 23, _saveDirty: true, _saveClient: 'window-from-before',
      agent: { id: 'agent', name: OLD, createdAt: 900 }, agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    A.ok(stale.body && stale.body.ok === false && stale.body.reset === true, 'a window from before the erase has its save refused (' + JSON.stringify(stale.body) + ')');
    const staleCrew = await fixture.json('POST', '/api/roster', { agents: [{ agentId: 'agent', system: 'x', name: OLD, model: '', provider: 'openrouter' }], updatedAt: Date.now(),
      saveRevision: 23, saveClient: 'window-from-before', rosterBase: { known: [], changed: ['agent'] } });
    A.eq([staleCrew.body && staleCrew.body.ok, staleCrew.body && staleCrew.body.held], [true, true], 'and its crew push is held, not written (' + JSON.stringify(staleCrew.body) + ')');
    A.eq(fs.existsSync(path.join(desktop, 'agent.roster.json')), false, 'no roster file: nothing but a founding writes one');
    await fixture.restart();
    await showsNoPriorStation('the next boot, with that window still open', erasedAt);
    A.eq(read(recordFile), recordBytes, 'the next boot reads the record the first one persisted, and rewrites nothing');
    await fixture.stop();

    // ---- 4. THE TERMINAL, AS A SHELL RUNS IT, on the record those boots left: no --workspace, so `starnet` picks ----
    const shell = Object.assign({}, process.env, quiet, profileEnv, { STARNET_PORT: '', SKYNET_PORT: '', STARNET_WORKSPACES: '', SKYNET_WORKSPACES: '',
      STARNET_TOKEN: '', STARNET_API_TOKEN: '', SKYNET_API_TOKEN: '', STARNET_APP_EXE: '' });
    const run = await terminal(['--spawn', '--name', NEW, '-p', 'say hello', '--json'], shell);
    A.eq(run.code, 0, '`starnet -p` runs (stderr: ' + run.err.slice(0, 800) + ')');
    A.ok(run.err.indexOf('booting a station on ' + desktop) >= 0, '`starnet -p` boots the app\'s workspace, never the old station\'s folder: ' + run.err.slice(0, 400));
    let receipt = null; try { receipt = JSON.parse(run.out.trim()); } catch (_) {}
    A.ok(!!receipt && receipt.ok === true, 'the run finished (' + run.out.slice(0, 300) + ')');
    A.ok(!!receipt && same(String(receipt.station && receipt.station.workspace), desktop), 'its receipt names the app\'s workspace');
    A.eq(receipt && receipt.agentName, NEW, 'and a new agent ran it, not the erased station\'s');
    oldUntouched('`starnet -p`');
    const init = await terminal(['init'], shell);
    A.eq(init.code, 0, '`starnet init` answers (' + init.err.trim() + ')');
    A.ok(init.err.indexOf(desktop) >= 0 && init.err.indexOf(legacy) < 0, '`starnet init` names the app\'s workspace too: ' + init.err.trim());
    oldUntouched('`starnet init`');

    // ---- 5. BACK IN THE APP: the terminal's station, and the erase still has authority under it ----
    await fixture.start();
    save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save && save.body.save.agent && save.body.save.agent.name, NEW, 'the app serves the station the terminal set up');
    const lineage = save.body.lineage || {};
    A.eq(lineage.station && lineage.station.state, 'active', 'the terminal founded it in the record');
    const rec = parsed(recordFile);
    A.eq(rec && [rec.state, rec.by, rec.eraseAuthority, rec.reset && rec.reset.kind, rec.reset && rec.reset.at], ['active', 'cli-bootstrap', true, 'erase', erasedAt], 'the founding keeps the erase: its time, and its authority over automatic imports');
    const candidate = ((lineage.recovery && lineage.recovery.candidates) || []).find(row => row.stationName === OLD);
    A.ok(!!candidate && candidate.recoverable === true, 'the old station is still there for an explicit recovery, and for nothing else');
    oldUntouched('the app\'s next boot');
  } catch (e) { failure = e; }

  await fixture.dispose();
  await new Promise(resolve => mock.server.close(resolve));
  if (path.dirname(fixtureRoot) !== path.resolve(os.tmpdir()) || !path.basename(fixtureRoot).startsWith('starnet-erase-restart-')) throw new Error('unsafe fixture root cleanup');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  if (failure) throw failure;
  A.report('erase-then-restart.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
