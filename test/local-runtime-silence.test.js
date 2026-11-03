/* node test/local-runtime-silence.test.js — a SILENT LOCAL /v1 SERVER gets one request, then the truth (local-runtime-profile
   lane, gap A, 2026-11-03).

   A CUSTOM card pointed at LM Studio (or vLLM, llama.cpp) on this computer or this network was treated as a hosted API:
   no headers within the hosted 30 s connect guard -> three adapter sends, then four loop rungs (7 sends of the same prompt,
   each restarting it on a server that may still have been working on the first); headers then silence -> two idle stalls
   and provider_stalled. Never local_timeout, never a sentence about the server. Now, for a non-native endpoint whose host is
   loopback or private (errorClass hostScope) with no other StarNet call open on that base URL, silence in ANY phase ends
   the turn on local_timeout after ONE request, naming the host, the phase and the wait.

   Locked here with a fake LM Studio on loopback (a real HTTP server, OS-chosen port), the REAL factory + CUSTOM adapter and
   the REAL loop:
     1. loopback, no response headers (connect phase): ONE send, local_timeout, not transient, the sentence
     2. loopback, headers then no first byte: ONE send, local_timeout ('first byte phase')
     3. loopback, one chunk then silence: ONE send, local_timeout ('between chunks phase'), the chunk already shown kept
     4. a private-LAN host (192.168.x, dialled through a fetch that lands on the loopback server): the same three
     5. a public host (dialled the same way): today's ladder — 7 sends and `timeout`; 2 sends and provider_stalled
     6. another StarNet call open on the same base URL: the silent request is re-sent, as before
     7. the wait note: an unanswered local request says so on the wait line, with the ceiling (limitMs)
     8. the ceilings: a local CUSTOM card waits 300 s for headers (the Ollama profile's), a public one the hosted 30 s
   loop.prestream-outage-ladder and loop.stall-giveup keep pinning the hosted ladder unchanged. */
'use strict';
process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS = '150';
process.env.SKYNET_PROVIDER_CONNECT_MS = '150';
process.env.SKYNET_PROVIDER_IDLE_MS = '150';
process.env.SKYNET_LOCAL_WAIT_NOTE_MS = '40';
const http = require('http');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const factory = require('../sidecar/providers/factory.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const NL = String.fromCharCode(10);
const MODEL = 'qwen2.5-7b-instruct';

/* A fake LM Studio: GET /v1/models lists one loaded model (LM Studio's own row shape); POST /v1/chat/completions behaves
   per `mode`: 'connect' never answers, 'first' sends headers and nothing else, 'between' headers and one chunk. */
function fakeLmStudio() {
  const s = { mode: 'connect', sends: [], sockets: new Set(), onSend: null, port: 0 };
  s.chatsFor = text => s.sends.filter(t => t === text).length;
  s.server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: MODEL, object: 'model', type: 'llm', state: 'loaded', quantization: 'Q4_K_M', max_context_length: 32768, loaded_context_length: 8192 }] }));
      return;
    }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let msgs = [];
      try { msgs = JSON.parse(body).messages || []; } catch (_) { msgs = []; }
      const last = msgs[msgs.length - 1] || {};
      s.sends.push(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      if (s.onSend) s.onSend(s);
      if (s.mode === 'connect') return;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      if (s.mode === 'between') res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hel' } }] }) + NL + NL);
    });
  });
  s.server.on('connection', sock => { s.sockets.add(sock); sock.on('close', () => s.sockets.delete(sock)); });
  s.listen = () => new Promise(resolve => s.server.listen(0, '127.0.0.1', () => { s.port = s.server.address().port; resolve(); }));
  s.close = () => new Promise(resolve => { for (const sock of s.sockets) sock.destroy(); s.server.close(() => resolve()); });
  return s;
}

// the URL a card is configured with, dialled on the loopback server (no request ever leaves this machine)
const viaLoopback = (s, origin) => (url, init) => fetch(String(url).replace(origin, 'http://127.0.0.1:' + s.port), init);
const card = (s, origin) => factory.selectProvider({ provider: 'lmstudio', baseUrl: origin + '/v1', fetch: viaLoopback(s, origin) });

