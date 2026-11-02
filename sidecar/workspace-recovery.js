/* sidecar/workspace-recovery.js — discover and activate stranded local station roots safely.

   Recovery is deliberately two-phase. The authenticated UI writes one opaque candidate request, then the
   sidecar exits. The next sidecar boot applies that request BEFORE the workspace owner/store graph opens:
   source -> sibling stage -> hash read-back -> retain current as rollback -> atomic activation. The source
   root is never mutated, and an ambiguous set is never selected without the Commander's explicit click.

   START FRESH from the gate is the same two phases, and shares the activation. Its request pins what the Commander saw
   (workspace-lineage.js requestFresh), and the next boot, in this same locked pre-claim phase, sets the WHOLE generation
   aside, one rename into workspace-quarantine, in place of a clean stage: SEAL, the station record, the legacy mirror and
   the carry rule's files, exactly what the desktop shell's fresh_start.rs leaves. Inside the running sidecar the old
   generation cannot be renamed: its own stores, children and station browser hold it open. A request the workspace has
   since moved on from is refused and kept as .failed-<stamp>, and the result ({ kind: 'fresh' } in the same last-result
   file) reaches the gate as lineage.lastFresh. */
'use strict';

const crypto = require('node:crypto');
const fsNative = require('node:fs');
const osNative = require('node:os');
const pathNative = require('node:path');
const { makeCronLock } = require('./cron-lock.js');   // O_EXCL + pid:nonce + stale-break advisory lock (G4.3 primitive)
const { makeWorkspaceOwner } = require('./workspace-owner.js');
const { note: failNote } = require('./failopen.js');
// The station lifecycle's one module: the reset and erase authority automatic recovery honors, the one path rule, the
// lifecycle files that never travel with a recovered station, and the record a restored generation starts with.
const stationRecord = require('./station-record.js');
const samePath = stationRecord.sameRoot;

