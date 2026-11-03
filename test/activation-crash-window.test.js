/* node test/activation-crash-window.test.js — A PROCESS THAT DIES AT ANY STEP OF AN ACTIVATION IS FINISHED BY THE NEXT BOOT.

   THE CLASS. START FRESH and explicit recovery each end in the same two renames: the live generation to the shelf, the stage
   into its place. Two renames cannot be one, and a process can die between them (power, a hard kill, a crash). Nothing knew an
   activation had been under way, so the next boot compared the request's pins against a workspace that was gone, refused it
   with "Nothing was moved" although everything had been, and made an empty workspace: no seal, no record, no marker. The erase
   authority survived only on the shelf, where nothing reads it, so the boot after that imported the very station the Commander
   had erased or set aside (the gh#101 resurrection), and a power loss let the shell's own legacy migration do the same first.
   The request file now carries a journal, and every boot settles it first (sidecar/workspace-recovery.js resumeActivation).

   THE INVARIANT, for BOTH activations and at EVERY step: kill a real child process just before its next rename, unlink or
   remove in applyPendingRecovery, then boot as index.js boots. Whichever step it was, the next boot leaves what the Commander
   asked for and no boot ever says otherwise:
     - the workspace is sealed and holds exactly the generation that was asked for, its station record and its facts;
     - the erase authority and the acknowledged roots are kept, so automatic recovery stays blocked, against a root nothing ever
       acknowledged too;
     - the old generation sits byte-identical on the shelf, once;
     - no stage is left behind, the request is consumed, and nothing was refused.
   Where the death left no workspace at all, the row runs twice more with the desktop shell going first, as it does after a power
   loss (main.rs migrate_workspace_data runs before any sidecar, into any workspace with no seal): once importing the legacy root,
   once with nothing to import. shellMigration() is the one stand-in here, what that function leaves. What it imported is set
   aside too, never deleted.

   SETTLE holds the states a death alone does not reach, all from a child killed in the window: a station nobody accounts for
   stays (and the request ends honestly), a stage that vanished, a journal naming anything else, a request that cannot be
   removed, and a name that will not move.

   Only the kill is faked, at the fs edge, in a child, so no catch block runs that a real death would skip. The requests are the
   real routes' own functions, and the boots are called with the arguments index.js passes. */
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Recovery = require('../sidecar/workspace-recovery.js');
const Lineage = require('../sidecar/workspace-lineage.js');

const T = Date.UTC(2026, 9, 31, 12, 0, 0);
const BUILD = '0.15.0-test';
const SAVE = 'agent.save.json';
const layout = root => ({ root, ws: path.join(root, 'workspaces'), legacy: path.join(root, 'legacy', 'workspaces'), extra: path.join(root, 'extra', 'workspaces'),
  shelf: path.join(root, 'workspace-quarantine'), freshRequest: path.join(root, 'workspaces.fresh-request.json'), recoveryRequest: path.join(root, 'workspaces.recovery-request.json'),
  last: path.join(root, 'workspaces.recovery-last.json') });
// what index.js passes (startupWorkspaceRecovery); scratchRoots stands in for the real home the scratch guard protects
const bootOpts = (t, at, over) => Object.assign({ fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [t.legacy, t.extra], auto: true, scratchRoots: [],
  now: () => at, buildVersion: BUILD }, over);

/* ---- THE CHILD: one boot, killed just before step `dieAt` ('landing' = the stage's own rename). Steps are the calls that move
   something on disk; the recovery lock and owner files are bookkeeping and are not counted. ---- */
const STEPS = ['renameSync', 'rmSync', 'unlinkSync'];
const BOOKKEEPING = /recovery-owner|recovery\.lock|starnet-workspace-owner/;
if (process.argv[2] === 'child') {
  const spec = JSON.parse(process.argv[3]), t = layout(spec.root);
  let step = 0;
  const dying = new Proxy(fs, { get(target, key) {
    const real = target[key];
    if (typeof real !== 'function') return real;
    if (!STEPS.includes(key)) return real.bind(target);
    return (...args) => {
      const landing = key === 'renameSync' && /-stage-/.test(String(args[0])) && path.resolve(String(args[1])) === t.ws;
      if (spec.dieAt === 'landing' ? landing : (!BOOKKEEPING.test(String(args[0])) && ++step === spec.dieAt)) process.exit(9);
      return real.apply(target, args);
    };
  } });
  Recovery.applyPendingRecovery(bootOpts(t, T + 2000, { fs: dying }));
  process.exit(0);
}

