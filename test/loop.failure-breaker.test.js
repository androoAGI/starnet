/* node test/loop.failure-breaker.test.js — Step 2 F1 (a)+(b) of the 2026-09-22 Hermes audit: loop DETECTION for
   the stuck shapes the identical-failure loop guard cannot see (sidecar/loop-breaker.js, wired in loop.js step 9).

   (a) UNKNOWN-TOOL STRIKES. Audit probe: 15 turns of a hallucinated `launch_rocket`, each answered a bare
       "unknown tool", nothing stopped. Now the registry's answer names the closest REAL tools the run can call,
       and three consecutive turns whose every call named a tool that does not exist end the run 'error' with
       failureCode 'unknown_tools' — on every surface (a watched run too).
   (b) SAME-TOOL FAILURE STREAK WITH VARYING ARGUMENTS. Audit probe: 15 net_get failures on 15 different URLs, no
       stop. Now one <failure_streak> nudge at 3 consecutive failures everywhere; a hard stop at 8 only on an
       UNATTENDED run (o.unattended === true, host-declared); an interactive run is only ever warned.

   Deterministic: scripted providers, the REAL tools/registry.js for the unknown-tool answers, no network. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry, closestToolNames } = require('../sidecar/tools/registry.js');
const Breaker = require('../sidecar/loop-breaker.js');

const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const usage = { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
// turns: array of arrays of { name, args } (one model turn each); after the script, a plain final text turn.
function scripted(turns) {
  const script = turns.map((calls, t) => calls.map((c, i) => [
    { type: 'tool_start', index: i, id: 't' + t + '_' + i, name: c.name },
    { type: 'tool_args', index: i, chunk: JSON.stringify(c.args || {}) }
  ]).reduce((a, b) => a.concat(b), []).concat([usage, { type: 'done', finishReason: 'tool_calls' }]));
  script.push([{ type: 'text', delta: 'final answer' }, usage, { type: 'done', finishReason: 'stop' }]);
  let n = 0;
  return {
    async *stream() { const t = script[Math.min(n, script.length - 1)]; n++; for (const ev of t) yield ev; },
    priceOf: () => ({ prompt: '0', completion: '0' }), contextLimit: () => 8000, callCount: () => n
  };
}
const repeat = (k, fn) => Array.from({ length: k }, (_, i) => fn(i));
async function run(provider, extra) {
  const { seq, emit } = setup();
  const messages = [{ role: 'user', content: 'go' }];
  const res = await runAgentLoop(Object.assign({ messages, provider, emit, cost: makeCostEngine({ priceOf: provider.priceOf }),
    model: 'replay/model', agentId: 'a', runId: 'r', capCtx: openCtx() }, extra || {}));
  return { res, seq, messages };
}
const sys = (messages, tag) => messages.filter(m => m.role === 'system' && m.content.indexOf('<' + tag + '>') === 0);
const errors = seq => seq.filter(e => e.name === 'agent.run.error');

// A real registry with the run's real tools; the dispatch hands it the advertised wire names like index.js does.
function realRegistry() {
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_read', scope: 'read', schema: { type: 'object' }, run: async () => 'file body' });
  reg.register({ impact: 'none', name: 'fs_list', scope: 'read', schema: { type: 'object' }, run: async () => 'a.txt' });
  reg.register({ impact: 'none', name: 'web_fetch', scope: 'read', schema: { type: 'object' }, run: async () => 'page' });
  const names = ['fs_read', 'fs_list', 'web_fetch'];
  return { reg, dispatch: (c, ctx) => reg.dispatch(c, Object.assign({}, ctx, { toolNames: names })), tools: names.map(n => ({ type: 'function', function: { name: n, parameters: { type: 'object' } } })) };
}

(async () => {
  // ---- registry answer: closest REAL tools, or an honest "nothing similar" ----
  {
    A.eq(closestToolNames('fs_raed', ['fs_read', 'fs_list', 'web_fetch', 'shell_exec']), ['fs_read'], 'a typo names the intended tool (edit distance) and nothing that is not close');
    A.eq(closestToolNames('fs_lst', ['fs_read', 'fs_list', 'fs_last']), ['fs_last', 'fs_list'], 'equally close names sort deterministically (distance, then name)');
    A.eq(closestToolNames('fs.read', ['fs_read', 'shell_exec']), ['fs_read'], 'a dotted/underscored slip resolves to the real wire name');
    A.eq(closestToolNames('launch_rocket', ['fs_read', 'fs_list', 'web_fetch']), [], 'a pure hallucination gets no fake suggestion');
    A.eq(closestToolNames('read_file', ['fs_read', 'fs_list', 'web_fetch']), ['fs_read'], 'a shared real word (read) is a suggestion even at a large edit distance');
    const { reg } = realRegistry();
    const typo = await reg.dispatch({ id: 'c', name: 'fs_raed', args: {}, argsRaw: '{}' }, { toolNames: ['fs_read', 'fs_list', 'web_fetch'] });
    A.eq(typo.isError, true, 'an unknown tool is still an error result');
    A.eq(typo.summary, 'unknown-tool', 'its summary is the stable unknown-tool marker the breaker counts');
    A.ok(/^unknown tool: fs_raed — /.test(typo.content), 'the answer still starts "unknown tool: <name>" (existing contract)');
    A.ok(/Closest real tools: fs_read\./.test(typo.content), 'the answer names the closest real tool: ' + typo.content);
    const ghost = await reg.dispatch({ id: 'c', name: 'launch_rocket', args: {}, argsRaw: '{}' }, { toolNames: ['fs_read'] });
    A.ok(/No available tool has a similar name/.test(ghost.content), 'a hallucination is told nothing is similar, not handed a random tool');
    const blank = await reg.dispatch({ id: 'c', name: '', args: {}, argsRaw: '{}' }, {});
    A.ok(/\(empty name\)/.test(blank.content) && !/Closest/.test(blank.content), 'an empty name gets the terse anti-priming answer, never the catalog');
    const fallback = await reg.dispatch({ id: 'c', name: 'fs_lsit', args: {}, argsRaw: '{}' }, {});
    A.ok(/Closest real tools: fs_list/.test(fallback.content), 'with no toolNames the registry falls back to its own names');
  }

  // ---- (a) THE AUDIT PROBE: a hallucinated tool every turn -> stopped after 3 strikes, even on a WATCHED run ----
  for (const unattended of [false, true]) {
    const provider = scripted(repeat(15, () => [{ name: 'launch_rocket', args: { target: 'moon' } }]));
    const { dispatch, tools } = realRegistry();
    const { res, seq, messages } = await run(provider, { dispatch, tools, unattended });
    const label = unattended ? ' (unattended)' : ' (interactive)';
    A.eq(res.reason, 'error', 'three unknown-tool strikes end the run error' + label);
    A.eq(provider.callCount(), 3, 'stopped after exactly 3 model turns, not 15' + label);
    A.eq(res.failureStage, 'tool_loop', 'failureStage names the tool loop' + label);
    A.eq(res.failureCode, 'unknown_tools', 'failureCode unknown_tools' + label);
    const errs = errors(seq);
    A.eq(errs.length, 1, 'exactly one agent.run.error' + label);
    A.ok(/do not exist \(launch_rocket\) on 3 turns in a row/.test(errs[0].payload.message), 'the error names the fake tool and the strike count: ' + errs[0].payload.message);
    A.eq(errs[0].payload.transient, false, 'a strike-out is not transient' + label);
    const results = messages.filter(m => m.role === 'tool');
    A.eq(results.length, 3, 'every one of the 3 calls got its paired result (provider-valid transcript)' + label);
    A.ok(results.every(m => /unknown tool: launch_rocket/.test(m.content)), 'each result told the model the tool does not exist' + label);
  }

  // ---- (a) a turn with ANY real call resets the strikes (Hermes mixed-batch rule) ----
  {
    const provider = scripted([
      [{ name: 'launch_rocket' }], [{ name: 'launch_rocket' }],
      [{ name: 'launch_rocket' }, { name: 'fs_read', args: { path: 'a' } }],   // mixed: the real call runs, strikes reset
      [{ name: 'launch_rocket' }], [{ name: 'launch_rocket' }]
    ]);
    const { dispatch, tools } = realRegistry();
    const { res } = await run(provider, { dispatch, tools, unattended: true });
    A.eq(res.reason, 'done', 'two strikes, a mixed turn, two strikes -> never 3 consecutive -> the run finishes');
    A.ok(provider.callCount() >= 6, 'all five tool turns ran before the final answer (' + provider.callCount() + ' model calls)');
  }

  // ---- (b) varying-argument failure streak: UNATTENDED -> nudge at 3, stop at 8 ----
  const alwaysFail = async (c) => ({ ok: false, isError: true, content: 'fetch failed for ' + ((c.args && c.args.url) || '?'), summary: 'error' });
  {
    const provider = scripted(repeat(15, i => [{ name: 'net_get', args: { url: 'https://h' + i + '.invalid/' } }]));
    const { res, seq, messages } = await run(provider, { dispatch: alwaysFail, unattended: true });
    A.eq(res.reason, 'error', 'unattended: a varying-arg failure streak is stopped');
    A.eq(provider.callCount(), 8, 'stopped at the 8th consecutive failure, not 15');
    A.eq(res.failureCode, 'repeated_tool_failure', 'failureCode repeated_tool_failure');
    A.eq(res.failureStage, 'tool_loop', 'failureStage tool_loop');
    const errs = errors(seq);
    A.eq(errs.length, 1, 'one agent.run.error');
    A.ok(/net_get failed 8 times in a row/.test(errs[0].payload.message) && /unattended/.test(errs[0].payload.message), 'the stop names the tool, the count and why it stopped: ' + errs[0].payload.message);
    const nudges = sys(messages, 'failure_streak');
    A.eq(nudges.length, 1, 'exactly one failure-streak nudge before the stop');
    A.ok(/net_get has now failed 3 times in a row/.test(nudges[0].content), 'the nudge fires at the 3rd consecutive failure');
    A.ok(/stopped after 8 consecutive failures/.test(nudges[0].content), 'an unattended nudge says the stop is coming');
    A.eq(sys(messages, 'loop_guard').length, 0, 'the identical-args loop guard never fired (no two calls were identical)');
  }

  // ---- (b) the SAME streak on an INTERACTIVE run is only warned ----
  {
    const provider = scripted(repeat(15, i => [{ name: 'net_get', args: { url: 'https://h' + i + '.invalid/' } }]));
    const { res, seq, messages } = await run(provider, { dispatch: alwaysFail, limits: { maxIters: 12, grace: false } });
    A.eq(res.reason, 'max_iters', 'interactive: the streak never hard-stops (runs to the Commander\'s own ceiling)');
    A.eq(provider.callCount(), 12, 'all 12 permitted turns ran');
    A.eq(errors(seq).length, 0, 'no loop-breaker error on a watched run');
    const nudges = sys(messages, 'failure_streak');
    A.eq(nudges.length, 1, 'still exactly one nudge (it fires once per streak)');
    A.ok(!/unattended/.test(nudges[0].content), 'the interactive nudge does not threaten a stop that will not happen');
  }

  // ---- (b) a success of the same tool clears the streak ----
  {
    const provider = scripted(repeat(14, i => [{ name: 'net_get', args: { url: 'https://h' + i + '.invalid/' } }]));
    let n = 0;
    const flaky = async (c) => (++n === 7 ? { ok: true, isError: false, content: 'got it', summary: 'ok' } : alwaysFail(c));
    const { res } = await run(provider, { dispatch: flaky, unattended: true });
    A.eq(res.reason, 'done', 'fail x6, success, fail x7 -> never 8 consecutive -> no stop');
  }

  // ---- (b) a successful MUTATION of another tool clears every streak (the next failure is a new experiment) ----
  {
    const turns = [];
    for (let i = 0; i < 12; i++) turns.push(i === 6 ? [{ name: 'fs_write', args: { path: 'cfg.json', content: '{}' } }] : [{ name: 'net_get', args: { url: 'https://h' + i + '.invalid/' } }]);
    const provider = scripted(turns);
    const dispatch = async (c) => (c.name === 'fs_write' ? { ok: true, isError: false, content: 'wrote 2 bytes', summary: 'ok' } : alwaysFail(c));
    const { res } = await run(provider, { dispatch, unattended: true });
    A.eq(res.reason, 'done', 'fail x6, a successful edit, fail x5 -> the edit reset the streak -> no stop');
  }

  // ---- disabled: limits.failureBreaker === false leaves every tier off (unattended included) ----
  {
    // varying args so the (separate, still-on) identical-failure loop guard stays out of it
    const provider = scripted(repeat(15, i => [{ name: 'launch_rocket', args: { attempt: i } }]));
    const { dispatch, tools } = realRegistry();
    const { res, messages } = await run(provider, { dispatch, tools, unattended: true, limits: { failureBreaker: false, maxIters: 9, grace: false } });
    A.eq(res.reason, 'max_iters', 'failureBreaker:false -> no strike-out');
    A.eq(sys(messages, 'failure_streak').length + sys(messages, 'no_progress').length, 0, 'no breaker nudges when disabled');
  }

  // ---- skipped calls never count: a cancelled/terminal-evidence skip neither strikes nor fails ----
  {
    const b = Breaker.makeLoopBreaker({ unattended: true });
    for (let i = 0; i < 20; i++) {
      const v = b.observe([{ id: 'c' + i, name: 'net_get', args: { u: i } }], [{ callId: 'c' + i, isError: true, summary: 'skipped - cancelled', content: 'skipped' }]);
      A.ok(!v.stop && !v.notes.length, 'a skip is not evidence of anything (' + i + ')');
      if (v.stop || v.notes.length) break;
    }
  }

  // ---- a parallel fan-out failing together is ONE failed attempt, and a stop never shares the warning's turn ----
  {
    const b = Breaker.makeLoopBreaker({ unattended: true });
    const fan = (t, k) => {
      const calls = repeat(k, i => ({ id: 't' + t + '_' + i, name: 'web_fetch', args: { url: 'https://x.invalid/' + t + '/' + i } }));
      return b.observe(calls, calls.map(c => ({ callId: c.id, isError: true, summary: 'error', content: 'fetch failed' })));
    };
    const first = fan(0, 8);
    A.eq(first.stop, null, '8 parallel failing web_fetch calls in ONE turn do not hard-stop an unattended run');
    A.eq(first.notes.length, 0, 'one failed turn is not yet a streak worth a nudge');
    A.eq(b.snapshot().fails[0][1], 1, 'the fan-out counted as one failure');
    A.eq(fan(1, 8).stop, null, 'second failed turn: no stop');
    const third = fan(2, 8);
    A.eq(third.stop, null, 'third failed turn: no stop');
    A.eq(third.notes.filter(n => n.indexOf('<failure_streak>') === 0).length, 1, 'third failed turn: the nudge reaches the model');
    let stoppedOn = -1;
    for (let t = 3; t < 12 && stoppedOn < 0; t++) if (fan(t, 8).stop) stoppedOn = t;
    A.eq(stoppedOn, 7, 'the hard stop lands on the 8th failed TURN, not the 8th failed result');
  }
  {
    // warn and stop configured to coincide: the stop waits one turn so the warning is never discarded
    const b = Breaker.makeLoopBreaker({ unattended: true, limits: { sameToolWarnAfter: 2, sameToolStopAfter: 2 } });
    const fail = t => b.observe([{ id: 'c' + t, name: 'net_get', args: { u: t } }], [{ callId: 'c' + t, isError: true, summary: 'error', content: 'boom' }]);
    A.eq(fail(0).stop, null, 'turn 1: counting');
    const w = fail(1);
    A.eq(w.stop, null, 'turn 2: the warning turn never stops');
    A.eq(w.notes.length, 1, 'turn 2: the warning is delivered');
    A.ok(fail(2).stop && true, 'turn 3: stops after the model was warned');
  }

  A.report('loop.failure-breaker.test');
})();
