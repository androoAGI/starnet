/* node test/safe-egress.real-socket.test.js — the outbound boundary's pinned dial against REAL undici and REAL net
   sockets, on Node 22 (doneMeans 2 of the safe-egress lane: "a real-socket test on Node 22 connects").

   Every other test of the pin fakes the dispatcher, so nothing drove the module's connect lookup through Node's own
   connect. That is where gh#82 lived (the pin answered Node's { all: true } with a single address and every request died
   as "fetch failed"), and where connector OAuth's pin held only the FIRST validated address, so a dead first address (a
   broken IPv6) failed sign-in that web_fetch completed.

   THE ONLY FAKE is at the socket edge, as in test/web.pinned-dispatcher.test.js: DNS "validates" two public test
   addresses [IPv6, IPv4]; the agent the module builds is kept whole, and its lookup's answer is swapped to
   [::1 (closed), 127.0.0.1 (listening)] just before the socket dials. Every option the module passes reaches undici
   untouched. Host names are reserved (.example), so a connect that asked the OS resolver would fail, and dns.lookup is
   trapped to prove it is never asked.

   MODULE rows (this file today): pinnedDispatcher through npm undici.fetch and through globalThis.fetch (Node's bundled
   fetch with the module's npm-undici Agent); a single address; [dead IPv6, live IPv4] connects, and a pin holding only
   the first address does not (the control); TLS SNI and Host keep the requested name; options.family is honoured by a
   raw net.connect; withPinned closes its Agent; a session's host keeps one keep-alive connection across requests. The
   consumer rows (web_request, connector OAuth, the skill fetch, the browser proxy's CONNECT) join as each consumer moves
   onto the module. Run it under the installed StarNet node too (C:/Users/andro/AppData/Local/StarNet/node.exe). */
'use strict';
const A = require('./_assert.js');
const S = require('../sidecar/net/safe-egress.js');
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns');
const undici = require('undici');

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';
const EDGE = { [PUBLIC_V4]: '127.0.0.1', [PUBLIC_V6]: '::1' };
const BOTH = [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }];

/* The agent the module builds, with ONE change at the socket edge: the pin's answer is swapped for the loopback pair.
   firstOnly keeps only the first address of an all:true answer: the pin connector OAuth had before the module. */
function edgeAgent(rec, firstOnly) {
  return opts => {
    rec.options.push(opts);
    const agent = new undici.Agent(Object.assign({}, opts, { connect: Object.assign({}, opts.connect, { lookup(h, o, cb) {
      rec.asked.push(h);
      opts.connect.lookup(h, o, (err, a, f) => {
        if (err) return cb(err);
        if (!Array.isArray(a)) { rec.lists.push([a]); return cb(null, EDGE[a] || a, f); }
        rec.lists.push(a.map(x => x.address));
        const list = a.map(x => ({ address: EDGE[x.address] || x.address, family: x.family }));
        cb(null, firstOnly ? list.slice(0, 1) : list);
      });
    } }) }));
    rec.agents.push(agent);
    return agent;
  };
}
const recorder = () => ({ options: [], asked: [], lists: [], agents: [] });
const lookupOf = list => async () => list.map(a => Object.assign({}, a));
const causeOf = e => (e && e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code))) || (e && e.code) || String(e && e.message);

/* The server_name a TLS ClientHello carries: the name, '' when the hello has none, null when truncated or malformed. */
function sniOf(buf) {
  if (!buf || buf.length < 5 || buf[0] !== 0x16) return null;
  const end = 5 + buf.readUInt16BE(3);
  if (buf.length < end || end < 5 + 4 || buf[5] !== 0x01) return null;
  let p = 5 + 4 + 2 + 32;
  const need = n => p + n <= end;
  if (!need(1)) return null; p += 1 + buf[p];
  if (!need(2)) return null; p += 2 + buf.readUInt16BE(p);
  if (!need(1)) return null; p += 1 + buf[p];
  if (p === end) return '';
  if (!need(2)) return null;
  const extEnd = p + 2 + buf.readUInt16BE(p); p += 2;
  if (extEnd > end) return null;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p), len = buf.readUInt16BE(p + 2); p += 4;
    if (p + len > extEnd) return null;
    if (type === 0x0000) {
      if (len < 5 || buf[p + 2] !== 0) return null;
      const nameLen = buf.readUInt16BE(p + 3);
      if (p + 5 + nameLen > p + len) return null;
      return buf.toString('latin1', p + 5, p + 5 + nameLen);
    }
    p += len;
  }
  return '';
}

/* Listen on 127.0.0.1 at a port whose [::1] twin is closed: that is the dead first address. Binding [::1] at the same
   port proves nobody listens there (then it is released); EADDRNOTAVAIL means this computer has no IPv6 loopback, which
   is just as dead. */
async function listenWithDeadV6(server) {
  for (let i = 0; i < 5; i++) {
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => { server.off('error', rej); res(); }); });
    const port = server.address().port;
    const twin = await new Promise(res => {
      const probe = net.createServer();
      probe.once('error', e => res(e.code));
      probe.listen(port, '::1', () => probe.close(() => res('free')));
    });
    if (twin === 'free' || twin === 'EADDRNOTAVAIL') return port;
    await new Promise(res => server.close(() => res()));
  }
  throw new Error('no port with a closed [::1] twin');
}

