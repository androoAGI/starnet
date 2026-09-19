/* node test/save.test.js — durable server-side agent save store (M-save).
   An in-memory fake fs proves: a save envelope round-trips, missing/corrupt -> undefined (fail-closed),
   writes are atomic (temp+rename, no .tmp left behind), the agentId jail-grammar is enforced, and a STALE
   write (older updatedAt) is refused so a background tab can't clobber a newer save. Pure + deterministic. */
'use strict';
const A = require('./_assert.js');
const pathMod = require('path');
const { makeSaveStore } = require('../sidecar/savestore.js');

// in-memory fs: records writes/renames so we can assert atomicity (write to .tmp, then rename onto target).
function memFs() {
  const files = new Map();
  const events = [];
  return {
    files, events,
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT: ' + p); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync(p, data) { files.set(p, String(data)); events.push(['write', p]); },
    renameSync(a, b) { if (!files.has(a)) { const e = new Error('ENOENT: ' + a); e.code = 'ENOENT'; throw e; } files.set(b, files.get(a)); files.delete(a); events.push(['rename', a, b]); },
    unlinkSync(p) { files.delete(p); },
    mkdirSync() {}
  };
}

let clk = 1000;
const clock = { now: () => clk };
const ROOT = '/ws';
const mk = (fs) => makeSaveStore({ fs, pathMod, root: ROOT, clock });
const envelope = (over) => Object.assign({ schema: 'starnet.save', version: 3, updatedAt: 100, agent: { id: 'agent', name: 'NOVA', stats: { xp: 42, level: 3 } } }, over || {});

// ---- A. construction guards ----
{
  A.throws(() => makeSaveStore({ pathMod, root: ROOT, clock }), 'missing fs throws');
  A.throws(() => makeSaveStore({ fs: memFs(), root: ROOT, clock }), 'missing pathMod throws');
  A.throws(() => makeSaveStore({ fs: memFs(), pathMod, clock }), 'missing root throws');
  A.throws(() => makeSaveStore({ fs: memFs(), pathMod, root: ROOT }), 'missing clock throws');
}

// ---- B. empty / missing save loads as undefined (fail-closed, never throws) ----
{
  const s = mk(memFs());
  A.eq(s.load('agent'), undefined, 'missing save -> undefined');
}

// ---- C. save round-trips the exact doc; persisted atomically (write .tmp then rename); survives a fresh store ----
{
  const fs = memFs();
  let s = mk(fs);
  clk = 1234;
  const r = s.save('agent', envelope({ updatedAt: 500 }));
  A.eq(r.ok, true, 'save ok');
  A.eq(r.updatedAt, 500, 'returns the stored updatedAt');
  A.eq(s.load('agent').agent.name, 'NOVA', 'load returns the persisted agent verbatim');
  A.eq(s.load('agent').agent.stats.xp, 42, 'nested stats preserved');
  // atomicity: every persisted file arrived via a rename from a .tmp; nothing left behind
  const renames = fs.events.filter(e => e[0] === 'rename');
  A.ok(renames.length >= 1, 'save renamed a temp onto the target');
  A.ok(renames.every(e => /\.tmp$/.test(e[1]) && !/\.tmp$/.test(e[2])), 'rename goes .tmp -> final');
  A.ok(![...fs.files.keys()].some(k => /\.tmp$/.test(k)), 'no .tmp file left behind');
  A.ok(fs.files.has(pathMod.join(ROOT, 'agent.save.json')), 'final save file exists');
  // a fresh store rebuilt from the same fs sees the persisted record (durable across restarts)
  s = mk(fs);
  A.eq(s.load('agent').agent.name, 'NOVA', 'save survives a fresh store instance');
}

// ---- D. corrupt save file -> undefined and a fresh save still works ----
{
  const fs = memFs();
  fs.files.set(pathMod.join(ROOT, 'agent.save.json'), '{not json');
  const s = mk(fs);
  A.eq(s.load('agent'), undefined, 'corrupt save -> undefined');
  A.eq(s.save('agent', envelope({ updatedAt: 10 })).ok, true, 'save recovers over a corrupt file');
  A.eq(s.load('agent').agent.name, 'NOVA', 'recovered save loads');
}

