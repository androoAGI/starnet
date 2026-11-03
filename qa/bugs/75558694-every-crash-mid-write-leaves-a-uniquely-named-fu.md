---
fingerprint: 75558694
slug: every-crash-mid-write-leaves-a-uniquely-named-fu
title: Every crash mid-write leaves a uniquely named full-copy tmp file that nothing ever sweeps
surface: sessions
severity: P2
status: fixed
found: 2026-10-20
lane: sweep/sessions
fix: 9d4f5ff13 b1b0be499 cb6ff28fa d05241c24 95d71f8c5
origin: audit
family: save-lifecycle
---

# Every crash mid-write leaves a uniquely named full-copy tmp file that nothing ever sweeps

## Symptom

The durable writers do keep their promise: a crash at any point leaves the last good or the new state, never a torn
one. But a crash between the temp write and the rename leaves the temp file behind. `durable-write.js` names temps
`<file>.<pid>.<random>.tmp`, so every crash adds a new orphan holding a full (or partial) copy of that store,
including credential stores such as channel secrets and connector keys (mode 0600). Nothing removes them. The save
store reuses `<file>.<seq>.tmp` names, so it leaves at most a few.

A write that FAILS leaves one too: when the rename is refused (EPERM from a lock on Windows), or the `.bak` copy fails,
the writer throws and the full-copy temp stays.

## Repro

1. Run a write through `makeDurableJsonStore(...).update()` in a child process whose fs facade kills the process (SIGKILL) on the first `writeSync` or `fsyncSync` of the main temp.
2. Restart, read the store, and list the directory.
3. For the failure case: make `renameSync` of the temp fail with EPERM (or, with no hard links, make the `.bak` copy fail with ENOSPC) and list the directory after the write throws.

## Evidence

Kill harness (111 kill points over the real `savestore.js`, `durable-store.js` and `logbound.js appendJsonlDurable`):
`TOTAL 111 BAD 0`. Every restart read the last good or the new state, and the next write succeeded. The directories
afterwards:

```
durablestore write:2:100  died ok:OLD2 | rec.json rec.json.33312.2551f26fda0f.tmp rec.json.bak
durablestore fsync:3      died ok:OLD2 | rec.json rec.json.45092.6064ad1469cd.tmp rec.json.bak
durablestore rename:1     died ok:OLD2 | rec.json rec.json.bak rec.json.bak.46180.a105bf91f91c.tmp
savestore    write:2:100  died ok:OLD2 | agent.save.json agent.save.json.2.tmp agent.save.json.bak
```

Anchor: `sidecar/durable-write.js:48` (`const tmp = file + '.' + process.pid + '.' + nonce + '.tmp';`). No sidecar
code removes stale `*.tmp` siblings at boot. This is disk growth and stray copies, not lost state.

_Found by the `sweep/sessions` lane (sessions surface), 2026-10-20._

Failed writes (persist-module planning probe at 0b8441064, real fs plus a fault facade, each store built the way
index.js builds it): T1, a rename refused with EPERM, leaves `a.json.<pid>.<hex>.tmp` (durable-store),
`agent.save.json.2.tmp` (savestore) and `chatmap.json.<pid>.<hex>.tmp` (channels/store); B1, a `.bak` refresh that
fails (no hard link, the copy hits ENOSPC), leaves a `.bak.*.tmp` in all three. `sidecar/durable-write.js:87` threw
with no unlink. The run journal's repair and workspace-recovery's request writer had their own temp names
(`<file>.repair-<hex>`, `<file>.tmp-<pid>-<now>-<seq>`).

`test/persist.conformance.test.js` INV-2 at 0b8441064, among its rows:

```
FAIL: INV-2 [general | link link] killed at write point 5/11: and leaves no temp of the file or its .bak — expected ["V3",[]], got ["V3",["store.json.2147483644.6832a75895c1.tmp"]]
FAIL: INV-2 [channels chatmap | link link] killed at write point 5/11: and leaves no temp of the file or its .bak — expected ["V3",[]], got ["V3",["chatmap.json.2147483644.583f44519493.tmp"]]
FAIL: INV-2 [deliverables snapshot | link link] killed at write point 5/11: and leaves no temp of the file or its .bak — expected ["V3",[]], got ["V3",["deliverables.library.json.2147483644.e9a094d3f7c2.tmp"]]
```

`test/persist-seam.http.test.js` at 0b8441064, through index.js (a temp of agent.save.json stamped with an exited
child's pid, then POST /api/save):

```
FAIL: S1: the dead writer's temp agent.save.json.64672.5ea70001dead.tmp is swept by the save
```

## Verdict

Fixed by the persist-module lane: 9d4f5ff13 (sidecar/persist writeAtomic, and the general and full-state stores),
b1b0be499 (the channel stores), cb6ff28fa (the station save) and d05241c24 (the run journal's repair, the
workspace-recovery files, the deliverables library and the START FRESH marker). Every store the lane moved (everything
that wrote through durable-write.js, the station save, the channel stores, the deliverables library, the run journal's
repair, the workspace-recovery files and the marker) shares one temp grammar, `<file>.<pid>.<nonce>.tmp`.
Ordinary replacements use `sidecar/persist/write.js` writeAtomic; journal repair retains its own append/in-place
protocol and uses persist's names, owned evidence copy and sweeper.

- THE CLEANUP: any failure after the temp exists (a short write, a failed fsync, a refused rename) unlinks the temp
  before the error is rethrown. A temp that cannot be unlinked is noted (failNote persist.temp), never silent.
- THE SWEEPER: after a successful write, once per file per process, the file's own temps are removed when an
  own-grammar temp's pid is dead (process.kill(pid, 0); EPERM counts as alive), or when a legacy temp
  (`<file>.<n>.tmp`, `<file>.tmp-<pid>-<now>-<seq>`, `<file>.repair-<hex>`) is more than 10 minutes older than the file
  just written (the filesystem's clock). One readdir per folder per process. It never touches another file's temps, a
  live writer's temp regardless of age, a `.bak` or a forensic copy. A replace also sweeps its `.bak`'s own temps.

There is no boot-wide sweep (decision D5): a crash temp goes on its file's next successful write. Proof:
`test/persist.conformance.test.js` INV-2 (a crash at every write point and every failed write, for every store) and
`test/persist-seam.http.test.js` S1 through index.js (a provably dead pid's temp swept, a live pid's kept), RED at
0b8441064 and GREEN at the lane tip. `test/persist.lint.test.js` keeps a new direct writer from appearing in the
sidecar. The writers that are not on persist yet are its baseline rows and keep their own temp names: environment's
`.tmp-<pid>` and procledger's `.<pid>.tmp` can still leave one temp per crashed process. They move in their own lanes.

Review follow-up 95d71f8c5 resolves the earlier conflict between the age rule and live-owner preservation: a paused
writer can still finish its old temp after another write sweeps. The exact 6ed58a52c source control fails that row;
the repaired conformance suite passes 3846 assertions, including dead-owner cleanup and preserved legacy handling.
PID reuse can conservatively keep an old own-grammar temp until that process exits. Combined landing gates remain
separate from this focused source evidence.