(async () => {
  const major = Number(String(process.versions.node).split('.')[0]);
  console.log('safe-egress.real-socket: node ' + process.version + ', npm undici ' + require('undici/package.json').version);
  A.ok(major >= 22, 'runs on Node 22 or later (the gate and the bundled runtime): ' + process.version);

  // the connect-time resolver is trapped; a positive control proves the trap sees net's default lookup
  const trap = { lookup: 0, promises: 0 };
  const realLookup = dns.lookup, realPromisesLookup = dns.promises.lookup;
  dns.lookup = function () { trap.lookup++; return realLookup.apply(this, arguments); };
  dns.promises.lookup = function () { trap.promises++; return realPromisesLookup.apply(this, arguments); };

  // every request the server answered, with the socket that carried it (recorded before the response is written)
  const served = [];
  const srv = http.createServer((req, res) => {
    served.push({ host: req.headers.host, socket: req.socket, remote: req.socket.remoteAddress });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('pinned ok ' + req.headers.host);
  });
  const port = await listenWithDeadV6(srv);
  const seen = [];
  const tlsSrv = net.createServer(s => {
    let b = Buffer.alloc(0);
    s.on('data', d => { b = Buffer.concat([b, d]); if (b.length >= 5 && b.length >= 5 + b.readUInt16BE(3)) { seen.push(sniOf(b)); s.destroy(); } });
    s.on('error', () => { /* the client resets a hung-up handshake; nothing to record */ });
  });
  const tport = await listenWithDeadV6(tlsSrv);

  try {
    {
      const before = trap.lookup;
      await new Promise((res, rej) => { const s = net.connect({ host: 'localhost', port }, () => { s.destroy(); res(); }); s.on('error', rej); });
      A.ok(trap.lookup > before, 'control: the trap sees a connect that resolves through the OS (' + (trap.lookup - before) + ' lookups)');
      trap.lookup = 0; trap.promises = 0;
    }
    const fetchers = [['npm undici.fetch', (url, init) => undici.fetch(url, init)], ['globalThis.fetch', (url, init) => globalThis.fetch(url, init)]];

    // ---- R1. a single validated address ----
    for (const [label, fetchImpl] of fetchers) {
      const host = 'one.pinned.example';
      const dest = await S.resolveValidated('http://' + host + ':' + port + '/ping', { policy: 'web', lookup: lookupOf([{ address: PUBLIC_V4, family: 4 }]) });
      const rec = recorder();
      const out = await S.withPinned(dest, { agentFactory: edgeAgent(rec) }, async d => {
        const r = await fetchImpl(dest.href, { dispatcher: d });
        return [r.status, await r.text()];
      }).catch(e => ['failed', causeOf(e)]);
      A.eq(out, [200, 'pinned ok ' + host + ':' + port], label + ': a single pinned address connects, and Host keeps the requested name');
      A.eq(rec.lists, [[PUBLIC_V4]], label + ': the socket was handed only the validated address');
      A.eq(rec.asked, [host], label + ': the pinned lookup was asked for the requested name');
      A.ok(!('autoSelectFamily' in rec.options[0].connect), label + ': one address needs no explicit family walk');
      A.ok(rec.agents[0].closed === true, label + ': withPinned closed its Agent once the body was read');
    }

    // ---- R2. [dead IPv6 first, live IPv4 second] connects; a pin holding only the first does not ----
    for (const [label, fetchImpl] of fetchers) {
      const host = 'two.pinned.example';
      const dest = await S.resolveValidated('http://' + host + ':' + port + '/ping', { policy: 'web', lookup: lookupOf(BOTH) });
      const rec = recorder();
      const before = served.length;
      const out = await S.withPinned(dest, { agentFactory: edgeAgent(rec) }, async d => {
        const r = await fetchImpl(dest.href, { dispatcher: d });
        return [r.status, await r.text()];
      }).catch(e => ['failed', causeOf(e)]);
      A.eq(out, [200, 'pinned ok ' + host + ':' + port], label + ': a dead first address falls back to the live second one');
      A.eq(rec.lists, [[PUBLIC_V6, PUBLIC_V4]], label + ': Node asked { all: true } and got every validated address, in order');
      A.ok(rec.options[0].connect.autoSelectFamily === true, label + ': autoSelectFamily is on for two addresses');
      A.eq(served.slice(before).map(s => s.remote), ['127.0.0.1'], label + ': the one request landed on the live address');

      const ctl = recorder();
      const ctlBefore = served.length;
      const failed = await S.withPinned(dest, { agentFactory: edgeAgent(ctl, true) }, async d => {
        const r = await fetchImpl(dest.href, { dispatcher: d });
        return [r.status, await r.text()];
      }).catch(e => ['failed', causeOf(e)]);
      A.eq(failed[0], 'failed', label + ' control: a pin that hands Node only the first address cannot connect (got ' + JSON.stringify(failed) + ')');
      A.ok(/ECONNREFUSED|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH/.test(String(failed[1])), label + ' control: it died dialing the dead address: ' + failed[1]);
      A.eq(served.length, ctlBefore, label + ' control: no request reached the server');
    }

    // ---- R3. TLS SNI keeps the requested name through the pin (never the pinned IP, never empty) ----
    for (const [label, fetchImpl] of fetchers) {
      const host = 'sni.pinned.example';
      const dest = await S.resolveValidated('https://' + host + ':' + tport + '/x', { policy: 'skillSource', lookup: lookupOf(BOTH) });
      const before = seen.length;
      const r = await S.withPinned(dest, { agentFactory: edgeAgent(recorder()) }, d => fetchImpl(dest.href, { dispatcher: d })).then(() => 'answered', e => causeOf(e));
      A.eq(seen.slice(before), [host], label + ': the ClientHello names ' + host + ' (not ' + PUBLIC_V4 + ', not empty)');
      A.ok(r !== 'answered', label + ': the hung-up handshake surfaces as a failure (' + r + ')');
    }

    // ---- R4. options.family is honoured by Node's own connect ----
    {
      const pin = S.pinnedLookup([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }], 'fam.pinned.example');
      // listeners first: the pinned lookup answers synchronously, so 'lookup' fires inside connect()
      const dial = opts => new Promise(res => {
        const s = new net.Socket();
        let first = null;
        s.on('lookup', (err, address) => { if (first === null) first = err ? 'error ' + err.code : address; });
        s.on('connect', () => { const at = s.remoteAddress; s.destroy(); res({ connected: at, first }); });
        s.on('error', e => res({ error: e.code || e.message, first }));
        s.connect(Object.assign({ host: 'fam.pinned.example', port, lookup: pin }, opts));
      });
      const v4 = await dial({ family: 4 });
      A.eq([v4.connected, v4.first], ['127.0.0.1', '127.0.0.1'], 'family 4: Node is handed the IPv4 address only, and connects');
      const v6 = await dial({ family: 6 });
      A.ok(v6.first === '::1' && !v6.connected, 'family 6: Node is handed the IPv6 address only (closed here, so no connection): ' + JSON.stringify(v6));
      const firstOnly = await dial({ autoSelectFamily: false });
      A.ok(firstOnly.first === '::1' && !firstOnly.connected, 'no family, no family walk: the first validated address only: ' + JSON.stringify(firstOnly));
      const walk = await dial({ autoSelectFamily: true });
      A.eq(walk.connected, '127.0.0.1', 'autoSelectFamily: Node walks the validated list past the dead address');
      const other = await new Promise(res => {
        const s = net.connect({ host: 'evil.pinned.example', port, lookup: pin });
        s.on('connect', () => { s.destroy(); res('connected'); });
        s.on('error', e => res(e.code));
      });
      A.eq(other, 'EGRESS_REFUSED', 'a pinned lookup refuses a name it did not validate, at the socket');
    }

    // ---- R5. a session keeps one validated answer and one keep-alive connection per host ----
    {
      let asked = 0;
      const rec = recorder();
      const sess = S.session({ policy: 'web', lookup: async () => { asked++; return [{ address: PUBLIC_V4, family: 4 }]; }, agentFactory: edgeAgent(rec) });
      const get = async path => {
        const dest = await sess.resolve('http://pkg.pinned.example:' + port + path);
        const r = await undici.fetch(dest.href, { dispatcher: sess.dispatcher(dest) });
        return r.status + ' ' + await r.text();
      };
      // a package fetch does a little work between files: each request finds the previous connection idle
      let before = served.length;
      const bodies = [];
      for (const path of ['/a', '/b', '/c']) { bodies.push(await get(path)); await new Promise(r => setImmediate(r)); }
      A.eq(bodies, [0, 1, 2].map(() => '200 pinned ok pkg.pinned.example:' + port), 'three requests through the session all land');
      A.eq([asked, rec.agents.length, new Set(served.slice(before).map(s => s.socket)).size], [1, 1, 1],
        'one DNS question, one Agent and ONE connection carried all three (no handshake per file)');
      // back to back, undici's pool may open a second connection while the first finishes, but never one per request
      before = served.length;
      for (const path of ['/d', '/e', '/f', '/g', '/h', '/i']) await get(path);
      const burst = new Set(served.slice(before).map(s => s.socket)).size;
      A.ok(burst <= 2 && asked === 1 && rec.agents.length === 1, 'six back-to-back requests reuse the session\'s connections (' + burst + ' sockets, still one DNS question)');
      await sess.close();
      A.ok(rec.agents[0].closed === true, 'the session closed its Agent at the end');
    }

    A.eq([trap.lookup, trap.promises], [0, 0], 'no connect above asked DNS: every socket dialed the validated answer');
  } finally {
    dns.lookup = realLookup; dns.promises.lookup = realPromisesLookup;
    await new Promise(res => srv.close(() => res()));
    await new Promise(res => tlsSrv.close(() => res()));
  }
  A.report('safe-egress.real-socket.test');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
