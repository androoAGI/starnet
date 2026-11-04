/* sidecar/deliverable-store.js — durable lifecycle index for Workshop deliverables.

   Run artifacts already live in runs.jsonl and pending Workshop builds already live in the Workshop backlog.
   This store records only the truth those authorities otherwise erase: kept/discarded/failed lifecycle rows and
   bounded cleanup undo batches. It owns metadata, never artifact bytes. */
'use strict';

const { makeDurableJsonStore } = require('./durable-store.js');
const { note: failNote } = require('./failopen.js');   // tagged SYNC swallow: a fail-open catch must never be invisible
const { writeFileDurable } = require('./durable-write.js');
const persist = require('./persist/index.js');   // the journal's tagged read and its forensic copy

// Sets, not object literals: `({a:1})['constructor']` is truthy, so an object-literal allowlist
// silently admits every Object.prototype key — and these keys come off persisted/model-supplied data.
// 'implemented' = a PLAN the Commander pressed Implement on: it was acted on and produced a build, but nothing
// was copied out of the jail, so it is deliberately not 'kept' (which asserts files landed in a folder).
// NOTE: an unrecognised status is coerced to 'failed' below — a new status MUST be added here or the library
// will quietly report success as failure.
const STATUS = new Set(['kept', 'implemented', 'discarded', 'failed']);
const SOURCE_MAX = 40, TEXT_MAX = 260, UNDO_CAP = 20, FILE_CAP = 50;
// CLEARED (2026-10-10, Andrew: "users can wipe them out if done"): ids the Commander cleared out of the library view.
// Library-only — the files on disk, the run log and any lifecycle row are untouched, so a clear is always undoable
// and can never destroy work. The id set is uncapped for the same reason lifecycle rows are: dropping the oldest
// would silently bring a cleared deliverable back.
const CLEAR_ID_MAX = 200;
const COMPACT_BYTES = 8 * 1024 * 1024;

function text(v, n) { return String(v == null ? '' : v).slice(0, n || TEXT_MAX); }
function filesOf(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, FILE_CAP).map(f => {
    const row = { path: text(f && f.path) };
    if (f && Number.isFinite(f.bytes) && f.bytes >= 0) row.bytes = Math.floor(f.bytes);
    return row;
  }).filter(f => f.path);
}
function rowOf(v, now) {
  v = v && typeof v === 'object' ? v : {};
  const id = text(v.id);
  if (!id) return null;
  return {
    id,
    agentId: text(v.agentId, 40), runId: text(v.runId, 80), title: text(v.title, 200),
    source: text(v.source || 'workshop', SOURCE_MAX), status: STATUS.has(v.status) ? v.status : 'failed',
    kind: text(v.kind || 'files', 20), summary: text(v.summary, 1000), files: filesOf(v.files),
    createdAt: Number(v.createdAt) || Number(now) || 0, updatedAt: Number(now) || Number(v.updatedAt) || 0
  };
}
function normalize(v) {
  const s = v && typeof v === 'object' ? v : {};
  // Never cap lifecycle rows: a kept row is the durable pointer to user-created work.
  // Growth is bounded by append-log compaction, not by deleting the oldest deliverable.
  const rows = Array.isArray(s.rows) ? s.rows.map(r => rowOf(r, r && r.updatedAt)).filter(Boolean) : [];
  const undo = Array.isArray(s.undo) ? s.undo.filter(x => x && x.token && Array.isArray(x.rows)).slice(-UNDO_CAP) : [];
  const cleared = Array.isArray(s.cleared) ? Array.from(new Set(s.cleared.map(id => text(id, CLEAR_ID_MAX)).filter(Boolean))) : [];
  const clearUndo = Array.isArray(s.clearUndo) ? s.clearUndo.filter(x => x && x.token && Array.isArray(x.ids)).slice(-UNDO_CAP) : [];
  return { v: 2, appliedSeq: Math.max(0, Number(s.appliedSeq) || 0), rows, undo, cleared, clearUndo };
}
function fingerprint(rows) {
  return rows.map(r => [r.id, r.status, r.updatedAt].join(':')).sort().join('|');
}

