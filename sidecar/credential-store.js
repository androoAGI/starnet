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
     channel    a chat channel's own credential, bound to its record and its provider (step S8, CHANNELS below). Outside the
                order: it serves only that bot's runs on that provider, the way a key a caller hands one run does.
   KEY order: explicit > keychain > env (OpenRouter: the alias first) > page, the order layersOf holds, read past the first
   key only for the complete pair below; starnet is linked only; a codex sign-in has no key here. Golden delta D1 (S2): under
   the desktop shell the keychain key outranks a bare OS export of the same provider (ANTHROPIC_API_KEY set for another
   tool), because the shell's key is adopted into the keychain layer; at trunk
   envFirst read the bare name before the shell's spelling, so the OS key won (probe R5; decision 4). ENDPOINT order
   (baseUrl): starnet linked; a sign-in never takes an explicit endpoint; an explicit endpoint only with the caller's own
   key or a key sent in this request; the keychain endpoint; the page endpoint only with the page's own key; the env URL; a
   keyless page endpoint only for a keyless run; the profile default. POOLS (keyPool, step S4, golden delta D2): a pool
   rides only its own layer's key — the keychain pool the keychain key, the env KEY_POOL the env key, the page pool the
   page key — and a key a caller sent gets only a pool sent with it; a pool whose layer holds no key is unused. Trunk did
   NOT bind pools: the pushed pool and the env KEY_POOL rode any run key (a body key, another layer's key, no key), so a
   refused key rotated onto another layer's account (probes R1 and R6; the golden's D2 rows hold trunk's values).

   COMPLETE PAIRS (step S7, doneMeans 3, golden deltas D3 and D4; gh#137, gh#113). key(id, '') and baseUrl(id, '') were two
   answers: the first layer's key, and the endpoint that key could use. CUSTOM has no default endpoint, so an operator's
   CUSTOM_OPENAI_KEY=E with no env URL, beside the page's saved pair {K, U}, resolved {E, ''}, and every routine was refused
   "no CUSTOM base URL is saved on this station" with U sitting saved (probe P3b). Sending E to U is the crossing this store
   forbids: U was saved for K. Now the station's own choice (stationChoice) is ONE pair: the first layer, in key order, whose
   key has a usable endpoint, used whole. A provider that needs a base URL (profile.requiresBaseUrl) looks past a key with no
   endpoint to the first lower layer with both; any other provider has its default and keeps its first key, so only runs
   trunk refused change, and a page key never outranks a usable env key. key(id, '') and baseUrl(id, '') read that one
   choice, and so do presence, the readout and keyPool, so a gate and the run it admits agree on every surface that hands a
   key on (cron-driver.js, Run Now, line hops, a channel with no key of its own, /v1, workers, the Doctor): each sends K to U,
   never E.
   D3 lists the rows. A keyless lower pair replaces nobody's key: E plus a URL the page saved with no key is refused, and
   the refusal names E as the half with no endpoint and both exits (D4, decision 5, probe P3c; resolve's missing 'unpaired',
   engine-credential.js). A key a caller passes is never swapped: with no usable endpoint it is refused. And baseUrl never
   hands a key an endpoint a layer saved for another key, except the two station-wide overrides (the keychain endpoint, the
   env URL): with runKey undefined it asks about the caller's own key, the shape a hub's secrets(), the fallback loop and
   the catalog use, which at trunk read the page copy against the STATION's key, so a channel's own key or a fallback's
   went to the page's endpoint. PR #141 was read only as the users' spec; its rule sent E to U.

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
       deps.channels                  the channel layer's file and record hooks (optional; without it the layer is memory only):
                                      { load() -> readJsonResilient's { status, value }, save(envelope) -> bool proven,
                                      verify(envelope) -> whether both copies on disk hold exactly this, newBind() -> a fresh
                                      stamp, keepsKeys() -> false on the desktop (a key stays out of the file),
                                      record(id) -> the live record/view (optional; the host supplies it lazily for conversions),
                                      follow(ids) -> bool proven: those records hold a station reference now }
       deps.digest(text)              a one-way digest (optional; index.js: SHA-256 hex): how the store remembers a key a layer
                                      let go of without keeping the key (S3, below). Without it, a pure 64-bit FNV-1a
     store.key(provider, explicitKey)                          the key a run goes out on        (providerRuntimeKey)
     store.baseUrl(provider, explicit, runKey, callerKey, inRequest)  the endpoint for that key (providerRuntimeBaseUrl)
     store.resolve(provider, ctx) -> { key, keyPool, baseUrl, source, endpointSource, rank, complete, missing }   a run's whole
                                                               credential at once; ctx { explicitKey, explicitBaseUrl,
                                                               explicitPool, inRequest, channel }, none = the station's own
                                                               choice; channel: a bot's credential as channel() reads it.
                                                               source: credentialSource's words, 'explicit' or 'channel'.
                                                               endpointSource: 'explicit' | 'keychain' | 'page' | 'environment'
                                                               | 'linked' | 'default' | 'none'. missing: '' | 'key' | 'baseUrl'
                                                               | 'unpaired' (an env key with no endpoint) | 'channel-key' (a
                                                               bot's own key this station no longer holds), a credentialError kind
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
     store.fromStation(provider, key)                          a key the station resolved for a run: a layer holds it, or held it
                                                               until a REMOVE or a rotation; never a channel's own key (S3)
     store.admitRun(options, provider)                         host-private ownership of an already resolved key, before a queue
     store.admittedFromStation(options, provider, key)         that admission's ownership for the same pair, else fromStation
     store.inFlight()                                          one run's watch over the keys its adapters send (S3, below):
                                                               { watch(adapter, provider, key, o) -> adapter,
                                                                 gone(adapter) -> provider id | '' }
     store.endpointIsForeign(provider, key, baseUrl)           whether that endpoint is one the page copy's key was not saved with
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
     store.putPage(provider, input, o)                         the page's copy (engine-key): page.put, then the channels it
                                                               turns into followers of the station (S8, below)
     store.channel(id, record) -> { key, baseUrl, keyLost }    a bot's own credential (S8, below); keyLost: '' | 'session' | 'gone'
                                                               | 'unreadable' (the channel file cannot be read right now)
     store.putChannel(id, { provider, key, baseUrl }) -> { credential, persisted, keyPersisted }   what a connect or a sync saves
     store.dropChannel(id) -> bool proven                      a forget: false while the channel file cannot be read
     store.settleChannels(rows) -> bool proven                 the records proven on disk (and, after a save that failed, those in
                                                               memory): each entry keeps the versions they name (S8, below)
     store.reconcileChannels(rows, { recovered }) -> { credentials, moved, followers, refused, orphans, pending, finish(saved) }
                                                               the boot's reconciliation (S8, below)
     store.carriedChannels()                                   what records still carry, by record id, because their move failed

   CONSUMERS (step S6, doneMeans 2). A station-side consumer of a provider credential — the voice legs, Live Voice, the
   image route, web_search's paid OpenRouter rung — used to read whichever source its own code named: STT only the legacy
   OpenRouter alias (so a key a browser page saved, or a bare OPENROUTER_API_KEY, never reached it, probe P2), the web rung
   only the run's own OpenRouter key or the alias (index.js), the image route the alias and then a second rung for every
   other source (#146); and each dialed a host its code hard-coded (https://openrouter.ai for STT, TTS and the web rung)
   or the endpoint of the STATION's key beside a key the page sent (TTS), whatever endpoint that key was saved with. Now
   each takes its key, and the endpoint saved with that key, from this store:
     credentialFor(id)     the station's own choice (resolve(id)), the endpoint saved with it, and its RANK
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

   CHANNELS (step S8; family B1). A channel record kept its bot's provider key and endpoint, so a rotated key stayed in
   channels/secrets.json and its .bak and the bot went on spending it (probe-channel-key), a key a sync replaced lingered in the
   .bak (probe-channel-sync), and a bot's own key the page later saved was stranded by the next rotation (channels TODO 3). A
   record now holds credential: { ref, bind } and nothing else of the kind (channels/secrets.js). ref 'station': the bot follows
   the station's credential for its provider, live. ref 'channel': the bot has an entry here, in
   .secrets/channel-credentials.json v1 { version: 1, channels: { <record id>: { provider, bind, ownKey, key?, baseUrl?, rev,
   prev? } } }, written main and .bak with both read back, as the page copy is. An entry holds the bot's own key, its own URL-only
   endpoint, or both; bind stamps it to its record, so an older build's rewrite or forget leaves an orphan the next boot can tell.
     A CHANGE LANDS WITH ITS RECORD (review r1). A connect, a sync or a bot add hands putChannel the new credential before the
   record that names it is saved. The new version is written under a bind of its own, with the version the saved record names
   kept beside it as `prev` (same fields, with its own `prev` while earlier changes remain unproven), and channel() serves whichever
   version a record names. settleChannels drops only versions no proven disk record or live record names
   once a record is proven on disk (index.js saveChannelSecrets after its read-back; after a save that failed and a route that
   rolled its record back, against the file a boot would read); a boot keeps the version its loaded record names (BOOT step 0).
   So a record save that fails, or a station that stops between the two, leaves the record that was saved naming a version that
   is there: neither key is lost, and a route that answered "nothing was started" changed nothing. At 86ff765db the new entry was
   written over the old one at once: a failed or interrupted provider switch left the old record naming a bind nobody held, and
   the next boot deleted the new entry as an orphan, so neither key was left; on the same provider the bot came back on the new
   key. A station reference takes effect the same way: its entry goes once a record that says so is proven saved. Every unproven
   version stays until that read-back: a failed save may have landed, so keeping only the first and last versions loses a key
   the authoritative record can still name (review r2).
     On the desktop an entry never holds a key (decision 3): the OS keychain has no slot for one, so ownKey: true says the bot was
   given one, which lives in memory for the session, and connect answers keyPersisted: false. A URL is not a key and is kept.
     RESOLUTION (channel()). An own key is an explicit key for that provider only: never swapped, no station pool, and its own
   endpoint rides it. An endpoint-only entry serves only a keyless run, as a record's endpoint did. An own key that was not
   kept (the desktop after a restart: keyLost 'session') or an entry that is gone ('gone') is REFUSED with the sentence
   (engine-credential.js 'channel-key', state 5): the bot never moves onto the station's key, which is another account. While the
   channel file cannot be read (an antivirus scan or a backup agent holding it open), a bot whose record names an entry is refused
   with a sentence of its own ('unreadable'): its key is not gone, the file is read again with the next message, and the log says
   it once (review r1: it read as 'gone', "reconnect it").
     WHOSE KEY IT IS: one test on every path (the connect, a conversion, the boot), stationHeld, the one the connect gate's
   channelConnectCredential asks: a key a station layer holds AS ITS KEY (the keychain's, the environment's, the page copy's) is
   the station's, and the bot follows it. A backup key in a layer's pool is not: the bot keeps the key it was given as its own,
   so the key the connect proved is the key the bot runs (review r1: these paths counted a pool entry as the station's, and a bot
   given a station backup key ran on the station's primary, another account, and was refused once the page removed its copy).
     CONVERSION (convertChannels). A push or a page save that makes a key station-held turns every entry holding that key for that
   provider into a station reference at once, so a later rotation reaches the bot with no sync and no restart (TODO 3). Its
   endpoint stays as an endpoint-only entry, unless the page copy's key was saved with another one (endpointIsForeign) or it
   is the one the station resolves for that key anyway. The record changes first: a crash then leaves an orphan the next
   boot deletes, never a bot with no key.
     BOOT (reconcileChannels, every boot, safe to run again; index.js reconcileChannelCredentials drives it). Rows are the records.
     0. An entry with a change still waiting for its record: the version the loaded record names stands, and the other goes.
     1. A record that still carries a key or an endpoint (an older build wrote it):
        a. loaded from .bak, with an entry for its provider: the entry is newer and stands, and the record binds to it;
        b. its key is station-held (a layer's key, not a backup): dropped, with an endpoint it was not saved with. Any other
           endpoint becomes an endpoint-only entry; with none left the record becomes a station reference;
        c. else the entry is written and read back BEFORE the record changes. A key read from the main file is the newest,
           because this build never writes one there, so it replaces the entry.
     2. ref 'channel' with a matching entry: an entry whose key has become station-held converts, as above. Else it stays.
     3. ref 'channel' with none: the record stays, its bot is refused, and its id is logged.
     4. No credential field and nothing carried: an older build's record, or one it rewrote (probe R2: trunk's auto-start
        rebuilds a record from a fixed field list). It ran the bot on the station's key, so the record becomes a station reference
        and its entry goes.
     5. An entry whose record is gone or carries another bind is deleted, once the records are saved (finish): this sweeps a
        forget on an older build.
   An unreadable file is left alone: nothing moves from it and nothing is deleted because of it, and a forget answers false until it
   can be read (dropChannel), so no route claims a key gone that it could not see. A failed write moves nothing:
   the bot runs on what its record carried, which the store holds in memory (carried) and index.js's every save keeps on the
   record, and the next boot tries again. So a key reaches the new file before it leaves the old one, and a crash at any step
   leaves it in at least one durable file; a .bak recovery never rolls a newer entry back; and running this twice changes
   nothing. index.js sweeps secrets.json.bak after it. PRE-UPDATE BACKUPS skip .secrets/, so a backup restored to another machine
   brings the reference and not the key, and that bot is refused until it is reconnected.

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
   keychain's and the page copy's keys and pools, the values trunk held, and each channel's own key, which trunk held from
   its record (S8; a channel's endpoint parts join secretValues() only). The environment's keys, pools and URLs are the
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
  // the digest of a string when the host hands none (test sandboxes; index.js hands SHA-256): two FNV-1a lanes, 64 bits, pure
  function fnv(text) {
    const s = String(text);
    let a = 0x811c9dc5, b = 0x050c5d1f;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0;
      b = Math.imul(b ^ c, 0x01000197) >>> 0;
    }
    return ('0000000' + a.toString(16)).slice(-8) + ('0000000' + b.toString(16)).slice(-8);
  }

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

    const trimSlash = u => String(u || '').trim().replace(/\/+$/, '');
    const chan = d.channels || {};
    let bindSeq = 0;
    const newBind = () => (typeof chan.newBind === 'function' ? String(chan.newBind()) : 'bind-' + (++bindSeq));
    const keepsChannelKeys = () => typeof chan.keepsKeys !== 'function' || chan.keepsKeys() !== false;
    const entries = Object.create(null);   // record id -> { provider, bind, ownKey, key?, baseUrl?, rev }: the channel layer
    const carried = Object.create(null);   // record id -> { provider, key, baseUrl }: what a record carries whose move failed
    let channelFile = 'unloaded';          // what the last read of the channel file found (readJsonResilient's status)
    let saidUnreadable = false;            // the log has said the channel file could not be read, and it still cannot

    /* ---- keys ---- */
    function key(provider, explicitKey) {
      const id = normalize(provider);
      if (usesCodex(id)) return '';

      // 'starnet' managed provider: the bearer is the linked device token, resolved from the credits config
      // (env CREDITS_* override or the linked .secrets/credits.json record) — never an env API key.
      if (id === 'starnet') return String(linked().apiKey || '').trim();
      return String(explicitKey || '').trim() || stationChoice(id).key;
    }
    /* THE STATION'S OWN CHOICE (the header's COMPLETE PAIRS): the first layer, in key order, whose key has a usable endpoint.
       #89: the key a browser page handed the station (engine-credential.js) fills the gap an operator left; an env var
       (OPENROUTER_API_KEY …) or the desktop keychain push is a deliberate deployment choice and keeps priority, so only a
       provider that cannot run without an endpoint ever looks past the first key, and only to a layer that holds a key: a
       keyless page URL replaces nobody's key (D4). No layer complete: the first key, whose refusal says what it lacks. */
    function stationChoice(id) {
      const held = [];
      for (const l of layersOf(id)) for (const k of l.keys) held.push({ key: k, layer: l.name });
      const profile = profileOf(id);
      const whole = (profile && profile.requiresBaseUrl) ? held.find(h => !!baseUrl(id, '', h.key)) : null;
      return whole || held[0] || { key: '', layer: '' };
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
      return endpoint(normalize(provider), explicitBaseUrl, runKey, callerKey, inRequest).url;
    }
    // the endpoint and the layer it came from: 'explicit' | 'keychain' | 'page' | 'environment' | 'linked' | 'default' | 'none'
    function endpoint(id, explicitBaseUrl, runKey, callerKey, inRequest) {
      const at = (url, source) => ({ url, source });

      // 'starnet' managed provider: baseUrl = the linked cloud URL + '/v1' (the inference proxy lives there).
      // Resolved live so linking/unlinking a station reconfigures it with no restart (mirrors the credits adapter).
      if (id === 'starnet') {
        const u = String(linked().url || '').trim().replace(/\/+$/, '');
        return u ? at(u + '/v1', 'linked') : at('', 'none');
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
      const mine = String(callerKey || '').trim();
      // the key this endpoint is for: `runKey` undefined = the caller's own key, else the station's choice
      const inUse = runKey === undefined ? key(id, mine) : String(runKey || '').trim();
      if (explicit) {
        const sentNow = inRequest === true && !!mine && inUse === mine;
        const held = !sentNow && !!inUse && (inUse === String(keys[id] || '').trim() || inUse === operatorKey(id) || !!pageRidesWith(id, inUse));
        if (inUse && (inUse !== mine || held)) explicit = '';
      }
      if (explicit) return at(explicit, 'explicit');
      const runtime = String(baseUrls[id] || '').trim();
      if (runtime) return at(runtime, 'keychain');
      // #89: the page's endpoint (a CUSTOM base URL saved in the browser) goes with the page's key — over the operator's
      // env URL when the run is on that key, never under an env key. A keyless page endpoint (a local server) ranks under
      // the operator's env URL and over the profile default, the same order the key follows.
      const copy = pageRidesWith(id, inUse);
      if (copy && copy.key && copy.baseUrl) return at(copy.baseUrl, 'page');
      const operatorUrl = envFirst(profile && profile.baseUrlEnv);
      if (operatorUrl) return at(operatorUrl, 'environment');
      if (copy && copy.baseUrl) return at(String(copy.baseUrl), 'page');
      const fallback = (profile && profile.baseUrl) || '';
      return at(fallback, fallback ? 'default' : 'none');
    }

    /* THE ONE RESOLUTION (the header's COMPLETE PAIRS): a run's whole credential. ctx: { explicitKey, explicitBaseUrl,
       explicitPool, inRequest }, a caller's own key, the endpoint and the pool sent with it, and whether this request
       sent them (runOnceCore's pool line: such a key takes only the pool sent with it; the station's pool never rotates
       onto an endpoint the caller named). With none: the station's own choice. complete and missing read the profile, so
       a sign-in's liveness, which this store never sees, stays index.js's providerHasCredential. */
    function resolve(provider, ctx) {
      const c = ctx || {}, id = normalize(provider), profile = profileOf(id) || {};
      // a channel's own credential serves only its own provider (S8): on any other it is not there
      const own = (c.channel && normalize(c.channel.provider) === id) ? c.channel : null;
      if (own && own.keyLost) return { key: '', keyPool: [], baseUrl: '', source: 'channel', endpointSource: 'none', rank: 'gap', complete: false, missing: 'channel-key' };
      const sent = String((own ? own.key : c.explicitKey) || '').trim();
      const k = key(id, sent);
      const end = endpoint(id, own ? own.baseUrl : c.explicitBaseUrl, k, sent, c.inRequest === true);
      const pool = keyPool(id, (sent && c.inRequest === true) ? (Array.isArray(c.explicitPool) ? c.explicitPool : []) : (end.url !== endpoint(id, '', k).url ? [] : undefined), k);
      const source = (sent && k === sent) ? (own ? 'channel' : 'explicit') : layerOf(id).credentialSource;
      const noEndpoint = !!profile.requiresBaseUrl && !end.url;
      const missing = noEndpoint ? (source === 'environment' ? 'unpaired' : 'baseUrl') : (profile.keyRequired && !k) ? 'key' : '';
      return { key: k, keyPool: pool, baseUrl: end.url, source, endpointSource: end.source,
        rank: (k && k === String(keys[id] || '').trim()) ? 'primary' : 'gap', complete: !missing, missing };
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
      const before = heldKeys(id);   // what a REMOVE or a rotation takes out of a layer is remembered as let go (S3, below)
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
      noteLetGo(id, before);
      if (own(patch, 'key') || own(patch, 'keyPool')) convertChannels(id);   // S8: a key the keychain now holds is the station's
      return id;
    }

    /* ---- the page's copy (POST /api/providers/engine-key) ---- */
    function putPage(provider, input, o) {
      const id = normalizeId(provider), before = id ? heldKeys(id) : [];
      const r = page.put(provider, input, o);
      if (id) noteLetGo(id, before);
      if (r && r.ok && r.changed) convertChannels(provider);   // S8: a key the page now holds is the station's
      return r;
    }

    /* ---- readouts ---- */
    // what an unattended run of this provider would use RIGHT NOW — booleans and source names, never a value
    function presence(id) {
      const saved = page.get(id) || {};
      const from = layerOf(id), layer = stationChoice(id).layer;
      return {
        saved: { key: !!saved.key, alternates: (saved.keyPool || []).length, baseUrl: !!saved.baseUrl },
        keySource: layer === 'page' ? 'station' : (layer ? 'environment' : 'none'),
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
      const from = stationChoice(id);
      if (from.layer !== 'environment') return named(from.layer || 'none');
      // the alias an export seeded (no push has replaced it): STARNET_ when that spelling is set, else SKYNET_, as env() reads
      const seeded = id === 'openrouter' && aliasFromEnv && from.key === String(keys[id] || '').trim();
      return named('environment', envName(seeded ? ['STARNET_OPENROUTER_KEY', 'SKYNET_OPENROUTER_KEY'] : profile && profile.keyEnv));
    }
    /* A BOT NEVER KEEPS THE STATION'S OWN KEY: a key the station holds — the keychain push, the operator's env key, the page copy —
       resolves live per message, never from a channel's credential (index.js channelConnectCredential; CHANNELS above). */
    function stationHeld(provider, recordKey) {
      const id = normalize(provider);
      const k = String(recordKey || '').trim();
      return !!k && (k === String(keys[id] || '').trim() || k === operatorKey(id) || !!pageRidesWith(id, k));
    }
    // the PAGE COPY's key beside an endpoint that copy was not saved with (what an older build's keyless connect left on a record)
    function endpointIsForeign(provider, recordKey, recordUrl) {
      const copy = pageRidesWith(normalize(provider), String(recordKey || '').trim());
      const u = String(recordUrl || '').trim().replace(/\/+$/, '');
      return !!copy && !!copy.key && !!u && u !== String(copy.baseUrl || '').trim().replace(/\/+$/, '');
    }
    function keychainValues() { return { keys: Object.values(keys), pools: Object.values(pools) }; }

    /* ---- a chat channel's own credential (S8; the header's CHANNELS) ---- */
    function loadChannels() {
      const r = (typeof chan.load === 'function' ? chan.load() : null) || { status: 'absent' };
      channelFile = String(r.status || 'absent');
      // said once while the file stays closed to us (an antivirus scan or a backup agent holding it open: EBUSY, EACCES), and again
      // the next time it closes. Nothing in it is changed or decided meanwhile; it is read again at the next use (channelsReady)
      if (channelFile === 'unreadable' && !saidUnreadable) warn('[channels] .secrets/channel-credentials.json could not be read: the bots with a key of their own are refused, and nothing in the file is changed, until it can be; it is read again at the next use');
      saidUnreadable = channelFile === 'unreadable';
      const saved = (channelFile !== 'unreadable' && r.value && typeof r.value === 'object') ? r.value.channels : null;
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
      for (const id of Object.keys(saved)) {
        // A connect while the file was unreadable may already have a pending live version. Reading the file again must
        // join its durable versions to that pending chain, never skip the old key because memory has the same record id.
        const rows = versionsOf(entries[id]), seen = new Set(rows.map(v => v.bind)), savedBinds = new Set();
        for (let raw = saved[id]; raw; raw = raw.prev) {
          const row = versionRow(raw);
          if (!row || savedBinds.has(row.bind)) break;
          savedBinds.add(row.bind);
          if (!seen.has(row.bind)) { rows.push(row); seen.add(row.bind); }
        }
        if (rows.length) entries[id] = versionChain(rows);
      }
    }
    // one version of an entry as the file holds it, or null: a torn or hand-edited row never loads as a key
    function versionRow(e) {
      const provider = (e && typeof e === 'object') ? normalizeId(e.provider) : '';
      if (!provider || typeof e.bind !== 'string' || !e.bind) return null;
      const v = { provider, bind: e.bind, ownKey: e.ownKey === true, rev: Number(e.rev) || 0 };
      if (typeof e.key === 'string' && e.key.trim()) { v.key = e.key.trim(); v.ownKey = true; }
      if (typeof e.baseUrl === 'string' && e.baseUrl.trim()) v.baseUrl = e.baseUrl.trim();
      return v;
    }
    function versionsOf(e) {
      const rows = [];
      for (let v = e; v; v = v.prev) rows.push(v);
      return rows;
    }
    function versionChain(rows) {
      let next = null;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = Object.assign({}, rows[i]);
        delete row.prev;
        if (next) row.prev = next;
        next = row;
      }
      return next;
    }
    // Each unproven write may have landed: a record can name any retained version, not only the first or latest.
    const versionNamed = (e, bind) => (!e || !bind) ? null : (versionsOf(e).find(v => v.bind === bind) || null);
    // the file is read at first use, and again while it stays unreadable: a file that is locked now is never written over
    function channelsReady() {
      if (channelFile === 'unloaded' || channelFile === 'unreadable') loadChannels();
      return channelFile !== 'unreadable';
    }
    function channelEnvelope() {
      const channels = {};
      const rowOf = e => {
        const row = { provider: e.provider, bind: e.bind, ownKey: !!e.ownKey };
        if (e.key && keepsChannelKeys()) row.key = e.key;
        if (e.baseUrl) row.baseUrl = e.baseUrl;
        row.rev = e.rev;
        return row;
      };
      for (const id of Object.keys(entries).sort()) {
        channels[id] = versionChain(versionsOf(entries[id]).map(rowOf));
      }
      return { version: 1, channels };
    }
    function saveChannels() {
      if (typeof chan.save !== 'function') return true;
      const ok = chan.save(channelEnvelope()) === true;
      if (!ok) warn('[channels] .secrets/channel-credentials.json is not proven saved: what it holds is live now, and the next boot tries again');
      return ok;
    }
    // An unchanged in-memory entry is not proof of a previous write. Reconnect, settle and forget all retry until the
    // destination reads back; an absent, empty store needs no file. A failed removal must never become a successful no-op.
    function proveChannels() {
      if (typeof chan.verify === 'function' && chan.verify(channelEnvelope()) === true) return true;
      if (!Object.keys(entries).length && typeof chan.load === 'function' && (chan.load() || {}).status === 'absent') return true;
      return saveChannels();
    }
    // a key that has become the station's, kept only for the endpoint saved beside it (its record still names it, so a version a
    // change is waiting to replace stays with it)
    const endpointOnly = e => Object.assign({ provider: e.provider, bind: e.bind, ownKey: false, baseUrl: e.baseUrl, rev: e.rev + 1 }, e.prev ? { prev: e.prev } : {});
    // whether that endpoint is the bot's own to keep: not one the page copy's key was never saved with (endpointIsForeign), and not
    // the one the station resolves for that key anyway, so the bot follows a proxy configured later (index.js ownBase says the same)
    const keepsOwnEndpoint = (id, k, url) => !!url && !endpointIsForeign(id, k, url) && trimSlash(url) !== trimSlash(baseUrl(id, '', k));

    function channel(id, record) {
      const rid = String(id || ''), r = record || {}, provider = normalize(r.provider);
      const held = carried[rid];
      if (held && held.provider === provider) return { key: held.key, baseUrl: held.baseUrl, keyLost: '' };
      const c = r.credential;
      if (!c || c.ref !== 'channel') return { key: '', baseUrl: '', keyLost: '' };
      // a file closed to us says nothing about the key in it: not 'gone', and it is read again with the next message (review r1)
      if (!channelsReady()) return { key: '', baseUrl: '', keyLost: 'unreadable' };
      const v = versionNamed(entries[rid], c.bind);
      if (!v || v.provider !== provider) return { key: '', baseUrl: '', keyLost: 'gone' };
      return { key: v.key || '', baseUrl: v.baseUrl || '', keyLost: (v.ownKey && !v.key) ? 'session' : '' };
    }
    /* What a connect or a sync saves. input: the key the caller handed over and the endpoint that goes with it, already paired
       (index.js channelConnectCredential). A key a station layer holds as its key (stationHeld, the gate's own test: a backup in
       a pool stays the bot's), or nothing at all, is a station reference, and any entry goes once a record that says so is proven
       saved. A CHANGE LANDS WITH ITS RECORD (the header's CHANNELS): it is written under a bind of its own, beside the version
       the saved record names, before any record names it, and settleChannels keeps the one a record proven on disk names. A
       provider's linked account and a sign-in take no credential of a channel's.
       -> { credential: what the record holds, persisted, keyPersisted: undefined with no own key, else whether it survives a restart } */
    function putChannel(id, input) {
      const rid = String(id || ''), i = input || {}, provider = normalize(i.provider);
      const url = keepsEndpoint(provider) ? String(i.baseUrl || '').trim() : '';
      const k = keepsEndpoint(provider) ? String(i.key || '').trim() : '';
      const ownKey = !!k && !stationHeld(provider, k);
      delete carried[rid];
      const ready = channelsReady(), cur = entries[rid];
      if (!ownKey && !url) return { credential: { ref: 'station' }, persisted: ready };
      const same = !!cur && cur.provider === provider && (cur.key || '') === (ownKey ? k : '') && (cur.baseUrl || '') === url;
      if (same) {
        const persisted = ready && proveChannels();
        return { credential: { ref: 'channel', bind: cur.bind }, persisted, keyPersisted: ownKey ? (persisted && keepsChannelKeys()) : undefined };
      }
      const next = { provider, bind: newBind(), ownKey, rev: (cur ? cur.rev : 0) + 1 };
      if (ownKey) next.key = k;
      if (url) next.baseUrl = url;
      // No record read-back has ruled any older bind out yet. Keep all of them until settlement can do so.
      if (cur) next.prev = cur;
      entries[rid] = next;
      const persisted = ready && saveChannels();
      return { credential: { ref: 'channel', bind: next.bind }, persisted, keyPersisted: ownKey ? (persisted && keepsChannelKeys()) : undefined };
    }
    /* THE RECORDS, PROVEN (review r1). rows: channels/secrets.js credentialRows of the records a save just read back, or of the file
       a boot would read beside the records in memory (a record may come twice). Each entry keeps every version some record names
       and loses the rest: a change waits in the file beside the version it replaces until a record naming it is proven on disk,
       and a change whose record never landed leaves the disk as it was. An entry no record names goes (a record that turned to
       the station, one that is gone). A file that cannot be read is left alone. -> bool: proven (true when nothing changed) */
    function settleChannels(rows) {
      if (!Array.isArray(rows) || !channelsReady()) return false;
      const named = Object.create(null);
      for (const row of rows) {
        if (!row || !row.id) continue;
        const keep = named[row.id] || (named[row.id] = new Set()), c = row.credential;
        if (c && c.ref === 'channel' && c.bind) keep.add(String(c.bind));
      }
      let changed = false;
      for (const rid of Object.keys(entries)) {
        const e = entries[rid], keep = named[rid] || new Set();
        const versions = versionsOf(e), retained = versions.filter(v => keep.has(v.bind));
        if (retained.length === versions.length) continue;
        changed = true;
        if (retained.length) entries[rid] = versionChain(retained);
        else delete entries[rid];
      }
      return changed ? saveChannels() : proveChannels();
    }
    // a forget: true only once the file is read and the entry is proven gone from it. A file that cannot be read answers false, so a
    // route never claims purged for a key it could not see (review r1: the memory of an unread file is empty, and read as "nothing
    // to forget" while the key stayed in both copies); the Commander's retry, once the file can be read, removes it
    function dropChannel(id) {
      const rid = String(id || '');
      delete carried[rid];
      if (!channelsReady()) return false;
      if (!entries[rid]) return proveChannels();
      delete entries[rid];
      return saveChannels();
    }
    function convertChannels(provider) {
      const id = normalizeId(provider), followers = [];
      if (!channelsReady()) return;
      let changed = false;
      for (const rid of Object.keys(entries)) {
        const head = entries[rid];
        // The live record can still name an older version after a failed re-add. Production supplies its view lazily;
        // injectable hosts without a record reader retain the historical single-entry contract.
        const record = typeof chan.record === 'function' ? chan.record(rid) : null;
        const c = record && record.credential;
        const e = typeof chan.record === 'function'
          ? (record && normalize(record.provider) === id && c && c.ref === 'channel' ? versionNamed(head, c.bind) : null)
          : head;
        if (!e) continue;
        if (e.provider !== id || !e.key || !stationHeld(id, e.key)) continue;
        if (keepsOwnEndpoint(id, e.key, e.baseUrl)) {
          entries[rid] = versionChain(versionsOf(head).map(v => v === e ? endpointOnly(v) : v));
          changed = true;
        }
        else followers.push(rid);
      }
      // the records first (the header's CONVERSION). One that is not proven saved keeps its entry on disk, and the next boot converts it
      if (followers.length && typeof chan.follow === 'function' && chan.follow(followers) === true) {
        for (const rid of followers) delete entries[rid];
        changed = true;
      }
      if (changed) saveChannels();
    }

    /* The boot's reconciliation (the header's BOOT). rows: channels/secrets.js credentialRows. It writes what must reach the file
       before a record changes, and answers what the records become:
         credentials   { record id: its credential field now (null: none) }: each such record also loses what it carries
         moved, followers, refused, orphans, pending   record ids, for the log: an entry written; a record now following the
                       station; a bot refused (step 3); an orphan to delete; a move that failed and waits for the next boot
         finish(saved)  call it once the records are on disk (saved false: they are not): only then do entries go, and the
                       two copies of the file are proven alike, since a crash between them leaves a replaced key in the .bak */
    function reconcileChannels(rows, o) {
      const recovered = !!(o && o.recovered), list = Array.isArray(rows) ? rows : [];
      const res = { credentials: Object.create(null), moved: [], followers: [], refused: [], orphans: [], pending: [], finish: () => true };
      const pend = row => {
        carried[row.id] = { provider: normalize(row.provider), key: String(row.key || '').trim(), baseUrl: String(row.baseUrl || '').trim() };
        res.credentials[row.id] = row.credential || null;
        res.pending.push(row.id);
      };
      if (!channelsReady()) {
        for (const row of list) if (row.key || row.baseUrl) pend(row);
        return res;
      }
      // 0: a change still waiting for its record (putChannel, then the station stopped, or the record's save failed): the version
      // the record as loaded names stands, and the other goes (finish writes the file); the steps below read the one that stands
      for (const row of list) {
        const e = entries[row.id], c = row.credential;
        if (!e || !e.prev) continue;
        const named = c && c.ref === 'channel' ? versionNamed(e, c.bind) : null;
        // A valid named version wins even deep in the chain. With no bind, recovery still uses the newest entry (step 1a).
        entries[row.id] = versionChain([named || e]);
      }
      const planned = Object.create(null), gone = new Set();
      const toStation = id => { res.credentials[id] = { ref: 'station' }; res.followers.push(id); if (entries[id]) gone.add(id); };
      const plan = (row, provider, k, url) => {
        const next = { provider, bind: newBind(), ownKey: !!k, rev: (entries[row.id] ? entries[row.id].rev : 0) + 1 };
        if (k) next.key = k;
        if (url) next.baseUrl = url;
        planned[row.id] = next;
        res.credentials[row.id] = { ref: 'channel', bind: next.bind };
        res.moved.push(row.id);
      };
      for (const row of list) {
        const id = row.id, provider = normalize(row.provider), e = entries[id], same = !!e && e.provider === provider;
        const k = String(row.key || '').trim(), url = String(row.baseUrl || '').trim();
        let c = row.credential;
        if (recovered && same) {   // 1a: the record came from the .bak, and the entry is newer than anything in it
          c = { ref: 'channel', bind: e.bind };
          res.credentials[id] = c;
        } else if (k || url) {     // 1b, 1c
          if (!keepsEndpoint(provider)) toStation(id);
          else if (!k || !stationHeld(provider, k)) plan(row, provider, k, url);
          else if (keepsOwnEndpoint(provider, k, url)) plan(row, provider, '', url);
          else toStation(id);
          continue;
        }
        if (c && c.ref === 'channel') {
          if (!same || e.bind !== c.bind) {   // 3
            res.refused.push(id);
            if (row.carries) res.credentials[id] = c;
          } else if (e.key && stationHeld(provider, e.key)) {   // 2
            if (keepsOwnEndpoint(provider, e.key, e.baseUrl)) planned[id] = endpointOnly(e);
            else toStation(id);
          }
        } else if (!c || c.ref !== 'station') toStation(id);   // 4
        else if (row.carries) res.credentials[id] = c;         // empty fields an older build left
      }
      // 5: what each entry's record holds once the outcomes above land
      const byId = new Map(list.map(row => [row.id, row]));
      for (const id of Object.keys(entries)) {
        if (planned[id] || gone.has(id)) continue;
        const row = byId.get(id), c = !row ? null : (res.credentials[id] !== undefined ? res.credentials[id] : row.credential);
        if (!c || c.ref !== 'channel' || c.bind !== entries[id].bind) { gone.add(id); res.orphans.push(id); }
      }
      const writes = Object.keys(planned);
      if (writes.length) {
        const before = Object.create(null);
        for (const id of writes) { before[id] = entries[id]; entries[id] = planned[id]; }
        if (!saveChannels()) {
          for (const id of writes) { if (before[id]) entries[id] = before[id]; else delete entries[id]; }
          for (const row of list) {
            if (!planned[row.id]) continue;
            if (row.key || row.baseUrl) pend(row);
            else delete res.credentials[row.id];
          }
          res.moved = [];
        }
      }
      res.finish = saved => {
        const landed = saved !== false;
        if (landed) for (const id of gone) delete entries[id];
        const proven = typeof chan.verify === 'function' ? chan.verify(channelEnvelope()) === true : true;
        const nothing = !Object.keys(entries).length && channelFile === 'absent';
        return ((landed && gone.size > 0) || (!proven && !nothing)) ? saveChannels() : true;
      };
      return res;
    }
    function carriedChannels() { return Object.assign({}, carried); }

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
      // a channel's own credential (S8), every version while changes wait for their records, and what a record whose move failed
      // still carries
      const channels = Object.values(entries).flatMap(versionsOf).concat(Object.values(carried));
      for (const e of channels) hold(e.key);
      if (childEnv) return Array.from(out);
      // the credential parts of the keychain's and the page copy's endpoints (live), then the environment layer's values
      for (const id of Object.keys(baseUrls)) for (const part of urlSecretParts(baseUrls[id])) hold(part);
      for (const c of copies) for (const part of urlSecretParts(c.baseUrl)) hold(part);
      for (const e of channels) for (const part of urlSecretParts(e.baseUrl)) hold(part);
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
    /* KEYS A LAYER LET GO OF (review r1). handleRun on the desktop, the channel hubs, the workers and the scheduler resolve the
       station's key themselves and hand it to a run, before runOnce's one-turn-at-a-time queue: a turn queued behind another waits
       as long as that turn runs. A key removed or rotated away meanwhile was held by no layer when its run started, so the watch
       below took it for a caller's own and every call of that run went out on the removed key. A push or a page save now
       remembers each key it took out of a layer, as a digest only (deps.digest, index.js: SHA-256; the key itself leaves the store
       at once, as before), and fromStation() still knows it as the station's. The env layer never lets a key go. */
    const digestOf = typeof d.digest === 'function' ? d.digest : fnv;
    const letGoKeys = new Set();          // digests of provider id + key
    const fingerprint = (id, v) => String(digestOf(id + '\u0000' + v));
    function heldKeys(id) { return layersOf(id).reduce((all, l) => all.concat(l.keys, l.pool), []); }
    function syncReadiness(id) {
      if (!d.readiness || (profileOf(id) || {}).authType === 'oauth_device_code') return;
      const k = key(id, ''), url = baseUrl(id, '', k);
      const pool = (profileOf(id) || {}).credentialPool ? keyPool(id, undefined, k) : [];
      d.readiness.syncPairs(id, [k, ...pool].filter((v, i, a) => a.indexOf(v) === i).map(value => ({ key: value, url })));
    }
    function credentialAccepted(id, k, u) {
      syncReadiness(id);
      return !d.readiness || d.readiness.accepted(d.readiness.keySlot(id, k), k, u);
    }
    function readinessAlternates(id, k, u, explicitPool) {
      syncReadiness(id);
      const out = { eligible: 0, verified: 0, unverified: 0, rejected: 0 };
      if (!(profileOf(id) || {}).credentialPool) return out;
      const pool = keyPool(id, Array.isArray(explicitPool) ? explicitPool : (u !== baseUrl(id, '', k) ? [] : undefined), k);
      for (const value of pool.filter((v, i, a) => v && v !== k && a.indexOf(v) === i)) {
        const status = d.readiness ? d.readiness.evidence(d.readiness.keySlot(id, value), value, u).status : 'unverified';
        if (status === 'rejected') out.rejected++;
        else { out.eligible++; out[status === 'verified' ? 'verified' : 'unverified']++; }
      }
      return out;
    }
    function accepted(id, k, u, explicitPool) {
      return credentialAccepted(id, k, u) || readinessAlternates(id, k, u, explicitPool).eligible > 0;
    }
    function noteLetGo(id, before) {
      for (const v of before) if (v && !holds(id, v)) letGoKeys.add(fingerprint(id, v));
      syncReadiness(id);
    }
    // a bot's own key (an entry's, a pending version's, a record's whose move failed): the bot's account, never the station's
    function channelOwns(provider, k) {
      const id = normalizeId(provider), v = String(k || '').trim();
      if (!id || !v) return false;
      const mine = e => !!e && e.provider === id && e.key === v;
      return Object.values(entries).some(e => versionsOf(e).some(mine)) || Object.values(carried).some(mine);
    }
    /* fromStation(provider, key): a key the station resolved for a run — a layer holds it now, or held it until a REMOVE or a
       rotation took it out — and not a channel's own key. What the in-flight watch takes; never a key a caller brought. A key a
       layer holds AS ITS KEY is the station's even while a channel entry still holds it too (a conversion whose record could not
       be saved waits for the next boot): a station run on it is never exempt. */
    function fromStation(provider, k) {
      const id = normalizeId(provider), v = String(k || '').trim();
      if (!id || !v || (channelOwns(id, v) && !stationHeld(id, v))) return false;
      return holds(id, v) || letGoKeys.has(fingerprint(id, v));
    }
    // A host can resolve a station key before its turn waits in the thread queue. Remember its ownership at admission:
    // after REMOVE a retained channel version may still hold the same value, but cannot turn that station run into a bot's.
    // The private symbol cannot arrive through request JSON, survives option spreads, and is reused only for this exact pair.
    const runAdmission = Symbol('credential admission');
    function admitRun(options, provider) {
      const o = options || {}, id = normalizeId(provider), k = String(o.key || '').trim();
      if (!id || !k || (o.provider && normalize(o.provider) !== id)) return o;
      const prior = o[runAdmission];
      if (prior && prior.provider === id && prior.key === k) return o;
      return Object.assign({}, o, { [runAdmission]: { provider: id, key: k, held: fromStation(id, k) } });
    }
    function admittedFromStation(options, provider, k) {
      const stamp = options && options[runAdmission], id = normalizeId(provider), key = String(k || '').trim();
      return stamp && stamp.provider === id && stamp.key === key ? stamp.held : fromStation(id, key);
    }
    /* A run resolves its keys as it starts and builds one provider adapter on each (its primary, every backup key it may
       rotate onto, every provider fallback); each later call goes out on those, so a key removed or replaced mid-run kept
       billing until the run ended. inFlight() is one run's watch over them:
         watch(adapter, provider, key, o) -> adapter   the key `adapter` sends for `provider`. Watched when it is the station's
                     (admittedFromStation: o.held keeps ownership captured before a queue; else fromStation() now) and the run's caller
                     did not send it in this request (o.sentByCaller: an /api/run body key or pool, a fallback's own body key).
                     A key no layer here ever held — a caller's — and a channel's own key are the caller's, and a removal on this
                     station is not about them. A key a layer let go of before the run reached its adapter is watched, and gone.
         gone(adapter) -> provider id | ''   that provider, once no layer holds the watched key any longer; else ''.
       So only a REMOVE or a rotation of that very key, in every layer that held it, stops a run, or, for a backup key, the
       removal of the last key its layer held for its pool to ride (S4): the loop asks before each call (loop.js
       credentialGone), never mid-stream, and runOnceCore asks once its primary adapter is built, before any request. */
    function inFlight() {
      const watched = new WeakMap();   // adapter -> [provider id, key]
      return {
        watch(adapter, provider, k, o) {
          const opts = o || {}, id = normalizeId(provider), v = String(k || '').trim();
          const held = own(opts, 'held') ? opts.held === true : fromStation(id, v);
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
    function credentialFor(provider) {
      const id = normalizeId(provider);
      const r = id && profileOf(id) ? resolve(id) : null;
      return (r && r.key) ? { key: r.key, baseUrl: r.baseUrl, rank: r.rank, source: r.source } : { key: '', baseUrl: '', rank: 'gap', source: 'none' };
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
      key, operatorKey, keyPool, pageRidesWith, baseUrl, resolve,
      keepsEndpoint, endpointNotHandedOver, keptEndpoints, loadKeptEndpoints, saveKeptEndpoints,
      push, putPage, presence, stationHeld, endpointIsForeign, alias, keychainValues, holds, fromStation, inFlight,
      secretValues, urlSecretParts, maskedUrl, admitRun, admittedFromStation, accepted, credentialAccepted, readinessAlternates, syncReadiness,
      credentialFor, endpointFor, consumerDeps,
      channel, putChannel, dropChannel, settleChannels, reconcileChannels, carriedChannels
    };
  }

  return { makeCredentialStore, adoptSpawnCredentials };
});
