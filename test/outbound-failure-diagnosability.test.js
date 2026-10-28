/* node test/outbound-failure-diagnosability.test.js

   WHY: a real 0.7.0 user's diagnostics report contained five entries reading exactly `fetch failed` and nothing
   else. That is undici's whole message for ANY failed outbound fetch — the actionable part (ENOTFOUND vs
   ECONNREFUSED vs a connect timeout, and WHICH host) lives on `err.cause`, and we were dropping it. With only
   "fetch failed" we could not tell DNS failure from a refused connection from proxy interception, so we could not
   tell the user what to fix. This locks the two seams that make the NEXT such report self-diagnosing:

     1. errorClass.annotateTransport — enrich a bare transport message with cause code + host, WITHOUT moving the
        classification verdict and WITHOUT burying a real provider sentence.
     2. diagnostics — report whether a proxy is configured, since Node's fetch ignores the proxy env vars
        entirely (measured on v22.23), which makes a proxied machine look like a broken app: the UI works
        (WebView2 honors the system proxy) while every provider call from the sidecar fails. */
'use strict';
const A = require('./_assert.js');
const { classifyApiError, transportDetail, annotateTransport } = require('../sidecar/providers/errorClass.js');
const { makeDiagnostics, proxyHostOnly } = require('../sidecar/diagnostics.js');

// Build the EXACT shape undici throws: a TypeError('fetch failed') whose `cause` carries the real detail.
function undiciError(causeMessage, extra) {
  const e = new TypeError('fetch failed');
  e.cause = Object.assign(new Error(causeMessage), extra || {});
  return e;
}

// ---- 1. the cause survives into the message the user can paste ----
{
  const dns = undiciError('getaddrinfo ENOTFOUND api.openai.com', { code: 'ENOTFOUND', hostname: 'api.openai.com' });
  A.eq(transportDetail(dns), 'ENOTFOUND api.openai.com', 'DNS failure yields code + host');
  const v = classifyApiError(dns, {});
  // the transport detail still LEADS; since quick win 15 (2026-10-27) the unreachable sentence follows it
  A.ok(v.message.indexOf('fetch failed (ENOTFOUND api.openai.com) — ') === 0, 'the emitted message names the code and the host');
  A.ok(/the name api.openai.com did not resolve/.test(v.message), 'and says what that means');
  A.ok(/ENOTFOUND/.test(v.message), 'the report can now distinguish DNS failure from a refused connection');

  const refused = undiciError('connect ECONNREFUSED 1.2.3.4:443', { code: 'ECONNREFUSED' });
  A.ok(/ECONNREFUSED/.test(classifyApiError(refused, {}).message), 'a refused connection is named');

  const timeout = undiciError('Connect Timeout Error', { code: 'UND_ERR_CONNECT_TIMEOUT' });
  A.ok(/UND_ERR_CONNECT_TIMEOUT/.test(classifyApiError(timeout, {}).message), 'an undici connect timeout is named');
}

