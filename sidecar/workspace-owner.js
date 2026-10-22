/* sidecar/workspace-owner.js — fail-closed, process-wide ownership for one WORKSPACES root.

   Agent OS's durable stores are intentionally single-writer. Atomic individual-file writes prevent torn
   files, but they cannot prevent two sidecars from loading the same snapshot and then overwriting each
   other's later changes. This owner claim makes the existing "one sidecar per WORKSPACES" invariant real.

   There is deliberately NO time-based stale break. A healthy sidecar may run for weeks; age is not proof
   that its claim is abandoned. We reclaim when process.kill(pid, 0) proves the stamped PID is gone, OR when
   the claim was stamped BEFORE the current OS boot (no process survives a reboot, so the holder is provably
   dead no matter who owns that PID now). That second rule exists because of a real dead-end: PIDs restart at
   boot, so after a crash + reboot the stamped PID almost always belongs to some unrelated live process and
   the kill(0) probe alone reported "busy" forever — every sidecar spawn exited before listening and the
   desktop sat on STATION DATA UNREACHABLE with no way out (2026-08-22 macOS report). A malformed lock (a
   crash mid-write leaves an empty/torn file) is reclaimable by the same rule when its mtime predates boot.

   PID REUSE WITHIN ONE BOOT (soak 2026-10-15). kill(0) alone also wedged a same-boot crash: hard-killed holder
   43136 stamped 08:30:50Z, Windows gave its PID to cmd.exe at 09:01:52Z, and every boot after that exited 73
   WORKSPACE_BUSY until the crash-loop breaker parked the station degraded. With an injected processIdentity
   (sidecar/process-identity.js; the host passes it, the factory default stays inert like bootedAt), a live
   stamped PID is probed for the OS's record of its CURRENT process and judged by judgeReuse (process-identity.js): a
   process CREATED more than REUSE_SLACK_MS (60s) after the claim was stamped cannot be the process that
   stamped it (a holder always exists before it writes its claim). A start between REUSE_EXE_SLACK_MS (2s) and
   the slack counts only when the executable differs too. On Linux the holder stamps its exact /proc start
   ticks and the probe compares them for equality. A Windows process whose StartTime Get-Process withholds
   (System, services, other users, elevated) is read from Win32_Process with a DST-sized tolerance: its time
   proves reuse only past slack + tolerance, its different image name proves it unless the reading places it
   before the stamp. An unreadable identity, an older start, or a start inside the slack stays BUSY:
   uncertainty is a safe false-busy, never a second writer. The slack absorbs clock adjustment between a
   holder's creation and its stamp. The residual false-reclaim needs the wall clock stepped BACKWARD by more
   than the slack (plus the tolerance, for an approximate same-image reading) inside the second or two between
   a holder's creation and its own stamp, the same clock-step class the boot rule above already accepts over a
   far longer window. The workspace-recovery election (workspace-recovery.js) passes the same identity.

   Immutable, atomically published generation tickets serialize claims and crash recovery.
   The compatibility claim retains O_EXCL creation and read-back verification; only the elected
   holder may replace it. Release publishes its marker after the last primary-file operation. */
'use strict';
const { note: failNote } = require('./failopen.js');
const { judgeReuse } = require('./process-identity.js');

function defaultNonce() {
  try { return require('node:crypto').randomBytes(16).toString('hex'); }
  catch (_) { try { return require('crypto').randomBytes(16).toString('hex'); } catch (__) { return 'unavailable'; } }
}

function defaultPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return true; // malformed/unprovable is busy, never reclaimable
  if (typeof process === 'undefined' || typeof process.kill !== 'function') return true;
  if (n === process.pid) return true;
  try { process.kill(n, 0); return true; }
  catch (e) {
    // Only ESRCH proves absence. Permission, resource and unsupported-probe errors
    // leave ownership unknown and must never authorize another writer.
    return !(e && e.code === 'ESRCH');
  }
}

// bootedAt from an injected wall clock (determinism law: no Date.now inside sidecar modules).
function makeBootedAt(now) {
  return function () {
    try {
      const os = require('node:os');
      const up = Number(os.uptime());
      const t = Number(typeof now === 'function' ? now() : 0);
      if (!(up > 0) || !(t > 0)) return 0;
      return t - up * 1000;
    } catch (_) { return 0; }
  };
}

