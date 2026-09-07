#!/usr/bin/env node
// t0-clean-install.mjs - Clean Windows install proof gate for beta distribution.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCurrentNsisInstaller } from './lib/release-installer.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawArgs = process.argv.slice(2);
const LOOP_ARG = rawArgs.find(a => /^--loop(=|$)/.test(a));
const LOOP_MAX = LOOP_ARG ? Math.max(1, Number(LOOP_ARG.split('=')[1] || process.env.STARNET_T0_LOOPS || 3) || 3) : 1;
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace(/Z$/, '') + '-' + process.pid;
const OUT = resolve(process.env.STARNET_T0_CLEAN_INSTALL_DIR || join(ROOT, '.dogfood', 't0-clean-install-' + STAMP));
const LATEST = resolve(process.env.STARNET_T0_CLEAN_INSTALL_LATEST_DIR || join(ROOT, '.dogfood', 't0-clean-install-latest'));

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }
function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch (_) { return ''; }
}
function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function stripJsonBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
function writeJson(file, value) {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}
function statusIcon(status) {
  if (status === 'pass') return 'PASS';
  if (status === 'fail') return 'FAIL';
  if (status === 'blocked') return 'BLOCKED';
  return 'SKIP';
}
function copyLatest() {
  rmSync(LATEST, { recursive: true, force: true });
  ensureDir(LATEST);
  for (const name of readdirSync(OUT)) {
    try { copyFileSync(join(OUT, name), join(LATEST, name)); } catch (_) {}
  }
}
function sha256(file) {
  const h = createHash('sha256');
  h.update(readFileSync(file));
  return h.digest('hex');
}
function fileInfo(file) {
  if (!file || !existsSync(file)) return null;
  if (!statSync(file).isFile()) return null;
  const st = statSync(file);
  return { path: file, bytes: st.size, sha256: sha256(file), mtime: st.mtime.toISOString() };
}
function tauriVersion() {
  const conf = readJson(join(ROOT, 'src-tauri', 'tauri.conf.json'), {});
  return conf && conf.version || '';
}
function artifactPaths() {
  const release = join(ROOT, 'src-tauri', 'target', 'release');
  const installer = process.env.STARNET_T0_INSTALLER_EXE || findCurrentNsisInstaller(ROOT);
  return {
    installer: installer ? resolve(installer) : '',
    version: tauriVersion()
  };
}
function argValue(name) {
  const eq = rawArgs.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const idx = rawArgs.indexOf(name);
  return idx >= 0 ? rawArgs[idx + 1] : '';
}
function evidencePath() {
  const raw = process.env.STARNET_T0_CLEAN_EVIDENCE || argValue('--evidence') || '';
  return raw ? resolve(raw) : '';
}
function windowsPath(p) {
  if (process.platform !== 'win32') return false;
  return existsSync(p);
}
function detectCleanSurface() {
  if (process.env.STARNET_T0_CLEAN_SURFACE_MOCK) return JSON.parse(process.env.STARNET_T0_CLEAN_SURFACE_MOCK);
  const sandboxPaths = [
    'C:\\Windows\\System32\\WindowsSandbox.exe',
    'C:\\Windows\\Sysnative\\WindowsSandbox.exe'
  ];
  const vmTools = [
    'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
    'C:\\Program Files (x86)\\VMware\\VMware Workstation\\vmrun.exe',
    'C:\\Program Files\\qemu\\qemu-system-x86_64.exe'
  ];
  const windowsSandboxPaths = sandboxPaths.filter(windowsPath);
  const vmToolPaths = vmTools.filter(windowsPath);
  return {
    platform: process.platform,
    windowsSandboxAvailable: windowsSandboxPaths.length > 0,
    windowsSandboxPaths,
    vmToolsAvailable: vmToolPaths.length > 0,
    vmToolPaths,
    cleanSurfaceAvailable: windowsSandboxPaths.length > 0 || vmToolPaths.length > 0,
    note: windowsSandboxPaths.length || vmToolPaths.length
      ? 'A clean Windows surface tool is present; run the installer there and import the proof JSON.'
      : 'No Windows Sandbox or common local VM CLI was detected on this host.'
  };
}
function parseEvidence(file) {
  if (!file) return { path: '', present: false, doc: null, errors: ['No clean-machine evidence JSON was provided.'] };
  if (!existsSync(file)) return { path: file, present: false, doc: null, errors: ['Evidence file does not exist: ' + file] };
  try {
    const doc = JSON.parse(stripJsonBom(readFileSync(file, 'utf8')));
    return { path: file, present: true, doc, errors: [] };
  } catch (e) {
    return { path: file, present: true, doc: null, errors: ['Evidence JSON could not be parsed: ' + (e && e.message || e)] };
  }
}
function evidenceBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}
function evidenceString(value) {
  return String(value == null ? '' : value).trim().replace(/^"+|"+$/g, '');
}
function normPath(value) {
  return evidenceString(value).replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}
