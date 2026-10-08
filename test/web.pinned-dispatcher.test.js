/* node test/web.pinned-dispatcher.test.js — web_request / web_fetch's DNS-pinned socket against REAL Node sockets.

   Every other web test passes lookup:null, which skips the pinned dispatcher entirely — so nothing ever drove
   fetchPinned's connect.lookup through real undici + net.connect. Node 20+ connects with autoSelectFamily on,
   which calls the lookup with { all: true } and expects an ARRAY of {address, family}. The pin answered with
   (address, family) regardless, Node read `undefined` as the address list, and EVERY pinned request died as
   "fetch failed" (cause: ERR_INVALID_IP_ADDRESS "Invalid IP address: undefined") — a user report on 0.12.5 and
   0.13.0: web_request to https://www.google.com/ failed while curl/fetch from the same machine got 200. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const net = require('node:net');
const undici = require('undici');
const { makeWebTools } = require('../sidecar/tools/builtin/web.js');

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const toLoop = a => (a === PUBLIC_V4 ? '127.0.0.1' : a);

/* The production Agent, with ONE change: the pin's answer is swapped for this loopback listener. EVERY option
   production passes (Agent-level and connect-level — a future servername/host/connectTimeout included) flows
   through untouched, so the test drives the same connector production builds, not a rebuilt one. */
function loopAgent(opts, onLookup) {
  return new undici.Agent(Object.assign({}, opts, { connect: Object.assign({}, opts.connect, { lookup(h, o, cb) {
    if (onLookup) onLookup();
    opts.connect.lookup(h, o, (err, a, f) => {
      if (err) return cb(err);
      if (Array.isArray(a)) cb(null, a.map(x => ({ address: toLoop(x.address), family: x.family })));
      else cb(null, toLoop(a), f);
    });
  } }) }));
}

/* The server_name a TLS ClientHello carries: the name string, '' when the hello has no SNI extension, null when
   the record is truncated or malformed. Bounds-checked at every length field so a short read never throws. */
function sniOf(buf) {
  if (!buf || buf.length < 5 || buf[0] !== 0x16) return null;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end || end < 5 + 4 || buf[5] !== 0x01) return null;
  let p = 5 + 4 + 2 + 32;                                  // handshake header, client_version, random
  const need = n => p + n <= end;
  if (!need(1)) return null; p += 1 + buf[p];             // session_id
  if (!need(2)) return null; p += 2 + buf.readUInt16BE(p); // cipher_suites
  if (!need(1)) return null; p += 1 + buf[p];             // compression_methods
  if (p === end) return '';                               // no extensions at all
  if (!need(2)) return null;
  const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;
  if (extEnd > end) return null;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
    if (p + len > extEnd) return null;
    if (type === 0x0000) {
      if (len < 5 || buf[p + 2] !== 0) return null;        // list length(2), name_type host_name(0)
      const nameLen = buf.readUInt16BE(p + 3);
      if (p + 5 + nameLen > p + len) return null;
      return buf.toString('latin1', p + 5, p + 5 + nameLen);
    }
    p += len;
  }
  return '';
}

