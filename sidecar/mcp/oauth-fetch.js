/* sidecar/mcp/oauth-fetch.js — the ONE fetch every connector-OAuth leg uses (probe, protected-resource + AS
   metadata, dynamic client registration, code exchange, refresh, Google userinfo, GitHub device flow), and the check
   of a custom server's authorization endpoint before the Commander's browser opens it.

   Those URLs come from an untrusted MCP server's metadata. This module owns their guard: the outbound boundary's
   connectorOauth row (sidecar/net/safe-egress.js: a public host, https, no embedded credentials), ONE DNS question per
   leg with every answer validated, and a dispatcher whose socket can reach only the addresses that answer validated,
   all of them, in order (Node's connect walks the list, so a dead first address falls back to the next).
   HISTORY: the security audit of 2026-09-25 found the leg resolved the name AGAIN at connect time, so a DNS-rebinding
   authorization server could pass the check publicly and aim DCR and token POSTs at 127.0.0.1 / 10.x /
   169.254.169.254; the fix pinned the dial. Until the safe-egress lane (2026-11-03) that pin held only the FIRST
   validated address (a broken IPv6 failed sign-in that web_fetch completed), and the guard was web.js's, injected by
   index.js, so this file could not be built without it.

   makeConnectorOauthFetch({ lookup?, fetchImpl?, agentFactory?, onCloseError? })
     -> { connectorOauthFetch(url, init) -> Response, publicDestination(url) -> Destination }
     Production passes only onCloseError; the rest is the transport edge, for tests:
     lookup        absent: this computer's DNS, read at call time (the http preload rigs replace it after boot);
                   null: no DNS and no pin (tests only)
     fetchImpl     absent: globalThis.fetch, read PER CALL (the preload rigs replace it too)
     agentFactory  absent: an undici Agent
   A refusal here is never the host's own words about the caller's URL: it names a host a remote server chose. A
   private DNS answer gains the DNS-filter exit (this computer's filter, VPN or hosts file is the usual answerer). */
'use strict';

const egress = require('../net/safe-egress.js');

function makeConnectorOauthFetch(deps) {
  deps = deps || {};
  const lookup = deps.lookup;
  if (lookup !== undefined && lookup !== null && typeof lookup !== 'function') {
    throw new TypeError('makeConnectorOauthFetch: lookup is a function, null (no DNS, tests only) or absent (this computer\'s DNS)');
  }
  const agentFactory = typeof deps.agentFactory === 'function' ? deps.agentFactory : undefined;
  const onCloseError = typeof deps.onCloseError === 'function' ? deps.onCloseError : undefined;
  const fetchNow = (url, init) => (typeof deps.fetchImpl === 'function' ? deps.fetchImpl : globalThis.fetch)(url, init);

  // a leg's destination: the connectorOauth row, one DNS answer, every address in it validated
  async function publicDestination(raw) {
    try { return await egress.resolveValidated(raw, { policy: 'connectorOauth', lookup }); }
    catch (e) { throw egress.withAnswerExit(e, 'connectorOauth'); }
  }

  async function connectorOauthFetch(raw, init) {
    const dest = await publicDestination(raw);
    const opts = Object.assign({}, init || {}, { redirect: 'manual' });
    // closed in the background, gracefully: undici waits for the in-flight request and its body, so the caller can
    // still read the Response, and a later request can never reuse this pinned connection
    return egress.withPinned(dest, { agentFactory, onCloseError, closeInBackground: true },
      dispatcher => fetchNow(dest.href, dispatcher ? Object.assign(opts, { dispatcher }) : opts));
  }

  return { connectorOauthFetch, publicDestination };
}

module.exports = { makeConnectorOauthFetch };
