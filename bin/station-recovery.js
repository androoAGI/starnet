#!/usr/bin/env node
/* bin/station-recovery.js — offline whole-station backup, inspect, rehearse and restore (#119).

   It lives in bin/ because bin/ and sidecar/ both ship inside the desktop app, next to its own node: a packaged install
   can run this with nothing else installed. SETTINGS > APP & BACKUP > RECOVERY BUNDLE prints the exact command for that
   install, and scripts/station-recovery.mjs is a source checkout's way in to the same code.

   Quit StarNet first. ONE SIDECAR PER WORKSPACE is a hard invariant, so backup and restore both take the same workspace
   owner claim a sidecar takes, and refuse while a live StarNet holds it: this tool cannot replace a station under a
   running app, and an app cannot start while it reads or stages one.

   It adds no way to point the app somewhere else. A restore writes into the folder the app already uses, and the folder
   it replaces is kept beside it as workspaces.rollback-*.

   A bundle is not signed. Its checksums catch damage, not a person who edited it, so a restore re-applies today's capture
   policy to every file and nothing here calls a bundle authentic. */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Recovery = require('../sidecar/station-recovery.js');
const { makeWorkspaceOwner, makeBootedAt } = require('../sidecar/workspace-owner.js');
const { makeProcessIdentity } = require('../sidecar/process-identity.js');

const AUTHENTICITY = 'A bundle is not signed: its checksums catch damage, not editing. Restore only a bundle you made yourself.';