function makeWorkspaceOwner(deps) {
  const d = deps || {};
  const fs = d.fs;
  const path = d.path;
  const pid = d.pid != null ? Number(d.pid) : ((typeof process !== 'undefined' && process.pid) || 0);
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };
  const nonce = typeof d.nonce === 'function' ? d.nonce : defaultNonce;
  const pidAlive = typeof d.pidAlive === 'function' ? d.pidAlive : defaultPidAlive;
  // bootedAt: wall-clock ms of the current OS boot. OPT-IN (host passes defaultBootedAt): the factory default
  // is inert (0) so an injected fake clock in tests is never compared against the real machine's boot time.
  // A 60s slack absorbs clock skew between os.uptime() and the stamp so a holder that started seconds after
  // boot is never misjudged as pre-boot.
  const bootedAt = typeof d.bootedAt === 'function' ? d.bootedAt : function () { return 0; };
  const BOOT_SLACK_MS = 60 * 1000;
  function predatesBoot(ms) {
    const b = Number(bootedAt()) || 0;
    const t = Number(ms) || 0;
    return b > 0 && t > 0 && t < (b - BOOT_SLACK_MS);
  }
  function lockMtime(lockfile) {
    try { return Number(fs.statSync(lockfile).mtimeMs) || 0; } catch (_) { return 0; }
  }
  // processIdentity: { probe(pid), self() } from sidecar/process-identity.js. OPT-IN exactly like bootedAt: the
  // factory default is inert, so a test's fake clock is never compared with a real process's creation time.
  const identity = d.processIdentity && typeof d.processIdentity.probe === 'function' ? d.processIdentity : null;
  let probed = null;   // pid -> probe result, scoped to one acquire() so a holder is probed at most once per boot
  let lastIdentity = null;
  function ownExecutable() {
    return (typeof process !== 'undefined' && process.execPath) ? String(process.execPath) : '';
  }
  function identityStamp() {
    if (!identity || typeof identity.self !== 'function') return {};
    const own = identity.self();
    return own && typeof own.startTicks === 'string' && /^\d+$/.test(own.startTicks) ? { startTicks: own.startTicks } : {};
  }
  // The stamped PID is alive. Is its CURRENT process the one that wrote the claim? true only on proof of reuse
  // (judgeReuse in process-identity.js holds the rule, shared with the workspace-recovery lock).
  function pidReused(holder) {
    if (!identity) return false;
    let seen = probed && probed.get(holder.pid);
    if (!seen) {
      // a throwing probe is an unknown identity (busy), never an aborted boot
      try { seen = identity.probe(holder.pid) || { ok: false, reason: 'no probe result' }; }
      catch (error) { seen = { ok: false, reason: String((error && (error.code || error.message)) || 'probe failed') }; }
      if (probed) probed.set(holder.pid, seen);
    }
    const judged = judgeReuse(holder, seen);
    lastIdentity = Object.assign({ pid: holder.pid, stampedAt: Number(holder.startedAt) || 0 }, judged);
    return judged.verdict === 'reused';
  }
  // provably dead: the stamped process predates this boot, or (for a valid stamp) its PID is gone or now
  // belongs to a provably different process. A malformed stamp is dead only when the FILE predates boot —
  // otherwise it is unprovable, i.e. busy.
  function holderDead(holder, lockfile) {
    if (!holder.valid) return predatesBoot(lockMtime(lockfile));
    if (predatesBoot(holder.startedAt)) return true;
    if (!pidAlive(holder.pid)) return true;
    return pidReused(holder);
  }
  const filename = String(d.filename || '.starnet-workspace-owner.json');
  if (!fs || typeof fs.openSync !== 'function' || typeof fs.renameSync !== 'function') {
    throw new Error('workspace-owner: an injected fs with openSync/renameSync is required');
  }
  if (!path || typeof path.join !== 'function') throw new Error('workspace-owner: an injected path is required');

  let held = null;
  let election = null;

  // Immutable generations serialize ownership across crashes. A fully written
  // ticket is published by atomic hard-link creation; a contender can only add
  // the next generation after the latest holder is proven dead or has released.
  // Never delete/reuse generations: that would recreate the stale-read ABA race.
  function elect(root) {
    const directory = path.join(root, filename + '.generations');
    fs.mkdirSync(directory, { recursive: true });
    const generations = fs.readdirSync(directory).filter(name => /^(0|[1-9][0-9]*)\.json$/.test(name))
      .map(name => Number(name.slice(0, -5)));
    if (generations.some(n => !Number.isSafeInteger(n))) throw new Error('invalid ownership generation');
    const latest = generations.reduce((max, n) => Math.max(max, n), -1);
    if (latest >= 0) {
      const previous = path.join(directory, latest + '.json');
      const holder = readHolder(previous);
      if (!fs.existsSync(previous + '.released') && !holderDead(holder, previous)) return false;
    }
    if (!Number.isSafeInteger(latest + 1)) throw new Error('ownership generation exhausted');
    const ticket = path.join(directory, (latest + 1) + '.json');
    const temporary = path.join(directory, '.pending-' + pid + '-' + String(nonce()).replace(/[^a-zA-Z0-9_-]/g, '_'));
    const raw = JSON.stringify(Object.assign({ version: 1, pid, nonce: String(nonce()), startedAt: Number(now()) || 0,
      executable: ownExecutable() }, identityStamp()));
    let fd = null, temporaryOwned = false;
    try {
      fd = fs.openSync(temporary, 'wx');
      temporaryOwned = true;
      fs.writeSync(fd, raw);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      // link never replaces an existing ticket, unlike rename on both platforms.
      fs.linkSync(temporary, ticket);
      election = ticket;
      return true;
    } catch (error) {
      // Another contender published this generation first. IT is the blocker now, not the stale ticket whose
      // PID we just judged, so a refusal must not present that verdict as the current holder's.
      if (error && error.code === 'EEXIST') { lastIdentity = null; return false; }
      throw error;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (error) { failNote('workspace.election.close', error); } }
      // A failed publication leaves only our private temporary file. It is not
      // authoritative and cannot block a subsequent recovery.
      if (temporaryOwned) { try { fs.unlinkSync(temporary); } catch (error) { failNote('workspace.election.cleanup', error); } }
    }
  }

  function releaseElection() {
    if (!election) return;
    const ticket = election;
    // Empty marker creation is atomic; only this owner publishes its release,
    // after its final primary-file operation. Failed release stays fail-closed.
    const fd = fs.openSync(ticket + '.released', 'wx');
    try { if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    election = null;
  }

  function readHolder(lockfile) {
    try {
      const raw = String(fs.readFileSync(lockfile, 'utf8'));
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || !Number.isInteger(Number(value.pid)) || Number(value.pid) <= 0 ||
          typeof value.nonce !== 'string' || !value.nonce) return { valid: false, raw: raw };
      return { valid: true, raw: raw, pid: Number(value.pid), nonce: value.nonce,
        startedAt: Number(value.startedAt) || 0, executable: String(value.executable || ''),
        startTicks: typeof value.startTicks === 'string' && /^\d+$/.test(value.startTicks) ? value.startTicks : '' };
    } catch (e) {
      return { valid: false, unreadable: true, error: (e && e.code) || 'unreadable' };
    }
  }

  function tryCreate(lockfile, root) {
    const claim = Object.assign({
      version: 1,
      pid: pid,
      nonce: String(nonce()),
      startedAt: Number(now()) || 0,
      executable: ownExecutable()
    }, identityStamp());
    const raw = JSON.stringify(claim);
    const temporary = lockfile + '.tmp.' + pid + '.' + String(nonce()).replace(/[^a-zA-Z0-9_-]/g, '_');
    let fd = null;
    let temporaryOwned = false;
    try {
      fd = fs.openSync(temporary, 'wx');
      temporaryOwned = true;
      fs.writeSync(fd, raw);
      if (typeof fs.fsyncSync === 'function') fs.fsyncSync(fd);
      fs.closeSync(fd); fd = null;
      // Publishing complete bytes avoids a same-boot torn primary after a kill.
      fs.linkSync(temporary, lockfile);
    } catch (e) {
      let cleanupError = null;
      if (fd != null) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      return { ok: false, exists: !!(e && e.code === 'EEXIST'), error: e, cleanupError };
    } finally {
      if (temporaryOwned) { try { fs.unlinkSync(temporary); } catch (error) { failNote('workspace.claim.cleanup', error); } }
    }
    let back = '';
    try { back = String(fs.readFileSync(lockfile, 'utf8')); } catch (e) {
      let cleanupError = null;
      try { fs.unlinkSync(lockfile); } catch (cleanup) { cleanupError = cleanup; }
      return { ok: false, exists: false, error: e, cleanupError };
    }
    if (back !== raw) {
      let cleanupError = null;
      try { fs.unlinkSync(lockfile); } catch (cleanup) { cleanupError = cleanup; }
      return { ok: false, exists: false, error: new Error('workspace owner read-back mismatch'), cleanupError };
    }
    held = { root: root, lockfile: lockfile, raw: raw, claim: claim };
    return { ok: true, root: root, lockfile: lockfile, holder: claim, release: release };
  }

  function acquire(root) {
    const resolved = path.resolve ? path.resolve(String(root || '')) : String(root || '');
    if (!resolved) return { ok: false, code: 'WORKSPACE_PATH_INVALID', message: 'workspace path is required' };
    if (held) {
      if (held.root === resolved) return { ok: true, root: held.root, lockfile: held.lockfile, holder: held.claim, release: release };
      return { ok: false, code: 'WORKSPACE_OWNER_ALREADY_HELD', root: resolved, heldRoot: held.root };
    }
    try { fs.mkdirSync(resolved, { recursive: true }); }
    catch (e) { return { ok: false, code: 'WORKSPACE_OWNER_UNAVAILABLE', root: resolved, error: e }; }
    probed = new Map();
    try { return claimRoot(resolved); }
    finally { probed = null; }
  }

  // identity on a BUSY result: what the PID-reuse check found for the holder it judged (null = no live PID probed)
  function claimRoot(resolved) {
    lastIdentity = null;
    try {
      if (!elect(resolved)) return { ok: false, code: 'WORKSPACE_BUSY', root: resolved,
        holder: readHolder(path.join(resolved, filename)), identity: lastIdentity };
    } catch (error) { return { ok: false, code: 'WORKSPACE_OWNER_UNAVAILABLE', root: resolved, error }; }
    try {
    const lockfile = path.join(resolved, filename);
    let created = tryCreate(lockfile, resolved);
    if (created.ok) return created;
    if (!created.exists) return { ok: false, code: 'WORKSPACE_OWNER_UNAVAILABLE', root: resolved, lockfile: lockfile, error: created.error };

    lastIdentity = null;
    const holder = readHolder(lockfile);
    if (!holderDead(holder, lockfile)) {
      return { ok: false, code: 'WORKSPACE_BUSY', root: resolved, lockfile: lockfile, holder: holder, identity: lastIdentity };
    }

    // This process holds the immutable election ticket. No other current host
    // can rename this claim using stale evidence while its ticket remains live.
    const reclaim = lockfile + '.dead-' + pid + '-' + String(nonce());
    try { fs.renameSync(lockfile, reclaim); }
    catch (_) { return { ok: false, code: 'WORKSPACE_BUSY', root: resolved, lockfile: lockfile, holder: holder }; }
    created = tryCreate(lockfile, resolved);
    try { fs.unlinkSync(reclaim); } catch (_) {}
    if (created.ok) return created;
    return { ok: false, code: created.exists ? 'WORKSPACE_BUSY' : 'WORKSPACE_OWNER_UNAVAILABLE',
      root: resolved, lockfile: lockfile, holder: readHolder(lockfile), error: created.error };
    } finally {
      if (!held) { try { releaseElection(); } catch (error) { failNote('workspace.election.release', error); } }
    }
  }

  function release() {
    if (!held) return false;
    const mine = held;
    held = null;
    try {
      if (String(fs.readFileSync(mine.lockfile, 'utf8')) !== mine.raw) return false;
      fs.unlinkSync(mine.lockfile);
      return true;
    } catch (_) { return false; }
    finally { try { releaseElection(); } catch (error) { failNote('workspace.election.release', error); } }
  }

  return { acquire: acquire, release: release, current: function () { return held && held.claim; } };
}

