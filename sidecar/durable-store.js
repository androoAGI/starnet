/* sidecar/durable-store.js — crash-safe + concurrency-safe + recovery-aware single-file JSON stores.

   HARD INVARIANT — ONE sidecar process per WORKSPACES dir. The concurrency safety below is an IN-PROCESS
   async mutex (makeKeyedMutex): it serializes writers that share a key WITHIN this Node process only. That is
   SUFFICIENT precisely because StarNet's product reality is a single sidecar owning a given save dir (`npm start`
   → one :8787; the desktop shell spawns exactly one sidecar per install). There is deliberately NO cross-process
   file lock here. If two sidecars ever pointed at the SAME WORKSPACES dir, their in-process mutexes would not see
   each other and a last-write-wins clobber could lose an update — so DON'T run two. (The cron scheduler, which
   genuinely can't assume single-owner, uses a separate on-disk pid-stamped lock: sidecar/cron-lock.js. The
   single-process invariant is the reason the general stores don't need one.) Decided 2026-07-04: document the
   invariant, no locking code.

   Three problems this fixes for the protected sibling stores (notebook, roster, dossier, channel
   secrets, codex tokens, connectors, allowlist), all of which today do an UNLOCKED read-modify-write
   over a plain writeFileSync->rename:

   P1 CONCURRENCY CLOBBER — callers do get() -> mutate -> set(). Two writers to the SAME key that each
      computed from a stale snapshot whole-array-overwrite each other -> a committed update is silently
      lost. The fix is `update(key, mutator)`: a per-KEY async mutex serializes every write, and the
      mutator RE-READS the current committed state inside the lock before merging (the same re-read-
      under-lock discipline cron already uses under cron-lock). Even an async mutator is fully serialized,
      so no number of concurrent in-process writers can lose an update.

   P2 NON-DURABLE + FAIL-OPEN-TO-EMPTY — a plain rename is atomic but NOT power-loss durable, so a hard
      kill can leave a store zero-length, and the old loaders catch-and-return-empty -> the app boots
      AMNESIAC and the next write persists that empty state forever. The fix: every write goes through
      writeFileDurable (fsync-before-rename) AND snapshots the prior good value to a `<file>.bak`
      last-known-good copy first; the loader DETECTS a zero-length/corrupt main and recovers from the
      .bak instead of silently wiping. A genuinely-absent file (new agent) is the ONLY thing that loads
      as empty.

   The primitives are sidecar/persist's (one implementation for every store): readJsonResilient is persist.readTagged,
   writeJsonResilient is persist.replaceJson (the last-known-good replace: a bad main is kept as <file>.corrupt-<n>
   before it is replaced, a .bak that cannot be refreshed never blocks the write, and a blind write over a file this
   process could not read keeps it as <file>.unseen-<n> first). What stays here is the keyed store itself, its read
   policy and update() discipline, and saveJsonVerified. Pure injected I/O (no ambient clock/rng), unit-testable
   against an in-memory fs; the Node host (sidecar/index.js) injects the real fs/path.

   makeKeyedMutex() -> { run(key, fn) -> Promise, size() }
   readJsonResilient({ fs }, file) -> { value, status, ... }   status: 'ok'|'recovered'|'absent'|'corrupt'|'unreadable'
   writeJsonResilient({ fs, path, writeDurable? }, file, value) -> void   (throws on a real write failure)
   makeDurableJsonStore({ fs, path, fileFor, writeDurable?, mutex?, onRecover?, onCorrupt? }) ->
       { get(key), set(key,value), update(key,mutator)->Promise, readKey(key), signature(key)->string|null, mutex } */
'use strict';

const persist = require('./persist/index.js');
const { writeFileDurable } = require('./durable-write.js');
const { note: failNote } = require('./failopen.js');   // tagged SYNC swallow: a fail-open catch must never be invisible

