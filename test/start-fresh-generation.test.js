/* node test/start-fresh-generation.test.js — START FRESH HAS ONE MEANING: THE WHOLE GENERATION, FROM EITHER DOOR.

   The desktop shell's door (fresh_start.rs) always moved the whole generation aside. The gate's door moved only the files a
   name regex matched, so the "fresh" station went on holding the old jail, chats, bot configs, checkpoints, line state and
   more, while the marker it wrote dropped an ERASE's authority and spoke its own dialect. Now the gate's door takes a request
   and the next boot sets the whole generation aside, in the locked pre-claim phase, with the activation explicit recovery
   uses (sidecar/workspace-recovery.js applyFreshRequest).

   This test drives requestFresh and applyPendingRecovery with the arguments index.js passes, on real files; only a rename or
   an unlink is ever faked, at the fs edge, to make it fail. test/start-fresh-generation.http.test.js is the same story through
   the real sidecar. Here:
     WHOLE    the live generation holds exactly SEAL, the record, the mirror and CARRY_ON_FRESH; everything else sits
              byte-identical in one workspace-quarantine/station-<stamp>; the request itself moves nothing;
     ERASE    a START FRESH never weakens a prior ERASE, and acknowledged roots are unioned;
     STALE    a request is refused, kept as .failed-<stamp>, and lastFresh says why, when the workspace moved on;
     ROLLBACK a failed rename changes nothing, names the error and the holder when known, and the button's next press works;
              a station browser process left on the profile with no lock file is ended by its own pid and the move goes
              through, for both doors; one that will not end still fails closed, and a live owner's is never touched;
     CARRY    every fixture row, the rule both doors share (station_contract.rs is the native half);
     ONE AT A TIME  a pending recovery wins, and a live owner's generation is never renamed;
     REDACTED the last result reaches a reader with no absolute local path;
     ROUTES   both lifecycle routes quiesce the station first and leave through the restart path;
     GATE     the page's own handler, run with the transport faked: the poll stops on a newer failure and re-arms. */
'use strict';
const A = require('./_assert.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Lineage = require('../sidecar/workspace-lineage.js');
const Recovery = require('../sidecar/workspace-recovery.js');
const SR = require('../sidecar/station-record.js');
const Orphans = require('../sidecar/tools/builtin/browser-orphans.js');
const { makeLineageRoutes } = require('../sidecar/lineage-routes.js');
const fixture = require('./fixtures/station-record-cases.json');

const BUILD = '0.15.0-test';
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-fresh-generation-'));
let sandboxes = 0;

function write(file, body) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function sandbox() {
  const root = path.join(scratch, 's' + (++sandboxes));
  const ws = path.join(root, 'workspaces');
  fs.mkdirSync(ws, { recursive: true });
  return { root, ws, shelf: path.join(root, 'workspace-quarantine'), requestFile: ws + '.fresh-request.json', home: root };
}
const deps = (ws, at) => ({ fs, path, platform: process.platform, now: () => at, workspaceRoot: ws });
// what index.js calls: the owner's ensure() at boot, the route's requestFresh, the next boot's applyPendingRecovery
const bootRecord = (ws, at) => SR.ensure(deps(ws, at || T0));
const ask = (ws, o) => Lineage.requestFresh(Object.assign({ fs, path, platform: process.platform, workspaceRoot: ws, candidateRoots: [], now: () => T0 + 1000, buildVersion: BUILD }, o));
const boot = (ws, o) => Recovery.applyPendingRecovery(Object.assign({ fs, path, platform: process.platform, home: path.dirname(ws), workspaceRoot: ws, candidateRoots: [], auto: false,
  now: () => T0 + 2000, buildVersion: BUILD }, o));
const lastFresh = ws => Recovery.lastFreshResult({ fs, path, platform: process.platform, home: path.dirname(ws), workspaceRoot: ws, candidateRoots: [] });

// Every file under a directory with its hash. The owner check's own election tickets are bookkeeping, never station state.
function tree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === '.starnet-workspace-owner.json.generations') continue;
      const r = rel ? rel + '/' + entry.name : entry.name, abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs, r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(dir, '');
  return out;
}
const names = dir => Object.keys(tree(dir)).sort();
function clean(carried) { return fixture.seal.concat([fixture.recordFile, fixture.freshMarker], carried || []).sort(); }

// a generation shaped like a real 0.14.x station (the file-name inventory of the _stations samples, never their contents)
const LAYOUT = ['agent/report.md', 'agent/downloads/receipt.pdf', 'channels/telegram.json', '.checkpoints/a/b.json', 'transcript-history-v2/t1.jsonl', '.run-journal/r1.json',
  '.spend-pending/p1.json', 'line-jobs.json', 'line-spend.json', 'verdict.packets.json', 'skill-evaluations.json', 'skill.nudge.json', '_away.briefing.json', 'discovery.state.json',
  'group-sessions.json', 'voice-cache/v1.bin', '.browser-profile/Default/Cookies', 'codex/tokens.json', '.secrets/provider-keys.json', 'ledger.jsonl', 'scout.state.json',
  'proc-ledger.json', '.schema-version.json', 'agent.roster.json'];
function plant(ws, list) { for (const rel of list || LAYOUT) write(path.join(ws, ...rel.split('/')), 'bytes of ' + rel); }
const LINK = fixture.carryOnFresh.files[0];
const LINK_BYTES = '{"url":"https://credits.example","accountId":"acct-7","linkedAt":7}';

