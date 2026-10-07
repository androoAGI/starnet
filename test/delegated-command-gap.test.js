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
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { resolveTools } = require('../sidecar/capability/resolve.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const { summarizeCapabilities } = require('../sidecar/capability/capsummary.js');
const { makeRunAuthority, enforceRunAuthority, impactOfTool } = require('../sidecar/inputpolicy.js');
const { withheldCommandTools, commandGap } = require('../sidecar/capability/withheld.js');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-issue77-gap-'));
  const registry = makeRegistry();
  // the REAL shell tool definitions (impact classes included); nothing here ever spawns
  makeShellTool({ spawn: () => { throw new Error('must not spawn'); }, fs, pathMod: path, root: tmp, bg: {} }).register(registry);
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
  A.ok(has('shell.bg.status') && has('shell.bg.kill') && has('shell.bg.wait'), 'only shell_bg_status/kill/wait survive — exactly the reporter\'s list');
  // Full Access on the worker is the one grant that changes it (named in the explanation as whole-computer authority)
  const full = enforceRunAuthority(floor, registry, makeRunAuthority({ surface: 'autonomous', isTask: true, fullAccess: true }));
  A.ok(full.tools.indexOf('shell.exec') >= 0, 'with Full Access on the worker, shell.exec is projected (so the explanation is accurate)');

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
