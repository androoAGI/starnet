/* node test/loop.acceptance-on-stop.test.js — ACCEPTANCE-ON-STOP (SOP lane, 2026-08-21).

   An SOP recipe attaches a typed acceptance contract the HOST evaluates. Evaluating it only after the loop returned
   could report a failure but never repair one. This proves the loop's bounded follow-up: when the model tries to
   finish and the host probe says a check still fails, the failing checks are NAMED to the model and it buys exactly
   one more turn; a probe that passes (or is absent, disabled, or throws) never costs a turn; and the run always
   terminates. The verdict itself stays the host's — the loop only reports how many nudges it spent. */
'use strict';
const A = require('./_assert.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const WRITE_SCHEMA = { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
const toolDefs = (...names) => names.map(n => ({ type: 'function', function: { name: n, description: '', parameters: { type: 'object', properties: {} } } }));

// every turn is a plain tool-free answer (the model thinks it is done), unless `writeFirst`.
function fixture(stops, writeFirst) {
  const turns = [];
  if (writeFirst) turns.push([{ type: 'tool_start', index: 0, id: 'c1', name: 'fs_write' }, { type: 'tool_args', index: 0, chunk: JSON.stringify({ path: 'out/report.md', content: 'x' }) }, { type: 'done', finishReason: 'tool_calls' }]);
  for (let i = 0; i < stops; i++) turns.push([{ type: 'text', delta: 'All set.' }, { type: 'done', finishReason: 'stop' }]);
  return { turns };
}
function reg() {
  const r = makeRegistry();
  r.register({ impact: 'none', name: 'fs_write', schema: WRITE_SCHEMA, run: async (a) => 'wrote ' + a.path });
  return r;
}
async function run(o) {
  const emit = makeEmitter(A.makeBus(), () => {});
  const provider = makeReplayProvider(o.fixture);
  const messages = [{ role: 'user', content: 'produce the report' }];
  const r = reg();
  const res = await runAgentLoop({
    messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', tools: toolDefs('fs_write'),
    limits: Object.assign({ maxIters: 8, grace: false, verifyOnStop: false }, o.limits || {}),
    acceptanceProbe: o.probe,
    dispatch: (c, ctx) => r.dispatch(c, ctx), capCtx: openCtx()
  });
  const nudges = messages.filter(m => m.role === 'system' && String(m.content).indexOf('<acceptance_before_done>') === 0);
  return { res, messages, nudges };
}
const failing = () => ({ checks: [
  { id: 'sop-1', type: 'artifact_contains', status: 'failed', code: 'artifact_not_produced_by_run', path: 'out/report.md' },
  { id: 'sop-2', type: 'verification_passed', status: 'failed', code: 'matching_verification_missing', command: 'npm test' }
] });
const passing = () => ({ checks: [{ id: 'sop-1', type: 'artifact_exists', status: 'passed', code: 'artifact_exists' }] });

(async () => {
  // ---- 1. THE CORE CASE: contract fails at stop -> exactly one nudge naming the checks, run continues, then ends ----
  {
    let probes = 0;
    const { res, messages, nudges } = await run({ fixture: fixture(3), probe: async () => { probes++; return failing(); } });
    A.eq(nudges.length, 1, 'a failing contract at stop buys exactly one nudge');
    A.ok(/sop-1 \[artifact_contains out\/report\.md\]: artifact_not_produced_by_run/.test(nudges[0].content), 'the nudge NAMES the failing artifact check and its code');
    A.ok(/sop-2 \[verification_passed `npm test`\]: matching_verification_missing/.test(nudges[0].content), 'the nudge NAMES the failing command check');
    A.ok(/never claim it holds/.test(nudges[0].content), 'an honest "cannot satisfy" is the accepted way out');
    A.eq(res.reason, 'done', 'the run still terminates after the nudge');
    A.eq(res.acceptanceNudges, 1, 'the return reports the spent nudge');
    const idx = messages.findIndex(m => m.role === 'system' && /acceptance_before_done/.test(String(m.content)));
    A.ok(messages.slice(idx + 1).some(m => m.role === 'assistant'), 'the nudge bought a REAL model turn after it');
    A.eq(probes, 1, 'the probe ran once (the second stop is past the budget — no probe, no nudge)');
  }
  // ---- 2. a passing contract costs nothing ----
  {
    const { res, nudges } = await run({ fixture: fixture(2), probe: async () => passing() });
    A.eq(nudges.length, 0, 'a passing contract never nudges');
    A.eq(res.acceptanceNudges, undefined, 'no nudge -> no field');
    A.eq(res.turns, 1, 'the run ended on its first answer');
  }
  // ---- 3. no probe / disabled / throwing probe -> never traps the model ----
  {
    const a = await run({ fixture: fixture(2) });
    A.eq(a.nudges.length, 0, 'no contract, no nudge');
    const b = await run({ fixture: fixture(2), probe: async () => failing(), limits: { acceptanceOnStop: false } });
    A.eq(b.nudges.length, 0, 'acceptanceOnStop:false disables the follow-up even with a failing contract');
    const c = await run({ fixture: fixture(2), probe: async () => { throw new Error('reader down'); } });
    A.eq(c.nudges.length, 0, 'a throwing probe counts as nothing to repair (the host still assesses at the end)');
    A.eq(c.res.reason, 'done', 'and the run ends cleanly');
  }
  // ---- 4. budget: { max: 2 } sends the model back twice, then lets it finish ----
  {
    const { res, nudges } = await run({ fixture: fixture(4), probe: async () => failing(), limits: { acceptanceOnStop: { max: 2 } } });
    A.eq(nudges.length, 2, 'max:2 buys two follow-ups');
    A.eq(res.acceptanceNudges, 2, 'both are reported');
    A.eq(res.reason, 'done', 'the run still terminates');
  }
  // ---- 5. a contract that becomes satisfied after the nudge: probe flips, no second nudge even with budget ----
  {
    let n = 0;
    const { nudges, res } = await run({ fixture: fixture(3, true), probe: async () => (n++ === 0 ? failing() : passing()), limits: { acceptanceOnStop: { max: 3 } } });
    A.eq(nudges.length, 1, 'once the checks hold, the loop stops asking');
    A.eq(res.reason, 'done', 'and ends');
  }
  A.report();
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
