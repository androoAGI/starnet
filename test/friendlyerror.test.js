/* node test/friendlyerror.test.js — the beginner-facing error translator (frontend/app/friendlyerror.js).
   Focus: the zero-to-value paths — managed-credit exhaustion routes to the STORE, and the no-provider/auth
   state offers BOTH the ChatGPT sign-in and the add-a-key path (never a single dead-end). */
'use strict';
const A = require('./_assert.js');
const { friendlyError, actionButton, KINDS, CAP_INFO } = require('../frontend/app/friendlyerror.js');

/* ---- THE SIDECAR'S OUTBOUND CALL FAILED => name the PROVIDER, not the local service ----
   From a real 0.7.0 user report (2026-07-29): their diagnostics showed a healthy local engine serving the report
   itself, with five `fetch failed` entries — the sidecar could not reach chatgpt.com/api.openai.com — while the
   app told them "Can't reach StarNet's local service, restart it". They lost a day to it.
   The discriminator is word order and it is decisive: NODE/undici says "fetch failed", a BROWSER says "Failed to
   fetch". So `fetch failed` can only have been produced inside the sidecar and forwarded, i.e. the broken hop is
   sidecar -> provider. These assertions lock BOTH directions, because the whole defect was one string being
   claimed by the wrong bucket. */
for (const raw of [
  'fetch failed',
  'TypeError: fetch failed',
  'getaddrinfo ENOTFOUND api.openai.com',
  'getaddrinfo EAI_AGAIN chatgpt.com',
  'UND_ERR_CONNECT_TIMEOUT'
]) {
  const v = friendlyError(new Error(raw));
  A.eq(v.kind, 'provider_unreachable', raw + ' is an UPSTREAM failure, not a local one');
  A.eq(v.retryable, true, raw + ' is retryable (provider blips are usually transient)');
  A.eq(v.action, null, raw + ' keeps RETRY as the primary chip, not a SETTINGS door that fixes nothing');
  A.ok(!/local service/i.test(v.userMessage), raw + ' must NEVER blame the local service');
  A.ok(!/restart/i.test(v.userMessage), raw + ' must NEVER tell the user to restart the app');
  A.ok(/provider/i.test(v.userMessage), raw + ' names the AI provider as the failing hop');
  A.ok(/running fine/i.test(v.userMessage), raw + ' reassures the user their install is healthy');
}
// …and the browser-side wordings must NOT be captured by the upstream bucket (they really are local transport).
for (const raw of ['Failed to fetch', 'cannot reach the STARNET sidecar', 'terminated', 'Load failed']) {
  A.eq(friendlyError(new Error(raw)).kind, 'network', raw + ' stays a LOCAL transport verdict');
}

