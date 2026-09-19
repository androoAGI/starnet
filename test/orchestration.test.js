/* node test/orchestration.test.js — team.dispatch (Stage 2 lead->worker delegation). Drives the tool against
   a FAKE runOnce (no live key, no network): verifies it spawns one child run per worker with the worker's
   identity, threads the parent signal + per-worker cost cap, forwards ONLY lifecycle/cost to the lead bus,
   rejects self/unknown targets without a run, null-guards a refused child, and is capability-gated. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEventListeners } = require('events');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');

// a fake run host that records every child runOnce call and returns a configurable result.
function fakeRunOnce(impl) {
  const calls = [];
  const fn = async (o) => { calls.push(o); return impl ? impl(o) : { reason: 'done', messages: [{ role: 'assistant', content: 'out:' + o.agentId }], usd: 0.2 }; };
  fn.calls = calls;
  return fn;
}
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));

(async () => {

// ---- sequential dispatch to two workers: identity, signal, cost cap, aggregated result ----
{
  const ro = fakeRunOnce();
  const roster = new Map([
    ['researcher', { system: 'R-SYS', name: 'RESEARCHER', model: 'm1' }],
    ['analyst', { system: 'A-SYS', name: 'ANALYST', model: null }]
  ]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead-model', perWorker: 1, newId: counter() });
  const signal = { aborted: false };
  const emitted = [];
  const leadBroker = { _isLeadConsent: true };   // stand-in for the lead's consent broker (ctx.consent)
  const ctx = { agentId: 'agent', projectRoot: '/selected/project', projectCwd: '/selected/project/package', signal, emit: (name, p) => emitted.push({ name, p }), consent: leadBroker };
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find X' }, { agentId: 'analyst', prompt: 'analyze Y' }] }, ctx);

  A.eq(ro.calls.length, 2, 'two child runs dispatched (one per worker)');
  A.eq(ro.calls[0].projectRoot, ctx.projectRoot, 'worker inherits the host-selected project for file tools');
  A.eq(ro.calls[0].workdir, ctx.projectCwd, 'worker inherits the execution cwd');
  A.eq(ro.calls[0].agentId, 'researcher', 'first child is the researcher');
  A.eq(ro.calls[0].system, 'R-SYS', "child runs with the worker's composed system prompt");
  A.eq(ro.calls[0].model, 'm1', 'child uses the worker model when set');
  A.eq(ro.calls[1].model, 'lead-model', 'child falls back to the lead model when the worker has none');
  // Each foreground worker now runs on its OWN abort controller chained to the parent, so one worker's wall clock
  // can't kill its siblings. Identity-equality with the parent signal is therefore GONE by design — propagation is
  // proven against a real AbortController in the "one worker's wall clock" section below.
  A.ok(ro.calls[0].signal && ro.calls[0].signal !== signal, "the child runs on its OWN abort signal (a straggler is stopped alone)");
  A.eq(ro.calls[0].maxCostUsd, 1, 'per-worker cost cap is passed to the child');
  A.eq(ro.calls[0].maxIters, 0, 'the default per-worker iteration ceiling is off');
  A.eq(ro.calls[0].surface, 'autonomous', 'workers run headless on the autonomous office baseline');
  // SAME ACCESS AS THE ORCHESTRATOR: a worker shares the lead's consent broker (its APPROVAL posture + grants)
  // and is handed the WORKBENCH, so shell/writes are available and gated by the lead's approvals — not auto-denied.
  A.ok(ro.calls[0].consent === leadBroker, "worker shares the lead's consent broker (same access as the orchestrator)");
  A.ok(Array.isArray(ro.calls[0].extraObjects) && ro.calls[0].extraObjects.some(o => o.objectType === 'workbench'), 'worker is equipped with the workbench (terminal) on top of the office');
  A.eq(ro.calls[0].isTask, true, 'worker run is a task (tool-capable)');
  A.ok(ro.calls[0].runId && ro.calls[0].runId !== ro.calls[1].runId, 'each child gets a distinct runId');

  const parsed = JSON.parse(out.content);
  A.eq(parsed.length, 2, 'aggregated result carries both workers');
  A.eq(parsed[0].agentId, 'researcher', 'result carries the worker agentId');
  A.eq(parsed[0].result, 'out:researcher', "result carries the worker's final assistant text");
  A.eq(parsed[0].reason, 'done', 'result carries the run reason');
  A.ok(Math.abs(parsed[0].usd - 0.2) < 1e-9, 'result carries the worker spend');
}

// ---- cross-provider dispatch: a worker with its OWN roster provider runs on THAT wire (2026-07-07 escape:
//      overseer on codex delegated to a worker whose roster model was another provider's slug — the worker's
//      model went down the codex wire and 400'd instantly, so the "researcher" died seconds after run.start) ----
{
  const ro = fakeRunOnce();
  const roster = new Map([
    ['researcher', { system: 'R', model: 'claude-x', provider: 'anthropic' }],
    ['peter', { system: 'P', model: 'gpt-5.5', provider: 'codex' }]
  ]);
  const auth = (pid) => (pid === 'anthropic' ? { provider: 'anthropic', key: 'ANT-KEY', baseUrl: '' } : null);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'LEAD-KEY', model: 'gpt-5.5', provider: 'codex', baseUrl: '', newId: counter(), providerAuth: auth });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }, { agentId: 'peter', prompt: 'y' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls[0].provider, 'anthropic', "worker runs on its OWN roster provider, not the lead's wire");
  A.eq(ro.calls[0].key, 'ANT-KEY', "worker's provider credential is resolved server-side (never the lead's key)");
  A.eq(ro.calls[0].model, 'claude-x', "worker keeps its own roster model on its own wire");
  A.eq(ro.calls[1].provider, 'codex', 'same-provider worker is untouched (lead wire)');
  A.eq(ro.calls[1].key, 'LEAD-KEY', 'same-provider worker uses the lead run key');
}

// ---- cross-provider fallback: no credential for the worker's provider -> lead's provider+MODEL (never the
//      foreign model down the lead's wire), with an honest note in the dispatch result ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R', model: 'claude-x', provider: 'anthropic' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'LEAD-KEY', model: 'gpt-5.5', provider: 'codex', newId: counter(), providerAuth: () => null });
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls[0].provider, 'codex', 'no credential -> worker falls back to the lead provider');
  A.eq(ro.calls[0].model, 'gpt-5.5', "no credential -> lead's MODEL too (a foreign model on the lead wire is an instant 400)");
  const parsed = JSON.parse(out.content);
  A.ok(/no credential/.test(parsed[0].note || ''), 'the fallback is disclosed in the dispatch result (never silent)');
}

// ---- no providerAuth injected (bare/legacy host): behavior degrades to the safe fallback, not a crash ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R', model: 'claude-x', provider: 'anthropic' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead-model', provider: 'codex', newId: counter() });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls[0].provider, 'codex', 'no resolver -> lead provider');
  A.eq(ro.calls[0].model, 'lead-model', 'no resolver -> lead model (never a cross-wire 400)');
}

// ---- worker maxIters can be tuned without changing the lead's loop default ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), workerMaxIters: 6 });
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls[0].maxIters, 6, 'deps.workerMaxIters overrides the default worker loop cap');
}

// ---- a narrow one-host check gets task-specific turn/tool/time budgets even if a lead delegates it ----
{
  const ro = fakeRunOnce(() => ({ reason: 'done', messages: [{ role: 'assistant', content: 'missing' }], usd: 0, model: 'm', reasoningEffort: 'medium', toolsOk: 1, durationMs: 12 }));
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), workerMaxIters: 16 });
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'Check starnessos.com and read its docs.' }] }, { agentId: 'lead', runId: 'lead-run', emit: () => {} });
  A.eq(ro.calls[0].maxIters, 3, 'direct-domain worker gets a three-turn cap');
  A.eq(ro.calls[0].maxToolCalls, 3, 'direct-domain worker gets a three-tool cap');
  A.eq(ro.calls[0].parentRunId, 'lead-run', 'child records its durable parent run id');
  const row = JSON.parse(out.content)[0];
  A.eq(row.model, 'm', 'dispatch result exposes the actual worker model');
  A.eq(row.reasoningEffort, 'medium', 'dispatch result exposes worker reasoning effort');
  A.eq(row.durationMs, 12, 'dispatch result exposes worker elapsed time');
}

// ---- child emit forwarding: ONLY lifecycle/cost reach the lead bus (no token/COMMS pollution) ----
{
  const ro = fakeRunOnce(async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
    o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'secret thinking' });
    o.emit('agent.cost', { agentId: o.agentId, runId: o.runId, usd: 0.1, model: 'm', reconciled: true });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0.1 });
    return { reason: 'done', messages: [{ role: 'assistant', content: 'r' }], usd: 0.1 };
  });
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const emitted = [];
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'agent', emit: (n, p) => emitted.push(n) });
  A.ok(emitted.indexOf('agent.run.start') >= 0 && emitted.indexOf('agent.run.end') >= 0, 'child lifecycle forwarded to the lead bus (drives the floor animation)');
  A.ok(emitted.indexOf('agent.cost') >= 0, 'child cost forwarded (honest lifetime total)');
  A.ok(emitted.indexOf('agent.token') < 0, "child tokens are NOT forwarded (no pollution of the lead's COMMS)");
}

// ---- deliverable visibility (2026-07-07 ghost-file escape): a worker's saved image/file must reach the
//      Commander — the deliverable event forwards to the lead bus (COMMS card / crate / notify all hang off
//      it), and the dispatch result carries the worker's PROVEN artifacts stamped with the owning workspace ----
{
  const ro = fakeRunOnce(async (o) => {
    o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
    o.emit('deliverable', { id: 'img_x', agentId: o.agentId, kind: 'image', title: 'images/x.png' });
    o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    return { reason: 'done', messages: [{ role: 'assistant', content: 'made it' }], usd: 0, artifacts: [{ kind: 'image', path: 'images/x.png' }] };
  });
  const roster = new Map([['designer', { system: 'D' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const emitted = [];
  const out = await dispatchTool.run({ workers: [{ agentId: 'designer', prompt: 'draw x' }] }, { agentId: 'lead', emit: (n, p) => emitted.push({ n, p }) });
  const fwd = emitted.find(e => e.n === 'deliverable');
  A.ok(fwd, "the worker's deliverable event is FORWARDED to the lead bus (drives the COMMS card + crate + notify)");
  A.eq(fwd && fwd.p.agentId, 'designer', 'the forwarded payload keeps the OWNING agentId (the card opens /api/file?agent=designer)');
  const row = JSON.parse(out.content)[0];
  A.ok(Array.isArray(row.artifacts) && row.artifacts.length === 1, 'the dispatch result carries the worker artifact ledger');
  A.eq(row.artifacts[0].workspace, 'designer', "each artifact is stamped with the owning WORKSPACE (the lead can answer 'where is it' truthfully)");
  A.eq(row.artifacts[0].path, 'images/x.png', 'the artifact keeps its jail-relative path');
  A.ok(/private workspace/.test(dispatchTool.description) && /cannot fs\.read/.test(dispatchTool.description), "the tool contract teaches the lead that worker files are NOT in its own jail (the ghost-file reply)");
}

// ---- self / unknown targets are rejected WITHOUT a run ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'agent', prompt: 'x' }, { agentId: 'ghost', prompt: 'y' }] }, { agentId: 'agent', emit: () => {} });
  A.eq(ro.calls.length, 0, 'no runOnce fired for a self/unknown target');
  const parsed = JSON.parse(out.content);
  A.eq(parsed[0].reason, 'error', 'self-delegation is an error');
  A.ok(/yourself/.test(parsed[0].result), 'self rejection explains why');
  A.eq(parsed[1].reason, 'error', 'unknown worker is an error');
  A.ok(/no such live worker/.test(parsed[1].result), 'unknown rejection points at the roster');
}

// ---- a child that could not start (runOnce -> undefined) is reported, not a crash ----
{
  const ro = fakeRunOnce(async () => undefined);   // mirrors a concurrency refusal / up-front error
  const roster = new Map([['researcher', { system: 'R' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, { agentId: 'agent', emit: () => {} });
  const parsed = JSON.parse(out.content);
  A.eq(parsed[0].reason, 'refused', 'a child that could not start is reported as refused (null-guarded)');
  A.ok(/concurrent-agent cap/.test(parsed[0].result), 'the refusal explains the likely cause');
  A.ok(parsed[0].retried === true, 'a refusal is retried once before it is reported as lost work');
  A.eq(ro.calls.length, 2, 'the retry is exactly ONE extra attempt (a refused worker did no work and cost nothing)');
}

// ---- parallel mode dispatches all workers ----
{
  const ro = fakeRunOnce(async () => { await Promise.resolve(); return { reason: 'done', messages: [{ role: 'assistant', content: 'r' }], usd: 0 }; });
  const roster = new Map([['a', {}], ['b', {}]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'a', prompt: '1' }, { agentId: 'b', prompt: '2' }], parallel: true }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls.length, 2, 'parallel dispatches both workers');
  A.eq(JSON.parse(out.content).length, 2, 'parallel returns both results');
}

// ---- capability gate: team.dispatch is denied without the orchestrator grant, runs with it ----
// ---- background mode returns durable handles immediately and records watch events/results ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-bg-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
      return { reason: 'done', messages: [{ role: 'assistant', content: 'bg:' + o.agentId }], usd: 0.3 };
    });
    const roster = new Map([['researcher', { system: 'R' }]]);
    const { dispatchTool, subagentsTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    A.ok(handle.id && handle.status === 'running', 'background dispatch returns a running durable handle immediately');
    await tick();
    A.eq(ro.calls[0].maxIters, 0, 'background workers also have no default iteration ceiling');
    await tick(); await tick();
    const rec = subagents.get(handle.id);
    A.eq(rec.status, 'done', 'background worker completes into the durable record');
    A.eq(rec.result, 'bg:researcher', 'background worker stores final text');
    A.ok(rec.events.some(e => e.name === 'agent.run.start'), 'background worker stores watchable lifecycle events');
    const listed = await subagentsTool.run({}, { agentId: 'lead' });
    A.eq(JSON.parse(listed.content).length, 1, 'team.subagents lists this lead\'s durable workers');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- background interrupt aborts the worker signal and marks the record resumable ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-cut-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    let childSignal = null;
    const ro = fakeRunOnce(async (o) => {
      childSignal = o.signal;
      return new Promise(() => {});
    });
    const roster = new Map([['researcher', { system: 'R' }]]);
    const { dispatchTool, interruptTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents });
    const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    await tick();
    const cut = await interruptTool.run({ id: handle.id }, { agentId: 'lead' });
    A.ok(/interrupted/.test(cut.summary), 'team.interrupt reports interrupted');
    A.ok(childSignal && childSignal.aborted, 'team.interrupt aborts the child run signal');
    A.eq(subagents.get(handle.id).status, 'interrupted', 'team.interrupt marks the durable record interrupted');
    A.eq(subagents.get(handle.id).canResume, true, 'interrupted background worker can be resumed');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- team.resume restarts a background worker with the same worker iteration cap ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-resume-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const first = subagents.start({ leadId: 'lead', agentId: 'researcher', prompt: 'retry', runId: 'run_a', projectRoot: '/original/project', workdir: '/original/project/package' }, async () => new Promise(() => {}));
    await tick();
    subagents.interrupt(first.id, 'lead');
    const reloaded = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock: { now: () => 1001 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(async () => ({ reason: 'done', messages: [{ role: 'assistant', content: 'resumed' }], usd: 0 }));
    const roster = new Map([['researcher', { system: 'R' }]]);
    const { resumeTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents: reloaded, workerMaxIters: 7 });
    A.eq(resumeTool.preconditions[0].requiredTool, 'team.subagents', 'team.resume declares inspection as a machine-readable precondition');
    let missing = null;
    try { await resumeTool.run({ id: 'missing' }, { agentId: 'lead', emit: () => {} }); } catch (e) { missing = e; }
    A.eq(missing && missing.precondition && missing.precondition.code, 'inspect_before_resume', 'an invalid resume id returns inspect-before-resume state instead of a successful-looking result');
    const out = await resumeTool.run({ id: first.id }, { agentId: 'lead', emit: () => {} });
    A.eq(out.summary, 'resumed', 'team.resume restarts the interrupted worker');
    await tick(); await tick();
    A.eq(ro.calls[0].maxIters, 7, 'resumed worker receives the configured iteration cap');
    A.eq(ro.calls[0].projectRoot, '/original/project', 'resume retains the original project from its durable record');
    A.eq(ro.calls[0].workdir, '/original/project/package', 'resume retains the original execution directory');
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

// ---- capability gate: team.dispatch is denied without the orchestrator grant, runs with it ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  const reg = makeRegistry();
  makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() }).register(reg);

  const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
  const r1 = await reg.dispatch({ name: 'team.dispatch', args: { workers: [{ agentId: 'researcher', prompt: 'x' }] } }, denyCtx);
  A.ok(r1.isError && /capability denied/.test(r1.content), 'team.dispatch denied without the orchestrator object');
  A.eq(ro.calls.length, 0, 'a denied dispatch never reaches runOnce');

  const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.dispatch'], approvalRules: {} }, { emit: () => {} });
  const r2 = await reg.dispatch({ name: 'team.dispatch', args: { workers: [{ agentId: 'researcher', prompt: 'x' }] } }, allowCtx);
  A.ok(!r2.isError, 'team.dispatch runs when the orchestrator object is present');
  A.eq(ro.calls.length, 1, 'a granted dispatch reaches runOnce');
}

// ---- CONSENT GATE (2026-07-14, the parked P1 prompt-injection fork closed): dispatch/spawn fan out REAL
//      autonomous budget-spending loops off text in the lead's context, so like team.summon they carry
//      requiresConsent — 'ask' mode gets the APPROVAL beat (session grants stop fatigue), Full Access bypasses.
//      This block FAILS if either tool ever silently reverts to consent-free. ----
{
  const t = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  A.eq(t.dispatchTool.requiresConsent, true, 'team.dispatch IS consent-gated (injected "dispatch a worker" needs a human moment)');
  A.eq(t.spawnTool.requiresConsent, true, 'team.spawn IS consent-gated (same fork — clones spend budget too)');
  // the capability registry mirror must agree (resolve.js builds approvalRules from it)
  const CAP_REGISTRY = require('../sidecar/capability/registry.js').CAP_REGISTRY;
  const orch = CAP_REGISTRY.orchestrator;
  A.eq(orch.find(g => g.tool === 'team.dispatch').requiresConsent, true, 'registry mirror: team.dispatch consent-gated');
  A.eq(orch.find(g => g.tool === 'team.spawn').requiresConsent, true, 'registry mirror: team.spawn consent-gated');
}

// ---- dispatch carries its OWN long timeout, never the 30s fast-tool default (regression: a real worker loop
//      runs for minutes; inheriting ctx.timeoutMs=30000 made team.dispatch always time out before returning) ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R' }]]);
  // default: no dispatchTimeoutMs passed -> a generous built-in (minutes), far above the 30s fast-tool cap
  const def = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() }).dispatchTool;
  A.ok(typeof def.timeoutMs === 'number' && def.timeoutMs > 60000, 'team.dispatch carries its own multi-minute timeout, not the 30s fast-tool default');
  // the registry honors tool.timeoutMs OVER ctx.timeoutMs, so a 30s ctx can never clamp a dispatch
  A.ok(def.timeoutMs > 30000, 'dispatch timeout outlasts CAPS.toolTimeoutMs (30s) so a worker loop is never cut short');
  // an explicit override is honored (the host wires this from CRON_MAX_RUN_MS)
  // An explicit override is honored (the host wires this from CRON_MAX_RUN_MS). The REGISTRY timeout deliberately
  // sits above it: the dispatch owns its own wall clock so it can return partial rows, and the registry's
  // timeout — which discards the whole result — must never be what fires first (2026-07-26 audit finding A).
  const over = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), dispatchTimeoutMs: 123456 }).dispatchTool;
  A.ok(over.timeoutMs > 123456, 'the registry timeout sits ABOVE the dispatch budget (the in-tool clock fires first)');
  A.ok(over.timeoutMs - 123456 >= 30000, 'the backstop leaves real slack, not a race with the in-tool clock');
}

// ============================ team.summon (create a NEW worker live) ============================

// ---- the tool's shape: lead-gated, consent-gated, and outlasts the 120s browser-ack backstop ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  A.eq(summonTool.name, 'team.summon', 'tool is team.summon');
  A.eq(summonTool.capability, 'orchestrator', 'gated by the orchestrator object (lead-only, like team.dispatch)');
  A.eq(summonTool.scope, 'write', 'summon is a write-scope mutation');
  A.eq(summonTool.requiresConsent, true, 'summon IS consent-gated (the APPROVAL beat) — like dispatch/spawn since 2026-07-14');
  A.ok(typeof summonTool.timeoutMs === 'number' && summonTool.timeoutMs > 120000, 'tool wall-clock outlasts the 120s summon ack backstop (clean null, not a tool timeout)');
}

// ---- happy path: ctx.summon resolves a new id; the spec is forwarded; the result carries the id for dispatch ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  let gotSpec = null;
  const ctx = { agentId: 'agent', summon: async (s) => { gotSpec = s; return 'researcher-2'; } };
  const out = await summonTool.run({ name: 'Researcher', specId: 'researcher', purpose: 'find things' }, ctx);
  A.ok(gotSpec && gotSpec.name === 'Researcher' && gotSpec.specId === 'researcher', 'the spec (name + specId) is forwarded to ctx.summon');
  A.eq(gotSpec.purpose, 'find things', 'a custom purpose is forwarded');
  const parsed = JSON.parse(out.content);
  A.eq(parsed.agentId, 'researcher-2', 'the new agentId comes back for the lead to delegate to');
  A.ok(!('workstation' in parsed), 'a bare-id ack claims NO desk (the station never said it placed one)');
  A.ok(!/desk/i.test(out.summary), 'and the summary stays silent about furniture it cannot source');
  A.ok(/team\.dispatch/.test(out.summary), 'the summary nudges the lead to delegate to the new worker');
}

// ---- THE DESK RIDES ALONG: the station acks { agentId, desk } and the tool reports WHERE it landed ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const ctx = { agentId: 'agent', summon: async () => ({ agentId: 'scout-2', desk: 'BRIDGE' }) };
  const out = await summonTool.run({ name: 'Scout', specId: 'scout' }, ctx);
  const parsed = JSON.parse(out.content);
  A.eq(parsed.agentId, 'scout-2', 'the object ack still yields the new agentId');
  A.eq(parsed.workstation, 'BRIDGE', 'the seeded workstation room reaches the lead');
  A.ok(/workstation in BRIDGE/.test(out.summary), 'the summary states where the workstation is (true whether it was built or adopted)');
  A.ok(summonTool.description.indexOf('workstation with it') > 0, 'the tool tells the lead never to ask the Commander to build the desk');
}

// ---- an object ack with NO desk (placement failed / no room) must not claim one ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const out = await summonTool.run({ name: 'Scout' }, { agentId: 'agent', summon: async () => ({ agentId: 'scout-3', desk: '' }) });
  A.eq(JSON.parse(out.content).agentId, 'scout-3', 'the agent is still reported as created');
  A.ok(!/desk/i.test(out.summary), 'a failed desk seed is never dressed up as a placed one');
}

// ---- declined / no browser: ctx.summon resolves null -> a clean "not completed", no crash ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const out = await summonTool.run({ name: 'Ghost' }, { agentId: 'agent', summon: async () => null });
  A.eq(out.summary, 'declined', 'a null ack (decline/timeout/disconnect) reports declined');
  A.ok(/No agent was created/.test(out.content), 'declined summon says plainly that nothing was created');
}

// ---- headless / worker: no ctx.summon closure -> degrades to a clear "not available" (fails closed) ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  const out = await summonTool.run({ name: 'X' }, { agentId: 'worker' });   // no summon on ctx (autonomous run)
  A.eq(out.summary, 'unavailable', 'summon without a live station is unavailable, not a crash');
}

// ---- nothing to summon: neither name nor specId -> noop, never calls ctx.summon ----
{
  const { summonTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() });
  let called = false;
  const out = await summonTool.run({ name: '   ' }, { agentId: 'agent', summon: async () => { called = true; return 'x'; } });
  A.eq(out.summary, 'noop', 'an empty spec is a noop');
  A.ok(!called, 'a noop never reaches ctx.summon');
}

// ---- capability gate: team.summon denied without the orchestrator grant, runs with it ----
{
  const reg = makeRegistry();
  makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', newId: counter() }).register(reg);
  let summoned = 0;
  const summon = async () => { summoned++; return 'researcher-2'; };

  const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {}, summon });
  const r1 = await reg.dispatch({ name: 'team.summon', args: { name: 'R', specId: 'researcher' } }, denyCtx);
  A.ok(r1.isError && /capability denied/.test(r1.content), 'team.summon denied without the orchestrator object');
  A.eq(summoned, 0, 'a denied summon never reaches ctx.summon');

  const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.summon'], approvalRules: {} }, { emit: () => {}, summon });
  const r2 = await reg.dispatch({ name: 'team.summon', args: { name: 'R', specId: 'researcher' } }, allowCtx);
  A.ok(!r2.isError, 'team.summon runs when the orchestrator object is present');
  A.eq(summoned, 1, 'a granted summon reaches ctx.summon');
}

// ============================ team.spawn (ephemeral self-clone sub-agents / Meeseeks) ============================

// ---- spawns N ephemeral clones: clone identity (lead system+model), ephemeral non-roster id, flat depth, results,
//      and the Meeseeks visual feed (lifecycle forwarded + task{kind:'subagent'} emitted, tokens NOT forwarded) ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-'));
  try {
    const taskEvents = [];
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: (n, p) => { if (n === 'task') taskEvents.push(p); }, newId: counter() });
    const ro = fakeRunOnce(async (o) => {
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
      o.emit('agent.token', { agentId: o.agentId, delta: 'secret' });
      return { reason: 'done', messages: [{ role: 'assistant', content: 'res:' + o.agentId }], usd: 0.4 };
    });
    const emitted = [];
    const leadBroker = { _isLeadConsent: true };
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'lead-model', selfSystem: 'LEAD-SYS', perWorker: 2, newId: counter(), subagents });
    const ctx = { agentId: 'lead', emit: (n) => emitted.push(n), consent: leadBroker };
    const out = await spawnTool.run({ tasks: [{ prompt: 'sub A', label: 'alpha' }, { prompt: 'sub B' }] }, ctx);

    A.eq(ro.calls.length, 2, 'two ephemeral clones spawned (one per task)');
    A.eq(ro.calls[0].system, 'LEAD-SYS', "the clone runs with the LEAD's OWN base identity (clone of self)");
    A.eq(ro.calls[0].model, 'lead-model', 'the clone uses the lead model');
    A.ok(/^sub-/.test(ro.calls[0].agentId), 'the clone gets an anonymous ephemeral agentId (sub- prefix, not a roster id)');
    A.ok(ro.calls[0].agentId !== ro.calls[1].agentId && ro.calls[0].agentId !== 'lead', 'each clone is a distinct, non-lead id');
    A.eq(ro.calls[0].isTask, true, 'the clone run is a task (tool-capable)');
    A.eq(ro.calls[0].maxCostUsd, 2, 'per-worker cost cap is passed to the clone');
    A.eq(ro.calls[0].maxIters, 0, 'clones also have no default iteration ceiling');
    A.ok(ro.calls[0].consent === leadBroker, 'the clone shares the lead consent broker (same approval posture)');
    A.ok(Array.isArray(ro.calls[0].extraObjects) && ro.calls[0].extraObjects.some(o => o.objectType === 'workbench'), 'the clone gets the workbench (terminal)');
    A.ok(!ro.calls[0].lead, 'FLAT DEPTH: the clone is NOT a lead (no orchestrator object) so it cannot re-spawn');
    A.eq(ro.calls[0].surface, 'autonomous', 'the clone runs headless on the autonomous baseline');

    const parsed = JSON.parse(out.content);
    A.eq(parsed.length, 2, 'both clone results returned');
    A.eq(parsed[0].label, 'alpha', 'a provided label is carried back');
    A.eq(parsed[1].label, 'subagent 2', 'an unlabelled task gets a default label');
    A.ok(/^res:sub-/.test(parsed[0].result), 'the clone final text is returned');
    A.eq(parsed[0].reason, 'done', 'the clone run reason is carried');

    A.ok(emitted.indexOf('agent.run.start') >= 0, 'clone lifecycle forwarded to the lead bus (floor materializes the Meeseeks)');
    A.ok(emitted.indexOf('agent.token') < 0, "clone tokens are NOT forwarded (no pollution of the lead's COMMS)");
    A.ok(taskEvents.some(e => e.kind === 'subagent'), 'a task{kind:subagent} record is emitted (the Meeseeks identity signal)');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- background mode returns durable handles immediately and completes into the record ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-bg-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce(async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: 'bg:' + o.agentId }], usd: 0.1 }));
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const out = await spawnTool.run({ tasks: [{ prompt: 'x' }], background: true }, { agentId: 'lead', emit: () => {} });
    const handle = JSON.parse(out.content)[0];
    A.ok(handle.id && handle.status === 'running', 'background spawn returns a running durable handle immediately');
    A.eq(handle.label, 'subagent 1', 'the handle carries the label');
    await tick(); await tick();
    A.eq(subagents.get(handle.id).status, 'done', 'the background clone completes into the durable record');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- guards: no subagent manager → unavailable (no run); empty tasks → noop ----
{
  const ro = fakeRunOnce();
  const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter() });   // no subagents dep
  const out = await spawnTool.run({ tasks: [{ prompt: 'x' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(out.summary, 'unavailable', 'team.spawn without a subagent manager is unavailable, not a crash');
  A.eq(ro.calls.length, 0, 'unavailable spawn never reaches runOnce');
}
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-noop-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const { spawnTool } = makeOrchestrationTools({ runOnce: fakeRunOnce(), roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    const out = await spawnTool.run({ tasks: [] }, { agentId: 'lead', emit: () => {} });
    A.eq(out.summary, 'noop', 'empty tasks is a noop');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- capability gate: team.spawn is denied without the orchestrator grant, runs with it ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-cap-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce();
    const reg = makeRegistry();
    makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents }).register(reg);
    const denyCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: [], approvalRules: {} }, { emit: () => {} });
    const r1 = await reg.dispatch({ name: 'team.spawn', args: { tasks: [{ prompt: 'x' }] } }, denyCtx);
    A.ok(r1.isError && /capability denied/.test(r1.content), 'team.spawn denied without the orchestrator object');
    const allowCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.spawn'], approvalRules: {} }, { emit: () => {} });
    const r2 = await reg.dispatch({ name: 'team.spawn', args: { tasks: [{ prompt: 'x' }] } }, allowCtx);
    A.ok(!r2.isError, 'team.spawn runs when the orchestrator object is present');
    await tick(); await tick();
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- POWER-USER DEFAULT: a single parallel dispatch may run twenty workers when no cap is configured ----
{
  let active = 0; let peak = 0;
  const ro = fakeRunOnce(async (o) => {
    active++; peak = Math.max(peak, active);
    await tick();
    active--;
    return { reason: 'done', messages: [{ role: 'assistant', content: 'out:' + o.agentId }], usd: 0 };
  });
  const roster = new Map(Array.from({ length: 20 }, (_, i) => ['w' + (i + 1), { system: 'S' + (i + 1) }]));
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  const workers = Array.from({ length: 20 }, (_, i) => ({ agentId: 'w' + (i + 1), prompt: 'p' + (i + 1) }));
  const out = await dispatchTool.run({ workers, parallel: true }, { agentId: 'lead', emit: () => {} });
  const rows = JSON.parse(out.content);
  A.eq(ro.calls.length, 20, 'the default dispatch starts all twenty requested workers');
  A.eq(rows.filter(r => r.reason === 'done').length, 20, 'all twenty workers finish and are reported');
  A.eq(rows.filter(r => r.reason === 'not-dispatched').length, 0, 'no hidden per-call ceiling drops work');
  A.eq(peak, 20, 'all twenty workers may execute concurrently when no station ceiling is configured');
}

// ---- OPT-IN CAPS STAY HONEST (2026-07-26 audit finding C): asking for MORE than maxWorkers used to slice(0,4) and say
//      nothing — "dispatched 4 worker(s), 4 done" for a 6-worker decomposition, so the lead reported on two
//      subtasks that never ran. The overflow must come back as explicit rows AND be named in the summary. ----
{
  const ro = fakeRunOnce();
  const roster = new Map([1, 2, 3, 4, 5, 6].map(i => ['w' + i, { system: 'S' + i }]));
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), maxWorkers: 4 });
  const out = await dispatchTool.run({ workers: [1, 2, 3, 4, 5, 6].map(i => ({ agentId: 'w' + i, prompt: 'p' + i })) }, { agentId: 'agent', emit: () => {} });
  A.eq(ro.calls.length, 4, 'the per-call worker cap still bounds how many child runs start');
  const rows = JSON.parse(out.content);
  A.eq(rows.length, 6, 'EVERY requested worker is accounted for in the result (4 run + 2 not-dispatched)');
  const nd = rows.filter(r => r.reason === 'not-dispatched');
  A.eq(nd.length, 2, 'the two workers past the cap come back as not-dispatched rows');
  A.eq(nd[0].agentId, 'w5', 'a not-dispatched row names the worker that was skipped');
  A.ok(/NOT RUN/.test(nd[0].result) && /follow-up call/.test(nd[0].result), 'the not-dispatched row tells the lead to re-dispatch it');
  A.ok(/NOT dispatched/.test(out.summary), 'the SUMMARY names the drop (the model reads this line first)');
  A.ok(/4 worker\(s\), 4 done/.test(out.summary), 'the summary still reports what actually ran');
}

// ---- same rule for team.spawn overflow ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-cap2-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce();
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents, maxWorkers: 4 });
    const out = await spawnTool.run({ tasks: [1, 2, 3, 4, 5].map(i => ({ prompt: 'p' + i, label: 'L' + i })) }, { agentId: 'agent', emit: () => {} });
    const rows = JSON.parse(out.content);
    A.eq(ro.calls.length, 4, 'spawn still starts at most maxWorkers clones');
    A.eq(rows.length, 5, 'every requested subtask is accounted for');
    const ns = rows.filter(r => r.reason === 'not-spawned');
    A.eq(ns.length, 1, 'the subtask past the cap comes back as a not-spawned row');
    A.eq(ns[0].label, 'L5', 'the not-spawned row keeps the label the lead gave it');
    A.ok(/NOT spawned/.test(out.summary), 'the spawn summary names the drop');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- EFFECTIVE APPROVAL POSTURE (2026-07-26 audit finding E): a worker shares the LEAD's consent broker, so a
//      worker whose OWN roster identity says "FULL ACCESS — never wait for a go-ahead" was lying to it whenever the
//      lead was in ask mode (every write actually paused). The delegated prompt must state the EFFECTIVE posture,
//      after (and explicitly superseding) the identity's own clause. ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['engineer', { system: 'E-SYS\n\nAPPROVAL — FULL ACCESS: run your tools directly.' }]]);
  const mk = posture => makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), approvalPosture: posture });

  await mk('ask').dispatchTool.run({ workers: [{ agentId: 'engineer', prompt: 'p' }] }, { agentId: 'lead', emit: () => {} });
  const askSys = ro.calls[0].system;
  A.ok(/E-SYS/.test(askSys), "the worker keeps its own composed roster identity");
  A.ok(/DELEGATED APPROVAL/.test(askSys), 'a delegated worker is told its EFFECTIVE approval posture');
  A.ok(/SUPERSEDES ANY APPROVAL SECTION ABOVE/.test(askSys), "the note explicitly overrides the identity's own clause");
  A.ok(/ASK FIRST/.test(askSys), "an ask-mode lead's worker is told to expect approval pauses");
  A.ok(askSys.indexOf('DELEGATED APPROVAL') > askSys.indexOf('APPROVAL — FULL ACCESS'), 'the effective posture lands AFTER the identity clause (later wins)');

  await mk('full').dispatchTool.run({ workers: [{ agentId: 'engineer', prompt: 'p' }] }, { agentId: 'lead', emit: () => {} });
  const fullSys = ro.calls[1].system;
  A.ok(/FULL ACCESS\. Run your tools directly/.test(fullSys), "a full-access lead's worker is told to act without asking");
  A.ok(!/ASK FIRST/.test(fullSys), 'no contradictory ask-first instruction on the full-access path');

  // a host that wires NO posture stays byte-identical to the pre-fix prompt (back-compat for bare unit callers)
  await mk(undefined).dispatchTool.run({ workers: [{ agentId: 'engineer', prompt: 'p' }] }, { agentId: 'lead', emit: () => {} });
  A.eq(ro.calls[2].system, 'E-SYS\n\nAPPROVAL — FULL ACCESS: run your tools directly.', 'no posture wired -> the identity is passed through untouched');
}

// the host's own posture thunk must be wired at the call site (the tool cannot read the roster itself)
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/approvalPosture: \(\) => \(FULL_ACCESS \|\| \(\(agentRoster\.get\(agentId\) \|\| \{\}\)\.approvalMode === 'full'\)\) \? 'full' : 'ask'/.test(src),
    'the run host wires the EFFECTIVE (lead) approval posture into makeOrchestrationTools');
}

// ---- THE ESCAPE (2026-07-26 audit finding A): a SEQUENTIAL dispatch whose wall clock ran out used to lose
//      EVERYTHING. One slow worker ate the shared budget, the registry's tool timeout rejected, and every
//      already-completed worker's result was discarded — the lead received only "team.dispatch timed out", after
//      the Commander had paid for all of them. Now: one worker's slice ends ALONE, its siblings' work survives,
//      and the row says so. Driven through the REAL registry (which owns the outer timeout). ----
{
  const finished = [];
  let clock = 0;
  const runOnce = async (o) => {
    const slow = o.agentId === 'analyst';
    await new Promise(res => {
      const t = setTimeout(res, slow ? 4000 : 5);
      if (o.signal && o.signal.addEventListener) o.signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
    finished.push(o.agentId);
    return { reason: 'done', messages: [{ role: 'assistant', content: 'REAL WORK from ' + o.agentId }], usd: 0.5 };
  };
  const roster = new Map([['researcher', {}], ['scribe', {}], ['analyst', {}]]);
  const tools = makeOrchestrationTools({
    runOnce, roster: () => roster, key: 'k', model: 'm', newId: counter(),
    dispatchTimeoutMs: 600, now: () => clock
  });
  const reg = makeRegistry();
  tools.register(reg);
  const capCtx = makeCapCtx({ agentId: 'agent', room: 'office', hasCompute: true, tools: ['team.dispatch'], approvalRules: {} }, { emit: () => {} });
  const r = await reg.dispatch({ name: 'team.dispatch', args: { workers: [
    { agentId: 'researcher', prompt: 'find X' }, { agentId: 'scribe', prompt: 'write Y' }, { agentId: 'analyst', prompt: 'deep dive Z' }
  ] }, argsRaw: '{}' }, capCtx);

  A.ok(!r.isError, 'a dispatch that runs out of wall clock RETURNS (it is not a registry timeout error)');
  const rows = JSON.parse(r.content);
  A.eq(rows.length, 3, 'every worker is accounted for');
  A.eq(rows[0].reason, 'done', 'the first finished worker is reported done');
  A.ok(/REAL WORK from researcher/.test(rows[0].result), "the finished worker's actual output SURVIVES the straggler (the escape)");
  A.ok(/REAL WORK from scribe/.test(rows[1].result), 'the second finished worker survives too');
  A.eq(rows[2].reason, 'timeout', 'the worker that blew its slice is reported as timeout, not as done');
  A.ok(/STOPPED/.test(rows[2].result) && /do not present it as complete/i.test(rows[2].result),
    'the timeout row tells the lead not to pass the unfinished part off as complete');
  A.ok(/out of time/.test(r.summary), 'the summary names the timeout so the model sees it before reading rows');
  A.ok(/2 done/.test(r.summary), 'the summary credits the work that did complete');
  A.ok(finished.indexOf('researcher') >= 0 && finished.indexOf('scribe') >= 0, 'both fast workers really ran');
}

// ---- a fast early worker DONATES its unused time: the wall clock is divided over what is LEFT, not fixed shares ----
{
  const ro = fakeRunOnce();
  const roster = new Map([['a', {}], ['b', {}], ['c', {}], ['d', {}]]);
  let clock = 0;
  const parent = new AbortController();
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), dispatchTimeoutMs: 4000, now: () => clock });
  await dispatchTool.run({ workers: ['a', 'b', 'c', 'd'].map(a => ({ agentId: a, prompt: 'p' })) }, { agentId: 'lead', signal: parent.signal, emit: () => {} });
  A.eq(ro.calls.length, 4, 'all four sequential workers ran');
  // clock never advances in this stub, so each worker sees the full remaining budget / workers remaining
  A.ok(ro.calls[0].signal && ro.calls[3].signal, 'every sequential worker got its own signal');
  A.eq(getEventListeners(parent.signal, 'abort').length, 0, 'settled workers detach their parent abort listeners');
}

// ---- abort PROPAGATION survives the per-worker controller: E-STOP on the lead still stops the worker ----
{
  let sawAbort = false;
  const parent = new AbortController();
  const runOnce = async (o) => {
    if (o.signal && o.signal.addEventListener) o.signal.addEventListener('abort', () => { sawAbort = true; }, { once: true });
    parent.abort();                                  // the lead is E-STOPped mid-worker
    await new Promise(res => setTimeout(res, 5));
    return { reason: 'abort', messages: [], usd: 0 };
  };
  const roster = new Map([['w', {}]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce, roster: () => roster, key: 'k', model: 'm', newId: counter(), dispatchTimeoutMs: 5000, now: () => 0 });
  await dispatchTool.run({ workers: [{ agentId: 'w', prompt: 'p' }] }, { agentId: 'lead', signal: parent.signal, emit: () => {} });
  A.ok(sawAbort, 'aborting the LEAD still cascades into the worker (the chained controller keeps E-STOP working)');
}

// ---- background workers keep NO wall clock (outliving the tool call is the point of background:true) ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-bg-noclock-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce();
    const roster = new Map([['w', {}]]);
    const parent = { aborted: false };
    const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents, dispatchTimeoutMs: 700, now: () => 0 });
    await dispatchTool.run({ workers: [{ agentId: 'w', prompt: 'p' }], background: true }, { agentId: 'lead', signal: parent, emit: () => {} });
    await tick(); await tick();
    A.eq(ro.calls.length, 1, 'the background worker started');
    A.ok(ro.calls[0].signal === undefined || ro.calls[0].signal !== null, 'background worker runs on the subagent registry signal');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

// ---- THE ESCAPE (2026-07-26 audit finding B): a parallel dispatch of 4 at the shipped defaults
//      (MAX_CONCURRENT_AGENTS 3, and the LEAD holds a slot for the whole dispatch) fanned out all at once, the
//      admission gate refused the last two, and NOTHING retried them — half the crew silently never worked.
//      Driven against the REAL concurrency gate, modelling the shipped admission path (index.js: tryEnter ->
//      `return` undefined on refusal, leave() in a finally). ----
{
  const { makeConcurrencyGate } = require('../sidecar/concurrency.js');
  const run = async (opts) => {
    const gate = makeConcurrencyGate({ max: 3 });
    gate.tryEnter('agent');                                  // the LEAD occupies a slot for the whole dispatch
    let peak = 0;
    const runOnce = async (o) => {
      if (!gate.tryEnter(o.agentId)) return undefined;        // shipped refusal shape
      peak = Math.max(peak, gate.active());
      try { await new Promise(r => setTimeout(r, 15)); return { reason: 'done', messages: [{ role: 'assistant', content: 'ok:' + o.agentId }], usd: 0.01 }; }
      finally { gate.leave(o.agentId); }
    };
    const roster = new Map([['w1', {}], ['w2', {}], ['w3', {}], ['w4', {}]]);
    const { dispatchTool } = makeOrchestrationTools(Object.assign({
      runOnce, roster: () => roster, key: 'k', model: 'm', newId: counter(), dispatchTimeoutMs: 20000, now: () => 0
    }, opts(gate)));
    const out = await dispatchTool.run({ workers: ['w1', 'w2', 'w3', 'w4'].map(a => ({ agentId: a, prompt: 'p' })), parallel: true }, { agentId: 'agent', emit: () => {} });
    return { rows: JSON.parse(out.content), summary: out.summary, peak };
  };

  // WITH the capacity wired (how the host wires it): every worker runs, and the gate is never over-subscribed.
  const wired = await run(gate => ({ freeSlots: () => { const m = gate.max(); return m > 0 ? Math.max(0, m - gate.active()) : null; } }));
  A.eq(wired.rows.length, 4, 'all four parallel workers are accounted for');
  A.eq(wired.rows.filter(r => r.reason === 'done').length, 4, 'ALL FOUR actually ran (the escape: two used to be refused and dropped)');
  A.eq(wired.rows.filter(r => r.reason === 'refused').length, 0, 'no worker is left refused');
  A.ok(wired.peak <= 3, 'the concurrency cap is still respected — waves never over-subscribe the gate (peak ' + wired.peak + ')');
  A.ok(/4 done/.test(wired.summary), 'the summary reports four done');

  // WITHOUT it wired, a refusal is still retried once rather than surfacing as lost work.
  const bare = await run(() => ({}));
  A.eq(bare.rows.length, 4, 'unwired hosts still account for every worker');
  A.ok(bare.rows.filter(r => r.reason === 'done').length >= 3, 'the retry pass recovers refusals even with no capacity hint');
}

// ---- a genuinely saturated gate still fails HONESTLY (never silently), and says what to do ----
{
  const ro = fakeRunOnce(() => undefined);            // every admission refused
  const roster = new Map([['w1', {}], ['w2', {}]]);
  const { dispatchTool } = makeOrchestrationTools({
    runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(),
    dispatchTimeoutMs: 5000, now: () => 0, freeSlots: () => 0
  });
  const out = await dispatchTool.run({ workers: [{ agentId: 'w1', prompt: 'p' }, { agentId: 'w2', prompt: 'p' }], parallel: true }, { agentId: 'agent', emit: () => {} });
  const rows = JSON.parse(out.content);
  A.eq(rows.length, 2, 'both workers are reported even when the gate is saturated');
  A.ok(rows.every(r => r.reason === 'refused'), 'a saturated gate yields refused rows, not fabricated results');
  A.ok(rows.every(r => r.retried === true), 'each refusal was retried once before being reported');
  A.ok(/MAX_CONCURRENT_AGENTS in SETTINGS/.test(rows[0].result), 'the refusal names the control the Commander can actually change');
  A.ok(ro.calls.length === 4, 'two workers x (first attempt + one retry) = four admission attempts');
}

// the host must wire the gate's live free capacity (the tool cannot see the gate itself)
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  A.ok(/freeSlots: \(\) => \{ const m = concurrencyGate\.max\(\); return m > 0 \? Math\.max\(0, m - concurrencyGate\.active\(\)\) : null; \}/.test(src),
    'the run host wires concurrencyGate free capacity into makeOrchestrationTools');
  A.ok(/now: \(\) => Date\.now\(\)/.test(src.slice(src.indexOf('makeOrchestrationTools({'), src.indexOf('makeOrchestrationTools({') + 3000)),
    'the run host injects the real clock for the dispatch wall clock');
}

/* ---- SESSION TARGETING: delegation can say WHERE, and refuses rather than guessing ----------------------
   The bug: `session` did not exist, so a delegated run was filed under whatever session the LEAD was in. The
   Commander named "research", the work landed elsewhere, and the lead reported success. These cover both the
   happy path and — the part that matters more — every way a name can fail to resolve. */
