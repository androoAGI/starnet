/* node test/errorclass.unreachable.test.js — NOTHING ANSWERING AT THE ADDRESS IS 'unreachable' (quick win 15, bug 8873fd77,
   GH#111).

   A refused connection (ECONNREFUSED: Ollama or LM Studio not started) or a name that did not resolve (ENOTFOUND /
   EAI_AGAIN) rode the `timeout` class: every adapter's pre-stream ladder plus the loop's six rungs — ~106 s of
   "retry 5/6 in 16s (timeout)" against an address where nothing was ever going to answer — and the run ended on a bare
   "fetch failed (ECONNREFUSED 127.0.0.1)". Now it is its own class: ONE retry (a blip still heals), then the turn ends
   naming the host and port and what to check. A connection that was made and then dropped (ECONNRESET) stays `timeout`.

   ONE RETRY ONLY AT A LOCAL ADDRESS (0.14.2 release review, B5). The one retry is for an address on this computer or this
   network (hostScope loopback / private). A PUBLIC host that does not answer is what a Wi-Fi drop, a VPN reconnect or
   sleep/wake looks like for a while (Windows reports an offline lookup as ENOTFOUND); with one retry, a reply cut mid-stream
   whose reconnect met the network still down ended the task in about half a second. A public host, or an error that
   names no address, keeps the ladder it rode as `timeout` in 0.14.1, and the sentence that names the address stays.

   Pins: the classification and its sentence; recovery-policy's one-rung cap at a local address and the timeout ladder at
   a public one; every fetch adapter's pre-stream ladder making exactly one retry locally and the full ladder publicly;
   the real loop over the real openai-compatible adapter ending after two requests with the host named, the retry line
   reading "unreachable"; and the same loop, pre-stream and mid-stream, riding the timeout ladder at a public address.
   No network: fetch is stubbed with the error undici throws. */
