#!/usr/bin/env node
/* bin/station-recovery.js — offline whole-station backup, inspect, rehearse and restore (#119).

   It lives in bin/ because bin/ and sidecar/ both ship inside the desktop app, next to its own node: a packaged install
   can run this with nothing else installed. SETTINGS > APP & BACKUP > RECOVERY BUNDLE prints the exact command for that
   install, and scripts/station-recovery.mjs is a source checkout's way in to the same code.

   Quit StarNet first. ONE SIDECAR PER WORKSPACE is a hard invariant, so backup and restore both take the same workspace
   owner claim a sidecar takes, and refuse while a live StarNet holds it: this tool cannot replace a station under a
   running app, and an app cannot start while it reads or stages one.

   It adds no way to point the app somewhere else. A restore writes into the folder the app already uses, and the folder
   it replaces is kept beside it as workspaces.rollback-*. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recovery = require('../sidecar/station-recovery.js');
const { makeWorkspaceOwner, makeBootedAt } = require('../sidecar/workspace-owner.js');
const { makeProcessIdentity } = require('../sidecar/process-identity.js');

const USAGE = [
  'StarNet station recovery (offline: quit StarNet first)',
  '',
  'Backup:',
  '  station-recovery backup --workspace <WORKSPACES> --output <file> [--browser-state <backup.json>] [--app-version <v>] [--mutation <id>] [--allow-incomplete]',
  '',
  'Inspect a bundle (a recovery bundle or a pre-update snapshot):',
  '  station-recovery inspect --bundle <file>',
  '',
  'Rehearse a restore in a temporary folder, touching no station:',
  '  station-recovery rehearse --bundle <file>',
  '',
  'Restore onto a folder that does not exist yet:',
  '  station-recovery restore --bundle <file> --target <new-WORKSPACES> [--browser-output <file>] [--allow-incomplete]',
  '',
  'Restore over an existing station (the current folder is kept beside it as .rollback-*):',
  '  station-recovery restore --bundle <file> --target <WORKSPACES> --replace-existing [--browser-output <file>] [--allow-incomplete]'
].join('\n');

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const k = a.slice(2, eq >= 0 ? eq : undefined);
    if (eq >= 0) out[k] = a.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}
function required(v, name) { if (!v || v === true) throw new Error('--' + name + ' is required'); return path.resolve(String(v)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function browserStoreFrom(file) {
  if (!file) return {};
  const doc = readJson(path.resolve(String(file)));
  if (doc && doc.store && typeof doc.store === 'object') return doc.store;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  throw new Error('browser state must be an object or a StarNet browser backup with {store}');
}
function printReport(doc) { console.log(JSON.stringify(doc, null, 2)); }

/* The claim a sidecar takes, held for the length of this command. Refused only by a holder proven alive: the shell's
   force-kill on Windows leaves a dead claim behind by design, and that one is taken over exactly as the next boot would. */
function claimStation(root) {
  const owner = makeWorkspaceOwner({ fs, path, now: () => Date.now(), bootedAt: makeBootedAt(() => Date.now()), processIdentity: makeProcessIdentity() });
  const claim = owner.acquire(root);
  if (!claim.ok && claim.code === 'WORKSPACE_BUSY') {
    const pid = claim.holder && claim.holder.valid ? ' (process ' + claim.holder.pid + ')' : '';
    throw Object.assign(new Error('StarNet is still running on this station' + pid + '. Quit it completely, including from the tray, then run this again. Nothing was changed.'), { code: claim.code });
  }
  if (!claim.ok) throw new Error('could not take the station for this command: ' + claim.code + ((claim.error && ': ' + claim.error.message) || ''));
  return owner;
}

// the words beside a report, so a reader never has to work out what the two booleans mean together
function verdictOf(report, integrity) {
  const wanting = (report.requirements || []).filter(x => x.status !== 'present').map(x => x.category + ' (' + x.status + ')');
  const c = integrity.counts;
  const gaps = [
    c.omitted && c.omitted + ' left out because the store could not be read here (see skipped: each has howToGet)',
    c.unreadable && c.unreadable + ' could not be read',
    c.tooLarge && c.tooLarge + ' too large for one bundle',
    c.symlinks && c.symlinks + ' symbolic link(s) not followed',
    c.promotedFromBak && c.promotedFromBak + ' replaced from the last good .bak',
    c.unusableBak && c.unusableBak + ' with an unusable .bak',
    c.tornKept && c.tornKept + ' torn store(s) kept as they were'
  ].filter(Boolean);
  return {
    categories: wanting.length ? 'NOT all required categories are present: ' + wanting.join(', ') : 'All required categories are present.',
    files: integrity.verbatim ? 'Nothing was skipped, nothing was repaired from a .bak, no torn file was kept.'
      : !integrity.tornChecked ? 'This bundle was made by an older StarNet, which did not record torn files, so it cannot prove nothing was torn.' + (gaps.length ? ' Also: ' + gaps.join('; ') + '.' : '')
      : 'Not an exact copy: ' + gaps.join('; ') + '.',
    excludedByDesign: c.excludedByDesign + ' item(s) left out on purpose (credentials, locks, runtime state, older .bak generations).'
  };
}

