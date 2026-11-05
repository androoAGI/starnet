/* sidecar/checkpoint.js — the PURE snapshot-index reducer of the execution-spine rollback net (Commit 1).

   The pure half of the checkpoint determinism split (docs/EXECUTION_SPINE_PLAN.md §3): this file owns the
   snapshot INDEX (which snapshots exist, their lineage, which one a rollback targets); the ambient half —
   the actual content-addressed shadow-git store under WORKSPACES/.checkpoints/<agentId>/, the real
   now-source, and id minting — lives ONLY in sidecar/index.js. Every function here is a pure transform with
   `now` INJECTED as a parameter; there is NO Date.now / Math.random / new Date() / fs, so it passes
   lint-determinism.js and is headless-testable exactly like cron-store.js / loop.js.

   A snapshot record (the snapshotId is a content hash minted by the ambient git layer):
     { id, runId, turn:int, parentId:string|null, ts:int, files:int, bytes:int, label,
       scopeId?:string, workTree?:string, gitCommit?:string, links?:[{ path, kind }], linksTotal?:int }
   links/linksTotal name the links (junctions, symlinks, mount points) checkpoint-store's capture left out of it.
   The optional scope fields bind a restore point to an explicitly-authorized external project root. They are
   ambient metadata only: the pure reducer preserves them, while checkpoint-store owns validation + access.
   The persisted index envelope (one per agent, fail-closed on load):
     { version:1, snapshots:[ ... ] }

   Surface (every op returns a NEW index/array; the input is never mutated):
     makeSnapshot(meta, { now })            -> snapshot              // normalize one record (throws on no id)
     record(index, meta, { now, keep? })    -> index'               // append (+ optional prune to last `keep`)
     prune(index, keep)                     -> index'               // keep the most recent `keep` snapshots
     findById(index, id)                    -> snapshot | null
     latest(index)                          -> snapshot | null
     firstOfRun(index, runId)               -> snapshot | null       // the run's earliest (pre-first-mutation) snap
     rollbackTargetForRun(index, runId)     -> snapshotId | null     // the state to restore to UNDO a whole run
     resolveForTurn(index, runId, turn)     -> snapshot | null       // the snap to rewind a run to a given turn
     loadIndex(rawObjOrString)             -> { version, snapshots } // tolerant, fail-closed
     toIndex(snapshots)                    -> { version, snapshots } // for persistence */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { (root.SK = root.SK || {}).checkpoint = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENVELOPE_VERSION = 1;
  const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;        // a git-oid-ish content id (hex, or a labelled hash)
  const MAX_LINKS = 32;                             // links named on one record (linksTotal counts them all)

  function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

  function snapshotsOf(index) {
    if (Array.isArray(index)) return index;                       // tolerate a bare array
    return (index && Array.isArray(index.snapshots)) ? index.snapshots : [];
  }

  /* makeSnapshot — normalize a snapshot record. `id` comes from meta.id (the git content hash minted by the
     host); `now` stamps ts. Throws on a missing/invalid id so a bad record never enters the index. */
  function makeSnapshot(meta, ctx) {
    meta = meta || {}; ctx = ctx || {};
    const id = meta.id;
    if (!isValidId(id)) throw new Error('checkpoint: invalid snapshot id (must match ' + ID_RE + ')');
    const snap = {
      id: String(id),
      runId: meta.runId != null ? String(meta.runId) : '',
      turn: Number.isFinite(meta.turn) ? (meta.turn | 0) : 0,
      parentId: meta.parentId != null ? String(meta.parentId) : null,
      ts: ctx.now || 0,
      files: Number.isFinite(meta.files) ? (meta.files | 0) : 0,
      bytes: Number.isFinite(meta.bytes) ? (meta.bytes | 0) : 0,
      label: meta.label != null ? String(meta.label) : '',
      scopeId: meta.scopeId != null ? String(meta.scopeId) : '',
      workTree: meta.workTree != null ? String(meta.workTree) : '',
      gitCommit: meta.gitCommit != null ? String(meta.gitCommit) : ''
    };
    // the links the capture left out (checkpoint-store's link boundary): present only when there were any
    const links = Array.isArray(meta.links) ? meta.links.filter(function (l) { return l && typeof l.path === 'string'; }) : [];
    if (links.length) {
      snap.links = links.slice(0, MAX_LINKS).map(function (l) { return { path: String(l.path), kind: String(l.kind || '') }; });
      snap.linksTotal = Number.isFinite(meta.linksTotal) && meta.linksTotal >= links.length ? (meta.linksTotal | 0) : links.length;
    }
    return snap;
  }

  function prune(index, keep) {
    const snaps = snapshotsOf(index);
    const k = (keep != null && keep >= 0) ? (keep | 0) : snaps.length;
    const kept = k >= snaps.length ? snaps.slice() : snaps.slice(snaps.length - k);
    return { version: ENVELOPE_VERSION, snapshots: kept };
  }

  /* record — append a normalized snapshot (newest last), then optionally prune to the most recent `keep`.
     parentId defaults to the current latest snapshot's id (lineage) when the caller doesn't supply one. */
  function record(index, meta, ctx) {
    ctx = ctx || {};
    const snaps = snapshotsOf(index);
    const head = snaps.length ? snaps[snaps.length - 1] : null;
    const withParent = (meta && meta.parentId == null && head)
      ? Object.assign({}, meta, { parentId: head.id })
      : meta;
    const snap = makeSnapshot(withParent, ctx);
    const next = { version: ENVELOPE_VERSION, snapshots: snaps.concat([snap]) };
    return ctx.keep != null ? prune(next, ctx.keep) : next;
  }

  function findById(index, id) { return snapshotsOf(index).find(s => s && s.id === id) || null; }

  function latest(index) { const s = snapshotsOf(index); return s.length ? s[s.length - 1] : null; }

  function firstOfRun(index, runId) { return snapshotsOf(index).find(s => s && s.runId === runId) || null; }

  /* rollbackTargetForRun — to UNDO an entire run, restore the workspace to the state it had BEFORE the run's
     first mutation: the parentId of that run's first snapshot. null if the run is the very first history
     (nothing earlier to restore) or unknown. */
  function rollbackTargetForRun(index, runId) {
    const first = firstOfRun(index, runId);
    return first && first.parentId ? first.parentId : null;
  }

  /* resolveForTurn — the snapshot taken for (runId, turn): rewind a run to a specific turn's pre-state. */
  function resolveForTurn(index, runId, turn) {
    return snapshotsOf(index).find(s => s && s.runId === runId && s.turn === (turn | 0)) || null;
  }

  /* loadIndex — normalize whatever came off disk into a valid { version, snapshots } envelope. Tolerates a
     JSON string, a parsed object, a bare array, null, or garbage; fail-closed to an empty index; drops
     malformed records (missing/invalid id). */
  function loadIndex(raw) {
    let obj = raw;
    if (typeof raw === 'string') { try { obj = JSON.parse(raw); } catch (e) { obj = null; } }
    const snaps = snapshotsOf(obj).filter(s => s && typeof s === 'object' && isValidId(s.id));
    return { version: ENVELOPE_VERSION, snapshots: snaps };
  }

  function toIndex(snapshots) { return { version: ENVELOPE_VERSION, snapshots: (snapshots || []).slice() }; }

  return {
    makeSnapshot: makeSnapshot,
    record: record,
    prune: prune,
    findById: findById,
    latest: latest,
    firstOfRun: firstOfRun,
    rollbackTargetForRun: rollbackTargetForRun,
    resolveForTurn: resolveForTurn,
    loadIndex: loadIndex,
    toIndex: toIndex,
    isValidId: isValidId,
    ENVELOPE_VERSION: ENVELOPE_VERSION
  };
});
