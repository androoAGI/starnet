'use strict';
/* test/helpers/line-hold-rig.js — the REAL work-line walk to a hold, for the line-hold lane's tests (S3).

   What is real: the compiled floor and router (frontend/app/pipeline.js, routing/router.js), the chain runner (routing/chain.js), the
   LineRunner (routing/line-runner.js), the pure job store (routing/linejobs.js, written through a JSON round trip and normalizeAll like
   the host's domain store), the continuation validator, and the STATION'S OWN hold proofs: holdOriginOf / holdPlanHash / holdFileReceipt /
   holdAuthority are compiled out of sidecar/index.js itself (the block between the two markers below), so a test never stands in a
   hand-written copy of how the host names an origin, binds a floor or hashes a file. What is faked: the provider (runOnce) and the clock.

   makeRig(o) -> rig
     o.gate     the LOOP gate's props (default { when: 'approved', maxIter: 6 })
     o.wiring   what its lanes reach (WIRINGS; default 'esc unwired')
     o.hold     false = a host with no hold port at all (the runner of before this lane)
     o.entryUsd / o.hopUsd   what the entry run and every hop cost (default 0.02 / 0.01)
     o.files    true = the drafter's runs write a real file (rig.fileOf(job) names it)
   o.floor    (S5) a whole floor { props, belts } in place of the gate floor above; o.entry { agentId, dockId } is the dock the entry run
              is at (default the gate floor's reviewer), o.agents the crew the station knows, o.peek lets the chain run single-step
              branches at once, o.barrierStore the chain's barrier file. rig.reply(x) answers every stage then (no 'reviewer' agent),
              rig.timers records every joiner timeout the chain armed. o.idBase / o.clockBase start the ids and the clock of a RESTARTED station
              past the first one's (a real restart mints new ones: a collision would be a fixture lie).
   rig.run({ entry, replies, origin, seed, files }) -> { job, line }     one job down the line, exactly as an entry door runs it:
        open -> runLineJob -> (the caller settles). `replies` are the REVIEWER's answers in order: replies[0] arrives with the job (the
        reviewer is the line's entry dock), each later reviewer turn answers the next one, the last repeats. Every other dock answers
        'another draft'.
   rig.settle(job, line) -> the entry's settle, as the hub does it (the line's text and stop note as the output)
   rig.world() -> a fingerprint of everything a held job must not move: provider calls, day-ledger notes, run rows, OUTBOX crates,
        shipment callbacks and durable finishes
   rig.reload() / rig.boot()   the saved store after a JSON round trip + normalizeAll / after the station's boot pass (LineJobs.boot) */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm'), crypto = require('node:crypto');
const P = require('../../frontend/app/pipeline.js');
const J = require('../../sidecar/routing/linejobs.js');
const LineHold = require('../../sidecar/routing/line-hold.js');
const { makeRouter } = require('../../sidecar/routing/router.js');
const { makeChainRunner } = require('../../sidecar/routing/chain.js');
const { makeLineRunner } = require('../../sidecar/routing/line-runner.js');
const Source = require('./source.js');

const belt = (x, y, dir) => ({ x, y, dir });
// INBOX -> drafter -> reviewer (the entry dock) -> LOOP gate (done E to the OUTBOX, back N to the drafter): the S2 policy test's floor, wired
// four ways (what the gate's escalation lane and done lane reach)
const WIRINGS = ['esc unwired', 'esc to a dock', 'esc to an OUTBOX only', 'human OUTBOX beside a downstream dock'];
const AFTER = 'a stage after the gate';   // not in WIRINGS: the policy matrix is about where the escalation lane goes; this floor is the resume tests'
/* THE REVIEWER'S WORDS the line-hold tests script, in one table for the in-process matrix and the real-sidecar wiring test (gh#122): the
   revise that sends the work round the gate, and BLOCKED in the five forms a reply can take. The verdict parser must hold every one. */
const REVISE = 'not yet\nVERDICT: revise';
const FORMS = [['plain', 'not safe to publish\nVERDICT: blocked'], ['UPPER', 'NOT SAFE TO PUBLISH\nVERDICT: BLOCKED'],
  ['markdown', 'not safe to publish\n**VERDICT:** `blocked`'], ['trailing line', 'VERDICT: blocked\n\nThanks for your patience.'], ['quoted tail', '> VERDICT: blocked']];
