/* STARNET quick model selector. Lives in COMMS beside voice controls; transport state stays in Harness. */
'use strict';

const ModelDock = (() => {
  const el = id => document.getElementById(id);
  // Delegates to the one complete implementation (U.esc escapes & < > " ' — quotes included, so the id="…"
  // / title="…" attribute contexts this dock builds are injection-safe); keep the null-guard the local had.
  const esc = s => U.esc(s == null ? '' : s);
  const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark'];
  // Fallback seed only (used when the live /api/models fetch fails) — real, current model ids only.
  // A missing fallback id is honest; an invented one is a lie. claude-3-5-haiku retired 2026-02-19,
  // so it's dropped here; opus-4-8 / sonnet-5 / haiku-4-5 are the current confirmed-real set.
  const ANTHROPIC_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];
  const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'];
  const HOSTED_FALLBACKS = {
    xai: ['grok-4.3', 'grok-4-fast', 'grok-4'],
    groq: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'meta-llama/llama-4-scout-17b-16e-instruct'],
    mistral: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],   // dropped 'deepseek-v4-pro' — unconfirmed/invented; real line is chat + reasoner (+ v3 snapshots)
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', 'deepseek-ai/DeepSeek-V3'],
    fireworks: ['accounts/fireworks/models/deepseek-v3p1', 'accounts/fireworks/models/kimi-k2p5', 'accounts/fireworks/models/llama-v3p3-70b-instruct'],
    perplexity: ['sonar-pro', 'sonar', 'sonar-reasoning-pro'],
    cerebras: ['llama-4-scout-17b-16e-instruct', 'llama3.1-8b', 'qwen-3-coder-480b']
  };
  // OpenRouter fallback seed — real slugs only (shown labelled "(catalog offline)" when the live fetch fails).
  const OPENROUTER_FALLBACK = [
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-5',
    'openai/gpt-5',
    'google/gemini-2.5-pro',
    'x-ai/grok-4'
  ];
  const EFFORTS = [
    { id: 'none', label: 'OFF', title: 'Reasoning off' },
    { id: 'minimal', label: 'MIN', title: 'Minimal reasoning' },
    { id: 'low', label: 'LOW', title: 'Low reasoning' },
    { id: 'medium', label: 'MED', title: 'Medium reasoning' },
    { id: 'high', label: 'HIGH', title: 'High reasoning' },
    { id: 'xhigh', label: 'XHIGH', title: 'Extra-high reasoning' },
    { id: 'max', label: 'MAX', title: 'Maximum reasoning' }
  ];
  // The ChatGPT-account Codex backend exposes EXACTLY these four levels (verified live) — no 'none', no
  // 'minimal'. The CLI's "Fast mode" is just 'low' surfaced as a variant, so the low chip reads FAST here.
  const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
  const OPENROUTER_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const REASONING_EFFORT_ORDER = OPENROUTER_REASONING_EFFORTS;
  const OFF_ONLY_EFFORTS = ['none'];
  const GROUP_NAMES = {
    anthropic: 'ANTHROPIC',
    openai: 'OPENAI',
    google: 'GOOGLE',
    'x-ai': 'XAI',
    meta: 'META',
    'meta-llama': 'META',
    mistralai: 'MISTRAL',
    deepseek: 'DEEPSEEK',
    qwen: 'QWEN',
    cohere: 'COHERE'
  };
  const PROVIDER_RANK = { starnet: -1, codex: 0, grok: 1, kimi: 2, openrouter: 3, openai: 4, anthropic: 5, gemini: 6, xai: 7, groq: 8, mistral: 9, deepseek: 10, together: 11, fireworks: 12, perplexity: 13, cerebras: 14, ollama: 15, custom: 16 };

  let opts = {};
  let wired = false;
  let open = false;
  let loading = false;
  let cache = {};
  // Per-provider truth about the catalog fetch. A populated fallback list is useful for recovery, but it is
  // not proof that a saved model still belongs to the active provider. Only a successful provider response
  // may reconcile (or invalidate) the current provider/model pair.
  let catalogState = {};
  let models = [];

  function provider() {
    const p = (typeof Harness !== 'undefined' && Harness.getProv) ? Harness.getProv() : 'openrouter';
    return normalizeProvider(p);
  }
  function providerLabel(p) {
    p = normalizeProvider(p);
    const map = { starnet: 'STARNET', codex: 'GPT / CODEX', grok: 'GROK OAUTH', kimi: 'KIMI OAUTH', openrouter: 'OPENROUTER', openai: 'OPENAI API', anthropic: 'ANTHROPIC', gemini: 'GEMINI', xai: 'XAI', groq: 'GROQ', mistral: 'MISTRAL', deepseek: 'DEEPSEEK', together: 'TOGETHER', fireworks: 'FIREWORKS', perplexity: 'PERPLEXITY', cerebras: 'CEREBRAS', ollama: 'OLLAMA', custom: 'CUSTOM' };
    return map[p] || String(p || 'openrouter').toUpperCase();
  }
  function normalizeProvider(p) {
    p = String(p || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'anthropic' || p === 'claude') return 'anthropic';
    if (p === 'gemini' || p === 'google' || p === 'google-ai' || p === 'google-gemini') return 'gemini';
    // grok/kimi are their OWN keyless OAuth providers now — NOT aliases for the xAI (API KEY) provider.
    if (p === 'grok' || p === 'grok-oauth' || p === 'supergrok') return 'grok';
    if (p === 'kimi' || p === 'moonshot' || p === 'kimi-for-coding') return 'kimi';
    if (p === 'xai' || p === 'x-ai') return 'xai';
    if (p === 'groq') return 'groq';
    if (p === 'mistral' || p === 'mistralai') return 'mistral';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'together' || p === 'together-ai') return 'together';
    if (p === 'fireworks' || p === 'fireworks-ai') return 'fireworks';
    if (p === 'perplexity' || p === 'pplx' || p === 'sonar') return 'perplexity';
    if (p === 'cerebras') return 'cerebras';
    // managed credits — bearer is the linked device token (mirrors app.js + registry.js aliases)
    if (p === 'starnet' || p === 'starnet-cloud' || p === 'managed') return 'starnet';
    if (p === 'ollama' || p === 'ollama-local') return 'ollama';
    if (p === 'custom' || p === 'openai-compatible' || p === 'local' || p === 'vllm' || p === 'lmstudio') return 'custom';
    return 'openrouter';
  }
  function apiFetch(url, init) {
    return (typeof Harness !== 'undefined' && Harness.apiFetch) ? Harness.apiFetch(url, init) : fetch(url, init);
  }

  function normalizeEffort(value) {
    if (typeof Harness !== 'undefined' && Harness.normalizeReasoningEffort) return Harness.normalizeReasoningEffort(value);
    const key = String(value || 'medium').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const map = {
      off: 'none', none: 'none', no: 'none', disabled: 'none',
      min: 'minimal', minimal: 'minimal',
      low: 'low',
      med: 'medium', mid: 'medium', medium: 'medium',
      high: 'high',
      extra: 'xhigh', xtra: 'xhigh', extrahigh: 'xhigh', xhigh: 'xhigh',
      max: 'max'
    };
    return map[key] || 'medium';
  }

  function currentEffort() {
    return normalizeEffort((typeof Harness !== 'undefined' && Harness.getReasoningEffort) ? Harness.getReasoningEffort() : 'medium');
  }

  function effortLabel(id) {
    id = normalizeEffort(id);
    const e = EFFORTS.find(x => x.id === id);
    return e ? e.label : 'MED';
  }

  function effortDef(id) {
    id = normalizeEffort(id);
    return EFFORTS.find(x => x.id === id) || EFFORTS[3];
  }

  // plain-language gloss of what the effort tier MEANS — surfaced in the chip tooltip so a
  // beginner learns "MED" is a reasoning dial, not a mystery button.
  const EFFORT_MEANING = {
    none: 'no extra reasoning — fastest, cheapest',
    minimal: 'a touch of reasoning',
    low: 'light reasoning — quick answers',
    medium: 'balanced reasoning — the default',
    high: 'deep reasoning — slower, more careful',
    xhigh: 'very deep reasoning',
    max: 'maximum reasoning — slowest, most thorough'
  };
  function effortMeaning(id) { return EFFORT_MEANING[normalizeEffort(id)] || EFFORT_MEANING.medium; }

  // a compact display name for the resting chip: last path segment, spaces, capped so the
  // composer never grows. Empty model → a dim placeholder.
  function shortModelName(id) {
    const raw = String(id || '').trim();
    if (!raw) return '';
    let s = raw.indexOf('/') >= 0 ? raw.split('/').pop() : raw;
    s = s.replace(/-latest$/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > 16) s = s.slice(0, 15).trim() + '…';
    return s.toUpperCase();
  }

  function getModel() {
    return (typeof Harness !== 'undefined' && Harness.getModel) ? String(Harness.getModel() || '') : '';
  }

  function modelLabel(item) {
    const id = String((item && item.id) || '');
    const raw = String((item && item.name) || id.split('/').pop() || id || 'no model');
    return raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function selectorLabel(model, effort) {
    const name = model ? modelLabel({ id: model }) : 'no model selected';
    return 'Model selector: ' + name + ', ' + effortDef(effort).title;
  }

  function groupOf(item) {
    return providerLabel((item && item.provider) || provider());
  }

  function asModel(item, p) {
    if (typeof item === 'string') return { id: item, name: item, provider: normalizeProvider(p) };
    const out = { id: String((item && item.id) || ''), name: (item && (item.displayName || item.name)) || String((item && item.id) || ''), provider: normalizeProvider(p) };
    const params = (item && (item.supported_parameters || item.supportedParameters)) || null;
    const efforts = (item && (item.reasoningEfforts || item.reasoning_efforts || item.supportedReasoningEfforts || item.supported_reasoning_efforts)) || null;
    if (Array.isArray(params)) out.supported_parameters = params.slice();
    if (Array.isArray(efforts)) out.reasoningEfforts = efforts.slice();
    if (item && item.supportsReasoning != null) out.supportsReasoning = !!item.supportsReasoning;
    if (item && item.supportsTools != null) out.supportsTools = !!item.supportsTools;
    // Codex carries the backend's own reasoning semantics: which level to preselect, and per-level glosses.
    const dl = item && (item.defaultReasoningLevel || item.default_reasoning_level);
    if (dl) out.defaultReasoningLevel = normalizeEffort(dl);
    const desc = item && (item.reasoningLevelDescriptions || item.reasoning_level_descriptions);
    if (desc && typeof desc === 'object') out.reasoningLevelDescriptions = desc;
    return out;
  }

  function mergeCurrent(list) {
    const current = getModel();
    const p = provider();
    // Preserve a saved current model only while the active catalog is unavailable. Once a successful catalog
    // says it is absent, reconcileCurrentModel() has either mapped it to a proven provider-native id or cleared
    // it. Re-inserting it here was the stale-model bug: a bare Anthropic id appeared selectable under STARNET.
    if (current && !list.some(m => m.id === current && normalizeProvider(m.provider) === p) && !(catalogState[p] && catalogState[p].confirmed)) {
      list.unshift({ id: current, name: current, provider: p, fallback: true, unverifiedCurrent: true });
    }
    return list.filter(m => m && m.id);
  }

  // Return a catalog-confirmed equivalent for a model whose provider changed. Managed StarNet/OpenRouter ids
  // are vendor/model; Anthropic's direct API uses the bare tail. Never invent a slug: a candidate is returned
  // only when that exact id is present in the successful catalog.
  function catalogEquivalent(current, p, list) {
    const id = String(current || '').trim();
    p = normalizeProvider(p);
    const rows = Array.isArray(list) ? list : [];
    if (!id) return '';
    if (rows.some(m => m && m.id === id)) return id;
    let candidate = '';
    if ((p === 'starnet' || p === 'openrouter') && id.indexOf('/') < 0) candidate = 'anthropic/' + id;
    else if (p === 'anthropic' && /^anthropic\//i.test(id)) candidate = id.slice(id.indexOf('/') + 1);
    return candidate && rows.some(m => m && m.id === candidate) ? candidate : '';
  }

  function reconcileCurrentModel(p, list) {
    p = normalizeProvider(p);
    if (!(catalogState[p] && catalogState[p].confirmed)) return;
    const current = getModel();
    if (!current || (Array.isArray(list) && list.some(m => m && m.id === current))) return;
    const next = catalogEquivalent(current, p, list);
    const picked = next && list.find(m => m && m.id === next);
    const effort = picked ? clampEffortForModel(currentEffort(), picked) : currentEffort();
    if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(p);
    if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(next);
    if (picked && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({
      model: next,
      provider: p,
      effort: effort,
      reason: next ? 'catalog_reconcile' : 'catalog_unavailable',
      previousModel: current
    });
  }

  function providerEnabled(p) {
    p = normalizeProvider(p || provider());
    if (p === provider()) return true;
    try {
      if (typeof Harness !== 'undefined' && Harness.getKey && Harness.getKey(p)) return true;
      if (typeof Harness !== 'undefined' && Harness.configured && Harness.configured(p)) return true;
    } catch (_) {}
    if (p === 'ollama') return true;
    return false;
  }

  async function codexEnabled() {
    if (provider() === 'codex') return true;
    try {
      const r = await apiFetch('/api/auth/codex/status', { cache: 'no-store' });
      const j = await r.json();
      return !!(j && j.connected);
    } catch (_) {
      return false;
    }
  }
  // the generalized enablement probe for the other keyless device-code providers (grok/kimi): enabled iff it's
  // the active provider OR /api/auth/<pid>/status reports connected:true. Mirrors codexEnabled exactly.
  async function oauthProviderEnabled(pid) {
    if (provider() === pid) return true;
    try {
      const r = await apiFetch('/api/auth/' + pid + '/status', { cache: 'no-store' });
      const j = await r.json();
      return !!(j && j.connected);
    } catch (_) {
      return false;
    }
  }

  function openRouterGroupName(item) {
    const id = String((item && item.id) || '');
    const head = id.indexOf('/') >= 0 ? id.split('/')[0].toLowerCase() : 'custom';
    return GROUP_NAMES[head] || head.toUpperCase();
  }

  function modelFamily(item) {
    const p = normalizeProvider((item && item.provider) || provider());
    const id = String((item && item.id) || '').toLowerCase();
    const name = String((item && item.name) || '').toLowerCase();
    if (p === 'codex') return 'gpt';
    if (p === 'grok' || p === 'xai') return 'grok';
    if (p === 'kimi') return 'kimi';
    if (p === 'mistral') return 'mistral';
    if (p === 'deepseek') return 'deepseek';
    if (p === 'perplexity') return 'perplexity';
    if (/^(openai|openai-internal)\//.test(id) || /\bgpt[-\s]?\d|\bgpt\b|codex/.test(id + ' ' + name)) return 'gpt';
    if (/^anthropic\//.test(id) || /claude/.test(id + ' ' + name)) return 'anthropic';
    if (/^google\//.test(id) || /gemini/.test(id + ' ' + name)) return 'google';
    if (/grok/.test(id + ' ' + name)) return 'grok';
    if (/mistral|mixtral|ministral/.test(id + ' ' + name)) return 'mistral';
    if (/deepseek/.test(id + ' ' + name)) return 'deepseek';
    if (/sonar|perplexity/.test(id + ' ' + name)) return 'perplexity';
    return 'other';
  }

  function declaredEfforts(item) {
    const raw = item && (item.reasoningEfforts || item.reasoning_efforts || item.supportedReasoningEfforts || item.supported_reasoning_efforts);
    if (!Array.isArray(raw)) return [];
    const seen = new Set(), out = [];
    for (const v of raw) {
      const e = normalizeEffort(v);
      if (!seen.has(e)) { seen.add(e); out.push(e); }
    }
    return out.length ? out : [];
  }

  function supportsReasoning(item) {
    if (normalizeProvider((item && item.provider) || provider()) === 'codex') return true;
    if (item && item.supportsReasoning != null) return !!item.supportsReasoning;
    const params = item && (item.supported_parameters || item.supportedParameters);
    if (Array.isArray(params)) {
      const set = new Set(params.map(x => String(x).toLowerCase()));
      return set.has('reasoning') || set.has('reasoning_effort') || set.has('include_reasoning');
    }
    const fam = modelFamily(item);
    return fam === 'gpt' || fam === 'anthropic' || fam === 'google' || fam === 'grok' || fam === 'deepseek';
  }

  function effortOptionsFor(item) {
    const declared = declaredEfforts(item);
    if (declared.length) return declared;
    if (normalizeProvider((item && item.provider) || provider()) === 'codex') return CODEX_EFFORTS.slice();
    if (!supportsReasoning(item)) return OFF_ONLY_EFFORTS.slice();
    return OPENROUTER_REASONING_EFFORTS.slice();
  }

  function currentModelItem() {
    const id = getModel();
    const p = provider();
    return models.find(m => m.id === id && normalizeProvider(m.provider) === p) || { id, name: id, provider: p };
  }

  function clampEffortForModel(value, item) {
    const opts = effortOptionsFor(item);
    let effort = normalizeEffort(value);
    if (opts.indexOf(effort) >= 0) return effort;
    // When the current effort isn't supported by this model, prefer the model's own recommended default
    // (Codex carries default_reasoning_level) before falling back to nearest-neighbour clamping.
    const def = item && item.defaultReasoningLevel ? normalizeEffort(item.defaultReasoningLevel) : '';
    if (def && opts.indexOf(def) >= 0) return def;
    const set = new Set(opts);
    let idx = REASONING_EFFORT_ORDER.indexOf(effort);
    if (idx < 0) idx = REASONING_EFFORT_ORDER.indexOf('medium');
    for (let i = idx; i >= 0; i--) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    for (let i = idx + 1; i < REASONING_EFFORT_ORDER.length; i++) if (set.has(REASONING_EFFORT_ORDER[i])) return REASONING_EFFORT_ORDER[i];
    return opts[0] || 'none';
  }

  function effectiveEffort(item) {
    return clampEffortForModel(currentEffort(), item || currentModelItem());
  }

  function ensureCurrentEffort() {
    const item = currentModelItem();
    const raw = currentEffort();
    const effort = clampEffortForModel(raw, item);
    if (effort !== raw && typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    return effort;
  }

  async function fetchProviderModels(p, force) {
    p = normalizeProvider(p);
    if (!force && cache[p] && cache[p].length) {
      return cache[p].slice();
    }
    let list = [];
    let confirmed = false;
    try {
      if (p === 'codex') {
        if (!(await codexEnabled())) { catalogState[p] = { confirmed: false, reason: 'not connected' }; cache[p] = []; return []; }
        const r = await apiFetch('/api/auth/codex/models', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j.models)) throw new Error((j && j.error) || 'invalid catalog response');
        list = j.models.map(m => asModel(m, p)); confirmed = true;
      } else if (p === 'grok' || p === 'kimi') {
        // the other keyless device-code providers: gate on the OAuth status, discover models via /api/auth/<pid>/models.
        if (!(await oauthProviderEnabled(p))) { catalogState[p] = { confirmed: false, reason: 'not connected' }; cache[p] = []; return []; }
        const r = await apiFetch('/api/auth/' + p + '/models', { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j.models)) throw new Error((j && j.error) || 'invalid catalog response');
        list = j.models.map(m => asModel(m, p)); confirmed = true;
      } else if (typeof Harness !== 'undefined' && Harness.listModels) {
        if (!providerEnabled(p)) { catalogState[p] = { confirmed: false, reason: 'not connected' }; cache[p] = []; return []; }
        try {
          const q = (p === 'custom' && typeof Harness !== 'undefined' && Harness.getBaseUrl && Harness.getBaseUrl(p))
            ? ('?baseUrl=' + encodeURIComponent(Harness.getBaseUrl(p))) : '';
          const r = await apiFetch('/api/models/' + encodeURIComponent(p) + q, { cache: 'no-store' });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const j = await r.json();
          if (j && j.error) throw new Error(j.error);
          if (!Array.isArray(j && j.models)) throw new Error('invalid catalog response');
          list = j.models.map(m => asModel(m, p)); confirmed = true;
        } catch (_) {}
        if (!confirmed) {
          list = (await Harness.listModels(p)).map(m => asModel(m, p));
          // Harness deliberately collapses catalog failures to []; a non-empty result is still positive proof.
          if (list.length) confirmed = true;
        }
      }
    } catch (_) {}
    catalogState[p] = { confirmed: confirmed, reason: confirmed ? '' : 'catalog unavailable' };
    if (!list.length && !confirmed && (p === 'codex' || p === 'openrouter' || p === 'anthropic' || p === 'gemini' || HOSTED_FALLBACKS[p])) {
      // E4: the live catalog fetch found nothing (sidecar/provider unreachable) — fall back to the
      // hardcoded seed list, but MARK each item so the UI can label it "(catalog offline)". Without the
      // flag a seed list renders indistinguishably from a verified live catalog, asserting models the
      // harness never confirmed exist.
      list = (p === 'codex' ? CODEX_MODELS : p === 'anthropic' ? ANTHROPIC_MODELS : p === 'gemini' ? GEMINI_MODELS : HOSTED_FALLBACKS[p] || OPENROUTER_FALLBACK).map(m => { const item = asModel(m, p); item.fallback = true; return item; });
    }
    list.sort((a, b) => {
      if (p === 'openrouter') {
        const ga = openRouterGroupName(a), gb = openRouterGroupName(b);
        if (ga !== gb) return ga.localeCompare(gb);
      }
      return modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);
    });
    cache[p] = list.slice();
    return list;
  }

  async function fetchModels(force) {
    loading = true;
    renderList();
    // 'starnet' first: a linked station's own credits are the most direct way to run, and its catalog is
    // the whole managed lineup. providerEnabled() keeps it out of the list when no credits are configured.
    const ids = ['starnet', 'codex', 'grok', 'kimi', 'openrouter', 'openai', 'anthropic', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'ollama', 'custom'];
    const active = provider();
    if (ids.indexOf(active) < 0) ids.unshift(active);
    const parts = await Promise.all(ids.map(p => fetchProviderModels(p, force)));
    const activeList = parts[ids.indexOf(active)] || [];
    reconcileCurrentModel(active, activeList);
    models = mergeCurrent(parts.reduce((a, b) => a.concat(b), []));
    models.sort((a, b) => {
      const pa = normalizeProvider(a.provider), pb = normalizeProvider(b.provider);
      if (pa !== pb) return ((PROVIDER_RANK[pa] == null ? 20 : PROVIDER_RANK[pa]) - (PROVIDER_RANK[pb] == null ? 20 : PROVIDER_RANK[pb]));
      if (pa === 'openrouter') {
        const ga = openRouterGroupName(a), gb = openRouterGroupName(b);
        if (ga !== gb) return ga.localeCompare(gb);
      }
      return modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);
    });
    loading = false;
    renderList();
    reflect();
    return models;
  }

  function renderEfforts() {
    const wrap = el('model-dock-efforts');
    if (!wrap) return;
    wrap.innerHTML = '';
    const item = currentModelItem();
    const isCodex = normalizeProvider((item && item.provider) || provider()) === 'codex';
    const levelDescs = (item && item.reasoningLevelDescriptions) || null;
    const selected = ensureCurrentEffort();
    const available = effortOptionsFor(item).map(effortDef);
    for (const e of available) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'model-dock-effort' + (e.id === selected ? ' sel' : '');
      // Codex has no 'off' tier — its 'low' level is the CLI's "Fast mode", so surface it as FAST.
      b.textContent = (isCodex && e.id === 'low') ? 'FAST' : e.label;
      b.title = (levelDescs && levelDescs[e.id]) || ((isCodex && e.id === 'low') ? 'Fast responses with lighter reasoning' : e.title);
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(e.id === selected));
      b.addEventListener('click', () => applyEffort(e.id));
      wrap.appendChild(b);
    }
  }

  function renderList() {
    const wrap = el('model-dock-list');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (loading) {
      const div = document.createElement('div');
      div.className = 'model-dock-empty';
      div.innerHTML = '<span class="loading pulse">scanning catalog…</span>';
      wrap.appendChild(div);
      return;
    }
    const q = String((el('model-dock-search') && el('model-dock-search').value) || '').trim().toLowerCase();
    const current = getModel();
    const activeProvider = provider();
    const list = models.filter(m => {
      if (!q) return true;
      return (m.id + ' ' + modelLabel(m) + ' ' + groupOf(m) + ' ' + openRouterGroupName(m)).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) {
      const div = document.createElement('div');
      div.className = 'model-dock-empty';
      div.textContent = 'NO MATCHES';
      wrap.appendChild(div);
      return;
    }
    let group = '';
    const frag = document.createDocumentFragment();
    for (const m of list) {
      const g = groupOf(m);
      if (g !== group) {
        group = g;
        const head = document.createElement('div');
        head.className = 'model-dock-group';
        // E4: label a group whose rows came from the hardcoded seed list (the live catalog fetch failed
        // for this provider) so an offline fallback never reads as a verified live catalog. Mirrors the
        // connect screen's "(catalog offline — type or pick a slug)" honesty.
        const groupFallback = list.some(x => groupOf(x) === g && x.fallback);
        head.textContent = group;
        if (groupFallback) {
          const off = document.createElement('i');
          off.className = 'model-dock-group-offline';
          off.textContent = ' (catalog offline)';
          head.appendChild(off);
          head.title = 'live catalog unreachable — showing a built-in fallback list; type a slug to use an unlisted model';
        }
        frag.appendChild(head);
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'model-dock-row' + (m.id === current && normalizeProvider(m.provider) === activeProvider ? ' sel' : '') + (m.fallback ? ' fallback' : '');
      row.title = m.fallback ? m.id + ' — fallback (catalog offline, unverified)' : m.id;
      row.dataset.provider = normalizeProvider(m.provider);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(m.id === current && normalizeProvider(m.provider) === activeProvider));
      const name = document.createElement('span');
      name.className = 'model-dock-row-name';
      name.textContent = modelLabel(m);
      const eff = document.createElement('span');
      eff.className = 'model-dock-row-effort';
      eff.textContent = effortLabel(effectiveEffort(m));
      row.appendChild(name);
      row.appendChild(eff);
      row.addEventListener('click', () => applyModel(m));
      frag.appendChild(row);
    }
    wrap.appendChild(frag);
  }

  function applyModel(item) {
    const picked = typeof item === 'string' ? { id: item, provider: provider() } : (item || {});
    const id = String(picked.id || '').trim();
    const pickedProvider = normalizeProvider(picked.provider || provider());
    if (!id) return;
    const effort = clampEffortForModel(currentEffort(), picked);
    if (typeof Harness !== 'undefined' && Harness.setProv) Harness.setProv(pickedProvider);
    if (typeof Harness !== 'undefined' && Harness.setModel) Harness.setModel(id);
    if (typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({ model: id, provider: pickedProvider, effort: effort, reason: 'model' });
    reflect();
    renderList();
    closeDock();
  }

  function applyEffort(id) {
    const effort = clampEffortForModel(id, currentModelItem());
    if (typeof Harness !== 'undefined' && Harness.setReasoningEffort) Harness.setReasoningEffort(effort);
    if (opts.apply) opts.apply({ model: getModel(), provider: provider(), effort: effort, reason: 'effort' });
    reflect();
    renderEfforts();
    renderList();
  }

  // Build the injected chrome (model short-name span in the resting chip + the CRT tooltip)
  // once, without touching index.html. Idempotent — safe to call from every reflect().
  function ensureChipChrome() {
    const toggle = el('model-dock-toggle');
    if (!toggle) return null;
    let nameEl = el('model-dock-model-name');
    if (!nameEl) {
      nameEl = document.createElement('span');
      nameEl.id = 'model-dock-model-name';
      nameEl.className = 'model-dock-model-name';
      nameEl.setAttribute('aria-hidden', 'true');
      // sit between the sigil and the effort chip so the chip reads MODEL · TIER
      const chip = el('model-dock-effort-chip');
      if (chip && chip.parentNode === toggle) toggle.insertBefore(nameEl, chip);
      else toggle.appendChild(nameEl);
    }
    let tip = el('model-dock-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'model-dock-tip';
      tip.className = 'model-dock-tip';
      tip.setAttribute('role', 'tooltip');
      tip.hidden = true;
      // pointer-events:none via CSS so it can never eat the click that opens the dock
      toggle.appendChild(tip);
    }
    return { nameEl, tip };
  }

  function updateTip(tip) {
    if (!tip) return;
    const current = getModel();
    const p = provider();
    const effort = currentEffort();
    const def = effortDef(effort);
    const model = current ? modelLabel({ id: current }) : 'no model selected';
    tip.innerHTML =
      '<div class="mdt-row mdt-model">' + esc(model) + '</div>' +
      '<div class="mdt-row mdt-prov">' + esc(providerLabel(p)) + '</div>' +
      '<div class="mdt-sep"></div>' +
      '<div class="mdt-row mdt-tier"><b>' + esc(def.label) + '</b> · reasoning effort</div>' +
      '<div class="mdt-row mdt-mean">' + esc(effortMeaning(effort)) + '</div>' +
      '<div class="mdt-hint">click to change model &amp; effort</div>';
  }

  function reflect() {
    const current = getModel();
    const p = provider();
    const toggle = el('model-dock-toggle');
    const providerEl = el('model-dock-provider');
    const currentEl = el('model-dock-current-model');
    const chip = el('model-dock-effort-chip');
    const chrome = ensureChipChrome();
    if (providerEl) providerEl.textContent = providerLabel(p);
    if (currentEl) currentEl.textContent = current ? modelLabel({ id: current }) : 'NO MODEL';
    const effort = ensureCurrentEffort();
    if (chip) chip.textContent = effortLabel(effort);
    if (toggle) toggle.setAttribute('aria-label', selectorLabel(current, effort));
    if (chrome && chrome.nameEl) {
      const short = shortModelName(current);
      chrome.nameEl.textContent = short || '—';
      chrome.nameEl.classList.toggle('empty', !short);
    }
    if (chrome) updateTip(chrome.tip);
    renderEfforts();
  }

  function showTip() {
    const tip = el('model-dock-tip');
    if (!tip || open) return;   // never show the hover tip while the dock itself is open
    updateTip(tip);
    tip.hidden = false;
    tip.classList.add('show');
  }
  function hideTip() {
    const tip = el('model-dock-tip');
    if (!tip) return;
    tip.classList.remove('show');
    tip.hidden = true;
  }
  // first-run affordance: one subtle pulse so a new user notices the chip exists. Persisted
  // guard so it fires only until they've interacted (or seen it once).
  const PULSE_KEY = 'starnet.modeldock.seen';
  function clearPulse() {
    const toggle = el('model-dock-toggle');
    if (toggle) toggle.classList.remove('first-run');
    try { localStorage.setItem(PULSE_KEY, '1'); } catch (_) {}
  }
  function maybePulse() {
    let seen = false;
    try { seen = localStorage.getItem(PULSE_KEY) === '1'; } catch (_) {}
    if (seen) return;
    const toggle = el('model-dock-toggle');
    if (!toggle) return;
    toggle.classList.add('first-run');
    // auto-retire after a few cycles so it's a nudge, not a permanent distraction
    setTimeout(clearPulse, 9000);
  }

  function openDock() {
    const dock = el('model-dock'), toggle = el('model-dock-toggle'), search = el('model-dock-search');
    if (!dock || !toggle) return;
    hideTip();
    clearPulse();
    open = true;
    dock.hidden = false;
    toggle.classList.add('on');
    toggle.setAttribute('aria-expanded', 'true');
    reflect();
    fetchModels(false).then(() => { if (open) renderList(); });
    setTimeout(() => { try { if (search) search.focus(); } catch (_) {} }, 0);
  }

  function closeDock() {
    const dock = el('model-dock'), toggle = el('model-dock-toggle');
    open = false;
    if (dock) dock.hidden = true;
    if (toggle) {
      toggle.classList.remove('on');
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleDock() {
    if (open) closeDock(); else openDock();
  }

  // The model picker's account door always leads to StarNet. It does not change the
  // active provider, promise a working model, or start a subscription transaction.
  function openSubscription(event) {
    const invoke = (typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core)
      ? window.__TAURI__.core.invoke : null;
    if (!invoke) return; // Browser: the anchor's normal target=_blank navigation owns this.
    event.preventDefault();
    closeDock();
    Promise.resolve().then(() => invoke('open_external_url', { url: 'https://www.starnetos.com/pricing' }))
      .catch(() => {
        if (typeof StationUI !== 'undefined' && StationUI.notify) {
          StationUI.notify('Could not open your browser. Visit www.starnetos.com/pricing for your StarNet subscription.', 'warn');
        }
      });
  }

  function wire() {
    if (wired) return;
    wired = true;
    const toggle = el('model-dock-toggle');
    const search = el('model-dock-search');
    const refresh = el('model-dock-refresh');
    const subscription = el('model-dock-subscription');
    if (toggle) {
      // this handler stops propagation (the outside-click closer below must not see its own opening
      // press), which also means audio.js's delegated click cue never reaches the document — so the
      // dock sounds its own, directional like every other panel: open going out, close coming back.
      toggle.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (typeof SFX !== 'undefined') { if (open) SFX.close(); else SFX.open(); }
        toggleDock();
      });
      // rich CRT tooltip on hover + keyboard focus (a11y) — killed the moment the dock opens
      toggle.addEventListener('mouseenter', showTip);
      toggle.addEventListener('mouseleave', hideTip);
      toggle.addEventListener('focus', showTip);
      toggle.addEventListener('blur', hideTip);
    }
    if (search) search.addEventListener('input', renderList);
    if (refresh) refresh.addEventListener('click', () => fetchModels(true));
    if (subscription) subscription.addEventListener('click', openSubscription);
    document.addEventListener('click', ev => {
      const dock = el('model-dock'), button = el('model-dock-toggle');
      if (!open || !dock || !button) return;
      if (dock.contains(ev.target) || button.contains(ev.target)) return;
      closeDock();
    });
    document.addEventListener('keydown', ev => { if (open && ev.key === 'Escape') closeDock(); });
  }

  function init(o) {
    opts = Object.assign({}, opts, o || {});
    wire();
    reflect();
    maybePulse();
    fetchModels(false).catch(() => { loading = false; renderList(); });
  }

  // PURE catalog accessor for OTHER pickers (recruitment bay, per-agent dossier) — same provider fan-out,
  // fallbacks, gating, grouping and sort as the dock, but WITHOUT touching Harness transport state or the
  // dock DOM (the dock is a global singleton bound to the FOCUSED agent; a per-target picker must not move it).
  // `ensure: { id, provider }` guarantees a specific model (e.g. an agent's own pin) is present even if the
  // provider is unconfigured, so the picker can always show + preselect it. Returns [{ id, name, provider, … }].
  async function computeCatalog(force, ensure) {
    const ids = ['codex', 'grok', 'kimi', 'openrouter', 'openai', 'anthropic', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'ollama', 'custom'];
    const active = provider();
    if (ids.indexOf(active) < 0) ids.unshift(active);
    const parts = await Promise.all(ids.map(p => fetchProviderModels(p, force).catch(() => [])));
    let list = parts.reduce((a, b) => a.concat(b), []).filter(m => m && m.id);
    if (ensure && ensure.id) {
      const eid = String(ensure.id).trim();
      const ep = normalizeProvider(ensure.provider);
      if (eid && !list.some(m => m.id === eid && normalizeProvider(m.provider) === ep)) list.unshift(asModel({ id: eid, name: eid }, ep));
    }
    // de-dup identical (provider,id) pairs the fan-out may surface twice (active provider appears in its own list)
    const seen = new Set();
    list = list.filter(m => { const k = normalizeProvider(m.provider) + '' + m.id; if (seen.has(k)) return false; seen.add(k); return true; });
    list.sort((a, b) => {
      const pa = normalizeProvider(a.provider), pb = normalizeProvider(b.provider);
      if (pa !== pb) return ((PROVIDER_RANK[pa] == null ? 20 : PROVIDER_RANK[pa]) - (PROVIDER_RANK[pb] == null ? 20 : PROVIDER_RANK[pb]));
      if (pa === 'openrouter') { const ga = openRouterGroupName(a), gb = openRouterGroupName(b); if (ga !== gb) return ga.localeCompare(gb); }
      return modelLabel(a).localeCompare(modelLabel(b)) || a.id.localeCompare(b.id);
    });
    return list;
  }

  return {
    init,
    refresh: () => fetchModels(true),
    reconcile: () => fetchModels(false),
    reflect,
    open: openDock,   // programmatic open — the model_not_found error door lands here (the PRIMARY model picker; Settings→MODELS is only the fallback chain)
    close: closeDock,
    normalizeEffort,
    // reuse surface for per-target pickers (bay / dossier) — pure data + label/effort helpers, no side effects
    catalog: (o) => computeCatalog(!!(o && o.force), o && o.ensure),
    labels: { model: modelLabel, provider: providerLabel, group: groupOf, short: shortModelName, normProvider: normalizeProvider, orGroup: openRouterGroupName },
    efforts: { optionsFor: effortOptionsFor, label: effortLabel, clamp: clampEffortForModel, list: () => EFFORTS.slice() },
    _internals: { effortOptionsFor, clampEffortForModel, modelFamily, supportsReasoning, selectorLabel, catalogEquivalent }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ModelDock;
