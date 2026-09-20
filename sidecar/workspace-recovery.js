/* sidecar/workspace-recovery.js — discover and activate stranded local station roots safely.

   Recovery is deliberately two-phase. The authenticated UI writes one opaque candidate request, then the
   sidecar exits. The next sidecar boot applies that request BEFORE the workspace owner/store graph opens:
   source -> sibling stage -> hash read-back -> retain current as rollback -> atomic activation. The source
   root is never mutated, and an ambiguous set is never selected without the Commander's explicit click. */
'use strict';

const crypto = require('node:crypto');
const fsNative = require('node:fs');
const osNative = require('node:os');
const pathNative = require('node:path');
const { makeCronLock } = require('./cron-lock.js');   // O_EXCL + pid:nonce + stale-break advisory lock (G4.3 primitive)
const { makeWorkspaceOwner } = require('./workspace-owner.js');

const REQUEST_VERSION = 1;
// Recovery activation runs BEFORE the workspace owner claim (it renames the workspace itself, so the
// owner file inside it cannot protect it). This advisory lock lives at the PARENT level — a sibling of
// the workspace root, like the request/last-result files — and serializes the whole inspect->copy->rename
// window across processes. A live holder means another sidecar is mid-recovery: the caller fails closed.
const RECOVERY_LOCK_MAX_RUN_MS = 8 * 60 * 1000;   // diagnostic age only; recovery disables age-based live-lock theft
// copyVerified/inventory read every file fully into memory (sync, hash + read-back verify). These caps
// fail the recovery CLOSED with a clear error before a pathological source OOMs the sidecar.
const MAX_RECOVERY_FILE_BYTES = 256 * 1024 * 1024;         // one file over 256 MiB cannot be safely buffered
const MAX_RECOVERY_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;   // 2 GiB aggregate source ceiling
const SAVE_NAMES = ['agent.save.json', 'agent.save.json.bak'];
const SKIP_TOP = new Set(['.browser-profile', '.starnet-workspace-owner.json.generations']);
const SKIP_FILES = new Set([
  '.starnet-workspace-owner.json', 'cron.lock', 'proc-ledger.json',
  '.migration-pending', '.migration-receipt.json', '.migrated'
]);
let atomicSequence = 0;

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function slash(value) { return String(value || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cleanStamp(now) { return new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 17); }

function samePath(a, b, path, platform) {
  const left = path.resolve(String(a || '')), right = path.resolve(String(b || ''));
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function uniqueRoots(values, path, platform) {
  const out = [];
  for (const value of values || []) {
    if (!value) continue;
    const root = path.resolve(String(value));
    if (!out.some(row => samePath(row, root, path, platform))) out.push(root);
  }
  return out;
}

function displayPath(root, home, path, platform) {
  const resolved = path.resolve(String(root || ''));
  const base = home ? path.resolve(String(home)) : '';
  if (!base) return resolved;
  const foldedResolved = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const foldedBase = platform === 'win32' ? base.toLowerCase() : base;
  if (foldedResolved === foldedBase) return '~';
  if (foldedResolved.startsWith(foldedBase + path.sep)) return '~' + resolved.slice(base.length);
  const tail = resolved.split(/[\\/]+/).filter(Boolean).slice(-2).join('/');
  return '[local-data]' + (tail ? '/' + tail : '');
}

function decodeSave(raw) {
  let envelope;
  try { envelope = JSON.parse(raw.toString('utf8')); } catch (_) { return null; }
  const doc = isObj(envelope && envelope.doc) ? envelope.doc : envelope;
  if (!isObj(doc) || doc.schema !== 'starnet.save' || !isObj(doc.agent)) return null;
  return {
    stationName: String(doc.agent.name || doc.agent.id || 'Prior station').slice(0, 120),
    updatedAt: Math.max(0, Number(doc.updatedAt || envelope.updatedAt || envelope.savedAt) || 0),
    saveVersion: Math.max(0, Number(doc.version) || 0)
  };
}

function readRootCandidate(root, deps) {
  const d = deps || {}, fs = d.fs || fsNative, path = d.path || pathNative;
  let sawSave = false;
  for (const name of SAVE_NAMES) {
    const file = path.join(root, name);
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      sawSave = true;
      const raw = fs.readFileSync(file);
      const decoded = decodeSave(raw);
      if (!decoded) continue;
      return Object.assign(decoded, {
        recoverable: true,
        sourceRoot: root,
        sourceFile: name,
        bytes: raw.length,
        saveSha256: sha256(raw)
      });
    } catch (_) { sawSave = true; }
  }
  return sawSave ? { recoverable: false, sourceRoot: root, reason: 'save file is unreadable or invalid' } : null;
}

function inspectCandidates(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const platform = String(o.platform || process.platform);
  const home = String(o.home || '');
  const current = path.resolve(String(o.workspaceRoot || ''));
  const roots = uniqueRoots(o.candidateRoots, path, platform).filter(root => !samePath(root, current, path, platform));
  const candidates = [];
  for (const root of roots) {
    const found = readRootCandidate(root, { fs, path });
    if (!found) continue;
    const identity = found.recoverable ? found.saveSha256 : 'invalid';
    candidates.push(Object.assign(found, {
      id: sha256(Buffer.from(root + '\0' + identity)).slice(0, 24),
      displayRoot: displayPath(root, home, path, platform)
    }));
  }
  candidates.sort((a, b) => Number(b.recoverable) - Number(a.recoverable) || b.updatedAt - a.updatedAt || a.displayRoot.localeCompare(b.displayRoot));
  const valid = candidates.filter(row => row.recoverable);
  return {
    candidates,
    recoverableCount: valid.length,
    distinctSaveCount: new Set(valid.map(row => row.saveSha256)).size,
    automaticCandidateId: valid.length === 1 ? valid[0].id : null
  };
}

function publicCandidate(row) {
  return {
    id: row.id,
    recoverable: row.recoverable === true,
    stationName: row.recoverable ? row.stationName : 'Unreadable prior save',
    updatedAt: row.recoverable ? row.updatedAt : 0,
    saveVersion: row.recoverable ? row.saveVersion : 0,
    bytes: row.recoverable ? row.bytes : 0,
    displayRoot: row.displayRoot,
    reason: row.recoverable ? undefined : row.reason
  };
}

function publicInspection(inspection) {
  const value = inspection || { candidates: [] };
  return {
    candidates: (value.candidates || []).map(publicCandidate),
    recoverableCount: Number(value.recoverableCount) || 0,
    distinctSaveCount: Number(value.distinctSaveCount) || 0,
    automaticCandidateId: value.automaticCandidateId || null
  };
}

function requestFile(workspaceRoot, path) {
  const root = path.resolve(String(workspaceRoot || ''));
  return path.join(path.dirname(root), path.basename(root) + '.recovery-request.json');
}

function lastResultFile(workspaceRoot, path) {
  const root = path.resolve(String(workspaceRoot || ''));
  return path.join(path.dirname(root), path.basename(root) + '.recovery-last.json');
}

function writeJsonAtomic(file, value, fs, path, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid + '-' + now() + '-' + (++atomicSequence);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (_) {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}

function requestRecovery(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const inspection = o.inspection || inspectCandidates(o);
  const candidate = (inspection.candidates || []).find(row => row.id === String(o.candidateId || '') && row.recoverable);
  if (!candidate) throw new Error('selected recovery candidate is unavailable or invalid');
  const file = requestFile(o.workspaceRoot, path);
  if (fs.existsSync(file)) throw new Error('a station recovery request is already pending');
  writeJsonAtomic(file, {
    version: REQUEST_VERSION,
    candidateId: candidate.id,
    expectedSaveSha256: candidate.saveSha256,
    requestedAt: now()
  }, fs, path, now);
  return { ok: true, candidateId: candidate.id, restartRequired: true };
}

function skipped(rel) {
  const normalized = slash(rel);
  const top = normalized.split('/')[0].toLowerCase();
  const name = normalized.split('/').pop().toLowerCase();
  return SKIP_TOP.has(top) || SKIP_FILES.has(name) || /\.tmp(?:\.|$)/i.test(name);
}

function inventory(root, deps) {
  const d = deps || {}, fs = d.fs || fsNative, path = d.path || pathNative;
  const maxFileBytes = Number(d.maxFileBytes) > 0 ? Number(d.maxFileBytes) : MAX_RECOVERY_FILE_BYTES;
  const maxTotalBytes = Number(d.maxTotalBytes) > 0 ? Number(d.maxTotalBytes) : MAX_RECOVERY_TOTAL_BYTES;
  const rows = [];
  let totalBytes = 0;
  function visit(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const childRel = slash(rel ? rel + '/' + name : name);
      if (skipped(childRel)) continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) visit(file, childRel);
      else if (stat.isFile()) {
        // Size guard BEFORE the full-buffer read: fail closed instead of OOMing on a pathological source.
        const size = Number(stat.size) || 0;
        if (size > maxFileBytes) {
          throw new Error('recovery source file too large to buffer safely: ' + childRel +
            ' (' + size + ' bytes exceeds the ' + maxFileBytes + '-byte per-file limit)');
        }
        totalBytes += size;
        if (totalBytes > maxTotalBytes) {
          throw new Error('recovery source too large to buffer safely: aggregate exceeds the ' +
            maxTotalBytes + '-byte limit at ' + childRel);
        }
        const raw = fs.readFileSync(file);
        rows.push({ path: childRel, bytes: raw.length, sha256: sha256(raw) });
      }
    }
  }
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) visit(root, '');
  return rows;
}

