/* node test/loop.verify-on-stop-failed-check.test.js — a check that RAN and FAILED is not verification.

   Audit probe (2026-09-22): fs_write src code -> shell_exec `npm test` prints "[exit 1]" -> the model says
   "Fixed and verified. All done." -> the run ended 'done'. The verify-on-stop ledger cleared on ANY non-error
   check result, but shell_exec reports a non-zero exit as ordinary content and verify.run reports "✗ FAILED" as an
   ordinary ok result. This pins: only a PASSING check clears the ledger (host-authored exit marker / verdict), a
   failing one leaves the stop nudge armed — and the nudge says the check failed instead of "you ran nothing" —
   and a later passing check still clears it. Tool results use the exact shapes shell.js / verify.js produce.
   Replay provider, stub registry: no network, no processes, no sidecar. */
'use strict';
const A = require('./_assert.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const EXEC_SCHEMA = { type: 'object', required: ['command'], properties: { command: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));

// shell.js: body + '\n[exit ' + code + (truncated) + killedNote + ']', summary 'exit N (Mms)'.
const shellOut = (body, code, killed) => ({ content: body + '\n[exit ' + code + (killed ? ' — KILLED (timed out after 1000ms)' : '') + ']', summary: 'exit ' + code + ' (5ms)' });
// verify.js: '✓ PASSED — `cmd`\n' / '✗ FAILED — `cmd`\n' + body + '\n[exit N]', summary 'verify passed|FAILED (Mms)'.
const verifyOut = (passed, cmd, body, code) => ({ content: (passed ? '✓ PASSED' : '✗ FAILED') + ' — `' + cmd + '`\n' + body + '\n[exit ' + code + ']', summary: (passed ? 'verify passed' : 'verify FAILED') + ' (5ms)' });

const write = (id) => [{ type: 'tool_start', index: 0, id, name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: '{"path":"src/app.js","content":"module.exports = 1;"}' }, { type: 'done', finishReason: 'tool_calls' }];
const exec = (id, command) => [{ type: 'tool_start', index: 0, id, name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: JSON.stringify({ command }) }, { type: 'done', finishReason: 'tool_calls' }];
const verify = (id, cmd) => [{ type: 'tool_start', index: 0, id, name: 'verify_run' }, { type: 'tool_args', index: 0, chunk: JSON.stringify({ cmd }) }, { type: 'done', finishReason: 'tool_calls' }];
const say = (t) => [{ type: 'text', delta: t }, { type: 'done', finishReason: 'stop' }];
const CLAIM = 'Fixed and verified. All done.';

// shellResults / verifyResults are consumed in call order.
function reg(shellResults, verifyResults) {
  const r = makeRegistry();
  const s = (shellResults || []).slice(), v = (verifyResults || []).slice();
  r.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
  r.register({ impact: 'none', name: 'shell_exec', schema: EXEC_SCHEMA, run: async () => s.shift() || shellOut('ok', 0) });
  r.register({ impact: 'none', name: 'verify_run', schema: { type: 'object', properties: { cmd: { type: 'string' } } }, run: async () => v.shift() || verifyOut(true, 'npm test', 'ok', 0) });
  return r;
}
async function run(turns, registry) {
  const bus = A.makeBus();
  const emit = makeEmitter(bus, () => {});
  const provider = makeReplayProvider({ turns });
  const messages = [{ role: 'user', content: 'fix the failing test' }];
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: toolDefs('fs_write', 'verify_run', 'shell_exec'),
    limits: { maxIters: 10, grace: false }, dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx()
  });
  const nudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<verify_before_done>') === 0);
  return { res, messages, nudges, calls: provider.callCount() };
}
const modelCalledAfter = (messages, m) => messages.slice(messages.indexOf(m) + 1).some(x => x.role === 'assistant');

