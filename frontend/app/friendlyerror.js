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
                   instead of a blind retry. capdenied's true unlock is BUILD MODE (place the gear) —
                   NOT the SKILLS list — because a station quest, minted on the denial, completes
                   by PLACEMENT (stationqueststore.js). auth/no-key opens the PROVIDERS key field.
   • cap         — (capdenied only) the resolved capability id ('web'|'cabinet'|…) parsed from the
                   raw 'no <need> — …' message, so copy can name WHICH power was missing + its gear.
   • raw         — the original technical text, kept for a de-emphasized sub-line / title tooltip.
   • transport   — (network only) true when the error was MARKED at Harness.chat's own transport throw site, i.e.
                   this page's connection provably dropped; false for words that merely read like a drop.

   RENDERING THE ACTION (the door): `actionButton(verdict)` maps a verdict to { label, run } — a
   ready-to-wire button that OPENS the exact surface (Build.open() for BUILD MODE, the settings PROVIDERS
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
  // the loop's turn-precondition (the DESK/workstation); the rest are placeable floor gear closed in BUILD MODE.
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
  //   family) · 'store' (top up managed credit) · 'budget' (SETTINGS › SPENDING LIMITS) · null (just retry / nothing).
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
    /* A SPENT ALLOWANCE is not a busy moment. A ChatGPT-subscription weekly quota resets in DAYS, so offering
       "wait a few seconds and try again" made every retry doomed and told the user nothing they could act on.
       The copy names the meter that was actually spent — the ChatGPT subscription, NOT API billing — and the
       door is PROVIDERS, where a different key or provider can pick the work up now. retryable:false, so the
       row offers no ↻ Try again. */
    quota_exhausted: { retryable: false, action: 'settings', msg: "This provider's plan allowance is used up — it resets on the provider's own schedule (a ChatGPT plan's short window comes back within hours, its weekly one within a week — not in seconds). To keep working now, switch to another provider or key under SETTINGS → AI & MODELS." },
    // auth: the pure message is context-blind (classify time can't know if ChatGPT is already connected). It names the
    // one honest next step; the action BUTTON (actionButton) tailors the door — "add a key" vs "sign in with ChatGPT".
    auth:          { retryable: false, action: 'settings', msg: 'No model is connected yet — add a provider key (or sign in with ChatGPT) to let it run.' },
    claude_cli_checking: { retryable: true, action: null, msg: 'StarNet is checking your local Claude Code sign-in. Try again once the check finishes.' },
    claude_cli_status_unavailable: { retryable: true, action: null, msg: 'StarNet could not check your local Claude Code sign-in. Try again in a moment.' },
    claude_cli_missing: { retryable: false, action: 'settings', msg: 'Claude Code is not installed. Open its card in AI & MODELS to set it up.' },
    claude_cli_signed_out: { retryable: false, action: 'settings', msg: 'Claude Code is not signed in. Open its card in AI & MODELS to sign in.' },
    // a provider is connected but no MODEL is picked: the fix is the model dock, not a key or a sign-in
    no_model:      { retryable: false, action: 'settings', msg: 'No model is picked yet — choose one from the model dock in COMMS, then send again.' },
    oauth:         { retryable: false, action: 'settings', msg: 'Your ChatGPT sign-in expired — reconnect it (or add a provider key instead).' },
    // xAI can 403-allowlist the Grok OAuth device flow off for an account — signing in is a dead-end there, so
    // point the user at the xAI (API KEY) provider instead of a doomed reconnect. Door is the PROVIDERS key field.
    grok_oauth_unavailable: { retryable: false, action: 'settings', msg: "Grok sign-in isn't available on this account yet — xAI hasn't opened the Grok sign-in for it. Add an xAI provider key instead (paste it under SETTINGS → AI & MODELS and pick the XAI provider)." },
    billing:       { retryable: false, action: 'settings', msg: "Your provider account is out of credit — top it up, then try again." },
    // managed StarNet credits ran out (only reachable when a managed-credit backend is wired). Point at the STORE
    // to top up; a BYOK station never hits this kind (it gets `billing`/`auth` instead).
    // copy names the SAME door the button opens (PROVIDERS) — "the STORE" was a surface that doesn't exist as a button.
    managed_credit:{ retryable: false, action: 'store',    msg: "You're out of StarNet credits — top up under SETTINGS → AI & MODELS, or connect your own provider key." },
    // The balance check FAILED (the account service was slow, erroring or unreachable) — the balance is unknown, NOT
    // $0. Reading this as managed_credit told a customer holding $79.24 to top up (2026-10-06). Retry is the door.
    managed_credit_unavailable: { retryable: true, action: null, msg: "StarNet couldn't check your credit balance just now — your credits are safe and nothing was charged. Try again in a moment." },
    // The service reported $0 because THIS station's running StarNet runs hold the balance (each reserves up to its PER
    // RUN limit and refunds what it doesn't spend; budgetcaps.managedRefusalMessage). Waiting is the first fix (retry),
    // then lowering PER RUN so runs can share the balance (the SPENDING LIMITS door); topping up stays the last
    // door — a small wallet's hold may come back as cents. Audit B11.
    managed_credit_held: { retryable: true, action: 'budget', msg: "Your StarNet balance is held by StarNet runs that are still working — nothing is lost: each run reserves up to its PER RUN limit and refunds what it doesn't spend. Wait for them to finish, lower PER RUN in SETTINGS › SPENDING LIMITS, or top up under SETTINGS → AI & MODELS." },
    // The account service ANSWERED and refused this station's token (unlinked on the account page, or linked to a
    // different account). Topping up fixes nothing; relinking does — same PROVIDERS door as the STARNET card.
    managed_credit_link: { retryable: false, action: 'store', msg: "Your StarNet account didn't accept this station's link (it was unlinked, or it belongs to another account) — your credits are safe. Relink it under SETTINGS → AI & MODELS → STARNET MANAGED." },
    // capdenied copy is REBUILT per-error in friendlyError() to name the exact power + gear; this is the fallback
    // when the capability can't be parsed. The door is BUILD MODE (place the gear), NOT the SKILLS list.
    capdenied:     { retryable: false, action: 'refit',    msg: "This task needed a tool this agent doesn't have on station yet — open BUILD MODE to place the gear it's missing." },
    timeout:       { retryable: true,  action: null,       msg: 'That took too long and timed out — try again.' },
    user_abort:    { retryable: false, action: null,       msg: 'Stopped.' },
    context_overflow: { retryable: false, action: null,    msg: 'This conversation got too long for the model — start a fresh chat or shorten it.' },
    model_not_found:  { retryable: false, action: 'settings', msg: "That model isn't available — pick a different one from the model dock in COMMS." },
    /* The StarNet credit relay refused this call's price: its ESTIMATE for the prompt ALONE is over its per-call ceiling
       ($10 by default at starnet-cloud b5582dd, and configurable there — sidecar/providers/errorClass.js
       call_too_expensive), and a resend is refused the same way. The relay says the call "could cost more", so the copy
       says "could", never that it does. The copy is REBUILT per error in friendlyError() to quote the ceiling the relay
       named; this is the fallback.
       NO "nothing was charged" (0.14.2 review): the station knows only that the relay refused THIS call. A run's later
       call can be the refused one after its earlier calls were billed (sidecar/loop.js books each turn's usage), and the
       relay's own code (starnet-cloud src/app.js, outside this repo) may auto-reload a zero balance before it prices the
       call. The relay refusing the call is all the copy says. */
    call_too_expensive: { retryable: false, action: 'settings', msg: "This conversation could now cost more per message than StarNet allows for one call on this model, so StarNet refused the call. Start a fresh chat, or pick a cheaper model from the model dock in COMMS." },
    content_policy_blocked: { retryable: false, action: null, msg: 'The model declined that request on safety grounds — try rephrasing it.' },
    // JUKEBOX is placed (the Spotify tools ARE granted) but Spotify's OAuth session isn't connected yet — the
    // real second half of the unlock chain. The door is TOOLSETS (its JUKEBOX row carries ▶ CONNECT SPOTIFY —
    // Settings has NO spotify surface; the old 'settings' door landed on PROVIDERS with no connect control),
    // NOT BUILD MODE (the gear is already on station) — distinct from `capdenied` which fires when no JUKEBOX exists.
    spotify_not_connected: { retryable: false, action: 'toolsets', msg: 'The JUKEBOX is on station, but Spotify isn’t connected yet — connect it in ABILITIES, then try again.' },
    // the one-run-at-a-time mutex: the SIDECAR message names the holder (age/source) + recovery steps.
    // Keep those details instead of flattening to `unknown` (2026-07-07 escape:
    // the user got "Something went wrong" in a loop while the real answer was one sentence away).
    agent_busy:    { retryable: true,  action: null,       msg: 'That agent is still busy with a previous run — wait for it to finish, or open its conversation and stop the active run.' },
    // the SIDECAR's own token gate said no (a 403 with "forbidden token/origin/host"): after a sidecar
    // crash+respawn the page still holds the OLD X-StarNet-Token, so EVERY action 403s. Retrying is doomed and
    // "add a key" is the wrong door — the page needs the fresh boot token, which only a reload fetches.
    stale_session: { retryable: false, action: 'reload',   msg: 'The station restarted — reload this page to reconnect.' },
    // (a page the station KEPT its key from gets the same 403 but is no restart — see withheldNotice() below)
    /* THE STATION'S OWN ANSWERS (truthful acks, 2026-11-03): a refusal the station named in X-StarNet-Code (STATION_CODE_TO_KIND
       below). station_refused: a route turned this request down — its own sentence leads (stationSaid), and no retry, key or
       model door rides with it (a resend is refused the same way; the key and the model were never the question). wrong_address:
       the gate refused this page's ADDRESS (forbidden_origin / forbidden_host) — the same hints the key check gives, no door. */
    station_refused: { retryable: false, action: null,     msg: 'The station refused this request.' },
    wrong_address: { retryable: false, action: null,       msg: 'This page’s address doesn’t match the station — open StarNet at the exact address you forward to it.' },
    /* StarNet's OWN spend ledger can't say what was spent (sidecar/loop.js stopForSpend, failureCode
       spend_history_unavailable): a limit the Commander chose can't be checked, so the run was stopped. NOT a provider
       out of credit (never `billing`), and never the generic "Something went wrong — try again": a retry hits the same
       refusal until the cause is fixed. The copy is REBUILT per cause in friendlyError() (spendUnknownMessage); this is
       the fallback. The door is SETTINGS › SPENDING LIMITS, where the cause and its fix are listed. */
    spend_unknown: { retryable: false, action: 'budget',   msg: "Your spending limits can't be checked because StarNet's spend history is unknown, so this run was stopped — open SETTINGS › SPENDING LIMITS to fix it." },
    /* HARNESS STOPS (2026-10-11 — "they start a task and then stop repeatedly with no explanation"). The loop's own
       stop messages (loop guard, loop breaker, unkept promises, output-limit cuts, hooks, checkpoints) fell through to
       `unknown` and led with "Something went wrong on that turn". Each now leads with what happened + what to do;
       the per-message copy is built by explainStop() below — these msgs are the fallback/metadata only. */
    loop_stuck:         { retryable: true,  action: null, msg: 'The agent got stuck repeating one step, so StarNet stopped the run. Say what to try differently, then ask again.' },
    unknown_tools:      { retryable: true,  action: null, msg: 'The model kept calling tools that don’t exist, so StarNet stopped the run. Try again, or switch to a stronger model.' },
    tool_keeps_failing: { retryable: true,  action: null, msg: 'A tool kept failing, so StarNet stopped this unattended run. Check its error, fix the cause, then run it again.' },
    no_progress:        { retryable: true,  action: null, msg: 'A tool kept returning the same result, so StarNet stopped this unattended run as stuck.' },
    incomplete_work:    { retryable: true,  action: null, msg: 'The agent stopped before finishing: it kept saying what it would do next without doing it. Say "continue" to push it on.' },
    memory_unverified:  { retryable: true,  action: null, msg: 'The agent said it saved something to memory, but nothing was written — ask it again to save it.' },
    output_limit:       { retryable: false, action: null, msg: 'The reply hit the model’s output limit while writing a large tool call, so nothing from it was saved. Ask for it in smaller parts.' },
    checkpoint_failed:  { retryable: true,  action: null, msg: 'StarNet couldn’t save this run’s progress to disk, so it stopped. Check free disk space, then try again.' },
    hook_blocked:       { retryable: false, action: null, msg: 'One of your hooks blocked this run. Change or turn off that hook to let it run.' },
    /* GH#111: the OLLAMA card points at a server that is not Ollama (LM Studio answers Ollama's chat with a 200 "no such
       route"). A resend reaches the same server, so no retry; the door is the CUSTOM card that speaks to it. The headline is
       the adapter's own sentence (it names the server); this msg is only the fallback. */
    endpoint_mismatch:  { retryable: false, action: 'settings', msg: 'The OLLAMA card points at a server that is not Ollama. Add that server under SETTINGS → AI & MODELS → CUSTOM with its /v1 URL instead.' },
    local_model_memory: { retryable: false, action: 'settings', msg: 'The local model ran out of memory. Close other local models or memory-heavy apps, or choose a smaller model from the model picker in COMMS before trying again. If the station is still blank or disconnected, restart StarNet after freeing memory.' },
    /* A LOCAL MODEL SERVER STAYED SILENT through StarNet's whole wait (errorClass local_timeout: LM Studio, vLLM, llama.cpp on
       this computer or network, or Ollama with the model loaded). The station ended the turn rather than start the same prompt
       over on a server that may still be working on it, so no ↻ Try again; the door is the model dock (a smaller model). The
       headline is the station's own sentence (it names the server, the phase and the wait); this msg is only the fallback.
       It read "That took too long and timed out — try again" with the code, and "start a fresh chat" (context_overflow)
       without it (local-runtime-profile review M2, 2026-11-03). */
    local_timeout:      { retryable: false, action: 'settings', msg: 'The model server on this computer or network sent nothing back within StarNet’s wait, so StarNet ended this turn instead of sending the same prompt again. Check the server’s own log, or pick a smaller model in the COMMS model dock.' },
    /* The model's CHAT TEMPLATE refused the conversation's shape (errorClass template_refusal, #102): the adapter already resent
       it once with no system message, so a resend is refused the same way — no ↻ Try again. Another model has another template,
       so the door is the model dock. The headline is the station's own sentence (it names the model, the host and the template's
       words: templateMessage); this msg is only the fallback. It read "Something went wrong — try again" (typed-outcomes, 2026-10-29). */
    template_refusal:   { retryable: false, action: 'settings', msg: "This model's chat template refused the conversation StarNet sent (it rejects a system message, or the order of the turns), so sending it again is refused the same way. Pick another model in the COMMS model dock, or update the model on its server." },
    /* NOTHING ANSWERED at the provider's address (errorClass unreachable, bug 8873fd77): the connection was refused or the name did
       not resolve, after one retry. StarNet itself is fine and the fix is starting that server or correcting its address, so the
       door is AI & MODELS and a retry stays (once it is started). The headline keeps the station's own note (which host, what to
       check: unreachableMessage); this msg is only the fallback. It read "try again" or blamed the internet (typed-outcomes). */
    unreachable:        { retryable: true,  action: 'settings', msg: "StarNet is running, but nothing answered at the AI provider's address — start the server that should answer there (Ollama, LM Studio …), or correct its address in SETTINGS → AI & MODELS, then send again." },
    // a TLS certificate this machine does not trust (errorClass tls_certificate): waiting never fixes it; the station's sentence names the fix
    /* THE STATION'S OWN REFUSALS (typed outcomes, the unpark): a run the station would not START — a routine whose pre-check script
       failed, a required routine skill that is gone, too many agents at once, a model that cannot run the task, an image route with no
       STUDIO. Each names its own failureCode at the refusal (sidecar/index.js runOnceCore), so COMMS words it from the code instead of
       a text ladder that read most of them "Something went wrong — try again" (and "too many agents" as the provider's rate limit).
       The station's own sentence leads (it names the script, the skill, the limit, the model); these msgs are only the fallback. */
    routine_precheck:   { retryable: false, action: null, msg: "This routine's pre-check script did not pass, so its agent never ran. Fix the script in ROUTINES, then run it again." },
    routine_skill:      { retryable: false, action: null, msg: 'A skill this routine requires is missing or withheld, so the routine did not run. Restore the skill, or edit the routine in ROUTINES.' },
    agent_deleting:     { retryable: false, action: null, msg: 'This agent is being deleted and cannot start new work.' },
    concurrency_limit:  { retryable: true,  action: null, msg: 'Too many agents are working at once, so this run did not start — wait for one to finish, then send it again.' },
    model_unsuitable:   { retryable: false, action: 'settings', msg: "This model can't run tasks here (it can't call tools, or it only makes images) — pick a different one from the model dock in COMMS." },
    image_blocked:      { retryable: false, action: null, msg: 'The image task could not start: it needs a STUDIO, MEDIA STUDIO turned on and a media connection. Nothing was marked done.' },
    image_not_produced: { retryable: true,  action: null, msg: 'The image task ended without producing an image, so nothing was marked done. Check the STUDIO route, then try again.' },
    tls_certificate:    { retryable: false, action: 'settings', msg: "This computer doesn't trust the AI provider's security certificate (a corporate proxy or an antivirus HTTPS scan can cause this), so StarNet could not connect. Point NODE_EXTRA_CA_CERTS at that proxy's root certificate and restart StarNet, or use another provider." },
    unknown:      { retryable: true,  action: null,       msg: 'Something went wrong on that turn — try again.' }
  };

  // the sidecar classifier speaks in `reason`s; map each onto our UI kind. Its whole domain is the PROVIDER
  // API call (sidecar/providers/errorClass.js) — so its `server_error`/`overloaded` are the provider's fault
  // by construction and map to provider_server_error, never to the local-service copy.
  const REASON_TO_KIND = {
    auth: 'auth', billing: 'billing', rate_limit: 'rate_limit', quota_exhausted: 'quota_exhausted', overloaded: 'provider_server_error',
    server_error: 'provider_server_error', timeout: 'timeout', context_overflow: 'context_overflow',
    model_not_found: 'model_not_found', call_too_expensive: 'call_too_expensive', content_policy_blocked: 'content_policy_blocked',
    format_error: 'unknown', endpoint_mismatch: 'endpoint_mismatch', unknown: 'unknown',
    template_refusal: 'template_refusal', unreachable: 'unreachable', tls_certificate: 'tls_certificate', local_memory: 'local_model_memory',
    local_timeout: 'local_timeout'
  };
  /* THE ONE TABLE: the station's failure CODE -> the kind whose words COMMS shows (typed-outcomes lane, 2026-10-29). The code
     rides agent.run.error / agent.run.end (failureCode — the provider classifier's reason, or the loop's own stop code) and
     Harness.chat hands it over as errorCode; friendlyError(err, status, { code }) reads the kind HERE instead of re-reading
     the error's words, so the page says what the station decided (a ChatGPT 429 the classifier called a rate limit is a rate
     limit, never a spent plan). A code not in this table (run_failure, format_error, unknown…) names nothing specific: the
     error's words decide, as before. StarNet's own UI-level messages (a sign-in, a busy agent, a stale page) are read first. */
  const CODE_TO_KIND = Object.assign({}, REASON_TO_KIND, {
    format_error: null, unknown: null, output_cap: null, local_error: null, local_timeout: 'local_timeout', provider_stalled: 'timeout',
    spend_history_unavailable: 'spend_unknown', capability_denied: 'capdenied', output_limit_tool_cut: 'output_limit',
    memory_write_unverified: 'memory_unverified', incomplete_work: 'incomplete_work', repeated_identical_failure: 'loop_stuck',
    unknown_tools: 'unknown_tools', repeated_tool_failure: 'tool_keeps_failing', no_progress: 'no_progress',
    checkpoint_failed: 'checkpoint_failed', hook_blocked: 'hook_blocked',
    // the station's own up-front refusals (sidecar/index.js runOnceCore) and its managed-credit refusals (budgetcaps.js managedRefusalMessage)
    routine_script_failed: 'routine_precheck', routine_script_blocked: 'routine_precheck', routine_script_missing: 'routine_precheck',
    routine_skill_unavailable: 'routine_skill', routine_skill_missing: 'routine_skill', routine_skill_withheld: 'routine_skill',
    agent_deleting: 'agent_deleting', concurrency_limit: 'concurrency_limit', model_unsuitable: 'model_unsuitable', model_no_tools: 'model_unsuitable',
    image_route_blocked: 'image_blocked', image_not_produced: 'image_not_produced',
    managed_credit: 'managed_credit', managed_credit_held: 'managed_credit_held', managed_credit_link: 'managed_credit_link',
    managed_credit_unavailable: 'managed_credit_unavailable'
  });
  /* THE STATION'S OWN REFUSAL CODES (truthful acks, 2026-11-03): every failure the station answers names itself in X-StarNet-Code
     (sidecar/respond.js CODES — one row here per code there), and Harness.chat's pre-stream throw carries it as err.stationCode.
     It is read BEFORE the words: a 403 is a stale page only when the gate says token_stale (token_missing is a page the station
     kept its key from), a 404 is never "that model isn't available", and no station code reads as a provider's key, billing or
     model fault. The GATE's codes decide outright: the gate answered before any route ran, so no route's sentence rides with
     them. A ROUTE's code still lets the station's own sentences keep their kinds (a ChatGPT sign-in, a missing key or model, a
     busy agent, a spend history it cannot read — the doors those sentences name) and decides everything the status ladders
     would have guessed. A station that sends no code is read by the words, exactly as before. */
  const STATION_CODE_TO_KIND = Object.freeze({
    token_stale: 'stale_session', token_missing: 'stale_session', forbidden_origin: 'wrong_address', forbidden_host: 'wrong_address',
    bad_request: 'station_refused', bad_json: 'station_refused', bad_agent_id: 'station_refused', refused: 'station_refused',
    forbidden: 'station_refused', wrong_owner: 'station_refused', path_refused: 'station_refused', ticket_refused: 'station_refused',
    not_found: 'station_refused', method_not_allowed: 'station_refused', conflict: 'station_refused', too_large: 'station_refused',
    frozen: 'station_refused', rate_limited: 'station_refused', upstream_error: 'station_refused', upstream_timeout: 'station_refused',
    station_error: 'server_error', unavailable: 'server_error'
  });
  const STATION_GATE_CODES = { token_stale: 1, token_missing: 1, forbidden_origin: 1, forbidden_host: 1 };
  // the station's code for a failure it answered ('' = none: an older station, or an error the station never answered)
  function stationCodeOf(err, opts) {
    const c = (opts && opts.stationCode) || (err && typeof err === 'object' ? err.stationCode : '');
    return typeof c === 'string' ? c.trim() : '';
  }
  // a station code's kind: its row, else (a code a newer station added) the station's own refusal
  function stationKind(code) {
    return code ? (Object.prototype.hasOwnProperty.call(STATION_CODE_TO_KIND, code) ? STATION_CODE_TO_KIND[code] : 'station_refused') : null;
  }
  // the station's own sentence for its refusal: the words after "sidecar HTTP <n> — ", without the code it already named
  function stationSaid(raw, code) {
    let s = String(raw || '').replace(/^\s*sidecar http \d{3}\b\s*(?:—|-|:)?\s*/i, '').trim();
    const tail = '(' + code + ')';
    if (code && s.slice(-tail.length) === tail) s = s.slice(0, -tail.length).trim();
    return s.replace(/[.\s]+$/, '');
  }
  // the kinds whose words are the station's own sentence (the refusal names the script, the skill, the limit, the model): it leads
  const STATION_SENTENCE_KINDS = { routine_skill: 1, agent_deleting: 1, concurrency_limit: 1, model_unsuitable: 1, image_blocked: 1, image_not_produced: 1 };
  function codeKind(code) {
    const c = String(code == null ? '' : code).trim();
    return c && Object.prototype.hasOwnProperty.call(CODE_TO_KIND, c) && CODE_TO_KIND[c] && KINDS[CODE_TO_KIND[c]] ? CODE_TO_KIND[c] : null;
  }

  /* WHICH provider an error came from (org P03) — so a door lands on that provider's card in AI & MODELS and the
     billing copy can name the account. Evidence only, never a guess: the adapter's own "<name> http <status>"
     signature (anthropic / gemini / openrouter and the device-OAuth labels), the sidecar credential guard's
     registry label ("connect a OPENROUTER API key", "configure the CUSTOM base URL"), or the provider's own
     console host in the body. An "openai-compatible http …" error with no host names nobody, so it returns null
     and the copy stays provider-neutral. Ids are the AI & MODELS card ids (.prov-card[data-provider]). */
  const PROVIDER_IDS = ['starnet', 'openrouter', 'codex', 'grok', 'kimi', 'openai', 'anthropic', 'gemini', 'xai', 'groq',
    'mistral', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'ollama', 'custom'];
  const PROVIDER_WORDS = { codex: 'CHATGPT', grok: 'GROK', kimi: 'KIMI', starnet: 'STARNET' };
  function providerWord(id) { return PROVIDER_WORDS[id] || String(id || '').toUpperCase(); }
  // a provider's name inside a SENTENCE (org P03): the brand's own case, like the sibling rows' 'No ChatGPT sign-in yet'.
  // Key labels keep providerWord's capitals; an id with no prose name keeps the provider-neutral copy.
  const PROVIDER_PROSE = { openrouter: 'OpenRouter', codex: 'ChatGPT', grok: 'Grok', kimi: 'Kimi', starnet: 'StarNet', openai: 'OpenAI',
    anthropic: 'Anthropic', gemini: 'Gemini', xai: 'xAI', groq: 'Groq', mistral: 'Mistral', deepseek: 'DeepSeek', together: 'Together AI',
    fireworks: 'Fireworks', perplexity: 'Perplexity', cerebras: 'Cerebras' };
  /* A SIGN-IN SUBSCRIPTION HAS NO WALLET (org P03, final round). The keyless sign-ins — ChatGPT (codex), Grok on SuperGrok /
     X Premium+, Kimi for Coding — are PLANS (sidecar/providers/registry.js: oauth_device_code + unmetered), so a billing or
     quota verdict on one is a spent plan allowance that resets on the provider's own schedule: never "out of credit — top
     it up" (there is no balance to top up). */
  const SUBSCRIPTION_IDS = ['codex', 'grok', 'kimi'];
  /* bug 06331054: a ChatGPT plan has a short rolling window (hours) AND a weekly one, so "resets weekly" sent a user whose
     short window was spent away for days. Name both, and quote the provider's own reset time when the error carries one
     ("Resets in 3 days", "try again in 4h 12m") — only its numbers and units, never other words from the error. */
  function quotaResetIn(raw) {
    const m = String(raw || '').match(/\b(?:resets?|try again) in\s+((?:\d+(?:\.\d+)?\s*(?:weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?){1,4})/i);
    return m ? m[1].replace(/[\s,]*(?:and\s*)?$/i, '').replace(/\s+/g, ' ').trim() : '';
  }
  /* #158: the adapter's own block of provider facts (codex.js providerFacts): "[provider: code=x; primary-used-percent=4]".
     Only names and slugs/numbers ride in it, so it can be read as data. */
  function providerFactsOf(raw) {
    const m = /\[provider: ([^\]]*)\]/.exec(String(raw || ''));
    const out = {};
    if (m) for (const pair of m[1].split(';')) { const i = pair.indexOf('='); if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim(); }
    return out;
  }
  const QUOTA_CODE_RE = /usage_limit_reached|quota_exhausted|quota_exceeded|usage_not_included|plan_limit|insufficient_quota/;
  /* The wait the provider stated, in seconds, or null: "try again in 4h 12m", "resets in 86400s", or its resets_in_seconds
     fact. The longer one when both are there. */
  const WAIT_UNIT_S = { ms: 0.001, millisecond: 0.001, s: 1, sec: 1, second: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, d: 86400, day: 86400, w: 604800, week: 604800 };
  function statedWaitSeconds(raw) {
    const text = String(raw || '');
    const said = /\b(?:resets?|try again) in\s+((?:\d+(?:\.\d+)?\s*(?:weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|milliseconds?|ms|seconds?|secs?|s)\b[\s,]*(?:and\s+)?){1,4})/i.exec(text);
    let total = null;
    if (said) {
      total = 0;
      const part = /(\d+(?:\.\d+)?)\s*([a-z]+)/gi;
      for (let m = part.exec(said[1]); m; m = part.exec(said[1])) {
        const unit = m[2].toLowerCase();
        if (unit === 'and') continue;
        total += Number(m[1]) * (WAIT_UNIT_S[unit] || WAIT_UNIT_S[unit.replace(/s$/, '')] || 0);
      }
    }
    const fact = Number(providerFactsOf(raw).resets_in_seconds);
    if (isFinite(fact) && fact > 0 && (total == null || fact > total)) total = fact;
    return total;
  }
  // a wait this short is a wait, not a spent allowance; past it, a window really can be spent ("try again in 45 minutes")
  const SHORT_WAIT_MAX_S = 15 * 60;
  function waitInWords(seconds) {
    if (seconds < 90) return 'about a minute';
    if (seconds < 90 * 60) return 'about ' + Math.round(seconds / 60) + ' minutes';
    return 'about ' + Math.round(seconds / 3600) + ' hours';
  }
  /* #158: may a rate-limit verdict on a sign-in plan be re-read as its spent allowance? YES on the provider's own numbers,
     whatever the words: a meter at its limit, or a wait past SHORT_WAIT_MAX_S. Otherwise the word "quota" is the only
     clue, and it is not proof: not when the provider's code says something else, or it names a short wait. */
  function planNumbersSpent(raw) {
    const facts = providerFactsOf(raw);
    const wait = statedWaitSeconds(raw);
    return Object.keys(facts).some(k => /-used-percent$/.test(k) && Number(facts[k]) >= 100) || (wait != null && wait > SHORT_WAIT_MAX_S);
  }
  function quotaWordMeansSpent(raw) {
    if (planNumbersSpent(raw)) return true;
    const low = String(raw || '').toLowerCase();
    const facts = providerFactsOf(raw);
    const wait = statedWaitSeconds(raw);
    if (!/quota/.test(low) || SHORT_WINDOW_RE.test(low) || wait != null) return false;
    const code = String(facts.code || facts.type || '').toLowerCase();
    return !code || QUOTA_CODE_RE.test(code);
  }
  /* #158: the meters on the SAME answer that refused. When every one reports well under its limit, "used up" is a claim
     those numbers contradict: the refusal is quoted, and which limit it was stays unknown. -> ['4%', '19%'] or null. */
  const METER_ROOM_BELOW_PCT = 90;
  function metersShowRoom(raw) {
    const facts = providerFactsOf(raw);
    const used = Object.keys(facts).filter(k => /-used-percent$/.test(k)).map(k => Number(facts[k]));
    if (!used.length || used.some(n => !isFinite(n) || n >= METER_ROOM_BELOW_PCT)) return null;
    return used.map(n => n + '%');
  }
  function quotaMessage(provider, raw) {
    const nm = SUBSCRIPTION_IDS.indexOf(provider) >= 0 ? PROVIDER_PROSE[provider] : null;
    const room = nm ? metersShowRoom(raw) : null;
    if (room) {
      return nm + ' refused this request as over a usage limit, but the usage meters on that same answer read ' + room.join(' and ')
        + " used, so those windows are not what stopped it. StarNet can't tell which limit did; it may be one specific to this model. Pick a different model from the model dock in COMMS, or switch provider under SETTINGS → AI & MODELS.";
    }
    const when = quotaResetIn(raw);
    const said = when ? (nm || 'The provider') + ' says it resets in ' + when + '. ' : '';
    if (!nm) return KINDS.quota_exhausted.msg.replace('To keep working now', said + 'To keep working now');
    return 'Your ' + nm + " plan allowance is used up — it resets on " + nm + "'s own schedule"
      + (provider === 'codex' ? ' (a few hours for the short window, up to a week for the weekly one)' : ', not in seconds')
      + '. ' + said + 'To keep working now, switch to another provider or key under SETTINGS → AI & MODELS.';
  }
  function providerFromRaw(raw) {
    const low = String(raw || '').toLowerCase();
    // (the ChatGPT adapter signs its failures 'codex http <status> — …': sidecar/providers/codex.js)
    let m = low.match(/\b(openrouter|anthropic|gemini|codex|grok \(xai\)|kimi for coding) http \d{3}\b/);
    if (m) return m[1].indexOf('grok') === 0 ? 'grok' : m[1].indexOf('kimi') === 0 ? 'kimi' : m[1];
    m = low.match(/connect an? (.+?) api key\b/) || low.match(/configure the (.+?) base url/) || low.match(/the station holds no (.+?) endpoint for its saved key/);
    if (m) {
      const id = m[1].trim().replace(/\s+(api|oauth)$/, '').replace(/\s+/g, '');
      if (PROVIDER_IDS.indexOf(id) >= 0) return id;
    }
    if (/\bconsole\.x\.ai\b|\bapi\.x\.ai\b/.test(low)) return 'xai';
    if (/\bopenrouter\.ai\b/.test(low)) return 'openrouter';
    if (/\bplatform\.openai\.com\b/.test(low)) return 'openai';
    return null;
  }

  /* MIRROR of sidecar/stop-reason.js STOP_EXPLAINERS — the browser never loads sidecar modules, so the harness's own
     stop messages are explained here in the SAME words (test/stop-reason.test.js locks the two copies together).
     Matched BEFORE any provider classification: these are StarNet's own decisions, not API failures. */
  const STOP_EXPLAINERS = [
    { kind: 'loop_stuck', re: /loop guard: (.+?) failed (\d+) times with identical arguments/i,
      text: m => 'The agent got stuck repeating one step: ' + m[1] + ' failed ' + m[2] + ' times in a row with the same input, so StarNet stopped the run. Say what to try differently, or fix what that step needs, then ask again.' },
    { kind: 'unknown_tools', re: /loop breaker: the model called tools that do not exist \(([^)]*)\)/i,
      text: m => 'The model kept calling tools that don’t exist (' + m[1] + '), so StarNet stopped the run. Try again, or switch to a stronger model.' },
    { kind: 'tool_keeps_failing', re: /loop breaker: (.+?) failed (\d+) times in a row/i,
      text: m => m[1] + ' kept failing (' + m[2] + ' times in a row, with different inputs), so StarNet stopped this unattended run. Check its error, fix the cause, then run it again.' },
    { kind: 'no_progress', re: /loop breaker: (.+?) returned the identical result (\d+) turns in a row/i,
      text: m => m[1] + ' kept returning the same result (' + m[2] + ' turns in a row), so StarNet stopped this unattended run as stuck. Check what it was waiting for, then run it again.' },
    { kind: 'incomplete_work', re: /Work is incomplete: the model kept announcing/i,
      text: () => 'The agent stopped before finishing: it kept saying what it would do next without actually doing it. Say "continue" to push it on, or switch to a stronger model.' },
    { kind: 'memory_unverified', re: /memory update is unverified|promise to remember above is unverified/i,
      text: () => 'The agent said it saved (or would remember) something, but nothing was written to memory — it will not remember this next time. Ask it again to save it.' },
    { kind: 'output_limit', re: /hit the model's output limit while writing a large (\S+) call/i,
      text: m => 'The reply hit the model’s output limit while writing a large ' + m[1] + ' call, so it never ran and nothing from it was saved. Ask for it in smaller parts (for example "write it section by section"), or switch to a model with a larger output limit.' },
    { kind: 'checkpoint_failed', re: /run checkpoint failed/i,
      text: () => 'StarNet couldn’t save this run’s progress to disk, so it stopped rather than risk losing work. Check free disk space, then try again.' },
    { kind: 'hook_blocked', re: /blocked by your hook(?: `([^`]*)`)?: ?(.*)$/i,
      text: m => 'Your hook' + (m[1] ? ' `' + m[1] + '`' : '') + ' blocked this run' + (m[2] ? ': ' + m[2].replace(/\.\s*$/, '') : '') + '. Change or turn off that hook to let it run.' },
    { kind: 'context_overflow', re: /context still too large after compacting/i,
      text: () => 'This conversation got too long for the model, even after StarNet compacted it. Start a fresh conversation, or switch to a model with a larger context window.' }
  ];
  function explainStop(message) {
    const s = String(message == null ? '' : message);
    if (!s) return null;
    for (const e of STOP_EXPLAINERS) {
      const m = s.match(e.re);
      if (m) return { kind: e.kind, text: e.text(m) };
    }
    return null;
  }
  /* The COMMS work-log line for a run that ENDED (agent.run.end reason) without a clean delivery and without an error
     row of its own. Raw reason words ("stopped (empty)") read as a silent stop; each now says what happened + the
     next step. opts.cancelSource: 'estop_by_run' (the run pressed E-STOP itself) — anything else that is not the
     Commander's own Stop came from OUTSIDE this chat (a station/HUD/phone STOP or E-STOP). opts.toolsRan: this turn's
     agent.tool_call count — an empty end AFTER tool steps is not "nothing was done" (a file may already be written), so
     it reads exactly like sidecar/stop-reason.js stopSentence (test/stop-reason.test.js locks the two). '' = nothing to add. */
  function stopLine(reason, opts) {
    const o = opts || {};
    const r = String(reason == null ? '' : reason);
    if (r === 'max_iters') return 'reached the step limit — say "continue" to keep going';
    if (r === 'empty') {
      const ran = Math.floor(Number(o.toolsRan) || 0);
      return ran > 0
        ? 'the model went silent after ' + ran + ' tool step' + (ran === 1 ? '' : 's') + ' and never gave a final answer — those steps may already have made changes; say "continue" to have it finish, or switch model if it keeps happening'
        : 'the model sent back an empty reply, so nothing was done — say "continue" to try again, or switch model if it keeps happening';
    }
    if (r === 'refusal') return 'the model declined that request — try rephrasing it';
    if (r === 'cancelled') {
      if (o.cancelSource === 'estop_by_run') return 'stopped — this run paused all automation (what Pause Automation in the StarNet tray menu does); RESUME AUTOMATION (top bar) is yours alone';
      return 'stopped from outside this chat — a STOP elsewhere (desk screen, HUD, phone, or Pause Automation in the StarNet tray menu) ended it before it finished';
    }
    // a FAILED run says it failed, never the stop's word (review 9.2: every failed run read "⏹ it stopped on an error…" and toasted "run failed: it
    // stopped on an error…"; only a run someone stopped is "stopped")
    if (r === 'error') return 'it hit an error before it finished — try again';
    if (!r || r === 'done' || r === 'clarifying') return '';
    return 'it stopped before finishing (' + r + ')';
  }

  /* A PAGE THE STATION KEPT ITS KEY FROM (review threads-backend-05). The sidecar serves the page without its key when it
     cannot prove this browser runs as the station's own OS user (Harness.tokenWithheld() = its reason); every keyed call
     then 403s exactly like a stale page, but the station did not restart — "The station restarted — reload" would be
     a false claim. Both stale_session sites (the "sidecar HTTP 403" ladder and kindFromRaw's 403) therefore lead with
     Harness's own withheld notice and offer NO door: the notice itself says whether a reload can help (it re-runs the
     check, so only for a transient reason) and names the owner's hatch. The kind stays stale_session (its
     post-mortem already reads "the message is the fix"). '' = this page holds its key (or no Harness: node/tests). */
  const TOKEN_WITHHELD_MSG = 'StarNet could not confirm this browser runs as your own user account, so it won’t take commands from this page. Open StarNet from the desktop app, or if this is your own browser, restart StarNet with STARNET_TRUST_LOCAL_PEERS=1.';
  function withheldNotice() {
    if (typeof Harness === 'undefined' || !Harness || typeof Harness.tokenWithheld !== 'function' || !Harness.tokenWithheld()) return '';
    return (typeof Harness.tokenWithheldNotice === 'function' && Harness.tokenWithheldNotice()) || TOKEN_WITHHELD_MSG;
  }

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
  /* DID THIS PAGE'S OWN CONNECTION TO THE SIDECAR DROP? (night N2, 2026-10-15.) Answered by PROVENANCE, never by words:
     Harness.chat marks the errors its own transport raised — the fetch() rejection, the body read rejection, the body
     ending before the lead's completion — with `starnetTransport` (see harness.js transportLoss). Words cannot answer
     it: Chromium/WebView2 rejects a body read on a dead sidecar with a bare "network error" the word list above never
     knew, and the same words can arrive IN-BAND, composed and streamed by a perfectly live sidecar. A string can never
     carry the mark, so no provider text can claim it. Only a marked error is a transport loss the reconnect watch may
     act on (verdict.transport); isTransportLoss above still shapes the COPY of an unmarked text, nothing more. */
  function isTransportThrow(err) {
    return !!err && typeof err === 'object' && typeof err.starnetTransport === 'string' && err.starnetTransport !== '';
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
  //   "This task needs FILE ACCESS — an INTEL CAB isn't on station. Open BUILD MODE to place it."
  // Falls back to the generic KINDS.capdenied copy when the capability can't be parsed.
  function capdeniedMessage(cap) {
    const info = cap && CAP_INFO[cap];
    if (!info) return KINDS.capdenied.msg;
    return 'This task needs ' + info.power + ' — ' + info.gear + " isn't on station. Open BUILD MODE to place it and try again.";
  }

  // browser fallback: classify the UI-level error string + optional HTTP status into a kind, using the SAME
  // vocabulary the sidecar reasons map onto. Order: most-specific intent first.
  /* Kept in step with the same three patterns in sidecar/providers/errorClass.js. A spent SUBSCRIPTION
     allowance ("you've hit your usage limit", "resets in 3 days", a weekly/monthly quota) is terminal; a
     PER-MINUTE limit is not, and Gemini phrases one as "Quota exceeded for quota metric", which a bare
     /quota/ test swallowed. OpenAI's `insufficient_quota` is an empty wallet and stays billing. */
  const QUOTA_EXHAUSTED_RE = /usage[_ ]?limit(?:[_ ]?(?:has|is)(?:[_ ]?been)?)?[_ ]?reached|hit (?:your|the) (?:usage|weekly|monthly|plan|daily) limit|(?:weekly|monthly|daily) (?:quota|limit)|resets? in \s*\d+\s*(?:day|hour|week)|resets? (?:on|at) \d|quota (?:will )?reset(?:s)? (?:in|on|at)/;
  const SHORT_WINDOW_RE = /per[- ]?(?:minute|second)|quota metric|\brpm\b|\btpm\b|requests per/;
  // OpenRouter's free-model DAILY cap names itself — and says "requests per day", which the veto above would eat
  const DAILY_FREE_CAP_RE = /free-models-per-day/;
  function quotaSpent(low) { return DAILY_FREE_CAP_RE.test(low) || (QUOTA_EXHAUSTED_RE.test(low) && !SHORT_WINDOW_RE.test(low)); }
  const TERMINAL_BILLING_RE = /insufficient[_ ]?quota|exceeded your current quota|out of credit|add credits|payment required/;
  /* Mirrored from sidecar/providers/errorClass.js (REJECTED_KEY_RE / NO_CREDIT_RE) — keep the two in step. xAI
     answers a bad key with HTTP 400 "Incorrect API key provided", and a team with no prepaid credits with 403
     "…doesn't have any credits yet. You can purchase credits on https://console.x.ai/…" (2026-09-27). */
  const REJECTED_KEY_RE = /incorrect api key|invalid api key|api key (?:is )?(?:invalid|not valid|incorrect)|invalid x-api-key/;
  const NO_CREDIT_RE = /(?:doesn'?t|does not) have any credits|purchase (?:more )?credits|used all (?:of )?(?:its |your )?available credits|(?:reached|exceeded|hit) (?:its |your |the |their )?(?:monthly )?spending limit|insufficient[_ ]?(?:credit|funds|balance)|out of credits?|credit balance is too low|key limit exceeded/;
  // mirrored from errorClass.js: an upstream region refusal is the model being unavailable here, not a bad key
  const REGION_REFUSAL_RE = /unsupported_country_region_territory|country,? region,? or territory not supported|not available in your (?:country|region)/;
  /* mirrored from errorClass.js (IMAGE_INPUT_REFUSED_RE) — keep the two in step: an image sent to a model that cannot see
     it (OpenRouter 404 "No endpoints found that support image input", 2026-10-23). Not "that model isn't available":
     the model is fine, the image is what it refused, and a vision model is the fix. OpenAI's own text-only models say
     "image_url is only supported by certain models" (400). */
  const IMAGE_INPUT_RE = /no endpoints found that support image input|(?:does not|doesn'?t|cannot|can'?t) (?:support|accept|take|handle) (?:image|vision)|image input (?:is )?(?:not supported|unsupported)|(?:images?|vision) (?:input )?(?:is |are )?not supported (?:by|for|on) (?:this|the) model|unknown variant `image_url`|image_url is only supported by certain models/;
  const IMAGE_INPUT_MSG = "This model can't see images — pick a vision model from the model dock in COMMS, then send again.";
  /* mirrored from errorClass.js (ACCOUNT_MODEL_REFUSED_RE) — keep the two in step: the ChatGPT Codex backend refuses a model
     this account may not run ("The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.", 2026-10-27),
     and every retry is refused the same way. It read "Something went wrong — try again"; another model is the fix. */
  const ACCOUNT_MODEL_RE = /model is not supported when using codex with a chatgpt account/;
  function accountModelMessage(raw) {
    const m = /the (['"])([a-z0-9][a-z0-9._/-]{0,119})\1 model is not supported when using codex/i.exec(String(raw || ''));
    return "ChatGPT won't run " + (m ? m[2] : 'this model') + ' on your account — pick a different model from the model dock in COMMS.';
  }
  /* mirrored from errorClass.js (namesUpstream): a 403 that names the UPSTREAM provider ("[…; provider xAI]" from the
     openai-compatible adapter, or OpenRouter's "Provider returned error") is that provider refusing this request — the
     router accepted our key (a rejected key is a 401 naming nobody). xai-403-1023. */
  const UPSTREAM_NAMED_RE = /provider returned error|[\[;] ?provider [^\];]+\]/;
  // the StarNet credit relay's per-call price ceiling (sidecar/providers/errorClass.js — keep the two in step)
  const CALL_TOO_EXPENSIVE_RE = /could cost more than the \$\d+(?:\.\d+)? starnet allows for one call|\bcall_too_expensive\b/;
  // quote the ceiling the relay named (it is configurable there), never a number of our own; claim nothing about what
  // the run cost (KINDS.call_too_expensive says why)
  function callTooExpensiveMessage(raw) {
    const m = /more than the (\$\d+(?:\.\d+)?) starnet allows/i.exec(String(raw || ''));
    if (!m) return KINDS.call_too_expensive.msg;
    return 'This conversation could now cost more per message than the ' + m[1] + ' StarNet allows for one call on this model, so StarNet refused the call. Start a fresh chat, or pick a cheaper model from the model dock in COMMS.';
  }
  // the upstream's name as the adapter's own allowlisted fact carries it — a plain brand name or nothing
  function upstreamName(raw) {
    const m = String(raw || '').match(/[\[;] ?provider ([^\];]+)\]/i);
    const nm = m ? m[1].trim() : '';
    return /^[A-Za-z0-9][A-Za-z0-9 .()-]{0,39}$/.test(nm) ? nm : '';
  }
  // a provider adapter's own failure sentence ("openrouter http 403 — …", "openai-compatible http 403 - …")
  const PROVIDER_HTTP_RE = /\b(?:openrouter|anthropic|gemini|codex|openai-compatible|grok \(xai\)|kimi for coding|xai) http \d{3}\b/;
  // the ONE sentence both classifier paths use for "no model is picked": the sidecar guard and the page preflight
  const NO_MODEL_RE = /\bno model selected\b/;
  /* WHICH grok failures mean "this account can't use Grok sign-in" (the allowlist yank)? Only ones that carry the
     OAuth surface's own voice: the adapter label "Grok (xAI) http 403", the refresh path's "xAI OAuth API access",
     or an explicit grok OAuth/sign-in phrase. The bare word "grok" is NOT enough: an XAI (API KEY) provider error
     names grok MODELS too, and sending that user to "add an xAI key" is a door onto the room they are already in. */
  const GROK_OAUTH_VOICE_RE = /grok \(xai\) http|grok[ _-]?oauth|grok sign-?in|xai[ _]oauth/;
  const GROK_ALLOWLIST_RE = /allowlist|not allowed|not enabled|not available|unavailable|access forbidden|\bforbidden\b|\b403\b/;
  /* StarNet's OWN spend-ledger refusal (sidecar/loop.js stopForSpend → failureCode spend_history_unavailable; every
     cause's sentence says "the spending limits you set can't be checked"), the failure code itself, and the older
     "spend history is unavailable" wording. Local by construction — never a provider's billing. */
  const SPEND_UNKNOWN_RE = /spending limits you set can['’]t be checked|spend[_ ]history[_ ](?:is[_ ])?unavailable/;
  // the spend_unknown headline, per cause — the loop's sentence names it; each keeps the SPENDING LIMITS door. The loop's
  // sentence ends with the way out it names for that cause (sidecar/budget.js unknownExit): a one-click one (COUNT AS, or
  // setting that limit to 0) is kept word for word, so the headline never offers less than the refusal did.
  function spendUnknownMessage(raw) {
    const low = String(raw || '').toLowerCase();
    const exit = (/can['’]t be checked\.\s+(.+)$/i.exec(String(raw || '')) || [])[1] || '';
    const oneClick = /\bCOUNT AS\b|\bto 0\b/.test(exit) ? ' ' + exit.trim() : '';
    if (/interrupted before its spend was recorded|earlier call has no settled charge/.test(low)) {
      return "Your spending limits can't be checked — an earlier call has an unsettled charge, so this run was stopped." + (oneClick || ' Settle that run in SETTINGS › SPENDING LIMITS.');
    }
    if (oneClick && /could not be read/.test(low)) return "Your spending limits can't be checked — StarNet couldn't read its spend history, so this run was stopped." + oneClick;
    // A damaged line stays uncertain until explicitly settled, even when a recovery estimate is available.
    if (/line (?:of|in) the spend record is damaged/.test(low)) {
      return "Your spending limits can't be checked — a line of StarNet's spend record is damaged, so what it recorded is unknown and this run was stopped." + (oneClick || ' Settle it in SETTINGS › SPENDING LIMITS.');
    }
    if (/could not be saved to disk/.test(low)) {
      return "Your spending limits can't be checked — StarNet couldn't save its spend history to disk, so this run was stopped. Restart StarNet to recover it; SETTINGS › SPENDING LIMITS shows the details.";
    }
    return KINDS.spend_unknown.msg;
  }

  /* The station's OWN sentences (sidecar/providers/errorClass.js templateRefusalText / unreachableNote / the TLS line): an error
     that carries no code still reads as what it is. stationSentence() lifts the sentence for the headline — the provider's raw
     text rides last in brackets and stays in raw. '' = the shape is not the station's (the KINDS fallback leads). */
  const TEMPLATE_SENTENCE_RE = /the chat template of .{0,240}? refused the conversation starnet sent/;
  const UNREACHABLE_NOTE_RE = /nothing is listening at .{1,160}? on this computer|the connection to .{1,160}? was refused —|the name .{1,160}? (?:did not resolve|could not be looked up)/;
  // a silent local /v1 server's turn end (sidecar/providers/openai-compatible.js localSilenceError): "… (connect phase), so this turn ended."
  const LOCAL_TIMEOUT_RE = /^the model server at \S+ on this (?:computer|network) .{1,240}? \((?:connect|first byte|between chunks) phase\), so this turn ended\./;
  function stationSentence(kind, raw) {
    // Strip only the final diagnostic block; an earlier IPv6 address is part of the station's explanation.
    const s = String(raw || '').replace(/\s*\[[^\[\]]*\]\s*$/, '').trim();
    const up = t => t.charAt(0).toUpperCase() + t.slice(1);
    let m = null;
    if (kind === 'local_timeout') {
      // the /v1 sentence is whole; the native Ollama one rides after the timeout words ("… — Ollama on this computer had …")
      if (LOCAL_TIMEOUT_RE.test(s.toLowerCase())) return s;
      m = / — (ollama (?:on this computer|at \S+) had [\s\S]+)$/i.exec(s);
      return m ? up(m[1]).replace(/\s*$/, '') + ' StarNet ended this turn without sending the prompt again.' : '';
    }
    if (kind === 'template_refusal') m = /\bthe chat template of [\s\S]+$/i.exec(s);
    else if (kind === 'unreachable') {
      m = /(?:nothing is listening at |the connection to \S+ was refused|the name \S+ (?:did not resolve|could not be looked up)|the name of the provider's server)[\s\S]*$/i.exec(s);
      return m ? 'StarNet is running, but ' + m[0].replace(/[.\s]*$/, '') + '.' : '';
    } else if (kind === 'tls_certificate') m = /\btls certificate verification failed[\s\S]*$/i.exec(s);
    return m ? up(m[0]) : '';
  }

  const MEMORY_RE = /^(?:local model|the model server at \S+) ran out of memory\./i;
  // minted only by the openai-compatible adapter when the OLLAMA card's URL answers as another server (notOllamaError)
  const WRONG_SERVER_RE = /^The OLLAMA card's URL(?: \([^)\s]*\))? is not an Ollama server:/;
  // Exact host readiness phrases, ahead of the backward-compatible missing-key HTTP prefix.
  function cliReadinessKind(raw) {
    const text = String(raw || '');
    if (/checking local sign-in for Claude Code/.test(text)) return 'claude_cli_checking';
    if (/local sign-in status unavailable for Claude Code/.test(text)) return 'claude_cli_status_unavailable';
    if (/Claude Code is not installed/.test(text)) return 'claude_cli_missing';
    if (/Claude Code is not signed in/.test(text)) return 'claude_cli_signed_out';
    return null;
  }
  function kindFromRaw(raw, status) {
    const low = String(raw || '').toLowerCase();
    if (MEMORY_RE.test(String(raw || ''))) return 'local_model_memory';
    if (WRONG_SERVER_RE.test(String(raw || ''))) return 'endpoint_mismatch';
    const cliKind = cliReadinessKind(raw);
    if (cliKind) return cliKind;
    // Harness pre-flight guards ("no API key set" / "no model selected"): a misconfig, not a fault — point at
    // Settings instead of offering a doomed retry. (Match before capdenied, which the em-dash-less strings miss.)
    if (/chatgpt.*sign-?in|sign-?in.*chatgpt|not signed in to chatgpt|codex_not_connected|codex auth|codex_auth|chatgpt subscription.*connect/.test(low)) return 'oauth';
    if (NO_MODEL_RE.test(low) && !/missing key\/model/.test(low)) return 'no_model';
    if (/no api key set|missing key\/model/.test(low)) return 'auth';
    // a forwarded capability denial ("no web — …" / "capdenied")
    if (/\bcapdenied\b/.test(low) || /^no\s+\w+\s+—/.test(low) || /needs a capability|capability.*(off|denied)/.test(low)) return 'capdenied';
    // the station's own sentences for a refused template / an address nothing answered at (sidecar/providers/errorClass.js) —
    // an error that carried no code still reads as what it is, ahead of the bare transport words inside it
    if (TEMPLATE_SENTENCE_RE.test(low)) return 'template_refusal';
    if (UNREACHABLE_NOTE_RE.test(low)) return 'unreachable';
    // …and a silent local server's turn end, ahead of the "timed out" words inside it (and of the overflow words an older one said)
    if (LOCAL_TIMEOUT_RE.test(low)) return 'local_timeout';
    // MUST precede isTransportLoss: that predicate also matches `fetch failed`, and whichever runs first owns the
    // verdict. Upstream is the more specific (and provable) reading, so it wins.
    if (isUpstreamFetchFailure(low)) return 'provider_unreachable';
    // the sidecar is unreachable (fetch threw — Harness throws "cannot reach the STARNET sidecar…")
    if (isTransportLoss(low)) return 'network';
    // content / policy beats a status
    if (/content[ _]?policy|moderation|flagged|safety|content_filter/.test(low)) return 'content_policy_blocked';
    // HTTP status from "sidecar HTTP <status>" or an explicit status arg
    const s = status || (low.match(/\b(?:http|status)\s+(\d{3})\b/) ? Number(RegExp.$1) : null);
    // an image refused by a model that cannot see it, whatever status carried it (errorClass.js reads it the same way)
    if (IMAGE_INPUT_RE.test(low) && s !== 401 && !(s === 429 || s === 408 || (s >= 500 && s < 600))) return 'model_not_found';
    // a model this ChatGPT account may not run (errorClass.js ACCOUNT_MODEL_REFUSED_RE): a resend is refused again
    if (ACCOUNT_MODEL_RE.test(low) && s !== 401 && !(s === 429 || s === 408 || (s >= 500 && s < 600))) return 'model_not_found';
    if (s) {
      // OUR OWN sidecar's token gate (crash+respawn → stale X-StarNet-Token): a "sidecar HTTP 403" throw or a
      // "forbidden token/origin/host" body means reload for the fresh boot token — never the provider-key door.
      // …but a PROVIDER's own "Forbidden" (its adapter label names it) is the provider's refusal, never this page's token
      if (s === 403 && (/sidecar http/.test(low) || (/\bforbidden\b/.test(low) && !PROVIDER_HTTP_RE.test(low)))) return 'stale_session';
      if (s === 403 && REGION_REFUSAL_RE.test(low)) return 'model_not_found';
      if (s === 403 && !NO_CREDIT_RE.test(low) && UPSTREAM_NAMED_RE.test(low)) return 'model_not_found';
      if (s === 401 || s === 403) return NO_CREDIT_RE.test(low) ? 'billing' : 'auth';
      if (s === 402) return /(resets? at|retry[- ]?after|rate limit)/.test(low) ? 'rate_limit' : 'billing';
      if (s === 404) return 'model_not_found';
      if (s === 408 || s === 504) return 'timeout';
      /* A 429 IS NOT ALWAYS "wait a few seconds". This fallback is the path REAL USERS take: classifyApiError
         above is require()-only (node/test), so in the browser every verdict comes from here. A
         ChatGPT-subscription weekly quota resets in DAYS, and an OpenAI account with no money answers
         `insufficient_quota` with 429 — neither clears by waiting, and offering ↻ Try again on either is a
         doomed instruction. Mirrors the same split in sidecar/providers/errorClass.js; keep the two in step. */
      if (s === 429) {
        if (quotaSpent(low)) return 'quota_exhausted';
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
      // the StarNet relay's per-call price ceiling (mirrors errorClass.js CALL_TOO_EXPENSIVE_RE — keep the two in step)
      if (s === 400 && CALL_TOO_EXPENSIVE_RE.test(low)) return 'call_too_expensive';
      if (s === 400 && REJECTED_KEY_RE.test(low)) return 'auth';
      // Anthropic's empty wallet is a 400 ("Your credit balance is too low … purchase credits"), not a bad request:
      // it read as `unknown` → "Something went wrong — try again" + report it (2026-10-07). Mirrors classify400.
      if (s === 400 && NO_CREDIT_RE.test(low)) return 'billing';
      if (s === 400 || s === 413 || s === 422) return /context length|maximum context|context window|too many tokens|reduce the length/.test(low) ? 'context_overflow' : 'unknown';
    }
    // message patterns (no status / in-band error text)
    if (CALL_TOO_EXPENSIVE_RE.test(low)) return 'call_too_expensive';
    // in-band provider overload phrasing, mirrored from sidecar/providers/errorClass.js — keep the two in step
    if (/overloaded|over capacity|temporarily unavailable|try again later/.test(low)) return 'provider_server_error';
    if (quotaSpent(low)) return 'quota_exhausted';
    if (/rate limit|too many requests|rate-limit/.test(low)) return 'rate_limit';
    // (kept in step with sidecar/providers/errorClass.js; a sign-in SUBSCRIPTION's "quota"/"insufficient" is re-read as its
    // spent plan allowance in friendlyError, which knows the provider — never "out of credit")
    if (/insufficient|out of credit|not enough credit|quota|payment required|add credits|billing/.test(low) || NO_CREDIT_RE.test(low)) return 'billing';
    if (/unauthorized|invalid api key|invalid key|no auth credentials|authentication|key was rejected|rejected/.test(low) || REJECTED_KEY_RE.test(low)) return 'auth';
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
    // TYPED OUTCOMES: the station's own failure code (opts.code — Harness.chat's errorCode — or a code the error object carries)
    // decides the kind through CODE_TO_KIND, in place of re-classifying the words; null when it names nothing specific
    const coded = codeKind((opts && opts.code) || (err && typeof err === 'object' ? err.failureCode : ''));
    // the station's own name for a refusal it answered (opts.stationCode, or err.stationCode from Harness.chat): STATION_CODE_TO_KIND
    const station = stationCodeOf(err, opts), stationRefusal = stationKind(station);
    // This prefix is minted only by the Ollama adapter after a concrete allocation failure. A server on another
    // machine keeps the adapter's own sentence (it names that machine); local advice would be untrue there.
    if (MEMORY_RE.test(raw)) {
      const k = KINDS.local_model_memory;
      const msg = /^local model/i.test(raw) ? k.msg : raw.replace(/\s*\[[\s\S]*$/, '');
      return { userMessage: msg, kind: 'local_model_memory', retryable: k.retryable, action: k.action, raw };
    }
    // The adapter's own sentence names the server it reached and the card that speaks to it: that is the headline (its
    // bracketed server words stay in raw), and the door lands on that CUSTOM card. Before this, COMMS led with "Something
    // went wrong on that turn — try again" and a retry that reaches the same server.
    if (WRONG_SERVER_RE.test(raw)) {
      const k = KINDS.endpoint_mismatch;
      return { userMessage: raw.replace(/\s*\[[\s\S]*$/, '') || k.msg, kind: 'endpoint_mismatch', retryable: k.retryable, action: k.action, provider: 'custom', raw };
    }
    // a StarNet-authored stop (loop guard, unkept promise, output-limit cut, hook…) leads with what happened and what
    // to do — before the user-abort test, whose /abort/ would otherwise claim a hook reason that mentions the word
    const harnessStop = (err && err.name === 'AbortError') ? null : explainStop(raw);
    if (harnessStop) {
      const hk = KINDS[harnessStop.kind] || KINDS.unknown;
      return { userMessage: harnessStop.text, kind: harnessStop.kind, retryable: hk.retryable, action: hk.action, raw: raw };
    }
    if (isUserAbort(err)) {
      const k = KINDS.user_abort;
      return { userMessage: k.msg, kind: 'user_abort', retryable: k.retryable, action: k.action, raw: raw };
    }
    let kind = null;
    // this page's own transport dropped (marked at Harness's throw site): a transport loss whatever words the
    // browser chose — the provenance is the proof, so no text ladder below may re-read it
    const transport = isTransportThrow(err);
    if (transport) {
      kind = 'network';
    } else if (STATION_GATE_CODES[station] === 1) {
      // the station's gate refused this page (its key, or its address) before any route ran: its code is the whole answer
      kind = stationRefusal;
    } else if (cliReadinessKind(raw)) {
      kind = cliReadinessKind(raw);
    } else
    // Managed-credit exhaustion (only emitted when a credits backend is wired) — a UI-level fault the sidecar
    // classifier doesn't model. Catch it before everything else so the CTA points at the STORE, not blind retry.
    // ONLY "out of managed credit" means an empty wallet: "Managed credits are unavailable" also says "managed credit",
    // and matching that as managed_credit told funded customers to top up whenever a balance check failed.
    if (/managed credits? (?:are |is )?unavailable/.test(raw.toLowerCase())) {
      kind = /refused this station'?s link|relink/.test(raw.toLowerCase()) ? 'managed_credit_link' : 'managed_credit_unavailable';
    } else if (/managed credits? (?:are |is )?held|balance is held by \d+ running starnet run/.test(raw.toLowerCase())) {
      kind = 'managed_credit_held';   // the balance sits in this station's own running runs' holds — never "out of credit"
    } else if (/managed credit|add credits in the store|out of managed credit/.test(raw.toLowerCase())) {
      kind = 'managed_credit';
    } else
    // xAI's Grok OAuth device flow can be 403-allowlisted off for an account: the backend says the OAuth surface
    // is unavailable/forbidden. That's a dead-end for RECONNECT, so route to the xAI (API KEY) provider instead.
    // Keyed on the OAuth surface's own voice (GROK_OAUTH_VOICE_RE), not the bare word "grok".
    if (GROK_OAUTH_VOICE_RE.test(raw.toLowerCase()) && GROK_ALLOWLIST_RE.test(raw.toLowerCase())) {
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
    } else if (NO_MODEL_RE.test(raw.toLowerCase()) && !/missing key\/model/.test(raw.toLowerCase())) {
      kind = 'no_model';
    } else if (/no api key set|missing key\/model/.test(raw.toLowerCase())) {
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
    } else if (!station && (/sidecar http 403\b/.test(raw.toLowerCase()) || (status === 403 && /\bforbidden\b/.test(raw.toLowerCase())))) {
      // OUR OWN sidecar's token gate said no (stale X-StarNet-Token after a crash+respawn) — UI-level, caught
      // BEFORE delegating: the sidecar API classifier would read a bare 403 as provider `auth` and the error row
      // would offer "🔑 Add a key", the wrong door (EL-11 FIX 2). The only fix is the fresh boot token → reload.
      // Only for a station that names no refusal: one that does said which 403 this was (the gate's code is read above).
      kind = 'stale_session';
    } else if (SPEND_UNKNOWN_RE.test(raw.toLowerCase())) {
      // StarNet's own spend ledger refused the run (UI-level: the provider classifier would call it `unknown` and
      // offer a doomed RETRY) — caught before delegating so both paths open SPENDING LIMITS.
      kind = 'spend_unknown';
    } else if (stationRefusal) {
      // a route's own refusal, named by its code: never re-read by the provider and status ladders below
      kind = stationRefusal;
    } else if (coded) {
      // the station already classified this failure (sidecar/providers/errorClass.js, or the loop's own stop): its code is the
      // kind. Only the HOP of a transport timeout is the page's to tell ("fetch failed" = the station could not reach the provider).
      kind = (coded === 'timeout' && isUpstreamFetchFailure(raw)) ? 'provider_unreachable' : coded;
    } else if (classifyApiError) {
      // delegate to the single-sourced truth table; synthesize the err shape it expects (status + message).
      try {
        const probe = (err && typeof err === 'object') ? err : new Error(raw);
        if (status != null && probe.status == null) { try { probe.status = status; } catch (_) {} }
        const verdict = classifyApiError(probe, {});
        kind = REASON_TO_KIND[verdict.reason] || 'unknown';
        // the station's own sentences read the same on both ladders (re-classifying them from a bare string loses the cause)
        if (TEMPLATE_SENTENCE_RE.test(raw.toLowerCase())) kind = 'template_refusal';
        else if (UNREACHABLE_NOTE_RE.test(raw.toLowerCase())) kind = 'unreachable';
        else if (LOCAL_TIMEOUT_RE.test(raw.toLowerCase())) kind = 'local_timeout';
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
    /* A sign-in subscription's spent plan (org P03, final round), on BOTH ladders: the fallbacks read any "insufficient" /
       "quota" / 402 as billing, and a ChatGPT plan 429 can read like any rate limit ("Codex quota exceeded" — its decisive
       code rides in a body the page never sees). When the adapter's own signature names a subscription provider, that
       is its plan allowance (a per-minute quota stays a rate limit). */
    // (a CODED rate limit stays one on the word alone: the station read the body's code the page never sees. The provider's own numbers still decide, code or no code)
    if ((kind === 'billing' || kind === 'rate_limit') && SUBSCRIPTION_IDS.indexOf(providerFromRaw(raw)) >= 0
        && (kind === 'billing' || planNumbersSpent(raw) || (!coded && quotaWordMeansSpent(raw)))) {
      kind = 'quota_exhausted';
    }
    const k = KINDS[kind] || KINDS.unknown;
    if (/^claude_cli_/.test(kind)) return { userMessage: k.msg, kind, retryable: k.retryable, action: k.action, provider: 'claude-cli', raw };
    // #158: "wait a few seconds" is only true of a few seconds: a longer stated wait is said as its own length
    if (kind === 'rate_limit') {
      const wait = statedWaitSeconds(raw);
      if (wait != null && wait >= 60) return { userMessage: 'The model provider is limiting requests and asks to wait ' + waitInWords(wait) + ' before trying again.', kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // a page the station kept its key from: say why, with no RELOAD door (a reload re-runs the same check). The gate's
    // token_missing says so (no key rode) whether or not this page knows its reason.
    if (kind === 'stale_session') {
      const withheld = withheldNotice() || (station === 'token_missing' ? TOKEN_WITHHELD_MSG : '');
      if (withheld) return { userMessage: withheld, kind: kind, retryable: false, action: null, withheld: true, raw: raw };
    }
    // the station's own refusal: its sentence leads (the code it named stays in raw), no door
    if (kind === 'station_refused') {
      const said = stationSaid(raw, station);
      const userMessage = !said ? k.msg : /^the station refused\b/i.test(said) ? said.charAt(0).toUpperCase() + said.slice(1) + '.' : 'The station refused this request: ' + said + '.';
      return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, stationCode: station, raw: raw };
    }
    if (kind === 'wrong_address') {
      return { userMessage: station === 'forbidden_host' ? 'StarNet answers only on localhost / 127.0.0.1 — reach it through a port forward, not a hostname.' : k.msg,
        kind: kind, retryable: k.retryable, action: k.action, stationCode: station, raw: raw };
    }
    // capdenied: name the exact power + gear parsed from the raw message, and route to BUILD MODE (the true unlock —
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
      // NEVER signed in is not "expired". The sidecar says "not signed in" / "sign in to <X> first" (or the
      // provider's *_not_connected code); a sign-in that died mid-life keeps the reconnect wording. The door
      // reads SIGN IN vs RECONNECT off `signedOut` (actionButton).
      const signedOut = /not signed in|not[ _-]?connected|sign in to [a-z0-9 ()]+ first|connect chatgpt first/.test(low);
      const userMessage = !nm ? (signedOut ? 'No ChatGPT sign-in yet — sign in under SETTINGS → AI\u00a0&\u00a0MODELS → CHATGPT\u00a0(CODEX), or add a provider key.' : k.msg)
        : !signedOut ? ('Your ' + nm + ' sign-in expired — reconnect it (or add a provider key instead).')
        : provider === 'grok'
          ? "Grok isn't signed in yet — sign in with your SuperGrok or X Premium+ account under SETTINGS → AI\u00a0&\u00a0MODELS → GROK\u00a0(XAI), or add an xAI API key instead."
          : "Kimi isn't signed in yet — sign in with your Kimi account under SETTINGS → AI\u00a0&\u00a0MODELS → KIMI\u00a0FOR\u00a0CODING, or add a provider key instead.";
      return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, provider: provider, signedOut: signedOut, raw: raw };
    }
    // auth: say WHICH credential is missing, or that the provider REJECTED one. "No model is connected yet" is only
    // true when nothing names a provider (a bare guard, a page preflight).
    if (kind === 'auth') {
      const low = raw.toLowerCase();
      const named = raw.match(/connect an? (.+?) api key\b/i);   // the sidecar guard: providerCredentialError()
      let userMessage = k.msg;
      if (/link this station to a starnet account/.test(low)) {
        userMessage = "This station isn't linked to StarNet credits yet — link it under SETTINGS → AI & MODELS → STARNET MANAGED, or connect your own provider key.";
      } else if (named) {
        userMessage = 'No ' + named[1].trim().replace(/\s+api$/i, '') + ' API key is connected yet — add it under SETTINGS → AI & MODELS, or pick a model from a provider you have already connected.';
      } else if (/configure the (.+?) base url/i.test(raw)) {
        userMessage = 'The ' + raw.match(/configure the (.+?) base url/i)[1].trim() + ' endpoint has no base URL yet — set it under SETTINGS → AI & MODELS.';
      } else if (/the station holds no (.+?) endpoint for its saved key/i.test(raw)) {
        // the run named an endpoint the station would not send its own key to (handleRun), and it holds none of its own
        userMessage = 'The station holds no ' + raw.match(/the station holds no (.+?) endpoint for its saved key/i)[1].trim() + ' endpoint for its saved key — re-save the base URL in SETTINGS → AI & MODELS.';
      } else if (providerFromRaw(raw) === 'codex') {
        // (org P03 wiring) a ChatGPT adapter 401/403 ('codex http 401 — …', after codex.js's one renew) is the sign-in being
        // refused, never "no model is connected" — the door beside it reads ⏼ RECONNECT CHATGPT (actionButton), and this copy
        // holds for an expired token (401) and a refused account (403) alike
        userMessage = 'ChatGPT refused this sign-in — reconnect it (or add a provider key instead).';
      } else if (!/sidecar http|chatgpt|codex/.test(low) && (REJECTED_KEY_RE.test(low) || /\bhttp (?:400|401|403)\b/.test(low))) {
        userMessage = 'The provider rejected the API key — check it, or paste a new one under SETTINGS → AI & MODELS.';
      }
      return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, provider: providerFromRaw(raw), raw: raw };
    }
    /* an UPSTREAM provider's 403 (xai-403-1023): the router (StarNet Cloud or OpenRouter) passed the request on, so the
       account and credits checks were met, and the provider behind it refused this request (xAI's safety check answers
       this way; the managed proxy keeps no reason). Say exactly that, never "your key" (a StarNet-credits user has
       none) — the model dock door stays (another model may answer); a region refusal keeps the model-unavailable copy. */
    if (kind === 'model_not_found') {
      const low = raw.toLowerCase();
      if (/\bhttp 403\b/.test(low) && UPSTREAM_NAMED_RE.test(low) && !REGION_REFUSAL_RE.test(low)) {
        const who = upstreamName(raw);
        const userMessage = (who ? who + ', the provider serving this model,' : 'The provider serving this model')
          + ' refused this request (HTTP 403), so the model did not answer. This is not a problem with your account or credits. Try rephrasing it, or pick a different model from the model dock in COMMS.';
        return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
      }
    }
    // billing: name the account that is out of credit when the error proves which provider it was (org P03) — a wallet
    // provider only: a sign-in subscription was turned into quota_exhausted above
    if (kind === 'billing') {
      const provider = providerFromRaw(raw);
      // OpenRouter's per-KEY credit limit: the key and the account may both be fine — the limit set on the key is the lever
      const nm = PROVIDER_PROSE[provider] || 'provider';
      const userMessage = /key limit exceeded/.test(raw.toLowerCase())
        ? 'This ' + nm + " key reached the credit limit set on it — raise that key's limit in your " + nm + ' key settings, or use a different key.'
        : provider && PROVIDER_PROSE[provider] ? 'Your ' + PROVIDER_PROSE[provider] + ' account is out of credit — top it up, then try again.' : k.msg;
      return { userMessage: userMessage, kind: kind, retryable: k.retryable, action: k.action, provider: provider, raw: raw };
    }
    // a spent plan allowance names the plan when it is a sign-in subscription's (quotaMessage); otherwise the neutral copy
    if (kind === 'quota_exhausted') {
      const provider = providerFromRaw(raw);
      // OpenRouter's free-model daily cap is not a plan: the levers are a paid model, credits, or tomorrow
      const msg = DAILY_FREE_CAP_RE.test(raw.toLowerCase())
        ? "OpenRouter's daily limit for free models is used up — it resets tomorrow (UTC), not in seconds. To keep working now, pick a paid model in the COMMS model dock, or add credits on OpenRouter to raise the free limit."
        : quotaMessage(provider, raw);
      return { userMessage: msg, kind: kind, retryable: k.retryable, action: k.action, provider: provider, raw: raw };
    }
    if (kind === 'spend_unknown') {
      return { userMessage: spendUnknownMessage(raw), kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    if (kind === 'call_too_expensive') {
      return { userMessage: callTooExpensiveMessage(raw), kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // a routine's pre-check: the script's own words are its detail (they name what failed, not what happened to the routine)
    if (kind === 'routine_precheck') {
      const detail = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return { userMessage: "This routine's pre-check script did not pass" + (detail ? ' (' + detail + ')' : '') + ', so its agent never ran. Fix the script in ROUTINES, then run it again.', kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // the station's own refusal sentence leads (typed outcomes: the kind came from its code), the kind's msg is only the fallback
    if (STATION_SENTENCE_KINDS[kind] === 1) {
      return { userMessage: String(raw || '').replace(/\s*\[[\s\S]*\]\s*$/, '').trim() || k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // the station's own sentence names the model/host/template (or which address did not answer): it leads, the fallback is generic
    if (kind === 'template_refusal' || kind === 'unreachable' || kind === 'tls_certificate' || kind === 'local_timeout') {
      return { userMessage: stationSentence(kind, raw) || k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // transport loss: the ONE kind whose copy names a component, so it is the one kind that owes proof. The
    // measured verdict rides along on `engineAlive` so a diagnostic report can state what was actually probed.
    // `transport` says whether THIS PAGE's connection provably dropped (a marked throw) — the only thing that may
    // arm COMMS's reconnect watch. An unmarked text keeps the network copy but never claims the connection was lost.
    if (kind === 'network') {
      return { userMessage: transportMessage(engineAlive), kind: kind, retryable: k.retryable, action: k.action, raw: raw, engineAlive: engineAlive, transport: transport };
    }
    // the model refused an IMAGE, not the request: say so, and the same model-dock door picks a vision model
    if (kind === 'model_not_found' && IMAGE_INPUT_RE.test(raw.toLowerCase())) {
      return { userMessage: IMAGE_INPUT_MSG, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    // ChatGPT refused the model for this account: name it, so the dock pick is obvious
    if (kind === 'model_not_found' && ACCOUNT_MODEL_RE.test(raw.toLowerCase())) {
      return { userMessage: accountModelMessage(raw), kind: kind, retryable: k.retryable, action: k.action, raw: raw };
    }
    return { userMessage: k.msg, kind: kind, retryable: k.retryable, action: k.action, raw: raw };
  }

  /* ---- Why a STARNET account-link start failed, from facts only (link-down 2026-10-07). Every failure used to read
     "could not reach the link service", which blamed the cloud for a dead LOCAL engine and gave support nothing.
     `info` is what the caller saw: { local:true } when the station's own POST never answered (a network failure or
     Harness.api's deadline), else { status, j, why } from the sidecar — j.reason is its stable classification of the
     cloud failure (sidecar/index.js linkStartFailure), and why is Harness.api.why's sentence for any other refusal (a
     plain-text or HTML refusal is an answer too: it is never "the engine isn't answering"). Lower-case lead, no trailing
     period (callers add their own). */
  function linkStartFailure(info) {
    const i = info || {}, j = i.j || {};
    if (i.local) return 'StarNet\'s engine on this computer isn\'t answering, so the link could not start — restart StarNet, then try again';
    if (i.status === 503 && j.degraded) return 'StarNet\'s engine on this computer stopped after an error, so the link could not start — restart StarNet, then try again';
    if (i.status === 404 && j.error === 'linking_unavailable') return 'account linking isn\'t available in this build of StarNet';
    const detail = j.detail ? ' (' + String(j.detail) + ')' : '';
    if (j.reason === 'tls') return 'security software on this computer (an antivirus HTTPS scan or a proxy) is blocking StarNet\'s secure connection to the StarNet account service' + detail + ' — allow StarNet, then try again';
    if (j.reason === 'timeout') return 'the StarNet account service did not answer in time — check a VPN or firewall, then try again';
    if (j.reason === 'dns' || j.reason === 'unreachable') return 'StarNet could not reach the StarNet account service from this computer' + detail + ' — check a VPN or firewall, then try again';
    if (j.reason === 'cloud_5xx') return 'the StarNet account service is having trouble right now — try again in a minute';
    if (/^cloud_\d+$/.test(String(j.reason || ''))) return 'the StarNet account service turned the link request down (http ' + String(j.reason).slice(6) + ') — try again';
    if (i.why) return 'the link could not start: ' + String(i.why);
    return 'could not reach the link service — try again';
  }

  /* ---- The DOOR: map a verdict to a ready-to-wire action button { label, run }. ONE place owns every
     error→surface route, so the consumer (chat.js offerRetry) never re-derives per-action labels/wiring, and a
     new door is added here alone. Returns null when the verdict has no actionable door (a plain retry / nothing).
     run() is a no-op-safe opener: it feature-detects each global (Build / StationUI / Harness) so it degrades
     quietly if a surface isn't loaded, never throwing. Routing is context-aware where it matters:
       • auth/oauth → if ChatGPT (Codex) is already connected, offer "sign in with ChatGPT"; else the key field.
       • capdenied  → BUILD MODE (Build.open) — place the missing gear the message just named.
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
  // org P03: a provider-named door lands ON that provider's card (StationUI.focusProvider scrolls to it and marks it);
  // `signin` also presses the card's own ⏼ SIGN IN / ⏼ RECONNECT, the same prov-oauth-signin flow a click starts.
  function openSettings(section, provider, opts) {
    if (typeof StationUI === 'undefined') return;
    try {
      if (section === 'providers' && provider && StationUI.focusProvider) { StationUI.focusProvider(provider, opts || {}); return; }
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
  /* ▸ PICK A MODEL. The model dock closes on any click OUTSIDE it (modeldock.js wire()), and this door is a chip in
     the COMMS log — so opening the dock synchronously let the SAME click bubble on to that closer, which shut it
     in the same tick and the door looked dead (live-caught 2026-09-27). Open after the originating click is done.
     Falls back to Settings only when the dock isn't mounted (headless/tests). */
  function pickModelDoor() {
    return { label: '▸ PICK A MODEL', run: () => {
      try {
        if (typeof ModelDock !== 'undefined' && ModelDock.open) {
          setTimeout(() => { try { ModelDock.open(); } catch (_) {} }, 0);
          return;
        }
      } catch (_) {}
      openSettings('models');
    } };
  }
  function actionButton(verdict) {
    if (!verdict) return null;
    switch (verdict.action) {
      case 'refit':
        return { label: '⚒ Open BUILD MODE', run: () => { try { if (typeof Build !== 'undefined' && Build.open) Build.open(); else if (typeof Build !== 'undefined' && Build.toggle && !(Build.isOpen && Build.isOpen())) Build.toggle(); } catch (_) {} } };
      case 'toolsets':
        // spotify_not_connected: the connect flow lives on the ABILITIES window's JUKEBOX row (setupSpotify) —
        // the only surface with a ▶ CONNECT SPOTIFY control. The action KEY stays 'toolsets' (internal, and the
        // shelf inside is still called TOOLSETS); only the LABEL follows the dock button, which reads ABILITIES.
        return { label: '⇄ OPEN ABILITIES', run: () => { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('connectors'); } catch (_) {} } };
      case 'settings': {
        if (/^claude_cli_/.test(verdict.kind)) return { label: '▸ OPEN CLAUDE CODE', run: () => openSettings('providers', 'claude-cli') };
        // org P03 — ONE label for the AI & MODELS door (▸ OPEN AI & MODELS), and it lands on the provider's card when
        // the error proves which provider it was. Sign-in doors keep the provider's name and press its sign-in.
        // Grok's OAuth sign-in is 403-allowlisted off for this account — the honest door is the xAI (API KEY)
        // provider, not a doomed reconnect. Lands on the XAI card, where its key field lives.
        if (verdict.kind === 'grok_oauth_unavailable')
          return { label: '▸ USE XAI (API KEY)', run: () => openSettings('providers', 'xai') };
        // A sign-in-class failure (dead/consumed refresh token, never signed in) ALWAYS gets the sign-in door — the
        // 2026-07-08 escape was exactly this error landing with only a generic "add a key" path. The door names the
        // provider whose sign-in died and runs that card's ⏼ SIGN IN / ⏼ RECONNECT (prov-oauth-signin): SIGN IN TO
        // when it was never signed in, RECONNECT when a sign-in expired.
        if (verdict.kind === 'oauth') {
          const pid = verdict.provider === 'grok' || verdict.provider === 'kimi' ? verdict.provider : 'codex';
          const verb = verdict.signedOut ? '⏼ SIGN IN TO ' : '⏼ RECONNECT ';
          return { label: verb + providerWord(pid), run: () => openSettings('providers', pid, { signin: true }) };
        }
        // no_model: a provider is connected, only the model is missing — the model dock is the door (and for a model whose chat
        // template refused the conversation: another model has another template)
        if (verdict.kind === 'no_model' || verdict.kind === 'local_model_memory' || verdict.kind === 'template_refusal' || verdict.kind === 'model_unsuitable' || verdict.kind === 'local_timeout') return pickModelDoor();
        // other auth/no-key: if ChatGPT is already the connected brain, the honest door is still "reconnect"
        // (a ChatGPT adapter failure names codex itself: its auth door is the same reconnect — it has no key to fix)
        if (verdict.kind === 'auth' && (verdict.provider === 'codex' || (codexConnected() && !verdict.provider)))
          return { label: '⏼ RECONNECT CHATGPT', run: () => openSettings('providers', 'codex', { signin: true }) };
        // model_not_found: the fix is repointing the PRIMARY model, which lives in the COMMS model dock —
        // NOT Settings→MODELS (that section is the fallback chain + class tiers and cannot change the primary;
        // sending users there was a door onto a room without the lever). Fall back to Settings only when the
        // dock isn't mounted (headless/tests).
        if (verdict.kind === 'model_not_found' || verdict.kind === 'call_too_expensive') return pickModelDoor();   // call_too_expensive's copy says pick a cheaper model in the dock
        // auth (add / fix a key), billing, quota: AI & MODELS, on the named provider's card when the error names one
        return { label: '▸ OPEN AI & MODELS', run: () => openSettings('providers', verdict.provider || null) };
      }
      case 'reload':
        // stale_session: the page holds a dead boot token — a reload is the ONE honest reconnect (the token is
        // injected at serve time; there is no in-page re-fetch handshake). Degrades quietly outside a browser.
        return { label: '↻ RELOAD & RECONNECT', run: () => { try { if (typeof location !== 'undefined' && location.reload) location.reload(); } catch (_) {} } };
      case 'store':
        // this door opens the PROVIDERS section (there is no "store") — name it truthfully with a CRT glyph.
        // managed credits: the STARNET MANAGED card (balance, LINK STATION) is the lever
        return { label: '▸ OPEN AI & MODELS', run: () => openSettings('providers', 'starnet') };
      case 'budget':
        // spend_unknown: SETTINGS › SPENDING LIMITS lists the interrupted runs to settle (or says restart) — the
        // only surface that clears the refusal. No retry chip rides with it: a retry hits the same refusal.
        return { label: '$ OPEN SPENDING LIMITS', run: () => openSettings('budget') };
      case 'skills':
        return { label: '✦ OPEN SKILLS', run: () => { try { if (typeof StationUI !== 'undefined' && StationUI.openTerm) StationUI.openTerm('skills'); } catch (_) {} } };   // 'skills' aliases into ABILITIES ▸ SKILLS (NAV CONDENSE 2)
      default:
        return null;
    }
  }

  return { friendlyError, actionButton, connectorDoor, connectorChipLabel, routeConsoleSearch, linkStartFailure, explainStop, stopLine, STOP_EXPLAINERS, KINDS, CAP_INFO,
    CODE_TO_KIND, codeKind, STATION_CODE_TO_KIND,
    _internals: { providerFromRaw, kindFromRaw, isTransportLoss, isTransportThrow, isUpstreamFetchFailure, isUserAbort, REASON_TO_KIND, capFromRaw, capdeniedMessage, codexConnected, transportMessage, stationSentence } };
});
