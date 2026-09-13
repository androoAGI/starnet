/* sidecar/providers/factory.js - provider profile to concrete LLMProvider adapter.
   runOnce() asks for selectProvider({ provider, ... }) and then drives the returned seam.
   Adding an OpenAI-compatible provider is now a registry entry; adding a new wire format
   is one adapter case here. */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(
      require('./openrouter.js'),
      require('./codex.js'),
      require('./openai-compatible.js'),
      require('./anthropic.js'),
      require('./gemini.js'),
      require('./registry.js')
    );
  } else {
    root.SK = root.SK || {};
    root.SK.providers = root.SK.providers || {};
    root.SK.providers.factory = factory(root.SK.providers.openrouter, root.SK.providers.codex, root.SK.providers.openaiCompatible, root.SK.providers.anthropic, root.SK.providers.gemini, root.SK.providers.registry);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (openrouter, codex, openaiCompatible, anthropic, gemini, registry) {
  'use strict';

  const PROVIDER_IDS = registry.providerIds();

  /* PROACTIVE RATE-LIMIT ACCOUNTING (providers/ratelimits.js). Every adapter takes its fetch by INJECTION and
     every adapter's success path is `if (res.ok && res.body) return res` — so the quota headers were dropped
     five times over, and quota was only ever learned by hitting a 429.

     Wrapping the injected fetch here instruments all five adapters at one seam. Deliberately NOT a per-adapter
     edit: a sixth adapter added later would have to remember, and the sixth adapter never remembers. Attached
     once at boot rather than threaded through selectProvider's ~10 call sites, all of which pass the same
     globalThis.fetch. Absent = every adapter behaves byte-identically to before. */
  let rateLimits = null;
  function attachRateLimits(tracker) {
    rateLimits = (tracker && typeof tracker.wrapFetch === 'function') ? tracker : null;
    return rateLimits;
  }

  function selectProvider(opts) {
    opts = opts || {};
    // Configured OAuth fallbacks need metadata at admission, but authentication only if used.
    // Cache a successful activation for this run. Failed activation stays retryable, and a
    // cancelled caller never starts refresh/inference. No credential is shared across wrappers.
    if (typeof opts.tokenProvider === 'function') {
      const base = Object.assign({}, opts); delete base.tokenProvider;
      const metadata = selectProvider(base);
      let active = null;
      return Object.assign({}, metadata, {
        async *stream(req) {
          if (req && req.signal && req.signal.aborted) return;
          if (!active) {
            active = Promise.resolve().then(() => opts.tokenProvider()).then(token =>
              selectProvider(Object.assign({}, base, { token, headers: typeof opts.headersProvider === 'function' ? opts.headersProvider() : base.headers })));
            active.catch(() => { active = null; });
          }
          const live = await active;
          if (req && req.signal && req.signal.aborted) return;
          yield* live.stream(req);
        }
      });
    }
    const id = registry.normalizeProviderId(opts.provider, registry.DEFAULT_PROVIDER_ID);
    const profile = registry.getProviderProfile(id);
    if (!profile) throw new Error('unknown provider: ' + (opts.provider || ''));
    if (rateLimits && typeof opts.fetch === 'function') opts = Object.assign({}, opts, { fetch: rateLimits.wrapFetch(id, opts.fetch) });

    if (profile.adapter === 'codex') {
      return codex.makeCodexProvider({
        fetch: opts.fetch,
        token: opts.token,
        renewToken: opts.renewToken,   // optional 401-recovery seam — the host's force-refresh (see codex.js header)
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'openrouter') {
      return openrouter.makeOpenRouterProvider({
        fetch: opts.fetch,
        clock: opts.clock,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        referer: opts.referer,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'openai-compatible') {
      // Device-OAuth providers (grok/kimi) authenticate the OpenAI-compatible endpoint with their OAuth ACCESS
      // TOKEN riding in AS the Bearer key (opts.token). Static per-provider wire headers (e.g. kimi's X-Msh-*)
      // merge UNDER any caller-supplied runtime headers (e.g. the dynamic X-Msh-Device-Id / X-Msh-Os-Version).
      const isDeviceOAuth = profile.authType === 'oauth_device_code';
      // Endpoint truth: the adapter no longer defaults an empty base URL to api.openai.com (it used to,
      // which silently rerouted an unlinked starnet run — credential included — to OpenAI and produced that
      // vendor's "invalid model ID"; 2026-08-25 stranded-user incident). Refuse HERE, where the provider id
      // is known, so the error names the actual remedy instead of a generic construction failure.
      if (!(opts.baseUrl || profile.baseUrl)) {
        throw new Error(id === 'starnet'
          ? 'STARNET is not linked on this station — link it in SETTINGS to run on credits (relink if you recently unlinked or reinstalled)'
          : 'provider ' + id + ' has no endpoint configured (base URL missing)');
      }
      const mergedHeaders = (profile.extraHeaders || opts.headers)
        ? Object.assign({}, profile.extraHeaders || {}, opts.headers || {})
        : undefined;
      return openaiCompatible.makeOpenAICompatibleProvider({
        fetch: opts.fetch,
        clock: opts.clock,
        // device-OAuth errors must carry the provider's NAME (e.g. "Grok (xAI) http 401 - …") so a mid-run
        // token death classifies to the ⏼ RECONNECT door, mirroring the pre-run oauthLabel() wrap. Keyed
        // openai-compatible providers keep the generic label (their recovery door is the key field either way).
        label: isDeviceOAuth ? (profile.name || profile.id) : undefined,
        key: isDeviceOAuth ? (opts.token || opts.key) : opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        chatPath: profile.chatPath,
        modelsPath: profile.modelsPath,
        reasoningEffort: opts.reasoningEffort,
        // profile wire hints: does this endpoint document `reasoning_effort`, and is tool support
        // asserted/denied at the provider level (fallback when the catalog carries no capability data)?
        sendReasoningEffort: profile.wireReasoningEffort === true,
        supportsTools: typeof profile.supportsTools === 'boolean' ? profile.supportsTools : null,
        // wireStreamOptions:false = endpoint rejects/lacks stream_options (usage streams by default there)
        includeUsage: profile.wireStreamOptions === false ? false : opts.includeUsage,
        staticModels: profile.staticModels,
        // prices.js family for endpoints whose /models carries no pricing (null = stays honestly unpriced)
        priceFamily: (typeof profile.priceFamily === 'string') ? profile.priceFamily : null,
        // Local runtimes may need to load a model before returning headers. Hosted providers retain the
        // shared 30s connect ceiling; only profiles that prove a different need override it.
        connectTimeoutMs: profile.connectTimeoutMs,
        defaultContext: opts.defaultContext,
        headers: mergedHeaders
      });
    }
    if (profile.adapter === 'anthropic') {
      return anthropic.makeAnthropicProvider({
        fetch: opts.fetch,
        clock: opts.clock,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    if (profile.adapter === 'gemini') {
      return gemini.makeGeminiProvider({
        fetch: opts.fetch,
        clock: opts.clock,
        key: opts.key,
        baseUrl: opts.baseUrl || profile.baseUrl,
        reasoningEffort: opts.reasoningEffort
      });
    }
    throw new Error('provider adapter is not wired: ' + profile.adapter);
  }

  return {
    selectProvider,
    PROVIDER_IDS,
    getProviderProfile: registry.getProviderProfile,
    listProviderProfiles: registry.listProviderProfiles,
    normalizeProviderId: registry.normalizeProviderId,
    providerUsesCodex: registry.providerUsesCodex,
    providerUsesDeviceOAuth: registry.providerUsesDeviceOAuth,
    defaultReasoningEffortForProvider: registry.defaultReasoningEffortForProvider,
    providerRequiresKey: registry.providerRequiresKey,
    providerRequiresBaseUrl: registry.providerRequiresBaseUrl,
    attachRateLimits: attachRateLimits
  };
});
