/* sidecar/providers/endpoint-facts.js — what StarNet knows about ONE endpoint (a base URL), in one cached object.

   Two facts, both read from things StarNet already has — never a new probe:
     · scope: where the host is, from its name alone (errorClass.hostScope): 'loopback' (this computer), 'private' (this
       network: an RFC 1918 / link-local / CGNAT / ULA address, a .local / .lan name, a bare name), 'public', '' (no host).
       `local` = loopback or private. A public name that resolves to a LAN address still reads public: only what the
       name proves.
     · windows: the context window each model's /models row REPORTED (openai-compatible reportedWindow: LM Studio's
       loaded_context_length, vLLM's max_model_len, context_length …), noted by the adapter from catalog reads it already
       makes. A model whose row reports none has no window here (0): a window is never invented.

   One object per base URL for this process (bounded), shared by every adapter instance on that URL: a run builds a fresh
   adapter, and the window the model dock's catalog read reported answers the run's adapter too. Pure bookkeeping: no IO,
   no clock. The local-runtime profile (openai-compatible.js: one send on a silent local server, then local_timeout) and
   the local prompt budget read it. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./errorClass.js'));
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.endpointFacts = factory(root.SK.providers.errorClass); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (errorClass) {
  'use strict';

  const MAX_ENDPOINTS = 200;
  const MAX_MODELS = 500;
  const byEndpoint = new Map();   // cleaned base URL -> fact object

  function cleanBaseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }

  // the fact object for a base URL (created on first ask). host = hostname only, hostPort = host[:port] as a URL parser
  // reads it — URL.host never carries userinfo, so no credential reaches a message built from it.
  function of(baseUrl) {
    const key = cleanBaseUrl(baseUrl);
    let f = byEndpoint.get(key);
    if (f) return f;
    let host = '', hostPort = '';
    try { const u = new URL(key); host = u.hostname || ''; hostPort = u.host || ''; } catch (_) { host = ''; hostPort = ''; }
    const scope = host ? errorClass.hostScope(host) : '';
    f = { baseUrl: key, host, hostPort, scope, local: scope === 'loopback' || scope === 'private', windows: new Map() };
    if (byEndpoint.size >= MAX_ENDPOINTS) byEndpoint.clear();
    byEndpoint.set(key, f);
    return f;
  }

  // a window a /models row REPORTED for a model on this endpoint (0 or less is no report and is ignored)
  function noteWindow(baseUrl, model, window) {
    const id = String(model || '');
    const n = Math.floor(Number(window) || 0);
    if (!id || !(n > 0)) return;
    const f = of(baseUrl);
    if (!f.windows.has(id) && f.windows.size >= MAX_MODELS) f.windows.clear();
    f.windows.set(id, n);
  }
  function windowOf(baseUrl, model) { return of(baseUrl).windows.get(String(model || '')) || 0; }

  // a plain copy for a reader outside the adapter (no Map, nothing to mutate)
  function snapshot(baseUrl, model) {
    const f = of(baseUrl);
    return { scope: f.scope, local: f.local, host: f.host, hostPort: f.hostPort, window: model ? windowOf(baseUrl, model) : 0 };
  }

  return { of, noteWindow, windowOf, snapshot, _reset: () => byEndpoint.clear() };
});