/* The one a RESTORE BACKUP can read. That button asks for 'starnet.save'; a pre-update snapshot from an extra window holds
   its station under that window's own journal key, so that journal is named forward when it is the only one. */
function browserImportStore(bundle) {
  const store = Object.fromEntries(bundle.browser.map(row => [row.key, row.value]));
  if (typeof store['starnet.save'] !== 'string') {
    const journals = Object.keys(store).filter(k => /^starnet\.save\.w\.[A-Za-z0-9_-]{1,80}$/.test(k));
    if (journals.length === 1) store['starnet.save'] = store[journals[0]];
  }
  for (const k of Object.keys(store)) if (/^starnet\.save\.w\./.test(k)) delete store[k];
  return store;
}

function backup(a) {
  const workspace = required(a.workspace, 'workspace');
  const output = required(a.output, 'output');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('no station folder at ' + workspace);
  const owner = claimStation(workspace);
  let bundle;
  try {
    bundle = Recovery.capture({
      workspaceRoot: workspace,
      browserStore: browserStoreFrom(a['browser-state']),
      now: Date.now(),
      appVersion: a['app-version'] || 'unknown',
      lastCompletedMutation: a.mutation == null ? null : String(a.mutation),
      maxChars: Recovery.BUNDLE_MAX_CHARS,
      budgetReason: Recovery.EXPLICIT_BUDGET_REASON,
      omitUnavailableCredentialStores: true
    });
  } finally { owner.release(); }
  const report = bundle.report;
  const integrity = Recovery.bundleIntegrity(bundle);
  const omitted = report.skipped.filter(x => /^omitted: /.test(String(x.reason)));
  const wanting = report.requirements.filter(x => x.status !== 'present');
  // a store this tool cannot open is no reason to have no backup at all: only OTHER missing categories stop the write
  const onlyOmission = wanting.length > 0 && wanting.every(x => x.status === 'omitted');
  const summary = { verdict: verdictOf(report, integrity), complete: report.complete, integrity, omitted, requirements: report.requirements, skipped: report.skipped, reauthentication: report.reauthentication };
  if (!report.complete && !onlyOmission && !a['allow-incomplete']) {
    printReport(Object.assign({ ok: false, action: 'backup', output, written: false, next: 'No file was written. If you never used the missing categories, run this again with --allow-incomplete: restoring that bundle will need --allow-incomplete too.' }, summary));
    return 2;
  }
  const receipt = Recovery.writeBundleAtomic({ bundle, file: output, allowIncomplete: true });
  printReport(Object.assign({ ok: true, action: 'backup', written: true, receipt, recoveryPoint: bundle.recoveryPoint }, report.complete ? {} : { next: 'Restoring this bundle needs --allow-incomplete.' }, summary));
  return 0;
}

function inspect(a) {
  const file = required(a.bundle, 'bundle');
  const bundle = Recovery.readBundle(file);
  const integrity = Recovery.bundleIntegrity(bundle);
  printReport({ ok: true, action: 'inspect', file, schema: bundle.schema, version: bundle.version, createdAt: bundle.createdAt, appVersion: bundle.appVersion, manifestSha256: bundle.manifestSha256, recoveryPoint: bundle.recoveryPoint, verdict: verdictOf(bundle.report, integrity), complete: !!bundle.report.complete, integrity, requirements: bundle.report.requirements, files: bundle.files.length, browserKeys: bundle.browser.length, skipped: bundle.report.skipped, reauthentication: bundle.report.reauthentication, semanticFingerprint: Recovery.semanticFingerprint(bundle) });
  return 0;
}

function rehearse(a) {
  const file = required(a.bundle, 'bundle');
  const bundle = Recovery.readBundle(file);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-rehearsal-'));
  const result = Recovery.rehearse({ bundle, scratchRoot, now: Date.now() });
  printReport(Object.assign({ action: 'rehearse', file, removed: !fs.existsSync(scratchRoot), verdict: verdictOf(bundle.report, result.integrity) }, result));
  return result.ok ? 0 : 1;
}

