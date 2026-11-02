/* node test/station-recovery-packaged.test.js — #119: what a packaged install with encrypted connector state can do.

   The CLI runs from bin/ (it ships in the app) against temporary folders only. An encrypted connector store no longer
   crashes it; `complete` and "an exact copy" are separate answers; a pre-update snapshot restores through the CLI; a
   rehearsal touches no station; a station a live process owns is refused. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const A = require('./_assert.js');
const Recovery = require('../sidecar/station-recovery.js');
const { makeConnectorVault } = require('../sidecar/connector-vault.js');
const { makeUpdatePreparation } = require('../sidecar/update-preparation.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const Backup = require('../frontend/app/backup.js');

const CLI = path.join(__dirname, '..', 'bin', 'station-recovery.js');
const KEY = 'ab'.repeat(32);
const SECRET = 'SYNTHETIC_VAULT_SECRET';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-packaged-'));
function run(args) { return cp.spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' }); }
function out(r) { return JSON.parse(r.stdout); }
function seed(ws, connectors) {
  const write = (rel, value) => {
    const f = path.join(ws, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('agent.save.json', { doc: { agent: { id: 'agent' }, station: { rooms: ['r'], props: ['p'] } } });
  write('transcript.jsonl', '{}\n');
  write('agent.notebook.json', { entries: [{ id: 'm' }] });
  write('cron.jobs.json', { jobs: [{ id: 'r' }] });
  write('loops.json', { loops: [{ id: 'l' }] });
  write('agent.todo.json', { items: [{ id: 't' }] });
  write('projects.json', { projects: [{ id: 'p' }] });
  write('agent.deliverables.json', { records: [{ id: 'd' }] });
  write('agent/report.md', 'deliverable');
  write('permissions.allow.json', { allow: ['fs.write:workspace'] });
  if (connectors === 'plain') write('connectors/state.json', { version: 2, configs: [{ id: 'notion', oauth: true }], oauth: { byId: { notion: { accessToken: SECRET } }, clients: {} } });
  if (connectors === 'vault') {
    fs.mkdirSync(path.join(ws, 'connectors'), { recursive: true });
    makeConnectorVault({ fs, path, keyHex: KEY }).write(path.join(ws, 'connectors', 'state.json'),
      { version: 2, configs: [{ id: 'notion', oauth: true }], oauth: { byId: { notion: { accessToken: SECRET } }, clients: {} } });
  }
}

/* ---- the encrypted store offline ---- */
const vaultWs = path.join(root, 'vault', 'workspaces');
seed(vaultWs, 'vault');
A.ok(JSON.parse(fs.readFileSync(path.join(vaultWs, 'connectors', 'state.json'), 'utf8')).format.startsWith('starnet.connector-vault.'), 'the fixture is really encrypted');
const vaultBundle = path.join(root, 'out', 'vault.starnet-recovery.json');
const offline = run(['backup', '--workspace', vaultWs, '--output', vaultBundle]);
A.eq(offline.status, 0, 'offline backup of an encrypted station does not crash: ' + offline.stderr);
const offlineReport = out(offline);
A.eq(offlineReport.ok, true, 'it writes the rest of the station');
A.eq(offlineReport.complete, false, 'but never calls that complete');
A.eq(offlineReport.requirements.find(x => x.category === 'connector_references').status, 'omitted', 'the category reads omitted, not present');
A.ok(offlineReport.omitted.some(x => x.path === 'connectors/state.json' && /OS credential store/.test(x.reason)), 'the report says what was left out and why');
A.ok(offlineReport.omitted.some(x => /SETTINGS > APP & BACKUP/.test(x.howToGet)), 'and how to get it');
A.eq(offlineReport.integrity.counts.omitted, 1, 'integrity counts it');
A.eq(offlineReport.integrity.verbatim, false, 'and is not an exact copy');
A.ok(offlineReport.reauthentication.some(x => x.id === 'connectors/state.json'), 'reauthentication names the missing list');
const vaultRaw = fs.readFileSync(vaultBundle, 'utf8');
A.ok(vaultRaw.indexOf(SECRET) < 0 && vaultRaw.indexOf('ciphertext') < 0 && vaultRaw.indexOf('connector-vault.v1"') < 0, 'neither the secret nor the encrypted bytes ride');