/* ---- WHOLE: the request moves nothing, the apply moves everything ---- */
{
  const t = sandbox();
  plant(t.ws);
  write(path.join(t.ws, ...LINK.split('/')), LINK_BYTES);
  const live = bootRecord(t.ws);
  A.eq(live.state, 'active', 'fixture: the record sees this generation as a station');
  const generation = live.generationId;
  const before = tree(t.ws);
  const asked = ask(t.ws);
  A.eq([asked.ok, asked.restartRequired, asked.requestedAt], [true, true, T0 + 1000], 'START FRESH takes a request');
  A.eq(tree(t.ws), before, 'the request moves nothing: the running sidecar holds this generation open');
  const request = JSON.parse(fs.readFileSync(t.requestFile, 'utf8'));
  A.eq([request.version, request.expectedState, request.expectedGenerationId, request.markerAt, request.fromVersion], [1, 'active', generation, null, BUILD], 'and pins the generation, the state, the marker and the build');
  A.eq(request.pinned['agent.save.json'], 'absent', 'a save that is not there pins as absent');
  A.eq(request.pinned['agent.roster.json'], before['agent.roster.json'], 'a roster pins by its hash');

  const applied = boot(t.ws);
  A.eq([applied.kind, applied.ok, applied.applied, applied.creditsLeftAside], ['fresh', true, true, false], 'the next boot applies it');
  A.eq(names(t.ws), clean([LINK]), 'THE LIVE GENERATION holds only SEAL, the record, the mirror and CARRY_ON_FRESH');
  const shelf = fs.readdirSync(t.shelf);
  A.eq(shelf.length, 1, 'one set-aside generation');
  A.ok(/^station-\d{17}$/.test(shelf[0]), 'named station-<stamp>, the place derive reads a generation from (' + shelf[0] + ')');
  A.eq(applied.quarantine, path.join(t.shelf, shelf[0]), 'the result names it');
  A.eq(tree(applied.quarantine), before, 'EVERYTHING ELSE sits byte-identical in it');
  A.eq(fs.readFileSync(path.join(t.ws, ...LINK.split('/')), 'utf8'), LINK_BYTES, 'the account link is carried byte for byte');
  A.eq(fs.readdirSync(t.root).filter(n => /fresh-stage/.test(n)), [], 'no stage is left behind');
  A.eq(fs.existsSync(t.requestFile), false, 'the request is consumed');

  const record = JSON.parse(fs.readFileSync(path.join(t.ws, fixture.recordFile), 'utf8'));
  A.eq([record.state, record.generationId, record.by, record.setAside, record.previous], ['none', null, 'start-fresh', applied.quarantine, { generationId: generation }], 'the record: none, set aside there, the old generation as previous');
  A.eq(record.reset, { kind: 'start-fresh', at: T0 + 2000, source: 'record' }, 'its reset is the apply, so a copy of the old station stays refused');
  const mirror = fs.readFileSync(path.join(t.ws, fixture.freshMarker), 'utf8');
  A.eq(Object.keys(JSON.parse(mirror)), fixture.nativeMarkers.keys, 'the legacy mirror has the native marker\'s keys, in its order');
  A.eq(JSON.parse(mirror), { version: 1, erased: false, at: String(T0 + 2000), acknowledgedRoots: [], quarantine: applied.quarantine, moved: [] }, 'and is the native START FRESH marker, field for field');
  const after = bootRecord(t.ws, T0 + 3000);
  A.eq([after.persisted, after.source], [true, 'record'], 'the next ensure() accepts the pair as it is');
  const gate = Lineage.inspectWorkspaceLineage({ fs, path, platform: process.platform, workspaceRoot: t.ws, candidateRoots: [], now: () => T0 + 3000 });
  A.eq([gate.onboardingAllowed, gate.station.state], [true, 'none'], 'and onboarding is allowed');
  A.eq(lastFresh(t.ws).ok, true, 'lastFresh reports the apply');

  // a hand restore from the shelf still works: the set-aside generation is a whole, ordinary workspace
  A.eq(fs.readFileSync(path.join(applied.quarantine, 'agent', 'report.md'), 'utf8'), 'bytes of agent/report.md', 'the old jail is in the set-aside generation');
}

/* ---- ERASE: a START FRESH of an erased generation stays erased, whichever door wrote the marker ---- */
{
  const t = sandbox();
  const legacy = path.join(t.root, 'legacy', 'workspaces'), other = path.join(t.root, 'other', 'workspaces'), snapshots = path.join(t.root, 'update-snapshots');
  const native = fixture.nativeMarkers;
  write(path.join(t.ws, '.migrated'), '1');
  write(path.join(t.ws, fixture.freshMarker), JSON.stringify(Object.assign({}, native.erase, { acknowledgedRoots: [legacy] }), null, 2));
  plant(t.ws, ['ledger.jsonl', 'agent/report.md']);
  write(path.join(other, 'agent.save.json'), '{"version":5}');
  write(path.join(snapshots, 'pre-1.starnet-backup.json'), '{}');
  bootRecord(t.ws);
  A.eq(ask(t.ws, { candidateRoots: [legacy, other], snapshotsRoot: snapshots }).ok, true, 'an erased generation takes a request');
  const applied = boot(t.ws);
  A.eq(applied.applied, true, 'and the apply runs');
  const record = JSON.parse(fs.readFileSync(path.join(t.ws, fixture.recordFile), 'utf8'));
  A.eq(record.eraseAuthority, true, 'the erase authority is carried into the clean generation (gh#101)');
  A.eq(record.acknowledgedRoots.slice().sort(), [legacy, other, snapshots].map(r => path.resolve(r)).sort(), 'the prior acknowledged roots are unioned with those this choice acknowledged');
  const mirror = JSON.parse(fs.readFileSync(path.join(t.ws, fixture.freshMarker), 'utf8'));
  A.eq([mirror.erased, mirror.at, typeof mirror.at], [true, String(T0 + 2000), 'string'], 'the mirror keeps it for an older build, at as epoch-ms text');
  const extra = path.join(t.root, 'extra', 'workspaces');
  write(path.join(extra, 'agent.save.json'), JSON.stringify({ version: 1, agentId: 'agent', updatedAt: 1, savedAt: 1, doc: { schema: 'starnet.save', version: 5, updatedAt: 1, agent: { id: 'agent', name: 'EXTRA' } } }));
  const auto = boot(t.ws, { auto: true, scratchRoots: [], candidateRoots: [extra], now: () => T0 + 4000 });
  A.eq([auto.applied, auto.code], [false, 'AUTO_RECOVERY_ERASED'], 'and automatic recovery stays blocked against a root nothing acknowledged');
}

