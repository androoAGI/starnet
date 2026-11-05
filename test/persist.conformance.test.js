/* node test/persist.conformance.test.js — sidecar/persist: one write, read, quarantine and name policy, and the SAME
   normalized outcome from every store built on it, under every fault (persist-module lane: INV-1 to INV-6).

   THE FAMILIES IT CLOSES
     75558694  a failed or crashed write left its temp behind, and nothing ever swept one                         (INV-2)
     e862d9ff  a second quarantine after a restart replaced the first copy; a failed move still named a destination (INV-3)
     34c58f4f  a torn main, with or without a .bak, was replaced with no copy kept; a writer that never read a locked
               file replaced it; a locked full-state load was silent                                       (INV-4, INV-5 read)

   WHAT RUNS
   1. Primitives (persist only): writeAtomic leaves no temp after a rename, short-write, write or fsync failure; a crash
      at every write point (a facade that is dead after the kill) reboots onto the old or the new bytes and the next
      write leaves no temp; the sweeper's liveness and staleness rules and what it never touches; first-free numbering
      across restarts; moveAside/preserve honesty; every linkSync errno of the no-hard-links family; readTagged's kinds
      and the unread mark; replaceJson's D1/D2; the names grammar.
   2. The store matrix: the general durable-store and the full-state stores, each built exactly as sidecar/index.js
      composes them (makeDurableJsonStore with the update-frozen writer and the host's quarantineCorrupt as onCorrupt;
      persist.host's loadResilient/saveResilient), the channel store's chat map and transcripts (makeChannelStore with
      that writer, through loadChatMap/saveChatRecord and loadHistory/appendTurn), the station save (makeSaveStore,
      through loadState and save(): a preservation it cannot make is its unreadable refusal) and the deliverables
      library's snapshot (makeDeliverableStore, through read() and compaction's durable.set), against every fault
      row, with hard links working and again with linkSync failing as EPERM, ENOTSUP, ENOSYS, EXDEV, EINVAL and EISDIR
      (FAT/exFAT and friends). A row speaks in values (V0..V3) and raw torn bytes; each store keeps a value in its own
      record format. Every store must give the row's expected normalized outcome:
        read  = value:<V> | empty | refused:unreadable
        write = ok | refused:unreadable | refused:corrupt | refused:unseen | threw:<errno>
        plus the main, the .bak and the forensic copies (byte-exact) afterwards, and never a temp.
      Then a crash at every write point of each store's write, and the read-modify-write paths (durable-store update()
      and the channel store's callers re-read before they write, so they carry prior bytes in the main; update() keeps
      an unhandled corrupt record a refusal; a locked channel file is a typed refusal, never empty).
   3. Files written by the base code, legacy siblings beside them, read back unchanged.
   4. The composition manifest: index.js binds persist.host with the options this suite composes, its writer is the
      update freeze over durable-write, and no sidecar composition of makeDurableJsonStore, makeChannelStore,
      makeSaveStore, makeDeliverableStore or makeRunJournal passes an option the matrix lacks.
   5. The journals and recovery files: run journals (a quarantine is the first free .corrupt-<n> and honest when it
      cannot be made; a journal that cannot be read is never repaired or moved aside; a failed or crashed repair leaves
      no temp), the deliverables journal (a torn tail is kept before it is cut, or nothing is cut and appends wait; a
      locked snapshot or journal is a typed refusal that caches nothing), the recovery request (workspace-recovery) and
      the START FRESH marker (workspace-lineage): a crash at every write point, a torn write included, leaves the old or
      the new bytes and the next write leaves no temp (INV-2, INV-3, INV-5).
   6. The names golden table: every sibling name persist or a legacy writer makes beside six store files, as
      station-recovery's bundle policy and workspace-lineage's evidence read it (INV-6).

   On a tree without sidecar/persist (the base this suite is proved RED on) the primitive rows report the module
   missing, and the store rows run that tree's own code: index.js's inline quarantineCorrupt/loadResilient/
   saveResilient, sliced from its source and run as written, and the stores' own modules. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./_assert.js');
const src = require('./helpers/source.js');
const failopen = require('../sidecar/failopen.js');
const DS = require('../sidecar/durable-store.js');
const { writeFileDurable: writeFileDurableRaw } = require('../sidecar/durable-write.js');
const { makeChannelStore } = require('../sidecar/channels/store.js');
const { makeSaveStore } = require('../sidecar/savestore.js');
const { makeDeliverableStore } = require('../sidecar/deliverable-store.js');
const RJ = require('../sidecar/run-journal.js');
const Recovery = require('../sidecar/workspace-recovery.js');
const SR = require('../sidecar/station-record.js');
const StationRecovery = require('../sidecar/station-recovery.js');

let persist = null, missing = '';
try { persist = require('../sidecar/persist/index.js'); }
catch (e) { missing = (e && e.code) || String(e); }
function havePersist(section) {
  if (persist) return true;
  A.ok(false, section + ': sidecar/persist is missing (' + missing + ')');
  return false;
}
const reset = () => { if (persist) persist._resetForTests(); };   // a fresh process: the per-process memos go

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-persist-conformance-'));
let seq = 0;
const fresh = name => { const d = path.join(ROOT, (++seq) + '-' + String(name).replace(/[^\w.-]+/g, '_').slice(0, 60)); fs.mkdirSync(d, { recursive: true }); return d; };
const injected = (code, op) => Object.assign(new Error('injected ' + code + (op ? ' (' + op + ')' : '')), { code });
const J = v => JSON.stringify(v);
const V0 = { k: 'zero' }, V1 = { k: 'one', a: 1, b: 2 }, V2 = { k: 'two', c: 3 }, V3 = { k: 'three' };

// the host and failNote are loud on purpose; the matrix runs hundreds of faults, so their lines are held here
function quiet(fn) {
  const w = console.warn, e = console.error;
  console.warn = console.error = () => {};
  try { return fn(); } finally { console.warn = w; console.error = e; }
}
async function quietly(fn) {
  const w = console.warn, e = console.error;
  console.warn = console.error = () => {};
  try { return await fn(); } finally { console.warn = w; console.error = e; }
}
function section(name, fn) {
  try { return fn(); } catch (e) { A.ok(false, name + ' threw: ' + ((e && e.stack) || e)); }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
// a pid that is provably dead (a crashed writer's temp carries one) and STAYS dead for the whole run: past every OS's
// pid range (Linux pid_max is at most 2^22, macOS's 99998, Windows hands out small multiples of 4), so no process
// started meanwhile can be given it. An exited child's pid was used before, but on a busy Windows box that pid went to a
// new process mid-run, and the sweeper then (rightly) kept that live writer's temp.
const DEAD = (() => {
  const pid = 2147483644;
  if (alive(pid)) throw new Error('no provably dead pid (' + pid + ' answers kill(0))');
  return pid;
})();
const LIVE = process.pid;

/* ---- the fault facade: the real fs, linkSync per the link mode, and a row's rules (op -> (args, ctx) -> code) ---- */
const LINK_MODES = ['link', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EINVAL', 'EISDIR'];
const WRAPPED = ['readFileSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'openSync', 'writeSync', 'fsyncSync', 'closeSync', 'linkSync'];
function facade(linkMode, rules) {
  const io = Object.create(fs);
  const r = rules || {};
  const fds = new Map();
  const ctx = { pathOf: fd => fds.get(fd) || '' };
  for (const op of WRAPPED) {
    const real = fs[op];
    io[op] = function () {
      const args = Array.from(arguments);
      if (op === 'linkSync' && linkMode !== 'link') throw injected(linkMode, op);
      const code = r[op] ? r[op](args, ctx) : null;
      if (code === 'NO-PROGRESS') return 0;
      if (code) throw injected(code, op);
      const out = real.apply(fs, args);
      if (op === 'openSync') fds.set(out, String(args[0]));
      return out;
    };
  }
  return io;
}
// a process that dies at its killAt-th mutating call: that call and every later call of any kind throws
const MUTATING = new Set(['openSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'linkSync', 'unlinkSync', 'copyFileSync', 'writeFileSync', 'mkdirSync']);
function killable(io, killAt) {
  const state = { calls: 0, dead: false };
  const proxy = new Proxy(io, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return function () {
        if (state.dead) throw injected('KILLED', String(k));
        if (MUTATING.has(k) && ++state.calls === killAt) { state.dead = true; throw injected('KILLED', String(k)); }
        return v.apply(t, arguments);
      };
    }
  });
  return { io: proxy, state };
}
// killable, and a write that is killed tears: its first half is on disk first (power lost part-way through a write)
function tearing(io, killAt) {
  const state = { calls: 0, dead: false };
  const proxy = new Proxy(io, {
    get(t, k) {
      const v = t[k];
      if (typeof v !== 'function') return v;
      return function () {
        if (state.dead) throw injected('KILLED', String(k));
        if (MUTATING.has(k) && ++state.calls === killAt) {
          state.dead = true;
          const a = Array.from(arguments);
          if (k === 'writeSync' && Buffer.isBuffer(a[1])) {
            const off = a[2] || 0, len = a[3] == null ? a[1].length - off : a[3];
            if (len > 1) t.writeSync(a[0], a[1], off, Math.floor(len / 2), a[4]);
          } else if (k === 'writeFileSync') {
            const data = Buffer.isBuffer(a[1]) ? a[1] : Buffer.from(String(a[1]));
            if (data.length > 1) t.writeFileSync(a[0], data.subarray(0, Math.floor(data.length / 2)), a[2]);
          }
          throw injected('KILLED', String(k));
        }
        return v.apply(t, arguments);
      };
    }
  });
  return { io: proxy, state };
}

/* ---- what is on disk beside a store file ---- */
const FORENSIC_NAME = /\.(?:corrupt(?:-\d+(?:-\d+)?)?|unseen-\d+)$/;
const TEMP_NAME = /\.tmp$|\.tmp-\d+-\d+-\d+$|\.repair-[0-9a-f]+$/i;
function look(file) {
  const dir = path.dirname(file), base = path.basename(file);
  const all = fs.readdirSync(dir).filter(n => n === base || n.indexOf(base + '.') === 0).sort();
  const text = n => fs.readFileSync(path.join(dir, n), 'utf8');
  const pick = n => (all.indexOf(n) >= 0 ? text(n) : '-');
  return {
    main: pick(base),
    bak: pick(base + '.bak'),
    forensic: all.filter(n => FORENSIC_NAME.test(n)).map(n => n.slice(base.length + 1) + '=' + text(n)),
    temps: all.filter(n => TEMP_NAME.test(n))
  };
}

/* ---- the composition sidecar/index.js binds ---- */
const INDEX = src.readSidecarIndex();   // deliberately index.js itself: this suite pins how index.js composes its stores
const HOST_BINDING = "const { quarantineCorrupt, readResilient, loadResilient, saveResilient } = require('./persist/index.js').host({ fs: fs, path: path, writeDurable: writeFileDurable });";
function hostFor(deps) {
  if (persist && INDEX.includes(HOST_BINDING)) return persist.host(deps);
  // a tree without the binding (the base this suite is proved RED on): index.js's own inline functions, run as written
  const body = ['quarantineCorrupt', 'loadResilient', 'saveResilient'].map(n => src.functionSourceIn(INDEX, n)).join('\n');
  const make = new Function('fs', 'path', 'readJsonResilient', 'writeJsonResilient', 'writeFileDurable',
    'let _quarantineSeq = 0;\n' + body + '\nreturn { quarantineCorrupt, loadResilient, saveResilient };');
  return make(deps.fs, deps.path, DS.readJsonResilient, DS.writeJsonResilient, deps.writeDurable);
}
// index.js function writeFileDurable: the update freeze over durable-write (the manifest below pins that shape)
function frozenWriter(state) {
  return function writeFileDurable(deps, file, data) {
    if (state.frozen) throw Object.assign(new Error('durable writes are frozen for update'), { code: 'UPDATE_MUTATIONS_FROZEN' });
    return writeFileDurableRaw(state.pid ? Object.assign({}, deps, { pid: state.pid }) : deps, file, data);
  };
}
const KEY = 'store';
const VALUES = { V0, V1, V2, V3 };
const SYMS = Object.keys(VALUES);
// a symbol of VALUES when `json` is that value as `enc` writes it, else the JSON itself
const nameOf = (enc, json) => SYMS.find(s => enc(s) === json) || json;
const CLOCK = { now: () => 1 };   // savedAt, lastSeen and ts are part of the bytes compared
function compose(io, dir, opts) {
  const o = opts || {};
  const state = { frozen: !!o.frozen, pid: o.pid || 0 };
  const writeFileDurable = frozenWriter(state);
  const host = hostFor({ fs: io, path: path, writeDurable: writeFileDurable });
  // the shape of every general store index.js composes (widgets, plugin-data, app-data, away-briefing; the factories
  // pass the same options through)
  const general = DS.makeDurableJsonStore({
    fs: io, path: path,
    fileFor: () => path.join(dir, KEY + '.json'),
    writeDurable: writeFileDurable,
    onRecover: (key, file) => console.warn('[widgets] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.'),
    onCorrupt: (key, file) => host.quarantineCorrupt(file, 'widgets')
  });
  return { host, general, state, file: path.join(dir, KEY + '.json') };
}
// the channel store exactly as index.js composes it (its update-frozen writer, an observer onRecover). limits { maxTurns:
// 1 } is the history's own trim, no persistence option: it makes one appendTurn replace the transcript's content, so
// the history rows compare whole files like every other store (index.js keeps the default 40 turns, as 2d does).
function composeChannels(io, dir, opts) {
  const o = opts || {};
  const state = { frozen: !!o.frozen, pid: o.pid || 0 };
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {} };   // no clock advances in the store matrix
  const store = makeChannelStore({ fs: io, pathMod: path, root: dir, clock: CLOCK, writeDurable: frozenWriter(state), timers, holding: () => state.frozen,
    onRecover: file => console.warn('[channels] recovered ' + file + ' from .bak last-known-good after a torn/corrupt main.'),
    limits: { maxTurns: o.maxTurns || 1 } });
  return { store, state };
}
// the station save store exactly as index.js composes it: no writer option (a station save's update freeze is the HTTP
// mutation gate, 423), so it writes through persist itself
function composeSave(io, dir) {
  const founded = [];
  // Observe accepted-save notifications here; the lifecycle owner's durable founding is covered by station-record
  // and start-fresh-generation HTTP. Its actual reset projection still reads the same record through the fault facade.
  const resetAt = () => SR.read({ fs: io, path, workspaceRoot: dir, now: CLOCK.now }).resetAt();
  return { founded, save: makeSaveStore({ fs: io, pathMod: path, root: dir, clock: CLOCK, resetAt, onFounded: w => founded.push(w.agentId) }) };
}
// the deliverables library exactly as index.js composes it (its update-frozen writer, an observer onRecover, the host's
// quarantineCorrupt as onCorrupt): its snapshot is read by load() (with the journal beside it) and written by compaction
function composeDeliverables(io, dir, opts) {
  const o = opts || {};
  const state = { frozen: !!o.frozen, pid: o.pid || 0 };
  const writeFileDurable = frozenWriter(state);
  const host = hostFor({ fs: io, path: path, writeDurable: writeFileDurable });
  const store = makeDeliverableStore({ fs: io, path: path, workspaces: dir, writeDurable: writeFileDurable,
    onRecover: (key, file) => console.warn('[deliverables] recovered ' + file + ' from .bak last-known-good.'),
    onCorrupt: (key, file) => host.quarantineCorrupt(file, 'deliverables') });
  return { store, state };
}
// a read through a store API that throws its refusals (the channel store): the same normalized outcome
function readThrough(fn) {
  try { return fn(); }
  catch (e) { return (e && e.code === 'ESTORE_UNREADABLE') ? 'refused:unreadable' : 'threw:' + ((e && e.code) || (e && e.message) || e); }
}
function written(fn) {
  try { fn(); return 'ok'; }
  catch (e) {
    const c = e && e.code;
    if (c === 'ESTORE_UNREADABLE') return 'refused:unreadable';
    if (c === 'ESTORE_CORRUPT') return 'refused:corrupt';
    if (c === 'ESTORE_UNSEEN') return 'refused:unseen';
    return 'threw:' + (c || (e && e.message) || e);
  }
}
/* Every store of the matrix, in its own record format. A row speaks in symbols (V0..V3 = VALUES) and raw torn bytes:
     file(dir)          the store's file in a row's folder
     compose(io, dir)   the store as index.js composes it, over the row's fault facade
     enc(sym)           the exact bytes this store keeps for that value (seeds are written with it; what is on disk
                        afterwards is read back into symbols with it)
     read(c)            value:<sym> | empty | refused:unreadable (value:<json> for a value no symbol names)
     write(c, sym)      ok | refused:unreadable | refused:corrupt | refused:unseen | threw:<errno>
     seen               a read-modify-write store: every write re-reads the file first (never a blind writer, so D2 has
                        nothing to keep; what it read rides in the main or becomes the .bak) */
const enc = s => J(VALUES[s]);
const chatEnc = s => J({ version: 1, chats: { c: { k: VALUES[s].k, lastSeen: 1 } } });
const historyEnc = s => J({ version: 1, messages: [{ role: 'user', content: VALUES[s].k, ts: 1 }] });
const UPDATED = { V0: 10, V1: 11, V2: 12, V3: 13 };   // each value's updatedAt: a row's write is always newer than its seed
const saveDoc = s => ({ updatedAt: UPDATED[s], k: VALUES[s].k });
const saveEnc = s => J({ version: 1, agentId: 'agent', updatedAt: UPDATED[s], savedAt: 1, doc: saveDoc(s) });
// one library row per value, in the store's normalized shape (key order included), so read() gives these exact bytes
const delivRow = s => ({ id: 'd', agentId: 'agent', runId: 'r', title: VALUES[s].k, source: 'workshop', status: 'kept', kind: 'files', summary: '', files: [], createdAt: 1, updatedAt: UPDATED[s] });
const delivEnc = s => J({ v: 2, appliedSeq: 0, rows: [delivRow(s)], undo: [], cleared: [], clearUndo: [] });
const KINDS = {
  general: {
    file: dir => path.join(dir, KEY + '.json'), compose, enc,
    read(c) {
      const r = c.general.readKey(KEY);
      if (r.status === 'ok' || r.status === 'recovered') return 'value:' + nameOf(enc, J(r.value));
      return r.status === 'unreadable' ? 'refused:unreadable' : 'empty';
    },
    write(c, s) { return written(() => c.general.set(KEY, VALUES[s])); }
  },
  'full-state': {
    file: dir => path.join(dir, KEY + '.json'), compose, enc,
    read(c) {
      const before = failopen.counts()['persist.load.unreadable'] || 0;
      const v = c.host.loadResilient(c.file, 'dossier');
      if (v !== undefined) return 'value:' + nameOf(enc, J(v));
      return (failopen.counts()['persist.load.unreadable'] || 0) > before ? 'refused:unreadable' : 'empty';
    },
    write(c, s) { return written(() => c.host.saveResilient(c.file, VALUES[s])); }
  },
  // channels/store: one chat record ('c') in chatmap.json, through loadChatMap and saveChatRecord (its merge keeps no key
  // of an earlier value here: every value is { k } plus the lastSeen the store stamps)
  'channels chatmap': {
    seen: true, file: dir => path.join(dir, 'chatmap.json'), compose: composeChannels, enc: chatEnc,
    read(c) {
      return readThrough(() => {
        const map = c.store.loadChatMap();
        return Object.keys(map.chats).length ? 'value:' + nameOf(chatEnc, J(map)) : 'empty';
      });
    },
    write(c, s) { return written(() => c.store.saveChatRecord('c', { k: VALUES[s].k })); },
    base: { main: '{"version":1,"chats":{"77":{"agentId":"tg_77","channel":"telegram","lastSeen":1700000000000}}}', bak: '{"version":1,"chats":{}}' }
  },
  // channels/store: an agent's transcript (h.history.json), through loadHistory and appendTurn
  'channels history': {
    seen: true, file: dir => path.join(dir, 'h.history.json'), compose: composeChannels, enc: historyEnc,
    read(c) {
      return readThrough(() => {
        const messages = c.store.loadHistory('h');
        return messages.length ? 'value:' + nameOf(historyEnc, J({ version: 1, messages })) : 'empty';
      });
    },
    write(c, s) { return written(() => c.store.appendTurn('h', 'user', VALUES[s].k)); },
    base: {
      main: '{"version":1,"messages":[{"role":"user","content":"hello","ts":1700000000000},{"role":"assistant","content":"hi there","ts":1700000000001}]}',
      bak: '{"version":1,"messages":[{"role":"user","content":"hello","ts":1700000000000}]}'
    }
  },
  // savestore: the station file (agent.save.json) through loadState and save(), on the anti-clobber path every write
  // passes (each is newer than what it replaces; the revision CAS of the HTTP route is the save tests' own)
  savestore: {
    seen: true, file: dir => path.join(dir, 'agent.save.json'), compose: composeSave, enc: saveEnc,
    skip: { 'update freeze': 'index.js composes saveStore without the host writer: a station save is frozen by the HTTP mutation gate (423)' },
    read(c) {
      const r = c.save.loadState('agent');
      if (r.status === 'unreadable') return 'refused:unreadable';
      return r.doc ? 'value:' + nameOf(s => J(saveDoc(s)), J(r.doc)) : 'empty';
    },
    write(c, s) {
      let r;
      const before = c.founded.length;
      try { r = c.save.save('agent', saveDoc(s)); }
      catch (e) { A.eq(c.founded.length, before, 'a thrown save never sends a founding notification'); return 'threw:' + ((e && e.code) || (e && e.message) || e); }
      A.eq(c.founded.length - before, r && r.ok === true ? 1 : 0, 'only a durably accepted save notifies the lifecycle owner');
      if (r && r.ok === true) return 'ok';
      if (r && r.quarantineFailed) return 'refused:corrupt';   // { ok:false, stale:true, unreadable:true, quarantineFailed:true }
      if (r && r.unreadable) return 'refused:unreadable';
      return 'refused:' + J(r);
    },
    // a station file as the base code wrote it (HTTP wrapper fields included), and base savestore's own numbered quarantine
    base: {
      main: '{"version":1,"agentId":"agent","updatedAt":5,"savedAt":1700000000000,"requestUpdatedAt":5,"revision":3,"client":"tab1","doc":{"schema":"starnet.save","updatedAt":5,"_saveRevision":3,"_saveClient":"tab1","agent":{"id":"agent","name":"Kept"}}}',
      bak: '{"version":1,"agentId":"agent","updatedAt":4,"savedAt":1699999999000,"doc":{"schema":"starnet.save","updatedAt":4,"agent":{"id":"agent","name":"Kept"}}}',
      reads: 'value:{"schema":"starnet.save","updatedAt":5,"_saveRevision":3,"_saveClient":"tab1","agent":{"id":"agent","name":"Kept"}}',
      legacy: { 'corrupt-1': 'LEGACY savestore quarantine', '2.tmp': 'LEGACY savestore temp' },
      next: 'corrupt-2'
    }
  },
  // deliverable-store: the library snapshot (deliverables.library.json), read through read() (load: the snapshot, then
  // its journal, which these rows leave absent; section 5 has the journal's own rows) and written by the snapshot's one
  // writer, compaction's durable.set of the whole state, on the store's own composed durable store
  'deliverables snapshot': {
    file: dir => path.join(dir, 'deliverables.library.json'), compose: composeDeliverables, enc: delivEnc,
    read(c) {
      return readThrough(() => {
        const s = c.store.read();
        return s.rows.length ? 'value:' + nameOf(delivEnc, J(s)) : 'empty';
      });
    },
    write(c, s) { return written(() => c.store._durable.set('deliverables', JSON.parse(delivEnc(s)))); },
    // a snapshot as the base code's compaction wrote it (normalize's shape)
    base: {
      main: '{"v":2,"appliedSeq":3,"rows":[{"id":"workshop:agent:r1","agentId":"agent","runId":"r1","title":"Report","source":"nightshift","status":"kept","kind":"files","summary":"","files":[{"path":"report.md","bytes":12}],"createdAt":100,"updatedAt":100}],"undo":[],"cleared":["run:a"],"clearUndo":[]}',
      bak: '{"v":2,"appliedSeq":1,"rows":[],"undo":[],"cleared":[],"clearUndo":[]}'
    }
  }
};
// a seed or an expectation: a symbol's bytes in this store's format, else the raw bytes themselves
const bytesOf = (kind, x) => (Object.prototype.hasOwnProperty.call(VALUES, x) ? kind.enc(x) : x);
// what is on disk beside a store's file, in symbols
function lookAs(kind, file) {
  const l = look(file);
  const sym = b => (b === '-' ? b : nameOf(kind.enc, b));
  return { main: sym(l.main), bak: sym(l.bak), forensic: l.forensic.map(f => { const i = f.indexOf('='); return f.slice(0, i + 1) + sym(f.slice(i + 1)); }), temps: l.temps };
}

function canon(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }
function same(got, want, label) {
  const sub = {};
  for (const k of Object.keys(want)) sub[k] = got[k];
  A.eq(canon(sub), canon(want), label);
}

(async () => {
  try {
    /* ============================== 1. PRIMITIVES ============================== */
    if (havePersist('1 primitives')) quiet(() => section('1 primitives', () => {
      const P = persist;

      // 1a. INV-2: no failed write leaves its temp (rename refused by a lock, short write, write error, fsync error)
      for (const [label, rules, code] of [
        ['rename refused', f => ({ renameSync: a => a[1] === f ? 'EPERM' : null }), 'EPERM'],
        ['short write', () => ({ writeSync: () => 'NO-PROGRESS' }), 'ESHORTWRITE'],
        ['write error', () => ({ writeSync: () => 'EIO' }), 'EIO'],
        ['fsync error', () => ({ fsyncSync: (a, ctx) => (/\.tmp$/.test(ctx.pathOf(a[0])) ? 'EIO' : null) }), 'EIO']
      ]) {
        const file = path.join(fresh('wa-' + label), 'a.json');
        fs.writeFileSync(file, J(V1));
        reset();
        let err = null;
        try { P.writeAtomic({ fs: facade('link', rules(file)), path }, file, J(V2)); } catch (e) { err = e; }
        A.eq(err && err.code, code, 'INV-2 writeAtomic, ' + label + ': the error reaches the caller');
        A.eq([look(file).main, look(file).temps], [J(V1), []], 'INV-2 writeAtomic, ' + label + ': the old bytes stay and no temp is left');
      }
      {
        const file = path.join(fresh('wa-facade'), 'a.json');
        fs.writeFileSync(file, J(V1));
        const io = Object.create(fs); io.fsyncSync = undefined; io.renameSync = () => { throw injected('EPERM', 'renameSync'); };
        let err = null;
        try { P.writeAtomic({ fs: io, path }, file, J(V2)); } catch (e) { err = e; }
        A.eq([err && err.code, look(file).temps], ['EPERM', []], 'INV-2 writeAtomic without fsync (a facade): a refused rename removes its temp too');
      }

      // 1b. INV-2: a crash at every write point reboots onto the old or the new bytes; the next write sweeps the dead temp
      {
        const ref = killable(facade('link', {}), 0);
        const refFile = path.join(fresh('wa-crash-ref'), 'a.json');
        fs.writeFileSync(refFile, J(V1));
        reset();
        P.writeAtomic({ fs: ref.io, path, pid: DEAD }, refFile, J(V2));
        const points = ref.state.calls;
        A.ok(points >= 6, 'writeAtomic has its write points (open, write, fsync, close, rename, directory sync): ' + points);
        let leftTemp = 0;
        for (let k = 1; k <= points; k++) {
          const file = path.join(fresh('wa-crash-' + k), 'a.json');
          fs.writeFileSync(file, J(V1));
          reset();
          const killed = killable(facade('link', {}), k);
          try { P.writeAtomic({ fs: killed.io, path, pid: DEAD }, file, J(V2)); } catch (_) { /* the process died here */ }
          if (look(file).temps.length) leftTemp++;
          reset();   // the reboot
          const boot = fs.readFileSync(file, 'utf8');
          A.ok(boot === J(V1) || boot === J(V2), 'INV-2 writeAtomic killed at write point ' + k + ': the reboot reads the old or the new bytes, got ' + boot);
          P.writeAtomic({ fs, path }, file, J(V3));
          A.eq([look(file).main, look(file).temps], [J(V3), []], 'INV-2 writeAtomic killed at write point ' + k + ': the next write lands and leaves no temp');
        }
        A.ok(leftTemp > 0, 'the crash rows are real: ' + leftTemp + ' kill point(s) left a dead writer\'s temp for the reboot to sweep');
      }

      // 1c. the sweeper: dead pid, or a legacy name 10 minutes stale; never another file's temps, a live writer's
      //     temp (even an old one), a .bak or a forensic copy
      {
        const dir = fresh('sweep');
        const file = path.join(dir, 'a.json');
        fs.writeFileSync(path.join(dir, 'clock-probe'), 'x');
        const oldSec = (fs.statSync(path.join(dir, 'clock-probe')).mtimeMs - P.STALE_MS - 60000) / 1000;
        const plant = (name, stale) => { const p = path.join(dir, name); fs.writeFileSync(p, name); if (stale) fs.utimesSync(p, oldSec, oldSec); return name; };
        const gone = [
          plant('a.json.' + DEAD + '.d1ad.tmp'),                   // own grammar, dead writer
          plant('a.json.8.tmp', true),                              // legacy savestore/channels temp, stale
          plant('a.json.tmp-123-456-2', true),                      // legacy workspace-recovery temp, stale
          plant('a.json.repair-cd34', true)                         // legacy run-journal repair temp, stale
        ];
        const kept = [
          plant('a.json.' + LIVE + '.01d.tmp', true),               // a paused live writer still owns an old temp
          plant('a.json.' + LIVE + '.11fe.tmp'),                    // a live writer's fresh temp
          plant('a.json.7.tmp'), plant('a.json.tmp-123-456-1'), plant('a.json.repair-ab12'),   // legacy, fresh
          plant('b.json.' + DEAD + '.0e1.tmp', true),               // another file's temp, dead and stale
          plant('a.json.bak.' + DEAD + '.ba4.tmp', true),           // the .bak's temp is another file's
          plant('a.json.' + DEAD + '.x.y.tmp'),                     // not the own grammar (a dotted nonce), fresh
          plant('a.json.bak', true), plant('a.json.corrupt-1', true), plant('a.json.unseen-1', true),
          plant('a.json.corrupt', true), plant('a.json.corrupt-4242-1', true)
        ];
        reset();
        P.writeAtomic({ fs, path }, file, J(V1));
        const names = fs.readdirSync(dir);
        for (const n of gone) A.ok(names.indexOf(n) < 0, 'INV-2 the sweeper removes ' + n);
        for (const n of kept) A.ok(names.indexOf(n) >= 0, 'INV-2 the sweeper never touches ' + n);
        const pausedTemp = path.join(dir, 'a.json.' + LIVE + '.01d.tmp');
        if (fs.existsSync(pausedTemp)) {
          fs.renameSync(pausedTemp, path.join(dir, 'resumed.json'));
          A.eq(fs.readFileSync(path.join(dir, 'resumed.json'), 'utf8'), path.basename(pausedTemp), 'INV-2 the paused writer can still finish its old temp after another write sweeps');
        }
        const late = plant('a.json.' + DEAD + '.1a7e.tmp');
        P.writeAtomic({ fs, path }, file, J(V2));
        A.ok(fs.existsSync(path.join(dir, late)), 'the sweep runs once per file per process: a temp that appears later waits');
        reset();
        P.writeAtomic({ fs, path }, file, J(V3));
        A.ok(!fs.existsSync(path.join(dir, late)), '...for the next process\'s first write of that file');

        const dir2 = fresh('sweep-one-readdir');
        fs.writeFileSync(path.join(dir2, 'c.json.' + DEAD + '.dead.tmp'), 'x');
        let readdirs = 0;
        const counted = Object.create(fs);
        counted.readdirSync = function () { readdirs++; return fs.readdirSync.apply(fs, arguments); };
        reset();
        for (const n of ['a.json', 'b.json', 'c.json']) for (const v of [V1, V2]) P.writeAtomic({ fs: counted, path }, path.join(dir2, n), J(v));
        A.eq(readdirs, 1, 'one readdir per directory per process, however many files are written there');
        A.ok(!fs.existsSync(path.join(dir2, 'c.json.' + DEAD + '.dead.tmp')), 'a later file in that directory is still swept from the one listing');

        const dir3 = fresh('sweep-guarded');
        fs.writeFileSync(path.join(dir3, 'a.json.' + DEAD + '.dead.tmp'), 'x');
        const noList = Object.create(fs); noList.readdirSync = undefined;
        reset();
        A.notThrows(() => P.writeAtomic({ fs: noList, path }, path.join(dir3, 'a.json'), J(V1)), 'a facade without readdirSync is written, never swept');
        A.ok(fs.existsSync(path.join(dir3, 'a.json.' + DEAD + '.dead.tmp')), '...and its directory is left alone');
        const stuck = Object.create(fs);
        stuck.unlinkSync = p => { if (/\.tmp$/.test(String(p))) throw injected('EACCES', 'unlinkSync'); return fs.unlinkSync(p); };
        const n0 = failopen.counts()['persist.sweep.unlink'] || 0;
        reset();
        A.notThrows(() => P.writeAtomic({ fs: stuck, path }, path.join(dir3, 'a.json'), J(V2)), 'a sweep that cannot unlink never fails the write');
        A.eq((failopen.counts()['persist.sweep.unlink'] || 0) - n0, 1, '...and is noted (persist.sweep.unlink), never silent');
      }

      // 1d. INV-3: first-free numbering across restarts; legacy copies are kept and never counted; a gap is filled first
      for (const linkMode of LINK_MODES) {
        const file = path.join(fresh('first-free-' + linkMode), 'a.json');
        fs.writeFileSync(file + '.corrupt', 'LEGACY-BARE');
        fs.writeFileSync(file + '.corrupt-4242-1', 'LEGACY-PID-SEQ');
        const io = facade(linkMode, {});
        fs.writeFileSync(file, 'FIRST-INCIDENT');
        reset();
        const m1 = P.moveAside({ fs: io }, file, 'corrupt');
        fs.writeFileSync(file, 'SECOND-INCIDENT');
        reset();   // a restart: nothing in memory remembers the first copy
        const m2 = P.moveAside({ fs: io }, file, 'corrupt');
        A.eq([m1.ok, path.basename(m1.to || ''), m2.ok, path.basename(m2.to || '')], [true, 'a.json.corrupt-1', true, 'a.json.corrupt-2'], 'INV-3 [' + linkMode + '] two incidents across a restart are .corrupt-1 and .corrupt-2');
        A.eq(look(file).forensic, ['corrupt=LEGACY-BARE', 'corrupt-1=FIRST-INCIDENT', 'corrupt-2=SECOND-INCIDENT', 'corrupt-4242-1=LEGACY-PID-SEQ'], 'INV-3 [' + linkMode + '] byte-exact, and the legacy copies are kept as they were');
        A.ok(!fs.existsSync(file), 'INV-3 [' + linkMode + '] a move leaves no original behind');
        fs.unlinkSync(file + '.corrupt-1');
        fs.writeFileSync(file, 'THIRD-INCIDENT');
        A.eq(path.basename(P.moveAside({ fs: io }, file, 'corrupt').to || ''), 'a.json.corrupt-1', 'INV-3 [' + linkMode + '] the FIRST free number is taken (a gap is filled)');
        fs.writeFileSync(file, 'KEPT');
        const p1 = P.preserve({ fs: io }, file, 'unseen'), p2 = P.preserve({ fs: io }, file, 'unseen');
        A.eq([path.basename(p1.to || ''), path.basename(p2.to || ''), fs.readFileSync(file, 'utf8')], ['a.json.unseen-1', 'a.json.unseen-2', 'KEPT'], 'INV-3 [' + linkMode + '] preserve numbers its own label and keeps the source');
      }

      // 1e. INV-3: a failed move or copy is honest: ok:false, the file where it was, no destination named or left behind
      for (const linkMode of LINK_MODES) {
        const dir = fresh('honest-' + linkMode);
        const file = path.join(dir, 'a.json');
        fs.writeFileSync(file, 'TORN{');
        const locked = facade(linkMode, { unlinkSync: a => (a[0] === file ? 'EBUSY' : null), renameSync: a => (a[0] === file ? 'EBUSY' : null) });
        const m = P.moveAside({ fs: locked }, file, 'corrupt');
        A.eq([m.ok, m.to], [false, undefined], 'INV-3 [' + linkMode + '] a move whose original cannot be dropped reports ok:false and names nothing');
        A.eq(look(file), { main: 'TORN{', bak: '-', forensic: [], temps: [] }, 'INV-3 [' + linkMode + '] ...and leaves the file where it was, with no copy (a made link is undone)');
        const gone = P.moveAside({ fs: facade(linkMode, {}) }, path.join(dir, 'nothing.json'), 'corrupt');
        A.eq([gone.ok, !!gone.absent, gone.to], [false, true, undefined], 'INV-3 [' + linkMode + '] a source that is gone is reported absent');
        const full = facade(linkMode === 'link' ? 'EPERM' : linkMode, {
          writeSync: (a, ctx) => {
            if (ctx.pathOf(a[0]) !== file + '.corrupt-1') return null;
            fs.writeSync(a[0], Buffer.from('PARTIAL'));
            return 'ENOSPC';
          }
        });
        full.copyFileSync = (a, b) => { fs.writeFileSync(b, 'PARTIAL'); throw injected('ENOSPC', 'copyFileSync'); };
        const p = P.preserve({ fs: full }, file, 'corrupt');
        A.eq([p.ok, p.to, look(file).forensic], [false, undefined, []], 'INV-3 [' + linkMode + '] a copy that runs out of disk reports ok:false and removes its partial file');
        const c = P.preserve({ fs: facade(linkMode, {}) }, file, 'corrupt', { copyOnly: true });
        A.ok(c.ok && fs.existsSync(c.to) && fs.readFileSync(c.to, 'utf8') === 'TORN{', 'INV-3 [' + linkMode + '] copyOnly keeps a byte-exact copy');
        A.eq(fs.statSync(file).nlink, 1, 'INV-3 [' + linkMode + '] copyOnly never shares the inode (a file appended in place must not change its copy)');
      }

      for (const linkMode of LINK_MODES) for (const flush of (linkMode === 'link' ? ['directory'] : ['file', 'directory'])) {
        const file = path.join(fresh('copy-flush-' + linkMode + '-' + flush), 'a.json');
        fs.writeFileSync(file, 'UNIQUE ORIGINAL');
        const failPath = flush === 'file' ? file + '.corrupt-1' : path.dirname(file);
        // Windows normally refuses opening directories. A real file descriptor stands in for that directory handle
        // so this row can inject the POSIX fsync EIO, while the production code still opens the directory's exact path.
        const io = facade(linkMode, { fsyncSync: (a, ctx) => ctx.pathOf(a[0]) === failPath ? 'EIO' : null });
        if (flush === 'directory') {
          const open = io.openSync, close = io.closeSync;
          const directoryFds = new Set();
          io.openSync = function (p) {
            if (p === failPath) { const fd = fs.openSync(file, 'r'); directoryFds.add(fd); return fd; }
            return open.apply(io, arguments);
          };
          const fsync = io.fsyncSync;
          io.fsyncSync = fd => { if (directoryFds.has(fd)) throw injected('EIO', 'directory fsync'); return fsync(fd); };
          io.closeSync = fd => { directoryFds.delete(fd); return close(fd); };
        }
        const moved = P.moveAside({ fs: io }, file, 'corrupt');
        A.eq([moved.ok, look(file).main, look(file).forensic], [false, 'UNIQUE ORIGINAL', []], 'INV-3 [' + linkMode + '] the original remains if its exclusive copy ' + flush + ' cannot be flushed');
      }

      // A second writer claims the first forensic name immediately before the committing filesystem operation.
      // Both the hard-link path and its FAT/exFAT fallback must preserve that competing copy and use the next name.
      for (const linkMode of LINK_MODES) {
        const file = path.join(fresh('quarantine-race-' + linkMode), 'a.json');
        fs.writeFileSync(file, 'SECOND INCIDENT');
        let claimed = false;
        const claim = a => {
          if (!claimed && a[0] === file && a[1] === file + '.corrupt-1') {
            claimed = true;
            fs.writeFileSync(a[1], 'FIRST INCIDENT', { flag: 'wx' });
          }
          return null;
        };
        const racing = facade(linkMode, { linkSync: claim, renameSync: claim, copyFileSync: claim,
          openSync: a => claim([file, a[1] === 'wx' ? a[0] : '']) });
        const moved = P.moveAside({ fs: racing }, file, 'corrupt');
        A.eq([claimed, moved.ok, moved.to], [true, true, file + '.corrupt-2'], 'INV-3 [' + linkMode + '] a concurrently claimed name is skipped atomically');
        A.eq(look(file).forensic, ['corrupt-1=FIRST INCIDENT', 'corrupt-2=SECOND INCIDENT'], 'INV-3 [' + linkMode + '] neither incident overwrites the other');
      }

      // A failed exclusive operation does not prove it created the destination. Keep another actor's bytes.
      for (const linkMode of LINK_MODES.slice(1)) {
        const file = path.join(fresh('copy-unowned-' + linkMode), 'a.json');
        fs.writeFileSync(file, 'SOURCE');
        const first = file + '.corrupt-1';
        let claimed = false;
        const failBeforeOpen = to => {
          if (to !== first) return null;
          claimed = true;
          fs.writeFileSync(to, 'FIRST INCIDENT', { flag: 'wx' });
          return 'EIO';
        };
        const io = facade(linkMode, { copyFileSync: a => failBeforeOpen(a[1]),
          openSync: a => a[1] === 'wx' ? failBeforeOpen(a[0]) : null });
        const kept = P.preserve({ fs: io }, file, 'corrupt');
        A.eq([claimed, kept.ok, look(file).forensic], [true, false, ['corrupt-1=FIRST INCIDENT']], 'INV-3 [' + linkMode + '] a failure before destination ownership never deletes a competing copy');
        A.eq(fs.readFileSync(file, 'utf8'), 'SOURCE', 'INV-3 [' + linkMode + '] a failed copy leaves the source in place');
      }

      // 1f. FAT/exFAT: every linkSync errno of the no-hard-links family falls back quietly; any other one is noted
      for (const code of LINK_MODES.slice(1).concat(['EIO'])) {
        const file = path.join(fresh('bak-link-' + code), 'a.json');
        fs.writeFileSync(file, J(V1));
        reset();
        const n0 = failopen.counts()['persist.bak.link'] || 0;
        P.replaceJson({ fs: facade(code, {}), path }, file, V2);
        A.eq([look(file).main, look(file).bak, look(file).temps], [J(V2), J(V1), []], 'linkSync ' + code + ': the .bak is refreshed by a durable copy');
        A.eq((failopen.counts()['persist.bak.link'] || 0) - n0, code === 'EIO' ? 1 : 0, code === 'EIO' ? 'an unexpected link failure is noted' : 'linkSync ' + code + ' means "no hard links here": quiet');
        const m = P.moveAside({ fs: facade(code, {}) }, file, 'corrupt');
        A.ok(m.ok && fs.readFileSync(m.to, 'utf8') === J(V2) && !fs.existsSync(file), 'linkSync ' + code + ': moveAside falls back to an exclusive copy then unlink');
      }

      // 1g. readTagged: absent / unreadable / bad, never conflated; the unread mark
      {
        const dir = fresh('read');
        const f = n => path.join(dir, n);
        reset();
        A.eq(P.readTagged({ fs }, f('none.json')).status, 'absent', 'ENOENT is absent');
        fs.writeFileSync(f('plain'), 'x');
        A.eq(P.readTagged({ fs }, path.join(f('plain'), 'under.json')).status, 'absent', 'ENOTDIR is absent');
        fs.writeFileSync(f('locked.json'), J(V1));
        for (const code of ['EBUSY', 'EACCES', 'EPERM', 'EMFILE', 'EIO']) {
          const r = P.readTagged({ fs: facade('link', { readFileSync: a => (a[0] === f('locked.json') ? code : null) }) }, f('locked.json'));
          A.eq([r.status, r.err && r.err.code, r.value], ['unreadable', code, undefined], code + ' is unreadable: never empty, never corrupt');
        }
        fs.writeFileSync(f('empty.json'), '');
        fs.writeFileSync(f('torn.json'), '{"k":');
        const e = P.readTagged({ fs }, f('empty.json')), t = P.readTagged({ fs }, f('torn.json'));
        A.eq([e.status, e.main, t.status, t.main, t.problemFile], ['corrupt', 'empty', 'corrupt', 'corrupt', f('torn.json')], 'zero-length and unparseable are bad, and name their file');
        fs.writeFileSync(f('torn.json.bak'), J(V0));
        const rec = P.readTagged({ fs }, f('torn.json'));
        A.eq([rec.status, rec.value, rec.main, rec.bak], ['recovered', V0, 'corrupt', 'ok'], 'a bad main with a good .bak is recovered, and says the main is bad');
        A.ok(P.isUnread(f('locked.json')), 'an unreadable read marks the file unread');
        P.readTagged({ fs }, f('locked.json'));
        A.ok(P.isUnread(f('locked.json')), 'a later good read does not clear the mark (a blind writer still holds the failed load)');
        P.replaceJson({ fs, path }, f('locked.json'), V2);
        A.ok(!P.isUnread(f('locked.json')), 'a successful replace clears it');
        A.eq(look(f('locked.json')).forensic, ['unseen-1=' + J(V1)], 'D2: that blind replace kept the bytes it never read');
      }

      // 1h. replaceJson: D2 only for a blind writer; a failed D2 copy refuses; prior skips the read; D1 is noted
      {
        const dir = fresh('replace');
        const file = path.join(dir, 'a.json');
        const lockedRead = () => P.readTagged({ fs: facade('link', { readFileSync: a => (a[0] === file ? 'EBUSY' : null) }) }, file);
        fs.writeFileSync(file, J(V1));
        reset();
        lockedRead();
        P.replaceJson({ fs, path }, file, V2, { seen: true });
        A.eq(look(file).forensic, [], 'D2: a writer whose value comes from a read that succeeded (seen) keeps no unseen copy');
        lockedRead();
        P.replaceJson({ fs, path }, file, V3, { prior: { status: 'ok', raw: J(V2) } });
        A.eq(look(file).forensic, [], 'D2: nor does a read-modify-write caller passing its prior read');
        lockedRead();
        const noCopy = facade('EPERM', { copyFileSync: () => 'ENOSPC', openSync: a => a[1] === 'wx' ? 'ENOSPC' : null });
        let err = null;
        try { P.replaceJson({ fs: noCopy, path }, file, V0); } catch (e) { err = e; }
        A.eq([err && err.code, look(file).main, look(file).forensic, look(file).temps], ['ESTORE_UNSEEN', J(V3), [], []], 'D2: unseen bytes that cannot be kept refuse the write, bytes untouched');
        let mainReads = 0;
        const counting = Object.create(fs);
        counting.readFileSync = function (p) { if (p === file) mainReads++; return fs.readFileSync.apply(fs, arguments); };
        P.replaceJson({ fs: counting, path }, file, V1, { prior: { status: 'ok', raw: J(V3) } });
        A.eq(mainReads, 0, 'prior { status: ok, raw } settles the main: no re-read (the warm-DM and save-cost budgets)');
        const n0 = failopen.counts()['persist.bak'] || 0;
        P.replaceJson({ fs: facade('EPERM', { renameSync: a => (a[1] === file + '.bak' ? 'ENOSPC' : null) }), path }, file, V2);
        A.eq([look(file).main, (failopen.counts()['persist.bak'] || 0) - n0, look(file).temps], [J(V2), 1, []], 'D1: a .bak that cannot be refreshed is noted (persist.bak) and the write lands, no temp');
      }

      // 1i. the names grammar
      {
        const N = P.names;
        A.eq(N.tempOf('a.json', 'a.json.123.ab12.tmp'), { kind: 'own', pid: 123, nonce: 'ab12' }, 'names: own temp grammar <file>.<pid>.<nonce>.tmp');
        for (const n of ['a.json.7.tmp', 'a.json.tmp-1-2-3', 'a.json.repair-ab12']) A.eq(N.tempOf('a.json', n), { kind: 'legacy' }, 'names: legacy temp ' + n);
        for (const n of ['a.json', 'a.json.bak', 'a.json.bak.123.ab.tmp', 'b.json.123.ab.tmp', 'a.jsonx.123.ab.tmp', 'a.json.123.a.b.tmp', 'a.json.corrupt-1', 'a.json.tmp'])
          A.eq(N.tempOf('a.json', n), null, 'names: ' + n + ' is no temp of a.json');
        for (const n of ['x.json.corrupt', 'x.json.corrupt-1', 'x.json.corrupt-4242-1', 'x.json.unseen-2', 'x.json.bak.corrupt-1', 'x.json.bak.unseen-1'])
          A.ok(N.isForensic(n), 'names: ' + n + ' is a forensic copy');
        for (const n of ['x.jsonl.corrupt-r0a1b2c', 'x.jsonl.torn-r0a1b2c', 'x.json.bak', 'x.json', 'x.json.corrupt-abc', 'x.json.unseen'])
          A.ok(!N.isForensic(n), 'names: ' + n + ' is not a forensic generation');
        for (const n of ['x.tmp', 'x.json.1.tmp', 'x.json.123.ab.tmp', 'draft.tmp.md', 'x.json.tmp-1-2-3', 'x.jsonl.repair-ab12']) A.ok(N.isTemp(n), 'names: ' + n + ' is temp-shaped');
        for (const n of ['x.json', 'x.json.bak', 'tmpfile', 'x.json.corrupt-1']) A.ok(!N.isTemp(n), 'names: ' + n + ' is not temp-shaped');
        A.ok(N.isBackup('x.json.bak') && !N.isBackup('x.json.bak.corrupt-1'), 'names: isBackup');
        A.eq(N.QUARANTINE_N_SOURCE, '\\.corrupt-\\d+', 'names: QUARANTINE_N_SOURCE is the numbered-quarantine text workspace-lineage builds from');
        A.eq(path.basename(N.forensicName('/w/a.json', 'unseen', 3)), 'a.json.unseen-3', 'names: forensicName');
      }
    }));

    /* ============================== 2. THE STORE MATRIX ============================== */
    const T1 = '{"k":"torn', TB = '{"k":"torn-bak';
    const forensicDest = a => FORENSIC_NAME.test(String(a[1]));
    const mainTemp = (f, p) => p.indexOf(f + '.') === 0 && p.indexOf(f + '.bak.') !== 0 && /\.tmp$/.test(p);
    const ROWS = [
      { id: 'ok', seed: { main: 'V1' },
        want: { read: 'value:V1', write: 'ok', main: 'V2', bak: 'V1', forensic: [] } },
      { id: 'absent', seed: {},
        want: { read: 'empty', write: 'ok', main: 'V2', bak: '-', forensic: [] } },
      { id: '.bak only', seed: { bak: 'V1' },
        want: { read: 'value:V1', write: 'ok', main: 'V2', bak: 'V1', forensic: [] } },
      { id: 'empty main + good .bak', seed: { main: '', bak: 'V1' },
        want: { read: 'value:V1', afterRead: ['corrupt-1='], write: 'ok', main: 'V2', bak: 'V1', forensic: ['corrupt-1='] } },
      { id: 'torn main + good .bak', seed: { main: T1, bak: 'V1' },
        want: { read: 'value:V1', afterRead: ['corrupt-1=' + T1], write: 'ok', main: 'V2', bak: 'V1', forensic: ['corrupt-1=' + T1] } },
      { id: 'torn main, no .bak', seed: { main: T1 },
        want: { read: 'empty', afterRead: ['corrupt-1=' + T1], write: 'ok', main: 'V2', bak: '-', forensic: ['corrupt-1=' + T1] } },
      { id: 'torn both', seed: { main: T1, bak: TB },
        want: { read: 'empty', afterRead: ['bak.corrupt-1=' + TB, 'corrupt-1=' + T1], write: 'ok', main: 'V2', bak: '-', forensic: ['bak.corrupt-1=' + TB, 'corrupt-1=' + T1] } }
    ].concat(['EBUSY', 'EACCES', 'EPERM'].map(code => (
      { id: 'busy main ' + code, seed: { main: 'V1', bak: 'V0' }, rules: (f, lock) => ({ readFileSync: a => (lock.on && a[0] === f ? code : null) }),
        want: { read: 'refused:unreadable', afterRead: [], write: 'refused:unreadable', main: 'V1', bak: 'V0', forensic: [], afterUnlock: 'value:V1' } }
    )), [
      { id: 'busy .bak', seed: { main: 'V1', bak: 'V0' }, rules: (f, lock) => ({ readFileSync: a => (lock.on && a[0] === f + '.bak' ? 'EBUSY' : null) }),
        want: { read: 'value:V1', write: 'ok', main: 'V2', bak: 'V1', forensic: [] } },
      { id: 'torn main + busy .bak', seed: { main: T1, bak: 'V0' }, rules: (f, lock) => ({ readFileSync: a => (lock.on && a[0] === f + '.bak' ? 'EBUSY' : null) }),
        want: { read: 'refused:unreadable', afterRead: [], write: 'refused:unreadable', main: T1, bak: 'V0', forensic: [], afterUnlock: 'value:V0' } },
      { id: 'second quarantine after a restart', seed: { main: T1 + '-1' }, restart: T1 + '-2',
        want: { read: 'empty', write: 'ok', read2: 'empty', write2: 'ok', main: 'V2', bak: '-', forensic: ['corrupt-1=' + T1 + '-1', 'corrupt-2=' + T1 + '-2'] } },
      { id: 'move-aside fails', seed: { main: T1 },
        rules: f => ({ unlinkSync: a => (a[0] === f ? 'EPERM' : null), renameSync: a => (forensicDest(a) ? 'EPERM' : null) }),
        want: { read: 'empty', afterRead: [], mainAfterRead: T1, write: 'ok', main: 'V2', bak: '-', forensic: ['corrupt-1=' + T1] } },
      { id: 'preserve fails', seed: { main: T1 },
        rules: f => ({ unlinkSync: a => (a[0] === f ? 'EPERM' : null), renameSync: a => (forensicDest(a) ? 'EPERM' : null),
          linkSync: a => (forensicDest(a) ? 'EPERM' : null), copyFileSync: a => (forensicDest(a) ? 'ENOSPC' : null),
          openSync: a => (a[1] === 'wx' && /\.(?:corrupt|unseen)-\d+$/.test(String(a[0])) ? 'ENOSPC' : null) }),
        want: { read: 'empty', afterRead: [], write: 'refused:corrupt', main: T1, bak: '-', forensic: [] } },
      { id: 'rename fails', seed: { main: 'V1', bak: 'V0' }, rules: f => ({ renameSync: a => (a[1] === f ? 'EPERM' : null) }),
        want: { read: 'value:V1', write: 'threw:EPERM', main: 'V1', bak: 'V1', forensic: [] } },
      { id: 'short write', seed: { main: 'V1', bak: 'V0' }, rules: f => ({ writeSync: (a, ctx) => (mainTemp(f, ctx.pathOf(a[0])) ? 'NO-PROGRESS' : null) }),
        want: { read: 'value:V1', write: 'threw:ESHORTWRITE', main: 'V1', bak: 'V1', forensic: [] } },
      { id: 'fsync fails', seed: { main: 'V1', bak: 'V0' }, rules: f => ({ fsyncSync: (a, ctx) => (mainTemp(f, ctx.pathOf(a[0])) ? 'EIO' : null) }),
        want: { read: 'value:V1', write: 'threw:EIO', main: 'V1', bak: 'V1', forensic: [] } },
      { id: '.bak refresh fails', seed: { main: 'V1', bak: 'V0' },
        rules: f => ({ linkSync: a => (a[1] === f + '.bak' ? 'EPERM' : null), renameSync: a => (a[1] === f + '.bak' ? 'ENOSPC' : null) }),
        want: { read: 'value:V1', write: 'ok', main: 'V2', bak: '-', forensic: [] } },
      // a blind writer keeps every copy it never read (D2); a read-modify-write store re-reads first, so what it read
      // becomes the .bak like any write's and nothing unseen is left to keep (INV-4: it carries those bytes itself)
      { id: 'boot read unreadable, then a later write', seed: { main: 'V1', bak: 'V0' }, unlockBeforeWrite: true,
        rules: (f, lock) => ({ readFileSync: a => (lock.on && a[0] === f ? 'EBUSY' : null) }),
        want: { read: 'refused:unreadable', afterRead: [], write: 'ok', main: 'V2', bak: 'V1', forensic: ['bak.unseen-1=V0', 'unseen-1=V1'] },
        wantSeen: { forensic: [] } },
      { id: 'update freeze', seed: { main: 'V1', bak: 'V0' }, frozen: true,
        want: { read: 'value:V1', write: 'threw:UPDATE_MUTATIONS_FROZEN', main: 'V1', forensic: [] } }
    ]);
    function runRow(row, kind, linkMode, label) {
      const dir = fresh(label + '-' + linkMode + '-' + row.id);
      const file = kind.file(dir);
      if (row.seed.main !== undefined) fs.writeFileSync(file, bytesOf(kind, row.seed.main));
      if (row.seed.bak !== undefined) fs.writeFileSync(file + '.bak', bytesOf(kind, row.seed.bak));
      const lock = { on: true };
      const io = facade(linkMode, row.rules ? row.rules(file, lock) : {});
      const got = {};
      reset();   // a process boots onto the seeded files
      let c = kind.compose(io, dir, { frozen: row.frozen });
      got.read = kind.read(c);
      const r1 = lookAs(kind, file);
      got.afterRead = r1.forensic;
      got.mainAfterRead = r1.main;
      if (row.unlockBeforeWrite) lock.on = false;
      got.write = kind.write(c, 'V2');
      if (row.restart) {
        fs.writeFileSync(file, row.restart);
        reset();   // the second incident is met by a new process
        c = kind.compose(io, dir);
        got.read2 = kind.read(c);
        got.write2 = kind.write(c, 'V2');
      }
      Object.assign(got, lookAs(kind, file));
      if (row.want.afterUnlock) {
        lock.on = false;
        reset();
        got.afterUnlock = kind.read(kind.compose(facade(linkMode, {}), dir));
      }
      return got;
    }
    quiet(() => section('2 store matrix', () => {
      for (const linkMode of LINK_MODES) for (const row of ROWS) for (const kindName of Object.keys(KINDS)) {
        const kind = KINDS[kindName];
        if (kind.skip && kind.skip[row.id]) continue;
        const got = runRow(row, kind, linkMode, kindName);
        same(got, Object.assign({ temps: [] }, row.want, kind.seen ? row.wantSeen : null), 'INV-1 [' + kindName + ' | link ' + linkMode + '] ' + row.id);
      }
    }));

    // 2b. INV-2 for each store: a crash at every write point of its write reboots onto the old or the new value, and the
    //     next write leaves no temp of the file or its .bak. The crashed process is gone, so a temp it left names a dead
    //     pid: a store writing through the host's writer has DEAD stamped by it (compose's pid); one writing through
    //     persist itself (savestore) left this process's pid, which crashed() renames to the dead pid it stands for.
    const OWN_TEMP = /^(.*)\.(\d+)\.([A-Za-z0-9_-]+)\.tmp$/;
    function crashed(dir) {
      for (const n of fs.readdirSync(dir)) {
        const m = OWN_TEMP.exec(n);
        if (m && Number(m[2]) === LIVE) fs.renameSync(path.join(dir, n), path.join(dir, m[1] + '.' + DEAD + '.' + m[3] + '.tmp'));
      }
    }
    quiet(() => section('2b crash matrix', () => {
      for (const linkMode of LINK_MODES) for (const kindName of Object.keys(KINDS)) {
        const kind = KINDS[kindName];
        const seed = dir => { const file = kind.file(dir); fs.writeFileSync(file, kind.enc('V1')); fs.writeFileSync(file + '.bak', kind.enc('V0')); return file; };
        const refDir = fresh('crash-ref-' + kindName + '-' + linkMode);
        seed(refDir);
        reset();
        const ref = killable(facade(linkMode, {}), 0);
        A.eq(kind.write(kind.compose(ref.io, refDir, { pid: DEAD }), 'V2'), 'ok', 'crash reference [' + kindName + ' | link ' + linkMode + '] writes');
        const points = ref.state.calls;
        let leftTemp = 0;
        for (let k = 1; k <= points; k++) {
          const dir = fresh('crash-' + kindName + '-' + linkMode + '-' + k);
          const file = seed(dir);
          reset();
          const killed = killable(facade(linkMode, {}), k);
          kind.write(kind.compose(killed.io, dir, { pid: DEAD }), 'V2');
          if (look(file).temps.length) leftTemp++;
          crashed(dir);
          reset();   // the reboot
          const c = kind.compose(facade(linkMode, {}), dir);
          const boot = kind.read(c);
          const label = 'INV-2 [' + kindName + ' | link ' + linkMode + '] killed at write point ' + k + '/' + points;
          A.ok(boot === 'value:V1' || boot === 'value:V2', label + ': the reboot reads the old or the new value, got ' + boot);
          A.eq(kind.write(c, 'V3'), 'ok', label + ': the next write lands');
          A.eq([lookAs(kind, file).main, look(file).temps], ['V3', []], label + ': and leaves no temp of the file or its .bak');
        }
        A.ok(leftTemp > 0, 'the crash rows are real [' + kindName + ' | link ' + linkMode + ']: ' + leftTemp + ' of ' + points + ' kill points left a dead writer\'s temp');
      }
    }));

    // 2c. the read-modify-write path: update() re-reads under its lock
    await quietly(async () => { try {
      for (const linkMode of LINK_MODES) {
        // INV-4: a boot read that was unreadable, then update() once the lock clears: the prior keys ride in the main
        const dir = fresh('rmw-u3-' + linkMode);
        const file = path.join(dir, KEY + '.json');
        fs.writeFileSync(file, J(V1)); fs.writeFileSync(file + '.bak', J(V0));
        const lock = { on: true };
        reset();
        const c = compose(facade(linkMode, { readFileSync: a => (lock.on && a[0] === file ? 'EBUSY' : null) }), dir);
        A.eq(KINDS.general.read(c), 'refused:unreadable', 'INV-5 [rmw | link ' + linkMode + '] a locked boot read is refused, never empty');
        lock.on = false;
        await c.general.update(KEY, cur => Object.assign({}, cur, V2));
        A.eq([look(file).main, look(file).forensic, look(file).temps], [J(Object.assign({}, V1, V2)), [], []], 'INV-4 [rmw | link ' + linkMode + '] update() re-read the real value: its prior keys are carried in the main, no unseen copy needed');
      }
      // an unhandled corrupt record stays a refusal for update(): an observer onCorrupt (terminal metadata), and a
      // store composed without one (request-reservations must never re-dispatch from a ledger it cannot read)
      for (const [label, onCorrupt] of [['an observer onCorrupt', () => undefined], ['no onCorrupt', undefined]]) {
        const dir = fresh('rmw-refuse-' + label);
        const file = path.join(dir, KEY + '.json');
        fs.writeFileSync(file, T1);
        reset();
        const store = DS.makeDurableJsonStore({ fs, path, fileFor: () => file, writeDurable: frozenWriter({}), onCorrupt });
        let err = null;
        try { await store.update(KEY, () => V2); } catch (e) { err = e; }
        A.eq([err && err.code, look(file).main, look(file).forensic], ['ESTORE_CORRUPT', T1, []], 'update() with ' + label + ' refuses a corrupt record and keeps its bytes exactly where they are');
        fs.writeFileSync(file + '.bak', J(V0));
        A.eq(KINDS.general.read({ general: store }), 'value:V0', 'with ' + label + ' a good .bak still recovers');
        A.eq(written(() => store.set(KEY, V2)), 'ok', 'with ' + label + ' a blind set() after the recovery lands');
        A.eq([look(file).main, look(file).forensic], [J(V2), ['corrupt-1=' + T1]], 'with ' + label + ' the torn main was kept (moved aside on read, or kept by the replace), never dropped');
      }
    } catch (e) { A.ok(false, '2c read-modify-write threw: ' + ((e && e.stack) || e)); } });

    // 2d. channels: the read-modify-write callers. A file that cannot be read is a typed refusal (ESTORE_UNREADABLE, the
    //     errno its cause), never an empty map or transcript: nothing is cached and the write it would feed is refused.
    //     Once the lock clears the next write re-reads, so every record already there rides in the main (INV-4, INV-5).
    quiet(() => section('2d channels read-modify-write', () => {
      const refused = fn => { try { fn(); return 'not refused'; } catch (e) { return (e && e.code) + ':' + (e && e.cause && e.cause.code); } };
      for (const linkMode of LINK_MODES) for (const code of ['EBUSY', 'EACCES', 'EPERM']) {
        const dir = fresh('chan-rmw-' + linkMode + '-' + code);
        const map = path.join(dir, 'chatmap.json'), hist = path.join(dir, 'h.history.json');
        fs.writeFileSync(map, J({ version: 1, chats: { a: { agentId: 'tg_a' }, b: { agentId: 'tg_b' } } }));
        fs.writeFileSync(map + '.bak', J({ version: 1, chats: { a: { agentId: 'tg_a' } } }));
        fs.writeFileSync(hist, J({ version: 1, messages: [{ role: 'user', content: 'kept', ts: 1 }] }));
        const lock = { on: true };
        reset();
        const c = composeChannels(facade(linkMode, { readFileSync: a => (lock.on && (a[0] === map || a[0] === hist) ? code : null) }), dir, { maxTurns: 40 });
        const tag = '[channels | link ' + linkMode + ' | ' + code + '] ';
        A.eq(refused(() => c.store.loadChatMap()), 'ESTORE_UNREADABLE:' + code, 'INV-5 ' + tag + 'a locked chat map is a typed refusal, the errno its cause, never an empty map');
        A.eq(refused(() => c.store.saveChatRecord('c', { agentId: 'tg_c' })), 'ESTORE_UNREADABLE:' + code, 'INV-5 ' + tag + 'and the write it would feed is refused');
        A.eq(refused(() => c.store.appendTurn('h', 'user', 'new')), 'ESTORE_UNREADABLE:' + code, 'INV-5 ' + tag + 'a locked transcript refuses an append the same way');
        lock.on = false;
        A.eq(Object.keys(c.store.loadChatMap().chats).sort(), ['a', 'b'], 'INV-5 ' + tag + 'nothing was cached: once the lock clears the real map reads back');
        c.store.saveChatRecord('c', { agentId: 'tg_c' });
        c.store.appendTurn('h', 'user', 'new');
        A.eq(Object.keys(JSON.parse(fs.readFileSync(map, 'utf8')).chats).sort(), ['a', 'b', 'c'], 'INV-4 ' + tag + 'the next write re-read the map: chats a and b ride in the main');
        A.eq(JSON.parse(fs.readFileSync(hist, 'utf8')).messages.map(m => m.content), ['kept', 'new'], 'INV-4 ' + tag + 'and the transcript keeps its earlier turn');
        A.eq([look(map).forensic, look(map).temps, look(hist).forensic, look(hist).temps], [[], [], [], []], 'INV-4 ' + tag + 'with no copy needed and no temp left');
      }
    }));

    /* ============================== 3. BASE-WRITTEN FILES ============================== */
    quiet(() => section('3 base-written files', () => {
      const LEGACY = {
        'corrupt-4242-1': 'LEGACY index.js quarantine', corrupt: 'LEGACY bare quarantine', '3.tmp': 'LEGACY savestore/channels temp',
        'tmp-4242-1700000000000-1': 'LEGACY recovery temp', 'repair-ab12cd': 'LEGACY repair temp'
      };
      const MAIN = '{"version":1,"widgets":[{"id":"w1","label":"Kept"}]}', BAK = '{"version":1,"widgets":[]}';
      for (const kindName of Object.keys(KINDS)) {
        const kind = KINDS[kindName];
        // each store's own record as the base code wrote it (a general store's, unless the kind names its own), the legacy
        // siblings any older build may have left beside it, and that store's own legacy quarantine names
        const base = kind.base || { main: MAIN, bak: BAK };
        const legacy = Object.assign({}, LEGACY, base.legacy);
        const dir = fresh('base-written-' + kindName);
        const file = kind.file(dir);
        fs.writeFileSync(file, base.main); fs.writeFileSync(file + '.bak', base.bak);
        for (const s of Object.keys(legacy)) fs.writeFileSync(file + '.' + s, legacy[s]);
        reset();
        const c = kind.compose(facade('link', {}), dir);
        A.eq(kind.read(c), base.reads || 'value:' + base.main, 'base-written [' + kindName + ']: the file reads back unchanged');
        A.eq(kind.write(c, 'V2'), 'ok', 'base-written [' + kindName + ']: and takes the next write');
        for (const s of Object.keys(legacy)) A.eq(fs.existsSync(file + '.' + s) && fs.readFileSync(file + '.' + s, 'utf8'), legacy[s], 'base-written [' + kindName + ']: legacy sibling .' + s + ' is kept (fresh legacy temps wait to go stale)');
        fs.writeFileSync(file, T1);
        reset();
        kind.read(kind.compose(facade('link', {}), dir));
        const next = base.next || 'corrupt-1';
        A.eq(fs.existsSync(file + '.' + next) && fs.readFileSync(file + '.' + next, 'utf8'), T1, 'base-written [' + kindName + ']: the next quarantine is .' + next + ' (first-free numbering steps over legacy names)');
      }
    }));

    /* ============================== 4. THE COMPOSITION MANIFEST ============================== */
    section('4 manifest', () => {
      A.ok(INDEX.includes(HOST_BINDING), 'manifest: index.js binds quarantineCorrupt/loadResilient/saveResilient from persist.host with exactly the options this suite composes (fs, path, its update-frozen writeFileDurable)');
      const firstUse = INDEX.search(/\bloadResilient\(/);
      A.ok(INDEX.indexOf(HOST_BINDING) >= 0 && INDEX.indexOf(HOST_BINDING) < firstUse, 'manifest: the binding sits above the first use of loadResilient (a const is not hoisted)');
      const wfd = src.functionSourceIn(INDEX, 'writeFileDurable');
      A.ok(/UPDATE_MUTATIONS_FROZEN/.test(wfd) && /return writeFileDurableRaw\(deps, file, data\);/.test(wfd), 'manifest: index.js writeFileDurable is the update freeze over writeFileDurableRaw (mirrored by frozenWriter)');
      A.ok(/const \{ writeFileDurable: writeFileDurableRaw \} = require\('\.\/durable-write\.js'\);/.test(INDEX), 'manifest: writeFileDurableRaw is durable-write.js (persist.writeAtomic)');
      // every option a sidecar makeDurableJsonStore call passes has a row here
      const COVERED = {
        fs: 'every row (the fault facade)', path: 'every row', fileFor: 'every row',
        writeDurable: 'the update-frozen writer (row "update freeze"; the crash rows pass a dead writer pid through it)',
        onRecover: 'the recovered rows', onCorrupt: 'the host quarantine (corrupt rows), an observer and none (2c)'
      };
      // a call is an expression (after =, return, '(' or ','): the declaration and the doc comment never match
      const CALL = /(?:=|\breturn|\(|,)\s*makeDurableJsonStore\(\s*(\{)?/g;
      const calls = [];
      for (const file of src.sidecarSourceFiles()) {
        let m;
        CALL.lastIndex = 0;
        while ((m = CALL.exec(file.text))) {
          if (!m[1]) { calls.push({ where: file.rel, keys: ['<not an object literal>'] }); continue; }
          calls.push({ where: file.rel, keys: topLevelKeys(file.text, m.index + m[0].length - 1) });
        }
      }
      A.ok(calls.length >= 15, 'manifest: the scan finds the sidecar makeDurableJsonStore compositions (' + calls.length + ')');
      for (const call of calls) for (const key of call.keys)
        A.ok(Object.prototype.hasOwnProperty.call(COVERED, key), 'manifest: ' + call.where + ' composes makeDurableJsonStore with "' + key + '", an option persist.conformance has no row for — add one');
      A.ok(calls.some(c => c.where === 'sidecar/index.js' && c.keys.indexOf('onCorrupt') >= 0), 'manifest: index.js composes general stores with an onCorrupt (the host quarantine) — the rows above build that shape');
      // the record stores: every option a sidecar composition of them passes has a row here too
      const RECORD_COVERED = {
        makeChannelStore: {
          fs: 'every channels row (the fault facade)', pathMod: 'every channels row', root: 'every channels row',
          clock: 'CLOCK (lastSeen and ts are part of the bytes compared)',
          writeDurable: 'the update-frozen writer (row "update freeze"; the crash rows pass a dead writer pid through it)',
          onRecover: 'the recovered rows',
          timers: 'injected frozen timers; delivery-ledger timing is covered by delivery-ledger.test and channels.delivery-ledger.property',
          holding: 'the same update-freeze state; delivery-ledger holding is covered by those owner tests'
        },
        makeSaveStore: {
          fs: 'every savestore row (the fault facade)', pathMod: 'every savestore row', root: 'every savestore row',
          clock: 'CLOCK (savedAt is part of the bytes compared)',
          resetAt: 'actual station-record reset projection through each fault facade',
          onFounded: 'every save write checks accepted-only notification; real durable founding is checked by station-record and start-fresh-generation HTTP',
          inflate: 'the host transcript read for a restored copy (save-restore.js is handed it): it opens no store file, so there is no persist row; the engines test holds it to HistoryRef.expand'
        },
        makeDeliverableStore: {
          fs: 'every deliverables row (the fault facade)', path: 'every deliverables row', workspaces: 'every deliverables row',
          writeDurable: 'the update-frozen writer (row "update freeze"; the crash rows pass a dead writer pid through it; the journal cut)',
          onRecover: 'the recovered rows', onCorrupt: 'the host quarantine (the corrupt rows)',
          admit: 'which rows are written, never how (the forget registry write-time gate; deliverable-rows.e2e and forgotten-everywhere.e2e drive it on a real station)'
        },
        makeRunJournal: {
          dir: 'every run-journal row', fs: 'every run-journal row (the fault facade)', path: 'every run-journal row',
          clock: 'the record stamps only (ts is in the records, never in how the file is written, read or kept)',
          redact: 'identity in the rows (redaction shapes record payloads, never how the file is written, read or kept)'
        }
      };
      for (const name of Object.keys(RECORD_COVERED)) {
        const re = new RegExp('(?:=|\\breturn|\\(|,)\\s*' + name + '\\(\\s*(\\{)?', 'g');
        const found = [];
        for (const file of src.sidecarSourceFiles()) {
          let m;
          re.lastIndex = 0;
          while ((m = re.exec(file.text))) found.push({ where: file.rel, keys: m[1] ? topLevelKeys(file.text, m.index + m[0].length - 1) : ['<not an object literal>'] });
        }
        A.ok(found.some(f => f.where === 'sidecar/index.js'), 'manifest: the scan finds index.js composing ' + name);
        for (const f of found) for (const key of f.keys)
          A.ok(Object.prototype.hasOwnProperty.call(RECORD_COVERED[name], key), 'manifest: ' + f.where + ' composes ' + name + ' with "' + key + '", an option persist.conformance has no row for — add one');
      }
      A.ok(/makeChannelStore\(\{[^\n]*\bwriteDurable: writeFileDurable\b/.test(INDEX), 'manifest: index.js hands the channel store its update-frozen writeFileDurable (composeChannels mirrors it with frozenWriter)');
      A.ok(/makeDeliverableStore\(\{[^}]*\bwriteDurable: writeFileDurable\b[^}]*onCorrupt: \(key, file\) => quarantineCorrupt\(file, 'deliverables'\)/.test(INDEX), 'manifest: index.js hands the deliverables store its update-frozen writeFileDurable and the host quarantine (composeDeliverables mirrors both)');
    });

    /* ============================== 5. JOURNALS AND RECOVERY FILES ============================== */
    const STALE = persist ? persist.STALE_MS : 10 * 60 * 1000;
    const textOf = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '-');
    // every name beside a file, as its suffix after '<file>.'
    const siblings = file => fs.readdirSync(path.dirname(file)).filter(n => n.indexOf(path.basename(file) + '.') === 0).map(n => n.slice(path.basename(file).length + 1)).sort();
    const tempsOf = file => siblings(file).filter(s => TEMP_NAME.test('.' + s));
    async function sectionAsync(name, fn) { try { await fn(); } catch (e) { A.ok(false, name + ' threw: ' + ((e && e.stack) || e)); } }
    // a run journal as a crashed run of an earlier process left it: begin + an unmatched intent (needs_review)
    const journalOf = (dir, runId) => path.join(dir, RJ._internals.runFileName(runId));
    function seedJournal(dir, runId, tail) {
      const j = RJ.makeRunJournal({ dir, fs, path, clock: { now: () => 1 } });
      j.begin({ runId, agentId: 'agent', streamId: 's' });
      j.toolIntent(runId, { callId: 'w1', name: 'fs.write', argsRaw: '{}' });
      if (tail) fs.appendFileSync(journalOf(dir, runId), tail);
      return journalOf(dir, runId);
    }
    const TORN_TAIL = '{"v":1,"runId":"torn';
    await quietly(async () => {
      // 5a. INV-3 run journals: a journal with no valid record, twice across a restart, is .corrupt-1 then .corrupt-2,
      //     byte-exact; a move that cannot be made says so (quarantinedTo null) and leaves the journal where it was
      await sectionAsync('5a run-journal quarantine', async () => {
        for (const linkMode of LINK_MODES) {
          const dir = fresh('rj-two-' + linkMode);
          const file = journalOf(dir, 'no-record');
          fs.writeFileSync(file, 'FIRST-INCIDENT{');
          reset();
          const one = RJ.makeRunJournal({ dir, fs: facade(linkMode, {}), path }).recoverFile(file);
          fs.writeFileSync(file, 'SECOND-INCIDENT{');
          reset();   // a restart: nothing in memory remembers the first copy
          const two = RJ.makeRunJournal({ dir, fs: facade(linkMode, {}), path }).recoverFile(file);
          const tag = '[run journal | link ' + linkMode + '] ';
          A.eq([path.basename(one.quarantinedTo || ''), path.basename(two.quarantinedTo || '')], [path.basename(file) + '.corrupt-1', path.basename(file) + '.corrupt-2'], 'INV-3 ' + tag + 'two incidents across a restart are .corrupt-1 and .corrupt-2');
          A.eq([textOf(file + '.corrupt-1'), textOf(file + '.corrupt-2'), textOf(file)], ['FIRST-INCIDENT{', 'SECOND-INCIDENT{', '-'], 'INV-3 ' + tag + 'byte-exact, and nothing is left at the journal\'s name');
          const stuck = journalOf(dir, 'stuck');
          fs.writeFileSync(stuck, 'LOCKED-GARBAGE{');
          reset();
          const held = facade(linkMode, { unlinkSync: a => (a[0] === stuck ? 'EBUSY' : null), renameSync: a => (a[0] === stuck ? 'EBUSY' : null) });
          const st = RJ.makeRunJournal({ dir, fs: held, path }).recoverFile(stuck);
          A.eq([st.quarantinedTo, textOf(stuck), siblings(stuck)], [null, 'LOCKED-GARBAGE{', []], 'INV-3 ' + tag + 'a move that cannot be made reports quarantinedTo null and leaves the journal where it was, with no copy');
        }
      });

      // 5b. INV-3 / INV-5 run journals: one that cannot be READ (EBUSY/EACCES/EPERM) is never repaired or moved aside,
      //     takes no record, and is read (and repaired, or moved aside) by the first pass after the lock clears
      await sectionAsync('5b run-journal unreadable', async () => {
        for (const code of ['EBUSY', 'EACCES', 'EPERM']) {
          const dir = fresh('rj-locked-' + code);
          const torn = seedJournal(dir, 'locked-torn', TORN_TAIL), junk = journalOf(dir, 'locked-junk');
          fs.writeFileSync(junk, 'NO-RECORD{');
          const before = { [torn]: textOf(torn), [junk]: textOf(junk) };
          const lock = { on: true };
          reset();
          const j = RJ.makeRunJournal({ dir, fs: facade('link', { readFileSync: a => (lock.on && (a[0] === torn || a[0] === junk) ? code : null) }), path });
          const tag = '[run journal | ' + code + '] ';
          for (const f of [torn, junk]) {
            const st = j.recoverFile(f);
            A.eq([st.unreadable === true, st.runId, st.quarantinedTo || null, st.repairedFrom || null, !!st.repairError], [true, '', null, null, true], 'INV-3 ' + tag + (f === torn ? 'a torn' : 'an unparseable') + ' journal it cannot read is unreadable: neither repaired nor moved aside, and refused for every action');
            A.eq([textOf(f), siblings(f)], [before[f], []], 'INV-3 ' + tag + 'its bytes stay where they are: no copy, no evidence, no temp');
          }
          A.throws(() => j.checkpoint('locked-torn', { phase: 'x', messages: [] }), 'INV-5 ' + tag + 'a record to it is refused while it cannot be read (no live entry)');
          const page = j.recoverPage({ limit: 10 });
          A.ok(page.rows.length === 2 && page.rows.every(r => r.runId === '' && r.unreadable === true), 'INV-5 ' + tag + 'the listing carries both as unreadable rows with no identity (the boot walk skips them)');
          lock.on = false;
          const after = j.recoverFile(torn), afterJunk = j.recoverFile(junk);
          A.ok(after.runId === 'locked-torn' && after.records === 2 && /\.torn-r[0-9a-f]{10}$/.test(String(after.repairedFrom || '')), 'INV-5 ' + tag + 'once the lock clears the next pass reads the journal and repairs its torn tail');
          A.eq(path.basename(afterJunk.quarantinedTo || ''), path.basename(junk) + '.corrupt-1', 'INV-3 ' + tag + 'and only then moves the unparseable one aside');
        }
      });

      // 5c. INV-2 run journals: a repair that fails leaves the journal untouched and no temp of it
      await sectionAsync('5c run-journal repair failures', async () => {
        const inTemp = (f, p) => String(p).indexOf(f + '.') === 0 && TEMP_NAME.test(String(p));
        for (const [label, rules, evidence] of [
          ['the evidence copy fails', f => ({ copyFileSync: a => (a[0] === f ? 'ENOSPC' : null),
            openSync: a => (a[1] === 'wx' && /\.(?:torn|corrupt)-r[0-9a-f]+$/.test(String(a[0])) ? 'ENOSPC' : null) }), 0],
          ['the temp write fails', f => ({ writeSync: (a, ctx) => (inTemp(f, ctx.pathOf(a[0])) ? 'ENOSPC' : null) }), 0],
          ['the temp fsync fails', f => ({ fsyncSync: (a, ctx) => (inTemp(f, ctx.pathOf(a[0])) ? 'EIO' : null) }), 0],
          ['the rename and the in-place rewrite fail', f => ({ renameSync: a => (a[1] === f ? 'EPERM' : null), openSync: a => (a[0] === f && a[1] === 'r+' ? 'EBUSY' : null) }), 1]
        ]) {
          const dir = fresh('rj-repair-fails-' + label);
          const file = seedJournal(dir, 'repair-fails', TORN_TAIL);
          const before = textOf(file);
          reset();
          const st = RJ.makeRunJournal({ dir, fs: facade('link', rules(file)), path }).recoverFile(file);
          const tag = 'INV-2 [run journal repair] ' + label + ': ';
          A.ok(!!st.repairError, tag + 'the repair reports its error');
          A.eq([textOf(file), tempsOf(file)], [before, []], tag + 'the journal is untouched and no temp of it is left');
          A.eq(siblings(file).filter(s => /^(?:torn|corrupt)-/.test(s)).length, evidence, tag + (evidence ? 'the evidence made before the replace is kept' : 'no partial evidence copy is left'));
        }
      });

      await sectionAsync('run-journal unowned evidence', async () => {
        const dir = fresh('rj-unowned-evidence');
        const file = seedJournal(dir, 'unowned-evidence', TORN_TAIL);
        const before = textOf(file);
        let claimed = '';
        const claimAndFail = to => {
          if (!/\.(?:torn|corrupt)-r[0-9a-f]+$/.test(String(to))) return null;
          claimed = to;
          fs.writeFileSync(to, 'FIRST INCIDENT', { flag: 'wx' });
          return 'EIO';
        };
        const io = facade('link', { copyFileSync: a => claimAndFail(a[1]),
          openSync: a => a[1] === 'wx' ? claimAndFail(a[0]) : null });
        const st = RJ.makeRunJournal({ dir, fs: io, path }).recoverFile(file);
        A.eq([!!st.repairError, !!claimed, claimed ? textOf(claimed) : '', textOf(file), tempsOf(file)],
          [true, true, 'FIRST INCIDENT', before, []], 'INV-3 journal repair keeps another actor\'s evidence after an unowned copy failure');
      });

      // 5d. INV-2 run journals: a crash at every write point of a repair; the reboot repairs the journal it finds and
      //     leaves no temp (the crashed process is gone, so its temp names a dead pid)
      await sectionAsync('5d run-journal repair crashes', async () => {
        const refDir = fresh('rj-crash-ref');
        const refFile = seedJournal(refDir, 'crash', TORN_TAIL);
        reset();
        const ref = killable(facade('link', {}), 0);
        const refState = RJ.makeRunJournal({ dir: refDir, fs: ref.io, path }).recoverFile(refFile);
        A.ok(/\.torn-r[0-9a-f]{10}$/.test(String(refState.repairedFrom || '')) && !(persist && persist.names.isForensic(refState.repairedFrom)), 'INV-6 a repair\'s evidence copy is .torn-r<hex>: its nonce carries a letter, so it never reads as a numbered quarantine');
        const points = ref.state.calls;
        let leftTemp = 0;
        for (let k = 1; k <= points; k++) {
          const dir = fresh('rj-crash-' + k);
          const file = seedJournal(dir, 'crash', TORN_TAIL);
          reset();
          try { RJ.makeRunJournal({ dir, fs: killable(facade('link', {}), k).io, path }).recoverFile(file); } catch (_) { /* the process died here */ }
          if (tempsOf(file).length) leftTemp++;
          crashed(dir);
          reset();   // the reboot
          const st = RJ.makeRunJournal({ dir, fs, path }).recoverFile(file);
          const label = 'INV-2 [run journal repair] killed at write point ' + k + '/' + points;
          A.eq([st.runId, st.records, st.status], ['crash', 2, 'needs_review'], label + ': the reboot recovers the proven prefix');
          A.eq([RJ._internals.parseRecords(textOf(file)).damage, tempsOf(file)], ['none', []], label + ': the journal is repaired and no temp of it is left');
        }
        A.ok(leftTemp > 0, 'the run-journal crash rows are real: ' + leftTemp + ' of ' + points + ' kill points left a dead writer\'s temp');
      });

      // 5e. INV-3 the deliverables journal: a torn tail is kept as the first free .corrupt-<n> (an exclusive copy,
      //     byte-exact, across a restart) before the journal is cut to its proven prefix
      const delivJournal = dir => path.join(dir, 'deliverables.library.jsonl');
      const delivOp = (seq, id) => J({ v: 2, seq, op: 'upsert', row: { id, agentId: 'agent', runId: 'r' + seq, title: 'T' + seq, source: 'workshop', status: 'kept', kind: 'files', summary: '', files: [], createdAt: seq, updatedAt: seq } });
      const ids = rows => rows.map(r => r.id).sort();
      const newRow = id => ({ id, agentId: 'agent', runId: 'r-' + id, title: id, status: 'kept', files: [] });
      async function settled(p) { try { await p; return 'ok'; } catch (e) { return (e && e.code) || String(e); } }
      const PROVEN = delivOp(1, 'd1') + '\n' + delivOp(2, 'd2') + '\n';
      await sectionAsync('5e deliverables torn journal', async () => {
        for (const linkMode of LINK_MODES) {
          const dir = fresh('deliv-torn-' + linkMode);
          const jf = delivJournal(dir);
          fs.writeFileSync(jf, PROVEN + '{"v":2,"seq":3,"op":"ups');
          const first = textOf(jf);
          reset();
          let c = composeDeliverables(facade(linkMode, {}), dir);
          const tag = '[deliverables journal | link ' + linkMode + '] ';
          A.eq(ids(c.store.list()), ['d1', 'd2'], 'INV-3 ' + tag + 'a torn tail keeps every proven row');
          A.eq(textOf(jf), PROVEN, 'INV-3 ' + tag + 'the journal is cut to its proven prefix');
          A.eq(await settled(c.store.record(newRow('d3'), 3)), 'ok', 'INV-3 ' + tag + 'and takes the next append');
          fs.appendFileSync(jf, '{"v":2,"seq":5,"op":"tor');
          const second = textOf(jf);
          reset();   // a restart: nothing in memory remembers the first copy
          c = composeDeliverables(facade(linkMode, {}), dir);
          A.eq(ids(c.store.list()), ['d1', 'd2', 'd3'], 'INV-3 ' + tag + 'the append after the cut replays across a restart');
          A.eq(look(jf).forensic, ['corrupt-1=' + first, 'corrupt-2=' + second], 'INV-3 ' + tag + 'two torn incidents across a restart are .corrupt-1 and .corrupt-2, byte-exact');
          A.ok(fs.existsSync(jf + '.corrupt-1') && fs.statSync(jf + '.corrupt-1').nlink === 1, 'INV-3 ' + tag + 'the copy is a copy (the journal is appended in place: a shared inode would change it)');
        }
        // the copy, or the cut, cannot be made: nothing is cut, the proven rows still read, appends are refused (record()
        // rejects into callers that catch), and the next load tries again; a failed cut never copies the same bytes twice
        for (const [label, rules] of [
          ['the copy fails', (jf, fault) => ({ copyFileSync: a => (fault.on && a[0] === jf ? 'ENOSPC' : null),
            openSync: a => (fault.on && a[1] === 'wx' && String(a[0]).indexOf(jf + '.corrupt-') === 0 ? 'ENOSPC' : null) })],
          ['the cut fails', (jf, fault) => ({ renameSync: a => (fault.on && a[1] === jf ? 'EPERM' : null) })]
        ]) {
          const dir = fresh('deliv-hold-' + label);
          const jf = delivJournal(dir);
          fs.writeFileSync(jf, PROVEN + '{"v":2,"seq":3,"op":"ups');
          const torn = textOf(jf);
          const fault = { on: true };
          reset();
          const c = composeDeliverables(facade('link', rules(jf, fault)), dir);
          const tag = 'INV-3 [deliverables journal] ' + label + ': ';
          A.eq(ids(c.store.list()), ['d1', 'd2'], tag + 'the proven rows still read');
          A.eq(textOf(jf), torn, tag + 'nothing is cut: the torn bytes stay in the journal until they are kept');
          A.eq(await settled(c.store.record(newRow('d3'), 3)), 'ESTORE_CORRUPT', tag + 'an append is refused while the tail is neither kept nor cut');
          A.eq(textOf(jf), torn, tag + 'and nothing was appended');
          A.eq(look(jf).forensic, label === 'the copy fails' ? [] : ['corrupt-1=' + torn], tag + (label === 'the copy fails' ? 'no partial copy is left' : 'the copy was made once, never again for the same bytes'));
          fault.on = false;
          A.eq(await settled(c.store.record(newRow('d3'), 3)), 'ok', tag + 'once the fault clears the next load keeps it and cuts, and the append lands');
          A.eq([look(jf).forensic, ids(composeDeliverables(facade('link', {}), dir).store.list())], [['corrupt-1=' + torn], ['d1', 'd2', 'd3']], tag + 'one byte-exact copy, and every row replays');
        }
      });

      // 5f. INV-5 deliverables: a locked snapshot or journal is a typed refusal, never an empty library; nothing is
      //     cached, the write it would feed is refused, and the real rows read back once the lock clears
      await sectionAsync('5f deliverables unreadable', async () => {
        for (const code of ['EBUSY', 'EACCES', 'EPERM']) for (const which of ['snapshot', 'journal']) {
          const dir = fresh('deliv-locked-' + which + '-' + code);
          const snap = path.join(dir, 'deliverables.library.json'), jf = delivJournal(dir);
          fs.writeFileSync(snap, J({ v: 2, appliedSeq: 1, rows: [JSON.parse(delivOp(1, 'd1')).row], undo: [], cleared: [], clearUndo: [] }));
          fs.writeFileSync(jf, delivOp(2, 'd2') + '\n');
          const before = [textOf(snap), textOf(jf)];
          const lock = { on: true };
          const target = which === 'snapshot' ? snap : jf;
          reset();
          const c = composeDeliverables(facade('link', { readFileSync: a => (lock.on && a[0] === target ? code : null) }), dir);
          const tag = 'INV-5 [deliverables | locked ' + which + ' | ' + code + '] ';
          let err = null;
          try { c.store.list(); } catch (e) { err = e; }
          A.eq([err && err.code, err && err.cause && err.cause.code], ['ESTORE_UNREADABLE', code], tag + 'the library is a typed refusal (the errno its cause), never empty');
          A.eq(await settled(c.store.record(newRow('d3'), 3)), 'ESTORE_UNREADABLE', tag + 'and the write it would feed is refused');
          A.eq([textOf(snap), textOf(jf), look(snap).forensic, look(jf).forensic], before.concat([[], []]), tag + 'nothing on disk changed and nothing was moved aside');
          lock.on = false;
          A.eq(ids(c.store.list()), ['d1', 'd2'], tag + 'nothing was cached: the real rows read back once the lock clears');
        }
      });

      // 5g. INV-2 the recovery request (workspace-recovery writeJsonAtomic, through requestRecovery): the format kept, no
      //     temp left by a failed or crashed write (a torn one included), and a crashed or stale legacy writer's temp
      //     swept by the next write
      const CAND = { id: 'a'.repeat(24), recoverable: true, saveSha256: 'b'.repeat(64) };
      const REQUESTED_AT = 1700000000000;
      const requestText = JSON.stringify({ version: 1, candidateId: CAND.id, expectedSaveSha256: CAND.saveSha256, requestedAt: REQUESTED_AT }, null, 2) + '\n';
      const requestOf = root => Recovery._internals.requestFile(root, path);
      const request = (io, root) => Recovery.requestRecovery({ fs: io, path, workspaceRoot: root, candidateId: CAND.id, inspection: { candidates: [CAND] }, now: () => REQUESTED_AT });
      await sectionAsync('5g recovery request', async () => {
        const root = path.join(fresh('req-format'), 'ws');
        reset();
        request(facade('link', {}), root);
        A.eq([textOf(requestOf(root)), tempsOf(requestOf(root))], [requestText, []], 'recovery request: the pretty JSON and its trailing newline, exactly as the base code wrote it, and no temp');
        const refused = path.join(fresh('req-rename'), 'ws');
        let err = null;
        try { request(facade('link', { renameSync: a => (a[1] === requestOf(refused) ? 'EPERM' : null) }), refused); } catch (e) { err = e; }
        A.eq([err && err.code, textOf(requestOf(refused)), tempsOf(requestOf(refused))], ['EPERM', '-', []], 'INV-2 recovery request, rename refused: the error reaches the caller and no temp is left');

        const refRoot = path.join(fresh('req-crash-ref'), 'ws');
        reset();
        const ref = tearing(facade('link', {}), 0);
        request(ref.io, refRoot);
        const points = ref.state.calls;
        let leftTemp = 0;
        for (let k = 1; k <= points; k++) {
          const dir = fresh('req-crash-' + k), at = path.join(dir, 'ws'), file = requestOf(at);
          reset();
          try { request(tearing(facade('link', {}), k).io, at); } catch (_) { /* the process died here */ }
          if (tempsOf(file).length) leftTemp++;
          crashed(dir);
          reset();   // the reboot
          const label = 'INV-2 [recovery request] killed at write point ' + k + '/' + points;
          const landed = textOf(file);
          A.ok(landed === '-' || landed === requestText, label + ': the reboot finds no request or the whole one, never a torn one: ' + JSON.stringify(landed.slice(0, 60)));
          if (landed !== '-') fs.unlinkSync(file);   // a pending request is consumed by the boot that applies it
          request(fs, at);
          A.eq([textOf(file), tempsOf(file)], [requestText, []], label + ': the next request lands and leaves no temp');
        }
        A.ok(leftTemp > 0, 'the recovery-request crash rows are real: ' + leftTemp + ' of ' + points + ' kill points left a dead writer\'s temp');

        const legacyRoot = path.join(fresh('req-legacy'), 'ws'), legacyFile = requestOf(legacyRoot);
        const stale = legacyFile + '.tmp-4242-1700000000000-1', young = legacyFile + '.tmp-4242-1700000000000-2';
        fs.writeFileSync(stale, 'LEGACY'); fs.writeFileSync(young, 'LEGACY');
        const oldSec = (fs.statSync(stale).mtimeMs - STALE - 60000) / 1000;
        fs.utimesSync(stale, oldSec, oldSec);
        reset();
        request(fs, legacyRoot);
        A.eq([fs.existsSync(stale), fs.existsSync(young)], [false, true], 'INV-2 recovery request: a legacy temp is swept by the next write once stale, and a fresh one waits');
      });

      // 5h. the START FRESH marker (station-record writeMirror): a crash at every write point, a torn write included,
      //     leaves the old marker or the new one, never a torn receipt (savestore reads a torn one as NaN and refuses
      //     every re-seed of the fresh station); the next START FRESH lands and leaves no temp
      await sectionAsync('5h start-fresh marker', async () => {
        const NOW = Date.UTC(2026, 10, 3);
        // SLR moved the live marker owner to the generation apply. Exercise that writer, not the request route.
        const nextRecord = ws => SR.freshRecord({ fs, path, workspaceRoot: ws, now: () => NOW }, null, { acknowledgedRoots: ['/old/root'] });
        const startFreshAt = (io, ws) => { SR.writeMirror({ fs: io, path }, ws, nextRecord(ws), { quarantine: null, moved: [] }); return { ok: true }; };
        const prior = { version: 1, at: '2026-01-01T00:00:00.000Z', acknowledgedRoots: ['/old/root'], quarantine: null, moved: [] };
        const priorText = JSON.stringify(prior, null, 2);
        const nextText = JSON.stringify(SR.mirrorMarker(nextRecord(path.resolve('fixture-station')), { quarantine: null, moved: [] }), null, 2);
        const seedWs = dir => { const ws = path.join(dir, 'ws'); fs.mkdirSync(ws, { recursive: true }); fs.writeFileSync(path.join(ws, SR.FRESH_MARKER), priorText); return ws; };
        const refWs = seedWs(fresh('marker-crash-ref'));
        reset();
        const ref = tearing(facade('link', {}), 0);
        A.eq(startFreshAt(ref.io, refWs).ok, true, 'START FRESH: the reference run writes its marker');
        A.eq(textOf(path.join(refWs, SR.FRESH_MARKER)), nextText, 'START FRESH keeps the marker\'s format (pretty JSON, the acknowledged roots merged)');
        const points = ref.state.calls;
        for (let k = 1; k <= points; k++) {
          const ws = seedWs(fresh('marker-crash-' + k)), marker = path.join(ws, SR.FRESH_MARKER);
          reset();
          try { startFreshAt(tearing(facade('link', {}), k).io, ws); } catch (_) { /* the process died here */ }
          crashed(ws);
          reset();   // the reboot
          const label = 'START FRESH marker killed at write point ' + k + '/' + points;
          const landed = textOf(marker);
          A.ok(landed === priorText || landed === nextText, label + ': the reboot reads the old marker or the new one, never a torn one: ' + JSON.stringify(landed.slice(0, 60)));
          A.eq([startFreshAt(fs, ws).ok, textOf(marker), tempsOf(marker)], [true, nextText, []], label + ': the next START FRESH lands and leaves no temp');
        }
      });
    });

    /* ============================== 6. THE NAMES GOLDEN TABLE (INV-6) ============================== */
    section('6 names golden table', () => {
      const HASH = 'ab'.repeat(32) + '.jsonl';
      const FILES = ['agent.save.json', 'agent.roster.json', 'channels/secrets.json', 'agent.notebook.json', '.run-journal/' + HASH, 'deliverables.library.jsonl'];
      // every sibling persist or a legacy writer makes beside a store file, and what it is
      const SIBLINGS = [
        ['bak', 'backup'],
        [LIVE + '.0a1b2c.tmp', 'temp'], ['bak.' + LIVE + '.0a1b2c.tmp', 'temp'],                          // persist's temps
        ['3.tmp', 'temp'], ['tmp-4242-1700000000000-1', 'temp'], ['repair-ab12cd34ef', 'temp'],           // legacy temps
        ['corrupt-1', 'forensic'], ['corrupt-12', 'forensic'], ['bak.corrupt-1', 'forensic'],
        ['unseen-1', 'forensic'], ['bak.unseen-2', 'forensic'],                                             // persist's copies
        ['corrupt', 'forensic'], ['corrupt-4242-1', 'forensic']                                             // legacy copies
      ];
      // a run journal's damage evidence: persist's (r<hex>) and the base repair's bare 10-hex nonce, all-digit included
      const EVIDENCE = ['torn-r0a1b2c3d4e', 'corrupt-r0a1b2c3d4e', 'torn-0a1b2c3d4e', 'corrupt-0a1b2c3d4e', 'torn-0123456789', 'corrupt-0123456789'].map(s => [s, 'evidence']);
      const rowsOf = file => SIBLINGS.concat(file.indexOf('.run-journal/') === 0 ? EVIDENCE : []);
      const BUNDLE = { backup: 'skip', temp: 'skip', forensic: 'skip', evidence: 'include' };
      const policyOf = rel => StationRecovery._internals.classifyPolicy(rel, null).action;
      for (const file of FILES) {
        A.eq(policyOf(file), file === 'channels/secrets.json' ? 'sanitize' : 'include', 'INV-6 [bundle] ' + file + ' itself is captured');
        for (const [suffix, kind] of rowsOf(file)) A.eq(policyOf(file + '.' + suffix), BUNDLE[kind], 'INV-6 [bundle] ' + file + '.' + suffix + ' (' + kind + '): ' + BUNDLE[kind]);
      }
      // workspace-lineage counts only positive station evidence: never a temp, always agent.save.json's numbered quarantine
      const dir = fresh('names-lineage');
      for (const file of FILES.filter(f => f.indexOf('/') < 0)) {
        fs.writeFileSync(path.join(dir, file), '{}');
        for (const [suffix] of SIBLINGS) fs.writeFileSync(path.join(dir, file + '.' + suffix), '{}');
      }
      A.eq(SR.meaningfulEntries(fs, path, dir).map(e => e.name).sort(),
        ['agent.notebook.json', 'agent.notebook.json.bak', 'agent.roster.json', 'agent.roster.json.bak', 'agent.save.json', 'agent.save.json.bak', 'agent.save.json.corrupt-1', 'agent.save.json.corrupt-12', 'deliverables.library.jsonl'],
        'INV-6 [lineage] the station evidence beside these stores: each store, its .bak where it has one and agent.save.json.corrupt-<n>; never a temp or any other copy');
      if (havePersist('6 names')) for (const file of FILES) for (const [suffix, kind] of rowsOf(file)) {
        const name = path.basename(file) + '.' + suffix, N = persist.names;
        A.eq([N.isTemp(name), N.isBackup(name), N.isForensic(name)], [kind === 'temp', kind === 'backup', kind === 'forensic'], 'INV-6 [names] ' + name + ' is ' + kind);
      }
    });
  } catch (e) {
    A.ok(false, 'persist.conformance threw: ' + ((e && e.stack) || e));
  } finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { console.log('note: could not remove ' + ROOT + ': ' + ((e && e.code) || e)); }
  }
  A.report('persist.conformance');
})();

// the top-level keys of the object literal whose '{' is at text[open] (strings, comments and nested brackets skipped)
function topLevelKeys(text, open) {
  const keys = [];
  let depth = 0, start = open + 1;
  const push = seg => {
    const s = seg.trim();
    if (!s) return;
    if (s.indexOf('...') === 0) { keys.push('...spread'); return; }
    const m = /^([A-Za-z_$][\w$]*)/.exec(s);
    keys.push(m ? m[1] : '<computed>');
  };
  for (let i = open; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '/' && nx === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
    if (ch === '/' && nx === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < text.length; i++) { if (text[i] === '\\') { i++; continue; } if (text[i] === ch) break; } continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; continue; }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) { push(text.slice(start, i)); return keys; }
      continue;
    }
    if (ch === ',' && depth === 1) { push(text.slice(start, i)); start = i + 1; }
  }
  return keys;
}
