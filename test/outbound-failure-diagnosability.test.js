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
  A.eq(v.message, 'fetch failed (ENOTFOUND api.openai.com)', 'the emitted message names the code and the host');
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
  A.eq(classifyApiError(own, {}).message, 'fetch failed (ENOTFOUND api.openai.com)', 'a host the cause carries still wins');
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
     (NOTE for the next reader: a cause CODE legitimately DOES change the reason — errorClass.js:168 maps
     ENOTFOUND/ECONNREFUSED/UND_ERR_* to `timeout`. That is pre-existing and correct; don't "fix" it.) */
  const trap = undiciError('getaddrinfo ENOTFOUND unauthorized.example.com', { code: 'ENOTFOUND', hostname: 'unauthorized.example.com' });
  const tv = classifyApiError(trap, {});
  A.ok(/unauthorized\.example\.com/.test(tv.message), 'the trap host really did land in the message');
  A.eq(tv.reason, 'timeout', 'the appended host text is NOT re-classified (it would read as `auth` if it were)');
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

readerStamp.then(() => A.report('outbound-failure-diagnosability.test'));