function restore(a) {
  const file = required(a.bundle, 'bundle');
  const target = required(a.target, 'target');
  const bundle = Recovery.readBundle(file);
  if (!bundle.report.complete && !a['allow-incomplete']) {
    const wanting = (bundle.report.requirements || []).filter(x => x.status !== 'present').map(x => x.category + ' (' + x.status + ')');
    throw new Error('this bundle is incomplete: ' + wanting.join(', ') + '. Nothing was changed. If that is all you have, run this again with --allow-incomplete.');
  }
  const browserOutput = path.resolve(String(a['browser-output'] || path.join(path.dirname(target), 'starnet-browser-restore.json')));
  const browserWithinTarget = path.relative(target, browserOutput);
  if (browserWithinTarget === '' || (!path.isAbsolute(browserWithinTarget) && browserWithinTarget !== '..' && !browserWithinTarget.startsWith('..' + path.sep))) {
    throw new Error('browser output must be outside the workspace target: ' + browserOutput);
  }
  const replacing = fs.existsSync(target);
  if (replacing && !a['replace-existing']) throw new Error('restore target is not clean; pass --replace-existing to keep it beside the restored station as a rollback generation');
  const browserStore = browserImportStore(bundle);
  const importable = typeof browserStore['starnet.save'] === 'string';
  const browserPayload = JSON.stringify({ schema: 'starnet.backup', version: 1, app: 'starnet', exportedAt: bundle.createdAt, agentName: 'restored-station', secretsIncluded: false, secretPolicy: 'credentials-excluded', store: browserStore, notebook: null }, null, 2) + '\n';
  const browserStage = browserOutput + '.restore-stage-' + process.pid + '-' + Date.now();
  const browserRollback = browserOutput + '.restore-rollback-' + process.pid + '-' + Date.now();
  let browserActivated = false;
  let browserMoved = false;
  fs.mkdirSync(path.dirname(browserOutput), { recursive: true });
  if (fs.existsSync(browserOutput) && !fs.statSync(browserOutput).isFile()) throw new Error('browser output is not a file: ' + browserOutput);
  try {
    fs.writeFileSync(browserStage, browserPayload, { flag: 'wx' });
    if (fs.readFileSync(browserStage, 'utf8') !== browserPayload) throw new Error('browser output staging read-back mismatch');
  } catch (e) {
    if (fs.existsSync(browserStage)) fs.unlinkSync(browserStage);
    throw e;
  }
  // held until the moment the old folder moves: the claim file lives inside it
  let owner = null;
  try {
    if (replacing) owner = claimStation(target);
    const receipt = Recovery.restore({
      bundle,
      targetRoot: target,
      replaceExisting: !!a['replace-existing'],
      allowIncomplete: !!a['allow-incomplete'],
      rollbackId: String(bundle.createdAt) + '-' + Date.now(),   // the same bundle restored twice keeps both replaced folders
      beforeActivate() {
        if (fs.existsSync(browserOutput)) { fs.renameSync(browserOutput, browserRollback); browserMoved = true; }
        fs.renameSync(browserStage, browserOutput);
        browserActivated = true;
        if (owner) { owner.release(); owner = null; }
      }
    });
    if (browserMoved && fs.existsSync(browserRollback)) fs.unlinkSync(browserRollback);
    printReport({ ok: true, action: 'restore', verdict: verdictOf(bundle.report, receipt.integrity), receipt, browserImport: importable
      ? { file: browserOutput, instruction: 'Optional: this holds the window settings. If StarNet opens on its RESUME screen, RESTORE BACKUP imports this file. The station itself is already restored.' }
      : { file: browserOutput, importable: false, instruction: 'This bundle holds no browser copy of the station, so RESTORE BACKUP will not accept this file. The station itself is already restored.' } });
    return 0;
  } catch (e) {
    if (owner) { try { owner.release(); } catch (_) {} }
    if (browserActivated && fs.existsSync(browserOutput)) fs.unlinkSync(browserOutput);
    if (browserMoved && fs.existsSync(browserRollback)) fs.renameSync(browserRollback, browserOutput);
    if (fs.existsSync(browserStage)) fs.unlinkSync(browserStage);
    throw e;
  }
}

function main(argv) {
  const a = argsOf(argv);
  const cmd = a._[0];
  if (a.help) { console.log(USAGE); process.exitCode = 0; return; }
  const run = { backup, inspect, rehearse, restore }[cmd];
  if (!run) { console.error(USAGE); process.exitCode = 1; return; }
  try { process.exitCode = run(a); }
  catch (e) {
    console.error(JSON.stringify({ ok: false, action: cmd, error: (e && e.message) || String(e) }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = { main, argsOf, verdictOf, browserImportStore };
if (require.main === module) main(process.argv.slice(2));
