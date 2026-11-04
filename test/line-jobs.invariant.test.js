/* Every entry uses one job verdict and one durable finish. Exercise the real runner and LineJobs store, with injected
   I/O only: no streamed prose or current floor topology is evidence that a job reached its OUTBOX. */
'use strict';
const A = require('./_assert.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');

async function main() {
  let state = { jobs: [] }, seq = 0, clock = 100, finishes = 0, failStart = false, failFinish = false;
  const events = [], rows = new Map();
  const store = result => { state = result.state; return result.job; };
  const runner = makeLineRunner({ now: () => ++clock, newId: () => String(++seq).padStart(12, '0'),
    runOnce: async o => {
      const row = { runId: o.runId, agentId: o.agentId, reason: 'done', outcome: 'succeeded', usd: 0.2 };
      rows.set(o.runId, row);
      o.emit('agent.token', { runId: o.runId, text: 'narration that must not be handed on' });
      o.emit('agent.run.end', row);
      return { reason: 'done', outcome: 'succeeded', text: 'finished work' };
    },
    chain: { advance: async seed => {
      const r = await seed.runAgent({ agentId: 'writer', text: seed.text, lineId: seed.lineId });
      return { text: r.text, agentId: 'writer', outboxId: 'outbox-a', hops: [r], jobId: seed.jobId };
    } },
    jobs: { start: o => { if (failStart) throw new Error('disk refused start'); return store(J.start(state, o)); }, finish: (id, o) => {
      if (failFinish) throw new Error('disk refused finish');
      finishes++; return store(J.finish(state, id, o));
    }, get: id => J.get(state, id), mark: (id, status) => store(J.mark(state, id, status)), all: () => state.jobs },
    runRow: id => rows.get(id), emit: (name, payload) => events.push({ name, payload }) });

  A.ok(typeof runner.open === 'function' && typeof runner.settle === 'function', 'the production runner owns job opening and settlement');
  if (typeof runner.open !== 'function') { A.report('line-jobs.invariant.test'); return; }
  failStart = true;
  A.throws(() => runner.open({ id: 'job-refusedstart', line: 'line-a', entry: 'sample', streamId: 'refused-start' }), 'a failed start refuses admission');
  A.ok(!runner.get('job-refusedstart') && !J.get(state, 'job-refusedstart'), 'failed start advertises no live or saved job');
  failStart = false;
  const admitted = runner.open({ id: 'job-refusedstart', line: 'line-a', entry: 'sample', streamId: 'refused-start' });
  A.eq(state.jobs.filter(j => j.id === admitted.id).length, 1, 'retry of a refused start creates exactly one record');
  runner.settle(admitted, { stopped: true });
  const clean = { runId: 'entry', agentId: 'researcher', reason: 'done', outcome: 'succeeded', usd: 0.1 };
  rows.set(clean.runId, clean);
  for (const entry of ['channel', 'schedule', 'manual', 'trigger', 'sendto', 'sample', 'steptest']) {
    const job = runner.open({ line: 'line-a', entry, streamId: entry + '-stream', text: 'research this' });
    A.eq(runner.open({ id: job.id, line: 'line-a', streamId: entry + '-stream' }), job, entry + ': adopting the wrapper record opens no second job');
    const line = await runner.runLineJob({ job, seed: { agentId: 'researcher', runId: 'entry', lineId: 'line-a', text: 'entry work' }, profile: runner.profiles.channel({}) });
    A.eq(line.jobId, job.id, entry + ': the walk carries the sending job id');
    const before = finishes;
    const result = runner.settle(job, { line });
    A.eq([result.delivered, result.outcome, result.status, result.stop], [true, 'delivered', 'delivered', null], entry + ': a proven OUTBOX result is delivered');
    A.eq([job.record.entry, job.record.runs.length, job.record.output], [entry, 2, 'finished work'], entry + ': record keeps the entry, exact runs and terminal output');
    A.eq(job.record.runs.map(r => r.agentId), ['writer', 'researcher'], entry + ': the final stage is first for job history and delivered-work readers');
    A.eq(runner.settle(job, { error: 'late cleanup failed' }), result, entry + ': a later cleanup cannot rewrite its outcome');
    A.eq(finishes - before, 1, entry + ': exactly one durable finish');
    A.ok(runner.deliverCrate(result, { workitemId: job.id, ts: clock }), entry + ': the first crate reaches OUTBOX');
    A.ok(!runner.deliverCrate(result, { workitemId: job.id, ts: clock }), entry + ': a second settle cannot deliver the crate twice');
  }
  A.eq(events.length, 7, 'one OUTBOX crate per delivered job across all seven entries');
  A.ok(events.every(e => e.name === 'workitem.delivered' && e.payload.finalQueueId === 'outbox' && e.payload.box === ''), 'the one emitter uses the floor OUTBOX contract');

  const cases = [
    ['no_outbox', { runs: [clean], line: { agentId: 'researcher' } }, 'stopped_short'],
    ['stage_incomplete', { runs: [Object.assign({}, clean, { reason: 'max_iters', outcome: 'step_limit' })], line: { outboxId: 'outbox-a' } }, 'stopped_short'],
    ['stage_incomplete', { runs: [], line: { outboxId: 'outbox-a' } }, 'stopped_short'],
    ['partial_join', { runs: [clean], line: { outboxId: 'outbox-a', partial: 'one branch lost' } }, 'stopped_short'],
    ['blocked', { runs: [clean], line: { outboxId: 'outbox-a', stop: { code: 'blocked', why: 'reviewer held this work' } } }, 'blocked'],
    ['wrong_line', { runs: [clean], line: { outboxId: 'outbox-a' }, onLine: false }, 'stopped_short'],
    ['stopped', { runs: [clean], line: { outboxId: 'outbox-a' }, stopped: true }, 'stopped'],
    ['station_fault', { runs: [clean], stopCause: 'fault' }, 'stopped'],
    ['station_fault', { runs: [clean], stopCause: 'fault', line: { stop: { code: 'stopped', why: 'stopped' } } }, 'stopped'],
    ['refused', { runs: [], refusedSaid: 'no budget remains' }, 'failed']
  ];
  for (const [code, facts, outcome] of cases) {
    const result = runner.outcomeOf(facts);
    A.eq([result.delivered, result.stop && result.stop.code, result.outcome], [false, code, outcome], code + ': words alone never claim delivery');
    A.ok(!runner.deliverCrate(result, { workitemId: 'not-delivered' }), code + ': never lights OUTBOX');
  }
  const unapproved = runner.outcomeOf({ runs: [clean], line: { outboxId: 'outbox-a', unapproved: 'pass limit reached' } });
  A.eq([unapproved.delivered, unapproved.unapproved], [true, 'pass limit reached'], 'existing LOOP hand-on decision remains delivered and visibly unapproved');

  const missing = runner.open({ line: 'line-a', entry: 'channel', streamId: 'missing-row' });
  runner.track(missing, 'missing-durable-row');
  A.eq(runner.settle(missing, { line: { outboxId: 'outbox-a' } }).stop.code, 'stage_incomplete', 'a tracked run with no durable row is unfinished');
  const retry = runner.open({ line: 'line-a', entry: 'sample', streamId: 'finish-failure' });
  failFinish = true;
  let threw = false;
  try { runner.settle(retry, { runs: [clean], line: { outboxId: 'outbox-a' } }); } catch (_) { threw = true; }
  A.ok(threw && !retry.result && J.get(state, retry.id).status === 'running', 'failed persistence cannot publish a finished result');
  A.ok(!runner.deliverCrate(retry.result, { workitemId: 'retry-crate' }), 'failed finish publishes no OUTBOX crate');
  failFinish = false;
  const retried = runner.settle(retry, { runs: [clean], line: { outboxId: 'outbox-a' } });
  A.ok(retried.delivered, 'a failed finish may retry without losing the live job');
  A.ok(runner.deliverCrate(retried, { workitemId: 'retry-crate' }) && !runner.deliverCrate(runner.settle(retry, {}), { workitemId: 'retry-crate' }), 'successful retry publishes its crate only once');

  let stopped = '';
  const paused = runner.open({ line: 'line-a', entry: 'steptest', streamId: 'paused', stopHandle: cause => { stopped = cause; } });
  runner.mark(paused, 'paused');
  A.eq(J.get(state, paused.id).status, 'paused', 'the step-through test records its wait');
  A.ok(runner.stop(paused.id, 'user') && stopped === 'user', 'job stop targets its own registered handle');
  runner.settle(paused, { stopped: true });
  A.ok(!runner.stop(paused.id), 'settlement releases its stop handle');
  const vm = require('node:vm');
  const commitSource = require('./helpers/source.js').sidecarTopLevelFunction('lineJobsSet');
  const previous = { jobs: [{ id: 'already-saved' }] }, next = { jobs: [{ id: 'not-saved' }] };
  let writeAttempts = 0;
  const host = { lineJobs: previous, lineJobsRefresh: () => previous,
    lineJobsWriteVerified: () => { writeAttempts++; throw new Error('disk full'); }, lineJobsStorageRefusal: () => {}, failNote: () => {}, LineJobs: J,
    change: () => ({ state: next, job: next.jobs[0] }) };
  A.throws(() => vm.runInNewContext(commitSource + '\nlineJobsSet(change, true);', host), 'production host propagates a refused strict finish');
  A.eq(host.lineJobs, previous, 'production host keeps its previous state when a strict write failed');
  A.eq(writeAttempts, 1, 'refusal reaches the actual writer boundary, not a missing lifted dependency');
  await entryIntegration();
  await heldIntegration();
  A.report('line-jobs.invariant.test');
}

