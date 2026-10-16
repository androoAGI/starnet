/* sidecar/workspace-lineage.js — bounded evidence that this machine had StarNet state before this boot. */
'use strict';
const { note: failNote } = require('./failopen.js');

// The desktop migration transaction seals even an empty first-run generation with a receipt. The receipt is
// bookkeeping, not user state; any files it actually migrated are scanned independently below.
// E-STOP/scheduler bookkeeping is INFRA, never evidence: the desktop shell fires POST /api/halt on EVERY
// clean quit, which durably writes loops.halt.json + nightshift.state.json (+ cron.halt.json when armed)
// even on a station that was never created — so a fresh install that was merely opened and closed once
// carried "prior station evidence" and stranded on the recovery gate forever (2026-08-25). A file the
// sidecar can write WITHOUT a Commander having created a station must never count as a prior station.
// Same class, different writer (#123): the quest-refresh boot tick (index.js armQuestRefresh) persists
// _station.questrefresh.json (+ .bak) ~3 s into EVERY boot — key or no key, station or no station.
const INFRA = /^(?:\.starnet-workspace-owner\.json|\.schema-version\.json(?:\.bak)?|\.migrated|\.migration-receipt\.json|cron\.lock|proc-ledger\.json|liveprices\.cache\.json|(?:cron\.halt|loops\.halt|nightshift\.state)\.json(?:\.bak)?|_station\.questrefresh\.json(?:\.bak)?)$/i;
// Positive evidence only. The former "anything not on the infrastructure denylist" rule made every newly
// introduced cache/receipt a fake prior station. This covers the harness-owned durable authorities without
// treating an arbitrary future `*.cache.json` as proof that a Commander already created a station.
const STATE_EVIDENCE = /^(?:agent\.save\.json(?:\.bak|\.corrupt-\d+)?|agent\.roster\.json(?:\.bak)?|(?:transcript|ledger|runs|growth-ratings|skills|skillprefs|autonomy\.ledger|deliverables\.library)\.jsonl|(?:budget|fallback|station\.widgets|memory\.config|study\.state|projects|personalization|recommendations|task-briefs|threads|execution-settings|terminal-sessions|subagents|routing\.plan|toolsets|usercommands)\.json(?:\.bak)?|(?:skills-allowed|skill-registries|skill-exchange-metrics|permissions\.(?:allow|bypass)|hooks(?:-allowed)?|plugins-allowed|cron\.(?:jobs|armed)|loops|nightshift\.(?:drafts|learn|acts)|nightfocus\.state|scout\.(?:interests|state))\.json(?:\.bak)?|_(?:station|commander)\.[a-z0-9._-]+\.json(?:\.bak)?|[a-z0-9_-]+\.(?:notebook|todo|declined|minted|pending|workshop|deliverables)\.json(?:\.bak)?|.*\.starnet-(?:backup|recovery)\.json)$/i;

function meaningfulEntries(fs, path, root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root).filter(name => {
      if (INFRA.test(name)) return false;
      if (/\.tmp(?:\.|$)/i.test(name)) return false;
      if (name === '.browser-profile') return false;
      return STATE_EVIDENCE.test(name);
    }).slice(0, 40).map(name => ({ name, path: path.join(root, name) }));
  } catch (_) { return []; }
}

// START FRESH marker: the Commander explicitly chose a new station over external prior-install evidence
// (legacy roots, update snapshots) that nothing could recover. It lists the acknowledged roots; evidence from
// those roots no longer gates. It NEVER suppresses current-workspace evidence — real station files in the live
// workspace are always honored. Not in STATE_EVIDENCE, so the marker itself is never "prior state".
const FRESH_MARKER = '.fresh-start.json';
const QUARANTINE_DIR = 'workspace-quarantine';

function readFreshMarker(fs, path, current) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(current, FRESH_MARKER), 'utf8'));
    if (!v || v.version !== 1 || !Array.isArray(v.acknowledgedRoots)) return null;
    return v;
  } catch (_) { return null; }
}

function sameRoot(a, b, path, platform) {
  const x = path.resolve(String(a)), y = path.resolve(String(b));
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
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
  if (entries.length) {
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

module.exports = { inspectWorkspaceLineage: inspectWorkspaceLineage, startFresh: startFresh, FRESH_MARKER: FRESH_MARKER, _internals: { meaningfulEntries: meaningfulEntries, STATE_EVIDENCE: STATE_EVIDENCE } };