(async () => {
  // 1) the pinned lookup answers BOTH callback shapes, and only with validated addresses
  let made = null;
  const shapes = makeWebTools({
    lookup: async () => [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }],
    agentFactory: opts => { made = opts; return { close: async () => {} }; },
    fetchImpl: async () => ({ status: 200, headers: new Map(), body: null, text: async () => 'x' })
  }).requestTool;
  try { await shapes.run({ url: 'https://api.shapes.example/x' }, {}); } catch (_) { /* the fake response is not the point */ }
  A.ok(made && made.connect && typeof made.connect.lookup === 'function', 'a pinned dispatcher was built for a named host');
  let single = null, all = null;
  made.connect.lookup('api.shapes.example', {}, (err, addr, fam) => { single = { err, addr, fam }; });
  made.connect.lookup('api.shapes.example', { all: true }, (err, list) => { all = { err, list }; });
  A.eq(single, { err: null, addr: PUBLIC_V6, fam: 6 }, 'single-address lookup returns the first validated address');
  A.eq(all, { err: null, list: [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }] },
    'all:true (Node autoSelectFamily) gets an ARRAY of every validated address, so a v6-less network still reaches v4');

  // 2) REAL undici + REAL net.connect: the request lands and returns 200. The agentFactory wraps the pin only
  //    to swap the public test address for this loopback listener — it passes the pin's callback SHAPE through
  //    untouched, which is exactly what Node validates.
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned ok ' + req.headers.host); });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  let lookupCalls = 0;
  const real = makeWebTools({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    agentFactory: opts => loopAgent(opts, () => { lookupCalls++; })
  });
  let out = null, failure = null;
  try { out = await real.requestTool.run({ url: 'http://api.pinned.example:' + port + '/ping' }, {}); }
  catch (e) { failure = (e && e.message) + (e && e.cause ? ' (cause: ' + (e.cause.code || '') + ' ' + e.cause.message + ')' : ''); }
  srv.close();
  A.eq(failure, null, 'a pinned web_request over real sockets does not fail');
  A.ok(out && /200$/.test(out.summary), 'web_request reports HTTP 200 (got ' + (out && out.summary) + ')');
  A.ok(out && /pinned ok api\.pinned\.example:/.test(String(out.content)), 'the body arrived and the Host header kept the requested name');
  A.ok(lookupCalls >= 1, 'the connection went through the pinned lookup');

  // 3) a transport failure names its cause (code + host), not undici's bare "fetch failed" — and never the URL,
  //    which can carry an auth.in:"query" key
  const failing = makeWebTools({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    agentFactory: () => ({ close: async () => {} }),
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED ' + PUBLIC_V4 + ':443 https://api.down.example/?k=SECRET'), { code: 'ECONNREFUSED', address: PUBLIC_V4 }) }); }
  }).requestTool;
  let msg = '';
  try { await failing.run({ url: 'https://api.down.example/x' }, {}); } catch (e) { msg = e.message; }
  A.eq(msg, 'fetch failed (ECONNREFUSED ' + PUBLIC_V4 + ')', 'the error names the transport cause');

  // 3b) a TLS-alert cause carries NO host/address (the 2026-10-07 macOS report: "fetch failed
  //     (ERR_SSL_TLSV1_ALERT_DECODE_ERROR)" — which service?). The requested hostname fills in; never the URL.
  const tlsAlert = makeWebTools({
    lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
    agentFactory: () => ({ close: async () => {} }),
    fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('C0:error:0A000432:SSL routines:ssl3_read_bytes:tlsv1 alert decode error:../deps/openssl/openssl/ssl/record/rec_layer_s3.c:1605:SSL alert number 50'), { code: 'ERR_SSL_TLSV1_ALERT_DECODE_ERROR' }) }); }
  }).requestTool;
  let tmsg = '';
  try { await tlsAlert.run({ url: 'https://api.down.example/x?k=SECRET' }, {}); } catch (e) { tmsg = e.message; }
  A.eq(tmsg, 'fetch failed (ERR_SSL_TLSV1_ALERT_DECODE_ERROR api.down.example)', 'a host-less TLS cause names the requested hostname');
  A.ok(!/\?k=|SECRET|https?:\/\//.test(tmsg), 'and never the URL or its query key');

  // 4) TLS SNI keeps the REQUESTED HOSTNAME through the pin — never the pinned IP, never empty. The pin swaps
  //    only the address the socket dials; undici derives servername from the URL host (web.js passes none).
  //    A raw listener records the ClientHello's server_name and hangs up — no certificate needed.
  const seen = [];
  const tlsSrv = net.createServer(s => {
    let b = Buffer.alloc(0);
    s.on('data', d => {
      b = Buffer.concat([b, d]);
      if (b.length >= 5 && b.length >= 5 + b.readUInt16BE(3)) { seen.push(sniOf(b)); s.destroy(); }
    });
    s.on('error', () => { /* the client resets a hung-up handshake; nothing to record */ });
  });
  try {
    await new Promise(res => tlsSrv.listen(0, '127.0.0.1', res));
    const tport = tlsSrv.address().port;
    const sni = makeWebTools({
      lookup: async () => [{ address: PUBLIC_V4, family: 4 }],
      agentFactory: opts => loopAgent(opts)
    }).requestTool;
    let smsg = '';
    try { await sni.run({ url: 'https://sni.pinned.example:' + tport + '/x' }, {}); } catch (e) { smsg = String(e && e.message); }
    A.eq(seen[0], 'sni.pinned.example', 'the ClientHello SNI is the requested hostname (no port, not ' + PUBLIC_V4 + ', not empty)');
    A.ok(/^fetch failed/.test(smsg), 'the hung-up handshake surfaces as a transport failure (got ' + smsg + ')');
    A.ok(smsg.indexOf('https://') < 0, 'the transport error never carries the URL');
    // An IP-LITERAL URL is not pinned (resolvedSafeAddrs returns nothing for a literal, dispatcher null), so it
    // would really dial the public IP — the "no SNI for an IP" leg is undici's own getServerName, not ours to drive.
  } finally {
    await new Promise(res => tlsSrv.close(() => res()));
  }

  A.report('web.pinned-dispatcher.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
