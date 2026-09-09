/* node test/station-tools.test.js — session.list / session.create / session.focus (the agent's session
   verbs over the station bridge). Driven against a stub bridge: what these tools OWN is the honesty
   contract — a bridge refusal, a silent page, or a missing bridge must come back as an explicit REFUSED
   the model cannot misread as success, because "created the research session" with no session behind it
   is the exact lie the bridge exists to prevent. The page half is proven against the REAL Workstreams in
   station-commands.test.js; the two meet in the cross-check there and live in the e2e. */
'use strict';
const A = require('./_assert.js');
const { makeStationTools } = require('../sidecar/tools/builtin/station.js');

function stubBridge(impl) {
  const seen = [];
  return { seen, request: async (verb, args) => { seen.push({ verb, args }); return impl(verb, args); } };
}

(async () => {

// ---- passthrough: each tool asks its verb and returns the page's real answer ----
{
  const bridge = stubBridge(verb => {
    if (verb === 'station.sessions') return { ok: true, result: { count: 2, sessions: [{ id: 'a', title: 'research' }, { id: 'b', title: 'General' }] } };
    if (verb === 'station.new_session') return { ok: true, result: { id: 'c', title: 'ops', focused: false } };
    if (verb === 'station.switch_session') return { ok: true, result: { id: 'a', title: 'research' } };
    if (verb === 'station.read_session') return { ok: true, result: { id: 'a', title: 'research', busy: true, turns: [{ speaker: 'researcher', text: 'Phobos and Deimos.' }] } };
    if (verb === 'station.tasks') return { ok: true, result: { count: 1, tasks: [{ id: 't1', title: 'Fix check', lane: 'todo' }] } };
    if (verb === 'station.new_task') return { ok: true, result: { id: 't1', title: 'Fix check', lane: 'todo', created: true, durable: true } };
    if (verb === 'station.manage_task') return { ok: true, result: { id: 't1', changed: true, durable: true, task: { id: 't1', lane: 'active' } } };
    return { ok: false, error: 'unknown' };
  });
  const t = makeStationTools({ station: bridge });
  const list = await t.listTool.run({});
  A.eq(JSON.parse(list.content).count, 2, 'session.list returns the real session list');
  A.eq(list.summary, '2 session(s)', 'and a truthful summary');
  const made = await t.createTool.run({ title: 'ops', agentId: 'researcher' });
  A.eq(JSON.parse(made.content).id, 'c', 'session.create returns the created id');
  A.eq(bridge.seen[1].args.title, 'ops', 'the title travels verbatim');
  A.eq(bridge.seen[1].args.agentId, 'researcher', 'and the crew binding travels');
  A.eq(bridge.seen[1].args.focus, false, 'focus is never implied');
  const foc = await t.focusTool.run({ session: 'research' });
  A.eq(JSON.parse(foc.content).title, 'research', 'session.focus returns where the Commander now is');
  const peek = await t.peekTool.run({ session: 'research' });
  const pk = JSON.parse(peek.content);
  A.eq(pk.turns[0].speaker, 'researcher', "session.peek returns another session's real turns, attributed");
  A.ok(/still working/.test(peek.summary), 'a busy session says so in the summary — "done" is never implied');
  A.eq(bridge.seen[bridge.seen.length - 1].args.limit, 12, 'the default read window travels');
  await t.peekTool.run({ session: 'research', limit: 500 });
  A.eq(bridge.seen[bridge.seen.length - 1].args.limit, 30, 'a runaway limit clamps');
  A.eq(JSON.parse((await t.taskListTool.run({})).content).count, 1, 'task.list reads the real board projection');
  A.eq(JSON.parse((await t.taskCreateTool.run({ title: 'Fix check' })).content).durable, true, 'task.create returns the page durability receipt');
  A.eq(JSON.parse((await t.taskManageTool.run({ task: 'Fix check', action: 'move', lane: 'active' })).content).task.lane, 'active', 'task.manage returns the stored state');
}

// ---- ⛔ the honesty contract: every failure is an explicit REFUSED, never a soft nothing ----
{
  const t = makeStationTools({});   // no bridge at all (bare host / headless composition)
  for (const [tool, args] of [[t.listTool, {}], [t.createTool, { title: 'x' }], [t.focusTool, { session: 'x' }], [t.peekTool, { session: 'x' }], [t.taskListTool, {}], [t.taskCreateTool, { title: 'x' }], [t.taskManageTool, { task: 'x', action: 'archive' }]]) {
    const out = await tool.run(args);
    A.ok(/^REFUSED:/.test(out.content), tool.name + ' without a bridge refuses explicitly');
    A.ok(/do not report this action as done/.test(out.content), 'and tells the model not to claim it');
  }
  const down = makeStationTools({ station: stubBridge(() => ({ ok: false, error: 'no station page answered — open StarNet to run station commands', unattended: true })) });
  const out = await down.createTool.run({ title: 'research' });
  A.ok(/REFUSED: no station page answered/.test(out.content), 'an unattended station (cron/Night Shift) is named, not papered over');
  const refused = makeStationTools({ station: stubBridge(() => ({ ok: false, error: 'a session called "research" already exists — delegate into it, focus it, or pick another name' })) });
  const dup = await refused.createTool.run({ title: 'research' });
  A.ok(/already exists/.test(dup.content), "the page's own refusal reaches the model verbatim");
  const thrown = makeStationTools({ station: { request: async () => { throw new Error('bus is down'); } } });
  const boom = await thrown.listTool.run({});
  A.ok(/REFUSED: bus is down/.test(boom.content), 'a throwing bridge refuses instead of crashing the run');
}

// ---- input hygiene runs before the bridge is ever bothered ----
{
  const bridge = stubBridge(() => ({ ok: true, result: {} }));
  const t = makeStationTools({ station: bridge });
  A.ok(/REFUSED: a session needs a title/.test((await t.createTool.run({ title: '   ' })).content), 'a blank title never reaches the page');
  A.ok(/REFUSED: name which session/.test((await t.focusTool.run({})).content), 'a blank focus target never reaches the page');
  A.ok(/REFUSED: a task needs a title/.test((await t.taskCreateTool.run({ title: ' ' })).content), 'a blank task title never reaches the page');
  A.eq(bridge.seen.length, 0, 'no bridge round-trip was spent on either');
  const long = 'x'.repeat(200);
  await t.createTool.run({ title: long });
  A.eq(bridge.seen[0].args.title.length, 80, 'a runaway title is clamped to the session-title cap');
}

// Focus provenance must be minted from execution context, never copied from tool arguments.
{
  const bridge = stubBridge(() => ({ok:true,result:{id:'target'}}));
  const t = makeStationTools({station:bridge});
  const ctx = {streamId:'real-session',runId:'real-run'};
  await t.focusTool.run({session:'target',origin:{streamId:'forged',runId:'forged'}},ctx);
  A.eq(bridge.seen[0].args.origin.streamId,'real-session','focus origin comes from the run');
  A.eq(bridge.seen[0].args.origin.runId,'real-run','focus carries the real run identity');
  await t.createTool.run({title:'new',focus:true,origin:{streamId:'forged'}},ctx);
  A.eq(bridge.seen[1].args.origin.runId,'real-run','focused create carries identical provenance');
  await t.focusTool.run({session:'target',origin:ctx});
  A.eq(bridge.seen[2].args.origin,null,'tool arguments cannot mint origin without a run context');
}

// ---- capability surface: lead-only, and consent-free (a session costs nothing and is reversible) ----
{
  const t = makeStationTools({});
  for (const tool of [t.listTool, t.createTool, t.peekTool, t.focusTool]) {
    A.eq(tool.capability, 'orchestrator', tool.name + ' rides the lead-only orchestrator gate');
    A.eq(tool.requiresConsent, false, tool.name + ' needs no consent beat');
  }
  A.eq(t.listTool.scope, 'read', 'listing is a read');
  A.eq(t.peekTool.scope, 'read', 'peeking is a read');
  A.eq(t.createTool.scope, 'write', 'creating is a write');
  for (const tool of [t.taskListTool, t.taskCreateTool, t.taskManageTool]) A.eq(tool.capability, 'orchestrator', tool.name + ' is lead-only');
  A.eq(t.taskListTool.requiresConsent, false, 'task listing is consent-free');
  A.eq(t.taskCreateTool.requiresConsent, false, 'adding a reversible card is consent-free');
  A.eq(t.taskManageTool.requiresConsent, true, 'task management is consent-gated because it includes destructive actions');
  A.ok(/NEVER answer from memory/i.test(t.peekTool.description) || /answering from memory is guessing/i.test(t.peekTool.description),
    "peek's description carries the anti-guessing rule — the tool exists because a lead denied real work");
  const reg = { registered: [], register(x) { this.registered.push(x.name); } };
  t.register(reg);
  A.eq(reg.registered.join(','), 'session.list,session.create,session.peek,session.focus,task.list,task.create,task.manage', 'register() installs session and task verbs');
}

/* ---- ⛔ THE CAPABILITY REGISTRY IS AN ALLOWLIST. A tool registered with the host but not declared in
   sidecar/capability/registry.js is exposed to NOBODY — these three shipped exactly that way on the first
   pass and a live model said "I don't have a session tool" while every unit test was green. Registration
   and declaration land together or the tool does not exist. */
{
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sidecar', 'capability', 'registry.js'), 'utf8');
  const orch = src.slice(src.indexOf('orchestrator: ['), src.indexOf(']', src.indexOf('orchestrator: [')));
  for (const name of ['session.list', 'session.create', 'session.peek', 'session.focus', 'task.list', 'task.create', 'task.manage']) {
    A.ok(orch.indexOf("tool: '" + name + "'") >= 0, name + ' is DECLARED in the orchestrator capability allowlist (registration alone exposes nothing)');
  }
  A.ok(/tool: 'session\.create', scope: 'write', requiresConsent: false/.test(orch), 'session.create is consent-free (spends nothing, reversible)');
}

A.report('station-tools.test');

})().catch(error => { console.error(error); process.exit(1); });