const A = require('./_assert.js');
console.warn = () => {};   // every boot here says why it imported nothing: that is what the rows assert
let SR = null;
try { SR = require('../sidecar/station-record.js'); } catch (_) { SR = null; }   // a checkout from before the record still runs every row it can build

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-activation-crash-'));
let sandboxes = 0;
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body)); };
const parsed = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const station = name => ({ version: 1, agentId: 'agent', updatedAt: 5, savedAt: 5, doc: { schema: 'starnet.save', version: 5, updatedAt: 5, agent: { id: 'agent', name }, station: { rooms: [{ id: 'command' }], props: [] }, workstreams: [{ id: 'general', history: [] }] } });
// every file under a folder with its hash; the owner check's own files are bookkeeping, never station state
function tree(dir) {
  const out = {};
  (function walk(d, rel) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.starnet-workspace-owner.json')) continue;
      const r = rel ? rel + '/' + entry.name : entry.name, abs = path.join(d, entry.name);
      if (entry.isDirectory()) walk(abs, r); else out[r] = hash(fs.readFileSync(abs));
    }
  })(dir, '');
  return out;
}
const names = dir => Object.keys(tree(dir)).sort();
const leftovers = (t, re) => fs.readdirSync(t.root).filter(n => re.test(n));
const dieIn = (t, dieAt) => spawnSync(process.execPath, [__filename, 'child', JSON.stringify({ root: t.root, dieAt })], { encoding: 'utf8' });
function sandbox() {
  const t = layout(path.join(scratch, 's' + (++sandboxes)));
  fs.mkdirSync(t.ws, { recursive: true });
  return t;
}
// the desktop's own erase, as fresh_start.rs leaves it: the seal and the marker, every legacy root acknowledged
const eraseMarker = (t, roots) => JSON.stringify({ version: 1, erased: true, at: String(T), acknowledgedRoots: roots, quarantine: null, moved: [] }, null, 2);
function ensure(t, at) { if (SR) return SR.ensure({ fs, path, platform: process.platform, now: () => at, workspaceRoot: t.ws }); return null; }
// the boot index.js runs: the pending lifecycle first, then the workspace it makes for its stores, then the record
function boot(t, at, over) {
  const result = Recovery.applyPendingRecovery(bootOpts(t, at, over));
  fs.mkdirSync(t.ws, { recursive: true });
  ensure(t, at);
  return result;
}

/* main.rs migrate_workspace_data, into a missing workspace (the one stand-in): a sealed generation holding a copy of the one
   valid legacy root, with its receipt, or, with no legacy root, an empty sealed generation with an empty receipt. */
