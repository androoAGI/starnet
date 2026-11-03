/* node test/station-marker-matrix.test.js — ERASE then restart shows no prior station, and the onboarding gate, automatic
   recovery and the terminal give ONE answer for every lifecycle shape.

   THE FAMILY (B3 lifecycle: gh#123, gh#101, gh#65, bug 5451970e). "Is there a station here, was it erased, was it reset"
   had five readers that disagreed. The terminal answered from a save/roster file probe, so after ERASE EVERYTHING on a
   default Windows install `starnet` booted the old station the erase had set aside in %LOCALAPPDATA%\StarNet\workspaces
   while the app said the computer was clean (gh#101). The gate answered from a filename regex, so a fresh install whose
   scheduler left one bookkeeping file was trapped in Recovery Mode while the terminal saw no station (gh#123). And which
   door wrote the reset decided whether an ERASE kept its authority: a START FRESH after it, native or sidecar, dropped the
   erase, so a station that appeared in another old folder was imported automatically. Every reader now asks the station
   record (sidecar/station-record.js): P1 — a save or roster file always counts, the record decides soft bookkeeping, and a
   workspace with no usable record falls back to the gate's frozen rule.

   SEAMS, each called the way its host calls it:
   - the gate: inspectWorkspaceLineage({ fs, path, platform, workspaceRoot, candidateRoots, now }) — index.js's boot capture;
   - automatic recovery: applyPendingRecovery({ ..., auto: true }) — index.js's pre-claim call — on a SECOND build of the
     same shape (it may import a station), with the scratch guard pointed away from this sandbox;
   - the terminal (bin/starnet.js): defaultWorkspace({}) (the workspace `starnet -p` boots), discoverDesktop(desktop).station
     (what starts the app instead of booting it keyless) and bootstrapWorkspace (what `starnet init` and `starnet -p` write)
     with a profile-shaped env. Process probes are faked only at the transport edge (no owner claim exists).
   The candidate roots are workspace-safety's, from the sandbox profile: what index.js passes in a packaged boot.
   Records and markers are written as FIXTURE BYTES, so nothing here needs the record module to set a shape up: a checkout
   from before the record fails this test on its assertions, not on a missing module. The one row that drives a door (the
   sidecar's START FRESH) fails on its own assertion there, and every other row still runs.

   SHAPES: fresh; bookkeeping under a none record; synthetic 0.13.5 and 0.14.x layouts (the file-name inventories of real
   stations from those builds; contents synthetic) and the 0.9.0 fixture; 0.14.x with its save gone (roster kept) and with
   save and roster gone; a native ERASE plus an install-folder legacy station (gh#101); a legacy marker in each at dialect;
   ERASE then START FRESH through each door (native with its set-aside generation, native with it deleted, the sidecar's)
   and an older build's sidecar START FRESH over a new-build record, each checked against an extra old root no reset
   acknowledged; a torn record, a torn marker, a newer build's record and a copied root; an older build onboarded under a
   none or erased record, and a hand restore that missed the hidden record, with `starnet init` / `-p` straight after (the
   terminal must refuse and write nothing); and a bare `npm start` station nothing set aside (still found). */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const A = require('./_assert.js');

const ROOT = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-marker-matrix-'));
const savedEnv = {};
for (const k of ['LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE', 'STARNET_DEV', 'SKYNET_DEV', 'STARNET_WORKSPACES', 'SKYNET_WORKSPACES']) savedEnv[k] = process.env[k];
// os.homedir() reads these; set before the CLI module is loaded (it reads the profile on every call, never at load)
process.env.HOME = process.env.USERPROFILE = path.join(scratch, 'boot-home');
for (const k of ['STARNET_DEV', 'SKYNET_DEV', 'STARNET_WORKSPACES', 'SKYNET_WORKSPACES']) delete process.env[k];
const cli = require('../bin/starnet.js');
const Lineage = require('../sidecar/workspace-lineage.js');
const Recovery = require('../sidecar/workspace-recovery.js');
const Safety = require('../sidecar/workspace-safety.js');