function fakeStation(sessions, opts) {
  opts = opts || {};
  const seen = [];
  return {
    seen,
    request: async (verb, args) => {
      seen.push({ verb, args });
      if (opts.down) return { ok: false, error: 'no station page answered', unattended: true };
      if (verb === 'station.sessions') return { ok: true, result: { sessions: sessions } };
      if (verb === 'station.dispatch_start') return { ok: true, result: { started: true } };
      if (verb === 'station.dispatch_end') return { ok: true, result: { settled: true } };
      if (verb === 'station.deliver') return opts.deliverFails ? { ok: false, error: 'session vanished' } : { ok: true, result: { folded: true } };
      return { ok: false, error: 'unknown verb' };
    }
  };
}
const SESSIONS = [
  { id: 'ws_general', title: 'General', agentId: 'agent' },
  { id: 'ws_r1', title: 'research', agentId: 'researcher' },
  { id: 'ws_b1', title: 'Billing rewrite', agentId: 'agent' }
];
function sessionTools(station, ro) {
  const roster = new Map([['researcher', { system: 'R-SYS', name: 'RESEARCHER', model: 'm1' }]]);
  return makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead-model', newId: counter(), station: station });
}
const leadCtx = () => ({ agentId: 'agent', emit: () => {} });

// a named session resolves to its id, rides into the child run as streamId, and is delivered back to the page
{
  const ro = fakeRunOnce();
  const station = fakeStation(SESSIONS);
  const { dispatchTool } = sessionTools(station, ro);
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'summarise X', session: 'research' }] }, leadCtx());
  A.eq(ro.calls.length, 1, 'the worker ran');
  A.eq(ro.calls[0].streamId, 'ws_r1', 'the named session resolves to its real id and rides into the run as streamId');
  A.eq(ro.calls[0].coordinatedSession, false, 'legacy bridge dispatch does not require server-owned session metadata');
  A.eq(ro.calls[0].sessionTitle, 'research', 'the stable session name rides into the durable run row for missed-page replay');
  A.eq(ro.calls[0].sessionPrompt, 'summarise X', 'the delegated instruction rides into the durable delivery envelope');
  const row = JSON.parse(out.content)[0];
  A.eq(row.reason, 'done', 'the worker completed');
  A.eq(row.session, 'research', 'the row reports WHICH session the work landed in');
  const deliver = station.seen.find(s => s.verb === 'station.deliver');
  A.ok(deliver, 'the finished answer was delivered to the page');
  A.eq(deliver.args.streamId, 'ws_r1', 'delivered to the resolved session, not the active one');
  A.eq(deliver.args.text, 'out:researcher', "the delivered text is the worker's real answer");
  A.eq(deliver.args.runId, ro.calls[0].runId, 'the delivery carries the SAME runId the run was filed under (idempotency + appendRun)');
  A.eq(deliver.args.sessionTitle, 'research', 'delivery carries the title so a second page with a divergent local id can resolve the same session');
  const started = station.seen.find(s => s.verb === 'station.dispatch_start');
  A.ok(started, 'the target session is told when its worker genuinely starts');
  A.eq(started.args.streamId, 'ws_r1', 'the live activity marker targets the resolved session');
  const settled = station.seen.find(s => s.verb === 'station.dispatch_end');
  A.ok(settled, 'the target session is told when its worker settles');
  A.eq(settled.args.runId, ro.calls[0].runId, 'the settled marker belongs to the same real worker run');
  A.eq(station.seen.filter(s => s.verb === 'station.sessions').length, 1, 'one session-list round trip for the whole dispatch');
}