/* ---- per-key async mutex: serialize fn()s that share a key into one promise chain ----
   Each key owns a tail promise; a new run chains after it (running fn whether the prior settled or
   threw, so one failure never wedges the queue) and becomes the new tail. The tail is pruned when it
   is the last in line, so the Map never grows without bound across many distinct keys. */
function makeKeyedMutex() {
  const tails = new Map();   // key -> Promise (the tail of that key's queue)
  function run(key, fn) {
    const k = String(key);
    const prev = tails.get(k) || Promise.resolve();
    // run fn AFTER prev regardless of prev's outcome; `result` is what the caller awaits.
    const result = prev.then(fn, fn);
    // a settle-swallowing tail keeps the chain alive without leaking rejections, and lets us prune.
    const tail = result.then(function () {}, function () {});
    tails.set(k, tail);
    tail.then(function () { if (tails.get(k) === tail) tails.delete(k); });
    return result;
  }
  return { run: run, size: function () { return tails.size; } };
}

/* ---- recovery-aware read + last-known-good write: persist's (sidecar/persist/read.js, replace.js) ----
   readJsonResilient: main first; on missing/zero-length/corrupt the <file>.bak last-known-good. A genuinely-new store
   is 'absent' (load empty, fine); a torn one is 'recovered' or, with no usable .bak, 'corrupt' (surfaced LOUDLY, never
   silently empty); a present-but-locked one is 'unreadable' (never empty, never recovered from a stale .bak).
   writeJsonResilient: the good main becomes the .bak (a hard link, or a durable copy) before the main is replaced
   durably; a bad main is kept as <file>.corrupt-<n> first; an unreadable main or sole .bak refuses (ESTORE_UNREADABLE). */
function readJsonResilient(deps, file) { return persist.readTagged(deps, file); }
function writeJsonResilient(deps, file, value) { persist.replaceJson(deps, file, value); }

/* ---- keyed, durable, recovery-aware JSON store ----
   get/set are recovery-aware + durable; update(key, mutator) is the SAFE write: it serializes per key
   and re-reads the current committed state inside the lock before the mutator merges, then persists the
   result durably. Returning undefined from the mutator skips the write (a no-op update). */
