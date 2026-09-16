/* sidecar/providers/registry.js - provider profiles, following the reference harness.
   Profiles are metadata only: adapters still implement the LLMProvider stream seam.
   This keeps provider discovery, auth shape, defaults, aliases, model endpoints, and UI
   labels in one place instead of spreading hardcoded provider ids through the host. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.providers = root.SK.providers || {}; root.SK.providers.registry = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_PROVIDER_ID = 'openrouter';

  // Wire-hint fields on openai-compatible profiles (all sourced from the provider's official API docs,
  // verified 2026-07; the adapter also self-heals by dropping any optional param a provider 400s on):
  //   wireReasoningEffort — endpoint documents the `reasoning_effort` chat-completions param.
  //   priceFamily — prices.js list-rate table to price runs with when /models carries no pricing block
  //                 (openai/xai/groq/mistral/deepseek/together/fireworks). Absent = honestly unpriced (ollama,
  //                 custom, perplexity, cerebras) — the loop's unpriced-token ceiling is the seatbelt there.
  //   wireStreamOptions: false — endpoint does not accept `stream_options` (usage still arrives:
  //     these providers report usage in the stream by default).
  //   connectTimeoutMs — provider-specific response-header ceiling for endpoints whose cold start can
  //     legitimately exceed the hosted-provider default (local model loading in Ollama).
  const PROFILES = [
    {
      id: 'openrouter',
      aliases: ['or'],
      name: 'OpenRouter',
      label: 'OPENROUTER',
      endpoint: 'openrouter.ai/api/v1',
      blurb: 'one key, broad model catalog',
      live: true,
      adapter: 'openrouter',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['OPENROUTER_KEY', 'OPENROUTER_API_KEY'],
      modelsRequireAuth: false,
      baseUrl: 'https://openrouter.ai/api/v1',
      baseUrlEnv: ['OPENROUTER_BASE'],
      modelsPath: '/models',
      credentialProbePath: '/auth/key',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: 'catalog',
      supportsReasoning: 'catalog',
      order: 20
    },
    {
      id: 'codex',
      aliases: ['openai-codex'],
      name: 'ChatGPT Codex',
      label: 'CHATGPT (CODEX)',
      endpoint: 'OAuth, ChatGPT subscription',
      blurb: 'sign in, no API key',
      live: true,
      adapter: 'codex',
      apiMode: 'codex_responses',
      authType: 'oauth_device_code',
      keyRequired: false,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultReasoningEffort: 'low',
      unmetered: true,
      credentialPool: false,
      supportsTools: true,
      supportsReasoning: true,
      // A ChatGPT subscription reaches the SAME realtime endpoint as an OpenAI API key: its access token is
      // minted with `aud: https://api.openai.com/v1`, and a call there returns `invalid_offer` — past auth and
      // past session validation — rather than 401/403. Verified 2026-07-30 against the live endpoint.
      liveVoice: { transport: 'webrtc', url: 'https://api.openai.com/v1/realtime/calls', model: 'gpt-realtime-2.1', voice: 'ash' },
      order: 10
    },
    {
      // GROK OAUTH — Grok on a SuperGrok / X Premium+ subscription via the RFC 8628 device-code flow (no API
      // key). Inference is OpenAI-compatible at api.x.ai/v1 with the OAuth access token riding in AS the Bearer
      // key. Separate id from the API-key 'xai' profile above (same wire, different auth), like codex vs openai.
      id: 'grok',
      aliases: ['grok-oauth', 'xai-oauth'],
      name: 'Grok (xAI)',
      label: 'GROK OAUTH',
      endpoint: 'OAuth, SuperGrok / X Premium+',
      blurb: 'sign in, no API key',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'oauth_device_code',
      keyRequired: false,
      modelsRequireAuth: true,
      baseUrl: 'https://api.x.ai/v1',
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: true,
      credentialPool: false,
      supportsTools: true,
      supportsReasoning: null,   // mirror the api-key xai profile — asserted by the live catalog, never guessed
      wireReasoningEffort: true,
      // Fallback roster for when the live /models catalog is unreachable (the xAI OAuth surface can 403 an
      // allowlisted-out account). Conservative, tools-only capability; the live catalog always wins when present.
      staticModels: [
        { id: 'grok-4', name: 'Grok 4', context_length: 256000, supportsTools: true, supportsReasoning: true },
        { id: 'grok-3', name: 'Grok 3', context_length: 131072, supportsTools: true, supportsReasoning: false },
        { id: 'grok-code-fast-1', name: 'Grok Code Fast 1', context_length: 256000, supportsTools: true, supportsReasoning: false }
      ],
      order: 11
    },
    {
      // KIMI OAUTH — Moonshot's Kimi for Coding on a Kimi subscription via the RFC 8628 device-code flow. Auth
      // requests carry the kimi-cli X-Msh-* headers (extraHeaders below + the runtime X-Msh-Os-Version /
      // X-Msh-Device-Id the host injects). Inference is OpenAI-compatible at api.kimi.com/coding/v1.
      id: 'kimi',
      aliases: ['moonshot', 'kimi-code', 'kimi-oauth'],
      name: 'Kimi for Coding',
      label: 'KIMI OAUTH',
      endpoint: 'OAuth, Kimi subscription',
      blurb: 'sign in, no API key',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'oauth_device_code',
      keyRequired: false,
      modelsRequireAuth: true,
      baseUrl: 'https://api.kimi.com/coding/v1',
      chatPath: '/chat/completions',
      modelsPath: '/models',
      defaultReasoningEffort: 'none',
      unmetered: true,
      credentialPool: false,
      supportsTools: true,
      supportsReasoning: false,
      // The STATIC part of the kimi-cli device signature; the host adds X-Msh-Os-Version + a stable per-install
      // X-Msh-Device-Id (minted once, persisted with the tokens) at request time. Sent on inference too.
      extraHeaders: {
        'X-Msh-Platform': 'kimi_cli',
        'X-Msh-Version': '1.0.0',
        'X-Msh-Device-Name': 'starnet',
        'X-Msh-Device-Model': 'starnet'
      },
      staticModels: [
        { id: 'kimi-for-coding', name: 'Kimi for Coding', context_length: 256000, supportsTools: true, supportsReasoning: false },
        { id: 'kimi-for-coding-highspeed', name: 'Kimi for Coding (Highspeed)', context_length: 256000, supportsTools: true, supportsReasoning: false },
        { id: 'k3', name: 'K3', context_length: 256000, supportsTools: true, supportsReasoning: false }
      ],
      order: 12
    },
    {
      id: 'starnet',
      aliases: ['starnet-cloud', 'managed'],
      name: 'StarNet Managed',
      label: 'STARNET',
      endpoint: 'managed inference (credits)',
      blurb: 'run on credits, no API key — link a station',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      // Auth is the linked device token (bearer). It is resolved from the credits-link store at request time
      // (index.js providerRuntimeKey), NOT from an env key the user pastes — a linked station needs zero env.
      authType: 'api_key',
      keyRequired: true,
      // baseUrl is DYNAMIC: the linked cloud URL + '/v1' (index.js providerRuntimeBaseUrl). Static default empty.
      // requiresBaseUrl is TRUE even though the LINK flow supplies it (not the user, unlike 'custom'): an
      // unlinked station resolves an empty baseUrl, and before 2026-08-25 that fell through to the adapter's
      // api.openai.com default — a starnet run silently left for OpenAI's API and died with that vendor's
      // "invalid model ID" (the stranded-user incident). With the flag set, hasCredential/listModels/run
      // admission all read an unresolved link as NOT CONFIGURED and say "link this station" instead.
      baseUrl: '',
      requiresBaseUrl: true,
      modelsRequireAuth: true,
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      // METERED: the proxy debits the ledger per request AND the app's own billing admission applies (no
      // unmetered flag — a managed run must reserve/settle like any paid provider).
      unmetered: false,
      credentialPool: false,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 15
    },
    {
      id: 'openai',
      priceFamily: 'openai',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: ['openai-api'],
      name: 'OpenAI API',
      label: 'OPENAI API',
      endpoint: 'api.openai.com/v1',
      blurb: 'OpenAI-compatible chat completions',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['OPENAI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.openai.com/v1',
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      // Native speech-to-speech: the provider itself listens and speaks, so live voice needs NO second
      // credential and no transcription layer of ours. Present here only because it is PROVEN against the
      // real endpoint; a provider without a verified descriptor gets composed voice instead of a guess.
      liveVoice: { transport: 'webrtc', url: 'https://api.openai.com/v1/realtime/calls', model: 'gpt-realtime-2.1', voice: 'ash' },
      order: 30
    },
    {
      id: 'anthropic',
      aliases: ['claude'],
      name: 'Anthropic',
      label: 'ANTHROPIC',
      endpoint: 'api.anthropic.com/v1',
      blurb: 'Claude native Messages API',
      live: true,
      adapter: 'anthropic',
      apiMode: 'anthropic_messages',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['ANTHROPIC_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.anthropic.com/v1',
      baseUrlEnv: ['ANTHROPIC_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: true,
      supportsReasoning: null,
      order: 35
    },
    {
      id: 'gemini',
      aliases: ['google', 'google-ai', 'google-gemini'],
      name: 'Google Gemini',
      label: 'GEMINI',
      endpoint: 'generativelanguage.googleapis.com/v1beta',
      blurb: 'Gemini native GenerateContent API',
      live: true,
      adapter: 'gemini',
      apiMode: 'gemini_generate_content',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      baseUrlEnv: ['GEMINI_BASE_URL', 'GOOGLE_AI_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: true,
      supportsReasoning: null,
      order: 36
    },
    {
      // NOTE: 'grok' is intentionally NO LONGER an alias here — it is now the id of the OAuth (subscription)
      // Grok profile below. This api.x.ai/v1 profile is the API-KEY Grok ('XAI'), a separate id, exactly as
      // 'openai' (API key) and 'codex' (OAuth) coexist. Users choosing "GROK OAUTH" vs "XAI" pick their auth.
      id: 'xai',
      priceFamily: 'xai',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: ['x-ai'],
      name: 'xAI',
      label: 'XAI',
      endpoint: 'api.x.ai/v1',
      blurb: 'Grok OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['XAI_API_KEY', 'X_AI_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.x.ai/v1',
      baseUrlEnv: ['XAI_BASE_URL', 'X_AI_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 37
    },
    {
      id: 'groq',
      priceFamily: 'groq',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: [],
      name: 'Groq',
      label: 'GROQ',
      endpoint: 'api.groq.com/openai/v1',
      blurb: 'fast OpenAI-compatible inference',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['GROQ_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.groq.com/openai/v1',
      baseUrlEnv: ['GROQ_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 38
    },
    {
      id: 'mistral',
      priceFamily: 'mistral',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: ['mistralai'],
      name: 'Mistral AI',
      label: 'MISTRAL',
      endpoint: 'api.mistral.ai/v1',
      blurb: 'Mistral OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['MISTRAL_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.mistral.ai/v1',
      baseUrlEnv: ['MISTRAL_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      // Mistral strictly validates request bodies (422 "Extra inputs are not permitted") and its spec
      // has no stream_options; its stream reports usage in the final chunk without it.
      wireStreamOptions: false,
      order: 39
    },
    {
      id: 'deepseek',
      priceFamily: 'deepseek',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: [],
      name: 'DeepSeek',
      label: 'DEEPSEEK',
      endpoint: 'api.deepseek.com',
      blurb: 'DeepSeek OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['DEEPSEEK_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.deepseek.com',
      baseUrlEnv: ['DEEPSEEK_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 40
    },
    {
      id: 'together',
      priceFamily: 'together',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: ['together-ai'],
      name: 'Together AI',
      label: 'TOGETHER',
      endpoint: 'api.together.ai/v1',
      blurb: 'Together OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['TOGETHER_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.together.ai/v1',
      baseUrlEnv: ['TOGETHER_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 41
    },
    {
      id: 'fireworks',
      priceFamily: 'fireworks',   // prices.js table — this endpoint's /models publishes no pricing
      aliases: ['fireworks-ai'],
      name: 'Fireworks AI',
      label: 'FIREWORKS',
      endpoint: 'api.fireworks.ai/inference/v1',
      blurb: 'Fireworks OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['FIREWORKS_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      baseUrlEnv: ['FIREWORKS_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 42
    },
    {
      id: 'perplexity',
      aliases: ['pplx', 'sonar'],
      name: 'Perplexity',
      label: 'PERPLEXITY',
      endpoint: 'api.perplexity.ai',
      blurb: 'Sonar chat completions API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['PERPLEXITY_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.perplexity.ai',
      baseUrlEnv: ['PERPLEXITY_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      // Perplexity's /chat/completions schema has no tools/tool_choice — function calling lives on its
      // separate Agent API. It DOES document its own reasoning_effort, and streams usage by default.
      supportsTools: false,
      supportsReasoning: null,
      wireReasoningEffort: true,
      wireStreamOptions: false,
      // Perplexity has NO usable /models for chat completions (its /v1/models lists Agent-API ids),
      // so the connect screen would be empty and contextLimit 0 (compaction off). Static Sonar roster
      // from docs.perplexity.ai/docs/sonar/models, verified 2026-07 (sonar-reasoning was removed
      // 2025-12-15). Deliberately NO pricing: Perplexity bills per-request search fees on top of
      // tokens, so token-only catalog pricing would under-report real cost — 'unpriced' is the
      // honest label until the provider reports cost on the wire.
      staticModels: [
        { id: 'sonar', name: 'Sonar', context_length: 128000, supportsTools: false, supportsReasoning: false },
        { id: 'sonar-pro', name: 'Sonar Pro', context_length: 200000, supportsTools: false, supportsReasoning: false },
        { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', context_length: 128000, supportsTools: false, supportsReasoning: true },
        { id: 'sonar-deep-research', name: 'Sonar Deep Research', context_length: 128000, supportsTools: false, supportsReasoning: true }
      ],
      order: 43
    },
    {
      id: 'cerebras',
      aliases: [],
      name: 'Cerebras',
      label: 'CEREBRAS',
      endpoint: 'api.cerebras.ai/v1',
      blurb: 'Cerebras OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['CEREBRAS_API_KEY'],
      modelsRequireAuth: true,
      baseUrl: 'https://api.cerebras.ai/v1',
      baseUrlEnv: ['CEREBRAS_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      wireReasoningEffort: true,
      order: 44
    },
    {
      id: 'qwencloud',
      priceFamily: 'qwen',   // prices.js table — DashScope /models may omit token pricing
      aliases: ['qwen', 'dashscope', 'qwen-cloud', 'alibaba'],
      name: 'Qwen Cloud',
      label: 'QWENCLOUD',
      endpoint: 'dashscope-intl.aliyuncs.com/compatible-mode/v1',
      blurb: 'Qwen Cloud / Alibaba Model Studio OpenAI-compatible API',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key',
      keyRequired: true,
      keyEnv: ['DASHSCOPE_API_KEY', 'QWENCLOUD_API_KEY', 'QWEN_API_KEY'],
      modelsRequireAuth: true,
      // QwenCloud intl compatible-mode endpoint (default); override via DASHSCOPE_BASE_URL /
      // QWENCLOUD_BASE_URL / QWEN_BASE_URL for China Model Studio or other regional hosts.
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      baseUrlEnv: ['DASHSCOPE_BASE_URL', 'QWENCLOUD_BASE_URL', 'QWEN_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: true,   // DashScope chat completions support function calling; catalog may omit the flag
      supportsReasoning: null,
      // DashScope uses enable_thinking on select models, not OpenAI's reasoning_effort wire param.
      wireReasoningEffort: false,
      order: 45
    },
    {
      id: 'ollama',
      aliases: ['ollama-local'],
      name: 'Ollama',
      label: 'OLLAMA',
      endpoint: '127.0.0.1:11434/v1',
      blurb: 'local OpenAI-compatible endpoint',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'none',
      keyRequired: false,
      modelsRequireAuth: false,
      baseUrl: 'http://127.0.0.1:11434/v1',
      baseUrlEnv: ['OLLAMA_BASE_URL'],
      modelsPath: '/models',
      defaultReasoningEffort: 'none',
      unmetered: true,
      credentialPool: false,
      supportsTools: null,
      supportsReasoning: false,
      wireReasoningEffort: true,
      // Ollama loads the model (and a potentially large context allocation) before response headers.
      // A first local run can therefore be healthy but silent for well beyond the hosted 30s ceiling.
      connectTimeoutMs: 300000,
      order: 60
    },
    {
      id: 'custom',
      aliases: ['openai-compatible', 'local', 'vllm', 'lmstudio'],
      name: 'Custom OpenAI-Compatible',
      label: 'CUSTOM',
      endpoint: 'your /v1 endpoint',
      blurb: 'bring any OpenAI-compatible endpoint',
      live: true,
      adapter: 'openai-compatible',
      apiMode: 'chat_completions',
      authType: 'api_key_optional',
      keyRequired: false,
      keyEnv: ['CUSTOM_OPENAI_KEY', 'OPENAI_COMPATIBLE_KEY'],
      modelsRequireAuth: false,
      baseUrl: '',
      baseUrlEnv: ['CUSTOM_OPENAI_BASE_URL', 'OPENAI_COMPATIBLE_BASE_URL'],
      modelsPath: '/models',
      requiresBaseUrl: true,
      defaultReasoningEffort: 'medium',
      unmetered: false,
      credentialPool: true,
      supportsTools: null,
      supportsReasoning: null,
      order: 70
    }
  ];

  const BY_ID = new Map();
  const ALIASES = new Map();
  for (const profile of PROFILES) {
    BY_ID.set(profile.id, profile);
    ALIASES.set(profile.id, profile.id);
    for (const a of (profile.aliases || [])) ALIASES.set(String(a).toLowerCase(), profile.id);
  }

  function canonicalKey(value) {
    return String(value || '').trim().toLowerCase();
  }
  function getProviderProfile(value) {
    const key = canonicalKey(value);
    if (!key) return null;
    const id = ALIASES.get(key);
    return id ? BY_ID.get(id) || null : null;
  }
  function normalizeProviderId(value, fallback) {
    const profile = getProviderProfile(value);
    if (profile) return profile.id;
    return fallback == null ? '' : String(fallback);
  }
  function providerUsesCodex(value) {
    return normalizeProviderId(value, '') === 'codex';
  }
  // True for any profile on the STANDARD RFC 8628 device-code wire (grok / kimi). Codex is DELIBERATELY excluded
  // (it speaks OpenAI's proprietary usercode/exchange wire and keeps flowing through the providerUsesCodex paths
  // untouched) — so a caller can branch: codex -> ensureCodexAccessToken, device-oauth -> ensureOAuthAccessToken.
  function providerUsesDeviceOAuth(value) {
    const profile = getProviderProfile(value);
    return !!(profile && profile.authType === 'oauth_device_code' && profile.id !== 'codex');
  }
  function defaultReasoningEffortForProvider(value) {
    const profile = getProviderProfile(value) || BY_ID.get(DEFAULT_PROVIDER_ID);
    return (profile && profile.defaultReasoningEffort) || 'medium';
  }
  function providerRequiresKey(value) {
    const profile = getProviderProfile(value);
    return !!(profile && profile.keyRequired);
  }
  function providerRequiresBaseUrl(value) {
    const profile = getProviderProfile(value);
    return !!(profile && profile.requiresBaseUrl);
  }
  function toPublicProfile(profile) {
    return {
      id: profile.id,
      aliases: (profile.aliases || []).slice(),
      name: profile.name,
      label: profile.label,
      endpoint: profile.endpoint,
      blurb: profile.blurb,
      live: profile.live !== false,
      apiMode: profile.apiMode,
      authType: profile.authType,
      keyRequired: !!profile.keyRequired,
      keyEnv: (profile.keyEnv || []).slice(),
      modelsRequireAuth: profile.modelsRequireAuth !== false,
      baseUrl: profile.baseUrl || '',
      baseUrlEnv: (profile.baseUrlEnv || []).slice(),
      requiresBaseUrl: !!profile.requiresBaseUrl,
      defaultReasoningEffort: profile.defaultReasoningEffort || 'medium',
      unmetered: !!profile.unmetered,
      supportsTools: profile.supportsTools,
      supportsReasoning: profile.supportsReasoning,
      credentialPool: !!profile.credentialPool
    };
  }
  function listProviderProfiles(opts) {
    opts = opts || {};
    return PROFILES
      .filter(p => opts.includeInactive || p.live !== false)
      .slice()
      .sort((a, b) => (a.order || 1000) - (b.order || 1000) || a.id.localeCompare(b.id))
      .map(p => opts.public === false ? Object.assign({}, p) : toPublicProfile(p));
  }
  function providerIds(opts) {
    return listProviderProfiles(Object.assign({}, opts, { public: false })).map(p => p.id);
  }

  return {
    DEFAULT_PROVIDER_ID,
    getProviderProfile,
    listProviderProfiles,
    normalizeProviderId,
    providerUsesCodex,
    providerUsesDeviceOAuth,
    defaultReasoningEffortForProvider,
    providerRequiresKey,
    providerRequiresBaseUrl,
    providerIds,
    _profiles: PROFILES
  };
});