/* ⛔ THE BROWSER LADDER, TESTED DIRECTLY. Everything above ran under node, where friendlyerror successfully
   `require`s sidecar/providers/errorClass.js — so it exercised the DELEGATE path. Real users run the FALLBACK
   ladder (kindFromRaw), because in the browser classifyApiError is null. That asymmetry is exactly how the
   original defect shipped: the sidecar classifier already got undici transport codes right, so a node-only test
   looked green over the half no user ever executes. These assertions hit kindFromRaw directly. */
{
  const { kindFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  A.eq(kindFromRaw('fetch failed', null), 'provider_unreachable', 'BROWSER ladder: "fetch failed" -> upstream');
  A.eq(kindFromRaw('getaddrinfo ENOTFOUND api.openai.com', null), 'provider_unreachable', 'BROWSER ladder: node DNS text -> upstream');
  A.eq(kindFromRaw('failed to fetch', null), 'network', 'BROWSER ladder: the browser word order stays LOCAL');
  A.eq(kindFromRaw('cannot reach the starnet sidecar', null), 'network', 'BROWSER ladder: an explicit sidecar-unreachable stays LOCAL');
  // precedence guard: isTransportLoss also matches `fetch failed`, so whichever test runs first owns the verdict.
  const { isTransportLoss, isUpstreamFetchFailure } = require('../frontend/app/friendlyerror.js')._internals;
  A.ok(isTransportLoss('fetch failed'), 'isTransportLoss still matches "fetch failed" (so ORDER is load-bearing)');
  A.ok(isUpstreamFetchFailure('fetch failed'), 'isUpstreamFetchFailure claims it');
  A.ok(!isUpstreamFetchFailure('Failed to fetch'), 'isUpstreamFetchFailure must NOT claim the browser wording');
}

/* ---- transport loss during an established SSE stream => retryable `network`, never "unknown" ----
   THIS BLOCK USED TO ASSERT THE DEFECT (fixed 2026-07-29). It required every one of these strings to produce
   "local service / reload / restart" guidance. But these five are precisely the shapes undici emits when the
   MODEL PROVIDER's stream dies mid-answer, which the sidecar forwards verbatim — so the assertion was pinning
   in place a message that told users with a perfectly healthy install to restart and reinstall. A 0.7.0 user
   lost a day to it. The kind and retryability are unchanged (they drive behavior); what is now locked is that
   the COPY only ever names the local service when liveness was actually MEASURED. */
for (const raw of [
  'terminated',
  'socket hang up',
  'other side closed',
  'premature close',
  'read ECONNRESET'
]) {
  const v = friendlyError(new Error(raw));
  A.eq(v.kind, 'network', raw + ' classifies as a transport disconnect');
  A.eq(v.retryable, true, raw + ' remains retryable after the station returns');
  A.ok(/try again/i.test(v.userMessage), raw + ' still gives a concrete next step');
  // the regression guard: unprobed, it must not blame (or absolve) the local engine.
  A.eq(v.engineAlive, null, raw + ' unprobed => engineAlive null');
  A.ok(!/local service|restart/i.test(v.userMessage), raw + ' unprobed must NOT prescribe restarting the app');

  // measured DOWN => the restart advice is earned, and only here.
  const down = friendlyError(new Error(raw), null, { engineAlive: false });
  A.ok(/local service/i.test(down.userMessage), raw + ' + proven-down engine names the local service');
  A.ok(/restart/i.test(down.userMessage), raw + ' + proven-down engine prescribes a restart');

  // measured UP => naming the local service would be a lie; it must point at the stream instead.
  const up = friendlyError(new Error(raw), null, { engineAlive: true });
  A.ok(!/Can't reach/i.test(up.userMessage), raw + ' + proven-up engine never claims it is unreachable');
  A.ok(/reply stream/i.test(up.userMessage), raw + ' + proven-up engine names the reply stream');
  A.eq(up.retryable, true, raw + ' + proven-up engine is still retryable');
}

// ---- managed-credit exhaustion => STORE upsell (only reachable when a credits backend is wired) ----
{
  const v = friendlyError('Out of managed credit — add credits in the STORE to keep running (or connect your own provider key).');
  A.eq(v.kind, 'managed_credit', 'a managed-credit-out message classifies as managed_credit');
  A.eq(v.action, 'store', 'managed_credit routes the CTA to the STORE, not a blind retry');
  A.eq(v.retryable, false, 'an exhausted managed balance is not retryable as-is');
  // 2026-07-15 UX sweep: the copy now names the SAME door the CTA button opens (SETTINGS → PROVIDERS) —
  // "the STORE" was a surface that exists nowhere as a button (the old copy/button mismatch).
  A.ok(/credit/i.test(v.userMessage) && /AI & MODELS/.test(v.userMessage), 'the message names the credit problem and the AI & MODELS door (the same one the button opens)');
}

// ---- a FAILED balance check is not an empty wallet (customer report 2026-10-06: told to top up holding $79.24) ----
{
  const v = friendlyError('Managed credits are unavailable right now — the credits service did not answer (try again, or use your own provider key).');
  A.eq(v.kind, 'managed_credit_unavailable', 'an unanswered balance check is its own kind, never managed_credit');
  A.ok(!/out of|top up/i.test(v.userMessage), 'it never tells a funded user they are out of credits or to top up: ' + v.userMessage);
  A.ok(/credits are safe/i.test(v.userMessage), 'it says the credits are safe');
  A.eq(v.retryable, true, 'a failed check is retryable (the service hiccup passes)');
  A.eq(v.action, null, 'retry is the door, not a top-up');
}
// ---- the service REFUSED the station's link: relink, never top up ----
{
  const v = friendlyError("Managed credits are unavailable — your StarNet account refused this station's link (it was unlinked, or belongs to another account). Relink it under SETTINGS → AI & MODELS → STARNET MANAGED (or use your own provider key).");
  A.eq(v.kind, 'managed_credit_link', 'a refused link is its own kind');
  A.ok(/relink/i.test(v.userMessage) && !/out of|top up/i.test(v.userMessage), 'it points at relinking, never at a top-up: ' + v.userMessage);
  A.eq(v.action, 'store', 'the door is AI & MODELS, where the STARNET card relinks');
  A.eq(v.retryable, false, 'a refused link does not fix itself on retry');
}

// ---- no provider / auth => BOTH paths offered (ChatGPT sign-in OR add a key), pointed at Settings ----
{
  const v = friendlyError(new Error('no API key set'));
  A.eq(v.kind, 'auth', 'a pre-flight "no API key set" is an auth/misconfig, not a fault');
  A.eq(v.action, 'settings', 'auth points at Settings/CONNECTIONS where both paths live');
  A.ok(/chatgpt/i.test(v.userMessage) && /key/i.test(v.userMessage), 'the auth message offers BOTH the ChatGPT sign-in and the add-a-key path');
}
{
  // /api/run's pre-stream guard uses this exact 400 body. If the browser classifier misses it,
  // COMMS renders an unknown retryable fault and offers a doomed "Try again" loop.
  const v = friendlyError(new Error('sidecar HTTP 400 — missing key/model'));
  A.eq(v.kind, 'auth', 'the exact /api/run missing-credential body classifies as auth');
  A.eq(v.action, 'settings', 'the missing-credential response points at provider settings');
  A.eq(v.retryable, false, 'missing credentials never offer a blind retry');
  const btn = actionButton(v);
  A.ok(btn && /key|settings/i.test(btn.label), 'the recovery action opens the provider-key door');
}

// ---- expired ChatGPT sign-in => oauth, and still offers the key alternative ----
{
  const v = friendlyError(new Error('codex_not_connected'));
  A.eq(v.kind, 'oauth', 'a codex_not_connected error is an oauth reconnection case');
  A.eq(v.action, 'settings', 'oauth points at Settings to reconnect');
  A.ok(/key/i.test(v.userMessage), 'the oauth message still names the add-a-key alternative (never a single dead-end)');
}

// ---- a plain provider billing error (BYOK) stays `billing` -> Settings (NOT the managed STORE) ----
{
  const e = new Error('insufficient credit'); e.status = 402;
  const v = friendlyError(e, 402);
  A.eq(v.kind, 'billing', 'a BYOK provider out-of-credit is the generic billing kind');
  A.eq(v.action, 'settings', 'BYOK billing points at Settings (its own provider account), not the managed STORE');
}

// ---- the managed_credit kind exists in the table with the store action ----
{
  A.ok(KINDS.managed_credit && KINDS.managed_credit.action === 'store', 'KINDS carries a managed_credit entry actioned to the store');
}

// ---- capdenied v2: name the exact power + gear, and route to REFIT (the true unlock), NOT the SKILLS list ----
{
  // the sidecar/harness build a room-cap denial as "no <need> — <reason>"
  const v = friendlyError(new Error('no web — no capability for web.search in room comms'));
  A.eq(v.kind, 'capdenied', 'a "no web — …" denial classifies as capdenied');
  A.eq(v.cap, 'web', 'the missing capability is parsed off the raw message');
  A.eq(v.action, 'refit', 'capdenied routes to REFIT (place the gear), never the SKILLS list');
  A.ok(/WEB ACCESS/.test(v.userMessage), 'the copy names the human power (WEB ACCESS)');
  A.ok(/DISH/.test(v.userMessage), 'the copy names the placeable GEAR (DISH)');
  A.ok(/BUILD MODE/.test(v.userMessage), 'the copy points at BUILD MODE as the door');
}
{
  // a files denial names FILE ACCESS + the INTEL CAB (the real palette prop, not a generic "cabinet")
  const v = friendlyError(new Error('no cabinet — no capability for fs.write in room ops'));
  A.eq(v.cap, 'cabinet', 'a cabinet denial parses to cabinet');
  A.ok(/FILE ACCESS/.test(v.userMessage) && /INTEL CAB/.test(v.userMessage), 'the copy names FILE ACCESS + the INTEL CAB');
}
{
  // the compute (turn-precondition) denial the loop emits: "no compute — no compute capability …"
  const v = friendlyError(new Error('no compute — no compute capability — place a computer in the room'));
  A.eq(v.kind, 'capdenied', 'the compute gate denial is a capdenied');
  A.eq(v.cap, 'compute', 'compute parses as the capability');
  A.eq(v.action, 'refit', 'the compute gate also routes to REFIT (place a DESK)');
}
{
  // an unparseable capdenied still classifies + routes to REFIT with the generic (no-cap) copy
  const v = friendlyError(new Error('capdenied'));
  A.eq(v.kind, 'capdenied', 'a bare "capdenied" token still classifies');
  A.eq(v.action, 'refit', 'it still routes to REFIT');
  A.eq(v.cap, null, 'no capability could be parsed → cap is null');
  A.ok(/BUILD MODE/.test(v.userMessage), 'the fallback copy still names BUILD MODE');
  A.ok(!/undefined/.test(v.userMessage), 'the fallback copy never leaks "undefined"');
}

// ---- EL-11 FIX 2: sidecar 403 (stale X-StarNet-Token after crash+respawn) => the RELOAD door, never the key door ----
{
  // the exact shape Harness.chat throws after the body-preserving fix (body: "forbidden token")
  const v = friendlyError(new Error('sidecar HTTP 403 — forbidden token'));
  A.eq(v.kind, 'stale_session', 'a sidecar 403 classifies as stale_session, not auth');
  A.eq(v.action, 'reload', 'the door is a reload, never the provider-key field');
  A.eq(v.retryable, false, 'a stale token is not fixed by a blind retry');
  A.ok(/restart/i.test(v.userMessage) && /reload/i.test(v.userMessage), 'the copy says the station restarted and to reload');
  const btn = actionButton(v);
  A.ok(btn && /reload/i.test(btn.label) && typeof btn.run === 'function', 'actionButton yields a RELOAD door');
  A.ok(!/key/i.test(btn.label), 'the label never offers "Add a key" for a stale session');
  let threw = false; try { btn.run(); } catch (_) { threw = true; }
  A.ok(!threw, 'the reload run() degrades quietly with no location global (node)');
}
{
  // the pre-fix bare shape (no body) must ALSO take the reload door — old streams/paths still throw it
  A.eq(friendlyError(new Error('sidecar HTTP 403')).kind, 'stale_session', 'a bare "sidecar HTTP 403" is a stale session');
  // and a caller passing the status separately with the sidecar's raw body text
  A.eq(friendlyError(new Error('forbidden token'), 403).kind, 'stale_session', 'status 403 + "forbidden token" body is a stale session');
  // a PROVIDER 403 (no sidecar-gate marker) keeps the auth path — only the sidecar's own gate means "reload"
  A.eq(friendlyError(new Error('invalid api key'), 403).kind, 'auth', 'a provider 403 (key rejected) still classifies as auth');
}

// ---- EL-11 FIX 3 (ladder half): a pre-stream sidecar failure that CARRIES its body reaches the oauth door ----
{
  // handleRun throws pre-stream via runRouteFailure: 500 {"error":"sidecar failure: Not signed in to ChatGPT …"}.
  // With the body preserved by Harness.chat, the ladder must land on oauth → RECONNECT CHATGPT (EL-10 family).
  const v = friendlyError(new Error('sidecar HTTP 500 — sidecar failure: Not signed in to ChatGPT — connect a ChatGPT subscription first. (codex_not_connected)'));
  A.eq(v.kind, 'oauth', 'a pre-stream codex_not_connected body classifies as oauth once the body survives');
  const btn = actionButton(v);
  A.ok(btn && /RECONNECT CHATGPT/i.test(btn.label), 'the door is RECONNECT CHATGPT, not a generic retry');
}

// ---- no "max_iters"-style raw token leaks in any KINDS message (jargon hygiene) ----
{
  const bad = /max_iters|max_tokens|sidecar HTTP|429|4\d\d|\bnull\b|undefined|capdenied|_[a-z]+_/;
  for (const [k, def] of Object.entries(KINDS)) {
    A.ok(!bad.test(def.msg), 'KINDS.' + k + ' message carries no technical token: ' + def.msg);
  }
}

// ---- actionButton: maps a verdict to a wireable { label, run } door; null when there is no door ----
{
  const cap = friendlyError(new Error('no web — denied'));
  const btn = actionButton(cap);
  A.ok(btn && /BUILD MODE/i.test(btn.label) && typeof btn.run === 'function', 'a capdenied verdict yields a BUILD MODE button with a run()');
  A.eq(actionButton({ action: null, retryable: true }), null, 'a plain-retry verdict yields no action button');
  A.eq(actionButton(null), null, 'a null verdict yields no button (never throws)');
  // run() is safe to call with no globals present (Build/StationUI undefined in node) — must not throw.
  let threw = false; try { btn.run(); } catch (_) { threw = true; }
  A.ok(!threw, "the REFIT button's run() degrades quietly when no surface is loaded");
  // auth (no ChatGPT connected in node) → a key/settings door
  const authBtn = actionButton(friendlyError(new Error('no API key set')));
  A.ok(authBtn && typeof authBtn.run === 'function' && /key|settings/i.test(authBtn.label), 'an auth verdict yields a key/settings door');
}

// ---- CAP_INFO covers every capId the sidecar can deny (parity guard against a missing gear entry) ----
{
  for (const id of ['compute', 'web', 'cabinet', 'workbench', 'memory', 'studio', 'jukebox', 'orchestrator']) {
    A.ok(CAP_INFO[id] && CAP_INFO[id].power && CAP_INFO[id].gear, 'CAP_INFO names a power + gear for ' + id);
  }
}

/* ---- a SPENT ALLOWANCE must not be dressed up as a busy moment ------------------------------------
   A ChatGPT-subscription weekly quota resets in DAYS. The old copy said "wait a few seconds and try again"
   with retryable:true, so the row offered a doomed retry and named nothing the user could act on. */
{
  const q = friendlyError(Object.assign(new Error("codex http 429 — You've hit your usage limit. Resets in 3 days"), { status: 429 }));
  A.eq(q.kind, 'quota_exhausted', 'a spent allowance gets its own kind');
  A.eq(q.retryable, false, 'no doomed retry is offered');
  A.ok(!/wait a few seconds|too many requests/i.test(q.userMessage), 'and the busy-provider copy is gone');
  A.ok(/allowance is used up/i.test(q.userMessage), 'the copy says the allowance is spent');
  A.ok(/weekly/i.test(q.userMessage), 'and names the subscription schedule, not a seconds-scale wait');
  A.ok(/AI & MODELS/.test(q.userMessage), 'and points at a door that can keep the work moving now');
  A.eq(q.action, 'settings', 'the action opens that door');
  const exactReport = friendlyError(Object.assign(new Error('codex http 429 — The usage limit has been reached'), { status: 429 }));
  A.eq(exactReport.kind, 'quota_exhausted', 'the exact Codex diagnostics wording is a spent allowance');
  A.eq(exactReport.retryable, false, 'the exact Codex diagnostics wording offers no doomed retry');
  // a real rate limit is untouched
  const rl = friendlyError(Object.assign(new Error('openrouter http 429 — slow down'), { status: 429 }));
  A.eq(rl.kind, 'rate_limit', 'a plain 429 is still a rate limit');
  A.eq(rl.retryable, true, 'and still offers a retry');
}

/* ---- THE BROWSER PATH, which is the one real users take -------------------------------------------
   friendlyerror.js pulls the sidecar's classifyApiError in through `require` — "never required in the
   browser", says its own comment. So under node every verdict comes from the shared truth table, and in the
   BROWSER every verdict comes from the kindFromRaw fallback. A test that only runs under node therefore
   proves the half users never execute: this exact gap is why the live app still said "the provider is busy"
   for a spent weekly quota after the shared table had already been fixed. Load the module with no `require`
   in scope — a real browser sandbox — and assert the fallback on the shapes Harness actually throws. */
{
  const vm = require('vm');
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__F = Friendly;', sandbox, { filename: 'friendlyerror.js' });
  const B = sandbox.__F;
  A.ok(B && typeof B.friendlyError === 'function', 'the module loads with no require() in scope (the browser shape)');

  const kindOf = (m, st) => B.friendlyError(m, st);
  const weekly = kindOf("sidecar HTTP 429 — codex: You've hit your usage limit. Resets in 3 days");
  A.eq(weekly.kind, 'quota_exhausted', 'BROWSER: a spent weekly allowance is quota_exhausted');
  A.eq(weekly.retryable, false, 'BROWSER: and offers no doomed retry');
  A.ok(/allowance is used up/i.test(weekly.userMessage), 'BROWSER: with copy that names the spent allowance');
  A.ok(!/wait a few seconds/i.test(weekly.userMessage), 'BROWSER: and never the busy-provider line');
  const exactReport = kindOf('sidecar HTTP 429 — codex: The usage limit has been reached');
  A.eq(exactReport.kind, 'quota_exhausted', 'BROWSER: the exact Codex diagnostics wording is a spent allowance');
  A.eq(exactReport.retryable, false, 'BROWSER: the exact Codex diagnostics wording offers no doomed retry');

  A.eq(kindOf('sidecar HTTP 429 — gemini: Quota exceeded for quota metric: requests per minute').kind, 'rate_limit',
    'BROWSER: a PER-MINUTE quota stays a plain rate limit');
  A.eq(kindOf('sidecar HTTP 429 — rate limited, slow down').kind, 'rate_limit', 'BROWSER: a bare 429 is unchanged');
  A.eq(kindOf('sidecar HTTP 429 — openai: insufficient_quota').kind, 'billing',
    'BROWSER: an out-of-money account is billing, not a busy provider');
  // StarNet's OWN spend-ledger errors say 'continuing with spending limits'; they are not a provider out of credit
  for (const own of ['Spend history is unavailable or not durably saved. Restore the ledger and restart StarNet before continuing with spending limits.',
    'An interrupted run has unsettled spend; reconcile its provider usage before continuing with spending limits.']) {
    A.ok(kindOf(own).kind !== 'billing', 'BROWSER: a local spend-ledger error is not told to top up the provider: ' + own.slice(0, 40));
  }
  A.eq(kindOf("codex: You've hit your usage limit. Resets in 3 days", 429).kind, 'quota_exhausted',
    'BROWSER: the explicit status argument works too');
  // the shared table and the fallback must agree, or the two halves drift again
  A.eq(kindOf("sidecar HTTP 429 — codex: You've hit your usage limit. Resets in 3 days").kind,
    friendlyError(Object.assign(new Error("codex http 429 — You've hit your usage limit. Resets in 3 days"), { status: 429 })).kind,
    'the browser fallback and the shared sidecar table give the SAME verdict');
}

/* ---- PROVIDER 5xx/OVERLOAD => name the PROVIDER's servers, never the local service (2026-07-30) ----
   The report wave behind this: users seeing "servers are unavailable out of the blue" during industry-wide
   provider load spikes, because every provider 500/529/"overloaded" landed on the server_error copy that says
   "The LOCAL StarNet service hit an error". A message naming a component owes proof it is at fault. The
   discriminator is EVIDENCE in the raw: provider phrasing or a provider name → provider; a "sidecar HTTP 5xx"
   with neither → the one case where our own route demonstrably answered, and only THAT keeps the local copy. */
{
  const { kindFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  // in-band adapter labels (the dominant real path: the provider answered 5xx mid-run)
  for (const raw of [
    'Anthropic http 529 - Overloaded',
    'OpenRouter http 503 - upstream is overloaded, try again later',
    'Anthropic http 500 - internal server error',
    'openai: The server is temporarily unavailable'
  ]) {
    const v = friendlyError(new Error(raw));
    A.eq(v.kind, 'provider_server_error', raw + ' is the PROVIDER\'s server fault (delegate path)');
    A.eq(kindFromRaw(raw.toLowerCase(), null), 'provider_server_error', raw + ' — BROWSER ladder agrees');
    A.eq(v.retryable, true, raw + ' is retryable (load spikes pass)');
    A.ok(!/local .*service|starnet service/i.test(v.userMessage) || /StarNet itself is fine/i.test(v.userMessage),
      raw + ' must NEVER blame the local service');
    A.ok(/provider/i.test(v.userMessage), raw + ' names the provider\'s servers');
    A.ok(/fine/i.test(v.userMessage), raw + ' reassures the user their install is healthy');
  }
  // a proxied provider body under the sidecar prefix still reads as the provider's fault
  A.eq(kindFromRaw('sidecar http 503 — anthropic: overloaded', null), 'provider_server_error',
    'a PROXIED provider overload under the sidecar prefix is still the provider');
  // …but a sidecar 5xx with NO provider evidence in the body is genuinely local, both ladders
  A.eq(kindFromRaw('sidecar http 500 — internal error', null), 'server_error',
    'BROWSER: a bare sidecar 500 keeps the local-service copy');
  A.eq(friendlyError(Object.assign(new Error('sidecar HTTP 500 — internal error'), { status: 500 })).kind,
    'server_error', 'DELEGATE: a bare sidecar 500 keeps the local-service copy');
  A.ok(/local starnet service/i.test(KINDS.server_error.msg), 'the local copy still exists for the proven-local case');
  // the two ladders must agree on the flagship shape, or the halves drift again
  A.eq(kindFromRaw('anthropic http 529 - overloaded', null),
    friendlyError(new Error('Anthropic http 529 - Overloaded')).kind,
    'browser fallback and delegate give the SAME verdict on a provider overload');
}

/* ---- A SUPERGROK USER WAS TOLD TO "SIGN IN WITH CHATGPT" (2026-09-27 user report) ----
   The /api/run guard answered a bare "missing key/model" for a signed-out GROK OAUTH station, and every one of
   these read "No model is connected yet — add a provider key (or sign in with ChatGPT)". Each failure now names
   its own provider and its own door. Both ladders (delegate + browser kindFromRaw) must agree. */
{
  const { kindFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  // signed-out GROK OAUTH (the guard now names the provider via providerCredentialError)
  const signedOut = friendlyError(new Error('sidecar HTTP 400 — missing key/model — sign in to GROK OAUTH first - a signed-in subscription + model are required'));
  A.eq(signedOut.kind, 'oauth', 'signed-out grok guard -> the oauth sign-in class');
  A.eq(signedOut.provider, 'grok', 'it names grok');
  A.eq(signedOut.signedOut, true, 'it knows the account was never signed in');
  A.ok(/grok isn't signed in yet/i.test(signedOut.userMessage), 'copy says Grok is not signed in (got: ' + signedOut.userMessage + ')');
  A.ok(!/chatgpt|expired/i.test(signedOut.userMessage), 'copy never sends a Grok user to ChatGPT, never claims an expiry');
  A.ok(/supergrok/i.test(signedOut.userMessage) && /key/i.test(signedOut.userMessage), 'copy names the subscription sign-in AND the key alternative');
  A.eq(actionButton(signedOut).label, '⏼ SIGN IN TO GROK', 'the door reads SIGN IN TO GROK');
  // the run path's own sign-in failure (tokens missing at run time) reads the same
  const runPath = friendlyError(new Error('GROK OAUTH sign-in needed: Not signed in to GROK OAUTH — connect it first.'));
  A.eq(runPath.signedOut, true, 'the run-path "Not signed in" error is signed-out, not expired');
  // …while a refresh that DIED mid-life keeps the reconnect wording
  const died = friendlyError(new Error('GROK OAUTH sign-in needed: refresh token rejected — sign in again'));
  A.eq(died.kind, 'oauth', 'a dead grok refresh is the oauth class');
  A.eq(died.signedOut, false, 'a dead refresh is not "never signed in"');
  A.eq(actionButton(died).label, '⏼ RECONNECT GROK', 'a dead grok refresh reads RECONNECT GROK');
  // a keyed provider with no key: name it
  const noKey = friendlyError(new Error('sidecar HTTP 400 — missing key/model — connect a XAI API key'));
  A.eq(noKey.kind, 'auth', 'a keyed guard stays auth');
  A.ok(/No XAI API key is connected yet/.test(noKey.userMessage), 'the missing-key copy names XAI (got: ' + noKey.userMessage + ')');
  A.ok(!/chatgpt/i.test(noKey.userMessage), 'a keyed provider miss does not mention ChatGPT');
  A.eq(actionButton(noKey).label, '＋ Add a key', 'the keyed door is still the key field');
  // a provider whose label already ends in API ("OPENAI API") must not read "OPENAI API API key"
  const openaiKey = friendlyError(new Error('sidecar HTTP 400 — missing key/model — connect a OPENAI API API key'));
  A.ok(/No OPENAI API key is connected yet/.test(openaiKey.userMessage) && !/API API/.test(openaiKey.userMessage),
    'the missing-key copy never doubles API (got: ' + openaiKey.userMessage + ')');
  // an endpoint with no base URL says so, not the generic "No model is connected yet"
  const noBase = friendlyError(new Error('sidecar HTTP 400 — missing key/model — configure the CUSTOM base URL'));
  A.ok(/CUSTOM endpoint has no base URL yet/.test(noBase.userMessage), 'a missing base URL is named (got: ' + noBase.userMessage + ')');
  // a connected provider with no model picked
  const noModel = friendlyError(new Error('sidecar HTTP 400 — no model selected — pick a model for GROK OAUTH first'));
  A.eq(noModel.kind, 'no_model', 'no model -> no_model');
  A.eq(noModel.retryable, false, 'no_model offers no blind retry');
  A.eq(actionButton(noModel).label, '▸ PICK A MODEL', 'no_model opens the model dock');
  A.eq(kindFromRaw('sidecar http 400 — no model selected — pick a model for grok oauth first', 400), 'no_model', 'BROWSER ladder agrees on no_model');
  // xAI rejected the key (400) / has no credits (403): say so, not "no model is connected"
  const rejected = friendlyError(Object.assign(new Error('openai-compatible http 400 - {"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}'), { status: 400 }));
  A.eq(rejected.kind, 'auth', 'xAI bad key -> auth');
  A.ok(/rejected the API key/i.test(rejected.userMessage), 'a rejected key is described as rejected (got: ' + rejected.userMessage + ')');
  const broke = friendlyError(Object.assign(new Error('openai-compatible http 403 - {"code":"The caller does not have permission to execute the specified operation","error":"Your newly created team doesn\'t have any credits yet. You can purchase credits on https://console.x.ai/team/x."}'), { status: 403 }));
  A.eq(broke.kind, 'billing', 'xAI no credits -> billing');
  A.ok(/out of credit/i.test(broke.userMessage), 'the billing copy says the account is out of credit');
  // the grok ALLOWLIST door is keyed on the OAuth surface's voice, not on the word "grok" in an XAI key error
  const keyed403 = friendlyError(new Error('openai-compatible http 403 - {"error":"The caller does not have permission to use model grok-4.7"}'));
  A.ok(keyed403.kind !== 'grok_oauth_unavailable', 'an XAI (API KEY) 403 naming a grok model is NOT the grok-sign-in allowlist door (got ' + keyed403.kind + ')');
  A.eq(friendlyError(new Error('Grok (xAI) http 403 - {"code":"The caller does not have permission to execute the specified operation"}')).kind, 'grok_oauth_unavailable',
    'a GROK OAUTH 403 still routes to the xAI key door');
  A.eq(friendlyError(new Error('This account is not enabled for xAI OAuth API access (403). Use the XAI (API KEY) provider instead.')).kind, 'grok_oauth_unavailable',
    'the refresh path\'s allowlist sentence routes there too');
}

A.report('friendlyerror.test');