function makeDurableJsonStore(deps) {
  const fs = deps.fs;
  const pathMod = deps.path;
  const fileFor = deps.fileFor;
  if (!fs || typeof fs.readFileSync !== 'function') throw new Error('makeDurableJsonStore: an injected fs is required');
  if (typeof fileFor !== 'function') throw new Error('makeDurableJsonStore: fileFor(key)->path is required');
  const wd = (typeof deps.writeDurable === 'function') ? deps.writeDurable : writeFileDurable;
  const mutex = deps.mutex || makeKeyedMutex();
  const onRecover = (typeof deps.onRecover === 'function') ? deps.onRecover : function () {};
  const onCorrupt = (typeof deps.onCorrupt === 'function') ? deps.onCorrupt : null;

  // onCorrupt(key, file, r) is the host's quarantine (index.js passes persist.host's quarantineCorrupt); truthy = moved
  function quarantined(key, file, r) {
    try { return !!onCorrupt(key, file, r); }
    catch (e) { failNote('durable-store.onCorrupt', e); return false; }
  }
  /* THE ONE READ POLICY (persist): bad bytes are moved aside on read, never left for a replace to drop.
     - 'recovered' with a present-but-bad main: the main is moved aside (through onCorrupt when the host gave one, else
       persist's first-free <file>.corrupt-<n>) and the .bak value is served. The status stays 'recovered'.
     - 'corrupt': every present-but-bad copy (the main, and the .bak too when the main is also bad) goes through onCorrupt;
       when all moved and the key now reads absent, the SAME update may initialize it. A store composed WITHOUT onCorrupt
       keeps a corrupt record a refusal: request-reservations must never re-dispatch from a reservation ledger it cannot
       read, and moving its only bytes aside would turn that refusal into an empty, replayable ledger.
     - 'unreadable': diagnostics only. onCorrupt may MOVE bytes; a transient read error is never that permission. */
  function readKey(key) {
    const file = fileFor(key);
    const r = readJsonResilient({ fs: fs }, file);
    if (r.status === 'recovered') {
      if (persist.isBad(r.main)) {
        if (onCorrupt) quarantined(key, file, r);
        else {
          const moved = persist.moveAside({ fs: fs }, file, 'corrupt');
          if (!moved.ok && !moved.absent) failNote('durable-store.quarantine', moved.error);
        }
      }
      try { onRecover(key, file, r); } catch (e) { failNote('durable-store.onRecover', e); }
    } else if (r.status === 'unreadable') {
      failNote('durable-store.unreadable', r.err || new Error('store temporarily unreadable'));
    } else if (r.status === 'corrupt' && onCorrupt) {
      let handled = true;
      for (const bad of persist.badCopies(file, r)) handled = quarantined(key, bad, r) && handled;
      // A successful quarantine changes the truth on disk. Re-read it now so the SAME update may initialize an
      // actually-empty key; a failed/undefined handler keeps the original corrupt status and the write refusal.
      if (handled) {
        const after = readJsonResilient({ fs: fs }, file);
        if (after.status === 'absent') return Object.assign(after, { quarantined: r.problemFile || file });
      }
    }
    return r;
  }
  function get(key) {
    const r = readKey(key);
    return (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;
  }
  // seen: the value derives from a read of this key that just succeeded (update()). A plain set() is a blind writer:
  // a key whose read in this process came back unreadable has its unseen bytes kept before the replace (D2).
  function write(key, value, seen) {
    const file = fileFor(key);
    if (pathMod && pathMod.dirname && fs.mkdirSync) {
      try { fs.mkdirSync(pathMod.dirname(file), { recursive: true }); }
      catch (e) { failNote('durable-store.mkdir', e); }   // the write below then fails loudly itself
    }
    try { persist.replaceJson({ fs: fs, path: pathMod, writeDurable: wd }, file, value, seen ? { seen: true } : undefined); }
    finally { const k = String(key); if (writeGen.has(k)) writeGen.set(k, writeGen.get(k) + 1); }   // even a throw mid-write invalidates
  }
  function set(key, value) { write(key, value, false); }
  /* signature(key) — ADDITIVE + OPT-IN (2026-10-19, idle-CPU pass): a cheap token that changes whenever this key's
     committed main file may have changed, so a caller can keep its last parsed read and skip the read+parse+normalize
     while the token holds. It is the bigint stat of the main file (dev, ino, size, mtimeNs, ctimeNs — a tmp+rename
     write changes the ino, an in-place same-size rewrite changes mtimeNs/ctimeNs only ACROSS a filesystem timestamp
     tick: ~1 ms on NTFS, 2 s on FAT) plus an in-process write generation bumped by every set(), so a write this
     process made can never hide inside one tick. An outside writer rewriting in place twice within one tick could
     (racy-clean); the single-writer contract above forbids that writer, so no racy guard is kept here.
     bigint is required: inodes on this class of box exceed 2^53, where a plain number collides.
     null means "do not cache": no statSync (the in-memory test fakes), a stat without bigint fields, a missing main
     (absent/recovered states keep their uncached, loud path), or any stat error (noted, never silent).
     The generation is LAZY — tracked only for keys someone has asked a signature of — so the stores that never
     call this pay nothing. Reads only: update() still re-reads disk under the mutex, a cache never feeds a mutator. */
  const writeGen = new Map();   // key -> set() count since the key's first signature() (in-process, never persisted)
  function signature(key) {
    if (typeof fs.statSync !== 'function') return null;
    const k = String(key);
    let st;
    try { st = fs.statSync(fileFor(key), { bigint: true }); }
    catch (e) {
      if (!e || e.code !== 'ENOENT') failNote('durable-store.signature', e);
      return null;
    }
    if (!st || typeof st.ino !== 'bigint' || typeof st.mtimeNs !== 'bigint' || typeof st.ctimeNs !== 'bigint') return null;
    if (!writeGen.has(k)) writeGen.set(k, 0);
    return writeGen.get(k) + ':' + st.dev + ':' + st.ino + ':' + st.size + ':' + st.mtimeNs + ':' + st.ctimeNs;
  }
  function update(key, mutator) {
    return mutex.run(key, async function () {
      const r = readKey(key);               // RE-READ the current committed state INSIDE the lock (loud on failure)
      // FAIL SAFE: if the current value is UNREADABLE (present but locked) OR CORRUPT with no usable backup,
      // refuse the write. Both states prove a record exists but give us no safe base for a read-modify-write;
      // treating either as `undefined` would persist an amnesiac replacement and destroy the only recovery /
      // forensic bytes. A genuinely absent record is the only state allowed to initialize from undefined.
      if (r.status === 'unreadable' || r.status === 'corrupt') {
        const detail = r.status === 'unreadable' ? ' (' + ((r.err && r.err.code) || 'EUNKNOWN') + ')' : '';
        const e = new Error('durable-store: refusing to update key "' + key + '" — current value is ' + r.status + detail);
        e.code = r.status === 'unreadable' ? 'ESTORE_UNREADABLE' : 'ESTORE_CORRUPT';
        e.cause = r.err;
        throw e;
      }
      const cur = (r.status === 'ok' || r.status === 'recovered') ? r.value : undefined;
      const next = await mutator(cur);      // mutator may be sync or async; the lock is held throughout
      if (next !== undefined) write(key, next, true);
      return next;
    });
  }
  return { get: get, set: set, update: update, readKey: readKey, signature: signature, mutex: mutex };
}

/* ---- verifiable durable write (read-back proof + retry-once) ----
   The LAW for irreplaceable credentials: never claim a secret is persisted without PROOF another durable copy
   holds it. A swallowed write error on a rotated OAuth refresh_token means a restart reloads the DEAD token ->
   forced re-sign-in; a swallowed write on freshly-exchanged connector tokens leaves the connector silently
   unsigned next boot while the UI said "connected". This primitive writes, READS THE VALUE BACK, and runs a
   caller-supplied proof predicate against the read-back; on failure it retries ONCE, then reports honestly.

     saveJsonVerified({ save(), load(), proof(readBack)->bool, mkdir?() }) -> { ok, attempts, error }

   `save()` performs the durable write (may throw). `load()` reads the value back (resilient loader; may return
   undefined). `proof(readBack)` returns true when the read-back proves the intended secret reached disk. ok is
   true ONLY when proof passes — the caller then knows durability is real and can safely report success; on
   ok:false the caller keeps the value in memory but must surface the failure (never a false "saved"). */
function saveJsonVerified(opts) {
  opts = opts || {};
  const save = opts.save, load = opts.load;
  const proof = (typeof opts.proof === 'function') ? opts.proof : function () { return true; };
  if (typeof save !== 'function' || typeof load !== 'function') {
    return { ok: false, attempts: 0, error: 'saveJsonVerified requires save+load functions' };
  }
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (typeof opts.mkdir === 'function') { try { opts.mkdir(); } catch (_) {} }
    try { save(); } catch (e) { lastErr = (e && e.message) || String(e); }
    // A load() that THROWS proves nothing (the file is unreadable/locked) — never run proof on it, never call it
    // proven. Only a successful read-back is eligible for the proof predicate.
    let readBack, loadOk = true; try { readBack = load(); } catch (e) { loadOk = false; lastErr = lastErr || (e && e.message) || String(e); }
    let proven = false; if (loadOk) { try { proven = !!proof(readBack); } catch (_) { proven = false; } }
    if (proven) return { ok: true, attempts: attempt, error: '' };
    if (!lastErr) lastErr = 'read-back did not prove the write reached disk';
  }
  return { ok: false, attempts: 2, error: lastErr };
}

module.exports = { makeKeyedMutex, readJsonResilient, writeJsonResilient, makeDurableJsonStore, saveJsonVerified, _internals: { readOne: persist.readOne } };
