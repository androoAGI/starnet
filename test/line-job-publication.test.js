/* A durable LineJob finish is the publication barrier: real chain, job book/store, SEND TO runner and target hub.
   Only model transport and the failing persistence edge are injected. No source shape stands in for publication evidence. */
'use strict';
const A = require('./_assert.js');
const P = require('../frontend/app/pipeline.js');
const J = require('../sidecar/routing/linejobs.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const { makeHandoffRunner } = require('../sidecar/routing/handoff-runner.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');

(async () => {
  const floor = { props: [], belts: [] };
  for (const [i, agentId] of ['source', 'receiver'].entries()) {
    floor.props.push({ id: 'i' + i, t: 'intake', x: 0, y: i * 4, w: 1, h: 1 },
      { id: 'b' + i, t: 'bay', x: 4, y: i * 4, w: 1, h: 1, agentId },
      { id: 'o' + i, t: 'outbox', x: 7, y: i * 4, w: 1, h: 1, ...(i === 0 ? { sendTo: 'i1' } : {}) });
    floor.belts.push(...[1, 2, 3, 5, 6].map(x => ({ x, y: i * 4, dir: 'E' })));
  }
  const plan = P.compileRoutingPlan(floor), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'the real two-line SEND TO floor compiles');
  const sourceLine = P.lineOf(plan, 'source');
  let state = { jobs: [] }, seq = 0, clock = 10, refusedId = '', handoff, throwShip = false;
  const rows = new Map(), events = [], publications = [], calls = [], finishes = [], hubs = [];
  const now = () => ++clock, newId = () => (++seq).toString(16).padStart(12, '0');
  const store = r => { state = r.state; return r.job; };
  const jobs = { start: o => store(J.start(state, o)), get: id => J.get(state, id),
    finish: (id, o) => { if (id === refusedId) throw new Error('injected durable finish refusal'); finishes.push(id); return store(J.finish(state, id, o)); },
    mark: (id, status) => store(J.mark(state, id, status)), all: () => state.jobs,
    link: (id, to) => store(J.link(state, id, to)) };
  const emit = (name, payload) => events.push({ name, payload });
  const runOnce = async o => {
    calls.push({ agentId: o.agentId, runId: o.runId });
    const row = { runId: o.runId, streamId: o.streamId, agentId: o.agentId, dockId: o.dockId,
      reason: 'done', outcome: 'succeeded', startedAt: now(), usd: 0.01 };
    rows.set(o.runId, row); o.emit('agent.run.end', row);
    return { ...row, text: 'the receiver finished its work' };
  };
  const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
    entryDockOf: a => router.entryDockOf(a), lineOfAgent: (a, d) => router.lineOfAgent(a, d),
    lastStage: (a, d) => router.chainShipsToOutbox(a, d), emit, now, newId,
    onShipped: rec => {
      if (rec.lineId === sourceLine) {
        publications.push({ rec, status: (jobs.get(rec.jobId) || {}).status });
        if (throwShip) throw new Error('injected shipment callback error after persistence');
      }
      return handoff.onShipped(rec);
    } });
  const runner = makeLineRunner({ chain, runOnce, jobs, runRow: id => rows.get(id), emit, now, newId });
  const config = () => ({ key: 'fixture', model: 'fixture' });
  handoff = makeHandoffRunner({ plan: () => plan, lineRunner: runner, jobs,
    runsFor: stream => [...rows.values()].filter(r => r.streamId === stream), emit, now, newId,
    makeHub: hooks => {
      const turns = new Map();
      const hub = makeChannelHub({ ...hooks, channel: 'sendto', ownerSurface: true, bindChats: false, textBatchWaitMs: 0,
        runOnce, lineRunner: runner, now, newId, store: { loadHistory: a => turns.get(a) || [],
          appendTurn: (a, role, content) => { const v = turns.get(a) || []; v.push({ role, content }); turns.set(a, v); return v; }, getChatRecord: () => null },
        secrets: config, resolveEntryRunConfig: config, resolveRunConfig: config, classify: () => true,
        resolveAgent: c => hooks.onRouted(router.resolveDock({ ...c, lineId: hooks.lineId() })),
        lineOriginFor: (a, d) => router.lineOriginFor(a, d), send: async (id, text) => { hooks.send(text); return { ok: true }; } });
      hubs.push(hub); return hub;
    } });
  const drain = async () => {
    for (let i = 0; i < 200 && handoff.status().lines.some(l => l.running || l.queued); i++) await new Promise(r => setTimeout(r, 5));
    A.ok(!handoff.status().lines.some(l => l.running || l.queued), 'the actual handoff queue settled');
  };
  const outputs = () => events.filter(e => e.name === 'workitem.delivered' && e.payload.box === 'line-output' && e.payload.lineId === sourceLine).length;
  const start = async label => {
    const streamId = 'source-' + label, runId = 'run-' + label;
    rows.set(runId, { runId, streamId, agentId: 'source', dockId: 'b0', reason: 'done', outcome: 'succeeded', startedAt: now(), usd: 0.01 });
    const job = runner.open({ line: sourceLine, entry: 'sample', text: 'make the report', streamId });
    const line = await runner.runLineJob({ job, seed: { agentId: 'source', dockId: 'b0', lineId: sourceLine,
      runId, streamId, since: rows.get(runId).startedAt, text: 'finished source work', originalText: 'make the report' } });
    return { job, line };
  };
  try {
    const first = await start('retry');
    await drain();
    A.eq([outputs(), publications.length, calls.length], [0, 0, 0], 'the walk alone publishes no authority, shipment or paid SEND TO');
    refusedId = first.job.id;
    let refused = false;
    try { runner.settle(first.job, { line: first.line, output: first.line.text }); } catch (_) { refused = true; }
    A.ok(refused && jobs.get(first.job.id).status === 'running', 'failed durable finish leaves the job live');
    runner.deliverCrate(first.job.result, { workitemId: 'source-crate', agentId: 'source' });
    await drain();
    A.eq([outputs(), publications.length, calls.length], [0, 0, 0], 'failed finish publishes no line-output, onShipped or SEND TO');
    A.eq(events.filter(e => e.name === 'workitem.delivered' && e.payload.workitemId === 'source-crate').length, 0, 'failed finish publishes no final crate');
    refusedId = '';
    const result = runner.settle(first.job, { line: first.line, output: first.line.text });
    runner.deliverCrate(result, { workitemId: 'source-crate', agentId: 'source' });
    runner.deliverCrate(runner.settle(first.job, {}), { workitemId: 'source-crate', agentId: 'source' });
    await drain();
    A.eq([outputs(), publications.length, calls.length], [1, 1, 1], 'finish retry releases authority and real SEND TO exactly once');
    A.eq(publications[0] && publications[0].status, 'delivered', 'shipment observes the already durable terminal job');
    A.eq(finishes.filter(id => id === first.job.id).length, 1, 'retry commits the source once without running its model again');
    A.eq(events.filter(e => e.name === 'workitem.delivered' && e.payload.workitemId === 'source-crate').length, 1, 'the retry delivers one final crate');

    for (const cause of ['stop', 'fault']) {
      const before = [outputs(), publications.length, calls.length];
      const next = await start(cause);
      const ended = runner.settle(next.job, { line: next.line, ...(cause === 'fault' ? { stopCause: 'fault' } : { stopped: true }) });
      await drain();
      A.eq(ended.stop.code, cause === 'fault' ? 'station_fault' : 'stopped', cause + ': the final verdict wins over the earlier completed walk');
      A.eq([outputs(), publications.length, calls.length], before, cause + ': no terminal authority or SEND TO escapes after later stop/fault');
    }

    const before = [outputs(), publications.length, calls.length];
    throwShip = true;
    const last = await start('callback');
    const settled = runner.settle(last.job, { line: last.line });
    runner.settle(last.job, {});
    A.eq(settled.status, 'delivered', 'a post-persist callback error cannot undo the durable result');
    A.eq(publications[publications.length - 1].status, 'delivered', 'even the throwing callback starts only after persistence');
    A.eq([outputs(), publications.length, calls.length], [before[0] + 1, before[1] + 1, before[2]], 'callback error is not retried into duplicate authority or paid work');
    await partialNotice();
    await heldNotice();
  } finally { for (const hub of hubs) hub.close(); }
})().catch(e => A.ok(false, String(e && e.stack || e))).finally(() => A.report('line-job-publication.test'));