const T_ERASE = 1793400000000, T_FRESH = 1793450000000, T_OLDER = 1793460000000;
const PLATFORM = process.platform;
const fold = p => (PLATFORM === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const same = (a, b) => fold(a) === fold(b);

/* ---- fixture writers (bytes only; no lane module) ---- */
function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2)); }
function saveEnvelope(name, createdAt) {
  return { version: 1, agentId: 'agent', updatedAt: createdAt + 5, savedAt: createdAt + 5,
    doc: { schema: 'starnet.save', version: 6, updatedAt: createdAt + 5, agent: { id: 'agent', name, createdAt }, workstreams: [] } };
}
function station(dir, name, createdAt) {
  write(path.join(dir, 'agent.save.json'), saveEnvelope(name, createdAt));
  write(path.join(dir, 'agent.roster.json'), { version: 1, agents: [{ agentId: 'agent', name }] });
}
function canonical(ws) { fs.mkdirSync(path.dirname(ws), { recursive: true }); return path.join(fs.realpathSync.native(path.dirname(ws)), path.basename(ws)); }
// a schema-valid v1 station record, as the record module writes one
function record(ws, over) {
  return Object.assign({ schema: 'starnet.station', version: 1, root: canonical(ws), state: 'none', generationId: null, since: T_ERASE,
    by: 'derived', reset: null, eraseAuthority: false, acknowledgedRoots: [], setAside: null, previous: null }, over || {});
}
// the two markers the native door writes (src-tauri/src/fresh_start.rs FreshMarker: at is epoch-ms TEXT)
function nativeMarker(o) { return { version: 1, erased: !!o.erased, at: String(o.at), acknowledgedRoots: o.ack || [], quarantine: o.quarantine || null, moved: [] }; }
const SOFT = ['autonomy.ledger.jsonl', 'scout.state.json', 'scout.state.json.bak', '_commander.autonomy.json', '_commander.dossier.json', '_commander.goals.json',
  '_station.questrefresh.json', 'cron.jobs.json', 'loops.json', 'nightfocus.state.json', 'personalization.json'];
const INFRA = ['loops.halt.json', 'nightshift.state.json', 'cron.halt.json', '.schema-version.json', 'proc-ledger.json', 'discovery.state.json', 'group-sessions.json'];
function files(dir, names) { for (const n of names) write(path.join(dir, n), /\.jsonl$/.test(n) ? '{"v":1}\n' : '{"v":1}'); }
// the file-name inventories of a real 0.13.5 station and a real 0.14.x one; every byte below is synthetic
const V0135 = ['.run-journal/', '.schema-version.json', '.spend-pending/', '.starnet-workspace-owner.json.generations/', '_away.briefing.json', '_away.briefing.json.bak',
  '_commander.autonomy.json', '_commander.autonomy.json.bak', '_commander.dossier.json', '_commander.dossier.json.bak', '_commander.goals.json', '_commander.goals.json.bak',
  '_station.questrefresh.json', '_station.questrefresh.json.bak', 'agent.roster.json', 'agent.roster.json.bak', 'agent.save.json', 'agent.save.json.bak', 'channels/',
  'diag.errors.json', 'discovery.state.json', 'discovery.state.json.bak', 'group-sessions.json', 'group-sessions.json.bak', 'ledger.jsonl', 'line-jobs.json', 'line-jobs.json.bak',
  'line-spend.json', 'line-spend.json.bak', 'liveprices.cache.json', 'proc-ledger.json', 'recommendations.json', 'recommendations.json.bak', 'routing.plan.json',
  'routing.plan.json.bak', 'runs.jsonl', 'scout.interests.json', 'scout.interests.json.bak', 'scout.state.json', 'scout.state.json.bak', 'skill-evaluations.json',
  'skill-evaluations.json.bak', 'skill.nudge.json', 'skill.nudge.json.bak', 'task-briefs.json', 'task-briefs.json.bak', 'transcript-history-v2/', 'verdict.packets.json',
  'verdict.packets.json.bak', 'voice-cache/'];
const V014X = V0135.filter(n => !['diag.errors.json', 'group-sessions.json.bak'].includes(n)).concat(['.checkpoints/', 'agent/']);
function layout(dir, inventory, createdAt) {
  for (const n of inventory) {
    if (n.endsWith('/')) write(path.join(dir, n, 'part.json'), '{"v":1}');
    else if (/^agent\.save\.json/.test(n)) write(path.join(dir, n), saveEnvelope('SYNTHETIC-' + path.basename(dir).toUpperCase(), createdAt));
    else if (/^agent\.roster\.json/.test(n)) write(path.join(dir, n), { version: 1, agents: [{ agentId: 'agent', name: 'SYNTHETIC' }] });
    else files(dir, [n]);
  }
}
function drop(dir, re) { for (const n of fs.readdirSync(dir)) if (re.test(n)) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); }

