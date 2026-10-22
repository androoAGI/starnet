/* sidecar/tools/builtin/loops.js -- model-facing durable LOOPS controls.

   A LOOP is iterative work toward an objective; a ROUTINE is clock-driven. These tools deliberately never
   accept, return, or edit the host-run check command. The Commander creates that capability in the trusted UI,
   or the host derives it from an already-approved project. All mutations are consent-gated by orchestrator. */
'use strict';

const PATCHABLE = ['name', 'objective', 'agentId', 'model', 'provider', 'exitOn', 'maxIterations'];

function clean(value, cap) {
  const text = String(value == null ? '' : value).trim();
  return cap && text.length > cap ? text.slice(0, cap) : text;
}

function safeLoop(row) {
  if (!row) return null;
  const out = {};
  for (const key of [
    'id', 'name', 'objective', 'agentId', 'gate', 'state', 'stopReason', 'enabled', 'iterationCount',
    'maxIterations', 'queueCap', 'pendingCount', 'pending', 'approvedCount', 'rejectedCount', 'noopCount',
    'recent', 'exitOn', 'redStreak', 'redStopAfter', 'lastCheck', 'lastError', 'budget', 'workdir', 'branch',
    'lastRunAt', 'lastRunId', 'createdAt', 'binding', 'bindingDetail', 'wouldFire'
  ]) if (Object.prototype.hasOwnProperty.call(row, key)) out[key] = row[key];
  return out;
}

function resolveLoop(rows, ref) {
  const want = clean(ref, 200);
  if (!want) throw new Error('id or loop name is required');
  rows = (rows || []).filter(Boolean);
  const byId = rows.find(row => String(row.id) === want);
  if (byId) return byId;
  const lower = want.toLowerCase();
  const exact = rows.filter(row => clean(row.name, 200).toLowerCase() === lower);
  const partial = rows.filter(row => clean(row.name, 200).toLowerCase().indexOf(lower) >= 0);
  const hits = exact.length ? exact : partial;
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error('"' + want + '" matches more than one loop - pass an exact id: ' + hits.map(row => row.id + ' (' + row.name + ')').join(', '));
  throw new Error('no loop matches "' + want + '" - call loop.list to see durable loops');
}