function copyVerified(source, stage, deps) {
  const d = deps || {}, fs = d.fs || fsNative, path = d.path || pathNative;
  const expected = inventory(source, { fs, path, maxFileBytes: d.maxFileBytes, maxTotalBytes: d.maxTotalBytes });
  fs.mkdirSync(stage, { recursive: false });
  for (const row of expected) {
    const src = path.resolve(source, ...row.path.split('/'));
    const dest = path.resolve(stage, ...row.path.split('/'));
    if (!dest.startsWith(stage + path.sep)) throw new Error('unsafe recovery path: ' + row.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const raw = fs.readFileSync(src);
    fs.writeFileSync(dest, raw);
    const back = fs.readFileSync(dest);
    if (back.length !== row.bytes || sha256(back) !== row.sha256) throw new Error('recovery read-back mismatch: ' + row.path);
  }
  const actual = inventory(stage, { fs, path, maxFileBytes: d.maxFileBytes, maxTotalBytes: d.maxTotalBytes });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('recovery stage inventory differs from its source');
  return actual;
}

function readLastResult(workspaceRoot, deps) {
  const d = deps || {}, fs = d.fs || fsNative, path = d.path || pathNative;
  try { return JSON.parse(fs.readFileSync(lastResultFile(workspaceRoot, path), 'utf8')); } catch (_) { return null; }
}

/* scratchTargetReason — AUTO recovery must never heal INTO a scratch workspace (2026-08-19/20 incident).
   Automatic recovery scans the REAL per-user app-data roots for a stranded station, and a fresh temp
   workspace looks exactly like a lost one — so every ad-hoc test sidecar (mkdtemp under os.tmpdir())
   silently copied the Commander's production station into its throwaway workspace the day v0.10.6 was
   installed locally. Rule: when the TARGET workspace root resolves under os.tmpdir() or under any
   env-declared scratch root (STARNET_SCRATCH_ROOT / SKYNET_SCRATCH_ROOT, path-delimiter separated),
   the auto branch is skipped with a reason. Explicit operator-driven recovery (a written request file,
   the CLI, disaster-recovery restore) is untouched: it never consults this. Returns null when the
   target is not scratch. */
function scratchRoots(o) {
  const path = o.path || pathNative;
  if (Array.isArray(o.scratchRoots)) return o.scratchRoots.map(r => path.resolve(String(r || '')));   // explicit override (tests stand in a fake "real" home)
  const env = o.env || process.env;
  const out = [];
  try { const t = typeof o.tmpdir === 'function' ? o.tmpdir() : osNative.tmpdir(); if (t) out.push(path.resolve(String(t))); } catch (_) {}
  for (const k of ['STARNET_SCRATCH_ROOT', 'SKYNET_SCRATCH_ROOT']) {
    const v = env && env[k];
    if (!v) continue;
    for (const part of String(v).split(path.delimiter)) { if (part.trim()) out.push(path.resolve(part.trim())); }
  }
  return out;
}
function underRoot(target, root, path, platform) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}
function scratchTargetReason(o) {
  const path = o.path || pathNative, platform = String(o.platform || process.platform);
  const target = path.resolve(String(o.workspaceRoot || ''));
  const norm = p => (platform === 'win32' ? String(p).toLowerCase() : String(p));
  for (const root of scratchRoots(o)) {
    if (underRoot(norm(target), norm(root), path, platform)) return { root, code: 'AUTO_RECOVERY_TARGET_IS_SCRATCH' };
  }
  return null;
}

