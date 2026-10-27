/* node test/errorclass.unreachable.test.js — NOTHING ANSWERING AT THE ADDRESS IS 'unreachable' (quick win 15, bug 8873fd77,
   GH#111).

   A refused connection (ECONNREFUSED: Ollama or LM Studio not started) or a name that did not resolve (ENOTFOUND /
   EAI_AGAIN) rode the `timeout` class: every adapter's pre-stream ladder plus the loop's six rungs — ~106 s of
   "retry 5/6 in 16s (timeout)" against an address where nothing was ever going to answer — and the run ended on a bare
   "fetch failed (ECONNREFUSED 127.0.0.1)". Now it is its own class: ONE retry (a blip still heals), then the turn ends
   naming the host and port and what to check. A connection that was made and then dropped (ECONNRESET) stays `timeout`.

   Pins: the classification and its sentence; recovery-policy's one-rung cap; every fetch adapter's pre-stream ladder
   making exactly one retry; and the real loop over the real openai-compatible adapter ending after two requests with
   the host named, the retry line reading "unreachable". No network: fetch is stubbed with the error undici throws. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { classifyApiError, REASONS } = require('../sidecar/providers/errorClass.js');
const Policy = require('../sidecar/recovery-policy.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeGeminiProvider } = require('../sidecar/providers/gemini.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');

// what undici's fetch rejects with when nothing listens (Node 22): a TypeError whose cause carries the system error
function refused(host, port) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('connect ECONNREFUSED ' + host + ':' + port), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect', address: host, port });
  return e;
}
function unresolved(host, code) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error('getaddrinfo ' + (code || 'ENOTFOUND') + ' ' + host), { code: code || 'ENOTFOUND', syscall: 'getaddrinfo', hostname: host });
  return e;
}

(async () => {
  // ---- 1. the class and its sentence ----
  {
    const c = classifyApiError(refused('127.0.0.1', 11434), { model: 'qwen3:8b' });
    A.eq(c.reason, 'unreachable', 'a refused connection is unreachable, not timeout');
    A.eq(c.retryable, true, 'one retry is still worth it (a server that was just starting)');
    A.eq(c.retryBudget, 1, 'and only one: the class names its retry budget');
    A.eq(c.shouldFallback, true, 'another provider is another host: a configured fallback may answer');
    A.ok(/^fetch failed \(ECONNREFUSED 127\.0\.0\.1\)/.test(c.message), 'the transport detail still leads (the page routes "fetch failed" to its provider-unreachable copy)');
    A.ok(/nothing is listening at 127\.0\.0\.1:11434/.test(c.message) && /connection was refused/.test(c.message), 'it names the host AND port, and says the connection was refused');
    A.ok(/start that server/.test(c.message) && /AI & MODELS/.test(c.message), 'it says what to check');
    const d = classifyApiError(unresolved('api.nowhere.test'), {});
    A.eq(d.reason, 'unreachable', 'a name that did not resolve is unreachable');
    A.ok(/the name api\.nowhere\.test did not resolve \(ENOTFOUND\)/.test(d.message), 'it names the unresolved host');
    A.eq(classifyApiError(unresolved('api.nowhere.test', 'EAI_AGAIN'), {}).reason, 'unreachable', 'EAI_AGAIN too');
    // the adapter-stamped hostname names it when the cause does not
    const bare = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' }, requestHost: 'lmstudio.lan' });
    A.ok(/nothing is listening at lmstudio\.lan/.test(classifyApiError(bare, {}).message), 'the stamped request host names it when the cause names none');
    // a connection that was made and then dropped or stalled is still `timeout`
    A.eq(classifyApiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), {}).reason, 'timeout', 'ECONNRESET stays timeout');
    A.eq(classifyApiError(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }), {}).reason, 'timeout', 'ETIMEDOUT stays timeout');
    A.ok(REASONS.unreachable && REASONS.unreachable.retryBudget === 1, 'REASONS.unreachable carries retryBudget 1');
  }

  // ---- 2. recovery-policy: the class caps the loop's ladder at one rung ----
  {
    const cls = classifyApiError(refused('127.0.0.1', 1234), {});
    const base = { classification: cls, canCompress: false, hasFallback: false, recoveriesUsed: 0, maxRecoveries: 2, maxRetries: 6, waitedMs: 0, patienceMs: Policy.RETRY_PATIENCE_MS };
    A.eq(Policy.providerFailure(Object.assign({}, base, { retriesUsed: 0 })).action, 'retry', 'rung 0: one retry');
    const second = Policy.providerFailure(Object.assign({}, base, { retriesUsed: 1 }));
    A.eq([second.action, second.reason], ['fail', 'unreachable'], 'rung 1: the turn ends (was: five more rungs as timeout)');
    A.eq(Policy.providerFailure(Object.assign({}, base, { retriesUsed: 0, hasFallback: true })).action, 'fallback', 'with a fallback configured it is taken at once');
    const timeoutCls = classifyApiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), {});
    A.eq(Policy.providerFailure(Object.assign({}, base, { classification: timeoutCls, retriesUsed: 1 })).action, 'retry', 'a timeout keeps its full ladder');
  }

  // ---- 3. every fetch adapter's pre-stream ladder makes exactly ONE retry ----
  {
    const adapters = {
      'openai-compatible': f => makeOpenAICompatibleProvider({ fetch: f, key: 'k', baseUrl: 'http://127.0.0.1:1234/v1' }),
      openrouter: f => makeOpenRouterProvider({ fetch: f, key: 'k' }),
      anthropic: f => makeAnthropicProvider({ fetch: f, key: 'k' }),
      gemini: f => makeGeminiProvider({ fetch: f, key: 'k' }),
      codex: f => makeCodexProvider({ fetch: f, token: 't' })
    };
    for (const [name, make] of Object.entries(adapters)) {
      let posts = 0;
      const fetch = async (url, init) => {
        if (!init || init.method !== 'POST') return new Response('{"data":[]}');
        posts++;
        throw refused('127.0.0.1', 1234);
      };
      let err = null;
      try { for await (const _ of make(fetch).stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { err = e; }
      A.ok(err, name + ': the refusal surfaces');
      A.eq(posts, 2, name + ': one request and ONE retry (was 3: the full pre-stream ladder)');
      A.eq(err && err.preStreamRetriesExhausted, true, name + ': marked as the adapter\'s spent ladder');
      A.eq(err && err.preStreamAttempts, 2, name + ': the loop is told two attempts were spent');
    }
  }

  // ---- 4. the real loop over the real adapter: two requests, then the host named ----
  {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    const emit = makeEmitter(bus, () => {});
    let posts = 0;
    const fetch = async (url, init) => {
      if (!init || init.method !== 'POST') return new Response('{"data":[]}');
      posts++;
      throw refused('127.0.0.1', 11434);
    };
    const waits = [];
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'qwen3:8b', agentId: 'a', runId: 'r-unreach',
      provider: makeOpenAICompatibleProvider({ fetch, key: 'k', baseUrl: 'http://127.0.0.1:11434/v1' }),
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), sleep: async ms => { waits.push(ms); }, random: () => 0.5
    });
    A.eq(res.reason, 'error', 'the run ends error');
    A.eq(posts, 2, 'two requests in all: the loop does not re-run a ladder the class says is spent (was 7+)');
    A.eq(waits, [], 'no loop backoff slept on top of the adapter\'s one retry');
    const errEv = seq.filter(e => e.name === 'agent.run.error').pop();
    A.ok(errEv && /nothing is listening at 127\.0\.0\.1:11434/.test(errEv.payload.message), 'agent.run.error names the host and port');
    const end = seq.filter(e => e.name === 'agent.run.end').pop();
    A.ok(end && end.payload.reason === 'error', 'agent.run.end error');
    A.eq(seq.filter(e => e.name === 'provider.retry' && e.payload.reason === 'timeout').length, 0, 'no retry line ever says "timeout"');
  }

  // ---- 5. a loop-owned retry (no adapter ladder) says "unreachable" on the retry line and stops after one ----
  {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    const emit = makeEmitter(bus, () => {});
    let calls = 0;
    const stub = { async *stream() { calls++; throw refused('127.0.0.1', 1234); } };
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit, model: 'm', agentId: 'a', runId: 'r-loop',
      provider: stub, cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), sleep: async () => {}, random: () => 0.5
    });
    A.eq(res.reason, 'error', 'loop-owned: ends error');
    A.eq(calls, 2, 'loop-owned: one retry, then the end');
    const retries = seq.filter(e => e.name === 'provider.retry');
    A.eq(retries.map(e => e.payload.reason), ['unreachable'], 'the one retry line reads unreachable');
  }

  A.report('errorclass.unreachable.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
