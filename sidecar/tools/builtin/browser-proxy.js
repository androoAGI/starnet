/* The owned Chromium uses this loopback proxy for every public connection.
   Validation and TCP dial share one DNS answer, including redirects and page
   subresources. CONNECT tunnels preserve the browser's original TLS SNI.

   A SOCKET ERROR MUST NEVER BE UNHANDLED HERE: this proxy lives inside the sidecar, so an 'error' with no listener
   ends the whole station. Measured 2026-09-30 (browser gauntlet, gate): Chromium was closed while a CONNECT was still
   resolving DNS — the browser's socket reset before its error listener existed (it was attached after the await) and
   the process died with ECONNRESET. Every socket gets its listener synchronously, before any await. */
'use strict';

const http = require('node:http');
const net = require('node:net');
const { note: failNote } = require('../../failopen.js');

/* WHY A LOAD WAS REFUSED (the Etsy reports, 2026-10-08). Chromium shows every non-200 answer to a CONNECT as one opaque
   net::ERR_TUNNEL_CONNECTION_FAILED and never reads the proxy's reason, so the refusal is kept HERE for the driver to
   name ("this computer's DNS answered 0.0.0.0 for www.etsy.com") instead of a bare tunnel failure, which users and
   their agents then blamed on a hidden VPN, a remote gateway or Etsy's bot wall. Measured with real Chromium:
   refused CONNECT = ERR_TUNNEL_CONNECTION_FAILED, nothing listening = ERR_PROXY_CONNECTION_FAILED. */
const REFUSALS_KEPT = 32;