(async () => {
  // ---- 1. THE AUDIT PROBE: write -> npm test [exit 1] -> "verified, done" -> the nudge still fires ----
  {
    const { res, messages, nudges } = await run(
      [write('w1'), exec('x1', 'npm test'), say(CLAIM), say('The test still fails; the change is NOT verified.')],
      reg([shellOut('FAIL test/app.test.js\n  1 failing', 1)]));
    A.eq(nudges.length, 1, 'a failing shell check does not clear the ledger — the stop nudge fires');
    A.ok(nudges[0] && modelCalledAfter(messages, nudges[0]), 'the nudge buys a real model turn instead of ending on the claim');
    A.ok(nudges[0] && /did NOT pass/.test(nudges[0].content) && /npm test/.test(nudges[0].content), 'the nudge says the check that ran did NOT pass (and names it)');
    A.ok(nudges[0] && !/without running anything/.test(nudges[0].content), 'the nudge does not falsely claim nothing was run');
    A.ok(nudges[0] && /src\/app\.js/.test(nudges[0].content), 'the nudge still names the unverified file');
    const claimAt = messages.findIndex(m => m.role === 'assistant' && m.content === CLAIM);
    A.ok(claimAt >= 0 && messages[claimAt + 1] === nudges[0], 'the nudge lands right after the unproven "verified" claim');
    A.eq(res.reason, 'done', 'bounded: the run still terminates after one nudge');
  }

  // ---- 2. a later PASSING check clears it: [exit 1] then [exit 0] -> no nudge ----
  {
    const { nudges, res } = await run(
      [write('w1'), exec('x1', 'npm test'), exec('x2', 'npm test -- --runInBand'), say(CLAIM)],
      reg([shellOut('1 failing', 1), shellOut('12 passing', 0)]));
    A.eq(nudges.length, 0, 'a subsequent [exit 0] check clears the ledger');
    A.eq(res.reason, 'done', 'and the run ends on the claim');
  }

  // ---- 3. verify.run "✗ FAILED" is not a pass; "✓ PASSED" is ----
  {
    const failed = await run([write('w1'), verify('v1', 'npm test'), say(CLAIM), say('Still failing.')],
      reg([], [verifyOut(false, 'npm test', '1 failing', 1)]));
    A.eq(failed.nudges.length, 1, 'verify_run FAILED leaves the ledger armed — the nudge fires');
    A.ok(failed.nudges[0] && /did NOT pass/.test(failed.nudges[0].content), 'and says the verification did not pass');

    const passed = await run([write('w1'), verify('v1', 'npm test'), say(CLAIM)],
      reg([], [verifyOut(true, 'npm test', '12 passing', 0)]));
    A.eq(passed.nudges.length, 0, 'verify_run PASSED clears the ledger');

    const fixedThenPassed = await run([write('w1'), verify('v1', 'npm test'), write('w2'), verify('v2', 'npm test'), say(CLAIM)],
      reg([], [verifyOut(false, 'npm test', '1 failing', 1), verifyOut(true, 'npm test', '12 passing', 0)]));
    A.eq(fixedThenPassed.nudges.length, 0, 'fail -> fix -> pass: the passing re-run clears it');
  }

  // ---- 4. a KILLED / timed-out check is not a pass, whatever code the dead child reported ----
  {
    const { nudges } = await run([write('w1'), exec('x1', 'npm test'), say(CLAIM), say('It timed out.')],
      reg([shellOut('RUNS test/app.test.js', 'null', true)]));
    A.eq(nudges.length, 1, 'a timed-out check leaves the ledger armed');
    const zeroKilled = await run([write('w1'), exec('x1', 'npm test'), say(CLAIM), say('It timed out.')],
      reg([shellOut('RUNS', 0, true)]));
    A.eq(zeroKilled.nudges.length, 1, 'KILLED in the marker outranks an exit code of 0');
  }

  // ---- 5. only the HOST marker counts: test output that merely MENTIONS a non-zero exit still passes ----
  {
    const { nudges } = await run([write('w1'), exec('x1', 'npm test'), say(CLAIM)],
      reg([shellOut('ok 1 - child reports [exit 3] when misconfigured\nok 2 - exit code 2 is surfaced\n12 passing', 0)]));
    A.eq(nudges.length, 0, 'the LAST [exit N] marker (the host\'s) decides — output prose cannot fail a passing run');
  }

  // ---- 6. the pure verdict reader, directly ----
  {
    const P = _internals.vosCheckPassed;
    const sh = (r) => P({ name: 'shell_exec', args: { command: 'npm test' } }, Object.assign({ ok: true, isError: false }, r));
    const vr = (r) => P({ name: 'verify.run', args: {} }, Object.assign({ ok: true, isError: false }, r));
    A.eq(sh(shellOut('x', 0)), true, 'exit 0 passes');
    A.eq(sh(shellOut('x', 1)), false, 'exit 1 fails');
    A.eq(sh(shellOut('x', -1)), false, 'a negative exit fails');
    A.eq(sh({ content: 'x\n[exit 0, output truncated to 64KB]', summary: 'exit 0 (5ms), truncated' }), true, 'a truncation note inside the marker is not a failure');
    A.eq(sh({ content: 'x\n[exit 0]\n\n[full-output receipt: 90000 characters]', summary: 'exit 0 (5ms)' }), true, 'a registry receipt after the marker does not hide it');
    A.eq(sh({ content: 'head…[elided — do not repeat this call]', summary: 'exit 2 (5ms)' }), false, 'a squeeze that cut the marker falls back to the host summary');
    A.eq(sh({ content: '{"exitCode":4}', summary: 'ok' }), false, 'with no marker and no exit summary, an explicit structured exit code still decides');
    A.eq(sh({ content: 'ran npm test', summary: 'ok' }), true, 'no failure evidence at all keeps the old behavior (counts as passed)');
    A.eq(sh({ ok: false, isError: true, content: 'tool shell_exec timed out after 1000ms', summary: 'timeout' }), false, 'an errored call never passes');
    A.eq(vr(verifyOut(false, 'npm test', 'x', 1)), false, 'verify FAILED fails');
    A.eq(vr({ content: '✗ FAILED — `npm test`\nx', summary: 'ok' }), false, 'the ✗ FAILED head alone is enough');
    A.eq(vr({ content: 'x', summary: 'verify FAILED (5ms)' }), false, 'the verify FAILED summary alone is enough');
    A.eq(vr(verifyOut(true, 'npm test', 'x', 0)), true, 'verify PASSED passes');
  }

  A.report('loop.verify-on-stop-failed-check.test');
})().catch(e => { console.log('FAIL: loop.verify-on-stop-failed-check.test threw -- ' + (e && e.stack || e)); process.exit(1); });
