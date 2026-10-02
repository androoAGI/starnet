/* node test/capgate.test.js — object=capability resolution + the compute & tool gates. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { canAgentUse, attenuate, makeCapCtx } = require('../sidecar/capability/capGate.js');
const { composeOffice } = require('../sidecar/capability/office.js');

// resolve a composed office (the non-bay run path) into its tool/compute reach, as runOnce does.
function officeReach(opts) {
  const objects = composeOffice(opts);
  return resolveTools('ag', { agents: { ag: { id: 'ag', room: 'office' } }, rooms: { office: { id: 'office', objects } } });
}

// build a station: { roomId: [objectType,...] }, with agent 'ag' assigned to `assignedRoom`
function station(objsByRoom, assignedRoom) {
  const rooms = {};
  for (const r in objsByRoom) rooms[r] = { id: r, objects: objsByRoom[r].map((t, i) => ({ instanceId: r + '_' + i, objectType: t })) };
  return { rooms, agents: { ag: { id: 'ag', room: assignedRoom } } };
}

// ---- A. resolveTools (pure projection) ----
{
  const full = resolveTools('ag', station({ quarters: ['computer', 'notebook'] }, 'quarters'));
  A.ok(full.hasCompute, 'computer grants compute');
  A.eq(full.tools.slice().sort(), ['code.run', 'deliverable_note', 'knowledge_search', 'manual.read', 'notebook.feedback', 'notebook.read', 'notebook.write', 'quest.update', 'recall_conversation', 'routine.notepad', 'skill.list', 'skill.manage', 'skill.view', 'skill.write', 'station.inspect', 'todo', 'tool.search', 'widget.get', 'widget.set'], 'notebook grants its tools; compute excluded from tools[]; the host-scoped routine notepad and other primitives ride the COMPUTER placed in this same room');
  A.eq(full.approvalRules['notebook.write'].requiresConsent, false, 'notebook write needs no consent (sandboxed private memory)');
  A.eq(full.approvalRules['notebook.read'].requiresConsent, false, 'read auto-allowed');

  const empty = resolveTools('ag', station({ quarters: [] }, 'quarters'));
  A.ok(!empty.hasCompute, 'empty room -> no compute');
  A.eq(empty.tools.length, 0, 'empty room -> no tools');

  // capability follows the ASSIGNED room, not objects elsewhere
  // `todo` is ABSENT from notebook-only rooms since 2026-08-17: it rides the COMPUTER (taskplan freebie), so
  // any agent that can RUN has a task list — a notebook-less station no longer silently loses planning.
  const split = resolveTools('ag', station({ quarters: ['notebook'], lab: ['computer'] }, 'quarters'));
  A.eq(split.tools.slice().sort(), ['knowledge_search', 'notebook.feedback', 'notebook.read', 'notebook.write', 'recall_conversation', 'skill.list', 'skill.manage', 'skill.view', 'skill.write', 'widget.get', 'widget.set'], 'only assigned-room objects grant tools');
  A.ok(!split.hasCompute, 'a computer in a DIFFERENT room does not grant compute');

  // de-dupe duplicate objects
  const dup = resolveTools('ag', station({ quarters: ['notebook', 'notebook'] }, 'quarters'));
  A.eq(dup.tools.slice().sort(), ['knowledge_search', 'notebook.feedback', 'notebook.read', 'notebook.write', 'recall_conversation', 'skill.list', 'skill.manage', 'skill.view', 'skill.write', 'widget.get', 'widget.set'], 'duplicate objects de-duped');

  // QUEST V2 §B fix: quest.update rides the COMPUTER (the compute freebie), not the notebook. A computer-only room
  // therefore grants quest.update while granting NO notebook tool — the exact reach a bare interactive agent gets.
  const compOnly = resolveTools('ag', station({ quarters: ['computer'] }, 'quarters'));
  A.ok(compOnly.hasCompute, 'a computer grants compute');
  // The bare compute-only office exposes host-owned primitives and no general notebook tools. routine.notepad
  // is inert unless the host also minted a cronJobId for this exact scheduled run.
  // deliverable_note rides COMPUTER for the same reason quest.update/tool.search do: it must exist on the
  // compute-only interactive office, which is exactly the surface most likely to produce an unnamed file.
  A.eq(compOnly.tools.slice().sort(), ['code.run', 'deliverable_note', 'manual.read', 'quest.update', 'routine.notepad', 'station.inspect', 'todo', 'tool.search'], 'computer-only room grants the host-scoped routine scratch tool + the deliverable naming and task-plan freebies, no general notebook tools');
  A.eq(compOnly.approvalRules['quest.update'].requiresConsent, false, 'quest.update is consent-free (freebie trust class)');
  A.eq(compOnly.approvalRules['todo'].requiresConsent, false, 'todo is consent-free (taskplan freebie — a runnable agent always has a task list)');

  // unknown agent -> nothing
  A.eq(resolveTools('ghost', station({ quarters: ['computer'] }, 'quarters')).tools.length, 0, 'unknown agent -> no tools');
}

// ---- B. canAgentUse ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  A.ok(canAgentUse(r, 'notebook.read').ok, 'granted tool allowed');
  A.ok(!canAgentUse(r, 'shell.exec').ok, 'ungranted tool denied');
  A.ok(canAgentUse(r, 'shell.exec').reason.indexOf('shell.exec') >= 0, 'denial names the tool');
}

// ---- C. attenuate (intersection, never union) ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  A.eq(attenuate(r, ['notebook.read', 'web.fetch']).tools, ['notebook.read'], 'attenuate intersects; never adds web.fetch');
}

// ---- C2. makeCapCtx threads run-scoped extras (runId) onto the ctx tools/dispatch consume (B1 seam) ----
{
  const r = resolveTools('ag', station({ quarters: ['notebook'] }, 'quarters'));
  const cc = makeCapCtx(r, { runId: 'run_42' });
  A.eq(cc.runId, 'run_42', 'makeCapCtx surfaces runId from extra (so a tool can stamp sourceRunId)');
  A.eq(cc.agentId, 'ag', 'capCtx still carries agentId');
  A.eq(typeof cc.canUse, 'function', 'capCtx still exposes canUse');
  A.eq(typeof cc.canRun, 'function', 'capCtx still exposes the compute gate');
}

// ---- F. THE MOAT (FLOOR-REAL): composeOffice — interactive floor is REAL, autonomous keeps the full office ----
{
  // F1. a brand-new interactive agent (NOTHING placed) can still THINK (compute is the freebie) but has NO
  //     web / files / terminal — the floor is not decorative, yet it is never a dead wall.
  const fresh = officeReach({ surface: 'interactive', extraObjects: [] });
  A.ok(fresh.hasCompute, 'F1: brand-new interactive agent has compute (the freebie) — works out of the box');
  A.eq(fresh.tools.indexOf('web_search'), -1, 'F1: no DISH placed -> no web');
  A.eq(fresh.tools.indexOf('fs.read'), -1, 'F1: no CABINET placed -> no files');
  A.eq(fresh.tools.indexOf('shell.exec'), -1, 'F1: no WORKBENCH placed -> no terminal');
  // QUEST V2 §B fix (truthful telemetry): quest.update MUST be present on the bare interactive office — the STATION
  // QUESTS prompt (gated on isTask) commands it, and a real-provider run reported it MISSING when it rode the notebook.
  // Now it rides compute (the freebie), so an agent with an EMPTY station can actually act on / mint quests.
  A.ok(fresh.tools.indexOf('quest.update') >= 0, 'F1: bare interactive office (nothing placed) STILL grants quest.update — the prompt never advertises an absent tool');

  // F2. placing a DISH genuinely unlocks web (and ONLY web) — the core "object = capability" promise.
  const withDish = officeReach({ surface: 'interactive', extraObjects: [{ objectType: 'dish' }] });
  A.ok(withDish.hasCompute, 'F2: still has compute');
  A.ok(withDish.tools.indexOf('web_search') >= 0 && withDish.tools.indexOf('web_fetch') >= 0, 'F2: placing a DISH unlocks web_search + web_fetch');
  A.eq(withDish.tools.indexOf('fs.read'), -1, 'F2: a DISH does not also grant files');
  A.eq(withDish.tools.indexOf('shell.exec'), -1, 'F2: a DISH does not also grant terminal');

  // F3. placing a CABINET unlocks files; a WORKBENCH unlocks the terminal (consent-gated).
  const withCab = officeReach({ surface: 'interactive', extraObjects: [{ objectType: 'cabinet' }] });
  A.ok(withCab.tools.indexOf('fs.read') >= 0 && withCab.tools.indexOf('fs.write') >= 0, 'F3: placing a CABINET unlocks files');
  A.eq(withCab.approvalRules['fs.write'].requiresConsent, true, 'F3: file WRITE is consent-gated');
  const withWb = officeReach({ surface: 'interactive', extraObjects: [{ objectType: 'workbench' }] });
  A.ok(withWb.tools.indexOf('shell.exec') >= 0 && withWb.tools.indexOf('verify.run') >= 0, 'F3: placing a WORKBENCH unlocks the terminal');

  // F4. AUTONOMOUS/headless runs (cron/Telegram/delegated) keep the full office — no regression to shipped work.
  const auto = officeReach({ surface: 'autonomous', extraObjects: [] });
  A.ok(auto.hasCompute, 'F4: autonomous has compute');
  A.ok(auto.tools.indexOf('web_search') >= 0, 'F4: autonomous keeps web (full default office)');
  A.ok(auto.tools.indexOf('fs.read') >= 0, 'F4: autonomous keeps files');
  A.ok(auto.tools.indexOf('notebook.write') >= 0, 'F4: autonomous keeps memory');

  // F5. only the LEAD gets the orchestrator/team.dispatch object (a delegated worker can never re-delegate).
  A.ok(officeReach({ surface: 'interactive', lead: true }).tools.indexOf('team.dispatch') >= 0, 'F5: the lead gets team.dispatch');
  A.ok(officeReach({ surface: 'interactive', lead: true }).tools.indexOf('team.spawn') >= 0, 'F5: the lead gets team.spawn');
  A.ok(officeReach({ surface: 'interactive', lead: true }).tools.indexOf('routine.create') >= 0, 'F5: the lead gets routine.create');
  A.eq(officeReach({ surface: 'interactive', lead: false }).tools.indexOf('team.dispatch'), -1, 'F5: a non-lead worker does not');
  A.eq(officeReach({ surface: 'interactive', lead: false }).tools.indexOf('team.spawn'), -1, 'F5: a non-lead worker cannot spawn subagents');
  A.eq(officeReach({ surface: 'interactive', lead: false }).tools.indexOf('routine.create'), -1, 'F5: a non-lead worker cannot create routines');
}

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  return { bus, seq, emit: makeEmitter(bus, () => {}) };
}

(async () => {
  // ---- D. compute gate: empty room -> NO paid model call ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const resolved = resolveTools('ag', station({ quarters: [] }, 'quarters'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', capCtx: makeCapCtx(resolved) });
    A.eq(provider.callCount(), 0, 'no compute -> NO paid model call');
    const cd = seq.find(e => e.name === 'capdenied');
    A.ok(cd !== undefined, 'capdenied emitted');
    A.eq(cd.payload.need, 'compute', 'capdenied need=compute');
    A.eq(res.reason, 'error', 'run ends without doing work');
  }

  // ---- D2. compute present -> normal run ----
  {
    const { emit } = setup();
    const provider = makeReplayProvider({ turns: [[{ type: 'text', delta: 'hi' }, { type: 'done', finishReason: 'stop' }]] });
    const resolved = resolveTools('ag', station({ quarters: ['computer'] }, 'quarters'));
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', capCtx: makeCapCtx(resolved) });
    A.eq(provider.callCount(), 1, 'compute present -> model call proceeds');
    A.eq(res.reason, 'done', 'normal completion');
  }

  // ---- E. tool gate: model calls an ungranted tool -> capdenied result, body never runs, pairing held ----
  {
    const { seq, emit } = setup();
    const provider = makeReplayProvider({ turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'notebook.read' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]
    ] });
    const reg = makeRegistry();
    let ran = 0;
    reg.register({ name: 'notebook.read', capability: 'memory', schema: { type: 'object' }, run: async () => { ran++; return 'secret notes'; } });
    // computer present (run proceeds) but NO notebook -> notebook.read is not granted
    const resolved = resolveTools('ag', station({ quarters: ['computer'] }, 'quarters'));
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'read my notes' }], provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
      model: 'replay/model', tools: reg.wireFormat(), dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: makeCapCtx(resolved)
    });
    const tr = seq.find(e => e.name === 'agent.tool_result').payload;
    A.eq(tr.isError, true, 'ungranted tool -> isError result');
    A.eq(tr.summary, 'capdenied', 'tool_result marked capdenied');
    A.eq(ran, 0, 'the tool body never ran (no action)');
    A.eq(res.reason, 'done', 'loop recovers and finishes');
  }

  A.report('capgate.test');
})();
