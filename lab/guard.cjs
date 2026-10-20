'use strict';

/* Test-process guard for the local StarNet lab. NOT an OS sandbox.

   Two postures, chosen at launch:
     offline (--offline) - no outbound connections, no helper processes, only
                         authoring writes reach the station.
     live (DEFAULT)      - outbound is allowed to the KNOWN PROVIDER HOSTS (every host
                         StarNet's own provider cards talk to), API writes are allowed,
                         helper processes stay available because agent tools need them.

   Why live is the default: the lab exists to test the REAL station. In offline mode not
   one provider card can be set up and not one model can run — every key save and every
   run is answered with "LAB_OFFLINE", which reads like a broken installation rather
   than a chosen posture. The live posture still holds the line that matters: only the
   known provider hosts are reachable, so the lab cannot wander off into arbitrary
   network traffic. --offline keeps the old, completely silent posture for scripted
   authoring tests.

   The allow list can be widened or narrowed with LAB_ALLOW_HOSTS (comma separated; it
   REPLACES the default list) and is reported by GET /api/lab/status.
*/

/* The posture comes from the launcher (lab/start.cjs sets LAB_LIVE=1|0): this module is --require'd by the
   sidecar, so the launcher's own argv never reaches it. Unset means live — the lab is meant to work. */
const LIVE = !/^(0|false|no|off)$/i.test(String(process.env.LAB_LIVE || '').trim());

/* The hosts StarNet's own provider cards talk to. Derived from the provider registry, so a
   NEW provider card is reachable without touching this file. */
/* The OAuth SIGN-IN hosts. A provider card names where INFERENCE goes; the sign-in (the RFC 8628 device code)
   goes to the vendor's AUTH host, which no registry row mentions. Without them the ChatGPT / Grok / Kimi
   sign-in cannot start in the lab at all ("LAB_BLOCKED: auth.openai.com is not on the allowed host list",
   2026-10-20). */
const OAUTH_HOSTS = ['auth.openai.com', 'auth.x.ai', 'auth.kimi.com', 'auth.kimi.ai'];

function defaultAllowHosts() {
  const hosts = new Set(['opencode.ai']);            // the lab's CUSTOM card points here
  try {
    const registry = require('../sidecar/providers/registry.js');
    for (const p of (registry.listProviderProfiles({ public: false }) || [])) {
      const url = String((p && p.baseUrl) || '');
      if (!/^https?:\/\//i.test(url)) continue;
      try { hosts.add(new URL(url).hostname.toLowerCase()); } catch (_) {}
    }
  } catch (_) { /* no registry: the explicit list below still applies */ }
  for (const h of OAUTH_HOSTS) hosts.add(h);          // the device-code sign-ins
  hosts.add('localhost');                            // a local Ollama / vLLM on this machine
  hosts.add('127.0.0.1');
  return [...hosts].filter(Boolean).sort();
}

const ALLOW_HOSTS = String(process.env.LAB_ALLOW_HOSTS || '').trim()
  ? String(process.env.LAB_ALLOW_HOSTS).split(',').map(v => v.trim().toLowerCase()).filter(Boolean)
  : defaultAllowHosts();

const deny = () => {
  throw new Error('LAB_OFFLINE: outbound connections and subprocesses are disabled — start the lab with --live '
    + '(or LAB_LIVE=1) to allow provider calls and agent tools');
};

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
      if (!hostAllowed(url.hostname)) {
        throw new Error('LAB_BLOCKED: ' + url.hostname + ' is not on the allowed host list (allowed: '
          + ALLOW_HOSTS.join(', ') + ') — start the lab with LAB_ALLOW_HOSTS=' + url.hostname
          + ' to reach that host');
      }
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
      return res.end(JSON.stringify({ ok: false, error: 'LAB_OFFLINE: execution and external actions disabled — start the lab with --live (or LAB_LIVE=1) to add a provider and run a model' }));
    }
    return handler(req, res);
  };
  return createServer.apply(this, args);
};

module.exports = { LIVE, ALLOW_HOSTS, hostAllowed, defaultAllowHosts };
