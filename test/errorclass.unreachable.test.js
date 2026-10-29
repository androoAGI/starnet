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
    // review 2026-10-27: no fallback, exactly as `timeout` before it — a local server that is simply not started must not
    // send the conversation to a cloud fallback (nor to another model on the same dead server)
    A.eq(c.shouldFallback, false, 'no fallback: a server that is not started never sends the conversation elsewhere');
    A.ok(/^fetch failed \(ECONNREFUSED 127\.0\.0\.1\)/.test(c.message), 'the transport detail still leads (the page routes "fetch failed" to its provider-unreachable copy)');
    A.ok(/nothing is listening at 127\.0\.0\.1:11434 on this computer/.test(c.message) && /connection was refused/.test(c.message), 'it names the host AND port, and says the connection was refused');
    A.ok(/start the server that should answer there \(Ollama, LM Studio/.test(c.message) && /AI & MODELS/.test(c.message), 'it says what to check');
    A.eq(c.retryDelayMs, null, 'a refused connection retries at the ladder\'s own first rung');
    // only what the harness can prove (review 2026-10-27): a refused connection to a HOSTED address is not "nothing is
    // listening" — a firewall, proxy or VPN refuses connections too — and "start Ollama" is the wrong door there
    const hosted = classifyApiError(refused('104.18.1.1', 443), { model: 'gpt-5.5' });
    A.eq(hosted.reason, 'unreachable', 'a refused hosted address is unreachable too');
    A.ok(/the connection to 104\.18\.1\.1:443 was refused/.test(hosted.message) && /firewall, proxy or VPN/.test(hosted.message), 'hosted: it says the connection was refused and points at the network');
    A.ok(!/nothing is listening|Ollama|LM Studio/.test(hosted.message), 'hosted: never "nothing is listening", never "start Ollama"');
    // an IPv6 loopback is this computer too: undici names a refused [::1] as address '::1' (hostScope used to strip its ':1')
    const v6 = classifyApiError(refused('::1', 11434), {});
    A.ok(v6.retryBudget === 1 && /nothing is listening at ::1 on this computer/.test(v6.message), 'a refused ::1 is this computer: one retry, and the sentence says so');
    const lan = classifyApiError(refused('192.168.1.20', 1234), {});
    A.ok(/the connection to 192\.168\.1\.20:1234 was refused/.test(lan.message) && /not running/.test(lan.message) && !/nothing is listening/.test(lan.message), 'a LAN server: refused, not running there');
    const d = classifyApiError(unresolved('api.nowhere.test'), {});
    A.eq(d.reason, 'unreachable', 'a name that did not resolve is unreachable');
    A.ok(/the name api\.nowhere\.test did not resolve \(ENOTFOUND\)/.test(d.message), 'it names the unresolved host');
    const again = classifyApiError(unresolved('api.nowhere.test', 'EAI_AGAIN'), {});
    A.eq(again.reason, 'unreachable', 'EAI_AGAIN too');
    A.ok(/could not be looked up just now \(EAI_AGAIN, a temporary DNS failure\)/.test(again.message), 'EAI_AGAIN says the lookup failed for now');
    // a name lookup that failed waits out a blip before its ONE retry (review 2026-10-27: a 400 ms retry landed inside it)
    A.eq([d.retryDelayMs, again.retryDelayMs], [4000, 4000], 'ENOTFOUND and EAI_AGAIN wait 4 s before their one retry');
    // the adapter-stamped hostname names it when the cause does not
    const bare = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' }, requestHost: 'lmstudio.lan' });
    A.ok(/the connection to lmstudio\.lan was refused/.test(classifyApiError(bare, {}).message), 'the stamped request host names it when the cause names none');
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
    A.eq(Policy.providerFailure(Object.assign({}, base, { retriesUsed: 0, hasFallback: true })).action, 'retry', 'with a fallback configured it is NOT taken (no failover off a server that is not started)');
    A.eq(Policy.providerFailure(Object.assign({}, base, { retriesUsed: 1, hasFallback: true })).action, 'fail', '...and after the one retry the turn ends, fallback or not');
    const dns = Policy.providerFailure(Object.assign({}, base, { classification: classifyApiError(unresolved('api.nowhere.test', 'EAI_AGAIN'), {}), retriesUsed: 0, jitterSample: 0 }));
    A.ok(dns.action === 'retry' && dns.delayMs >= 4000, 'a failed name lookup: the loop-owned retry waits at least 4 s (' + dns.delayMs + ' ms)');
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
    // a failed name lookup: the same one retry, after 4 s (every adapter at once, so the suite waits 4 s, not 20)
    const dnsRuns = Object.entries(adapters).map(async ([name, make]) => {
      let posts = 0;
      const fetch = async (url, init) => {
        if (!init || init.method !== 'POST') return new Response('{"data":[]}');
        posts++;
        throw unresolved('api.nowhere.test', 'EAI_AGAIN');
      };
      let err = null;
      try { for await (const _ of make(fetch).stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { err = e; }
      A.eq([posts, err && err.preStreamWaitMs], [2, 4000], name + ': EAI_AGAIN — one retry, after a 4 s wait (was 400 ms)');
    });
    await Promise.all(dnsRuns);
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

  // ---- 4b. a configured fallback on the same dead server is never dialled (review 2026-10-27) ----
  {
    const bus = A.makeBus();
    const seq = A.collectBus(bus, events.names());
    let posts = 0;
    const fetch = async (url, init) => {
      if (!init || init.method !== 'POST') return new Response('{"data":[]}');
      posts++;
      throw refused('127.0.0.1', 11434);
    };
    const res = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }], emit: makeEmitter(bus, () => {}), model: 'qwen3:8b', agentId: 'a', runId: 'r-unreach-fb',
      provider: makeOpenAICompatibleProvider({ fetch, key: 'k', baseUrl: 'http://127.0.0.1:11434/v1' }),
      fallbacks: [{ provider: makeOpenAICompatibleProvider({ fetch, key: 'k', baseUrl: 'http://127.0.0.1:11434/v1' }), model: 'qwen3:4b' }],
      cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), sleep: async () => {}, random: () => 0.5
    });
    A.eq(res.reason, 'error', 'with a fallback configured: the run still ends error');
    A.eq(posts, 2, 'with a fallback configured: two requests, the fallback never dialled (was 4: two more at the same dead server)');
    A.eq(seq.filter(e => e.name === 'provider.fallback').length, 0, 'no provider.fallback event');
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
    A.eq(retries.map(e => e.payload.maxAttempts), [1], 'and reads "retry 1/1": never a promise of rungs the class refuses (was 1/6)');
  }

  A.report('errorclass.unreachable.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