async function entryIntegration() {
  const P = require('../frontend/app/pipeline.js');
  const { makeRouter } = require('../sidecar/routing/router.js');
  const { makeChainRunner } = require('../sidecar/routing/chain.js');
  const { makeChannelHub } = require('../sidecar/channels/hub.js');
  const { makeStepTest } = require('../sidecar/routing/steptest.js');
  const floor = { props: [
    { id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research' },
    { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer' },
    { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [1, 2, 3, 5, 6, 8, 9].map(x => ({ x, y: 0, dir: 'E' })) };
  const router = makeRouter(), compiled = P.compileRoutingPlan(floor);
  A.ok(router.setPlan(compiled).ok, 'integration fixture uses a real compiled line');
  const lineId = P.lineOf(compiled, 'research');
  let jobs = { jobs: [] }, seq = 0, time = 500, mode = 'clean', finishCount = 0;
  const rows = new Map(), events = [], calls = [];
  const now = () => ++time, newId = () => String(++seq).padStart(12, '0');
  const save = r => { jobs = r.state; return r.job; };
  const deps = { start: o => save(J.start(jobs, o)), get: id => J.get(jobs, id),
    finish: (id, o) => { finishCount++; return save(J.finish(jobs, id, o)); },
    mark: (id, status) => save(J.mark(jobs, id, status)), all: () => jobs.jobs };
  const runOnce = async o => {
    calls.push(o);
    const incomplete = mode === 'incomplete' && o.agentId === 'writer';
    const row = { runId: o.runId, agentId: o.agentId, dockId: o.dockId, reason: incomplete ? 'max_iters' : 'done',
      outcome: incomplete ? 'step_limit' : 'succeeded', usd: 0.01 };
    rows.set(o.runId, row);
    o.emit('agent.token', { runId: o.runId, delta: o.agentId + ' reply' });
    o.emit('agent.run.end', row);
    return Object.assign({ text: o.agentId + ' reply' }, row);
  };
  const chain = makeChainRunner({ nextAgent: (a, ctx) => router.chainNext(a, ctx), stepAgent: (a, ctx) => router.chainStep(a, ctx),
    stepDock: (d, ctx) => router.chainStepDock(d, ctx), entryDockOf: a => router.entryDockOf(a),
    lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d), now, newId });
  const book = () => makeLineRunner({ runOnce, chain, now, newId, jobs: deps, runRow: id => rows.get(id), emit: (name, payload) => events.push({ name, payload }) });
  let lineRunner = book();
  let streamId = 'integration-chat';
  const turns = new Map();
  const hub = makeChannelHub({ channel: 'dev', ownerSurface: true, bindChats: false, textBatchWaitMs: 0,
    runOnce, lineRunner, now, newId, streamId: () => streamId,
    store: { loadHistory: a => turns.get(a) || [], appendTurn: (a, role, content) => { const arr = turns.get(a) || []; arr.push({ role, content }); turns.set(a, arr); }, getChatRecord: () => null },
    secrets: () => ({ key: 'k', model: 'm' }), resolveEntryRunConfig: () => ({ key: 'k', model: 'm' }), resolveRunConfig: () => ({ key: 'k', model: 'm' }),
    resolveAgent: ctx => router.resolveDock(ctx), lineOriginFor: (a, d) => router.lineOriginFor(a, d), classify: () => true,
    send: async () => ({ ok: true }) });
  for (const scenario of ['clean', 'incomplete', 'no_outbox']) {
    mode = scenario;
    if (scenario === 'no_outbox') {
      const without = JSON.parse(JSON.stringify(floor)); without.belts = without.belts.filter(b => b.x < 8);
      A.ok(router.setPlan(P.compileRoutingPlan(without)).ok, 'dead-end line still compiles');
    }
    let result = null;
    const count = jobs.jobs.length, finished = finishCount;
    await hub.onInbound({ chatId: 'job-chat', chatType: 'dm', userId: 'owner', text: 'research the moon', messageId: scenario },
      { onSettled: s => { result = s.result; } });
    A.eq(jobs.jobs.length - count, 1, scenario + ': real hub opens exactly one job');
    A.eq(finishCount - finished, 1, scenario + ': real hub finishes exactly once');
    A.ok(result && result.delivered === (scenario === 'clean'), scenario + ': intake uses the shared job verdict');
    A.eq(result && result.stop && result.stop.code, scenario === 'clean' ? null : scenario === 'incomplete' ? 'stage_incomplete' : 'no_outbox', scenario + ': typed stop survives the real router/chain/hub');
  }
  hub.close();

  router.setPlan(compiled); mode = 'clean'; streamId = 'step-integration';
  let disk = [];
  const stepStore = { load: () => JSON.parse(JSON.stringify(disk)), save: v => { disk = JSON.parse(JSON.stringify(v)); } };
  const makeStep = () => makeStepTest({ lineRunner, now, newId, newRunId: newId, store: stepStore,
    runDock: lineRunner.hopRunner(lineRunner.profiles.steptest({ config: () => ({ key: 'k', model: 'm' }),
      persona: 'test', brief: () => '', dockSystem: p => p, station: () => null,
      emit: (name, payload) => events.push({ name, payload }) })),
    plan: { get: () => router.getPlan(), step: (a, ctx) => router.chainStep(a, ctx), peek: (a, ctx) => router.chainPeek(a, ctx),
      stepDock: (d, ctx) => router.chainStepDock(d, ctx), peekDock: (d, ctx) => router.chainPeekDock(d, ctx),
      entryDock: (line, text) => router.resolveDock({ lineId: line, text }), lineOf: (a, d) => router.lineOfAgent(a, d),
      shipsToOutbox: (a, d) => router.chainShipsToOutbox(a, d), lineLimits: l => router.lineLimits(l) } });
  let step = makeStep();
  const started = step.start({ line: lineId, text: 'write a moon report', pause: 'every' });
  A.ok(started.ok, 'step integration starts a real line');
  await step.settled(started.session.id);
  let session = step.get(started.session.id).session;
  const jobId = session.jobId;
  const pausedDisk = JSON.parse(JSON.stringify(disk));
  A.eq([session.state, J.get(jobs, jobId).status], ['paused', 'paused'], 'step pause is persisted on the same job');
  jobs = J.boot(jobs, now()).state;
  lineRunner = book(); step = makeStep();   // new process-owned book, persisted session and job records
  session = step.get(session.id).session;
  A.eq([session.jobId, J.get(jobs, jobId).status], [jobId, 'paused'], 'restart reclaims the paused job instead of interrupting it');
  const outBefore = events.filter(e => e.payload.finalQueueId === 'outbox' && e.payload.box === '').length;
  step.continue(session.id, {}); await step.settled(session.id);
  step.continue(session.id, {}); await step.settled(session.id);
  session = step.get(session.id).session;
  A.eq([session.state, session.outcome, J.get(jobs, jobId).outcome], ['done', 'delivered', 'delivered'], 'continued test reaches its actual OUTBOX and settles the original job');
  A.eq(events.filter(e => e.payload.finalQueueId === 'outbox' && e.payload.box === '').length - outBefore, 1, 'step-through emits one OUTBOX crate after restart');
  disk = pausedDisk; lineRunner = book();
  A.notThrows(() => { step = makeStep(); }, 'stale paused session beside an already-finished job cannot prevent boot');
  A.eq([step.get(session.id).session.state, J.get(jobs, jobId).outcome], ['failed', 'delivered'], 'stale session cannot reopen or rewrite its finished job');
  const orphan = lineRunner.open({ line: lineId, entry: 'steptest', streamId: 'lost-session' }); lineRunner.mark(orphan, 'paused');
  lineRunner = book(); step = makeStep();
  A.eq(J.get(jobs, orphan.id).outcome, 'interrupted', 'paused job whose session is gone becomes interrupted at boot');
}

/* A JOB HELD AT A REVIEWER'S GATE (line-hold lane, S3; invariant no-held-row-reads-as-delivered). Every entry still has one job verdict and
   one durable finish — and a job that PARKED for a person has neither a finish nor a delivery: settle says held and not delivered, finishes
   nothing, lights no OUTBOX crate, and says the same on the second call. Through the real router, chain, LineRunner and (for the chat) the
   real channel hub, with the station's own hold proofs compiled out of index.js (test/helpers/line-hold-rig.js). */
async function heldIntegration() {
  const { makeRig } = require('./helpers/line-hold-rig.js');
  const { makeChannelHub } = require('../sidecar/channels/hub.js');
  const crates = rig => rig.events.filter(e => e.n === 'workitem.delivered' && (e.p.finalQueueId === 'outbox' || e.p.box === 'line-output')).length;
  // the six entries that can hold: one verdict, no finish, no crate — and the step-through test, which keeps its own pause, never does
  for (const entry of ['channel', 'schedule', 'manual', 'trigger', 'sendto', 'sample']) {
    const rig = makeRig(), ran = await rig.run({ entry, replies: ['no\nVERDICT: blocked'] });
    const result = rig.settle(ran.job, ran.line);
    A.eq([result.held, result.delivered, result.status, result.outcome, result.stop && result.stop.code], [true, false, 'held', 'blocked', 'blocked'], entry + ': a held job is a held result: not delivered');
    A.eq([rig.counts.finish, crates(rig), rig.shipped.length, rig.record(ran.job.id).status], [0, 0, 0, 'held'], entry + ': no durable finish, no OUTBOX crate, no shipment; the record says held');
    A.ok(rig.settle(ran.job, {}) === result && !rig.runner.deliverCrate(result, { workitemId: 'w' }) && rig.counts.finish === 0, entry + ': a second settle is the same result; no crate can be delivered from it');
    rig.dispose();
  }
  // the real channel hub: the reply says the job is held and where to decide, the job is held, and the hub settles it not delivered
  const rig = makeRig();
  let time = 7000, seq = 7000;
  const now = () => ++time, newId = () => String(++seq).padStart(12, '0');
  const sent = [], settled = [], turns = new Map();
  const runOnce = async o => {
    const reviewer = o.agentId === 'reviewer';
    rig.calls.push(o.agentId);
    const row = { runId: o.runId, streamId: o.streamId, agentId: o.agentId, dockId: o.dockId, reason: 'done', outcome: 'succeeded', usd: 0.02, startedAt: now() };
    rig.rows.set(o.runId, row); o.emit('agent.run.end', row);
    return Object.assign({ text: reviewer ? 'not safe to publish\nVERDICT: blocked' : 'a first draft' }, row);
  };
  const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
  const lineRunner = makeLineRunner({ chain: rig.chain, runOnce, jobs: rig.jobs, runRow: id => rig.rows.get(id), emit: (name, payload) => rig.events.push({ n: name, p: payload }), now, newId,
    hold: { originOf: rig.ports.holdOriginOf, planHash: rig.ports.holdPlanHash, receiptFor: rig.ports.holdFileReceipt, authority: rig.ports.holdAuthority } });
  const hub = makeChannelHub({ channel: 'dev', ownerSurface: true, bindChats: false, textBatchWaitMs: 0, runOnce, lineRunner, now, newId, streamId: () => 'held-chat-stream',
    store: { loadHistory: a => turns.get(a) || [], appendTurn: (a, role, content) => { const arr = turns.get(a) || []; arr.push({ role, content }); turns.set(a, arr); }, getChatRecord: () => null },
    secrets: () => ({ key: 'k', model: 'm' }), resolveEntryRunConfig: () => ({ key: 'k', model: 'm' }), resolveRunConfig: () => ({ key: 'k', model: 'm' }),
    resolveAgent: ctx => rig.router.resolveDock(ctx), lineOriginFor: (a, d) => rig.router.lineOriginFor(a, d), classify: () => true,
    send: async (chatId, text) => { sent.push(text); return { ok: true }; } });
  try {
    await hub.onInbound({ chatId: 'held-chat', chatType: 'dm', userId: 'owner', text: 'write a post', messageId: 'held-1' }, { onSettled: s => settled.push(s) });
    const s = settled[0], result = s && s.result, rec = result && rig.record(result.jobId);
    A.ok(result && result.held === true && result.delivered === false && s.ok === false, 'the hub settles a held job as not delivered (its intake hears ok=false)');
    A.eq([rec && rec.status, rec && rec.endedAt, rig.counts.finish, crates(rig), rig.shipped.length], ['held', null, 0, 0, 0], 'the hub: the job is held, never finished, nothing delivered');
    A.ok(sent.length === 1 && /paused/.test(sent[0]) && /WORKFLOWS/.test(sent[0]) && sent[0].includes(result.jobId), 'the chat is told the job is held and where to decide: ' + String(sent[0]).slice(-200));
    const c = rec && rec.continuation;
    A.eq(c && c.origin, { kind: 'channel', instanceId: 'dev', chatId: 'held-chat', senderId: 'owner', chatType: 'dm', threadId: null, boundAgentId: null }, 'the hold names the chat it came from');
    A.eq(c && [c.attempts.length === 2, Math.abs(c.accounting.entryUsd - 0.02) < 1e-9, c.accounting.dayReceipts.length, c.restriction.entryUntrusted, c.restriction.taints], [true, true, 0, false, []], 'the hub\'s entry run is the saved entry attempt; a trusted owner chat carries no taint');
    // a FORWARDED message is a third party's words: the same walk is saved under the same taint the entry run started under
    await hub.onInbound({ chatId: 'held-chat-2', chatType: 'dm', userId: 'owner', text: 'summarise this', messageId: 'held-2', forwarded: true }, { onSettled: x => settled.push(x) });
    const f = settled[1] && settled[1].result, fc = f && rig.record(f.jobId).continuation;
    A.eq(fc && [fc.restriction.entryUntrusted, fc.restriction.taints, fc.walk.product.taints], [true, ['forwarded message'], ['forwarded message']], 'a forwarded message is held under its entry taint, untrusted');
  } finally { hub.close(); rig.dispose(); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
