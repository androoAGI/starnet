/* Durable, workspace-local recovery artifacts for model-visible tool/process output. */
'use strict';
const { note: failNote } = require('./failopen.js');

function makeOutputArtifacts(deps) {
  deps = deps || {};
  const fsp = deps.fsp;
  const fs = deps.fs;
  const P = deps.pathMod;
  const ROOT = deps.root;
  const crypto = deps.crypto || require('node:crypto');
  if (!fsp || !fs || !P || !ROOT) throw new Error('output artifacts require fsp, fs, pathMod, and root');

  function agent(id) {
    id = String(id || 'agent');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('bad agentId');
    return id;
  }
  function safe(value, max) { return String(value || 'output').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, max); }
  function paths(agentId, name) {
    const aid = agent(agentId);
    const rel = '.output/' + name + '.txt';
    return { rel, dir: P.join(ROOT, aid, '.output'), abs: P.join(ROOT, aid, rel) };
  }
  function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

  async function park(agentId, stem, content) {
    const text = String(content == null ? '' : content);
    const bytes = Buffer.from(text, 'utf8');
    const base = safe(stem, 120);
    let chosen = null, handle = null;
    await fsp.mkdir(P.join(ROOT, agent(agentId), '.output'), { recursive: true });
    for (let suffix = 0; ; suffix++) {
      chosen = paths(agentId, base + (suffix ? '-' + suffix : ''));
      try { handle = await fsp.open(chosen.abs, 'wx'); break; }
      catch (e) { if (e && e.code === 'EEXIST') continue; throw e; }
    }
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { if (handle) await handle.close(); }
    const actual = await fsp.readFile(chosen.abs);
    if (!Buffer.isBuffer(actual) || !actual.equals(bytes)) return null;
    return { path: chosen.rel, abs: chosen.abs, chars: text.length, bytes: bytes.length, sha256: digest(bytes) };
  }

  /* PARK ONCE (W1.8 cross-run replay). park() above names a file per call (a run id and a sequence), so the same body parked by
     two runs is two files. A replayed result is parked by its bytes instead: the caller puts a digest of them in the stem, the
     first replay writes the file (exclusive create, synced, read back), and every later replay of the same body finds it, reads
     it back and names the same file, so the stub that names it is the same bytes on every request (a stable cached prefix).
     A file at that name holding other bytes (edited since, or a write a crash cut short) is never handed out: null, and the
     caller keeps the stub without a handle. Never rewritten. Two parks of one name in this process wait on each other (one
     sidecar per workspace is the store's invariant, so an in-process wait is the whole race). */
  // abs path -> a promise that settles (never rejects) when the in-flight parkOnce of that name is over: the attempt's own
  // error goes to its own caller through `await job`, so a waiter only needs to know it ended, then reads the file afresh
  const parking = new Map();
  async function parkOnce(agentId, stem, content) {
    const text = String(content == null ? '' : content);
    const bytes = Buffer.from(text, 'utf8');
    const chosen = paths(agentId, safe(stem, 120));
    for (let prior = parking.get(chosen.abs); prior; prior = parking.get(chosen.abs)) await prior;
    const job = (async () => {
      await fsp.mkdir(chosen.dir, { recursive: true });
      let handle = null, reused = false;
      try { handle = await fsp.open(chosen.abs, 'wx'); }
      catch (e) { if (!e || e.code !== 'EEXIST') throw e; reused = true; }
      if (handle) {
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
      }
      const actual = await fsp.readFile(chosen.abs);
      if (!Buffer.isBuffer(actual) || !actual.equals(bytes)) return null;
      return { path: chosen.rel, abs: chosen.abs, chars: text.length, bytes: bytes.length, sha256: digest(bytes), reused };
    })();
    const over = job.then(() => true, () => false);
    parking.set(chosen.abs, over);
    try { return await job; }
    finally { if (parking.get(chosen.abs) === over) parking.delete(chosen.abs); }
  }

  function append(entry) {
    entry = entry || {};
    const name = safe(entry.kind, 24) + '-' + safe(entry.id, 72);
    const chosen = paths(entry.agentId, name);
    fs.mkdirSync(chosen.dir, { recursive: true });
    const bytes = Buffer.from(String(entry.text == null ? '' : entry.text), 'utf8');
    let originalSize = 0;
    try { originalSize = fs.statSync(chosen.abs).size; }
    catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
    let fd = null, readFd = null;
    try {
      fd = fs.openSync(chosen.abs, 'a');
      let offset = 0;
      while (offset < bytes.length) {
        const wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - offset) throw new Error('output append made no valid write progress');
        offset += wrote;
      }
      fs.fsyncSync(fd);
      const total = fs.statSync(chosen.abs).size;
      if (bytes.length) {
        const verify = Buffer.alloc(bytes.length);
        readFd = fs.openSync(chosen.abs, 'r');
        let offset = 0;
        while (offset < verify.length) {
          const read = fs.readSync(readFd, verify, offset, verify.length - offset, total - bytes.length + offset);
          if (!Number.isInteger(read) || read <= 0 || read > verify.length - offset) throw new Error('output append read-back mismatch');
          offset += read;
        }
        if (!verify.equals(bytes)) throw new Error('output append read-back mismatch');
      }
      return { path: chosen.rel, bytes: total };
    } catch (e) {
      // A failed verification must not poison the stable process artifact and let a later successful append
      // bless corrupt history. Roll the file back to the last verified byte boundary before surfacing failure.
      if (readFd != null) { try { fs.closeSync(readFd); } catch (closeErr) { failNote('output.rollback.read-close', closeErr); } readFd = null; }
      if (fd != null) { try { fs.closeSync(fd); } catch (closeErr) { failNote('output.rollback.write-close', closeErr); } fd = null; }
      let rollbackFd = null;
      try {
        // Windows refuses ftruncate on an append-open handle, so close it first and truncate by path.
        fs.truncateSync(chosen.abs, originalSize);
        rollbackFd = fs.openSync(chosen.abs, 'r+');
        fs.fsyncSync(rollbackFd);
      } catch (rollbackErr) { failNote('output.rollback.truncate', rollbackErr); }
      finally { if (rollbackFd != null) try { fs.closeSync(rollbackFd); } catch (closeErr) { failNote('output.rollback.sync-close', closeErr); } }
      throw e;
    } finally {
      if (readFd != null) try { fs.closeSync(readFd); } catch (_) {}
      if (fd != null) try { fs.closeSync(fd); } catch (_) {}
    }
  }

  /* STAGED APPENDS (perf review 10-19, background shell spill). append() above is one verified durable write — mkdir,
     stat, open, write, fsync, stat, open, read-back — 21-54 ms of synchronous I/O on the sidecar's only thread, and a
     background process paid it once per output CHUNK (the loop saturated near 48 chunks/s). A streaming writer splits
     the same guarantee in two:
       stage(entry)  writes the chunk through to the OS at once (open 'a' + write + close, well under 1 ms), so the bytes
                     survive a sidecar crash and are readable at the path immediately — exactly as with append().
       commit(entry) makes everything staged since the last commit durable with ONE fsync and verifies it by read-back.
     The caller says "durably appended" only for COMMITTED bytes (shellbg commits before every receipt it renders), so
     what a receipt claims is exactly as durable as before; only the fsync is shared across the chunks of one batch.
     Failure granularity matches append(): a failed write rolls the file back to the last fully staged boundary (that
     chunk alone is lost); a failed commit rolls back to the last COMMITTED boundary and throws. A file someone else
     truncated or deleted between chunks is re-based on what is actually on disk, like append() re-reads its size. */
  const spools = new Map();   // abs path -> { chosen, committed, staged: Buffer[], stagedBytes }
  function spoolFor(entry) {
    const chosen = paths(entry.agentId, safe(entry.kind, 24) + '-' + safe(entry.id, 72));
    let st = spools.get(chosen.abs);
    if (!st) {
      fs.mkdirSync(chosen.dir, { recursive: true });
      let size = 0;
      try { size = fs.statSync(chosen.abs).size; }
      catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      st = { chosen, committed: size, staged: [], stagedBytes: 0 };
      spools.set(chosen.abs, st);
    }
    return st;
  }
  function rollbackTo(abs, size, tag) {
    let rollbackFd = null;
    try {
      fs.truncateSync(abs, size);
      rollbackFd = fs.openSync(abs, 'r+');
      fs.fsyncSync(rollbackFd);
    } catch (rollbackErr) { failNote(tag, rollbackErr); }
    finally { if (rollbackFd != null) try { fs.closeSync(rollbackFd); } catch (closeErr) { failNote(tag + '-close', closeErr); } }
  }
  function stage(entry) {
    entry = entry || {};
    const st = spoolFor(entry);
    const bytes = Buffer.from(String(entry.text == null ? '' : entry.text), 'utf8');
    if (!bytes.length) return { path: st.chosen.rel, bytes: st.committed + st.stagedBytes };
    let fd = null, boundary = st.committed + st.stagedBytes;
    try {
      try { fd = fs.openSync(st.chosen.abs, 'a'); }
      catch (e) {
        if (!e || e.code !== 'ENOENT') throw e;
        fs.mkdirSync(st.chosen.dir, { recursive: true });   // the .output dir was removed mid-stream
        fd = fs.openSync(st.chosen.abs, 'a');
      }
      const onDisk = fs.fstatSync(fd).size;
      if (onDisk !== boundary) { st.committed = onDisk; st.staged = []; st.stagedBytes = 0; boundary = onDisk; }
      let offset = 0;
      while (offset < bytes.length) {
        const wrote = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(wrote) || wrote <= 0 || wrote > bytes.length - offset) throw new Error('output append made no valid write progress');
        offset += wrote;
      }
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (closeErr) { failNote('output.stage.write-close', closeErr); } fd = null; }
      rollbackTo(st.chosen.abs, boundary, 'output.stage.rollback');
      throw e;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch (closeErr) { failNote('output.stage.close', closeErr); }
    }
    st.staged.push(bytes);
    st.stagedBytes += bytes.length;
    return { path: st.chosen.rel, bytes: st.committed + st.stagedBytes };
  }
  function commit(entry) {
    entry = entry || {};
    const st = spoolFor(entry);
    if (!st.stagedBytes) return { path: st.chosen.rel, bytes: st.committed };
    const expect = st.staged.length === 1 ? st.staged[0] : Buffer.concat(st.staged, st.stagedBytes);
    let fd = null;
    try {
      // r+ (not r): Windows FlushFileBuffers needs a handle with write access
      fd = fs.openSync(st.chosen.abs, 'r+');
      fs.fsyncSync(fd);
      const total = fs.fstatSync(fd).size;
      if (total !== st.committed + expect.length) throw new Error('output append read-back mismatch');
      const verify = Buffer.alloc(expect.length);
      let offset = 0;
      while (offset < verify.length) {
        const read = fs.readSync(fd, verify, offset, verify.length - offset, st.committed + offset);
        if (!Number.isInteger(read) || read <= 0 || read > verify.length - offset) throw new Error('output append read-back mismatch');
        offset += read;
      }
      if (!verify.equals(expect)) throw new Error('output append read-back mismatch');
      st.committed = total; st.staged = []; st.stagedBytes = 0;
      return { path: st.chosen.rel, bytes: total };
    } catch (e) {
      if (fd != null) { try { fs.closeSync(fd); } catch (closeErr) { failNote('output.commit.close', closeErr); } fd = null; }
      rollbackTo(st.chosen.abs, st.committed, 'output.commit.rollback');
      st.staged = []; st.stagedBytes = 0;
      throw e;
    } finally {
      if (fd != null) try { fs.closeSync(fd); } catch (closeErr) { failNote('output.commit.close', closeErr); }
    }
  }
  // drop a finished stream's bookkeeping (the caller commits first; the file itself is untouched)
  function release(entry) {
    entry = entry || {};
    try { spools.delete(paths(entry.agentId, safe(entry.kind, 24) + '-' + safe(entry.id, 72)).abs); } catch (e) { failNote('output.release', e); }
  }

  return { park, parkOnce, append, stage, commit, release, _internals: { paths, safe, agent, spools } };
}

