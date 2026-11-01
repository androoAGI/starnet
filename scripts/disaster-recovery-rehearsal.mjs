#!/usr/bin/env node
// Deterministic, disposable whole-station disaster-recovery rehearsal and evidence generator.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const Recovery = require('../sidecar/station-recovery.js');
const Save = require('../frontend/app/save.js');
const { makeConnectorVault } = require('../sidecar/connector-vault.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(process.env.STARNET_DISASTER_RECOVERY_DIR || path.join(ROOT, '.dogfood', 'disaster-recovery-' + stamp));
const latest = path.resolve(process.env.STARNET_DISASTER_RECOVERY_LATEST_DIR || path.join(ROOT, '.dogfood', 'disaster-recovery-latest'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-dr-rehearsal-'));
const source = path.join(scratch, 'damaged-machine', 'workspaces');
const backupDir = path.join(scratch, 'offline-backups');
const scenarios = [];

function ensure(p) { fs.mkdirSync(p, { recursive: true }); }
function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  ensure(path.dirname(file));
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
}
function read(root, rel) { return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'); }
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function record(id, title, fn) {
  const started = Date.now();
  try { const evidence = fn() || {}; scenarios.push({ id, title, status: 'pass', durationMs: Date.now() - started, evidence }); }
  catch (e) { scenarios.push({ id, title, status: 'fail', durationMs: Date.now() - started, error: (e && e.message) || String(e) }); }
}
function assert(v, m) { if (!v) throw new Error(m); }
function seed(root, mutation, taskDone = false) {
  ensure(root);
  write(root, 'agent.roster.json', { version: 1, agents: [{ agentId: 'agent', name: 'NOVA' }, { agentId: 'scribe', name: 'SCRIBE' }] });
  write(root, 'agent.save.json', { version: 1, agentId: 'agent', updatedAt: mutation, savedAt: mutation, doc: { schema: 'starnet.save', version: Save.CURRENT, updatedAt: mutation, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: [{ id: 'command' }, { id: 'lab' }], props: [{ id: 'terminal', roomId: 'command' }, { id: 'bench', roomId: 'lab' }] }, workstreams: [{ id: 'general', title: 'General', messages: [{ role: 'user', content: 'complete station rehearsal' }] }] } });
  write(root, 'channels/agent.history.json', { version: 1, messages: [{ role: 'user', content: 'preserved channel conversation', ts: mutation }] });
  write(root, 'agent.notebook.json', { entries: [{ id: 'memory-1', title: 'Memory', body: 'preserve me' }] });
  write(root, '_commander.dossier.json', { block: 'Commander memory and preferences' });
  write(root, 'cron.jobs.json', { jobs: [{ id: 'routine-1', schedule: '0 9 * * *', prompt: 'morning report' }] });
  write(root, 'loops.json', { loops: [{ id: 'loop-1', objective: 'continue until verified', state: 'active' }] });
  write(root, 'agent.todo.json', { items: [{ id: 'task-1', text: 'complete rehearsal', done: taskDone }] });
  write(root, '_station.quests.json', { quests: [{ id: 'quest-1', title: 'Recover station', state: 'open' }] });
  write(root, 'projects.json', { projects: [{ id: 'project-1', root: 'C:/Projects/demo', blessed: true }] });
  write(root, 'agent.deliverables.json', { records: [{ id: 'deliverable-1', path: 'agent/workshop/run-1/report.md', state: 'kept' }] });
  write(root, 'agent/workshop/run-1/report.md', '# Verified deliverable\nmutation=' + mutation + '\n');
  write(root, 'permissions.allow.json', {
    allow: ['fs.write:workspace', 'shell.exec:*', 'path:C:/Projects/demo'],
    meta: { 'path:C:/Projects/demo': { grantedAt: mutation, source: 'rehearsal' } },
  });
  write(root, 'connectors/state.json', { version: 2, configs: [{ id: 'notion', transport: 'http', url: 'https://mcp.example/api?token=DO_NOT_EXPORT', headers: { Authorization: 'Bearer DO_NOT_EXPORT', 'X-Safe': 'yes' }, oauth: true }], oauth: { byId: { notion: { accessToken: 'DO_NOT_EXPORT', refreshToken: 'DO_NOT_EXPORT' } }, clients: {} } });
  write(root, 'channels/secrets.json', { telegram: { enabled: true, botName: 'station-bot', token: 'DO_NOT_EXPORT' } });
  write(root, '.secrets/spotify.json', { accessToken: 'DO_NOT_EXPORT' });
  write(root, 'proc-ledger.json', { procs: [{ pid: 999 }] });
  write(root, '.recovery-mutation.json', { lastCompletedMutation: mutation });
}

ensure(out); ensure(backupDir); seed(source, 100, false);
const browser100 = {
  'starnet.save': JSON.stringify({ schema: 'starnet.save', version: Save.CURRENT, updatedAt: 100, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: ['command', 'lab'], props: ['terminal', 'bench'] } }),
  'starnet.station.v1': JSON.stringify({ selectedRoom: 'command', camera: { x: 3, y: 4 } }),
  'starnet.queststate.v1': JSON.stringify({ seen: ['quest-1'] }),
  'starnet.byok.key': 'DO_NOT_EXPORT'
};
let bundle100, backup100, cleanReceipt, cleanFingerprint, cleanTarget, cleanBrowser;

record('dr.1-capture', 'Capture complete quiescent station', () => {
  bundle100 = Recovery.capture({ workspaceRoot: source, browserStore: browser100, now: 1000, appVersion: '0.9.0-rehearsal', lastCompletedMutation: 100 });
  assert(bundle100.report.complete, 'required category missing');
  assert(JSON.stringify(bundle100).indexOf('DO_NOT_EXPORT') < 0, 'credential leaked into bundle');
  backup100 = path.join(backupDir, 'station-mutation-100.starnet-recovery.json');
  const receipt = Recovery.writeBundleAtomic({ bundle: bundle100, file: backup100, nonce: 'm100' });
  return { receipt, requirements: bundle100.report.requirements, recoveryPoint: bundle100.recoveryPoint, reauthentication: bundle100.report.reauthentication, skipped: bundle100.report.skipped };
});

record('dr.2-clean-profile', 'Restore complete station onto clean machine/profile', () => {
  cleanTarget = path.join(scratch, 'clean-machine', 'workspaces');
  cleanBrowser = {};
  cleanReceipt = Recovery.restore({ bundle: Recovery.readBundle(backup100), targetRoot: cleanTarget, browserSink: cleanBrowser, nonce: 'clean' });
  const recaptured = Recovery.capture({ workspaceRoot: cleanTarget, browserStore: cleanBrowser, now: 1001, appVersion: '0.9.0-rehearsal', lastCompletedMutation: 100 });
  cleanFingerprint = Recovery.semanticFingerprint(recaptured);
  assert(JSON.stringify(cleanFingerprint) === JSON.stringify(Recovery.semanticFingerprint(bundle100)), 'semantic fingerprint changed after restore');
  assert(read(cleanTarget, 'agent/workshop/run-1/report.md').includes('mutation=100'), 'deliverable missing after restore');
  return { target: cleanTarget, semanticFingerprint: cleanFingerprint, restored: cleanReceipt.restored, skipped: cleanReceipt.skipped, reauthentication: cleanReceipt.reauthentication, browserKeysRestored: cleanReceipt.browserKeysRestored };
});

record('dr.3-corrupt-bundle', 'Reject corrupt backup before destination mutation', () => {
  const corrupt = JSON.parse(JSON.stringify(bundle100));
  corrupt.files.find(x => x.path === 'agent.save.json').data = Buffer.from('corrupt').toString('base64');
  const target = path.join(scratch, 'corrupt-destination');
  let error = '';
  try { Recovery.restore({ bundle: corrupt, targetRoot: target }); } catch (e) { error = e.message; }
  assert(/checksum/.test(error), 'corrupt bundle was not rejected by checksum');
  assert(!fs.existsSync(target), 'corrupt bundle changed destination');
  return { rejected: true, error, destinationCreated: false };
});

record('dr.4-interrupted-backup', 'Interrupted backup preserves previous verified recovery point', () => {
  const before = hash(backup100);
  let error = '';
  try { Recovery.writeBundleAtomic({ bundle: bundle100, file: backup100, nonce: 'interrupt', beforeCommit() { throw new Error('injected interruption before commit'); } }); } catch (e) { error = e.message; }
  assert(error.includes('injected interruption'), 'interruption was not surfaced');
  assert(hash(backup100) === before, 'previous bundle changed');
  return { previousSha256: before, preserved: true, error };
});

record('dr.5-missing-files', 'Missing required store cannot become a complete recovery point', () => {
  const root = path.join(scratch, 'missing-loop-profile');
  fs.cpSync(source, root, { recursive: true });
  fs.unlinkSync(path.join(root, 'loops.json'));
  const bundle = Recovery.capture({ workspaceRoot: root, browserStore: browser100, now: 1100, lastCompletedMutation: 100 });
  const missing = bundle.report.requirements.filter(x => x.status === 'missing');
  assert(missing.some(x => x.category === 'loops'), 'missing loop category was not identified');
  let refused = false;
  try { Recovery.writeBundleAtomic({ bundle, file: path.join(backupDir, 'incomplete.json') }); } catch (_) { refused = true; }
  assert(refused, 'incomplete bundle committed');
  return { complete: bundle.report.complete, missing, commitRefused: true };
});

record('dr.6-disk-full', 'Disk-full backup preserves previous verified recovery point', () => {
  const before = hash(backup100);
  const diskFullFs = new Proxy(fs, { get(target, prop) {
    if (prop === 'writeFileSync') return (fd, data) => { if (typeof fd === 'number') { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } return target.writeFileSync(fd, data); };
    const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  let code = '';
  try { Recovery.writeBundleAtomic({ bundle: bundle100, file: backup100, nonce: 'diskfull', fs: diskFullFs }); } catch (e) { code = e.code; }
  assert(code === 'ENOSPC', 'disk-full error not surfaced');
  assert(hash(backup100) === before, 'previous bundle changed on ENOSPC');
  return { errorCode: code, previousSha256: before, preserved: true };
});

let bundle101;
record('dr.7-previous-version-rollback', 'Rollback to previous station version retains replaced generation', () => {
  seed(source, 101, true);
  const browser101 = Object.assign({}, browser100, { 'starnet.station.v1': JSON.stringify({ selectedRoom: 'lab', camera: { x: 9, y: 9 } }) });
  bundle101 = Recovery.capture({ workspaceRoot: source, browserStore: browser101, now: 2000, appVersion: '0.9.1-rehearsal', lastCompletedMutation: 101 });
  const target = path.join(scratch, 'rollback-machine', 'workspaces');
  const browser = {};
  Recovery.restore({ bundle: bundle101, targetRoot: target, browserSink: browser, nonce: 'new' });
  const receipt = Recovery.restore({ bundle: bundle100, targetRoot: target, browserSink: browser, replaceExisting: true, nonce: 'old', rollbackId: 'mutation-101' });
  assert(receipt.rollback && fs.existsSync(receipt.rollback), 'replaced generation not retained');
  assert(read(target, '.recovery-mutation.json').includes('100'), 'older generation not active');
  assert(read(receipt.rollback, '.recovery-mutation.json').includes('101'), 'newer generation not retained');
  return { activeMutation: 100, retainedMutation: 101, rollbackGeneration: receipt.rollback, browserStateRolledBack: browser['starnet.station.v1'] === browser100['starnet.station.v1'] };
});

record('dr.8-recovery-point', 'Measure completed-mutation loss from last successful recovery point', () => {
  const lastDurableRecoveryMutation = Number(bundle100.recoveryPoint.lastCompletedMutation);
  const damageAfterMutation = Number(bundle101.recoveryPoint.lastCompletedMutation);
  const lost = damageAfterMutation - lastDurableRecoveryMutation;
  assert(lost === 1, 'rehearsal recovery point lost ' + lost + ' mutations, expected exactly one');
  return { lastDurableRecoveryMutation, damageAfterMutation, observedCompletedMutationsLost: lost, targetMaximum: 1, pass: lost <= 1, limitation: 'This is an explicit quiescent recovery-point guarantee, not an automatic continuous-backup RPO.' };
});

record('dr.9-connector-vault', 'Encrypted connector state: the app keeps the list without credentials, offline says what it left out', () => {
  const root = path.join(scratch, 'vault-profile', 'workspaces');
  seed(root, 200, false);
  const stateFile = path.join(root, 'connectors', 'state.json');
  const state = { version: 2, configs: [{ id: 'notion', transport: 'http', url: 'https://mcp.example/api', oauth: true }], oauth: { byId: { notion: { accessToken: 'DO_NOT_EXPORT', refreshToken: 'DO_NOT_EXPORT' } }, clients: {} } };
  const vault = makeConnectorVault({ fs, path, keyHex: 'ab'.repeat(32) });
  vault.write(stateFile, state);
  assert(JSON.parse(read(root, 'connectors/state.json')).format === 'starnet.connector-vault.v1', 'fixture is not encrypted');
  const online = Recovery.capture({ workspaceRoot: root, browserStore: browser100, now: 3000, lastCompletedMutation: 200, omitUnavailableCredentialStores: true, readConnectorState: () => makeConnectorVault({ fs, path, keyHex: 'ab'.repeat(32) }).load(stateFile) });
  assert(online.report.complete, 'the running-app capture is incomplete');
  assert(JSON.stringify(online).indexOf('DO_NOT_EXPORT') < 0, 'credential leaked into the running-app bundle');
  const restoredOnline = path.join(scratch, 'vault-clean-machine', 'workspaces');
  const receipt = Recovery.restore({ bundle: online, targetRoot: restoredOnline });
  assert(JSON.parse(read(restoredOnline, 'connectors/state.json')).configs.some(x => x.id === 'notion'), 'connector reference did not restore');
  assert(receipt.reauthentication.some(x => x.kind === 'connector' && x.id === 'notion'), 'connector sign-in is not listed for reauthentication');
  const offline = Recovery.capture({ workspaceRoot: root, browserStore: browser100, now: 3001, lastCompletedMutation: 200, omitUnavailableCredentialStores: true });
  assert(!offline.report.complete, 'an offline bundle without the connector list must not read complete');
  assert(offline.files.every(x => x.path !== 'connectors/state.json'), 'encrypted store rode the offline bundle');
  const left = offline.report.skipped.find(x => x.path === 'connectors/state.json');
  assert(left && /^omitted: /.test(left.reason) && left.howToGet, 'offline report does not say what was left out and how to get it');
  const scratchRoot = path.join(scratch, 'vault-rehearsal');
  ensure(scratchRoot);
  const rehearsal = Recovery.rehearse({ bundle: offline, scratchRoot, now: 3002 });
  assert(rehearsal.ok, 'offline bundle did not restore to the same content');
  assert(!fs.existsSync(scratchRoot), 'rehearsal left its folder behind');
  return { onlineComplete: online.report.complete, onlineIntegrity: online.report.integrity, offlineComplete: offline.report.complete, offlineIntegrity: offline.report.integrity, left };
});

const failed = scenarios.filter(x => x.status !== 'pass');
const status = {
  schema: 'starnet.disaster-recovery-rehearsal.v1',
  generatedAt: new Date().toISOString(),
  verdict: failed.length ? 'red' : 'green',
  completeStationRestored: !failed.length,
  counts: { pass: scenarios.length - failed.length, fail: failed.length },
  requiredCategories: Recovery.REQUIRED_CATEGORIES,
  scenarios,
  exactRecoveryAccounting: cleanReceipt ? { restored: cleanReceipt.restored, skipped: cleanReceipt.skipped, reauthentication: cleanReceipt.reauthentication } : null,
  semanticFingerprint: cleanFingerprint || null,
  rpo: scenarios.find(x => x.id === 'dr.8-recovery-point')?.evidence || null,
  limitations: [
    'The rehearsal uses a disposable filesystem profile and synthetic credentials, including a connector-vault fixture with a synthetic key; installed Windows/macOS UI import and the real OS credential store remain a separate attended proof.',
    'The RPO is measured for explicit quiescent recovery points. StarNet does not yet claim an automatic continuous-backup RPO.'
  ]
};

ensure(out);
fs.writeFileSync(path.join(out, 'disaster-recovery-status.json'), JSON.stringify(status, null, 2) + '\n');
const md = [
  '# StarNet Disaster-Recovery Rehearsal', '',
  '- Verdict: **' + status.verdict.toUpperCase() + '**',
  '- Complete station restored: **' + String(status.completeStationRestored) + '**',
  '- Scenarios: **' + status.counts.pass + '/' + scenarios.length + ' pass**',
  '- Recovery point: mutation **' + (status.rpo?.lastDurableRecoveryMutation ?? '?') + '**; damage after **' + (status.rpo?.damageAfterMutation ?? '?') + '**; completed mutations lost **' + (status.rpo?.observedCompletedMutationsLost ?? '?') + '**',
  '', '| Scenario | Status |', '| --- | --- |',
  ...scenarios.map(s => '| ' + s.id + ' — ' + s.title + ' | ' + s.status.toUpperCase() + ' |'),
  '', '## Reauthentication required', '',
  ...(status.exactRecoveryAccounting?.reauthentication || []).map(x => '- ' + x.kind + ' `' + x.id + '`: ' + x.reason),
  '', '## Known limits', '', ...status.limitations.map(x => '- ' + x), ''
].join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), md);
if (cleanTarget && fs.existsSync(cleanTarget)) {
  fs.cpSync(cleanTarget, path.join(out, 'restored-profile'), { recursive: true });
  fs.writeFileSync(path.join(out, 'starnet-browser-restore.json'), JSON.stringify({
    schema: 'starnet.backup', version: 1, app: 'starnet', exportedAt: bundle100.createdAt,
    agentName: 'NOVA', secretsIncluded: false, secretPolicy: 'credentials-excluded',
    store: cleanBrowser || {}, notebook: null
  }, null, 2) + '\n');
}
fs.rmSync(latest, { recursive: true, force: true });
fs.cpSync(out, latest, { recursive: true });
fs.rmSync(scratch, { recursive: true, force: true });
console.log('disaster-recovery rehearsal: ' + status.verdict + ' (' + status.counts.pass + '/' + scenarios.length + ' pass)');
console.log('evidence: ' + out);
process.exit(failed.length ? 1 : 0);
