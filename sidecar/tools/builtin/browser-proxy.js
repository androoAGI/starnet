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

async function startPinnedProxy({ validate, resolve }) {
  const localOrigins = new Set();
  async function destination(url) {
    const requested = new URL(url);
    if (localOrigins.has(requested.origin) && ['127.0.0.1', 'localhost', '[::1]'].includes(requested.hostname)) {
      return { u: requested, address: requested.hostname.replace(/^\[|\]$/g, '') };
    }
    const u = validate(url);
    const selected = await resolve(u);
    const address = selected ? selected.address : u.hostname.replace(/^\[|\]$/g, '');
    if (!net.isIP(address)) throw new Error('no verified IP address for ' + u.hostname);
    return { u, address };
  }
  const server = http.createServer((req, res) => {
    (async () => {
      const { u, address } = await destination(req.url);
      if (u.protocol !== 'http:') throw new Error('HTTPS requires CONNECT');
      const upstream = http.request({ hostname: address, port: Number(u.port) || 80,
        path: u.pathname + u.search, method: req.method,
        headers: Object.assign({}, req.headers, { host: u.host }) }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers);
        incoming.on('error', () => res.destroy());
        incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('error', () => upstream.destroy());
      res.on('error', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  server.on('connect', (req, client, head) => {
    let upstream = null;
    client.on('error', () => { if (upstream) upstream.destroy(); });   // before any await: see the header
    client.on('close', () => { if (upstream) upstream.destroy(); });
    (async () => {
      if (!/^[^@/]+:\d+$/.test(req.url)) throw new Error('invalid CONNECT authority');
      const { u, address } = await destination('https://' + req.url + '/');
      if (client.destroyed) return;   // the browser went away while DNS resolved
      const port = Number(u.port) || 443;
      upstream = net.connect({ host: address, port });
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
    })().catch(() => { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
  });
  server.on('upgrade', (req, client, head) => {
    let upstream = null;
    client.on('error', () => { if (upstream) upstream.destroy(); });   // before any await: see the header
    client.on('close', () => { if (upstream) upstream.destroy(); });
    (async () => {
      const { u, address } = await destination(req.url.replace(/^ws:/i, 'http:'));
      if (u.protocol !== 'http:') throw new Error('unsupported upgrade target');
      if (client.destroyed) return;
      upstream = net.connect({ host: address, port: Number(u.port) || 80 });
      upstream.once('connect', () => {
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
    })().catch(() => { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
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
    close: () => new Promise(resolveClose => server.close(resolveClose))
  };
}

module.exports = { startPinnedProxy };