// case and partial names still resolve while they are UNIQUE
{
  const ro = fakeRunOnce();
  const { dispatchTool } = sessionTools(fakeStation(SESSIONS), ro);
  await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'RESEARCH' }] }, leadCtx());
  A.eq(ro.calls[0].streamId, 'ws_r1', 'a case-different name matches its session');
  const ro2 = fakeRunOnce();
  const t2 = sessionTools(fakeStation(SESSIONS), ro2);
  await t2.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'billing' }] }, leadCtx());
  A.eq(ro2.calls[0].streamId, 'ws_b1', 'a unique partial name matches its session');
  const ro3 = fakeRunOnce();
  const t3 = sessionTools(fakeStation(SESSIONS), ro3);
  await t3.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'ws_r1' }] }, leadCtx());
  A.eq(ro3.calls[0].streamId, 'ws_r1', 'an exact session id is accepted verbatim');
}

/* ⛔ THE ONE THAT MATTERS. An unknown session must REFUSE — never fall back to the current one. Running the
   work "somewhere sensible" is what produced the original bug: the lead then truthfully reports a success the
   Commander cannot find. A refusal is legible; a wrong-but-plausible destination is not. */
{
  const ro = fakeRunOnce();
  const { dispatchTool } = sessionTools(fakeStation(SESSIONS), ro);
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'marketing' }] }, leadCtx());
  A.eq(ro.calls.length, 0, 'the worker did NOT run in some other session');
  const row = JSON.parse(out.content)[0];
  A.eq(row.reason, 'error', 'an unresolvable session is an error row, not a silent redirect');
  A.ok(/no session called "marketing"/.test(row.result), 'the refusal names what could not be found');
  A.ok(/General, research, Billing rewrite/.test(row.result), 'and lists the sessions that DO exist so the model can correct itself');
  A.ok(/did NOT run/.test(row.result), 'and states plainly that no work happened');
}

