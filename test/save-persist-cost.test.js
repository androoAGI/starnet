/* node test/save-persist-cost.test.js — a debounced station persist (POST /api/save -> saveStore.save) no longer re-reads,
   re-parses and re-stringifies the whole save, and makes ONE durable write — with every anti-clobber rule intact.

   The bug (perf review 10-19, index.js POST /api/save): each persist read + parsed the current main (anti-clobber),
   stringified BOTH envelopes in full to test for an idempotent replay, read + parsed the main AGAIN to copy it to .bak
   through a second fsync'd write, then stringified + fsync'd the new main: ~3 parses, 3 stringifies and 2 fsyncs of the
   whole envelope, 121-161 ms at 5.8 MiB.

   Proves through the REAL savestore over the real fs (the store index.js's handler calls), compareRevision like the
   HTTP route:
     (1) a run of normal persists: zero reads of the main, one stringify, one durable write each;
     (2) the .bak is the previous committed save after every persist;
     (3) an exact replay of an acknowledged request is still idempotent (no write, same answer);
     (4) a stale revision still conflicts and keeps the rejected snapshot; an older updatedAt (legacy caller) is still
         refused;
     (5) a save replaced or torn behind the store is read in full again (the gates use what is really on disk). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSaveStore } = require('../sidecar/savestore.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-save-cost-'));
try {
  const file = path.join(root, 'agent.save.json');
  const c = { reads: 0, fsyncs: 0, bigStringify: 0 };
  // a durable write is the fsync of a TEMP's bytes before its rename: the directory fsync that makes the rename itself
  // durable on POSIX (persist writeAtomic) is part of that one write, so only fsyncs of fds opened on a .tmp path count
  const fdPath = new Map();
  const cfs = new Proxy(fs, { get(t, p) {
    if (p === 'readFileSync') return function (f) { if (String(f) === file) c.reads++; return t.readFileSync.apply(t, arguments); };
    if (p === 'openSync') return function (f) { const fd = t.openSync.apply(t, arguments); fdPath.set(fd, String(f)); return fd; };
    if (p === 'closeSync') return function (fd) { fdPath.delete(fd); return t.closeSync(fd); };
    if (p === 'fsyncSync') return function (fd) { if (/\.tmp$/.test(fdPath.get(fd) || '')) c.fsyncs++; return t.fsyncSync(fd); };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  const realStringify = JSON.stringify;
  JSON.stringify = function (v) { const out = realStringify.apply(JSON, arguments); if (typeof out === 'string' && out.length > 100000) c.bigStringify++; return out; };
  let T = 1000;
  const store = makeSaveStore({ fs: cfs, pathMod: path, root, clock: { now: () => ++T } });
  const workstreams = Array.from({ length: 120 }, (_, i) => ({ id: 'ws' + i, title: 'session ' + i, history: [{ role: 'user', content: 'y'.repeat(1500) }] }));
  const envelope = (updatedAt, rev, tag, client) => ({ schema: 'skynet.save', version: 9, updatedAt, _saveRevision: rev, _saveClient: client || 'tab1', agent: { id: 'agent', name: tag }, workstreams });

  let r = store.save('agent', envelope(100, 0, 'v0'), { compareRevision: true });
  A.ok(r.ok && r.revision >= 1000, 'first persist accepted (at the clock revision on an empty file, review 10-23 #2)');

  // ---- (1) + (2) ----
  let rev = r.revision;
  for (let i = 1; i <= 5; i++) {
    c.reads = 0; c.fsyncs = 0; c.bigStringify = 0;
    r = store.save('agent', envelope(100 + i * 10, rev, 'v' + i), { compareRevision: true });
    A.ok(r.ok && r.revision === rev + 1, 'persist ' + i + ' accepted');
    A.eq(c.reads, 0, 'persist ' + i + ' read the main 0 times (was 2 reads + 2 parses)');
    A.eq(c.bigStringify, 1, 'persist ' + i + ' stringified the envelope once (was 3 times)');
    A.eq(c.fsyncs, 1, 'persist ' + i + ' made one durable write (was two: the .bak copy + the main)');
    const bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    A.eq(bak.doc.agent.name, 'v' + (i - 1), '.bak holds the previous committed save after persist ' + i);
    rev = r.revision;
  }
  A.eq(store.load('agent').agent.name, 'v5', 'the main holds the last persist');

  // ---- (3) an exact replay of the last acknowledged request ----
  const replay = envelope(150, rev - 1, 'v5');
  const before = fs.readFileSync(file, 'utf8');
  r = store.save('agent', replay, { compareRevision: true });
  A.ok(r.ok && r.revision === rev, 'a replay of the acknowledged request answers ok with the same revision');
  A.eq(fs.readFileSync(file, 'utf8'), before, 'and writes nothing');

  // ---- (4) ----
  r = store.save('agent', envelope(999, rev - 2, 'stale-tab', 'tab2'), { compareRevision: true });   // another tab: every page mints its own id
  A.ok(!r.ok && r.conflict && r.stale, 'a stale revision still conflicts');
  A.ok(fs.existsSync(path.join(root, r.recovery)), 'and the rejected snapshot is kept durably');
  A.eq(store.load('agent').agent.name, 'v5', 'the station is untouched by the stale tab');
  const legacy = store.save('agent', envelope(1, 0, 'old'), {});
  A.ok(!legacy.ok && legacy.stale, 'a legacy write with an older updatedAt is still refused on the fast path');

  // ---- (5) ----
  const outside = JSON.parse(fs.readFileSync(file, 'utf8'));
  outside.doc._saveRevision = rev + 5; outside.doc.agent.name = 'outside';
  fs.writeFileSync(file + '.ext', realStringify(outside)); fs.renameSync(file + '.ext', file);
  c.reads = 0;
  r = store.save('agent', envelope(400, rev, 'mine'), { compareRevision: true });
  A.ok(c.reads >= 1, 'a save replaced behind the store is read in full again');
  A.ok(!r.ok && r.conflict, 'and its newer revision wins the anti-clobber gate (conflict, not a clobber)');
  A.eq(store.load('agent').agent.name, 'outside', 'the outside save is intact');
  const bakRev = JSON.parse(fs.readFileSync(file + '.bak', 'utf8')).doc._saveRevision;
  fs.writeFileSync(file, '{ torn');
  r = store.save('agent', envelope(500, bakRev, 'after-tear'), { compareRevision: true });
  A.ok(r.ok, 'a torn main recovers from .bak and the next persist lands');
  A.eq(store.load('agent').agent.name, 'after-tear', 'with the new content');
  JSON.stringify = realStringify;

  // ---- (6) the first v7 save keeps the last older file, ONCE: one extra durable write, and every save after it costs what it always did ----
  {
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-save-cost7-'));
    try {
      const file2 = path.join(root2, 'agent.save.json'), kept = path.join(root2, 'agent.save.pre-history-ref.json');
      const c2 = { reads: 0, fsyncs: 0, bigStringify: 0 }, fdPath2 = new Map();
      const cfs2 = new Proxy(fs, { get(t, p) {
        if (p === 'readFileSync') return function (f) { if (String(f) === file2) c2.reads++; return t.readFileSync.apply(t, arguments); };
        if (p === 'openSync') return function (f) { const fd = t.openSync.apply(t, arguments); fdPath2.set(fd, String(f)); return fd; };
        if (p === 'closeSync') return function (fd) { fdPath2.delete(fd); return t.closeSync(fd); };
        if (p === 'fsyncSync') return function (fd) { if (/\.tmp$/.test(fdPath2.get(fd) || '')) c2.fsyncs++; return t.fsyncSync(fd); };
        const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      JSON.stringify = function (v) { const out = realStringify.apply(JSON, arguments); if (typeof out === 'string' && out.length > 100000) c2.bigStringify++; return out; };
      let T2 = 1000;
      const store2 = makeSaveStore({ fs: cfs2, pathMod: path, root: root2, clock: { now: () => ++T2 } });
      const envelope2 = (version, rev, tag) => ({ schema: 'starnet.save', version, updatedAt: 100 + rev, _saveRevision: rev, _saveClient: 'tab1', agent: { id: 'agent', name: tag }, workstreams });
      let r2 = store2.save('agent', envelope2(6, 0, 'v6-0'), { compareRevision: true });
      let rev2 = r2.revision;
      for (let i = 1; i <= 2; i++) { c2.reads = 0; c2.fsyncs = 0; c2.bigStringify = 0; r2 = store2.save('agent', envelope2(6, rev2, 'v6-' + i), { compareRevision: true }); rev2 = r2.revision; }
      A.eq([c2.reads, c2.fsyncs, c2.bigStringify, fs.existsSync(kept)], [0, 1, 1, false], 'a v6 save costs what it always did and keeps nothing');
      c2.reads = 0; c2.fsyncs = 0; c2.bigStringify = 0;
      r2 = store2.save('agent', envelope2(7, rev2, 'v7-first'), { compareRevision: true }); rev2 = r2.revision;
      A.ok(r2.ok && fs.existsSync(kept), 'the first v7 save lands and keeps the older station file');
      A.eq(c2.fsyncs, 2, 'the first v7 save makes ONE extra durable write (the kept copy), then the main as always');
      A.ok(c2.reads <= 1 && c2.bigStringify <= 2, 'and reads the main at most once (to copy it) and stringifies at most twice (' + c2.reads + ' reads, ' + c2.bigStringify + ' stringifies)');
      A.eq(JSON.parse(fs.readFileSync(kept, 'utf8')).doc.agent.name, 'v6-2', 'the kept copy is the v6 file it replaced');
      const keptBytes = fs.readFileSync(kept, 'utf8');
      for (let i = 1; i <= 4; i++) {
        c2.reads = 0; c2.fsyncs = 0; c2.bigStringify = 0;
        r2 = store2.save('agent', envelope2(7, rev2, 'v7-' + i), { compareRevision: true }); rev2 = r2.revision;
        A.ok(r2.ok, 'v7 persist ' + i + ' accepted');
        A.eq([c2.reads, c2.fsyncs, c2.bigStringify], [0, 1, 1], 'v7 persist ' + i + ' costs what a persist always did: no read of the main, one stringify, one durable write');
      }
      A.eq(fs.readFileSync(kept, 'utf8'), keptBytes, 'and the kept copy was written once');
    } finally { JSON.stringify = realStringify; try { fs.rmSync(root2, { recursive: true, force: true }); } catch (_) {} }
  }

  // ---- (7) a save that names its rows (save v7, step S5) costs what a save that repeats them costs: no read of the main, one stringify, one durable write ----
  {
    const HR = require('../frontend/app/historyref.js');
    const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-save-cost-packed-'));
    try {
      const file3 = path.join(root3, 'agent.save.json');
      const c3 = { reads: 0, fsyncs: 0, bigStringify: 0 }, fdPath3 = new Map();
      const cfs3 = new Proxy(fs, { get(t, p) {
        if (p === 'readFileSync') return function (f) { if (String(f) === file3) c3.reads++; return t.readFileSync.apply(t, arguments); };
        if (p === 'openSync') return function (f) { const fd = t.openSync.apply(t, arguments); fdPath3.set(fd, String(f)); return fd; };
        if (p === 'closeSync') return function (fd) { fdPath3.delete(fd); return t.closeSync(fd); };
        if (p === 'fsyncSync') return function (fd) { if (/\.tmp$/.test(fdPath3.get(fd) || '')) c3.fsyncs++; return t.fsyncSync(fd); };
        const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      JSON.stringify = function (v) { const out = realStringify.apply(JSON, arguments); if (typeof out === 'string' && out.length > 100000) c3.bigStringify++; return out; };
      let T3 = 1000;
      const store3 = makeSaveStore({ fs: cfs3, pathMod: path, root: root3, clock: { now: () => ++T3 } });
      // 120 sessions whose records are big enough to count (a long title each) and whose histories are one reference each
      const rowsOf = i => Array.from({ length: 6 }, (_, j) => ({ rowId: i * 10 + j + 1, streamId: 'p' + i, role: j % 2 ? 'assistant' : 'user', kind: 'turn', ts: 1000 + j, content: 'line ' + i + '.' + j }));
      const packedSessions = Array.from({ length: 120 }, (_, i) => ({ id: 'p' + i, title: 'session ' + i + ' ' + 'z'.repeat(1000),
        history: HR.pack(rowsOf(i), { streamId: 'p' + i, seal: k => { const id = Number(k.split(':')[1]); return rowsOf(i).find(r => r.rowId === id) || null; } }) }));
      A.ok(packedSessions.every(w => w.history.length === 1 && typeof w.history[0].$ref === 'string'), '(fixture) every history is one reference');
      const envelope3 = (rev, tag) => ({ schema: 'starnet.save', version: 7, updatedAt: 100 + rev, _saveRevision: rev, _saveClient: 'tab1', agent: { id: 'agent', name: tag }, workstreams: packedSessions });
      let r3 = store3.save('agent', envelope3(0, 'p0'), { compareRevision: true });
      let rev3 = r3.revision;
      for (let i = 1; i <= 4; i++) {
        c3.reads = 0; c3.fsyncs = 0; c3.bigStringify = 0;
        r3 = store3.save('agent', envelope3(rev3, 'p' + i), { compareRevision: true }); rev3 = r3.revision;
        A.ok(r3.ok, 'packed persist ' + i + ' accepted');
        A.eq([c3.reads, c3.fsyncs, c3.bigStringify], [0, 1, 1], 'packed persist ' + i + ' costs what a persist always did: no read of the main, one stringify, one durable write');
      }
      A.eq(store3.load('agent').workstreams[7].history[0].$ref, packedSessions[7].history[0].$ref, 'the station file keeps the references as bytes (it reads nothing of them)');
    } finally { JSON.stringify = realStringify; try { fs.rmSync(root3, { recursive: true, force: true }); } catch (_) {} }
  }
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}
A.report('save-persist-cost.test');
