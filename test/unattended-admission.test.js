/* node test/unattended-admission.test.js — the futile-beat skip's resolver (sidecar/unattended-admission.js) and the
   driver seam that carries its hold (cost fix W1.6). Pure: a fake clock and fake deps, no sidecar.

   The rule: a build beat that ended 'duplicate-backlog' against a BUILT, undecided item is remembered with the
   fingerprint of what it read; the next beats are held before the leash is spent ('awaiting-verdict', naming the
   build) only while that fingerprint is unchanged and the build is still undecided. Any change re-admits at once.
   The real sidecar proof (0 provider calls, leash unchanged, one ledger row, re-admitted by a message and a verdict,
   across a restart) is test/nightshift-futile-beat.e2e.test.js. */
'use strict';
const A = require('./_assert.js');
const UA = require('../sidecar/unattended-admission.js');
const { makeNightshiftDriver } = require('../sidecar/nightshift-driver.js');
const ns = require('../sidecar/nightshift.js');

// ---- fingerprint: one stable digest of the parts, key order never matters, any change moves it ----
(function fingerprint() {
  const parts = { work: [['undecided', 'r2', 'b2', 'Continue: X']], backlog: [['b2', 'continue: x', 'r2', '']], activity: [['u1', 100]], context: { goal: null, known: ['goals'], beliefs: { goals: ['ship'] }, threads: [] }, focus: ['', '', ''], project: null, posture: ['leash', 'sandbox'], engine: ['openrouter', 'm'],
    persona: 'You are the overseer.', verdicts: { rated: 3, answered: [['scout:a', 'declined']], learning: [true, 1] } };
  const reordered = { verdicts: { learning: [true, 1], answered: [['scout:a', 'declined']], rated: 3 }, persona: 'You are the overseer.', engine: ['openrouter', 'm'], posture: ['leash', 'sandbox'], project: null, focus: ['', '', ''], context: { threads: [], beliefs: { goals: ['ship'] }, known: ['goals'], goal: null }, activity: [['u1', 100]], backlog: [['b2', 'continue: x', 'r2', '']], work: [['undecided', 'r2', 'b2', 'Continue: X']] };
  const fp = UA.fingerprint(parts);
  A.ok(/^[0-9a-f]{64}$/.test(fp), 'a sha256 hex digest');
  A.eq(UA.fingerprint(reordered), fp, 'the same parts in another key order hash alike');
  A.eq(UA.fingerprint(JSON.parse(JSON.stringify(parts))), fp, 'a copy hashes alike');
  const moved = (mut) => { const p = JSON.parse(JSON.stringify(parts)); mut(p); return UA.fingerprint(p) !== fp; };
  A.ok(moved(p => p.activity.unshift(['u2', 200])), 'a new owner run (a new message) moves it');
  A.ok(moved(p => { p.work = []; p.backlog = []; }), 'a verdict (the build leaves the backlog) moves it');
  A.ok(moved(p => p.backlog.push(['b3', 'new task', '', ''])), 'a new task moves it');
  A.ok(moved(p => p.context.threads.push(['t1', 5])), 'a new open thread moves it');
  A.ok(moved(p => { p.project = ['/p', true, 'abc']; }), 'a project focus with a new HEAD moves it');
  A.ok(moved(p => { p.focus[2] = '/steered'; }), 'a steer moves it');
  A.ok(moved(p => { p.posture[1] = 'observe'; }), 'a dial change moves it');
  A.ok(moved(p => { p.engine[1] = 'another/model'; }), 'a model change moves it');
  A.ok(moved(p => { p.context.beliefs.goals = ['ship v2']; }), 'a dossier change moves it');
  A.ok(moved(p => { p.persona = 'You are the overseer. Be terse.'; }), 'a persona edit (or its learned tail) moves it');
  A.ok(moved(p => { p.verdicts.rated = 4; }), 'a new like or dislike (one more rating) moves it');
  A.ok(moved(p => { p.verdicts.answered.unshift(['quest:q', 'completed']); }), 'a new answer to a recommendation moves it');
  A.ok(moved(p => { p.verdicts.learning = [false, 2]; }), 'pausing learning moves it');
  A.eq(UA.canonical({ b: 1, a: undefined, c: [1, { z: 2, y: 1 }] }), '{"b":1,"c":[1,{"y":1,"z":2}]}', 'canonical sorts keys at every depth and drops undefined');
})();