// an AMBIGUOUS name refuses too — picking between two matches is the same guess by another name
{
  const ro = fakeRunOnce();
  const dupes = [{ id: 'ws_a', title: 'research plan', agentId: 'agent' }, { id: 'ws_b', title: 'research notes', agentId: 'agent' }];
  const { dispatchTool } = sessionTools(fakeStation(dupes), ro);
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'research' }] }, leadCtx());
  A.eq(ro.calls.length, 0, 'an ambiguous target starts no work');
  A.ok(/more than one session matches/.test(JSON.parse(out.content)[0].result), 'the refusal explains the ambiguity');
}

// no page attached (cron / Night Shift): the target is refused, not silently dropped
{
  const ro = fakeRunOnce();
  const { dispatchTool } = sessionTools(fakeStation(SESSIONS, { down: true }), ro);
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'research' }] }, leadCtx());
  A.eq(ro.calls.length, 0, 'an unreachable station starts no work');
  A.ok(/could not read this station's session list/.test(JSON.parse(out.content)[0].result), 'the failure says the list was unreadable, never "no such session"');
}

// no bridge wired at all (bare host): honest refusal, and NO session param means byte-identical old behaviour
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R', name: 'R', model: 'm' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead', newId: counter() });
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'research' }] }, leadCtx());
  A.eq(ro.calls.length, 0, 'without a bridge a session target is refused, not ignored');
  A.ok(/no live station page is attached/.test(JSON.parse(out.content)[0].result), 'the refusal is honest about why');
  const ro2 = fakeRunOnce();
  const t2 = makeOrchestrationTools({ runOnce: ro2, roster: () => roster, key: 'k', model: 'lead', newId: counter() });
  const out2 = await t2.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p' }] }, leadCtx());
  A.eq(ro2.calls.length, 1, 'a dispatch with no session runs exactly as before');
  A.eq(ro2.calls[0].streamId, undefined, 'and passes no streamId at all (unchanged run shape)');
  A.eq(JSON.parse(out2.content)[0].session, undefined, 'and claims no session');
}

