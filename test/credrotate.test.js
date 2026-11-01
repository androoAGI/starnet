/* node test/credrotate.test.js — credential rotation through the REAL agent loop (P0.2 integration).
   Drives runAgentLoop with a primary provider that throws a 429 (rate_limit) and a fallback entry on a fresh
   key that succeeds. Proves the headline daily-driver behavior: a rate-limited key does NOT stall the agent —
   the loop rotates to the next key, the run completes, the failed key is reported to onFallback and cooled in
   credpool so it isn't tried first next run. No real keys / no network. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeCredPool } = require('../sidecar/credpool.js');
const { makeCostEngine } = require('../sidecar/cost.js');

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}

// a provider whose stream immediately throws a 429 — the "exhausted / rate-limited key".
function rateLimitedProvider() {
  return { async *stream() { throw Object.assign(new Error('429 Too Many Requests'), { status: 429 }); } };
}
// a provider that streams a normal reply — the "fresh key".
function okProvider(text) {
  return { async *stream() {
    yield { type: 'text', delta: text };
    yield { type: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
    yield { type: 'done', finishReason: 'stop' };
  } };
}

(async () => {
  // ---- rotation recovers the run + cools the failed key ----
  {
    const { seq, emit } = setup();
    const calls = [];
    const credPool = makeCredPool({ clock: { now: () => 1000 } });
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'rot',
      provider: rateLimitedProvider(),
      credKey: 'KEYA',
      fallbacks: [{ provider: okProvider('rotated reply'), model: 'replay/model', credKey: 'KEYB' }],
      onFallback: (info) => { calls.push(info); if (info.rotate && info.credKey) credPool.penalize(info.credKey); }
    });

    A.eq(res.reason, 'done', 'run recovers by rotating to the fresh key (not stalled)');
    A.eq(calls.length, 1, 'onFallback fired once');
    A.eq(calls[0].rotate, true, 'rotate flagged (rate_limit is a shouldRotateCredential reason)');
    A.eq(calls[0].credKey, 'KEYA', 'the OUTGOING (failed) key A is reported, not the new one');
    A.eq(credPool.order(['KEYA', 'KEYB']), ['KEYB', 'KEYA'], 'failed key A is now cooled to the back of the order');
    const assistant = res.messages.filter(m => m.role === 'assistant').pop();
    A.ok(assistant && String(assistant.content).indexOf('rotated reply') !== -1, 'assistant carries the fresh-key reply');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'exactly one run.end despite the rotation');
    // P3.1 telemetry: the failover is observable on the bus, not just implied by the switched agent.cost.model
    const fb = seq.filter(e => e.name === 'provider.fallback');
    A.eq(fb.length, 1, 'a provider.fallback telemetry event is emitted on rotation');
    A.eq(fb[0].payload.reason, 'rate_limit', 'fallback event carries the classified reason');
    A.eq(fb[0].payload.rotate, true, 'fallback event flags it as a credential rotation');
  }

  // ---- exhausted pool: primary + the only fallback both rate-limit -> honest error, no infinite spin ----
  {
    const { emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'rot2',
      provider: rateLimitedProvider(),
      credKey: 'KEYA',
      fallbacks: [{ provider: rateLimitedProvider(), model: 'replay/model', credKey: 'KEYB' }]
    });
    A.eq(res.reason, 'error', 'all keys exhausted -> a clean error, bounded (no spin)');
  }

  // ---- no hook / no credKey -> the loop behaves exactly as before (byte-identical contract) ----
  {
    const { seq, emit } = setup();
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'replay/model', agentId: 'a', runId: 'plain',
      provider: okProvider('plain reply')
    });
    A.eq(res.reason, 'done', 'single-provider run unaffected by the rotation additions');
    A.eq(seq.filter(e => e.name === 'agent.run.end').length, 1, 'one run.end');
  }

  // ---- cross-provider failover prices subsequent turns by the NEW provider's cost engine (P3.1) ----
  {
    const { seq, emit } = setup();
    const primaryCost = makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) });           // primary: free
    const fbCost = makeCostEngine({ priceOf: () => ({ in: 1000, out: 1000 }) });          // fallback provider: priced (per-million)
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'provA/model', agentId: 'a', runId: 'xprov',
      provider: rateLimitedProvider(), cost: primaryCost,
      fallbacks: [{ provider: okProvider('done'), model: 'provB/model', cost: fbCost, credKey: 'B' }]
    });
    A.eq(res.reason, 'done', 'cross-provider failover completes');
    const cost = seq.filter(e => e.name === 'agent.cost').pop();
    A.ok(cost && cost.payload.usd > 0, 'spend is priced by the FALLBACK provider cost engine, not the free primary');
    A.eq(cost.payload.model, 'provB/model', 'the reconciled cost carries the switched-to model');
    const fb = seq.filter(e => e.name === 'provider.fallback').pop();
    A.eq(fb.payload.toModel, 'provB/model', 'telemetry records the cross-provider target model');
  }

  /* ---- the SUMMARIZER follows the failover ---------------------------------------------------------
     index.js builds `summarize` as a closure BEFORE the loop starts, capturing its own `provider`/`model`,
     neither of which is ever reassigned — while loop.js swaps its own three on failover. So a run that rotated
     credentials or fell over to another provider then compacted against the DEAD credential / failed endpoint.
     Two summarizer failures flip compactionOff, which makes the later shouldCompress recovery a no-op, so the
     run dies 'error' on a context_overflow it could have folded and survived; on a rate-limited key it also
     kept hammering the exact credential credPool had just cooled. The loop now hands the summarizer its LIVE
     provider/model/cost. */
  {
    const { emit } = setup();
    const { makeContext } = require('../sidecar/context.js');
    const { makeRegistry } = require('../sidecar/tools/registry.js');
    const capCtx = { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' };
    const reg = makeRegistry();
    reg.register({ name: 'note', schema: { type: 'object', properties: { t: { type: 'string' } } }, run: async () => 'noted' });
    const seen = [];
    // the PRIMARY 429s immediately -> the loop rotates. The fallback then takes a tool-call turn (so a SECOND
    // turn exists, which is where maybeCompact runs with lastUsage set) and answers on the turn after.
    const primary = { stream: () => { const e = new Error('http 429 — rate limited'); e.status = 429; throw e; }, priceOf: () => ({ in: 0, out: 0 }), contextLimit: () => 10 };
    let fbTurn = 0;
    const fbProvider = {
      stream: async function* () {
        fbTurn++;
        if (fbTurn === 1) {
          yield { type: 'tool_start', index: 0, id: 'c1', name: 'note' };
          yield { type: 'tool_args', index: 0, chunk: '{"t":"x"}' };
          yield { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } };
          yield { type: 'done', finishReason: 'tool_calls' };
          return;
        }
        yield { type: 'text', delta: 'after failover' };
        yield { type: 'usage', usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } };
        yield { type: 'done', finishReason: 'stop' };
      },
      priceOf: () => ({ in: 0, out: 0 }), contextLimit: () => 10
    };
    const ctxMgr = makeContext({ contextLimit: 10, compactAt: 0.65, keepTail: 2 });   // 8 prompt tokens > 6.5 -> compact
    const res = await runAgentLoop({
      messages: [
        { role: 'user', content: 'turn one, long enough to matter for the estimate' },
        { role: 'assistant', content: 'reply one, also long enough to matter here' },
        { role: 'user', content: 'turn two, please compact before answering me' }
      ], emit,
      model: 'dead/model', agentId: 'a', runId: 'sum', provider: primary, cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) }),
      fallbacks: [{ provider: fbProvider, model: 'live/model', credKey: 'KEYB' }],
      context: ctxMgr, tools: [], dispatch: (c, ctx2) => reg.dispatch(c, ctx2), capCtx,
      // exactly index.js's signature — record which provider/model the loop offered the summarizer
      summarize: async (older, prevSummary, live) => { seen.push({ model: live && live.model, isFb: !!(live && live.provider === fbProvider) }); return 'SUMMARY'; }
    });
    A.eq(res.reason, 'done', 'the failed-over run completes');
    A.ok(seen.length >= 1, 'the summarizer actually ran (compaction fired)');
    if (seen.length) {
      A.eq(seen[seen.length - 1].model, 'live/model', 'the summarizer is handed the SWITCHED-TO model, not the dead one');
      A.eq(seen[seen.length - 1].isFb, true, 'and the live provider object, not the failed primary');
    }
  }

  /* ---- the COOLDOWN has to reach the PRIMARY key --------------------------------------------------
     penalize() is called with the OUTGOING key, which on the first rotation is the run's PRIMARY — but the only
     consumer of a cooldown is credPool.order(), and the list index.js hands it has just had the primary filtered
     out (it is the key we are already on). The next run's primary is re-derived from providerRuntimeKey(), not
     from that ordering, so the cooldown recorded for the key MOST likely to be rate-limited — the one always
     tried first — could never affect anything: every run inside the 5-minute window opened on it again and
     burned a wasted round-trip plus one of the loop's bounded recovery slots. Cooldowns for ALTERNATE keys
     always worked; only the primary was inert.

     The pure module already answered the question (coolingUntil); nothing asked it. The test below that hands
     order() a list CONTAINING the primary is exactly why this hid — production provably never does that. */
  {
    let t = 1000;
    const pool = makeCredPool({ clock: { now: () => t } });
    pool.penalize('KEYA');
    A.ok(pool.coolingUntil('KEYA') > t, 'the primary key IS recorded as cooling — the state existed all along');
    A.eq(pool.coolingUntil('KEYB'), 0, 'an untouched key is not cooling');
    t += 6 * 60 * 1000;
    A.ok(pool.coolingUntil('KEYA') <= t, 'and the cooldown expires on its own');
  }
  // the WIRING that consults it (index.js is not node-loadable in isolation, so this is a source lock —
  // the same pattern channels.sse.test.js uses for handleChannelEvents)
  {
    const fs = require('fs'); const path = require('path');
    const src = readSidecarSource();
    const at = src.indexOf('let rotationFallbacks = []');
    A.ok(at > 0, 'index.js owns the rotation-fallback build');
    const seg = src.slice(at, at + 2600);
    A.ok(/credPool\.coolingUntil\(runKey\)/.test(seg), 'the run asks whether its OWN primary key is cooling');
    A.ok(/activePrimaryKey = warm/.test(seg), 'and starts on a WARM pool key when it is');
    A.ok(/ordered\.push\(runKey\)/.test(seg), 'demoting the cooling primary to the back rather than dropping it');
    // subscription stacking: an unmetered OAuth subscription still names its ACCOUNT handle, so a spent account cools too
    A.ok(/credKey: \(providerUnmetered && !oauthAccounts\) \? null : activePrimaryKey/.test(src),
      'and the loop is told the key actually in use, so a failure cools the right credential');
  }

  A.report('credrotate.test');
})();
