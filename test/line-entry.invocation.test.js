'use strict';
/* Real canonical LineJobs/domain stores + actual host admission/cleanup wrappers.
   Core terminal facts here are injected unit evidence, not a real provider proof. */
const A = require('./_assert.js'), vm = require('node:vm');
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), crypto = require('node:crypto');
const C = require('../sidecar/routing/line-continuation.js');
function invocationOwner() {
  const file = require.resolve('../sidecar/routing/line-entry-invocation.js');
  if (!process.env.LINE_ENTRY_INVOCATION_CONTROL) return require(file);
  const source = fs.readFileSync(process.env.LINE_ENTRY_INVOCATION_CONTROL, 'utf8');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  console.log('CONTROL_SOURCE LINE_ENTRY_INVOCATION_CONTROL SHA256=' + hash);
  if (hash !== String(process.env.LINE_ENTRY_INVOCATION_CONTROL_SHA256 || '').toLowerCase()) throw new Error('entry invocation control hash mismatch');
  const old = new Module(file, module); old.filename = file; old.paths = Module._nodeModulePaths(path.dirname(file));
  old._compile(source, file); return old.exports;
}
const { makeEntryInvocation } = invocationOwner();
const RunTable = require('../sidecar/run-table.js'), RunOutcome = require('../frontend/app/runoutcome.js');
const { allocated, J } = require('./helpers/line-accounting-host.js');
const { fixture, clone } = require('./helpers/line-entry.js');
const { sidecarTopLevelFunction } = require('./helpers/source.js');
const hostCode = ['runOnce', 'settleRun', 'runOnceEntryCore'].map(sidecarTopLevelFunction).join('\n');
function setup(env, tune) {
  const data = fixture();
  env.host.mutate(s => J.start(s, Object.assign({}, data.job, { at: 100 })));
  data.receipt.ledgerId = env.host.enroll().ledgerId;
  const b = data.receipt.binding, options = { runId: b.entryRunId, workitemId: b.workitemId, agentId: b.entryNode.agentId,
    dockId: b.entryNode.dockId, lineId: b.lineId, streamId: b.streamId, messages: [{ role: 'user', content: data.receipt.input.text }], emit() {} };
  const facts = { runId: options.runId, workitemId: options.workitemId, agentId: options.agentId, dockId: options.dockId,
    lineId: options.lineId, streamId: options.streamId, endedAt: 110, usd: 0.125, usageMissing: false, unpriced: false,
    outcome: 'succeeded', text: 'accepted terminal\nVERDICT: BLOCKED', artifacts: [], taint: 'upstream content' };
  const state = { calls: 0, entered: [], authority: true, beforeCore: null, terminal: facts, coreError: null, afterObserve: 0 };
  const table = RunTable.makeRunTable({ now: () => 105, note() {} });
  let inv, host;
  const d = { prepare: env.host.prepare, checkpoint: env.host.checkpoint,
    authority: async ({ phase, receipt }) => {
      state.entered.push(phase);
      // The private test authority reads the actual seeded job and enrollment;
      // it is not a saved-floor implementation or an account verification claim.
      const jobs = env.raw(env.jobFile), ledger = env.raw(env.spendFile);
      return state.authority && jobs.jobs.some(j => j.id === receipt.binding.jobId && j.line === receipt.binding.lineId)
        && jobs.continuationAccounting.ledgerId === ledger.continuationAccounting.ledgerId;
    }, run: o => host(o) };
  if (tune) tune({ data, options, facts, state, d });
  inv = makeEntryInvocation(d);
  const core = async o => {
    state.calls++;
    A.eq(env.raw(env.jobFile).jobs[0].entryAdmission.state, 'intent', 'actual core entry follows a durably readable intent');
    A.ok(o.ceilingUsd <= data.receipt.limits.maxUsd, 'actual run option retains the original dollar ceiling');
    if (state.beforeCore) await state.beforeCore(o, inv);
    if (state.coreError) inv.noteError(o, state.coreError);
    inv.observe(o, state.terminal);
    state.afterObserve++;
    if (state.coreError) throw state.coreError;
    return { reason: 'done', text: facts.text };
  };
  const build = vm.compileFunction(hostCode + '\nfunction runOnceQueued(o, run) { return runOnceEntryCore(o, run); }\nreturn runOnce;',
    ['runTable', 'RunTable', 'RunOutcome', 'endedOutcomes', 'lineEntryInvocations', 'runOnceTrackedBelt']);
  host = build(table, RunTable, RunOutcome, new Map(), inv, core);
  return { data, options, facts, state, table, inv, execute: () => inv.execute(data.job.id, data.receipt, options) };
}
async function failure(fn) { try { await fn(); return null; } catch (error) { return error; } }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
(async () => {
  await allocated(async env => {
    const f = setup(env), out = await f.execute();
    A.eq([out.invoked, out.confirmed, out.receipt.state, out.usageStatus], [true, true, 'observed', 'observed'], 'one genuine invocation returns exact saved observation');
    A.eq(out.receipt.observation.product.text, f.facts.text, 'full terminal text remains byte-exact');
    A.eq(out.receipt.observation.product.verdict, 'blocked', 'shared parser records BLOCKED without starting a walker');
    A.ok(out.receipt.observation.product.taints.includes('webhook payload') && out.receipt.observation.product.taints.includes('upstream content'), 'negative source and actual execution taint both survive');
    A.eq(env.raw(env.spendFile).lines['line-a'].usd, 5, 'private observation buys no ledger booking');
    const replay = await f.execute();
    A.eq([replay.invoked, replay.receipt, f.state.calls, f.table.size()], [false, out.receipt, 1, 0], 'replayed prepare never dispatches; actual RunTable cleanup balances');
  });
  for (const mode of ['before', 'after']) await allocated(async env => {
    const f = setup(env); env.f[mode] = env.jobFile;
    A.ok(await failure(f.execute), mode + ': failed intent acknowledgement refuses invocation');
    A.eq(f.state.calls, 0, mode + ': no core work before verified intent');
    env.f.before = ''; env.f.after = ''; env.f.readsBlocked.clear();
    if (mode === 'after') {
      const retry = await f.execute();
      A.eq([retry.invoked, retry.receipt.state, f.state.calls], [false, 'intent', 0], 'landed intent retry ACK supplies no execution permission');
    }
  });
  for (const mode of ['before', 'after']) await allocated(async env => {
    const f = setup(env);
    f.state.beforeCore = () => { env.f[mode] = env.jobFile; };
    const out = await f.execute();
    A.ok(out.observationError, mode + ': unconfirmed observation has a separate storage failure');
    A.eq(out.executionError, null, mode + ': successful actual work is not rewritten into an execution failure');
    A.eq([f.state.calls, f.state.afterObserve, f.table.size()], [1, 0, 0], mode + ': no tail or leaked RunTable admission after strict observation failure');
    env.f.before = ''; env.f.after = ''; env.f.readsBlocked.clear();
    const retry = await f.execute();
    A.eq([retry.invoked, f.state.calls], [false, 1], mode + ': explicit retry never buys another invocation');
    A.eq(retry.receipt.state, mode === 'after' ? 'observed' : 'intent', mode + ': canonical read distinguishes landed observation from unsaved result');
  });
  for (const [name, change, expected] of [
    ['missing usage', f => { f.usageMissing = true; }, 'observed'], ['known zero', f => { f.usd = 0; }, 'observed'],
    ['stopped', f => { f.outcome = 'stopped'; f.text = ''; }, 'observed'], ['unpriced', f => { f.unpriced = true; }, 'uncertain'],
    ['file-bearing', f => { f.artifacts = [{ kind: 'file', path: 'draft.txt' }]; }, 'uncertain'],
    ['invalid USD', f => { f.usd = NaN; }, 'uncertain'], ['oversized text', f => { f.text = 'x'.repeat(2 * 1024 * 1024); }, 'uncertain']
  ]) await allocated(async env => {
    const f = setup(env); change(f.facts);
    const out = await f.execute();
    A.eq(out.receipt.state, expected, name + ': actual evidence is observed or explicitly remains uncertain');
    if (name === 'missing usage') A.eq([out.receipt.observation.usd, out.usageStatus], [0.125, 'unresolved'], 'missing remainder retains positive floor without granting booking');
    if (name === 'known zero') A.eq(out.receipt.observation.usd, 0, 'known zero has an exact completed receipt');
    A.eq([f.state.calls, f.table.size()], [1, 0], name + ': no retry or live admission leak');
  });
  await allocated(async env => {
    const f = setup(env); f.state.coreError = new Error('actual provider failure');
    f.facts.outcome = 'failed'; f.facts.text = ''; f.facts.usageMissing = true;
    f.state.beforeCore = () => { env.f.before = env.jobFile; };
    const out = await f.execute();
    A.ok(out.executionError === f.state.coreError, 'observation failure cannot replace original execution exception');
    A.ok(out.observationError, 'both independent failures remain visible');
    A.eq(out.terminalEvidence.outcome, 'failed', 'in-memory actual outcome remains distinct from durable acknowledgement');
    A.eq(f.table.size(), 0, 'both-failure path still releases physical invocation');
  });
  await allocated(async env => {
    const f = setup(env, ({ d }) => { d.authority = null; });
    A.ok(await failure(f.execute), 'unwired production authority refuses');
    A.eq([f.state.calls, env.raw(env.jobFile).jobs[0].entryAdmission], [0, undefined], 'unavailable authority creates no intent or provider work');
  });
  await allocated(async env => {
    const f = setup(env, ({ d }) => { const original = d.authority; d.authority = p => p.phase === 'dequeue' ? false : original(p); });
    const out = await f.execute();
    A.eq([out.receipt.state, f.state.calls, f.table.size()], ['uncertain', 0, 0], 'fresh dequeue refusal never enters core and retains original identity');
  });
  await allocated(async env => {
    const f = setup(env);
    f.state.beforeCore = async (o, inv) => { A.ok(await failure(() => inv.enter(o)), 'same private context is consumed once'); };
    await f.execute();
    A.eq(f.state.calls, 1, 're-entering context cannot start a second core');
    A.eq(f.inv.has({ lineEntryInvocation: { allowed: true }, entryAdmission: f.data.receipt }), false, 'serialized lookalikes cannot name the private capability');
  });
  for (const value of [0, 0.001, NaN, Infinity, -1]) await allocated(async env => {
    const f = setup(env); f.options.ceilingUsd = value;
    A.ok(await failure(f.execute), 'zero/invalid narrower ceiling refuses before dispatch');
    A.eq(f.state.calls, 0, 'invalid ceiling cannot become billing fallback/default');
  });
  await allocated(async env => {
    const f = setup(env); f.options.ceilingUsd = 0.05;
    f.state.beforeCore = o => { A.eq(o.ceilingUsd, 0.05, 'current narrower dollar ceiling is preserved'); };
    await f.execute();
  });
  for (const ack of ['returned', 'lost']) await allocated(async env => {
    const lost = new Error('fixture lost observation ACK');
    const f = setup(env, ({ d }) => {
      const checkpoint = d.checkpoint;
      d.checkpoint = (id, revision, next) => {
        if (next.state !== 'observed') return checkpoint(id, revision, next);
        const changed = clone(next);
        changed.observation.product.text = 'different valid terminal\nVERDICT: BLOCKED';
        changed.observation.outputDigest = C.entryOutputDigest(changed.observation.product);
        changed.observation.usd = 0.75;
        const result = checkpoint(id, revision, changed);
        if (ack === 'lost') throw lost;
        return result;
      };
    });
    const out = await f.execute();
    A.eq([out.confirmed, out.usageStatus], [false, 'unresolved'], ack + ': another valid canonical observation cannot acknowledge this execution');
    A.ok(out.observationError, ack + ': mismatch retains storage failure');
    if (ack === 'lost') A.ok(out.observationError === lost, 'lost ACK retains the actual writer error');
    A.eq([out.terminalEvidence.text, out.terminalEvidence.usd], [f.facts.text, f.facts.usd], ack + ': actual terminal text and cost survive contradictory storage');
    A.eq([out.executionError, f.state.calls, f.state.afterObserve, f.table.size()], [null, 1, 0, 0], ack + ': contradiction cannot rewrite execution, enter the tail or leak ownership');
    const retry = await f.execute();
    A.eq([retry.invoked, f.state.calls], [false, 1], ack + ': replayed preparation never re-enters paid work');
  });
  await allocated(async env => {
    const lost = new Error('fixture exact observation lost ACK');
    const f = setup(env, ({ d }) => {
      const checkpoint = d.checkpoint;
      d.checkpoint = (id, revision, next) => { const r = checkpoint(id, revision, next); if (next.state === 'observed') throw lost; return r; };
    });
    const out = await f.execute();
    A.eq([out.confirmed, out.receipt.state, out.usageStatus], [true, 'observed', 'observed'], 'only the exact landed observation resolves lost ACK');
    A.eq([out.receipt.observation.product.text, out.receipt.observation.usd], [f.facts.text, f.facts.usd], 'lost ACK reconciliation keeps exact actual evidence');
    A.ok(out.observationError === lost, 'confirmed lost ACK remains visible as a storage incident');
  });
  for (const mode of ['different-returned', 'different-lost', 'exact-lost']) await allocated(async env => {
    const lost = new Error('fixture uncertain ACK lost');
    const f = setup(env, ({ d, data }) => {
      const authorize = d.authority, checkpoint = d.checkpoint;
      d.authority = p => p.phase === 'dequeue' ? false : authorize(p);
      d.checkpoint = (id, revision, next) => {
        const written = mode === 'exact-lost' ? next : Object.assign(clone(next), { state: 'observed', observation: clone(data.observation) });
        const r = checkpoint(id, revision, written);
        if (mode !== 'different-returned') throw lost;
        return r;
      };
    });
    const out = await f.execute();
    A.eq(out.confirmed, mode === 'exact-lost', mode + ': uncertainty requires its exact readback');
    A.eq(out.usageStatus, 'unresolved', mode + ': refusal cannot acquire authoritative usage from another receipt');
    A.ok(out.observationError, mode + ': uncertainty write mismatch/lost ACK is visible');
    A.eq([f.state.calls, f.table.size()], [0, 0], mode + ': no core invocation or leaked owner');
  });
  for (const changed of ['run', 'workitem', 'input']) await allocated(async env => {
    const f = setup(env, ({ d }) => {
      const authorize = d.authority;
      d.authority = async p => {
        const allowed = await authorize(p);
        if (p.phase === 'dequeue') {
          if (changed === 'run') p.options.runId = 'run-foreign';
          if (changed === 'workitem') p.options.workitemId = 'crate-foreign';
          if (changed === 'input') p.options.messages[p.options.messages.length - 1].content = 'different input';
        }
        return allowed;
      };
    });
    const out = await f.execute();
    A.eq([out.receipt.state, f.state.calls, f.table.size()], ['uncertain', 0, 0], changed + ': post-await identity mutation refuses before core');
    A.eq(out.receipt.binding, f.data.receipt.binding, changed + ': original durable identity is not rewritten by a mutated invocation');
  });
  await allocated(async env => {
    const waiting = deferred(), resume = deferred();
    const f = setup(env, ({ d }) => {
      const authorize = d.authority;
      d.authority = async p => { const ok = await authorize(p); if (p.phase === 'dequeue') { waiting.resolve(); await resume.promise; } return ok; };
    });
    const first = f.execute(); await waiting.promise;
    const second = await f.execute();
    A.eq([second.invoked, second.receipt.state, f.state.calls], [false, 'intent', 0], 'concurrent same-job preparation is a receipt replay, never another invocation');
    resume.resolve(); const out = await first;
    A.eq([out.confirmed, out.receipt.state, f.state.calls, f.table.size()], [true, 'observed', 1, 0], 'only fresh admitted invocation completes and releases ownership');
  });
  await allocated(async env => {
    const waiting = deferred(), resume = deferred(), ac = new AbortController();
    const f = setup(env, ({ d }) => {
      const authorize = d.authority;
      d.authority = async p => { const ok = await authorize(p); if (p.phase === 'dequeue') { waiting.resolve(); await resume.promise; } return ok; };
    });
    f.options.signal = ac.signal;
    const pending = f.execute(); await waiting.promise; ac.abort(); resume.resolve();
    const out = await pending;
    A.eq([out.receipt.state, f.state.calls, f.table.size()], ['uncertain', 0, 0], 'STOP during authority await refuses core and releases the exact owner');
  });
  A.report('line-entry.invocation');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