async function runTurn(provider, text, signal) {
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const dropped = [];
  const emit = makeEmitter(bus, e => dropped.push(e));
  const res = await runAgentLoop({
    provider, emit, model: MODEL, agentId: 'a', runId: 'r-' + text, random: () => 0.5, signal,
    messages: [{ role: 'user', content: text }],
    cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) })
  });
  return {
    res, dropped,
    errors: seq.filter(e => e.name === 'agent.run.error').map(e => e.payload),
    tokens: seq.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('')
  };
}

const PHASES = [
  { mode: 'connect', phase: 'connect phase', env: 'SKYNET_LOCAL_CONNECT_TIMEOUT_MS', what: /sent no response headers for 150 ms/ },
  { mode: 'first', phase: 'first byte phase', env: 'SKYNET_PROVIDER_IDLE_MS', what: /answered with headers and then sent nothing for 150 ms/ },
  { mode: 'between', phase: 'between chunks phase', env: 'SKYNET_PROVIDER_IDLE_MS', what: /stopped sending in the middle of its reply: nothing for 150 ms after the last chunk/ }
];

async function localRows(s, origin, hostPort, where, label) {
  for (const p of PHASES) {
    s.mode = p.mode;
    const text = label + '-' + p.mode;
    const { res, errors, tokens, dropped } = await runTurn(card(s, origin), text);
    A.eq(s.chatsFor(text), 1, label + ' ' + p.mode + ': ONE request, never re-sent (sends: ' + s.chatsFor(text) + ')');
    A.eq(res.reason, 'error', label + ' ' + p.mode + ': the run ends in error');
    A.eq(res.failureCode, 'local_timeout', label + ' ' + p.mode + ': on local_timeout');
    A.eq(errors.length, 1, label + ' ' + p.mode + ': one agent.run.error');
    const msg = (errors[0] && errors[0].message) || '';
    A.eq(errors[0] && errors[0].transient, false, label + ' ' + p.mode + ': not transient');
    A.ok(msg.indexOf('The model server at ' + hostPort + ' ' + where) === 0, label + ' ' + p.mode + ': names the host and where it is: ' + msg);
    A.ok(msg.indexOf('(' + p.phase + ')') > 0, label + ' ' + p.mode + ': names the phase');
    A.ok(p.what.test(msg), label + ' ' + p.mode + ': names the wait');
    A.ok(/StarNet did not re-send the request/.test(msg), label + ' ' + p.mode + ': says it did not re-send');
    A.ok(/the server's own log/.test(msg) && /smaller model/.test(msg) && msg.indexOf(p.env) > 0, label + ' ' + p.mode + ': names the fixes and the env');
    A.ok(/timed out/.test(msg), label + ' ' + p.mode + ': keeps the timeout words');
    if (p.mode === 'between') A.eq(tokens, 'Hel', label + ': the chunk already shown stays shown');
    A.eq(dropped.length, 0, label + ' ' + p.mode + ': every event passed the contract');
  }
}

(async () => {
  const s = fakeLmStudio();
  await s.listen();
  try {
    // ---- 1-3. loopback ----
    await localRows(s, 'http://127.0.0.1:' + s.port, '127.0.0.1:' + s.port, 'on this computer', 'loopback');

    // ---- 4. a private-LAN host ----
    await localRows(s, 'http://192.168.1.50:1234', '192.168.1.50:1234', 'on this network', 'lan');

    // ---- 5. a public host keeps today's ladder ----
    {
      s.mode = 'connect';
      const { res } = await runTurn(card(s, 'http://llm.example.com:1234'), 'public-connect');
      A.eq(s.chatsFor('public-connect'), 7, 'public host, no headers: 3 adapter sends + 4 loop rungs, as before');
      A.eq(res.failureCode, 'timeout', 'and ends as the retryable timeout');
      s.mode = 'first';
      const r2 = await runTurn(card(s, 'http://llm.example.com:1234'), 'public-first');
      A.eq(s.chatsFor('public-first'), 2, 'public host, headers then silence: two idle stalls, as before');
      A.eq(r2.res.failureCode, 'provider_stalled', 'and ends provider_stalled');
    }

    // ---- 6. another StarNet call open on the same base URL: re-sent as before ----
    {
      s.mode = 'connect';
      const origin = 'http://127.0.0.1:' + s.port;
      const bgAbort = new AbortController();
      const bg = makeOpenAICompatibleProvider({ fetch: viaLoopback(s, origin), baseUrl: origin + '/v1', localSilence: true, connectTimeoutMs: 60000 });
      const bgRun = (async () => { try { for await (const e of bg.stream({ model: MODEL, messages: [{ role: 'user', content: 'quest' }], signal: bgAbort.signal })) void e; } catch (_) { /* stopped below */ } })();
      while (!s.chatsFor('quest')) await new Promise(r => setTimeout(r, 10));
      const stop = new AbortController();
      s.onSend = st => { if (st.chatsFor('busy') >= 2) stop.abort(); };
      const { res } = await runTurn(card(s, origin), 'busy', stop.signal);
      s.onSend = null;
      A.eq(s.chatsFor('busy'), 2, 'a silent request with another StarNet call open on that base URL is re-sent, as before');
      A.eq(res.reason, 'cancelled', 'and was still on the ladder when stopped');
      bgAbort.abort();
      await bgRun;
    }

    // ---- 7. the wait note ----
    {
      s.mode = 'connect';
      const p = card(s, 'http://127.0.0.1:' + s.port);
      const seen = [];
      let error = null;
      try { for await (const ev of p.stream({ model: MODEL, messages: [{ role: 'user', content: 'note' }] })) seen.push(ev); } catch (e) { error = e; }
      const w = seen.find(e => e.type === 'waiting' && e.phase === 'connect');
      A.ok(!!w && /^no answer yet from the model server at 127\.0\.0\.1:\d+ on this computer \(a server loading a model can take minutes\)$/.test(w.note), 'an unanswered local request names the server on the wait line: ' + (w && w.note));
      A.eq(w && [w.limitMs, w.limitKind], [150, 'connect'], 'and carries the connect ceiling it will wait');
      A.ok(!!error && error.localModelTimeout === true, 'and still ends on the local timeout');
    }
  } finally {
    await s.close();
  }

  // ---- 8. the ceilings (no wait: the connect guard's timer is read as it is armed) ----
  {
    const saved = { local: process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS, hosted: process.env.SKYNET_PROVIDER_CONNECT_MS };
    delete process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS;
    delete process.env.SKYNET_PROVIDER_CONNECT_MS;
    const realSetTimeout = global.setTimeout;
    const armed = async baseUrl => {
      const delays = [];
      const ac = new AbortController();
      const fake = async (url, init) => {
        if (!/\/chat(?:\/completions)?$/.test(String(url))) return new Response('{"data":[]}', { status: /\/api\/show$/.test(String(url)) ? 404 : 200 });
        ac.abort();
        const e = new Error('aborted'); e.name = 'AbortError'; throw e;
      };
      const p = factory.selectProvider({ provider: 'custom', baseUrl, fetch: fake });
      global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
      try { for await (const ev of p.stream({ model: MODEL, messages: [{ role: 'user', content: 'x' }], signal: ac.signal })) void ev; }
      finally { global.setTimeout = realSetTimeout; }
      return delays;
    };
    try {
      A.ok((await armed('http://127.0.0.1:1234/v1')).indexOf(300000) >= 0, 'a loopback CUSTOM card waits the local 300 s for headers');
      A.ok((await armed('http://lmstudio.lan:1234/v1')).indexOf(300000) >= 0, 'so does one on this network');
      const pub = await armed('https://llm.example.com/v1');
      A.ok(pub.indexOf(30000) >= 0 && pub.indexOf(300000) < 0, 'a public CUSTOM card keeps the hosted 30 s');
      const ollama = await armed('http://127.0.0.1:11434/v1');
      A.ok(ollama.indexOf(300000) >= 0, 'a CUSTOM card that borrowed the Ollama wire keeps the Ollama profile ceiling');
    } finally {
      if (saved.local != null) process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS = saved.local;
      if (saved.hosted != null) process.env.SKYNET_PROVIDER_CONNECT_MS = saved.hosted;
    }
  }

  A.report('local-runtime-silence.test');
})();