const REQUEST_VERSION = 1;
const FRESH_REQUEST_VERSION = 1;
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
// The workspace's own lifecycle files (its station record and legacy reset marker) never travel with a recovered station:
// a copied marker used to replace the live generation's erase choice (gh#101). The restored stage gets its own record.
const SKIP_TOP = new Set(['.browser-profile', '.starnet-workspace-owner.json.generations'].concat(stationRecord.LIFECYCLE_FILES));
const SKIP_FILES = new Set([
  '.starnet-workspace-owner.json', 'cron.lock', 'proc-ledger.json',
  '.migration-pending', '.migration-receipt.json', '.migrated'
]);
let atomicSequence = 0;

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function slash(value) { return String(value || '').replace(/\\/g, '/').replace(/^\.\//, ''); }
function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function cleanStamp(now) { return new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 17); }

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

function freshRequestFile(workspaceRoot, path) {
  const root = path.resolve(String(workspaceRoot || ''));
  return path.join(path.dirname(root), path.basename(root) + '.fresh-request.json');
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
  if (fs.existsSync(freshRequestFile(o.workspaceRoot, path))) throw new Error('a START FRESH request is already pending');
  writeJsonAtomic(file, {
    version: REQUEST_VERSION,
    candidateId: candidate.id,
    expectedSaveSha256: candidate.saveSha256,
    requestedAt: now()
  }, fs, path, now);
  return { ok: true, candidateId: candidate.id, restartRequired: true };
}

// The pending START FRESH: the facts it pinned (stationRecord.freshFacts), the build that took it, and the external roots
// the Commander saw as evidence and chose past. A pending recovery wins, and the two never queue up.
function writeFreshRequest(opts) {
  const o = opts || {}, fs = o.fs || fsNative, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const file = freshRequestFile(o.workspaceRoot, path);
  if (fs.existsSync(file)) throw new Error('a START FRESH request is already pending');
  if (fs.existsSync(requestFile(o.workspaceRoot, path))) throw new Error('a station recovery request is already pending');
  const request = Object.assign({ version: FRESH_REQUEST_VERSION }, o.facts, {
    fromVersion: String(o.fromVersion || ''),
    acknowledgedRoots: Array.isArray(o.acknowledgedRoots) ? o.acknowledgedRoots.slice() : [],
    requestedAt: now()
  });
  writeJsonAtomic(file, request, fs, path, now);
  return request;
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

/* #101: a reset's clean generation is intentional, not a missing station. Only automatic recovery
   consults this choice; explicit recovery still shows every candidate and preserves the clean generation
   in rollback. The choice is the station record's (station-record.js reads both doors' reset markers with its
   one parser): an erase authority blocks all automatic imports, START FRESH (and an earlier recovery) acknowledge
   specific old roots only, and a record or reset choice that cannot be read safely never authorizes an automatic
   replacement. */
const AUTO_RECOVERY_BLOCKS = {
  'record-unreadable': { code: 'AUTO_RECOVERY_RECORD_UNREADABLE',
    reason: 'the station record could not be read safely; automatic recovery preserved this workspace. Explicit recovery remains available.' },
  'erase-authority': { code: 'AUTO_RECOVERY_ERASED',
    reason: 'ERASE EVERYTHING selected this clean generation; no prior station was imported. Explicit recovery remains available.' },
  'reset-unreadable': { code: 'AUTO_RECOVERY_FRESH_MARKER_UNREADABLE',
    reason: 'the fresh-start choice could not be read safely; automatic recovery preserved this workspace. Explicit recovery remains available.' }
};
function automaticRecoveryPolicy(o) {
  const fs = o.fs || fsNative, path = o.path || pathNative;
  const platform = String(o.platform || process.platform);
  const record = stationRecord.read({ fs, path, platform, now: typeof o.now === 'function' ? o.now : function () { return 0; }, workspaceRoot: o.workspaceRoot });
  const block = AUTO_RECOVERY_BLOCKS[record.autoImportBlock()];
  if (block) return { code: block.code, reason: block.reason };
  const roots = uniqueRoots(o.candidateRoots, path, platform);
  const candidateRoots = roots.filter(root => !record.acknowledges(root));
  if (roots.length && !candidateRoots.length) return { code: 'AUTO_RECOVERY_ACKNOWLEDGED',
    reason: 'START FRESH or an earlier recovery already accounted for these prior roots; no prior station was imported. Explicit recovery remains available.' };
  return { candidateRoots };
}

function recoveryLockFile(workspaceRoot, path) {
  const root = path.resolve(String(workspaceRoot || ''));
  return path.join(path.dirname(root), path.basename(root) + '.recovery.lock');
}

/* THE ONE ACTIVATION, shared by explicit recovery and START FRESH: the live generation moves to `aside` and the stage takes
   its place, both renames on one volume. A failed move changes nothing. A failed activation puts the live generation back;
   if even that fails the error says where the generation is. Returns whether a generation was moved aside. */
function activateGeneration(fs, current, stage, aside) {
  let moved = false;
  try {
    if (fs.existsSync(current)) { fs.renameSync(current, aside); moved = true; }
    fs.renameSync(stage, current);
  } catch (error) {
    if (moved) {
      try { if (!fs.existsSync(current) && fs.existsSync(aside)) fs.renameSync(aside, current); }
      catch (rollback) {
        error.message = String(error.message) + '; rollback also failed (' + String(rollback && rollback.message || rollback) + '); the station is preserved at ' + aside;
        error.stranded = true;
      }
    }
    throw error;
  }
  return moved;
}

// A request that did not run: kept beside the workspace as .failed-<stamp>, and the result is what the Commander reads.
function failRequest(fs, path, now, current, requestPath, fields) {
  try { fs.renameSync(requestPath, requestPath + '.failed-' + cleanStamp(now)); } catch (_) {}
  const result = Object.assign({ version: 1, ok: false, applied: false, at: now() }, fields);
  try { writeJsonAtomic(lastResultFile(current, path), result, fs, path, now); } catch (_) {}
  return result;
}

/* A request the workspace has moved on from never sets it aside. Each row is a state the Commander did not choose past, the
   most specific reason first: an older build's reset and a save that came back each move the record too. */
function staleFreshRequest(request, facts, buildVersion) {
  const again = ' Nothing was moved. Press START FRESH again if you still want a new station.';
  if (String(request.fromVersion || '') !== String(buildVersion || '')) return { code: 'FRESH_REQUEST_BUILD_CHANGED',
    error: 'StarNet changed version after START FRESH was requested (' + String(request.fromVersion || 'unknown') + ' to ' + String(buildVersion || 'unknown') + ').' + again };
  if (facts.markerAt !== (request.markerAt === undefined ? null : request.markerAt)) return { code: 'FRESH_REQUEST_MARKER_CHANGED',
    error: 'this workspace was reset again after START FRESH was requested.' + again };
  const changed = Array.from(new Set(Object.keys(request.pinned).concat(Object.keys(facts.pinned)))).filter(name => request.pinned[name] !== facts.pinned[name]).sort();
  if (changed.length) return { code: 'FRESH_REQUEST_STATION_FILES_CHANGED', files: changed.slice(0, 8),
    error: 'a save or roster file changed after START FRESH was requested (' + changed.slice(0, 4).join(', ') + ').' + again };
  if (facts.expectedState !== request.expectedState || facts.expectedGenerationId !== request.expectedGenerationId) return { code: 'FRESH_REQUEST_GENERATION_CHANGED',
    error: 'this workspace\'s station changed after START FRESH was requested.' + again };
  return null;
}

// On Windows ANY open handle under a directory refuses its rename (EPERM, EBUSY), and the error names no holder. The station
// browser is the one holder this machine can name without a process listing: its profile lives in the generation, and a
// running Chromium keeps the profile's lock file open.
function freshHolder(fs, path, platform, current) {
  try {
    const held = require('./tools/builtin/browser-orphans.js').profileHeld(path.join(current, '.browser-profile'), { fs, platform });
    return held.held ? 'the station browser (' + held.how + ')' : null;
  } catch (error) { failNote('lineage.fresh.holder', error); return null; }
}
function freshFailure(fs, path, platform, current, error) {
  const code = String(error && error.code || ''), inUse = /^(?:EBUSY|EPERM|EACCES)$/.test(code);
  const stranded = !!(error && error.stranded);   // its message already says where the station is, and something did move
  const holder = inUse ? freshHolder(fs, path, platform, current) : null;
  const what = inUse && !stranded ? 'this workspace could not be set aside (' + code + '): a program may still have a file in it open.' : String(error && error.message || error);
  const next = inUse ? ' Close what is using it, then press START FRESH again.' : ' Press START FRESH again once that is fixed.';
  const fields = { code: 'FRESH_ACTIVATION_FAILED', error: stranded ? what : what + ' Nothing was moved.' + next };
  return holder ? Object.assign(fields, { holder }) : fields;
}

/* THE FRESH APPLY. Runs under applyPendingRecovery's lock, before the owner claim and every store. Every set-aside is a rename
   into workspace-quarantine, never a delete: a failed rename changes nothing, and the result says why. */
function applyFreshRequest(o) {
  const fs = o.fs || fsNative, path = o.path || pathNative, platform = String(o.platform || process.platform);
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const current = path.resolve(String(o.workspaceRoot || ''));
  const requestPath = freshRequestFile(current, path);
  // the same refusal the native door makes: a generation with a live owner is never renamed under it. The request stays
  // pending, and this boot's own owner claim refuses in the usual way.
  if (fs.existsSync(current)) {
    const owner = makeWorkspaceOwner({ fs, path, now, pid: o.lockPid, nonce: o.lockNonce, pidAlive: o.lockPidAlive, bootedAt: o.lockBootedAt, processIdentity: o.lockProcessIdentity });
    if (!owner.acquire(current).ok) return { kind: 'fresh', applied: false, pending: true, code: 'FRESH_WORKSPACE_BUSY' };
    owner.release();
  }
  const refuse = fields => failRequest(fs, path, now, current, requestPath, Object.assign({ kind: 'fresh' }, fields));
  let request = null;
  try { request = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch (_) { request = null; }
  if (!isObj(request) || request.version !== FRESH_REQUEST_VERSION || !isObj(request.pinned)) {
    return refuse({ code: 'FRESH_REQUEST_INVALID', error: 'the START FRESH request could not be read. Nothing was moved.' });
  }
  const recordDeps = { fs, path, platform, now, workspaceRoot: current };
  let stage = null;
  try {
    const stale = staleFreshRequest(request, stationRecord.freshFacts(recordDeps), o.buildVersion);
    if (stale) return refuse(stale);
    const stamp = cleanStamp(now);
    const home = path.join(path.dirname(current), stationRecord.QUARANTINE_DIR);
    let aside = path.join(home, 'station-' + stamp);
    for (let n = 1; fs.existsSync(aside); n++) aside = path.join(home, 'station-' + stamp + '-' + n);
    const hadGeneration = fs.existsSync(current);
    const record = stationRecord.freshRecord(recordDeps, stationRecord.read(recordDeps).record, {
      acknowledgedRoots: request.acknowledgedRoots, setAside: hadGeneration ? aside : null
    });
    stage = current + '.fresh-stage-' + stamp;
    if (fs.existsSync(stage)) { const taken = stage; stage = null; throw new Error('a fresh stage already exists at ' + taken); }
    fs.mkdirSync(stage, { recursive: false });
    for (const name of stationRecord.SEAL) fs.writeFileSync(path.join(stage, name), '1');
    // the mirror keeps every older build honest, in the native door's marker shape; the record is this build's
    stationRecord.writeMirror(recordDeps, stage, record, { quarantine: record.setAside, moved: [] });
    stationRecord.writeRecord(recordDeps, stage, record);
    const carry = stationRecord.carryInto(recordDeps, current, stage);
    fs.mkdirSync(home, { recursive: true });
    const moved = activateGeneration(fs, current, stage, aside);
    const result = {
      version: 1, kind: 'fresh', ok: true, applied: true, at: record.reset.at, quarantine: moved ? aside : null,
      creditsLeftAside: carry.leftAside.length > 0
    };
    // past this line the clean generation is live: neither of these can un-happen it
    try { fs.unlinkSync(requestPath); } catch (error) { failNote('lineage.fresh.request', error); }
    try { writeJsonAtomic(lastResultFile(current, path), result, fs, path, now); } catch (error) { failNote('lineage.fresh.result', error); }
    return result;
  } catch (error) {
    if (stage && typeof fs.rmSync === 'function') {
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) { failNote('lineage.fresh.stage', e); }
    }
    return refuse(freshFailure(fs, path, platform, current, error));
  }
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
    // lockProcessIdentity (opt-in, injected by index.js; soak 2026-10-15): within one boot a hard-killed holder's
    // PID can be handed to an unrelated process, which kill(0) reads as alive. The identity check proves such a
    // PID recycled (sidecar/process-identity.js); an unreadable identity keeps the lock respected.
    processIdentity: o.lockProcessIdentity,
    reclaimByAge: false
  });
  // Recovery precedes workspace ownership and can replace the whole directory.
  // Elect outside that directory so its legacy advisory lock cannot be stolen
  // by a delayed stale reclaimer while another process is copying/activating.
  const election = makeWorkspaceOwner({ fs, path, now, pid: o.lockPid,
    nonce: o.lockNonce, pidAlive: o.lockPidAlive, bootedAt: o.lockBootedAt, processIdentity: o.lockProcessIdentity,
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
    if (fs.existsSync(freshRequestFile(current, path))) return applyFreshRequest(o);
    if (o.auto === true) {
      const scratch = scratchTargetReason(o);
      if (scratch) {
        // Loud by contract: the skip is a data-safety decision a diagnostics reader must be able to see.
        try { console.warn('[recovery] auto station recovery SKIPPED: target workspace is a scratch root (' + current + ' is under ' + scratch.root + '); a real station is never ingested into a temp workspace. Explicit recovery (request file / CLI restore) is unaffected.'); } catch (_) {}
        return { applied: false, pending: false, autoSkipped: true, code: scratch.code, scratchRoot: scratch.root };
      }
      const policy = automaticRecoveryPolicy(o);
      if (policy.code) {
        console.warn('[recovery] auto station recovery SKIPPED (' + policy.code + '): ' + policy.reason);
        return { applied: false, pending: false, autoSkipped: true, code: policy.code, reason: policy.reason };
      }
      const active = readRootCandidate(current, { fs, path });
      const inspection = inspectCandidates(Object.assign({}, o, { candidateRoots: policy.candidateRoots }));
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
  const fail = error => failRequest(fs, path, now, current, requestPath, { error: String(error && error.message || error) });
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
    // the restored generation's own station record: active, its reset cleared (the recovered station predates any reset
    // here), the replaced generation's erase authority kept, and every root this recovery chose among acknowledged, so
    // a root the Commander did not pick never becomes the one automatic candidate if this station's save is lost later
    const recordDeps = { fs, path, platform: String(o.platform || process.platform), now, workspaceRoot: current };
    stationRecord.writeRecord(recordDeps, stage, stationRecord.recoveryRecord(recordDeps, stationRecord.read(recordDeps).record, {
      sourceRoot: selected.sourceRoot, acknowledgedRoots: inspection.candidates.map(row => row.sourceRoot),
      setAside: fs.existsSync(current) ? rollback : null
    }));
    const moved = activateGeneration(fs, current, stage, rollback);
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

// The last result as a reader may see it: no absolute local path survives, in the error text or in the quarantine it names.
function publicLastResult(o) {
  const path = o.path || pathNative, platform = String(o.platform || process.platform);
  const last = readLastResult(o.workspaceRoot, o);
  if (!last) return last;
  const roots = uniqueRoots([o.workspaceRoot, path.dirname(path.resolve(String(o.workspaceRoot || '')))].concat(o.candidateRoots || []).concat(o.home || []), path, platform)
    .sort((a, b) => b.length - a.length);
  if (typeof last.error === 'string') {
    for (const root of roots) last.error = last.error.split(root).join(displayPath(root, o.home, path, platform));
  }
  if (typeof last.quarantine === 'string') last.quarantine = displayPath(last.quarantine, o.home, path, platform);
  return last;
}

// the last START FRESH apply, for lineage.lastFresh: the gate's visible exit when a request did not run
function lastFreshResult(opts) {
  const last = publicLastResult(opts || {});
  return last && last.kind === 'fresh' ? last : null;
}

function recoveryReport(opts) {
  const o = opts || {}, path = o.path || pathNative;
  const now = typeof o.now === 'function' ? o.now : function () { return 0; };
  const inspection = o.inspection || inspectCandidates(o);
  const platform = String(o.platform || process.platform);
  const lastRecovery = publicLastResult(o);
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
  inspectCandidates, publicInspection, requestRecovery, writeFreshRequest, applyPendingRecovery, recoveryReport, lastFreshResult, readRootCandidate,
  scratchTargetReason,
  _internals: { decodeSave, displayPath, inventory, requestFile, freshRequestFile, lastResultFile, copyVerified, sha256, recoveryLockFile }
};
