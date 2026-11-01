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
  A.eq(btn && btn.label, '▸ OPEN AI & MODELS', 'the recovery action opens AI & MODELS (org P03: one label for that door)');
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
// ---- a page the station KEPT its key from is not a restarted station (review threads-backend-05 / sidecar-index-06) ----
// The sidecar withholds the key when it cannot prove this browser runs as its own OS user; every keyed call then 403s
// exactly like a stale page, but a reload re-runs the same check — "the station restarted — reload" is false and a dead door.
{
  const NOTICE = 'StarNet could not confirm this browser runs as your own user account (the ownership check timed out or failed), so it won’t take commands from this page. TEST NOTICE';
  const withheldHarness = { tokenWithheld: () => 'lookup-failed', tokenWithheldNotice: () => NOTICE };
  globalThis.Harness = withheldHarness;
  try {
    for (const [err, status] of [[new Error('sidecar HTTP 403 — forbidden token')], [new Error('sidecar HTTP 403')], [new Error('forbidden token'), 403]]) {
      const v = friendlyError(err, status);
      A.eq(v.userMessage, NOTICE, 'a withheld page leads with the station\'s own withheld notice: ' + err.message);
      A.ok(!/restart|reload/i.test(v.userMessage), 'a withheld page never claims a restart or offers a reload');
      A.eq(v.action, null, 'a withheld page gets no RELOAD door (a reload re-runs the same check)');
      A.eq(actionButton(v), null, 'actionButton offers no door for a withheld page');
      A.eq(v.retryable, false, 'a withheld page is not fixed by a retry');
      A.eq(v.withheld, true, 'the verdict says the key was withheld (diagnostics)');
    }
    A.eq(friendlyError(new Error('invalid api key'), 403).kind, 'auth', 'a provider 403 on a withheld page is still the provider\'s auth');
    // a Harness without the notice still never says "restarted"
    globalThis.Harness = { tokenWithheld: () => 'other-user' };
    const bare = friendlyError(new Error('sidecar HTTP 403'));
    A.ok(/STARNET_TRUST_LOCAL_PEERS=1/.test(bare.userMessage) && !/restart(ed)? —|reload/i.test(bare.userMessage), 'the fallback withheld copy names the escape hatch: ' + bare.userMessage);
    // a page that DOES hold a key keeps the stale-session reload door
    globalThis.Harness = { tokenWithheld: () => '' };
    const stale = friendlyError(new Error('sidecar HTTP 403 — forbidden token'));
    A.ok(stale.kind === 'stale_session' && stale.action === 'reload' && /restarted/.test(stale.userMessage), 'a keyed page\'s stale 403 keeps the restart + reload copy');
  } finally { delete globalThis.Harness; }
}