function recoveryLockFile(workspaceRoot, path) {
  const root = path.resolve(String(workspaceRoot || ''));
  return path.join(path.dirname(root), path.basename(root) + '.recovery.lock');
}

/* applyPendingRecovery — the ONLY mutation entry point. Recovery renames the ACTIVE workspace root
   (current -> rollback, stage -> current), and it runs BEFORE the one-sidecar owner claim, so two
   simultaneous boots could race the rename (the existsSync checks on the stage/rollback names are
   TOCTOU, not mutual exclusion). The whole inspect->copy->rename window is therefore serialized behind
   a cross-process advisory lock at the PARENT level (a sibling of the workspace root — the lock cannot
   live inside a directory that recovery renames). A boot that cannot acquire it FAILS CLOSED: no
   mutation, a distinguishable { lockUnavailable: true } result, and the composition root decides
   whether to exit (index.js matches the owner-claim refusal semantics). A stale lock from a crashed
   holder is broken only when its pid is PROVEN dead. Recovery has no safe wall-clock ceiling, so
   unlike cron it never reclaims a lock merely because the mtime is old. */
function applyPendingRecovery(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const current = path.resolve(String(o.workspaceRoot || ''));
  const lockfile = recoveryLockFile(current, path);
  // A fresh install may not have the workspace parent yet; the lockfile needs it to exist.
  try { fs.mkdirSync(path.dirname(lockfile), { recursive: true }); } catch (_) {}
  const lock = makeCronLock({
    fs, path, lockfile, now,
    maxRunMs: Number(o.lockMaxRunMs) > 0 ? Number(o.lockMaxRunMs) : RECOVERY_LOCK_MAX_RUN_MS,
    pid: o.lockPid, nonce: o.lockNonce, pidAlive: o.lockPidAlive,
    // bootedAt (opt-in, injected by index.js): with reclaimByAge:false the pid probe was the ONLY way this
    // lock ever broke — after a crash + reboot the stamped pid usually belongs to some unrelated live
    // process, so the lock read BUSY FOREVER and every boot exited 73 (the DEAD-END SCREENS pid-reuse law,
    // already fixed in workspace-owner.js). A lockfile written before the current OS boot cannot have a
    // live holder; cron-lock reclaims it.
    bootedAt: o.lockBootedAt,
    reclaimByAge: false
  });
  // Recovery precedes workspace ownership and can replace the whole directory.
  // Elect outside that directory so its legacy advisory lock cannot be stolen
  // by a delayed stale reclaimer while another process is copying/activating.
  const election = makeWorkspaceOwner({ fs, path, now, pid: o.lockPid,
    nonce: o.lockNonce, pidAlive: o.lockPidAlive, bootedAt: o.lockBootedAt,
    filename: path.basename(current) + '.recovery-owner.json' });
  const elected = election.acquire(path.dirname(current));
  let attempt = { ran: false };
  if (elected.ok) {
    try { attempt = lock.withLock(function () { return applyPendingRecoveryLocked(o); }); }
    finally { election.release(); }
  }
  if (!attempt.ran) {
    return {
      ok: false, applied: false, lockUnavailable: true, code: 'RECOVERY_LOCK_UNAVAILABLE',
      error: 'another StarNet process holds the workspace recovery lock'
    };
  }
  return attempt.result;
}

