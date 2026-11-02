/* node test/station-recovery-backup.http.test.js — #119 on the real sidecar: a station with an encrypted connector store
   backs itself up over POST /api/recovery/backup, the barrier comes down, the bundle restores into an isolated folder
   through the shipped CLI, and a second sidecar with a DIFFERENT key (a clean machine) opens it. Everything is temporary:
   the Downloads folder is a fixture's, reached through a test-only USERPROFILE/HOME. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const CLI = path.join(__dirname, '..', 'bin', 'station-recovery.js');
const SECRET = 'SYNTHETIC_HTTP_BEARER';
function run(args) { return cp.spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }); }
function write(root, rel, value) {
  const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
}
function quiet(extra) {
  return Object.assign({ SKYNET_DEV: '1', SKYNET_CRON_ENABLED: '0', SKYNET_LOOP_ENABLED: '0', SKYNET_EDGE_TTS: '0',
    OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '' }, extra || {});
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-home-'));
  const downloads = path.join(home, 'Downloads');
  fs.mkdirSync(downloads);
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-isolated-'));
  const target = path.join(isolated, 'workspaces');
  const app = SidecarFixture.create({ prefix: 'starnet-recovery-backup-', env: quiet({ STARNET_CONNECTOR_ENCRYPTION_KEY: 'ab'.repeat(32), USERPROFILE: home, HOME: home }), timeoutMs: 20000 });
  let second = null;
  // nested, so update-snapshots (a sibling of WORKSPACES) lands in this test's folder and never in the shared temp root
  const stationHome = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-station-'));
  fs.rmSync(app.workspace, { recursive: true, force: true });
  app.workspace = path.join(stationHome, 'workspaces');
  fs.mkdirSync(app.workspace);
  try {
    const ws = app.workspace;
    write(ws, 'agent.save.json', { version: 1, agentId: 'agent', updatedAt: 1000, savedAt: 1000, doc: { schema: 'starnet.save', version: 1, updatedAt: 1000, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: [{ id: 'lab' }], props: [{ id: 'terminal' }] }, workstreams: [] } });
    write(ws, 'transcript.jsonl', '{}\n');
    write(ws, 'agent.notebook.json', { entries: [{ id: 'm' }] });
    write(ws, 'cron.jobs.json', { jobs: [] });
    write(ws, 'loops.json', { loops: [] });
    write(ws, 'agent.todo.json', { items: [] });
    write(ws, 'projects.json', { projects: [] });
    write(ws, 'agent.deliverables.json', { records: [] });
    write(ws, 'agent/report.md', 'deliverable');
    write(ws, 'permissions.allow.json', { allow: ['cabinet:write'] });
    write(ws, 'connectors/state.json', { version: 2, configs: [{ id: 'vaulted-reference', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer ' + SECRET } }], oauth: { byId: {}, clients: {} } });
    await app.start();
    const sealed = JSON.parse(fs.readFileSync(path.join(ws, 'connectors', 'state.json'), 'utf8'));
    A.ok(String(sealed.format).startsWith('starnet.connector-vault.'), 'boot sealed the connector store: the real encrypted case');

    const info = (await app.json('GET', '/api/recovery/info')).body;
    A.eq(info.ok, true, 'the info route answers');
    A.eq(path.resolve(info.workspace), path.resolve(ws), 'it names the folder this station really reads');
    A.eq(path.resolve(info.folder), path.resolve(downloads), 'and the folder a bundle lands in');
    A.eq(path.resolve(info.cli), path.resolve(CLI), 'and the CLI beside it');
    A.ok(info.commands.restore.indexOf('--replace-existing') >= 0 && info.commands.restore.indexOf(ws) >= 0, 'its restore command targets that folder');

    const made = await app.json('POST', '/api/recovery/backup', { browserStore: { 'starnet.save': JSON.stringify({ agent: { id: 'agent' } }), 'starnet.station.v1': '{"room":"lab"}', 'starnet.byok.key': SECRET } });
    A.eq(made.status, 200, 'the route answers: ' + made.text);
    A.eq(path.dirname(made.body.file), downloads, 'the bundle is in Downloads');
    A.eq(made.body.requirements.find(x => x.category === 'connector_references').status, 'present', 'the running app reads its own encrypted store');
    A.eq(made.body.complete, true, 'so the bundle is complete');
    A.eq(made.body.gate.noAgents, false, 'and it holds a readable agent');
    // the string the page prints, run as written in the shell the station names: nothing here assembles it
    A.eq(made.body.recovery.bundleKnown, true, 'the receipt carries commands finished for this bundle');
    const printed = made.body.recovery.commands.rehearse;
    const ran = process.platform === 'win32'
      ? require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', printed], { encoding: 'utf8' })
      : require('child_process').spawnSync('/bin/sh', ['-c', printed], { encoding: 'utf8' });
    A.eq(ran.status, 0, 'the printed command runs in ' + made.body.recovery.shell + ': ' + printed + ' ' + ran.stderr);
    A.eq(JSON.parse(ran.stdout).contentMatches, true, 'and rehearses this very bundle');
    A.ok(made.body.integrity.counts.excludedByDesign >= 1, 'the receipt counts what was excluded by design');
    A.ok(made.body.reauthentication.some(x => x.kind === 'connector' && x.id === 'vaulted-reference'), 'and lists the connector to reconnect');
    const raw = fs.readFileSync(made.body.file, 'utf8');
    A.ok(raw.indexOf(SECRET) < 0, 'no credential is in the bundle');
    A.ok(raw.indexOf('connector-vault.v1"') < 0, 'nor the encrypted store');
    const after = await app.json('POST', '/api/activity', { at: Date.now() });
    A.ok(after.status !== 423, 'writes resume when it finishes');
    A.eq((await app.json('GET', '/api/update/status')).body.frozen, false, 'and the barrier reads down');

    const rehearsal = run(['rehearse', '--bundle', made.body.file]);
    A.eq(rehearsal.status, 0, 'the rehearsal passes on the bundle: ' + rehearsal.stderr + rehearsal.stdout);
    A.ok(fs.existsSync(path.join(ws, 'agent.save.json')), 'with the source station untouched');

    const prepared = await app.json('POST', '/api/update/prepare', { targetVersion: '9.9.9', browserStore: {} });
    A.eq(prepared.status, 200, 'the pre-update path still works: ' + prepared.text);
    const busy = await app.json('POST', '/api/recovery/backup', {});
    A.eq(busy.body.code, 'UPDATE_PREPARED', 'a backup waits for a prepared update, and never lowers its barrier');
    A.eq((await app.json('POST', '/api/activity', { at: 1 })).status, 423, 'which stays up');
    const snapshot = prepared.body.receipt.snapshot.file;
    A.eq(run(['rehearse', '--bundle', snapshot]).status, 0, 'a pre-update snapshot rehearses through the CLI');
    await app.json('POST', '/api/update/cancel', {});

    const live = run(['restore', '--bundle', made.body.file, '--target', ws, '--replace-existing']);
    A.ok(live.status === 1 && /still running/.test(live.stderr), 'the CLI refuses to replace the station of a live sidecar: ' + live.stderr);
    A.eq(fs.existsSync(path.join(ws, 'agent.save.json')), true, 'which stays where it is');

    await app.stop();

    const restored = run(['restore', '--bundle', made.body.file, '--target', target]);
    A.eq(restored.status, 0, 'the CLI restores it into an isolated folder: ' + restored.stderr);
    const browserFile = JSON.parse(fs.readFileSync(path.join(isolated, 'starnet-browser-restore.json'), 'utf8'));
    A.eq(browserFile.store['starnet.station.v1'], '{"room":"lab"}', 'with the browser state beside it');
    A.eq(browserFile.store['starnet.byok.key'], undefined, 'and no browser credential');

    second = SidecarFixture.create({ prefix: 'starnet-recovery-clean-', env: quiet({ STARNET_CONNECTOR_ENCRYPTION_KEY: 'cd'.repeat(32), USERPROFILE: home, HOME: home }), timeoutMs: 20000 });
    fs.rmSync(second.workspace, { recursive: true, force: true });
    second.workspace = target;
    await second.start();
    const save = await second.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save.agent.name, 'NOVA', 'a sidecar with a different key opens the restored station');
    const connectors = await second.json('GET', '/api/connectors');
    A.ok(connectors.body.connectors.some(x => x.id === 'vaulted-reference'), 'and lists the connector reference');
    A.ok(JSON.stringify(connectors.body).indexOf(SECRET) < 0, 'with no credential');
    A.eq(fs.readFileSync(path.join(target, 'agent', 'report.md'), 'utf8'), 'deliverable', 'and the deliverable bytes');
    await second.stop();
  } finally {
    if (second) await second.dispose();
    await app.dispose();
    const snapshots = path.join(stationHome, 'update-snapshots');
    for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) { try { fs.chmodSync(path.join(snapshots, name), 0o666); } catch (_) {} }
    fs.rmSync(stationHome, { recursive: true, force: true });
    fs.rmSync(isolated, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
  A.report('station-recovery-backup.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
