/* node test/loop.provider-recovery.test.js — Lane A items 2 & 3 in the agent loop:
   (2a) a bounded SAME-provider retry recovers a retryable, non-failover mid-stream error (e.g. `timeout`);
   (2b) usage that arrived before a FATAL stream error is reconciled into spend before end('error');
   (3)  the last done-event finishReason ('length'/'content_filter') is surfaced on the run's return value.
   Zero network — a hand-rolled provider throws/yields canned events. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { bus, seq, emit };
}
const priceOf = () => ({ in: 1, out: 2 });   // $1/$2 per-million so token math is easy to assert
function cost() { return makeCostEngine({ priceOf }); }

// a provider whose stream() runs a caller-supplied generator function fresh each attempt (so retries re-invoke it)
function scriptedProvider(genFn) {
  return { stream: (req) => genFn(req), priceOf, contextLimit: () => 0 };
}
const timeoutErr = () => { const e = new Error('provider stream idle timed out after 120000ms'); e.code = 'PROVIDER_STREAM_TIMEOUT'; return e; };
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });

(async () => {
  // (2a) SAME-PROVIDER RETRY: the first attempt throws a `timeout` (retryable, no failover chain); the loop
  //      retries the same provider and the second attempt streams a clean answer -> run ends 'done'.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) { throw timeoutErr(); }        // first call: hung stream turned into a timeout
      yield { type: 'text', delta: 'recovered' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 2, 'the timeout triggered exactly one same-provider retry');
    A.eq(res.reason, 'done', 'the retried turn completed the run');
    A.ok(res.messages.some(m => m.role === 'assistant' && String(m.content).indexOf('recovered') >= 0), 'the recovered text is in the transcript');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'no run.error was emitted (the retry recovered)');
  }

  // Recovery decisions are observable through the host callback without inventing a fallback event for a retry.
  {
    const { emit } = setup();
    let attempt = 0;
    const attempts = [];
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) throw timeoutErr();
      yield { type: 'text', delta: 'ok' };
      yield { type: 'done', finishReason: 'stop' };
    });
    await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r',
      onRecovery: row => attempts.push(row), sleep: async () => {}
    });
    A.eq(attempts.map(x => [x.sequence, x.stage, x.action, x.reason, x.attempt]), [[1, 'provider_stream', 'retry', 'timeout', 1]], 'central recovery decision is reported once with stable fields');
  }

  // (2a-bound) a PERSISTENT timeout still terminates: retries are bounded, then the run ends 'error'.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () { attempt++; throw timeoutErr(); yield; });   // always throws
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(res.reason, 'error', 'a persistent timeout eventually ends the run in error');
    A.eq([res.failureStage, res.failureCode], ['provider_stream', 'timeout'], 'terminal provider failure carries stable failure-stage telemetry');
    A.eq(attempt, 7, 'bounded: 1 initial + 6 retries (one per backoff rung) then give up');
    A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, true, 'a timeout error is transient');
  }

  // (2a-adapter-bound) provider adapters own a separate PRE-STREAM retry ladder. Once an adapter marks that
  //     ladder exhausted, the loop must NOT multiply the adapter's attempts by its own six-rung ladder (the old
  //     15-POST storm) — but since 2026-09-22 it no longer gives up either (a 2s blip killed single-provider
  //     runs): the adapter's spend is COUNTED against the rungs and the ladder continues. This provider ignores
  //     req.preStreamRetries and never stamps its spend, so every attempt is assumed to be the standard 3-POST
  //     ladder (2 rungs): 1st call -> rungs 0-1 spent, loop rung 2; 2nd call -> rungs 3-4 spent, loop rung 5;
  //     3rd call -> the ladder is spent. Three calls, not one and not seven. Full coverage lives in
  //     loop.prestream-outage-ladder.test.js.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const exhausted = timeoutErr();
    exhausted.preStreamRetriesExhausted = true;
    const waits = [];
    const provider = scriptedProvider(async function* () { attempt++; throw exhausted; yield; });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', sleep: async ms => { waits.push(ms); }, random: () => 0.5 });
    A.eq(attempt, 3, 'an exhausted adapter ladder is continued but COUNTED — never multiplied');
    A.eq(waits, [4000, 60000], 'the loop sleeps only the rungs the adapter did not already spend');
    A.eq(res.reason, 'error', 'a persistent pre-stream failure still ends honestly');
    A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, true, 'the prompt failure remains classified as transient');
  }

  // (2a-exhausted-chain) an OVERLOADED provider with NO failover chain (every single-provider station,
  //     e.g. ChatGPT-login codex) gets the same-provider retries the A2 comment always promised. This was
  //     the field failure behind "servers overloaded" runs dying at ~2s: retryable+shouldFallback with an
  //     empty chain hit neither the failover branch nor the retry branch and went straight to fatal.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt <= 2) { throw new Error('Our servers are currently overloaded. Please try again later.'); }
      yield { type: 'text', delta: 'rode it out' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 3, 'two overload blips were retried on the SAME provider (no chain to fall back to)');
    A.eq(res.reason, 'done', 'the run survived a transient overload instead of dying red');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'a ridden-out overload emits no run.error');
    A.eq(seq.filter(e => e.name === 'provider.fallback').length, 0, 'no failover was claimed — same-provider retries are silent and truthful');
  }

  // (2a-live-parity) The installed Hermes comparison exposed a longer overload window after a successful
  //     host action: StarNet's four-rung (~16.6s) ladder ended the run while Hermes kept working for up to
  //     ~102s. Repeating the CURRENT model turn is safe here because the prior turn's tool result is already
  //     paired in messages; the completed host effect must never be dispatched a second time.
  {
    const { seq, emit } = setup();
    let streamAttempt = 0, toolRuns = 0;
    const waits = [];
    const provider = scriptedProvider(async function* () {
      streamAttempt++;
      if (streamAttempt === 1) {
        yield { type: 'tool_start', index: 0, id: 'effect-1', name: 'fixture_action' };
        yield { type: 'tool_args', index: 0, chunk: '{"action":"identify_seam"}' };
        yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      if (streamAttempt <= 6) throw new Error('Our servers are currently overloaded. Please try again later.');
      yield { type: 'text', delta: 'recovered after the provider window' };
      yield { type: 'usage', usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const registry = makeRegistry();
    registry.register({ impact: 'none',
      name: 'fixture_action',
      schema: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } },
      run: async () => { toolRuns++; return 'host effect complete'; }
    });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'inspect the fixture' }], provider, emit, cost: cost(), model: 'm',
      agentId: 'a', runId: 'r', tools: [], dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx(),
      sleep: async ms => { waits.push(ms); }, random: () => 0.5   // 0.5 = the un-jittered rung (±20% jitter otherwise)
    });
    A.eq(res.reason, 'done', 'a Hermes-length overload window is ridden out instead of ending the task');
    A.eq(streamAttempt, 7, 'one tool turn + five overloaded continuation attempts + one recovered continuation');
    A.eq(toolRuns, 1, 'the completed host effect executes exactly once across continuation retries');
    A.eq(waits, [400, 1200, 4000, 10000, 30000], 'the longer bounded ladder is used in deterministic order');
    A.eq(seq.filter(e => e.name === 'agent.tool_call').length, 1, 'no duplicate tool call is surfaced');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'a recovered provider window emits no terminal error');
  }

  // (2a-exhausted-chain-bound) a PERSISTENT overload with no chain still terminates in error — patience is bounded.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () { attempt++; throw new Error('overloaded'); yield; });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 7, 'bounded: 1 initial + 6 same-provider retries, then give up');
    A.eq(res.reason, 'error', 'a genuinely down backend still ends the run honestly');
    A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, true, 'the terminal overload error is marked transient');
  }

  // (2b) FATAL-PATH USAGE RECONCILE: usage arrives, THEN the stream throws a non-retryable error. The billed
  //      tokens must be recorded before end('error') — spend/tokens on the return value are nonzero, and an
  //      agent.cost (reconciled) event fired.
  {
    const { seq, emit } = setup();
    const badReq = new Error('http 400 - malformed'); badReq.status = 400;   // 400 -> format_error (not retryable, no fallback)
    const provider = scriptedProvider(async function* () {
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
      throw badReq;
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(res.reason, 'error', 'a 400 mid-stream ends the run error');
    // 1000 in * $1/M + 500 out * $2/M = 0.001 + 0.001 = 0.002
    A.ok(Math.abs(res.usd - 0.002) < 1e-9, 'usage received before the fatal error was reconciled into spend');
    A.eq(res.tokens, 1500, 'the billed tokens are recorded on the fatal path');
    const costEv = seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled);
    A.ok(costEv.length >= 1, 'a reconciled agent.cost fired before end(error)');
  }

  // (2b-neg) no usage before a fatal error -> nothing reconciled (no spurious spend).
  {
    const { emit } = setup();
    const err = new Error('http 400'); err.status = 400;
    const provider = scriptedProvider(async function* () { throw err; yield; });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(res.reason, 'error', 'fatal with no usage still ends error');
    A.eq(res.usd, 0, 'no usage -> no phantom spend on the fatal path');
    A.eq(res.tokens, 0, 'no usage -> zero tokens');
  }

  // (3) finishReason SURFACED when semantic continuation is explicitly disabled: the legacy/cut-short result
  //     remains available for callers that opt out of automatic continuation.
  {
    const { emit } = setup();
    const provider = scriptedProvider(async function* () {
      yield { type: 'text', delta: 'a very long truncated answer' };
      yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } };
      yield { type: 'done', finishReason: 'length' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', limits: { outputContinuation: false } });
    A.eq(res.reason, 'done', 'a length-truncated turn still ends reason=done (gate unbroken)');
    A.eq(res.finishReason, 'length', 'finishReason=length is surfaced additively on the return value');
  }

  // (3-neg) a clean 'stop' finish does NOT attach a finishReason field (only non-clean stops are surfaced).
  {
    const { emit } = setup();
    const provider = scriptedProvider(async function* () {
      yield { type: 'text', delta: 'ok' };
      yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(res.reason, 'done', 'clean stop -> done');
    A.eq(res.finishReason, undefined, 'a clean stop attaches no finishReason field');
  }

  // (4) TRUNCATED STREAM — a clean mid-generation FIN, which throws NO error. The adapter reports
  //     truncated:true (it observed neither its end-of-stream sentinel nor a finish_reason). The loop must not
  //     accept the fragment as a delivery: it re-runs the turn, and a good retry completes the run normally.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) {
        yield { type: 'text', delta: 'half a sen' };
        yield { type: 'done', finishReason: null, truncated: true };   // the body died in transit
        return;
      }
      yield { type: 'text', delta: 'the whole answer' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 2, 'the truncated stream triggered exactly one retry');
    A.eq(res.reason, 'done', 'the retried turn completed the run');
    A.ok(res.messages.some(m => m.role === 'assistant' && String(m.content).indexOf('the whole answer') >= 0), 'the COMPLETE answer is what landed in the transcript');
    A.ok(!res.messages.some(m => String(m.content).indexOf('half a sen') >= 0), 'the truncated fragment was discarded, never delivered');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'a recovered truncation emits no run.error');
  }

  // (4-bound) a PERSISTENTLY truncated stream terminates as the provider failure it is — never as a completed,
  //           $0 delivery — and the tokens the provider WILL bill are reconciled on the way out.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      yield { type: 'text', delta: 'half a sen' };
      yield { type: 'usage', usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 } };
      yield { type: 'done', finishReason: null, truncated: true };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 2, 'bounded: 1 initial + 1 truncation retry, then give up');
    A.eq(res.reason, 'error', 'a persistently truncated stream is NOT reported as a completed run');
    const err = seq.find(e => e.name === 'agent.run.error');
    A.eq(err.payload.transient, true, 'a truncation is transient');
    A.ok(/truncated in transit/.test(err.payload.message), 'the error names the truncation plainly');
    // BOTH attempts streamed usage and BOTH are billed by the provider: 2 x (1000 in * $1/M + 500 out * $2/M).
    // (Before 2026-09-04 the retry `continue` reset the first attempt's usage to null and only the second was
    // booked — the exact partial-usage leak the stop-means-stop lane closed; see loop.stop-means-stop.test.js.)
    A.ok(Math.abs(res.usd - 0.004) < 1e-9, 'the billed tokens of EVERY attempt are recorded — a truncated turn is never free: ' + res.usd);
    A.eq(seq.filter(e => e.name === 'agent.cost' && e.payload.reconciled).length, 2, 'one reconciled booking per attempt, never a duplicate');
  }

  // (4-inert) BACKWARD COMPATIBILITY: a provider that never sets `truncated` — or never emits a done event at
  //           all — behaves exactly as before. The flag is opt-in, so an adapter that cannot tell is untouched.
  {
    const { emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      yield { type: 'text', delta: 'answer with no done event at all' };
      yield { type: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r' });
    A.eq(attempt, 1, 'no done event -> no retry (unchanged behavior)');
    A.eq(res.reason, 'done', 'a provider that never reports termination still ends done');
  }

  // (window-re-resolve) a cross-provider fallback RE-RESOLVES the context window. Everything else about the
  //     failover swaps (provider, model, cost, credential) but the compaction threshold was frozen at the
  //     PRIMARY model's window: after a 200k→8k switch the manager kept waiting for prompt tokens the small
  //     window can never hold, so the run overflowed with proactive compaction still "not yet due".
  {
    const { seq, emit } = setup();
    const { makeContext } = require('../sidecar/context.js');
    const ctx = makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 2 });
    const primary = scriptedProvider(async function* () { throw new Error('Our servers are currently overloaded. Please try again later.'); yield; });
    const small = {
      priceOf, contextLimit: () => 8000,
      stream: async function* () {
        yield { type: 'text', delta: 'served from the small window' };
        yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: primary, emit, cost: cost(), model: 'big', agentId: 'a', runId: 'r',
      context: ctx, summarize: async () => '', fallbacks: [{ provider: small, model: 'small' }], sleep: async () => {}
    });
    A.eq(res.reason, 'done', 'the failover served the turn');
    A.eq(seq.filter(e => e.name === 'provider.fallback').length, 1, 'exactly one observable failover');
    A.eq(ctx.contextLimit, 8000, 'the context manager now measures against the FALLBACK model window');
    A.ok(ctx.shouldCompact({ prompt_tokens: 6000 }), 'a prompt past 65% of the small window is now compaction-due');
  }

  // (window-re-resolve, cold catalog) a fallback provider that does not know its window (contextLimit 0)
  //     KEEPS the primary's limit instead of disarming proactive compaction.
  {
    const { emit } = setup();
    const { makeContext } = require('../sidecar/context.js');
    const ctx = makeContext({ contextLimit: 200000, compactAt: 0.65, keepTail: 2 });
    const primary = scriptedProvider(async function* () { throw new Error('Our servers are currently overloaded. Please try again later.'); yield; });
    const cold = {
      priceOf, contextLimit: () => 0,
      stream: async function* () {
        yield { type: 'text', delta: 'cold catalog fallback' };
        yield { type: 'done', finishReason: 'stop' };
      }
    };
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'x' }], provider: primary, emit, cost: cost(), model: 'big', agentId: 'a', runId: 'r',
      context: ctx, summarize: async () => '', fallbacks: [{ provider: cold, model: 'unknown' }], sleep: async () => {}
    });
    A.eq(res.reason, 'done', 'the cold-catalog failover still served the turn');
    A.eq(ctx.contextLimit, 200000, 'an unknown fallback window keeps the last known limit — stale beats none');
  }

  // (retry-dedupe) deltas from a FAILED attempt already reached COMMS live; the retried stream must not
  //     re-print them. The retried attempt buffers, then emits only the suffix novel beyond what was shown —
  //     while the DURABLE assistant turn keeps the FULL retried text (stripping it would corrupt the
  //     transcript by exactly the bytes the Commander already saw).
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) { yield { type: 'text', delta: 'Hello wor' }; throw timeoutErr(); }
      yield { type: 'text', delta: 'Hello world!' };
      yield { type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', sleep: async () => {} });
    A.eq(res.reason, 'done', 'the retried turn completed');
    const streamed = seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
    A.eq(streamed, 'Hello world!', "the live stream carries the answer ONCE — the failed attempt's prefix is not re-printed");
    A.ok(res.messages.some(m => m.role === 'assistant' && m.content === 'Hello world!'), 'the durable turn keeps the FULL retried text, not the stripped suffix');
  }

  // (retry-dedupe, divergent) a regeneration that shares no prefix falls back to emitting in full —
  //     identical to the old behavior, never worse — and the transcript still holds only the final text.
  {
    const { seq, emit } = setup();
    let attempt = 0;
    const provider = scriptedProvider(async function* () {
      attempt++;
      if (attempt === 1) { yield { type: 'text', delta: 'First take…' }; throw timeoutErr(); }
      yield { type: 'text', delta: 'Completely different answer.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const res = await runAgentLoop({ messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'm', agentId: 'a', runId: 'r', sleep: async () => {} });
    const streamed = seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('');
    A.eq(streamed, 'First take…Completely different answer.', 'a divergent regeneration emits in full after the shown partial (never worse than before)');
    A.ok(res.messages.some(m => m.role === 'assistant' && m.content === 'Completely different answer.'), 'the transcript holds ONLY the final retried text');
  }

  A.report('loop.provider-recovery.test');
})();