const USAGE = [
  'StarNet station recovery (offline: quit StarNet first)',
  '',
  'Backup (never overwrites a file):',
  '  station-recovery backup --workspace <WORKSPACES> --output <file> [--browser-state <backup.json>] [--app-version <v>] [--mutation <id>] [--allow-no-agents]',
  '',
  'Inspect a bundle (a recovery bundle or a pre-update snapshot):',
  '  station-recovery inspect --bundle <file>',
  '',
  'Rehearse a restore in a temporary folder, touching no station:',
  '  station-recovery rehearse --bundle <file>',
  '',
  'Restore onto a folder that does not exist yet:',
  '  station-recovery restore --bundle <file> --target <new-WORKSPACES> [--browser-output <file>] [--allow-incomplete] [--allow-no-agents]',
  '',
  'Restore over an existing station (the current folder is kept beside it as .rollback-*):',
  '  station-recovery restore --bundle <file> --target <WORKSPACES> --replace-existing [--browser-output <file>] [--allow-incomplete] [--allow-no-agents]',
  '',
  '--allow-incomplete: restore although something was left out, repaired or torn.',
  '--allow-no-agents: restore or write a bundle with no readable agent save, which replaces a station with nothing.'
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
// a switch that moves a station must never read "=false" as yes
function flag(a, name) {
  const v = a[name];
  if (v === undefined || v === false) return false;
  if (v === true || v === 'true') return true;
  if (v === 'false') return false;
  throw new Error('--' + name + ' takes no value, or true or false. Got: ' + v);
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
function insideOf(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

/* The claim a sidecar takes, held for the length of this command. Refused only by a holder proven alive: the shell's
   force-kill on Windows leaves a dead claim behind by design, and that one is taken over exactly as the next boot would.
   A claim nobody can read proves nothing either way until the computer restarts, and the person is told that. */
function claimStation(root) {
  const owner = makeWorkspaceOwner({ fs, path, now: () => Date.now(), bootedAt: makeBootedAt(() => Date.now()), processIdentity: makeProcessIdentity() });
  const claim = owner.acquire(root);
  if (!claim.ok && claim.code === 'WORKSPACE_BUSY') {
    if (claim.holder && claim.holder.valid === false) {
      throw Object.assign(new Error('This station\'s owner claim cannot be read, so StarNet may or may not be running. Quit it completely, including from the tray, then restart this computer: a claim older than the last restart is cleared by itself. Nothing was changed.'), { code: claim.code });
    }
    const pid = claim.holder && claim.holder.valid ? ' (process ' + claim.holder.pid + ')' : '';
    throw Object.assign(new Error('StarNet is still running on this station' + pid + '. Quit it completely, including from the tray, then run this again. Nothing was changed.'), { code: claim.code });
  }
  if (!claim.ok) throw new Error('could not take the station for this command: ' + claim.code + ((claim.error && ': ' + claim.error.message) || ''));
  return owner;
}

// Everything here is counted from the bundle's files and rows, so an empty requirements list or a summary edited to read
// "exact" changes nothing. A file can still be edited with its rows removed: only AUTHENTICITY speaks to that.
function verdictOf(bundle) {
  const requirements = Recovery.trustedRequirements(bundle);
  const integrity = Recovery.bundleIntegrity(bundle);
  const gate = Recovery.restoreGate(bundle);
  const absent = requirements.filter(x => x.status === 'missing').map(x => x.category);
  const omitted = requirements.filter(x => x.status === 'omitted').map(x => x.category);
  const c = integrity.counts;
  const gaps = [
    c.omitted && c.omitted + ' left out because the store could not be read here (see skipped: each has howToGet)',
    c.unreadable && c.unreadable + ' could not be read',
    c.tooLarge && c.tooLarge + ' too large for one bundle',
    c.symlinks && c.symlinks + ' symbolic link(s) with data outside the station not followed',
    c.promotedFromBak && c.promotedFromBak + ' replaced from the last good .bak',
    c.unusableBak && c.unusableBak + ' with an unusable .bak',
    c.tornKept && c.tornKept + ' torn store(s) kept as they were',
    c.unportable && c.unportable + ' left out because the name cannot be stored safely',
    gate.tornSaves.length && 'agent save(s) that do not parse: ' + gate.tornSaves.join(', ')
  ].filter(Boolean);
  // these clear "exact" without asking for a flag: a person should know, and a restore still lands what it should
  const notes = [
    c.credentialFiles && c.credentialFiles + ' credential file(s) left out by name, which cannot come back from this bundle',
    c.linksNotFollowed && c.linksNotFollowed + ' link(s) inside the station not followed: run its install step again after a restore'
  ].filter(Boolean);
  // what this tool would really write, whatever the bundle's own rows claim (an old bundle holds what today's capture leaves out)
  const dropped = Recovery.restorePreview(bundle).dropped;
  if (dropped.length) notes.push('a restore will not write ' + dropped.length + ' file(s) in this bundle: ' + dropped.slice(0, 12).map(x => x.path).join(', ') + (dropped.length > 12 ? ', and more' : ''));
  const all = gaps.concat(notes);
  return {
    station: gate.noAgents ? 'THIS BUNDLE HOLDS NO READABLE AGENT (' + gate.files + ' file(s)). It would replace a station with nothing.' : gate.readableSaves + ' readable agent save(s), ' + gate.files + ' file(s).',
    categories: !absent.length && !omitted.length ? 'All required categories are present.'
      : [absent.length ? 'Nothing captured for: ' + absent.join(', ') + '. Expected if you never used them' + (gaps.length ? ', unless a file listed as left out belongs to them.' : '.') : '',
        omitted.length ? 'Left out: ' + omitted.join(', ') + '.' : ''].filter(Boolean).join(' '),
    files: integrity.verbatim && !all.length ? 'Nothing was skipped, nothing was repaired from a .bak, no torn file was kept.'
      : !integrity.tornChecked ? 'This bundle was made by an older StarNet, which did not record torn files, so it cannot prove nothing was torn.' + (all.length ? ' Also: ' + all.join('; ') + '.' : '')
      : 'Not an exact copy: ' + all.join('; ') + '.',
    droppedOnRestore: dropped,
    excludedByDesign: c.excludedByDesign + ' item(s) left out on purpose (known credential fields, approvals, locks, runtime state, older .bak generations).',
    readable: 'This file is not encrypted: conversations, agents\' files, plugin data and app data are in it as readable text. Do not send it to anyone.',
    authenticity: AUTHENTICITY,
    restoreNeeds: gate.flags
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
  // RESTORE BACKUP posts this to the station: how much agents may do alone is reset with the station's own copy
  delete store['starnet.autonomy.v1']; delete store['skynet.autonomy.v1'];
  return store;
}

function backup(a) {
  const workspace = required(a.workspace, 'workspace');
  const output = required(a.output, 'output');
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error('no station folder at ' + workspace);
  if (insideOf(workspace, output)) throw new Error('a recovery bundle cannot be saved inside the station it backs up: ' + output);
  if (fs.existsSync(output)) throw new Error('a file already exists at ' + output + '. Nothing was changed: choose another name.');
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
  const gate = Recovery.restoreGate(bundle);
  const omitted = report.skipped.filter(x => /^omitted: /.test(String(x.reason)));
  const summary = { verdict: verdictOf(bundle), complete: report.complete, integrity: Recovery.bundleIntegrity(bundle), omitted, requirements: Recovery.trustedRequirements(bundle), skipped: report.skipped, reauthentication: report.reauthentication };
  // a category nobody used is no reason to refuse: only "there is no station here" stops the write
  if (gate.noAgents && !flag(a, 'allow-no-agents')) {
    printReport(Object.assign({ ok: false, action: 'backup', output, written: false, next: 'No file was written, because no agent save in this folder can be read. Check that this is the right folder. To write it anyway, run this again with --allow-no-agents.' }, summary));
    return 2;
  }
  const receipt = Recovery.writeBundleAtomic({ bundle, file: output, allowIncomplete: true, noOverwrite: true });
  try { fs.chmodSync(output, 0o600); } catch (_) {}
  printReport(Object.assign({ ok: true, action: 'backup', written: true, receipt, recoveryPoint: bundle.recoveryPoint }, gate.flags.length ? { next: 'Restoring this bundle needs ' + gate.flags.join(' ') + '.' } : {}, summary));
  return 0;
}

function inspect(a) {
  const file = required(a.bundle, 'bundle');
  const bundle = Recovery.readBundle(file);
  printReport({ ok: true, action: 'inspect', file, schema: bundle.schema, version: bundle.version, createdAt: bundle.createdAt, appVersion: bundle.appVersion, manifestSha256: bundle.manifestSha256, recoveryPoint: bundle.recoveryPoint, verdict: verdictOf(bundle), complete: !!bundle.report.complete, integrity: Recovery.bundleIntegrity(bundle), requirements: Recovery.trustedRequirements(bundle), files: bundle.files.length, directories: Array.isArray(bundle.directories) ? bundle.directories.length : 0, browserKeys: bundle.browser.length, skipped: bundle.report.skipped, reauthentication: bundle.report.reauthentication, semanticFingerprint: Recovery.semanticFingerprint(bundle) });
  return 0;
}

function rehearse(a) {
  const file = required(a.bundle, 'bundle');
  const bundle = Recovery.readBundle(file);
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-recovery-rehearsal-'));
  const result = Recovery.rehearse({ bundle, scratchRoot, now: Date.now() });
  printReport(Object.assign({ action: 'rehearse', file, removed: !fs.existsSync(scratchRoot), verdict: verdictOf(bundle) }, result));
  return result.ok ? 0 : 1;
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }

/* What an earlier restore left when its process was stopped. The pid is in each name, so a live restore's own files are
   never touched. A stage holds only files a restore wrote, never a junction. A browser rollback is only swept once the
   output it was moved away from is back, so the one copy of that file is never the thing removed. */
function sweepRestoreLeftovers(target, browserOutput) {
  const removed = [];
  const sweep = (full, stem) => {
    let names;
    try { names = fs.readdirSync(path.dirname(full)); } catch (_) { return; }
    const base = path.basename(full);
    for (const name of names) {
      if (!name.startsWith(base + stem)) continue;
      const m = /^(\d+)-/.exec(name.slice((base + stem).length));
      if (!m || pidAlive(Number(m[1]))) continue;
      const leftover = path.join(path.dirname(full), name);
      try { fs.rmSync(leftover, { recursive: true, force: true }); removed.push(leftover); } catch (_) {}
    }
  };
  sweep(target, '.restore-stage-');
  sweep(browserOutput, '.restore-stage-');
  if (fs.existsSync(browserOutput)) sweep(browserOutput, '.restore-rollback-');
  return removed;
}

function restore(a) {
  const file = required(a.bundle, 'bundle');
  const target = required(a.target, 'target');
  const allowIncomplete = flag(a, 'allow-incomplete');
  const allowNoAgents = flag(a, 'allow-no-agents');
  const replaceExisting = flag(a, 'replace-existing');
  const bundle = Recovery.readBundle(file);
  const gate = Recovery.restoreGate(bundle);
  const verdict = verdictOf(bundle);
  const needs = gate.flags.filter(x => !(x === '--allow-incomplete' && allowIncomplete) && !(x === '--allow-no-agents' && allowNoAgents));
  if (needs.length) {
    throw new Error('Nothing was changed. ' + verdict.station + ' ' + verdict.files + ' If this is all you have, run this again with ' + needs.join(' ') + '.');
  }
  const browserOutput = path.resolve(String(a['browser-output'] || path.join(path.dirname(target), 'starnet-browser-restore.json')));
  if (insideOf(target, browserOutput)) throw new Error('browser output must be outside the workspace target: ' + browserOutput);
  const replacing = fs.existsSync(target);
  if (replacing && !replaceExisting) throw new Error('restore target is not clean; pass --replace-existing to keep it beside the restored station as a rollback generation');
  sweepRestoreLeftovers(target, browserOutput);
  // said before anything moves, on stderr so the receipt on stdout stays one JSON document
  console.error([replacing ? 'Replacing the station at ' + target + ' (the current folder is kept beside it).' : 'Restoring into ' + target + '.',
    verdict.station, verdict.categories, verdict.files, verdict.authenticity].join('\n'));
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
      replaceExisting,
      allowIncomplete,
      allowNoAgents,
      rollbackId: String(bundle.createdAt) + '-' + Date.now(),   // the same bundle restored twice keeps both replaced folders
      beforeActivate() {
        if (fs.existsSync(browserOutput)) { fs.renameSync(browserOutput, browserRollback); browserMoved = true; }
        fs.renameSync(browserStage, browserOutput);
        browserActivated = true;
        if (owner) { owner.release(); owner = null; }
      }
    });
    if (browserMoved && fs.existsSync(browserRollback)) fs.unlinkSync(browserRollback);
    printReport({ ok: true, action: 'restore', verdict, receipt, browserImport: importable
      ? { file: browserOutput, instruction: 'Optional: this holds the window settings. If StarNet opens on its RESUME screen, RESTORE BACKUP imports this file. The station itself is already restored.' }
      : { file: browserOutput, importable: false, instruction: 'This bundle holds no browser copy of the station, so RESTORE BACKUP will not accept this file. The station itself is already restored.' } });
    return 0;
  } catch (e) {
    if (owner) { try { owner.release(); } catch (_) {} }
    // best effort, each on its own: what holds the station may hold these too, and a failure here must never replace e,
    // which may be the only thing saying where the station went
    try { if (browserActivated && fs.existsSync(browserOutput)) fs.unlinkSync(browserOutput); } catch (_) {}
    try { if (browserMoved && fs.existsSync(browserRollback)) fs.renameSync(browserRollback, browserOutput); } catch (_) {}
    try { if (fs.existsSync(browserStage)) fs.unlinkSync(browserStage); } catch (_) {}
    throw e;
  }
}

// the shape of every failure: what happened, and the one state that must never be lost in a stack of words
function failureOf(cmd, e) {
  const out = { ok: false, action: cmd, error: (e && e.message) || String(e) };
  if (e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) out.hint = 'Another program may be holding a file in this folder: antivirus, a backup or sync tool, or StarNet itself. Close it or wait a minute, then run this again.';
  if (e && e.rollbackError) out.rollbackError = (e.rollbackError && e.rollbackError.message) || String(e.rollbackError);
  if (e && e.stationDisplaced) {
    out.stationDisplaced = e.stationDisplaced;
    out.recover = 'YOUR STATION IS SAFE BUT NOT IN PLACE. It is at ' + e.stationDisplaced.rollback + '. DO NOT OPEN STARNET: it would start a new empty station at ' + e.stationDisplaced.target + '. Close whatever holds the folder, then rename that folder back to ' + e.stationDisplaced.target + '. If StarNet was opened anyway, quit it completely and move the new ' + e.stationDisplaced.target + ' aside first.';
  }
  return out;
}

function main(argv) {
  const a = argsOf(argv);
  const cmd = a._[0];
  if (a.help) { console.log(USAGE); process.exitCode = 0; return; }
  const run = { backup, inspect, rehearse, restore }[cmd];
  if (!run) { console.error(USAGE); process.exitCode = 1; return; }
  try { process.exitCode = run(a); }
  catch (e) {
    console.error(JSON.stringify(failureOf(cmd, e), null, 2));
    process.exitCode = 1;
  }
}

module.exports = { main, argsOf, flag, verdictOf, browserImportStore, failureOf };
if (require.main === module) main(process.argv.slice(2));
