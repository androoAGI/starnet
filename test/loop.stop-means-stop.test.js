/* node test/loop.stop-means-stop.test.js — STOP MEANS STOP (audit 2026-09-03).

   Two lies a STOP used to tell:
   (1) the loop never read the run signal BETWEEN tool dispatches, so a turn that issued five writes kept
       executing four of them after the Commander stopped it after the first;
   (2) a cancelled turn (and every retry/compress/fallback re-entry) returned without reconciling the usage
       the provider still bills, so the ledger booked $0 for a stopped 150k-prompt turn.
   Zero network — the replay provider and hand-rolled generators drive the loop. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop, _internals } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

const openCtx = (extra) => Object.assign({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, extra || {});
const SCHEMA = { type: 'object', properties: { path: { type: 'string' } } };
const priceOf = () => ({ in: 1, out: 2 });   // $1/$2 per-million so token math is easy to assert
const cost = () => makeCostEngine({ priceOf });
function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
function scriptedProvider(genFn) { return { stream: (req) => genFn(req), priceOf, contextLimit: () => 0 }; }
const timeoutErr = () => { const e = new Error('provider stream idle timed out after 120000ms'); e.code = 'PROVIDER_STREAM_TIMEOUT'; return e; };
const toolMsgs = (res) => res.messages.filter(m => m.role === 'tool');

// one turn that issues three sequential writes, then a turn that stops
function threeWrites() {
  const turn = [];
  ['c0', 'c1', 'c2'].forEach((id, i) => {
    turn.push({ type: 'tool_start', index: i, id, name: 'write_x' });
    turn.push({ type: 'tool_args', index: i, chunk: JSON.stringify({ path: 'f' + i }) });
  });
  turn.push({ type: 'done', finishReason: 'tool_calls' });
  return { turns: [turn, [{ type: 'text', delta: 'ok' }, { type: 'done', finishReason: 'stop' }]] };
}

(async () => {
  // ---- (a) STOP after the FIRST of three queued tool calls: only the first runs; the other two are SKIPPED
  //          with a paired, truthful result; the transcript says skipped, never success. ----
  {
    const { seq, emit } = setup();
    const ac = new AbortController();
    const ran = [];
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'write_x', schema: SCHEMA, run: async (a) => { ran.push(a.path); ac.abort(); return 'wrote ' + a.path; } });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'go' }], provider: makeReplayProvider(threeWrites()), emit, cost: cost(),
      model: 'replay/model', agentId: 'a', runId: 'r', tools: [], limits: { maxIters: 5, grace: false }, signal: ac.signal,
      dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: openCtx({ signal: ac.signal }), clock: { now: () => Date.now() }
    });
    A.eq(ran, ['f0'], 'ONLY the first write executed after the Commander stopped the run');
    const tm = toolMsgs(res);
    A.eq(tm.map(m => m.tool_call_id), ['c0', 'c1', 'c2'], 'every requested call still has its paired transcript result');
    A.eq(tm[0].content, 'wrote f0', 'the call that ran before the stop keeps its real result');
    A.ok(/^ERROR: skipped: cancelled/.test(tm[1].content) && /^ERROR: skipped: cancelled/.test(tm[2].content), 'the two unrun calls read as SKIPPED (cancelled) in the transcript: ' + tm[1].content);
    const results = seq.filter(e => e.name === 'agent.tool_result');
    A.eq(results.map(e => e.payload.callId), ['c0', 'c1', 'c2'], 'a tool_result was emitted for every call, in call order');
    A.eq(results.slice(1).map(e => [e.payload.ok, e.payload.isError, e.payload.summary]), [[false, true, 'skipped — cancelled'], [false, true, 'skipped — cancelled']], 'the skipped results are telemetry-honest (ok:false, isError:true, summary names the cancel)');
    A.eq(res.reason, 'cancelled', 'the run ends cancelled, not done');
  }

  // ---- (a-registry) registry.dispatch refuses at the door when the run signal is ALREADY aborted — a tool that
  //                   ignores ctx.signal would otherwise run to completion. ----
  {
    const ac = new AbortController(); ac.abort();
    let invoked = 0;
    const reg = makeRegistry();
    reg.register({ impact: 'none', name: 'write_x', schema: SCHEMA, run: async () => { invoked++; return 'wrote'; } });
    const r = await reg.dispatch({ id: 'k', name: 'write_x', args: { path: 'p' } }, openCtx({ signal: ac.signal }));
    A.eq(invoked, 0, 'tool.run was NOT invoked under an already-aborted signal');
    A.eq([r.ok, r.isError, r.summary], [false, true, 'skipped - cancelled'], 'the refusal is an ordinary isError tool result');
    A.ok(/skipped: cancelled/.test(r.content), 'the content says skipped: cancelled (' + r.content + ')');
    // and a live (unaborted) signal changes nothing
    const live = new AbortController();
    const ok = await reg.dispatch({ id: 'k2', name: 'write_x', args: { path: 'p' } }, openCtx({ signal: live.signal }));
    A.eq([ok.ok, invoked], [true, 1], 'an unaborted signal dispatches normally');
  }

  // ---- (a-parallel) the CONCURRENT branch checks the signal before each dispatch too. ----
  {
    const ac = new AbortController(); ac.abort();
    let invoked = 0;
    const emitted = [];
    const calls = [{ id: 'p0', name: 'read_a', args: {}, argsRaw: '{}' }, { id: 'p1', name: 'read_b', args: {}, argsRaw: '{}' }];
    const results = await _internals.executeCalls(calls, async () => { invoked++; return { ok: true, content: 'x' }; }, {}, (n, p) => emitted.push([n, p]),
      { agentId: 'a', runId: 'r', clock: { now: () => 0 }, signal: ac.signal, hiddenTools: new Set(), parallelSafe: () => true, turnOutputMax: 0 });
    A.eq(invoked, 0, 'parallel branch: no dispatch under an aborted signal');
    A.eq(results.map(r => [r.callId, r.ok, r.isError]), [['p0', false, true], ['p1', false, true]], 'parallel branch: both calls paired with a skipped result');
    A.ok(results.every(r => /skipped: cancelled/.test(r.content)), 'parallel branch: results read skipped: cancelled');
  }

  // ---- (b) a CANCELLED turn reconciles the usage the provider already delivered — exactly ONCE. ----
  {
    const { seq, emit } = setup();
    const ac = new AbortController();
    const provider = scriptedProvider(async function* () {
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
      yield { type: 'text', delta: 'partial ' };
      ac.abort();                                   // the Commander pressed STOP mid-stream
      yield { type: 'text', delta: 'never seen' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', signal: ac.signal });
    A.eq(res.reason, 'cancelled', 'the run ends cancelled');
    A.ok(Math.abs(res.usd - 0.002) < 1e-9, 'the cancelled turn booked its usage (1000 in * $1/M + 500 out * $2/M = $0.002), not $0: ' + res.usd);
    A.eq(res.tokens, 1500, 'the billed tokens are recorded on the cancel path');
    const costEv = seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled);
    A.eq(costEv.length, 1, 'reconciled agent.cost fired exactly ONCE (no double-count)');
    A.eq(costEv[0].payload.model, 'm', 'the booking names the model that produced the usage');
    const endEv = seq.find(e => e.name === 'agent.run.end');
    A.ok(endEv && Math.abs(endEv.payload.usd - 0.002) < 1e-9, 'agent.run.end carries the booked spend');
  }

  // ---- (b-neg) a cancel before any usage arrived books NOTHING (no spurious spend). ----
  {
    const { seq, emit } = setup();
    const ac = new AbortController();
    const provider = scriptedProvider(async function* () { yield { type: 'text', delta: 'p' }; ac.abort(); yield { type: 'text', delta: 'q' }; });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', signal: ac.signal });
    A.eq([res.reason, res.usd, seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled).length], ['cancelled', 0, 0], 'no usage -> nothing reconciled');
  }

  // ---- (c) a RETRY-CONTINUE keeps the failed attempt's partial usage: both attempts land in the ledger. ----
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) {
        yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
        throw timeoutErr();                         // retryable, no failover chain -> same-provider retry
      }
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', sleep: async () => {} });
    A.eq([attempt, res.reason], [2, 'done'], 'the timeout retried once and the run completed');
    // 0.002 (failed attempt) + (10*1 + 5*2)/1e6 = 0.00002 -> 0.00202
    A.ok(Math.abs(res.usd - 0.00202) < 1e-12, 'spend = failed attempt + successful attempt: ' + res.usd);
    A.eq(res.tokens, 1515, 'tokens from BOTH attempts are recorded');
    const costEv = seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled);
    A.eq(costEv.map(e => e.payload.tokensIn), [1000, 10], 'two reconciled bookings, one per attempt, in order — never a duplicate');
  }

  // ---- (c-cancel-in-backoff) STOP during the retry backoff: the failed attempt is booked once, then cancelled. ----
  {
    const { seq, emit } = setup();
    const ac = new AbortController();
    const provider = scriptedProvider(async function* () {
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
      throw timeoutErr();
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', signal: ac.signal, sleep: async () => { ac.abort(); } });
    A.eq(res.reason, 'cancelled', 'a cancel during the backoff ends cancelled');
    A.eq(seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled).length, 1, 'the failed attempt was booked exactly once');
    A.ok(Math.abs(res.usd - 0.002) < 1e-9, 'its usage is on the ledger: ' + res.usd);
  }

  // ---- (c-stop-cuts-backoff) STOP during a LONG retry backoff ends the run at once (stall report 2026-10-13). The rung's
  //      sleep (up to 60 s, or a server-stated Retry-After) ignored the stop: the page showed the run stopped while the
  //      run kept its conversation's turn, so the next message sat on "connecting" until the sleep ran out. ----
  {
    const { emit } = setup();
    const ac = new AbortController();
    let attempts = 0;
    const provider = scriptedProvider(async function* () { attempts++; throw timeoutErr(); });
    const rung = ms => new Promise(r => setTimeout(r, Math.min(ms, 3000) || 3000));   // a real timer, like the host's sleep
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', signal: ac.signal,
      sleep: () => rung(3000) });
    const ms = Date.now() - t0;
    A.eq([res.reason, attempts], ['cancelled', 1], 'a stop during the backoff ends cancelled, and the turn is never re-sent');
    A.ok(ms < 1000, 'the stop cuts the backoff short instead of sleeping it out (' + ms + ' ms)');
  }
  // ...and the truncated-stream retry's backoff too
  {
    const { emit } = setup();
    const ac = new AbortController();
    let attempts = 0;
    const provider = scriptedProvider(async function* () { attempts++; yield { type: 'text', delta: 'half' }; yield { type: 'done', finishReason: 'stop', truncated: true }; });
    setTimeout(() => ac.abort(), 40);
    const t0 = Date.now();
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', signal: ac.signal,
      sleep: () => new Promise(r => setTimeout(r, 3000)) });
    const ms = Date.now() - t0;
    A.eq([res.reason, attempts], ['cancelled', 1], 'a stop during the truncation retry backoff ends cancelled');
    A.ok(ms < 1000, 'the truncation backoff is cut short by the stop (' + ms + ' ms)');
  }

  A.report('loop.stop-means-stop');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