// ---- E. anti-clobber: an OLDER updatedAt is refused; equal/newer is accepted (monotonic in time) ----
{
  const fs = memFs();
  const s = mk(fs);
  s.save('agent', envelope({ updatedAt: 200, agent: { id: 'agent', name: 'NEW' } }));
  // a stale background tab tries to push an older snapshot -> refused, on-disk save unchanged
  const stale = s.save('agent', envelope({ updatedAt: 150, agent: { id: 'agent', name: 'OLD' } }));
  A.eq(stale.ok, false, 'older updatedAt refused');
  A.eq(stale.stale, true, 'flagged stale');
  A.eq(s.load('agent').agent.name, 'NEW', 'on-disk save not clobbered by the stale write');
  // equal updatedAt is allowed (idempotent re-push / same-ms update)
  A.eq(s.save('agent', envelope({ updatedAt: 200, agent: { id: 'agent', name: 'SAME' } })).ok, true, 'equal updatedAt accepted');
  A.eq(s.load('agent').agent.name, 'SAME', 'equal-ts write applied');
  // a newer save wins
  A.eq(s.save('agent', envelope({ updatedAt: 999, agent: { id: 'agent', name: 'NEWER' } })).ok, true, 'newer updatedAt accepted');
  A.eq(s.load('agent').agent.name, 'NEWER', 'newer write applied');
}

// ---- E2. WINDOWS ERRNO: a present-but-LOCKED prior save is NOT clobbered (unreadable != absent) ----
// Regression armor: a non-ENOENT read error must not be conflated with "no file", or a stale tab's save would
// overwrite a newer record we merely failed to read. A genuinely corrupt (parsed-garbage) file still recovers.
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  s.save('agent', envelope({ updatedAt: 900, agent: { id: 'agent', name: 'NEWEST' } }));   // a good, recent save on disk
  // lock the record: every read of the main file throws EBUSY (a Windows file lock)
  const realRead = fs.readFileSync.bind(fs);
  fs.readFileSync = (p) => { if (p === file) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return realRead(p); };

  const r = s.save('agent', envelope({ updatedAt: 100, agent: { id: 'agent', name: 'STALE' } }));
  A.eq(r.ok, false, 'a save is REFUSED while the prior record is unreadable (not clobbered)');
  A.eq(r.unreadable, true, 'the refusal is flagged unreadable (distinct from a normal stale-updatedAt refusal)');

  // the record is intact once the lock clears — the STALE write never landed
  fs.readFileSync = realRead;
  A.eq(s.load('agent').agent.name, 'NEWEST', 'the locked record survived intact (no from-empty wipe)');

  // contrast: a genuinely CORRUPT (readable-but-garbage) prior is still safe to recover over (product behavior)
  fs.files.set(file, '{ garbage not json');
  A.eq(s.save('agent', envelope({ updatedAt: 5, agent: { id: 'agent', name: 'FRESH' } })).ok, true, 'a corrupt (parsed-garbage) prior still recovers over');
  A.eq(s.load('agent').agent.name, 'FRESH', 'the recovered-over save loads');
}

// ---- F. a doc with no updatedAt is treated as time 0 (first write lands; later real saves supersede it) ----
{
  const fs = memFs();
  const s = mk(fs);
  A.eq(s.save('agent', { schema: 'starnet.save', agent: { id: 'agent' } }).ok, true, 'first write with no updatedAt lands');
  A.eq(s.save('agent', envelope({ updatedAt: 5 })).ok, true, 'a stamped save supersedes the unstamped one');
  A.eq(s.load('agent').agent.name, 'NOVA', 'stamped save won');
}

// ---- G. agentId jail-grammar enforced (no path traversal via a crafted agentId) ----
{
  const s = mk(memFs());
  A.throws(() => s.load('../escape'), 'traversal agentId rejected on load');
  A.throws(() => s.save('a/b', envelope()), 'slash agentId rejected on save');
  A.throws(() => s.save('agent', null), 'null doc rejected');
  A.throws(() => s.save('agent', 'nope'), 'non-object doc rejected');
}

// ---- H. when the fs supports it, the durable write fsyncs the temp BEFORE the rename (power-loss safety) ----
{
  const calls = [];
  const files = new Map();
  let cur = null;
  const fsyncFs = {
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync() { calls.push('writeFileSync'); },   // the durable path must NOT use this when openSync is present
    renameSync(a, b) { files.set(b, files.get(a)); files.delete(a); calls.push('rename'); },
    mkdirSync() {},
    openSync(p) { cur = { path: p, buf: '' }; calls.push('open'); return 7; },
    writeSync(fd, data) { cur.buf = String(data); calls.push('write'); },
    fsyncSync() { calls.push('fsync'); },
    closeSync() { files.set(cur.path, cur.buf); calls.push('close'); }   // commit the buffered temp on close
  };
  const s = makeSaveStore({ fs: fsyncFs, pathMod, root: ROOT, clock });
  s.save('agent', envelope({ updatedAt: 1 }));
  A.ok(calls.indexOf('fsync') >= 0, 'durable path fsyncs the temp file');
  A.ok(calls.indexOf('fsync') < calls.indexOf('rename'), 'fsync happens BEFORE the rename');
  A.eq(calls.indexOf('writeFileSync'), -1, 'plain writeFileSync NOT used when fsync is available');
  A.eq(s.load('agent').agent.name, 'NOVA', 'durable-path write round-trips');
}

