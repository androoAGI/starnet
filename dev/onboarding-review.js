/* Local UI review only: actual frontend modules, deterministic model replies.
 * Run node dev/onboarding-review.js and open http://127.0.0.1:8998.
 * No real agent, account, or station data is used. */
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const frontend = path.resolve(__dirname, '../frontend');
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.woff2':'font/woff2' };
http.createServer((req, res) => {
  try {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = route === '/' ? path.join(__dirname, 'onboarding-review.html') : path.resolve(frontend, '.' + route);
    if (route !== '/' && !file.startsWith(frontend + path.sep)) { res.writeHead(403).end(); return; }
    const bytes = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(bytes);
  } catch (_) { res.writeHead(404).end(); }
}).listen(8998, '127.0.0.1', () => console.log('UI review (demo replies): http://127.0.0.1:8998'));