// The pre-existing recovery body, now only ever entered while holding the recovery lock above.
function applyPendingRecoveryLocked(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const current = path.resolve(String(o.workspaceRoot || ''));
  const requestPath = requestFile(current, path);
  if (!fs.existsSync(requestPath)) {
    if (o.auto === true) {
      const scratch = scratchTargetReason(o);
      if (scratch) {
        // Loud by contract: the skip is a data-safety decision a diagnostics reader must be able to see.
        try { console.warn('[recovery] auto station recovery SKIPPED: target workspace is a scratch root (' + current + ' is under ' + scratch.root + '); a real station is never ingested into a temp workspace. Explicit recovery (request file / CLI restore) is unaffected.'); } catch (_) {}
        return { applied: false, pending: false, autoSkipped: true, code: scratch.code, scratchRoot: scratch.root };
      }
      const active = readRootCandidate(current, { fs, path });
      const inspection = inspectCandidates(o);
      if ((!active || !active.recoverable) && inspection.recoverableCount === 1 && inspection.automaticCandidateId) {
        requestRecovery(Object.assign({}, o, { inspection, candidateId: inspection.automaticCandidateId }));
        return applyPendingRecoveryLocked(Object.assign({}, o, { auto: false }));   // stay inside the held lock
      }
    }
    return { applied: false, pending: false };
  }
  let request;
  try { request = JSON.parse(fs.readFileSync(requestPath, 'utf8')); }
  catch (error) { request = null; }
  const fail = error => {
    const stamp = cleanStamp(now);
    const failed = requestPath + '.failed-' + stamp;
    try { fs.renameSync(requestPath, failed); } catch (_) {}
    const result = { version: 1, ok: false, applied: false, at: now(), error: String(error && error.message || error) };
    try { writeJsonAtomic(lastResultFile(current, path), result, fs, path, now); } catch (_) {}
    return result;
  };
  try {
    if (!request || request.version !== REQUEST_VERSION || !/^[a-f0-9]{24}$/.test(String(request.candidateId || ''))) {
      throw new Error('invalid station recovery request');
    }
    const active = readRootCandidate(current, { fs, path });
    if (active && active.recoverable) {
      try { fs.unlinkSync(requestPath); } catch (_) {}
      return { ok: true, applied: false, alreadyRecovered: true };
    }
    const inspection = inspectCandidates(o);
    const selected = inspection.candidates.find(row => row.id === request.candidateId && row.recoverable);
    if (!selected || selected.saveSha256 !== request.expectedSaveSha256) throw new Error('selected recovery source changed before activation');
    const stamp = cleanStamp(now);
    const stage = current + '.recovery-stage-' + stamp;
    const rollback = current + '.recovery-rollback-' + stamp;
    if (fs.existsSync(stage) || fs.existsSync(rollback)) throw new Error('recovery stage or rollback name already exists');
    const files = copyVerified(selected.sourceRoot, stage, { fs, path, maxFileBytes: o.maxFileBytes, maxTotalBytes: o.maxTotalBytes });
    writeJsonAtomic(path.join(stage, '.migration-receipt.json'), {
      version: 1, validated: true, sourceRoots: [selected.sourceRoot], files
    }, fs, path, now);
    fs.writeFileSync(path.join(stage, '.migrated'), '1');
    let moved = false;
    try {
      if (fs.existsSync(current)) { fs.renameSync(current, rollback); moved = true; }
      fs.renameSync(stage, current);
    } catch (error) {
      try { if (moved && !fs.existsSync(current) && fs.existsSync(rollback)) fs.renameSync(rollback, current); } catch (_) {}
      throw error;
    }
    fs.unlinkSync(requestPath);
    const result = {
      version: 1, ok: true, applied: true, at: now(), candidateId: selected.id,
      stationName: selected.stationName, restoredFiles: files.length,
      rollbackRetained: moved, sourcePreserved: fs.existsSync(selected.sourceRoot)
    };
    writeJsonAtomic(lastResultFile(current, path), result, fs, path, now);
    return result;
  } catch (error) { return fail(error); }
}

