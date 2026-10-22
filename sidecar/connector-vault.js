'use strict';

const crypto = require('node:crypto');
const { writeFileDurable } = require('./durable-write.js');

const FORMAT = 'starnet.connector-vault.v1';
const AAD = Buffer.from(FORMAT);
const UNAVAILABLE = 'Connector credentials are locked. Restart Agent OS with the original OS account and an unlocked credential store.';
// Why the saved sign-ins could not be opened. Each one names what the user can actually do about it:
// a restart only helps when the OS store was unreachable or the file was busy; the others need START FRESH.
// 'reset-interrupted': an earlier START FRESH stopped part-way (crash, power loss); pressing it again finishes it.
// 'busy': the file was there but could not be read right now (antivirus, backup or sync holding it); a restart
// is the fix, and START FRESH would only set a good store aside. It stays named as the exit for a file that is
// still locked after a restart (an account that may not read it), so the lock is never one with no way out.
const LOCK_REASONS = ['key-unavailable', 'key-mismatch', 'unreadable', 'reset-interrupted', 'busy'];
// Windows reports a sharing violation as EBUSY and a held/denied handle as EPERM. Other errors (EIO, POSIX EACCES)
// are not a passing hold, so they stay 'unreadable'.
const BUSY_READ_CODES = ['EBUSY', 'EPERM'];
// detail (optional, from vault.lockDetail): { movedTo, unfinishable? } for an interrupted reset, { readCode } for a
// busy file.
function lockMessage(reason, keyError = '', detail = {}) {
  const why = String(keyError || '').trim().slice(0, 240);
  const movedTo = detail && typeof detail.movedTo === 'string' ? detail.movedTo.slice(0, 400) : '';
  const readCode = detail && typeof detail.readCode === 'string' ? detail.readCode.replace(/[^A-Z]/g, '').slice(0, 12) : '';
  if (reason === 'busy') return 'Saved connector sign-ins are locked: Agent OS could not read the saved file' + (readCode ? ' (' + readCode + ')' : '') +
    '. Another program such as antivirus, backup or sync may have been holding it, or this account may not be allowed to read it. They are safe and unchanged. Restart Agent OS to try again.' +
    ' If it is still locked after a restart, START FRESH moves the old files aside (nothing is deleted) so you can sign in again.';
  if (reason === 'key-unavailable') return 'Saved connector sign-ins are locked: Agent OS could not open this computer\'s credential store.' +
    (why ? ' Reason: ' + why + '.' : '') + ' They are safe and unchanged. Unlock or repair the credential store and restart Agent OS, or START FRESH to sign in again.';
  if (reason === 'key-mismatch') return 'Saved connector sign-ins are locked: they were sealed with a key this OS account no longer has (its credential-store entry was reset, or this is a different account). START FRESH to sign in again. The old files are kept, not deleted.';
  const unfinishable = detail && typeof detail.unfinishable === 'string' ? detail.unfinishable.slice(0, 240) : '';
  if (reason === 'reset-interrupted' && unfinishable) return 'Saved connector sign-ins are locked: an earlier START FRESH was interrupted and cannot be finished automatically, because ' +
    unfinishable + '. Your files were left as they are. To recover by hand, copy the files from ' + (movedTo || 'the unreadable-* folder') +
    ' back into the connectors folder, delete the .reset-pending file there, and restart Agent OS.';
  if (reason === 'reset-interrupted') return 'Saved connector sign-ins are locked: an earlier START FRESH was interrupted before it finished. Your old files were not deleted' +
    (movedTo ? ' (copies are in ' + movedTo + ')' : '') + '. Press START FRESH to finish it.';
  return 'Saved connector sign-ins are locked: the saved file is damaged or from a newer Agent OS. START FRESH to sign in again. The old files are kept, not deleted.';
}
function lockError(reason) { return Object.assign(new Error(UNAVAILABLE), { lockReason: LOCK_REASONS.includes(reason) ? reason : 'unreadable' }); }
function validState(value) {
  const object = v => !!v && typeof v === 'object' && !Array.isArray(v);
  return object(value) && value.version === 2 && Array.isArray(value.configs) &&
    object(value.oauth) && object(value.oauth.byId) && object(value.oauth.clients);
}

