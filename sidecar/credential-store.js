/* sidecar/credential-store.js — every API-key provider's key, key pool and endpoint, in ONE place (credential-store lane,
   B1 credential sources).

   WHY. A provider credential lived in five stores that every reader combined on its own: the desktop shell's push
   (runtimeKeys / runtimeKeyPools / runtimeBaseUrls), the legacy OpenRouter alias (runtimeKey), the operator's environment,
   the browser page's copy (engine-credential.js) and the key an /api/run body carries. Remove, rotate and restart could
   therefore mean something different on every surface (gh#89, #137, #146, #113). This module is the one place those
   layers are held and resolved; index.js keeps one-line functions with the names its call sites use.

   THE LAYERS (step S1 moved trunk's resolution here UNCHANGED; test/fixtures/credential-store-golden.json is the
   behaviour captured from trunk's own index.js, and every later change is a named delta row in it):
     explicit   a key the caller hands one run (an /api/run body key, a fallback's own key). Never stored here.
     keychain   the desktop shell's credentials, in memory: the keys and key pools it wrote into the sidecar's environment at
                spawn, adopted at boot (adoptSpawnCredentials, step S2; deps.spawn), then changed only by its push (POST
                /api/key -> push). A branded OpenRouter key the shell did not write (a headless operator's export, or a
                desktop user's own single-spelling one) still seeds its OpenRouter key at boot, as at trunk: the legacy alias
                STARNET_/SKYNET_OPENROUTER_KEY (deps.alias, else read through deps.env), which the readout calls the
                environment; the host's runtimeKey mirror follows that key (deps.onAlias). Its endpoints are kept across
                restarts as URLs only (.secrets/provider-endpoints.json v1) on a station whose shell pushes provider config
                (deps.keptEndpoints).
     env        the operator's environment, read live through the host's envFirst (the bare name, then STARNET_/SKYNET_)
                and the branded KEY_POOL_<ID> (deps.env). Never written; only adoption at boot deletes the shell's pairs.
     page       the browser page's copy (engine-credential.js makeEngineKeys, injected as deps.page): one credential per
                provider — its key, its backup keys and the endpoint it was saved with.
     linked     starnet: the linked device token and cloud URL (deps.linked, the host's resolveCreditsConfig).
   KEY order: explicit > keychain > env (OpenRouter: the alias first) > page; starnet is linked only; a codex sign-in has
   no key here. Golden delta D1 (S2): under the desktop shell the keychain key outranks a bare OS export of the same
   provider (ANTHROPIC_API_KEY set for another tool), because the shell's key is adopted into the keychain layer; at trunk
   envFirst read the bare name before the shell's spelling, so the OS key won (probe R5; decision 4). ENDPOINT order
   (baseUrl): starnet linked; a sign-in never takes an explicit endpoint; an explicit endpoint only with the caller's own
   key or a key sent in this request; the keychain endpoint; the page endpoint only with the page's own key; the env URL; a
   keyless page endpoint only for a keyless run; the profile default. POOLS (keyPool, step S4, golden delta D2): a pool
   rides only its own layer's key — the keychain pool the keychain key, the env KEY_POOL the env key, the page pool the
   page key — and a key a caller sent gets only a pool sent with it; a pool whose layer holds no key is unused. Trunk did
   NOT bind pools: the pushed pool and the env KEY_POOL rode any run key (a body key, another layer's key, no key), so a
   refused key rotated onto another layer's account (probes R1 and R6; the golden's D2 rows hold trunk's values).

   ADOPTION (S2, doneMeans 1). The desktop shell (src-tauri main.rs sidecar_command) starts the sidecar with
   STARNET_DESKTOP_SHELL=1 and hands it the OS keychain's provider keys and key pools as environment variables, each in BOTH
   spellings with one value (set_sidecar_branded_env): SKYNET_/STARNET_<keyEnv> (credentials.rs SIDECAR_PROVIDER_KEY_ENVS,
   and OPENROUTER_KEY) and SKYNET_/STARNET_KEY_POOL_<ID>. Left there, that copy outlived a removal in Settings: the shell
   deleted the keychain entry and pushed an empty key, and the environment went on serving the removed key to routines, to
   /api/providers and to every other reader. adoptSpawnCredentials moves each such pair into the keychain layer and deletes
   both spellings from the environment the host hands it (index.js: process.env, before anything else can copy it), so this
   store is the key's only holder and a push changes it everywhere at once. Only a pair the shell could have written is
   adopted: both spellings set to one non-empty value. One spelling, two different values, and a bare name are the user's
   own exports and stay in the env layer, where they survive a removal and the readout names them. Without the marker
   (bin/starnet.js, servers, CI, tests) nothing is adopted or deleted, so a headless env key behaves exactly as at trunk.
   Names alone cannot tell the two apart: STARNET_OPENROUTER_KEY is also the documented headless name.

     adoptSpawnCredentials(env, { desktopShell, profiles }) -> { desktopShell, keys, pools, names }
                                      under the marker, takes the shell's pairs out of `env` (deleted there); `profiles` is
                                      the registry's list; `names` the variables it deleted. Without it: nothing, untouched.
     makeCredentialStore(deps) -> store
       deps.profile(id)               the provider profile (registry getProviderProfile), null for an unknown id
       deps.normalize(value)          canonical id, unknown -> 'openrouter' (index.js normalizeProvider)
       deps.normalizeId(value)        canonical id, unknown -> '' (the registry's normalizeProviderId(value, ''))
       deps.usesCodex(id)             the ChatGPT sign-in, whose bearer this store never holds
       deps.linked()                  { url, apiKey } of the linked StarNet account
       deps.envFirst(names)           the first set name's value, trimmed: the bare name, then STARNET_/SKYNET_; '' when none
       deps.envName(names)            the variable envFirst(names) reads, '' when none: a readout, never a value (optional)
       deps.env(suffix)               STARNET_<suffix>, else SKYNET_<suffix> (index.js ENV)
       deps.page                      the page layer: { get(id) -> { key?, keyPool?, baseUrl? } | null }
       deps.spawn                     adoptSpawnCredentials' result: seeds the keychain layer's keys and pools at boot
       deps.alias                     (test sandboxes) the alias to seed; otherwise env('OPENROUTER_KEY') at boot, which
                                      after adoption holds only a branded OpenRouter key the shell did not write
       deps.onAlias(key)              told the keychain's OpenRouter key at boot and after every push that sets or clears it
       deps.hasCredential(id, k, url) whether that pair can run (index.js providerHasCredential), for presence()
       deps.keptEndpoints             { on, load() -> the saved file | undefined, save(envelope) -> bool proven }
       deps.warn(line)                one log line (never a key, a pool or a URL)
       deps.keychain                  { keys, pools, baseUrls }: the keychain layer's three maps, when the host hands in
                                      its own (the test sandboxes do, test/helpers/credential-store-sandbox.js)
     store.key(provider, explicitKey)                          the key a run goes out on        (providerRuntimeKey)
     store.baseUrl(provider, explicit, runKey, callerKey, inRequest)  the endpoint for that key (providerRuntimeBaseUrl)
     store.keyPool(provider, explicitPool, runKey)             the backup keys a run rotates onto (providerRuntimeKeyPool):
                                                               the pool sent with the caller's own key, else the pool of the
                                                               layer that holds runKey (S4)
     store.push(provider, patch, report)                       the shell's push (setProviderRuntimeConfig); -> id | null.
                                                               An empty key deletes the keychain key; when an environment
                                                               variable still supplies one, one log line names it. `report`
                                                               gets alternateCount (the pushed pool's size) and, when the
                                                               patch moved an endpoint, endpointPersisted
     store.presence(id)                                        what an unattended run would use (engineKeyPresence):
                                                               { saved, keySource, unattendedReady, credentialSource,
                                                               envName }. keySource keeps the page's vocabulary
                                                               ('environment' = keychain or env, 'station' = the page copy,
                                                               'none'); credentialSource names the one layer the station's
                                                               own key comes from: 'keychain' | 'environment' | 'page' |
                                                               'linked' | 'sign-in' | 'none', and envName the variable when
                                                               it is 'environment' (else null)
     store.stationHeld(provider, key)                          the keychain's, the env's or the page copy's own key, never
                                                               a backup key in a pool (channelKeyIsStationHeld)
     store.holds(provider, key)                                whether a station layer (keychain, env, page) holds exactly
                                                               this key for this provider, as its key OR in its pool while
                                                               it holds a key for that pool to ride (S3, S4)
     store.inFlight()                                          one run's watch over the keys its adapters send (S3, below):
                                                               { watch(adapter, provider, key, o) -> adapter,
                                                                 gone(adapter) -> provider id | '' }
     store.endpointIsForeign(provider, key, baseUrl)           (channelEndpointIsForeign)
     store.keptEndpoints()                                     the kept endpoints, by provider (desktopEndpointsHeld)
     store.loadKeptEndpoints()                                 boot: read the kept endpoints back (loadDesktopEndpoints)
     store.endpointNotHandedOver(id)                           (providerEndpointNotHandedOver)
     store.operatorKey(id), store.pageRidesWith(id, runKey), store.keepsEndpoint(id)
                                                               the trunk helpers above, by their new names (trunk's
                                                               providerFallbackKeyPool, which handed the env KEY_POOL to any
                                                               run key, is gone: S4)
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

  // a provider's key-pool variable, without its STARNET_/SKYNET_ prefix: KEY_POOL_<ID>, the id upper-cased with every other
  // character an underscore. The env layer reads it (layersOf) and the desktop shell writes it for each keychain
  // provider (main.rs sidecar_command), so adoption looks for the same name.
  function poolEnvName(id) { return 'KEY_POOL_' + String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_'); }
  // at most 8 distinct keys, trimmed, in order: every pool this store holds or hands out
  function cleanPool(list) { return Array.from(new Set(list.map(k => String(k || '').trim()).filter(Boolean))).slice(0, 8); }

  /* adoptSpawnCredentials(env, { desktopShell, profiles }) — the desktop shell's keys and key pools become the keychain
     layer's, and leave `env` (the header's ADOPTION). For each provider, the first keyEnv name whose two spellings hold one
     value is its keychain key; a later name holding that same value leaves env too (the same credential), and one holding
     another value stays (the shell writes one name per provider, so that is a user's own export, read below the keychain
     key). Its KEY_POOL pair is adopted the same way, comma-separated as the shell joins it. Pure apart from the deletes it
     makes in the object it is handed; never reads or returns anything else from it. */
  function adoptSpawnCredentials(env, opts) {
    const o = opts || {};
    const out = { desktopShell: o.desktopShell === true, keys: Object.create(null), pools: Object.create(null), names: [] };
    if (!out.desktopShell || !env || typeof env !== 'object') return out;
    // the value both spellings hold, when the shell could have written them (set_sidecar_branded_env); '' otherwise
    const pairOf = name => {
      const a = env['STARNET_' + name], b = env['SKYNET_' + name];
      return (typeof a === 'string' && a === b && a.trim()) ? a.trim() : '';
    };
    const take = name => {
      delete env['STARNET_' + name];
      delete env['SKYNET_' + name];
      out.names.push('STARNET_' + name, 'SKYNET_' + name);
    };
    for (const p of Array.isArray(o.profiles) ? o.profiles : []) {
      const id = String((p && p.id) || '');
      if (!id) continue;
      let key = '';
      for (const name of Array.isArray(p.keyEnv) ? p.keyEnv : []) {
        const value = pairOf(name);
        if (!value || (key && value !== key)) continue;
        key = value;
        take(name);
      }
      if (key) out.keys[id] = key;
      const pool = cleanPool(pairOf(poolEnvName(id)).split(','));
      if (pool.length) { out.pools[id] = pool; take(poolEnvName(id)); }
    }
    return out;
  }

  function makeCredentialStore(deps) {
    const d = deps || {};
    for (const name of REQUIRED) if (typeof d[name] !== 'function') throw new TypeError('makeCredentialStore: deps.' + name + ' must be a function');
    const profileOf = d.profile, normalize = d.normalize, normalizeId = d.normalizeId, usesCodex = d.usesCodex;
    const linked = d.linked, envFirst = d.envFirst, env = d.env;
    const envName = typeof d.envName === 'function' ? d.envName : () => '';
    const page = (d.page && typeof d.page.get === 'function') ? d.page : { get: () => null };
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : () => false;
    const onAlias = typeof d.onAlias === 'function' ? d.onAlias : () => {};
    const warn = typeof d.warn === 'function' ? d.warn : () => {};
    const kept = d.keptEndpoints || {};
    const keepsOn = kept.on === true;
    if (keepsOn && (typeof kept.load !== 'function' || typeof kept.save !== 'function')) throw new TypeError('makeCredentialStore: deps.keptEndpoints needs load and save');
    const layer = d.keychain || {};
    const keys = layer.keys || Object.create(null);           // provider id -> the keychain key (adopted at boot, then pushed)
    const pools = layer.pools || Object.create(null);         // provider id -> its alternate keys; never shared across providers
    const baseUrls = layer.baseUrls || Object.create(null);   // provider id -> the pushed endpoint

    // S2: the desktop shell's spawn keys and pools ARE the keychain layer from boot (adoptSpawnCredentials took them out of
    // the environment before this store was built)
    const spawn = d.spawn || {};
    for (const id of Object.keys(spawn.keys || {})) keys[id] = String(spawn.keys[id]);
    for (const id of Object.keys(spawn.pools || {})) pools[id] = cleanPool(spawn.pools[id]);

    // the legacy OpenRouter alias (STARNET_/SKYNET_OPENROUTER_KEY) is the keychain's OpenRouter key from boot, and every push
    // of an OpenRouter key replaces it; the host's runtimeKey mirror reads it through onAlias. A pair the shell wrote was
    // adopted above and has left the environment, so what seeds it here is an export the shell did not write (a headless
    // operator's, or a user's own on the desktop): still an environment variable, which the readout says while it serves.
    function alias() { return String(keys.openrouter || ''); }
    const seed = String((own(d, 'alias') ? d.alias : env('OPENROUTER_KEY')) || '').trim();
    if (seed) keys.openrouter = seed;
    let aliasFromEnv = !!seed;
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

    /* ---- key pools (S4, golden delta D2) ----
       A key pool is one layer's backup keys for ITS OWN key: the keychain pool rides only the keychain key, the
       environment's KEY_POOL_<ID> only the environment's key, the page copy's backups only the page's key. A run on any
       other key never rotates onto them (that is another account), and a pool whose layer holds no key is unused: the
       keychain pool after the shell's REMOVE (the shell keeps that slot), an env KEY_POOL with no env key. At trunk the
       pushed pool and the env KEY_POOL rode ANY run key, so a refused key rotated onto another layer's account at that key's
       endpoint (probe R1: the env pool behind the page key, at the page endpoint; R6: the keychain pool behind a body key).
       `explicitPool`: the pool a caller sent with its own key, taken as it is (runOnceCore passes it, or [] when the caller
       sent its key with none: a key the caller sent gets only a pool sent with it). `runKey` undefined = the station's own
       key (key()). When two layers hold the same key, the first in key order with backups serves; each is that key's own. */
    function keyPool(provider, explicitPool, runKey) {
      const id = normalize(provider);
      if (Array.isArray(explicitPool)) return cleanPool(explicitPool);
      const inUse = runKey === undefined ? key(id, '') : String(runKey || '').trim();
      const layer = inUse ? layersOf(id).find(l => l.keys.includes(inUse) && l.pool.length) : null;
      return layer ? layer.pool : [];
    }
    /* each station layer's own credential for a provider, in key order: the keys it holds and its backup keys. The keychain
       holds what the shell adopted or pushed; the OpenRouter alias an export seeded (STARNET_/SKYNET_OPENROUTER_KEY the
       shell did not write: aliasFromEnv) is the environment's, as presence() names it. The environment holds the variable
       envFirst reads and its KEY_POOL_<ID> (STARNET_, else SKYNET_). The page copy holds its key and its backups. */
    function layersOf(id) {
      const profile = profileOf(id);
      const kc = String(keys[id] || '').trim();
      const aliasIsEnv = id === 'openrouter' && aliasFromEnv;
      const copy = page.get(id) || {};
      const layer = (name, held, pool) => ({ name, keys: held.filter(Boolean), pool: cleanPool(Array.isArray(pool) ? pool : []) });
      return [
        layer('keychain', [aliasIsEnv ? '' : kc], own(pools, id) ? pools[id] : []),
        layer('environment', [aliasIsEnv ? kc : '', envFirst(profile && profile.keyEnv)], String(env(poolEnvName(id)) || '').split(',')),
        layer('page', [String(copy.key || '').trim()], copy.keyPool)
      ];
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
       `report` (optional): alternateCount, the size of the pool the shell pushed (S4: kept as the shell's slot, ridden only
       by the keychain key); endpointPersisted when the patch moved an endpoint — false = live now, NOT kept on disk */
    function push(provider, patch, report) {
      const id = normalizeId(provider);
      if (!id || !profileOf(id)) return null;
      patch = patch || {};
      if (own(patch, 'key')) {
        const k = String(patch.key || '').trim();
        if (k) keys[id] = k;
        else delete keys[id];
        if (id === 'openrouter') { aliasFromEnv = false; onAlias(alias()); }
        // decision 4: a REMOVE that leaves an environment variable serving this provider is said, naming the variable (the
        // /api/key answer and /api/providers say it too); the Settings page does not show it in this lane
        const after = k ? null : layerOf(id);
        if (after && after.credentialSource === 'environment') {
          const label = (profileOf(id) || {}).label || id;
          warn('[credentials] the ' + label + ' key was removed from this station\'s keychain, but ' +
            (after.envName ? 'the environment variable ' + after.envName : 'an environment variable') + ' still holds one, so ' + label +
            ' keeps running on it — unset it in the environment that starts StarNet to stop that');
        }
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
        const pool = cleanPool(Array.isArray(patch.keyPool) ? patch.keyPool : []);
        if (pool.length) pools[id] = pool;
        else delete pools[id];
      }
      // the push's answer counts the pool the shell pushed, whether or not a keychain key is there for it to ride (S4)
      if (report) report.alternateCount = own(pools, id) ? pools[id].length : 0;
      return id;
    }

    /* ---- readouts ---- */
    // what an unattended run of this provider would use RIGHT NOW — booleans and source names, never a value
    function presence(id) {
      const saved = page.get(id) || {};
      const operator = !!(String(keys[id] || '').trim() || operatorKey(id));
      const from = layerOf(id);
      return {
        saved: { key: !!saved.key, alternates: (saved.keyPool || []).length, baseUrl: !!saved.baseUrl },
        keySource: operator ? 'environment' : (saved.key ? 'station' : 'none'),
        unattendedReady: hasCredential(id, key(id, ''), baseUrl(id, '')),
        credentialSource: from.credentialSource,
        envName: from.envName
      };
    }
    // the ONE layer key(id, '') reads, named, and the variable when that is the environment (S2). A sign-in's bearer and
    // StarNet's device token are not keys this store holds for a run: they read 'sign-in' and 'linked' (or 'none').
    function layerOf(id) {
      const profile = profileOf(id);
      const named = (credentialSource, name) => ({ credentialSource, envName: name || null });
      if (usesCodex(id) || (profile && profile.authType === 'oauth_device_code')) return named('sign-in');
      if (id === 'starnet') return named(String(linked().apiKey || '').trim() ? 'linked' : 'none');
      if (String(keys[id] || '').trim()) {
        // the alias an export seeded (no push has replaced it): STARNET_ when that spelling is set, else SKYNET_, as env() reads
        return (id === 'openrouter' && aliasFromEnv) ? named('environment', envName(['STARNET_OPENROUTER_KEY', 'SKYNET_OPENROUTER_KEY'])) : named('keychain');
      }
      if (operatorKey(id)) return named('environment', envName(profile && profile.keyEnv));
      if (String((page.get(id) || {}).key || '')) return named('page');
      return named('none');
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

    /* ---- a key the station holds, and a run in flight (S3, decision 7) ----
       holds(provider, key): a station layer holds exactly this key for this provider — the keychain's key, the env layer's
       key (the variable envFirst reads, so a keychain push never hides it) or the page copy's key, or a key in the pool of
       a layer that holds a key of its own (S4: a pool whose layer holds no key is unused, so a run that rotated onto it
       stops once its layer's key is removed). Never another provider's, never a provider this station does not know, and
       never StarNet's linked token or a sign-in's bearer: those are not keys a layer here holds (layerOf). */
    function holds(provider, k) {
      const id = normalizeId(provider), v = String(k || '').trim(), profile = profileOf(id);
      if (!id || !v || id === 'starnet' || usesCodex(id) || (profile && profile.authType === 'oauth_device_code')) return false;
      return layersOf(id).some(l => l.keys.includes(v) || (l.keys.length > 0 && l.pool.includes(v)));
    }
    /* A run resolves its keys as it starts and builds one provider adapter on each (its primary, every backup key it may
       rotate onto, every provider fallback); each later call goes out on those, so a key removed or replaced mid-run kept
       billing until the run ended. inFlight() is one run's watch over them:
         watch(adapter, provider, key, o) -> adapter   the key `adapter` sends for `provider`. Watched only when a station
                     layer held it as the run resolved it (o.held when the run resolved it before it built the adapter; else
                     holds() now) and the run's caller did not send it in this request (o.sentByCaller: an /api/run body
                     key or pool, a fallback's own body key). A key no layer here held — a channel's own key, a caller's —
                     is the caller's, and a removal on this station is not about it.
         gone(adapter) -> provider id | ''   that provider, once no layer holds the watched key any longer; else ''.
       So only a REMOVE or a rotation of that very key, in every layer that held it, stops a run, or, for a backup key, the
       removal of the last key its layer held for its pool to ride (S4): the loop asks before each call (loop.js
       credentialGone), never mid-stream. */
    function inFlight() {
      const watched = new WeakMap();   // adapter -> [provider id, key]
      return {
        watch(adapter, provider, k, o) {
          const opts = o || {}, id = normalizeId(provider), v = String(k || '').trim();
          const held = own(opts, 'held') ? opts.held === true : holds(id, v);
          if (adapter && (typeof adapter === 'object' || typeof adapter === 'function') && id && v && held && opts.sentByCaller !== true) watched.set(adapter, [id, v]);
          return adapter;
        },
        gone(adapter) {
          const w = adapter && (typeof adapter === 'object' || typeof adapter === 'function') ? watched.get(adapter) : undefined;
          return (w && !holds(w[0], w[1])) ? w[0] : '';
        }
      };
    }

    return {
      key, operatorKey, keyPool, pageRidesWith, baseUrl,
      keepsEndpoint, endpointNotHandedOver, keptEndpoints, loadKeptEndpoints, saveKeptEndpoints,
      push, presence, stationHeld, endpointIsForeign, alias, keychainValues, holds, inFlight
    };
  }

  return { makeCredentialStore, adoptSpawnCredentials };
});