/* ---- one sandbox profile: the app's desktop workspace, the bare `npm start` root (inside the NSIS install folder on Windows)
   and an extra old root no reset acknowledged ---- */
let seq = 0;
function profile(label) {
  const base = path.join(scratch, String(++seq) + '-' + label);
  const env = { LOCALAPPDATA: path.join(base, 'local'), APPDATA: path.join(base, 'roaming'), XDG_DATA_HOME: path.join(base, 'xdg'), STARNET_DEV: '', SKYNET_DEV: '' };
  const home = path.join(base, 'home');
  for (const d of [env.LOCALAPPDATA, env.APPDATA, env.XDG_DATA_HOME, home]) fs.mkdirSync(d, { recursive: true });
  process.env.HOME = process.env.USERPROFILE = home;
  const desktop = cli.desktopWorkspaces(env, PLATFORM);
  const bare = cli.bareWorkspaces(env, PLATFORM);
  // macOS: the bare sidecar's default IS the desktop root, so the install-folder station lives in an ordinary legacy root
  const legacy = same(bare, desktop) ? path.join(home, '.local', 'share', 'StarNet', 'workspaces') : bare;
  const extra = path.join(home, '.local', 'share', 'Skynet', 'workspaces');
  fs.mkdirSync(desktop, { recursive: true });
  const candidates = Safety.workspaceCandidates({ path, env, platform: PLATFORM, homedir: () => home });
  return { base, env, home, desktop, bare, legacy, extra, candidates, bareIsLegacy: same(bare, legacy) };
}
function useProfile(p) { Object.assign(process.env, p.env); process.env.HOME = process.env.USERPROFILE = p.home; }
function snapshot(dir) {
  const out = {};
  (function walk(d, rel) {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out[r] = fs.readFileSync(path.join(d, e.name)).toString('base64');
    }
  })(dir, '');
  return out;
}

