/* node test/delegated-command-gap.test.js — issue #77, the shell half: a DELEGATED worker in ASK mode is told the
   truth about commands.

   The report: a Creator dispatched from the Supervisor's project conversation (ASK, Away Work OFF, WORKBENCH placed)
   said "shell execution is unavailable": its tools held only shell_bg_status/kill/wait, tool_search answered with an
   unrelated browser tool, and its capability note called it an "UNATTENDED" run needing a "per-routine grant".

   The withholding is BY DESIGN (inputpolicy.js makeRunAuthority: no workspace-process tool on a non-interactive
   surface in ASK mode; orchestration.js runs workers surface:'autonomous'). This proves (1) that projection on the
   real tool definitions and CAP_REGISTRY rows — so the test breaks if the policy ever changes underneath the
   wording — and (2) that every surface the worker reads now names the cause and the step that works. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
const { makeTerminalTools } = require('../sidecar/tools/builtin/terminal.js');
const { makeCommsTools } = require('../sidecar/tools/builtin/comms.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');
const { makeRunAuthority, enforceRunAuthority, impactOfTool } = require('../sidecar/inputpolicy.js');
const { withheldCommandTools, commandGap } = require('../sidecar/capability/withheld.js');
const TaskBriefPolicy = require('../sidecar/taskbrief-policy.js');
const { makeTool } = require('../sidecar/tools/tool.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-issue77-gap-'));
  const registry = makeRegistry();
  // the REAL shell tool definitions (impact classes included); nothing here ever spawns
  makeShellTool({ spawn: () => { throw new Error('must not spawn'); }, fs, pathMod: path, root: tmp, bg: {} }).register(registry);
  // …and the terminal and channel tools the WORKBENCH / station also project (quick win 8 declares their impact)
  makeTerminalTools({ manager: {}, environment: {}, fs, pathMod: path, root: tmp, envFor: () => ({}) }).register(registry);
  makeCommsTools({ listTargets: () => [], sendTo: async () => ({ ok: true }) }).register(registry);
  makeToolSearchTool({ registry }).register(registry);
  registry.register({ name: 'browser.inspect', capability: 'web', impact: 'synthetic-browser', scope: 'read', requiresConsent: false,
    description: 'Inspect one element on the current page.', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'x', summary: 'x' }) });
  registry.register({ name: 'browser.tabs', capability: 'web', impact: 'synthetic-browser', scope: 'read', requiresConsent: false,
    description: 'List the open browser tabs.', schema: { type: 'object', properties: {} }, run: async () => ({ content: 'x', summary: 'x' }) });

  // the worker's floor: a WORKBENCH (orchestration.js WORKER_KIT) + a dish
  const station = { rooms: { r: { id: 'r', objects: [{ instanceId: 'wb', objectType: 'workbench' }, { instanceId: 'd', objectType: 'dish' }] } }, agents: { designer: { id: 'designer', room: 'r' } } };
  const floor = resolveTools('designer', station);
  A.ok(floor.tools.indexOf('shell.exec') >= 0, 'the WORKBENCH grants shell.exec on the floor');

  // ---- 1. the dispatched worker's projection: ASK mode, surface autonomous (what team.dispatch passes) ----
  const authority = makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: false });
  const before = floor.tools.slice();
  const worker = enforceRunAuthority(floor, registry, authority);
  const has = n => worker.tools.indexOf(n) >= 0;
  A.ok(!has('shell.exec') && !has('shell.bg.write'), 'BY DESIGN: a delegated ASK-mode worker has no shell.exec / shell.bg.write, WORKBENCH or not');
  A.ok(has('shell.bg.status') && has('shell.bg.kill') && has('shell.bg.wait'), 'shell_bg_status/kill/wait survive — exactly the reporter\'s list');
  A.ok(!has('shell.bg.read'), 'shell_bg_read is not: it pages the whole log of a command the agent ran, and that log is the agent\'s, not this run\'s (external-unknown, as in 0.14.1)');
  // Full Access on the worker is the one grant that changes it (named in the explanation as whole-computer authority)
  const full = enforceRunAuthority(floor, registry, makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: true }));
  A.ok(full.tools.indexOf('shell.exec') >= 0, 'with Full Access on the worker, shell.exec is projected (so the explanation is accurate)');

  // ---- 1b. quick win 8 (#155 family): every host tool DECLARES its impact; none falls through to external-unknown ----
  // The eight that fell through now declare one. Its review (B3, release 0.14.2) put the READERS back in the lane they
  // always fell into, declared: terminal.status/read, shell.bg.read and channel.targets hand back what the agent's
  // sessions, logs and chat map hold, which are keyed by agent, not by run, so as impact none every unattended, non-owner
  // or tainted run of that agent could read and repeat them. The STOPPERS stay none, like shell.bg.kill in 0.14.1: they
  // end or redraw the agent's own work and hand back nothing it held.
  const READERS = ['terminal.status', 'terminal.read', 'shell.bg.read', 'channel.targets'];
  const STOPPERS = ['terminal.resize', 'terminal.interrupt', 'terminal.stop'];
  const declared = { 'channel.send': 'external-unknown' };
  for (const n of READERS) declared[n] = 'external-unknown';
  for (const n of STOPPERS) declared[n] = 'none';
  for (const [name, impact] of Object.entries(declared)) {
    const t = registry.get(name);
    A.ok(t && t.impact === impact && impactOfTool(t) === impact, name + ' declares impact ' + impact + ' (got ' + (t && t.impact) + ' / ' + impactOfTool(t) + ')');
  }
  // the command runners keep theirs: a terminal that runs a command is still workspace-process
  for (const name of ['terminal.start', 'terminal.write', 'shell.exec', 'shell.bg.write']) A.eq(impactOfTool(registry.get(name)), 'workspace-process', name + ' stays workspace-process');
  // the projection on the reporter's worker: the WORKBENCH's terminal stoppers reach it; its readers and runners do not
  for (const name of STOPPERS) A.ok(floor.tools.indexOf(name) >= 0 && has(name), name + ' (impact none) is projected to the delegated ASK worker');
  for (const name of ['terminal.status', 'terminal.read', 'shell.bg.read']) {
    A.ok(floor.tools.indexOf(name) >= 0 && !has(name), name + ' is on the WORKBENCH floor but NOT projected to the delegated ASK worker');
  }
  A.ok(!has('terminal.start') && !has('terminal.write'), 'terminal.start / terminal.write are still withheld from it (workspace-process, no grant)');
  // a GRANTED routine (the terminal grant): it can start a terminal and stop what it starts, but cannot read it
  const grantedAuthority = makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: false, unattendedGrants: ['workbench'] });
  const granted = enforceRunAuthority(floor, registry, grantedAuthority);
  A.ok(['terminal.start', 'terminal.interrupt', 'terminal.stop', 'shell.exec'].every(n => granted.tools.indexOf(n) >= 0), 'a routine granted the terminal can start and stop it');
  A.ok(['terminal.read', 'terminal.status', 'shell.bg.read'].every(n => granted.tools.indexOf(n) < 0), 'but it is not offered terminal.read / terminal.status / shell.bg.read: ' + JSON.stringify(granted.tools.filter(n => /^(terminal|shell)\./.test(n))));
  // the readers on every lane, through the run authority every real run's dispatch carries (index.js dctx.authorize)
  for (const name of READERS) {
    const t = registry.get(name);
    const callOf = { name, args: { session: 's' } };
    A.ok((await authority.authorize(callOf, t)).ok === false, name + ': an unattended ASK run asking for it is refused');
    A.ok((await grantedAuthority.authorize(callOf, t)).ok === false, name + ': so is a routine granted the terminal');
    let n = 0;
    const watchedRun = makeRunAuthority({ surface: 'interactive', isTask: true, fullAccess: false, confirm: async () => { n++; return 'always'; } });
    const w1 = await watchedRun.authorize(callOf, t), w2 = await watchedRun.authorize(callOf, t);
    A.ok(w1.ok === true && w1.oneShot === true && w2.ok === true && w2.oneShot === true && n === 2, name + ': a watched run confirms every call exactly, and "always" is not remembered: ' + JSON.stringify([w1, w2, n]));
    A.ok(enforceRunAuthority({ tools: [name] }, registry, watchedRun).tools.indexOf(name) >= 0, name + ': a watched run is offered it');
    const fullRun = makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: true });
    A.ok(enforceRunAuthority({ tools: [name] }, registry, fullRun).tools.indexOf(name) >= 0 && (await fullRun.authorize(callOf, t)).ok === true, name + ': Full Access keeps it');
    const ownerDm = makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: false, ownerTrusted: true });
    A.ok(enforceRunAuthority({ tools: [name] }, registry, ownerDm).tools.indexOf(name) >= 0, name + ': an authenticated owner DM keeps it');
    // a dispatch that carries no run authority at all is refused (the declared field, registry.js), never run
    const bare = await registry.dispatch({ id: 'c', name, args: { session: 's' }, argsRaw: '{"session":"s"}', parseError: null }, { agentId: 'designer', emit: () => {} });
    A.ok(bare.isError && /no run authority/.test(bare.content), name + ': a dispatch with no run authority is refused: ' + bare.content);
    // THE TASK BRIEF (review of B3): canMutate holds a scope-read tool that DECLARES external-unknown (the MCP-read rule), so
    // declaring the lane alone made every COMMS and channel turn's first read wait for brief_proceed. briefExempt keeps it a
    // read the model may make while it researches, exactly as its undeclared 0.14.1 shape (impact null) passed
    const v0141 = makeTool({ name, capability: t.capability, scope: t.scope, requiresConsent: t.requiresConsent });
    for (const status of ['ready', 'clarifying']) {   // taskbrief-store STATES that are not yet 'executing'
      const now = TaskBriefPolicy.canMutate({ status }, t, { name, args: {} });
      const then = TaskBriefPolicy.canMutate({ status }, v0141, { name, args: {} });
      A.ok(now.ok === true && then.ok === true, name + ': an unsettled (' + status + ') Task Brief never holds it, as in 0.14.1: ' + JSON.stringify([now, then]));
    }
  }
  // the stoppers are scope write, so they waited for brief_proceed in 0.14.1 and still do (impact none changes no brief rule)
  for (const name of STOPPERS) {
    const t = registry.get(name);
    const v0141 = makeTool({ name, capability: t.capability, scope: t.scope, requiresConsent: t.requiresConsent });
    A.ok(TaskBriefPolicy.canMutate({ status: 'ready' }, t, { name, args: {} }).ok === false && TaskBriefPolicy.canMutate({ status: 'ready' }, v0141, { name, args: {} }).ok === false
      && TaskBriefPolicy.canMutate({ status: 'executing' }, t, { name, args: {} }).ok === true, name + ': waits for brief_proceed before the brief settles, as in 0.14.1');
  }
  // channel.send declares the lane it always fell into (review of quick win 8): outward messaging under the Commander's
  // bot identity keeps an exact per-call confirmation that never becomes a standing grant, and is never offered to a
  // delegated worker or an unattended ASK run (whose exec lockout would refuse every call anyway)
  const commsRun = enforceRunAuthority({ tools: ['channel.targets', 'channel.send'] }, registry, authority);
  A.ok(commsRun.tools.indexOf('channel.targets') < 0, 'channel.targets (the Commander\'s chat list) is NOT offered to a delegated / unattended ASK run');
  A.ok(commsRun.tools.indexOf('channel.send') < 0, 'channel.send is NOT offered to a delegated / unattended ASK run');
  const fullComms = enforceRunAuthority({ tools: ['channel.send'] }, registry, makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: true }));
  A.ok(fullComms.tools.indexOf('channel.send') >= 0, 'Full Access keeps it (unchanged)');
  const taint = require('../sidecar/taint.js');
  A.ok(taint.allowedWhenTainted(registry.get('channel.send')) === false, 'a tainted run still cannot send a channel message');
  for (const n of READERS) A.ok(taint.allowedWhenTainted(registry.get(n)) === false, n + ': a tainted run loses it, as in 0.14.1');
  for (const n of STOPPERS) A.ok(taint.allowedWhenTainted(registry.get(n)) === true, n + ': stopping its own work stays open after taint');
  const workerAsk = await authority.authorize({ name: 'channel.send', args: {} }, registry.get('channel.send'));
  A.ok(workerAsk.ok === false, 'a delegated worker asking to send is refused before any broker could cache a grant: ' + JSON.stringify(workerAsk));
  // a watched run: every send asks, and an "always" answer covers that one send only
  let asked = 0;
  const watched = makeRunAuthority({ surface: 'interactive', isTask: true, fullAccess: false, confirm: async () => { asked++; return 'always'; } });
  const s1 = await watched.authorize({ name: 'channel.send', args: { target: 'telegram:1', text: 'one' } }, registry.get('channel.send'));
  const s2 = await watched.authorize({ name: 'channel.send', args: { target: 'telegram:1', text: 'two' } }, registry.get('channel.send'));
  A.ok(s1.ok === true && s1.oneShot === true && s2.ok === true && s2.oneShot === true, 'a watched send is a one-shot exact confirmation (no broker, so no standing grant): ' + JSON.stringify([s1, s2]));
  A.eq(asked, 2, 'an "always" answer is not remembered: the second send asks again');
  const watchedOffer = enforceRunAuthority({ tools: ['channel.send'] }, registry, watched);
  A.ok(watchedOffer.tools.indexOf('channel.send') >= 0, 'a watched run is offered it');

  // ---- 2. the withheld map index.js builds from that diff ----
  const kept = new Set(worker.tools);
  const withheld = withheldCommandTools(before.filter(n => !kept.has(n)), { impactOf: n => impactOfTool(registry.get(n)), opts: { delegatedBy: 'supervisor' } });
  A.ok(withheld['shell.exec'] && withheld['shell.bg.write'], 'shell.exec and shell.bg.write are recorded as WITHHELD for this run');
  A.ok(!withheld['shell.bg.read'], 'non-command classes keep their existing handling (only workspace-process is explained here)');
  const gap = withheld['shell.exec'];
  A.ok(/delegated by supervisor/.test(gap.why) && /ASK mode/.test(gap.why) && /WORKBENCH/.test(gap.why), 'why: names the lead, ASK mode and that the WORKBENCH does not change it: ' + gap.why);
  A.ok(/result for supervisor/.test(gap.enable) && /watched conversation/.test(gap.enable) && /Full Access/.test(gap.enable), 'enable: hand the exact command back to the lead; Full Access is the only other grant: ' + gap.enable);
  A.ok(/routine/i.test(commandGap({ routine: true }).enable) && !/routine/i.test(gap.enable), 'a routine gets its own remedy; a worker is never told about routine grants');

  // ---- 3. tool_search for the shell: names the withheld tool and the route, never reveals it ----
  const ctx = makeCapCtx(Object.assign({}, worker, { deferred: ['browser.inspect', 'browser.tabs'], withheld }), { agentId: 'designer' });
  const search = registry.get('tool.search');
  const r = await search.run({ query: 'run a shell command' }, ctx);
  A.ok(/WITHHELD on this run/.test(r.content) && /shell\.exec/.test(r.content), 'tool_search "run a shell command" answers WITHHELD shell.exec, not a browser tool: ' + r.content);
  A.ok(/result for supervisor/.test(r.content), 'and says what works instead');
  A.ok(!(r.control && r.control.revealTools && r.control.revealTools.indexOf('shell.exec') >= 0), 'a withheld tool is never revealed (the gate would refuse it)');
  const r2 = await search.run({ query: 'inspect an element' }, ctx);
  A.ok(r2.control && r2.control.revealTools.indexOf('browser.inspect') >= 0 && !/WITHHELD/.test(r2.content), 'an unrelated search is unchanged: ' + r2.content);
  const none = await search.run({ query: 'x' }, makeCapCtx(Object.assign({}, worker, { deferred: [], withheld: {} }), { agentId: 'designer' }));
  A.ok(/nothing further to find/.test(none.content), 'no deferred and no withheld tools: the historic answer');

  // ---- 4. the capability note a delegated worker reads ----
  const note = summarizeCapabilities(worker, { surface: 'autonomous', delegatedBy: 'supervisor' });
  A.ok(/DELEGATED worker run for supervisor/.test(note), 'the note says DELEGATED (not "UNATTENDED routine"): ' + note);
  A.ok(!/per-routine/.test(note), 'it no longer sends the worker to a per-routine grant');
  A.ok(/shell_bg_\* tools you see only inspect or stop/.test(note), 'it explains the surviving shell_bg_* tools cannot run a command');
  A.ok(/Do NOT report that the station has no shell/.test(note) && /result for supervisor/.test(note), 'it forbids the false "no shell" conclusion and names the route');
  const routineNote = summarizeCapabilities(worker, { surface: 'autonomous' });
  A.ok(/UNATTENDED run/.test(routineNote) && /per-routine grant/.test(routineNote), 'a non-delegated unattended run keeps its existing note');
  const fullNote = summarizeCapabilities(full, { surface: 'autonomous', delegatedBy: 'supervisor' });
  A.ok(!/Commands:/.test(fullNote), 'a worker that HAS shell.exec is not told commands are withheld');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  A.report('delegated-command-gap.test');
})().catch(e => { console.log('FAIL: delegated-command-gap.test threw — ' + (e && e.stack || e)); process.exit(1); });
