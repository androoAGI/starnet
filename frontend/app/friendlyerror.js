/* STARNET — friendlyerror.js : turn a raw failure into something a beginner can act on.
   Pure + testable (UMD: a `Friendly` global in the browser, module.exports under node).

   The COMMS panel used to surface raw plumbing on a failed turn — "sidecar HTTP 500", an OpenRouter
   payload, a capdenied string — and the ↻ retry chip fired blindly regardless of WHY it failed. This
   maps any error (the thrown Error from Harness.chat + an optional HTTP status) to:

     friendlyError(err, status, opts) -> { userMessage, kind, retryable, action, raw, engineAlive }

   • userMessage — one plain-language sentence to LEAD the error row with.
   • kind        — a stable class (mirrors the sidecar classifier's reasons, plus the UI-level
                   `network` / `capdenied` / `user_abort` cases the browser sees but the API layer doesn't).
   • retryable   — whether a plain "↻ Try again" makes sense.
   • action      — null | 'settings' | 'skills' | 'store' | 'refit' | 'reload': a context-aware DESTINATION
                   instead of a blind retry. capdenied's true unlock is REFIT (place the gear) —
                   NOT the SKILLS list — because a station quest, minted on the denial, completes
                   by PLACEMENT (stationqueststore.js). auth/no-key opens the PROVIDERS key field.
   • cap         — (capdenied only) the resolved capability id ('web'|'cabinet'|…) parsed from the
                   raw 'no <need> — …' message, so copy can name WHICH power was missing + its gear.
   • raw         — the original technical text, kept for a de-emphasized sub-line / title tooltip.

   RENDERING THE ACTION (the door): `actionButton(verdict)` maps a verdict to { label, run } — a
   ready-to-wire button that OPENS the exact surface (Build.open() for REFIT, the settings PROVIDERS
   section for keys, StationUI SKILLS for a skill toggle). The consumer (chat.js offerRetry) calls
   it instead of re-deriving the label/route per action, so a new action door is added in ONE place.

   INTEGRATION (not duplication): when the sidecar classifier module is reachable (node/tests), we delegate
   to classifyApiError() to derive the reason, then translate that reason into a beginner-facing message —
   so the truth table stays single-sourced. In the browser the sidecar module isn't loaded, so we fall back
   to a lightweight pattern-match over the SAME kind vocabulary on the UI-level error strings Harness throws
   ('sidecar HTTP <status>', 'cannot reach the STARNET sidecar…', a forwarded 'no <cap> — …'). */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.Friendly = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // optional: the sidecar's pure API-error classifier (node/test only). Never required in the browser.
  let classifyApiError = null;
  try { if (typeof require === 'function') classifyApiError = require('../../sidecar/providers/errorClass.js').classifyApiError; } catch (_) {}

  // The capability a `no <need> — …` denial names → the plain power word + the placeable GEAR that grants it.
  // Single-sourced from the sidecar's capsummary CAPS table (id/object) + worldmodel's CAP_LABEL power words, so
  // a beginner reads "needs FILE ACCESS — the CABINET isn't on station" instead of a raw cap token. `compute` is
  // the loop's turn-precondition (the DESK/workstation); the rest are placeable floor gear closed in REFIT.
  const CAP_INFO = {
    compute:      { power: 'a WORKSTATION', gear: 'a DESK',       does: 'run at all' },
    web:          { power: 'WEB ACCESS',    gear: 'a DISH',       does: 'search or fetch the web' },
    cabinet:      { power: 'FILE ACCESS',   gear: 'an INTEL CAB', does: 'read or write files' },
    workbench:    { power: 'a TERMINAL',    gear: 'a WORKBENCH',  does: 'run commands or control the computer' },
    memory:       { power: 'MEMORY',        gear: 'a NOTEBOOK',   does: 'keep long-term memory' },
    studio:       { power: 'IMAGE TOOLS',   gear: 'a STUDIO',     does: 'generate or analyze images' },
    jukebox:      { power: 'SPOTIFY',       gear: 'a JUKEBOX',    does: 'search or control Spotify' },
    orchestrator: { power: 'the LEAD role', gear: 'the ORCHESTRATOR role', does: 'delegate to crew' }
  };
  // aliases the raw message may carry for the same capability (prop objectType ↔ cap id, or a tool family word).
  const CAP_ALIAS = {
    computer: 'compute', desk: 'compute', workstation: 'compute',
    dish: 'web', search: 'web', browser: 'web', fetch: 'web',
    files: 'cabinet', file: 'cabinet', fs: 'cabinet',
    terminal: 'workbench', shell: 'workbench', exec: 'workbench', desktop: 'workbench',
    notebook: 'memory', recall: 'memory',
    images: 'studio', image: 'studio',
    spotify: 'jukebox', music: 'jukebox'
  };

  // kind -> beginner-facing copy + whether a plain retry helps + where to send them instead.
  // action: 'settings' (fix the model key) · 'refit' (place the missing gear) · 'skills' (toggle a skill
  //   family) · 'store' (top up managed credit) · null (just retry / nothing).
  const KINDS = {
    // ONLY for a fault PROVEN local: the raw carries "sidecar http 5xx" (our own service answered 500). A
    // provider's 5xx/overloaded must never land here — a message naming a component owes proof it is at fault,
    // and blaming the local service for an Anthropic/OpenRouter overload had users reporting "StarNet's servers
    // are down" during every industry load spike (2026-07-30, the report wave behind this split).
    server_error:  { retryable: true,  action: null,       msg: 'The local StarNet service hit an error — give it a moment and try again.' },
    // The PROVIDER's servers answered with an error/overload (5xx, "overloaded", "temporarily unavailable").
    // StarNet is healthy and says so; retry is the primary door because provider load spikes pass.
    provider_server_error: { retryable: true, action: null, msg: "The AI provider's servers are having trouble right now (overloaded or erroring) — StarNet itself is fine. Wait a moment and try again; if it keeps failing, switch model or provider in COMMS." },
    network:       { retryable: true,  action: null,       msg: "Can't reach StarNet's local service — if the app closed, restart it; if it restarted, reload this window, then try again." },
    rate_limit:    { retryable: true,  action: null,       msg: 'The model provider is busy (too many requests) — wait a few seconds and try again.' },
    // The sidecar is fine; its call OUT to the model provider failed (see isUpstreamFetchFailure). Say that, and
    // say StarNet is healthy — the failure mode this replaces had users restarting and reinstalling for days over
    // a message that named the wrong component. `action: null` on purpose: a provider blip is usually transient,
    // so RETRY must stay the primary chip rather than a SETTINGS door that fixes nothing.
    provider_unreachable: { retryable: true, action: null, msg: "StarNet is running fine, but it couldn't reach the AI provider — that's usually your internet connection, a VPN or proxy, or the provider having a moment. Try again; if it keeps failing, switch provider or model in SETTINGS." },
    provider_unresponsive: { retryable: false, action: 'settings', msg: "The AI provider accepted the request but never started replying — it may be out of usage or unavailable. Switch model/provider under SETTINGS → PROVIDERS." },
    /* A SPENT ALLOWANCE is not a busy moment. A ChatGPT-subscription weekly quota resets in DAYS, so offering
       "wait a few seconds and try again" made every retry doomed and told the user nothing they could act on.
       The copy names the meter that was actually spent — the ChatGPT subscription, NOT API billing — and the
       door is PROVIDERS, where a different key or provider can pick the work up now. retryable:false, so the
       row offers no ↻ Try again. */
    quota_exhausted: { retryable: false, action: 'settings', msg: "This provider's plan allowance is used up — it resets on the provider's own schedule (a ChatGPT subscription resets weekly, not in seconds). To keep working now, switch to another provider or key under SETTINGS → PROVIDERS." },
    // auth: the pure message is context-blind (classify time can't know if ChatGPT is already connected). It names the
    // one honest next step; the action BUTTON (actionButton) tailors the door — "add a key" vs "sign in with ChatGPT".
    auth:          { retryable: false, action: 'settings', msg: 'No model is connected yet — add a provider key (or sign in with ChatGPT) to let it run.' },
    oauth:         { retryable: false, action: 'settings', msg: 'Your ChatGPT sign-in expired — reconnect it (or add a provider key instead).' },
    // xAI can 403-allowlist the Grok OAuth device flow off for an account — signing in is a dead-end there, so
    // point the user at the xAI (API KEY) provider instead of a doomed reconnect. Door is the PROVIDERS key field.
    grok_oauth_unavailable: { retryable: false, action: 'settings', msg: "Grok sign-in isn't available on this account yet — xAI hasn't opened the Grok sign-in for it. Add an xAI provider key instead (paste it under SETTINGS → PROVIDERS and pick the XAI provider)." },
    billing:       { retryable: false, action: 'settings', msg: "Your provider account is out of credit — top it up, then try again." },
    // managed StarNet credits ran out (only reachable when a managed-credit backend is wired). Point at the STORE
    // to top up; a BYOK station never hits this kind (it gets `billing`/`auth` instead).
    // copy names the SAME door the button opens (PROVIDERS) — "the STORE" was a surface that doesn't exist as a button.
    managed_credit:{ retryable: false, action: 'store',    msg: "You're out of StarNet credits — top up under SETTINGS → PROVIDERS, or connect your own provider key." },
    // capdenied copy is REBUILT per-error in friendlyError() to name the exact power + gear; this is the fallback
    // when the capability can't be parsed. The door is REFIT (place the gear), NOT the SKILLS list.
    capdenied:     { retryable: false, action: 'refit',    msg: "This task needed a tool this agent doesn't have on station yet — open REFIT to place the gear it's missing." },
    timeout:       { retryable: true,  action: null,       msg: 'That took too long and timed out — try again.' },
    user_abort:    { retryable: false, action: null,       msg: 'Stopped.' },
    context_overflow: { retryable: false, action: null,    msg: 'This conversation got too long for the model — start a fresh chat or shorten it.' },
    model_not_found:  { retryable: false, action: 'settings', msg: "That model isn't available — pick a different one from the model dock in COMMS." },
    content_policy_blocked: { retryable: false, action: null, msg: 'The model declined that request on safety grounds — try rephrasing it.' },
    // JUKEBOX is placed (the Spotify tools ARE granted) but Spotify's OAuth session isn't connected yet — the
    // real second half of the unlock chain. The door is TOOLSETS (its JUKEBOX row carries ▶ CONNECT SPOTIFY —
    // Settings has NO spotify surface; the old 'settings' door landed on PROVIDERS with no connect control),
    // NOT REFIT (the gear is already on station) — distinct from `capdenied` which fires when no JUKEBOX exists.
    spotify_not_connected: { retryable: false, action: 'toolsets', msg: 'The JUKEBOX is on station, but Spotify isn’t connected yet — connect it in ABILITIES, then try again.' },
    // the one-run-at-a-time mutex: the SIDECAR message names the holder (age/source) + recovery steps.
    // Keep those details instead of flattening to `unknown` (2026-07-07 escape:
    // the user got "Something went wrong" in a loop while the real answer was one sentence away).
    agent_busy:    { retryable: true,  action: null,       msg: 'That agent is still busy with a previous run — wait for it to finish, or open its conversation and stop the active run.' },
    // the SIDECAR's own token gate said no (a 403 with "forbidden token/origin/host"): after a sidecar
    // crash+respawn the page still holds the OLD X-StarNet-Token, so EVERY action 403s. Retrying is doomed and
    // "add a key" is the wrong door — the page needs the fresh boot token, which only a reload fetches.
    stale_session: { retryable: false, action: 'reload',   msg: 'The station restarted — reload this page to reconnect.' },
    unknown:       { retryable: true,  action: null,       msg: 'Something went wrong on that turn — try again.' }
  };

  // the sidecar classifier speaks in `reason`s; map each onto our UI kind. Its whole domain is the PROVIDER
  // API call (sidecar/providers/errorClass.js) — so its `server_error`/`overloaded` are the provider's fault
  // by construction and map to provider_server_error, never to the local-service copy.
  const REASON_TO_KIND = {
    auth: 'auth', billing: 'billing', rate_limit: 'rate_limit', quota_exhausted: 'quota_exhausted', overloaded: 'provider_server_error',
    server_error: 'provider_server_error', timeout: 'timeout', context_overflow: 'context_overflow',
    model_not_found: 'model_not_found', content_policy_blocked: 'content_policy_blocked',
    format_error: 'unknown', unknown: 'unknown'
  };

  function rawText(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    return String((err && err.message) || err);
  }
  // Browser fetch implementations do not agree on the message used when an established response stream dies.
  // Chromium commonly reports "Failed to fetch"; undici/Tauri can surface only "terminated", a socket close,
  // or ECONNRESET. They all mean ONE thing: the response stream died before it finished.
  //
  // ⚠ WHAT THEY DO **NOT** TELL YOU IS *WHERE* IT DIED (2026-07-29). This predicate used to be documented as
  // "COMMS lost its local sidecar transport" and the copy asserted "Can't reach StarNet's local service —
  // restart the app". That is an UNPROVEN claim, and it is wrong in at least two common cases:
  //   • the MODEL PROVIDER's stream drops mid-answer (undici surfaces exactly `terminated` /
  //     `other side closed` / `premature close` / ECONNRESET) — the sidecar is perfectly healthy;
  //   • a request the sidecar never answered (a throw above index.js's central route guard is only LOGGED by
  //     surfaceProcessError, so the socket hangs — see the same note in sidecar/openai-compat.js) — again, alive.
  // In both, the app told the user to restart/reinstall and they burned days on a phantom. Truthful telemetry:
  // the transport wording is now chosen by PROOF (opts.engineAlive, from a real /api/health probe), never by
  // assumption. Keep this predicate about the SHAPE of the failure; let the caller establish the LOCATION.
  function isTransportLoss(raw) {
    return /cannot reach|can'?t reach|unreachable|failed to fetch|fetch failed|networkerror|load failed|connection (?:refused|reset)|disconnected|\bterminated\b|socket (?:hang up|closed)|other side closed|premature close|econnreset|epipe/i.test(String(raw || ''));
  }
  /* IS THIS THE SIDECAR'S *OUTBOUND* CALL FAILING? (2026-07-29 — from a real user's diagnostics report.)
     The word order is the tell, and it is decisive. A BROWSER fetch rejection says "Failed to fetch" (Chromium),
     "NetworkError" or "Load failed". NODE/undici says "fetch failed" — the other order. So a raw text carrying
     `fetch failed` cannot have come from this page's fetch to the sidecar; it can only have been produced INSIDE
     the sidecar and forwarded to us, which means the hop that broke is sidecar -> MODEL PROVIDER. Same for the
     Node-only DNS/undici strings (getaddrinfo, ENOTFOUND, EAI_AGAIN, UND_ERR_*), which no browser ever emits.

     This existed as a real user report: diagnostics showed a healthy local engine (uptime, workspace present, the
     report itself was served by it) with five `fetch failed` entries — the sidecar could not reach chatgpt.com /
     api.openai.com — and the app told them "Can't reach StarNet's local service, restart it". They lost a day.

     WHY THE BUG SURVIVED: sidecar/providers/errorClass.js:168 ALREADY classifies undici transport codes
     correctly, but friendlyerror only `require`s it in node/tests — in the browser classifyApiError is null, so
     the real user path fell through to isTransportLoss and blamed the local service. Getting this right in the
     BROWSER fallback ladder is the whole point; a node-only test proves the half users never run. */
  function isUpstreamFetchFailure(raw) {
    const s = String(raw || '');
    // `fetch failed` in THAT order only — "Failed to fetch" (browser) must never match here.
    return /\bfetch failed\b/i.test(s) || /getaddrinfo|ENOTFOUND|EAI_AGAIN|UND_ERR_/i.test(s);
  }

  // The three HONEST readings of a transport loss, keyed on whether the local engine was actually PROVEN to be
  // up. `engineAlive` comes from a token-free GET /api/health probe (Harness.pingEngine) — true/false are
  // measured; null/undefined means nobody probed, so we must not name a culprit at all.
  //   false → the engine really is unreachable: today's copy, now EARNED.
  //   true  → the engine answered, so "restart StarNet" is actively bad advice; name the stream instead.
  //   null  → unproven. Say only what happened, prescribe the cheap step, and do NOT blame a component.
  function transportMessage(engineAlive) {
    if (engineAlive === false) return KINDS.network.msg;
    if (engineAlive === true) {
      return "The reply stream stopped before it finished — StarNet's local service answered a health check, so "
        + 'the app itself is running; this was the connection carrying the reply. Try again.';
    }
    return 'The connection dropped before the reply finished — try again. If it keeps happening, use "copy '
      + 'diagnostics for a bug report" below so the cause can be identified.';
  }
  // a user-initiated stop (Esc / Stop button → AbortController) reads as an AbortError or an "abort" message.
  // A user abort is NOT a fault — it must not produce a scary error row.
  function isUserAbort(err) {
    if (!err || typeof err === 'string') return /\babort/i.test(String(err || ''));
    return err.name === 'AbortError' || /\babort/i.test(String(err.message || ''));
  }

  // Parse WHICH capability a capdenied names, from the raw error text. The sidecar/harness build the message as
  //   'no <need> — <reason>'   (need ∈ compute|web|cabinet|workbench|memory|studio|jukebox), OR
  //   'capability denied: no capability for <tool> in room <room>'  (a tool-level denial, cap unknown up front).
  // Returns a CAP_INFO key or null. Never throws.
  function capFromRaw(raw) {
    const low = String(raw || '').toLowerCase();
    // preferred shape: "no <need> — …" — pull the word between "no " and the em/en dash or hyphen separator.
    let m = low.match(/\bno\s+([a-z_]+)\s*[—–-]/);
    let word = m ? m[1] : null;
    if (!word) { m = low.match(/\bno\s+([a-z_]+)\s+capability\b/); word = m ? m[1] : null; }
    if (word) {
      if (CAP_INFO[word]) return word;
      if (CAP_ALIAS[word]) return CAP_ALIAS[word];
    }
    // fall back to any capability/alias token appearing anywhere in the message (e.g. the tool-level denial text).
    for (const k of Object.keys(CAP_INFO)) { if (new RegExp('\\b' + k + '\\b').test(low)) return k; }
    for (const a of Object.keys(CAP_ALIAS)) { if (new RegExp('\\b' + a + '\\b').test(low)) return CAP_ALIAS[a]; }
    return null;
  }

  // Build the beginner capdenied sentence naming the exact power + its gear, e.g.
  //   "This task needs FILE ACCESS — an INTEL CAB isn't on station. Open REFIT to place it."
  // Falls back to the generic KINDS.capdenied copy when the capability can't be parsed.
  function capdeniedMessage(cap) {
    const info = cap && CAP_INFO[cap];
    if (!info) return KINDS.capdenied.msg;
    return 'This task needs ' + info.power + ' — ' + info.gear + " isn't on station. Open REFIT to place it and try again.";
  }

  // browser fallback: classify the UI-level error string + optional HTTP status into a kind, using the SAME
  // vocabulary the sidecar reasons map onto. Order: most-specific intent first.
  /* Kept in step with the same three patterns in sidecar/providers/errorClass.js. A spent SUBSCRIPTION
     allowance ("you've hit your usage limit", "resets in 3 days", a weekly/monthly quota) is terminal; a
     PER-MINUTE limit is not, and Gemini phrases one as "Quota exceeded for quota metric", which a bare
     /quota/ test swallowed. OpenAI's `insufficient_quota` is an empty wallet and stays billing. */
  const QUOTA_EXHAUSTED_RE = /usage[_ ]?limit(?:[_ ]?(?:has|is)(?:[_ ]?been)?)?[_ ]?reached|hit (?:your|the) (?:usage|weekly|monthly|plan|daily) limit|(?:weekly|monthly|daily) (?:quota|limit)|resets? in \s*\d+\s*(?:day|hour|week)|resets? (?:on|at) \d|quota (?:will )?reset(?:s)? (?:in|on|at)/;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|rpm|tpm|requests per/;
  const TERMINAL_BILLING_RE = /insufficient[_ ]?quota|exceeded your current quota|out of credit|add credits|payment required/;

  function kindFromRaw(raw, status) {
    const low = String(raw || '').toLowerCase();
    if (/did not start streaming|first-byte timeout|no response bytes/.test(low)) return 'provider_unresponsive';
    // Harness pre-flight guards ("no API key set" / "no model selected"): a misconfig, not a fault — point at
    // Settings instead of offering a doomed retry. (Match before capdenied, which the em-dash-less strings miss.)
    if (/chatgpt.*sign-?in|sign-?in.*chatgpt|not signed in to chatgpt|codex_not_connected|codex auth|codex_auth|chatgpt subscription.*connect/.test(low)) return 'oauth';
    if (/no api key set|no model selected|missing key\/model/.test(low)) return 'auth';
    // a forwarded capability denial ("no web — …" / "capdenied")
    if (/\bcapdenied\b/.test(low) || /^no\s+\w+\s+—/.test(low) || /needs a capability|capability.*(off|denied)/.test(low)) return 'capdenied';
    // MUST precede isTransportLoss: that predicate also matches `fetch failed`, and whichever runs first owns the
    // verdict. Upstream is the more specific (and provable) reading, so it wins.
    if (isUpstreamFetchFailure(low)) return 'provider_unreachable';
    // the sidecar is unreachable (fetch threw — Harness throws "cannot reach the STARNET sidecar…")
    if (isTransportLoss(low)) return 'network';
    // content / policy beats a status
    if (/content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // HTTP status from "sidecar HTTP <status>" or an explicit status arg
    const s = status || (low.match(/\b(?:http|status)\s+(\d{3})\b/) ? Number(RegExp.$1) : null);
    if (s) {
      // OUR OWN sidecar's token gate (crash+respawn → stale X-StarNet-Token): a "sidecar HTTP 403" throw or a
      // "forbidden token/origin/host" body means reload for the fresh boot token — never the provider-key door.
      if (s === 403 && (/sidecar http/.test(low) || /\bforbidden\b/.test(low))) return 'stale_session';
      if (s === 401 || s === 403) return 'auth';
      if (s === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (s === 404) return 'model_not_found';
      if (s === 408 || s === 504) return 'timeout';
      /* A 429 IS NOT ALWAYS "wait a few seconds". This fallback is the path REAL USERS take: classifyApiError
         above is require()-only (node/test), so in the browser every verdict comes from here. A
         ChatGPT-subscription weekly quota resets in DAYS, and an OpenAI account with no money answers
         `insufficient_quota` with 429 — neither clears by waiting, and offering ↻ Try again on either is a
         doomed instruction. Mirrors the same split in sidecar/providers/errorClass.js; keep the two in step. */
      if (s === 429) {
        if (QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low)) return 'quota_exhausted';
        if (TERMINAL_BILLING_RE.test(low)) return 'billing';
        return 'rate_limit';
      }
      /* 5xx: WHO answered it decides the copy, and the BODY outranks the prefix. In-band adapter labels name
         the provider ("Anthropic http 529 - Overloaded"); a pre-stream route failure says "sidecar HTTP 5xx —
         <detail>" but that detail can be a PROXIED provider body, so the prefix alone proves nothing. Evidence
         order: provider phrasing/name in the body → provider; a "sidecar http" prefix with neither → local
         (the one case where our own route demonstrably answered the 5xx); anything else → provider, because
         this ladder runs on the model-call path and "the local service broke" is the claim that owes proof. */
      if (s >= 500) {
        if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'provider_server_error';
        if (/\b(anthropic|openai|openrouter|google|gemini|grok|xai|kimi|codex|deepseek|mistral|groq|ollama)\b/.test(low)) return 'provider_server_error';
        return /sidecar http/.test(low) ? 'server_error' : 'provider_server_error';
      }
      if (s === 400 || s === 413 || s === 422) return /context length|maximum context|context window|too many tokens|reduce the length/.test(low) ? 'context_overflow' : 'unknown';
    }
    // message patterns (no status / in-band error text)
    // in-band provider overload phrasing, mirrored from sidecar/providers/errorClass.js — keep the two in step
    if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'provider_server_error';
    if (QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low)) return 'quota_exhausted';
    if (/rate limit|too many requests|rate-limit/.test(low)) return 'rate_limit';
    if (/insufficient|out of credit|not enough credit|quota|payment required|add credits|billing/.test(low)) return 'billing';
    if (/unauthorized|invalid api key|invalid key|no auth credentials|authentication|key was rejected|rejected/.test(low)) return 'auth';
    if (/no endpoints|model not found|not a valid model|unknown model/.test(low)) return 'model_not_found';
    if (/timed out|timeout/.test(low)) return 'timeout';
    if (/context length|maximum context|context window|too many tokens/.test(low)) return 'context_overflow';
    return 'unknown';
  }

  /* err: the thrown Error / in-band error string from Harness.chat. status: an optional HTTP status if the
     caller has it separately. opts.engineAlive: MEASURED local-engine liveness (true/false), or omitted when
     the caller did not probe — it only ever changes the `network` (transport-loss) wording, never the kind, so
     every existing consumer keeps its behavior. Returns a complete, well-typed verdict — never throws. */
  function friendlyError(err, status, opts) {
    const engineAlive = (opts && typeof opts.engineAlive === 'boolean') ? opts.engineAlive : null;
    const raw = rawText(err);
    if (isUserAbort(err)) {
      const k = KINDS.user_abort;
      return { userMessage: k.msg, kind: 'user_abort', retryable: k.retryable, action: k.action, raw: raw };
    }
    let kind = null;
    // Managed-credit exhaustion (only emitted when a credits backend is wired) — a UI-level fault the sidecar
    // classifier doesn't model. Catch it before everything else so the CTA points at the STORE, not blind retry.
    if (/managed credit|add credits in the store|out of managed credit/.test(raw.toLowerCase())) {
      kind = 'managed_credit';
    } else
    // xAI's Grok OAuth device flow can be 403-allowlisted off for an account: the backend says the OAuth surface
    // is unavailable/forbidden. That's a dead-end for RECONNECT, so route to the xAI (API KEY) provider instead.
    if (/\bgrok\b/.test(raw.toLowerCase()) && /allowlist|not allowed|not enabled|not available|unavailable|access forbidden|\bforbidden\b|\b403\b/.test(raw.toLowerCase())) {
      kind = 'grok_oauth_unavailable';
    } else
    // grok/kimi keyless sign-ins are a reconnect case (same class as codex): not-connected, auth-error, or a
    // dead refresh token. The action BUTTON tailors the door per provider (RECONNECT GROK / RECONNECT KIMI).
    if (/\b(grok|kimi)[_ -]?(not[_ -]?connected|auth[_ -]?error|auth\b|token[_ -]?refresh|refresh[_ -]?token|relogin|reconnect)/.test(raw.toLowerCase())
        || /(grok|kimi).*(sign[- ]?in|not signed in|not connected|expired|sign in again)/.test(raw.toLowerCase())
        || /sign[- ]?in.*(grok|kimi)/.test(raw.toLowerCase())
        // mid-run token death: the provider adapter now labels HTTP failures with the provider name
        // ("Grok (xAI) http 401 - …", "Kimi For Coding http 401 - …"). An auth-status failure on a keyless
        // subscription sign-in is a RECONNECT case, never a key-field case. (grok+403 never reaches here —
        // grok_oauth_unavailable above catches it first, by design.)
        || /(grok|kimi).*http 40[13]/.test(raw.toLowerCase())) {
      kind = 'oauth';
    } else
    // Harness pre-flight misconfig ("no API key set" / "no model selected") is UI-level — catch before delegating
    // (the sidecar classifier never sees these) so both paths point at Settings, not a blind retry.
    // `sign[- ]?in` (space allowed): the sidecar's dead-refresh-token errors say "Sign in with ChatGPT again"
    // — the old `sign-?in` missed the space and the consumed-token escape fell through to a generic door.
    if (/chatgpt.*sign[- ]?in|sign[- ]?in.*chatgpt|not signed in to chatgpt|codex_not_connected|codex auth|codex_auth|codex (token )?refresh|refresh_token_reused|chatgpt subscription.*connect/.test(raw.toLowerCase())) {
      kind = 'oauth';
    } else if (/no api key set|no model selected|missing key\/model/.test(raw.toLowerCase())) {
      kind = 'auth';
    } else if (/spotify is not connected|spotify.*not connected|connect (it in settings|it in toolsets|spotify)|spotify session expired|spotify auth failed/.test(raw.toLowerCase())) {
      // the JUKEBOX is placed but Spotify's OAuth isn't linked (or its session died) — every flavor gets the
      // TOOLSETS door: the JUKEBOX row there is the only surface with a connect/reconnect control.
      kind = 'spotify_not_connected';
    } else if (/\bcapdenied\b/.test(raw.toLowerCase()) || /^no\s+\w+\s+—/.test(raw.toLowerCase()) || /needs a capability/.test(raw.toLowerCase())) {
      // a capability denial is UI-level (the sidecar classifier doesn't model it) — catch it before delegating.
      kind = 'capdenied';
    } else if (/already running a task/.test(raw.toLowerCase())) {
      // the per-agent run mutex — UI-level, and the sidecar message already names the holder + doors.
      kind = 'agent_busy';
    } else if (/sidecar http 403\b/.test(raw.toLowerCase()) || (status === 403 && /\bforbidden\b/.test(raw.toLowerCase()))) {
      // OUR OWN sidecar's token gate said no (stale X-StarNet-Token after a crash+respawn) — UI-level, caught
      // BEFORE delegating: the sidecar API classifier would read a bare 403 as provider `auth` and the error row
      // would offer "🔑 Add a key", the wrong door (EL-11 FIX 2). The only fix is the fresh boot token → reload.
      kind = 'stale_session';
    } else if (classifyApiError) {
      // delegate to the single-sourced truth table; synthesize the err shape it expects (status + message).
      try {
        const probe = (err && typeof err === 'object') ? err : new Error(raw);
        if (status != null && probe.status == null) { try { probe.status = status; } catch (_) {} }
        const verdict = classifyApiError(probe, {});
        kind = REASON_TO_KIND[verdict.reason] || 'unknown';
        // a bare network failure ("cannot reach the sidecar") classifies as `unknown` upstream (it never reached
        // the API) — promote it to the friendlier `network` bucket so the message points at the sidecar.
        if (kind === 'unknown' && isTransportLoss(raw)) kind = 'network';
        // Same precedence as the browser ladder above. The node classifier calls an undici transport code
        // `timeout`, which is honest about the SHAPE but silent about the HOP — "the provider timed out" and "your
        // machine can't reach the provider" need different words, and only the latter should mention VPN/proxy.
        if ((kind === 'unknown' || kind === 'network' || kind === 'timeout') && isUpstreamFetchFailure(raw)) kind = 'provider_unreachable';
        // The node classifier's domain is the provider API, so its server_error/overloaded map to
        // provider_server_error — but a GENUINE local fault ("sidecar HTTP 500 — internal error", no provider
        // evidence in the body) also reaches it via the probe. Apply the same evidence rule as the browser
        // ladder: a sidecar-prefixed 5xx with no provider name/phrasing in the body is the local service's own.
        if (kind === 'provider_server_error' && /sidecar http/.test(raw.toLowerCase())
            && !/overloaded|over capacity|temporarily unavailable|try again later/.test(raw.toLowerCase())
            && !/\b(anthropic|openai|openrouter|google|gemini|grok|xai|kimi|codex|deepseek|mistral|groq|ollama)\b/.test(raw.toLowerCase())) {
          kind = 'server_error';
        }
      } catch (_) { kind = kindFromRaw(raw, status); }
    } else {
      kind = kindFromRaw(raw, status);
    }
    const k = KINDS[kind] || KINDS.unknown;
    // capdenied: name the exact power + gear parsed from the raw message, and route to REFIT (the true unlock —
    // a station quest minted on this denial completes by PLACEMENT, not a SKILLS toggle).
    if (kind === 'capdenied') {
      const cap = capFromRaw(raw);
      return { userMessage: capdeniedMessage(cap), kind: kind, retryable: k.retryable, action: k.action, cap: cap, raw: raw };
    }
    // agent_busy: the sidecar composed the full truthful sentence (who holds the agent, since when, the doors)
    // — retain those facts, replacing only guidance for the retired global-stop control.
    if (kind === 'agent_busy' && /already running a task/.test(raw.toLowerCase())) {
      const message = raw.replace(/,\s*or press E-STOP\b[^.]*\.?$/i, ', or open its conversation and stop the active run.');
      return { userMessage: message, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // oauth (keyless device-code sign-in) carries WHICH provider it was, so the door reads the right reconnect
    // label (RECONNECT CHATGPT / GROK / KIMI). Codex keeps its exact copy; grok/kimi name themselves.
    if (kind === 'oauth') {
      const low = raw.toLowerCase();
      // loose contains-match (an underscore like "grok_not_connected" is a word char, so \b would miss it).
      const provider = /grok/.test(low) ? 'grok' : /kimi/.test(low) ? 'kimi' : 'codex';
      const nm = provider === 'grok' ? 'Grok' : provider === 'kimi' ? 'Kimi' : null;
      const userMessage = nm ? ('Your ' + nm + ' sign-in expired — reconnect it (or add a provider key instead).') : k.msg;
      return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, provider: provider, raw: raw };
    }
    // transport loss: the ONE kind whose copy names a component, so it is the one kind that owes proof. The
    // measured verdict rides along on `engineAlive` so a diagnostic report can state what was actually probed.
    if (kind === 'network') {
      return { userMessage: transportMessage(engineAlive), kind: kind, retryable: k.retryable, action: k.action, raw: raw, engineAlive: engineAlive };
    }
    return { userMessage: k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
  }

  /* ---- The DOOR: map a verdict to a ready-to-wire action button { label, run }. ONE place owns every
     error→surface route, so the consumer (chat.js offerRetry) never re-derives per-action labels/wiring, and a
     new door is added here alone. Returns null when the verdict has no actionable door (a plain retry / nothing).
     run() is a no-op-safe opener: it feature-detects each global (Build / StationUI / Harness) so it degrades
     quietly if a surface isn't loaded, never throwing. Routing is context-aware where it matters:
       • auth/oauth → if ChatGPT (Codex) is already connected, offer "sign in with ChatGPT"; else the key field.
       • capdenied  → REFIT (Build.open) — place the missing gear the message just named.
       • settings/store → the PROVIDERS section of Settings (openSettingsSection when Lane C ships it; plain
         openTerm('settings') is the safe fallback until then).                                                */
  function codexConnected() {
    try {
      if (typeof Harness === 'undefined') return false;
      if (Harness.hasStoredCredential) return !!Harness.hasStoredCredential('codex');
      if (Harness.getProv) return Harness.getProv() === 'codex';
    } catch (_) {}
    return false;
  }
  // open Settings, landing on a specific section when the host supports it (Lane C's openTerm(key, section)); the
  // bare openTerm('settings') is the graceful fallback so this works today.
  function openSettings(section) {
    if (typeof StationUI === 'undefined') return;
    try {
      if (section && StationUI.openTerm && StationUI.openTerm.length >= 2) { StationUI.openTerm('settings', section); return; }
      if (StationUI.openTerm) StationUI.openTerm('settings');
    } catch (_) { try { if (StationUI.openTerm) StationUI.openTerm('settings'); } catch (_) {} }
  }
  /* connector_required (beginner seam Lane 1, 2026-08-22): the bus event the MCP manager emits alongside its
     "connector X is not connected" throw becomes ONE post-run chip that opens the ABILITIES window ALREADY
     ROUTED at that connector — the CATALOG section with the console search pre-filled, so the card (SIGN IN /
     ADD) is the next click. Same door family as OPEN ABILITIES above (same openTerm, same chip row); the only
     addition is the pre-route. Label: "⇄ CONNECT GMAIL — 2 clicks" — this chip + the card's own button.
     connectorDoor(ev) -> { label, run, connectorId } or null when the event names no connector. */
  function connectorChipLabel(ev) {
    const id = ev && ev.connectorId ? String(ev.connectorId).trim() : '';
    if (!id) return '';
    return '⇄ CONNECT ' + id.replace(/[-_]+/g, ' ').toUpperCase();
  }
  // prefill the ABILITIES console search with the connector name so the catalog card is the thing on screen.
  // The catalog loads async (ccRefresh), so the filter is re-asserted until a card exists (bounded ~3s); the
  // search input itself is what the Commander sees, so an early fill is never wrong, only incomplete.
  function routeConsoleSearch(doc, query, setTimeoutImpl) {
    const st = setTimeoutImpl || (typeof setTimeout === 'function' ? setTimeout : null);
    let tries = 0;
    const apply = () => {
      const list = doc.querySelector('#cc-list');
      const term = list ? (list.closest ? list.closest('.term') : null) : null;
      const input = term ? term.querySelector('.con-search-in') : null;
      if (input) {
        input.value = query;
        try { input.dispatchEvent(new (doc.defaultView || globalThis).Event('input', { bubbles: true })); } catch (_) {}
      }
      const hasCard = !!(list && list.querySelector('.cc-card'));
      if (!hasCard && st && ++tries < 12) st(apply, 250);
      return !!input;
    };
    return apply();
  }
  function connectorDoor(ev) {
    const label = connectorChipLabel(ev);
    if (!label) return null;
    const id = String(ev.connectorId).trim();
    return {
      label: label, connectorId: id, kind: ev.kind || 'mcp',
      run: () => {
        try {
          if (typeof StationUI === 'undefined' || !StationUI.openTerm) return false;
          StationUI.openTerm('connectors', 'catalog');
          if (typeof document !== 'undefined') routeConsoleSearch(document, id);
          return true;
        } catch (_) { return false; }
      }
    };
  }
  function actionButton(verdict) {
    if (!verdict) return null;
    switch (verdict.action) {
      case 'refit':
        return { label: '⚒ Open REFIT', run: () => { try { if (typeof Build !== 'undefined' && Build.open) Build.open(); else if (typeof Build !== 'undefined' && Build.toggle && !(Build.isOpen && Build.isOpen())) Build.toggle(); } catch (_) {} } };
      case 'toolsets':
        // spotify_not_connected: the connect flow lives on the ABILITIES window's JUKEBOX row (setupSpotify) —
        // the only surface with a ▶ CONNECT SPOTIFY control. The action KEY stays 'toolsets' (internal, and the
        // shelf inside is still called TOOLSETS); only the LABEL follows the dock button, which reads ABILITIES.
        return { label: '⇄ OPEN ABILITIES', run: () => { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('connectors'); } catch (_) {} } };
      case 'settings':
        // Grok's OAuth sign-in is 403-allowlisted off for this account — the honest door is the xAI (API KEY)
        // provider, not a doomed reconnect. Lands on the PROVIDERS section where the xAI key row lives.
        if (verdict.kind === 'grok_oauth_unavailable')
          return { label: '▸ USE XAI (API KEY)', run: () => openSettings('providers') };
        // A codex sign-in-class failure (dead/consumed refresh token, not-signed-in) ALWAYS gets the reconnect
        // door — the 2026-07-08 escape was exactly this error landing with only a generic "add a key" path.
        // Settings→PROVIDERS is where the row's ⏼ RE-SIGN-IN action now lives.
        if (verdict.kind === 'oauth') {
          // the door names the specific provider whose sign-in died (all land on the same PROVIDERS section).
          const label = verdict.provider === 'grok' ? '⏼ RECONNECT GROK'
            : verdict.provider === 'kimi' ? '⏼ RECONNECT KIMI'
            : '⏼ RECONNECT CHATGPT';
          return { label: label, run: () => openSettings('providers') };
        }
        // other auth/no-key: if ChatGPT is already the connected brain, the honest door is still "reconnect";
        // otherwise the provider key field. Both land on the same PROVIDERS section.
        if (verdict.kind === 'auth' && codexConnected())
          return { label: '⏼ RECONNECT CHATGPT', run: () => openSettings('providers') };
        if (verdict.kind === 'auth')
          return { label: '＋ Add a key', run: () => openSettings('providers') };
        // model_not_found: the fix is repointing the PRIMARY model, which lives in the COMMS model dock —
        // NOT Settings→MODELS (that section is the fallback chain + class tiers and cannot change the primary;
        // sending users there was a door onto a room without the lever). Fall back to Settings only when the
        // dock isn't mounted (headless/tests).
        if (verdict.kind === 'model_not_found') {
          return { label: '▸ PICK A MODEL', run: () => {
            try { if (typeof ModelDock !== 'undefined' && ModelDock.open) { ModelDock.open(); return; } } catch (_) {}
            openSettings('models');
          } };
        }
        return { label: '⚙ Open Settings', run: () => openSettings('providers') };
      case 'reload':
        // stale_session: the page holds a dead boot token — a reload is the ONE honest reconnect (the token is
        // injected at serve time; there is no in-page re-fetch handshake). Degrades quietly outside a browser.
        return { label: '↻ RELOAD & RECONNECT', run: () => { try { if (typeof location !== 'undefined' && location.reload) location.reload(); } catch (_) {} } };
      case 'store':
        // this door opens the PROVIDERS section (there is no "store") — name it truthfully with a CRT glyph.
        return { label: '▸ OPEN PROVIDERS', run: () => openSettings('providers') };
      case 'skills':
        return { label: '✦ OPEN SKILL LIBRARY', run: () => { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('skills'); } catch (_) {} } };   // 'skills' aliases into ABILITIES ▸ SKILL LIBRARY (NAV CONDENSE 2)
      default:
        return null;
    }
  }

  return { friendlyError, actionButton, connectorDoor, connectorChipLabel, routeConsoleSearch, KINDS, CAP_INFO,
    _internals: { kindFromRaw, isTransportLoss, isUpstreamFetchFailure, isUserAbort, REASON_TO_KIND, capFromRaw, capdeniedMessage, codexConnected, transportMessage } };
});
