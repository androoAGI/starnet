/* node test/shell.timeout-telemetry.test.js — A SHELL TIMEOUT MUST READ AS A TIMEOUT (h1 audit 2026-09-22).

   The probe: a timed-out command came back ok=true isError=false summary "exit -1 (2288ms)" — "timed out" lived only
   in the body, so the tool card, agent.tool_result telemetry and the recovery policy all read a successful call; and a
   requested timeout above the ceiling was clamped SILENTLY. Proves, through the REAL registry and the real loop's
   telemetry, that a killed command (timeout or abort) is an isError result whose summary names the cause and whose
   content keeps the partial output + the `[exit -1 — KILLED …]` receipt; that a clamp states requested vs effective;
   and that an ordinary non-zero exit is still a plain result with its `[exit N]` suffix untouched.

   Deterministic: an injected fake spawn (no real child process is ever started), platform 'linux' so the kill path is
   child.kill(). The only real waits are the shell's own 1000ms/1200ms timeouts (its minimum), bounded. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');

// fake child: LONGJOB prints a partial line then hangs until killed; FAILJOB exits 3; OKJOB exits 0.
const spawned = [];
function fakeSpawn(cmd) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { if (child.killed) return; child.killed = true; setImmediate(() => child.emit('close', null)); };
  spawned.push({ cmd: String(cmd), child });
  // the marker the shell echoes, with this call's nonce read back off the marked command (run-paths S1)
  const marker = (ec) => '\n' + require('./helpers/shell-marker.js').echoMarker(cmd, '/ws/a1', ec);
  setImmediate(() => {
    if (/LONGJOB/.test(cmd)) { child.stdout.emit('data', Buffer.from('partial-output-line\n')); return; }
    if (/FAILJOB/.test(cmd)) { child.stdout.emit('data', Buffer.from('boom happened' + marker(3))); child.emit('close', 3); return; }
    child.stdout.emit('data', Buffer.from('fine' + marker(0))); child.emit('close', 0);
  });
  return child;
}
const call = (args, id) => ({ id: id || 'c1', name: 'shell.exec', args, argsRaw: JSON.stringify(args) });

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sh-tt-'));
  try {
    const shell = makeShellTool({ spawn: fakeSpawn, fs, pathMod: path, root, platform: 'linux', clock: { now: () => 0 }, limits: { maxTimeoutMs: 1200 } });
    const reg = makeRegistry();
    shell.register ? shell.register(reg) : reg.register(shell.execTool);
    const ctx = (extra) => Object.assign({ agentId: 'a1', runId: 'r1', callId: 'c1', emit: () => {} }, extra || {});

    // ---- 1. a timed-out command is an ERROR whose summary says timeout; partial output + [exit …] receipt kept ----
    const t0 = Date.now();
    const r1 = await reg.dispatch(call({ cmd: 'LONGJOB', timeoutMs: 1000 }), ctx());
    const took = Date.now() - t0;
    A.eq([r1.ok, r1.isError], [false, true], 'a timed-out command is ok:false isError:true (was ok:true)');
    A.ok(/timeout/.test(r1.summary), 'summary names the timeout: ' + r1.summary);
    A.ok(/TIMEOUT: the command did not finish within its 1000ms timeout/.test(r1.content), 'content states the timeout and its value');
    A.ok(/KILLED/.test(r1.content) && /did not complete/.test(r1.content), 'content says the command was killed and did not complete');
    A.ok(r1.content.indexOf('partial-output-line') >= 0, 'the partial output captured before the kill is kept');
    A.ok(/\n\[exit -1[^\]]*timed out after 1000ms[^\]]*\]\s*$/.test(r1.content), 'the [exit -1 — KILLED (timed out …)] receipt stays the LAST line: ' + JSON.stringify(r1.content.slice(-70)));
    A.ok(!/\[timeout: requested/.test(r1.content), 'no clamp note when the requested timeout was honoured');
    A.ok(took >= 900 && took < 5000, 'the kill fired at the requested timeout (' + took + 'ms)');
    A.ok(spawned[spawned.length - 1].child.killed, 'the child was actually killed');

    // ---- 2. a requested timeout ABOVE the ceiling is clamped out loud: requested + effective both stated ----
    const r2 = await reg.dispatch(call({ cmd: 'LONGJOB', timeoutMs: 999999 }, 'c2'), ctx({ callId: 'c2' }));
    A.eq(r2.isError, true, 'the clamped long job still times out as an error');
    A.ok(/requested 999999ms is above the 1200ms ceiling/.test(r2.content), 'the clamp names the requested value and the ceiling');
    A.ok(/effective timeout of 1200ms/.test(r2.content), 'the clamp names the effective value');
    A.ok(/timed out after 1200ms/.test(r2.content), 'it was killed at the EFFECTIVE timeout');

    // ---- 3. a requested timeout BELOW the minimum on a command that finishes: note on an ordinary result ----
    const r3 = await reg.dispatch(call({ cmd: 'OKJOB', timeoutMs: 50 }, 'c3'), ctx({ callId: 'c3' }));
    A.eq([r3.ok, r3.isError], [true, false], 'a finished command is still an ordinary result');
    A.ok(/^\[timeout: requested 50ms is below the 1000ms minimum — this command ran with an effective timeout of 1000ms\]\n/.test(r3.content), 'the low-side clamp is the FIRST line: ' + JSON.stringify(r3.content.slice(0, 120)));
    A.ok(/\n\[exit 0\]$/.test(r3.content), 'the [exit 0] receipt is untouched and last');

    // ---- 4. an ordinary NON-ZERO exit is NOT an error (another lane parses [exit N]) ----
    const r4 = await reg.dispatch(call({ cmd: 'FAILJOB' }, 'c4'), ctx({ callId: 'c4' }));
    A.eq([r4.ok, r4.isError], [true, false], 'exit 3 stays ok:true isError:false');
    A.ok(/^exit 3 \(/.test(r4.summary), 'summary is the plain exit summary: ' + r4.summary);
    A.ok(/boom happened\n\[exit 3\]$/.test(r4.content), 'content ends with the exact [exit 3] suffix: ' + JSON.stringify(r4.content));
    A.ok(!/\[timeout:/.test(r4.content), 'no clamp note on a default timeout');

    // ---- 5. an ABORTED command (the run was stopped) is an error too, summary 'cancelled', and it is FAST ----
    const ac = new AbortController();
    const tA = Date.now();
    const p5 = reg.dispatch(call({ cmd: 'LONGJOB', timeoutMs: 1200 }, 'c5'), ctx({ callId: 'c5', signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    const r5 = await p5;
    A.eq([r5.ok, r5.isError, r5.summary], [false, true, 'cancelled'], 'an aborted command is an isError result named cancelled');
    A.ok(/CANCELLED/.test(r5.content) && /KILLED \(aborted\)/.test(r5.content), 'content says it was stopped and killed');
    A.ok(r5.content.indexOf('partial-output-line') >= 0, 'partial output kept on abort too');
    A.ok(Date.now() - tA < 1000, 'a cooperative shell stop settles on its own kill (no grace wait): ' + (Date.now() - tA) + 'ms');

    // ---- 6. TELEMETRY: through the real loop, agent.tool_result carries isError + the timeout summary ----
    {
      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      const emit = makeEmitter(bus, () => {});
      const provider = makeReplayProvider({ turns: [
        [{ type: 'tool_start', index: 0, id: 't1', name: 'shell_exec' }, { type: 'tool_args', index: 0, chunk: '{"cmd":"LONGJOB","timeoutMs":1000}' }, { type: 'done', finishReason: 'tool_calls' }],
        [{ type: 'text', delta: 'the command timed out' }, { type: 'done', finishReason: 'stop' }]
      ] });
      const messages = [{ role: 'user', content: 'run it' }];
      const res = await runAgentLoop({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
        model: 'replay/model', agentId: 'a1', runId: 'r6', tools: [], limits: { maxIters: 4, grace: false, failureRecovery: false },
        dispatch: (c, dctx) => reg.dispatch(Object.assign({}, c, { name: c.name === 'shell_exec' ? 'shell.exec' : c.name }), Object.assign({}, dctx, { agentId: 'a1', runId: 'r6', emit: () => {} })),
        capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a1', room: 'office' } });
      const tr = seq.find(e => e.name === 'agent.tool_result' && e.payload.callId === 't1');
      A.ok(!!tr, 'an agent.tool_result was emitted for the shell call');
      A.eq([tr && tr.payload.ok, tr && tr.payload.isError, tr && tr.payload.summary], [false, true, 'timeout'], 'telemetry reads the timeout as an ERROR named timeout');
      const toolMsg = res.messages.find(m => m.role === 'tool');
      A.ok(toolMsg && /^ERROR: /.test(String(toolMsg.content)) && /TIMEOUT/.test(String(toolMsg.content)), 'the model-visible tool message is an ERROR that says TIMEOUT');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('shell.timeout-telemetry.test');
})().catch(e => { console.log('FAIL: shell.timeout-telemetry.test threw — ' + (e && e.stack || e)); process.exit(1); });