// ---- settle: only the dead end against an undecided build is remembered ----
(function settle() {
  const seen = { fp: 'f1' };
  A.eq(UA.settle(seen, { delivered: false, reason: 'duplicate-backlog', waitingOn: { runId: 'r2', backlogId: 'b2' } }, 7), { fp: 'f1', runId: 'r2', backlogId: 'b2', at: 7 }, 'the dead end on an undecided build is remembered with what the beat read');
  A.eq(UA.settle(seen, { delivered: false, reason: 'duplicate-backlog' }, 7), null, 'a title refused for another cause (queued, discarded) names no build to wait on: nothing remembered');
  A.eq(UA.settle(seen, { delivered: true, reason: 'built' }, 7), null, 'a delivery forgets it');
  A.eq(UA.settle(seen, { delivered: false, reason: 'no-candidates' }, 7), null, 'another stand-down forgets it');
  A.eq(UA.settle(seen, null, 7), null, 'a beat that threw forgets it');
  A.eq(UA.settle({ fp: null }, null, 7), null, 'a reason-only draft beat (the host settles it with no reading and no result) forgets it');
  A.eq(UA.settle({ fp: null }, { reason: 'duplicate-backlog', waitingOn: { runId: 'r2' } }, 7), null, 'an unproven reading (no fingerprint) is never remembered');
})();

// ---- decide: hold only a build beat, while nothing changed and the build is still undecided and on the desk ----
(function decide() {
  const stuck = { fp: 'f1', runId: 'r2', backlogId: 'b2', at: 1 };
  const waiting = { title: 'Continue: X', runId: 'r2' };
  const held = { stuck, builds: true, fp: 'f1', waiting, desk: true };
  const at = (patch) => UA.decide(Object.assign({}, held, patch));
  A.eq(at({ stuck: null }), { admit: true }, 'nothing remembered: admit');
  A.eq(UA.decide(held), { admit: false, binding: 'awaiting-verdict', why: { title: 'Continue: X', runId: 'r2' } }, 'a build beat, unchanged, the build undecided and on the desk: held, naming the build');
  A.eq(at({ builds: false }), { admit: true, changed: 'mode' }, 'the next beat would run as a reason-only draft (the away-workshop grant is off, or the dial is below building): never held, a draft queues nothing so it cannot end on the dead end');
  A.eq(at({ builds: undefined }).admit, true, 'an unproven mode never holds');
  A.eq(at({ fp: 'f2' }), { admit: true, changed: 'inputs' }, 'anything the beat reads changed: admitted at once');
  A.eq(at({ fp: null }).admit, true, 'an unproven reading never holds');
  A.eq(at({ waiting: null }), { admit: true, changed: 'verdict' }, 'the build was decided (no longer in the backlog): nothing is awaited');
  A.eq(at({ waiting: { title: 'Y', runId: 'r9' } }).admit, true, 'another build in its place is not the one awaited');
  A.eq(at({ desk: false }), { admit: true, changed: 'desk' }, 'a build the desk no longer lists (its deliverable is gone) is never claimed to wait there');
  A.eq(at({ desk: undefined }).admit, true, 'an unproven desk never holds');
  A.eq(UA.AWAITING_VERDICT, 'awaiting-verdict', 'the binding name');
})();

