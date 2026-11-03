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
  } finally { for (const hub of hubs) hub.close(); }
})().catch(e => A.ok(false, String(e && e.stack || e))).finally(() => A.report('line-job-publication.test'));

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