function makeLoopTools(deps) {
  deps = deps || {};
  const listState = typeof deps.listState === 'function' ? deps.listState : () => ({ loops: [], halted: false, armed: false });
  const createLoop = deps.createLoop;
  const updateLoop = deps.updateLoop;
  const controlLoop = deps.controlLoop;
  const removeLoop = deps.removeLoop;
  const verdictLoop = deps.verdictLoop;

  const listTool = {
    name: 'loop.list', capability: 'orchestrator', scope: 'read', requiresConsent: false,
    description: 'List durable Agent OS LOOPS and their proven state. A LOOP keeps iterating toward an objective; for “every weekday”, cron, reminders, or clock schedules use routine.list/create/manage instead.',
    schema: { type: 'object', properties: {} },
    run: async () => {
      const state = listState() || {};
      const loops = (state.loops || []).map(safeLoop);
      const body = { loops, halted: !!state.halted, armed: !!state.armed, inFlight: Number(state.inFlight) || 0 };
      if (body.halted) body.note = "LOOPS are stopped by the Commander's E-STOP; creating or resuming one does not lift it";
      return { content: JSON.stringify(body), summary: loops.length + ' loop(s)' + (body.halted ? ' - E-STOPPED' : '') };
    }
  };

  const createTool = {
    name: 'loop.create', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 15000, taintLocked: true,
    description: 'Create one durable Agent OS LOOP when the Commander asks to keep working, iterate, or continue until an objective/convergence/check passes. Do not use for clock schedules such as “every weekday” (use routine.create). The review gate is fixed: generated changes wait for the Commander. A check command is never model-authored; for exitOn=check-green the host may derive a check only from an already-approved project folder. Repeating the same objective returns the existing loop.',
    schema: {
      type: 'object', required: ['objective'], properties: {
        name: { type: 'string' }, objective: { type: 'string' }, agentId: { type: 'string' },
        workdir: { type: 'string', description: 'Optional already-approved project folder. Required for check-green.' },
        exitOn: { type: 'string', enum: ['check-green', 'empty-digests', 'never'] },
        maxIterations: { type: ['integer', 'null'] }, model: { type: 'string' }, provider: { type: 'string' }
      }
    },
    run: async (args, ctx) => {
      if (typeof createLoop !== 'function') throw new Error('loop creation unavailable');
      args = args || {};
      const objective = clean(args.objective, 4000);
      if (!objective) throw new Error('objective is required');
      const row = await createLoop({
        name: clean(args.name || objective.slice(0, 60), 140), objective,
        agentId: clean(args.agentId || (ctx && ctx.agentId) || 'agent', 40),
        workdir: clean(args.workdir, 600) || null,
        exitOn: args.exitOn || 'empty-digests', maxIterations: args.maxIterations == null ? null : args.maxIterations,
        model: clean(args.model, 200) || null, provider: clean(args.provider, 60) || null, gate: 'review'
      });
      const duplicate = !!(row && row._duplicate);
      const safe = safeLoop(row);
      return {
        content: JSON.stringify({ ok: true, duplicate, loop: safe, halted: !!(row && row._halted), durable: true,
          note: row && row._halted ? "saved, but LOOPS remain stopped by the Commander's E-STOP" : undefined }),
        summary: duplicate ? 'loop already exists - no duplicate created' : 'created durable loop "' + (safe && safe.name) + '"'
      };
    }
  };

  const manageTool = {
    name: 'loop.manage', capability: 'orchestrator', scope: 'write', requiresConsent: true, timeoutMs: 30000,
    // taint lock per ACTION (taint.js): a run that read outside content may still pause or stop a loop (stopping work
    // schedules nothing); update/resume/approve re-arm what a later run obeys and remove/reject throw work away
    taintLocked: (a) => !(a && (a.action === 'pause' || a.action === 'stop')),
    description: 'Manage an EXISTING durable LOOP: update safe objective metadata, pause/resume/stop/remove it, or approve/reject one pending review iteration. Does not lift the global E-STOP and cannot read or change the host-run check command.',
    schema: {
      type: 'object', required: ['loop', 'action'], properties: {
        loop: { type: 'string' }, action: { type: 'string', enum: ['update', 'pause', 'resume', 'stop', 'remove', 'approve', 'reject'] },
        name: { type: 'string' }, objective: { type: 'string' }, agentId: { type: 'string' }, model: { type: 'string' }, provider: { type: 'string' },
        exitOn: { type: 'string', enum: ['check-green', 'empty-digests', 'never'] }, maxIterations: { type: ['integer', 'null'] },
        iteration: { type: 'integer' }, note: { type: 'string' }, reason: { type: 'string' }
      }
    },
    run: async (args) => {
      args = args || {};
      const state = listState() || {};
      const found = resolveLoop(state.loops || [], args.loop);
      let row;
      if (args.action === 'update') {
        if (typeof updateLoop !== 'function') throw new Error('loop updates unavailable');
        const patch = {};
        for (const key of PATCHABLE) if (Object.prototype.hasOwnProperty.call(args, key)) patch[key] = args[key];
        if (!Object.keys(patch).length) throw new Error('update needs at least one safe field');
        row = await updateLoop(found.id, patch);
      } else if (args.action === 'pause' || args.action === 'resume' || args.action === 'stop') {
        if (typeof controlLoop !== 'function') throw new Error('loop controls unavailable');
        row = await controlLoop(found.id, args.action, clean(args.reason, 800));
      } else if (args.action === 'remove') {
        if (typeof removeLoop !== 'function') throw new Error('loop removal unavailable');
        await removeLoop(found.id);
        return { content: JSON.stringify({ ok: true, removed: true, id: found.id, durable: true }), summary: 'removed loop "' + found.name + '"' };
      } else if (args.action === 'approve' || args.action === 'reject') {
        if (typeof verdictLoop !== 'function') throw new Error('loop verdicts unavailable');
        const iteration = Number(args.iteration);
        if (!Number.isInteger(iteration) || iteration < 1) throw new Error('approve/reject needs a positive iteration number from loop.list');
        row = await verdictLoop(found.id, iteration, args.action === 'approve' ? 'approved' : 'rejected', clean(args.note, 800));
      } else throw new Error('unknown loop action');
      const safe = safeLoop(row);
      return { content: JSON.stringify({ ok: true, loop: safe, halted: !!(row && row._halted), durable: true,
        note: row && row._halted ? "the loop is saved but remains blocked by the Commander's E-STOP" : undefined }), summary: args.action + ' loop "' + found.name + '"' };
    }
  };

  return { listTool, createTool, manageTool, register(reg) { [listTool, createTool, manageTool].forEach(tool => reg.register(tool)); return reg; } };
}

module.exports = { makeLoopTools, _internals: { resolveLoop, safeLoop, PATCHABLE } };