/* ---- the shapes ---- */
const OLD = 'OLD-STATION', EXTRA = 'EXTRA-STATION';
const rows = [
  { name: 'fresh install', build: p => {},
    expect: { allowed: true, current: false, legacy: [], auto: { applied: false }, pick: 'desktop', station: false, bootstrap: 'wrote' } },
  { name: 'station-less bookkeeping under a none record (the gh#123 family)', build: p => {
      write(path.join(p.desktop, '.station.json'), record(p.desktop)); files(p.desktop, SOFT.concat(INFRA)); },
    expect: { allowed: true, current: false, legacy: [], auto: { applied: false }, pick: 'desktop', station: false, bootstrap: 'wrote' } },
  { name: '0.13.5 layout, no record', build: p => layout(p.desktop, V0135, 1700000000000),
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: '0.14.x layout, no record', build: p => layout(p.desktop, V014X, 1760000000000),
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: '0.14.x layout with its save gone (roster kept)', build: p => { layout(p.desktop, V014X, 1760000000000); drop(p.desktop, /^agent\.save\.json/); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: '0.14.x layout with save and roster gone (never orphaned by the migration)', build: p => { layout(p.desktop, V014X, 1760000000000); drop(p.desktop, /^agent\.(?:save|roster)\.json/); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'refused' } },
  { name: '0.9.0 fixture', build: p => { for (const n of fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'upgrade', 'v090-intel-mac'))) fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'upgrade', 'v090-intel-mac', n), path.join(p.desktop, n)); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: 'native ERASE plus the install-folder legacy station (gh#101)', build: p => {
      write(path.join(p.desktop, '.migrated'), '1'); write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ erased: true, at: T_ERASE, ack: [p.legacy] }));
      station(p.legacy, OLD, 1600000000000); },
    expect: { allowed: true, current: false, legacy: [], auto: { applied: false, code: 'AUTO_RECOVERY_ERASED' }, pick: 'desktop', station: false, bootstrap: 'wrote' } }
].concat([['epoch-ms number', T_FRESH], ['epoch-ms text (the native door)', String(T_FRESH)], ['ISO (the old sidecar door)', new Date(T_FRESH).toISOString()]].map(([dialect, at]) => ({
  name: 'START FRESH marker, at as ' + dialect + ', with the acknowledged legacy station', build: p => {
    write(path.join(p.desktop, '.fresh-start.json'), { version: 1, erased: false, at, acknowledgedRoots: [p.legacy], quarantine: null, moved: [] }); station(p.legacy, OLD, 1600000000000); },
  expect: { allowed: true, current: false, legacy: [], auto: { applied: false }, pick: 'desktop', station: false, bootstrap: 'wrote' }
}))).concat([
  { name: 'ERASE then native START FRESH (the erased generation set aside in workspace-quarantine)', build: p => {
      const q = path.join(path.dirname(p.desktop), 'workspace-quarantine', 'station-' + T_FRESH);
      write(path.join(q, '.migrated'), '1'); write(path.join(q, '.fresh-start.json'), nativeMarker({ erased: true, at: T_ERASE, ack: [p.legacy] }));
      write(path.join(p.desktop, '.migrated'), '1'); write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ erased: false, at: T_FRESH, ack: [p.legacy], quarantine: q }));
      station(p.legacy, OLD, 1600000000000); station(p.extra, EXTRA, 1610000000000); },
    expect: { allowed: false, current: false, legacy: ['extra'], auto: { applied: false, code: 'AUTO_RECOVERY_ERASED' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'ERASE then native START FRESH, its set-aside generation deleted since (the marker alone decides, as before)', build: p => {
      const q = path.join(path.dirname(p.desktop), 'workspace-quarantine', 'station-' + T_FRESH);
      write(path.join(p.desktop, '.migrated'), '1'); write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ erased: false, at: T_FRESH, ack: [p.legacy], quarantine: q }));
      station(p.legacy, OLD, 1600000000000); station(p.extra, EXTRA, 1610000000000); },
    expect: { allowed: false, current: false, legacy: ['extra'], auto: { applied: true }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'ERASE then the sidecar\'s START FRESH, then an unacknowledged old station appears', build: p => {
      write(path.join(p.desktop, '.migrated'), '1'); write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ erased: true, at: T_ERASE, ack: [p.legacy] }));
      files(p.desktop, ['ledger.jsonl', 'scout.state.json']); station(p.legacy, OLD, 1600000000000);
      const r = Lineage.requestFresh({ fs, path, platform: PLATFORM, workspaceRoot: p.desktop, candidateRoots: p.candidates, now: () => T_FRESH, buildVersion: 'matrix' });
      if (!r || r.ok !== true) throw new Error('fixture: the sidecar START FRESH request failed: ' + JSON.stringify(r));
      const a = Recovery.applyPendingRecovery({ fs, path, platform: PLATFORM, workspaceRoot: p.desktop, candidateRoots: p.candidates, now: () => T_FRESH, buildVersion: 'matrix' });
      if (!a || a.applied !== true || a.kind !== 'fresh') throw new Error('fixture: the sidecar START FRESH did not apply: ' + JSON.stringify(a));
      station(p.extra, EXTRA, 1610000000000); },
    expect: { allowed: false, current: false, legacy: ['extra'], auto: { applied: false, code: 'AUTO_RECOVERY_ERASED' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'an older build\'s sidecar START FRESH over a new-build record founded after an ERASE', build: p => {
      write(path.join(p.desktop, '.station.json'), record(p.desktop, { state: 'active', generationId: 'g-' + (T_ERASE + 9).toString(36) + '-0badc0de', since: T_ERASE + 9, by: 'save',
        reset: { kind: 'erase', at: T_ERASE, source: 'marker' }, eraseAuthority: true, acknowledgedRoots: [p.legacy] }));
      // what the older build left: the station files moved aside, its own marker (ISO at, no erased), the record untouched
      const q = path.join(path.dirname(p.desktop), 'workspace-quarantine', '20261031120000');
      station(q, 'NEW-BUILD-STATION', T_ERASE + 9); files(q, ['ledger.jsonl']);
      write(path.join(p.desktop, '.fresh-start.json'), { version: 1, at: new Date(T_OLDER).toISOString(), acknowledgedRoots: [p.legacy], quarantine: q, moved: ['agent.roster.json', 'agent.save.json', 'ledger.jsonl'] });
      station(p.legacy, OLD, 1600000000000); station(p.extra, EXTRA, 1610000000000); },
    expect: { allowed: false, current: false, legacy: ['extra'], auto: { applied: false, code: 'AUTO_RECOVERY_ERASED' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'a torn station record', build: p => { write(path.join(p.desktop, '.station.json'), '{"schema":"starnet.station","vers'); station(p.legacy, OLD, 1600000000000); },
    expect: { allowed: false, current: false, legacy: ['legacy'], auto: { applied: false, code: 'AUTO_RECOVERY_RECORD_UNREADABLE' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'a torn START FRESH marker', build: p => { write(path.join(p.desktop, '.fresh-start.json'), '{"version":1,"acknow'); station(p.legacy, OLD, 1600000000000); },
    expect: { allowed: false, current: false, legacy: ['legacy'], auto: { applied: false, code: 'AUTO_RECOVERY_FRESH_MARKER_UNREADABLE' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'a newer build\'s record (version 2)', build: p => {
      write(path.join(p.desktop, '.station.json'), { schema: 'starnet.station', version: 2, root: canonical(p.desktop), state: 'erased', lifecycle: { future: true } }); station(p.legacy, OLD, 1600000000000); },
    expect: { allowed: false, current: false, legacy: ['legacy'], auto: { applied: false, code: 'AUTO_RECOVERY_RECORD_UNREADABLE' }, pick: 'desktop', station: false, bootstrap: 'refused' } },
  { name: 'a copied root (the shell\'s first-run migration copied a legacy root and its record)', build: p => {
      const rec = record(p.legacy, { state: 'active', generationId: 'g-' + (1600000000000).toString(36) + '-0c0be1ed', since: 1600000000000, by: 'save' });
      station(p.legacy, OLD, 1600000000000); write(path.join(p.legacy, '.station.json'), rec);
      station(p.desktop, OLD, 1600000000000); write(path.join(p.desktop, '.station.json'), rec); },
    expect: { allowed: false, current: true, legacy: ['legacy'], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: 'an older build onboarded under a new-build none record, then `starnet init` / `starnet -p`', build: p => {
      const rec = record(p.desktop, { since: T_FRESH, by: 'start-fresh', reset: { kind: 'start-fresh', at: T_FRESH, source: 'record' } });
      write(path.join(p.desktop, '.station.json'), rec); write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ at: T_FRESH }));
      station(p.desktop, 'ONBOARDED-BY-AN-OLDER-BUILD', T_FRESH + 1000); files(p.desktop, ['ledger.jsonl']); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: 'an older build onboarded under a new-build erased record, then `starnet init` / `starnet -p`', build: p => {
      write(path.join(p.desktop, '.station.json'), record(p.desktop, { state: 'erased', reset: { kind: 'erase', at: T_ERASE, source: 'marker' }, eraseAuthority: true, acknowledgedRoots: [p.legacy] }));
      write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ erased: true, at: T_ERASE, ack: [p.legacy] }));
      station(p.desktop, 'ONBOARDED-BY-AN-OLDER-BUILD', T_ERASE + 1000); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: 'a hand restore from workspace-quarantine that missed the hidden record', build: p => {
      const q = path.join(path.dirname(p.desktop), 'workspace-quarantine', '20261031120000');
      station(q, 'RESTORED-BY-HAND', 1700000000000); files(q, ['ledger.jsonl']);
      write(path.join(p.desktop, '.station.json'), record(p.desktop, { since: T_FRESH, by: 'start-fresh', reset: { kind: 'start-fresh', at: T_FRESH, source: 'record' }, setAside: q }));
      write(path.join(p.desktop, '.fresh-start.json'), nativeMarker({ at: T_FRESH, quarantine: q }));
      for (const n of ['agent.save.json', 'agent.roster.json', 'ledger.jsonl']) fs.copyFileSync(path.join(q, n), path.join(p.desktop, n)); },
    expect: { allowed: false, current: true, legacy: [], auto: { applied: false }, pick: 'desktop', station: true, bootstrap: 'station' } },
  { name: 'a bare `npm start` station nothing set aside (still found)', build: p => station(p.legacy, OLD, 1600000000000),
    expect: { allowed: false, current: false, legacy: ['legacy'], auto: { applied: true }, pick: 'legacy', station: false, bootstrap: 'refused' } }
]);

/* ---- run every shape through every seam ---- */
const FAKE_PROBES = { pidAlive: () => false, listeningPortOf: () => 0, claimVerdict: () => 'unknown', bootedAt: () => 0 };
const OPTS = { name: 'MATRIX', model: 'test/model', provider: 'openrouter' };
const keyOf = (p, root) => ['legacy', 'extra', 'bare'].find(k => same(p[k], root)) || root;
try {
  for (const row of rows) {
    const n = row.name, e = row.expect;
    const p = profile('read');
    useProfile(p);
    // a door that is missing or broken fails its own row: one shape never hides what the others would show
    try { row.build(p); }
    catch (e) { A.ok(false, n + ': the shape builds through today\'s doors (' + (e && e.message) + ')'); continue; }
    const before = snapshot(p.base);
    // the gate
    const lineage = Lineage.inspectWorkspaceLineage({ fs, path, platform: PLATFORM, workspaceRoot: p.desktop, candidateRoots: p.candidates, now: Date.now });
    const current = lineage.evidence.some(x => x.kind === 'current-workspace');
    const legacy = lineage.evidence.filter(x => x.kind === 'legacy-workspace').map(x => keyOf(p, x.root));
    A.eq(lineage.onboardingAllowed, e.allowed, n + ': the gate ' + (e.allowed ? 'allows' : 'holds') + ' onboarding (' + JSON.stringify(lineage.evidence.map(x => x.kind + ':' + x.examples.join(','))) + ')');
    A.eq(current, e.current, n + ': the gate ' + (e.current ? 'sees' : 'sees no') + ' station in the workspace');
    A.eq(legacy, e.legacy, n + ': the old roots the gate still counts');
    // the terminal
    const picked = cli.defaultWorkspace({});
    const pick = same(picked, p.desktop) ? 'desktop' : same(picked, p.legacy) ? 'legacy' : picked;
    const wantPick = e.pick === 'legacy' && !p.bareIsLegacy ? 'desktop' : e.pick;   // macOS: the bare root is the desktop
    A.eq(pick, wantPick, n + ': `starnet` boots the ' + wantPick + ' workspace');
    const stationSeen = cli.discoverDesktop(p.desktop, FAKE_PROBES).station;
    A.eq(stationSeen, e.station, n + ': the terminal ' + (e.station ? 'sees' : 'sees no') + ' station (what starts the app instead of booting it keyless)');
    A.eq(stationSeen, current, n + ': ONE ANSWER — the terminal and the gate agree whether this workspace holds a station');
    A.eq(snapshot(p.base), before, n + ': the gate and the terminal\'s looks write nothing');
    // the terminal's bootstrap (`starnet init`, `starnet -p` on a spawn): last, it may write
    const boot = cli.bootstrapWorkspace(p.desktop, OPTS, Object.assign({}, p.env));
    const outcome = boot.wrote ? 'wrote' : boot.refused ? 'refused' : 'station';
    A.eq(outcome, e.bootstrap, n + ': `starnet init` / `-p` ' + ({ wrote: 'sets a station up', refused: 'refuses (the app recovers it)', station: 'finds the station already there' })[e.bootstrap] + ' (' + (boot.reason || 'wrote') + ')');
    if (boot.wrote) {
      A.ok(lineage.onboardingAllowed && !stationSeen, n + ': the terminal sets a station up only where the gate would let the app onboard');
      const rec = (() => { try { return JSON.parse(fs.readFileSync(path.join(p.desktop, '.station.json'), 'utf8')); } catch (_) { return null; } })();
      A.ok(rec && rec.state === 'active' && rec.by === 'cli-bootstrap', n + ': and its station record says the bootstrapped station was founded');
      for (const k of ['legacy', 'extra']) { const b = before; for (const rel of Object.keys(b)) if (rel.startsWith(path.relative(p.base, p[k]).split(path.sep).join('/') + '/')) A.eq(snapshot(p.base)[rel], b[rel], n + ': ' + rel + ' is untouched'); }
    } else {
      A.eq(snapshot(p.base), before, n + ': and writes nothing');
    }
    // automatic recovery, on a second build of the same shape: it may import a station
    const q = profile('auto');
    useProfile(q);
    row.build(q);
    const auto = Recovery.applyPendingRecovery({ fs, path, platform: PLATFORM, home: q.home, workspaceRoot: q.desktop, candidateRoots: q.candidates,
      auto: true, now: Date.now, scratchRoots: [path.join(q.base, 'not-a-scratch-root')] });
    A.eq(!!auto.applied, e.auto.applied, n + ': automatic recovery ' + (e.auto.applied ? 'imports' : 'imports nothing') + ' (' + (auto.code || 'no skip code') + ')');
    if ('code' in e.auto) A.eq(auto.code, e.auto.code, n + ': and says why: ' + e.auto.code);
  }
} finally {
  for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  fs.rmSync(scratch, { recursive: true, force: true });
}
A.report('station-marker-matrix.test');
