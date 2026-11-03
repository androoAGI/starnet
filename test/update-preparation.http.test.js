/* node test/update-preparation.http.test.js — real route wiring for freeze, snapshot receipt, and cancel.

   A pre-update recovery point is written whenever there is something to protect (sidecar/update-preparation.js, NOTHING TO
   PROTECT): a founded station, station data on disk before one is founded, or the page's own station-save journal. Only a
   workspace with none of them gets an in-memory receipt and no bundle (test/stationless-boot-census.http.test.js, its
   UPDATE ROW). The rows here run in the order a fresh install meets them, and every one of them snapshots:
     1. station-less, with the page's journal the only copy of a station: the bundle carries the journal;
     2. station-less, with station data a WAKE cut short wrote on disk (the dossier) and no journal: the bundle carries it;
     3. a station founded through POST /api/save (the station file's first accepted write): the full barrier and receipt. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const Recovery = require('../sidecar/station-recovery.js');

const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const TOKEN = 'update-preparation-http-token-32-bytes';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(e => e ? reject(e) : resolve(p)); });
  });
}
const diesFirst = (proc, output) => new Promise((_, reject) => proc.once('close', code => reject(new Error('sidecar exited before it was up (' + code + '):\n' + output()))));   // a sidecar that dies at boot fails now, with its output, not at the limit
function waitFor(fn, ms, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start >= ms) return reject(new Error(typeof label === 'function' ? label() : label));
      setTimeout(tick, 25);
    };
    tick();
  });
}
async function call(base, route, method, body) {
  const r = await fetch(base + route, {
    method: method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

(async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-update-http-'));
  const workspace = path.join(sandbox, 'workspaces');
  fs.mkdirSync(workspace);
  const sentinel = path.join(workspace, 'canonical-user-state.json');
  const bytes = JSON.stringify({ agents: 4, workstreams: 33, marker: 'transactional-update' });
  fs.writeFileSync(sentinel, bytes);
  // bug 31db37b0: five recovery points from earlier install attempts (read-only, like prepare leaves them) + a user file
  const snapshots = path.join(sandbox, 'update-snapshots');
  fs.mkdirSync(snapshots);
  const old = [];
  for (let i = 0; i < 5; i++) {
    const name = 'pre-0.12.' + i + '-' + (1760000000000 + i) + '-old.starnet-backup.json';
    const at = new Date(Date.parse('2026-01-01T00:00:00Z') + i * 86400000);
    for (const f of [name, name + '.receipt.json']) {
      fs.writeFileSync(path.join(snapshots, f), '{}');
      fs.utimesSync(path.join(snapshots, f), at, at);
      fs.chmodSync(path.join(snapshots, f), 0o400);
    }
    old.push(name);
  }
  fs.writeFileSync(path.join(snapshots, 'keep-me.txt'), 'user file');
  const bundles = () => fs.readdirSync(snapshots).filter(n => /^pre-.+\.starnet-backup\.json$/.test(n)).sort();
  // this sidecar is NOT in dev mode, so it scans the profile's station folders at boot and sweeps its Downloads:
  // every profile path stays inside the sandbox, so the real ones are never read
  const profile = path.join(sandbox, 'profile');
  const downloads = path.join(profile, 'Downloads');
  fs.mkdirSync(downloads, { recursive: true });
  // #119: what a stopped capture left, from a process that is gone, beside a finished bundle and someone else's file
  const unfinished = path.join(downloads, 'starnet-recovery-20261101-120000.starnet-recovery.json.tmp-999999-abcdef0123456789');
  const finished = path.join(downloads, 'starnet-recovery-20261101-120000.starnet-recovery.json');
  const foreign = path.join(downloads, 'thesis.tmp-999999-abc');
  for (const f of [unfinished, finished, foreign]) fs.writeFileSync(f, 'x');
  const port = await freePort();
  const child = spawn(process.execPath, [INDEX], {
    env: Object.assign({}, process.env, {
      APPDATA: profile, LOCALAPPDATA: profile, XDG_DATA_HOME: profile, USERPROFILE: profile, HOME: profile,
      STARNET_SWEEP_BACKUP_TEMPS: '1',   // the opt-in the desktop shell sets; safe here because the profile is this sandbox
      SKYNET_WORKSPACES: workspace, SKYNET_PORT: String(port), SKYNET_API_TOKEN: TOKEN,
      SKYNET_LIVE_PRICES: '0', SKYNET_QUEST_REFRESH: '0', SKYNET_CRON: '0',
      SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: ''
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', d => { output += d.toString(); });
  try {
    await Promise.race([waitFor(() => output.includes('http://127.0.0.1:' + port), 30000, () => 'sidecar boot timeout:\n' + output), diesFirst(child, () => output)]);
    const base = 'http://127.0.0.1:' + port;
    A.eq(fs.existsSync(unfinished), false, 'boot removes a recovery bundle a stopped process never finished');
    A.eq(fs.existsSync(finished) && fs.existsSync(foreign), true, 'and nothing else in Downloads');
    A.eq(bundles(), old.slice(2), 'boot keeps the three newest pre-update recovery points');
    A.eq(old.slice(0, 2).some(n => fs.existsSync(path.join(snapshots, n + '.receipt.json'))), false, 'and removes the older ones with their receipts');
    A.eq(fs.existsSync(path.join(snapshots, 'keep-me.txt')), true, 'nothing else in update-snapshots is touched');
    const journalStore = { 'starnet.save': JSON.stringify({ version: 5, updatedAt: 123 }) };
    const bundleOf = r => { const s = r && r.body && r.body.receipt && r.body.receipt.snapshot; return s && fs.existsSync(s.file) ? Recovery.readBundle(s.file) : null; };
    const station = async () => { const l = await call(base, '/api/lineage', 'GET'); return l.body && l.body.lineage && l.body.lineage.station && l.body.lineage.station.state; };

    // ---- 1. STATION-LESS, the page's journal the only copy of a station ----
    A.eq(await station(), 'none', 'fixture: no station is founded yet');
    const journal = await call(base, '/api/update/prepare', 'POST', { targetVersion: '9.9.9', browserStore: journalStore });
    A.eq([journal.status, journal.body && journal.body.ok], [200, true], 'station-less with a page journal: prepare succeeds');
    const journalBundle = bundleOf(journal);
    A.ok(!!journalBundle, 'and writes a real recovery bundle: the journal is a station the workspace does not hold yet');
    A.eq(journalBundle && journalBundle.browser.map(b => b.key), ['starnet.save'], 'the bundle carries the page journal');
    A.eq(bundles(), [old[3], old[4], path.basename(journal.body.receipt.snapshot.file)].sort(), 'a verified prepare keeps itself + the two newest older recovery points');
    A.eq((await call(base, '/api/update/cancel', 'POST', {})).body.frozen, false, 'a failed install thaws it');

    // ---- 2. STATION-LESS WITH DATA ON DISK, no journal: what a WAKE cut short wrote is still protected ----
    const dossier = await call(base, '/api/dossier', 'POST', { block: 'COMMANDER DOSSIER\n- written before the first save' });
    A.eq(dossier.status, 200, 'a pre-founding dossier write lands (WAKE writes before its first save)');
    A.eq(await station(), 'none', 'and founds nothing');
    const data = await call(base, '/api/update/prepare', 'POST', { targetVersion: '9.9.9', browserStore: {} });
    A.eq([data.status, data.body && data.body.ok], [200, true], 'station-less with station data on disk and no journal: prepare succeeds');
    const dataBundle = bundleOf(data);
    A.ok(!!dataBundle && data.body.receipt.station === undefined, 'and still writes a real recovery bundle');
    A.eq(dataBundle && dataBundle.files.some(row => row.path === '_commander.dossier.json'), true, 'carrying that data');
    A.eq((await call(base, '/api/update/cancel', 'POST', {})).body.frozen, false, 'a failed install thaws it');

    // ---- 3. A FOUNDED STATION: the station file's first accepted write, then the barrier and receipt as always ----
    const at = Date.now();
    const founded = await call(base, '/api/save', 'POST', { schema: 'starnet.save', version: 6, updatedAt: at, _saveRevision: 0, _saveDirty: true, _saveClient: 'update-window',
      agent: { id: 'agent', name: 'UPDATER', createdAt: at }, agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    A.ok(founded.body && founded.body.ok === true, 'the station file\'s first accepted write lands (' + JSON.stringify(founded.body) + ')');
    A.eq(await station(), 'active', 'and founds the station');
    const prepared = await call(base, '/api/update/prepare', 'POST', { targetVersion: '9.9.9', browserStore: journalStore });
    A.eq(prepared.status, 200, 'real prepare route succeeds');
    A.eq(prepared.body && prepared.body.ok, true, 'route returns a verified receipt');
    A.ok(fs.existsSync(prepared.body.receipt.snapshot.file), 'receipt names a real recovery bundle');
    A.eq((bundleOf(prepared) || { files: [] }).files.some(row => row.path === 'agent.save.json'), true, 'holding the founded station');
    A.eq(fs.readFileSync(sentinel, 'utf8'), bytes, 'snapshot preparation preserves canonical bytes');
    A.eq(bundles(), [journal, data, prepared].map(r => path.basename(r.body.receipt.snapshot.file)).sort(), 'a verified prepare keeps itself + the two newest older recovery points');

    const blocked = await call(base, '/api/activity', 'POST', { at: Date.now() });
    A.eq(blocked.status, 423, 'mutation after snapshot is locked');
    A.eq(blocked.body && blocked.body.code, 'UPDATE_MUTATIONS_FROZEN', 'locked response is machine-readable');
    const status = await call(base, '/api/update/status', 'GET');
    A.eq(status.body && status.body.frozen, true, 'read-only status remains available while frozen');
    const cancelled = await call(base, '/api/update/cancel', 'POST', {});
    A.eq(cancelled.body && cancelled.body.frozen, false, 'native install failure can explicitly unfreeze');
    const after = await call(base, '/api/activity', 'POST', { at: Date.now() });
    A.ok(after.status !== 423, 'normal mutation routing resumes after cancel');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    await new Promise(resolve => { if (child.exitCode != null || child.signalCode != null) resolve(); else child.once('exit', resolve); });
    try { for (const name of fs.existsSync(snapshots) ? fs.readdirSync(snapshots) : []) fs.chmodSync(path.join(snapshots, name), 0o666); } catch (_) {}
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  A.report('update-preparation.http.test');
})().catch(e => { console.error(e); process.exit(1); });
