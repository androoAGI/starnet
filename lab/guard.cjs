'use strict';

/* Test-process guard for the local StarNet lab. NOT an OS sandbox.

   Two postures, chosen at launch:
     offline (default) - no outbound connections, no helper processes, only
                         authoring writes reach the station.
     live (LAB_LIVE=1)  - outbound is allowed ONLY to the hostnames in
                         LAB_ALLOW_HOSTS (default opencode.ai, openrouter.ai),
                         API writes are allowed so keys, runs and tools work.
                         Helper processes stay available because agent tools need
                         them; that is a real widening, so live mode is opt-in.
*/

const LIVE = /^(1|true|yes|on)$/i.test(String(process.env.LAB_LIVE || '').trim());
const ALLOW_HOSTS = String(process.env.LAB_ALLOW_HOSTS || 'opencode.ai,openrouter.ai')
  .split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
const deny = () => { throw new Error('LAB_OFFLINE: outbound connections and subprocesses are disabled'); };

function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return ALLOW_HOSTS.some(allowed => h === allowed || h.endsWith('.' + allowed));
}

if (LIVE) {
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = function (input, init) {
      let url;
      try { url = new URL(typeof input === 'string' ? input : (input && input.url) || ''); }
      catch (_) { throw new Error('LAB_OFFLINE: unreadable request target'); }
      if (!hostAllowed(url.hostname)) throw new Error('LAB_OFFLINE: ' + url.hostname + ' is not on the allowed host list');
      return realFetch.call(this, input, init);
    };
  }
} else {
  globalThis.fetch = async () => deny();
  require('node:net').Socket.prototype.connect = deny;
  for (const mod of ['node:http', 'node:https']) {
    const transport = require(mod);
    transport.request = deny;
    transport.get = deny;
  }
  const cp = require('node:child_process');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = deny;
}

/* Only authoring-related writes may reach the station offline. Live mode allows
   keys, runs and tools, which is what a real workflow test needs. */
const http = require('node:http');
const createServer = http.createServer;
const writable = new Set(['/api/save', '/api/routing', '/api/roster', '/api/tickets', '/api/presence']);
http.createServer = function (...args) {
  const index = typeof args[0] === 'function' ? 0 : 1;
  const handler = args[index];
  if (typeof handler === 'function') args[index] = (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/api/lab/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ lab: true, offline: !LIVE, live: LIVE, execution: LIVE, subprocesses: LIVE, hosts: LIVE ? ALLOW_HOSTS : [] }));
    }
    if (!LIVE && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !writable.has(pathname)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'LAB_OFFLINE: execution and external actions disabled' }));
    }
    return handler(req, res);
  };
  return createServer.apply(this, args);
};

module.exports = { LIVE, ALLOW_HOSTS, hostAllowed };