// ---- EL-11 FIX 3 (ladder half): a pre-stream sidecar failure that CARRIES its body reaches the oauth door ----
{
  // handleRun throws pre-stream via runRouteFailure: 500 {"error":"sidecar failure: Not signed in to ChatGPT …"}.
  // With the body preserved by Harness.chat, the ladder must land on oauth → RECONNECT CHATGPT (EL-10 family).
  const v = friendlyError(new Error('sidecar HTTP 500 — sidecar failure: Not signed in to ChatGPT — connect a ChatGPT subscription first. (codex_not_connected)'));
  A.eq(v.kind, 'oauth', 'a pre-stream codex_not_connected body classifies as oauth once the body survives');
  const btn = actionButton(v);
  A.eq(btn && btn.label, '⏼ SIGN IN TO CHATGPT', 'a never-signed-in ChatGPT reads SIGN IN TO CHATGPT (org P03), not a generic retry');
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
  A.ok(authBtn && typeof authBtn.run === 'function' && authBtn.label === '▸ OPEN AI & MODELS', 'an auth verdict yields the ▸ OPEN AI & MODELS door');
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

/* ---- bug 06331054: a ChatGPT plan has a SHORT window (hours) and a weekly one ----------------------------
   "resets weekly" sent a user whose multi-hour window was spent away for days. The copy names both windows, and
   quotes the provider's own reset time when the error carries one. */
{
  const bare = friendlyError(Object.assign(new Error('codex http 429 — The usage limit has been reached'), { status: 429 })).userMessage;
  A.ok(/a few hours for the short window, up to a week for the weekly one/.test(bare), 'ChatGPT: both windows are named: ' + bare);
  A.ok(!/resets weekly/.test(bare), 'ChatGPT: never "resets weekly" as if that were the only window');
  const said = friendlyError(Object.assign(new Error("codex http 429 — You've hit your usage limit. Resets in 3 days"), { status: 429 })).userMessage;
  A.ok(/ChatGPT says it resets in 3 days\. To keep working now/.test(said), 'ChatGPT: the provider\'s own reset time is quoted: ' + said);
  const soon = friendlyError(Object.assign(new Error("codex http 429 — You've hit your usage limit. Try again in 4h 12m."), { status: 429 })).userMessage;
  A.ok(/ChatGPT says it resets in 4h 12m\./.test(soon), 'ChatGPT: a short-window reset is quoted too: ' + soon);
  const kimi = friendlyError(Object.assign(new Error('Kimi For Coding http 429 - weekly limit reached, resets in 2 days'), { status: 429 })).userMessage;
  A.ok(/^Your Kimi plan allowance is used up — it resets on Kimi's own schedule, not in seconds\. Kimi says it resets in 2 days\./.test(kimi), 'another plan quotes its reset the same way: ' + kimi);
  A.ok(!/resets weekly/.test(KINDS.quota_exhausted.msg) && /weekly/.test(KINDS.quota_exhausted.msg) && /hours/.test(KINDS.quota_exhausted.msg),
    'the provider-neutral copy names both ChatGPT windows: ' + KINDS.quota_exhausted.msg);
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
  // StarNet's OWN spend-ledger errors name 'the spending limits you set'; they are not a provider out of credit
  // (sidecar/loop.js stopForSpend, one line per cause: an interrupted run, a failed save, an unreadable record)
  for (const own of ['An earlier run was interrupted before its spend was recorded, so the spending limits you set can’t be checked. Settle it in SETTINGS › SPENDING LIMITS.',
    'Spend history could not be saved to disk, so the spending limits you set can’t be checked. Restart StarNet to recover it.',
    'Spend history could not be read, so the spending limits you set can’t be checked. See SETTINGS › SPENDING LIMITS.']) {
    A.ok(kindOf(own).kind !== 'billing', 'BROWSER: a local spend-ledger error is not told to top up the provider: ' + own.slice(0, 40));
    // its own kind on BOTH paths: a truthful headline, the SPENDING LIMITS door, and no doomed RETRY chip
    for (const v of [kindOf(own), friendlyError(new Error(own))]) {
      A.eq(v.kind, 'spend_unknown', 'a local spend-ledger refusal is spend_unknown: ' + own.slice(0, 40));
      A.eq(v.retryable, false, 'spend_unknown offers no retry (a retry hits the same refusal)');
      A.eq(v.action, 'budget', 'spend_unknown routes to SPENDING LIMITS');
      A.ok(/spending limits can't be checked/i.test(v.userMessage) && !/something went wrong|try again|top up|out of credit/i.test(v.userMessage),
        'the headline says the limits cannot be checked, never the generic line or a top-up (got: ' + v.userMessage + ')');
    }
  }
  A.eq(kindOf("codex: You've hit your usage limit. Resets in 3 days", 429).kind, 'quota_exhausted',
    'BROWSER: the explicit status argument works too');
  // the shared table and the fallback must agree, or the two halves drift again
  A.eq(kindOf("sidecar HTTP 429 — codex: You've hit your usage limit. Resets in 3 days").kind,
    friendlyError(Object.assign(new Error("codex http 429 — You've hit your usage limit. Resets in 3 days"), { status: 429 })).kind,
    'the browser fallback and the shared sidecar table give the SAME verdict');
  // BROWSER: both stale-session sites (the "sidecar HTTP 403" ladder and kindFromRaw's bare 403) on a page the station
  // kept its key from lead with the withheld notice and offer no reload door (review threads-backend-05)
  sandbox.Harness = { tokenWithheld: () => 'peer-not-found', tokenWithheldNotice: () => 'WITHHELD NOTICE' };
  for (const [m, st] of [['http 403 forbidden'], ['sidecar HTTP 403 — forbidden token'], ['forbidden token', 403]]) {
    const v = kindOf(m, st);
    A.ok(v.userMessage === 'WITHHELD NOTICE' && v.action === null && B.actionButton(v) === null,
      'BROWSER: a withheld page\'s 403 (' + m + ') leads with the withheld notice, no reload door');
  }
  delete sandbox.Harness;
  A.eq(kindOf('http 403 forbidden').action, 'reload', 'BROWSER: a keyed page\'s bare 403 keeps the reload door');
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
  A.eq(actionButton(noKey).label, '▸ OPEN AI & MODELS', 'the keyed door is ▸ OPEN AI & MODELS (org P03)');
  A.eq(noKey.provider, 'xai', 'the keyed guard names the XAI card the door lands on');
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

// ---- spend_unknown: StarNet's own spend ledger refused the run (failureCode spend_history_unavailable) ----
// A customer saw "Something went wrong on that turn — try again." + a RETRY that hit the same refusal every time.
{
  const interrupted = friendlyError('An earlier run was interrupted before its spend was recorded, so the spending limits you set can’t be checked. Settle it in SETTINGS › SPENDING LIMITS.');
  A.eq(interrupted.kind, 'spend_unknown', 'the interrupted-run refusal is spend_unknown');
  A.ok(/earlier run stopped before StarNet recorded what it spent/.test(interrupted.userMessage) && /Settle that run in SETTINGS › SPENDING LIMITS/.test(interrupted.userMessage),
    'the interrupted cause names the run and the SETTLE fix (got: ' + interrupted.userMessage + ')');
  const unsaved = friendlyError('Spend history could not be saved to disk, so the spending limits you set can’t be checked. Restart StarNet to recover it.');
  A.ok(/Restart StarNet/.test(unsaved.userMessage) && !/Settle/.test(unsaved.userMessage), 'a failed save says restart, never settle (got: ' + unsaved.userMessage + ')');
  // d688ea20: the loop's damaged-line cause (sidecar/loop.js) is spend_unknown, names the damaged line and keeps the SETTLE door
  const damagedLine = friendlyError('A line of the spend record is damaged, so what it recorded is unknown and the spending limits you set can’t be checked. Settle it in SETTINGS › SPENDING LIMITS.');
  A.eq(damagedLine.kind, 'spend_unknown', 'the damaged-line refusal is spend_unknown');
  A.ok(/line of StarNet's spend record is damaged/.test(damagedLine.userMessage) && /Settle it in SETTINGS › SPENDING LIMITS/.test(damagedLine.userMessage) && !/earlier run/.test(damagedLine.userMessage),
    'the damaged cause is never called an interrupted run (got: ' + damagedLine.userMessage + ')');
  const unread = friendlyError('Spend history could not be read, so the spending limits you set can’t be checked. See SETTINGS › SPENDING LIMITS.');
  A.eq(unread.userMessage, KINDS.spend_unknown.msg, 'an unreadable record gets the cause-neutral headline');
  A.ok(/spend history is unknown/.test(KINDS.spend_unknown.msg), 'the fallback headline says spend history is unknown');
  A.eq(friendlyError(new Error('sidecar HTTP 409 — spend history is unavailable, so a pool cannot be resumed — see SETTINGS › SPENDING LIMITS')).kind, 'spend_unknown',
    'the resume refusal reads the same way');
  A.eq(friendlyError('spend_history_unavailable').kind, 'spend_unknown', 'the bare failure code reads the same way');
  // the door opens SETTINGS straight on SPENDING LIMITS (the same openTerm(key, section) the other doors use)
  const btn = actionButton(interrupted);
  A.ok(btn && /SPENDING LIMITS/.test(btn.label), 'the door names SPENDING LIMITS (got: ' + (btn && btn.label) + ')');
  const opened = [];
  const prevUI = global.StationUI;
  global.StationUI = { openTerm(key, section) { opened.push([key, section]); } };
  try { btn.run(); } finally { if (prevUI === undefined) delete global.StationUI; else global.StationUI = prevUI; }
  A.eq(JSON.stringify(opened), JSON.stringify([['settings', 'budget']]), 'the door opens SETTINGS › SPENDING LIMITS (section budget)');
  // not swallowed: provider billing and the generic unknown stay what they were
  A.eq(friendlyError(Object.assign(new Error('openai http 429 - insufficient_quota'), { status: 429 })).kind, 'billing', 'provider billing is untouched');
  A.eq(friendlyError('the spending limit on your OpenAI account was reached').kind !== 'spend_unknown', true, 'a provider spending-limit sentence is not StarNet\'s ledger');
}

// GH#111: the OLLAMA card pointed at LM Studio. The adapter's sentence names the server and the card that speaks to it;
// COMMS leads with that sentence (not "Something went wrong — try again"), offers no doomed retry, and its door lands on
// the CUSTOM card. The text is the real adapter's, produced by the real adapter against LM Studio's 200 reply.
// (async: report() below waits for it, since report() exits the process)
const wrongServerCase = (async () => {
  const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
  const lmStudio = makeOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', nativeOllama: true, fetch: async (url, init) =>
    new Response(JSON.stringify({ error: 'Unexpected endpoint or method. (' + ((init && init.method) || 'GET') + ' ' + new URL(url).pathname + ')' }), { status: 200 }) });
  let thrown = null;
  try { for await (const _ of lmStudio.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { thrown = e; }
  A.ok(thrown && /is not an Ollama server/.test(thrown.message), 'the adapter names the wrong server: ' + (thrown && thrown.message));
  const raw = String(thrown && thrown.message);
  const { kindFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  // the page receives the in-band error TEXT (the browser path); the node path also sees the Error with its flag
  for (const input of [raw, thrown]) {
    const v = friendlyError(input, null, { engineAlive: true });
    A.eq(v.kind, 'endpoint_mismatch', 'a wrong server behind the OLLAMA card has its own kind (' + typeof input + ')');
    A.ok(/^The OLLAMA card's URL \(127\.0\.0\.1:1234\) is not an Ollama server: .*SETTINGS → AI & MODELS → CUSTOM with its \/v1 URL instead\.$/.test(v.userMessage),
      'the headline IS the adapter sentence, without the bracketed server words: ' + v.userMessage);
    A.eq(v.retryable, false, 'no ↻ Try again: a resend reaches the same server');
    A.eq([v.action, v.provider], ['settings', 'custom'], 'the door is AI & MODELS, landing on the CUSTOM card');
    A.eq(v.raw, raw, 'the server\'s own words stay in raw for diagnostics');
  }
  A.eq(kindFromRaw(raw), 'endpoint_mismatch', 'the browser fallback ladder reads the adapter sentence too');
  A.eq(actionButton(friendlyError(raw)).label, '▸ OPEN AI & MODELS', 'the door is the existing AI & MODELS key, no new control');
  const focused = [], priorUI = global.StationUI;
  global.StationUI = { focusProvider(pid) { focused.push(pid); }, openTerm() {} };
  try { actionButton(friendlyError(raw)).run(); } finally { if (priorUI === undefined) delete global.StationUI; else global.StationUI = priorUI; }
  A.eq(focused, ['custom'], 'pressing it lands on the CUSTOM card');
  // only the adapter's sentence: the bare LM Studio words (an unknown proxy) and Ollama's own errors keep their kinds
  A.eq(kindFromRaw('Unexpected endpoint or method. (POST /api/chat)'), 'unknown', 'the bare server sentence alone proves nothing about the card');
  A.ok(friendlyError('model runner has unexpectedly stopped').kind !== 'endpoint_mismatch', 'Ollama\'s own error is not a wrong server');
})();

// An explicit Ollama allocation failure is terminal and points at the primary model picker.
{
  const raw = 'Local model ran out of memory. Close other local models. [openai-compatible http 500 - llama-server terminated: cudaMalloc failed: out of memory]';
  for (const input of [raw, Object.assign(new Error(raw), { status: 500, localModelMemory: true })]) {
    const verdict = friendlyError(input);
    A.eq(verdict.kind, 'local_model_memory', 'local allocation failure has its own actionable UI kind');
    A.eq(verdict.retryable, false, 'no blind retry button on an exhausted local runtime');
    A.ok(/Close other local models/.test(verdict.userMessage) && /smaller model/.test(verdict.userMessage), 'the memory remedy names actual choices');
    A.ok(/restart StarNet after freeing memory/.test(verdict.userMessage), 'restart guidance is conditional on a blank/disconnected station and freed memory');
    A.eq(verdict.raw, raw, 'raw runtime allocation detail stays available for diagnostics');
  }
  // Review providers-tools-05: a remote model server's allocation failure keeps the memory kind, and its words.
  const remoteRaw = 'The model server at ollama.lan ran out of memory. Free memory on that machine, or choose a smaller model from the model picker in COMMS before trying again. [http 500 - failed to allocate CUDA0 buffer]';
  const remote = friendlyError(Object.assign(new Error(remoteRaw), { status: 500, localModelMemory: true }));
  A.eq(remote.kind, 'local_model_memory', 'a remote allocation failure has the memory kind');
  A.ok(/^The model server at ollama\.lan ran out of memory\./.test(remote.userMessage) && !/Close other local models|restart StarNet/.test(remote.userMessage), 'and says which machine, never local advice: ' + remote.userMessage);
  A.eq(require('../frontend/app/friendlyerror.js')._internals.kindFromRaw(remoteRaw, 500), 'local_model_memory', 'the browser fallback reads the remote prefix too');
  A.eq(require('../frontend/app/friendlyerror.js')._internals.kindFromRaw(raw, 500), 'local_model_memory',
    'browser fallback does not mistake the runtime termination for a network loss or generic 500');
  const opened = [], prior = global.ModelDock, priorTimer = global.setTimeout;
  global.ModelDock = { open() { opened.push('models'); } };
  global.setTimeout = fn => { fn(); };
  try { actionButton(friendlyError(raw)).run(); } finally { global.setTimeout = priorTimer; if (prior === undefined) delete global.ModelDock; else global.ModelDock = prior; }
  A.eq(opened, ['models'], 'the action opens the primary model picker');
  A.eq(friendlyError('openai-compatible http 500 - cudaMalloc failed: out of memory').kind, 'provider_server_error',
    'an unmarked hosted provider allocation failure is not asserted to be local');
}

/* ---- org P03: the AI & MODELS doors have ONE label and land on the provider's card ----
   Four labels ('⚙ Open Settings', '＋ Add a key', '▸ OPEN AI & MODELS', '⏼ RECONNECT …') all opened the top of a long
   page with no provider focus, and RECONNECT only navigated. Now: ▸ OPEN AI & MODELS lands on the named provider's
   card; a sign-in door names its provider and presses that card's own sign-in; billing names the account. */
{
  const { providerFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  A.eq(providerFromRaw('openrouter http 402 — insufficient credits'), 'openrouter', 'the adapter signature names openrouter');
  A.eq(providerFromRaw('anthropic http 400 - Your credit balance is too low'), 'anthropic', 'the adapter signature names anthropic');
  A.eq(providerFromRaw('Kimi For Coding http 401 - token expired'), 'kimi', 'a device-OAuth label names kimi');
  A.eq(providerFromRaw('sidecar HTTP 400 — missing key/model — connect a OPENAI API API key'), 'openai', 'the credential guard label maps to its card id');
  A.eq(providerFromRaw('configure the CUSTOM base URL'), 'custom', 'a missing base URL names the CUSTOM card');
  A.eq(providerFromRaw('openai-compatible http 402 - payment required'), null, 'an unnamed openai-compatible error names nobody (no guess)');
  A.eq(providerFromRaw('openrouter.ai says: anthropic/claude model unavailable'), 'openrouter', 'a model path naming anthropic inside an openrouter body stays openrouter');

  const or = friendlyError(Object.assign(new Error('openrouter http 402 — This request requires more credits'), { status: 402 }));
  A.eq(or.kind, 'billing', 'an openrouter 402 is billing');
  A.ok(/^Your OpenRouter account is out of credit/.test(or.userMessage), 'the billing copy names the account (got: ' + or.userMessage + ')');
  A.eq(or.provider, 'openrouter', 'the billing verdict carries the provider');
  const anon = friendlyError(Object.assign(new Error('insufficient credit'), { status: 402 }));
  A.eq(anon.userMessage, KINDS.billing.msg, 'an unnamed billing error keeps the provider-neutral copy (truthful: nothing named it)');

  // every non-sign-in AI & MODELS door reads ▸ OPEN AI & MODELS; the retired labels are gone from the module
  A.eq(actionButton(or).label, '▸ OPEN AI & MODELS', 'billing opens AI & MODELS');
  A.eq(actionButton({ kind: 'quota_exhausted', action: 'settings' }).label, '▸ OPEN AI & MODELS', 'quota opens AI & MODELS');
  A.eq(actionButton({ kind: 'managed_credit', action: 'store' }).label, '▸ OPEN AI & MODELS', 'managed credits open AI & MODELS');
  const src = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/friendlyerror.js'), 'utf8');
  A.ok(!/'⚙ Open Settings'|'＋ Add a key'/.test(src), "the retired '⚙ Open Settings' / '＋ Add a key' labels are gone");

  // the door's run() hands the provider (and the sign-in press) to StationUI.focusProvider
  const calls = [];
  global.StationUI = { focusProvider: (pid, o) => calls.push([pid, !!(o && o.signin)]), openTerm: (k, s) => calls.push(['term:' + k, s]) };
  try {
    actionButton(or).run();
    actionButton(friendlyError(new Error('GROK OAUTH sign-in needed: Not signed in to GROK OAUTH — connect it first.'))).run();
    actionButton(friendlyError(new Error('ChatGPT sign-in needed: refresh_token_reused — sign in with ChatGPT again'))).run();
    actionButton(anon).run();
    actionButton({ kind: 'managed_credit', action: 'store' }).run();
  } finally { delete global.StationUI; }
  A.eq(JSON.stringify(calls[0]), JSON.stringify(['openrouter', false]), 'billing lands on the OPENROUTER card');
  A.eq(JSON.stringify(calls[1]), JSON.stringify(['grok', true]), 'SIGN IN TO GROK lands on the GROK card and presses its sign-in');
  A.eq(JSON.stringify(calls[2]), JSON.stringify(['codex', true]), 'RECONNECT CHATGPT lands on the CHATGPT card and presses its sign-in');
  A.eq(JSON.stringify(calls[3]), JSON.stringify(['term:settings', 'providers']), 'an unnamed provider opens AI & MODELS without a card focus');
  A.eq(JSON.stringify(calls[4]), JSON.stringify(['starnet', false]), 'managed credits land on the STARNET MANAGED card');
  A.eq(actionButton(friendlyError(new Error('ChatGPT sign-in needed: refresh_token_reused — sign in with ChatGPT again'))).label, '⏼ RECONNECT CHATGPT',
    'a dead ChatGPT refresh reads RECONNECT CHATGPT');

  // stationui: focusProvider exists, is exported, presses the card's own prov-oauth-signin; the card status never
  // reads a bare NOT VERIFIED when the probe gave no reason
  const ui = require('fs').readFileSync(require('path').join(__dirname, '../frontend/app/stationui.js'), 'utf8');
  A.ok(/function focusProvider\(pid, opts\)/.test(ui) && /openTerm, focusProvider,/.test(ui), 'StationUI.focusProvider is defined and exported');
  A.ok(/querySelector\('\[data-act="prov-oauth-signin"\]'\); if \(b\) b\.click\(\)/.test(ui), 'a sign-in door presses the card\'s own prov-oauth-signin key');
  A.ok(/the provider answered but did not confirm this key/.test(ui) && /the check got no answer from the provider/.test(ui), 'an empty probe error prints a fallback reason');
}

/* ---- org P03 (final round): a sign-in SUBSCRIPTION has no wallet ----
   ChatGPT (codex), Grok (SuperGrok / X Premium+) and Kimi for Coding are plans (registry: oauth_device_code + unmetered).
   Naming the account made a ChatGPT 402 read "Your ChatGPT account is out of credit — top it up": there is nothing to top
   up — the plan allowance resets on the provider's schedule. Every billing/quota verdict on one says that instead. */
{
  const { providerFromRaw, kindFromRaw } = require('../frontend/app/friendlyerror.js')._internals;
  A.eq(providerFromRaw("codex http 429 — You've hit your usage limit"), 'codex', 'the ChatGPT adapter signature names codex');
  const subs = [
    ['codex http 402 — Payment Required', 402, 'codex', 'ChatGPT'],
    ['codex http 429 — insufficient_quota', 429, 'codex', 'ChatGPT'],
    ['codex http 429 — Codex quota exceeded', 429, 'codex', 'ChatGPT'],
    ['Grok (xAI) http 402 - insufficient credits', 402, 'grok', 'Grok'],
    ['Kimi For Coding http 429 - quota exceeded', 429, 'kimi', 'Kimi'],
    ['Kimi For Coding http 402 - payment required', 402, 'kimi', 'Kimi']
  ];
  for (const [raw, status, id, nm] of subs) {
    const v = friendlyError(Object.assign(new Error(raw), { status }));
    A.eq(v.kind, 'quota_exhausted', raw + ' — a sign-in subscription\'s spent plan, never billing');
    A.ok(!/out of credit|top (?:it )?up/i.test(v.userMessage), raw + ' — never "out of credit — top it up": ' + v.userMessage);
    A.ok(new RegExp('^Your ' + nm + ' plan allowance is used up — it resets on ' + nm + "'s own schedule").test(v.userMessage), raw + ' — names the plan and its reset: ' + v.userMessage);
    A.ok(/switch to another provider or key under SETTINGS → AI & MODELS/.test(v.userMessage), raw + ' — the way to keep working now');
    A.eq(v.retryable, false, raw + ' — no doomed retry');
    A.eq(v.provider, id, raw + ' — the verdict carries the provider');
    A.eq(actionButton(v).label, '▸ OPEN AI & MODELS', raw + ' — the AI & MODELS door');
  }
  A.ok(/weekly/.test(friendlyError(Object.assign(new Error('codex http 402 — Payment Required'), { status: 402 })).userMessage), 'ChatGPT keeps its weekly reset');
  // the BROWSER ladder still reads these as billing (in step with errorClass.js); the provider-aware re-read happens in friendlyError
  A.eq(kindFromRaw('codex http 402 — payment required', null), 'billing', 'the browser ladder alone says billing (the subscription re-read sits above it)');
  // a per-minute quota on a subscription is still a busy moment, and a wallet provider is still out of credit
  const perMin = friendlyError(Object.assign(new Error('Kimi For Coding http 429 - quota exceeded: requests per minute'), { status: 429 }));
  A.eq(perMin.kind, 'rate_limit', 'a per-minute quota on a subscription stays a rate limit');
  const wallet = friendlyError(Object.assign(new Error('openrouter http 402 — insufficient credits'), { status: 402 }));
  A.ok(wallet.kind === 'billing' && /^Your OpenRouter account is out of credit — top it up/.test(wallet.userMessage), 'a wallet provider keeps "out of credit — top it up"');
  const xaiKey = friendlyError(Object.assign(new Error('xai http 402 - add credits at console.x.ai'), { status: 402 }));
  A.ok(xaiKey.kind === 'billing' && /^Your xAI account is out of credit/.test(xaiKey.userMessage), 'the xAI API key (a wallet) is not the Grok sign-in: ' + xaiKey.userMessage);
  const unnamed = friendlyError(Object.assign(new Error("You've hit your usage limit. Resets in 3 days"), { status: 429 }));
  A.eq(unnamed.userMessage, KINDS.quota_exhausted.msg.replace('To keep working now', 'The provider says it resets in 3 days. To keep working now'),
    'an unnamed spent allowance keeps the neutral quota copy, plus the reset time it stated (naming no provider)');
  A.eq(friendlyError(Object.assign(new Error("You've hit your usage limit."), { status: 429 })).userMessage, KINDS.quota_exhausted.msg,
    'with no stated reset time it is the neutral copy exactly');
  // a ChatGPT adapter auth failure names codex: its door is the reconnect, never a key field
  const codexAuth = friendlyError(Object.assign(new Error('codex http 401 — Unauthorized'), { status: 401 }));
  A.eq(codexAuth.provider, 'codex', 'a codex 401 names codex');
  A.eq(actionButton(codexAuth).label, '⏼ RECONNECT CHATGPT', 'its door reconnects ChatGPT');
  // (org P03 wiring) and its words say the same thing as that door: the sign-in was refused, never "no model is connected"
  for (const [raw, status] of [['codex http 401 — Unauthorized', 401], ['codex http 403 — Forbidden', 403], ['codex http 401 — {"error":"token has expired"}', 401]]) {
    const v = friendlyError(Object.assign(new Error(raw), { status }));
    A.eq(v.userMessage, 'ChatGPT refused this sign-in — reconnect it (or add a provider key instead).', 'a ChatGPT ' + status + ' names the refused sign-in: ' + raw);
    A.ok(v.userMessage !== KINDS.auth.msg, 'never the bare "No model is connected yet" beside RECONNECT CHATGPT');
    A.eq(actionButton(v).label, '⏼ RECONNECT CHATGPT', 'copy and door agree for ' + raw);
  }
}

/* A MODEL THIS ChatGPT ACCOUNT MAY NOT RUN (2026-10-27 report): the user saw "Something went wrong on that turn — try
   again" with a RETRY chip four times; every retry was refused the same way. BOTH halves (the node delegate and the
   browser ladder real users run) must name the model and open the model dock, never offer the doomed retry. */
{
  const vm = require('vm');
  const fs3 = require('fs');
  const path3 = require('path');
  const src = fs3.readFileSync(path3.join(__dirname, '..', 'frontend', 'app', 'friendlyerror.js'), 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__F = Friendly;', sandbox, { filename: 'friendlyerror.js' });
  const B = sandbox.__F;
  const refusal = "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.";
  for (const [half, F] of [['NODE', { friendlyError, actionButton }], ['BROWSER', B]]) {
    for (const raw of ['codex http 400 — ' + refusal, refusal]) {
      const v = F.friendlyError(new Error(raw));
      A.eq(v.kind, 'model_not_found', half + ': ' + raw + ' is the model unavailable to this account');
      A.eq(v.retryable, false, half + ': no doomed retry');
      A.ok(/gpt-6-astra/.test(v.userMessage) && /model dock/i.test(v.userMessage), half + ': the copy names the refused model and the dock: ' + v.userMessage);
      A.ok(!/went wrong|try again/i.test(v.userMessage), half + ': never "something went wrong — try again"');
      A.eq(F.actionButton(v).label, '▸ PICK A MODEL', half + ': the door opens the model dock');
    }
    // a refusal that quotes no model still reads as the account refusing it
    A.ok(/won't run this model/.test(F.friendlyError(new Error('codex http 400 — The model is not supported when using Codex with a ChatGPT account.')).userMessage),
      half + ': an unnamed model still gets the account copy');
  }
}

wrongServerCase.then(() => A.report('friendlyerror.test'), e => { A.ok(false, 'the wrong-server case threw: ' + (e && e.stack)); A.report('friendlyerror.test'); });