function shellMigration(t, imports) {
  fs.mkdirSync(t.ws);
  const files = [];
  if (imports) {
    for (const name of fs.readdirSync(t.legacy)) {
      const bytes = fs.readFileSync(path.join(t.legacy, name));
      fs.writeFileSync(path.join(t.ws, name), bytes);
      files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  fs.writeFileSync(path.join(t.ws, '.migration-receipt.json'), JSON.stringify({ version: 1, validated: true, sourceRoots: imports ? [t.legacy] : [], files }));
  fs.writeFileSync(path.join(t.ws, '.migrated'), '1');
}

/* ---- THE TWO ACTIVATIONS: each builds a real request on an ERASED generation, and says what the next boot must leave ---- */
const FRESH = {
  name: 'START FRESH',
  build() {
    const t = sandbox();
    write(path.join(t.ws, '.migrated'), '1');
    write(path.join(t.ws, '.fresh-start.json'), eraseMarker(t, [t.legacy]));
    for (const [rel, body] of [['agent.roster.json', '{"version":1,"agents":[]}'], ['ledger.jsonl', 'a row\n'], ['agent/report.md', 'the old jail'], ['.secrets/credits.json', '{"accountId":"acct-7"}']]) write(path.join(t.ws, ...rel.split('/')), body);
    write(path.join(t.legacy, SAVE), station('ERASED-OLD-STATION'));
    write(path.join(t.extra, SAVE), station('NEVER-ACKNOWLEDGED'));
    ensure(t, T + 500);
    t.before = tree(t.ws);
    const asked = Lineage.requestFresh({ fs, path, platform: process.platform, workspaceRoot: t.ws, candidateRoots: [t.legacy], now: () => T + 1000, buildVersion: BUILD });
    if (!asked || asked.ok !== true) throw new Error('no request: ' + JSON.stringify(asked));
    return t;
  },
  shelved(t) { return fs.existsSync(t.shelf) ? fs.readdirSync(t.shelf).map(n => path.join(t.shelf, n)) : []; },
  verify(t, label, first) {
    A.eq(names(t.ws), ['.fresh-start.json', '.migrated', '.secrets/credits.json', '.station.json'], label + ': the workspace is the clean generation, sealed, the account link carried');
    const record = parsed(path.join(t.ws, '.station.json'));
    A.eq(record && [record.state, record.eraseAuthority], ['none', true], label + ': no station, and the erase keeps its authority (' + JSON.stringify(record) + ')');
    A.ok(!!record && record.acknowledgedRoots.includes(t.legacy), label + ': the root the erase acknowledged stays acknowledged');
    const last = parsed(t.last);
    A.ok(last === null || (last.kind === 'fresh' && last.ok === true), label + ': the last result never reports a failure (' + JSON.stringify(last) + ')');
    A.ok(!/Nothing was moved/.test(JSON.stringify(first) + JSON.stringify(last)), label + ': no boot says nothing moved');
    const gate = Lineage.inspectWorkspaceLineage({ fs, path, platform: process.platform, workspaceRoot: t.ws, candidateRoots: [t.legacy], now: () => T + 3500 });
    A.eq([gate.onboardingAllowed, gate.evidence], [true, []], label + ': the gate shows no prior station');
    const auto = Recovery.applyPendingRecovery(bootOpts(t, T + 4000));
    A.eq([auto.applied, auto.code], [false, 'AUTO_RECOVERY_ERASED'], label + ': and the boot after that imports nothing, not even a root nothing acknowledged (' + JSON.stringify(auto) + ')');
  }
};
const RECOVERY = {
  name: 'explicit recovery',
  build() {
    const t = sandbox();
    write(path.join(t.ws, '.migrated'), '1');
    write(path.join(t.ws, '.fresh-start.json'), eraseMarker(t, []));
    write(path.join(t.ws, 'ledger.jsonl'), 'the replaced generation\n');
    write(path.join(t.legacy, SAVE), station('CHOSEN'));
    write(path.join(t.extra, SAVE), station('NOT-CHOSEN'));
    ensure(t, T + 500);
    t.before = tree(t.ws);
    const opts = { fs, path, platform: process.platform, home: t.root, workspaceRoot: t.ws, candidateRoots: [t.legacy, t.extra], now: () => T + 1000 };
    const inspection = Recovery.inspectCandidates(opts);
    Recovery.requestRecovery(Object.assign({}, opts, { inspection, candidateId: inspection.candidates.find(row => row.sourceRoot === t.legacy).id }));
    return t;
  },
  shelved(t) { return leftovers(t, /\.recovery-rollback-/).map(n => path.join(t.root, n)); },
  verify(t, label, first) {
    A.ok(!!first && first.ok !== false, label + ': the boot reports no failure (' + JSON.stringify(first) + ')');
    A.eq(fs.readFileSync(path.join(t.ws, SAVE)).equals(fs.readFileSync(path.join(t.legacy, SAVE))), true, label + ': the workspace is the chosen station');
    A.eq(fs.existsSync(path.join(t.ws, '.migrated')), true, label + ': sealed');
    const record = parsed(path.join(t.ws, '.station.json'));
    A.eq(record && [record.state, record.eraseAuthority], ['active', true], label + ': active, and the erase keeps its authority (' + JSON.stringify(record) + ')');
    A.ok(!!record && [t.legacy, t.extra].every(root => record.acknowledgedRoots.includes(root)), label + ': every root the recovery chose among is acknowledged');
    const last = parsed(t.last);
    A.ok(last === null || last.ok === true, label + ': the last result never reports a failure (' + JSON.stringify(last) + ')');
  }
};

function row(sc, dieAt, shell) {
  const t = sc.build();
  const died = dieIn(t, dieAt);
  const wsGone = !fs.existsSync(t.ws);
  if (died.status !== 0 && died.status !== 9) { A.ok(false, sc.name + ' step ' + dieAt + ': the child failed on its own (' + died.status + '): ' + died.stderr); return { finished: true }; }
  const label = sc.name + ', dead before step ' + dieAt + (shell ? ', then the shell ' + (shell === 'import' ? 'imported the legacy root' : 'sealed an empty workspace') : '');
  if (died.status === 0 && shell) return { finished: true };
  if (shell) shellMigration(t, shell === 'import');
  const first = boot(t, T + 3000);
  sc.verify(t, label, first);
  const shelved = sc.shelved(t);
  const old = shelved.filter(dir => !dir.endsWith('-interrupted'));
  A.eq(old.length, 1, label + ': one set-aside generation (' + JSON.stringify(shelved) + ')');
  if (old.length === 1) A.eq(tree(old[0]), t.before, label + ': the old generation is byte-identical on the shelf');
  const imported = shelved.filter(dir => dir.endsWith('-interrupted'));
  A.eq(imported.length, shell ? 1 : 0, label + ': what appeared after the first rename is shelved too, never deleted');
  if (shell === 'import' && imported.length === 1) A.eq(tree(imported[0])[SAVE], hash(fs.readFileSync(path.join(t.legacy, SAVE))), label + ': the import is whole');
  A.eq(leftovers(t, /-stage-/), [], label + ': no stage is left behind');
  A.eq(leftovers(t, /(?:fresh|recovery)-request\.json(?:\.failed-\d+)?$/), [], label + ': the request is consumed, and none was refused');
  return { finished: died.status === 0, wsGone };
}

/* ---- EVERY STEP, both activations ---- */
for (const sc of [FRESH, RECOVERY]) {
  try {
    let steps = 0, windows = 0;
    for (let dieAt = 1; dieAt <= 120; dieAt++) {
      const r = row(sc, dieAt);
      if (r.finished) break;
      steps++;
      if (r.wsGone) { windows++; row(sc, dieAt, 'import'); row(sc, dieAt, 'empty'); }
    }
    A.ok(steps >= 8, sc.name + ': the row walked the activation\'s steps (' + steps + ')');
    A.ok(windows >= 1, sc.name + ': at least one step leaves no workspace at all (' + windows + ')');
  } catch (e) { A.ok(false, sc.name + ': this checkout cannot run the row (' + (e && e.message) + ')'); }
}

/* ---- SETTLE: the states a death alone does not reach, each from a child killed in the window ---- */
function settle(what, sc, body) {
  try { body(sc.build()); } catch (e) { A.ok(false, what + ': this checkout cannot run the row (' + (e && e.stack) + ')'); }
}
// a station a receipt does not account for, on top of an interrupted activation: the one thing that is never set aside
for (const sc of [FRESH, RECOVERY]) {
  settle(sc.name + ' under a founded station', sc, t => {
    A.eq(dieIn(t, 'landing').status, 9, sc.name + ': fixture: the child dies at the landing');
    fs.mkdirSync(t.ws);
    write(path.join(t.ws, SAVE), station('FOUNDED-SINCE'));
    const bytes = fs.readFileSync(path.join(t.ws, SAVE));
    const r = Recovery.applyPendingRecovery(bootOpts(t, T + 3000));
    A.eq([r.ok, r.applied], [false, false], sc.name + ': the activation ends, reported (' + JSON.stringify(r) + ')');
    A.ok(/station has been created here since/.test(r.error) && !/Nothing was moved/.test(r.error), sc.name + ': and says what happened (' + r.error + ')');
    A.ok(fs.readFileSync(path.join(t.ws, SAVE)).equals(bytes), sc.name + ': the new station is left as it is');
    A.eq(tree(sc.shelved(t)[0]), t.before, sc.name + ': the set-aside generation stays on the shelf, named in the error');
    A.ok(r.error.includes(sc.shelved(t)[0]), sc.name + ': the error names where it is');
    A.eq(leftovers(t, /-stage-/), [], sc.name + ': the stage goes');
    A.eq(leftovers(t, /request\.json$/), [], sc.name + ': the request cannot run again');
    A.eq(leftovers(t, /request\.json\.failed-\d{17}$/).length, 1, sc.name + ': it is kept as .failed-<stamp>');
  });
}
// a receipt that does not cover the save: the file changed after the shell copied it, so it is a station, not the import
settle('an import that a session changed', FRESH, t => {
  dieIn(t, 'landing');
  shellMigration(t, true);
  write(path.join(t.ws, SAVE), station('CHANGED-SINCE-THE-IMPORT'));
  const r = Recovery.applyPendingRecovery(bootOpts(t, T + 3000));
  A.eq(r.code, 'FRESH_ACTIVATION_INTERRUPTED', 'a save the receipt does not cover byte for byte is never set aside (' + JSON.stringify(r) + ')');
  A.eq(fs.existsSync(path.join(t.ws, SAVE)), true, 'it stays');
});
// the stage vanished: the generation goes back, and the request simply runs again
settle('a stage that vanished', FRESH, t => {
  dieIn(t, 'landing');
  for (const stage of leftovers(t, /-stage-/)) fs.rmSync(path.join(t.root, stage), { recursive: true, force: true });
  const first = boot(t, T + 3000);
  A.eq([first.kind, first.applied], ['fresh', true], 'with no stage the generation goes back and the request runs again (' + JSON.stringify(first) + ')');
  FRESH.verify(t, 'a stage that vanished', first);
  A.eq(FRESH.shelved(t).length, 1, 'once');
  A.eq(tree(FRESH.shelved(t)[0]), t.before, 'and the generation is whole');
});
// a journal that names anything but this workspace's own stage and shelf is no journal: nothing it names is touched
settle('a journal naming something else', FRESH, t => {
  const elsewhere = path.join(t.root, 'someone-elses-folder'), other = path.join(t.root, 'another');
  write(path.join(elsewhere, 'keep.txt'), 'keep');
  write(path.join(other, 'keep.txt'), 'keep');
  const request = parsed(t.freshRequest);
  for (const activation of [{ ready: true, stage: elsewhere, aside: other, record: 'x', result: { ok: true } }, { ready: true, stage: t.ws + '.fresh-stage-1', aside: other, record: 'x', result: { ok: true } }, 'not an object']) {
    write(t.freshRequest, Object.assign({}, request, { activation }));
    const copy = sandbox();
    A.eq(Object.keys(tree(elsewhere)), ['keep.txt'], 'fixture: the folder is there');
    fs.rmSync(copy.root, { recursive: true, force: true });
  }
  const r = boot(t, T + 3000);
  A.eq([r.kind, r.applied, r.resumed], ['fresh', true, undefined], 'the request runs as if there were no journal (' + JSON.stringify(r) + ')');
  A.eq(names(elsewhere), ['keep.txt'], 'and what the journal named is untouched');
  A.eq(names(other), ['keep.txt'], 'both of them');
});
// a request that cannot be removed: the journal finishes it again, and a finished reset is never reported as a failure
settle('a request that cannot be removed', FRESH, t => {
  const stuck = new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync') return p => { if (String(p) === t.freshRequest) throw Object.assign(new Error('EPERM: denied'), { code: 'EPERM' }); return target.unlinkSync(p); };
    const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  const first = Recovery.applyPendingRecovery(bootOpts(t, T + 2000, { fs: stuck }));
  A.eq([first.kind, first.ok], ['fresh', true], 'the set-aside finishes');
  A.eq(fs.existsSync(t.freshRequest), true, 'fixture: the request is stuck');
  ensure(t, T + 2500);
  const next = boot(t, T + 3000);
  A.eq([next.ok, next.applied, next.resumed], [true, true, true], 'the next boot finishes it from the journal, never "reset again" (' + JSON.stringify(next) + ')');
  A.eq(fs.existsSync(t.freshRequest), false, 'and it is gone');
  FRESH.verify(t, 'a request that cannot be removed', next);
});
// a name that will not move, boot after boot: the stage's own files are written in place, so nothing waits forever
for (const sc of [FRESH, RECOVERY]) {
  settle(sc.name + ' with a name that will not move', sc, t => {
    dieIn(t, 'landing');
    const refusing = new Proxy(fs, { get(target, key) {
      if (key === 'renameSync') return (a, b) => { if (/-stage-/.test(String(a))) throw Object.assign(new Error('EPERM: held'), { code: 'EPERM' }); return target.renameSync(a, b); };
      const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
    } });
    const first = Recovery.applyPendingRecovery(bootOpts(t, T + 3000, { fs: refusing }));
    A.eq([first.ok, first.applied, first.resumed], [true, true, true], sc.name + ': the last exit finishes it (' + JSON.stringify(first) + ')');
    ensure(t, T + 3100);
    sc.verify(t, sc.name + ' written in place', first);
    A.eq(leftovers(t, /-stage-/), [], sc.name + ': the stage goes');
  });
}

fs.rmSync(scratch, { recursive: true, force: true });
A.report('activation-crash-window.test');
