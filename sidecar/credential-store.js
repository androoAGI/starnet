/* sidecar/credential-store.js — every API-key provider's key, key pool and endpoint, in ONE place (credential-store lane,
   B1 credential sources).

   WHY. A provider credential lived in five stores that every reader combined on its own: the desktop shell's push
   (runtimeKeys / runtimeKeyPools / runtimeBaseUrls), the legacy OpenRouter alias (runtimeKey), the operator's environment,
   the browser page's copy (engine-credential.js) and the key an /api/run body carries. Remove, rotate and restart could
   therefore mean something different on every surface (gh#89, #137, #146, #113). This module is the one place those
   layers are held and resolved; index.js keeps one-line functions with the names its call sites use.

   THE LAYERS, as resolved at trunk (step S1 moved them here UNCHANGED; test/fixtures/credential-store-golden.json is the
   behaviour captured from trunk's own index.js, and every later change is a named delta row in it):
     explicit   a key the caller hands one run (an /api/run body key, a fallback's own key). Never stored here.
     keychain   the desktop shell's push (POST /api/key -> push): keys, key pools and endpoints, in memory. On EVERY station
                the legacy alias STARNET_/SKYNET_OPENROUTER_KEY seeds its OpenRouter key at boot (deps.alias), and the
                host's runtimeKey mirror follows that key (deps.onAlias). Its endpoints are kept across restarts as URLs
                only (.secrets/provider-endpoints.json v1) on a station whose shell pushes provider config (deps.keptEndpoints).
     env        the operator's environment, read live through the host's envFirst (the bare name, then STARNET_/SKYNET_)
                and the branded KEY_POOL_<ID> (deps.env). Never written.
     page       the browser page's copy (engine-credential.js makeEngineKeys, injected as deps.page): one credential per
                provider — its key, its backup keys and the endpoint it was saved with.
     linked     starnet: the linked device token and cloud URL (deps.linked, the host's resolveCreditsConfig).
   KEY order: explicit > keychain > env (OpenRouter: the alias first) > page; starnet is linked only; a codex sign-in has
   no key here. ENDPOINT order (baseUrl): starnet linked; a sign-in never takes an explicit endpoint; an explicit endpoint
   only with the caller's own key or a key sent in this request; the keychain endpoint; the page endpoint only with the
   page's own key; the env URL; a keyless page endpoint only for a keyless run; the profile default. POOLS (keyPool): an
   explicit pool; else the pushed pool, for ANY run key; else the env KEY_POOL, for any run key; else the page pool, only
   with the page's own key. Two of those cross accounts (a pool rides a key of another layer: probes R1 and R6), and the
   golden pins them as they are until step S4 binds each pool to its own layer's key.

     makeCredentialStore(deps) -> store
       deps.profile(id)               the provider profile (registry getProviderProfile), null for an unknown id
       deps.normalize(value)          canonical id, unknown -> 'openrouter' (index.js normalizeProvider)
       deps.normalizeId(value)        canonical id, unknown -> '' (the registry's normalizeProviderId(value, ''))
       deps.usesCodex(id)             the ChatGPT sign-in, whose bearer this store never holds
       deps.linked()                  { url, apiKey } of the linked StarNet account
       deps.envFirst(names)           the first set name's value, trimmed: the bare name, then STARNET_/SKYNET_; '' when none
       deps.env(suffix)               STARNET_<suffix>, else SKYNET_<suffix> (index.js ENV)
       deps.page                      the page layer: { get(id) -> { key?, keyPool?, baseUrl? } | null }
       deps.alias                     STARNET_/SKYNET_OPENROUTER_KEY at boot: seeds the keychain's OpenRouter key
       deps.onAlias(key)              told the keychain's OpenRouter key at boot and after every push that sets or clears it
       deps.hasCredential(id, k, url) whether that pair can run (index.js providerHasCredential), for presence()
       deps.keptEndpoints             { on, load() -> the saved file | undefined, save(envelope) -> bool proven }
       deps.warn(line)                one log line (never a key, a pool or a URL)
       deps.keychain                  { keys, pools, baseUrls }: the keychain layer's three maps, when the host hands in
                                      its own (the test sandboxes do, test/helpers/credential-store-sandbox.js)
     store.key(provider, explicitKey)                          the key a run goes out on        (providerRuntimeKey)
     store.baseUrl(provider, explicit, runKey, callerKey, inRequest)  the endpoint for that key (providerRuntimeBaseUrl)
     store.keyPool(provider, explicitPool, runKey)             the backup keys a run rotates onto (providerRuntimeKeyPool)
     store.push(provider, patch, report)                       the shell's push (setProviderRuntimeConfig); -> id | null
     store.presence(id)                                        what an unattended run would use (engineKeyPresence)
     store.stationHeld(provider, key)                          the keychain's, the env's or the page copy's own key, never
                                                               a backup key in a pool (channelKeyIsStationHeld)
     store.endpointIsForeign(provider, key, baseUrl)           (channelEndpointIsForeign)
     store.keptEndpoints()                                     the kept endpoints, by provider (desktopEndpointsHeld)
     store.loadKeptEndpoints()                                 boot: read the kept endpoints back (loadDesktopEndpoints)
     store.endpointNotHandedOver(id)                           (providerEndpointNotHandedOver)
     store.operatorKey(id), store.fallbackPool(id, runKey), store.pageRidesWith(id, runKey), store.keepsEndpoint(id)
                                                               the trunk helpers above, by their new names
     store.alias()                                             the keychain's OpenRouter key (the runtimeKey alias)
     store.keychainValues()                                    { keys, pools }: the keychain layer's values, for redaction

   Pure: no fs, no process.env, no clock; the host injects all three. UMD, no dependencies. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.credentialStore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const REQUIRED = ['profile', 'normalize', 'normalizeId', 'usesCodex', 'linked', 'envFirst', 'env'];

  function makeCredentialStore(deps) {
    const d = deps || {};
    for (const name of REQUIRED) if (typeof d[name] !== 'function') throw new TypeError('makeCredentialStore: deps.' + name + ' must be a function');
    const profileOf = d.profile, normalize = d.normalize, normalizeId = d.normalizeId, usesCodex = d.usesCodex;
    const linked = d.linked, envFirst = d.envFirst, env = d.env;
    const page = (d.page && typeof d.page.get === 'function') ? d.page : { get: () => null };
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : () => false;
    const onAlias = typeof d.onAlias === 'function' ? d.onAlias : () => {};
    const warn = typeof d.warn === 'function' ? d.warn : () => {};
    const kept = d.keptEndpoints || {};
    const keepsOn = kept.on === true;
    if (keepsOn && (typeof kept.load !== 'function' || typeof kept.save !== 'function')) throw new TypeError('makeCredentialStore: deps.keptEndpoints needs load and save');
    const layer = d.keychain || {};
    const keys = layer.keys || Object.create(null);           // provider id -> the pushed key
    const pools = layer.pools || Object.create(null);         // provider id -> its alternate keys; never shared across providers
    const baseUrls = layer.baseUrls || Object.create(null);   // provider id -> the pushed endpoint

    // the legacy OpenRouter alias (STARNET_/SKYNET_OPENROUTER_KEY) is the keychain's OpenRouter key from boot, on every
    // station, and every push of an OpenRouter key replaces it; the host's runtimeKey mirror reads it through onAlias
    function alias() { return String(keys.openrouter || ''); }
    const seed = String(d.alias || '').trim();
    if (seed) keys.openrouter = seed;
    onAlias(alias());

    /* ---- keys ---- */
    function key(provider, explicitKey) {
      const id = normalize(provider);
      if (usesCodex(id)) return '';

      // 'starnet' managed provider: the bearer is the linked device token, resolved from the credits config
      // (env CREDITS_* override or the linked .secrets/credits.json record) — never an env API key.
      if (id === 'starnet') return String(linked().apiKey || '').trim();
      const explicit = String(explicitKey || '').trim();
      if (explicit) return explicit;
      const runtime = String(keys[id] || '').trim();
      if (runtime) return runtime;
      const operator = operatorKey(id);
      // #89: the key a browser page handed the station (engine-credential.js) fills the gap an operator left; an env var
      // (OPENROUTER_API_KEY …) or the desktop keychain push above is a deliberate deployment choice and keeps priority.
      return operator || String((page.get(id) || {}).key || '');
    }
    // the env-var key an operator set for this provider (OPENROUTER_KEY/OPENROUTER_API_KEY …); '' when none
    function operatorKey(id) {
      const profile = profileOf(id);
      if (id === 'openrouter') return alias() || envFirst(profile && profile.keyEnv);
      return envFirst(profile && profile.keyEnv);
    }

    /* ---- key pools ---- */
    function keyPool(provider, explicitPool, runKey) {
      const id = normalize(provider);
      const source = Array.isArray(explicitPool)
        ? explicitPool
        : (own(pools, id)
          ? pools[id]
          : fallbackPool(id, runKey));
      return Array.from(new Set(source.map(k => String(k || '').trim()).filter(Boolean))).slice(0, 8);
    }
    // the operator's SKYNET_KEY_POOL_<PROVIDER>; else the page copy's backup keys — only for a run on the page copy's own
    // key (backups for someone else's key would rotate a run onto a different account)
    function fallbackPool(id, runKey) {
      const fromEnv = String(env('KEY_POOL_' + id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')) || '').split(',').filter(k => String(k || '').trim());
      if (fromEnv.length) return fromEnv;
      const copy = pageRidesWith(id, runKey);
      return (copy && copy.key && copy.keyPool) ? copy.keyPool : [];
    }
    /* #89 the page copy (engine-credential.js) is ONE credential: its endpoint and backup keys belong to its own key. They
       ride only a run whose key IS that key — never an operator env key, the desktop push, or another page's per-run key
       (that would send a credential to an endpoint, or rotate a run onto an account, it was not saved for). A keyless page
       endpoint rides a keyless run. `runKey` undefined = the station's own resolution (key()). */
    function pageRidesWith(id, runKey) {
      const copy = page.get(id);
      if (!copy) return null;
      const inUse = runKey === undefined ? key(id, '') : String(runKey || '').trim();
      return inUse === String(copy.key || '') ? copy : null;
    }

    /* ---- endpoints ---- */
    function baseUrl(provider, explicitBaseUrl, runKey, callerKey, inRequest) {
      const id = normalize(provider);

      // 'starnet' managed provider: baseUrl = the linked cloud URL + '/v1' (the inference proxy lives there).
      // Resolved live so linking/unlinking a station reconfigures it with no restart (mirrors the credits adapter).
      if (id === 'starnet') {
        const u = String(linked().url || '').trim().replace(/\/+$/, '');
        return u ? (u + '/v1') : '';
      }
      // Managed credentials and destination belong to the same linked account. A stale per-run
      // BYOK endpoint must never redirect the device token away from that account's service.
      const profile = profileOf(id);
      // ...and for the same reason a SUBSCRIPTION SIGN-IN (ChatGPT, Grok, Kimi: authType oauth_device_code), whose OAuth bearer
      // rides the request: a per-run endpoint (an /api/run body's, a channel snapshot's) never redirects it. The Commander's own
      // endpoint (the runtime push, the env URL) and the profile's still apply.
      let explicit = (profile && profile.authType === 'oauth_device_code') ? '' : String(explicitBaseUrl || '').trim();
      // ...nor does a STATION-HELD API key (the keychain/runtime push, an operator env key, the page copy). A per-run endpoint
      // rides only the caller's own key (`callerKey`, when it is the key the run goes out on: `runKey`, else this provider's
      // resolution of it) or a keyless run; otherwise it is ignored and the configured endpoint below serves. A key the station
      // itself holds (the keychain/runtime push, the operator's env key, the page copy) is never "the caller's own", even when a
      // caller hands it back as callerKey: a channel record an older build saved with the station's key in it must not carry it
      // elsewhere. The page copy (#89) is one credential — its key goes to the endpoint it was saved with (below), never another
      // a record names beside it (review r7: the page's own sync handed it back for a script's saved endpoint).
      // Review r8: a key that arrived in THIS request's body (`inRequest` true: /api/run) IS the caller's own, even when the
      // station holds the same key — the caller sent it, and the page copy can lag the page's last change — so the endpoint sent
      // beside it rides with it. A key read from a record or resolved by the station keeps the rule above.
      if (explicit) {
        const mine = String(callerKey || '').trim();
        const inUse = runKey === undefined ? key(id, mine) : String(runKey || '').trim();
        const sentNow = inRequest === true && !!mine && inUse === mine;
        const held = !sentNow && !!inUse && (inUse === String(keys[id] || '').trim() || inUse === operatorKey(id) || !!pageRidesWith(id, inUse));
        if (inUse && (inUse !== mine || held)) explicit = '';
      }
      if (explicit) return explicit;
      const runtime = String(baseUrls[id] || '').trim();
      if (runtime) return runtime;
      // #89: the page's endpoint (a CUSTOM base URL saved in the browser) goes with the page's key — over the operator's
      // env URL when the run is on that key, never under an env key. A keyless page endpoint (a local server) ranks under
      // the operator's env URL and over the profile default, the same order the key follows.
      const copy = pageRidesWith(id, runKey);
      if (copy && copy.key && copy.baseUrl) return copy.baseUrl;
      return envFirst(profile && profile.baseUrlEnv) || String((copy && copy.baseUrl) || '') || (profile && profile.baseUrl) || '';
    }

    /* #137 THE DESKTOP'S ENDPOINTS, KEPT ACROSS RESTARTS. On the desktop app the OS keychain holds provider KEYS; a provider's
       ENDPOINT (a CUSTOM base URL, an Ollama that is not on this machine) reaches the station only when the app pushes it
       (POST /api/key), and the keychain layer is memory. Every app restart (an update included) and every sidecar respawn
       therefore started a station with no endpoint: a routine due at launch, and any routine, Run Now, line hop, channel or
       phone run before the window handed the endpoint over again, failed "no CUSTOM base URL is saved on this station". So
       a station whose shell pushes its provider config (the per-launch IPC token is set: deps.keptEndpoints.on) keeps the
       endpoints it was pushed (URLs only, never a key) in .secrets/ (station-recovery skips it, /api/file cannot reach it)
       and reads them back at boot, before the scheduler's launch catch-up. Every API-key provider's endpoint is kept — the
       Commander's own servers (CUSTOM, Ollama) and a cloud provider's override (an OpenRouter-compatible proxy, a corporate
       gateway) alike: the page sends no key on the desktop, so a per-run endpoint never rides the keychain key (baseUrl),
       and a cloud override held for this session only sent every chat after a respawn to the provider's default until the
       window's hand-over landed. A sign-in (ChatGPT, Grok, Kimi) and StarNet's linked account resolve their own endpoints:
       never kept. The host writes main AND .bak and reads both back: an endpoint the Commander replaced or cleared (a URL
       can carry a token in its query) must not survive in the recovery copy. */
    function keepsEndpoint(id) {
      const profile = profileOf(id);
      return !!profile && id !== 'starnet' && profile.authType !== 'oauth_device_code';
    }
    // review r8: a desktop station that holds NO endpoint for this provider of its own — none pushed or kept, no env URL, no
    // page copy — so its only answer is the provider's default: a run naming one has outrun the window's hand-over (handleRun)
    function endpointNotHandedOver(id) {
      if (!keepsOn || !keepsEndpoint(id)) return false;
      const profile = profileOf(id);
      return !String(baseUrls[id] || '').trim() && !envFirst(profile && profile.baseUrlEnv) && !String((page.get(id) || {}).baseUrl || '').trim();
    }
    let keptOnDisk = '{}';
    function keptEndpoints() {
      const out = {};
      for (const id of Object.keys(baseUrls).sort()) {
        const u = String(baseUrls[id] || '').trim();
        if (u && keepsEndpoint(id)) out[id] = u;
      }
      return out;
    }
    function loadKeptEndpoints() {
      if (!keepsOn) return;
      const saved = kept.load();
      const urls = saved && typeof saved === 'object' ? saved.baseUrls : null;
      if (!urls || typeof urls !== 'object' || Array.isArray(urls)) return;
      for (const p of Object.keys(urls)) {
        const id = normalizeId(p);
        const u = typeof urls[p] === 'string' ? urls[p].trim() : '';
        if (keepsEndpoint(id) && u && !baseUrls[id]) baseUrls[id] = u;
      }
      keptOnDisk = JSON.stringify(keptEndpoints());
    }
    // called on every endpoint push; writes only when the set changed. The pushed endpoint is live either way; a failed
    // write is logged by the host's verified writer and retried by the next change.
    function saveKeptEndpoints() {
      if (!keepsOn) return true;
      const held = keptEndpoints();
      const want = JSON.stringify(held);
      if (want === keptOnDisk) return true;
      const ok = kept.save({ version: 1, baseUrls: held });
      if (ok) keptOnDisk = want;
      return ok;
    }

    /* ---- the desktop shell's push (POST /api/key) ----
       `report` (optional): endpointPersisted is set when the patch moved an endpoint — false = live now, NOT kept on disk */
    function push(provider, patch, report) {
      const id = normalizeId(provider);
      if (!id || !profileOf(id)) return null;
      patch = patch || {};
      if (own(patch, 'key')) {
        const k = String(patch.key || '').trim();
        if (k) keys[id] = k;
        else delete keys[id];
        if (id === 'openrouter') onAlias(alias());
      }
      if (own(patch, 'baseUrl')) {
        const u = String(patch.baseUrl || '').trim();
        if (u) baseUrls[id] = u;
        else delete baseUrls[id];
        // #137: the station keeps the endpoint across an app restart or a respawn; review r8: a failed write is said, not dropped
        const persisted = saveKeptEndpoints();
        if (report) report.endpointPersisted = persisted;
        if (!persisted) warn('[desktop-endpoints] the ' + id + ' endpoint is in use now but was NOT saved to disk — after a restart the station waits for the app to hand it over again');
      }
      if (own(patch, 'keyPool')) {
        const pool = keyPool(id, Array.isArray(patch.keyPool) ? patch.keyPool : []);
        if (pool.length) pools[id] = pool;
        else delete pools[id];
      }
      return id;
    }

    /* ---- readouts ---- */
    // what an unattended run of this provider would use RIGHT NOW — booleans and a source name, never a value
    function presence(id) {
      const saved = page.get(id) || {};
      const operator = !!(String(keys[id] || '').trim() || operatorKey(id));
      return {
        saved: { key: !!saved.key, alternates: (saved.keyPool || []).length, baseUrl: !!saved.baseUrl },
        keySource: operator ? 'environment' : (saved.key ? 'station' : 'none'),
        unattendedReady: hasCredential(id, key(id, ''), baseUrl(id, ''))
      };
    }
    /* A CHANNEL RECORD NEVER HOLDS THE STATION'S OWN KEY (channels/secrets.js scrubStationKeys): a key the station holds —
       the keychain push, the operator's env key, the page copy — resolves live per message, never from a record. */
    function stationHeld(provider, recordKey) {
      const id = normalize(provider);
      const k = String(recordKey || '').trim();
      return !!k && (k === String(keys[id] || '').trim() || k === operatorKey(id) || !!pageRidesWith(id, k));
    }
    // a record holding the PAGE COPY's key beside an endpoint that copy was not saved with (an older build's keyless connect)
    function endpointIsForeign(provider, recordKey, recordUrl) {
      const copy = pageRidesWith(normalize(provider), String(recordKey || '').trim());
      const u = String(recordUrl || '').trim().replace(/\/+$/, '');
      return !!copy && !!copy.key && !!u && u !== String(copy.baseUrl || '').trim().replace(/\/+$/, '');
    }
    function keychainValues() { return { keys: Object.values(keys), pools: Object.values(pools) }; }

    return {
      key, operatorKey, keyPool, fallbackPool, pageRidesWith, baseUrl,
      keepsEndpoint, endpointNotHandedOver, keptEndpoints, loadKeptEndpoints, saveKeptEndpoints,
      push, presence, stationHeld, endpointIsForeign, alias, keychainValues
    };
  }

  return { makeCredentialStore };
});
