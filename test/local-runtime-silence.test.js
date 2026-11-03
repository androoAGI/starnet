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
     6. another StarNet call open on the same server (review M1): the silent request is re-sent ONCE, then local_timeout
        saying the other call was open — in the connect phase and the first-byte phase (idleBusy), and with the other call
        configured as localhost or [::1] on the same port (one server)
     7. the wait note: an unanswered local request says so on the wait line, with the ceiling (limitMs) only when that
        request's silence ends the turn (review M3): a busy first send states none, its re-send does; the same for the
        idle ceiling once headers are in
     8. the ceilings: a local CUSTOM card waits 300 s for headers (the Ollama profile's), a public one the hosted 30 s; an
        explicitly set SKYNET_PROVIDER_CONNECT_MS still sets a local card's wait, below SKYNET_LOCAL_CONNECT_TIMEOUT_MS
     9. compaction due on a silent local server (review M4): the summary's ONE request, then local_timeout — no summary
        retry on the run model (the same server), and the turn is never sent after it
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
const { makeSummarizer } = require('../sidecar/compaction-summarizer.js');
const Friendly = require('../frontend/app/friendlyerror.js');
const { makeContext, RUN_CONTEXT_DEFAULTS, compactionSummaryPrompt } = require('../sidecar/context.js');

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
const card = (s, origin, clock = { now: () => Date.now() }) => factory.selectProvider({ provider: 'lmstudio', baseUrl: origin + '/v1', fetch: viaLoopback(s, origin), clock });

/* ANOTHER StarNet call held open on a server (a quest's background call): its own adapter instance, a fetch that never
   answers (it dials nothing — only its open-call entry matters), stopped by its caller. */
async function holdOpen(baseUrl) {
  const ac = new AbortController();
  const never = (url, init) => {
    if (!init || init.body == null) return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    return new Promise((_, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true }));
  };
  const bg = makeOpenAICompatibleProvider({ fetch: never, baseUrl, localSilence: true, connectTimeoutMs: 60000 });
  const run = (async () => { try { for await (const e of bg.stream({ model: MODEL, messages: [{ role: 'user', content: 'quest' }], signal: ac.signal })) void e; } catch (_) { /* stopped below */ } })();
  await new Promise(r => setTimeout(r, 20));
  return { stop: async () => { ac.abort(); await run; } };
}

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
    // COMMS words it as itself with or without the code (review M2): never "timed out — try again", never a context overflow
    for (const code of ['local_timeout', undefined]) {
      const v = Friendly.friendlyError(msg, null, { engineAlive: true, code });
      A.eq([v.kind, v.retryable], ['local_timeout', false], label + ' ' + p.mode + ': COMMS reads local_timeout (code ' + code + ')');
      A.ok(v.userMessage.indexOf('The model server at ' + hostPort) === 0 && v.userMessage.indexOf('[') < 0, label + ' ' + p.mode + ': and leads with the sentence: ' + v.userMessage);
    }
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

    // ---- 6. another StarNet call open on the same server: ONE re-send, then local_timeout (review M1) ----
    {
      const origin = 'http://127.0.0.1:' + s.port;
      const busyRows = [
        { mode: 'connect', phase: 'connect phase', other: origin, label: 'connect' },
        { mode: 'first', phase: 'first byte phase', other: origin, label: 'first byte (idleBusy)' },
        { mode: 'connect', phase: 'connect phase', other: 'http://localhost:' + s.port, label: 'the other call on localhost' },
        { mode: 'connect', phase: 'connect phase', other: 'http://[::1]:' + s.port, label: 'the other call on [::1]' }
      ];
      for (const b of busyRows) {
        s.mode = b.mode;
        const other = await holdOpen(b.other + '/v1');
        const text = 'busy-' + b.label;
        // bounded: code that keeps the whole ladder is stopped at a 3rd send instead of running it out
        const stop = new AbortController();
        s.onSend = st => { if (st.chatsFor(text) >= 3) stop.abort(); };
        const { res, errors } = await runTurn(card(s, origin), text, stop.signal);
        s.onSend = null;
        await other.stop();
        const msg = (errors[0] && errors[0].message) || '';
        A.eq(s.chatsFor(text), 2, b.label + ': a silent request with another StarNet call open on that server is re-sent ONCE (sends: ' + s.chatsFor(text) + ')');
        A.eq([res.reason, res.failureCode], ['error', 'local_timeout'], b.label + ': then the turn ends on local_timeout');
        A.eq(errors[0] && errors[0].transient, false, b.label + ': not transient');
        A.ok(msg.indexOf('(' + b.phase + ')') > 0, b.label + ': names the phase: ' + msg);
        A.ok(/Another StarNet call was open on that server, so StarNet re-sent the request once/.test(msg), b.label + ': says another call was open and the request went twice');
        A.ok(!/StarNet did not re-send/.test(msg), b.label + ': never claims it was not re-sent');
        A.eq(Friendly.friendlyError(msg, null, { engineAlive: true }).kind, 'local_timeout', b.label + ': COMMS reads it as local_timeout without the code');
      }
    }

    // ---- 7. the wait note ----
    {
      s.mode = 'connect';
      let clockNow = 1000;
      const p = card(s, 'http://127.0.0.1:' + s.port, { now: () => clockNow });
      s.onSend = () => { clockNow = 4000; };   // the request left; catalog warm reads do not advance time
      const seen = [];
      let error = null;
      try { for await (const ev of p.stream({ model: MODEL, messages: [{ role: 'user', content: 'note' }] })) seen.push(ev); } catch (e) { error = e; }
      const w = seen.find(e => e.type === 'waiting' && e.phase === 'connect');
      A.ok(!!w && /^no answer yet from the model server at 127\.0\.0\.1:\d+ on this computer \(a server loading a model can take minutes\)$/.test(w.note), 'an unanswered local request names the server on the wait line: ' + (w && w.note));
      A.eq(w && [w.limitMs, w.limitKind], [150, 'connect'], 'and carries the connect ceiling it will wait');
      A.eq(w && w.limitElapsedMs, 3000, 'local wait elapsed time comes from the injected clock, not wall time');
      s.onSend = null;
      A.ok(!!error && error.localModelTimeout === true, 'and still ends on the local timeout');
    }
    // ---- 7b. the limit only when the silence ends the turn (review M3) ----
    const streamOf = async (p, text) => {
      const seen = [];
      let error = null;
      try { for await (const ev of p.stream({ model: MODEL, messages: [{ role: 'user', content: text }] })) seen.push(ev); } catch (e) { error = e; }
      return { seen, error, waits: seen.filter(e => e.type === 'waiting') };
    };
    {
      const origin = 'http://127.0.0.1:' + s.port;
      s.mode = 'connect';
      const other = await holdOpen(origin + '/v1');
      const { waits, error } = await streamOf(card(s, origin), 'note-busy');
      await other.stop();
      const connects = waits.filter(e => e.phase === 'connect');
      A.eq(s.chatsFor('note-busy'), 2, 'busy, no headers: the adapter re-sends once itself');
      A.ok(connects.length >= 2 && !('limitMs' in connects[0]), 'the first (busy) send states no limit: it will be re-sent: ' + JSON.stringify(connects[0]));
      const lim = connects.find(e => e.limitMs > 0);
      A.eq(lim && [lim.limitMs, lim.limitKind], [150, 'connect'], 'its re-send states the ceiling: a silence there ends the turn');
      A.ok(!!lim && lim.limitElapsedMs >= 0 && lim.limitElapsedMs < 150, 'counted from the re-send (limitElapsedMs): ' + (lim && lim.limitElapsedMs));
      A.ok(!!error && error.localModelTimeout === true && error.localResent === true, 'and the re-send\'s silence is local_timeout, marked re-sent');
    }
    {
      const origin = 'http://127.0.0.1:' + s.port;
      s.mode = 'first';
      const alone = await streamOf(card(s, origin), 'note-idle-alone');
      A.ok(alone.waits.some(e => e.phase === 'streaming' && e.limitMs === 150 && e.limitKind === 'silence'), 'alone, headers in: the idle ceiling is stated');
      const other = await holdOpen(origin + '/v1');
      const busy = await streamOf(card(s, origin), 'note-idle-busy');
      await other.stop();
      A.ok(!busy.waits.some(e => e.limitKind === 'silence' || e.limitMs > 0), 'busy, headers in: no idle ceiling stated, the stall will be re-sent: ' + JSON.stringify(busy.waits));
      A.ok(!!busy.error && busy.error.localBusy === true && busy.error.localModelTimeout !== true, 'and the stall goes up marked busy for the loop\'s one re-send');
    }

    // ---- 9. compaction due on a silent local server: ONE request (the summary's), then local_timeout (review M4) ----
    {
      s.mode = 'connect';
      const origin = 'http://127.0.0.1:' + s.port;
      const p = card(s, origin);
      const ctx = makeContext(Object.assign({ contextLimit: 8192 }, RUN_CONTEXT_DEFAULTS));
      const messages = [{ role: 'system', content: 'sys' }];
      for (let i = 0; i < 12; i++) messages.push({ role: 'user', content: 'question ' + i + ' ' + 'q'.repeat(3000) }, { role: 'assistant', content: 'answer ' + i + ' ' + 'a'.repeat(3000) });
      messages.push({ role: 'user', content: 'compact-turn' });
      // an aux model unlike the run model: the summarizer's retry-on-the-run-model path is the one that must not fire
      const summarize = makeSummarizer({ model: MODEL, provider: p, auxModelFor: () => 'aux-' + MODEL, summaryPrompt: compactionSummaryPrompt });
      const before = s.sends.length;
      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      const dropped = [];
      const res = await runAgentLoop({
        provider: p, emit: makeEmitter(bus, e => dropped.push(e)), model: MODEL, agentId: 'a', runId: 'r-compact', random: () => 0.5,
        messages, context: ctx, summarize, microCompaction: false, cost: makeCostEngine({ priceOf: () => ({ in: 0, out: 0 }) })
      });
      const sent = s.sends.slice(before);
      const errors = seq.filter(e => e.name === 'agent.run.error').map(e => e.payload);
      A.eq(sent.length, 1, 'compaction due + a silent local server: ONE request in all (sends: ' + sent.length + ')');
      A.ok(/^Summarize this earlier part of the conversation/.test(sent[0] || ''), 'and it was the summary\'s');
      A.eq(s.chatsFor('compact-turn'), 0, 'the turn itself is never sent after the summary\'s silence');
      A.eq([res.reason, res.failureCode], ['error', 'local_timeout'], 'the run ends on local_timeout');
      A.ok(errors.length === 1 && errors[0].transient === false && /^The model server at 127\.0\.0\.1:\d+ on this computer/.test(errors[0].message), 'with the server\'s sentence: ' + (errors[0] && errors[0].message));
      A.eq(dropped.length, 0, 'every event passed the contract');
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
      // an explicitly set SKYNET_PROVIDER_CONNECT_MS still applies to a local card (review minor) — the local knob outranks it
      process.env.SKYNET_PROVIDER_CONNECT_MS = '45000';
      const hostedKnob = await armed('http://127.0.0.1:1234/v1');
      A.ok(hostedKnob.indexOf(45000) >= 0 && hostedKnob.indexOf(300000) < 0, 'SKYNET_PROVIDER_CONNECT_MS set: a loopback CUSTOM card waits it, not the local 300 s');
      process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS = '120000';
      const both = await armed('http://127.0.0.1:1234/v1');
      A.ok(both.indexOf(120000) >= 0 && both.indexOf(45000) < 0, 'both set: SKYNET_LOCAL_CONNECT_TIMEOUT_MS decides a local card');
      delete process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS;
      delete process.env.SKYNET_PROVIDER_CONNECT_MS;
    } finally {
      if (saved.local != null) process.env.SKYNET_LOCAL_CONNECT_TIMEOUT_MS = saved.local;
      if (saved.hosted != null) process.env.SKYNET_PROVIDER_CONNECT_MS = saved.hosted;
    }
  }

  A.report('local-runtime-silence.test');
})();