const refused = run(['restore', '--bundle', vaultBundle, '--target', path.join(root, 'refused', 'workspaces')]);
A.ok(refused.status !== 0 && /--allow-incomplete/.test(refused.stderr), 'restoring it asks for an explicit choice and names it');
A.eq(fs.existsSync(path.join(root, 'refused')), false, 'and creates nothing');
const allowed = path.join(root, 'allowed', 'workspaces');
const allowedRun = run(['restore', '--bundle', vaultBundle, '--target', allowed, '--allow-incomplete']);
A.eq(allowedRun.status, 0, 'the explicit choice restores: ' + allowedRun.stderr);
A.eq(fs.readFileSync(path.join(allowed, 'agent', 'report.md'), 'utf8'), 'deliverable', 'with the station files');
A.eq(fs.existsSync(path.join(allowed, 'connectors', 'state.json')), false, 'and no connector store it never had');
A.eq(out(allowedRun).browserImport.importable, false, 'a bundle with no browser copy says RESTORE BACKUP will not take its file');

/* a pre-update capture still fails closed: it is the running app's job to supply the callback */
let threw = '';
try { Recovery.capture({ workspaceRoot: vaultWs, now: 1 }); } catch (e) { threw = e.message; }
A.ok(/requires the running StarNet app/.test(threw), 'a caller that does not ask for omission still fails closed');

/* ---- the running app's bundle keeps the list, without the credentials ---- */
const online = Recovery.capture({ workspaceRoot: vaultWs, now: 2, omitUnavailableCredentialStores: true, readConnectorState: () => makeConnectorVault({ fs, path, keyHex: KEY }).load(path.join(vaultWs, 'connectors', 'state.json')) });
A.eq(online.report.complete, true, 'with the callback the bundle is complete');
A.eq(online.report.integrity.verbatim, true, 'and an exact copy');
A.ok(JSON.stringify(online).indexOf(SECRET) < 0, 'and carries no credential');
A.ok(online.report.reauthentication.some(x => x.kind === 'connector' && x.id === 'notion'), 'and lists the connector to sign back in to');
const locked = Recovery.capture({ workspaceRoot: vaultWs, now: 3, omitUnavailableCredentialStores: true, readConnectorState: () => { throw new Error('Saved connector sign-ins are locked: test'); } });
A.ok(locked.report.skipped.some(x => /^omitted: Saved connector sign-ins are locked/.test(x.reason)), 'a locked store costs only itself, and the lock is named');

/* ---- complete is not an exact copy ---- */
const tornWs = path.join(root, 'torn', 'workspaces');
seed(tornWs, 'plain');
const clean = Recovery.capture({ workspaceRoot: tornWs, now: 4 });
A.eq(clean.report.complete && clean.report.integrity.verbatim, true, 'an untouched station is complete and exact');
fs.writeFileSync(path.join(tornWs, 'agent.notebook.json'), '{"torn');
fs.writeFileSync(path.join(tornWs, 'agent.notebook.json.bak'), JSON.stringify({ entries: [{ id: 'good' }] }));
fs.writeFileSync(path.join(tornWs, 'loops.json'), '{"torn');
fs.writeFileSync(path.join(tornWs, 'agent', 'tsconfig.json'), '{ /* comment */ }');
const torn = Recovery.capture({ workspaceRoot: tornWs, now: 5 });
A.eq(torn.report.complete, true, 'complete still says only that every category has evidence');
A.eq(torn.report.integrity.allRequiredPresent, true, 'and integrity says the same');
A.eq(torn.report.integrity.verbatim, false, 'but it is not an exact copy');
A.eq(torn.report.integrity.counts.promotedFromBak, 1, 'the .bak promotion is counted');
A.eq(torn.report.integrity.counts.tornKept, 1, 'the torn store with no .bak is counted');
A.ok(torn.report.skipped.some(x => x.path === 'loops.json' && /^torn: /.test(x.reason)), 'and named');
A.eq(torn.report.skipped.some(x => /tsconfig/.test(x.path)), false, 'an agent file that was never strict JSON is not a torn store');
A.eq(clean.report.integrity.counts.excludedByDesign, 0, 'nothing excluded here');
fs.mkdirSync(path.join(tornWs, '.secrets'), { recursive: true });
fs.writeFileSync(path.join(tornWs, '.secrets', 'x.json'), '{}');
A.ok(Recovery.capture({ workspaceRoot: tornWs, now: 6 }).report.integrity.counts.excludedByDesign >= 1, 'a credential folder is excluded by design, not a gap');