// ---- the driver carries the hold: before the spend, one edge-triggered row naming the build, status sees it ----
(function driverSeam() {
  const T0 = 1700000000000, MIN = 60000;
  let state = ns.fresh(T0), beats = 0, writes = 0, hold = { ok: false, reason: 'awaiting-verdict', why: { title: 'Continue: X', runId: 'r2', nested: { no: 1 } } };
  const ledger = [];
  const d = makeNightshiftDriver({
    getState: () => state, setState: (s) => { writes++; state = s; },
    getPosture: () => ({ actsUnattended: true, leashPerDay: 3 }),
    lastActivity: () => 0, precheck: () => hold,
    beat: () => { beats++; return Promise.resolve({ delivered: false, reason: 'duplicate-backlog' }); },
    now: () => T0, ledger: (e) => ledger.push(e), awayThresholdMs: 15 * MIN, beatIntervalMs: 45 * MIN
  });
  for (let i = 0; i < 30; i++) A.eq(d.applyTick(T0 + i * MIN).binding, 'awaiting-verdict', i ? undefined : 'a held tick binds awaiting-verdict');
  A.eq(beats, 0, 'no beat ran (no model call)');
  A.eq(state.beatsUsedToday || 0, 0, 'no leash unit was spent');
  const rows = ledger.filter(e => e.kind === 'decline');
  A.eq(rows.length, 1, '30 held ticks write ONE decline row');
  A.ok(rows[0].preSpend === true && rows[0].why && rows[0].why.title === 'Continue: X' && rows[0].why.runId === 'r2' && !('nested' in rows[0].why), 'the row is pre-spend and names the build (primitives only): ' + JSON.stringify(rows[0]));
  const st = d.statusDecision(T0 + 31 * MIN);
  A.ok(st.fire === false && st.binding === 'awaiting-verdict' && st.why && st.why.runId === 'r2', 'status reads the same hold and names the build');
  hold = { ok: false, reason: 'awaiting-verdict', why: { title: 'Continue: Y', runId: 'r3' } };
  d.applyTick(T0 + 32 * MIN);
  A.eq(ledger.filter(e => e.kind === 'decline').length, 2, 'a hold on ANOTHER build is a new edge: one more row');
  hold = { ok: true };
  A.eq(d.applyTick(T0 + 33 * MIN).fired, true, 'the moment the precheck admits, the beat fires');
  A.eq(beats, 1, 'and makes its call');
  A.eq(state.beatsUsedToday, 1, 'spending its leash unit at accept time, as before');
  A.ok(writes >= 1, 'the spend was persisted');
  const plain = makeNightshiftDriver({ getState: () => ns.fresh(T0), setState() {}, getPosture: () => ({ actsUnattended: true, leashPerDay: 3 }), lastActivity: () => 0,
    precheck: () => ({ ok: false, reason: 'readiness' }), beat: () => Promise.resolve({}), ledger: (e) => ledger.push(e), awayThresholdMs: 15 * MIN, beatIntervalMs: 45 * MIN });
  ledger.length = 0;
  plain.applyTick(T0);
  A.ok(ledger[0] && ledger[0].binding === 'readiness' && !('why' in ledger[0]), 'a stand-down without a why writes the row it always wrote');
  A.ok(!('why' in plain.statusDecision(T0)), 'and status carries no why');
})();

// ---- THE HOST'S HALF, the real code sliced from the sidecar (length-guarded: fnBody does not parse regex literals) ----
const vm = require('vm');
const path = require('path');
const { readSidecarSource } = require('./helpers/source');
const SRC = readSidecarSource();
const slice = (header, max) => { const b = A.fnBody(SRC, header); A.ok(b.length > 40 && b.length < max, 'extracted the real ' + header + ' (' + b.length + ' chars)'); return b; };
const HOST_SRC = ['function readSmallText(', 'function projectHeadOf(', 'function nightshiftBeatBuilds(', 'function futileDeskHas(', 'function futileBeatHold('].map(h => slice(h, 3000)).join('\n');

