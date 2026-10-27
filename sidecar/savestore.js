/* sidecar/savestore.js — durable server-side persistence for the agent the user builds (M-save).

   The browser's localStorage is the FRAGILE store: a cache wipe, a different browser, or a fresh
   machine loses the agent (identity, XP/level/confidence, personalization, workstreams, station).
   `save.js` itself says "localStorage for now ... moves to the SQLite sidecar later." This module is
   that move: a durable mirror of the save envelope on the sidecar's own disk (the app-data dir that
   survives a browser wipe). The frontend keeps localStorage as a fast cache and writes through to here.

     makeSaveStore({ fs, pathMod, root, clock }) -> {
       load(agentId)        -> doc | undefined        // the stored save envelope; undefined if none/corrupt
       stamp(agentId)       -> string                 // one stat: moves on every save/outside edit; '' = unknown
       loadStamped(agentId) -> { doc, stamp }         // load()'s doc + the pre-read stamp ('' unless a clean read)
       save(agentId, doc, {compareRevision?}) -> { ok, conflict?, reset?, reseeded?, seeded?, revision?, updatedAt }
     }

   The file lives at <root>/<agentId>.save.json — a SIBLING of the notebook/channels stores, OUTSIDE the
   agent's fs jail (<root>/<agentId>/), so the agent's own fs.* tools can neither read nor corrupt the
   record of its own growth. It holds NO secret: the API key/OAuth tokens are stored separately and are
   never part of the save envelope, so mirroring it to disk leaks nothing.

   Save-safe like its siblings: atomic temp+rename; a missing/corrupt file loads as undefined and NEVER
   throws; an incoming write whose updatedAt is older than what's on disk is rejected (a stale tab cannot
   clobber a newer save). Pure + deterministic: all I/O is the injected `fs` (sync), time is the injected
   `clock` — no Date.now/rng, so it replays identically under test. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.savestore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // failopen.note — the tagged SYNC swallow (per-tag count + throttled warn): a fail-open catch must never be invisible.
  const { note: failNote } = (typeof require === 'function') ? require('./failopen.js') : { note: function (tag, e) { console.warn('[failopen] ' + tag + ':', (e && e.message) || e); } };

  const AID_RE = /^[A-Za-z0-9_-]{1,40}$/;   // same agentId grammar as the notebook / fs jail / channels store

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function makeSaveStore(deps) {
    const d = deps || {};
    const fs = d.fs;
    const pathMod = d.pathMod;
    const rootDir = d.root;
    const clock = d.clock;
    if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function' || typeof fs.renameSync !== 'function')
      throw new Error('makeSaveStore: an injected fs (readFileSync/writeFileSync/renameSync[/mkdirSync]) is required');
    if (!pathMod || typeof pathMod.join !== 'function') throw new Error('makeSaveStore: an injected pathMod is required');
    if (!rootDir) throw new Error('makeSaveStore: a root dir is required');
    if (!clock || typeof clock.now !== 'function') throw new Error('makeSaveStore: an injected clock is required');

    let tmpSeq = 0;   // deterministic process-unique tmp suffix (a single host; no pid/rng needed)
    let writes = 0;   // main-file saves made by this process: part of stamp(), so an in-process save always moves it
    const recoveredMissing = new Set();
    const settledBy = new Map();   // agentId -> { receipt, files: Map(name -> 'mtimeMs:size') }: the boot offer's settled memo (settleConflicts)
    const lastWritten = new Map();   // file -> { stamp, updatedAt, revision, replayAt, seededRevision } of this process's own last write (see save())

    /* Rejected-save snapshots are recoveries, not history: every stale client (a reopened tab, a flaky beacon)
       used to add one forever (audit 2026-09-25 #18). Keep the newest CONFLICT_KEEP per agent — the file just
       written always survives — and drop the rest. Best-effort: a failed prune never fails the save response. */
    const CONFLICT_KEEP = Number(d.conflictKeep) > 0 ? Math.floor(Number(d.conflictKeep)) : 20;
    function pruneConflicts(agentId, keepName) {
      if (typeof fs.readdirSync !== 'function' || typeof fs.unlinkSync !== 'function' || typeof fs.statSync !== 'function') return 0;
      const prefix = agentId + '.save-conflict-';
      let names;
      try { names = fs.readdirSync(rootDir).filter(n => typeof n === 'string' && n.indexOf(prefix) === 0 && /\.json$/.test(n)); }
      catch (e) { failNote('savestore.conflict-prune.list', e); return 0; }
      if (names.length <= CONFLICT_KEEP) return 0;
      const rows = [];
      for (const n of names) {
        let m = 0;
        try { m = Number(fs.statSync(pathMod.join(rootDir, n)).mtimeMs) || 0; } catch (e) { failNote('savestore.conflict-prune.stat', e); }
        rows.push({ n, m: n === keepName ? Infinity : m });
      }
      rows.sort((a, b) => (b.m - a.m) || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
      let removed = 0;
      for (const r of rows.slice(CONFLICT_KEEP)) {
        try { fs.unlinkSync(pathMod.join(rootDir, r.n)); removed++; } catch (e) { failNote('savestore.conflict-prune.unlink', e); }
        // a window that conflicts again overwrites its snapshot, and the atomic write leaves the prior one as .bak
        try { fs.unlinkSync(pathMod.join(rootDir, r.n + '.bak')); } catch (e) { if (!e || e.code !== 'ENOENT') failNote('savestore.conflict-prune.unlink-bak', e); }
      }
      return removed;
    }
    // the restore backups beside the station file, newest restore first by the time in the name; the copy just written is
    // always kept. Best-effort: a failed prune never fails the restore. kind: 'restore' (a preserved window save brought
    // back) or 'adopt' (a reopening window's unsent save merged in, POST /api/save/adopt) — each kind keeps its own newest few.
    function pruneRestoreBackups(agentId, keepName, kind) {
      if (typeof fs.readdirSync !== 'function' || typeof fs.unlinkSync !== 'function') return 0;
      const re = new RegExp('^' + agentId + '\\.save-before-' + (kind === 'adopt' ? 'adopt' : 'restore') + '-(\\d+)\\.json$');
      let rows;
      try { rows = fs.readdirSync(rootDir).map(n => { const m = typeof n === 'string' ? re.exec(n) : null; return m ? { n, t: Number(m[1]) } : null; }).filter(Boolean); }
      catch (e) { failNote('savestore.restore-backup-prune.list', e); return 0; }
      rows.sort((a, b) => (a.n === keepName ? -1 : b.n === keepName ? 1 : 0) || (b.t - a.t) || (a.n < b.n ? 1 : a.n > b.n ? -1 : 0));
      let removed = 0;
      for (const r of rows.slice(RESTORE_BACKUP_KEEP)) {
        try { fs.unlinkSync(pathMod.join(rootDir, r.n)); removed++; } catch (e) { failNote('savestore.restore-backup-prune.unlink', e); }
      }
      return removed;
    }
    function ensureRoot() { try { if (fs.mkdirSync) fs.mkdirSync(rootDir, { recursive: true }); } catch (_) {} }
    function saveFile(agentId) {
      if (!AID_RE.test(String(agentId))) throw new Error('bad save agentId: ' + agentId);
      return pathMod.join(rootDir, agentId + '.save.json');
    }
    // see stamp() in the API below
    function stamp(agentId) {
      const file = saveFile(agentId);
      if (typeof fs.statSync !== 'function') return '';
      try {
        const s = fs.statSync(file, { bigint: true });
        if (!s || s.mtimeNs == null || s.size == null) return '';
        return writes + ':' + s.mtimeNs + ':' + s.size + ':' + s.ino;
      } catch (_) { return ''; }
    }
    // reads + parses a save file path, returning a TAGGED result so callers can tell a genuinely-absent file
    // from one that EXISTS but couldn't be READ (locked/EBUSY/EACCES on Windows) versus one that read but has
    // GARBAGE bytes. The distinction is load-bearing for the anti-clobber gate. The agentId grammar is validated
    // by the caller via saveFile() BEFORE this.
    //   { status: 'ok', wrapper }      — read + parsed
    //   { status: 'absent' }           — ENOENT: no file at all (safe to write a fresh save)
    //   { status: 'unreadable', err }  — present but a non-ENOENT errno blocked the read (locked/EACCES): bytes
    //                                     are probably FINE, freshness UNKNOWN — do NOT clobber (conservative)
    //   { status: 'corrupt', err }     — present + read but the bytes don't parse: unrecoverable garbage, safe to
    //                                     overwrite (a corrupt save is already lost — preserves prior product behavior)
    function readTaggedRaw(file, keepRaw) {
      let raw;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (e) {
        if (e && e.code === 'ENOENT') return { status: 'absent' };
        return { status: 'unreadable', err: e };   // present but locked/EACCES/etc. — NOT absent, bytes intact
      }
      // a zero-length main is a TORN write (crash between temp-open and rename, or an interrupted legacy write):
      // treat it like corrupt so the .bak recovery path below kicks in rather than loading empty.
      if (raw == null || String(raw).length === 0) return { status: 'corrupt', err: new Error('zero-length save file') };
      try { const wrapper = JSON.parse(raw); return keepRaw ? { status: 'ok', wrapper: wrapper, raw: raw } : { status: 'ok', wrapper: wrapper }; }
      catch (e) { return { status: 'corrupt', err: e }; }   // present + read but garbage — recoverable-over
    }
    // quarantine a corrupt main aside (rename to <file>.corrupt-<seq>) so it's preserved for forensics but no
    // longer blocks the store, then recover from <file>.bak if it holds a clean prior save. Best-effort + loud.
    // Returns the quarantine destination path (null if the move failed) so the recovery marker can disclose it.
    // A quarantined copy may be the ONLY remaining bytes of a lost save, and the recovery notice names it. tmpSeq
    // restarts in every process, so `.corrupt-<seq>` repeats across restarts: never replace an existing copy (the old
    // unlink-then-rename destroyed the first incident's bytes on the second) — step to the first free name instead.
    function taken(p) {
      if (typeof fs.existsSync === 'function') return fs.existsSync(p);
      try { fs.readFileSync(p); return true; } catch (e) { return !(e && e.code === 'ENOENT'); }
    }
    function quarantine(file, why) {
      try {
        let dead = file + '.corrupt-' + (++tmpSeq);
        while (taken(dead)) dead = file + '.corrupt-' + (++tmpSeq);
        fs.renameSync(file, dead);
        try { console.warn('[savestore] quarantined corrupt save ' + file + ' -> ' + dead + ' (' + why + ')'); } catch (_) {}
        return dead;
      } catch (_) { return null; /* couldn't move it (locked/gone) — leave it; recovery below still tries .bak */ }
    }
    // RECOVERY NOTICE (EL-11 FIX 2/3): when the store quarantines an unrecoverable save ('quarantined') or
    // restores one from .bak ('recovered'), persist a sibling marker the frontend reads on the next boot —
    // silent data loss / silent recovery is the lie class this kills. Worse news is STICKY: an unacked
    // 'quarantined' marker is never papered over by a later 'recovered'. Best-effort, never throws (a notice
    // failure must not block the store), and only written at the quarantine event itself (no churn on reads).
    function recoveryFile(file) { return file.replace(/\.json$/, '') + '.recovery.json'; }
    function writeRecoveryMarker(file, kind, extra) {
      try {
        const rf = recoveryFile(file);
        const cur = readTaggedRaw(rf);
        if (cur.status === 'ok' && cur.wrapper && cur.wrapper.kind === 'quarantined' && kind === 'recovered') return;
        writeDurable(rf, JSON.stringify(Object.assign({ version: 1, kind: kind, at: clock.now() }, extra || {})));
      } catch (e) { failNote('savestore.notice', e); }
    }
    // RESILIENT tagged read: main first; on a corrupt/torn main, quarantine it and recover from <file>.bak. An
    // 'unreadable' main is NOT quarantined (bytes are fine, just locked) — surfaced as-is so the caller stays
    // conservative. Adds status 'recovered' (main was bad, .bak was clean -> the .bak value is authoritative).
    function readTagged(file, keepRaw) {
      const m = readTaggedRaw(file, keepRaw);
      if (m.status === 'ok') { recoveredMissing.delete(file); return m; }
      if (m.status === 'unreadable') return m;   // locked/EBUSY: don't roll back to a possibly-stale .bak
      // main is absent OR corrupt/torn — try the last-known-good .bak.
      const b = readTaggedRaw(file + '.bak');
      // The backup may be the only intact copy. A transient read failure proves neither
      // absence nor corruption, even when main is torn. Do not quarantine or replace it.
      if (b.status === 'unreadable') return b;
      if (b.status === 'ok') {
        if (m.status === 'corrupt') {
          const dead = quarantine(file, 'main unparseable; recovered from .bak');
          writeRecoveryMarker(file, 'recovered', dead ? { quarantinedTo: dead } : undefined);
          recoveredMissing.add(file);
        } else {
          // Missing main is also a recovery, not a pristine first run. Avoid re-arming an
          // acknowledged notice on every read while the backup remains authoritative.
          if (!recoveredMissing.has(file)) {
            writeRecoveryMarker(file, 'recovered');
            recoveredMissing.add(file);
          }
        }
        return { status: 'recovered', wrapper: b.wrapper, err: m.err };
      }
      // no usable .bak. A genuinely-absent main with no .bak is just a new agent (absent). A corrupt main with
      // no clean .bak is unrecoverable — quarantine it so the next write starts fresh (preserves prior "corrupt
      // save is already lost" product behavior) and report corrupt.
      if (m.status === 'corrupt') {
        const dead = quarantine(file, 'main unparseable and no usable .bak');
        writeRecoveryMarker(file, 'quarantined', { quarantinedTo: dead || (file + ' (quarantine rename failed; left in place)') });
      }
      return m.status === 'absent' ? { status: 'absent' } : { status: 'corrupt', err: m.err };
    }
    // back-compat convenience: the parsed wrapper, or undefined when absent/unreadable/corrupt.
    // 'recovered' (from .bak) is a usable value, so it returns the wrapper too.
    function readWrapper(file) { const r = readTagged(file); return (r.status === 'ok' || r.status === 'recovered') ? r.wrapper : undefined; }
    // atomic temp+rename, with the temp file fsync'd before the rename so the DURABLE store of record actually
    // survives a hard power loss (the ledger/runs siblings fsync their appends; this is the same guarantee). The
    // fsync is capability-guarded: the real node:fs supplies openSync/writeSync/fsyncSync, while the in-memory
    // test fs (writeFileSync/renameSync only) falls back to the plain path — keeps the store deterministic + testable.
    function writeDurable(file, data) {
      const tmp = file + '.' + (++tmpSeq) + '.tmp';
      if (typeof fs.openSync === 'function' && typeof fs.fsyncSync === 'function' && typeof fs.writeSync === 'function') {
        // FULL-WRITE LOOP (the exact hazard durable-write.js documents): a single unchecked writeSync may
        // make partial progress — fsync + rename of that prefix then replaces the good main with a torn
        // save while save() reports ok, and the next load quarantines it. Write a Buffer with progress
        // accounting; a non-advancing write throws BEFORE the rename, so main is never touched.
        const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        let fd = null;
        try {
          fd = fs.openSync(tmp, 'w');
          let offset = 0;
          while (offset < bytes.length) {
            const wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
            if (wrote === undefined) break;   // an injected test fs without a byte count keeps single-shot semantics
            if (!Number.isInteger(wrote) || wrote <= 0 || offset + wrote > bytes.length) {
              throw new Error('short write on ' + tmp + ': ' + offset + '/' + bytes.length);
            }
            offset += wrote;
          }
          fs.fsyncSync(fd);
        }
        finally { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} } }
      } else {
        fs.writeFileSync(tmp, data);   // test/in-memory fs: no fsync available, plain write
      }
      fs.renameSync(tmp, file);   // atomic replace
    }
    /* linkBackup — the good main becomes <file>.bak as a HARD LINK: a second name for the bytes that were made durable
       when they were written as the main (two metadata ops instead of a second temp + write + fsync + rename of the
       whole save). The main never goes missing, and the shared inode ends when the main's own tmp+rename lands (this
       store never writes a file in place). false = no link (FAT/exFAT, an fs facade without linkSync, a refusal):
       the caller copies instead. Same discipline as durable-store.js. */
    function linkBackup(file) {
      if (typeof fs.linkSync !== 'function' || typeof fs.unlinkSync !== 'function') return false;
      try {
        try { fs.unlinkSync(file + '.bak'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
        fs.linkSync(file, file + '.bak');
        return true;
      } catch (e) {
        if (!e || (e.code !== 'EPERM' && e.code !== 'ENOTSUP' && e.code !== 'EXDEV' && e.code !== 'ENOSYS')) failNote('savestore.bak.link', e);
        return false;
      }
    }
    /* THE RESET GENERATION (bug 5c019483 against #101's erase authority). ERASE EVERYTHING and START FRESH leave a clean
       generation carrying a <root>/.fresh-start.json receipt (workspace-lineage.js FRESH_MARKER; src-tauri fresh_start.rs
       stamps `at` as epoch-ms text, the sidecar's startFresh as an ISO time). A missing station file there is the
       Commander's choice, not a lost file: a browser copy of the station from BEFORE that reset must never write itself
       back. Only a station founded after it (agent.createdAt later than the receipt) may re-seed the file. A receipt that
       cannot be read, or a copy with no founding time, proves nothing either way: refused. No receipt = no reset. */
    const RESET_RECEIPT = '.fresh-start.json';
    // the reset receipt's time: null = no receipt (no reset), NaN = a receipt that cannot be read (proves nothing)
    function resetReceiptAt() {
      let raw;
      try { raw = fs.readFileSync(pathMod.join(rootDir, RESET_RECEIPT), 'utf8'); }
      catch (e) { return (e && e.code === 'ENOENT') ? null : NaN; }
      try {
        const receipt = JSON.parse(raw);
        const v = receipt && receipt.version === 1 ? receipt.at : undefined;
        return typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
      } catch (e) { return NaN; }
    }
    function foundedAt(doc) { return Number(doc && doc.agent && doc.agent.createdAt); }
    // true when a station founded at `founded` is not provably from after the reset (`at` from resetReceiptAt)
    function predatesReceipt(founded, at) { return at !== null && !(Number.isFinite(at) && Number.isFinite(founded) && founded > at); }
    function resetRefusesSeed(doc) { return predatesReceipt(foundedAt(doc), resetReceiptAt()); }
    /* ERASED WORK (review 10-23 #5): a preserved copy from before the reset is erased work only while the CURRENT station is
       from after it (founded after the receipt). When the station itself predates the receipt (a backup of the old station
       was restored into the fresh one), its copies are its own lineage: ordinary preserved work. stationFounded undefined =
       there is no station file. */
    function erasedWork(copyFounded, stationFounded) {
      const at = resetReceiptAt();
      return predatesReceipt(copyFounded, at) && !(stationFounded !== undefined && predatesReceipt(stationFounded, at));
    }
    // restore backups (<agent>.save-before-restore-<ms>.json) are kept for the newest few restores only (review 10-23 #7)
    const RESTORE_BACKUP_KEEP = 3;
    /* THE BOOT OFFER'S SETTLED MEMO, DURABLE (review 10-23 r2 #4/#5). The boot offer reads preserved snapshots newest first
       under a time budget. A snapshot that brings nothing back into the station (all of it is there, deleted on purpose, or
       erased work from before a reset) is SETTLED: not read again while it is unchanged (same name, mtime and size). An
       in-process memo was not enough: every app launch is a fresh sidecar, so a big station re-read the same settled newest
       snapshot on every launch, spent the budget and never reached an older one holding real lost work. The memo lives in
       <agent>.save-offer-settled.json beside the snapshots (not station state: START FRESH leaves it, like the snapshots).
       A verdict stays true while the station only moves forward. It is dropped whole when that may no longer hold: the
       reset receipt changed (part of the key), or a write took the station somewhere it was not (unsettle() from save():
       a write on a missing, corrupt or .bak-recovered file, an explicit RESTORE BACKUP, a different station founding). */
    function settledFile(agentId) { return pathMod.join(rootDir, String(agentId) + '.save-offer-settled.json'); }
    function receiptKey() { return String(resetReceiptAt()); }
    function settledMemo(agentId) {
      const receipt = receiptKey();
      let m = settledBy.get(agentId);
      if (m && m.receipt === receipt) return m;
      m = { receipt, files: new Map() };
      try {
        const v = JSON.parse(fs.readFileSync(settledFile(agentId), 'utf8'));
        if (v && v.version === 1 && v.receipt === receipt && v.files && typeof v.files === 'object')
          for (const name of Object.keys(v.files)) if (typeof v.files[name] === 'string') m.files.set(name, v.files[name]);
      } catch (e) { if (!e || (e.code !== 'ENOENT' && !(e instanceof SyntaxError))) failNote('savestore.offer-settled.read', e); }
      settledBy.set(agentId, m);
      return m;
    }
    function unsettle(agentId) {
      settledBy.delete(agentId);
      try { if (typeof fs.unlinkSync === 'function') fs.unlinkSync(settledFile(agentId)); }
      catch (e) { if (!e || e.code !== 'ENOENT') failNote('savestore.offer-settled.unlink', e); }
    }
    function sameFounding(a, b) { return a === b || (Number.isNaN(a) && Number.isNaN(b)); }
    // a window's whole save kept beside the station file as <agent>.save-conflict-<its _saveClient>.json (the newest few
    // kept: pruneConflicts). Returns the file name. A refused save keeps its snapshot this way, and so does a merge that
    // did not take a window's own changes (POST /api/save/adopt).
    function preserveCopy(agentId, doc) {
      const client = /^[A-Za-z0-9_-]{1,80}$/.test(String(doc && doc._saveClient || '')) ? doc._saveClient : clock.now() + '-' + (++tmpSeq);
      const name = String(agentId) + '.save-conflict-' + client + '.json';
      writeAtomic(pathMod.join(rootDir, name), doc);
      pruneConflicts(String(agentId), name);
      return name;
    }
    /* THE HEAD THIS STORE WROTE, PROVED FROM DISK (no in-process memo): a clean read whose wrapper names the revision and the
       window (_saveClient) this store wrote, while the doc still carries both. { client, at: that write's request
       updatedAt, revision }, or null — a wrapper from before 0.14.1, a .bak recovery, or an outside edit proves nothing. */
    function vouchedHead(read, wrapper, revision) {
      if (!read || read.status !== 'ok' || !wrapper || typeof wrapper !== 'object' || !wrapper.doc || typeof wrapper.doc !== 'object') return null;
      if (!Number.isInteger(wrapper.revision) || wrapper.revision !== revision || num(wrapper.doc._saveRevision) !== revision) return null;
      if (typeof wrapper.client !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(wrapper.client) || wrapper.client !== wrapper.doc._saveClient) return null;
      return { client: wrapper.client, at: num(wrapper.requestUpdatedAt), revision };
    }
    // prior (optional): what the caller already knows about THIS file's current main — { status, raw? } from its own
    // read moments ago (save() reads it for the anti-clobber gate), so the main is not read and parsed a second time.
    function writeAtomic(file, value, prior) {
      ensureRoot();
      // LAST-KNOWN-GOOD snapshot: before overwriting main, keep the CURRENT clean main as <file>.bak so a torn
      // replace of main can be recovered from the prior committed save. A main that is itself corrupt/torn is NOT
      // kept (never clobber a possibly-good .bak with garbage). Best-effort — a .bak failure must never block the
      // real save.
      if (prior) {
        if (prior.status === 'ok' && !linkBackup(file)) {
          try {
            const cur = prior.raw != null ? prior.raw : fs.readFileSync(file, 'utf8');
            if (cur && String(cur).length) writeDurable(file + '.bak', cur);
          } catch (e) { failNote('savestore.bak', e); }
        }
      } else {
        try {
          const cur = fs.readFileSync(file, 'utf8');
          if (cur && String(cur).length) { try { JSON.parse(cur); writeDurable(file + '.bak', cur); } catch (_) {} }
        } catch (_) { /* no current main (first write) — nothing to back up */ }
      }
      writeDurable(file, JSON.stringify(value));   // atomic + durable replace of main
    }

    return {
      // HTTP callers must distinguish a missing station from temporarily inaccessible bytes.
      // Keep load()'s legacy optional-document shape for internal best-effort readers.
      // head (when provable): which window wrote the current doc and its request's updatedAt (see vouchedHead), so a
      // reopening page can tell whether its own cached save is newer or older than that write.
      loadState(agentId) {
        const r = readTagged(saveFile(agentId));
        const w = r.wrapper;
        const doc = w && typeof w === 'object' && w.doc && typeof w.doc === 'object' ? w.doc : undefined;
        const head = doc ? vouchedHead(r, w, num(doc._saveRevision)) : null;
        return head ? { status: r.status, doc, head } : { status: r.status, doc };
      },
      /* THE STATION FILE'S HEAD, cheaply (save-latch-kill: the crew roster's revision check, sidecar handleRoster): its
         revision and, when the store can prove it, the window that wrote it — from this process's own last write while nothing
         moved the file since (no read), else one read whose writer is proved the way GET /api/save proves it (vouchedHead).
         { revision, client } (client null = not provable) | { revision: 0, client: null, absent: true } | null (unreadable). */
      head(agentId) {
        const file = saveFile(agentId);
        const memo = lastWritten.get(file);
        if (memo && memo.stamp && memo.stamp === stamp(agentId)) return { revision: num(memo.revision), client: typeof memo.writer === 'string' ? memo.writer : null };
        const r = readTagged(file);
        if (r.status === 'absent') return { revision: 0, client: null, absent: true };
        if (r.status !== 'ok' && r.status !== 'recovered') return null;
        const doc = r.wrapper && typeof r.wrapper === 'object' && r.wrapper.doc && typeof r.wrapper.doc === 'object' ? r.wrapper.doc : null;
        if (!doc) return null;
        const revision = num(doc._saveRevision);
        const vouched = vouchedHead(r, r.wrapper, revision);
        return { revision, client: vouched ? vouched.client : null };
      },
      // the stored save envelope (the exact doc the frontend persisted), or undefined when there is none or
      // the file is unreadable/corrupt. Never throws on a bad file — a wiped agent reads as "nothing yet".
      load(agentId) {
        const w = readWrapper(saveFile(agentId));   // saveFile() validates the id (throws on traversal) before any read
        return (w && typeof w === 'object' && w.doc && typeof w.doc === 'object') ? w.doc : undefined;
      },

      /* A SAVE STAMP, so a reader can tell "the save has not changed since I projected it" without parsing it again
         (idle-cpu piece 2, 2026-10-19: GET /api/overseer re-parsed the whole 3.8 MB save on every 2.5 s poll per page).
         stamp() = this process's save count + the file's mtime (ns) + size + file id, from one stat (~0.2 ms). Every save
         here is a temp+rename, so it moves the file id and mtime; an outside edit moves mtime (and on NTFS the id). '' when
         there is no file or no stat: '' never matches, so a caller then reads afresh, exactly as without a stamp.
         loadStamped() = load()'s exact doc plus the stamp taken BEFORE the read, and only for a clean ('ok') read: an
         absent, locked, corrupt or .bak-recovered read stamps '' and is never memoized by anyone. The parsed doc itself is
         never cached here: it is ~4x the file in heap and ~15 load() callers would share one mutable object. */
      stamp,
      loadStamped(agentId) {
        const file = saveFile(agentId);
        const before = stamp(agentId);
        const r = readTagged(file);
        const w = (r.status === 'ok' || r.status === 'recovered') ? r.wrapper : undefined;
        return { doc: (w && typeof w === 'object' && w.doc && typeof w.doc === 'object') ? w.doc : undefined, stamp: r.status === 'ok' ? before : '' };
      },

      // persist the save envelope durably. Wrapped with the server receive time + the doc's own updatedAt so
      // a later read can compare freshness without parsing the frontend schema. ANTI-CLOBBER: if the incoming
      // doc is OLDER than what's on disk (updatedAt regressed), the write is refused — a stale background tab
      // can never overwrite a newer save. HTTP clients additionally use compareRevision to reject stale
      // snapshots even when they have a new timestamp; timestamp-only behavior remains for legacy internal callers.
      save(agentId, doc, options = {}) {
        if (!doc || typeof doc !== 'object') throw new Error('save: a doc object is required');
        const file = saveFile(agentId);   // validates the id (throws on traversal)
        /* THE MAIN THIS PROCESS JUST WROTE (perf review 10-19: ~3 parses, 3 stringifies and 2 fsyncs of the whole
           envelope per debounced persist, 121-161 ms at 5.8 MiB). When stamp() still equals the stamp taken right after
           this process's own last write of this file, the main IS that write — no other save and no outside edit moved
           it — so the anti-clobber facts it needs (updatedAt, the revision, the stored request's updatedAt) are known
           without reading and parsing the save again. Only an exact REPLAY can need the stored doc itself (the
           idempotency compare below), and a replay must carry the stored request's updatedAt: such a request, and any
           moved stamp, takes the full read exactly as before. */
        const memo = lastWritten.get(file);
        const known = (memo && memo.stamp && memo.stamp === stamp(agentId)
          && !(options.compareRevision && JSON.stringify(doc.updatedAt) === JSON.stringify(memo.replayAt))) ? memo : null;
        const prevRead = known ? { status: 'ok' } : readTagged(file, true);
        // CONSERVATIVE anti-clobber on an UNREADABLE prior: the file EXISTS but a non-ENOENT errno blocked the
        // read (locked/EBUSY/EACCES), so the bytes are probably a perfectly good — possibly NEWER — save we just
        // couldn't read this instant. We cannot prove this incoming write isn't a lower-progress overwrite, so we
        // refuse rather than blow it away (the Windows errno conflation would otherwise treat it as progress=0 and
        // always accept, silently wiping the record). A genuinely CORRUPT prior (read but garbage) still recovers-
        // over as before. Report unreadable distinctly so the caller can retry/surface.
        if (prevRead.status === 'unreadable') {
          try { console.warn('[savestore] refusing save for ' + String(agentId) + ' — existing record is unreadable (' + ((prevRead.err && prevRead.err.code) || 'EUNKNOWN') + '); not clobbering a possibly-newer save'); } catch (_) {}
          return { ok: false, stale: true, unreadable: true, updatedAt: 0 };
        }
        // a prior read cleanly ('ok') OR recovered from .bak ('recovered') is an authoritative prior for the
        // anti-clobber freshness gate — a torn main whose .bak we restored must still not be regressed.
        const prev = known ? undefined : ((prevRead.status === 'ok' || prevRead.status === 'recovered') ? prevRead.wrapper : undefined);
        const prevUpdated = known ? known.updatedAt : (prev && typeof prev === 'object' ? num(prev.updatedAt) : 0);
        const requestUpdatedAt = num(doc.updatedAt);
        let incomingUpdated = requestUpdatedAt;
        let seeded = false;   // this write re-seeded an empty station file from a copy (reported, so the page can say so)
        // the revision this file's lineage was re-seeded at (0 = never): every copy based on a revision below it is from
        // before the station file went missing. Kept in the wrapper (never the doc), so a restart still knows it.
        let seededRevision = known ? num(known.seededRevision) : num(prev && prev.seededRevision);
        // the window (_saveClient) whose copy re-seeded the file, so its own late-acknowledged seed is never blamed on another window
        let seededClient = known ? known.seededClient : (prev && typeof prev.seededClient === 'string' ? prev.seededClient : undefined);
        let explicitRestore = false;
        if (options.compareRevision) {
          /* AN EXPLICIT BACKUP RESTORE (backup.js importFile: CloudSave.push(doc, { restore: true }) stamps _saveRestore). The
             Commander chose to put that station back, so a reset generation's erase authority does not refuse it. A wire flag
             only: it never reaches the station file. */
          explicitRestore = doc._saveRestore === true;
          if (Object.prototype.hasOwnProperty.call(doc, '_saveRestore')) { doc = Object.assign({}, doc); delete doc._saveRestore; }
          const revision = known ? known.revision : num(prev && prev.doc && prev.doc._saveRevision);
          const expected = num(doc._saveRevision);
          // A replay of an acknowledged request (including a beacon racing fetch) is idempotent. The two JSON texts
          // can only be equal when the request's updatedAt is the stored request's (that key is in both), so that one
          // scalar is compared first and the two whole-envelope stringifies run only for a real replay candidate.
          const replayAt = prev ? (prev.requestUpdatedAt == null ? prevUpdated : prev.requestUpdatedAt) : undefined;
          const same = !known && prev && JSON.stringify(doc.updatedAt) === JSON.stringify(replayAt)
            && JSON.stringify(Object.assign({}, prev.doc, { updatedAt: replayAt, _saveRevision: expected, _saveDirty: false })) === JSON.stringify(Object.assign({}, doc, { _saveDirty: false }));
          if (same) return { ok: true, updatedAt: prevUpdated, revision };
          /* RE-SEED AN EMPTY STATION FILE (bug 5c019483). A copy based on a revision this file does not hold (a browser
             save at _saveRevision 23 after the workspace was wiped, moved or reset) used to read the MISSING file as
             revision 0 and land as a conflict snapshot — never the station — so every autosave was refused. When there is
             truly nothing here (no main AND no .bak: 'absent'; a locked, corrupt or .bak-recovered prior is not empty)
             the copy IS the station. A reset generation keeps its erase authority (above).
             THE SEED REVISION is one no window can hold. A seed at revision 1 made old numbers valid again: a second,
             stale window of the lost station frozen at R >= 1 (cloudsave keeps its revision after a conflict and stamps
             every later autosave with it) matched once the seeding window's autosaves reached R, and its stale snapshot
             replaced the newer station. The seed takes the clock (ms), far above any save count, and never below the
             copy's own number + 1, so revisions keep only going up and every pre-seed copy stays a conflict. */
          const absent = prevRead.status === 'absent';
          const seed = expected !== revision && absent;
          /* A RESET GENERATION REFUSES EVERY PRE-RESET COPY ON THE EMPTY FILE (review 10-23 #2), not only a seed: a copy at
             _saveRevision 0 founded before the receipt used to land as an ordinary first save. Only an explicit backup
             restore (above) or a station founded after the receipt writes the empty file. */
          const reset = absent && !explicitRestore && resetRefusesSeed(doc);
          /* THIS WINDOW'S OWN UNACKNOWLEDGED WRITE (support report 2026-10-21). A window gives up on a save after its
             acknowledgement deadline, but a busy station may still write it. The window keeps the old revision, so
             its next save arrives "behind" a head it wrote itself and was refused as another window's change. A
             window's id (_saveClient) is minted per page load, and a window only learns revisions from its own ACKs,
             so when the head is the write THIS process made for this same id (`known`: nothing moved the file since),
             every revision since `expected` is this window's own. Accept the save when it is also NEWER than that
             write's request (a delayed older request never replaces a newer one). A head this process cannot vouch
             for — an outside edit, a restart — stays a conflict: preserved, and restorable from the station. */
          /* …AND ACROSS A RESTART (support reports 10-15…10-25: one window, the station "went back"). The memo dies with
             the process, so a window that wrote the head, lost the ACK and then died (crash, power loss, a killed app)
             came back as a new window carrying its newer cached save on the old revision — refused, and every save after
             it refused too. The store's own wrapper now names the revision and window it wrote (`revision`, `client`);
             while the doc still carries both, the head is provably that window's write. An outside edit that moved the
             doc's revision or writer is not, and stays a conflict. */
          // Never across stations: the head and the request must be the same station's founding (agent.createdAt).
          const head = known ? { client: known.client, at: known.replayAt } : vouchedHead(prevRead, prev, revision);
          const ownHead = !!head && expected < revision && /^[A-Za-z0-9_-]{1,80}$/.test(String(doc._saveClient || ''))
            && doc._saveClient === head.client && num(requestUpdatedAt) > num(head.at)
            && sameFounding(foundedAt(doc), known ? known.founded : foundedAt(prev && prev.doc));
          if (reset || (expected !== revision && !ownHead && !seed)) {
            // Keep the rejected snapshot durably as well as the current station. Never silently
            // merge whole envelopes: removals and roster/config edits have conflicting semantics.
            const recovery = preserveCopy(String(agentId), doc);
            const refused = { ok: false, stale: true, conflict: true, revision, recovery, updatedAt: prevUpdated };
            if (reset) refused.reset = true;   // the station file is empty because it was RESET: no other window wrote it
            else {
              // this copy is from before the station file was re-seeded: by ANOTHER copy (saved back first, which says nothing
              // about which of the two holds newer work: the page must not call the station file newer), or by THIS window's
              // own copy whose acknowledgement it never heard (review 10-23 #6: never blamed on another window)
              // ownSeed only while the head IS that own write (its writer's _saveClient rides the stored doc): once another window
              // saved on top of it, this window is simply behind another window's newer save (review 10-23 r2, proofE)
              if (seededRevision > 0 && expected < seededRevision) {
                const headClient = known ? known.client : (prev && prev.doc ? prev.doc._saveClient : undefined);
                if (seededClient && seededClient === doc._saveClient) { if (headClient === doc._saveClient) refused.ownSeed = true; }
                else refused.reseeded = true;
              }
              // a copy from before this computer's station was reset, while the station is from after it: erased work, which a
              // restore refuses, so the page never offers one (review 10-23 #5)
              const stationFounded = known ? known.founded : foundedAt(prev && prev.doc);
              if (erasedWork(foundedAt(doc), stationFounded)) refused.predatesReset = true;
            }
            return refused;
          }
          seeded = seed;
          incomingUpdated = Math.max(incomingUpdated, prevUpdated + 1);
          /* EVERY write to an EMPTY file takes the clock revision (review 10-23 #2), never below the copy's own number + 1. A
             brand-new station's first save used to restart the line at revision 1, so a stale window of the station that was
             there before (a reset, a wipe), frozen at revision R, matched once the new station reached R and replaced it. A
             first save is still not called a re-seed: `seeded`/seededRevision stay the seed path's. */
          const nextRevision = absent ? Math.max(expected + 1, Math.floor(num(clock.now()))) : revision + 1;
          if (seed) { seededRevision = nextRevision; seededClient = /^[A-Za-z0-9_-]{1,80}$/.test(String(doc._saveClient || '')) ? doc._saveClient : undefined; }
          doc = Object.assign({}, doc, { updatedAt: incomingUpdated, _saveRevision: nextRevision, _saveDirty: false });
        }

        if (!options.compareRevision && (known || prev) && incomingUpdated < prevUpdated) return { ok: false, stale: true, updatedAt: prevUpdated };
        // this write may take the station somewhere it was not (see settledMemo): the boot offer's verdicts start over
        const priorFounded = known ? known.founded : foundedAt(prev && prev.doc);
        if (prevRead.status !== 'ok' || explicitRestore || !sameFounding(priorFounded, foundedAt(doc))) unsettle(String(agentId));
        lastWritten.delete(file);
        const writer = options.compareRevision && /^[A-Za-z0-9_-]{1,80}$/.test(String(doc._saveClient || '')) ? { revision: num(doc._saveRevision), client: doc._saveClient } : {};
        writeAtomic(file, { version: 1, agentId: String(agentId), updatedAt: incomingUpdated, savedAt: clock.now(), ...(options.compareRevision ? { requestUpdatedAt } : {}), ...writer, ...(options.compareRevision && seededRevision > 0 ? { seededRevision } : {}),
          ...(options.compareRevision && seededRevision > 0 && seededClient ? { seededClient } : {}), doc: doc },
          { status: prevRead.status, raw: prevRead.raw });
        writes++;
        recoveredMissing.delete(file);   // the main exists again and is this write
        const after = stamp(agentId);
        if (after) lastWritten.set(file, { stamp: after, updatedAt: incomingUpdated, revision: num(doc._saveRevision), replayAt: options.compareRevision ? requestUpdatedAt : incomingUpdated, seededRevision: options.compareRevision ? seededRevision : 0,
          seededClient: options.compareRevision && seededRevision > 0 ? seededClient : undefined, client: doc._saveClient, writer: writer.client || null, founded: foundedAt(doc) });
        return { ok: true, updatedAt: incomingUpdated, ...(options.compareRevision ? { revision: doc._saveRevision } : {}), ...(seeded ? { seeded: true } : {}) };
      },

      // the persisted quarantine/recovery marker for this agent's save (EL-11 FIX 2/3), or undefined when there
      // is none / it doesn't parse. { version, kind:'quarantined'|'recovered', at, quarantinedTo? }. Read-only —
      // the frontend shows the honest notice and then acks via clearRecoveryNotice().
      recoveryNotice(agentId) {
        const r = readTaggedRaw(recoveryFile(saveFile(agentId)));
        const w = (r.status === 'ok') ? r.wrapper : undefined;
        return (w && typeof w === 'object' && (w.kind === 'quarantined' || w.kind === 'recovered')) ? w : undefined;
      },

      // the user has SEEN the notice — remove the marker so it shows exactly once. Best-effort boolean.
      clearRecoveryNotice(agentId) {
        try {
          if (typeof fs.unlinkSync !== 'function') return false;
          fs.unlinkSync(recoveryFile(saveFile(agentId)));
          return true;
        } catch (_) { return false; }
      },

      // PRESERVED WINDOW SAVES (support report 2026-10-21): the snapshots a refused save leaves beside the station
      // file, newest first, so their sessions can be brought back. Read-only: a snapshot that does not parse is
      // skipped, never removed. `name` is a bare file name in the save root.
      conflicts(agentId) {
        const rows = [];
        for (const f of this.conflictFiles(agentId)) {
          const doc = this.readConflict(agentId, f.name);
          if (doc) rows.push({ name: f.name, mtimeMs: f.mtimeMs, doc });
        }
        return rows;
      },
      // the same list WITHOUT reading any snapshot (one readdir + a stat each): [{ name, mtimeMs, size }], newest first. The
      // boot offer reads snapshots one at a time from this and stops early (review 10-23 #3d).
      conflictFiles(agentId) {
        saveFile(agentId);   // validates the id before the name is used as a prefix
        const prefix = String(agentId) + '.save-conflict-';
        let names = [];
        try { names = fs.readdirSync(rootDir).filter(n => typeof n === 'string' && n.indexOf(prefix) === 0 && /\.json$/.test(n)); }
        catch (e) { if (!e || e.code !== 'ENOENT') failNote('savestore.conflicts.list', e); return []; }
        const rows = [];
        for (const name of names) {
          let mtimeMs = 0, size = 0;
          try { const s = fs.statSync(pathMod.join(rootDir, name)); mtimeMs = Number(s.mtimeMs) || 0; size = Number(s.size) || 0; } catch (e) { failNote('savestore.conflicts.stat', e); }
          rows.push({ name, mtimeMs, size });
        }
        return rows.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      },
      // the boot offer's settled memo (see settledMemo above; review 10-23 #3d, r2 #4/#5): settledConflicts(agentId) -> a
      // predicate over conflictFiles() rows, true for a snapshot found to bring nothing back and unchanged since.
      // settleConflicts(agentId, rows, present) records rows and persists the memo once, keeping only names still `present`
      // (conflictFiles() names). The banner's own restore and POST .../restore never consult it.
      settledConflicts(agentId) {
        saveFile(agentId);
        const m = settledMemo(String(agentId));
        return f => !!f && m.files.get(f.name) === num(f.mtimeMs) + ':' + num(f.size);
      },
      settleConflicts(agentId, rows, present) {
        saveFile(agentId);
        const m = settledMemo(String(agentId));
        let changed = false;
        for (const f of Array.isArray(rows) ? rows : []) {
          if (!f || typeof f.name !== 'string') continue;
          const key = num(f.mtimeMs) + ':' + num(f.size);
          if (m.files.get(f.name) !== key) { m.files.set(f.name, key); changed = true; }
        }
        if (Array.isArray(present)) { const keep = new Set(present); for (const name of Array.from(m.files.keys())) if (!keep.has(name)) { m.files.delete(name); changed = true; } }
        if (!changed) return false;
        const files = {};
        for (const [name, key] of m.files) files[name] = key;
        try { ensureRoot(); writeDurable(settledFile(agentId), JSON.stringify({ version: 1, receipt: m.receipt, files })); return true; }
        catch (e) { failNote('savestore.offer-settled.write', e); return false; }   // the in-process memo still holds it
      },
      // one preserved snapshot by its bare file name (this agent's conflict grammar only), or undefined when it is gone or
      // does not parse (never removed).
      readConflict(agentId, name) { return this.readConflictState(agentId, name).doc; },
      // the same read, TAGGED (the 0.14.0 boot offer was held for this): { status: 'ok', doc } | 'absent' (gone, or not this
      // agent's grammar) | 'corrupt' (read, but not a save object) | 'unreadable' (it is there, but a locked/EBUSY/EACCES read
      // failed this instant — it may still hold lost work, so a caller must never treat it as having nothing to offer)
      readConflictState(agentId, name) {
        saveFile(agentId);
        const prefix = String(agentId) + '.save-conflict-';
        if (typeof name !== 'string' || name.indexOf(prefix) !== 0 || !/^[A-Za-z0-9_.-]+\.json$/.test(name) || name.indexOf('..') >= 0) return { status: 'absent' };
        let raw;
        try { raw = fs.readFileSync(pathMod.join(rootDir, name), 'utf8'); }
        catch (e) {
          if (e && e.code === 'ENOENT') return { status: 'absent' };
          failNote('savestore.conflicts.read', e);
          return { status: 'unreadable' };
        }
        let doc;
        try { doc = JSON.parse(raw); } catch (e) { failNote('savestore.conflicts.read', e); return { status: 'corrupt' }; }
        return (doc && typeof doc === 'object' && !Array.isArray(doc)) ? { status: 'ok', doc } : { status: 'corrupt' };
      },
      // true when a preserved station copy is ERASED WORK: from before this computer's station was reset (the same proof
      // that refuses it as a re-seed) while the current `station` is from after the reset. Erased work is never offered back
      // or restored (#101 erase authority). A station that itself predates the reset (a restored backup of the old station)
      // makes its copies ordinary preserved work (review 10-23 #5). No `station` = there is no station file.
      predatesReset(doc, station) { return erasedWork(foundedAt(doc), station && typeof station === 'object' ? foundedAt(station) : undefined); },

      // keep a window's whole save beside the station file as a preserved copy (see preserveCopy): restorable and
      // downloadable like a refused save's snapshot. Returns its bare file name.
      preserve(agentId, doc) {
        saveFile(agentId);   // validates the id before it names a file
        if (!doc || typeof doc !== 'object') throw new Error('preserve: a doc object is required');
        return preserveCopy(String(agentId), doc);
      },

      // a durable copy of the current station file under <agentId>.save-before-<label>.json, taken before a restore
      // rewrites it. Returns the copy's name, or null when there is no station file to copy. Restore backups
      // (label restore-<ms>) keep only the newest RESTORE_BACKUP_KEEP, and never drop the one just written (review 10-23 #7).
      backup(agentId, label) {
        const file = saveFile(agentId);
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(label || ''))) throw new Error('backup: a label of [A-Za-z0-9_-] is required');
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
        const name = String(agentId) + '.save-before-' + label + '.json';
        ensureRoot();
        writeDurable(pathMod.join(rootDir, name), raw);
        const kind = /^(restore|adopt)-\d+$/.exec(String(label));
        if (kind) pruneRestoreBackups(String(agentId), name, kind[1]);
        return name;
      },

      _internals: { saveFile, AID_RE, num, readTagged, recoveryFile }
    };
  }

  return { makeSaveStore, _internals: { AID_RE, num } };
});