/* THE POINTER MUST RESOLVE WHERE IT IS READ (harness gauntlet G1, 2026-10-08). A park lands in the agent's private
   jail and is named relative to it (.output/…). In a project-scoped session a relative fs/shell path resolves
   against the PROJECT, so that pointer dangled and the model burned ~12 minutes hunting its own file. There the
   model is handed the absolute path instead — path trust already serves an agent's own workspace by absolute
   path, so this grants nothing new. Outside a project session the relative pointer is unchanged.
   The rule itself is the run's path object's (sidecar/run-paths.js placeJail); every run reads it from ctx.paths. This
   wrapper keeps the narrow .output/<file> form for a caller holding only loose facts, and adds no second copy. */
function visibleOutputPath(rel, o) {
  o = o || {};
  rel = String(rel == null ? '' : rel);
  const projectRoot = typeof o.projectRoot === 'string' ? o.projectRoot.trim() : '';
  const aid = String(o.agentId || 'agent');
  if (!projectRoot || !o.root || !o.pathMod || !/^\.output\/[^\\/]+$/.test(rel) || !/^[A-Za-z0-9_-]{1,40}$/.test(aid)) return rel;
  const RunPaths = require('./run-paths.js');
  try { return RunPaths.makeRunPaths(RunPaths.makeResolver({ pathMod: o.pathMod, root: String(o.root) }), { agentId: aid, projectRoot }).placeJail(rel); }
  catch (e) { failNote('output.visible-path', e); return rel; }   // a station-reserved id owns no workspace to point into
}

// A path inside an agent's parked-output folder, relative or absolute (visibleOutputPath hands out both).
function isParkedOutputPath(p) {
  return /(^|[\\/])\.output[\\/][^\\/]+\.txt$/.test(String(p || ''));
}

module.exports = { makeOutputArtifacts, visibleOutputPath, isParkedOutputPath };