// an in-memory disk (path -> text; the folders those paths imply exist too) that counts what was read: nothing on the real
// disk is consulted, so a walk up from a focus never meets a repository above the test
function memFs(files) {
  const key = p => path.resolve(String(p));
  const map = new Map(Object.keys(files).map(k => [key(k), files[k]]));
  const dirs = new Set();
  for (const k of map.keys()) for (let d = path.dirname(k); !dirs.has(d); d = path.dirname(d)) { dirs.add(d); if (path.dirname(d) === d) break; }
  const m = { reads: 0, map };
  m.existsSync = p => { m.reads++; return map.has(key(p)) || dirs.has(key(p)); };
  m.readFileSync = p => { m.reads++; if (!map.has(key(p))) throw Object.assign(new Error('ENOENT ' + key(p)), { code: 'ENOENT' }); return map.get(key(p)); };
  m.readdirSync = p => { m.reads++; const d = key(p); return Array.from(new Set(Array.from(map.keys()).concat(Array.from(dirs)).filter(x => x !== d && path.dirname(x) === d).map(x => path.basename(x)))); };
  return m;
}
function host(o) {
  const seen = { backlog: 0, fp: 0, notes: [] };
  const ctx = vm.createContext({
    fs: o.fs || memFs({}), path, WORKSPACES: path.resolve('/ws'), UnattendedAdmission: UA,
    commanderPosture: { summary: () => o.posture || { buildsUnattended: true } },
    workshopOf: id => (o.granted === false ? null : { agentId: id }),
    fsJail: { safeAgentId: id => { if (!/^[a-z]+$/.test(id)) throw new Error('refused agent id'); return id; } },
    failNote: tag => seen.notes.push(tag),
    workshopStore: { backlogOf: () => { seen.backlog++; return o.backlog || []; } },
    futileBeatFingerprint: () => { seen.fp++; return 'fp' in o ? o.fp : 'f1'; },
    nightshiftStuck: o.stuck || {}
  });
  const api = vm.runInContext(HOST_SRC + '\n({ projectHeadOf, nightshiftBeatBuilds, futileDeskHas, futileBeatHold })', ctx);
  return Object.assign(api, { seen });
}

// ---- projectHeadOf: the commit the scan's `git -C <focus>` reads, from the focus's own repo or the nearest one above it ----
(function projectHead() {
  const A1 = 'a'.repeat(40), B1 = 'b'.repeat(40), C1 = 'c'.repeat(40), D1 = 'd'.repeat(40), E1 = 'e'.repeat(40);
  const disk = memFs({ '/p/.git/HEAD': 'ref: refs/heads/main\n', '/p/.git/refs/heads/main': A1 + '\n', '/p/src/deep/file.js': 'x',
    '/wt/.git': 'gitdir: ' + path.resolve('/p/.git/worktrees/wt') + '\n', '/wt/sub/a.js': 'x', '/p/.git/worktrees/wt/HEAD': 'ref: refs/heads/feat\n', '/p/.git/worktrees/wt/commondir': '../..\n', '/p/.git/refs/heads/feat': C1 + '\n',
    '/q/.git/HEAD': 'ref: refs/heads/main\n', '/q/.git/packed-refs': '# pack-refs with: peeled\n' + D1 + ' refs/heads/main\n',
    '/d/.git/HEAD': E1 + '\n', '/n/b.txt': 'x', '/n/a.txt': 'x', '/n/.env': 'SECRET=1' });
  const h = host({ fs: disk });
  A.eq(h.projectHeadOf('/p'), A1, 'a repo focus reads its HEAD commit');
  A.eq(h.projectHeadOf('/p/src/deep'), A1, 'a focus on a folder INSIDE a repo reads that repo\'s HEAD (the scan\'s git -C reads it too), not the folder\'s names');
  disk.map.set(path.resolve('/p/.git/refs/heads/main'), B1 + '\n');
  A.eq(h.projectHeadOf('/p/src/deep'), B1, 'so a commit in that repo moves a sub-folder focus');
  A.eq(h.projectHeadOf('/wt/sub'), C1, 'a linked worktree (its .git is a file naming the git dir) resolves its branch through commondir');
  A.eq(h.projectHeadOf('/q'), D1, 'a branch with no loose ref reads packed-refs');
  A.eq(h.projectHeadOf('/d'), E1, 'a detached HEAD is the commit itself');
  A.eq(h.projectHeadOf('/n'), 'a.txt/b.txt', 'a folder in no repo shows its top-level names, never .env or .git');
})();

// ---- nightshiftBeatBuilds: the ONE predicate for the beat's mode ----
(function beatMode() {
  A.eq(host({}).nightshiftBeatBuilds('agent'), true, 'the dial builds unattended and the away-workshop grant is on: a BUILD beat');
  A.eq(host({ granted: false }).nightshiftBeatBuilds('agent'), false, 'the grant off: a reason-only draft');
  A.eq(host({ posture: { buildsUnattended: false } }).nightshiftBeatBuilds('agent'), false, 'the dial below building: a draft');
  A.eq(host({}).nightshiftBeatBuilds('agent', { buildsUnattended: false }), false, 'a posture the caller already read is the one asked');
})();