'use strict';
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { classifyApiError, REASONS, _internals } = require('../sidecar/providers/errorClass.js');
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
    // 0.14.2 release review (B5): a PUBLIC address keeps the ladder it rode as timeout in 0.14.1 — no class budget, no DNS
    // floor, no fallback (timeout had none) — and keeps the sentence above
    A.eq([hosted.retryable, hosted.retryBudget, hosted.retryDelayMs, hosted.shouldFallback], [true, null, null, false], 'hosted: the timeout ladder (no class budget, no DNS floor) and no fallback, as in 0.14.1');
    // an IPv6 loopback is this computer too: undici names a refused [::1] as address '::1' (hostScope used to strip its ':1')
    const v6 = classifyApiError(refused('::1', 11434), {});
    A.ok(v6.retryBudget === 1 && /nothing is listening at ::1 on this computer/.test(v6.message), 'a refused ::1 is this computer: one retry, and the sentence says so');
    const lan = classifyApiError(refused('192.168.1.20', 1234), {});
    A.ok(/the connection to 192\.168\.1\.20:1234 was refused/.test(lan.message) && /not running/.test(lan.message) && !/nothing is listening/.test(lan.message), 'a LAN server: refused, not running there');
    A.eq(lan.retryBudget, 1, 'a LAN server: one retry');
    const d = classifyApiError(unresolved('api.nowhere.test'), {});
    A.eq(d.reason, 'unreachable', 'a name that did not resolve is unreachable');
    A.ok(/the name api\.nowhere\.test did not resolve \(ENOTFOUND\)/.test(d.message), 'it names the unresolved host');
    const again = classifyApiError(unresolved('api.nowhere.test', 'EAI_AGAIN'), {});
    A.eq(again.reason, 'unreachable', 'EAI_AGAIN too');
    A.ok(/could not be looked up just now \(EAI_AGAIN, a temporary DNS failure\)/.test(again.message), 'EAI_AGAIN says the lookup failed for now');
    // a PUBLIC name that did not resolve (Windows reports an offline lookup as ENOTFOUND): the ladder, at its own rungs
    A.eq([d.retryBudget, d.retryDelayMs, again.retryBudget, again.retryDelayMs], [null, null, null, null], 'a public name that did not resolve: the timeout ladder, no 4 s floor');
    // a LOCAL name lookup that failed waits out a blip before its ONE retry (review 2026-10-27: a 400 ms retry landed inside it)
    const dLan = classifyApiError(unresolved('gpu-box.lan'), {});
    const dBare = classifyApiError(unresolved('ollama', 'EAI_AGAIN'), {});
    A.eq([dLan.retryBudget, dLan.retryDelayMs, dBare.retryBudget, dBare.retryDelayMs], [1, 4000, 1, 4000], 'a .lan name and a bare container name: one retry, after 4 s');
    A.ok(/the name gpu-box\.lan did not resolve \(ENOTFOUND\)/.test(dLan.message), 'a local name is named the same way');
    // the adapter-stamped hostname names it when the cause does not
    const bare = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' }, requestHost: 'lmstudio.lan' });
    A.ok(/the connection to lmstudio\.lan was refused/.test(classifyApiError(bare, {}).message), 'the stamped request host names it when the cause names none');
    A.eq(classifyApiError(bare, {}).retryBudget, 1, 'a stamped LAN hostname: one retry');
    A.eq(classifyApiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' }, requestHost: 'api.openai.com' }), {}).retryBudget, null, 'a stamped public hostname: the ladder');
    // the budget follows the address the sentence names: the cause's own address first, then the stamped hostname
    const proxied = classifyApiError(Object.assign(refused('127.0.0.1', 8080), { requestHost: 'api.openai.com' }), {});
    A.ok(proxied.retryBudget === 1 && /nothing is listening at 127\.0\.0\.1:8080 on this computer/.test(proxied.message), 'a refused 127.0.0.1 is local whatever host was dialled, and its sentence says so');
    // an error that names no address cannot prove it is local: the ladder (the 0.14.1 behaviour)
    const nameless = classifyApiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), {});
    A.eq([nameless.reason, nameless.retryBudget], ['unreachable', null], 'no address named: still unreachable, on the ladder');
    // where an address is (hostScope): this computer and this network are local, anything else is public
    const isLocal = (code, field, host) => _internals.unreachableIsLocal({ code, cause: { code, [field]: host } });
    const local = [['ECONNREFUSED', 'address', '::1'], ['ECONNREFUSED', 'address', '10.0.0.5'], ['ECONNREFUSED', 'address', '172.20.1.1'],
      ['ECONNREFUSED', 'address', '100.64.0.1'], ['ECONNREFUSED', 'address', 'fd00::1'], ['ENOTFOUND', 'hostname', 'host.docker.internal'], ['ENOTFOUND', 'hostname', 'localhost']];
    const remote = [['ECONNREFUSED', 'address', '8.8.8.8'], ['ECONNREFUSED', 'address', '172.32.0.1'], ['ENOTFOUND', 'hostname', 'api.openai.com'], ['EAI_AGAIN', 'hostname', 'chatgpt.com']];
    A.eq(local.filter(r => !isLocal(...r)).map(r => r[2]), [], 'loopback, RFC 1918, CGNAT, ULA and .internal addresses are local');
    A.eq(remote.filter(r => isLocal(...r)).map(r => r[2]), [], 'public addresses and names are not');
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
    const dns = Policy.providerFailure(Object.assign({}, base, { classification: classifyApiError(unresolved('gpu-box.lan', 'EAI_AGAIN'), {}), retriesUsed: 0, jitterSample: 0 }));
    A.ok(dns.action === 'retry' && dns.delayMs >= 4000, 'a failed LOCAL name lookup: the loop-owned retry waits at least 4 s (' + dns.delayMs + ' ms)');
    const timeoutCls = classifyApiError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), {});
    A.eq(Policy.providerFailure(Object.assign({}, base, { classification: timeoutCls, retriesUsed: 1 })).action, 'retry', 'a timeout keeps its full ladder');
    // after the adapter spent its own pre-stream retry, a local address is done (its one retry is gone)...
    A.eq(Policy.providerFailure(Object.assign({}, base, { retriesUsed: 1, preStreamRetriesExhausted: true })).action, 'fail', 'local, adapter ladder spent: the turn ends');
    // ...and a PUBLIC address gets exactly what a timeout gets (the class it rode in 0.14.1): rung for rung, with a fallback
    // configured or not, and after an adapter spent its own pre-stream ladder too
    const pub = [classifyApiError(unresolved('api.openai.com'), {}), classifyApiError(unresolved('chatgpt.com', 'EAI_AGAIN'), {}), classifyApiError(refused('104.18.1.1', 443), {})];
    const differs = [];
    for (const cls of pub) for (let used = 0; used <= 7; used++) for (const hasFallback of [false, true]) for (const pre of [false, true]) {
      const inp = Object.assign({}, base, { retriesUsed: used, hasFallback, preStreamRetriesExhausted: pre, jitterSample: 0.5, waitedMs: 0 });
      const a = Policy.providerFailure(Object.assign({}, inp, { classification: cls }));
      const b = Policy.providerFailure(Object.assign({}, inp, { classification: timeoutCls }));
      if (a.action !== b.action || a.delayMs !== b.delayMs) differs.push([cls.message.slice(0, 40), used, hasFallback, pre, a.action, b.action, a.delayMs, b.delayMs].join(' '));
    }
    A.eq(differs, [], 'a public address: every recovery decision is the timeout one (ladder, waits, no failover)');
    const fifth = Policy.providerFailure(Object.assign({}, base, { classification: pub[0], retriesUsed: 5, preStreamRetriesExhausted: true, jitterSample: 0.5 }));
    A.eq([fifth.action, fifth.reason, fifth.delayMs], ['retry', 'unreachable', 60000], 'a public address on rung 6 still retries, at the ladder\'s 60 s rung, and still reads unreachable');
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
    // a failed LOCAL name lookup: the same one retry, after 4 s (every adapter at once, so the suite waits 4 s, not 20)
    const spend = async (make, error) => {
      let posts = 0;
      const fetch = async (url, init) => {
        if (!init || init.method !== 'POST') return new Response('{"data":[]}');
        posts++;
        throw error();
      };
      let err = null;
      try { for await (const _ of make(fetch).stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { err = e; }
      return [posts, err && err.preStreamAttempts, err && err.preStreamWaitMs, !!(err && err.preStreamRetriesExhausted)];
    };
    const dnsRuns = Object.entries(adapters).map(async ([name, make]) => {
      const [posts, , waited] = await spend(make, () => unresolved('gpu-box.lan', 'EAI_AGAIN'));
      A.eq([posts, waited], [2, 4000], name + ': EAI_AGAIN at a LAN name — one retry, after a 4 s wait (was 400 ms)');
    });
    // a PUBLIC address (0.14.2 release review, B5): the adapter's whole pre-stream ladder, exactly as a timeout spends it
    const publicRuns = Object.entries(adapters).map(async ([name, make]) => {
      const [pubDns, pubRefused, tmo] = await Promise.all([
        spend(make, () => unresolved('api.example.com')),
        spend(make, () => refused('104.18.1.1', 443)),
        spend(make, () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }))
      ]);
      A.eq([pubDns, pubRefused], [tmo, tmo], name + ': a public ENOTFOUND or ECONNREFUSED spends the timeout pre-stream ladder ' + JSON.stringify(tmo));
      A.eq(tmo.slice(0, 2), [3, 3], name + ': which is three requests (the full ladder, as in 0.14.1)');
    });
    await Promise.all(dnsRuns.concat(publicRuns));
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

  // ---- 4c. a PUBLIC address over the real loop and the real adapter (0.14.2 release review, B5): the timeout ladder, pre-stream
  //      and mid-stream — a Wi-Fi drop, a VPN reconnect or sleep/wake is waited out, never ended in half a second ----
  {
    const enc = s => new TextEncoder().encode(s);
    const chunk = (delta, finish, usage) => 'data: ' + JSON.stringify(Object.assign({ choices: [{ index: 0, delta, finish_reason: finish }] }, usage ? { usage } : {})) + '\n\n';
    const answerRes = () => new Response(enc(chunk({ content: 'ok' }, null) + chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }) + 'data: [DONE]\n\n'),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
    // a reply cut mid-stream: one delta, then the socket drops (undici: TypeError 'terminated', cause ECONNRESET)
    const dropped = () => Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const cutRes = () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc(chunk({ content: 'partial ' }, null))); },
      pull(c) { c.error(dropped()); }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const resetErr = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const loopOver = async (baseUrl, script) => {
      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      let posts = 0;
      const fetch = async (url, init) => {
        if (!init || init.method !== 'POST') return new Response('{"data":[]}');
        posts++;
        return script(posts);
      };
      const waits = [];
      const res = await runAgentLoop({
        messages: [{ role: 'user', content: 'hi' }], emit: makeEmitter(bus, () => {}), model: 'gpt-x', agentId: 'a', runId: 'r-scope-' + baseUrl.length + '-' + Math.random().toString(36).slice(2),
        provider: makeOpenAICompatibleProvider({ fetch, key: 'k', baseUrl }),
        cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 2 }) }), sleep: async ms => { waits.push(ms); }, random: () => 0.5
      });
      const retries = seq.filter(e => e.name === 'provider.retry').map(e => e.payload);
      const errEv = seq.filter(e => e.name === 'agent.run.error').pop();
      return { reason: res.reason, posts, waits, retries, error: errEv ? String(errEv.payload.message || '') : '' };
    };
    const PUBLIC = 'https://api.example.com/v1';
    const [preDns, preTimeout, preBack, midDns, midTimeout, midBack, midLocal] = await Promise.all([
      loopOver(PUBLIC, () => { throw unresolved('api.example.com'); }),
      loopOver(PUBLIC, () => { throw resetErr(); }),
      loopOver(PUBLIC, n => { if (n <= 4) throw unresolved('api.example.com'); return answerRes(); }),
      loopOver(PUBLIC, n => { if (n === 1) return cutRes(); throw unresolved('api.example.com'); }),
      loopOver(PUBLIC, n => { if (n === 1) return cutRes(); throw resetErr(); }),
      loopOver(PUBLIC, n => { if (n === 1) return cutRes(); if (n <= 3) throw unresolved('api.example.com'); return answerRes(); }),
      loopOver('http://127.0.0.1:1234/v1', n => { if (n === 1) return cutRes(); throw refused('127.0.0.1', 1234); })
    ]);
    // pre-stream: nothing answered from the first request on
    A.eq([preDns.reason, preDns.posts, preDns.waits], [preTimeout.reason, preTimeout.posts, preTimeout.waits], 'public, pre-stream: ENOTFOUND spends exactly the timeout ladder (requests and waits) ' + JSON.stringify([preTimeout.posts, preTimeout.waits]));
    A.ok(preDns.posts === 7 && preDns.waits.length === 4, 'public, pre-stream: seven requests, the adapter\'s three then four loop rungs (was 2 requests: one retry, then the end)');
    A.ok(preDns.retries.length > 0 && preDns.retries.every(r => r.reason === 'unreachable' && r.maxAttempts === Policy.RETRY_DELAYS_MS.length), 'public, pre-stream: every retry line reads unreachable, "n/' + Policy.RETRY_DELAYS_MS.length + '"');
    A.ok(/the name api\.example\.com did not resolve \(ENOTFOUND\)/.test(preDns.error), 'public, pre-stream: the end still names the address');
    A.eq([preBack.reason, preBack.posts], ['done', 5], 'public, pre-stream: the network back on the fifth request finishes the task');
    // mid-stream: the reply was cut, and the reconnect met the network still down
    A.eq([midDns.reason, midDns.posts, midDns.waits], [midTimeout.reason, midTimeout.posts, midTimeout.waits], 'public, mid-stream: a reconnect that cannot resolve the name rides the timeout ladder ' + JSON.stringify([midTimeout.posts, midTimeout.waits]));
    A.eq(midDns.posts, 1 + Policy.RETRY_DELAYS_MS.length, 'public, mid-stream: the cut reply and every rung (was 2 requests, ~0.5 s)');
    A.eq([midBack.reason, midBack.posts], ['done', 4], 'public, mid-stream: the network back on the fourth request finishes the task');
    A.eq(midBack.retries.map(r => r.reason), ['timeout', 'unreachable', 'unreachable'], 'public, mid-stream: the drop reads timeout, the reconnects unreachable');
    // a LOCAL address mid-stream stays fast: the drop's retry was its one retry
    A.eq([midLocal.reason, midLocal.posts], ['error', 2], 'local, mid-stream: the reconnect refused at 127.0.0.1 ends the turn (one retry in all)');
    A.ok(/nothing is listening at 127\.0\.0\.1:1234 on this computer/.test(midLocal.error), 'local, mid-stream: the end names the host and port');
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