// ---- I. .bak last-known-good: a torn (zero-length) main recovers from the .bak snapshot ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  s.save('agent', envelope({ updatedAt: 300, agent: { id: 'agent', name: 'GOOD' } }));   // clean save on disk
  s.save('agent', envelope({ updatedAt: 400, agent: { id: 'agent', name: 'NEWER' } }));   // a second write snapshots the first to .bak
  A.ok(fs.files.has(file + '.bak'), 'a .bak snapshot was written before the second save');
  // simulate a TORN main (crash left it zero-length)
  fs.files.set(file, '');
  A.eq(s.load('agent').agent.name, 'GOOD', 'a torn (zero-length) main recovers the prior save from .bak');
  // and the anti-clobber gate still uses the recovered value: an OLDER write is refused
  const stale = s.save('agent', envelope({ updatedAt: 100, agent: { id: 'agent', name: 'STALE' } }));
  A.eq(stale.ok, false, 'a stale write is refused even when the prior value came from .bak recovery');
}

// ---- J. quarantine: a corrupt main with NO usable .bak is renamed aside so the store recovers ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  fs.files.set(file, '{ total garbage');   // corrupt, no .bak present
  A.eq(s.load('agent'), undefined, 'corrupt main with no .bak loads as undefined');
  A.ok([...fs.files.keys()].some(k => /\.corrupt-\d+$/.test(k)), 'the corrupt main was quarantined (renamed aside), not left in place');
  A.ok(!fs.files.has(file), 'the corrupt main path is now clear');
  A.eq(s.save('agent', envelope({ updatedAt: 5 })).ok, true, 'a fresh save lands after quarantine');
  A.eq(s.load('agent').agent.name, 'NOVA', 'the fresh save loads cleanly');
}

// ---- K. corrupt main but a CLEAN .bak: recover from .bak AND quarantine the corrupt main ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  fs.files.set(file + '.bak', JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 700, savedAt: 1, doc: envelope({ updatedAt: 700, agent: { id: 'agent', name: 'FROMBAK' } }) }));
  fs.files.set(file, '{ corrupt main');
  A.eq(s.load('agent').agent.name, 'FROMBAK', 'a corrupt main recovers the save from a clean .bak');
  A.ok([...fs.files.keys()].some(k => /\.corrupt-\d+$/.test(k)), 'the corrupt main was quarantined even though .bak recovered');
}

// ---- L. RECOVERY NOTICE (EL-11 FIX 2): a double-corrupt save (main + .bak both bad) persists a
// 'quarantined' marker so boot can DISCLOSE the loss instead of silently presenting first-run ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  fs.files.set(file, '{ total garbage');
  fs.files.set(file + '.bak', 'also garbage');
  A.eq(s.load('agent'), undefined, 'double-corrupt (main + .bak) loads as undefined');
  const n = s.recoveryNotice('agent');
  A.ok(n && n.kind === 'quarantined', 'an unrecoverable quarantine persists a "quarantined" recovery marker');
  A.ok(/\.corrupt-\d+/.test(String((n && n.quarantinedTo) || '')), 'the marker names the quarantined forensic copy path');
  A.ok(Number(n && n.at) > 0, 'the marker is timestamped');
  s.load('agent');   // subsequent loads (boot re-reads) must not destroy or duplicate the marker
  A.ok(s.recoveryNotice('agent') && s.recoveryNotice('agent').kind === 'quarantined', 'the marker persists across later loads');
  // the ack (POST /api/save/recovery-ack) clears it so the notice shows exactly once
  A.eq(s.clearRecoveryNotice('agent'), true, 'ack clears the recovery marker');
  A.eq(s.recoveryNotice('agent'), undefined, 'a cleared marker reads as none');
}

// ---- M. RECOVERY NOTICE (EL-11 FIX 3): a silent .bak recovery persists a 'recovered' marker ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  fs.files.set(file + '.bak', JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 700, savedAt: 1, doc: envelope({ updatedAt: 700, agent: { id: 'agent', name: 'FROMBAK' } }) }));
  fs.files.set(file, '{ corrupt main');
  A.eq(s.load('agent').agent.name, 'FROMBAK', 'recovers from .bak');
  const n = s.recoveryNotice('agent');
  A.ok(n && n.kind === 'recovered', 'a .bak recovery persists a "recovered" marker (the user learns it happened)');
  A.ok(/\.corrupt-\d+/.test(String((n && n.quarantinedTo) || '')), 'the recovered marker still names the quarantined main');
}