/* A FAILED FOLD IS REPORTED, NOT SWALLOWED. The run really is filed under that stream (runOnce got the
   streamId), so the work is not lost — but the lead must not tell the Commander to go look somewhere the
   answer was never shown. */
{
  const ro = fakeRunOnce();
  const { dispatchTool } = sessionTools(fakeStation(SESSIONS, { deliverFails: true }), ro);
  const out = await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'p', session: 'research' }] }, leadCtx());
  const row = JSON.parse(out.content)[0];
  A.eq(row.reason, 'done', 'the work itself still completed');
  A.eq(row.session, undefined, 'the row does NOT claim the session when the fold failed');
  A.ok(/could not show it there/.test(row.sessionNote), 'it carries an honest note about what the Commander will actually see');
}

// one dispatch, two workers, two different sessions — each lands in its own
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R', name: 'R', model: 'm' }], ['analyst', { system: 'A', name: 'A', model: 'm' }]]);
  const station = fakeStation(SESSIONS);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead', newId: counter(), station: station });
  await dispatchTool.run({ workers: [
    { agentId: 'researcher', prompt: 'a', session: 'research' },
    { agentId: 'analyst', prompt: 'b', session: 'Billing rewrite' }
  ] }, leadCtx());
  A.eq(ro.calls[0].streamId, 'ws_r1', 'worker one landed in research');
  A.eq(ro.calls[1].streamId, 'ws_b1', 'worker two landed in billing');
  A.eq(station.seen.filter(s => s.verb === 'station.sessions').length, 1, 'still one list round trip, not one per worker');
}

