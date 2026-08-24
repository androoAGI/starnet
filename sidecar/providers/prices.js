/* sidecar/providers/prices.js — published list prices for the providers whose API does NOT report them.

   Most adapters get pricing off the wire: the OpenRouter and OpenAI-compatible catalogs carry a `pricing`
   block per model, and some providers report a real billed `usage.cost`, which cost.js always prefers.
   Anthropic's /v1/models and Google's /v1beta/models return NO price data at all, so both adapters hardcoded
   `pricing: null` -> priceOf() -> null -> cost.js dollars() -> 0.

   That zero was not cosmetic. `spentUsd` stayed 0.00 for an entire run, so the per-run hard ceiling in
   loop.js ("if (spentUsd >= maxCostUsd) return end('budget')") and the day/global pools could never fire on
   those providers — the spend seatbelt was structurally disconnected on two of the three biggest ones, and
   the budget UI rendered a permanent $0.00.

   WHAT THESE NUMBERS ARE: published list rates, USD per MILLION tokens, standard non-batch tier. They are
   an ESTIMATE, never a billed amount. cost.js labels anything derived from here `costSource: 'catalog'` —
   distinct from 'provider' (a real billed figure that came over the wire) — so the honesty channel stays
   intact and a caller can always tell an estimate from a fact. A model that matches nothing here stays
   `unpriced` rather than being guessed at, exactly like the Perplexity entry in registry.js.

   KNOWN IMPRECISION, stated rather than hidden:
     · Long-context tiers are not modelled. Gemini 2.5 Pro and the Claude 1M-context beta bill a higher rate
       above a prompt threshold, so a very long prompt UNDER-reports here (the cap fires later than it
       should, never earlier).
     · Cache reads/writes bill at different rates than fresh input. This IS now modelled (see CACHE below)
       for the families whose rates are published — anthropic.js asks for prompt caching, so leaving it
       unmodelled would have overstated most of the input bill on every run. A family with no CACHE entry
       still prices cached tokens at the fresh rate and therefore OVER-reports, never under.
     · Anthropic's 1-hour cache TTL writes at 2.0x; only the default 5-minute (1.25x) tier is modelled.
     · Batch/priority tiers are not modelled.
   For a spend SEATBELT an approximate number is enormously better than a structural zero, which is the
   trade being made here.

   Rates verified 2026-08-21: Anthropic against the claude-api skill reference (2026-06-24 snapshot) + models.dev;
   OpenAI against developers.openai.com/api/docs/pricing; xAI docs.x.ai/docs/models; Gemini ai.google.dev pricing;
   Mistral mistral.ai/pricing/api; Groq console.groq.com/docs/models; Together together.ai/pricing; Fireworks
   docs.fireworks.ai/serverless/pricing; DeepSeek's vendor page is JS-rendered (unreadable headless) so its rows
   carry the models.dev + benchlm.ai figures (two concurring third-party sources, named inline). Ids a vendor
   page did not list get ONLY a family fallback and a comment naming the gap — nothing here is invented.
   (Original table verified 2026-07-24.) They WILL go stale — override any
   entry without a code change via SKYNET_MODEL_PRICES, a JSON object of
   { "<model-id-or-prefix>": { "in": <usd per Mtok>, "out": <usd per Mtok> } }. An override whose key is a
   prefix of the model id wins over every built-in rule below.

   Patterns are tried IN ORDER, so a specific id beats its family fallback. The family fallbacks at the end
   of each list exist so a newly-released model in a known family gets an approximately-right cap instead of
   silently disabling the seatbelt again. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).prices = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // [pattern, { in, out }] — USD per MILLION tokens. Order matters: specific before family fallback.
  const ANTHROPIC = [
    // Claude 5 family (claude-api skill reference, 2026-06-24; models.dev 2026-08-21 concurs)
    [/^claude-fable-5/i,             { in: 10.00, out: 50.00 }],
    [/^claude-mythos-5/i,            { in: 10.00, out: 50.00 }],  // Project Glasswing — same rate as Fable 5 (skill ref)
    [/^claude-mythos/i,              { in: 10.00, out: 50.00 }],  // mythos-preview: priced at the Fable/Mythos 5 rate (unverified id)
    [/^claude-opus-5/i,              { in: 5.00, out: 25.00 }],
    [/^claude-sonnet-5/i,            { in: 3.00, out: 15.00 }],   // LIST rate; $2/$10 intro through 2026-08-31 — over-reports until then
    [/^claude-opus-4-[5678]/i,       { in: 5.00, out: 25.00 }],   // opus 4.5 / 4.6 / 4.7 / 4.8 share a rate
    [/^claude-haiku-4-5/i,           { in: 1.00, out: 5.00 }],
    [/^claude-sonnet-4/i,            { in: 3.00, out: 15.00 }],   // sonnet 4 / 4.5 / 4.6 share a rate
    [/^claude-opus-4/i,              { in: 15.00, out: 75.00 }],  // opus 4 / 4.1 (4.5+ matched above)
    [/^claude-3-5-haiku/i,           { in: 0.80, out: 4.00 }],
    [/^claude-3-haiku/i,             { in: 0.25, out: 1.25 }],
    [/^claude-3-(5|7)-sonnet/i,      { in: 3.00, out: 15.00 }],
    [/^claude-3-sonnet/i,            { in: 3.00, out: 15.00 }],
    [/^claude-3-opus/i,              { in: 15.00, out: 75.00 }],
    // family fallbacks for ids this table has not seen yet
    [/fable|mythos/i,                { in: 10.00, out: 50.00 }],
    [/opus/i,                        { in: 15.00, out: 75.00 }],
    [/sonnet/i,                      { in: 3.00, out: 15.00 }],
    [/haiku/i,                       { in: 1.00, out: 5.00 }]
  ];

  const GEMINI = [
    // 3.x (ai.google.dev/gemini-api/docs/pricing, 2026-08-21; 3.6/3.7 flash rates double 2027-01-01)
    [/^gemini-3\.7-flash/i,          { in: 0.75, out: 3.75 }],
    [/^gemini-3\.6-flash/i,          { in: 0.75, out: 3.75 }],
    [/^gemini-3\.5-flash-lite/i,     { in: 0.30, out: 2.50 }],
    [/^gemini-3\.5-flash/i,          { in: 1.50, out: 9.00 }],
    [/^gemini-3\.1-flash-lite/i,     { in: 0.25, out: 1.50 }],
    [/^gemini-3\.1-pro/i,            { in: 2.00, out: 12.00 }],   // <=200k prompt tier
    [/^gemini-3-flash/i,             { in: 0.50, out: 3.00 }],
    [/^gemini-3-pro/i,               { in: 2.00, out: 12.00 }],
    [/^gemini-flash-lite-latest/i,   { in: 0.30, out: 2.50 }],
    [/^gemini-flash-latest/i,        { in: 0.75, out: 3.75 }],
    [/^gemini-2\.5-flash-lite/i,     { in: 0.10, out: 0.40 }],
    [/^gemini-2\.5-flash/i,          { in: 0.30, out: 2.50 }],
    [/^gemini-2\.5-pro/i,            { in: 1.25, out: 10.00 }],   // base tier; >200k prompt bills higher
    [/^gemini-2\.0-flash-lite/i,     { in: 0.075, out: 0.30 }],
    [/^gemini-2\.0-flash/i,          { in: 0.10, out: 0.40 }],
    [/^gemini-1\.5-pro/i,            { in: 1.25, out: 5.00 }],
    [/^gemini-1\.5-flash/i,          { in: 0.075, out: 0.30 }],
    // family fallbacks for ids this table has not seen yet — priced at the newest (dearest) tier of each family
    [/flash-lite/i,                  { in: 0.30, out: 2.50 }],
    [/flash/i,                       { in: 1.50, out: 9.00 }],
    [/pro/i,                         { in: 2.00, out: 12.00 }]
  ];

  // developers.openai.com/api/docs/pricing, 2026-08-21 (standard tier)
  const OPENAI = [
    [/^gpt-5\.6-sol/i,               { in: 4.00, out: 20.00 }],
    [/^gpt-5\.6-terra/i,             { in: 2.00, out: 12.00 }],
    [/^gpt-5\.6-luna/i,              { in: 0.20, out: 1.20 }],
    [/^gpt-5\.5-pro/i,               { in: 30.00, out: 180.00 }],
    [/^gpt-5\.5/i,                   { in: 5.00, out: 30.00 }],
    [/^gpt-5\.4-pro/i,               { in: 30.00, out: 180.00 }],
    [/^gpt-5\.4-mini/i,              { in: 0.75, out: 4.50 }],
    [/^gpt-5\.4-nano/i,              { in: 0.20, out: 1.25 }],
    [/^gpt-5\.4/i,                   { in: 2.50, out: 15.00 }],
    [/^gpt-5\.2-pro/i,               { in: 21.00, out: 168.00 }], // models.dev only — not on the vendor page
    [/^gpt-5\.[23]/i,                { in: 1.75, out: 14.00 }],   // 5.2 (vendor); 5.3-codex/-chat carry 5.2's rate (models.dev only)
    [/^gpt-5\.1/i,                   { in: 1.25, out: 10.00 }],
    [/^gpt-5-pro/i,                  { in: 15.00, out: 120.00 }], // models.dev only
    [/^gpt-5-mini/i,                 { in: 0.25, out: 2.00 }],
    [/^gpt-5-nano/i,                 { in: 0.05, out: 0.40 }],
    [/^gpt-5$/i,                     { in: 1.25, out: 10.00 }],
    [/^o1-pro/i,                     { in: 150.00, out: 600.00 }],
    [/^o1/i,                         { in: 15.00, out: 60.00 }],
    [/^o3-pro/i,                     { in: 20.00, out: 80.00 }],
    [/^o3-mini/i,                    { in: 1.10, out: 4.40 }],    // models.dev only
    [/^o3/i,                         { in: 2.00, out: 8.00 }],
    [/^o4-mini/i,                    { in: 1.10, out: 4.40 }],
    [/^gpt-4\.1-mini/i,              { in: 0.40, out: 1.60 }],
    [/^gpt-4\.1-nano/i,              { in: 0.10, out: 0.40 }],    // models.dev only
    [/^gpt-4\.1/i,                   { in: 2.00, out: 8.00 }],
    [/^gpt-4o-mini/i,                { in: 0.15, out: 0.60 }],    // models.dev only
    [/^gpt-4o/i,                     { in: 2.50, out: 10.00 }],
    [/^gpt-4-turbo/i,                { in: 10.00, out: 30.00 }],  // models.dev only
    [/^gpt-4/i,                      { in: 30.00, out: 60.00 }],  // models.dev only
    [/^gpt-3\.5/i,                   { in: 0.50, out: 1.50 }],    // models.dev only
    // family fallbacks (unseen ids): bare gpt-5.6 is NOT on the vendor page — it rides the sol (flagship) rate
    [/^gpt-5\.6/i,                   { in: 4.00, out: 20.00 }],
    [/-pro\b/i,                      { in: 30.00, out: 180.00 }],
    [/-nano\b/i,                     { in: 0.20, out: 1.25 }],
    [/-mini\b/i,                     { in: 0.75, out: 4.50 }],
    [/^o\d/i,                        { in: 2.00, out: 8.00 }],
    [/^gpt-5/i,                      { in: 5.00, out: 30.00 }],
    [/^gpt/i,                        { in: 2.50, out: 10.00 }]
  ];

  // docs.x.ai/docs/models, 2026-08-21 — <200k-prompt tier (the >=200k tier bills 2x; under-reports on huge prompts)
  const XAI = [
    [/^grok-4\.6/i,                  { in: 2.00, out: 6.00 }],
    [/^grok-4\.5/i,                  { in: 2.00, out: 6.00 }],
    [/^grok-4\.3/i,                  { in: 1.25, out: 2.50 }],
    [/^grok-4\.20/i,                 { in: 1.25, out: 2.50 }],
    [/^grok-build/i,                 { in: 1.00, out: 2.00 }],
    // family fallback — grok-4 / grok-3 / grok-code-fast-1 (registry staticModels) are no longer on the vendor page
    [/^grok/i,                       { in: 2.00, out: 6.00 }]
  ];

  // console.groq.com/docs/models, 2026-08-21 (production models); the rest are models.dev only
  const GROQ = [
    [/gpt-oss-120b/i,                { in: 0.15, out: 0.60 }],
    [/gpt-oss-(safeguard-)?20b/i,    { in: 0.075, out: 0.30 }],
    [/llama-3\.3-70b/i,              { in: 0.59, out: 0.79 }],    // models.dev only
    [/llama-3\.1-8b/i,               { in: 0.05, out: 0.08 }],    // models.dev only
    [/qwen3\.6-27b/i,                { in: 0.60, out: 3.00 }],    // models.dev only
    // family fallbacks
    [/70b|120b|qwen/i,               { in: 0.60, out: 3.00 }],
    [/llama|gpt-oss|gemma|mistral|mixtral|compound/i, { in: 0.59, out: 0.79 }]
  ];

  // mistral.ai/pricing/api, 2026-08-21
  const MISTRAL = [
    [/^mistral-medium/i,             { in: 1.50, out: 7.50 }],    // Medium 3.5 (the -latest alias); older 2505/2508 billed 0.4/2 — over-reports
    [/^mistral-large-2411|^pixtral-large/i, { in: 2.00, out: 6.00 }], // models.dev only
    [/^mistral-large/i,              { in: 0.50, out: 1.50 }],    // Large 3
    [/^mistral-small/i,              { in: 0.15, out: 0.60 }],    // Small 4
    [/^codestral/i,                  { in: 0.30, out: 0.90 }],
    [/^devstral-small/i,             { in: 0.10, out: 0.30 }],    // models.dev only
    [/^devstral/i,                   { in: 0.40, out: 2.00 }],    // models.dev only
    [/^magistral-medium/i,           { in: 2.00, out: 5.00 }],    // models.dev only
    [/^magistral/i,                  { in: 0.50, out: 1.50 }],    // models.dev only
    [/^ministral-14b/i,              { in: 0.20, out: 0.20 }],
    [/^ministral-8b/i,               { in: 0.15, out: 0.15 }],
    [/^ministral-3b/i,               { in: 0.10, out: 0.10 }],
    [/^voxtral-small/i,              { in: 0.10, out: 0.40 }],
    [/^open-mixtral-8x22b/i,         { in: 2.00, out: 6.00 }],    // models.dev only
    [/^open-mixtral-8x7b/i,          { in: 0.70, out: 0.70 }],    // models.dev only
    [/nemo|^open-mistral-7b|^pixtral-12b/i, { in: 0.25, out: 0.25 }], // models.dev only (nemo 0.15; 7b 0.25 — dearer wins)
    [/^glm-5/i,                      { in: 1.40, out: 4.40 }],
    // family fallbacks
    [/large|medium/i,                { in: 1.50, out: 7.50 }],
    [/ministral/i,                   { in: 0.20, out: 0.20 }],
    [/mistral|small|codestral|devstral|magistral|pixtral/i, { in: 0.50, out: 1.50 }]
  ];

  // DeepSeek: api-docs.deepseek.com/quick_start/pricing is client-rendered and could not be read headless on
  // 2026-08-21. These are the models.dev + benchlm.ai (synced 2026-07-31) figures, which agree with each
  // other; other aggregators report a peak-hours tier up to 3x higher, so this table may UNDER-report at peak.
  const DEEPSEEK = [
    [/^deepseek-v4-pro/i,            { in: 0.435, out: 0.87 }],
    [/^deepseek-v4-flash/i,          { in: 0.14, out: 0.28 }],
    [/^deepseek-(chat|reasoner)/i,   { in: 0.14, out: 0.28 }],
    // family fallback
    [/deepseek/i,                    { in: 0.435, out: 0.87 }]
  ];

  // together.ai/pricing (serverless), 2026-08-21; org-prefixed ids (e.g. deepseek-ai/DeepSeek-V4-Pro-0813)
  const TOGETHER = [
    [/kimi-k3/i,                     { in: 3.00, out: 15.00 }],
    [/kimi-k2\.7/i,                  { in: 0.95, out: 4.00 }],
    [/kimi-k2\.6/i,                  { in: 1.20, out: 4.50 }],    // models.dev only
    [/kimi-k2/i,                     { in: 0.50, out: 2.80 }],    // models.dev only (K2.5)
    [/glm-5\.[12]/i,                 { in: 1.40, out: 4.40 }],
    [/glm-5/i,                       { in: 1.00, out: 3.20 }],    // models.dev only
    [/qwen3\.8/i,                    { in: 2.50, out: 6.25 }],
    [/qwen3\.7-max/i,                { in: 1.25, out: 3.75 }],
    [/qwen3\.7-plus/i,               { in: 0.32, out: 1.28 }],
    [/qwen3\.6-plus/i,               { in: 0.50, out: 3.00 }],    // models.dev only
    [/qwen3\.5-397b/i,               { in: 0.60, out: 3.60 }],    // models.dev only
    [/qwen3\.5-9b/i,                 { in: 0.17, out: 0.25 }],
    [/qwen3-coder-480b/i,            { in: 2.00, out: 2.00 }],    // models.dev only
    [/deepseek-v4-pro-0813/i,        { in: 1.32, out: 3.96 }],
    [/deepseek-v4-pro/i,             { in: 1.74, out: 3.48 }],    // models.dev only (pre-0813)
    [/deepseek-v4-flash/i,           { in: 0.14, out: 0.28 }],
    [/deepseek-r1/i,                 { in: 3.00, out: 7.00 }],    // models.dev only
    [/deepseek-v3-1/i,               { in: 0.60, out: 1.70 }],    // models.dev only
    [/deepseek-v3/i,                 { in: 1.25, out: 1.25 }],    // models.dev only
    [/llama-3\.3-70b/i,              { in: 1.04, out: 1.04 }],
    [/llama-3-8b/i,                  { in: 0.14, out: 0.14 }],    // models.dev only
    [/minimax-m/i,                   { in: 0.30, out: 1.20 }],    // models.dev only
    [/gpt-oss-120b/i,                { in: 0.15, out: 0.60 }],    // models.dev only
    [/gpt-oss-20b/i,                 { in: 0.05, out: 0.20 }],
    [/gemma-4-31b/i,                 { in: 0.39, out: 0.97 }],    // models.dev only
    [/gemma-3n/i,                    { in: 0.06, out: 0.12 }],
    [/nemotron-3-ultra/i,            { in: 0.60, out: 3.60 }],    // models.dev only
    // family fallbacks — unknown org-prefixed ids take the dearest rate of their family
    [/deepseek/i,                    { in: 1.74, out: 3.48 }],
    [/kimi|moonshot/i,               { in: 3.00, out: 15.00 }],
    [/qwen/i,                        { in: 2.50, out: 6.25 }],
    [/glm|zai/i,                     { in: 1.40, out: 4.40 }],
    [/llama|meta-llama/i,            { in: 1.04, out: 1.04 }],
    [/gpt-oss|openai/i,              { in: 0.15, out: 0.60 }],
    [/gemma|google/i,                { in: 0.39, out: 0.97 }],
    [/mistral|mixtral/i,             { in: 1.04, out: 1.04 }]     // no Mistral rows on the vendor page — 70B-class rate
  ];

  // docs.fireworks.ai/serverless/pricing (standard tier), 2026-08-21; ids are accounts/fireworks/models/<slug>
  const FIREWORKS = [
    [/kimi-k3-fast/i,                { in: 4.50, out: 22.50 }],   // models.dev only (router)
    [/kimi-k3/i,                     { in: 3.00, out: 15.00 }],
    [/kimi-k2p7-code-fast/i,         { in: 1.90, out: 8.00 }],    // models.dev only (router)
    [/kimi-k2p7/i,                   { in: 0.95, out: 4.00 }],    // models.dev only
    [/kimi-k2p6-(fast|turbo)/i,      { in: 2.00, out: 8.00 }],    // models.dev only (router)
    [/kimi-k2p6/i,                   { in: 0.95, out: 4.00 }],    // models.dev only
    [/deepseek-v4-pro/i,             { in: 1.74, out: 3.48 }],
    [/deepseek-v4-flash/i,           { in: 0.22, out: 0.66 }],    // vendor page; models.dev lists 0.14/0.28 — dearer wins
    [/glm-5p2-fast/i,                { in: 2.10, out: 6.60 }],    // models.dev only (router)
    [/glm-5p[12]/i,                  { in: 1.40, out: 4.40 }],
    [/qwen3p8-max/i,                 { in: 2.00, out: 6.00 }],
    [/qwen3p7-plus/i,                { in: 0.40, out: 1.60 }],
    [/minimax-m/i,                   { in: 0.30, out: 1.20 }],
    [/gpt-oss-120b/i,                { in: 0.15, out: 0.60 }],
    [/gpt-oss-20b/i,                 { in: 0.07, out: 0.30 }],
    [/nemotron-lightning/i,          { in: 0.05, out: 0.20 }],
    [/nemotron-3-ultra/i,            { in: 0.60, out: 2.40 }],    // models.dev only
    [/inkling/i,                     { in: 1.00, out: 4.05 }],    // models.dev only
    [/muse-glimmer/i,                { in: 0.35, out: 1.50 }],    // models.dev only
    // family fallbacks — by family, then the vendor's published parameter-size tiers (MoE 56.1B–176B = 1.20)
    [/kimi/i,                        { in: 3.00, out: 15.00 }],
    [/deepseek/i,                    { in: 1.74, out: 3.48 }],
    [/glm/i,                         { in: 1.40, out: 4.40 }],
    [/qwen/i,                        { in: 2.00, out: 6.00 }],
    [/\/routers\//i,                 { in: 4.50, out: 22.50 }],   // an unknown router: dearest known router rate
    [/./,                            { in: 1.20, out: 1.20 }]     // any other serverless id: the top size tier
  ];

  // Alibaba Model Studio / DashScope list rates (USD per Mtok, standard tier), approximate 2026-08.
  // Sourced from public pricing docs; family fallbacks stay conservative until tests pin each id.
  const QWEN = [
    [/^qwen3\.5-plus/i,               { in: 0.40, out: 1.20 }],
    [/^qwen3\.5-flash/i,              { in: 0.10, out: 0.40 }],
    [/^qwen3-max/i,                   { in: 1.60, out: 6.40 }],
    [/^qwen-max/i,                    { in: 1.60, out: 6.40 }],
    [/^qwen-plus/i,                   { in: 0.40, out: 1.20 }],
    [/^qwen-turbo/i,                  { in: 0.05, out: 0.20 }],
    [/^qwen-long/i,                   { in: 0.40, out: 1.20 }],
    [/^qwen2\.5-72b/i,                { in: 0.40, out: 1.20 }],
    [/^qwen2\.5-32b/i,                { in: 0.20, out: 0.60 }],
    [/^qwen2\.5-14b/i,                { in: 0.10, out: 0.30 }],
    [/^qwen2\.5-7b/i,                 { in: 0.05, out: 0.15 }],
    [/^qwen2\.5-coder/i,              { in: 0.20, out: 0.60 }],
    [/^qwen2\.5/i,                    { in: 0.20, out: 0.60 }],
    [/^qwen3/i,                       { in: 0.40, out: 1.20 }],
    [/qwen/i,                         { in: 0.40, out: 1.20 }]
  ];

  const TABLES = { anthropic: ANTHROPIC, gemini: GEMINI, openai: OPENAI, xai: XAI, groq: GROQ, mistral: MISTRAL, deepseek: DEEPSEEK, together: TOGETHER, fireworks: FIREWORKS, qwen: QWEN };

  /* CACHE MULTIPLIERS, per family — what a cached prompt token bills relative to a fresh one. This exists
     because anthropic.js now actually ASKS for prompt caching: until then every cached_tokens figure was
     zero and folding cache traffic into prompt_tokens at a flat 1.0x was the harmless imprecision this
     file's header used to describe. The moment a run caches, that flat rate stops being a rounding error and
     starts overstating most of the input bill.
     A family absent from here keeps the old 1.0x behaviour, so an unmodelled provider can only ever
     OVER-report — the safe direction for a spend seatbelt, and never a silent under-count. */
  /* The anthropic write multiplier tracks the TTL tier anthropic.js actually requests: the 5-minute tier
     writes at 1.25x, the 1-hour tier (SKYNET_ANTHROPIC_CACHE_TTL=1h) at 2.0x. Reading the SAME env both
     sides keeps the estimate honest — an operator who opts into the pricier tier sees it in the seatbelt. */
  const ANTHROPIC_TTL_1H = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_ANTHROPIC_CACHE_TTL : '';
      return String(raw == null ? '' : raw).trim().toLowerCase() === '1h';
    } catch (_) { return false; }
  })();
  const CACHE = {
    anthropic: { read: 0.10, write: ANTHROPIC_TTL_1H ? 2.00 : 1.25 },
    gemini:    { read: 0.25, write: 1.00 },   // implicit context caching — no separate write charge published
    // 2026-08-21. OpenAI: cached input is 0.10x list on every current model (gpt-5.x, gpt-4.1, o3/o4); the
    // legacy o1 (0.50x) and gpt-4o (0.50x) rows UNDER-report cache reads at this ratio — accepted, they are
    // not the default on any profile. DeepSeek: cache hit 0.0028 vs miss 0.14 = 0.02x. Mistral: a flat 90%
    // cached-input discount (0.10x). xAI publishes 0.16–0.25x but no single ratio — left unmodelled (1.0x,
    // over-reports). None of these publish a separate write charge.
    openai:    { read: 0.10, write: 1.00 },
    deepseek:  { read: 0.02, write: 1.00 },
    mistral:   { read: 0.10, write: 1.00 }
  };
  const NO_CACHE = { read: 1, write: 1 };

  // Operator overrides, parsed ONCE and tolerant of garbage — a typo in the env must never wedge a run
  // (same discipline as SKYNET_ANTHROPIC_MAX_TOKENS in anthropic.js). Longest matching key wins, so a full
  // model id beats a family prefix.
  const OVERRIDES = (function () {
    try {
      const raw = (typeof process !== 'undefined' && process.env) ? process.env.SKYNET_MODEL_PRICES : '';
      const s = String(raw == null ? '' : raw).trim();
      if (!s) return [];
      const obj = JSON.parse(s);
      if (!obj || typeof obj !== 'object') return [];
      const out = [];
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (!v || typeof v !== 'object') continue;
        const i = Number(v.in), o = Number(v.out);
        if (!Number.isFinite(i) || !Number.isFinite(o) || i < 0 || o < 0) continue;
        out.push({ key: String(k).toLowerCase(), price: { in: i, out: o } });
      }
      return out.sort((a, b) => b.key.length - a.key.length);   // longest (most specific) key first
    } catch (_) { return []; }
  })();

  /* priceOf(family, id) -> { in, out } | null   — per-million USD, or null when nothing matches (honest
     'unpriced'). Deliberately INDEPENDENT of catalog warm state: contextLimit() is 0 until a catalog loads,
     and the spend cap must not inherit that same cold-start hole — it has to work from the very first turn. */
  /* LIVE CATALOG SEAM (2026-07-31, Hermes-parity pass). The host may wire a lookup backed by the models.dev
     aggregate (liveprices.js) so a newly-released model gets its real published rate instead of a stale
     family fallback. Precedence is deliberate: an OPERATOR override always wins; the LIVE published rate
     beats the built-in snapshot (which goes stale between releases); the snapshot remains the offline floor.
     Everything from here is still an ESTIMATE (costSource 'catalog') — the honesty channel is unchanged,
     and a throwing/garbage lookup must never wedge the seatbelt, hence the try + shape check. */
  let liveLookup = null;
  function setLiveLookup(fn) { liveLookup = typeof fn === 'function' ? fn : null; }
  function priceOf(family, id) {
    const key = String(id == null ? '' : id).trim();
    if (!key) return null;
    const cache = CACHE[family] || NO_CACHE;   // an operator override rebases in/out, never the cache ratios
    const lower = key.toLowerCase();
    for (const o of OVERRIDES) if (lower.indexOf(o.key) === 0) return { in: o.price.in, out: o.price.out, cache };
    if (liveLookup) {
      try {
        const lv = liveLookup(family, key);
        if (lv && Number.isFinite(lv.in) && Number.isFinite(lv.out) && lv.in >= 0 && lv.out >= 0) {
          return { in: lv.in, out: lv.out, cache };
        }
      } catch (_) { /* a broken live catalog falls through to the built-in snapshot */ }
    }
    const table = TABLES[family];
    if (!table) return null;
    for (const [re, price] of table) if (re.test(key)) return { in: price.in, out: price.out, cache };
    return null;
  }

  /* The catalog `pricing` block shape the other adapters already publish: per-TOKEN decimal strings under
     {prompt, completion} (openrouter.js / openai-compatible.js both parseFloat(...) * 1e6 to get back to
     per-million). Returning the same shape keeps listModels() consistent across every provider, so the
     connect screen and priceOf() can never disagree. */
  function pricingBlock(family, id) {
    const p = priceOf(family, id);
    if (!p) return null;
    return { prompt: String(p.in / 1e6), completion: String(p.out / 1e6) };
  }

  return { priceOf, pricingBlock, setLiveLookup, _internals: { ANTHROPIC, GEMINI, OPENAI, XAI, GROQ, MISTRAL, DEEPSEEK, TOGETHER, FIREWORKS, TABLES, CACHE, OVERRIDES } };
});