function geometry(gate, wiring) {
  wiring = wiring || 'esc unwired';
  const belts = [belt(1, 4, 'E'), belt(2, 4, 'E'), belt(5, 4, 'E'), belt(6, 4, 'E'), belt(7, 4, 'E'), belt(10, 4, 'E'), belt(11, 4, 'E'), belt(12, 4, 'E'),
    belt(13, 4, 'E'), belt(14, 4, 'E'), belt(12, 3, 'N'), belt(12, 2, 'N'), belt(12, 1, 'W')];
  for (let x = 11; x >= 6; x--) belts.push(belt(x, 1, 'W'));
  belts.push(belt(5, 1, 'S'), belt(5, 2, 'S'));
  const props = [{ id: 'p1', t: 'intake', x: 0, y: 4, w: 1, h: 1 }, { id: 'p2', t: 'bay', x: 3, y: 3, w: 2, h: 2, agentId: 'drafter' },
    { id: 'p3', t: 'bay', x: 8, y: 3, w: 2, h: 2, agentId: 'reviewer' },
    Object.assign({ id: 'p5', t: 'loop', x: 12, y: 4, w: 1, h: 1, done: 'E', when: 'approved', maxIter: 6 }, gate || {}),
    (wiring === 'human OUTBOX beside a downstream dock' || wiring === AFTER) ? { id: 'p6', t: 'bay', x: 15, y: 3, w: 2, h: 2, agentId: 'publisher' } : { id: 'p6', t: 'outbox', x: 15, y: 3, w: 2, h: 2 }];
  // AFTER (S4's floor): the done lane runs a PUBLISHER stage and then reaches the OUTBOX, so an APPROVE has a paid stage to run from the saved cursor
  if (wiring === AFTER) { belts.push(belt(17, 4, 'E'), belt(18, 4, 'E')); props.push({ id: 'p8', t: 'outbox', x: 19, y: 3, w: 2, h: 2 }); }
  if (wiring !== 'esc unwired' && wiring !== AFTER) props.find(p => p.t === 'loop').esc = 'S';
  if (wiring === 'esc to a dock') { props.push({ id: 'p9', t: 'bay', x: 14, y: 6, w: 2, h: 2, agentId: 'fixer' }); belts.push(belt(12, 5, 'S'), belt(12, 6, 'E'), belt(13, 6, 'E')); }
  if (wiring === 'esc to an OUTBOX only' || wiring === 'human OUTBOX beside a downstream dock') { props.push({ id: 'p7', t: 'outbox', x: 11, y: 7, w: 2, h: 2 }); belts.push(belt(12, 5, 'S'), belt(12, 6, 'S')); }
  return { props, belts };
}

/* The station's hold proofs, compiled from sidecar/index.js (the block from the first marker to the second). `scope` supplies only what
   index.js would have in module scope: the router, E-STOP, the workspaces root, failNote. */
function hostPorts(scope) {
  const index = Source.readSidecarIndex();
  const a = index.indexOf("/* ---- THE HOLD'S HOST PROOFS (line-hold lane, S3)"), b = index.indexOf('/* RESTART TRUTH (2026-07-06 audit', a);
  if (a < 0 || b <= a) throw new Error('rig: the hold host-proofs block is missing from sidecar/index.js');
  const names = ['holdOriginOf', 'holdPlanHash', 'holdFileReceipt', 'holdAuthority', 'routinePolicyDigest', 'routinePolicyOf', 'routineOf'];
  const s = Object.assign({ LineHold, crypto, fs, path, WORKSPACES: os.tmpdir(), failNote: () => {}, nightshiftState: {},
    // the routines the station knows (index.js cronJobs, read through cronStore.getJob): a resume of a routine's job reads its configuration from here
    cronJobs: [], cronStore: { getJob: (jobs, id) => jobs.find(j => j && j.id === id) || null },
    // what a RESUME's authority reads beside a hold's (line-hold lane, S4): the crew, the halts, the day ledger
    sampleRunConfigFor: () => ({ ok: true, configured: true }), cronHalted: false, processFaultQuiesced: false, lineSpend: { spentToday: () => 0 } }, scope);
  if (!s.admit) s.admit = s.router;   // index.js reads the floor through the saved-floor seams (admit.*); a rig with one posted-plan router answers the same names with it
  return vm.compileFunction(index.slice(a, b) + '\nreturn {' + names.join(',') + '};', Object.keys(s))(...Object.values(s));
}

