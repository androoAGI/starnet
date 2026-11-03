'use strict';
// Actual admission owner, hub, chain, job book and filesystem: terminal storage failure never abandons a job.
const A = require('./_assert.js');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const J = require('../sidecar/routing/linejobs.js');
const { makeDomainStore } = require('../sidecar/domain-store.js');
const { writeFileDurable } = require('../sidecar/durable-write.js');
const { makeLineRunner } = require('../sidecar/routing/line-runner.js');
const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
const { makeChannelHub } = require('../sidecar/channels/hub.js');
const { makeChainRunner } = require('../sidecar/routing/chain.js');
const { makeRouter } = require('../sidecar/routing/router.js');
const P = require('../frontend/app/pipeline.js');
const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(dir) {
  let state = { jobs: [] }, triggers = { triggers: [] }, seq = 0, time = 1000, failTerminal = false, failRate = false, hub;
  const calls = [], events = [], rows = new Map(), warnings = [], depths = new Map();
  const now = () => ++time, newId = () => String(++seq).padStart(12, '0');
  const store = makeDomainStore({ fs, path, file: path.join(dir, 'line-jobs.json'), version: 1,
    defaults: () => ({ jobs: [] }), normalize: J.normalizeAll, encode: value => ({ jobs: value.jobs }),
    decode: value => value && Array.isArray(value.jobs) ? { jobs: value.jobs } : undefined,
    writeDurable: (deps, file, text) => {
      if (failTerminal && (JSON.parse(text).jobs || []).some(job => !['running', 'paused'].includes(job.status))) {
        throw Object.assign(new Error('fixture terminal job write refusal'), { code: 'EIO' });
      }
      return writeFileDurable(deps, file, text);
    }
  });
  const save = result => { store.save(result.state); state = result.state; return result.job; };
  const router = makeRouter(), plan = P.compileRoutingPlan({ props: [
    { id: 'in', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
    { id: 'writer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer' },
    { id: 'out', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
  ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) });
  if (!router.setPlan(plan).ok) throw new Error('fixture line did not compile');
  const runOnce = async options => {
    calls.push(options);
    const row = { runId: options.runId, agentId: options.agentId, dockId: options.dockId, streamId: options.streamId,
      reason: 'done', outcome: 'succeeded', usd: 0.1 };
    rows.set(row.runId, row);
    options.emit('agent.token', { runId: row.runId, delta: 'Completed the requested work.' });
    options.emit('agent.run.end', row);
    return Object.assign({ text: 'Completed the requested work.' }, row);
  };
  const emit = (name, payload) => events.push({ name, payload });
  const chain = makeChainRunner({ nextAgent: (agent, ctx) => router.chainNext(agent, ctx), stepAgent: (agent, ctx) => router.chainStep(agent, ctx),
    stepDock: (dock, ctx) => router.chainStepDock(dock, ctx), entryDockOf: agent => router.entryDockOf(agent),
    lineOfAgent: (agent, dock) => router.lineOfAgent(agent, dock), lastStage: (agent, dock) => router.chainShipsToOutbox(agent, dock), now, newId });
  const book = makeLineRunner({ runOnce, chain, now, newId, emit, runRow: id => rows.get(id), jobs: {
    get: id => J.get(state, id), start: options => save(J.start(state, options)), finish: (id, result) => save(J.finish(state, id, result)) } });
  const runner = makeTriggerRunner({ load: () => triggers, save: value => {
    if (failRate) throw new Error('fixture rate record write refusal');
    triggers = value;
  }, now, newId, emit, lineRunner: book, plan: () => plan, warn: message => warnings.push(message),
  bumpQueue: (agent, delta) => { const value = (depths.get(agent) || 0) + delta; depths.set(agent, value); return value; },
  runsFor: stream => [...rows.values()].filter(row => row.streamId === stream),
  makeHub: hooks => {
    const turns = new Map();
    hub = makeChannelHub({ channel: 'trigger', ownerSurface: true, bindChats: false, textBatchWaitMs: 0,
      now, newId, runOnce, lineRunner: book, streamId: hooks.streamId, jobId: hooks.jobId, jobEntry: 'trigger',
      onJobSettled: hooks.onJobSettled, onResolved: hooks.onResolved, onLineOutcome: hooks.onLineOutcome,
      store: { loadHistory: agent => turns.get(agent) || [], appendTurn: (agent, role, content) => {
        const list = turns.get(agent) || []; list.push({ role, content }); turns.set(agent, list);
      }, getChatRecord: () => null },
      secrets: () => ({ key: 'synthetic', model: 'fixture' }),
      resolveEntryRunConfig: () => ({ key: 'synthetic', model: 'fixture' }), resolveRunConfig: () => ({ key: 'synthetic', model: 'fixture' }),
      resolveAgent: ctx => hooks.onRouted(router.resolveDock(ctx)), lineOriginFor: (agent, dock) => router.lineOriginFor(agent, dock),
      classify: () => true, emit, send: async (_chat, text) => { hooks.send(text); return { ok: true }; }
    });
    return hub;
  } });
  const trigger = runner.create({ kind: 'webhook', lineId: plan.lines[0].lineId, maxPerHour: 60 }).trigger.id;
  return { book, runner, trigger, calls, events, warnings, state: () => state, disk: () => store.load().value,
    fail: (terminal, rate) => { failTerminal = terminal; failRate = !!rate; },
    depth: () => depths.get('writer') || 0, hub: () => hub, close: () => { if (hub) hub.close(); } };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'line-hook-orphans-'));
  try {
    {
      const f = fixture(path.join(root, 'admission')), id = 'job-admission001';
      try {
        f.fail(true, true);
        A.throws(() => f.runner.enqueue(f.trigger, { jobId: id, text: 'Perform this job' }), 'rate write plus refusal finish failures reach admission caller');
        A.eq(J.get(f.disk(), id).status, 'running', 'strict job start landed before the two later failures');
        A.eq(f.calls.length, 0, 'failed admission never starts a provider call');
        A.eq(f.runner.view(f.trigger).queued, 1, 'unconfirmed refusal still occupies an owned queue slot');
        f.fail(false);
        A.eq(f.book.stop(id, 'user'), true, 'the exact admitted job remains cancellable');
        A.eq(J.get(f.disk(), id).outcome, 'stopped', 'recovered storage proves admission-orphan cancellation');
        A.eq(f.book.get(id), null, 'durable cancellation releases admission owner');
        A.eq(f.calls.length, 0, 'retry never executes the refused admission');
      } finally { f.close(); }
    }
    for (const cause of ['user', 'fault']) {
      const f = fixture(path.join(root, cause)), id = 'job-terminal0001';
      try {
        f.fail(true);
        A.ok(f.runner.enqueue(f.trigger, { jobId: id, text: 'Write the requested answer.' }).ok, 'actual hub job is admitted before terminal fault');
        for (let i = 0; i < 100; i++) await turn();
        A.eq(f.calls.length, 1, 'actual hub and chain made one completed run');
        A.eq(f.hub()._internals.inflight.size, 0, 'the paid run unwound its actual hub owner');
        A.eq(J.get(f.disk(), id).status, 'running', 'unconfirmed terminal state remains honest on disk');
        A.eq(f.runner.view(f.trigger).queued, 1, 'unconfirmed terminal state still occupies exact queued capacity');
        A.eq(f.depth(), 1, 'the floor retains unfinished terminal ownership');
        A.eq(f.events.filter(event => event.name === 'workitem.delivered').length, 0, 'failed terminal storage publishes no delivered crate');
        A.throws(() => f.book.stop(id, cause), 'a stop retries the exact pending terminal write and reports its failure');
        f.fail(false);
        A.eq(f.book.stop(id, cause), true, 'the exact completed run retains a terminal retry owner');
        const stopped = J.get(f.disk(), id);
        A.eq([stopped.outcome, stopped.stop && stopped.stop.code], ['stopped', cause === 'fault' ? 'station_fault' : 'stopped'], 'durable retry preserves owned STOP/fault authority');
        A.eq([stopped.runs.length, stopped.usd], [1, 0.1], 'terminal retry retains the actual paid row and spend');
        A.eq(f.book.get(id), null, 'durable terminal retry releases the private job owner');
        A.eq(f.depth(), 0, 'durable terminal retry releases the floor exactly once');
        A.eq([f.runner.view(f.trigger).lastOutcome.jobId, f.runner.view(f.trigger).lastOutcome.outcome], [id, 'stopped'], 'trigger readback belongs to the exact settled job');
        A.eq(f.calls.length, 1, 'terminal retry never reruns paid work');
        A.eq(f.events.filter(event => event.name === 'workitem.delivered').length, 0, 'late STOP/fault never publishes the earlier successful walk');
      } finally { f.close(); }
    }
    {
      const f = fixture(path.join(root, 'resume')), held = 'job-held00000001', next = 'job-next00000001';
      try {
        f.fail(true);
        A.ok(f.runner.enqueue(f.trigger, { jobId: held, text: 'First job.' }).ok, 'first job starts before terminal storage refuses');
        for (let i = 0; i < 100; i++) await turn();
        A.ok(f.runner.enqueue(f.trigger, { jobId: next, text: 'Second job.' }).ok, 'following delivery has its own durable admission');
        for (let i = 0; i < 10; i++) await turn();
        A.eq([f.calls.length, f.runner.view(f.trigger).queued], [1, 2], 'held terminal owner blocks the following job without losing either identity');
        f.fail(false);
        A.eq(f.book.stop(held, 'user'), true, 'recovered stop settles only the held terminal owner');
        for (let i = 0; i < 100; i++) await turn();
        A.eq([f.calls.length, f.runner.view(f.trigger).queued, f.depth()], [2, 0, 0], 'next owner resumes once and both floor entries settle');
        A.eq([J.get(f.disk(), held).outcome, J.get(f.disk(), next).outcome], ['stopped', 'delivered'], 'resumption cannot replace the stopped job receipt');
        A.eq(f.runner.view(f.trigger).lastOutcome.jobId, next, 'trigger readback advances to the actual following job');
        A.eq(f.book.stop(held, 'user'), false, 'repeated cancellation cannot replay terminal projection');
        A.eq(f.events.filter(event => event.name === 'workitem.delivered').length, 1, 'only the following confirmed job publishes a delivered crate');
      } finally { f.close(); }
    }
  } finally {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('line-hook-orphans-')) throw new Error('unexpected fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
  A.report('line-hook-orphans');
})().catch(error => { console.error(error); process.exitCode = 1; });