async function startPinnedProxy({ validate, resolve }) {
  const localOrigins = new Set();
  const refusals = [];
  // Only endpoints created/accepted by this proxy are ever destroyed during teardown.
  const clients = new Set(), outgoing = new Set();
  // A shared keep-alive pool could lend a tracked socket to another caller before this proxy closes.
  const agent = new http.Agent(http.globalAgent.options);
  let closing = false, closePromise = null;
  function track(set, endpoint) {
    if (!set.has(endpoint)) {
      set.add(endpoint);
      endpoint.once('close', () => set.delete(endpoint));
    }
    return endpoint;
  }
  let refusalSeq = 0;   // a sequence, not a clock: "since this navigation began" needs order, not time
  function refused(host, e) {
    refusals.push({ host: String(host || '').toLowerCase().replace(/^\[|\]$/g, ''), reason: String((e && e.message) || e || 'refused'),
      code: (e && e.code) || null, seq: ++refusalSeq });
    if (refusals.length > REFUSALS_KEPT) refusals.shift();
  }
  function hostOfTarget(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }
  // resolve(u) answers one verified address, every verified address (an array), or nothing for an IP literal
  async function destination(url) {
    const requested = new URL(url);
    if (localOrigins.has(requested.origin) && ['127.0.0.1', 'localhost', '[::1]'].includes(requested.hostname)) {
      return { u: requested, addresses: [requested.hostname.replace(/^\[|\]$/g, '')] };
    }
    const u = validate(url);
    const selected = await resolve(u);
    const verified = (Array.isArray(selected) ? selected : selected ? [selected] : []).map(a => a && a.address);
    const addresses = verified.length ? verified : [u.hostname.replace(/^\[|\]$/g, '')];
    if (!addresses.every(a => net.isIP(a))) throw new Error('no verified IP address for ' + u.hostname);
    return { u, addresses };
  }
  /* EVERY VERIFIED ADDRESS GETS ITS TURN (prompted by the Etsy reports, 2026-10-28). The dial took only the FIRST address
     the DNS answered: a computer whose IPv6 is broken, or a name with one dead address, failed every load through this
     proxy (ERR_TUNNEL_CONNECTION_FAILED) where a normal Chrome, which falls back to the next address, opens the site.
     Measured: a refused first address answered 502; a black-holed one hung 21 s, then 502. Node's own fallback
     (autoSelectFamily, the Happy Eyeballs connect) now walks the list, and its lookup can only hand back the
     addresses validation already checked: still one DNS answer, never a second query. */
  function dialOptions(dest, port) {
    if (dest.addresses.length < 2) return { host: dest.addresses[0], port };
    const pinned = dest.addresses.map(address => ({ address, family: net.isIP(address) }));
    return { host: dest.u.hostname, port, autoSelectFamily: true,
      lookup: (_name, opts, cb) => (opts && opts.all) ? cb(null, pinned) : cb(null, pinned[0].address, pinned[0].family) };
  }
  function dialFailure(dest, port, e) {
    const many = dest.addresses.length > 1;
    const codeOf = x => (x && x.code) || (x && x.message) || 'connection failed';
    const each = many && e && Array.isArray(e.errors) && e.errors.length
      ? e.errors.map(x => ((x && x.address) || '?') + ' ' + codeOf(x)).join(', ') : codeOf(e);
    const err = new Error(many
      ? 'could not reach any of the ' + dest.addresses.length + ' addresses for ' + dest.u.hostname + ':' + port + ' (' + each + ')'
      : 'could not reach ' + dest.addresses[0] + ':' + port + ' (' + each + ')');
    err.code = 'DIAL_FAILED';
    return err;
  }
  const server = http.createServer((req, res) => {
    (async () => {
      const dest = await destination(req.url);
      const { u } = dest;
      if (closing || req.destroyed || res.destroyed) return;
      if (u.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const upstream = track(outgoing, http.request(Object.assign(dialOptions(dest, Number(u.port) || 80), { agent,
        path: u.pathname + u.search, method: req.method,
        headers: Object.assign({}, req.headers, { host: u.host }) }), incoming => {
        if (closing || res.destroyed) { incoming.destroy(); return; }
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      }));
      upstream.on('socket', socket => { track(outgoing, socket); if (closing) socket.destroy(); });
      upstream.on('error', () => { if (closing || res.destroyed) return; if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('error', () => upstream.destroy());
      res.on('error', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(e => { if (closing || res.destroyed) return; refused(hostOfTarget(req.url), e); if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  server.on('connection', client => { track(clients, client); if (closing) client.destroy(); });
  server.on('connect', (req, client, head) => {
    let upstream = null;
    client.on('error', () => { if (upstream) upstream.destroy(); });   // before any await: see the header
    client.on('close', () => { if (upstream) upstream.destroy(); });
    (async () => {
      if (!/^[^@/]+:\d+$/.test(req.url)) throw new Error('invalid CONNECT authority');
      const dest = await destination('https://' + req.url + '/');
      const { u } = dest;
      if (closing || client.destroyed) return;   // the browser went away while DNS resolved
      const port = Number(u.port) || 443;
      upstream = track(outgoing, net.connect(dialOptions(dest, port)));
      let established = false;
      upstream.once('connect', () => {
        if (closing || client.destroyed) { upstream.destroy(); return; }
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', e => {
        if (established || client.destroyed) { client.destroy(); return; }
        // no verified address answered: say so (502) - a bare reset reads in Chromium as ERR_EMPTY_RESPONSE
        refused(u.hostname, dialFailure(dest, port, e));
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      });
    })().catch(e => {
      refused(String(req.url || '').replace(/:\d+$/, ''), e);
      if (!closing && !client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  server.on('upgrade', (req, client, head) => {
    let upstream = null;
    client.on('error', () => { if (upstream) upstream.destroy(); });   // before any await: see the header
    client.on('close', () => { if (upstream) upstream.destroy(); });
    (async () => {
      const dest = await destination(req.url.replace(/^ws:/i, 'http:'));
      const { u } = dest;
      if (u.protocol !== 'http:') throw new Error('unsupported upgrade target');
      if (closing || client.destroyed) return;
      upstream = track(outgoing, net.connect(dialOptions(dest, Number(u.port) || 80)));
      upstream.once('connect', () => {
        if (closing || client.destroyed) { upstream.destroy(); return; }
        const headers = req.rawHeaders.slice();
        for (let i = 0; i < headers.length; i += 2) {
          if (headers[i].toLowerCase() === 'host') headers[i + 1] = u.host;
        }
        let wire = req.method + ' ' + u.pathname + u.search + ' HTTP/' + req.httpVersion + '\r\n';
        for (let i = 0; i < headers.length; i += 2) wire += headers[i] + ': ' + headers[i + 1] + '\r\n';
        upstream.write(wire + '\r\n');
        if (head && head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    })().catch(e => {
      refused(hostOfTarget(String(req.url || '').replace(/^ws:/i, 'http:')), e);
      if (!closing && !client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    });
  });
  // a malformed or reset request from the browser: drop that connection, never the station
  server.on('clientError', (e, sock) => { if (sock && !sock.destroyed) sock.destroy(); });
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  // After listen: a runtime server error (rare — an fd/socket failure) must never end the station; it marks the proxy
  // dead instead, and the driver reads listening() to treat its browser as dead and start a fresh one (#61).
  let failed = false;
  server.on('error', () => { failed = true; try { server.close(); } catch (e) { failNote('browser.proxy.close', e); } });
  return {
    port: server.address().port,
    listening: () => !failed && server.listening,
    allowLocal(url) { localOrigins.add(new URL(url).origin); },
    // refusalMark() before a navigation, refusalsSince(mark) after it (oldest first): what the driver names at a tunnel failure
    refusalMark: () => refusalSeq,
    refusalsSince: mark => refusals.filter(r => r.seq > Number(mark || 0)).map(r => Object.assign({}, r)),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise((resolveClose, rejectClose) => {
        server.close(e => e && e.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectClose(e) : resolveClose());
        // server.close alone waits for active HTTP and leaves upgraded CONNECT/WebSocket sockets alive.
        // Pending DNS handlers check closing before opening anything after this owned set is drained.
        agent.destroy();
        for (const endpoint of outgoing) endpoint.destroy();
        for (const client of clients) client.destroy();
      });
      return closePromise;
    }
  };
}

module.exports = { startPinnedProxy };