function isSubPath(child, parent) {
  const c = normPath(child);
  const p = normPath(parent);
  return !!c && !!p && (c === p || c.startsWith(p + '\\'));
}
function hasSmokeInstallMarker(value) {
  return /starnett\d[^\\\/]*smoke/i.test(evidenceString(value));
}
function isWindowsAppDataPath(value) {
  return /[\\\/]appdata[\\\/](local|roaming)[\\\/]/i.test(evidenceString(value));
}
function validateEvidence(parsed, installerInfo) {
  const errors = parsed.errors.slice();
  const doc = parsed.doc || {};
  if (!parsed.present || !doc) return { ready: false, errors, proof: null };
  if (doc.schema !== 'starnet.clean-install-proof.v1') errors.push('Evidence schema must be starnet.clean-install-proof.v1.');
  if (!evidenceBool(doc.cleanMachine)) errors.push('Evidence must declare cleanMachine=true.');
  const installer = doc.installer || {};
  const gotHash = String(installer.sha256 || '').toLowerCase();
  const expectedHash = installerInfo && String(installerInfo.sha256 || '').toLowerCase();
  if (!gotHash) errors.push('Evidence installer.sha256 is missing.');
  if (expectedHash && gotHash && gotHash !== expectedHash) errors.push('Evidence installer.sha256 does not match the current NSIS installer.');
  if (installerInfo && Number(installer.bytes || 0) && Number(installer.bytes) !== installerInfo.bytes) errors.push('Evidence installer.bytes does not match the current NSIS installer.');
  if (!evidenceBool(doc.install && doc.install.succeeded)) errors.push('Evidence install.succeeded must be true.');
  if (!evidenceBool(doc.launch && doc.launch.succeeded)) errors.push('Evidence launch.succeeded must be true.');
  const installLocation = evidenceString(doc.install && doc.install.installLocation);
  const exePath = evidenceString(doc.launch && doc.launch.exePath);
  const workspaceRoot = evidenceString(doc.launch && (doc.launch.workspaceRoot || doc.launch.workspaces));
  if (!installLocation) errors.push('Evidence install.installLocation is missing.');
  if (!exePath) errors.push('Evidence launch.exePath is missing.');
  if (!workspaceRoot) errors.push('Evidence launch.workspaceRoot is missing.');
  const hygienePaths = [
    ['install.installLocation', installLocation],
    ['launch.exePath', exePath],
    ['launch.workspaceRoot', workspaceRoot],
    ['launch.startupRoot', doc.launch && doc.launch.startupRoot],
    ['launch.resourceDir', doc.launch && doc.launch.resourceDir]
  ].map(([label, value]) => [label, evidenceString(value)]).filter(([, value]) => value);
  const smokePath = hygienePaths.find(([, value]) => hasSmokeInstallMarker(value));
  if (smokePath) errors.push('Evidence points at a StarNet smoke-test install path: ' + smokePath[0] + '.');
  if (installLocation && workspaceRoot && isSubPath(workspaceRoot, installLocation)) errors.push('Evidence launch.workspaceRoot must not live under the installation directory.');
  if (workspaceRoot && !isWindowsAppDataPath(workspaceRoot)) errors.push('Evidence launch.workspaceRoot must live under Windows AppData.');
  const proof = {
    schema: doc.schema || '',
    generatedAt: doc.generatedAt || '',
    sourceMachine: doc.sourceMachine || {},
    machineKind: doc.machineKind || '',
    cleanMachine: evidenceBool(doc.cleanMachine),
    installer: doc.installer || {},
    install: doc.install || {},
    launch: doc.launch || {},
    installHygiene: {
      installLocation,
      exePath,
      workspaceRoot,
      workspaceInsideInstall: !!(installLocation && workspaceRoot && isSubPath(workspaceRoot, installLocation)),
      smokeInstallPath: smokePath ? { field: smokePath[0], path: smokePath[1] } : null
    },
    notes: Array.isArray(doc.notes) ? doc.notes : []
  };
  return { ready: errors.length === 0, errors, proof };
}
function step(id, phase, title, status, reason, extra = {}) {
  return Object.assign({ id, phase, title, status, required: true, reason }, extra);
}
function checkPlan(loop) {
  const file = join(ROOT, 'docs', 'STARNET_T0_CLEAN_INSTALL_PROOF.md');
  const text = readText(file).toLowerCase();
  const required = ['clean-machine', 'installer hash', 'install success', 'first launch', 'not a dev-box'];
  const missing = required.filter(term => text.indexOf(term) < 0);
  return step('t0.0-loop-spec', 'T0.0', 'Clean-machine proof loop is documented', existsSync(file) && !missing.length ? 'pass' : 'fail', missing.length ? 'Missing terms: ' + missing.join(', ') : 'T0 clean-machine proof spec exists.', { loop, evidenceFile: file });
}
function runOnce(loop) {
  const results = [checkPlan(loop)];
  const artifacts = artifactPaths();
  const installerInfo = fileInfo(artifacts.installer);
  results.push(step('t0.1-release-installer', 'T0.1', 'Current NSIS installer is discoverable and hash-recorded', installerInfo ? 'pass' : 'blocked', installerInfo ? 'NSIS installer found; hash recorded.' : 'Build the desktop installer first with npm.cmd run phase5:surface or npm.cmd run desktop:build.', { loop, artifacts: { installer: installerInfo, version: artifacts.version } }));

  const surface = detectCleanSurface();
  const parsed = parseEvidence(evidencePath());
  const validation = validateEvidence(parsed, installerInfo);
  ensureDir(OUT);
  writeJson(join(OUT, 'clean-surface.json'), surface);
  writeJson(join(OUT, 'imported-evidence.json'), parsed.doc || { path: parsed.path, present: parsed.present, errors: parsed.errors });

  const proofImported = validation.ready;
  results.push(step('t0.2-clean-windows-surface', 'T0.2', 'A clean Windows surface is available or imported', proofImported || surface.cleanSurfaceAvailable ? 'pass' : 'blocked', proofImported ? 'Imported clean-machine proof is present, so local clean-surface availability is not required for this run.' : surface.note, { loop, surface }));

  if (proofImported) {
    results.push(step('t0.3-matching-clean-machine-evidence', 'T0.3', 'Clean-machine evidence matches the current installer', 'pass', 'Evidence declares a clean machine and matches the current installer hash.', { loop, evidence: validation.proof }));
    results.push(step('t0.4-install-launch-observed', 'T0.4', 'Install success and first launch were observed', 'pass', 'Clean-machine evidence records install.succeeded=true and launch.succeeded=true.', { loop, evidence: validation.proof }));
  } else if (parsed.present) {
    results.push(step('t0.3-matching-clean-machine-evidence', 'T0.3', 'Clean-machine evidence matches the current installer', 'fail', validation.errors.join(' '), { loop, evidencePath: parsed.path, errors: validation.errors }));
    results.push(step('t0.4-install-launch-observed', 'T0.4', 'Install success and first launch were observed', 'fail', validation.errors.join(' '), { loop, evidencePath: parsed.path, errors: validation.errors }));
  } else {
    results.push(step('t0.3-matching-clean-machine-evidence', 'T0.3', 'Clean-machine evidence matches the current installer', 'blocked', 'Run the current installer on a true clean Windows machine, then import the proof JSON with STARNET_T0_CLEAN_EVIDENCE or --evidence.', { loop, evidencePath: parsed.path, errors: validation.errors }));
    results.push(step('t0.4-install-launch-observed', 'T0.4', 'Install success and first launch were observed', 'blocked', 'No clean-machine install and first-launch proof exists yet.', { loop, evidencePath: parsed.path, errors: validation.errors }));
  }

  return results;
}
function signature(results) {
  return results.map(r => r.id + ':' + r.status + ':' + (r.reason || '')).join('|');
}
function chooseNextAction(latest) {
  const nonPass = latest.filter(r => r.status === 'fail' || r.status === 'blocked');
  if (!nonPass.length) return null;
  const failed = nonPass.find(r => r.status === 'fail');
  if (failed) return failed;
  const priority = [
    't0.1-release-installer',
    't0.2-clean-windows-surface',
    't0.3-matching-clean-machine-evidence',
    't0.4-install-launch-observed',
    't0.0-loop-spec'
  ];
  for (const id of priority) {
    const match = nonPass.find(r => r.id === id);
    if (match) return match;
  }
  return nonPass[0];
}
function writeSummary(allResults, loopsRun) {
  ensureDir(OUT);
  const latest = allResults.filter(r => r.loop === loopsRun);
  const fail = latest.filter(r => r.status === 'fail').length;
  const blocked = latest.filter(r => r.status === 'blocked').length;
  const pass = latest.filter(r => r.status === 'pass').length;
  const cleanInstallProofReady = !fail && !blocked && latest.length > 0 && latest.every(r => r.status === 'pass');
  const nextAction = chooseNextAction(latest);
  const verdict = fail ? 'red' : (blocked ? 'blocked' : 'green');
  const blockers = latest.filter(r => r.status === 'blocked').map(r => r.reason);
  const failures = latest.filter(r => r.status === 'fail').map(r => r.reason);
  const json = {
    generatedAt: nowIso(),
    lane: 'T0-clean-install-proof',
    version: tauriVersion(),
    installer: latest.find(r => r.id === 't0.1-release-installer')?.artifacts?.installer || null,
    verdict,
    cleanInstallProofReady,
    loopsRun,
    outDir: OUT,
    counts: { pass, blocked, fail },
    blockers,
    failures,
    nextAction: nextAction ? { id: nextAction.id, status: nextAction.status, reason: nextAction.reason } : null,
    results: latest,
    history: allResults.map(r => ({ loop: r.loop, id: r.id, status: r.status, reason: r.reason || '' }))
  };
  writeJson(join(OUT, 't0-clean-install-status.json'), json);

  let md = '# StarNet T0 Clean-Machine Install Evidence\n\n';
  md += '- Generated: `' + json.generatedAt + '`\n';
  md += '- Verdict: `' + json.verdict + '`\n';
  md += '- Clean install proof ready: `' + json.cleanInstallProofReady + '`\n\n';
  md += '| Status | Phase | Step | Notes |\n|---|---|---|---|\n';
  for (const r of latest) md += '| ' + statusIcon(r.status) + ' | `' + mdEscape(r.phase) + '` | `' + r.id + '` ' + mdEscape(r.title) + ' | ' + mdEscape(r.reason) + ' |\n';
  md += '\n## Next Action\n\n';
  if (nextAction) md += 'Work `' + nextAction.id + '`: ' + nextAction.reason + '\n';
  else md += 'T0 is clean-install proof ready.\n';
  writeFileSync(join(OUT, 'summary.md'), md);
  copyLatest();
  return json;
}

let allResults = [];
let loopsRun = 0;
let prevSig = '';
for (let i = 1; i <= LOOP_MAX; i += 1) {
  console.log('[t0-clean-install] loop ' + i + ' starting');
  const results = runOnce(i);
  loopsRun = i;
  allResults = allResults.concat(results);
  for (const r of results) console.log('[t0-clean-install]   ' + statusIcon(r.status) + ' ' + r.id);
  const sig = signature(results);
  if (!results.some(r => r.status !== 'pass')) break;
  if (prevSig && prevSig === sig) break;
  prevSig = sig;
}

const summary = writeSummary(allResults, loopsRun);
console.log('[t0-clean-install] evidence: ' + OUT);
console.log('[t0-clean-install] latest: ' + LATEST);
console.log('[t0-clean-install] cleanInstallProofReady=' + summary.cleanInstallProofReady);
if (summary.verdict === 'red') process.exit(1);
if (!summary.cleanInstallProofReady) process.exit(2);
process.exit(0);