const old = JSON.parse(JSON.stringify(clean)); delete old.report.integrity;
A.eq(Recovery.bundleIntegrity(old).verbatim, false, 'a bundle from before this field can never read as exact');
A.eq(Recovery.bundleIntegrity(old).tornChecked, false, 'and says why');
const lying = JSON.parse(JSON.stringify(torn)); lying.report.integrity.verbatim = true;
A.ok(Recovery.validate(lying).errors.some(e => /lists gaps/.test(e)), 'a report that claims exact over its own gaps is invalid');

const inspectTorn = path.join(root, 'out', 'torn.starnet-recovery.json');
Recovery.writeBundleAtomic({ bundle: torn, file: inspectTorn });
const seen = out(run(['inspect', '--bundle', inspectTorn]));
A.ok(/^All required categories/.test(seen.verdict.categories), 'inspect says the categories answer in words');
A.ok(/^Not an exact copy: .*replaced from the last good \.bak.*torn store/.test(seen.verdict.files), 'and the files answer separately');

/* ---- a category nobody used is no reason to refuse (the gate itself: station-recovery-safety.test.js) ---- */
const thinWs = path.join(root, 'thin', 'workspaces');
seed(thinWs, 'plain');
fs.unlinkSync(path.join(thinWs, 'loops.json'));
const thinOut = path.join(root, 'out', 'thin.starnet-recovery.json');
const thin = run(['backup', '--workspace', thinWs, '--output', thinOut]);
A.eq(thin.status, 0, 'a category with nothing in it does not stop the write');
A.eq(out(thin).complete, false, 'complete still says what it always said');
A.eq(out(thin).verdict.restoreNeeds, [], 'and a restore needs no flag for it');

/* ---- a rehearsal touches no station ---- */
const beforeFiles = JSON.stringify(fs.readdirSync(vaultWs).sort());
const rehearsal = run(['rehearse', '--bundle', vaultBundle]);
A.eq(rehearsal.status, 0, 'rehearse passes: ' + rehearsal.stderr);
const rehearsed = out(rehearsal);
A.eq(rehearsed.contentMatches, true, 'what lands is what was captured');
A.eq(rehearsed.removed, true, 'its folder is gone');
A.eq(JSON.stringify(fs.readdirSync(vaultWs).sort()), beforeFiles, 'the station is untouched');
const corrupt = JSON.parse(fs.readFileSync(vaultBundle, 'utf8')); corrupt.files[0].data = 'AAAA';
const corruptFile = path.join(root, 'out', 'corrupt.json'); fs.writeFileSync(corruptFile, JSON.stringify(corrupt));
A.ok(run(['rehearse', '--bundle', corruptFile]).status !== 0, 'a corrupt bundle fails the rehearsal');

