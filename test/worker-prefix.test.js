/* node test/worker-prefix.test.js — THE WORKER PREFIX (cost lane W1.10, 2026-11-09): every delegated surface composes its
   prompt through the ONE resolver (orchestration.js workerPrompt), driven against a FAKE runOnce (no key, no network).

   The law: nothing volatile in a cached prefix. A delegated run's `system` is its identity and its approval posture, plus
   the fixed [DELEGATED EXECUTION] line when a task context exists, and nothing else, so two dispatches of one agent with
   different tasks send the same bytes. The task context (the lead's Task Brief with its per-run tb_ id, the lead's
   query-ranked recall and the Commander's taste) is handed to the run whole, in the same words, as `delegatedContext`;
   runOnce places it in the opening message's <run_context> note (test/worker-prefix.e2e.test.js proves that placement
   through the real request assembly, the repair's and the kill switch's too).

   Surfaces: a foreground team.dispatch worker and its structured-result repair, a background dispatch, team.spawn clones
   (foreground and background), and team.resume of an interrupted worker. With no task context the system keeps its
   pre-lane bytes (identity + posture) and nothing is handed on. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeSubagentManager } = require('../sidecar/subagents.js');

const EXEC = '[DELEGATED EXECUTION] Treat the [TASK CONTEXT] block handed to you with this task as settled input from the Commander. Do not ask the Commander another discovery question. If a truly blocking gap remains, report that gap to the lead agent.';
// one lead turn's task context: its own Task Brief (per-run id) and recall ranked by its own request
const contextOf = n => '<task_brief id="tb_lead-run-' + n + '" status="ready">\n\nORIGINAL REQUEST: request number ' + n + '\n\n</task_brief>'
  + '\n\n<recalled-memory>\n[recalled]\n• recall ranked for request ' + n + '\n</recalled-memory>';
const handed = n => '[TASK CONTEXT]\n' + contextOf(n);

function fakeRunOnce(impl) {
  const calls = [];
  const fn = async (o) => { calls.push(o); return impl ? impl(o) : { reason: 'done', messages: [{ role: 'assistant', content: 'out:' + o.agentId }], usd: 0 }; };
  fn.calls = calls;
  return fn;
}
const counter = () => { let n = 0; return () => 'child_' + (++n); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const lead = () => ({ agentId: 'lead', emit: () => {}, consent: {} });
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'sk-worker-prefix-' + name + '-'));
const rm = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} };
const subagentsAt = (dir, now) => makeSubagentManager({ fs, pathMod: path, file: path.join(dir, 'subagents.json'), clock: { now: () => now || 1000 }, emit: () => {}, newId: counter() });
const posture = () => 'full';

// identity + approval posture exactly as a worker with NO task context receives it (the pre-lane bytes)
async function identityWithPosture(identity) {
  const ro = fakeRunOnce();
  const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map([['w', { system: identity }]]), key: 'k', model: 'm', newId: counter(), approvalPosture: posture });
  await dispatchTool.run({ workers: [{ agentId: 'w', prompt: 'x' }] }, lead());
  return ro.calls[0].system;
}

// the shared check: two delegated runs of one agent with different task contexts
function samePrefix(a, b, base, label) {
  A.eq(b.system, a.system, label + ': the system prompt is BYTE-IDENTICAL across two dispatches with different tasks');
  A.eq(a.system, base + '\n\n' + EXEC, label + ': the system is the identity + posture + the fixed [DELEGATED EXECUTION] line, nothing else');
  A.ok(String(a.system).indexOf('tb_') < 0 && String(a.system).indexOf('ORIGINAL REQUEST') < 0 && String(a.system).indexOf('recall ranked') < 0, label + ': no brief id, request or recall in the system');
  A.eq(a.delegatedContext, handed(1), label + ': dispatch 1 is handed its whole task context, same words');
  A.eq(b.delegatedContext, handed(2), label + ': dispatch 2 is handed its own whole task context, same words');
}

(async () => {
  const R = await identityWithPosture('R-SYS');
  const LEAD = await identityWithPosture('LEAD-SYS');
  A.ok(R.indexOf('R-SYS\n\n[DELEGATED APPROVAL') === 0 && R.indexOf('FULL ACCESS') > 0, 'the posture note follows the identity (control)');

  // ---- a foreground team.dispatch worker, twice, and its structured-result repair ----
  {
    let live = contextOf(1);
    const ro = fakeRunOnce(async (o) => ({ reason: 'done', messages: [{ role: 'assistant', content: /HAIKU/.test(JSON.stringify(o.messages)) && !o.outputOnly ? 'not json' : '{"haiku":"granite"}' }], usd: 0 }));
    const roster = new Map([['researcher', { system: 'R-SYS', model: 'm' }]]);
    const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), getTaskContext: () => live, approvalPosture: posture, perWorker: 1 });
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'find three tide facts' }] }, lead());
    live = contextOf(2);
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'HAIKU about granite', resultSchema: { type: 'object', required: ['haiku'], properties: { haiku: { type: 'string' } } } }] }, lead());
    A.eq(ro.calls.length, 3, 'two dispatches and one structured-result repair ran');
    const [d1, d2, repair] = ro.calls;
    samePrefix(d1, d2, R, 'foreground dispatch');
    A.eq(d1.messages[d1.messages.length - 1].content, 'find three tide facts', 'foreground dispatch: the opening message is the subtask alone (the context is a host note, never the worker\'s own words)');
    A.ok(repair && repair.outputOnly === true, 'the invalid structured result got its one repair run');
    A.eq(repair && repair.system, d2.system, 'the repair keeps the worker\'s system bytes');
    A.eq(repair && repair.delegatedContext, handed(2), 'the repair is handed the same whole task context');
  }

  // ---- a background dispatch, twice ----
  {
    const dir = tmp('bg');
    try {
      let live = contextOf(1);
      const ro = fakeRunOnce();
      const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map([['researcher', { system: 'R-SYS' }]]), key: 'k', model: 'm', newId: counter(), subagents: subagentsAt(dir), getTaskContext: () => live, approvalPosture: posture });
      await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }], background: true }, lead());
      await tick(); await tick();
      live = contextOf(2);
      await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'y' }], background: true }, lead());
      await tick(); await tick();
      A.eq(ro.calls.length, 2, 'background dispatch: two worker runs');
      samePrefix(ro.calls[0] || {}, ro.calls[1] || {}, R, 'background dispatch');
    } finally { rm(dir); }
  }

  // ---- team.spawn clones of the lead, foreground and background ----
  {
    const dir = tmp('spawn');
    try {
      let live = contextOf(1);
      const ro = fakeRunOnce();
      const { spawnTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'LEAD-SYS', newId: counter(), subagents: subagentsAt(dir), getTaskContext: () => live, approvalPosture: posture });
      await spawnTool.run({ tasks: [{ prompt: 'clone one' }] }, lead());
      live = contextOf(2);
      await spawnTool.run({ tasks: [{ prompt: 'clone two' }], background: true }, lead());
      await tick(); await tick();
      A.eq(ro.calls.length, 2, 'team.spawn: two clone runs');
      samePrefix(ro.calls[0] || {}, ro.calls[1] || {}, LEAD, 'team.spawn');
    } finally { rm(dir); }
  }

  // ---- team.resume of an interrupted worker: the same prefix a fresh dispatch of that agent sends ----
  {
    const dir = tmp('resume');
    try {
      const subagents = subagentsAt(dir);
      const rec = subagents.start({ leadId: 'lead', agentId: 'researcher', prompt: 'retry', runId: 'run_before' }, async () => new Promise(() => {}));
      await tick();
      subagents.interrupt(rec.id, 'lead');
      let live = contextOf(1);
      const ro = fakeRunOnce();
      const roster = new Map([['researcher', { system: 'R-SYS' }]]);
      const { resumeTool, dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => roster, key: 'k', model: 'm', newId: counter(), subagents: subagentsAt(dir, 1001), getTaskContext: () => live, approvalPosture: posture });
      await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'fresh' }] }, lead());
      live = contextOf(2);
      const out = await resumeTool.run({ id: rec.id }, lead());
      A.eq(out.summary, 'resumed', 'team.resume restarted the interrupted worker');
      await tick(); await tick();
      A.eq(ro.calls.length, 2, 'team.resume: a fresh dispatch and the resumed run');
      samePrefix(ro.calls[0] || {}, ro.calls[1] || {}, R, 'team.resume');
    } finally { rm(dir); }
  }

  // ---- no task context: the pre-lane bytes, nothing handed on ----
  {
    const ro = fakeRunOnce();
    const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map([['researcher', { system: 'R-SYS' }]]), key: 'k', model: 'm', newId: counter(), getTaskContext: () => '', approvalPosture: posture });
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, lead());
    A.eq(ro.calls[0].system, R, 'no task context: the system is the identity + posture, as before the lane');
    A.ok(!ro.calls[0].delegatedContext, 'no task context: nothing is handed on');
    const ro2 = fakeRunOnce();
    const { dispatchTool: bare } = makeOrchestrationTools({ runOnce: ro2, roster: () => new Map([['researcher', { system: 'R-SYS' }]]), key: 'k', model: 'm', newId: counter() });
    await bare.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, lead());
    A.eq(ro2.calls[0].system, 'R-SYS', 'no host context and no posture wired: the system is the identity, byte-identical to before');
    A.ok(!ro2.calls[0].delegatedContext, 'and nothing is handed on');
  }

  // ---- a host that wires only the static taskContext string gets the same split ----
  {
    const ro = fakeRunOnce();
    const { dispatchTool } = makeOrchestrationTools({ runOnce: ro, roster: () => new Map([['researcher', { system: 'R-SYS' }]]), key: 'k', model: 'm', newId: counter(), taskContext: contextOf(1) });
    await dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'x' }] }, lead());
    A.eq(ro.calls[0].system, 'R-SYS\n\n' + EXEC, 'static taskContext: the system is the identity + the fixed line');
    A.eq(ro.calls[0].delegatedContext, handed(1), 'static taskContext: the context is handed on whole');
  }

  A.report('worker-prefix');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