// ---- 1b. TLS-alert and socket causes carry NO host: the adapter-stamped requestHost names it (2026-10-07) ----
// A macOS customer's report read "fetch failed (ERR_SSL_TLSV1_ALERT_DECODE_ERROR)" — no way to tell which service.
{
  const OPENSSL = 'C0:error:0A000432:SSL routines:ssl3_read_bytes:tlsv1 alert decode error:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:1605:SSL alert number 50';
  const bare = undiciError(OPENSSL, { code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR' });
  A.eq(classifyApiError(bare, {}).message, 'fetch failed (ERR_SSL_TLSV1_ALERT_DECODE_ERROR)',
    'unstamped: the openssl path in the cause message is NOT mistaken for a host');
  const tls = undiciError(OPENSSL, { code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR' });
  tls.requestHost = 'api.example.com';
  const tv = classifyApiError(tls, {});
  A.eq(tv.message, 'fetch failed (ERR_SSL_TLSV1_ALERT_DECODE_ERROR api.example.com)', 'stamped: the TLS failure names its host');
  A.eq(tv.reason, classifyApiError(bare, {}).reason, 'the host never moves the verdict');

  const sock = new TypeError('terminated');
  sock.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  sock.requestHost = 'api.example.com';
  const sv = classifyApiError(sock, {});
  A.eq(sv.message, 'terminated (UND_ERR_SOCKET api.example.com)', 'a mid-stream socket drop names its host');
  A.eq(sv.reason, 'timeout', 'and keeps its transport verdict');

  const own = undiciError('getaddrinfo ENOTFOUND api.openai.com', { code: 'ENOTFOUND', hostname: 'api.openai.com' });
  own.requestHost = 'stamped.example.com';
  const ownMsg = classifyApiError(own, {}).message;
  A.ok(ownMsg.indexOf('fetch failed (ENOTFOUND api.openai.com) — ') === 0 && ownMsg.indexOf('stamped.example.com') < 0, 'a host the cause carries still wins');
}

// ---- 1c. the adapter seam: stampRequestHost keeps the HOSTNAME only (keys ride query strings / userinfo) ----
let readerStamp = Promise.resolve();   // the async leg below; report() waits for it
{
  const { runtime, timeouts } = require('../sidecar/providers/provider.js');
  const e = runtime.stampRequestHost(new TypeError('fetch failed'), 'https://user:pass@gen.example.com:8443/v1beta/models/x:stream?alt=sse&key=SECRET');
  A.eq(e.requestHost, 'gen.example.com', 'only the hostname is stamped — no port, path, query or userinfo');
  const ab = Object.assign(new Error('aborted'), { name: 'AbortError' });
  A.eq(runtime.stampRequestHost(ab, 'https://x.example.com/').requestHost, undefined, 'a cancel is never stamped');
  A.eq(runtime.stampRequestHost(new Error('x'), 'not a url').requestHost, undefined, 'an unparseable URL stamps nothing');
  A.eq(runtime.stampRequestHost('str', 'https://x.example.com/'), 'str', 'a non-object passes through');

  // a socket dropped MID-STREAM throws from the guarded reader, not the adapter's fetch catch — it is stamped there
  readerStamp = (async () => {
    const drop = new TypeError('terminated');
    drop.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const r = timeouts.idleGuardedReader({ read: async () => { throw drop; }, cancel: async () => {} }, { idleMs: 5000, url: 'https://api.example.com/v1' });
    let got = null;
    try { await r.read(); } catch (err) { got = err; }
    A.eq(got && got.requestHost, 'api.example.com', 'the mid-stream reader stamps the host it was opened on');
    A.eq(classifyApiError(got, {}).message, 'terminated (UND_ERR_SOCKET api.example.com)', 'so the run error names it');
  })().catch(err => A.ok(false, 'reader stamp threw: ' + (err && err.stack || err)));
}

// ---- 2. annotation must NEVER change the verdict, and never bury a real provider explanation ----
{
  /* `reason` is picked from the RAW message BEFORE annotation runs, so the appended text can never be
     re-classified. Proven with a trap: a hostname containing a word the reason ladder matches. If the annotated
     message were fed back through classification, 'unauthorized' would flip the verdict to `auth` — which would be
     a nasty bug, since `auth` is non-retryable and would send the user to the PROVIDERS key field over what is
     actually a DNS failure. It must stay the transport verdict.
     (NOTE for the next reader: a cause CODE legitimately DOES change the reason — errorClass.js maps
     ECONNREFUSED/ENOTFOUND/EAI_AGAIN to `unreachable` (quick win 15, 2026-10-27) and the other UND_ERR_* / socket codes
     to `timeout`. That is the code, not the text.) */
  const trap = undiciError('getaddrinfo ENOTFOUND unauthorized.example.com', { code: 'ENOTFOUND', hostname: 'unauthorized.example.com' });
  const tv = classifyApiError(trap, {});
  A.ok(/unauthorized\.example\.com/.test(tv.message), 'the trap host really did land in the message');
  A.eq(tv.reason, 'unreachable', 'the appended host text is NOT re-classified (it would read as `auth` if it were)');
  A.eq(tv.retryable, true, 'so the verdict stays retryable rather than becoming a dead-end auth door');

  // A provider that sent real words keeps them verbatim — plumbing must never displace an upstream explanation.
  const real = new Error('You exceeded your current quota');
  real.cause = { code: 'ECONNRESET' };
  A.eq(classifyApiError(real, {}).message, 'You exceeded your current quota',
    'a real provider sentence is left untouched');
  A.eq(annotateTransport('You exceeded your current quota', real), 'You exceeded your current quota',
    'annotateTransport only touches bare transport-shaped messages');

  // No cause -> nothing to add, and no cosmetic parentheses.
  A.eq(classifyApiError(new TypeError('fetch failed'), {}).message, 'fetch failed', 'no cause => message unchanged');
  A.eq(transportDetail(null), '', 'a null error yields no detail');
  A.eq(transportDetail(new Error('boom')), '', 'an error with no transport code yields no detail');

  // Never double-append a code the message already carries.
  const dup = new Error('fetch failed'); dup.cause = { code: 'ENOTFOUND' };
  const once = annotateTransport('fetch failed (ENOTFOUND)', dup);
  A.eq(once, 'fetch failed (ENOTFOUND)', 'an already-named code is not appended twice');
}

// ---- 3. a proxy URL must never carry credentials into a pasted bug report ----
{
  A.eq(proxyHostOnly('http://user:secretpass@proxy.corp.example:8080'), 'proxy.corp.example:8080',
    'basic-auth credentials are stripped from a proxy URL');
  // a password containing '@' is why the split must use the LAST '@', not the first.
  A.eq(proxyHostOnly('http://user:p@ssw0rd@proxy.corp.example:8080'), 'proxy.corp.example:8080',
    "a password containing '@' still strips correctly (last '@' wins)");
  A.ok(!/secretpass|ssw0rd/.test(proxyHostOnly('http://user:secretpass@proxy.corp.example:8080')),
    'no fragment of the password survives');
  A.eq(proxyHostOnly('https://proxy.corp:3128/pac.dat?x=1'), 'proxy.corp:3128', 'path and query are dropped');
  A.eq(proxyHostOnly('proxy.local:8080'), 'proxy.local:8080', 'a bare host:port passes through');
  A.eq(proxyHostOnly(''), '', 'empty input yields empty');
  A.eq(proxyHostOnly(null), '', 'null input yields empty');
}

// ---- 4. the report states the proxy situation honestly in all three cases ----
{
  const d = makeDiagnostics({ redact: x => x });
  const base = {
    version: { app: '0.7.0' }, platform: { os: 'win32', arch: 'x64', node: 'v22.12.0' },
    mode: 'desktop', provider: 'codex', model: 'gpt-5.6-sol', keyPresent: true,
    agentCount: 11, uptimeMs: 5000, workspacePresent: true, errors: []
  };
  const lineOf = (snap) => d.assemble(snap).text.split('\n').find(l => /^Proxy:/.test(l)) || '';

  const withProxy = lineOf(Object.assign({}, base, { proxy: { configured: true, vars: ['HTTPS_PROXY=proxy.corp.example:8080'] } }));
  A.ok(/proxy\.corp\.example:8080/.test(withProxy), 'a configured proxy is named in the report');
  A.ok(/NOT used by the engine/i.test(withProxy), 'the report says the engine does not route through it');

  A.ok(/none configured/.test(lineOf(Object.assign({}, base, { proxy: { configured: false, vars: [] } }))),
    'no proxy configured is stated explicitly');
  // A caller that forgets the field must degrade to the honest default, never to a claim that one IS configured.
  A.ok(/none configured/.test(lineOf(base)), 'a missing proxy field defaults to "none configured", never a fake one');

  // `routed` is a deliberate honest constant: nothing today can route the engine's fetch through a proxy.
  A.eq(d.assemble(Object.assign({}, base, { proxy: { configured: true, vars: ['HTTP_PROXY=x:1'] } })).report.proxy.routed, false,
    'routed is always false until real proxy routing exists');
}

// ---- 5. real registered web_fetch body failures retain code + dialled host ----
// A decoder/socket failure after HTTP headers is NOT a proven TLS failure or customer recovery.
const webBodyStamp = (async () => {
  const http = require('node:http');
  const undici = require('undici');
  const { makeRegistry } = require('../sidecar/tools/registry.js');
  const { makeWebTools } = require('../sidecar/tools/builtin/web.js');
  const publicAddress = '93.184.216.34';
  const lookup = async () => [{ address: publicAddress, family: 4 }];
  const call = url => ({ id: 'body-read', name: 'web_fetch', args: { url } });
  const safeMessage = out => !/SECRET|private-body|token=|https?:\/\/|decoder-private|:8443/.test(JSON.stringify(out));

  for (const [kind, redirect] of [['gzip', false], ['socket', false], ['gzip', true]]) {
    let requests = 0, headersSeen = 0, bodyReads = 0, closed = 0, browserCalls = 0, releaseBody;
    const agents = [], pinnedHosts = [];
    const server = http.createServer((req, res) => {
      requests++;
      if (req.url.startsWith('/redirect')) {
        res.writeHead(302, { location: 'http://final.body.example:' + server.address().port + '/private-body?token=SECRET' });
        res.end(); return;
      }
      res.writeHead(200, kind === 'gzip'
        ? { 'content-type': 'text/plain', 'content-encoding': 'gzip' }
        : { 'content-type': 'text/plain', 'content-length': '256' });
      if (kind === 'gzip') { res.end('not a gzip stream'); return; }
      // Destroy the socket only AFTER real Undici returned the headers.
      res.flushHeaders();
      releaseBody = () => res.destroy();
      res.write('partial');
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    try {
      const web = makeWebTools({ lookup,
        agentFactory: opts => {
          // Same public-DNS -> loopback socket seam as web.pinned-dispatcher.test.js.
          const agent = new undici.Agent({ ...opts, connect: { ...opts.connect, lookup(host, options, cb) {
            pinnedHosts.push(host);
            opts.connect.lookup(host, options, (err, address, family) => {
              if (err) return cb(err);
              if (Array.isArray(address)) cb(null, address.map(a => ({ ...a, address: '127.0.0.1' })));
              else cb(null, '127.0.0.1', family);
            });
          } } });
          const close = agent.close.bind(agent);
          agent.close = () => { closed++; return new Promise((resolve, reject) => close(err => err ? reject(err) : resolve())); };
          agents.push(agent); return agent;
        },
        fetchImpl: async (url, init) => {
          const response = await undici.fetch(url, init);
          if (response.status === 200) {
            headersSeen++;
            countBodyReads(response, () => { bodyReads++; });
            if (releaseBody) releaseBody();
          }
          return response;
        },
        reader: { available: () => ({ ok: true }), fetchText: async () => { browserCalls++; return { ok: false }; } }
      });
      const url = 'http://initial.body.example:' + server.address().port + (redirect ? '/redirect' : '/private-body?token=SECRET');
      const out = await web.register(makeRegistry()).dispatch(call(url));
      const code = kind === 'gzip' ? 'Z_DATA_ERROR' : 'UND_ERR_SOCKET';
      const host = redirect ? 'final.body.example' : 'initial.body.example';
      A.eq(out.content, 'tool web_fetch failed: terminated (' + code + ' ' + host + ')', kind + ': registered result retains body cause and final hop');
      A.eq(out.isError, true, kind + ': a body failure stays a tool error');
      A.eq([headersSeen, bodyReads], [1, 1], kind + ': failure occurred reading the body after successful headers');
      A.eq(requests, redirect ? 2 : 1, kind + ': no request retry or extra fallback');
      A.eq(closed, requests, kind + ': every pinned dispatcher closes');
      A.eq(browserCalls, 0, kind + ': body failure does not invoke the browser');
      A.ok(pinnedHosts.includes(host), kind + ': real socket used the public-host pin seam');
      A.ok(safeMessage(out) && !out.content.includes(':' + server.address().port), kind + ': diagnostic contains no URL path, query, port or body');
    } finally {
      await Promise.all(agents.map(a => a.destroy().catch(() => {})));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }

  /* A body READ is either Response.text() (the historic path) or a reader on response.body (the streaming
     raw-body ceiling, 2026-10-20). Count whichever the tool uses, once per read, so this pins "the body was
     read after the headers", not which API read it. */
  function countBodyReads(response, inc) {
    const text = response.text.bind(response);
    response.text = () => { inc(); return text(); };
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      const getReader = body.getReader.bind(body);
      body.getReader = (...a) => { inc(); return getReader(...a); };
    }
  }
  const bodyError = (message, code, name) => Object.assign(new TypeError(message), {
    ...(name ? { name } : {}),
    ...(code === null ? {} : { cause: Object.assign(new Error('decoder-private SECRET https://secret.invalid/path'), {
      code, hostname: 'https://secret.invalid/private-body?token=SECRET', address: 'SECRET:8443'
    }) })
  });
  const cases = [
    [bodyError('terminated', 'Z_DATA_ERROR'), 'terminated (Z_DATA_ERROR api.body.example)'],
    [bodyError('terminated', 'UND_ERR_SOCKET'), 'terminated (UND_ERR_SOCKET api.body.example)'],
    [bodyError('terminated', null), 'terminated'],
    [bodyError('terminated', 'Z_DATA_ERROR SECRET/path'), 'terminated'],
    [bodyError('terminated', 'Z_' + 'A'.repeat(80)), 'terminated'],
    [bodyError('body read failed', 'Z_DATA_ERROR'), 'body read failed'],
    [bodyError('terminated', 'Z_DATA_ERROR', 'AbortError'), 'terminated'],
    [bodyError('terminated (Z_DATA_ERROR api.body.example)', 'Z_DATA_ERROR'), 'terminated (Z_DATA_ERROR api.body.example)']
  ];
  for (const [error, message] of cases) {
    let requests = 0, reads = 0, closed = 0, browserCalls = 0;
    const web = makeWebTools({ lookup, agentFactory: () => ({ close: async () => { closed++; } }),
      fetchImpl: async () => {
        requests++;
        const response = new undici.Response(new ReadableStream({ start(c) { c.error(error); } }), { status: 200 });
        countBodyReads(response, () => { reads++; }); return response;
      }, reader: { available: () => ({ ok: true }), fetchText: async () => { browserCalls++; return { ok: false }; } }
    });
    const out = await web.register(makeRegistry()).dispatch(call('https://api.body.example:8443/private-body?token=SECRET'));
    A.eq(out.content, 'tool web_fetch failed: ' + message, 'body metadata guard: ' + message);
    A.eq([out.isError, requests, reads, closed, browserCalls], [true, 1, 1, 1, 0], 'diagnostic enrichment leaves dispatch and fallback unchanged');
    A.ok(safeMessage(out), 'raw cause fields never enter the registered result');
  }
  let cancelledFetches = 0;
  const stop = new AbortController(); stop.abort();
  const cancelled = await makeWebTools({ lookup: null, fetchImpl: async () => { cancelledFetches++; throw Error('must not run'); } })
    .register(makeRegistry()).dispatch(call('https://api.body.example/'), { signal: stop.signal });
  A.eq(cancelledFetches, 0, 'cancelled registered call makes no network request');
  A.ok(cancelled.isError && /cancelled/.test(cancelled.summary), 'cancelled run keeps its cancellation result');
})().catch(err => A.ok(false, 'registered web body diagnostic threw: ' + (err && err.stack || err)));

Promise.all([readerStamp, webBodyStamp]).then(() => A.report('outbound-failure-diagnosability.test'));