/* ---- STALE: a request the workspace moved on from is refused, and nothing is set aside ---- */
{
  const saveFile = ws => path.join(ws, 'agent.save.json');
  const recordFile = ws => path.join(ws, fixture.recordFile);
  const rewriteRecord = (ws, patch) => write(recordFile(ws), JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(recordFile(ws), 'utf8')), patch), null, 2));
  const rows = [
    ['a save appeared', ws => write(saveFile(ws), '{"version":5}'), 'FRESH_REQUEST_STATION_FILES_CHANGED', /agent\.save\.json/],
    ['a save backup appeared', ws => write(saveFile(ws) + '.bak', '{"version":5}'), 'FRESH_REQUEST_STATION_FILES_CHANGED', /agent\.save\.json\.bak/],
    ['a forensic copy appeared', ws => write(saveFile(ws) + '.corrupt-3', 'x'), 'FRESH_REQUEST_STATION_FILES_CHANGED', /corrupt-3/],
    ['the roster changed', ws => write(path.join(ws, 'agent.roster.json'), '[{"id":"changed"}]'), 'FRESH_REQUEST_STATION_FILES_CHANGED', /agent\.roster\.json/],
    ['the roster disappeared', ws => fs.unlinkSync(path.join(ws, 'agent.roster.json')), 'FRESH_REQUEST_STATION_FILES_CHANGED', /agent\.roster\.json/],
    ['the generation changed', ws => rewriteRecord(ws, { generationId: 'g-abc-0badc0de' }), 'FRESH_REQUEST_GENERATION_CHANGED', /station changed/],
    ['an older build reset this workspace', ws => write(path.join(ws, fixture.freshMarker), JSON.stringify({ version: 1, at: new Date(T0 + 500).toISOString(), acknowledgedRoots: [] })), 'FRESH_REQUEST_MARKER_CHANGED', /reset again/, 'marker'],
    ['the build changed', null, 'FRESH_REQUEST_BUILD_CHANGED', /0\.15\.0-test to 0\.15\.1/, { buildVersion: '0.15.1' }],
    ['the request is not JSON', (ws, t) => write(t.requestFile, '{torn'), 'FRESH_REQUEST_INVALID', /could not be read/],
    ['the request is a future shape', (ws, t) => write(t.requestFile, '{"version":2,"pinned":{}}'), 'FRESH_REQUEST_INVALID', /could not be read/]
  ];
  for (const [what, tamper, code, says, opts] of rows) {
    const t = sandbox();
    plant(t.ws, ['agent.roster.json', 'ledger.jsonl', 'agent/report.md']);
    bootRecord(t.ws);
    A.eq(ask(t.ws).ok, true, what + ': fixture: the request is taken');
    if (tamper) tamper(t.ws, t);
    const before = tree(t.ws);
    const r = boot(t.ws, opts && opts.buildVersion ? opts : {});
    A.eq([r.kind, r.ok, r.applied, r.code], ['fresh', false, false, code], what + ': the apply refuses it (' + JSON.stringify(r) + ')');
    A.ok(says.test(r.error), what + ': and says why (' + r.error + ')');
    A.eq(tree(t.ws), before, what + ': nothing moved');
    A.eq(fs.existsSync(t.shelf), false, what + ': nothing was set aside');
    A.eq(fs.existsSync(t.requestFile), false, what + ': the request cannot run twice');
    A.eq(fs.readdirSync(t.root).filter(n => /\.fresh-request\.json\.failed-\d{17}$/.test(n)).length, 1, what + ': it is kept as .failed-<stamp>');
    const last = lastFresh(t.ws);
    A.eq([last && last.ok, last && last.code], [false, code], what + ': lastFresh carries it to the gate');
  }
  // a state change with no generation id on the request's side: the station-less workspace founded after the request
  const t = sandbox();
  bootRecord(t.ws);
  const legacy = path.join(t.root, 'legacy', 'workspaces');
  write(path.join(legacy, 'agent.save.json'), '{"version":5}');
  A.eq(ask(t.ws, { candidateRoots: [legacy] }).ok, true, 'state row: fixture: a none generation takes a request');
  bootRecord(t.ws).found({ by: 'save' });
  const r = boot(t.ws, { candidateRoots: [legacy] });
  A.eq(r.code, 'FRESH_REQUEST_GENERATION_CHANGED', 'a station founded after the request refuses it');

  // what a request survives: bookkeeping the old sidecar wrote on its way down is not a state the Commander chose past
  const q = sandbox();
  plant(q.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(q.ws);
  A.eq(ask(q.ws).ok, true, 'fixture: a request');
  write(path.join(q.ws, 'nightshift.state.json'), '{"halted":true}');
  write(path.join(q.ws, 'ledger.jsonl'), 'one more row\n');
  A.eq(boot(q.ws).applied, true, 'a write that is not a save, a roster, a reset or a founding does not refuse the request');
  A.eq(names(q.ws), clean(), 'and it left with the generation');
}

/* ---- a record that cannot be read: START FRESH is the exit, and the bytes leave with the generation ---- */
for (const [what, bytes] of [['torn', '{"schema":"starnet.station","vers'], ['a newer build\'s', JSON.stringify({ schema: 'starnet.station', version: 2, root: 'x', state: 'erased' })]]) {
  const t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  write(path.join(t.ws, fixture.recordFile), bytes);
  A.eq(ask(t.ws).ok, true, what + ' record: START FRESH still takes a request');
  const applied = boot(t.ws);
  A.eq(applied.applied, true, what + ' record: and applies');
  A.eq(fs.readFileSync(path.join(applied.quarantine, fixture.recordFile), 'utf8'), bytes, what + ' record: its bytes are kept with the set-aside generation, never written over');
  A.eq(SR.read(deps(t.ws, T0 + 3000)).source, 'record', what + ' record: the clean generation has its own');
}

