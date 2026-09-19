/* node test/durable-store.test.js — the crash-safe + concurrency-safe single-file JSON store (P1 + P2).

   Proves the three guarantees the persistence-hardening task demands:
   A. CONCURRENCY: N concurrent update() writers to ONE key, each with an ASYNC mutator, lose ZERO
      updates — and a NAIVE get->await->set baseline DOES lose them (so the mutex is doing real work).
   B. DURABILITY: every write goes through the fsync-before-rename durable path and snapshots a .bak.
   C. RECOVERY: a zero-length (torn) OR corrupt main file is recovered from the .bak last-known-good,
      a genuinely-absent key loads empty ('absent'), and an unrecoverable main is flagged 'corrupt'
      (never silently emptied). */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeKeyedMutex, readJsonResilient, writeJsonResilient, makeDurableJsonStore, saveJsonVerified } = require('../sidecar/durable-store.js');

// in-memory fs with the FULL durable path (openSync/writeSync/fsyncSync/closeSync) so writeFileDurable
// takes its real fsync-before-rename branch. Tracks fsync calls so we can assert durability.
function memFs() {
  const files = new Map();   // path -> string contents
  const fds = new Map();     // fd -> { path, buf }
  let nextFd = 10;
  const stats = { fsync: 0, rename: 0, open: 0 };
  return {
    files, stats,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); stats.rename++; },
    mkdirSync() {},
    openSync(p, flags) { stats.open++; const fd = nextFd++; if (flags === 'r') { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } fds.set(fd, { path: p, buf: files.get(p), read: true }); } else { fds.set(fd, { path: p, buf: '' }); files.set(p, ''); } return fd; },
    writeSync(fd, data) { const h = fds.get(fd); h.buf += String(data); files.set(h.path, h.buf); },
    fsyncSync() { stats.fsync++; },
    closeSync(fd) { fds.delete(fd); }
  };
}

const ROOT = '/ws';
const fileFor = key => pathMod.join(ROOT, String(key).replace(/[^A-Za-z0-9_-]/g, '_') + '.json');

// ---- 0. keyed mutex serializes same-key, parallelizes different-key ----
{
  const mx = makeKeyedMutex();
  const order = [];
  let aRunning = false, overlap = false;
  const mkTask = (key, tag) => mx.run(key, async () => {
    if (key === 'a') { if (aRunning) overlap = true; aRunning = true; }
    await new Promise(r => setTimeout(r, 5));
    if (key === 'a') aRunning = false;
    order.push(tag);
  });
  return (async () => {
    await Promise.all([mkTask('a', 'a1'), mkTask('a', 'a2'), mkTask('a', 'a3'), mkTask('b', 'b1')]);
    A.ok(!overlap, 'same-key tasks never overlap (serialized)');
    A.eq(order.filter(t => t[0] === 'a'), ['a1', 'a2', 'a3'], 'same-key tasks run in submission order');
    A.eq(mx.size(), 0, 'mutex prunes settled keys (no unbounded Map growth)');
    await main();
  })();
}