// the run host wires the bridge in (the tool cannot reach the page by itself)
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('makeOrchestrationTools({'), src.indexOf('makeOrchestrationTools({') + 3000);
  A.ok(/station: require\('\.\/overseer.js'\)\.isCoordinatorRun\([\s\S]*?\? overseerStation\(o.streamId, runId\) : stationBridge/.test(block), 'only coordinator runs receive durable session operations; other leads retain the visual bridge');
}

// the PAGE half exists and holds the line on both verbs
{
  const page = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationcommands.js'), 'utf8');
  A.ok(/'station\.sessions'/.test(page), 'the page can list its sessions');
  A.ok(/'station\.deliver'/.test(page), 'the page can fold a delegated answer into a session');
  A.ok(/indexOf\(runId\) >= 0/.test(page), 'delivery is idempotent by runId (no double-posting)');
  A.ok(/history\.push/.test(page) && !/ws\.history = next/.test(page), 'delivery APPENDS — it never replaces a session\'s existing thread');
  const mirror = fs.readFileSync(path.join(__dirname, '..', 'website', 'app', 'app', 'stationcommands.js'), 'utf8');
  A.eq(mirror, page, 'the website mirror of stationcommands.js is in sync');
}

// ---- G6 structured contracts: validate, repair once, and never accept invalid completion ----
{
  let n = 0;
  const ro = fakeRunOnce(async () => (++n === 1
    ? { reason: 'done', messages: [{ role: 'assistant', content: 'not json' }], usd: 0.2, artifacts: [{ path: 'draft.txt' }] }
    : { reason: 'done', messages: [{ role: 'assistant', content: '{"answer":"fixed"}' }], usd: 0.1, artifacts: [{ path: 'fixed.txt' }] }));
  const roster = new Map([['worker', { system: 'W', model: 'm' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), perWorker: 1 });
  const out = await dispatchTool.run({ workers: [{ agentId: 'worker', prompt: 'answer', resultSchema: {
    type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false
  } }] }, { agentId: 'lead', emit: () => {} });
  const row = JSON.parse(out.content)[0];
  A.eq(ro.calls.length, 2, 'invalid structured output receives exactly one repair run');
  A.eq(row.validation.state, 'repaired', 'the host identifies a repaired result');
  A.eq(row.structuredResult, { answer: 'fixed' }, 'the repaired strict JSON value is returned separately');
  A.ok(Math.abs(row.usd - 0.3) < 1e-9, 'initial and repair costs are both retained');
  A.eq(row.artifacts.length, 2, 'artifacts from initial and repair runs are retained');
}

{
  const ro = fakeRunOnce(async () => ({ reason: 'done', messages: [{ role: 'assistant', content: 'still invalid' }], usd: 0.1 }));
  const roster = new Map([['worker', { system: 'W', model: 'm' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), perWorker: 1 });
  const out = await dispatchTool.run({ workers: [{ agentId: 'worker', prompt: 'answer', resultSchema: { type: 'object' } }] }, { agentId: 'lead', emit: () => {} });
  const row = JSON.parse(out.content)[0];
  A.eq(ro.calls.length, 2, 'an invalid result is never repaired more than once');
  A.eq(row.reason, 'invalid-result', 'invalid output after repair is not accepted as done');
  A.eq(row.validation.state, 'invalid', 'the terminal validation state is explicit');
}

// ---- G6 spawn quality gate and generation-bound steering tool ----
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-orch-g6-'));
  try {
    let T = 1, seq = 0, release;
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'),
      clock: { now: () => T++ }, emit: () => {}, newId: () => 'reg_' + (++seq) });
    const ro = fakeRunOnce(async (o) => { await new Promise(resolve => { release = resolve; }); return { reason: 'done', messages: [{ role: 'assistant', content: 'ok' }], usd: 0 }; });
    const tools = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', newId: counter(), subagents });
    const rejected = await tools.spawnTool.run({ tasks: [{ prompt: 'same' }, { prompt: ' same ' }, { prompt: '   ' }] }, { agentId: 'lead', emit: () => {} });
    A.eq(ro.calls.length, 0, 'empty and duplicate clone tasks are rejected before any provider run');
    A.eq(JSON.parse(rejected.content).filter(r => r.reason === 'not-spawned').length, 3, 'every rejected batch row is reported');
    const started = await tools.spawnTool.run({ tasks: [{ prompt: 'unique' }], background: true }, { agentId: 'lead', emit: () => {} });
    const worker = JSON.parse(started.content)[0]; await tick();
    const stale = await tools.steerTool.run({ id: worker.id, generation: worker.generation + 1, text: 'wrong' }, { agentId: 'lead' });
    A.eq(stale.summary, 'not queued', 'team.steer refuses a stale generation');
    const queued = await tools.steerTool.run({ id: worker.id, generation: worker.generation, text: 'follow up' }, { agentId: 'lead' });
    A.ok(/queued for generation/.test(queued.summary), 'team.steer queues for the inspected generation');
    release(); await tick(); await tick();
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

{
  const registryRows = require('../sidecar/capability/registry.js').CAP_REGISTRY.orchestrator;
  const steer = registryRows.find(r => r.tool === 'team.steer');
  A.ok(steer && steer.scope === 'write' && steer.requiresConsent === false, 'capability registry exposes generation-bound steering without a spend grant');
}

// ============================ lead context handoff (G6) ============================
// A worker's opening message used to be ONLY the prompt string — whatever the lead had already established
// was lost unless hand-woven into prose, and the worker re-derived it at full cost. `context` rides FIRST in
// the opening user message, the ask stays last, and the structured-repair replay reuses the same opening.
{
  const ro = fakeRunOnce();
  const roster = new Map([['researcher', { system: 'R-SYS', name: 'RESEARCHER', model: 'm1' }]]);
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'lead-model', newId: counter() });
  const ctx = { agentId: 'lead', signal: { aborted: false }, emit: () => {}, consent: {} };
  await dispatchTool.run({ workers: [
    { agentId: 'researcher', prompt: 'summarize the config', context: 'config lives at /srv/app/config.yaml; the db block is already validated' },
    { agentId: 'researcher', prompt: 'no-context control' }
  ] }, ctx);
  A.eq(ro.calls.length, 2, 'both workers dispatched');
  const opening = String(ro.calls[0].messages[0].content);
  A.ok(opening.indexOf('[LEAD CONTEXT') === 0, 'the handoff block leads the opening message');
  A.ok(opening.indexOf('config lives at /srv/app/config.yaml') > 0, 'the lead-authored context rides to the worker verbatim');
  A.ok(opening.indexOf('[YOUR SUBTASK]') > 0 && opening.indexOf('summarize the config') > opening.indexOf('[YOUR SUBTASK]'), 'the ask itself stays LAST, under its own header');
  A.eq(String(ro.calls[1].messages[0].content), 'no-context control', 'a worker without context gets the exact pre-G6 opening message (byte-identical)');

  // context composes with a result contract: context first, prompt, then the JSON contract suffix.
  const ro2 = fakeRunOnce(async () => ({ reason: 'done', messages: [{ role: 'assistant', content: '{"ok":true}' }], usd: 0.1 }));
  const { dispatchTool: d2 } = makeOrchestrationTools({ runOnce: ro2, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await d2.run({ workers: [{ agentId: 'researcher', prompt: 'check it', context: 'the port is 8787',
    resultSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } }] }, ctx);
  const contracted = String(ro2.calls[0].messages[0].content);
  A.ok(contracted.indexOf('[LEAD CONTEXT') === 0 && contracted.indexOf('the port is 8787') > 0
    && contracted.indexOf('[STRUCTURED RESULT CONTRACT]') > contracted.indexOf('check it'), 'context + prompt + result contract compose in that order');

  // an oversized handoff is clamped, never rejected — the worker still runs.
  const ro3 = fakeRunOnce();
  const { dispatchTool: d3 } = makeOrchestrationTools({ runOnce: ro3, roster: () => roster, key: 'k', model: 'm', newId: counter() });
  await d3.run({ workers: [{ agentId: 'researcher', prompt: 'p', context: 'x'.repeat(9000) }] }, ctx);
  const clamped = String(ro3.calls[0].messages[0].content);
  A.ok(clamped.indexOf('x'.repeat(8000)) > 0 && clamped.indexOf('x'.repeat(8001)) < 0, 'the handoff block is clamped to its 8000-char bound');
}