function recoveryReport(opts) {
  const o = opts || {}, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const inspection = o.inspection || inspectCandidates(o);
  const platform = String(o.platform || process.platform);
  const lastRecovery = readLastResult(o.workspaceRoot, o);
  if (lastRecovery && typeof lastRecovery.error === 'string') {
    for (const root of uniqueRoots([o.workspaceRoot].concat(o.candidateRoots || []).concat(o.home || []), path, platform)
      .sort((a, b) => b.length - a.length)) {
      lastRecovery.error = lastRecovery.error.split(root).join(displayPath(root, o.home, path, platform));
    }
  }
  return {
    schema: 'starnet.workspace-recovery-report',
    version: 1,
    generatedAt: new Date(now()).toISOString(),
    platform,
    architecture: String(o.arch || process.arch),
    currentWorkspace: displayPath(o.workspaceRoot, o.home, path, platform),
    lineage: o.publicLineage || null,
    recovery: publicInspection(inspection),
    lastRecovery
  };
}

module.exports = {
  inspectCandidates, publicInspection, requestRecovery, applyPendingRecovery, recoveryReport, readRootCandidate,
  scratchTargetReason,
  _internals: { decodeSave, displayPath, inventory, requestFile, lastResultFile, copyVerified, sha256, recoveryLockFile }
};