async function main() {
  // ---- A. CONCURRENCY: N concurrent async-mutator update()s lose ZERO updates ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    const N = 50;
    const writers = [];
    for (let i = 0; i < N; i++) {
      writers.push(store.update('notebook:hero', async (cur) => {
        const list = Array.isArray(cur) ? cur : [];
        await new Promise(r => setTimeout(r, (i % 5)));   // async work INSIDE the critical section
        return list.concat([{ id: 'note_' + i }]);
      }));
    }
    await Promise.all(writers);
    const final = store.get('notebook:hero');
    A.eq(final.length, N, 'all ' + N + ' concurrent update() writers persisted (zero lost updates)');
    const ids = new Set(final.map(n => n.id));
    A.eq(ids.size, N, 'every distinct note id survived (no overwrite)');
  }

  // ---- A2. the NAIVE get->await->set pattern DOES lose updates (proves the mutex is load-bearing) ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    const N = 50;
    const naive = [];
    for (let i = 0; i < N; i++) {
      naive.push((async () => {
        const cur = store.get('k') || [];          // read snapshot
        await new Promise(r => setTimeout(r, (i % 5)));  // ...await between read and write...
        store.set('k', cur.concat([{ id: i }]));    // whole-array overwrite from a stale snapshot
      })());
    }
    await Promise.all(naive);
    A.ok((store.get('k') || []).length < N, 'naive get->await->set LOSES updates (baseline confirms the hazard)');
  }

  // ---- B. DURABILITY: writes take the fsync-before-rename path and keep a .bak last-known-good ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    await store.update('roster', () => ({ v: 1 }));
    A.ok(fs.stats.fsync > 0, 'first write fsync()d before rename (durable)');
    await store.update('roster', () => ({ v: 2 }));
    const bak = fs.files.get(fileFor('roster') + '.bak');
    A.eq(JSON.parse(bak), { v: 1 }, 'second write snapshotted the prior value to .bak (last-known-good)');
    A.eq(store.get('roster'), { v: 2 }, 'main holds the newest value');
    A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no .tmp left behind (rename consumed every temp)');
  }

  // ---- C1. RECOVERY: a torn (zero-length) main is recovered from .bak, NOT silently emptied ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    await store.update('agentX', () => [{ id: 'note_1' }]);   // commit good v1
    await store.update('agentX', () => [{ id: 'note_1' }, { id: 'note_2' }]);   // commit v2 (snapshots v1 -> .bak)
    // simulate a hard kill mid-rename: main left ZERO-LENGTH on disk
    fs.files.set(fileFor('agentX'), '');
    const r = readJsonResilient({ fs }, fileFor('agentX'));
    A.eq(r.status, 'recovered', 'zero-length main is recovered from .bak (not amnesiac)');
    A.eq(r.value, [{ id: 'note_1' }], 'recovered the last-known-good value');
    A.ok(store.get('agentX') && store.get('agentX').length === 1, 'store.get() returns the recovered value, never empty');
  }

  // ---- C2. RECOVERY: a CORRUPT main with a good .bak recovers ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    await store.update('agentY', () => ({ a: 1 }));
    await store.update('agentY', () => ({ a: 2 }));   // .bak = {a:1}
    fs.files.set(fileFor('agentY'), '{ this is not json');
    const r = readJsonResilient({ fs }, fileFor('agentY'));
    A.eq(r.status, 'recovered', 'corrupt main recovers from .bak');
    A.eq(r.value, { a: 1 }, 'recovered the prior good value from .bak');
  }

  // ---- C3. ABSENT vs CORRUPT: a brand-new key loads empty; an unrecoverable main is flagged, not emptied ----
  {
    const fs = memFs();
    const r1 = readJsonResilient({ fs }, fileFor('brandnew'));
    A.eq(r1.status, 'absent', 'a genuinely-absent key is absent (loads empty — the only allowed empty)');
    let corruptFlagged = 0;
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor, onCorrupt: () => { corruptFlagged++; } });
    fs.files.set(fileFor('busted'), '\u0000\u0000not json and no bak');   // present-but-bad, no .bak
    const r2 = store.readKey('busted');
    A.eq(r2.status, 'corrupt', 'present-but-bad main with no .bak is CORRUPT, never silently absent/empty');
    A.eq(store.get('busted'), undefined, 'get() returns undefined for corrupt (caller decides) — but onCorrupt fired');
    A.ok(corruptFlagged >= 1, 'onCorrupt surfaced the unrecoverable file LOUDLY (not silent)');
    // 2026-08-21 sync-silence ratchet: an onCorrupt handler that THROWS used to vanish into an empty catch.
    // It is still fail-open (the read returns), but the swallow is now tagged + counted — provably fired.
    const failopen = require('../sidecar/failopen.js');
    failopen.resetForTests();
    const loud = makeDurableJsonStore({ fs, path: pathMod, fileFor, onCorrupt: () => { throw new Error('handler bug'); } });
    A.notThrows(() => loud.get('busted'), 'a throwing onCorrupt handler never escapes into the caller (fail-open kept)');
    A.eq(failopen.counts()['durable-store.onCorrupt'], 1, 'the swallowed handler failure is COUNTED under its tag (wiring proof, not just helper proof)');

    // A corrupt record is not a new record. update() must preserve its only forensic/recovery bytes instead of
    // passing undefined to a default-empty mutator and committing an amnesiac replacement.
    const corruptBytes = fs.files.get(fileFor('busted'));
    let corruptWrite = null;
    try { await store.update('busted', cur => (Array.isArray(cur) ? cur : []).concat([{ id: 'new' }])); }
    catch (e) { corruptWrite = e; }
    A.ok(corruptWrite && corruptWrite.code === 'ESTORE_CORRUPT', 'update() refuses an unrecoverable corrupt record');
    A.eq(fs.files.get(fileFor('busted')), corruptBytes, 'refused corrupt update preserves the original bytes exactly');

    // A missing main does not make a present backup disposable. This is the crash shape after main removal but
    // before replacement: if the surviving backup is corrupt, initialization must preserve it for recovery.
    const backupOnlyFile = fileFor('backup-only');
    fs.files.set(backupOnlyFile + '.bak', '{ corrupt surviving backup');
    const backupOnly = store.readKey('backup-only');
    A.eq(backupOnly.status, 'corrupt', 'missing main plus corrupt backup is CORRUPT, never genuinely absent');
    let backupOnlyWrite = null;
    try { await store.update('backup-only', () => ({ replacement: true })); }
    catch (e) { backupOnlyWrite = e; }
    A.ok(backupOnlyWrite && backupOnlyWrite.code === 'ESTORE_CORRUPT', 'update() refuses to initialize over a corrupt surviving backup');
    A.eq(fs.files.get(backupOnlyFile + '.bak'), '{ corrupt surviving backup', 'refused update preserves the surviving backup bytes exactly');
    A.ok(!fs.files.has(backupOnlyFile), 'refused update does not mint an amnesiac replacement main');

    // The production host DOES quarantine and returns the destination. That acknowledgement must target the
    // orphan backup (not the absent main) and let this same update initialize, while preserving the bad bytes.
    const healedFile = fileFor('backup-only-healed');
    const badBackup = '{ corrupt orphan backup';
    fs.files.set(healedFile + '.bak', badBackup);
    let quarantinedSource = '';
    const healingStore = makeDurableJsonStore({
      fs, path: pathMod, fileFor,
      onCorrupt(_key, problemFile) {
        quarantinedSource = problemFile;
        const dest = problemFile + '.corrupt-proof';
        fs.renameSync(problemFile, dest);
        return dest;
      }
    });
    await healingStore.update('backup-only-healed', cur => ({ initializedFrom: cur === undefined ? 'absent' : 'unexpected' }));
    A.eq(quarantinedSource, healedFile + '.bak', 'orphan-backup recovery quarantines the actual corrupt backup, not the absent main');
    A.eq(fs.files.get(healedFile + '.bak.corrupt-proof'), badBackup, 'orphan-backup quarantine preserves the forensic bytes');
    A.eq(healingStore.get('backup-only-healed'), { initializedFrom: 'absent' }, 'the same update initializes after successful orphan-backup quarantine');

    // Preserve the valid initialization path: a genuinely absent key still starts from undefined and commits.
    await store.update('brandnew', cur => ({ initializedFrom: cur === undefined ? 'absent' : 'unexpected' }));
    A.eq(store.get('brandnew'), { initializedFrom: 'absent' }, 'update() still initializes a genuinely absent record');
  }

  // ---- C4. the .bak is NEVER clobbered by a corrupt current main ----
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    await store.update('z', () => ({ good: 1 }));
    await store.update('z', () => ({ good: 2 }));         // .bak = {good:1}
    fs.files.set(fileFor('z'), 'CORRUPT NOW');             // main goes bad in place
    writeJsonResilient({ fs, path: pathMod }, fileFor('z'), { good: 3 });   // a write while main is corrupt
    A.eq(JSON.parse(fs.files.get(fileFor('z') + '.bak')), { good: 1 }, '.bak preserved (corrupt main never overwrote the last-known-good)');
    A.eq(store.get('z'), { good: 3 }, 'the new value still committed to main');
  }

  // ---- C5. WINDOWS ERRNO CONFLATION: a present-but-LOCKED main (EBUSY/EACCES) is 'unreadable', NOT 'absent' ----
  // Regression armor for the silent-data-wipe class: a non-ENOENT read error must never be conflated with a
  // genuinely-missing file, or the store would proceed from empty and the next write persists amnesiac state.
  {
    const fs = memFs();
    const store = makeDurableJsonStore({ fs, path: pathMod, fileFor });
    await store.update('locked', () => ({ progress: 7 }));   // a real, good record exists on disk
    // now make EVERY read of this key's main throw EBUSY (a Windows lock), while .bak reads still work
    const mainFile = fileFor('locked');
    const realRead = fs.readFileSync.bind(fs);
    fs.readFileSync = (p, enc) => { if (p === mainFile) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; } return realRead(p, enc); };

    const r = readJsonResilient({ fs }, mainFile);
    A.eq(r.status, 'unreadable', 'a non-ENOENT read error is UNREADABLE, never absent');
    A.eq(r.value, undefined, 'unreadable never yields a value (never silently empty)');
    A.eq((r.err && r.err.code), 'EBUSY', 'the underlying errno is carried for surfacing');

    let corruptFlagged = 0;
    const store2 = makeDurableJsonStore({ fs, path: pathMod, fileFor, onCorrupt: () => { corruptFlagged++; } });
    const rk = store2.readKey('locked');
    A.eq(rk.status, 'unreadable', 'readKey surfaces unreadable');
    A.eq(corruptFlagged, 0, 'unreadable files never enter a callback allowed to quarantine corrupt bytes');
    A.eq(store2.get('locked'), undefined, 'get() returns undefined for unreadable (never a fabricated empty)');

    // the load-bearing guarantee: update() REFUSES to write over an unreadable record (no from-empty clobber)
    let threw = null;
    try { await store2.update('locked', () => ({ progress: 0 })); } catch (e) { threw = e; }
    A.ok(threw && threw.code === 'ESTORE_UNREADABLE', 'update() throws ESTORE_UNREADABLE instead of clobbering a locked file from empty');

    // once the lock clears, reads + writes work normally again (transient, not fatal)
    fs.readFileSync = realRead;
    A.eq(store2.get('locked'), { progress: 7 }, 'after the lock clears the real value reads back (transient failure, data intact)');
    await store2.update('locked', (cur) => ({ progress: (cur && cur.progress || 0) + 1 }));
    A.eq(store2.get('locked'), { progress: 8 }, 'update() resumes normally post-unlock (built on the real prior value, not empty)');
  }

  // ---- D. FULL-STATE writers (the roster/dossier/secrets/tokens/connectors/allowlist pattern) ----
  // These persist the WHOLE in-memory state on each write (saveResilient), not a disk-snapshot RMW, so the
  // lost-update class the mutex prevents cannot occur: N concurrent full-state writes always leave a single
  // COMPLETE, parseable file equal to one of the writes — never a torn/interleaved/lost one — and a torn
  // write still recovers from .bak. (This is the guarantee roster/dossier need; they have no RMW to lock.)
  {
    const fs = memFs();
    const file = pathMod.join(ROOT, 'roster.json');
    const saveResilient = (value) => writeJsonResilient({ fs, path: pathMod, writeDurable: undefined }, file, value);
    const N = 50;
    await Promise.all(Array.from({ length: N }, (_, i) => Promise.resolve().then(() => saveResilient({ version: 1, seq: i, agents: [{ agentId: 'a' + i }] }))));
    const r = readJsonResilient({ fs }, file);
    A.eq(r.status, 'ok', 'full-state file is complete + parseable after N concurrent writers (never torn)');
    A.ok(typeof r.value.seq === 'number' && r.value.seq >= 0 && r.value.seq < N, 'final state equals one committed write (no lost/garbled state)');
    A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no .tmp left behind under concurrent full-state writes');
    // torn write recovery for the full-state pattern
    fs.files.set(file, '');
    const rec = readJsonResilient({ fs }, file);
    A.eq(rec.status, 'recovered', 'a torn full-state file recovers from .bak (roster/dossier never boot empty)');
  }

  // ---- E. saveJsonVerified (EL-5b F1/F3/F4): read-back PROOF + retry-once for irreplaceable credentials ----
  // The shared primitive behind connector-state and Codex-token persistence: a swallowed write on a rotated/
  // exchanged token silently loses the credential on the NEXT boot while the UI claims "connected". This must
  // report ok:false (never a false success) when the read-back cannot prove the value reached disk.
  {
    // E1: write lands, proof passes -> ok on the first attempt.
    let disk = null;
    let r = saveJsonVerified({ save: () => { disk = { byId: { c1: { accessToken: 'TOK' } } }; }, load: () => disk,
      proof: (rb) => !!(rb && rb.byId && rb.byId.c1 && rb.byId.c1.accessToken === 'TOK') });
    A.eq(r.ok, true, 'E1: a durable write proven by read-back is ok');
    A.eq(r.attempts, 1, 'E1: succeeds on the first attempt');

    // E2: first save throws, second lands -> retry-once recovers.
    disk = null; let n = 0;
    r = saveJsonVerified({ save: () => { n++; if (n === 1) throw new Error('EIO'); disk = { byId: { c1: { accessToken: 'TOK2' } } }; }, load: () => disk,
      proof: (rb) => !!(rb && rb.byId && rb.byId.c1 && rb.byId.c1.accessToken === 'TOK2') });
    A.eq(r.ok, true, 'E2: a first-write failure is recovered by the single retry');
    A.eq(r.attempts, 2, 'E2: it took two attempts');

    // E3: save ALWAYS throws -> disk never gets the token -> ok:false with the honest error (the F1/F3 hazard).
    disk = null;
    r = saveJsonVerified({ save: () => { throw new Error('EACCES'); }, load: () => disk,
      proof: (rb) => !!(rb && rb.byId && rb.byId.c1) });
    A.eq(r.ok, false, 'E3: a persistent write failure is reported ok:false (sign-in must fail loudly, not pretend)');
    A.ok(/EACCES/.test(r.error), 'E3: the honest error text is surfaced');

    // E4: save "succeeds" but the read-back shows a DIFFERENT/older token (torn write) -> proof fails -> ok:false.
    disk = { byId: { c1: { accessToken: 'STALE' } } };
    r = saveJsonVerified({ save: () => { /* pretends to write; disk unchanged */ }, load: () => disk,
      proof: (rb) => !!(rb && rb.byId && rb.byId.c1 && rb.byId.c1.accessToken === 'FRESH') });
    A.eq(r.ok, false, 'E4: a read-back mismatch is caught (no false durability claim)');

    // E5: load() throwing (unreadable) does not crash -> treated as unproven -> ok:false.
    r = saveJsonVerified({ save: () => {}, load: () => { throw new Error('locked'); }, proof: () => true });
    A.eq(r.ok, false, 'E5: a load() failure is treated as unproven, never a crash or false success');

    // E6: guard — missing save/load returns ok:false, never throws.
    A.eq(saveJsonVerified({}).ok, false, 'E6: missing save/load returns ok:false');
  }

  A.report('durable-store.test');
}