/* A JOB PARKED AT A REVIEWER'S GATE PUBLISHES NOTHING (line-hold lane, S3; invariant no-held-row-reads-as-delivered). The line-output
   authority, the shipment receipt and the paid SEND TO belong to a job's durable END; a held job has not ended. Real router, chain, LineRunner,
   SEND TO runner and target hub, the station's own hold proofs (test/helpers/line-hold-rig.js); only the model is injected. The same line with a
   reviewer that APPROVES is the control: it ships and the receiver runs exactly once, so a held job's zero is not a floor that cannot send. */
async function heldNotice() {
  const { geometry, hostPorts } = require('./helpers/line-hold-rig.js');
  const g = geometry();
  g.props.find(p => p.id === 'p6').sendTo = 'i2';   // the review line's OUTBOX hands its finished work to a second line
  g.props.push({ id: 'i2', t: 'intake', x: 0, y: 12, w: 1, h: 1 }, { id: 'b2', t: 'bay', x: 4, y: 12, w: 1, h: 1, agentId: 'receiver' }, { id: 'o2', t: 'outbox', x: 7, y: 12, w: 1, h: 1 });
  g.belts.push(...[1, 2, 3, 5, 6].map(x => ({ x, y: 12, dir: 'E' })));
  const plan = P.compileRoutingPlan(g), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'held fixture: the two-line floor (a review line that sends on) compiles');
  const lineId = router.lineOriginFor('drafter', 'p2');
  let state = { jobs: [] }, seq = 0, clock = 10, handoff, verdictOf = 'blocked';
  const rows = new Map(), events = [], calls = [], shipped = [], finishes = [], hubs = [];
  const now = () => ++clock, newId = () => (++seq).toString(16).padStart(12, '0');
  const store = r => { state = r.state; return r.job; };
  const jobs = { start: o => store(J.start(state, o)), get: id => J.get(state, id), finish: (id, o) => { finishes.push(id); return store(J.finish(state, id, o)); },
    mark: (id, s) => store(J.mark(state, id, s)), all: () => state.jobs, link: (id, to) => store(J.link(state, id, to)),
    hold: (id, rev, c) => store(J.checkpoint(state, id, rev, c)) };
  const emit = (name, payload) => events.push({ name, payload });
  const ports = hostPorts({ router, nightshift: { isHalted: () => false } });
  const runOnce = async o => {
    calls.push(o.agentId);
    const row = { runId: o.runId, streamId: o.streamId, agentId: o.agentId, dockId: o.dockId, reason: 'done', outcome: 'succeeded', startedAt: now(), usd: 0.01 };
    rows.set(o.runId, row); o.emit('agent.run.end', row);
    return { ...row, text: o.agentId === 'reviewer' ? 'the review\nVERDICT: ' + verdictOf : o.agentId === 'receiver' ? 'the receiver finished its work' : 'another draft' };
  };
  const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c), entryDockOf: a => router.entryDockOf(a),
    fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d),
    loopGateAfter: (a, l, d) => router.loopGateAfter(a, l, d), getTag: () => 'general', emit, now, newId,
    onShipped: rec => { if (rec.lineId === lineId) shipped.push(rec); return handoff.onShipped(rec); } });
  const runner = makeLineRunner({ chain, runOnce, jobs, runRow: id => rows.get(id), emit, now, newId,
    hold: { originOf: ports.holdOriginOf, planHash: ports.holdPlanHash, receiptFor: ports.holdFileReceipt, authority: ports.holdAuthority } });
  const config = () => ({ key: 'fixture', model: 'fixture' });
  handoff = makeHandoffRunner({ plan: () => plan, lineRunner: runner, jobs,
    runsFor: stream => [...rows.values()].filter(r => r.streamId === stream), emit, now, newId,
    makeHub: hooks => {
      const turns = new Map();
      const hub = makeChannelHub({ ...hooks, channel: 'sendto', ownerSurface: true, bindChats: false, textBatchWaitMs: 0, runOnce, lineRunner: runner, now, newId,
        store: { loadHistory: a => turns.get(a) || [], appendTurn: (a, role, content) => { const v = turns.get(a) || []; v.push({ role, content }); turns.set(a, v); return v; }, getChatRecord: () => null },
        secrets: config, resolveEntryRunConfig: config, resolveRunConfig: config, classify: () => true,
        resolveAgent: c => hooks.onRouted(router.resolveDock({ ...c, lineId: hooks.lineId() })),
        lineOriginFor: (a, d) => router.lineOriginFor(a, d), send: async (id, text) => { hooks.send(text); return { ok: true }; } });
      hubs.push(hub); return hub;
    } });
  const drain = async () => {
    for (let i = 0; i < 200 && handoff.status().lines.some(l => l.running || l.queued); i++) await new Promise(r => setTimeout(r, 5));
    A.ok(!handoff.status().lines.some(l => l.running || l.queued), 'held fixture: the SEND TO queue settled');
  };
  const outputs = () => events.filter(e => e.name === 'workitem.delivered' && e.payload.box === 'line-output' && e.payload.lineId === lineId).length;
  const send = async label => {   // the review line's job: the reviewer is its entry dock, as the hub's entry run is
    const streamId = 'review-' + label, runId = 'run-' + label;
    rows.set(runId, { runId, streamId, agentId: 'reviewer', dockId: 'p3', reason: 'done', outcome: 'succeeded', startedAt: now(), usd: 0.02 });
    const job = runner.open({ line: lineId, entry: 'sample', text: 'write a post', streamId });
    const line = await runner.runLineJob({ job, seed: { agentId: 'reviewer', dockId: 'p3', lineId, runId, streamId, since: rows.get(runId).startedAt, entryUsd: 0.02,
      text: 'the review\nVERDICT: ' + verdictOf, originalText: 'write a post', origin: {}, taints: [] }, profile: runner.profiles.channel({}) });
    return { job, line };
  };
  try {
    const held = await send('held');
    const result = runner.settle(held.job, { line: held.line, output: held.line.text });
    runner.deliverCrate(result, { workitemId: 'review-crate', agentId: 'reviewer' });
    runner.settle(held.job, {});
    await drain();
    A.eq([result.held, result.delivered, J.get(state, held.job.id).status, finishes.length], [true, false, 'held', 0], 'held: the source job is held, never finished');
    A.eq([outputs(), shipped.length, calls.filter(a => a === 'receiver').length, events.filter(e => e.name === 'workitem.delivered' && e.payload.workitemId === 'review-crate').length], [0, 0, 0, 0],
      'held: no line-output authority, no shipment callback, no paid SEND TO, no final crate');
    // the control: the same line, a reviewer that approves, ships and sends on once
    verdictOf = 'approved';
    const approved = await send('approved');
    const done = runner.settle(approved.job, { line: approved.line, output: approved.line.text });
    runner.settle(approved.job, {});
    await drain();
    A.eq([done.delivered, done.held, J.get(state, approved.job.id).status], [true, undefined, 'delivered'], 'control: the approving reviewer\'s job is delivered');
    A.eq([outputs(), shipped.length, calls.filter(a => a === 'receiver').length, finishes.length], [1, 1, 1, 2], 'control: it publishes its authority, ships and runs the receiver exactly once, each of the two jobs finishing once (so the held zero is not a line that cannot send)');
  } finally { for (const hub of hubs) hub.close(); }
}

