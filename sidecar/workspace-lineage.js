/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';
const { note: failNote } = require('./failopen.js');
// Whether a workspace holds a station, was erased or was reset is ONE fact: the station record (station-record.js, the
// lifecycle's one module). Every question below asks it through read(), which applies P1: a save or roster file under any
// of its names is always a station, the record decides soft bookkeeping, and a workspace with no usable record still
// answers by the frozen fallback rule. The record module also holds the one path rule and the lifecycle file names.
const SR = require('./station-record.js');
const { meaningfulEntries, bookkeepingEntries, sameRoot, QUARANTINE_DIR } = SR;

// a reader's in-memory derive only stamps when it derived; nothing here persists it, so a caller without a clock is fine
function zeroClock() { return 0; }
function recordDeps(d, root) {
  return { fs: d.fs, path: d.path, platform: d.platform, now: typeof d.now === 'function' ? d.now : zeroClock, randomId: d.randomId, workspaceRoot: root };
}

// Does this workspace hold a station a Commander created? The SAME positive evidence the recovery gate reads, so a
// background writer that checks it first can never be the file that makes a station-less workspace look like one.
function hasStationState(deps) {
  const d = deps || {};
  return meaningfulEntries(d.fs, d.path, d.path.resolve(String(d.workspaceRoot || ''))).length > 0;
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
   left a user on PRIOR STATION DATA FOUND with nothing recoverable and no way forward). Moves every
   current-workspace state file into a sibling quarantine folder (NEVER deletes — a wrong click is
   reversible by hand), then records the clean generation through the station record module: state none, a reset
   from now, the erase authority of the generation it replaces CARRIED (an ERASE is never weakened by a later START
   FRESH, gh#101) and every root a prior reset acknowledged kept, plus the external evidence roots this choice
   acknowledges — and the legacy marker mirror in the native door's exact shape, so an older build reads the same reset.
   Returns what moved. Fails closed: any rename error stops the pass with the files that already moved reported, nothing lost. */
function startFresh(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const now = typeof d.now === 'function' ? d.now : zeroClock;   // host injects the wall clock (determinism law)
  const current = path.resolve(String(d.workspaceRoot || ''));
  const lineage = inspectWorkspaceLineage(d);
  const prior = SR.read(recordDeps(d, current));   // the generation START FRESH replaces
  const at = Math.floor(Number(now()) || 0);
  const stamp = new Date(at).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const quarantine = path.join(path.dirname(current), QUARANTINE_DIR, stamp);
  const moved = [];
  /* DRAIN, never sample: meaningfulEntries caps each listing at 40 for the gate's BOUNDED evidence
     report, but Start Fresh must move EVERY state file — moving one 40-file page and returning ok left
     the rest as live current-workspace evidence, so the next inspect kept the PRIOR STATION DATA gate
     shut (the exact dead end this exit was built to remove) with the station torn in half (early-
     alphabet files quarantined, later ones live). Loop pages until the listing is empty; the pass
     ceiling only guards against a pathological directory that regrows entries. */
  let entries = meaningfulEntries(fs, path, current);
  const bookkeeping = bookkeepingEntries(fs, path, current);
  if (entries.length || bookkeeping.length) {
    try { fs.mkdirSync(quarantine, { recursive: true }); }
    catch (e) { return { ok: false, error: 'could not create quarantine folder: ' + String(e && e.message || e), quarantine, moved }; }
    let passes = 0;
    while (entries.length) {
      if (++passes > 200) return { ok: false, error: 'quarantine did not converge after 200 passes', quarantine, moved };
      for (const entry of entries) {
        try { fs.renameSync(entry.path, path.join(quarantine, entry.name)); moved.push(entry.name); }
        catch (e) { return { ok: false, error: 'could not move ' + entry.name + ': ' + String(e && e.message || e), quarantine, moved }; }
      }
      entries = meaningfulEntries(fs, path, current);
    }
    for (const entry of bookkeeping) {   // never evidence, but this station's — it leaves with the station
      try { fs.renameSync(entry.path, path.join(quarantine, entry.name)); moved.push(entry.name); }
      catch (e) { return { ok: false, error: 'could not move ' + entry.name + ': ' + String(e && e.message || e), quarantine, moved }; }
    }
  }
  const acknowledgedRoots = lineage.evidence
    .filter(row => row.kind === 'legacy-workspace' || row.kind === 'update-snapshot')
    .map(row => row.root);
  const setAside = moved.length ? quarantine : null;
  const record = SR.freshRecord(recordDeps(d, current), prior.record, { at, acknowledgedRoots, setAside });
  try {
    try { fs.mkdirSync(current, { recursive: true }); } catch (e) { failNote('lineage.startFresh.mkdir', e); }   // the writes below report the real failure
    // the mirror first: if the record write then fails, the next boot re-derives this same reset from the mirror
    SR.writeMirror(recordDeps(d, current), current, record, { quarantine: setAside, moved });
    // a record this build cannot read (torn, unreadable, or a newer build's) is never written over: the owner's next boot
    // sets torn bytes aside and derives this reset from the mirror, and a newer build's record stays as it is
    if (!prior.recordProblem) SR.writeRecord(recordDeps(d, current), current, record);
  } catch (e) { return { ok: false, error: 'could not record the fresh start: ' + String(e && e.message || e), quarantine, moved }; }
  return { ok: true, quarantine: setAside, moved, acknowledgedRoots: record.acknowledgedRoots };
}

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, hasStationState: hasStationState, startFresh: startFresh };