// ---- futileDeskHas: the deliverable the desk lists the build by is still on disk, in the agent's jail ----
(function deskHas() {
  const disk = memFs({ '/ws/agent/workshop/r2/deliverable.json': '{}' });
  const h = host({ fs: disk });
  A.eq(h.futileDeskHas('agent', 'r2'), true, 'the deliverable is there: the build is on the desk');
  A.eq(h.futileDeskHas('agent', 'r3'), false, 'no deliverable: not on the desk');
  const before = disk.reads;
  A.eq(h.futileDeskHas('agent', '../r2'), false, 'a run id that is not a plain id is never a path');
  A.eq(disk.reads, before, 'and touches no disk');
  A.eq(h.futileDeskHas('Bad Id', 'r2'), false, 'an agent id the jail refuses has no desk to claim');
  A.ok(h.seen.notes.indexOf('nightshift.futile.desk-path') >= 0, 'and the refusal is noted, never thrown into the precheck');
})();

// ---- futileBeatHold: the hold the precheck and status read, over the beat's own mode ----
(function hold() {
  const stuck = { agent: { fp: 'f1', runId: 'r2', backlogId: 'b2', at: 1 } };
  const backlog = [{ id: 'b2', title: 'Continue: X', builtRunId: 'r2' }];
  const desk = () => memFs({ '/ws/agent/workshop/r2/deliverable.json': '{}' });
  const held = host({ stuck, backlog, fs: desk() });
  A.eq(held.futileBeatHold('agent'), { ok: false, reason: 'awaiting-verdict', why: { title: 'Continue: X', runId: 'r2' } }, 'a build beat, unchanged, the build undecided and on the desk: held, naming it');
  const none = host({ backlog, fs: desk() });
  A.eq(none.futileBeatHold('agent'), null, 'nothing remembered: admitted');
  A.ok(none.seen.backlog === 0 && none.seen.fp === 0, 'and nothing read (the precheck runs every tick)');
  const off = host({ stuck, backlog, fs: desk(), granted: false });
  A.eq(off.futileBeatHold('agent'), null, 'REVIEW BLOCKER: the away-workshop grant turned off lifts the hold at once (the next beat is a reason-only draft, which is never the futile one)');
  A.ok(off.seen.backlog === 0 && off.seen.fp === 0, 'and a draft beat reads neither the backlog nor the fingerprint');
  A.eq(host({ stuck, backlog, fs: desk(), posture: { buildsUnattended: false } }).futileBeatHold('agent'), null, 'the dial lowered below building lifts it too');
  A.eq(host({ stuck, backlog, fs: desk(), fp: 'f2' }).futileBeatHold('agent'), null, 'anything the beat reads changed: admitted');
  A.eq(host({ stuck, backlog, fs: desk(), fp: null }).futileBeatHold('agent'), null, 'an unproven reading: admitted');
  A.eq(host({ stuck, backlog: [], fs: desk() }).futileBeatHold('agent'), null, 'the build was decided: admitted');
  A.eq(host({ stuck, backlog, fs: memFs({}) }).futileBeatHold('agent'), null, 'its deliverable is gone from disk: the hold never claims it waits on the desk');
})();