// The desktop shell supplies a stable, OS-keychain-backed key. Never create a
// plaintext key beside the ciphertext, and never treat a missing key as empty data:
// ciphertext without its key stays locked and untouched. When the desktop expected a
// key (required) but the OS store was unreachable, a store with NO sealed data runs
// unencrypted instead of refusing every sign-in (`fallback` says so, truthfully), the
// same rule as the credits token: better a token on disk than a token nobody has.
// The next launch with a working store seals it (migrate).
function makeConnectorVault({ fs, path, keyHex = '', required = false, writeDurable = writeFileDurable }) {
  if (keyHex && !/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error(UNAVAILABLE);
  const key = keyHex ? Buffer.from(keyHex, 'hex') : null;
  let locked = false;
  let lockReason = '';
  let lockInfo = {};
  let resetInProgress = false;
  // The START FRESH recovery marker: { movedTo, sources: [basenames], previous?: [earlier folders] }.
  // { absent } when there is none; { bad, movedTo? } when it exists but cannot be checked.
  function readMarker(marker) {
    let raw;
    try { raw = fs.readFileSync(marker, 'utf8'); }
    catch (e) { return e && e.code === 'ENOENT' ? { absent: true } : { bad: 'cannot be read (' + String(e && e.code || e) + ')' }; }
    let m = null;
    try { m = JSON.parse(raw); } catch (e) { return { bad: 'is not valid JSON' }; }
    const movedTo = m && typeof m.movedTo === 'string' && m.movedTo ? m.movedTo : '';
    const names = m && Array.isArray(m.sources) && m.sources.every(n => typeof n === 'string' && n && path.basename(n) === n) ? m.sources : null;
    if (!movedTo || !names) return { bad: 'does not list the files it moved', movedTo };
    const previous = Array.isArray(m.previous) ? m.previous.filter(p => typeof p === 'string' && p && p !== movedTo) : [];
    return { raw, movedTo, sources: names, previous };
  }
  // Every file an interrupted reset lists must still be at its source path (inPlace) or in its recovery folder,
  // or finishing the reset could lose one.
  function lostSources(pending, inPlace) {
    return pending.sources.filter(name => !inPlace(name) && !fs.existsSync(path.join(pending.movedTo, name)));
  }
  function lockDetailFor(reason, file, error) {
    if (reason === 'busy') return error && error.readCode ? { readCode: String(error.readCode) } : {};
    if (reason !== 'reset-interrupted') return {};
    const m = readMarker(file + '.reset-pending');
    // The same check startFresh makes, so the message only promises a finish START FRESH will do (the files a
    // reset moves all sit beside `file`). unfinishable: why it cannot, for the by-hand steps instead.
    const lost = m.bad || m.absent ? [] : lostSources(m, name => fs.existsSync(path.join(path.dirname(file), name)));
    const unfinishable = m.bad ? 'its record ' + m.bad : lost.length ? lost.join(', ') + ' is in neither its original place nor the recovery folder' : '';
    return Object.assign(m.movedTo ? { movedTo: m.movedTo } : {}, unfinishable ? { unfinishable } : {});
  }
  function decode(value) {
    if (value && typeof value.format === 'string' && value.format.startsWith('starnet.connector-vault.') && value.format !== FORMAT) throw lockError('unreadable');
    if (!value || value.format !== FORMAT) return value;
    if (!key) throw lockError('key-unavailable');
    try {
      if (!/^[a-f0-9]{24}$/.test(value.iv || '') || !/^[a-f0-9]{32}$/.test(value.tag || '') ||
          typeof value.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) throw new Error();
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'hex'));
      cipher.setAAD(AAD);
      cipher.setAuthTag(Buffer.from(value.tag, 'hex'));
      const plain = JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8'));
      if (!validState(plain)) throw new Error();
      return plain;
    } catch (_) { throw lockError('key-mismatch'); }
  }
  function encode(value) {
    if (!validState(value)) throw new Error('Invalid connector state; saved credentials were preserved');
    if (!key) return value;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { format: FORMAT, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: data.toString('base64') };
  }
  function readOne(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return { absent: true };
      // a held or access-denied file is present and probably fine — never call it damaged (security-storage-05)
      if (BUSY_READ_CODES.includes(e.code)) throw Object.assign(lockError('busy'), { readCode: e.code });
      throw lockError('unreadable');
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { corrupt: true }; }
    // Every supported current/legacy format is an object. JSON null is present
    // data, never proof of an absent store: boot migration would otherwise seal
    // an empty state over this file AND its last-good encrypted backup.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw lockError('unreadable');
    return { value: decode(parsed), encrypted: parsed && parsed.format === FORMAT };
  }
  function load(file) {
    if (locked) throw lockError(lockReason);
    try {
      // A reset interrupted after parking the old copies must never boot as an empty store.
      if (!resetInProgress && fs.existsSync(file + '.reset-pending')) throw lockError('reset-interrupted');
      const main = readOne(file);
      if (!main.absent && !main.corrupt) return main.value;
      const bak = readOne(file + '.bak');
      if (!bak.absent && !bak.corrupt) return bak.value;
      if (main.absent && bak.absent) return undefined;
      throw lockError('unreadable');
    } catch (e) {
      locked = true; lockReason = (e && e.lockReason) || 'unreadable';
      lockInfo = lockDetailFor(lockReason, file, e);
      throw lockError(lockReason);
    }
  }
  function readVerified(file, value) {
    const got = readOne(file);
    if (got.absent || got.corrupt || key && !got.encrypted || JSON.stringify(got.value) !== JSON.stringify(value)) throw new Error(UNAVAILABLE);
  }
  function write(file, value, { removal = false } = {}) {
    if (locked) throw new Error(UNAVAILABLE);
    // Read before writing: a wrong/missing key must never overwrite the last copy.
    const previous = load(file);
    const data = JSON.stringify(encode(value));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!removal && previous !== undefined) {
      writeDurable({ fs, path }, file + '.bak', JSON.stringify(encode(previous)));
      readVerified(file + '.bak', previous);
    }
    writeDurable({ fs, path }, file, data);
    readVerified(file, value);
    // First write and explicit removal must both have a verified recovery copy.
    if (removal || previous === undefined) {
      writeDurable({ fs, path }, file + '.bak', JSON.stringify(encode(value)));
      readVerified(file + '.bak', value);
    }
    return true;
  }
  function migrate(file, value, legacyFiles = []) {
    if (!key) return false;
    // Seal BOTH copies and verify before removing any old credential file.
    write(file, value, { removal: true });
    for (const legacy of legacyFiles) {
      for (const target of [legacy, legacy + '.bak']) {
        try { fs.unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Connector credential migration could not remove a legacy copy'); }
      }
    }
    return true;
  }
  // Readback alone can come from the page cache. These barriers protect the only remaining credential
  // bytes before originals are unlinked, and restored bytes before the recovery marker is cleared.
  function flushRecoveryFile(file) {
    const fd = fs.openSync(file, 'r+'); // Windows FlushFileBuffers needs a writable handle.
    try { fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  }
  function flushRecoveryDirectory(dir) {
    let fd = null;
    try {
      fd = fs.openSync(dir, 'r');
      fs.fsyncSync(fd);
    } catch (e) {
      // Like durable-write, tolerate unsupported directory flushing. Do not hide real I/O failures:
      // EIO/ENOSPC and POSIX access failures must leave the originals or recovery marker in place.
      const unsupported = e && (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(e.code)
        || process.platform === 'win32' && (fd == null
          ? ['EISDIR', 'EACCES', 'EPERM'].includes(e.code) : ['EBADF', 'EPERM'].includes(e.code)));
      if (!unsupported) throw e;
    } finally { if (fd != null) fs.closeSync(fd); }
  }
  // START FRESH: the user's explicit exit from a store that cannot be opened. Every copy (main, backup,
  // legacy) is MOVED into a dated unreadable-* folder beside it, never deleted, and only once all of them
  // are aside is a new empty store written (sealed when a key exists). A failed move leaves the vault locked.
  function startFresh(file, legacyFiles = [], { stamp = '' } = {}) {
    const empty = { version: 2, configs: [], oauth: { byId: {}, clients: {} } };
    const label = String(stamp || '').replace(/[^0-9A-Za-z-]/g, '-').slice(0, 40) || 'unknown';
    const dir = path.join(path.dirname(file), 'unreadable-' + label);
    const candidates = [file, ...legacyFiles].flatMap(f => [f, f + '.bak']);
    const sources = candidates.filter(src => fs.existsSync(src));
    const marker = file + '.reset-pending';
    /* RESUME AN INTERRUPTED RESET (security-storage-04). A crash or power loss after the marker was written left
       the store locked, and every later START FRESH refused: a lock with no exit. Nothing is lost at any point of
       an interrupted run, because originals are only removed after ALL copies are verified and flushed. So every
       file the marker lists is either still in place or copied into its folder. When that holds, finish the job:
       sweep what sits at the source paths now into a NEW folder (the earlier one is never touched) and record
       both. When it does not (an unreadable marker, or a listed file in neither place), refuse and change nothing. */
    const pending = readMarker(marker);
    const refuse = (why, movedTo) => new Error('START FRESH cannot finish the earlier interrupted attempt: ' + why +
      '. Your files were left as they are. To recover by hand, copy the files from ' + (movedTo || 'the unreadable-* folder') +
      ' back into ' + path.dirname(file) + ', delete ' + marker + ', and restart Agent OS.');
    if (pending.bad) throw refuse('its record ' + marker + ' ' + pending.bad, pending.movedTo);
    const resuming = !pending.absent;
    if (resuming) {
      const lost = lostSources(pending, name => candidates.some(c => path.basename(c) === name && fs.existsSync(c)));
      if (lost.length) throw refuse(lost.join(', ') + ' is in neither ' + path.dirname(file) + ' nor ' + pending.movedTo, pending.movedTo);
    }
    for (const src of sources) {
      if (fs.existsSync(path.join(dir, path.basename(src)))) throw new Error('START FRESH could not keep ' + path.basename(src) + ' aside; nothing was changed');
    }
    const previous = resuming ? [pending.movedTo, ...pending.previous] : [];
    const oldReason = lockReason || (resuming ? 'reset-interrupted' : 'unreadable');
    const moved = [];
    let writing = false, wroteMarker = false;
    try {
      if (sources.length) fs.mkdirSync(dir, { recursive: true });
      // Durable intent precedes the first move. A crash leaves a visible locked store, never an empty one.
      // A resume with nothing left to move keeps the earlier marker as it is (it already locks the store).
      if (!resuming || sources.length) {
        writeDurable({ fs, path }, marker, JSON.stringify(Object.assign({ movedTo: dir, sources: sources.map(src => path.basename(src)) },
          previous.length ? { previous } : {})));
        wroteMarker = true;
      }
      // Verify every preserved copy before removing any original credential file.
      for (const src of sources) {
        const dest = path.join(dir, path.basename(src));
        fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
        if (!fs.readFileSync(dest).equals(fs.readFileSync(src))) throw new Error('Recovery copy could not be verified: ' + path.basename(src));
        flushRecoveryFile(dest);
      }
      if (sources.length) {
        flushRecoveryDirectory(dir);
        flushRecoveryDirectory(path.dirname(dir));
      }
      for (const src of sources) {
        fs.unlinkSync(src);
        moved.push(path.basename(src));
      }
      resetInProgress = true;
      locked = false; lockReason = ''; lockInfo = {};
      writing = true;
      write(file, empty, { removal: true });
      fs.unlinkSync(marker);
      return { movedTo: moved.length ? dir : '', moved, state: empty, previous };
    } catch (error) {
      locked = true; lockReason = oldReason;
      let restored = true;
      // Only remove files created by this attempt where no original existed; originals are copied back from verified recovery files.
      if (writing) for (const target of [file, file + '.bak']) {
        if (sources.includes(target)) continue;
        try { fs.unlinkSync(target); } catch (e) { if (e.code !== 'ENOENT') restored = false; }
      }
      const restoredDirs = new Set();
      for (const name of moved.slice().reverse()) {
        const src = sources.find(candidate => path.basename(candidate) === name);
        try {
          const saved = path.join(dir, name);
          fs.copyFileSync(saved, src);
          if (!fs.readFileSync(src).equals(fs.readFileSync(saved))) restored = false;
          flushRecoveryFile(src);
          restoredDirs.add(path.dirname(src));
        } catch (_) { restored = false; }
      }
      for (const dir of restoredDirs) {
        try { flushRecoveryDirectory(dir); } catch (_) { restored = false; }
      }
      // A clean rollback returns to exactly the state before this attempt: no marker after a first attempt, the
      // earlier marker after a resume (the store must stay locked while its old files are still parked).
      if (restored && !resuming) try { fs.unlinkSync(marker); } catch (e) { if (e.code !== 'ENOENT') restored = false; }
      if (restored && resuming && wroteMarker) try { writeDurable({ fs, path }, marker, pending.raw); } catch (e) { restored = false; }
      lockInfo = lockDetailFor(lockReason, file);
      const earlier = resuming ? ' Earlier copies stay in ' + pending.movedTo + '.' : '';
      const detail = restored ? (resuming ? 'Storage remains locked' + (moved.length ? '; the files it moved were put back' : '') + '.' + earlier
        : 'The original files were restored and storage remains locked.')
        : 'Storage remains locked; preserved recovery files are in ' + dir + '. Recovery did not fully restore the original locations.' + earlier;
      throw new Error('START FRESH failed. ' + detail + ' ' + String(error && error.message || error));
    } finally { resetInProgress = false; }
  }
  return { load, write, migrate, startFresh,
    get protected() { return !!key && !locked; }, get locked() { return locked; },
    get lockReason() { return locked ? lockReason : ''; },
    // What the lock message can name (lockMessage's third argument): { movedTo, unfinishable? } for an interrupted
    // reset, { readCode } for a busy file.
    get lockDetail() { return locked ? Object.assign({}, lockInfo) : {}; },
    // The desktop expected an OS-keychain key and did not get one: whatever is saved is NOT encrypted.
    get fallback() { return !!required && !key; } };
}

module.exports = { makeConnectorVault, FORMAT, UNAVAILABLE, LOCK_REASONS, lockMessage };
