'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { startPinnedProxy } = require('../sidecar/tools/builtin/browser-proxy.js');
const { _internals } = require('../sidecar/tools/builtin/browser.js');

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }
function request(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}
function connect(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority });
    req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  let hits = 0;
  const sentinel = http.createServer((req, res) => { hits++; res.end('LOCAL_SENTINEL'); });
  const port = await listen(sentinel);
  const proxy = await startPinnedProxy({ validate: _internals.assertSafeUrl,
    resolve: u => _internals.assertResolvedSafe(u, async () => [{ address: '127.0.0.1', family: 4 }]) });
  try {
    const url = 'http://127.0.0.1:' + port + '/proof';
    const blocked = await request(proxy.port, url);
    A.eq(blocked.status, 403, 'ordinary browser traffic cannot reach loopback through the proxy');
    A.eq(hits, 0, 'blocked request never reaches the local sentinel');
    A.eq(await connect(proxy.port, '127.0.0.1:' + port), 403, 'HTTPS CONNECT to loopback is refused');
    const rebound = await request(proxy.port, 'http://rebind.audit.test:' + port + '/proof');
    A.eq(rebound.status, 403, 'a public hostname resolving to loopback is refused');
    A.eq(hits, 0, 'neither DNS rebinding nor CONNECT reached the sentinel');
    proxy.allowLocal(url);
    const allowed = await request(proxy.port, url);
    A.eq(allowed.status, 200, 'explicit browser.test_navigate origin can reach its local server');
    A.eq(allowed.body, 'LOCAL_SENTINEL', 'local test request reaches only the authorized origin');
  } finally {
    await proxy.close();
    await new Promise(resolve => sentinel.close(resolve));
  }

  /* THE BROWSER CLOSES MID-CONNECT (measured 2026-09-30, gate): Chromium's socket resets while the proxy is still
     resolving DNS for its CONNECT. That reset had no listener yet and ended the whole sidecar with ECONNRESET. */
  {
    const crashes = [];
    const onCrash = e => crashes.push(e);
    process.on('uncaughtException', onCrash);
    let release; const resolving = new Promise(r => { release = r; });
    let asked = 0;
    const slow = await startPinnedProxy({ validate: _internals.assertSafeUrl,
      resolve: async () => { asked++; await resolving; return { address: '93.184.215.14', family: 4 }; } });
    try {
      for (const verb of ['CONNECT example.com:443', 'GET ws://example.com/socket']) {
        const sock = require('node:net').connect(slow.port, '127.0.0.1');
        await new Promise(r => sock.once('connect', r));
        sock.write(verb + ' HTTP/1.1\r\nHost: example.com\r\n' + (/^GET/.test(verb) ? 'Connection: Upgrade\r\nUpgrade: websocket\r\n' : '') + '\r\n');
        await new Promise(r => setTimeout(r, 150));
        sock.on('error', () => {});
        sock.resetAndDestroy();   // a TCP RST, as when the browser process is killed
      }
      await new Promise(r => setTimeout(r, 150));
      release();
      await new Promise(r => setTimeout(r, 300));
      A.ok(asked >= 1, 'the reset arrived while the proxy was still resolving the address');
      A.eq(crashes.map(e => e.code || e.message), [], 'a browser reset mid-CONNECT / mid-upgrade never crashes the sidecar');
      const after = await request(slow.port, 'http://127.0.0.1:1/');
      A.eq(after.status, 403, 'and the proxy keeps serving');
    } finally {
      process.removeListener('uncaughtException', onCrash);
      await slow.close();
    }
  }
  /* THE ETSY REPORTS (2026-10-08): a refused CONNECT reaches Chromium only as ERR_TUNNEL_CONNECTION_FAILED, so the
     proxy keeps the reason for the driver to name — and a dial that fails answers 502 instead of a bare reset. */
  {
    const t0 = 0;
    const filtered = await startPinnedProxy({ validate: _internals.assertSafeUrl,
      resolve: u => _internals.assertResolvedSafe(u, async () => [{ address: '0.0.0.0', family: 4 }]) });
    try {
      A.eq(await connect(filtered.port, 'www.etsy.com:443'), 403, 'a name the DNS answers 0.0.0.0 for is refused');
      const got = filtered.refusalsSince(t0);
      A.eq(got.length, 1, 'the refusal is kept');
      A.eq(got[0].host, 'www.etsy.com', 'under the host the browser asked for');
      A.ok(/resolves to private address 0\.0\.0\.0/.test(got[0].reason), 'with the real reason: ' + got[0].reason);
      A.eq(filtered.refusalsSince(filtered.refusalMark()), [], 'a later navigation never reads an older refusal');
      const why = _internals.explainRefusal(got[0]);
      A.eq(why.code, 'NETWORK_REFUSED', 'a private DNS answer is a refusal, not a dead proxy and not worth a retry');
      A.ok(/this computer's DNS answered 0\.0\.0\.0 for www\.etsy\.com/.test(why.text), 'the agent is told what answered: ' + why.text);
      A.ok(/no outside proxy, VPN or gateway/.test(why.text), 'and that StarNet routes through no remote proxy');
    } finally { await filtered.close(); }

    const closed = http.createServer();
    const deadPort = await listen(closed);
    await new Promise(r => closed.close(r));
    const unreachable = await startPinnedProxy({ validate: _internals.assertSafeUrl, resolve: async () => ({ address: '127.0.0.1', family: 4 }) });
    try {
      A.eq(await connect(unreachable.port, 'example.com:' + deadPort), 502, 'a verified address that does not answer is a 502, not a reset');
      const got = unreachable.refusalsSince(t0);
      A.eq(got.length && got[0].code, 'DIAL_FAILED', 'the dial failure is kept');
      A.ok(/could not reach 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/.test(got[0].reason), 'naming the address and the socket error: ' + got[0].reason);
      A.eq(_internals.explainRefusal(got[0]).code, 'NAVIGATION_FAILED', 'a dial failure may pass: it gets the one retry');
    } finally { await unreachable.close(); }

    A.eq(_internals.explainRefusal({ host: 'www.etsy.com', reason: 'getaddrinfo ENOTFOUND www.etsy.com', code: 'ENOTFOUND' }).code, 'NAVIGATION_FAILED',
      'a failed lookup is named as a lookup failure');
    A.eq(_internals.pickRefusal([{ host: 'www.etsy.com', reason: 'a' }, { host: 'i.etsystatic.com', reason: 'b' }], 'https://www.etsy.com/listing/1').reason, 'a',
      'the refusal for the navigated host wins over a later subresource');
    A.eq(_internals.pickRefusal([{ host: 'www.etsy.com', reason: 'a' }], 'https://etsy.com/').reason, 'a', 'a redirect hop refused under its own name is still named');
  }
  A.report('browser-proxy.test');
})().catch(e => { console.error(e); process.exitCode = 1; });
