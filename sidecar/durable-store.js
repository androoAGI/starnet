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

   This is a pure, injected-I/O module (no ambient clock/rng — it reuses durable-write.js's crypto nonce),
   so it passes lint-determinism and is unit-testable against an in-memory fs. The Node host
   (sidecar/index.js) injects the real fs/path and composes these into its notebook/roster/etc. stores.

   makeKeyedMutex() -> { run(key, fn) -> Promise, size() }
   readJsonResilient({ fs }, file) -> { value, status }     status: 'ok'|'recovered'|'absent'|'corrupt'|'unreadable'
   writeJsonResilient({ fs, path, writeDurable? }, file, value) -> void   (throws on a real write failure)
   makeDurableJsonStore({ fs, path, fileFor, writeDurable?, mutex?, onRecover?, onCorrupt? }) ->
       { get(key), set(key,value), update(key,mutator)->Promise, readKey(key), mutex } */
'use strict';

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

/* ---- recovery-aware read ----
   Tries the main file; on missing/zero-length/corrupt falls back to the <file>.bak last-known-good.
   Returns a STATUS so the caller can distinguish a genuinely-new store (absent -> load empty, fine)
   from a torn/corrupt one that was recovered, or an unrecoverable one that must be surfaced LOUDLY and
   never silently treated as empty.
     'ok'        — main parsed cleanly.
     'recovered' — main was missing/zero-length/corrupt but .bak parsed cleanly (value is the .bak).
     'absent'    — neither main nor .bak exists (a brand-new key; load empty is correct).
     'corrupt'   — main is present-but-bad and there is no usable .bak (caller must surface loudly).
     'unreadable'— main EXISTS but a non-ENOENT errno blocked the read (locked/EBUSY/EACCES). NOT empty, NOT
                   recovered from .bak (that would roll back live data): surface loudly, fail writes safely. */
function readOne(fs, file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    // ONLY a genuinely-missing file is 'absent'. Any OTHER errno (EBUSY/EACCES/EPERM/EMFILE — on Windows a
    // file held open by antivirus or another process reads as one of these) means the file is present but
    // UNREADABLE right now. Conflating that with 'absent' is a silent-data-wipe hazard: the caller would
    // proceed from empty and the next write persists the amnesiac state. Surface it as its own kind.
    if (e && e.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', err: e };
  }
  if (raw == null || String(raw).length === 0) return { kind: 'empty' };   // zero-length = torn write
  try { return { kind: 'ok', value: JSON.parse(raw) }; }
  catch (_) { return { kind: 'corrupt' }; }
}

function readJsonResilient(deps, file) {
  const fs = deps.fs;
  const m = readOne(fs, file);
  if (m.kind === 'ok') return { value: m.value, status: 'ok' };
  // UNREADABLE main (locked/transient errno, file exists): do NOT fall back to .bak — the main is fine, just
  // momentarily inaccessible, and recovering from a stale .bak would ROLL BACK live data. Surface loudly and
  // let the caller fail safely; a later read (unlocked) returns the real value. Never treated as empty.
  if (m.kind === 'unreadable') return { value: undefined, status: 'unreadable', err: m.err };
  const b = readOne(fs, file + '.bak');
  if (b.kind === 'ok') return { value: b.value, status: 'recovered' };
  if (m.kind === 'absent' && b.kind === 'absent') return { value: undefined, status: 'absent' };
  if (b.kind === 'unreadable') return { value: undefined, status: 'unreadable', err: b.err, problemFile: file + '.bak' };
  // main present-but-bad (empty/corrupt) and no usable .bak -> unrecoverable; do NOT silently empty.
  // When the main is absent, the forensic bytes live in the BACKUP. Carry that exact path so a host quarantine
  // never keeps trying to rename the missing main while the bad backup pins this key corrupt forever.
  return { value: undefined, status: 'corrupt', problemFile: m.kind === 'absent' ? file + '.bak' : file };
}

/* ---- durable write with a last-known-good snapshot ----
   Before overwriting main, copy the CURRENT good main to <file>.bak (durably) so the prior committed
   value survives a torn replace. A current main that is itself corrupt is NOT copied (never clobber a
   possibly-good .bak with garbage). Then write the new value to main durably (fsync-before-rename). */
function writeJsonResilient(deps, file, value) {
  const fs = deps.fs;
  const pathMod = deps.path;
  const wd = (typeof deps.writeDurable === 'function') ? deps.writeDurable : writeFileDurable;
  const data = JSON.stringify(value);
  // Every writer, including full-state set/save callers, must preserve inaccessible authority.
  // A missing/torn main does not authorize replacement of an unreadable sole backup.
  const prior = readJsonResilient({ fs }, file);
  if (prior.status === 'unreadable') {
    const error = new Error('durable-store: refusing to replace unreadable state');
    error.code = 'ESTORE_UNREADABLE'; error.cause = prior.err;
    throw error;
  }
  let cur;
  try {
    cur = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      const failure = new Error('durable-store: current state became unreadable before write');
      failure.code = 'ESTORE_UNREADABLE'; failure.cause = error; throw failure;
    }
  }
  let valid = false;
  if (cur && String(cur).length) { try { JSON.parse(cur); valid = true; } catch (_) {} }
  // A backup write failure is not a parse failure. Refuse before replacing the committed main.
  if (valid) wd({ fs: fs, path: pathMod }, file + '.bak', cur);
  wd({ fs: fs, path: pathMod }, file, data);
}

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
  const onCorrupt = (typeof deps.onCorrupt === 'function') ? deps.onCorrupt : function () {};

  function readKey(key) {
    const file = fileFor(key);
    const r = readJsonResilient({ fs: fs }, file);
    if (r.status === 'recovered') { try { onRecover(key, file, r); } catch (e) { failNote('durable-store.onRecover', e); } }
    // Corrupt bytes may be quarantined; unreadable bytes get diagnostics only.
    else if (r.status === 'unreadable') {
      // onCorrupt is allowed to MOVE bytes. A transient read error is never that permission.
      failNote('durable-store.unreadable', r.err || new Error('store temporarily unreadable'));
    } else if (r.status === 'corrupt') {
      let handled = false;
      try { handled = !!onCorrupt(key, r.problemFile || file, r); } catch (e) { failNote('durable-store.onCorrupt', e); }
      // A successful quarantine changes the truth on disk. Re-read it now so the SAME update may initialize an
      // actually-empty key; a failed/undefined handler keeps the original corrupt status and the write refusal.
      if (r.status === 'corrupt' && handled) {
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
  function set(key, value) {
    const file = fileFor(key);
    try { if (pathMod && pathMod.dirname && fs.mkdirSync) fs.mkdirSync(pathMod.dirname(file), { recursive: true }); } catch (_) {}
    writeJsonResilient({ fs: fs, path: pathMod, writeDurable: wd }, file, value);
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
      if (next !== undefined) set(key, next);
      return next;
    });
  }
  return { get: get, set: set, update: update, readKey: readKey, mutex: mutex };
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

module.exports = { makeKeyedMutex, readJsonResilient, writeJsonResilient, makeDurableJsonStore, saveJsonVerified, _internals: { readOne } };
