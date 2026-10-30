/* node test/loop.verify-on-stop.test.js — VERIFY-ON-STOP.

   The station's promise is that nothing is claimed unless it is proven, and "fake done" — an edit shipped as
   finished with no check ever run against it — is the failure this project pays for most. The system prompt
   already INSTRUCTED the model to verify after editing; nothing ENFORCED it. This proves the enforcement:
   a run that mutated CODE and then tries to end without evidence buys exactly one more turn, and every
   narrowing that keeps the nudge from firing on work that has nothing to verify. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const EXEC_SCHEMA = { type: 'object', required: ['command'], properties: { command: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));

function setup() {
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  return { emit };
}
// turn 1 calls `name` with `args`; every later turn is a plain tool-free answer.
function fixture(name, args, extraStops) {
  const turns = [[{ type: 'tool_start', index: 0, id: 'c1', name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args) }, { type: 'done', finishReason: 'tool_calls' }]];
  for (let i = 0; i < (extraStops || 2); i++) turns.push([{ type: 'text', delta: 'All set.' }, { type: 'done', finishReason: 'stop' }]);
  return { turns };
}
function reg(fail) {
  const r = makeRegistry();
  r.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => { if (fail) throw new Error('EACCES'); return 'wrote ' + a.path; } });
  r.register({ impact: 'none', name: 'shell_exec', schema: EXEC_SCHEMA, run: async (a) => 'ran ' + a.command });
  r.register({ impact: 'none', name: 'verify_run', schema: { type: 'object', properties: {} }, run: async () => 'PASS 12 passing' });
  return r;
}
function externalReg(fail) {
  const r = makeRegistry();
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_action', schema: { type: 'object', properties: {} }, run: async () => {
    if (fail) throw new Error('remote failure');
    return 'changed';
  } });
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_verify_file', schema: { type: 'object', properties: {} }, run: async () => 'verified' });
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_status', schema: { type: 'object', properties: {} }, run: async () => 'action completed' });
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_read_file', schema: { type: 'object', properties: {} }, run: async () => 'file contents' });
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_inspect', schema: { type: 'object', properties: {} }, run: async () => 'sources: /a, /b' });
  r.register({ impact: 'none', name: 'mcp__parity_fixture_eval__fixture_fetch', schema: { type: 'object', properties: {} }, run: async (a) => 'source content for ' + a.path });
  r.register({ impact: 'none', name: 'mcp__other__read_status', schema: { type: 'object', properties: {} }, run: async () => 'other state' });
  return r;
}
async function run(o) {
  const { emit } = setup();
  const provider = makeReplayProvider(o.fixture);
  const messages = [{ role: 'user', content: o.user || 'go' }];
  const r = o.registry || reg();
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: o.tools || toolDefs('fs_write', 'verify_run', 'shell_exec'),
    limits: Object.assign({ maxIters: 8, grace: false }, o.limits || {}),
    dispatch: (c, ctx) => r.dispatch(c, ctx), capCtx: openCtx(),
    standaloneWorkspace: o.standalone === true
  });
  const nudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<verify_before_done>') === 0);
  const externalNudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<verify_external_before_done>') === 0);
  const failedCheckNudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<failed_check_repair>') === 0);
  const sourceNudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<verify_sources_before_done>') === 0);
  return { res, messages, nudges, externalNudges, failedCheckNudges, sourceNudges };
}

(async () => {
  // ---- 1. THE CORE CASE: code changed, run tries to stop, no check ever ran -> one nudge, run continues ----
  {
    const { res, messages, nudges } = await run({ fixture: fixture('fs_write', { path: 'src/app.js', content: 'x' }) });
    A.eq(nudges.length, 1, 'a code edit that ends unverified buys exactly one nudge');
    A.ok(/src\/app\.js/.test(nudges[0].content), 'the nudge NAMES the file it is asking about');
    A.ok(/state what you did NOT verify/.test(nudges[0].content), 'an honest "could not verify" is an accepted way out');
    A.eq(res.reason, 'done', 'the run still terminates after the nudge');
    // The nudge must actually buy a MODEL TURN, not merely append text. Assert structurally: an assistant turn
    // follows it. (res.turns is the wrong ruler here — a re-emitted identical answer is refunded by design.)
    const at = messages.indexOf(nudges[0]);
    A.eq(messages.slice(at + 1).some(m => m.role === 'assistant'), true, 'the model was called again after the nudge');
  }

  // ---- 2. PROSE HAS NOTHING TO RUN. A README/SKILL.md edit must never demand a test. ----
  for (const p of ['NOTES.md', 'docs/guide.mdx', 'README', 'CHANGELOG', 'data/rows.csv']) {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: p, content: 'x' }) });
    A.eq(nudges.length, 0, 'a prose edit (' + p + ') never triggers verify-on-stop');
  }

  // ---- 3. EVIDENCE DISARMS IT — both the dedicated verifier and a shell command that is really a check ----
  {
    const two = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'verify_run' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'green' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: two })).nudges.length, 0, 'a passing verify_run disarms the guard');

    const viaShell = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: '{"command":"npm test"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'green' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: viaShell })).nudges.length, 0, 'a real check through shell_exec disarms the guard');

    // ...but a shell command that merely LOOKS AROUND is not evidence that anything passed.
    const looksAround = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/a.js","content":"x"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: '{"command":"git status"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'done' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: looksAround })).nudges.length, 1, '`git status` is not verification — the guard still fires');
  }

  // ---- 4. NEVER DEMAND THE IMPOSSIBLE: with no verification tool wired there is nothing to ask for ----
  {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), tools: toolDefs('fs_write') });
    A.eq(nudges.length, 0, 'no verify_run and no shell_exec wired -> no nudge');
  }

  // ---- 5. A FAILED WRITE CHANGED NOTHING. There is no edit to verify. ----
  {
    const { nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), registry: reg(true) });
    A.eq(nudges.length, 0, 'a write that errored arms nothing');
  }

  // ---- 6. BOUNDED: a model that ignores the nudge still terminates, and the budget is honored ----
  {
    const { res, nudges } = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }, 6) });
    A.eq(nudges.length, 1, 'at most one nudge per run even when the model keeps refusing to verify');
    A.eq(res.reason, 'done', 'the run terminates rather than looping on the nudge');

    const off = await run({ fixture: fixture('fs_write', { path: 'src/a.js', content: 'x' }), limits: { verifyOnStop: false } });
    A.eq(off.nudges.length, 0, 'limits.verifyOnStop === false disables the guard entirely');
  }

  // ---- 7. the pure classifiers, directly ----
  {
    const { vosIsCodePath, vosIsCheckCommand, vosKey, vosExternalRole, vosExternalArtifactMutation, vosExternalSourceRole, sourceGroundingRequested } = _internals;
    A.eq(vosIsCodePath('src/a.js'), true, '.js is code');
    A.eq(vosIsCodePath('a.md'), false, '.md is prose');
    A.eq(vosIsCodePath('Makefile'), true, 'an extension-less build file is code');
    A.eq(vosIsCodePath('LICENSE'), false, 'LICENSE is prose even without an extension');
    A.eq(vosIsCodePath(''), false, 'an empty path arms nothing');
    A.eq(vosIsCheckCommand({ command: 'pytest -q' }), true, 'pytest is a check');
    A.eq(vosIsCheckCommand({ command: 'cargo test' }), true, 'cargo test is a check');
    A.eq(vosIsCheckCommand({ command: 'ls -la' }), false, 'ls is not a check');
    A.eq(vosIsCheckCommand({ command: 'cat package.json' }), false, 'reading a file is not a check');
    // token-burn audit 2026-10-17: checks real night shifts ran and passed, which still re-armed the nudge
    A.eq(vosIsCheckCommand({ command: 'node tests\\smoke.js' }), true, 'node tests\\x.js is a check');
    A.eq(vosIsCheckCommand({ command: 'node tests.js' }), true, 'node tests.js is a check');
    A.eq(vosIsCheckCommand({ command: 'node --check src/app.js' }), true, 'node --check is a syntax check');
    A.eq(vosIsCheckCommand({ command: 'git apply --check workshop/run/change.patch' }), true, 'git apply --check proves a patch applies');
    A.eq(vosIsCheckCommand({ command: 'git apply workshop/run/change.patch' }), false, '...but applying it is not a check');
    A.eq(vosIsCheckCommand({ command: 'node server.js' }), false, 'running a server is not a check');
    A.eq(vosIsCodePath('workshop/run-1/deliverable.json'), false, 'a night-shift manifest is bookkeeping, not code');
    A.eq(vosIsCodePath('src/config.json'), true, '...while any other .json still counts');
    A.eq(vosIsCodePath('.gitignore'), false, 'an inert dotfile (.gitignore) has nothing to run');
    A.eq(vosIsCodePath('.env.local'), false, '...nor does an .env variant');
    A.eq(vosIsCodePath('.babelrc'), true, 'a config dotfile a check would exercise (.babelrc) still arms the nudge');
    A.eq(vosIsCodePath('.eslintrc'), true, '...as does .eslintrc');
    A.eq(vosIsCodePath('.eslintrc.js'), true, '...and a dotfile WITH a code extension');
    A.eq(vosIsCheckCommand({ command: 'node -c src/app.js' }), true, 'node -c (lower-case) is --check');
    A.eq(vosIsCheckCommand({ command: 'node -C dev app.js' }), false, 'node -C <condition> is NOT a check (case-sensitive)');
    const { vosIsPatchOnlyCheck } = _internals;
    A.eq(vosIsPatchOnlyCheck({ command: 'git apply --check work/change.patch' }), true, 'a bare git apply --check vouches for patch files only');
    A.eq(vosIsPatchOnlyCheck({ command: 'git apply --check work/change.patch && npm test' }), false, '...combined with a real check it clears everything');
    A.eq(vosKey('fs.write'), 'fs_write', 'dotted registry names and underscored wire names collapse to one key');
    A.eq(vosExternalRole('mcp__parity_fixture_eval__fixture_action'), 'mutate', 'an external action arms read-back enforcement');
    A.eq(vosExternalRole('mcp__parity_fixture_eval__fixture_verify_file'), 'observe', 'an external verifier is classified as read-back');
    A.eq(vosExternalArtifactMutation('mcp__parity_fixture_eval__fixture_action', { action: 'set_workbook_input' }), true,
      'an artifact-shaped action arms the stronger freshness rule');
    A.eq(vosExternalArtifactMutation('mcp__parity_fixture_eval__fixture_action', { action: 'restart_service', note: 'spreadsheet mentioned in prose' }), false,
      'unstructured prose does not turn an ordinary external action into an artifact mutation');
    A.eq(vosExternalSourceRole('mcp__parity_fixture_eval__fixture_inspect'), 'discover', 'connector inspection is source discovery');
    A.eq(vosExternalSourceRole('mcp__parity_fixture_eval__fixture_fetch'), 'read', 'connector fetch is source retrieval');
    A.eq(sourceGroundingRequested([{ role: 'user', content: 'Report reference code QZ-731.' }]), false,
      'an ordinary reference identifier does not falsely request research grounding');
    A.eq(vosExternalRole('fs_write'), '', 'native tools stay outside the external-effect classifier');
  }

  // ---- 8. EXTERNAL EFFECTS: connector mutation -> one read-back nudge; a later verifier disarms it ----
  {
    const action = 'mcp__parity_fixture_eval__fixture_action';
    const verify = 'mcp__parity_fixture_eval__fixture_verify_file';
    const actionOnly = await run({
      fixture: fixture(action, { action: 'set_workbook_input' }),
      tools: toolDefs(action, verify), registry: externalReg()
    });
    A.eq(actionOnly.externalNudges.length, 1, 'an external mutation cannot stop as independently verified without read-back');
    A.ok(/NOT independently verified/.test(actionOnly.externalNudges[0].content), 'the nudge always permits a truthful unverified disclosure');

    const actionThenVerify = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: action }, { type: 'tool_args', index: 0, chunk: '{"action":"set_workbook_input"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: verify }, { type: 'tool_args', index: 0, chunk: '{"path":"book.xlsx"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Verified.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: actionThenVerify, tools: toolDefs(action, verify), registry: externalReg() })).externalNudges.length, 0, 'a successful connector read-back disarms the external guard');

    const status = 'mcp__parity_fixture_eval__fixture_status';
    const artifactActionThenStatus = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: action }, { type: 'tool_args', index: 0, chunk: '{"action":"set_workbook_input"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: status }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Verified.' }, { type: 'done', finishReason: 'stop' }],
      [{ type: 'text', delta: 'The artifact was not independently verified.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: artifactActionThenStatus, tools: toolDefs(action, status, verify), registry: externalReg() })).externalNudges.length, 1,
      'generic status cannot discharge artifact verification debt when a dedicated verifier exists');

    const readFile = 'mcp__parity_fixture_eval__fixture_read_file';
    const artifactActionThenRead = { turns: [
      artifactActionThenStatus.turns[0],
      [{ type: 'tool_start', index: 0, id: 'c2', name: readFile }, { type: 'tool_args', index: 0, chunk: '{"path":"book.xlsx"}' }, { type: 'done', finishReason: 'tool_calls' }],
      artifactActionThenStatus.turns[2], artifactActionThenStatus.turns[3]
    ] };
    A.eq((await run({ fixture: artifactActionThenRead, tools: toolDefs(action, readFile, verify), registry: externalReg() })).externalNudges.length, 1,
      'reading artifact contents does not substitute for a dedicated freshness verifier when one exists');

    A.eq((await run({ fixture: artifactActionThenStatus, tools: toolDefs(action, status), registry: externalReg() })).externalNudges.length, 0,
      'artifact freshness does not spend an impossible turn when the connector exposes no strong verifier');

    const ordinaryActionThenStatus = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: action }, { type: 'tool_args', index: 0, chunk: '{"action":"restart_service"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: status }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Verified.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: ordinaryActionThenStatus, tools: toolDefs(action, status, verify), registry: externalReg() })).externalNudges.length, 0,
      'generic status remains valid read-back for an ordinary non-artifact external action');

    const wrongConnector = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: action }, { type: 'tool_args', index: 0, chunk: '{"action":"set_workbook_input"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: 'mcp__other__read_status' }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Verified.' }, { type: 'done', finishReason: 'stop' }],
      [{ type: 'text', delta: 'Still done.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ fixture: wrongConnector, tools: toolDefs(action, verify, 'mcp__other__read_status'), registry: externalReg() })).externalNudges.length, 1,
      'reading a different connector cannot verify this connector\'s mutation');

    A.eq((await run({ fixture: fixture(action, { action: 'set_workbook_input' }), tools: toolDefs(action), registry: externalReg() })).externalNudges.length, 0,
      'a connector with no read-back tool does not spend an impossible turn');

    A.eq((await run({ fixture: fixture(action, { action: 'set_workbook_input' }), tools: toolDefs(action, verify), registry: externalReg(true) })).externalNudges.length, 0,
      'a failed external action changed no proven state and arms nothing');
  }

  // ---- 9. FAILED-CHECK REPAIR: a successful tool call can still prove a command failed. Put a fixed,
  //          proximal system boundary immediately after that result so the next model turn inspects the
  //          expectation source before mutating instead of guessing from an exit marker. ----
  {
    const command = 'mcp__parity_fixture_eval__fixture_run_command';
    const failed = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: command }, { type: 'tool_args', index: 0, chunk: '{"name":"check"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'I will inspect before repairing.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    const registry = makeRegistry();
    registry.register({ impact: 'none', name: command, schema: { type: 'object', properties: {} }, run: async () => JSON.stringify({ exitCode: 7, stderr: 'REPAIR-CHECK-FAIL-17 value=1' }) });
    const { messages, failedCheckNudges } = await run({ fixture: failed, tools: toolDefs(command), registry });
    A.eq(failedCheckNudges.length, 1, 'an explicit non-zero command result adds one proximal repair nudge');
    A.ok(/Do not mutate yet/.test(failedCheckNudges[0].content) && /test, check, or config/.test(failedCheckNudges[0].content),
      'the nudge requires expectation-source inspection before repair');
    const resultAt = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'c1');
    A.eq(messages[resultAt + 1], failedCheckNudges[0], 'the repair boundary sits immediately after the failed command result');

    const passingRegistry = makeRegistry();
    passingRegistry.register({ impact: 'none', name: command, schema: { type: 'object', properties: {} }, run: async () => JSON.stringify({ exitCode: 0, stdout: 'PASS' }) });
    A.eq((await run({ fixture: failed, tools: toolDefs(command), registry: passingRegistry })).failedCheckNudges.length, 0,
      'a zero exit code adds no failed-check repair nudge');
  }

  // ---- 10. SOURCE GROUNDING: discovery metadata and search snippets are not retrieved sources. If the
  //           user asked for citations and the same connector exposes a fetch/read tool, buy one bounded turn. ----
  {
    const inspect = 'mcp__parity_fixture_eval__fixture_inspect';
    const fetch = 'mcp__parity_fixture_eval__fixture_fetch';
    const inspectOnly = await run({
      user: 'Use both sources and attach each source to its claim.',
      fixture: fixture(inspect, {}, 2), tools: toolDefs(inspect, fetch), registry: externalReg()
    });
    A.eq(inspectOnly.sourceNudges.length, 1,
      'a source-citation task cannot stop after discovery metadata when a source reader exists');
    A.ok(/every source you cite/.test(inspectOnly.sourceNudges[0].content) && /not source retrieval/.test(inspectOnly.sourceNudges[0].content),
      'the nudge distinguishes discovery from retrieval and requires every cited source');

    const inspectThenFetch = { turns: [
      [{ type: 'tool_start', index: 0, id: 'c1', name: inspect }, { type: 'tool_args', index: 0, chunk: '{}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'tool_start', index: 0, id: 'c2', name: fetch }, { type: 'tool_args', index: 0, chunk: '{"path":"/a"}' }, { type: 'done', finishReason: 'tool_calls' }],
      [{ type: 'text', delta: 'Grounded answer with /a.' }, { type: 'done', finishReason: 'stop' }]
    ] };
    A.eq((await run({ user: 'Cite the source.', fixture: inspectThenFetch, tools: toolDefs(inspect, fetch), registry: externalReg() })).sourceNudges.length, 0,
      'a successful source fetch disarms the grounding guard');
    A.eq((await run({ user: 'Cite the source.', fixture: fixture(inspect, {}), tools: toolDefs(inspect), registry: externalReg() })).sourceNudges.length, 0,
      'source grounding does not spend an impossible turn when the connector exposes no reader');
    A.eq((await run({ user: 'Summarize the available connector capabilities.', fixture: fixture(inspect, {}), tools: toolDefs(inspect, fetch), registry: externalReg() })).sourceNudges.length, 0,
      'an inspect-only task that asks for no source grounding does not spend an extra turn');
  }

  // ---- STANDALONE PAGES (live walkthrough 2026-10-13): a web page saved in the agent's own workspace, with no project
  //      around it, has no build or test to run — demanding one sent the agent into file:// browsing and shell reads of
  //      its own deliverable after it had said "Done." Inside a project the same file is still code to verify. ----
  {
    for (const p of ['launch-countdown.html', 'site/index.htm', 'logo.svg', 'theme.css']) {
      const { nudges } = await run({ fixture: fixture('fs_write', { path: p, content: 'x' }), standalone: true });
      A.eq(nudges.length, 0, 'a standalone page (' + p + ') with no project never triggers verify-on-stop');
    }
    A.eq((await run({ fixture: fixture('fs_write', { path: 'launch-countdown.html', content: 'x' }) })).nudges.length, 1,
      'the same page inside a project is still code to verify');
    A.eq((await run({ fixture: fixture('fs_write', { path: 'src/app.js', content: 'x' }), standalone: true })).nudges.length, 1,
      'a script in a standalone workspace is still code to verify');
  }

  A.report('loop.verify-on-stop.test');
})().catch(e => { console.log('FAIL: loop.verify-on-stop.test threw -- ' + (e && e.stack || e)); process.exit(1); });