/* ---- ROLLBACK: a rename that fails changes nothing, and the next press works ---- */
{
  const failing = (rule, unlink) => new Proxy(fs, { get(target, key) {
    if (key === 'renameSync') return (a, b) => { const e = rule(String(a), String(b)); if (e) throw e; return target.renameSync(a, b); };
    if (key === 'unlinkSync' && unlink) return p => { const e = unlink(String(p)); if (e) throw e; return target.unlinkSync(p); };
    const v = target[key];
    return typeof v === 'function' ? v.bind(target) : v;
  } });
  const err = (code, message) => Object.assign(new Error(code + ': ' + message), { code });
  const stranded = (t, label) => {
    A.eq(fs.readdirSync(t.root).filter(n => /fresh-stage/.test(n)), [], label + ': no stage is left behind');
    A.eq(fs.existsSync(t.requestFile), false, label + ': the request does not run again by itself');
    A.eq(fs.readdirSync(t.root).filter(n => /\.fresh-request\.json\.failed-/.test(n)).length, 1, label + ': it is kept as .failed-<stamp>');
  };

  // the move itself fails: the common Windows case, a file in the generation held open
  let t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl', 'agent/report.md']);
  bootRecord(t.ws);
  ask(t.ws);
  let before = tree(t.ws);
  let r = boot(t.ws, { fs: failing((a, b) => a === t.ws ? err('EPERM', 'operation not permitted, rename') : null) });
  A.eq([r.kind, r.ok, r.applied, r.code], ['fresh', false, false, 'FRESH_ACTIVATION_FAILED'], 'a held generation fails closed (' + JSON.stringify(r) + ')');
  A.ok(/EPERM/.test(r.error) && /may still have a file in it open/.test(r.error) && /Nothing was moved/.test(r.error), 'the error says what happened in words, and no more than it knows (' + r.error + ')');
  A.ok(/Close what is using it/.test(r.error), 'and what to do about it');
  A.eq(tree(t.ws), before, 'nothing moved');
  stranded(t, 'held');
  A.eq(lastFresh(t.ws).code, 'FRESH_ACTIVATION_FAILED', 'lastFresh names it');
  A.eq(ask(t.ws).ok, true, 'the button re-arms: a new request is taken');
  const retried = boot(t.ws);
  A.eq(retried.applied, true, 'and the holder gone, it applies');
  A.eq(tree(retried.quarantine), before, 'the same generation, byte-identical');

  // the holder, when browser-orphans can name it
  t = sandbox();
  plant(t.ws, ['agent.roster.json', '.browser-profile/lockfile']);
  bootRecord(t.ws);
  ask(t.ws);
  const lock = path.join(t.ws, '.browser-profile', 'lockfile');
  r = boot(t.ws, { platform: 'win32', fs: failing((a, b) => a === t.ws ? err('EBUSY', 'resource busy or locked, rename') : null, p => p === lock ? err('EBUSY', 'in use') : null) });
  A.eq(r.code, 'FRESH_ACTIVATION_FAILED', 'an orphaned station browser fails closed too');
  A.ok(/station browser/.test(String(r.holder)), 'and lastFresh names it (' + JSON.stringify(r.holder) + ')');
  t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  ask(t.ws);
  r = boot(t.ws, { platform: 'win32', fs: failing((a, b) => a === t.ws ? err('EBUSY', 'resource busy or locked, rename') : null) });
  A.eq(r.holder, undefined, 'a holder nothing can name is not guessed at');

  // a station browser process left on the generation's profile, holding no lock file: one Chromium started as the last sidecar
  // closed its browser (start-fresh-browser.e2e.test.js caught it), or a crash's whole browser. The boot ends it by its own pid
  // (browser-orphans.js sweepSync, which index.js passes as sweepProfile) and tries the move again; nothing else is ended
  const leftover = (box, extra) => {
    const profile = path.join(box.ws, '.browser-profile'), chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const s = { profile, swept: [], ended: [], moves: 0, table: [
      { pid: 4100, ppid: 4000, cmd: chrome + ' --type=utility --utility-sub-type=network.mojom.NetworkService "--user-data-dir=' + profile + '"' },
      // the Commander's own Chrome, and a look-alike profile beside the station's
      { pid: 4200, ppid: 9, cmd: chrome + ' "--user-data-dir=' + path.join(box.root, 'Chrome', 'User Data') + '"' },
      { pid: 4300, ppid: 9, cmd: chrome + ' "--user-data-dir=' + profile + '-old"' }] };
    // Windows' rule at the fs edge: while a process runs on the profile, the generation's move aside is refused
    s.fs = failing(a => a === box.ws && ++s.moves && s.table.some(row => Orphans.sameDir(Orphans.profileArg(row.cmd), profile)) ? err('EPERM', 'operation not permitted, rename') : null);
    s.sweepProfile = dir => {
      s.swept.push(dir);
      return Orphans.sweepSync(Object.assign({ profileDir: dir, listProcesses: () => s.table, sleep: () => {}, alive: pid => s.table.some(row => row.pid === pid),
        kill: pid => { s.ended.push(pid); s.table = s.table.filter(row => row.pid !== pid); } }, extra));
    };
    return s;
  };
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl', '.browser-profile/Default/Cookies']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  let left = leftover(t);
  A.eq(fs.existsSync(path.join(left.profile, 'lockfile')), false, 'fixture: no lock file says the profile is held');
  r = boot(t.ws, { fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0] });
  A.eq([r.kind, r.ok, r.applied], ['fresh', true, true], 'a process left on the profile cannot fail the switch (' + JSON.stringify(r) + ')');
  A.eq(left.swept, [left.profile], 'the boot looks at this generation\'s own profile, once');
  A.eq(left.ended, [4100], 'and ends only the process on it, by its own pid');
  A.eq(left.moves, 2, 'refused once, then through');
  A.eq(r.quarantine ? tree(r.quarantine) : null, before, 'the generation is whole on the shelf, its profile with it');

  // the explicit recovery shares the activation
  const save = name => ({ version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, doc: { schema: 'starnet.save', version: 5, updatedAt: 5, agent: { id: 'agent', name }, station: { rooms: [], props: [] }, workstreams: [] } });
  const recoverable = box => {
    const legacy = path.join(box.root, 'legacy', 'workspaces');
    write(path.join(legacy, 'agent.save.json'), save('NOVA'));
    const inspection = Recovery.inspectCandidates({ fs, path, platform: process.platform, home: box.root, workspaceRoot: box.ws, candidateRoots: [legacy] });
    Recovery.requestRecovery({ fs, path, platform: process.platform, home: box.root, workspaceRoot: box.ws, candidateRoots: [legacy], inspection, candidateId: inspection.candidates[0].id, now: () => T0 + 1000 });
    return legacy;
  };
  t = sandbox();
  plant(t.ws, ['ledger.jsonl', '.browser-profile/Default/Cookies']);
  bootRecord(t.ws);
  let legacy = recoverable(t);
  left = leftover(t);
  r = boot(t.ws, { candidateRoots: [legacy], fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0] });
  A.eq([r.ok, r.applied, r.rollbackRetained], [true, true, true], 'an explicit recovery\'s switch goes through as well (' + JSON.stringify(r) + ')');
  A.eq(fs.existsSync(path.join(t.ws, 'agent.save.json')) && JSON.parse(fs.readFileSync(path.join(t.ws, 'agent.save.json'), 'utf8')).doc.agent.name, 'NOVA', 'the chosen station is live');
  A.eq(left.ended, [4100], 'and the one process on the profile was ended');

  // the bound runs out: a process StarNet cannot end (one started as administrator) still fails closed, with nothing moved
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl', '.browser-profile/Default/Cookies']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  left = leftover(t, { kill: () => {}, alive: () => true });
  r = boot(t.ws, { fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0] });
  A.eq([r.kind, r.ok, r.applied, r.code], ['fresh', false, false, 'FRESH_ACTIVATION_FAILED'], 'a process that will not end fails closed once the bound runs out (' + JSON.stringify(r) + ')');
  A.ok(/EPERM/.test(r.error) && /Nothing was moved/.test(r.error), 'with the error it always gave');
  A.eq(tree(t.ws), before, 'nothing moved');
  A.eq([left.swept.length, left.moves], [1, 4], 'the sweep ran once, and the move was tried again within the bound');
  stranded(t, 'unending');
  // a generation no station browser ever ran on has nothing of StarNet's to end: no listing, the same bounded tries
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  left = leftover(t);
  r = boot(t.ws, { fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0] });
  A.eq([r.code, left.swept, left.moves], ['FRESH_ACTIVATION_FAILED', [], 4], 'with no profile there is no sweep, and the move still fails closed');

  // a live owner's generation is never swept: nothing of a running station is ended
  t = sandbox();
  plant(t.ws, ['ledger.jsonl', '.browser-profile/Default/Cookies']);
  bootRecord(t.ws);
  legacy = recoverable(t);
  write(path.join(t.ws, '.starnet-workspace-owner.json'), { version: 1, pid: 424242, nonce: 'live-owner', startedAt: T0 });
  left = leftover(t);
  r = boot(t.ws, { candidateRoots: [legacy], fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0], lockPid: 7, lockPidAlive: pid => pid === 424242 });
  A.eq([r.ok, r.applied], [false, false], 'a generation with a live owner is not switched under it (' + JSON.stringify(r) + ')');
  A.eq([left.swept, left.ended, left.moves], [[], [], 1], 'nothing on its profile is ended, and the move is not tried again under it');
  A.ok(fs.existsSync(path.join(t.ws, 'ledger.jsonl')), 'nothing moved');

  // the activation fails after the move: the live generation goes back
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  r = boot(t.ws, { fs: failing((a, b) => /fresh-stage/.test(a) && b === t.ws ? err('ENOSPC', 'no space, rename') : null) });
  A.eq(r.code, 'FRESH_ACTIVATION_FAILED', 'a failed activation is reported');
  A.ok(/ENOSPC/.test(r.error) && /Nothing was moved/.test(r.error), 'with the real error (' + r.error + ')');
  A.eq(/Close what is using it/.test(r.error), false, 'and no advice that does not fit it');
  A.eq(tree(t.ws), before, 'and the rollback put the original generation back');
  A.eq(fs.readdirSync(t.shelf), [], 'the shelf holds nothing');
  stranded(t, 'rolled back');

  // neither generation will take the name (a scanner holding both folders): the last exit writes the stage's own files there,
  // so a boot never opens an unsealed workspace with the erase on the shelf (activation-crash-window.test.js holds the deaths)
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  const noName = failing((a, b) => /fresh-stage/.test(a) && b === t.ws ? err('ENOSPC', 'no space, rename') : (b === t.ws ? err('EPERM', 'denied, rollback') : null));
  r = boot(t.ws, { fs: noName });
  A.eq([r.kind, r.ok, r.applied], ['fresh', true, true], 'with both names refused the clean generation is written in place (' + JSON.stringify(r) + ')');
  A.eq(names(t.ws), clean(), 'sealed, with its record and mirror');
  A.eq(tree(r.quarantine), before, 'and the old generation is whole on the shelf');
  A.eq(fs.readdirSync(t.root).filter(n => /fresh-stage/.test(n)), [], 'no stage is left behind');
  A.eq(fs.existsSync(t.requestFile), false, 'the request is consumed');

  // and even that fails: the station is safe, the error says where, and nothing is claimed that is not true. The stage and the
  // journal stay, because they are all that knows what this workspace was meant to be: the next boot finishes it.
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  const stuck = t;
  const noPlace = new Proxy(noName, { get(target, key) {
    // only the last exit's own step fails: making the workspace again once it has gone to the shelf
    if (key === 'mkdirSync') return (p, ...rest) => { if (String(p) === stuck.ws && !fs.existsSync(stuck.ws)) throw err('ENOSPC', 'no space left'); return fs.mkdirSync(p, ...rest); };
    return target[key];
  } });
  r = boot(t.ws, { fs: noPlace });
  const aside = path.join(t.shelf, fs.readdirSync(t.shelf)[0]);
  A.ok(/rollback also failed/.test(r.error) && r.error.includes(aside) && !/Nothing was moved/.test(r.error), 'a stranded generation is named exactly (' + r.error + ')');
  A.eq([r.kind, r.ok, r.applied, r.pending], ['fresh', false, false, true], 'it is not a refusal: the request stays pending');
  A.ok(/finishes this at its next start/.test(r.error), 'and it says what happens next');
  A.eq(tree(aside), before, 'and it is whole');
  A.eq(fs.existsSync(t.requestFile), true, 'the request keeps its journal');
  A.eq(fs.readdirSync(t.root).filter(n => /fresh-stage/.test(n)).length, 1, 'and the stage stays');
  A.eq(fs.readdirSync(t.root).filter(n => /\.fresh-request\.json\.failed-/.test(n)).length, 0, 'nothing was failed');
  A.eq(lastFresh(t.ws).pending, true, 'lastFresh says so');
  fs.mkdirSync(t.ws, { recursive: true });   // the boot goes on: index.js makes the workspace for its stores
  const finished = boot(t.ws, { now: () => T0 + 5000 });
  A.eq([finished.ok, finished.applied, finished.resumed], [true, true, true], 'the next boot finishes it (' + JSON.stringify(finished) + ')');
  A.eq(names(t.ws), clean(), 'the clean generation is live');
  A.eq(tree(aside), before, 'the old generation has not moved');
  A.eq(fs.existsSync(t.requestFile), false, 'and the request is consumed');

  // the workspace is made again between the two renames (an orphaned station browser writing its profile back): the generation
  // cannot go back, nothing is written over or merged into that folder, and it is never reported as "nothing moved"
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  const remade = t;
  r = boot(t.ws, { fs: failing((a, b) => {
    if (!/fresh-stage/.test(a) || b !== remade.ws) return null;
    write(path.join(remade.ws, '.browser-profile', 'Default', 'Preferences'), 'an orphan wrote this');
    return err('ENOTEMPTY', 'directory not empty, rename');
  }) });
  const shelved = path.join(t.shelf, fs.readdirSync(t.shelf)[0]);
  A.eq([r.kind, r.ok, r.applied, r.pending], ['fresh', false, false, true], 'a workspace made again meanwhile strands the activation, pending (' + JSON.stringify(r) + ')');
  A.ok(/made .* again while it was set aside/.test(r.error) && r.error.includes(shelved) && !/Nothing was moved/.test(r.error), 'and says what happened and where the generation is (' + r.error + ')');
  A.eq(names(t.ws), ['.browser-profile/Default/Preferences'], 'nothing was written into the folder that appeared');
  A.eq(tree(shelved), before, 'the generation is whole on the shelf');
  left = leftover(t);
  const settled = boot(t.ws, { now: () => T0 + 5000, fs: left.fs, sweepProfile: left.sweepProfile, retryDelays: [0, 0, 0] });
  A.eq([settled.ok, settled.applied, settled.resumed], [true, true, true], 'the next boot finishes it (' + JSON.stringify(settled) + ')');
  A.eq(left.ended, [4100], 'resuming the interrupted move also ends only its profile holder');
  A.eq(names(t.ws), clean(), 'the clean generation is live');
  A.eq(names(shelved + '-interrupted'), ['.browser-profile/Default/Preferences'], 'and what appeared is set aside beside the generation, never deleted');
  A.eq(tree(shelved), before, 'which has not moved');

  // the quarantine shelf cannot be made: nothing moved, on every platform
  t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  ask(t.ws);
  write(t.shelf, 'a file where the shelf goes');
  before = tree(t.ws);
  r = boot(t.ws);
  A.eq(r.code, 'FRESH_ACTIVATION_FAILED', 'a blocked shelf fails closed');
  A.eq(tree(t.ws), before, 'and moves nothing');

  // the clean stage cannot be written: nothing moved
  t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  ask(t.ws);
  before = tree(t.ws);
  r = boot(t.ws, { fs: new Proxy(fs, { get(target, key) {
    if (key === 'writeFileSync') return (p, ...rest) => { if (/fresh-stage/.test(String(p))) throw err('ENOSPC', 'no space left'); return target.writeFileSync(p, ...rest); };
    const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
  } }) });
  A.eq(r.code, 'FRESH_ACTIVATION_FAILED', 'a stage that cannot be written fails closed');
  A.eq(tree(t.ws), before, 'and moves nothing');
  A.eq(fs.readdirSync(t.root).filter(n => /fresh-stage/.test(n)), [], 'its partial stage is removed');

  // past the activation nothing can un-happen it: a stuck request file never reports a failure for a finished reset
  t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  ask(t.ws);
  r = boot(t.ws, { fs: failing(() => null, p => p === t.requestFile ? err('EPERM', 'denied') : null) });
  A.eq([r.ok, r.applied], [true, true], 'a request file that cannot be removed does not fail a finished set-aside');
  A.eq(names(t.ws), clean(), 'the clean generation is live');
}