// ---- ONE RESOLVER for the beat's mode (the family the review blocker belongs to): every reader asks nightshiftBeatBuilds ----
(function oneResolver() {
  const beat = slice('async function runNightshiftBeat(', 40000);
  const precheck = slice('function nightshiftPrecheck()', 6000);
  const status = slice('function handleNightshiftStatus(', 12000);
  const holdSrc = slice('function futileBeatHold(', 3000);
  A.eq((SRC.match(/buildsUnattended && workshopOf\(/g) || []).length, 1, 'the predicate is spelled once in the sidecar (inside nightshiftBeatBuilds)');
  A.ok(/return !!\(p\.buildsUnattended && workshopOf\(agentId\)\);/.test(slice('function nightshiftBeatBuilds(', 3000)), 'and that one place is the resolver');
  A.ok(beat.indexOf('if (nightshiftBeatBuilds(agentId, posture)) {') >= 0, 'the beat picks build or draft by it');
  A.ok(/nightshiftBeatBuilds\(NIGHTSHIFT_AGENT\) && routingHold\(\)\)/.test(precheck), 'the held-floor gate asks it');
  A.ok(/const builds = nightshiftBeatBuilds\(agentId\);/.test(holdSrc), 'the futile-beat hold asks it');
  A.ok(/out\.buildMode = \(\(\) => \{ try \{ return nightshiftBeatBuilds\(NIGHTSHIFT_AGENT, summary\); \}/.test(status) && !/buildsUnattended && wsGranted/.test(status), 'status names the mode it returns');
  const buildEnd = beat.indexOf('finally { settleFutileBeat(agentId, seen, result); }'), forget = beat.indexOf('settleFutileBeat(agentId, null, null);');
  A.ok(buildEnd > 0 && forget > buildEnd && forget < beat.indexOf('nightshiftContextPack()') && forget < beat.indexOf('nightshiftChat('),
    'a reason-only draft beat forgets the futile one before it reads or calls anything');
  A.ok(/let nightshiftStuck = loadNightshiftStuck\(\);[^\n]*\n[^\n]*\nsetImmediate\(\(\) => \{ for \(const aid of Object\.keys\(nightshiftStuck\)\) proveFutileDesk\(aid, nightshiftStuck\[aid\]\); \}\);/.test(SRC),
    'a marker a restart carried over is re-proved against the desk');
})();

// ---- the desk's proof retracts a hold on a build the desk would not list (settleFutileBeat -> proveFutileDesk) ----
async function deskProof() {
  const code = slice('function settleFutileBeat(', 3000) + '\n' + slice('function proveFutileDesk(', 3000);
  const make = (manifest) => {
    const saved = [];
    let release = null;
    const gate = new Promise(r => { release = r; });
    const ctx = vm.createContext({ UnattendedAdmission: UA, nightshiftStuck: {}, NIGHTSHIFT_STUCK_FILE: '/ws/nightshift.stuck.json', WORKSPACES: '/ws',
      fs: { mkdirSync() {} }, saveResilient: (f, v) => saved.push(JSON.parse(JSON.stringify(v))), failNote() {},
      validateWorkshopManifest: () => gate.then(() => manifest) });
    const api = vm.runInContext(code + '\n({ settle: settleFutileBeat, read: () => nightshiftStuck, put: (v) => { nightshiftStuck = v; } })', ctx);
    return Object.assign(api, { saved, release });
  };
  const dead = { delivered: false, reason: 'duplicate-backlog', waitingOn: { runId: 'r2', backlogId: 'b2' } };
  const flush = () => new Promise(r => setImmediate(r));
  const gone = make(null);
  gone.settle('agent', 'f1', dead);
  A.ok(gone.read().agent && gone.read().agent.runId === 'r2', 'the futile beat is remembered');
  gone.release(); await flush(); await flush();
  A.ok(!gone.read().agent, 'the desk could not prove its deliverable: the marker is forgotten, so the next beat runs');
  A.ok(gone.saved.length === 2 && !gone.saved[1].stuck.agent, 'and the forgetting is persisted');
  const ok = make({ runId: 'r2', files: [] });
  ok.settle('agent', 'f1', dead);
  ok.release(); await flush(); await flush();
  A.ok(ok.read().agent && ok.read().agent.runId === 'r2', 'a build the desk proves keeps the hold');
  const newer = make(null);
  newer.settle('agent', 'f1', dead);
  newer.put({ agent: Object.assign({}, newer.read().agent, { at: newer.read().agent.at + 1 }) });
  newer.release(); await flush(); await flush();
  A.ok(newer.read().agent, 'a proof that resolves after a newer marker leaves that marker alone');
}

deskProof().then(() => A.report('unattended-admission.test'), (e) => { console.log('FAIL: unattended-admission.test threw - ' + (e && e.stack || e)); process.exit(1); });
