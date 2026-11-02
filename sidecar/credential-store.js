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
                environment. No host mirror of it remains (S6: index.js's runtimeKey is gone; every station-side OpenRouter
                consumer asks credentialFor). Its endpoints are kept across restarts as URLs only
                (.secrets/provider-endpoints.json v1) on a station whose shell pushes provider config (deps.keptEndpoints).
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
       deps.page                      the page layer: { get(id) -> { key?, keyPool?, baseUrl? } | null, secretValues()? -> every
                                      saved record's key and backups, for redaction }
       deps.spawn                     adoptSpawnCredentials' result: seeds the keychain layer's keys and pools at boot
       deps.alias                     (test sandboxes) the alias to seed; otherwise env('OPENROUTER_KEY') at boot, which
                                      after adoption holds only a branded OpenRouter key the shell did not write
       deps.hasCredential(id, k, url) whether that pair can run (index.js providerHasCredential), for presence() and the
                                      realtime voice's readiness (consumerDeps)
       deps.keptEndpoints             { on, load() -> the saved file | undefined, save(envelope) -> bool proven }
       deps.warn(line)                one log line (never a key, a pool or a URL)
       deps.keychain                  { keys, pools, baseUrls }: the keychain layer's three maps, when the host hands in
                                      its own (the test sandboxes do, test/helpers/credential-store-sandbox.js)
       deps.providerIds()             every provider id the registry knows: the env and page layers secretValues reads
       deps.shapes                    how a credential LOOKS (secret-values.js SECRET_SHAPES): { name(n) a credential name,
                                      token(v) a token-like run, credential(v) a token or a vendor key shape }
       deps.now()                     the host's clock in ms (optional): with it secretValues reads the environment layer at
                                      most once a second (REDACTION below); without it, on every call
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
     store.alias()                                             the keychain's OpenRouter key (what trunk's runtimeKey alias
                                                               held; the golden reads it, and credentialFor's rank names it)
     store.keychainValues()                                    { keys, pools }: the keychain layer's values (the golden
                                                               reads them; redaction reads secretValues, which holds them)
     store.secretValues({ childEnv }) -> string[]              every value this store holds that is a secret (S5, below)
     store.urlSecretParts(url) -> string[]                     the credential parts of an endpoint URL, never the whole URL
     store.maskedUrl(url)                                      that URL with each of those parts masked in place
     store.credentialFor(provider) -> { key, baseUrl, rank, source }   the station's own credential for a station-side
                                                               consumer (S6, below): its key, the endpoint saved with it, its
                                                               rank ('primary' | 'gap') and the layer it comes from
     store.endpointFor(provider, key)                          the endpoint for a key a consumer is about to send ('' for a
                                                               provider this station does not know)
     store.consumerDeps() -> { media, realtime, imageRoute(), webRung(run) }   every module-level dialer's credential
                                                               dependencies, built here once (S6, below)

   CONSUMERS (step S6, doneMeans 2). A station-side consumer of a provider credential — the voice legs, Live Voice, the
   image route, web_search's paid OpenRouter rung — used to read whichever source its own code named: STT only the legacy
   OpenRouter alias (so a key a browser page saved, or a bare OPENROUTER_API_KEY, never reached it, probe P2), the web rung
   only the run's own OpenRouter key or the alias (index.js), the image route the alias and then a second rung for every
   other source (#146); and each dialed a host its code hard-coded (https://openrouter.ai for STT, TTS and the web rung)
   or the endpoint of the STATION's key beside a key the page sent (TTS), whatever endpoint that key was saved with. Now
   each takes its key, and the endpoint saved with that key, from this store:
     credentialFor(id)     the station's own choice (key(id, '')), the endpoint baseUrl resolves for it, and its RANK
                           (decision 1): 'primary' when the key is the keychain layer's — the desktop shell's key, a push,
                           and the branded STARNET_/SKYNET_OPENROUTER_KEY export the alias seeded, exactly what trunk's
                           runtimeKey held — and 'gap' for any other layer (a bare OPENROUTER_KEY or OPENROUTER_API_KEY,
                           the page copy). A 'gap' credential only fills gaps: last in the image route, after the local
                           engine in the STT ladder, and never what /api/stt/status prefers, so nobody's image or speech
                           billing moves. With no key there is no credential: { key: '', baseUrl: '', rank: 'gap' }.
     endpointFor(id, key)  baseUrl(id, '', key): the endpoint of the layer that holds that key, or a station-wide
                           override (the keychain endpoint, the env URL), else the profile default — never the endpoint
                           saved with another key. A page key sent with one request gets the endpoint that key resolves
                           to, not the station key's. No voice leg carries an endpoint of its own, so what baseUrl's
                           inRequest decides, whether an endpoint sent beside a key rides it, never arises here.
     consumerDeps()        the dependencies each module-level dialer is built with, here so index.js and the census test
                           (test/credential-store.no-crossing.test.js) build them from the same function:
       media               { providerRuntimeKey, endpointFor, credentialFor } (media-service.js): the TTS chain and STT's
                           Groq and OpenAI legs take the station's own key, every keyed leg dials endpointFor(provider, the
                           key it sends), and STT's OpenRouter leg takes credentialFor('openrouter') by its rank
       realtime            { hasCredential(id), nativeVoiceBlocker(id) } (realtime-voice.js): native Live Voice dials the
                           registry's realtime URL only for a key saved with the profile's default endpoint; the blocker
                           is the sentence that says why not ('' = native is fine), and composed voice serves. A sign-in
                           holds no key here, and its bearer is minted for that URL, so it is never blocked
       imageRoute()        the station's own image credentials for image-task.js resolveRoute: the linked account, the
                           OpenRouter credential with its rank, the OpenAI key with its endpoint
       webRung(run)        web_search's paid OpenRouter rung for one run ({ providerId, runKey, baseUrl, model }), or null:
                           on an OpenRouter run the run's own key and endpoint (and its model); on any other run
                           credentialFor('openrouter') with no model, so web.js sends OpenRouter's search model; never on a
                           StarNet-credits run (decision 2: the image route's rule — a credits run never spends a BYOK key)

   REDACTION (step S5). secretValues() is the provider part of index.js's held list (stationSecretValues), which feeds the
   known-value layer (context.js redact: the run stream, transcripts, diagnostics) and the prompt scrub (prompt-scrub.js):
   each layer's keys and key pools — the keychain's (the shell's adopted and pushed keys, and the OpenRouter alias however
   it was seeded), the environment's (the variable envFirst reads, and its KEY_POOL_<ID>) and the page copy's — and the
   credential parts of every endpoint a layer holds (urlSecretParts): the keychain's, the environment's URL variable and the
   page copy's. At trunk the environment's keys and pools and every endpoint were missing, so a provider key with no vendor
   prefix set in the environment (MISTRAL_API_KEY), a backup key in KEY_POOL_<ID> and a token inside CUSTOM_OPENAI_BASE_URL
   reached the run stream, transcripts and diagnostics raw whenever a model or a server echoed them, and GET /api/providers
   answered the endpoint whole (probe P4, probe-providers-echo); it now answers maskedUrl. A whole URL is never held, so a
   local server's address stays readable in every text. Decision 8: the environment's key and backups of a provider that
   takes no key (CUSTOM: keyRequired false) are held only when they look like a credential (shapes.credential), because a
   local server's placeholder key (lm-studio, not-needed, anything) is ordinary text a tool result or a prompt must keep; a
   keyed provider's env key is held whole, and the keychain's and the page copy's values are held whole, as at trunk.
   secretValues({ childEnv: true }) is what child-env.js strips from a helper process's environment by value: the
   keychain's and the page copy's keys and pools, the values trunk held. The environment's keys, pools and URLs are the
   user's own exports (a variable holding one is theirs), so a host helper (git, the claude CLI) sees them as at trunk; the
   OpenRouter alias an STARNET_/SKYNET_OPENROUTER_KEY export seeded is a keychain value here, so a user's OPENROUTER_API_KEY
   holding it is still stripped, as at trunk. Named change (S2): an adopted keychain key is in that list from boot, where
   trunk listed it only once the shell had pushed it, so a user's own variable holding that very key is stripped as well.

   Pure: no fs, no process.env, no clock; the host injects all three. UMD, no dependencies. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.credentialStore = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const REQUIRED = ['profile', 'normalize', 'normalizeId', 'usesCodex', 'linked', 'envFirst', 'env', 'providerIds'];
  const SHAPES = ['name', 'token', 'credential'];
  const MASK = '[redacted-secret]';   // the marker context.js redact() writes over a known value

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
    for (const name of SHAPES) if (!d.shapes || typeof d.shapes[name] !== 'function') throw new TypeError('makeCredentialStore: deps.shapes.' + name + ' must be a function');
    const profileOf = d.profile, normalize = d.normalize, normalizeId = d.normalizeId, usesCodex = d.usesCodex;
    const linked = d.linked, envFirst = d.envFirst, env = d.env, providerIds = d.providerIds, shapes = d.shapes;
    const now = typeof d.now === 'function' ? d.now : null;
    const envName = typeof d.envName === 'function' ? d.envName : () => '';
    const page = (d.page && typeof d.page.get === 'function') ? d.page : { get: () => null };
    const hasCredential = typeof d.hasCredential === 'function' ? d.hasCredential : () => false;
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
    // of an OpenRouter key replaces it (credentialFor ranks it 'primary', as trunk's runtimeKey ranked). A pair the shell
    // wrote was adopted above and has left the environment, so what seeds it here is an export the shell did not write (a
    // headless operator's, or a user's own on the desktop): still an environment variable, which the readout says while
    // it serves.
    function alias() { return String(keys.openrouter || ''); }
    const seed = String((own(d, 'alias') ? d.alias : env('OPENROUTER_KEY')) || '').trim();
    if (seed) keys.openrouter = seed;
    let aliasFromEnv = !!seed;

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
        if (id === 'openrouter') aliasFromEnv = false;
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

    /* ---- what this store holds, for redaction (S5; the header's REDACTION) ---- */
    function secretValues(o) {
      const childEnv = !!(o && o.childEnv === true);
      const out = new Set();
      const hold = v => { const s = String(v == null ? '' : v).trim(); if (s) out.add(s); };
      const ids = idList();
      // the keychain layer (the shell's adopted and pushed keys and backups, the OpenRouter alias however it was seeded) and
      // the page copy (every saved record's key and backups), whole: the values trunk held, read live
      for (const id of Object.keys(keys)) hold(keys[id]);
      for (const id of Object.keys(pools)) for (const k of pools[id] || []) hold(k);
      if (typeof page.secretValues === 'function') for (const v of page.secretValues() || []) hold(v);
      const copies = ids.map(id => page.get(id) || {});
      for (const c of copies) { hold(c.key); for (const k of c.keyPool || []) hold(k); }
      if (childEnv) return Array.from(out);
      // the credential parts of the keychain's and the page copy's endpoints (live), then the environment layer's values
      for (const id of Object.keys(baseUrls)) for (const part of urlSecretParts(baseUrls[id])) hold(part);
      for (const c of copies) for (const part of urlSecretParts(c.baseUrl)) hold(part);
      for (const v of envHeld(ids)) hold(v);
      return Array.from(out);
    }
    function idList() { const v = providerIds(); return Array.isArray(v) ? v : []; }
    /* The ENVIRONMENT LAYER's held values: each provider's key (the variable envFirst reads) and KEY_POOL_<ID> entries, and
       the credential parts of its URL variable. Decision 8: the key and backups of a provider that takes no key
       (keyRequired false: CUSTOM) only when shaped like a credential (shapes.credential), so a local server's placeholder
       key (lm-studio, not-needed, anything) stays ordinary text; a keyed provider's are held whole. redact() asks for the
       held list on every call, which is every token frame of a run's stream, and reading every provider's variables costs
       about a hundred environment lookups (tens of microseconds on Windows, several times a frame's own redaction). The
       environment cannot change from outside a running process, and nothing in the sidecar writes a provider's key, pool
       or URL variable after boot (adoption runs before this store is built; servicekeys never writes a provider key
       name), so with the host's clock (deps.now) this part is read at most once a second; without one, on every call.
       The keychain's and the page copy's values above, which a push or a page save changes, are always read live. */
    const ENV_FRESH_MS = 1000;
    let envMemo = null;   // { at, values }
    function envHeld(ids) {
      const t = now ? Number(now()) : NaN;
      if (envMemo && t >= envMemo.at && t - envMemo.at < ENV_FRESH_MS) return envMemo.values;
      const values = [];
      for (const id of ids) {
        const profile = profileOf(id);
        if (!profile) continue;
        const keyed = profile.keyRequired !== false;
        for (const v of [envFirst(profile.keyEnv)].concat(String(env(poolEnvName(id)) || '').split(','))) {
          const s = String(v || '').trim();
          if (s && (keyed || shapes.credential(s))) values.push(s);
        }
        for (const part of urlSecretParts(envFirst(profile.baseUrlEnv))) values.push(part);
      }
      envMemo = Number.isFinite(t) ? { at: t, values } : null;
      return values;
    }
    /* An endpoint URL's CREDENTIAL PARTS, as [from, to) spans of the trimmed string: the password before the host (to the
       authority's LAST '@': a password may hold one) and a user name there shaped like a token (https://<token>@host); a
       path segment shaped like a token (/t/<token>/v1); a query or fragment parameter named like a credential (api_key,
       key, token, sig: shapes.name) or whose value is shaped like a token. Shaped like a token: a run of 20 or more letters
       and digits holding both (shapes.token). The scheme, the host, the port, an ordinary path and a parameter such as
       api-version=2024-02-01 are never a part. A string that is not a URL splits as far as it goes. */
    function credentialSpans(s) {
      const spans = [];
      const tokenLike = v => shapes.token(unescaped(v));
      const upTo = (from, chars, limit) => {   // the first index at or after `from` that holds one of `chars`, else limit
        const end = limit === undefined ? s.length : limit;
        for (let i = from; i < end; i++) if (chars.indexOf(s[i]) >= 0) return i;
        return end;
      };
      const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(s);
      const from = scheme ? scheme[0].length : 0;
      const hostEnd = upTo(from, '/?#');
      const at = s.lastIndexOf('@', hostEnd - 1);
      if (at >= from) {
        const colon = s.indexOf(':', from);
        const userEnd = colon >= 0 && colon < at ? colon : at;
        if (userEnd > from && tokenLike(s.slice(from, userEnd))) spans.push([from, userEnd]);
        if (at > userEnd + 1) spans.push([userEnd + 1, at]);
      }
      const pathEnd = upTo(hostEnd, '?#');
      for (let i = hostEnd; i < pathEnd;) {   // the path starts at a '/' (hostEnd is one, or pathEnd itself)
        const start = i + 1, end = upTo(start, '/', pathEnd);
        if (end > start && tokenLike(s.slice(start, end))) spans.push([start, end]);
        i = end;
      }
      const params = (a, b) => {   // name=value pairs between & or ; (a bare value has no name)
        for (let i = a; i < b;) {
          const end = upTo(i, '&;', b), eq = upTo(i, '=', end);
          const valueAt = eq < end ? eq + 1 : i;
          if (end > valueAt && ((eq < end && shapes.name(unescaped(s.slice(i, eq)))) || tokenLike(s.slice(valueAt, end)))) spans.push([valueAt, end]);
          i = end + 1;
        }
      };
      const hash = upTo(pathEnd, '#');
      if (s[pathEnd] === '?') params(pathEnd + 1, hash);
      if (hash < s.length) params(hash + 1, s.length);
      return spans;
    }
    // printable-ASCII percent escapes decoded (a token's +, / and = are often escaped); any other escape stays as written,
    // so this never throws
    function unescaped(v) { return v.replace(/%([2-7][0-9A-Fa-f])/g, (m, hex) => String.fromCharCode(parseInt(hex, 16))); }
    // each credential part as written, and decoded when that differs (a server may echo either)
    function urlSecretParts(url) {
      const s = String(url == null ? '' : url).trim(), out = [];
      for (const [a, b] of credentialSpans(s)) {
        const raw = s.slice(a, b), plain = unescaped(raw);
        out.push(raw);
        if (plain !== raw) out.push(plain);
      }
      return out;
    }
    // the URL with each credential part masked where it stands (GET /api/providers' currentBaseUrl): the rest reads as saved
    function maskedUrl(url) {
      const s = String(url == null ? '' : url).trim();
      return credentialSpans(s).reverse().reduce((t, [a, b]) => t.slice(0, a) + MASK + t.slice(b), s);
    }

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

    /* ---- what a station-side consumer sends, and where (S6; the header's CONSUMERS) ---- */
    const trimSlash = u => String(u || '').trim().replace(/\/+$/, '');
    function credentialFor(provider) {
      const id = normalizeId(provider);
      const k = id && profileOf(id) ? key(id, '') : '';
      if (!k) return { key: '', baseUrl: '', rank: 'gap', source: 'none' };
      return { key: k, baseUrl: baseUrl(id, '', k), rank: k === String(keys[id] || '').trim() ? 'primary' : 'gap', source: layerOf(id).credentialSource };
    }
    function endpointFor(provider, k) {
      const id = normalizeId(provider);
      return id && profileOf(id) ? baseUrl(id, '', String(k || '').trim()) : '';
    }
    // native Live Voice only for a key saved with the profile's default endpoint (decision 6): '' = fine. No key (nothing
    // connected, or a sign-in, whose bearer this store never holds) leaves that answer to realtime-voice.js.
    function nativeVoiceBlocker(provider) {
      const id = normalize(provider), profile = profileOf(id);
      if (!profile || !profile.liveVoice) return '';
      const saved = credentialFor(id);
      if (!saved.key || trimSlash(saved.baseUrl) === trimSlash(profile.baseUrl)) return '';
      const name = profile.name || id;
      return 'native Live Voice is not offered for this ' + name + ' key: it was saved with another endpoint, and native voice only goes to ' + name + '\'s own. ' +
        'Composed voice serves; save the key with the default endpoint for native voice.';
    }
    function imageRoute() {
      const or = credentialFor('openrouter'), oa = credentialFor('openai');
      return {
        managedKey: key('starnet', ''), managedBaseUrl: baseUrl('starnet', ''),
        stationOpenRouterKey: or.key, stationOpenRouterBaseUrl: or.baseUrl, stationOpenRouterRank: or.rank,
        stationOpenAIKey: oa.key, stationOpenAIBaseUrl: oa.baseUrl
      };
    }
    function webRung(run) {
      const r = run || {};
      const id = normalizeId(r.providerId);
      if (id === 'starnet') return null;   // decision 2: a credits run never spends a BYOK key
      if (id === 'openrouter') {
        const k = String(r.runKey || '').trim();
        return k ? { apiKey: k, baseUrl: String(r.baseUrl || '').trim() || endpointFor(id, k), model: r.model } : null;
      }
      const or = credentialFor('openrouter');
      return or.key ? { apiKey: or.key, baseUrl: or.baseUrl } : null;
    }
    function consumerDeps() {
      return {
        media: { providerRuntimeKey: key, endpointFor, credentialFor },
        realtime: { hasCredential: provider => !!hasCredential(provider, key(provider, ''), baseUrl(provider, '')), nativeVoiceBlocker },
        imageRoute,
        webRung
      };
    }

    return {
      key, operatorKey, keyPool, pageRidesWith, baseUrl,
      keepsEndpoint, endpointNotHandedOver, keptEndpoints, loadKeptEndpoints, saveKeptEndpoints,
      push, presence, stationHeld, endpointIsForeign, alias, keychainValues, holds, inFlight,
      secretValues, urlSecretParts, maskedUrl,
      credentialFor, endpointFor, consumerDeps
    };
  }

  return { makeCredentialStore, adoptSpawnCredentials };
});
