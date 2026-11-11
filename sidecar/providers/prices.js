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
     · Long-context tiers are not PRICED. Gemini 2.5 / 3 / 3.1 Pro (above a 200k prompt), every xAI grok row (2x
       at 200k+) and Claude Haiku 5.5 (5x above a 100K-token prompt) bill a higher rate above a prompt threshold,
       so a prompt past it would UNDER-report here (the cap fires later than it should, never earlier). A run that
       prices from this table never sends one on purpose: promptTierTokens() below names each of those boundaries and
       the run's context manager keeps its working window under it (index.js runOnce windowCeiling, context.js
       makeContext), so a long run folds before a turn crosses into the dearer tier. Only a prompt that cannot be
       folded (one giant newest turn) can still cross it. A route that books the provider's BILLED cost (OpenRouter's
       usage.cost) prices every tier exactly and keeps the model's whole window (promptTierCeiling). The Claude
       1M-context beta on Sonnet 4 / 4.5 is not requested by anthropic.js.
     · Cache reads/writes bill at different rates than fresh input. This IS now modelled (see CACHE below)
       for the families whose rates are published — anthropic.js asks for prompt caching, so leaving it
       unmodelled would have overstated most of the input bill on every run. A family with no CACHE entry
       still prices cached tokens at the fresh rate and therefore OVER-reports, never under.
     · Anthropic cache writes price per tier (W1.13): the 5-minute tier at 1.25x, the 1-hour tier at 2.0x, split by
       the usage the API reports (cost.js writeUnits). A write reported without its split prices at the dearest tier
       the request asked for (see CACHE below), so it can only over-report.
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
  const node = typeof module !== 'undefined' && module.exports;
  const api = factory(node ? require('./cache-ttl.js') : ((root.SK && root.SK.providers) || {}).cacheTtl);
  if (node) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.providers = root.SK.providers || {}).prices = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (cacheTtl) {
  'use strict';

  // [pattern, { in, out, cacheRead? }] — USD per MILLION tokens. Order matters: specific before family fallback.
  // cacheRead: the model's DOCUMENTED cache-read ratio, only where it is not the family's (CACHE below). Billing never reads
  // it (the family rate over-reports these reads: the seatbelt's safe direction); cacheRatesOf below does.
  const ANTHROPIC = [
    // Claude 5 family (claude-api skill reference, 2026-06-24; models.dev 2026-08-21 concurs). The 5.5 rows and Sonnet 5
    // re-checked 2026-10-08 against the claude-api skill "Current Models" table (cached 2026-10-06). Cache reads re-checked
    // 2026-11-09 (shared/prompt-caching.md:144, shared/model-migration.md:1695 and :2040): $0.25/MTok on Fable 5.1 and
    // Mythos 5.1 (0.025x), $0.20/MTok on Opus 5.5 (0.05x), 0.1x on every other model; Fable 5 / Mythos 5 read at $1/MTok.
    [/^claude-fable-5[-.]1/i,        { in: 10.00, out: 50.00, cacheRead: 0.025 }],  // fable 5.1
    [/^claude-fable-5/i,             { in: 10.00, out: 50.00 }],  // fable 5
    [/^claude-mythos-5[-.]1/i,       { in: 10.00, out: 50.00, cacheRead: 0.025 }],  // Project Glasswing — Fable 5.1's rates (skill ref)
    [/^claude-mythos-5/i,            { in: 10.00, out: 50.00 }],  // Project Glasswing — same rate as Fable 5 (skill ref)
    [/^claude-mythos/i,              { in: 10.00, out: 50.00 }],  // mythos-preview: priced at the Fable/Mythos 5 rate (unverified id)
    [/^claude-opus-5[-.]5/i,         { in: 4.00, out: 20.00, cacheRead: 0.05 }],    // opus 5.5
    [/^claude-opus-5/i,              { in: 5.00, out: 25.00 }],
    [/^claude-sonnet-5/i,            { in: 2.00, out: 10.00 }],   // sonnet 5 and 5.5 share a rate ("at the same prices", skill ref)
    [/^claude-opus-4-[5678]/i,       { in: 5.00, out: 25.00 }],   // opus 4.5 / 4.6 / 4.7 / 4.8 share a rate
    [/^claude-haiku-5[-.]5/i,        { in: 0.10, out: 0.50 }],    // prompts <= 100K tokens; longer prompts bill $0.50/$2.50 (see header)
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

  const TABLES = { anthropic: ANTHROPIC, gemini: GEMINI, openai: OPENAI, xai: XAI, groq: GROQ, mistral: MISTRAL, deepseek: DEEPSEEK, together: TOGETHER, fireworks: FIREWORKS };

  /* CACHE MULTIPLIERS, per family — what a cached prompt token bills relative to a fresh one. This exists
     because anthropic.js now actually ASKS for prompt caching: until then every cached_tokens figure was
     zero and folding cache traffic into prompt_tokens at a flat 1.0x was the harmless imprecision this
     file's header used to describe. The moment a run caches, that flat rate stops being a rounding error and
     starts overstating most of the input bill.
     A family absent from here keeps the old 1.0x behaviour, so an unmodelled provider can only ever
     OVER-report — the safe direction for a spend seatbelt, and never a silent under-count. */
  /* The anthropic WRITE multiplier depends on the tier (claude-api skill, shared/prompt-caching.md:144): the 5-minute
     tier writes at 1.25x, the 1-hour tier at 2.0x. write5m / write1h price a write the API split by tier
     (usage.cache_creation; cost.js writeUnits). `write` prices a write whose split went unreported, at the dearest tier
     the request asked for (cache-ttl.js longestTier, the same switch the stampers read): 1.25x under the default, 2.0x
     once 1-hour anchors are requested (cacheOf below) — an operator who opts into the pricier tier sees it in the
     seatbelt, and an unreported split can only over-report. */
  const CACHE = {
    anthropic: { read: 0.10, write: 1.25, write5m: 1.25, write1h: 2.00 },
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
  const ANTHROPIC_1H = { read: 0.10, write: 2.00, write5m: 1.25, write1h: 2.00 };   // the same rates, 1-hour anchors requested
  function cacheOf(family) {
    if (family === 'anthropic' && cacheTtl && cacheTtl.longestTier() === '1h') return ANTHROPIC_1H;
    return CACHE[family] || NO_CACHE;
  }

  /* cacheRatesOf(id) -> { read, write } | null   THE CACHE RATES A MODEL IS DOCUMENTED TO BILL, WHEREVER IT IS SERVED
     (W2.1 review). Billing prices a cache read at its FAMILY's rate (CACHE above): Anthropic's 0.10x over-reports the
     Fable 5.1 / Mythos 5.1 (0.025x) and Opus 5.5 (0.05x) reads, the safe direction for a spend seatbelt. Whatever WEIGHS a
     read against a write (batched ageing's payback, history-edit.js) needs the opposite bound: a read priced above the
     model's own rate credits every later request with a saving it does not make. So it asks here, never the billing row:
       · a Claude model (a bare id of the anthropic table above; 'anthropic/claude-opus-5-5' through OpenRouter or the
         managed route is 'claude-opus-5-5') -> read: its row's documented cacheRead, else the family's 0.10x ("every
         other model at 0.1x"); write: the dearest tier the cache switch asks for (cacheOf: 1.25x, 2.0x once 1-hour anchors
         are requested). The same rates on every route: OpenRouter's catalog carries no cache rates, and the dearer write
         and the model's own read can only make a re-write weigh more and a saving less.
       · any other id -> null: its route's own rates are what there is to weigh.
     Matched on the bare id, as promptTierTokens is: the documented rates are a property of the model wherever it is
     billed. An operator price override rebases in/out, never these. */
  function cacheRatesOf(id) {
    const key = String(id == null ? '' : id).trim().split('/').pop();
    if (!/^claude-/i.test(key)) return null;
    for (const [re, price] of ANTHROPIC) {
      if (!re.test(key)) continue;
      const fam = cacheOf('anthropic');
      return { read: price.cacheRead != null ? price.cacheRead : fam.read, write: fam.write };
    }
    return null;
  }

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
    const cache = cacheOf(family);   // an operator override rebases in/out, never the cache ratios
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

  /* LONG-CONTEXT PRICE TIERS (context-cost-1023). The prompt size, in tokens, above which a model bills a HIGHER rate
     than its row above, for exactly the tiers this file documents (the row comments): Haiku 5.5 above 100K, Gemini
     2.5 / 3 / 3.1 Pro above 200k (an unseen Gemini Pro id is priced at the 3.x Pro row, so it takes that row's
     boundary), every grok row at 200k+. 0 = no tier known: the model bills one rate whatever the prompt, or this file
     does not know of a tier (it never invents one).
     A tier is a property of the MODEL wherever it is billed, so the bare id is matched on any route: 'google/gemini-2.5-pro'
     and 'models/gemini-2.5-pro' are 'gemini-2.5-pro'. Whether a RUN needs to stay under it is promptTierCeiling's call. */
  const PROMPT_TIERS = [
    [/^claude-haiku-5[-.]5/i,        100000],   // $0.10/$0.50 up to 100K, $0.50/$2.50 above
    [/^gemini-([2-9][\d.]*-)?pro/i,  200000],   // 2.5 / 3 / 3.1 Pro: the rows above are the <=200k tier
    [/^grok/i,                       200000]    // every xAI row above is the <200k tier; 200k+ bills 2x
  ];
  function promptTierTokens(id) {
    const key = String(id == null ? '' : id).trim().split('/').pop();
    if (!key) return 0;
    for (const [re, tokens] of PROMPT_TIERS) if (re.test(key)) return tokens;
    return 0;
  }

  /* THE RUN'S WINDOW CEILING (context-cost-1023): the prompt size a run on this route and model keeps its working
     window under, 0 = none (the model's whole window). 0.14.0 reads a model's REAL window (1M on Gemini Pro, 2M on grok),
     and folding at 65% of it would send 650k-token turns at a rate the spend caps cannot see when the caps price from
     the table above. So the ceiling is the model's tier boundary, EXCEPT:
       · an unmetered run (a flat subscription or a local model: exempt from every dollar cap) has no tier to stay under;
       · a route that books the provider's BILLED cost. OpenRouter returns usage.cost on every call (openrouter.js asks
         for it with usage:{include:true}) and cost.js reconcile books it over any catalog price (costSource 'provider'),
         so the meter and every cap already count the dearer tier. Its runs keep the whole window, as they did on 0.13.5,
         whose shared OpenRouter catalog already gave every run the real window.
     xAI keeps the ceiling: cost.js books its cost_in_usd_ticks when a response carries it, but its 0.13.5 runs worked in
     the cold 131072 guess, so 200k still gives them more room than 0.13.5 did, without a 2x tier on every long turn. */
  const BILLED_COST_ROUTES = new Set(['openrouter']);
  function promptTierCeiling(providerId, id, unmetered) {
    if (unmetered) return 0;
    if (BILLED_COST_ROUTES.has(String(providerId == null ? '' : providerId).trim().toLowerCase())) return 0;
    return promptTierTokens(id);
  }

  return { priceOf, pricingBlock, setLiveLookup, promptTierTokens, promptTierCeiling, cacheRatesOf, _internals: { ANTHROPIC, GEMINI, OPENAI, XAI, GROQ, MISTRAL, DEEPSEEK, TOGETHER, FIREWORKS, TABLES, CACHE, OVERRIDES, PROMPT_TIERS, BILLED_COST_ROUTES } };
});