/* ---- CARRY: every fixture row, the rule both doors share ---- */
{
  const rowBytes = row => {
    if (!row.padTo) return Buffer.from(row.text);
    return Buffer.from(row.text.slice(0, -1) + ' '.repeat(row.padTo - row.text.length) + '}');
  };
  for (const row of fixture.carryOnFresh.rows) {
    const t = sandbox();
    plant(t.ws, ['agent.roster.json']);
    const link = path.join(t.ws, ...LINK.split('/'));
    let bytes = null;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (row.kind === 'file') { bytes = rowBytes(row); fs.writeFileSync(link, bytes); }
    else if (row.kind === 'dir') fs.mkdirSync(link);
    else if (row.kind === 'symlink') {
      const real = path.join(t.root, 'credits-elsewhere.json');
      fs.writeFileSync(real, '{"accountId":"acct-7"}');
      try { fs.symlinkSync(real, link); } catch (_) { console.log('  (' + row.name + ': this host cannot create a symlink; CI runs the row)'); continue; }
    }
    bootRecord(t.ws);
    A.eq(ask(t.ws).ok, true, row.name + ': a request is taken');
    const r = boot(t.ws);
    A.eq(r.applied, true, row.name + ': the reset is never refused over the link');
    A.eq(r.creditsLeftAside, row.verdict === 'leave-aside', row.name + ': the result says whether the link stayed behind');
    if (row.verdict === 'carry') {
      A.eq(names(t.ws), clean(fixture.carryOnFresh.files), row.name);
      A.ok(fs.readFileSync(link).equals(bytes), row.name + ': carried byte for byte');
      A.ok(fs.readFileSync(path.join(r.quarantine, ...LINK.split('/'))).equals(bytes), row.name + ': and still in the set-aside generation');
    } else {
      A.eq(names(t.ws), clean(), row.name + ': the clean generation starts unlinked');
      if (row.verdict === 'leave-aside') {
        A.ok(fs.lstatSync(path.join(r.quarantine, ...LINK.split('/'))), row.name + ': the link is never lost');
        if (bytes) A.ok(fs.readFileSync(path.join(r.quarantine, ...LINK.split('/'))).equals(bytes), row.name + ': byte for byte');
      }
    }
    A.eq(lastFresh(t.ws).creditsLeftAside, row.verdict === 'leave-aside', row.name + ': and lastFresh carries it to the gate');
  }
  // one byte rule across the doors: serde_json refuses a BOM and invalid UTF-8, so the JS half does too
  for (const [what, bytes] of [['a BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(LINK_BYTES)])], ['invalid UTF-8', Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])]]) {
    const t = sandbox();
    plant(t.ws, ['agent.roster.json']);
    write(path.join(t.ws, ...LINK.split('/')), bytes);
    bootRecord(t.ws);
    ask(t.ws);
    A.eq(boot(t.ws).creditsLeftAside, true, what + ' stays aside, as the native door decides');
  }
}

/* ---- ONE AT A TIME ---- */
{
  const save = name => ({ version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, doc: { schema: 'starnet.save', version: 5, updatedAt: 5, agent: { id: 'agent', name }, station: { rooms: [], props: [] }, workstreams: [] } });
  // a pending recovery wins, and the two never queue up
  let t = sandbox();
  plant(t.ws, ['ledger.jsonl']);
  const legacy = path.join(t.root, 'legacy', 'workspaces');
  write(path.join(legacy, 'agent.save.json'), save('NOVA'));
  bootRecord(t.ws);
  const inspection = Recovery.inspectCandidates({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [legacy] });
  const recoveryOpts = { fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [legacy], inspection, candidateId: inspection.candidates[0].id, now: () => T0 + 1000 };
  Recovery.requestRecovery(recoveryOpts);
  const refused = ask(t.ws, { candidateRoots: [legacy] });
  A.eq(refused.ok, false, 'START FRESH is refused while a verified recovery is pending');
  A.ok(/recovery request is already pending/.test(refused.error), 'and says so (' + refused.error + ')');
  A.eq(fs.existsSync(t.requestFile), false, 'and writes no request');

  t = sandbox();
  plant(t.ws, ['ledger.jsonl']);
  write(path.join(legacy, 'agent.save.json'), save('NOVA'));
  bootRecord(t.ws);
  const second = Recovery.inspectCandidates({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [legacy] });
  A.eq(ask(t.ws, { candidateRoots: [legacy] }).ok, true, 'fixture: a START FRESH request');
  A.throws(() => Recovery.requestRecovery(Object.assign({}, recoveryOpts, { workspaceRoot: t.ws, inspection: second, home: t.root })), 'a recovery is refused while a START FRESH is pending');
  const again = ask(t.ws, { candidateRoots: [legacy] });
  A.ok(again.ok === false && /already pending/.test(again.error), 'a second press is refused while the first is pending');

  // both on disk (an older build's recovery beside a pending request): the recovery runs, and the next boot refuses the request
  write(path.join(t.root, 'workspaces.recovery-request.json'), { version: 1, candidateId: second.candidates[0].id, expectedSaveSha256: second.candidates[0].saveSha256, requestedAt: T0 });
  const recovered = boot(t.ws, { candidateRoots: [legacy] });
  A.eq([recovered.applied, recovered.kind], [true, undefined], 'with both on disk the verified recovery wins');
  const next = boot(t.ws, { candidateRoots: [legacy], now: () => T0 + 5000 });
  A.eq([next.applied, next.code], [false, 'FRESH_REQUEST_STATION_FILES_CHANGED'], 'and the request is then refused: the station it was about is gone');
  A.eq(JSON.parse(fs.readFileSync(path.join(t.ws, 'agent.save.json'), 'utf8')).doc.agent.name, 'NOVA', 'the recovered station is untouched');

  // a live owner's generation is never renamed under it (the same refusal the native door makes)
  t = sandbox();
  plant(t.ws, ['agent.roster.json', 'ledger.jsonl']);
  bootRecord(t.ws);
  ask(t.ws);
  write(path.join(t.ws, '.starnet-workspace-owner.json'), { version: 1, pid: 424242, nonce: 'live-owner', startedAt: T0 });
  const before = tree(t.ws);
  const busy = boot(t.ws, { lockPid: 7, lockPidAlive: pid => pid === 424242 });
  A.eq([busy.kind, busy.applied, busy.pending, busy.code], ['fresh', false, true, 'FRESH_WORKSPACE_BUSY'], 'a generation with a live owner is left alone');
  A.eq(tree(t.ws), before, 'nothing moved');
  A.eq(fs.existsSync(t.requestFile), true, 'and the request stays pending for the next boot');
  A.eq(lastFresh(t.ws), null, 'this is not a verdict on the request: lastFresh stays quiet');
  const free = boot(t.ws, { lockPid: 7, lockPidAlive: () => false });
  A.eq(free.applied, true, 'once the owner is proven gone the request runs');
}

/* ---- REDACTED: the last result reaches the page and the report with no absolute local path ---- */
{
  const t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  ask(t.ws);
  const applied = boot(t.ws);
  const shown = Recovery.lastFreshResult({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [] });
  A.ok(!JSON.stringify(shown).includes(t.root), 'lastFresh shows no absolute path (' + JSON.stringify(shown) + ')');
  A.ok(shown.quarantine.startsWith('~'), 'it shows the set-aside generation relative to home');
  A.eq(fs.existsSync(applied.quarantine), true, 'fixture: the real path is real');
  const report = Recovery.recoveryReport({ fs, path, platform: process.platform, arch: 'x64', home: t.root, workspaceRoot: t.ws, candidateRoots: [], now: () => T0 });
  A.ok(!JSON.stringify(report).includes(t.root), 'the redacted report keeps it that way');

  // a failure whose text names the paths, on a data shelf outside the home
  const u = sandbox();
  plant(u.ws, ['agent.roster.json']);
  bootRecord(u.ws);
  ask(u.ws);
  const failingFs = new Proxy(fs, { get(target, key) {
    if (key === 'renameSync') return (a, b) => { if (String(a) === u.ws) { const e = new Error('ENOSPC: no space, rename \'' + a + '\' -> \'' + b + '\''); e.code = 'ENOSPC'; throw e; } return target.renameSync(a, b); };
    const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  boot(u.ws, { fs: failingFs });
  const failed = Recovery.lastFreshResult({ fs, path, platform: process.platform, home: path.join(scratch, 'someone-else'), workspaceRoot: u.ws, candidateRoots: [] });
  A.eq(failed.ok, false, 'fixture: the failure');
  A.ok(!failed.error.includes(u.root), 'its error text names no absolute path, in or out of the home (' + failed.error + ')');

  // an explicit recovery's result is not a START FRESH's
  const v = sandbox();
  write(v.ws + '.recovery-last.json', { version: 1, ok: true, applied: true, at: 5, candidateId: 'x' });
  A.eq(lastFresh(v.ws), null, 'lastFresh reads only a START FRESH result');
}

/* ---- ROUTES: the two lifecycle routes, with the transport faked ---- */
(async () => {
  function fakeRes() {
    const r = { status: 0, body: null };
    r.writeHead = code => { r.status = code; };
    r.end = text => { r.body = text ? JSON.parse(text) : null; };
    return r;
  }
  const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
  function routes(t, o) {
    const calls = [];
    const recovery = Object.assign({}, Recovery);
    const group = makeLineageRoutes(Object.assign({
      fs, path, platform: process.platform, arch: 'x64', homedir: () => t.root, workspaceRoot: t.ws, candidateRoots: [],
      lineage: { evidence: [], currentWorkspace: t.ws }, inspection: Recovery.inspectCandidates({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [] }), recovery,
      stationView: () => ({ state: 'none', generationId: null }), requestFresh: Lineage.requestFresh, buildVersion: BUILD, desktopShell: true, readBody: async () => '{}', now: () => T0, log: line => calls.push('log:' + line),
      quiesce: async () => { calls.push('quiesce:' + fs.existsSync(t.requestFile)); return { ok: true }; },
      restart: why => calls.push('restart:' + why)
    }, o));
    return { calls, handle: exact => group.routes.find(r => r.exact === exact).h };
  }

  let t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  let g = routes(t);
  let res = fakeRes();
  await g.handle('/api/lineage/start-fresh')({}, res);
  A.eq(res.status, 202, 'POST /api/lineage/start-fresh answers 202');
  A.eq([res.body.ok, res.body.restartRequired, res.body.requestedAt, res.body.desktopWillRestart], [true, true, T0, true], 'with the request\'s facts');
  A.eq(g.calls[0], 'quiesce:false', 'the station browser is closed and swept BEFORE the request exists');
  A.eq(fs.existsSync(t.requestFile), true, 'then the request is written');
  A.eq(g.calls.some(c => c.startsWith('restart')), false, 'and the restart waits for the response to flush');
  await tick(220);
  A.eq(g.calls.filter(c => c.startsWith('restart')), ['restart:start-fresh'], 'then it leaves through the restart path');

  // a browser that will not close never blocks the request: the rename is the judge, and it fails closed
  for (const [what, quiesce, expected] of [
    ['a sweep that reports a survivor', async () => ({ ok: false, error: 'an orphaned browser is still running' }), /still running/],
    ['a sweep that throws', async () => { throw new Error('sweep failed'); }, null],
    ['a close that never settles', () => new Promise(() => {}), null]
  ]) {
    t = sandbox();
    plant(t.ws, ['agent.roster.json']);
    bootRecord(t.ws);
    g = routes(t, { quiesce, quiesceMs: 30 });
    res = fakeRes();
    await g.handle('/api/lineage/start-fresh')({}, res);
    A.eq([res.status, fs.existsSync(t.requestFile)], [202, true], what + ': the request is still taken');
    if (expected) A.ok(g.calls.some(c => expected.test(c)), what + ': and the log says so (' + g.calls.join(' | ') + ')');
    await tick(220);
  }

  // a refused request closes the door it opened: no exit, the same sidecar keeps serving
  t = sandbox();
  plant(t.ws, ['agent.roster.json']);
  bootRecord(t.ws);
  write(t.ws + '.recovery-request.json', '{}');
  g = routes(t);
  res = fakeRes();
  await g.handle('/api/lineage/start-fresh')({}, res);
  A.eq([res.status, res.body.ok], [409, false], 'a refused START FRESH answers 409');
  await tick(220);
  A.eq(g.calls.filter(c => c.startsWith('restart')), [], 'and never restarts');

  // the recovery route: the same quiesce, the same exit, and a refused candidate never exits
  t = sandbox();
  bootRecord(t.ws);
  const legacy = path.join(t.root, 'legacy', 'workspaces');
  write(path.join(legacy, 'agent.save.json'), { version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, doc: { schema: 'starnet.save', version: 5, updatedAt: 5, agent: { id: 'agent', name: 'NOVA' }, station: { rooms: [], props: [] }, workstreams: [] } });
  const inspection = Recovery.inspectCandidates({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [legacy] });
  g = routes(t, { candidateRoots: [legacy], inspection, readBody: async () => JSON.stringify({ candidateId: inspection.candidates[0].id }) });
  res = fakeRes();
  await g.handle('/api/lineage/recover')({}, res);
  A.eq(res.status, 202, 'POST /api/lineage/recover answers 202');
  A.eq(g.calls[0], 'quiesce:false', 'after the same quiesce');
  await tick(220);
  A.eq(g.calls.filter(c => c.startsWith('restart')), ['restart:recovery'], 'and the same restart path');
  g = routes(t, { candidateRoots: [legacy], inspection, readBody: async () => '{"candidateId":"nope"}' });
  res = fakeRes();
  await g.handle('/api/lineage/recover')({}, res);
  await tick(220);
  A.eq([res.status, g.calls.filter(c => c.startsWith('restart'))], [409, []], 'a refused recovery never restarts');

  /* ---- GATE: the page's own START FRESH handler, run with the transport faked ---- */
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'app.js'), 'utf8');
  const from = app.indexOf("const freshBtn = el('btn-lineage-fresh');");
  const to = app.indexOf("show('screen-lineage');", from);
  A.ok(from > 0 && to > from, 'fixture: the gate\'s START FRESH block is found in app.js');
  const block = app.slice(from, to);
  // the block's polls decide a reload through gateRefusedPage (App scope, not in the block): lift the real one by source, as
  // station-refusal-readers.test.js does, over a Harness whose reader says whether the gate refused this page's key
  const gateSrc = A.fnBody(app, 'function gateRefusedPage(');
  A.ok(gateSrc.length > 0, 'fixture: app.js defines gateRefusedPage');
  let gateRefused = false;
  const gateRefusedPage = new Function('Harness', gateSrc + '\nreturn gateRefusedPage;')({ classifyApiFailure: () => gateRefused ? { staleSession: true } : null });
  function gate(lineage, answers) {
    const page = { status: { textContent: '' }, btn: { textContent: '✦ START FRESH', disabled: false, onclick: null }, reloads: 0, timer: null, stopped: false, later: [], asked: [] };
    const fetchFake = async (url, opts) => {
      page.asked.push(url);
      const answer = url === '/api/lineage/start-fresh' ? answers.post : answers.poll();
      return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
    };
    const run = new Function('el', 'SFX', 'status', 'lineage', 'validCandidates', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'location', 'gateRefusedPage', block);
    run(id => id === 'btn-lineage-fresh' ? page.btn : null, {}, page.status, lineage, [], fetchFake,
      fn => { page.timer = fn; return 1; }, () => { page.stopped = true; }, (fn, ms) => { page.later.push({ fn, ms }); return 1; }, { reload() { page.reloads++; } }, gateRefusedPage);
    return page;
  }
  const REQUESTED_AT = T0 + 100;
  const accepted = { status: 202, body: { ok: true, requestedAt: REQUESTED_AT, desktopWillRestart: true } };
  const lineageAnswer = l => ({ status: 200, body: { ok: true, lineage: l } });
  async function press(page) { await page.btn.onclick(); await page.btn.onclick(); }

  // a failure the old sidecar's lineage still shows from an earlier try is not this press's answer; the newer one is
  let answer = lineageAnswer({ priorInstallEvidence: true, lastFresh: { ok: false, at: T0 - 5, error: 'an old failure' } });
  let p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await p.btn.onclick();
  A.ok(/quarantine/.test(p.status.textContent) && /Press again/.test(p.status.textContent), 'the first press only arms (' + p.status.textContent + ')');
  A.ok(/sign-ins, channel bots and connectors/.test(p.status.textContent), 'and says what leaves with the workspace');
  A.eq(p.asked, [], 'nothing was asked of the sidecar yet');
  await p.btn.onclick();
  A.eq([p.asked, p.btn.disabled], [['/api/lineage/start-fresh'], true], 'the second press asks, and the button waits');
  A.ok(/set aside as it comes back/.test(p.status.textContent), 'the status line says when the set-aside happens (' + p.status.textContent + ')');
  await p.timer();
  A.eq([p.stopped, p.btn.disabled, p.reloads], [false, true, 0], 'an older lastFresh is not this request\'s answer: the poll goes on');
  answer = lineageAnswer({ priorInstallEvidence: true, lastFresh: { ok: false, at: REQUESTED_AT + 900, error: 'a program still has a file in this workspace open.', holder: 'the station browser (lockfile in use)' } });
  await p.timer();
  A.eq([p.stopped, p.btn.disabled, p.btn.textContent, p.reloads], [true, false, '✦ START FRESH', 0], 'A NEWER FAILED lastFresh stops the poll and re-arms the button');
  A.ok(/could not start fresh/.test(p.status.textContent) && /still has a file/.test(p.status.textContent) && /station browser/.test(p.status.textContent), 'and the status line shows the error and the holder (' + p.status.textContent + ')');
  await press(p);
  A.eq(p.asked.filter(u => u === '/api/lineage/start-fresh').length, 2, 'the button works again');

  // success: the evidence is gone, whatever else lastFresh says
  answer = lineageAnswer({ priorInstallEvidence: false, lastFresh: { ok: true, at: REQUESTED_AT + 900 } });
  p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await press(p);
  await p.timer();
  A.eq([p.stopped, p.reloads], [true, 1], 'an open gate reloads into onboarding');
  // a set-aside that left other evidence behind still ends the wait
  answer = lineageAnswer({ priorInstallEvidence: true, lastFresh: { ok: true, at: REQUESTED_AT + 900 } });
  p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await press(p);
  await p.timer();
  A.eq([p.stopped, p.reloads], [true, 1], 'a finished request with new evidence reloads into the gate, never a forever wait');
  // the sidecar door's half of the carry rule is said before the reload
  answer = lineageAnswer({ priorInstallEvidence: false, lastFresh: { ok: true, at: REQUESTED_AT + 900, creditsLeftAside: true } });
  p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await press(p);
  await p.timer();
  A.eq([p.stopped, p.reloads, p.later.length > 0], [true, 0, true], 'a link left aside holds the reload');
  A.ok(/account link could not be carried/.test(p.status.textContent), 'long enough to read that it stayed behind (' + p.status.textContent + ')');
  p.later.filter(l => l.ms > 1000 && l.ms !== 12000).forEach(l => l.fn());
  A.eq(p.reloads, 1, 'then it reloads');
  // #39: the gate refusing this page's key (the restart minted a new one) means only a reload reconnects, and the work is already done
  answer = lineageAnswer({ priorInstallEvidence: true });
  p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await press(p);
  gateRefused = true;
  await p.timer();
  gateRefused = false;
  A.eq([p.stopped, p.reloads], [true, 1], 'a poll the gate refused reloads once and stops, whatever lineage says');
  // an answer the gate did not refuse (the old service still going down) leaves the poll going
  p = gate({ priorInstallEvidence: true }, { post: accepted, poll: () => answer });
  await press(p);
  await p.timer();
  A.eq([p.stopped, p.reloads], [false, 0], 'an answer the gate did not refuse leaves the poll going');
  // a refused POST re-arms at once
  p = gate({ priorInstallEvidence: true }, { post: { status: 409, body: { ok: false, error: 'a station recovery request is already pending' } }, poll: () => answer });
  await press(p);
  A.eq([p.btn.disabled, p.timer], [false, null], 'a refused request re-arms, with no poll');
  A.ok(/already pending/.test(p.status.textContent), 'and says why');
  // the gate opens on a request that did not finish: a reload outran the poll
  p = gate({ priorInstallEvidence: true, lastFresh: { ok: false, at: T0, error: 'it did not finish.' } }, { post: accepted, poll: () => answer });
  A.ok(/could not start fresh/.test(p.status.textContent) && /did not finish/.test(p.status.textContent), 'the gate says why on opening');
  p = gate({ priorInstallEvidence: true, lastFresh: { ok: true, at: T0 } }, { post: accepted, poll: () => answer });
  A.eq(p.status.textContent, '', 'and is silent about one that finished');
  // the page never touches a station itself
  A.eq(/localStorage|startCreation|removeItem/.test(block), false, 'the page only asks: nothing here clears or creates a station client-side');

  A.report('start-fresh-generation.test');
})().catch(e => { console.log('FAIL: unhandled — ' + (e && e.stack || e)); process.exitCode = 1; }).finally(() => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
});