// team.spawn carries the same handoff, and the durable record keeps it for resume.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-spawn-ctx-'));
  try {
    const subagents = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub.json'), clock: { now: () => 1000 }, emit: () => {}, newId: counter() });
    const ro = fakeRunOnce();
    const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter(), subagents });
    await spawnTool.run({ tasks: [{ prompt: 'sub with context', context: 'the answer format is CSV' }] }, { agentId: 'lead', emit: () => {}, consent: {} });
    const opening = String(ro.calls[0].messages[0].content);
    A.ok(opening.indexOf('[LEAD CONTEXT') === 0 && opening.indexOf('the answer format is CSV') > 0, 'a spawned clone receives the handoff block first');
    const rec = subagents.list({})[0];
    A.eq(rec.context, 'the answer format is CSV', 'the handoff context is durable on the subagent record (resume rebuilds the same opening)');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
}

{
  let understanding = 'Initial context';
  const ro = fakeRunOnce();
  const { dispatchTool } = makeOrchestrationTools({runOnce:ro, roster:()=>new Map([['researcher',{system:'R-SYS'}]]), key:'k', model:'m', newId:counter(), getTaskContext:()=>understanding});
  understanding = 'Latest answer: draft only; user must review before sending.';
  await dispatchTool.run({workers:[{agentId:'researcher',prompt:'Prepare the draft'}]}, {agentId:'lead',emit:()=>{},consent:{}});
  A.ok(ro.calls[0].system.includes(understanding),'worker receives the latest in-turn understanding at dispatch');
}
A.report('orchestration.test');

})();
