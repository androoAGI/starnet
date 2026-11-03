/* node test/subagents.stale-worker.test.js — Step 2 F3 of the 2026-09-22 Hermes audit: a hung background worker
   is detected and stopped instead of staying `running` forever.

   Background workers have no wall clock by design and iteration/$ caps default off (a locked decision), so a worker
   wedged on a silent provider or a dead tool used to sit `running` with no result for the lead or the overseer
   hand-back to act on. subagents.checkStalls (host sweep, injected clock here) is a no-PROGRESS check, not a duration
   cap: quiet for STALL_MS (default 450s) between tool calls — or IN_TOOL_STALL_MS (default 1200s) while a tool call
   is still running — and the worker is marked `stale` with an honest reason and a finalization receipt, its run is
   aborted with reason worker_stalled, and anything it started is cancelled. Any progress event resets the clock.

   Deterministic: the real manager over a temp dir, a hand-driven clock, no timers. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const counter = (p) => { let n = 0; return () => (p || 'id_') + (++n); };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sub-stale-'));
  try {
    let T = 1000000;
    const clock = { now: () => T };
    const tasks = [], hookCalls = [];
    const hooks = { invoke: (name, p) => { hookCalls.push({ name, p }); return Promise.resolve(null); } };
    const mgr = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'subagents.json'), clock,
      emit: (n, p) => { if (n === 'task') tasks.push(p); }, newId: counter('w_'), hooks });
    A.eq(mgr.stallPolicy(), { stallMs: 450000, inToolStallMs: 1200000 }, 'defaults mirror Hermes: 450s idle / 1200s in-tool');

    const held = {};
    const hang = key => async (h) => { held[key] = h; h.emit('agent.run.start', { agentId: 'x', runId: h.runId, trigger: 'directive', model: 'm' }); return new Promise(() => {}); };

    // ---- a silent worker: alive until the threshold, stale after it ----
    const w = mgr.start({ leadId: 'agent', agentId: 'researcher', prompt: 'hang forever', parentRunId: 'lead_1', parentStreamId: 'home' }, hang('w'));
    await tick();
    T += 449999;
    A.eq(mgr.checkStalls(), [], '449.999s of quiet is not a stall');
    A.eq(mgr.get(w.id).status, 'running', 'still running just under the threshold');
    T += 1;
    const stalled = mgr.checkStalls();
    A.eq(stalled.map(s => s.id), [w.id], 'at 450s of quiet the sweep stops it');
    const rec = mgr.get(w.id);
    A.eq(rec.status, 'stale', 'honest status: stale');
    A.eq(rec.stalledAfterMs, 450000, 'records how long it was quiet');
    A.ok(/^stalled: no progress for 450s/.test(rec.reason), 'the reason says it stalled and for how long: ' + rec.reason);
    A.ok(/INCOMPLETE/.test(rec.result) && /do not present it as done/.test(rec.result), 'the result the lead/overseer reads says the work is incomplete');
    A.ok(rec.completedAt > 0 && rec.canResume === true, 'settled and resumable');
    A.eq(rec.finalization && rec.finalization.state, 'delivered', 'a finalization receipt was committed and delivered');
    A.ok(held.w.signal.aborted, 'its run was aborted');
    A.eq(held.w.signal.reason && held.w.signal.reason.code, 'worker_stalled', 'with the worker_stalled reason');
    // review 8.2: the task feed says the worker's outcome (RunOutcome.ofWorker: a liveness stop is interrupted) — it did not finish, never failed work
    A.ok(tasks.some(t => t.id === w.id && t.status === 'unfinished' && t.outcome === 'interrupted') && !tasks.some(t => t.id === w.id && t.status === 'failed'), 'the task feed shows it did not finish (interrupted), never failed');
    A.ok(hookCalls.some(c => c.name === 'subagent_stop' && c.p.extra.child_status === 'stale'), 'the subagent_stop hook heard about it');
    A.eq(mgr.activeRuns(), [], 'reconnect truth: no longer live');
    A.eq(mgr.checkStalls(), [], 'a stale worker is not stalled twice');
    // the overseer hand-back filters exactly on these fields (overseer.js freshReviews)
    const v = mgr.list({ leadId: 'agent' }).find(r => r.id === w.id);
    A.ok(v.status === 'stale' && v.completedAt > 0 && v.parentStreamId === 'home' && v.cancelledBy === '', 'the listed view is what the overseer hand-back collects');

    // ---- progress resets the clock ----
    const p = mgr.start({ leadId: 'agent', agentId: 'analyst', prompt: 'slow but alive' }, hang('p'));
    await tick();
    T += 400000; held.p.emit('agent.token', { agentId: 'x', runId: held.p.runId, delta: 'thinking…' });
    T += 400000;
    A.eq(mgr.checkStalls(), [], 'a token 400s ago resets the clock (800s since start, 400s quiet)');
    T += 40000; held.p.emit('agent.cost', { agentId: 'x', runId: held.p.runId, usd: 0.01, reconciled: true });
    T += 449000;
    A.eq(mgr.checkStalls(), [], 'a cost booking is progress too');
    T += 1000;
    A.eq(mgr.checkStalls().map(s => s.id), [p.id], 'then 450s of real silence stalls it');

    // ---- an in-flight tool call gets the longer in-tool window ----
    const t = mgr.start({ leadId: 'agent', agentId: 'engineer', prompt: 'long build' }, hang('t'));
    await tick();
    held.t.emit('agent.tool_call', { agentId: 'x', runId: held.t.runId, callId: 'c1', name: 'shell_exec', argsSummary: 'npm run build' });
    T += 1000000;
    A.eq(mgr.checkStalls(), [], 'a 1000s-silent tool call is within the in-tool window');
    held.t.emit('agent.tool_result', { agentId: 'x', runId: held.t.runId, callId: 'c1', ok: true, ms: 1000000, summary: 'exit 0', isError: false });
    T += 449000;
    A.eq(mgr.checkStalls(), [], 'the result closed the tool call and reset the clock');
    held.t.emit('agent.tool_call', { agentId: 'x', runId: held.t.runId, callId: 'c2', name: 'shell_exec', argsSummary: 'npm test' });
    T += 1200000;
    const inTool = mgr.checkStalls();
    A.eq(inTool.map(s => s.id), [t.id], 'a tool call silent for 1200s stalls the worker');
    A.ok(/while a tool call was still running/.test(mgr.get(t.id).reason), 'the reason says it was stuck inside a tool: ' + mgr.get(t.id).reason);

    // ---- a call HELD by the run's spend pool stops the stall clock (bug d3a76db3, review of 8f4267c08) ----
    // A held worker emits nothing while its call waits for room under the shared PER RUN cap; the runner reports the
    // hold through its handle (orchestration.js watchedPool). The held stretch is neither progress nor silence.
    {
      const s = mgr.start({ leadId: 'agent', agentId: 'clone', prompt: 'waits its turn' }, hang('s'));
      await tick();
      A.eq(typeof held.s.holdStall, 'function', 'the runner handle can report a spend-pool hold');
      T += 100000;                    // 100s of real quiet before the call reached the pool
      held.s.holdStall();
      T += 10000000;                  // then held for 10,000s behind a fellow's long call
      A.eq(mgr.checkStalls(), [], 'a worker whose call is held is never stopped as stalled, however long the hold');
      held.s.holdStall(); held.s.releaseStall();
      A.eq(mgr.checkStalls(), [], 'holds nest: one release of two leaves it held');
      held.s.releaseStall();
      A.eq(mgr.checkStalls(), [], 'released: the 100s before the hold still count, the 10,000s held do not');
      T += 349999;
      A.eq(mgr.checkStalls(), [], '449.999s of quiet outside the hold is not a stall');
      held.s.releaseStall();          // an extra release is a no-op (never a negative hold)
      T += 1;
      A.eq(mgr.checkStalls().map(x => x.id), [s.id], 'then 450s of quiet outside the hold stalls it, as before');
      A.eq(mgr.get(s.id).stalledAfterMs, 450000, 'the quiet it reports excludes the held stretch');
      held.s.holdStall();
      A.eq(mgr.get(s.id).status, 'stale', 'a hold reported after the verdict changes nothing');
    }

    // ---- the aborted run settling late never rewrites the stale verdict ----
    {
      let finish;
      const late = mgr.start({ leadId: 'agent', agentId: 'scribe', prompt: 'late settle' }, (h) => { h.emit('agent.run.start', { runId: h.runId }); return new Promise(res => { finish = res; }); });
      await tick();
      T += 450000;
      mgr.checkStalls();
      finish({ status: 'done', reason: 'cancelled', result: 'partial', usd: 0.3 });
      await tick(); await tick();
      A.eq(mgr.get(late.id).status, 'stale', 'the late cancelled/done settle does not overwrite stale');
      A.ok(/INCOMPLETE/.test(mgr.get(late.id).result), 'and the honest result stands');
    }

    // ---- a stalled worker's own children are cancelled with it ----
    {
      const parent = mgr.start({ leadId: 'agent', agentId: 'chief', prompt: 'parent' }, hang('par'));
      await tick();
      const child = mgr.start({ leadId: 'chief', agentId: 'helper', prompt: 'child', parentRunId: parent.runId }, hang('chi'));
      await tick();
      T += 200000;
      held.chi.emit('agent.token', { runId: held.chi.runId, delta: 'busy' });   // the child is alive; its parent is not
      T += 300000;
      A.eq(mgr.checkStalls().map(s => s.id), [parent.id], 'only the silent parent stalls');
      A.eq(mgr.get(child.id).status, 'interrupted', 'its live child is cancelled with it (nobody is left to read the result)');
      A.eq(mgr.get(child.id).cancelledBy, 'parent', 'honestly attributed to the parent');
      A.ok(held.chi.signal.aborted, 'the child run was aborted');
    }

    // ---- a resumed generation starts a fresh clock; the old generation's events cannot keep it alive ----
    {
      const r = mgr.resume(w.id, hang('w2'), {});
      A.ok(r.ok, 'a stale worker can be resumed');
      await tick();
      T += 300000;
      held.w.emit('agent.token', { runId: held.w.runId, delta: 'ghost from generation 1' });
      T += 150000;
      A.eq(mgr.checkStalls().map(s => s.id), [w.id], 'a late event from the aborted generation did not refresh the new one');
      A.eq(mgr.get(w.id).generation, 2, 'the stall is recorded on generation 2');
    }

    // ---- knobs: a custom threshold, and 0 disables the sweep ----
    {
      const m2 = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 's2.json'), clock, emit: () => {}, newId: counter('k_'), stallMs: 5000, inToolStallMs: 1000 });
      A.eq(m2.stallPolicy(), { stallMs: 5000, inToolStallMs: 5000 }, 'the in-tool window is never shorter than the idle window');
      const x = m2.start({ leadId: 'agent', agentId: 'a', prompt: 'x' }, hang('k'));
      await tick();
      T += 5000;
      A.eq(m2.checkStalls().map(s => s.id), [x.id], 'a custom 5s threshold applies');
      const m3 = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 's3.json'), clock, emit: () => {}, newId: counter('z_'), stallMs: 0 });
      m3.start({ leadId: 'agent', agentId: 'a', prompt: 'x' }, hang('z'));
      await tick();
      T += 100000000;
      A.eq(m3.checkStalls(), [], 'stallMs 0 disables the liveness check');
    }

    // ---- a FOREGROUND team.spawn clone that stalls comes back to the awaiting lead as 'stalled', not done ----
    {
      const m4 = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 's4.json'), clock, emit: () => {}, newId: counter('f_') });
      const runOnce = async (o) => {
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
        o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'half an answer' });
        await new Promise(res => o.signal.addEventListener('abort', res, { once: true }));
        return { reason: 'cancelled', messages: [{ role: 'assistant', content: 'half an answer' }], usd: 0.02 };
      };
      const { spawnTool } = makeOrchestrationTools({ runOnce, roster: () => new Map(), key: 'k', model: 'm', selfSystem: 'S', newId: counter('o_'), subagents: m4 });
      const pending = spawnTool.run({ tasks: [{ prompt: 'hangs mid-answer', label: 'hung' }] }, { agentId: 'agent', runId: 'lead_x', emit: () => {} });
      await tick(); await tick();
      T += 450000;
      A.eq(m4.checkStalls().length, 1, 'the hung foreground clone is stalled by the sweep');
      const rows = JSON.parse((await pending).content);
      A.eq(rows[0].reason, 'stalled', 'the lead receives reason stalled');
      A.ok(/made no progress/.test(rows[0].result) && /half an answer/.test(rows[0].result), 'with the partial text labelled as partial: ' + rows[0].result);
    }
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  A.report('subagents.stale-worker.test');
})();
