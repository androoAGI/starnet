/* node test/subagents.stop-cascade.test.js — Step 2 F2 of the 2026-09-22 Hermes audit: Stop reaches background
   workers.

   Audit probe D3: a lead run started a background worker and was cancelled; the worker kept `running` (and
   spending) because it owns its own AbortController, deliberately NOT chained to the lead's signal. Now every
   worker record carries the run that started its current generation (parentRunId), and a cancelled parent run
   cancels its workers — and theirs — through subagents.cancelChildren (index.js calls it when a run's signal
   aborts while its loop is live; a lead that ENDS normally detaches first). Honest state: `interrupted`,
   cancelledBy 'parent', a reason naming the parent run, resumable, and no overseer review turn for a stop the
   Commander just made. Generation fences hold: a resumed worker follows the run that resumed it.

   Deterministic: the real subagents.js manager + the real orchestration tools over a fake run host, temp dirs. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSubagentManager } = require('../sidecar/subagents.js');
const { makeOrchestrationTools } = require('../sidecar/tools/builtin/orchestration.js');
const { makeOverseer } = require('../sidecar/overseer.js');

const tick = () => new Promise(resolve => setImmediate(resolve));
const counter = (p) => { let n = 0; return () => (p || 'id_') + (++n); };

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sub-cascade-'));
  try {
    const file = path.join(root, 'subagents.json');
    let T = 1000;
    const tasks = [];
    const mgr = makeSubagentManager({ fs, pathMod: path, file, clock: { now: () => T++ }, emit: (n, p) => { if (n === 'task') tasks.push(p); }, newId: counter('w_') });
    const held = {};
    const hang = key => async (h) => { held[key] = h; h.emit('agent.run.start', { agentId: 'x', runId: h.runId, trigger: 'directive', model: 'm' }); return new Promise(() => {}); };

    // ---- a cancelled parent run stops exactly its own workers, and their descendants ----
    const a = mgr.start({ leadId: 'agent', agentId: 'researcher', prompt: 'A', parentRunId: 'lead_run_1' }, hang('a'));
    const b = mgr.start({ leadId: 'agent', agentId: 'analyst', prompt: 'B', parentRunId: 'lead_run_1' }, hang('b'));
    const other = mgr.start({ leadId: 'agent', agentId: 'scribe', prompt: 'C', parentRunId: 'lead_run_2' }, hang('other'));
    const orphan = mgr.start({ leadId: 'agent', agentId: 'scout', prompt: 'D' }, hang('orphan'));   // Commander-resumed shape: no parent run
    await tick();
    const grandchild = mgr.start({ leadId: 'researcher', agentId: 'helper', prompt: 'A.1', parentRunId: a.runId }, hang('grand'));
    await tick();
    A.eq(mgr.get(a.id).parentRunId, 'lead_run_1', 'the durable record carries the run that started it');

    const n = mgr.cancelChildren('lead_run_1');
    A.eq(n, 3, 'two direct workers + one descendant cancelled');
    for (const k of ['a', 'b', 'grand']) {
      A.ok(held[k].signal.aborted, k + ': its run signal was aborted');
      A.eq(held[k].signal.reason && held[k].signal.reason.code, 'parent_cancelled', k + ': the abort reason says WHY (parent_cancelled)');
    }
    for (const r of [a, b, grandchild]) {
      const rec = mgr.get(r.id);
      A.eq(rec.status, 'interrupted', r.prompt + ': honest status interrupted');
      A.eq(rec.cancelledBy, 'parent', r.prompt + ': cancelledBy parent');
      A.ok(rec.completedAt > 0 && rec.canResume === true, r.prompt + ': settled and resumable');
    }
    A.ok(/lead_run_1 was cancelled/.test(mgr.get(a.id).reason), 'the reason names the cancelled parent run: ' + mgr.get(a.id).reason);
    A.ok(/parent worker .* was cancelled/.test(mgr.get(grandchild.id).reason), 'a descendant names its cancelled parent worker');
    A.ok(!held.other.signal.aborted && mgr.get(other.id).status === 'running', 'a worker of ANOTHER run is untouched');
    A.ok(!held.orphan.signal.aborted && mgr.get(orphan.id).status === 'running', 'a worker with no parent run is untouched');
    A.eq(mgr.activeRuns().map(r => r.subagentId).sort(), [other.id, orphan.id].sort(), 'reconnect truth: only the untouched workers are still live');
    // review 8.2: a stop is its own outcome on the bus too — never published as failed work (the page played the failure sting for it)
    A.ok(tasks.filter(t => t.status === 'stopped' && t.outcome === 'stopped').length >= 3 && !tasks.some(t => t.status === 'failed'), 'each cancelled worker published a stopped task event, never a failed one');
    A.eq(mgr.cancelChildren('lead_run_1'), 0, 'idempotent: a second cancel finds nothing live');
    A.eq(mgr.cancelChildren(''), 0, 'an empty parent id cancels nothing');

    // ---- the aborted runner settling late never rewrites the verdict ----
    {
      let finish;
      const w = mgr.start({ leadId: 'agent', agentId: 'researcher', prompt: 'late', parentRunId: 'lead_run_3' }, () => new Promise(res => { finish = res; }));
      await tick();
      mgr.cancelChildren('lead_run_3');
      finish({ status: 'done', reason: 'done', result: 'I finished anyway', usd: 0.2 });
      await tick(); await tick();
      A.eq(mgr.get(w.id).status, 'interrupted', 'a late "done" from the aborted generation does not overwrite interrupted');
      A.ok(mgr.get(w.id).result !== 'I finished anyway', 'nor does its result land as finished work');
    }

    // ---- generation fence: a resumed worker follows the run that RESUMED it ----
    {
      const r = mgr.resume(a.id, hang('a2'), { parentRunId: 'lead_run_9' });
      A.ok(r.ok, 'the parent-cancelled worker is resumable');
      await tick();
      A.eq(mgr.get(a.id).generation, 2, 'a new generation');
      A.eq(mgr.get(a.id).parentRunId, 'lead_run_9', 'the new generation follows the resuming run');
      A.eq(mgr.get(a.id).cancelledBy, '', 'the new generation starts clean');
      A.eq(mgr.cancelChildren('lead_run_1'), 0, 'the OLD parent run can no longer reach it');
      A.ok(!held.a2.signal.aborted, 'the resumed generation keeps running');
      A.eq(mgr.cancelChildren('lead_run_9'), 1, 'the resuming run cancels it');
      A.ok(held.a2.signal.aborted, 'aborted');
    }

    // ---- durable: a restart keeps the honest verdict (not re-staled, not resurrected) ----
    {
      const reloaded = makeSubagentManager({ fs, pathMod: path, file, clock: { now: () => T++ }, emit: () => {}, newId: counter('r_') });
      const rec = reloaded.get(b.id);
      A.eq(rec.status, 'interrupted', 'after restart the cancelled worker is still interrupted');
      A.eq(rec.cancelledBy, 'parent', 'and still says its parent cancelled it');
      A.eq(reloaded.get(other.id).status, 'stale', 'while a worker that was genuinely running when the process died is staled as before');
    }

    // ---- no overseer review turn for a Stop the Commander just pressed ----
    {
      const ov = makeOverseer({ fs, path, file: path.join(root, 'overseer.json'), now: () => T++, newId: counter('ws_'),
        sessions: () => ({ generalId: 'home', workstreams: [{ id: 'home', title: null, agentId: 'agent' }], deletedIds: [] }), hasAgent: () => true });
      const base = { leadId: 'agent', parentStreamId: 'home', completedAt: 5, generation: 1 };
      ov.collect([
        Object.assign({}, base, { id: 'w1', runId: 'run_w1', status: 'interrupted', cancelledBy: 'parent' }),
        Object.assign({}, base, { id: 'w2', runId: 'run_w2', status: 'interrupted', cancelledBy: '' }),
        Object.assign({}, base, { id: 'w3', runId: 'run_w3', status: 'stale', cancelledBy: '' })
      ]);
      const ids = ov.snapshot().reviews.map(r => r.workerId).sort();
      A.eq(ids, ['w2', 'w3'], 'a parent-cancelled worker gets no review turn; an interrupted/stale one still does');
    }

    // ---- through the real orchestration tools: team.spawn/team.dispatch(background) stamp the lead run ----
    {
      const mgr2 = makeSubagentManager({ fs, pathMod: path, file: path.join(root, 'sub2.json'), clock: { now: () => T++ }, emit: () => {}, newId: counter('s_') });
      const signals = [];
      const runOnce = async (o) => {
        signals.push(o.signal);
        o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'directive', model: 'm' });
        await new Promise(res => { if (o.signal.aborted) res(); else o.signal.addEventListener('abort', res, { once: true }); });
        return { reason: 'cancelled', messages: [{ role: 'assistant', content: 'partial notes' }], usd: 0.05 };
      };
      const roster = new Map([['researcher', { system: 'R', name: 'R', model: 'm' }]]);
      const tools = makeOrchestrationTools({ runOnce, roster: () => roster, key: 'k', model: 'm', selfSystem: 'S', newId: counter('o_'), subagents: mgr2 });
      const ctx = { agentId: 'agent', runId: 'lead_live', emit: () => {} };
      const spawned = JSON.parse((await tools.spawnTool.run({ tasks: [{ prompt: 'bg clone' }], background: true }, ctx)).content)[0];
      const dispatched = JSON.parse((await tools.dispatchTool.run({ workers: [{ agentId: 'researcher', prompt: 'bg work' }], background: true }, ctx)).content)[0];
      await tick();
      A.eq(mgr2.get(spawned.id).parentRunId, 'lead_live', 'team.spawn background stamps the lead run id');
      A.eq(mgr2.get(dispatched.id).parentRunId, 'lead_live', 'team.dispatch background stamps the lead run id');
      A.eq(mgr2.cancelChildren('lead_live'), 2, 'cancelling the lead run reaches both');
      await tick(); await tick();
      A.ok(signals.every(s => s.aborted), 'both worker runs were aborted');
      A.eq(mgr2.get(spawned.id).status, 'interrupted', 'spawned worker: interrupted');
      A.eq(mgr2.get(dispatched.id).status, 'interrupted', 'dispatched worker: interrupted (the runner\'s late result did not overwrite it)');

      // a FOREGROUND spawn clone cancelled by its parent reports it honestly to the (awaiting) lead
      const pending = tools.spawnTool.run({ tasks: [{ prompt: 'fg clone', label: 'fg' }] }, { agentId: 'agent', runId: 'lead_fg', emit: () => {} });
      await tick();
      mgr2.cancelChildren('lead_fg');
      const rows = JSON.parse((await pending).content);
      A.eq(rows[0].reason, 'cancelled', 'the foreground row says cancelled, never done');
      A.ok(/run that started this worker was cancelled/.test(rows[0].result) && /partial notes/.test(rows[0].result), 'and keeps its partial text, labelled as partial: ' + rows[0].result);
    }
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  A.report('subagents.stop-cascade.test');
})();