// One line for the boot refusal: what the PID-reuse check actually found (never more than it proved).
function describeIdentity(identity) {
  const v = identity || {};
  const at = ms => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : 'an unknown time');
  if (v.verdict === 'same-process' && Number(v.processStartedAt) > 0 && Number(v.toleranceMs) > 0) {
    return 'PID ' + v.pid + ' started about ' + at(v.processStartedAt) + ' (read without a process handle, ±' +
      Math.round(Number(v.toleranceMs) / 60000) + ' min); its claim was stamped ' + at(v.stampedAt) +
      ' — not provably a different process, treated as a live owner';
  }
  if (v.verdict === 'same-process' && Number(v.processStartedAt) > 0) {
    return 'PID ' + v.pid + ' started ' + at(v.processStartedAt) + '; its claim was stamped ' + at(v.stampedAt) +
      ' — not provably a different process, treated as a live owner';
  }
  if (v.verdict === 'same-process') return 'PID ' + v.pid + ' carries the claim\'s exact process start ticks — the same process';
  if (v.verdict === 'reused') return 'PID ' + v.pid + ' now belongs to a process started after the claim — a recycled PID';
  return 'PID ' + v.pid + ' is running but its start time could not be read (' + String(v.reason || 'unknown') +
    ') — treated as a live owner';
}

module.exports = { makeWorkspaceOwner: makeWorkspaceOwner, makeBootedAt: makeBootedAt, describeIdentity: describeIdentity,
  _internals: { defaultPidAlive: defaultPidAlive } };
