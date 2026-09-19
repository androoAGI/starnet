/* node test/provider.timeouts.test.js — the shared provider stream-timeout plumbing (Lane A item 1/4/5).
   Covers: the idle watchdog (a stalled SSE stream errors with a `timeout`-CLASSIFIED error, and cancels the
   reader) vs a user-cancel (classifies as abort, NOT timeout); connectSignal composition; the Retry-After
   delay math honored by requestWithRetry; and the non-blocking catalog re-warm kick. Zero network. */
'use strict';
const A = require('./_assert.js');
const provider = require('../sidecar/providers/provider.js');
const { classifyApiError } = require('../sidecar/providers/errorClass.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const timeouts = provider.timeouts;
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }

(async () => {
  // 1. idleGuardedReader: a reader that never resolves read() -> the watchdog fires and throws a `timeout`
  //    error (message contains "timed out"), and the underlying reader is cancelled.
  {
    let cancelled = false;
    const stallReader = {
      read: () => new Promise(() => {}),                 // never resolves — a stalled stream
      cancel: () => { cancelled = true; return Promise.resolve(); }
    };
    const guarded = timeouts.idleGuardedReader(stallReader, { idleMs: 30 });
    let err = null;
    try { await guarded.read(); } catch (e) { err = e; }
    A.ok(err && /timed out/i.test(err.message), 'a stalled read throws a "timed out" error');
    A.ok(cancelled, 'the underlying reader is cancelled on idle timeout');
    // and that error classifies as `timeout` (retryable, no credential rotation) — the whole point.
    const cls = classifyApiError(err, {});
    A.eq(cls.reason, 'timeout', 'the idle-timeout error classifies as timeout');
    A.eq(cls.retryable, true, 'a timeout is retryable');
  }
  // 1a. A response that never emits its first byte uses the shorter admission watchdog, not the long idle window.
  {
    let cancelled = false;
    const guarded = timeouts.idleGuardedReader({
      read: () => new Promise(() => {}),
      cancel: () => { cancelled = true; return Promise.resolve(); }
    }, { firstByteMs: 25, idleMs: 10000 });
    let err = null;
    try { await guarded.read(); } catch (e) { err = e; }
    A.ok(err && err.firstByte === true, 'a silent first read is marked as a first-byte timeout');
    A.eq(err && err.phase, 'first-byte', 'the timeout phase identifies stream admission');
    A.ok(cancelled, 'the first-byte watchdog cancels the stalled reader');
  }

  // 1b. THE 2026-07-08 ESCAPE (EL-11): a WHATWG-faithful reader — cancel() settles the pending read() as
  //     {done:true} synchronously, exactly like a real ReadableStream reader — must STILL surface the idle
  //     timeout as an ERROR. The old cancel-before-reject order let Promise.race adopt the clean end-of-stream,
  //     so a hung provider stream ended as a successful run (runs.jsonl reason:'done', tokens:0) and night-shift
  //     beats burned leash reporting success. (Test 1's mock never resolved on cancel, so it couldn't catch this.)
  function whatwgStallReader() {
    let pendingResolve = null;
    const r = {
      cancelled: false,
      read: () => new Promise(res => { pendingResolve = res; }),   // stalls until cancel() settles it
      cancel: () => { r.cancelled = true; if (pendingResolve) pendingResolve({ done: true, value: undefined }); return Promise.resolve(); }
    };
    return r;
  }
  {
    const r = whatwgStallReader();
    const guarded = timeouts.idleGuardedReader(r, { idleMs: 25 });
    let err = null, out = null;
    try { out = await guarded.read(); } catch (e) { err = e; }
    A.ok(err, 'a stalled read whose cancel resolves {done:true} still ERRORS — never a clean end-of-stream (got ' + JSON.stringify(out) + ')');
    A.ok(err && /timed out/i.test(err.message), 'the surfaced error is the idle timeout');
    A.eq(classifyApiError(err, {}).reason, 'timeout', 'and it classifies as timeout (retryable)');
    A.ok(r.cancelled, 'the underlying reader was still cancelled');
  }
  // 1c. same WHATWG-faithful reader under a USER-CANCEL: AbortError, never a clean {done:true} end.
  {
    const ac = new AbortController();
    const r = whatwgStallReader();
    const guarded = timeouts.idleGuardedReader(r, { idleMs: 10000, signal: ac.signal });
    const p = guarded.read();
    ac.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a user-cancel on a WHATWG-faithful reader surfaces as an AbortError, not a clean end');
    A.ok(r.cancelled, 'the reader is cancelled on user-cancel');
  }

  // 2. user-cancel through the guarded reader classifies as ABORT, never timeout (the CRITICAL invariant).
  {
    const ac = new AbortController();
    let cancelled = false;
    const stallReader = { read: () => new Promise(() => {}), cancel: () => { cancelled = true; return Promise.resolve(); } };
    const guarded = timeouts.idleGuardedReader(stallReader, { idleMs: 10000, signal: ac.signal });
    const p = guarded.read();
    ac.abort();
    let err = null;
    try { await p; } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a user-cancel surfaces as an AbortError (name)');
    A.ok(!/timed out/i.test(err.message), 'a user-cancel is NOT reported as a timeout');
    A.ok(cancelled, 'the reader is cancelled on user-cancel too');
  }

  // 2b. a signal already aborted before the first read -> immediate AbortError (never a timeout, no wait).
  {
    const guarded = timeouts.idleGuardedReader({ read: () => new Promise(() => {}), cancel: () => Promise.resolve() }, { idleMs: 5, signal: { aborted: true } });
    let err = null;
    try { await guarded.read(); } catch (e) { err = e; }
    A.ok(err && err.name === 'AbortError', 'a pre-aborted signal short-circuits to AbortError');
  }

  // 3. connectSignal: composes the caller signal with a connect-timeout; a caller-abort still propagates.
  {
    const ac = new AbortController();
    const merged = timeouts.connectSignal(ac.signal, 60000);
    A.ok(merged && typeof merged.aborted === 'boolean', 'connectSignal returns an AbortSignal');
    A.eq(merged.aborted, false, 'not aborted before either input fires');
    ac.abort();
    A.eq(merged.aborted, true, 'a caller-abort aborts the merged signal');
  }

  // 3a. connectGuard unit behavior — the DISARMABLE connect ceiling. The reason objects it aborts with are
  //     exactly what undici surfaces as the fetch rejection (verified on Node v22: fetch rejects with the
  //     abort REASON object).
  {
    // connect expiry: the timer fires -> signal aborts with a `timeout`-classified reason (not an AbortError).
    const g = timeouts.connectGuard(null, 15);
    await new Promise(r => setTimeout(r, 40));
    A.eq(g.signal.aborted, true, 'connectGuard signal aborts once the connect window elapses');
    const reason = g.signal.reason;
    A.ok(reason && /timed out/i.test(reason.message), 'the connect-expiry reason message contains "timed out"');
    A.ok(reason && reason.name !== 'AbortError', 'a connect expiry is NOT an AbortError (so it retries like a transient error)');
    A.eq(classifyApiError(reason, {}).reason, 'timeout', 'the connect-expiry reason classifies as timeout');
  }
  {
    // disarm() stops the timer: after disarm the signal must never abort on its own, even long past the window.
    const g = timeouts.connectGuard(null, 15);
    g.disarm();
    await new Promise(r => setTimeout(r, 40));
    A.eq(g.signal.aborted, false, 'a disarmed connectGuard never aborts (the streaming body is safe)');
  }
  {
    // user-cancel wins over the connect timer and surfaces as a NAMED AbortError.
    const ac = new AbortController();
    const g = timeouts.connectGuard(ac.signal, 10000);
    ac.abort();
    A.eq(g.signal.aborted, true, 'a caller-abort aborts the guard signal');
    A.eq(g.signal.reason && g.signal.reason.name, 'AbortError', 'a caller-abort surfaces as an AbortError reason, never a timeout');
  }
  {
    // a pre-aborted caller signal aborts the guard immediately as an AbortError.
    const g = timeouts.connectGuard({ aborted: true }, 10000);
    A.eq(g.signal.aborted, true, 'a pre-aborted caller signal aborts the guard at once');
    A.eq(g.signal.reason && g.signal.reason.name, 'AbortError', 'pre-aborted -> AbortError, not timeout');
  }

  // 4. Retry-After honored: a 429 with Retry-After: 2 makes requestWithRetry wait ~2s (capped at 60s). We
  //    prove the MATH by classifying the same error and checking the delay formula, and prove it is WIRED by
  //    timing a retry against a short Retry-After. Use a small value so the test stays fast.
  {
    // math: delay = min(60000, max(RETRY_DELAYS[attempt]=400, retryAfterMs)). With Retry-After 2s -> 2000.
    const err = new Error('http 429'); err.status = 429; err.headers = new Headers({ 'retry-after': '2' });
    const cls = classifyApiError(err, {});
    A.eq(cls.reason, 'rate_limit', '429 classifies as rate_limit');
    A.eq(cls.retryAfterMs, 2000, 'Retry-After: 2 -> 2000ms parsed off the response headers');
    const delay = Math.min(60000, Math.max(400, cls.retryAfterMs || 0));
    A.eq(delay, 2000, 'delay math takes the server-stated wait over the base backoff');
    // cap: a huge Retry-After clamps to 60s.
    const err2 = new Error('http 429'); err2.status = 429; err2.headers = new Headers({ 'retry-after': '9999' });
    const cls2 = classifyApiError(err2, {});
    A.eq(Math.min(60000, Math.max(400, cls2.retryAfterMs || 0)), 60000, 'an oversized Retry-After clamps to 60s');
  }

  // 4b. WIRED: requestWithRetry actually waits the Retry-After before the retry. A 429 (Retry-After 0.05s)
  //     then a 200 stream — assert both calls happened and >=~40ms elapsed (the honored wait).
  {
    let n = 0, firstAt = 0, retryAt = 0;
    const fetchImpl = async (url) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      n++;
      if (n === 1) { firstAt = Date.now(); return new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '0.05' } }); }
      retryAt = Date.now();
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [] });
    A.eq(n, 2, 'a 429 with Retry-After retries exactly once');
    A.ok((retryAt - firstAt) >= 40, 'the retry waited approximately the Retry-After window (>=40ms)');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'after honoring Retry-After it streams normally');
  }

  // 5. catalog re-warm: a cold catalog kicks a background /models GET on stream() (at most once per instance).
  {
    let modelsCalls = 0;
    const fetchImpl = async (url) => {
      if (/\/models/.test(url)) { modelsCalls++; return new Response('{"data":[{"id":"m","context_length":123,"pricing":{"prompt":"0.000001","completion":"0.000002"}}]}', { status: 200 }); }
      return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    await collect(p, { model: 'm', messages: [] });      // first run kicks the re-warm
    await new Promise(r => setTimeout(r, 5));             // let the fire-and-forget /models settle
    A.ok(modelsCalls >= 1, 'a cold-catalog stream() kicks a background /models re-warm');
    const before = modelsCalls;
    await collect(p, { model: 'm', messages: [] });       // now warm -> no further re-warm from this instance
    await new Promise(r => setTimeout(r, 5));
    A.eq(modelsCalls, before, 'once warm, no further re-warm is kicked');
    A.eq(p.contextLimit('m'), 123, 'the re-warmed catalog now answers contextLimit');
  }

  // 6. env-tunable idle timeout is read from SKYNET_PROVIDER_IDLE_MS (default 300s — generous, since after the
  //    connect guard disarms this is the streaming body's only ceiling and deep-reasoning turns go byte-silent).
  {
    const saved = process.env.SKYNET_PROVIDER_IDLE_MS;
    process.env.SKYNET_PROVIDER_FIRST_BYTE_MS = '25';
    A.eq(timeouts.firstByteMs(), 25, 'first-byte timeout honors SKYNET_PROVIDER_FIRST_BYTE_MS');
    delete process.env.SKYNET_PROVIDER_FIRST_BYTE_MS;
    process.env.SKYNET_PROVIDER_IDLE_MS = '25';
    A.eq(timeouts.idleMs(), 25, 'idle timeout honors SKYNET_PROVIDER_IDLE_MS');
    delete process.env.SKYNET_PROVIDER_IDLE_MS;
    A.eq(timeouts.idleMs(), 300000, 'idle timeout defaults to 300s when unset');
    if (saved != null) process.env.SKYNET_PROVIDER_IDLE_MS = saved;
  }

  // ---- connect-guard end-to-end through a real adapter (makeOpenRouterProvider) ----
  // A fetch stand-in that honors the AbortSignal the way undici does: if the signal aborts before it decides to
  // respond, it rejects with the signal's REASON object (verified live on Node v22). Streams a body via a real
  // ReadableStream so res.body.getReader() drives the idle-guarded reader path.
  function sseResponse(chunks, perChunkMs) {
    let i = 0;
    const stream = new ReadableStream({
      pull(controller) {
        return new Promise(resolve => {
          setTimeout(() => {
            // a test that cancels mid-body (9b) leaves this timer dangling; enqueue/close on a cancelled stream
            // throws (uncaught, inside a timer) — swallow it, the cancel already ended the stream on purpose.
            try {
              if (i < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[i++]));
              else controller.close();
            } catch (_) {}
            resolve();
          }, perChunkMs);
        });
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }
  function abortWhenSignalled(signal) {
    // never resolves on its own; rejects with the abort reason if/when the signal fires (undici semantics).
    return new Promise((_res, rej) => {
      if (signal && signal.aborted) return rej(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => rej(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }
    });
  }

  // 7. REGRESSION (the bug): headers arrive fast, then the body streams for LONGER than the connect window.
  //    With a tiny connect ms the OLD code aborted the body mid-stream; the disarmable guard must let it finish.
  {
    const savedC = process.env.SKYNET_PROVIDER_CONNECT_MS;
    process.env.SKYNET_PROVIDER_CONNECT_MS = '30';   // connect ceiling far SHORTER than the total stream time
    const chunks = [
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }) + '\n',
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n',
      'data: [DONE]\n'
    ];
    const fetchImpl = async (url, opts) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      // headers resolve immediately; each body chunk arrives ~50ms apart -> whole body > the 30ms connect window.
      return sseResponse(chunks, 50);
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    let err = null, text = '';
    try {
      for await (const e of p.stream({ model: 'm', messages: [] })) if (e.type === 'text') text += e.delta;
    } catch (e) { err = e; }
    A.ok(!err, 'a body that streams longer than the connect window completes WITHOUT a timeout error');
    A.eq(text, 'hello', 'the full streamed body is delivered after the connect guard is disarmed');
    if (savedC != null) process.env.SKYNET_PROVIDER_CONNECT_MS = savedC; else delete process.env.SKYNET_PROVIDER_CONNECT_MS;
  }

  // 8. CONNECT EXPIRY: a fetch that never returns headers -> the guard fires -> after retries the stream() rejects
  //    with a `timeout`-classified error (message contains "timed out"), NOT an AbortError.
  {
    const savedC = process.env.SKYNET_PROVIDER_CONNECT_MS;
    process.env.SKYNET_PROVIDER_CONNECT_MS = '15';
    let attempts = 0;
    const fetchImpl = async (url, opts) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      attempts++;
      return abortWhenSignalled(opts && opts.signal);   // headers never arrive; only the guard can end this
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    let err = null;
    try { for await (const _ of p.stream({ model: 'm', messages: [] })) {} } catch (e) { err = e; }
    A.ok(err, 'a never-connecting fetch eventually rejects');
    A.ok(err && /timed out/i.test(err.message), 'the connect-expiry error message contains "timed out"');
    A.ok(err && err.name !== 'AbortError', 'a connect expiry is NOT surfaced as a cancel/AbortError');
    A.eq(classifyApiError(err, {}).reason, 'timeout', 'the connect-expiry error classifies as timeout (retryable)');
    A.ok(attempts >= 2, 'a connect timeout retried like a transient network error (>=2 attempts)');
    if (savedC != null) process.env.SKYNET_PROVIDER_CONNECT_MS = savedC; else delete process.env.SKYNET_PROVIDER_CONNECT_MS;
  }

  // 9. USER CANCEL never classifies as timeout — pre-headers AND mid-body both surface as a clean cancel.
  {
    // 9a. cancel BEFORE headers arrive -> stream() ends cleanly (isAbort -> return), no timeout, no throw.
    {
      const ac = new AbortController();
      const fetchImpl = async (url, opts) => {
        if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
        setTimeout(() => ac.abort(), 10);               // user cancels while the POST is still in flight
        return abortWhenSignalled(opts && opts.signal);
      };
      const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
      let err = null; const out = [];
      try { for await (const e of p.stream({ model: 'm', messages: [], signal: ac.signal })) out.push(e); } catch (e) { err = e; }
      A.ok(!err, 'a pre-headers user-cancel ends the stream cleanly (no throw)');
      A.eq(out.length, 0, 'nothing is emitted after a pre-headers cancel');
    }
    // 9b. cancel MID-BODY -> the idle-guarded reader sees the caller signal and ends cleanly, never as a timeout.
    {
      const ac = new AbortController();
      const chunks = [
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'part' } }] }) + '\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ial' } }] }) + '\n',
        'data: [DONE]\n'
      ];
      const fetchImpl = async (url) => {
        if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
        return sseResponse(chunks, 40);                 // slow body so we can cancel mid-stream
      };
      const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
      let err = null; let text = '';
      setTimeout(() => ac.abort(), 60);                  // fire after the first chunk, before [DONE]
      try { for await (const e of p.stream({ model: 'm', messages: [], signal: ac.signal })) if (e.type === 'text') text += e.delta; } catch (e) { err = e; }
      A.ok(!err || err.name === 'AbortError', 'a mid-body user-cancel is a clean cancel, never a timeout error');
      A.ok(!/timed out/i.test((err && err.message) || ''), 'a mid-body cancel is NOT reported as a timeout');
    }
  }

  // 10. THE HUNG-STREAM RUN-TRUTH ESCAPE, end-to-end through a real adapter + a REAL ReadableStream: the
  //     provider accepts, streams ONE token, then goes byte-silent forever. The adapter stream MUST end in a
  //     `timeout`-classified error — never as a clean end-of-stream (which is what let loop.js record a
  //     successful turn and the run row read COMPLETE while the provider was wedged).
  {
    const savedI = process.env.SKYNET_PROVIDER_IDLE_MS;
    process.env.SKYNET_PROVIDER_IDLE_MS = '40';
    const fetchImpl = async (url) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      let sent = false;
      const stream = new ReadableStream({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: 'one' } }] }) + '\n')); return; }
          return new Promise(() => {});   // wedged provider: no bytes, no close, forever
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: fetchImpl, key: 'k' });
    let err = null; const seen = [];
    try { for await (const e of p.stream({ model: 'm', messages: [] })) seen.push(e.type); } catch (e) { err = e; }
    A.ok(seen.indexOf('text') >= 0, 'the one real token was delivered before the hang');
    A.ok(err, 'a hung stream ERRORS out of the adapter — it must NOT end as a clean (done-looking) stream');
    A.ok(err && /timed out/i.test(err.message), 'the error is the idle timeout ("timed out")');
    A.eq(classifyApiError(err, {}).reason, 'timeout', 'it classifies as timeout — retryable, honest agent.run.error, never a silent reason:done');
    if (savedI != null) process.env.SKYNET_PROVIDER_IDLE_MS = savedI; else delete process.env.SKYNET_PROVIDER_IDLE_MS;
  }

  A.report('provider.timeouts.test');
})();