/* ---- one sidecar per workspace: a live holder refuses backup and replace ---- */
const liveWs = path.join(root, 'live', 'workspaces');
seed(liveWs, 'plain');
const held = cp.spawn(process.execPath, ['-e', `
  const fs = require('fs'), path = require('path');
  const { makeWorkspaceOwner } = require(${JSON.stringify(path.join(__dirname, '..', 'sidecar', 'workspace-owner.js'))});
  const owner = makeWorkspaceOwner({ fs, path, now: () => Date.now() });
  const c = owner.acquire(${JSON.stringify(liveWs)});
  process.stdout.write(c.ok ? 'held' : 'failed');
  setInterval(() => {}, 1000);
`], { stdio: ['ignore', 'pipe', 'inherit'] });
(async () => {
  await new Promise((resolve, reject) => {
    held.stdout.once('data', d => String(d) === 'held' ? resolve() : reject(new Error('fixture could not take the claim')));
    held.once('error', reject);
    held.once('exit', code => reject(new Error('fixture exited before taking the claim: ' + code)));
  });
  const liveOut = path.join(root, 'out', 'live.starnet-recovery.json');
  const liveBackup = run(['backup', '--workspace', liveWs, '--output', liveOut]);
  A.ok(liveBackup.status === 1 && /still running/.test(liveBackup.stderr), 'backup refuses a station a live process owns: ' + liveBackup.stderr);
  A.eq(fs.existsSync(liveOut), false, 'and writes nothing');
  const liveRestore = run(['restore', '--bundle', vaultBundle, '--target', liveWs, '--replace-existing', '--allow-incomplete']);
  A.ok(liveRestore.status === 1 && /still running/.test(liveRestore.stderr), 'restore refuses to replace it');
  A.ok(fs.existsSync(path.join(liveWs, 'agent.save.json')), 'and the station stays where it was');
  A.eq(fs.readdirSync(path.dirname(liveWs)).filter(n => /rollback|restore-stage/.test(n)), [], 'with no stage or rollback left behind');
  held.kill();
  await new Promise(resolve => held.once('exit', resolve));

  /* the holder is gone (a force-killed shell leaves this claim behind): both proceed */
  A.eq(run(['backup', '--workspace', liveWs, '--output', liveOut]).status, 0, 'a dead holder does not block a backup');
  const replaced = run(['restore', '--bundle', liveOut, '--target', liveWs, '--replace-existing']);
  A.eq(replaced.status, 0, 'nor a restore: ' + replaced.stderr);
  A.ok(out(replaced).receipt.rollback && fs.existsSync(path.join(out(replaced).receipt.rollback, 'agent.save.json')), 'the replaced station is kept beside it');
  A.eq(run(['restore', '--bundle', liveOut, '--target', liveWs, '--replace-existing']).status, 0, 'the same bundle can be restored twice');

  /* ---- a pre-update snapshot restores through the CLI ---- */
  const preWs = path.join(root, 'pre', 'workspaces');
  seed(preWs, 'vault');
  const prep = makeUpdatePreparation({
    fs, path, workspaceRoot: preWs, writeDurable: writeFileDurable, now: () => 1760000000000, newId: () => 'id',
    recovery: Object.assign({}, Recovery, { capture: o => Recovery.capture(Object.assign({}, o, { readConnectorState: () => makeConnectorVault({ fs, path, keyHex: KEY }).load(path.join(preWs, 'connectors', 'state.json')) })) })
  });
  const prepared = await prep.prepare({ targetVersion: '9.9.9', browserStore: { 'starnet.save.w.win1': JSON.stringify({ agent: { id: 'agent' } }), 'starnet.station.v1': '{}' } });
  A.eq(prepared.ok, true, 'the pre-update path prepares: ' + prepared.error);
  const snapshot = prepared.receipt.snapshot.file;
  A.eq(out(run(['inspect', '--bundle', snapshot])).integrity.verbatim, true, 'inspect reads a pre-update snapshot');
  A.eq(run(['rehearse', '--bundle', snapshot]).status, 0, 'rehearse reads a read-only pre-update snapshot');
  const preTarget = path.join(root, 'pre-restored', 'workspaces');
  const preRestore = run(['restore', '--bundle', snapshot, '--target', preTarget]);
  A.eq(preRestore.status, 0, 'restore takes it: ' + preRestore.stderr);
  A.ok(JSON.parse(fs.readFileSync(path.join(preTarget, 'connectors', 'state.json'), 'utf8')).configs.some(x => x.id === 'notion'), 'with the connector list the app read');
  const browserFile = JSON.parse(fs.readFileSync(out(preRestore).browserImport.file, 'utf8'));
  A.eq(typeof browserFile.store['starnet.save'], 'string', 'an extra window\'s journal lands under the key RESTORE BACKUP asks for');
  A.eq(Object.keys(browserFile.store).some(k => /\.w\./.test(k)), false, 'and not under its own');
  A.eq(Backup.validate(browserFile), null, 'the import file passes the importer\'s own validation');
  prep.cancel();

  /* ---- the in-app barrier ---- */
  const appWs = path.join(root, 'app', 'workspaces');
  seed(appWs, 'vault');
  const dl = path.join(root, 'app', 'Downloads'); fs.mkdirSync(dl);
  let frozenWrites = 0, thawed = 0, runs = 0;
  const appPrep = makeUpdatePreparation({
    fs, path, workspaceRoot: appWs, writeDurable: writeFileDurable, now: () => 1760000000000, newId: () => 'id', liveRuns: () => runs,
    appVersion: () => '0.14.3', onFreeze: () => { frozenWrites++; }, onThaw: () => { thawed++; },
    recovery: Object.assign({}, Recovery, { capture: o => Recovery.capture(Object.assign({}, o, { readConnectorState: () => makeConnectorVault({ fs, path, keyHex: KEY }).load(path.join(appWs, 'connectors', 'state.json')) })) })
  });
  runs = 1;
  const busy = await appPrep.createBackup({ dir: dl });
  A.eq(busy.code, 'BACKUP_RUNS_ACTIVE', 'a working agent refuses it and is not stopped');
  A.eq(appPrep.isFrozen(), false, 'and the barrier comes down');
  A.eq(fs.readdirSync(dl), [], 'and nothing is written');
  runs = 0;
  const inside = await appPrep.createBackup({ dir: path.join(appWs, 'sub') });
  A.eq(inside.code, 'BACKUP_FOLDER_INSIDE_STATION', 'never inside the station it backs up');
  const made = await appPrep.createBackup({ dir: dl, browserStore: { 'starnet.save': JSON.stringify({ agent: { id: 'agent' } }) } });
  A.eq(made.ok, true, 'the in-app bundle is written: ' + made.error);
  A.ok(frozenWrites >= 1 && thawed >= 1 && appPrep.isFrozen() === false, 'writes froze for it and thawed after');
  const resumed = appPrep.beginRequest('POST', '/api/activity');
  A.ok(resumed.ok, 'mutations resume');
  resumed.release();
  A.eq(path.dirname(made.file), dl, 'it lands in the folder the host chose');
  A.ok(/^starnet-recovery-\d{8}-\d{6}\.starnet-recovery\.json$/.test(path.basename(made.file)), 'under a clearly named file');
  A.eq(made.complete && made.integrity.verbatim, true, 'its receipt is complete and exact');
  const second = await appPrep.createBackup({ dir: dl });
  A.ok(second.ok && second.file !== made.file, 'a second one in the same second never overwrites the first');
  A.eq(appPrep.beginRequest('POST', '/api/recovery/backup').tracked, false, 'the backup request does not wait for itself');
  const prepThenBackup = await appPrep.prepare({ targetVersion: '1' });
  A.eq(prepThenBackup.ok, true, 'an update can prepare after');
  A.eq((await appPrep.createBackup({ dir: dl })).code, 'UPDATE_PREPARED', 'and a backup never takes down a prepared update\'s barrier');
  A.eq(appPrep.isFrozen(), true, 'which stays up');
  appPrep.cancel();

  /* ---- what the page says is the receipt ---- */
  const posts = [];
  const post = (p, body, options) => { posts.push({ p, body, options }); return Promise.resolve({ ok: true, status: 200, j: made }); };
  const said = await Backup.createRecoveryBundle({ post, drain: () => ({ ok: true }) });
  A.eq(posts[0].p, '/api/recovery/backup', 'the page calls the route');
  A.ok(posts[0].options.timeoutMs > 60000, 'and waits longer than a normal write');
  A.ok(said.ok && said.line.indexOf(made.file) >= 0 && /copy it somewhere else/.test(said.line), 'it names the exact file and that it is on this disk');
  A.ok(/All required categories are present/.test(said.detail) && /Nothing was skipped, nothing was repaired from a \.bak, no torn file was kept/.test(said.detail), 'a clean bundle says both answers');
  const gappy = Backup.describeRecovery({ requirements: [{ category: 'connector_references', status: 'omitted' }, { category: 'loops', status: 'missing' }], integrity: { verbatim: false, tornChecked: true, counts: { promotedFromBak: 2, tornKept: 1, omitted: 1, excludedByDesign: 3 } }, gate: { gaps: true, flags: ['--allow-incomplete'] }, gaps: [{ path: 'connectors/state.json', reason: 'omitted: locked', howToGet: 'open the app' }], gapsTotal: 1, reauthentication: [{ kind: 'connector', id: 'notion' }] }).join('\n');
  A.ok(/Some categories have nothing/.test(gappy) && /connector references: left out/.test(gappy) && /loops: nothing captured/.test(gappy) && /--allow-incomplete/.test(gappy), 'a gap in the categories is said');
  A.ok(/Not an exact copy/.test(gappy) && /2 replaced from the last good \.bak/.test(gappy) && /1 torn store/.test(gappy) && /open the app/.test(gappy), 'so is each thing skipped or replaced');
  A.ok(/3 item\(s\) left out on purpose/.test(gappy) && /connector notion/.test(gappy), 'and what was excluded, and what to reconnect');
  const unsure = await Backup.createRecoveryBundle({ post, drain: () => ({ ok: false }) });
  A.ok(unsure.ok && /not confirmed in the station file/.test(unsure.detail), 'an unconfirmed save does not stop the bundle and is said');
  const no = await Backup.createRecoveryBundle({ post: () => Promise.resolve({ ok: false, status: 409, j: { ok: false, error: '1 agent run is still working.' } }) });
  A.ok(!no.ok && /No bundle was written: 1 agent run is still working/.test(no.line), 'a refusal never reads as a backup');
  // the printed commands themselves run in station-recovery-safety.test.js and station-recovery-backup.http.test.js
  const resources = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle.resources;
  A.eq(resources['../bin'], 'bin', 'bin/ ships in the desktop bundle, so the printed command exists there');

  /* ---- every command the doc gives is one this CLI takes ---- */
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'DISASTER_RECOVERY.md'), 'utf8');
  const usage = run(['--help']).stdout;
  const docCommands = doc.split(/\r?\n/).filter(l => /station-recovery\.js" /.test(l)).map(l => l.slice(l.indexOf('station-recovery.js" ') + 21).trim());
  A.ok(docCommands.length >= 4, 'the doc gives its commands: ' + docCommands.length);
  for (const cmd of docCommands) {
    A.ok(['backup', 'inspect', 'rehearse', 'restore'].includes(cmd.split(' ')[0]), 'a subcommand this CLI has: ' + cmd);
    for (const name of cmd.match(/--[a-z-]+/g) || []) A.ok(usage.indexOf(name) >= 0, 'a flag this CLI has: ' + name);
  }
  const backupLine = docCommands.find(c => c.startsWith('backup'));
  A.ok(/Get-Date/.test(backupLine), 'its backup example makes a new name each time, because the tool never overwrites');

  for (const dir of [path.join(root, 'pre', 'update-snapshots')]) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { try { fs.chmodSync(path.join(dir, name), 0o666); } catch (_) {} }
  }
  fs.rmSync(root, { recursive: true, force: true });
  A.report('station-recovery-packaged.test');
})().catch(e => { try { held.kill(); } catch (_) {} console.error(e && e.stack || e); process.exit(1); });