function makeDeliverableStore(deps) {
  deps = deps || {};
  if (!deps.path || !deps.workspaces) throw new Error('makeDeliverableStore: path/workspaces required');
  const durable = makeDurableJsonStore({
    fs: deps.fs, path: deps.path,
    fileFor: () => deps.path.join(deps.workspaces, 'deliverables.library.json'),
    writeDurable: deps.writeDurable, onRecover: deps.onRecover, onCorrupt: deps.onCorrupt
  });
  const KEY = 'deliverables';
  const fs = deps.fs, pathMod = deps.path;
  const journalFile = pathMod.join(deps.workspaces, 'deliverables.library.jsonl');
  const durableWrite = typeof deps.writeDurable === 'function' ? deps.writeDurable : writeFileDurable;
  const canAppend = fs && typeof fs.openSync === 'function' && typeof fs.writeSync === 'function'
    && typeof fs.fsyncSync === 'function' && typeof fs.closeSync === 'function';
  let state = null, nextSeq = 1, journalOps = 0;
  // appendHold: why appends wait (a torn journal tail not yet kept and cut), else null. tornKept: that tail's copy, once
  // made, so a cut that failed is retried without copying the same bytes again.
  let appendHold = null, tornKept = null;

  function applyOp(s, op) {
    if (!op || Number(op.seq) <= Number(s.appliedSeq || 0)) return s;
    if (op.op === 'upsert') {
      const clean = rowOf(op.row, op.row && op.row.updatedAt);
      if (clean) {
        const i = s.rows.findIndex(r => r.id === clean.id);
        if (i >= 0) { clean.createdAt = s.rows[i].createdAt || clean.createdAt; s.rows[i] = clean; }
        else s.rows.push(clean);
      }
    } else if (op.op === 'cleanup') {
      const ids = new Set(Array.isArray(op.rows) ? op.rows.map(r => r && r.id).filter(Boolean) : []);
      s.rows = s.rows.filter(r => !ids.has(r.id));
      s.undo = s.undo.filter(b => b.token !== op.token);
      s.undo.push({ token: text(op.token, 100), at: Number(op.at) || 0, rows: (op.rows || []).map(r => rowOf(r, r && r.updatedAt)).filter(Boolean) });
      while (s.undo.length > UNDO_CAP) s.undo.shift();
    } else if (op.op === 'clear') {
      const ids = Array.isArray(op.ids) ? op.ids.map(id => text(id, CLEAR_ID_MAX)).filter(Boolean) : [];
      const had = new Set(s.cleared), added = ids.filter(id => !had.has(id));
      for (const id of added) { s.cleared.push(id); had.add(id); }
      s.clearUndo = s.clearUndo.filter(b => b.token !== op.token);
      s.clearUndo.push({ token: text(op.token, 100), at: Number(op.at) || 0, ids: added });   // undo restores only what THIS clear hid
      while (s.clearUndo.length > UNDO_CAP) s.clearUndo.shift();
    } else if (op.op === 'unclear') {
      const i = s.clearUndo.findIndex(b => b.token === op.token);
      if (i >= 0) { const back = new Set(s.clearUndo[i].ids); s.clearUndo.splice(i, 1); s.cleared = s.cleared.filter(id => !back.has(id)); }
    } else if (op.op === 'forget') {
      // the forget registry's purge: the rows it names leave the library AND the undo batches that hold their copies
      const ids = new Set(Array.isArray(op.ids) ? op.ids.map(id => text(id)) : []);
      s.rows = s.rows.filter(r => !ids.has(r.id));
      s.undo = s.undo.map(b => Object.assign({}, b, { rows: b.rows.filter(r => !ids.has(r.id)) })).filter(b => b.rows.length);
    } else if (op.op === 'undo') {
      const i = s.undo.findIndex(b => b.token === op.token);
      if (i >= 0) {
        const batch = s.undo[i]; s.undo.splice(i, 1);
        for (const old of batch.rows) if (!s.rows.some(r => r.id === old.id)) {
          const row = rowOf(old, old.updatedAt || op.at); if (row) s.rows.push(row);
        }
      }
    }
    s.appliedSeq = Number(op.seq) || s.appliedSeq;
    return s;
  }
  function unreadable(file, err) {
    const e = new Error('deliverables: ' + file + ' cannot be read right now (' + ((err && err.code) || 'EUNKNOWN') + '); nothing was loaded or cached, and the next read tries again');
    e.code = 'ESTORE_UNREADABLE'; e.cause = err; e.file = file;
    return e;
  }
  /* The snapshot through the store's own read policy (a torn main is moved aside, a good .bak recovers it) and the
     journal through persist's errno policy: a file that is present but cannot be read (EBUSY/EACCES/EPERM) throws
     ESTORE_UNREADABLE, never an empty library, and nothing is cached, so the real rows read back once the lock clears. */
  function load() {
    if (state) return state;
    const snap = durable.readKey(KEY);
    if (snap.status === 'unreadable') throw unreadable(snap.problemFile || pathMod.join(deps.workspaces, 'deliverables.library.json'), snap.err);
    const journal = persist.readTagged({ fs }, journalFile, { text: true });
    if (journal.status === 'unreadable') throw unreadable(journalFile, journal.err);
    const s = normalize(snap.status === 'ok' || snap.status === 'recovered' ? snap.value : null);
    const raw = journal.status === 'ok' ? journal.value : '';
    const validLines = [];
    let torn = false, next = 1, ops = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let op; try { op = JSON.parse(line); } catch (_) { torn = true; break; }
      if (!op || op.v !== 2 || !(Number(op.seq) > 0)) { torn = true; break; }
      validLines.push(line);
      next = Math.max(next, Number(op.seq) + 1); ops++;
      applyOp(s, op);
    }
    appendHold = (torn && canAppend) ? cutTornTail(raw, validLines) : null;
    nextSeq = Math.max(nextSeq, next, s.appliedSeq + 1);
    journalOps = ops;
    // a torn tail not yet kept and cut: the proven rows are served, nothing is cached, and appends wait (commit)
    if (!appendHold) state = s;
    return s;
  }
  /* Keep the torn bytes, then cut the active append path to the proven prefix: otherwise every later valid append would
     sit after the torn line and disappear again on the next restart, because replay correctly stops at the first
     untrusted record. The copy is persist's first-free <journal>.corrupt-<n> made by an exclusive COPY (the journal is
     appended in place, so a shared inode would change the copy), and the cut happens only once that copy exists.
     Returns null once cut, else why appends must wait: nothing was cut, and the next load tries again. */
  function cutTornTail(raw, validLines) {
    const kept = tornKept && tornKept.bytes === raw.length && (typeof fs.existsSync !== 'function' || fs.existsSync(tornKept.to));
    if (!kept) {
      const copy = persist.preserve({ fs }, journalFile, persist.names.LABELS.CORRUPT, { copyOnly: true });
      if (!copy.ok) {
        const why = copy.error || new Error('the torn journal could not be kept');
        failNote('deliverables.journal.quarantine', why);
        return why;
      }
      tornKept = { bytes: raw.length, to: copy.to };
    }
    try { durableWrite({ fs, path: pathMod }, journalFile, validLines.join('\n') + (validLines.length ? '\n' : '')); }
    catch (e) { failNote('deliverables.journal.cut', e); return e; }
    tornKept = null;
    return null;
  }
  function appendLine(op) {
    fs.mkdirSync(deps.workspaces, { recursive: true });
    const data = Buffer.from(JSON.stringify(op) + '\n', 'utf8');
    let fd = null, at = 0;
    try {
      fd = fs.openSync(journalFile, 'a');
      while (at < data.length) { const n = fs.writeSync(fd, data, at, data.length - at, null); if (!(n > 0)) throw new Error('deliverable journal short write'); at += n; }
      fs.fsyncSync(fd);
    } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) {} }
  }
  function maybeCompact(s) {
    if (!canAppend) return;
    let bytes = 0; try { bytes = fs.statSync(journalFile).size; } catch (_) {}
    // Compact only when both byte growth and duplicate-operation growth prove it useful.
    // The snapshot retains every live row and bounded undo batch; appliedSeq makes replay
    // idempotent if power fails between snapshot replacement and journal truncation.
    if (bytes < COMPACT_BYTES || journalOps < s.rows.length * 2 + 1000) return;
    durable.set(KEY, s);
    durableWrite({ fs, path: pathMod }, journalFile, '');
    journalOps = 0;
  }
  function commit(op) {
    const s = load();
    if (appendHold) {
      const e = new Error('deliverables: the journal ' + journalFile + ' has a torn tail that could not be kept and cut yet; nothing was appended, and the next load tries again');
      e.code = 'ESTORE_CORRUPT'; e.cause = appendHold;
      throw e;
    }
    op = Object.assign({ v: 2, seq: nextSeq++ }, op);
    if (canAppend) { appendLine(op); journalOps++; applyOp(s, op); maybeCompact(s); }
    else { applyOp(s, op); durable.set(KEY, s); }
    return s;
  }
  function read() {
    const s = load();
    return normalize({ appliedSeq: s.appliedSeq, rows: s.rows, undo: s.undo, cleared: s.cleared, clearUndo: s.clearUndo });
  }
  function list() { return read().rows.slice().sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id)).map(r => Object.assign({}, r, { files: r.files.map(f => Object.assign({}, f)) })); }
  function record(row, now) {
    const clean = rowOf(row, now);
    if (!clean) return Promise.reject(new Error('deliverable id required'));
    // the forget registry's write-time gate (deps.admit): a lifecycle row for a run whose session was deleted is not written
    if (typeof deps.admit === 'function' && !deps.admit(clean)) return Promise.resolve(null);
    return durable.mutex.run(KEY, async () => { commit({ op: 'upsert', row: clean }); return clean; });
  }
  function previewCleanup(opts) {
    opts = opts || {};
    const wanted = Array.isArray(opts.statuses) && opts.statuses.length ? opts.statuses.filter(s => STATUS.has(s)) : ['discarded', 'failed'];
    const all = list();
    const targets = all.filter(r => wanted.indexOf(r.status) >= 0);
    const protectedRows = all.filter(r => wanted.indexOf(r.status) < 0);
    return { statuses: wanted, targets, protected: protectedRows, fingerprint: fingerprint(targets) };
  }
  function applyCleanup(preview, token, now) {
    preview = preview || {};
    token = text(token, 100);
    if (!token) return Promise.resolve({ ok: false, reason: 'undo-token-required' });
    let out = { ok: false, reason: 'preview-stale' };
    return durable.mutex.run(KEY, async () => {
      const s = load();
      const wanted = Array.isArray(preview.statuses) ? preview.statuses.filter(x => STATUS.has(x)) : [];
      const current = s.rows.filter(r => wanted.indexOf(r.status) >= 0);
      if (fingerprint(current) !== String(preview.fingerprint || '')) return out;
      commit({ op: 'cleanup', token, at: Number(now) || 0, rows: current });
      out = { ok: true, removed: current.length, undoToken: token };
      return out;
    });
  }
  function undoCleanup(token, now) {
    token = text(token, 100);
    let out = { ok: false, reason: 'not-found', restored: 0 };
    return durable.mutex.run(KEY, async () => {
      const s = load();
      const i = s.undo.findIndex(b => b.token === token);
      if (i < 0) return out;
      const restored = s.undo[i].rows.filter(old => !s.rows.some(r => r.id === old.id)).length;
      commit({ op: 'undo', token, at: Number(now) || 0 });
      out = { ok: true, restored };
      return out;
    });
  }
  /* forget(match) -> Promise<number>: the forget registry's purge. Every library row `match(row)` names, and its copy in a cleanup undo
     batch, is removed. The journal still holds those rows' earlier upsert lines and the snapshot's .bak the old rows, so the state is folded
     into the snapshot now (twice: the second write makes the .bak the purged copy too) and the journal is emptied - the same sequence the
     size-triggered compaction runs, applied at once. */
  function forget(match) {
    return durable.mutex.run(KEY, async () => {
      const s = load();
      const ids = new Set();
      for (const r of s.rows) if (match(r)) ids.add(r.id);
      for (const b of s.undo) for (const r of b.rows) if (match(r)) ids.add(r.id);
      if (!ids.size) return 0;
      commit({ op: 'forget', ids: Array.from(ids) });
      durable.set(KEY, s); durable.set(KEY, s);
      if (canAppend) { durableWrite({ fs, path: pathMod }, journalFile, ''); journalOps = 0; }
      return ids.size;
    });
  }
  function clearedIds() { return new Set(load().cleared); }
  // clear(ids) hides library rows; the caller (the route) decides WHICH ids are eligible against the live library.
  function clear(ids, token, now) {
    token = text(token, 100);
    const want = Array.from(new Set((Array.isArray(ids) ? ids : []).map(id => text(id, CLEAR_ID_MAX)).filter(Boolean)));
    if (!token) return Promise.resolve({ ok: false, reason: 'undo-token-required', cleared: 0 });
    return durable.mutex.run(KEY, async () => {
      const had = new Set(load().cleared), fresh = want.filter(id => !had.has(id));
      if (!fresh.length) return { ok: true, cleared: 0, undoToken: '' };
      commit({ op: 'clear', token, at: Number(now) || 0, ids: fresh });
      return { ok: true, cleared: fresh.length, undoToken: token };
    });
  }
  function unclear(token, now) {
    token = text(token, 100);
    return durable.mutex.run(KEY, async () => {
      const b = load().clearUndo.find(x => x.token === token);
      if (!b) return { ok: false, reason: 'not-found', restored: 0 };
      commit({ op: 'unclear', token, at: Number(now) || 0 });
      return { ok: true, restored: b.ids.length };
    });
  }
  return { read, list, record, forget, previewCleanup, applyCleanup, undoCleanup, clear, unclear, clearedIds, _durable: durable };
}

module.exports = { makeDeliverableStore, normalize };