/* The station's resume profile, compiled from sidecar/index.js (the block from RESUME_PERSONA to the live-walk registry). `scope` supplies what
   index.js has in module scope (lineRunner, sampleRunConfigFor, router, redact, and the routine reads of the host proofs). */
function resumeProfile(scope) {
  const index = Source.readSidecarIndex();
  const a = index.indexOf('const RESUME_PERSONA ='), b = index.indexOf('const lineResumeInflight = new Map();', a);
  if (a < 0 || b <= a) throw new Error('rig: the resume profile block is missing from sidecar/index.js');
  return vm.compileFunction(index.slice(a, b) + '\nreturn resumeProfileFor;', Object.keys(scope))(...Object.values(scope));
}

function makeRig(o) {
  o = o || {};
  const entryUsd = o.entryUsd == null ? 0.02 : o.entryUsd, hopUsd = o.hopUsd == null ? 0.01 : o.hopUsd;
  const plan = P.compileRoutingPlan(o.floor || geometry(o.gate, o.wiring)), router = makeRouter();
  if (!router.setPlan(plan).ok) throw new Error('rig: the floor does not deploy: ' + JSON.stringify(plan.errors));
  const entryDock = o.entry || { agentId: 'reviewer', dockId: 'p3' };
  const lineId = o.floor ? router.lineOriginFor(entryDock.agentId, entryDock.dockId) : router.lineOriginFor('drafter', 'p2');
  let state = { jobs: [] }, seq = o.idBase || 0, clock = o.clockBase || 1000, said = 0, runN = 0, replies = [];   // (a RESTARTED station mints ids and reads a clock that are not the first one's: o.idBase, o.clockBase)
  const rows = new Map(), events = [], calls = [], notes = [], shipped = [], counts = { finish: 0, hold: 0, start: 0 }, timers = [];
  const now = () => ++clock, newId = () => (++seq).toString(16).padStart(12, '0');
  const rig = { router, plan, lineId, rows, events, calls, notes, shipped, counts, timers, halted: false, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'line-hold-rig-')) };
  const put = r => { state = J.normalizeAll(JSON.parse(JSON.stringify(r.state))); return r.job ? J.get(state, r.job.id) : null; };   // saved, then read back
  rig.jobs = { start: x => { counts.start++; return put(J.start(state, x)); }, get: id => J.get(state, id),
    finish: (id, x) => { counts.finish++; return put(J.finish(state, id, x)); }, mark: (id, s) => put(J.mark(state, id, s)), all: () => state.jobs };
  if (o.hold !== false) rig.jobs.hold = (id, rev, c) => { counts.hold++; return put(J.checkpoint(state, id, rev, c)); };
  rig.day = { spent: () => 0, note: (l, usd) => notes.push(usd) };   // the day ledger the chain notes every paid stage into (a test may swap in the real one)
  rig.roster = new Map((o.agents || ['drafter', 'reviewer', 'publisher', 'fixer']).map(a => [a, { agentId: a }]));   // the crew the station knows (a resume refuses a deleted agent)
  // the run config a stage would resolve (index.js sampleRunConfigFor): an agent the station's crew no longer holds cannot run
  const configFor = a => rig.roster.has(a) ? { ok: true, configured: true } : { ok: false, error: 'target agent ' + a + ' is not in the live roster' };
  rig.cron = [];   // the routines this station knows (a test pushes the cron job record a scheduled or Run Now job came from)
  rig.ports = hostPorts({ router, nightshift: { isHalted: () => rig.halted }, sampleRunConfigFor: configFor, lineSpend: { spentToday: l => rig.day.spent(l) }, cronJobs: rig.cron });
  // (the chain is built by a function: a RESTARTED station is a new chain with no barrier in memory — rig.restartChain())
  const buildChain = () => makeChainRunner(Object.assign({ nextAgent: (a, x) => router.chainNext(a, x), stepDock: (d, x) => router.chainStepDock(d, x), entryDockOf: a => router.entryDockOf(a),
    fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d), agentOfDock: d => router.agentOfDock(d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), onShipped: r => shipped.push(r),
    daySpend: { spentToday: l => rig.day.spent(l), note: (l, usd) => rig.day.note(l, usd) }, emit: (n, p) => events.push({ n, p }), now, newId, getTag: () => 'general',
    setTimer: (fn, ms) => { timers.push(ms); return 0; } },
  o.peek ? { peekDock: (d, x) => router.chainPeekDock(d, x) } : null, o.barrierStore ? { barrierStore: o.barrierStore } : null));
  rig.chain = buildChain();
  const fileOf = job => path.join(rig.dir, job.id + '.md');
  rig.fileOf = fileOf;
  rig.seen = [];   // every provider call as it was made: what the stage was handed and under which verdicts it ran
  const runOnce = async x => {
    calls.push(x.agentId);
    const msgs = Array.isArray(x.messages) ? x.messages : [], lastUser = msgs.length ? msgs[msgs.length - 1] : null;
    rig.seen.push({ agentId: x.agentId, dockId: x.dockId, runId: x.runId, prompt: lastUser ? String(lastUser.content) : '', ownerTrusted: x.ownerTrusted, untrustedEntry: x.untrustedEntry,
      channelSender: x.channelSender, channelSenderOwner: x.channelSenderOwner, ceilingUsd: x.ceilingUsd, unattendedGrants: x.unattendedGrants, surface: x.surface });
    if (rig.beforeCall) rig.beforeCall(x, calls.length);   // a test's hand on the world while the job is out (a floor edit, an E-STOP)
    const reviewer = !o.floor && x.agentId === 'reviewer';   // (a custom floor has no reviewer: rig.reply answers every stage)
    const text = reviewer ? replies[Math.min(said++, replies.length - 1)] : (typeof rig.reply === 'function' ? rig.reply(x) : 'another draft');
    const row = { runId: x.runId, streamId: x.streamId, agentId: x.agentId, dockId: x.dockId, reason: 'done', outcome: 'succeeded', startedAt: now(), usd: hopUsd, projectRoot: rig.dir };
    if (!reviewer && o.files) { fs.writeFileSync(path.join(rig.dir, 'draft-' + x.runId + '.md'), 'the file ' + x.runId); row.artifacts = [{ kind: 'file', path: 'draft-' + x.runId + '.md' }]; }
    rows.set(x.runId, row); x.emit('agent.run.end', row);
    return Object.assign({ text }, row);
  };
  const build = () => makeLineRunner({ chain: rig.chain, runOnce, jobs: rig.jobs, runRow: id => rows.get(id), emit: (n, p) => events.push({ n, p }), now, newId,
    handoffFiles: async (agentId, artifacts, opts) => artifacts.map(a => ({ abs: path.join((opts && opts.projectRoot) || rig.dir, a.path) })),
    hold: o.hold === false ? undefined : { originOf: rig.ports.holdOriginOf, planHash: rig.ports.holdPlanHash, receiptFor: rig.ports.holdFileReceipt, authority: rig.ports.holdAuthority } });
  rig.runner = build();
  // the facts each entry door hands the walk (hub.js jobOriginFacts, the cron seams, the trigger and SEND TO runners)
  const hex = c => c.repeat(64);
  rig.facts = {
    channel: { instanceId: 'telegram', chatId: 'chat-1', senderId: 'user-1', chatType: 'dm', threadId: null, boundAgentId: null },
    // a routine's facts are the configuration its hops run under (the host digests it: holdOriginOf), the same shape both cron seams pass
    schedule: runId => ({ routineId: 'cron_demo', fireRunId: runId, policy: { preloadSkills: ['skill-a'], requiredPreloads: true, workdir: null, enabledToolsets: null } }),
    manual: runId => ({ routineId: 'cron_demo', fireRunId: runId, policy: { preloadSkills: ['skill-a'], requiredPreloads: true, workdir: null, enabledToolsets: null } }),
    trigger: { triggerId: 'trg_demo12345', triggerKind: 'webhook', reservationId: hex('c'), fingerprint: hex('d') },
    folder: { triggerId: 'trg_demo12345', triggerKind: 'folder', sourceText: 'a new file landed' },
    sendto: { sourceJobId: 'job-aaaaaaaaaaaa', sourceLineId: 'L1', sourceOutboxId: 'o1', targetIntakeId: 'i1', lineage: ['L1', 'L2'], depth: 1 },
    sample: {}, steptest: {}
  };
  rig.run = async function run(opts) {
    opts = opts || {};
    const entry = opts.entry || 'channel', n = ++runN, runId = 'run-entry-' + n, streamId = 'rig-stream-' + n;
    replies = (opts.replies || ['not safe to publish\nVERDICT: blocked']).slice(); said = 0;
    const first = replies[said++];
    rows.set(runId, { runId, streamId, agentId: entryDock.agentId, dockId: entryDock.dockId, reason: 'done', outcome: 'succeeded', startedAt: now(), usd: entryUsd, projectRoot: rig.dir });
    const job = rig.runner.open({ line: lineId, entry, text: 'write a post', streamId, delivery: opts.delivery });
    const facts = opts.origin !== undefined ? opts.origin : (typeof rig.facts[entry] === 'function' ? rig.facts[entry](runId) : rig.facts[entry]);
    const seed = Object.assign({ agentId: entryDock.agentId, dockId: entryDock.dockId, lineId, runId, streamId, since: rows.get(runId).startedAt, text: first, originalText: 'write a post',
      entryUsd, entryTrusted: true, hostPowerKept: true, origin: facts, taints: [] }, opts.seed);
    const line = await rig.runner.runLineJob({ job, seed, profile: opts.profile || rig.runner.profiles.channel({}) });   // (opts.profile: the profile the door's hub really builds)
    return { job, line, runId, streamId };
  };
  rig.settle = (job, line, facts) => rig.runner.settle(job, Object.assign({ line, output: String(line.text || '') + rig.runner.stopNote(line) }, facts));
  /* WIRED TO THE REAL HOST: the runner's job port and the day ledger are the production ones (index.js lineJobsSet and the real spend ledger),
     exactly as the lineRunner `jobs:` block wires them. */
  rig.wire = host => {
    Object.assign(rig.jobs, {
      start: x => host.mutate(st => J.start(st, x)),
      finish: (id, x) => { counts.finish++; return host.mutate(st => J.finish(st, id, x)); },
      get: id => J.get(host.jobs(), id), mark: (id, st) => host.mutate(x => J.mark(x, id, st)), all: () => host.jobs().jobs,
      hold: (id, rev, c) => { counts.hold++; return host.hold(id, rev, c); }
    });
    rig.day = { spent: l => host.ledger.spentToday(l), note: (l, usd) => { notes.push(usd); host.ledger.note(l, usd); } };
    return rig;
  };
  /* THE RESUME OWNER over the real host's store, the rig's runner and the station's own authority (line-resume.js); `over` swaps one dep */
  /* THE STATION'S OWN resumeProfileFor (index.js), compiled out of the host: the profile a resumed hop runs under — a channel profile that is
     untrusted and power-withheld whatever the job ran under, and, for a routine's job, inside the routine's own tool envelope. The rig supplies
     only what index.js has in module scope: the line runner (whose profiles are read when the profile is built), the run config, the router. */
  rig.productionProfileFor = () => resumeProfile({ lineRunner: { get profiles() { return rig.runner.profiles; } }, sampleRunConfigFor: configFor, router, admit: router, redact: s => s,
    routineOf: rig.ports.routineOf, routinePolicyOf: rig.ports.routinePolicyOf });
  rig.owner = (host, over) => {
    const Resume = require('../../sidecar/routing/line-resume.js'), inflight = new Map();
    return Resume.makeLineResume(Object.assign({ store: host.store, authority: q => rig.ports.holdAuthority(q), runner: rig.runner, profileFor: rig.productionProfileFor(), hold: { receiptFor: rig.ports.holdFileReceipt },
      halted: () => rig.halted, inflight, runRow: id => rows.get(id), now }, over));
  };
  rig.record = id => J.get(state, id);
  rig.state = () => state;
  rig.reload = () => { state = J.normalizeAll(JSON.parse(JSON.stringify(state))); return state; };
  rig.boot = () => { state = J.normalizeAll(JSON.parse(JSON.stringify(J.boot(state, now()).state))); rig.runner = build(); return state; };
  // a RESTARTED station: the chain and the runner are new objects with nothing in memory (no join barrier, no live handle); the saved jobs are what the disk says
  rig.restartChain = () => { rig.chain = buildChain(); rig.runner = build(); return rig; };
  rig.world = () => JSON.stringify({ calls: calls.length, notes: notes.slice(), rows: rows.size, crates: events.filter(e => e.n === 'workitem.delivered' && e.p.finalQueueId === 'outbox').length,
    lineOutputs: events.filter(e => e.n === 'workitem.delivered' && e.p.box === 'line-output').length, shipped: shipped.length, finish: counts.finish });
  rig.dispose = () => { try { fs.rmSync(rig.dir, { recursive: true, force: true }); } catch (_) { /* a temp dir */ } };
  return rig;
}

module.exports = { makeRig, geometry, hostPorts, WIRINGS, AFTER, FORMS, REVISE };