// ---- N. RECOVERY NOTICE: worse news is sticky — an unacked "quarantined" is never papered over ----
{
  const fs = memFs();
  const s = mk(fs);
  const file = pathMod.join(ROOT, 'agent.save.json');
  // first: unrecoverable quarantine → 'quarantined' marker
  fs.files.set(file, '{ garbage'); fs.files.set(file + '.bak', 'garbage too');
  s.load('agent');
  A.eq(s.recoveryNotice('agent').kind, 'quarantined', 'quarantined marker written');
  // later: a fresh save + .bak snapshot, main corrupts again, .bak recovers → would write 'recovered'
  A.eq(s.save('agent', envelope({ updatedAt: 800 })).ok, true, 'fresh save lands after quarantine');
  A.eq(s.save('agent', envelope({ updatedAt: 900 })).ok, true, 'second save snapshots .bak');
  fs.files.set(file, '{ corrupt again');
  A.ok(s.load('agent'), 'recovers from .bak');
  A.eq(s.recoveryNotice('agent').kind, 'quarantined', 'the unacked "quarantined" marker is NOT downgraded to "recovered"');
}

// ---- O. RECOVERY NOTICE: a clean store has no marker, and normal saves never mint one ----
{
  const fs = memFs();
  const s = mk(fs);
  A.eq(s.recoveryNotice('agent'), undefined, 'a clean/new store carries no recovery marker');
  A.eq(s.save('agent', envelope({ updatedAt: 5 })).ok, true, 'normal save works');
  A.eq(s.recoveryNotice('agent'), undefined, 'a normal save writes no marker');
}

// ---- P. SHORT-WRITE SAFETY: a writeSync that makes partial progress must still produce a COMPLETE save ----
// POSIX lets writeSync return having written fewer bytes than asked. The old single-shot write fsynced and
// renamed that PREFIX over the good main while save() reported ok — the next load quarantined it and fell
// back to .bak, losing the acknowledged save. Same hazard durable-write.js documents; savestore predated it.
{
  const base = memFs();
  const fds = new Map(); let fdSeq = 0;
  const fsx = Object.assign({}, base, {
    openSync(p) { const id = ++fdSeq; fds.set(id, { p, chunks: [] }); return id; },
    writeSync(fd, buf, offset, len) {
      const f = fds.get(fd);
      const n = Math.min(3, len);   // trickle: at most 3 bytes per call
      f.chunks.push(Buffer.from(buf.slice(offset, offset + n)));
      return n;
    },
    fsyncSync() {},
    closeSync(fd) { const f = fds.get(fd); if (f) { base.files.set(f.p, Buffer.concat(f.chunks).toString('utf8')); base.events.push(['write', f.p]); fds.delete(fd); } }
  });
  const s = mk(fsx);
  const r = s.save('agent', envelope({ updatedAt: 200, agent: { id: 'agent', name: 'TRICKLE-ÅÖÜ', stats: { xp: 7 } } }));
  A.eq(r.ok, true, 'save succeeds over a trickling writeSync');
  const back = s.load('agent');
  A.eq(back && back.agent && back.agent.name, 'TRICKLE-ÅÖÜ', 'the FULL envelope (multi-byte chars included) round-trips — never a fsynced prefix');
}

// A torn/missing main does not authorize replacement while its backup is temporarily locked.
for (const torn of [false, true]) {
  const base = memFs(), file = pathMod.join(ROOT, 'agent.save.json');
  const bytes = JSON.stringify({ updatedAt: 700, doc: envelope({ updatedAt: 700 }) });
  base.files.set(file + '.bak', bytes);
  if (torn) base.files.set(file, '{ torn');
  let locked = true;
  const s = mk({ ...base, readFileSync(p) {
    if (locked && p === file + '.bak') throw Object.assign(new Error('locked'), { code: 'EACCES' });
    return base.readFileSync(p);
  } });
  A.eq(s.loadState('agent').status, 'unreadable', 'backup read fault is unknown even with torn main');
  A.eq(s.save('agent', envelope({ updatedAt: 900 })).ok, false, 'refuse replacement over unreadable backup');
  A.eq(base.files.get(file + '.bak'), bytes, 'backup bytes retained');
  A.eq(base.files.has(file), torn, 'main not replaced or quarantined during read fault');
  locked = false;
  A.eq(s.load('agent').updatedAt, 700, 'recovery works after backup unlock');
  A.eq(s.recoveryNotice('agent').kind, 'recovered', 'backup recovery disclosed');
  s.clearRecoveryNotice('agent'); s.load('agent');
  A.eq(s.recoveryNotice('agent'), undefined, 'reading recovered backup does not re-arm acknowledged notice');
}

A.report('save.test');
