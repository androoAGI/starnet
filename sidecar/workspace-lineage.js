/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';
const { note: failNote } = require('./failopen.js');
// The prior-station evidence rule (the INFRA and quest-refresh bookkeeping exclusions, the STATE_EVIDENCE allowlist,
// meaningfulEntries), the one Windows case-fold path rule and the lifecycle file names live in station-record.js, the
// station lifecycle's one module, where the evidence rule is frozen as the record's fallback.
const {
  meaningfulEntries, bookkeepingEntries, sameRoot, STATE_EVIDENCE, FRESH_MARKER, QUARANTINE_DIR
} = require('./station-record.js');

// Does this workspace hold a station a Commander created? The SAME positive evidence the recovery gate reads, so a
// background writer that checks it first can never be the file that makes a station-less workspace look like one.
function hasStationState(deps) {
  const d = deps || {};
  return meaningfulEntries(d.fs, d.path, d.path.resolve(String(d.workspaceRoot || ''))).length > 0;
}

// START FRESH marker (FRESH_MARKER): the Commander explicitly chose a new station over external prior-install evidence
// (legacy roots, update snapshots) that nothing could recover. It lists the acknowledged roots; evidence from
// those roots no longer gates. It NEVER suppresses current-workspace evidence — real station files in the live
// workspace are always honored. Not in STATE_EVIDENCE, so the marker itself is never "prior state".
function readFreshMarker(fs, path, current) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(current, FRESH_MARKER), 'utf8'));
    if (!v || v.version !== 1 || !Array.isArray(v.acknowledgedRoots)) return null;
    return v;
  } catch (_) { return null; }
}

function inspectWorkspaceLineage(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const current = path.resolve(String(d.workspaceRoot || ''));
  const same = (a, b) => sameRoot(a, b, path, d.platform);
  const marker = readFreshMarker(fs, path, current);
  const acknowledged = root => !!marker && marker.acknowledgedRoots.some(r => same(r, root));
  const evidence = [];
  const currentEntries = meaningfulEntries(fs, path, current);
  if (currentEntries.length) evidence.push({ kind: 'current-workspace', root: current, count: currentEntries.length, examples: currentEntries.map(x => x.name).slice(0, 8) });
  if (fs.existsSync(path.join(current, '.migration-pending'))) {
    evidence.push({ kind: 'migration-pending', root: current, count: 1, examples: ['.migration-pending'] });
  }
  for (const root of Array.isArray(d.candidateRoots) ? d.candidateRoots : []) {
    if (!root || same(root, current)) continue;
    const entries = meaningfulEntries(fs, path, root);
    if (entries.length && !acknowledged(root)) evidence.push({ kind: 'legacy-workspace', root: path.resolve(root), count: entries.length, examples: entries.map(x => x.name).slice(0, 8) });
  }
  const snapshotsRoot = path.resolve(String(d.snapshotsRoot || path.join(path.dirname(current), 'update-snapshots')));
  try {
    const snapshots = fs.existsSync(snapshotsRoot)
      ? fs.readdirSync(snapshotsRoot).filter(name => /\.starnet-backup\.json$/i.test(name)).slice(0, 12) : [];
    if (snapshots.length && !acknowledged(snapshotsRoot)) evidence.push({ kind: 'update-snapshot', root: snapshotsRoot, count: snapshots.length, examples: snapshots });
  } catch (_) {}
  return {
    version: 1,
    priorInstallEvidence: evidence.length > 0,
    onboardingAllowed: evidence.length === 0,
    currentWorkspace: current,
    evidence: evidence
  };
}

/* START FRESH — the gate's third exit (2026-08-22: a first-run whose overseer never woke, then a manual reset,
   left a user on PRIOR STATION DATA FOUND with nothing recoverable and no way forward). Moves every
   current-workspace state file into a sibling quarantine folder (NEVER deletes — a wrong click is
   reversible by hand) and writes the marker acknowledging external evidence roots. Returns what moved.
   Fails closed: any rename error stops the pass with the files that already moved reported, nothing lost. */
function startFresh(deps) {
  const d = deps || {}, fs = d.fs, path = d.path;
  const now = typeof d.now === 'function' ? d.now : function () { return 0; };   // host injects the wall clock (determinism law)
  const current = path.resolve(String(d.workspaceRoot || ''));
  const lineage = inspectWorkspaceLineage(d);
  const stamp = new Date(now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
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
  const prior = readFreshMarker(fs, path, current);
  const marker = {
    version: 1,
    at: new Date(now()).toISOString(),
    acknowledgedRoots: Array.from(new Set((prior ? prior.acknowledgedRoots : []).concat(acknowledgedRoots))),
    quarantine: moved.length ? quarantine : null,
    moved
  };
  try {
    try { fs.mkdirSync(current, { recursive: true }); } catch (e) { failNote('lineage.startFresh.mkdir', e); }   // the write below reports the real failure
    fs.writeFileSync(path.join(current, FRESH_MARKER), JSON.stringify(marker, null, 2));
  } catch (e) { return { ok: false, error: 'could not write the fresh-start marker: ' + String(e && e.message || e), quarantine, moved }; }
  return { ok: true, quarantine: marker.quarantine, moved, acknowledgedRoots: marker.acknowledgedRoots };
}

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, hasStationState: hasStationState, startFresh: startFresh, FRESH_MARKER: FRESH_MARKER, _internals: { meaningfulEntries: meaningfulEntries, STATE_EVIDENCE: STATE_EVIDENCE } };
