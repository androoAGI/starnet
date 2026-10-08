/* node test/loop.prestream-outage-ladder.test.js — F2 of the 2026-09-22 Hermes audit: a short outage BEFORE the
   stream starts must not kill a single-provider run.

   Before: an adapter retried twice (400/1200ms), stamped preStreamRetriesExhausted, and recovery-policy refused
   any loop-level retry on that flag — audit probe "503 x4, no fallback" ended error/overloaded after 1.6s.
   After: the adapter's spent attempts/backoff are counted against the loop's six-rung ladder, later rungs send
   ONE request each (req.preStreamRetries = 0), total local patience stays the ladder's 105.6s, the rungs carry
   ±20% jitter from an injectable o.random, and auth / billing / quota-exhausted / TLS stay fatal on attempt 1.

   Deterministic: the REAL openai-compatible adapter over a stubbed fetch (its own 400+1200ms pre-stream delays
   are real timers, ~1.6s per outage case), the loop's sleep and random injected, no network, no sidecar. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const Policy = require('../sidecar/recovery-policy.js');

const NL = String.fromCharCode(10);
const PATIENCE = Policy.RETRY_PATIENCE_MS;
const ADAPTER_WAIT = 400 + 1200;   // openai-compatible RETRY_DELAYS — the rungs an exhausted adapter already spent

function setup() {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const emit = makeEmitter(bus, () => {});
  return { seq, emit };
}
const priceOf = () => ({ in: 1, out: 2 });
const cost = () => makeCostEngine({ priceOf });
const sum = xs => xs.reduce((a, b) => a + b, 0);
const openCtx = () => ({ canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' });

const sse = chunks => new Response(chunks.map(c => 'data: ' + JSON.stringify(c)).concat(['data: [DONE]', '', '']).join(NL),
  { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textTurn = text => sse([
  { choices: [{ index: 0, delta: { content: text } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
]);
const toolTurn = (id, name, args) => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
]);
const jsonErr = (status, message, headers) => new Response(JSON.stringify({ error: { message } }), { status, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}) });

// A scripted upstream: `script(n)` answers the n-th chat POST (1-based). /models re-warm GETs are answered empty.
function upstream(script) {
  const posts = [];
  const fetch = async (url, init) => {
    if (!/chat\/completions/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    posts.push(JSON.parse(init.body));
    return script(posts.length);
  };
  return { fetch, posts };
}
const adapter = fetch => makeOpenAICompatibleProvider({ fetch, key: 'fixture-only', baseUrl: 'https://fixture.invalid/v1', label: 'custom' });

async function runWith(provider, extra) {
  const { seq, emit } = setup();
  const waits = [], recov = [];
  const res = await runAgentLoop(Object.assign({
    messages: [{ role: 'user', content: 'x' }], provider, emit, cost: cost(), model: 'fixture-model', agentId: 'a', runId: 'r',
    sleep: async ms => { waits.push(ms); }, random: () => 0.5, onRecovery: row => recov.push(row)
  }, extra || {}));
  return { res, seq, waits, recov };
}

(async () => {
  // (A) THE AUDIT PROBE: 503 x4 before the stream, then a normal answer, no fallback chain -> the run survives.
  {
    const up = upstream(n => n <= 4 ? jsonErr(503, 'upstream overloaded') : textTurn('rode out the outage'));
    const t0 = Date.now();
    const { res, seq, waits, recov } = await runWith(adapter(up.fetch));
    A.eq(res.reason, 'done', '503 x4 then success with NO fallback ends done (was error/overloaded at 1.6s)');
    A.ok(res.messages.some(m => m.role === 'assistant' && m.content === 'rode out the outage'), 'the recovered answer is the delivered turn');
    A.eq(up.posts.length, 5, 'five POSTs: the adapter ladder (3) then one request per loop rung (1 + 1)');
    A.eq(waits, [4000, 10000], 'the loop slept rungs 2 and 3 only — rungs 0/1 were the adapter\'s 400/1200ms, counted not repeated');
    A.ok(ADAPTER_WAIT + sum(waits) <= PATIENCE, 'total backoff ' + (ADAPTER_WAIT + sum(waits)) + 'ms stays within the ' + PATIENCE + 'ms patience bound');
    A.eq(recov.map(r => [r.action, r.reason, r.attempt, r.delayMs]), [['retry', 'overloaded', 3, 4000], ['retry', 'overloaded', 4, 10000]],
      'recovery telemetry numbers the rungs across adapter + loop (attempt 3 = the first loop-owned rung)');
    A.eq(seq.filter(e => e.name === 'agent.run.error').length, 0, 'a ridden-out outage emits no run.error');
    A.eq(seq.filter(e => e.name === 'provider.fallback').length, 0, 'no failover is claimed for a same-provider retry');
    A.ok(Date.now() - t0 < 10000, 'the only real time spent is the adapter\'s own 1.6s pre-stream backoff');
  }

  // (B) A PERSISTENT outage still terminates, bounded: 3 adapter POSTs + 4 loop rungs = 7 requests (the same
  //     count as the mid-stream ladder's 1 + 6), total backoff exactly the ladder, never multiplied.
  {
    const up = upstream(() => jsonErr(503, 'upstream overloaded'));
    const { res, seq, waits } = await runWith(adapter(up.fetch));
    A.eq(res.reason, 'error', 'a genuinely down provider still ends the run');
    A.eq([res.failureStage, res.failureCode], ['provider_stream', 'overloaded'], 'terminal failure names the stage and class');
    A.eq(up.posts.length, 7, 'seven POSTs total — never the old 15-request storm');
    A.eq(waits, [4000, 10000, 30000, 60000], 'the loop owns rungs 2..5');
    A.ok(ADAPTER_WAIT + sum(waits) <= PATIENCE, 'total backoff ' + (ADAPTER_WAIT + sum(waits)) + 'ms <= patience ' + PATIENCE + 'ms');
    A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, true, 'the terminal overload is honestly transient');
  }

  // (C) NEVER RETRIED: auth, billing (insufficient_quota 429), a spent subscription quota, and a TLS rejection all
  //     stop on the FIRST request — no adapter retry, no loop rung.
  {
    const cases = [
      ['401 auth', () => jsonErr(401, 'Incorrect API key provided'), 'auth'],
      ['429 insufficient_quota', () => jsonErr(429, 'You exceeded your current quota, please check your plan and billing details.'), 'billing'],
      ['429 weekly quota', () => jsonErr(429, 'The usage limit has been reached. Your limit resets in 3 days.'), 'quota_exhausted']
    ];
    for (const [label, answer, code] of cases) {
      const up = upstream(answer);
      const { res, seq, waits } = await runWith(adapter(up.fetch));
      A.eq(res.reason, 'error', label + ' -> the run ends error');
      A.eq(up.posts.length, 1, label + ' -> exactly ONE request (fatal after 1 attempt)');
      A.eq(waits, [], label + ' -> no backoff was slept');
      A.eq(res.failureCode, code, label + ' -> failureCode ' + code);
      A.eq(seq.find(e => e.name === 'agent.run.error').payload.transient, false, label + ' -> not transient');
    }
    let tlsCalls = 0;
    const tlsFetch = async (url) => {
      if (!/chat\/completions/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
      tlsCalls++;
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
    };
    const { res, seq, waits } = await runWith(adapter(tlsFetch));
    A.eq([res.reason, res.failureCode], ['error', 'tls_certificate'], 'a TLS rejection ends the run as tls_certificate');
    A.eq(tlsCalls, 1, 'the adapter does not re-send into a certificate it cannot trust');
    A.eq(waits, [], 'no backoff for a certificate failure');
    A.ok(/NODE_EXTRA_CA_CERTS/.test(seq.find(e => e.name === 'agent.run.error').payload.message), 'the user is told how to fix it');
  }

  // (D) TOOLS ARE NEVER RE-DISPATCHED: a turn that already ran a host tool, then a pre-stream outage on the NEXT
  //     model call. The retries re-issue only the model request; the tool's effect happens exactly once.
  {
    let toolRuns = 0;
    const registry = makeRegistry();
    registry.register({ name: 'fixture_action', schema: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } },
      run: async () => { toolRuns++; return 'host effect complete'; } });
    const up = upstream(n => n === 1 ? toolTurn('call-1', 'fixture_action', '{"action":"apply"}')
      : n <= 5 ? jsonErr(503, 'upstream overloaded') : textTurn('done after the outage'));
    const { res, seq, waits } = await runWith(adapter(up.fetch), {
      messages: [{ role: 'user', content: 'apply the fixture' }], tools: [], dispatch: (c, ctx) => registry.dispatch(c, ctx), capCtx: openCtx()
    });
    A.eq(res.reason, 'done', 'the run completes after the post-tool outage');
    A.eq(toolRuns, 1, 'the completed host effect executed exactly once across every retry');
    A.eq(seq.filter(e => e.name === 'agent.tool_call').length, 1, 'exactly one tool call was surfaced');
    A.eq(up.posts.length, 6, 'one tool turn + 3 adapter POSTs + 1 + 1 loop rungs');
    A.eq(waits, [4000, 10000], 'same counted ladder after a tool turn');
    const retried = up.posts.slice(1);
    A.ok(retried.every(b => b.messages.filter(m => m.role === 'tool' && m.tool_call_id === 'call-1').length === 1),
      'every retried request carries the ONE paired tool result — replayed as history, never re-run');
  }

  // (E) JITTER: ±20% per rung from o.random, and the local total never exceeds the patience bound. Scripted
  //     provider stamping its spend like the real adapters (and honoring req.preStreamRetries), no real timers.
  {
    const stamped = () => {
      let calls = 0;
      return { priceOf, contextLimit: () => 0, stream: async function* (req) {
        calls++;
        const own = req.preStreamRetries === 0 ? 1 : 3;
        const e = Object.assign(new Error('custom http 503 - upstream overloaded'), { status: 503, preStreamRetriesExhausted: true,
          preStreamAttempts: own, preStreamWaitMs: own === 3 ? ADAPTER_WAIT : 0 });
        throw e;
        yield null;   // eslint: generator shape
      }, get calls() { return calls; } };
    };
    const hi = await runWith(stamped(), { random: () => 0.999999 });
    const lo = await runWith(stamped(), { random: () => 0 });
    A.eq(lo.waits, [3200, 8000, 24000, 48000], 'random 0 -> every rung 20% early');
    A.eq(hi.waits.slice(0, 3), [4800, 12000, 36000], 'random ~1 -> rungs 20% late');
    A.eq(hi.waits[3], PATIENCE - ADAPTER_WAIT - 4800 - 12000 - 36000, 'the last late rung shrinks to fit the remaining patience');
    A.ok(ADAPTER_WAIT + sum(hi.waits) <= PATIENCE, 'even worst-case upward jitter stays within ' + PATIENCE + 'ms');
    A.ok(ADAPTER_WAIT + sum(lo.waits) <= PATIENCE, 'downward jitter is within the bound too');
    A.eq([hi.res.reason, lo.res.reason], ['error', 'error'], 'jitter never extends the ladder — a persistent outage still ends');
    // agents sharing one key draw different samples -> different comeback times (no lockstep)
    const a = await runWith(stamped(), { random: () => 0.1 });
    const b = await runWith(stamped(), { random: () => 0.9 });
    A.ok(a.waits[0] !== b.waits[0] && Math.abs(a.waits[0] - 4000) <= 800 && Math.abs(b.waits[0] - 4000) <= 800, 'two agents come back at different times, each within ±20%: ' + a.waits[0] + ' vs ' + b.waits[0]);
    // a throwing random source degrades to the plain rung instead of breaking recovery
    const bad = await runWith(stamped(), { random: () => { throw new Error('rng down'); } });
    A.eq(bad.waits, [4000, 10000, 30000, 60000], 'a broken random source falls back to the un-jittered ladder');
  }

  // (F) A server-stated wait (Retry-After on an exhausted pre-stream 429 rate limit) is honored — never earlier —
  //     with upward-only jitter, and the rate limit that is NOT a spent quota keeps retrying.
  {
    let calls = 0;
    const provider = { priceOf, contextLimit: () => 0, stream: async function* (req) {
      calls++;
      if (calls <= 2) {
        throw Object.assign(new Error('custom http 429 - rate limit exceeded'), { status: 429, headers: { 'retry-after': '20' },
          preStreamRetriesExhausted: true, preStreamAttempts: req.preStreamRetries === 0 ? 1 : 3, preStreamWaitMs: req.preStreamRetries === 0 ? 0 : 40000 });
      }
      yield { type: 'text', delta: 'after the window' };
      yield { type: 'done', finishReason: 'stop' };
    } };
    const { res, waits } = await runWith(provider, { random: () => 0.5 });
    A.eq(res.reason, 'done', 'a plain (non-quota) 429 rides out its window');
    A.eq(waits, [22000, 22000], 'Retry-After 20s honored with +10% upward jitter at sample 0.5 (never earlier than stated)');
  }

  // (G) unknown is NOT continued after an adapter exhausted its ladder — "the same unrecognized refusal three
  //     times" is evidence, not a blip. (Mid-stream unknowns keep their retries — loop.provider-recovery.test.)
  {
    let calls = 0;
    const provider = { priceOf, contextLimit: () => 0, stream: async function* () {
      calls++;
      throw Object.assign(new Error('custom http 409 - conflict'), { status: 409, preStreamRetriesExhausted: true, preStreamAttempts: 3, preStreamWaitMs: ADAPTER_WAIT });
      yield null;
    } };
    const { res, waits } = await runWith(provider);
    A.eq([res.reason, calls, waits.length], ['error', 1, 0], 'an exhausted `unknown` ends without loop rungs');
  }

  // (H) a TLS-alert / socket failure names the DESTINATION HOST in the run error (2026-10-07 macOS report:
  //     "fetch failed (ERR_SSL_TLSV1_ALERT_DECODE_ERROR)" — which service?). Hostname only: never the base URL's
  //     path, never the key. Pre-stream (the adapter's fetch catch) AND mid-stream (the guarded reader).
  {
    const alertFetch = async (url) => {
      if (!/chat\/completions/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('C0:error:0A000432:SSL routines:ssl3_read_bytes:tlsv1 alert decode error:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:1605:SSL alert number 50'), { code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR' }) });
    };
    const { res, seq } = await runWith(adapter(alertFetch));
    const msg = String((seq.find(e => e.name === 'agent.run.error') || { payload: {} }).payload.message || '');
    A.eq(res.reason, 'error', 'the TLS alert ends the run');
    A.ok(/ERR_SSL_TLSV1_ALERT_DECODE_ERROR fixture\.invalid/.test(msg), 'the run error names code + host (got ' + msg + ')');
    A.ok(!/\/v1|fixture-only/.test(msg), 'and never the URL path or the key');

    const enc = new TextEncoder();
    const dropFetch = async (url) => {
      if (!/chat\/completions/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
      let sent = false;
      const body = new ReadableStream({ pull(ctrl) {
        if (!sent) { sent = true; ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'par' } }] }) + NL + NL)); return; }
        ctrl.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
      } });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const mid = await runWith(adapter(dropFetch));
    const mmsg = String((mid.seq.find(e => e.name === 'agent.run.error') || { payload: {} }).payload.message || '');
    A.eq(mid.res.reason, 'error', 'a socket that keeps dropping mid-stream ends the run');
    A.ok(/UND_ERR_SOCKET fixture\.invalid/.test(mmsg), 'the mid-stream run error names code + host (got ' + mmsg + ')');
    A.ok(!/\/v1|fixture-only/.test(mmsg), 'and never the URL path or the key');
  }

  A.report('loop.prestream-outage-ladder.test');
})();
