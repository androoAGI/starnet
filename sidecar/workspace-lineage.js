/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';
// Whether a workspace holds a station, was erased or was reset is ONE fact: the station record (station-record.js, the
// lifecycle's one module). Every question below asks it through read(), which applies P1: a save or roster file under any
// of its names is always a station, the record decides soft bookkeeping, and a workspace with no usable record still
// answers by the frozen fallback rule. The record module also holds the one path rule and the lifecycle file names.
const SR = require('./station-record.js');
const { sameRoot } = SR;
const Recovery = require('./workspace-recovery.js');   // the two-phase lifecycle: its request files and its apply

// a reader's in-memory derive only stamps when it derived; nothing here persists it, so a caller without a clock is fine
function zeroClock() { return 0; }
function recordDeps(d, root) {
  return { fs: d.fs, path: d.path, platform: d.platform, now: typeof d.now === 'function' ? d.now : zeroClock, randomId: d.randomId, workspaceRoot: root };
}

/* The prior-station evidence the onboarding gate reads. The current workspace is evidence iff its record says it holds a
   station (P1); a legacy root is evidence by the same rule until a reset or recovery acknowledged it, and so is a verified
   update snapshot. A reset NEVER suppresses current-workspace evidence: a save or roster that appears in the live
   workspace later is always honored. The examples are names only (the fallback's listing), never file contents. */
function inspectWorkspaceLineage(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const platform = String(d.platform || process.platform);
  const current = path.resolve(String(d.workspaceRoot || ''));
  const record = SR.read(recordDeps(d, current));
  const evidence = [];
  const row = (kind, root, view) => { const names = view.evidenceNames(); return { kind, root, count: names.length, examples: names.slice(0, 8) }; };
  if (record.station()) evidence.push(row('current-workspace', current, record));
  if (fs.existsSync(path.join(current, '.migration-pending'))) {
    evidence.push({ kind: 'migration-pending', root: current, count: 1, examples: ['.migration-pending'] });
  }
  for (const root of Array.isArray(d.candidateRoots) ? d.candidateRoots : []) {
    if (!root || sameRoot(root, current, path, platform) || record.acknowledges(root)) continue;
    const legacy = SR.read(recordDeps(d, root));
    if (legacy.station()) evidence.push(row('legacy-workspace', path.resolve(root), legacy));
  }
  const snapshotsRoot = path.resolve(String(d.snapshotsRoot || path.join(path.dirname(current), 'update-snapshots')));
  try {
    const snapshots = fs.existsSync(snapshotsRoot)
      ? fs.readdirSync(snapshotsRoot).filter(name => /\.starnet-backup\.json$/i.test(name)).slice(0, 12) : [];
    if (snapshots.length && !record.acknowledges(snapshotsRoot)) evidence.push({ kind: 'update-snapshot', root: snapshotsRoot, count: snapshots.length, examples: snapshots });
  } catch (_) {}
  return {
    version: 1,
    priorInstallEvidence: evidence.length > 0,
    onboardingAllowed: evidence.length === 0,
    currentWorkspace: current,
    evidence: evidence,
    station: record.publicView()   // additive: the record's state and generation (the host shows its live record's)
  };
}

/* START FRESH — the gate's third exit (2026-08-22: a first-run whose overseer never woke, then a manual reset,
   left a user on PRIOR STATION DATA FOUND with nothing recoverable and no way forward). START FRESH has ONE meaning, through
   either door: the WHOLE generation is set aside, never a subset of it, because the old jail, chats, bots and line state left
   live would steer the next station. Files stay where they are until the next boot: the running sidecar holds this
   generation open, so this is only the REQUEST, and workspace-recovery.js applyFreshRequest renames the generation into
   workspace-quarantine in its locked pre-claim phase (NEVER a delete: a wrong click is reversible by hand). The request
   pins what the Commander saw (station-record.js freshFacts): if the workspace moves on before the apply, nothing is set
   aside and lineage.lastFresh says why. It also keeps the external evidence roots this choice acknowledges. An ERASE stays
   erased: the clean generation carries the erase authority of the one it replaces (gh#101). */
function requestFresh(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const now = typeof d.now === 'function' ? d.now : zeroClock;   // host injects the wall clock (determinism law)
  const current = path.resolve(String(d.workspaceRoot || ''));
  const acknowledgedRoots = inspectWorkspaceLineage(d).evidence
    .filter(row => row.kind === 'legacy-workspace' || row.kind === 'update-snapshot')
    .map(row => row.root);
  try {
    const request = Recovery.writeFreshRequest({ fs, path, now, workspaceRoot: current, fromVersion: d.buildVersion, acknowledgedRoots,
      facts: SR.freshFacts(recordDeps(d, current)) });
    return { ok: true, restartRequired: true, requestedAt: request.requestedAt, acknowledgedRoots };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, requestFresh: requestFresh };
