/* STARNET — harness.js : the REAL agent harness (BYOK).
   Owns the model connection + streaming + token/cost accounting.

   For this prototype the call goes browser -> OpenRouter directly (CORS-friendly,
   key in localStorage). In the shipped desktop build this exact interface is
   re-implemented behind the Tauri sidecar + OS keychain — callers (chat.js) never
   change, only the transport inside Harness.chat() does. Keep that seam clean. */
'use strict';

const Harness = (() => {
  const LS = { key: 'starnet.byok.key', keyPool: 'starnet.byok.keyPool', model: 'starnet.byok.model', prov: 'starnet.byok.prov', baseUrl: 'starnet.byok.baseUrl', effort: 'starnet.byok.reasoningEffort' };
  const OR = 'https://openrouter.ai/api/v1';

  let totals = { tokens: 0, cost: 0, calls: 0 };
  // Model catalogs are keyed BY PROVIDER. A single shared map was a real defect: ModelDock warms all
  // ~17 providers in parallel (modeldock.js fetchModels) and every listModels(p) miss reset the one
  // map, so whichever provider resolved LAST — usually an unconfigured one with an empty list — wiped
  // the ACTIVE provider's catalog. contextLimitOf()/priceOf() then returned 0 for the live model, and
  // the bottom-bar context gauge sat at unknown/"—" forever even after a real measured turn.
  let modelsByProv = Object.create(null);   // provider -> { id -> { id, name, pricing, context_length, supportsTools } }

  // Resolve a model id against the warmed catalogs, preferring the ACTIVE provider's (the same id can
  // exist under two providers with different windows/prices, e.g. a direct slug vs an OpenRouter one).
  function catalogModel(id) {
    if (!id) return null;
    const p = normalizeProviderId(getProv());
    const own = modelsByProv[p];
    if (own && own[id]) return own[id];
    for (const k in modelsByProv) { const m = modelsByProv[k] && modelsByProv[k][id]; if (m) return m; }
    return null;
  }
  /* CONTEXT OCCUPANCY IS PER CONVERSATION, NOT PER AGENT.
     This was keyed by agentId alone, and the bottom bar labels itself "MEMORY OF THIS CHAT" — so
     opening a NEW session (or switching to any other one) kept asserting the PREVIOUS conversation's
     fill over an empty transcript. Proven live 2026-08-03: a workstream with zero turns read
     "13k / 200k (7% full)" inherited from a 4-turn sibling. After a long chat that reads as 60%+ of
     the window occupied by a conversation that has not said a word — the exact class of claim the
     harness cannot prove. The key is agentId + streamId (the workstream the run was launched from). */
  let contextByKey = {};     // agentId\0streamId -> { used, model, runId, sentEstimate, live }
  let runModels = {};        // runId -> model from agent.run.start, for events that omit model
  let runConv = {};          // runId -> { key, sentEstimate } registered by chat() at run.start
  /* HARNESS OVERHEAD, LEARNED FROM A REAL REQUEST (agentId\0model -> tokens).
     A request carries far more than the visible dialogue: system prompt, every tool schema, and the
     sidecar's manual/capability/skill/memory dressing. On a seeded station that measured ~13.1k tokens
     against a two-line chat. So a browser-side estimate of the dialogue alone is not a usable stand-in —
     but prompt_tokens MINUS our estimate of the messages we sent IS the overhead, directly observed.
     Learned from the FIRST cost event of a run only: later turns of an agentic run carry accumulated
     tool results the next request will never resend, and calibrating on those inflates the overhead.

     PERSISTED, because this closure dies on every reload and a station gets reloaded constantly — an
     un-persisted calibration means the gauge goes blank after every refresh and only comes back once
     you have paid for another turn, which is most of what "it never works" felt like. The stored value
     is a real past measurement, it is only ever used to produce a tilde-marked projection, and the very
     next turn overwrites it — so a system-prompt or toolset change (which does move the overhead)
     self-corrects on first use rather than persisting a lie. */
  const LS_OVERHEAD = 'starnet.ctx.overhead';
  const OVERHEAD_MAX = 40;   // bounded: a few models per provider, never an unbounded localStorage row
  // Each entry is CtxGauge.calibrate's { overhead } fit. A stored entry that is not a usable fit is
  // DROPPED, not coerced — a half-read calibration would silently bias every projection it feeds.
  let overheadByModel = (() => {
    const out = Object.create(null);
    try {
      const raw = JSON.parse(localStorage.getItem(LS_OVERHEAD) || '{}');
      if (raw && typeof raw === 'object') {
        for (const k in raw) {
          const v = raw[k];
          if (!v || typeof v !== 'object') continue;
          const o = Number(v.overhead);
          if (isFinite(o) && o >= 0) out[k] = { overhead: Math.floor(o) };
        }
      }
    } catch (_) {}
    return out;
  })();
  function rememberOverhead(key, cal) {
    if (!cal) return;
    overheadByModel[key] = cal;
    try {
      const keys = Object.keys(overheadByModel);
      if (keys.length > OVERHEAD_MAX) { for (const k of keys.slice(0, keys.length - OVERHEAD_MAX)) delete overheadByModel[k]; }
      localStorage.setItem(LS_OVERHEAD, JSON.stringify(overheadByModel));
    } catch (_) {}   // a full/blocked localStorage must never break a run's cost fold
  }
  // Runs launched with internal:true (retitle / goal-judge / pitch / autopilot self-talk) are tiny
  // side prompts on the SAME agentId — their prompt_tokens must never overwrite the agent's real
  // context occupancy (they made the gauge snap back to ~1% right after every real turn).
  const internalRuns = new Set();   // runIds whose cost events are gauge-invisible

  // Composite map keys join on U+0000, built with String.fromCharCode so no raw NUL byte ever lands in
  // this source file (a literal one makes the whole file invisible to grep). No id can contain it.
  const SEP = String.fromCharCode(0);
  const convKey = (agentId, streamId) => String(agentId || 'agent') + SEP + String(streamId || '');
  const hasEst = () => (typeof CtxGauge !== 'undefined' && !!CtxGauge.estimateMessages);
  const estOf = msgs => (hasEst() ? CtxGauge.estimateMessages(msgs) : 0);

  /* Register the conversation a run belongs to, plus our estimate of the messages it was given.
     Called by chat() the moment it latches a runId, so the bus fold below can attribute the run's
     cost events to the right conversation and calibrate the overhead against what we actually sent. */
  function registerRun(runId, agentId, streamId, messages) {
    if (!runId) return;
    runConv[runId] = { key: convKey(agentId, streamId), sentEstimate: estOf(messages), calibrated: false, agentId: String(agentId || 'agent') };
  }

  // Fold ONE token-bearing agent.cost payload into the per-conversation context occupancy. Called from
  // the U.bus subscription below, which sees BOTH transports: chat-stream events (re-emitted by chat()'s
  // reader) and routed/scheduled/channel runs arriving over the world SSE bridge — previously only
  // the chat path updated the gauge, so background runs never moved it. A run with no registered
  // conversation (a server-launched cron/channel run) folds under the agent's streamless bucket: it is
  // real occupancy, but it belongs to no on-screen chat and must not colour one.
  function foldContextCost(payload) {
    if (!payload || !(payload.tokensIn > 0)) return;               // summarizer/compaction emits omit token fields on purpose
    if (payload.runId && internalRuns.has(payload.runId)) return;  // gauge-invisible side prompt
    const aid = payload.agentId || 'agent';
    const m = payload.model || runModels[payload.runId] || getModel();
    const reg = payload.runId ? runConv[payload.runId] : null;
    const key = reg ? reg.key : convKey(aid, '');
    /* THE FIRST cost event of a run is the only one that measures the messages we actually sent — every
       later turn of an agentic run adds tool results the next request will never carry. So it is the
       only one allowed to (a) calibrate the harness overhead and (b) stand as this conversation's
       BASELINE: the exact, measured cost of this exact transcript. Calibrating on a tool-heavy turn 4
       instead would have inflated the overhead ~4x and every projection with it. */
    const firstOfRun = !!(reg && !reg.seen);
    if (reg) reg.seen = true;
    if (firstOfRun && m && hasEst()) rememberOverhead(reg.agentId + SEP + m, CtxGauge.calibrateFromEstimate(payload.tokensIn, reg.sentEstimate));
    const prev = contextByKey[key];
    const baseline = firstOfRun ? payload.tokensIn
      : ((prev && prev.runId === (payload.runId || '')) ? prev.baseline : 0);
    contextByKey[key] = {
      used: payload.tokensIn, model: m, runId: payload.runId || '',
      sentEstimate: reg ? reg.sentEstimate : -1, baseline: baseline || 0, live: true
    };
  }
  // A run ended: its measurement stops being "what the model is holding right now". The reading stays
  // (it is still the last real thing we know) but drops out of live mode, so contextState projects the
  // NEXT request instead of freezing on an agentic run's tool-result peak that will never be resent.
  function endContextRun(payload) {
    const rid = payload && payload.runId;
    if (!rid) return;
    const reg = runConv[rid];
    const rec = reg && contextByKey[reg.key];
    if (rec && rec.runId === rid) rec.live = false;
    else { for (const k in contextByKey) { if (contextByKey[k] && contextByKey[k].runId === rid) contextByKey[k].live = false; } }
    delete runConv[rid];
  }

  // Desktop (Tauri) build: the BYOK key lives in the OS keychain — never in localStorage and
  // never returned to this WebView. Rust stores it and injects it into the sidecar's env at spawn
  // (read only there). The browser build keeps the localStorage transport unchanged.
  const TAURI = (typeof window !== 'undefined') && window.__TAURI__ && window.__TAURI__.core;
  const DESKTOP = !!TAURI;
  const invoke = (cmd, args) => TAURI.invoke(cmd, args);
  // DEV fast-path (sidecar started with SKYNET_DEV=1, e.g. `npm run dev:seed`): the host injects
  // window.__STARNET_DEV__ = {model, prov} and holds the API key in its own env (runtimeKey). We treat dev
  // like the desktop "server holds the key" seam — no key in the page, configured() is true, and a fresh
  // origin (a new worktree port) auto-resumes the server-seeded save with no connect screen / awakening.
  const DEV = (typeof window !== 'undefined' && window.__STARNET_DEV__ && typeof window.__STARNET_DEV__ === 'object') ? window.__STARNET_DEV__ : null;
  const DEVMODE = !!DEV;
  if (DEVMODE) {
    try {
      if (DEV.model) localStorage.setItem('starnet.byok.model', String(DEV.model));
      localStorage.setItem('starnet.byok.prov', String(DEV.prov || 'openrouter'));
    } catch (_) {}
  }
  let _configured = false;   // desktop back-compat alias for "is the OpenRouter key stored?"
  let _configuredByProvider = Object.create(null);
  let _alternateCountByProvider = Object.create(null);
  let apiToken = (typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) ? String(window.__STARNET_API_TOKEN__) : '';
  let apiTokenPromise = null;

  // TRUE only for our OWN sidecar API — a same-origin request under /api/. The X-StarNet-Token this gates is a
  // PRIVATE local credential; a naive substring match on '/api/' would attach it to third-party URLs that merely
  // contain '/api/' (e.g. the OpenRouter fallback catalog https://openrouter.ai/api/v1/models), leaking the token
  // cross-origin AND forcing a CORS preflight OpenRouter rejects (so the fallback fails exactly when it's needed).
  // Accepted = a leading-slash relative path ('/api/...'), an absolute URL at location.origin, OR the exact
  // configured loopback sidecar origin used by the packaged Tauri page.
  function apiPath(s) {
    s = String(s || '');
    if (s.indexOf('/api/') === 0) return true;   // leading-slash relative — always same-origin
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;   // other relative forms don't carry another origin
    try {
      const base = (typeof location !== 'undefined' && location.href) ? location.href : undefined;
      const parsed = new URL(s, base);
      const here = (typeof location !== 'undefined' && location.origin) ? location.origin : null;
      if (parsed.pathname.indexOf('/api/') !== 0) return false;
      if (here != null && parsed.origin === here) return true;
      // The packaged Tauri page is cross-origin from its configured loopback sidecar. Trust only that
      // exact configured loopback origin; accepting arbitrary cross-origin /api URLs would leak the token.
      let sidecar = null;
      const configured = (typeof window !== 'undefined' && window.__STARNET_API__) ? String(window.__STARNET_API__) : '';
      if (configured) {
        try {
          const u = new URL(configured, base);
          const host = String(u.hostname || '').toLowerCase();
          const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
          if (loopback && (u.protocol === 'http:' || u.protocol === 'https:')) sidecar = u.origin;
        } catch (_) {}
      }
      return sidecar != null && parsed.origin === sidecar;
    } catch (_) { return false; }
  }
  function isApiUrl(u) {
    if (typeof u === 'string') return apiPath(u);
    return !!(u && typeof u.url === 'string' && apiPath(u.url));
  }
  function withApiToken(init, token) {
    init = Object.assign({}, init || {});
    const headers = new Headers(init.headers || {});
    if (token) headers.set('X-StarNet-Token', token);
    init.headers = headers;
    return init;
  }
  function ensureApiToken() {
    if (!apiToken && typeof window !== 'undefined' && window.__STARNET_API_TOKEN__) apiToken = String(window.__STARNET_API_TOKEN__);
    if (apiToken) return Promise.resolve(apiToken);
    if (!apiTokenPromise) apiTokenPromise = Promise.resolve('').then(t => { apiTokenPromise = null; return t; });
    return apiTokenPromise;
  }
  if (typeof window !== 'undefined' && window.fetch && !window.__STARNET_FETCH_HARDENED__) {
    const rawFetch = window.fetch.bind(window);
    window.fetch = function (u, init) {
      if (!isApiUrl(u)) return rawFetch(u, init);
      return ensureApiToken().then(t => rawFetch(u, withApiToken(init, t)));
    };
    window.__STARNET_FETCH_HARDENED__ = true;
  }

  /* desktop: load the keychain "configured?" flag once at boot, before the connect screen reads it */
  async function init() {
    await ensureApiToken();
    // BEFORE the desktop early-return on purpose: managed credits live in the SIDECAR, not the keychain, so
    // they are configured identically in a browser build and a packaged one. Probing after the return would
    // leave configured('starnet') false forever anywhere that isn't Tauri — including every dev session.
    await refreshCreditsConfigured();
    if (!DESKTOP) return;
    let loaded = false;
    try {
      const status = await invoke('harness_provider_key_status');
      if (Array.isArray(status)) {
        _configuredByProvider = Object.create(null);
        status.forEach(s => {
          const p = normalizeProviderId(s && s.provider);
          _configuredByProvider[p] = !!(s && s.configured);
          _alternateCountByProvider[p] = Math.max(0, Number(s && s.alternateCount) || 0);
        });
        _configured = !!_configuredByProvider.openrouter;
        loaded = true;
      }
    } catch (_) {}
    if (!loaded) {
      try { _configured = await invoke('harness_has_key'); } catch (_) { _configured = false; }
      _configuredByProvider.openrouter = _configured;
    }
    // CODEX IS NOT A KEYCHAIN PROVIDER (its OAuth tokens live sidecar-side in workspaces/codex/), so the
    // keychain status above can NEVER report it — which left configured('codex') false FOREVER on desktop:
    // every ChatGPT-sign-in install had brainReady() dead, so the live awakening beats + the V3 interview
    // silently degraded to the scripted spine on every machine (proven on Andrew's 3-install test,
    // 2026-07-19). Ask the sidecar directly; fail-open (a dead route just leaves it unconfigured).
    try {
      const r = await fetch('/api/auth/codex/status');   // same relative idiom app.js's refreshCodexStatus uses (works in browser + desktop webview)
      if (r && r.ok) { const j = await r.json(); if (j && j.connected) _configuredByProvider.codex = true; }
    } catch (_) {}
    // The OTHER device-code OAuth providers (grok/kimi) hold their tokens sidecar-side too — same probe,
    // same fail-open contract (a dead route just leaves them unconfigured).
    await Promise.all(['grok', 'kimi'].map(async pid => {
      try {
        const r = await fetch('/api/auth/' + pid + '/status');
        if (r && r.ok) { const j = await r.json(); if (j && j.connected) _configuredByProvider[pid] = true; }
      } catch (_) {}
    }));
  }
  // Whether this station can run on managed credits. The bearer is the linked device token the SIDECAR
  // holds — there is nothing on this side to inspect, so we ask, exactly as codex/grok/kimi do. Fail-open:
  // /api/credits 404s by design when credits are unconfigured, which just leaves the provider unconfigured.
  //
  // WITHOUT THIS A CREDITS-ONLY STATION IS STRANDED. Resume gates on `getKey() || configured()`, and a user
  // who linked an account and never pasted a key has neither — so every boot would bounce them to the
  // connect screen demanding an API key they deliberately do not have.
  //
  // Called again after a link/unlink so selecting STARNET does not wait for a page reload.
  async function refreshCreditsConfigured() {
    try {
      const r = await fetch('/api/credits?history=0', { cache: 'no-store' });
      const j = (r && r.ok) ? await r.json() : null;
      _configuredByProvider.starnet = !!(j && j.configured);
    } catch (_) { _configuredByProvider.starnet = false; }
    return !!_configuredByProvider.starnet;
  }
  /* whether a key is set — works in both modes; never exposes the value. In dev mode the host holds the
     key (runtimeKey), so we report configured without one — that's what lets a fresh origin auto-resume. */
  function normalizeProviderId(provider) {
    const p = String(provider || getProv() || 'openrouter').trim().toLowerCase();
    if (p === 'codex' || p === 'openai-codex') return 'codex';
    if (p === 'openai' || p === 'openai-api') return 'openai';
    if (p === 'anthropic' || p === 'claude') return 'anthropic';
    if (p === 'gemini' || p === 'google' || p === 'google-ai' || p === 'google-gemini') return 'gemini';
    // grok/kimi are their OWN keyless OAuth (subscription) providers — NOT aliases for the API-key
    // providers. Folding 'grok' into 'xai' here silently rewrote every GROK OAUTH selection into the
    // API-key xAI provider (and 'kimi' fell through to 'openrouter'), so the OAuth brains could never
    // actually be the active provider anywhere Harness owns the truth.
    if (p === 'grok' || p === 'grok-oauth' || p === 'supergrok' || p === 'xai-oauth') return 'grok';
    if (p === 'kimi' || p === 'moonshot' || p === 'kimi-code' || p === 'kimi-for-coding' || p === 'kimi-oauth') return 'kimi';
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
  function providerSlot(base, provider) {
    return base + '.' + normalizeProviderId(provider || getProv());
  }
  function readScoped(base, provider) {
    const p = normalizeProviderId(provider || getProv());
    const scoped = localStorage.getItem(providerSlot(base, p));
    if (scoped != null) return scoped;
    return p === 'openrouter' ? (localStorage.getItem(base) || '') : '';
  }
  function writeScoped(base, provider, value) {
    const p = normalizeProviderId(provider || getProv());
    const v = value == null ? '' : String(value);
    localStorage.setItem(providerSlot(base, p), v);
    if (p === 'openrouter') localStorage.setItem(base, v);
  }
  function setDesktopConfigured(provider, value) {
    const p = normalizeProviderId(provider || getProv());
    _configuredByProvider[p] = !!value;
    if (p === 'openrouter') _configured = !!value;
  }
  function providerNeedsKey(provider) {
    const p = normalizeProviderId(provider);
    // codex/grok/kimi authenticate by device-code OAuth tokens held sidecar-side; ollama/custom are keyless
    // endpoints; starnet's bearer is the linked device token, which the user never sees, let alone pastes.
    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet';
  }
  function configured(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'ollama') return true;
    if (p === 'custom' && getBaseUrl(p)) return true;
    // STARNET MANAGED is configured IFF the sidecar reports live credits — in BOTH modes. It must not fall
    // through to the keyless branch below, which would answer "configured" for every station simply because
    // there is no key to look for, and claim a station can run on credits it has never been linked to.
    if (p === 'starnet') return !!_configuredByProvider.starnet;
    return DESKTOP ? !!(_configuredByProvider[p] || (p === 'openrouter' && _configured)) : (DEVMODE || !providerNeedsKey(p) || !!getKey(p));
  }

  // Truthful-telemetry getter for the SETTINGS credential list/badges: true IFF a real credential
  // actually exists for this provider — never fabricated by DEVMODE. Unlike configured() (which gates
  // run-ability and intentionally reports true in DEVMODE for auto-resume), this answers ONLY "does a
  // stored credential back this row?" so removing a key makes the row/badge disappear on rerender.
  //   - a real API key is stored (browser localStorage), OR
  //   - desktop OS keychain reports it (getKey returns '' by design there; _configuredByProvider holds truth), OR
  //   - a deliberately keyless endpoint is configured (custom with a baseUrl; ollama is a local endpoint), OR
  //   - codex OAuth is connected, OR
  //   - DEV seed: the host holds a server-side runtime credential for exactly DEV.prov (the seeded provider).
  function hasStoredCredential(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'codex') return DESKTOP ? !!_configuredByProvider.codex : (getProv() === 'codex');
    // grok/kimi mirror codex: OAuth tokens live sidecar-side, so the desktop configured map (fed by the boot
    // probe + app.js's status refresh) is the only local truth; in the browser the active-provider pick stands in.
    if (p === 'grok' || p === 'kimi') return DESKTOP ? !!_configuredByProvider[p] : (getProv() === p);
    if (p === 'ollama') return false;                      // an endpoint is configuration, never a credential
    if (p === 'custom' && !getKey(p)) return false;        // a keyless custom endpoint must not manufacture a key row
    if (DESKTOP) return !!(_configuredByProvider[p] || (p === 'openrouter' && _configured));
    if (!!readScoped(LS.key, p)) return true;              // a real key is stored in this browser
    // DEV seed: the host may hold a server-side runtime key for the seeded provider. It is not a given —
    // a seeded station with no key at all still boots in DEV mode, and ASSUMING the key existed made the
    // settings row render "● KEY SAVED" over nothing (an agent live-verifying a change reads that badge as
    // proof it can run). `hasKey` is the sidecar's own answer; an older boot payload without it reads false.
    if (DEVMODE && DEV && DEV.hasKey === true && normalizeProviderId(DEV.prov) === p) return true;
    return false;
  }

  // getKey() returns the real key in the browser; in desktop it returns '' (the key isn't here).
  const getKey = provider => DESKTOP ? '' : readScoped(LS.key, provider);
  const setKey = (k, provider) => {
    const p = normalizeProviderId(provider || getProv());
    if (DESKTOP) {
      const on = !!(k && String(k).trim());
      // configured flips ONLY after the keychain write PROVES itself. The old optimistic pre-invoke flip meant a
      // rejected write (locked/denied keychain) left the map claiming "configured" while no key existed anywhere —
      // Settings toasted "✓ stored in your OS keychain", the no-key nudges stayed cleared, and the next run died
      // with no re-entry hint (desktop-only strand; the browser branch is synchronous localStorage). Callers see
      // the rejection and must render the honest failure.
      return invoke('harness_store_provider_key', { provider: p, key: k || '', baseUrl: getBaseUrl(p) || '' })
        .catch(e => {
          if (p === 'openrouter') return invoke('harness_store_key', { key: k || '' });
          throw e;
        })
        .then(r => { setDesktopConfigured(p, on); return r; })
        .catch(e => { setDesktopConfigured(p, false); throw e; });
    }
    writeScoped(LS.key, p, k || '');
  };
  function keyPoolSize(provider) {
    const p = normalizeProviderId(provider || getProv());
    if (DESKTOP) return Math.max(0, Number(_alternateCountByProvider[p]) || 0);
    try { return JSON.parse(readScoped(LS.keyPool, p) || '[]').length || 0; } catch (_) { return 0; }
  }
  function setKeyPool(keys, provider) {
    const p = normalizeProviderId(provider || getProv());
    const cleaned = Array.from(new Set((Array.isArray(keys) ? keys : []).map(k => String(k || '').trim()).filter(Boolean))).slice(0, 8);
    if (DESKTOP) {
      return invoke('harness_store_provider_key_pool', { provider: p, keys: cleaned })
        .then(count => { _alternateCountByProvider[p] = Math.max(0, Number(count) || 0); return count; });
    }
    writeScoped(LS.keyPool, p, JSON.stringify(cleaned));
    return Promise.resolve(cleaned.length);
  }
  async function validateAndSetKeyPool(keys, provider) {
    const p = normalizeProviderId(provider || getProv());
    const cleaned = Array.from(new Set((Array.isArray(keys) ? keys : []).map(k => String(k || '').trim()).filter(Boolean))).slice(0, 8);
    for (const candidate of cleaned) {
      const r = await fetch('/api/providers/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, key: candidate, baseUrl: getBaseUrl(p) || '', model: p === getProv() ? getModel() : '' })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.credentialVerified) throw new Error(String(j.error || 'a backup key was rejected') + ' — your previous backup pool is unchanged');
    }
    return setKeyPool(cleaned, p);
  }
  // Channel bot tokens (Telegram/Discord). Desktop: store in the OS keychain via Tauri (never over HTTP, never
  // plaintext) — mirrors setKey for provider keys. Returns a promise that resolves to true when the token was
  // routed to the keychain, false in the browser build (where the caller lets the token ride the connect POST as
  // before). An empty token clears the stored token. `DESKTOP` is the only branch — dev/browser keep the old path.
  function storeChannelToken(channel, token) {
    const c = String(channel || '').trim().toLowerCase();
    if (!DESKTOP || !c) return Promise.resolve(false);
    return Promise.resolve(invoke('harness_store_channel_token', { channel: c, token: token || '' }))
      .then(() => true)
      .catch(e => { console.warn('[harness] channel-token store failed:', (e && e.message) || e); return false; });
  }
  const getModel = () => localStorage.getItem(LS.model) || '';
  const setModel = m => {
    const prev = localStorage.getItem(LS.model) || '';
    localStorage.setItem(LS.model, m || '');
    // A deliberate model switch invalidates every context-occupancy reading (a different window,
    // and the next prompt re-measures): blank the gauge honestly rather than show a stale fill.
    // The learned overheads survive — they are keyed BY MODEL, so switching back re-uses the
    // calibration that model already earned instead of going blind again.
    if ((m || '') !== prev) { contextByKey = {}; runConv = {}; }
  };
  const getProv = () => normalizeProviderId(localStorage.getItem(LS.prov) || 'openrouter');
  const setProv = p => localStorage.setItem(LS.prov, normalizeProviderId(p || 'openrouter'));
  const getBaseUrl = provider => readScoped(LS.baseUrl, provider);
  const setBaseUrl = (u, provider) => {
    const p = normalizeProviderId(provider || getProv());
    writeScoped(LS.baseUrl, p, u || '');
    if (DESKTOP) {
      return invoke('harness_store_provider_key', { provider: p, baseUrl: u || '' }).catch(() => {});
    }
  };
  function defaultReasoningEffortForProvider(provider) {
    const p = normalizeProviderId(provider);
    if (p === 'codex') return 'low';
    if (p === 'kimi') return 'none';   // mirrors the sidecar registry profile (kimi-for-coding has no reasoning dial)
    if (p === 'ollama') return 'none';
    return 'medium';
  }
  function normalizeReasoningEffort(value) {
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
  const getReasoningEffort = provider => normalizeReasoningEffort(readScoped(LS.effort, provider) || defaultReasoningEffortForProvider(provider));
  const setReasoningEffort = (e, provider) => writeScoped(LS.effort, provider || getProv(), normalizeReasoningEffort(e));

  /* per-million pricing for a model id, if known from the catalog */
  function priceOf(id) {
    const m = catalogModel(id);
    if (!m || !m.pricing) return null;
    const inP = parseFloat(m.pricing.prompt) * 1e6;
    const outP = parseFloat(m.pricing.completion) * 1e6;
    if (!isFinite(inP) || !isFinite(outP)) return null;
    return { in: inP, out: outP };
  }

  /* the model's real max context-window length (tokens) from the catalog, or 0 if unknown.
     The sidecar's model endpoint carries OpenRouter context_length through to the browser; if
     that endpoint is unavailable we fall back to the public OpenRouter catalog. */
  function contextLimitOf(id) {
    const m = catalogModel(id);
    return (m && m.context_length) || 0;
  }

  /* Context-window occupancy for ONE conversation — the question the bottom-bar gauge actually asks
     ("MEMORY OF THIS CHAT"), so it is answered per (agentId, streamId), never per agent alone.

       contextState(agentId, streamId, messages)
         messages — the dialogue this conversation would send next (chat.js historyWindow). Optional;
                    without it the reading falls back to the last measurement, as before.

     Three honest answers, in order of strength:
       1. LIVE      a run is streaming for this conversation right now → the provider's own
                    prompt_tokens for the request in flight. Exact, and the one time the bar should
                    track an agentic run climbing toward the compaction threshold.
       2. PROJECTED the model's learned harness overhead + our estimate of this conversation's
                    dialogue. This is what makes a NEW or RESUMED session readable instead of blank,
                    and what makes the bar move when you paste something big. Marked projected → the
                    renderer prints "~", so it never passes as a measurement.
       3. MEASURED  a settled reading for THIS conversation whose message set has not changed since
                    (used when we have no calibration to project from yet).
     None of those available → measured:false, projected:false: the gauge shows "calibrating" rather
     than a number it cannot stand behind.

     The reading is trusted for the model that PRODUCED it (rec.model — the provider stamped it on the
     reconciled agent.cost), so a mid-run provider failover or a crew agent on an aux model still shows
     its real occupancy against that model's real limit. */
  function contextState(agentId, streamId, messages) {
    const aid = agentId || 'agent';
    const rec = contextByKey[convKey(aid, streamId)] || null;
    const hasRec = !!(rec && rec.used > 0 && rec.model);
    const model = (hasRec && rec.model) || getModel() || '';
    const limit = contextLimitOf(model);
    const base = { agentId: aid, streamId: String(streamId || ''), model, limit };

    // 1. in flight — report what the provider says the model is holding this second
    if (hasRec && rec.live) return Object.assign(base, { used: rec.used, measured: true, projected: false });

    const est = Array.isArray(messages) ? estOf(messages) : null;
    // 2. this transcript was itself measured (a run's FIRST turn carried exactly these messages) and
    //    nothing has been added since — an exact reading beats projecting the same thing.
    if (hasRec && rec.baseline > 0 && est !== null && est === rec.sentEstimate) {
      return Object.assign(base, { used: rec.baseline, measured: true, projected: false });
    }
    if (hasRec && est === null) return Object.assign(base, { used: rec.used, measured: true, projected: false });   // caller passed no transcript
    // 3. this conversation HAS a measurement, just not of its current shape: grow from its own
    //    baseline. Better than the model-level fit because that baseline already contains this chat's
    //    real overhead AND anything the sidecar compacted away — neither has to be re-guessed.
    if (hasRec && rec.baseline > 0 && est !== null && hasEst()) {
      return Object.assign(base, { used: CtxGauge.projectFromBaseline(rec.baseline, rec.sentEstimate, messages), measured: false, projected: true });
    }
    // 4. never measured here — fall back to the model's learned overhead plus this transcript
    const cal = overheadByModel[aid + SEP + model];
    if (est !== null && cal && hasEst()) {
      return Object.assign(base, { used: CtxGauge.projectFrom(cal, messages), measured: false, projected: true });
    }
    if (hasRec) return Object.assign(base, { used: rec.used, measured: true, projected: false });
    return Object.assign(base, { used: 0, measured: false, projected: false });
  }

  function normalizeModel(m) {
    const params = Array.isArray(m && m.supported_parameters) ? m.supported_parameters.slice() : [];
    return {
      id: m && m.id,
      name: (m && (m.name || m.id)) || '',
      pricing: (m && m.pricing) || null,
      context_length: (m && +m.context_length) || 0,
      supportsTools: (m && typeof m.supportsTools === 'boolean') ? m.supportsTools : (params.length ? params.indexOf('tools') >= 0 : true),
      supportsReasoning: !!(m && m.supportsReasoning),
      supported_parameters: params,
      reasoningEfforts: Array.isArray(m && m.reasoningEfforts) ? m.reasoningEfforts.slice() : []
    };
  }

  // The model catalog can proxy a LIVE external fetch (OpenRouter's /models); a slow/blocked upstream must
  // never hang a caller. Bound every catalog fetch with an AbortController timeout so listModels() always
  // settles — a timeout reads as "catalog unavailable" (empty list), exactly like an offline sidecar.
  const MODEL_CATALOG_TIMEOUT_MS = 6000;
  async function fetchModelCatalog(url, field) {
    let ctl = null, t = null;
    try { ctl = new AbortController(); t = setTimeout(() => { try { ctl.abort(); } catch (_) {} }, MODEL_CATALOG_TIMEOUT_MS); } catch (_) {}
    try {
      const r = await fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const raw = (j && j[field]) || [];
      return raw.map(normalizeModel).filter(m => m.id);
    } finally { if (t) clearTimeout(t); }
  }

  /* public model catalog (no key required) — populates the connect dropdown */
  async function listModels(provider) {
    try {
      let list;
      const p = normalizeProviderId(provider || getProv());
      try {
        const q = (p === 'custom' && getBaseUrl(p)) ? ('?baseUrl=' + encodeURIComponent(getBaseUrl(p))) : '';
        list = await fetchModelCatalog('/api/models/' + encodeURIComponent(p) + q, 'models');
      } catch (_) {
        if (p === 'openrouter') list = await fetchModelCatalog(OR + '/models', 'data');
        else list = [];
      }
      list.sort((a, b) => a.id.localeCompare(b.id));
      // scope the catalog to the provider it was fetched FOR — never to a shared map another
      // provider's warm can overwrite (see modelsByProv above).
      const map = Object.create(null);
      for (const m of list) map[m.id] = m;
      modelsByProv[p] = map;
      return list;
    } catch (e) {
      console.warn('[harness] model list unavailable:', e.message);
      return [];
    }
  }

  // Truthful provider state for Settings. Configuration, credential custody, endpoint reachability and catalog
  // availability are independent facts; callers must never infer one from another. The sidecar performs the
  // round-trip so desktop keychain credentials stay out of the WebView, while browser BYOK can be supplied over
  // the same authenticated loopback seam used by /api/run. A failed probe is data, not an exception-shaped lie.
  async function probeProvider(provider) {
    const p = normalizeProviderId(provider || getProv());
    const baseUrl = getBaseUrl(p) || '';
    const credentialSaved = hasStoredCredential(p);
    const endpointConfigured = p === 'ollama' || (p === 'custom' && !!baseUrl);
    const selected = p === getProv();
    const fallback = { provider: p, credentialSaved, endpointConfigured, reachable: false, catalogAvailable: false, credentialVerified: false, selected, error: 'station unreachable' };
    if (p === 'custom' && !endpointConfigured) return Object.assign({}, fallback, { error: 'endpoint not configured' });
    try {
      const r = await fetch('/api/providers/probe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: p, key: getKey(p) || '', baseUrl })
      });
      const j = await r.json().catch(() => ({}));
      return {
        provider: p, credentialSaved, endpointConfigured,
        reachable: !!(r.ok && j.reachable), catalogAvailable: !!(j && j.catalogAvailable),
        credentialVerified: !!(j && j.credentialVerified), selected,
        error: String((j && j.error) || '')
      };
    } catch (_) { return fallback; }
  }

  // Replace a credential as one user-visible operation: prove the candidate first, then commit it. Validation
  // never mutates provider state, so a rejection/timeout leaves the previous working key untouched.
  async function validateAndSetKey(key, provider) {
    const p = normalizeProviderId(provider || getProv());
    const candidate = String(key || '').trim();
    if (!candidate) return setKey('', p);
    const r = await fetch('/api/providers/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: p, key: candidate, baseUrl: getBaseUrl(p) || '', model: p === getProv() ? getModel() : '' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.credentialVerified) {
      throw new Error(String(j.error || 'the provider did not verify this key') + ' — your previous key is unchanged');
    }
    await Promise.resolve(setKey(candidate, p));
    return Object.assign({}, j, { stored: true });
  }

  // PURE (test-locked in harness-internal.test.js): fold a sidecar error-response body into the human tail of
  // the thrown "sidecar HTTP <status> — <detail>" message. JSON envelopes ({error}/{message}, + code when it
  // isn't already in the text) unwrap to their message; anything else passes through. Bounded, never throws.
  function sidecarErrorDetail(text) {
    const t = String(text == null ? '' : text).slice(0, 600).trim();
    if (!t) return '';
    try {
      const j = JSON.parse(t);
      const msg = j && (j.error || j.message);
      if (msg) {
        let out = String(msg);
        if (j.code && out.indexOf(String(j.code)) < 0) out += ' (' + String(j.code) + ')';
        return out.slice(0, 600).trim();
      }
    } catch (_) {}
    return t;
  }

  /* Run an agent turn/task through the LOCAL SIDECAR (node sidecar/index.js), which holds the
     real agent loop + tools (web, files). We POST the request and read the response body as a
     stream of newline-delimited JSON events — the FROZEN agent.* U.bus events the harness emits.
     Each event is re-emitted on U.bus (for telemetry) and mapped to the caller's callbacks.
     onToken(delta) per text delta · onToolCall/onToolResult per tool step · onUsage per turn. */
  async function chat({ system, messages, onToken, onTerminalReset, onUsage, onToolCall, onToolResult, onRunId, onDeliverable, onPermission, onSummon, agentId, isTask, recurring, signal, streamId, recipeId, workbench, placed, stationPlaced, internal, evidence, projectRoot, taskAction, postconditions, recovery, connectorContinuationOf, retryUserRunId }) {
    const model = getModel(), provider = getProv(), key = getKey(provider), reasoningEffort = getReasoningEffort(provider);
    // Codex authenticates by an OAuth token (server-side); the desktop build keeps the key in the
    // sidecar's env (keychain). Neither needs a key sent from here.
    if (providerNeedsKey(provider) && !DESKTOP && !DEVMODE && !key) throw new Error('no API key set');
    if (!model) throw new Error('no model selected');

    let res;
    try {
      const reqBody = { model, provider, reasoningEffort, system, messages, agentId: agentId || 'agent', isTask: !!isTask, recurring: !!recurring };
      if (recovery && recovery.sourceRunId && recovery.continuationId && recovery.continuationToken) {
        reqBody.recovery = {
          sourceRunId: String(recovery.sourceRunId), continuationId: String(recovery.continuationId),
          continuationToken: String(recovery.continuationToken)
        };
      }
      if (getBaseUrl(provider)) reqBody.baseUrl = getBaseUrl(provider);
      if (streamId) reqBody.streamId = streamId;   // M-mem.2b: scope this run's memory to the active workstream
      if (connectorContinuationOf) reqBody.connectorContinuationOf = connectorContinuationOf;
      if (retryUserRunId) reqBody.retryUserRunId = String(retryUserRunId);
      // reason-only self-talk (retitle / goal-judge / pitch / autopilot): the sidecar keeps the caller's system
      // prompt VERBATIM (no manual/capability/skill/memory dressing) and never stamps the away clock for it.
      if (internal) reqBody.internal = true;
      /* THE EVIDENCE PACK, for the runs that must GUESS (rec perfection W2). An internal run gets a verbatim
         system prompt — which is right for a strict-format parse, and wrong for the three RECOMMENDATION
         generators, which were asked "what should this Commander do next?" while being handed strictly less
         about the Commander than an ordinary task run receives. `evidence:true` appends the SAME bounded,
         provenance-labelled server-side pack (commander-context.js) an ordinary task gets — nothing else about
         the internal path changes (no manual, no skills, no memory fence, no recall-stat writes). */
      if (evidence) reqBody.evidence = true;
      if (/^(answer|cancel|replace)$/.test(String(taskAction || ''))) reqBody.taskAction = String(taskAction);
      if (postconditions != null) reqBody.postconditions = postconditions;
      if (recipeId) reqBody.recipeId = String(recipeId).slice(0, 60);   // provenance spine: which recipe launched this run (rides to the durable run row)
      // project-anchored session (ref-parity working folder): the sidecar injects the folder context line
      // ONLY when this root is still a standing blessed path grant — an un-blessed root injects nothing.
      if (projectRoot) reqBody.projectRoot = String(projectRoot);
      // THE MOAT (FLOOR-REAL): send the agent's REAL placed capability objects so the sidecar grants exactly what's
      // on the floor (dish→web · cabinet→files · workbench→terminal · …). `placed` supersedes the legacy `workbench`
      // boolean; an old caller passing only `workbench` still grants the terminal.
      if (Array.isArray(placed) && placed.length) reqBody.placed = placed;
      else if (workbench) reqBody.workbench = true;
      // Class Loadouts (shared-gear model): the STATION-WIDE gear the agent draws on under the overseer. Tools stay
      // gated by `placed` (the agent's own desk-room), but a class's SKILL PACKAGE — recipes, not tools — becomes
      // available when the STATION has the required shared gear (a specialist owns only a desk yet still gets its
      // class skills). Sent separately so the tool projection is untouched; the sidecar uses it for skills only.
      if (Array.isArray(stationPlaced) && stationPlaced.length) reqBody.stationPlaced = stationPlaced;
      if (!DESKTOP && !DEVMODE && provider !== 'codex' && provider !== 'grok' && provider !== 'kimi') reqBody.key = key;   // dev/desktop + the OAuth providers keep secrets server-side (custom/ollama may still ride an optional key)
      if (!DESKTOP && !DEVMODE) {
        try { const pool = JSON.parse(readScoped(LS.keyPool, provider) || '[]'); if (Array.isArray(pool) && pool.length) reqBody.keyPool = pool; } catch (_) {}
      }
      res = await fetch('/api/run', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });
    } catch (e) {
      throw new Error('cannot reach the STARNET sidecar — start it with `npm start` (node sidecar/index.js)');
    }
    // A pre-stream failure's TRUE reason lives in the response body — runRouteFailure's {"error":"sidecar
    // failure: Not signed in to ChatGPT …"} JSON, handleRun's "missing key/model", the token gate's "forbidden
    // token". The old bare throw discarded it, so the friendly-error ladder never saw the text it classifies on
    // and the RECONNECT CHATGPT / reload doors were lost on this whole path (EL-10/EL-11). Read it (bounded)
    // and carry it in the thrown message.
    if (!res.ok || !res.body) {
      let detail = '';
      try { detail = sidecarErrorDetail(await res.text()); } catch (_) {}
      throw new Error('sidecar HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '', lastUsage = null, runId = null, errMsg = null, endReason = null, finishReason = null, completionVerdict = 'not_assessed', effectVerdict = 'no_observed_effects';
    let budgetScope = null, budgetCapUsd = null;   // additive: WHICH spend cap ended a 'budget' run (+ its $ cap)

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const s = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!s) continue;
        let ev; try { ev = JSON.parse(s); } catch (_) { continue; }
        const name = ev.name, payload = ev.payload || {};
        // INTERNAL reason-only calls (the pitch/suggest self-talk) still produce usage events, but must NOT
        // register as delivered tasks: drop their run.start/run.end re-emit so
        // XP / tasksDone / FloorStats products / the quest log / the suggestion cooldown never count the agent
        // thinking to itself (truthful-telemetry + honest-loot). The caller's own promise result is unaffected — the
        // switch below still latches runId/endReason locally from these same events.
        const suppressBus = internal && (name === 'agent.run.start' || name === 'agent.run.end');
        if (!suppressBus && typeof U !== 'undefined' && U.bus) { try { U.bus.emit(name, payload); } catch (_) {} }
        switch (name) {
          // latch the LEAD's runId on the FIRST run.start only. Stage 2: a delegated worker's run.start/end/error
          // are forwarded onto THIS (the lead's) stream for the floor animation — they still reach U.bus above, but
          // must NOT hijack the lead's runId / endReason / errMsg (keyed below to the lead's runId).
          case 'agent.run.start':
            if (payload.runId && payload.model) runModels[payload.runId] = payload.model;
            if (internal && payload.runId) internalRuns.add(payload.runId);   // this run's cost events must not move the context gauge
            // Bind the run to the CONVERSATION that launched it. Only here do we know both the
            // streamId and the exact message array we sent, and the gauge needs both: the streamId to
            // avoid painting this run's fill onto some other session, the messages to learn what the
            // harness adds on top of them. run.start always precedes agent.cost on this stream, so the
            // bus fold below always finds the registration.
            if (payload.runId && !internal) registerRun(payload.runId, agentId || 'agent', streamId, messages);
            if (!runId) { runId = payload.runId; onRunId && onRunId(runId); }
            break;
          case 'agent.token': full += payload.delta; onToken && onToken(payload.delta); break;
          // Any prose before a tool call was an in-progress narration segment, not the terminal answer. Keep it
          // visible in the chronological live transcript, but reset every final-output accumulator at this
          // authoritative boundary so returned/persisted/delivered text contains exactly the last assistant turn.
          case 'agent.tool_call': full = ''; onTerminalReset && onTerminalReset(); onToolCall && onToolCall(payload); break;
          case 'agent.tool_result': onToolResult && onToolResult(payload); break;
          case 'deliverable': onDeliverable && onDeliverable(payload); break;
          // the run is PAUSED on the sidecar awaiting this; the UI shows approve/always/full/deny and answers
          // via Harness.consent(). No more events arrive on this stream until the answer is POSTed.
          case 'permission.prompt': onPermission && onPermission(payload); break;
          // a backend COMMAND: the orchestrator's team.summon tool asks us to create a worker. The handler runs the
          // real summonAgent() and POSTs /api/summon/ack with the new id (Harness.summonAck), resolving the tool.
          case 'crew.summon.request': onSummon && onSummon(payload); break;
          case 'agent.cost':
            totals.tokens += (payload.tokensIn || 0) + (payload.tokensOut || 0);
            totals.cost += payload.usd || 0;
            // The newest prompt_tokens is the live context reading for this event's agent/model. The
            // U.bus subscription (foldContextCost) already saw this payload via the re-emit above;
            // fold directly only when the bus is unavailable (headless/test embeds).
            if (typeof U === 'undefined' || !U.bus) foldContextCost(payload);
            // `model` rides along because it is the SIDECAR's report of what actually served this call —
            // the only model fact a caller can attribute to a run. Additive: existing readers ignore it.
            lastUsage = { total_tokens: (payload.tokensIn || 0) + (payload.tokensOut || 0), cost: payload.usd, model: payload.model || '' };
            onUsage && onUsage(lastUsage); break;
          case 'capdenied': errMsg = errMsg || ('no ' + (payload.need || 'capability') + ' — ' + (payload.reason || '')); break;
          case 'agent.run.error': if (!payload.runId || payload.runId === runId) errMsg = payload.message; break;   // the lead's own error (a worker's rides the tool result)
          case 'agent.run.end':
            if (payload.runId) { delete runModels[payload.runId]; internalRuns.delete(payload.runId); }
            // latch the lead's stop reason AND (Lane 5, additive) WHY it stopped when the provider truncated/
            // filtered it — the caller renders a "cut short" recap instead of a delivered crate for those.
            if (!payload.runId || payload.runId === runId) {
              endReason = payload.reason; finishReason = payload.finishReason || null;
              completionVerdict = payload.completionVerdict || 'not_assessed';
              effectVerdict = payload.effectVerdict || 'no_observed_effects';
              // additive budget-stop detail: which cap fired + the effective $ cap (absent on non-budget stops)
              budgetScope = payload.budgetScope || null;
              budgetCapUsd = (typeof payload.budgetCapUsd === 'number' && isFinite(payload.budgetCapUsd)) ? payload.budgetCapUsd : null;
            }
            break;   // the lead's own end, not a forwarded worker's
        }
      }
    }
    totals.calls++;
    // surface the error to the caller (do NOT swallow it just because some text streamed first) —
    // a network/fetch failure still throws below; this is for in-band run errors / capdenied.
    if (errMsg) return { text: full, usage: lastUsage, runId, error: errMsg, endReason, finishReason, completionVerdict, effectVerdict, budgetScope, budgetCapUsd };
    return { text: full, usage: lastUsage, runId, endReason, finishReason, completionVerdict, effectVerdict, budgetScope, budgetCapUsd };
  }

  /* Read-only fetch of an agent's notebook (its memory.md) from the sidecar. The agent writes these notes
     itself with the notebook tool during runs; the dossier just surfaces them. Returns [] on any failure. */
  async function notebook(agentId) {
    try {
      const r = await fetch('/api/notebook?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.notes) ? j.notes : [];
    } catch (e) { return []; }
  }

  // STOP MEANS STOP (2026-09-04): the answer is the SIDECAR's, never assumed. { ok:true } only when POST /api/cancel
  // came back 2xx; a refused status or a thrown fetch is { ok:false, error, status?, transport? } so the caller keeps
  // the UI in "stopping…" and says so — a swallowed failure here read as a clean stop while the run kept burning.
  async function cancel(runId) {
    if (!runId) return { ok: false, error: 'no run id' };
    try {
      const r = await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId }) });
      if (!r.ok) return { ok: false, error: 'the station refused the stop (http ' + r.status + ')', status: r.status };
      return { ok: true };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e), transport: true }; }
  }

  // E-STOP: stop EVERY in-flight run on the sidecar in one call — browser runs AND any messaging-hub/Telegram
  // runs. Returns the honest abort total plus the sidecar's durability receipt: current-process stopping and
  // restart persistence are distinct facts, so callers must not collapse a false *HaltPersisted field into success.
  async function haltAll() {
    try {
      const r = await fetch('/api/halt', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const j = await r.json().catch(() => ({}));
      // honest total: run controllers (browser/hub/force-fired beats) + cron leases + the driver-path beat —
      // everything the server ACTUALLY aborted, so the HALT toast never under-reports what the E-STOP stopped.
      const n = k => (j && typeof j[k] === 'number') ? j[k] : 0;
      return {
        halted: n('halted') + n('cronAborted') + n('beatAborted'),
        nightshiftHaltPersisted: j.nightshiftHaltPersisted,
        cronHaltPersisted: j.cronHaltPersisted,
        loopsHaltPersisted: j.loopsHaltPersisted
      };
    } catch (_) { return { halted: 0 }; }
  }

  // answer a live permission.prompt: decision ∈ once|always|full|deny. Resolves the run's paused dispatch so it
  // continues (or denies). Separate request from the open /api/run stream — no deadlock.
  async function consent(runId, promptId, decision) {
    if (!runId || !promptId) return { ok: false, decision: 'deny' };
    try {
      const r = await fetch('/api/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId, decision }) });
      const j = await r.json().catch(() => null);
      return (j && typeof j === 'object') ? j : { ok: false, decision: 'deny' };
    } catch (_) { return { ok: false, decision: 'deny' }; }
  }

  // EL-11 FIX 1c: attest to the sidecar that a live permission.prompt is now RENDERED to a human (the active
  // consent card, or the global background toast + rail marker). Earns the run's paused consent ONE bounded
  // extension of the fail-closed auto-deny timer — a deny on a prompt nobody saw is a consent violation.
  // A stale id is a harmless no-op on the sidecar. The RESULT is honest: { ok:true } only on a 2xx; a refused status
  // or a thrown fetch returns { ok:false, error } so the caller can warn that the extension was NOT earned (the
  // fail-closed auto-deny timer is still running against a card the station cannot prove anyone saw).
  async function consentAck(runId, promptId) {
    if (!runId || !promptId) return { ok: false, error: 'no run/prompt id' };
    try {
      const r = await fetch('/api/consent/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId }) });
      if (!r.ok) return { ok: false, error: 'the station refused the ack (http ' + r.status + ')', status: r.status };
      return { ok: true };
    } catch (e) { return { ok: false, error: (e && e.message) || String(e), transport: true }; }
  }

  // answer a live in-turn clarify card (a brief.ask riding the permission.prompt channel): the answer TEXT
  // resumes the SAME paused turn — deliberately a separate route from consent, whose decisions are a closed
  // enum with grant semantics. Fire-and-forget; a stale id is a harmless no-op (the run fell back to the
  // durable end-run question).
  async function consentAnswer(runId, promptId, answer, receipt) {
    if (!runId || !promptId || !answer) return;
    try {
      const r=await fetch('/api/consent/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, promptId, answer, receipt:receipt===true }) });
      if(receipt) return r.ok ? await r.json() : {ok:false};
    } catch (_) { if(receipt) return {ok:false}; }
  }

  // answer a live crew.summon.request: report the new agentId we summoned (or null if we couldn't), which resolves
  // the run's awaiting team.summon tool. Separate request from the open /api/run stream — no deadlock. The summon
  // tool has its own browser-ack timeout, so a dropped ack settles cleanly to "not completed" rather than hanging.
  // `desk` (optional) is the room the new agent's seeded workstation actually landed in — the ONLY reason the
  // tool result may mention a desk at all, so the lead can never announce furniture the floor doesn't have.
  async function summonAck(runId, requestId, agentId, desk) {
    if (!runId || !requestId) return;
    const body = { runId, requestId, agentId: agentId || null };
    if (desk) body.desk = String(desk).slice(0, 60);
    try { await fetch('/api/summon/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
  }

  // Cortex (M-mem.5b): after a run, reflection may PROPOSE durable memories (announced via the memory.proposed
  // SSE event). Fetch the pending candidates WITH content for the Keep/Edit/Discard turn-in beat. [] on failure.
  async function memoryProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/memory/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.proposals) ? j.proposals : [];
    } catch (e) { return []; }
  }
  // GROWTH Tier 1: after a salient run a STUDY pass may propose DOSSIER belief updates (goals/pain/style/… ADD or
  // RETIRE). Fetch the pending candidates WITH text for the study turn-in card. Consent is applied locally to the
  // dossier (Keep→DossierStore.upsert / Discard→StudyStore denylist), so there is no server verdict call. [] on failure.
  async function studyProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/study/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.proposals) ? j.proposals : [];
    } catch (e) { return []; }
  }
  // NS-6: after a salient task run the sidecar MINES threads (ideas the Commander floated but never acted on) into
  // a stash. Fetch the pending candidates for the thread turn-in card. Returns { runId, proposals } — the BATCH
  // runId matters: the turn-in verdict must reference the stash batch (which may be the agent's latest pending
  // batch when the exact run had none). { runId:null, proposals:[] } on any failure (fail-open).
  async function threadProposals(runId, agentId) {
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent') + (runId ? '&run=' + encodeURIComponent(runId) : '');
      const r = await fetch('/api/threads/proposals' + q, { cache: 'no-store' });
      if (!r.ok) return { runId: null, proposals: [] };
      const j = await r.json();
      return { runId: j.runId || null, proposals: Array.isArray(j.proposals) ? j.proposals : [] };
    } catch (e) { return { runId: null, proposals: [] }; }
  }
  // NS-6: submit ONE thread turn-in verdict { agentId, runId, id, verdict:'keep'|'edit'|'discard', title?, spec? }.
  // keep/edit COMMIT an open thread on the ledger (the click IS the consent — stash, never auto-commit); discard
  // permanently denylists the idea's fingerprint. Returns the server's { ok, reason } ({ ok:false } on failure).
  async function threadTurnin(o) {
    try {
      const r = await fetch('/api/threads/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: false }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  // submit one turn-in verdict. Keep/Edit commit a real memory (→ memory.write); every verdict → memory.feedback.
  // The sidecar re-broadcasts those over the SSE bus, so XP + the dossier update live without a local emit here.
  async function memoryTurnin(o) {
    try {
      const r = await fetch('/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: true }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  // SILENT-SAVE UX: undo an auto-saved memory (the one-tap ✕ on a passive receipt). verdict:'veto' removes the
  // saved record (a notebook note, or a skill when kind:'skill') and adds its text to the permanent declined
  // denylist so it's never re-proposed. Server emits memory.forget/feedback over SSE. { ok } on success.
  function memoryVeto(o) {
    return memoryTurninSend(Object.assign({ verdict: 'veto' }, o || {}));
  }
  function memoryTurninSend(o) {
    return fetch('/api/memory/turnin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) })
      .then(r => r.ok ? r.json().catch(() => ({ ok: true })) : { ok: false }).catch(() => ({ ok: false }));
  }
  // wipe a hero's SERVER-SIDE memory (notebook/declined/todo) on new-hero commission, so a fresh Commander never
  // inherits a stranger's kept memories or permanently-declined proposals. Fire-and-forget; a fresh hero proceeds
  // regardless (the browser advice stores are already reset locally).
  async function memoryReset(agentId) {
    try { await fetch('/api/memory/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId || 'agent' }) }); } catch (e) {}
  }

  // Cortex (M-mem.6) — the Memory Core: the FULL provenance-bearing §5.2 records (kind/sourceRunId/useCount/
  // trust/pinned/timestamps), which the slim /api/notebook view drops. [] on any failure.
  /* The same read, with the OUTCOME kept: { ok, skills }. agentSkills() below collapses every failure to []
     for its existing callers, which is fine for a list that renders "no skills yet" — but a COUNTER must never
     turn an errored read into a confident zero ("you have none" is a different claim from "I could not ask").
     Any surface that states a number reads through this one. */
  async function agentSkillsRead(agentId, opts) {
    opts = opts || {};
    try {
      const q = '?agent=' + encodeURIComponent(agentId || 'agent')
        + (opts.archived ? '&archived=1' : '')
        + (opts.body ? '&body=1' : '');
      const r = await fetch('/api/agent-skills' + q, { cache: 'no-store' });
      if (!r.ok) return { ok: false, skills: [] };
      const j = await r.json();
      if (!j || !Array.isArray(j.skills)) return { ok: false, skills: [] };
      return { ok: true, skills: j.skills };
    } catch (e) { return { ok: false, skills: [] }; }
  }
  async function agentSkills(agentId, opts) {
    return (await agentSkillsRead(agentId, opts)).skills;
  }
  async function agentSkillManage(o) {
    try {
      const r = await fetch('/api/agent-skills/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      return r.ok ? (await r.json().catch(() => ({ ok: true }))) : { ok: false };
    } catch (e) { return { ok: false }; }
  }
  /* The Commander's review decision on a skill the guard WITHHELD from the model. The approval is
     recorded against the content digest the sidecar just read, so any later edit re-asks. Carries
     the sidecar's refusal text through on failure — a 'block' verdict can never be approved and the
     panel must say why rather than silently fail. */
  async function agentSkillAllow(o) {
    try {
      const r = await fetch('/api/agent-skills/allow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) });
      const j = await r.json().catch(() => null);
      if (r.ok) return j || { ok: true };
      return { ok: false, error: (j && j.error) || 'could not record that decision' };
    } catch (e) { return { ok: false, error: 'the station did not answer' }; }
  }
  async function skillExchangePost(path, body) {
    try {
      const r = await fetch('/api/skill-exchange/' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
      });
      const j = await r.json().catch(() => null);
      if (r.ok) return j || { ok: true };
      return { ok: false, error: (j && j.error) || 'the skill exchange refused that request' };
    } catch (e) { return { ok: false, error: 'the station did not answer' }; }
  }
  function skillExchangeInspect(url) { return skillExchangePost('inspect', { url }); }
  function skillExchangeRegistry(o) { return skillExchangePost('registry', o); }
  function skillExchangeDiscover(o) { return skillExchangePost('discover', o); }
  async function skillExchangeRegistries(o) {
    if (o) return skillExchangePost('registries', o);
    try { const r = await fetch('/api/skill-exchange/registries', { cache: 'no-store' }); return r.ok ? await r.json() : { ok: false }; }
    catch (_) { return { ok: false, error: 'the station did not answer' }; }
  }
  function skillExchangeImport(envelope) { return skillExchangePost('import', { envelope }); }
  function skillExchangeInstall(o) { return skillExchangePost('install', o); }
  function skillExchangeCheck(o) { return skillExchangePost('check', o); }
  function skillExchangeExport(o) { return skillExchangePost('export', o); }
  function skillExchangePublishHandoff(o) { return skillExchangePost('publish-handoff', o); }
  function skillExchangeGenerations(o) { return skillExchangePost('generations', o); }
  function skillExchangeRollback(o) { return skillExchangePost('rollback', o); }

  async function memoryRecords(agentId) {
    try {
      const r = await fetch('/api/memory/records?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.records) ? j.records : [];
    } catch (e) { return []; }
  }
  // the three Memory Core mutations (the user's click IS the consent). { ok } on success.
  function memoryMutate(path, o) {
    return fetch('/api/memory/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) })
      .then(r => r.ok ? r.json().catch(() => ({ ok: true })) : { ok: false }).catch(() => ({ ok: false }));
  }
  const memoryPin = o => memoryMutate('pin', o);
  const memoryEdit = o => memoryMutate('edit', o);
  const memoryForget = o => memoryMutate('forget', o);
  // observability: the permanent declined reject-list (what reflection will never re-propose). [] on any failure.
  async function memoryDeclined(agentId) {
    try {
      const r = await fetch('/api/memory/declined?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.declined) ? j.declined : [];
    } catch (e) { return []; }
  }
  const memoryRestore = o => memoryMutate('declined/restore', o);   // undo a discard — remove one entry from the reject-list
  // High-stakes proposals still awaiting a verdict, across ALL runs (the durable queue). Unattended runs reflect
  // now, so a credential/PII/standing-instruction belief can be raised by a routine at 3am with nobody watching —
  // this is how it stays answerable instead of quietly evaporating. [] on any failure (never a fabricated deck).
  async function memoryPending(agentId) {
    try {
      const r = await fetch('/api/memory/pending?agent=' + encodeURIComponent(agentId || 'agent'), { cache: 'no-store' });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.pending) ? j.pending : [];
    } catch (e) { return []; }
  }

  /* Minimal JSON client for the sidecar's /api surface (the launch-token rides via the hardened
     window.fetch above). Two shapes, matching the two call-site idioms this codebase already uses:
       get(path)        -> resolves the parsed JSON; THROWS Error('http <status>') on a non-2xx.
                           Callers keep their own .catch — silence stays an explicit .catch(() => …).
       post(path, body) -> resolves { ok, status, j } where j is the parsed body EVEN on a non-2xx
       del(path)           (the sidecar's {error} envelope), so callers can surface j.error; rejects
                           only on network failure or a non-JSON body. body defaults to {}.
     Streaming responses (/api/run, /api/cron/run) and Response-shape consumers must NOT use this. */
  const api = {
    get: path => fetch(path, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }),
    post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body == null ? {} : body) })
      .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j }))),
    del: path => fetch(path, { method: 'DELETE' })
      .then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j })))
  };

  // ONE fold point for context occupancy: every agent.cost on the bus — chat-stream re-emits AND
  // routed/scheduled/channel runs arriving over the world SSE bridge — updates the gauge. util.js
  // (U.bus) loads before this file; the chat reader keeps a direct-fold fallback for busless embeds.
  if (typeof U !== 'undefined' && U.bus) {
    try { U.bus.on('agent.cost', foldContextCost); } catch (_) {}
    // …and ONE release point: when the run ends its reading stops being "in flight" (see endContextRun).
    try { U.bus.on('agent.run.end', endContextRun); } catch (_) {}
    try { U.bus.on('agent.run.error', endContextRun); } catch (_) {}
  }

  /* IS THE LOCAL ENGINE ACTUALLY UP? (2026-07-29 — the "Can't reach StarNet's local service" misdiagnosis.)
     A dead response stream and a dead sidecar are INDISTINGUISHABLE from the thrown fetch error alone (see the
     long note on isTransportLoss in friendlyerror.js), and the app used to assert the sidecar was gone and tell
     people to restart — sending users chasing a phantom for days when the real drop was the model's stream.
     This is the measurement that turns that guess into proof.

     GET /api/health is the right probe and the only one that works here: it is in apiauth's TOKEN_EXEMPT set, so
     it needs no X-StarNet-Token (a stale-token 403 would otherwise read as "dead" — a second lie), and its
     handler is a bare writeHead(200)/end('ok') that touches no store, so it cannot itself fail for load reasons.
     Bounded by an AbortController, because a socket the sidecar accepted and never answered (the exact
     hung-request bug this fix exists for) would otherwise hang the error row forever. On timeout we return
     `null`, NOT false — an unanswered probe has not proven the engine dead, and under truthful telemetry an
     inconclusive measurement must never be reported as a conclusive one.

     THE 4s BUDGET IS MEASURED, NOT GUESSED (2026-07-29, Chromium/WebView2, dead loopback port, n=13). A REFUSED
     connection does NOT fail in microseconds as you would expect — it is BIMODAL: ~250ms or ~1750-2015ms
     (Chromium appears to retry a dead keep-alive socket with a ~2s backoff before surfacing "Failed to fetch").
     Samples: 249,250,251,251,268,1754,1771,1773,1794,2015 + 251,1778,2030. A 2000ms budget therefore lands
     exactly ON the slow mode and half of all genuinely-dead engines time out into `null` — which is the ONE case
     where "restart StarNet" is the correct advice, so it must not be lost to an impatient probe. 4000ms clears
     the observed tail ~2x. Cost is bounded and rare: the common in-band failure path proves liveness by receipt
     and never calls this at all, and a healthy engine answers /api/health in ~1ms.
     Resolves true | false | null. Never throws, never rejects. */
  function pingEngine(timeoutMs) {
    const budget = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 4000;
    let ac = null, timer = null;
    try { ac = new AbortController(); } catch (_) { ac = null; }
    let timedOut = false;
    if (ac) timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (_) {} }, budget);
    const done = (v) => { if (timer) clearTimeout(timer); return v; };
    let p;
    try {
      p = fetch('/api/health', Object.assign({ cache: 'no-store' }, ac ? { signal: ac.signal } : {}));
    } catch (_) { return Promise.resolve(done(false)); }   // synchronous throw = no request left the page
    return Promise.resolve(p)
      // Any ANSWER at all proves something is listening and serving on the port — even a non-2xx. The claim
      // under test is "can't REACH the local service", so reachability, not the status code, is the verdict.
      .then(() => done(true))
      .catch(() => done(timedOut ? null : false));
  }

  // Durable interrupted-run recovery. Listing is read-only; preparation is accepted only when the sidecar's
  // journal proves there is no uncertain dispatched mutation. The returned token is one-shot and consumed by
  // the ordinary /api/run path, so recovery does not create a privileged second execution route.
  async function runRecoveries() {
    const r = await fetch('/api/run-recoveries?limit=100', { cache: 'no-store' });
    if (!r.ok) throw new Error('recovery list unavailable');
    const j = await r.json();
    return Array.isArray(j && j.recoveries) ? j.recoveries : [];
  }
  async function prepareAutomaticRecovery(row) {
    row = row || {};
    const continuationId = row.continuation && row.continuation.state === 'ready'
      ? String(row.continuation.continuationId || '')
      : ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('auto-' + Date.now()));
    const r = await fetch('/api/run-recoveries/continue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: String(row.runId || ''), agentId: String(row.agentId || ''),
        recoveryToken: String(row.recoveryToken || ''), continuationId, mode: 'automatic'
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.continuationToken) throw new Error(String(j.error || 'automatic recovery could not be prepared'));
    return {
      sourceRunId: String(row.runId || ''), continuationId,
      continuationToken: String(j.continuationToken)
    };
  }
  async function resolveRunRecovery(row, outcomes) {
    row = row || {};
    const resolutionId = 'review-ui-' + String(row.runId || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 80);
    const r = await fetch('/api/run-recoveries/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: String(row.runId || ''), agentId: String(row.agentId || ''),
        recoveryToken: String(row.recoveryToken || ''), resolutionId,
        confirmedNoReplay: true, outcomes: Array.isArray(outcomes) ? outcomes : []
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.recovery) throw new Error(String(j.error || 'recovery decision could not be saved'));
    return j.recovery;
  }
  async function prepareReviewedRecovery(row) {
    row = row || {};
    const continuationId = row.continuation && row.continuation.state === 'ready'
      ? String(row.continuation.continuationId || '')
      : ('review-continue-' + String(row.runId || '').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 70));
    const r = await fetch('/api/run-recoveries/continue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: String(row.runId || ''), agentId: String(row.agentId || ''),
        recoveryToken: String(row.recoveryToken || ''), continuationId,
        confirmedSafeContinuation: true, mode: 'reviewed'
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.continuationToken) throw new Error(String(j.error || 'reviewed recovery could not be prepared'));
    return { sourceRunId: String(row.runId || ''), continuationId, continuationToken: String(j.continuationToken) };
  }

  return {
    pingEngine,
    isDesktop: () => DESKTOP,   // lets the UI tell a desktop keychain-store failure (token saved locally) from a browser no-op
    getKey, setKey, setKeyPool, validateAndSetKeyPool, keyPoolSize, storeChannelToken, getModel, setModel, getProv, setProv, getBaseUrl, setBaseUrl, getReasoningEffort, setReasoningEffort, normalizeReasoningEffort, init, configured, refreshCreditsConfigured, hasStoredCredential, setDesktopConfigured,
    listModels, probeProvider, validateAndSetKey, priceOf, contextLimitOf, contextState, chat, cancel, haltAll, consent, consentAck, consentAnswer, summonAck, notebook,
    runRecoveries, prepareAutomaticRecovery, resolveRunRecovery, prepareReviewedRecovery,
    memoryProposals, memoryTurnin, memoryVeto, memoryReset, memoryRecords, memoryDeclined, memoryRestore, memoryPending, memoryPin, memoryEdit, memoryForget,
    studyProposals,
    threadProposals, threadTurnin,
    agentSkills, agentSkillsRead, agentSkillManage, agentSkillAllow,
    skillExchangeInspect, skillExchangeRegistry, skillExchangeDiscover, skillExchangeRegistries, skillExchangeImport, skillExchangeInstall, skillExchangeCheck,
    skillExchangeExport, skillExchangePublishHandoff, skillExchangeGenerations, skillExchangeRollback,
    api,
    apiToken: ensureApiToken,
    apiFetch: (u, init) => ensureApiToken().then(t => fetch(u, withApiToken(init, t))),
    totals: () => totals,
    setTotals: t => { totals = { tokens: t.tokens || 0, cost: t.cost || 0, calls: t.calls || 0 }; },
    resetTotals: () => {
      totals = { tokens: 0, cost: 0, calls: 0 }; contextByKey = {}; runModels = {}; runConv = {};
      overheadByModel = Object.create(null);
      try { localStorage.removeItem(LS_OVERHEAD); } catch (_) {}   // a wipe must clear the persisted calibration too
    }
  };
})();
