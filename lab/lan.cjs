'use strict';

// LAN-only, password-protected front door. StarNet itself remains loopback-only.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function privateIPv4(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function makeProxy({ host, port, username, password, upstreamPort = 8790, publicOrigin }) {
  const loopback = host === '127.0.0.1';
  if (!privateIPv4(host) || (host.startsWith('127.') && !loopback)) throw new Error('A private IPv4 address is required');
  if (loopback && !publicOrigin) throw new Error('Loopback mode requires an explicit Tailscale HTTPS origin');
  const origin = publicOrigin || ('http://' + host + ':' + port);
  const publicUrl = new URL(origin);
  if (publicOrigin && (!loopback || publicUrl.protocol !== 'https:' || !publicUrl.hostname.endsWith('.ts.net') || publicUrl.origin !== origin)) throw new Error('Only a loopback Tailscale HTTPS proxy is supported');
  const authority = publicUrl.host;
  const expected = Buffer.from('Basic ' + Buffer.from(username + ':' + password).toString('base64'));
  const server = http.createServer((req, res) => {
    const deny = (code, text, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
      res.end(text);
    };
    const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const allowedHost = req.headers.host === authority || (loopback && req.headers.host === host + ':' + port);
    if (!privateIPv4(peer) || (loopback && peer !== '127.0.0.1') || !allowedHost) return deny(403, 'Private address/host required');
    if (req.headers.origin && req.headers.origin !== origin) return deny(403, 'Foreign origin denied');
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.headers['sec-fetch-mode'] !== 'navigate') return deny(403, 'Cross-site request denied');
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return deny(401, 'Login required', { 'WWW-Authenticate': 'Basic realm="StarNet Local Lab", charset="UTF-8"' });
    }
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return deny(400, 'Invalid request path');
    const headers = { ...req.headers, host: '127.0.0.1:' + upstreamPort };
    delete headers.authorization;
    delete headers['proxy-authorization'];
    delete headers.forwarded;
    for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-')) delete headers[key];
    if (headers.origin) headers.origin = 'http://127.0.0.1:' + upstreamPort;
    if (headers.referer) headers.referer = 'http://127.0.0.1:' + upstreamPort + '/';
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers }, answer => {
      // Keep the sidecar's caching/ETag contract (static art is revalidated;
      // the token page is no-store). Only add a privacy policy of our own.
      const responseHeaders = { ...answer.headers, 'Referrer-Policy': 'same-origin' };
      if (!responseHeaders['cache-control']) responseHeaders['cache-control'] = 'no-store';
      if (responseHeaders['access-control-allow-origin']) responseHeaders['access-control-allow-origin'] = origin;
      if (typeof responseHeaders.location === 'string') responseHeaders.location = responseHeaders.location.replace('http://127.0.0.1:' + upstreamPort, origin);
      res.writeHead(answer.statusCode, responseHeaders);
      answer.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) deny(502, 'Local lab unavailable'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

if (require.main === module) {
  const host = process.argv[2];
  const port = Number(process.argv[3] || 8791);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const file = path.resolve(__dirname, '../.lab-state/lan-access.json');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let credentials;
  if (fs.existsSync(file)) credentials = JSON.parse(fs.readFileSync(file, 'utf8'));
  else {
    credentials = { username: 'lab', password: crypto.randomBytes(18).toString('base64url') };
    fs.writeFileSync(file, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: 'wx' });
  }
  const publicOrigin = process.argv[4];
  const server = makeProxy({ host, port, ...credentials, publicOrigin });
  server.listen(port, host, () => console.log('Lab proxy: ' + (publicOrigin || ('http://' + host + ':' + port)) + '\nLocal listener: ' + host + ':' + port + '\nCredentials: ' + file + '\n' +
    (publicOrigin ? 'Tailscale HTTPS only. No LAN listener or public Funnel.' : 'Private trusted LAN only: HTTP is not encrypted. No public forwarding.')));
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

module.exports = { makeProxy, privateIPv4 };