async function partialNotice() {
  const world = require('../frontend/app/worldmodel.js').create();
  A.ok(world.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 14 } }).ok, 'partial fixture room');
  A.ok(world.stampBlueprint('second_opinion', 32, 2).ok, 'partial fixture uses the real JOINER blueprint');
  world.props().filter(p => p.t === 'bay').forEach((b, i) => world.assignPropAgent(b.id, 'crew' + i));
  const plan = P.compileRoutingPlan(world.projectGeometry()), router = makeRouter();
  A.ok(router.setPlan(plan).ok, 'partial fixture compiles');
  const entry = router.resolveDock({ tag: 'general' }), lineId = router.lineOriginFor(entry.agentId, entry.dockId);
  let state = { jobs: [] }, seq = 0, refuses = true, hop = 0;
  const rows = new Map(), events = [], notices = [];
  const store = r => { state = r.state; return r.job; };
  const chain = makeChainRunner({ nextAgent: (a, c) => router.chainNext(a, c), stepDock: (d, c) => router.chainStepDock(d, c),
    peekDock: (d, c) => router.chainPeekDock(d, c), entryDockOf: a => router.entryDockOf(a),
    fanSiblingsDock: d => router.fanSiblingsDock(d), lineOfAgent: (a, d) => router.lineOfAgent(a, d), lastStage: (a, d) => router.chainShipsToOutbox(a, d),
    cleanJob: () => false, onShipped: rec => notices.push({ rec, status: (J.get(state, rec.jobId) || {}).status }),
    emit: (name, payload) => events.push({ name, payload }), setTimer: fn => { fn(); return 0; } });
  const runner = makeLineRunner({ chain, now: () => 100, newId: () => (++seq).toString(16).padStart(12, '0'),
    runRow: id => rows.get(id), jobs: { start: o => store(J.start(state, o)), get: id => J.get(state, id),
      finish: (id, o) => { if (refuses) throw new Error('partial finish refused'); return store(J.finish(state, id, o)); } },
    runOnce: async o => {
      const failed = ++hop === 1;
      const row = { runId: o.runId, agentId: o.agentId, dockId: o.dockId, reason: failed ? 'error' : 'done', outcome: failed ? 'failed' : 'succeeded' };
      rows.set(o.runId, row); o.emit('agent.run.end', row);
      return { ...row, text: failed ? '' : 'joined surviving evidence' };
    } });
  rows.set('entry', { runId: 'entry', agentId: entry.agentId, dockId: entry.dockId, reason: 'done', outcome: 'succeeded' });
  const job = runner.open({ line: lineId, entry: 'sample', streamId: 'partial' });
  const line = await runner.runLineJob({ job, seed: { ...entry, lineId, runId: 'entry', streamId: 'partial', text: 'entry evidence', originalText: 'compare evidence' } });
  A.ok(!!line.partial, 'a real failed COPY branch produces a marked partial JOIN');
  try { runner.settle(job, { line }); } catch (_) { /* intentional I/O refusal */ }
  A.eq(notices.length, 0, 'even the partial refusal notice waits for a durable finish');
  refuses = false;
  const result = runner.settle(job, { line });
  runner.settle(job, {});
  A.eq([result.outcome, result.stop.code], ['stopped_short', 'partial_join'], 'partial work remains unfinished');
  A.ok(notices.length === 1 && notices[0].rec.partial === line.partial && notices[0].status === 'problem', 'the established partial shipment refusal notice survives once after persistence');
  A.eq(events.filter(e => e.name === 'workitem.delivered' && e.payload.box === 'line-output').length, 0, 'partial work never gains terminal OUTBOX authority');
}
