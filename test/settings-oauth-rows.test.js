/* test/settings-oauth-rows.test.js — the grok + kimi keyless device-code sign-in rows must tell the SAME truth
   the codex row does (settings-codex-row.test.js), but through the SHARED parameterized path — never a copy of
   the codex block per provider. The honest contract, mirrored:
     · the panel reads the FULL /api/auth/<pid>/status truth (connected + expired + reason), not a bool
     · a known-dead sign-in renders SIGN-IN EXPIRED (never SIGNED IN)
     · every oauth row carries ⏼ RE-SIGN-IN + ✕ DISCONNECT, id'd per provider so two rows never collide
     · the sign-in flow is the ONE shared engine (OAuthSignIn.for(pid)) — no bespoke poll loops in the UI
     · modeldock lists grok/kimi (rank right after codex, GROK/KIMI OAUTH labels) via /api/auth/<pid>/{status,models}
     · friendlyerror's oauth door reads ⏼ RECONNECT GROK / ⏼ RECONNECT KIMI, and the xAI 403-allowlist case
       routes to the XAI (API KEY) provider instead of a dead-end reconnect */
'use strict';
const A = require('./_assert.js');
const fs = require('fs'); const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const ui = read('frontend', 'app', 'stationui.js');
const dock = read('frontend', 'app', 'modeldock.js');
const keycta = read('frontend', 'app', 'keycta.js');
const signin = read('frontend', 'app', 'codexsignin.js');

// ---- the shared engine exposes a per-provider factory ----
A.ok(/OAuthSignIn\s*=\s*\{/.test(signin) && /\bfor\s*\(pid\)/.test(signin), 'codexsignin.js exposes OAuthSignIn.for(pid)');
A.ok(/window\.OAuthSignIn\s*=\s*OAuthSignIn/.test(signin), 'OAuthSignIn is exposed on window for the browser consumers');

// ---- Settings: grok + kimi are provider cards, and the shared oauth machinery drives them ----
A.ok(/id: 'grok'/.test(ui) && /id: 'kimi'/.test(ui), 'grok + kimi appear as Settings provider cards');
A.ok(/OAUTH_EXTRA\s*=\s*\[\s*'grok'\s*,\s*'kimi'\s*\]/.test(ui), 'the extra keyless OAuth providers are grok + kimi');
// full status truth, not a bool — the SAME expired-shape guard the codex row uses, but on the shared refresh.
A.ok(/oauthStatus\[pid\]\s*=\s*next/.test(ui), 'the shared refresh stores connected+expired+reason (not a lone bool)');
A.ok(/expired:\s*!!\(j && j\.expired\)/.test(ui), 'the shared status carries the expired truth from /api/auth/<pid>/status');
A.ok(/fetch\('\/api\/auth\/'\s*\+\s*pid\s*\+\s*'\/status'/.test(ui), 'the shared refresh reads the real per-provider status route');
A.ok(/function isOAuthProvider/.test(ui) && /isOAuthProvider\(p\.id\)/.test(ui), 'the provider card render is generalized over the OAuth providers (not codex-only branches)');

// ---- dead sign-in renders EXPIRED, never SIGNED IN; the row survives so recovery is reachable ----
A.ok(/const connLabel = isOAuthProvider\(p\.id\) \? '● SIGNED IN'/.test(ui), 'SIGNED IN is reserved for a live OAuth sign-in (all providers), gated below on !dead');
A.ok(/const codexDead = isOAuthProvider\(p\.id\) && oauthExpiredFor\(p\.id\)/.test(ui), 'a dead sign-in flag covers every OAuth provider, not just codex');
A.ok(/oauthProvConnected\(pid\) \|\| oauthProvExpired\(pid\)/.test(ui), 'an expired grok/kimi sign-in still earns its row (RE-SIGN-IN lives there)');
A.ok(/key-mask-dead/.test(ui) && /⚠ EXPIRED/.test(ui), 'the expired oauth row masks the fault, never a live label');

// ---- the shared row carries actions wired to the real endpoints, id'd per provider ----
A.ok(/data-act="'\s*\+\s*esc\(pid\)\s*\+\s*'-resign"/.test(ui), 'the shared oauth row renders a per-provider ⏼ RE-SIGN-IN action');
A.ok(/data-act="'\s*\+\s*esc\(pid\)\s*\+\s*'-logout"/.test(ui), 'the shared oauth row renders a per-provider ✕ DISCONNECT action');
A.ok(/⏼ RE-SIGN-IN/.test(ui) && /✕ DISCONNECT/.test(ui), 'the action labels are the locked vocabulary');
A.ok(/id="'\s*\+\s*esc\(pid\)\s*\+\s*'-inline-code"/.test(ui) && /id="'\s*\+\s*esc\(pid\)\s*\+\s*'-inline-status"/.test(ui), 'each oauth row gets its OWN inline device-code surface (no id collision between grok + kimi)');

// ---- ONE shared engine, no bespoke poll loops in the UI ----
A.ok(/OAuthSignIn\.for\(pid\)/.test(ui), 'RE-SIGN-IN / DISCONNECT drive the shared OAuthSignIn engine');
A.ok(/act\.match\(\/\^\(grok\|kimi\)-\(resign\|logout\)\$\//.test(ui), 'the grok/kimi row actions are handled by ONE parameterized handler, not a block per provider');
A.ok(!/\/api\/auth\/grok\/poll/.test(ui) && !/\/api\/auth\/kimi\/poll/.test(ui), 'stationui.js never grows its own grok/kimi poll loop (the engine owns it)');

// ---- modeldock lists grok + kimi, enabled via status, discovered via /models, ranked right after codex ----
A.ok(/codex: 0, grok: 1, kimi: 2/.test(dock), 'grok + kimi rank immediately after codex in the model dock');
A.ok(/grok: 'GROK OAUTH'/.test(dock) && /kimi: 'KIMI OAUTH'/.test(dock), 'the dock labels read GROK OAUTH / KIMI OAUTH');
A.ok(/'codex', 'grok', 'kimi'/.test(dock), 'the provider fan-out includes grok + kimi');
A.ok(/async function oauthProviderEnabled/.test(dock) && /'\/api\/auth\/'\s*\+\s*pid\s*\+\s*'\/status'/.test(dock), 'grok/kimi are gated on their live OAuth status route');
A.ok(/'\/api\/auth\/'\s*\+\s*p\s*\+\s*'\/models'/.test(dock), 'grok/kimi model discovery hits /api/auth/<pid>/models');
A.ok(/if \(p === 'grok'[^\n]*\) return 'grok'/.test(dock) && /return 'kimi'/.test(dock), 'grok/kimi are their OWN providers in normalizeProvider (not aliased to xai)');

// ---- keycta treats grok/kimi as keyless (no "add a key" banner for an OAuth station) ----
A.ok(/p !== 'codex' && p !== 'grok' && p !== 'kimi'/.test(keycta), 'keycta treats grok/kimi as keyless OAuth providers');

// ---- friendlyerror doors: RECONNECT GROK / RECONNECT KIMI, plus the xAI 403-allowlist escape ----
{
  const { friendlyError, actionButton } = require('../frontend/app/friendlyerror.js');

  const g = friendlyError(new Error('grok_not_connected'));
  A.eq(g.kind, 'oauth', 'a grok_not_connected error classifies as the oauth sign-in class');
  A.eq(g.provider, 'grok', 'the verdict carries the grok provider so the door can name it');
  A.ok(/key/i.test(g.userMessage), 'the grok oauth message still names the add-a-key alternative (never a dead-end)');
  // never connected is not "expired": nothing to reconnect, so the door reads SIGN IN
  A.eq(actionButton(g).label, '⏼ SIGN IN TO GROK', 'a never-connected grok door reads ⏼ SIGN IN TO GROK');
  A.ok(!/expired/i.test(g.userMessage), 'a never-connected grok is not told its sign-in expired');
  const gDead = friendlyError(new Error('Grok (xAI) http 401 - invalid access token'));
  A.eq(actionButton(gDead).label, '⏼ RECONNECT GROK', 'a grok sign-in that died mid-life still reads ⏼ RECONNECT GROK');

  const km = friendlyError(new Error('kimi_auth_error: refresh_token rejected — sign in again'));
  A.eq(km.kind, 'oauth', 'a kimi auth error classifies as oauth');
  A.eq(actionButton(km).label, '⏼ RECONNECT KIMI', 'the kimi door reads ⏼ RECONNECT KIMI');

  // the xAI 403-allowlist case is NOT a reconnect — it routes to the xAI (API KEY) provider.
  const gx = friendlyError(new Error('grok OAuth device flow unavailable — 403 access forbidden (account not allowlisted for Grok sign-in)'));
  A.eq(gx.kind, 'grok_oauth_unavailable', 'the grok 403-allowlist failure is its own kind, not a doomed reconnect');
  const gxBtn = actionButton(gx);
  A.ok(gxBtn && /XAI|API KEY/i.test(gxBtn.label), 'the 403-allowlist door points at the XAI (API KEY) provider (got ' + (gxBtn && gxBtn.label) + ')');
  A.ok(/xai|api key/i.test(gx.userMessage) && !/undefined|null/.test(gx.userMessage), 'the message clearly guides to the xAI key path (no dead-end, no leaked tokens)');
  // it must NOT read as a reconnect-grok door (that would be the dead-end this case exists to avoid).
  A.ok(!/RECONNECT GROK/.test(gxBtn.label), 'the allowlist case never offers the doomed RECONNECT GROK door');

  // regression: codex stays RECONNECT CHATGPT (provider defaults to codex when unnamed).
  const cx = friendlyError(new Error('codex_not_connected'));
  A.eq(cx.provider, 'codex', 'a codex oauth error still resolves to the codex provider');
  A.eq(actionButton(cx).label, '⏼ RECONNECT CHATGPT', 'the codex door is unchanged (⏼ RECONNECT CHATGPT)');
}

// ---- FIRST sign-in reachability (live-caught 2026-07-17, widened to codex 2026-07-21): a never-signed-in
// device-code card must offer ⏼ SIGN IN right on the provider card — the oauth key-row (where RE-SIGN-IN
// lives) only renders once a live or known-dead sign-in exists. Codex is NOT exempt: its connect-screen
// block lives only on the overseer/brain screen, so after ✕ DISCONNECT (or a machine that never signed in
// there) the card button is the ONLY reachable sign-in — gating it to OAUTH_EXTRA was the user-reported
// escape where a removed ChatGPT sign-in could never be re-connected.
{
  const ui = read('frontend', 'app', 'stationui.js');
  A.ok(/data-act="prov-oauth-signin"/.test(ui), 'the provider card renders a ⏼ SIGN IN action for a not-signed-in device-code provider');
  A.ok(/wantsOAuthSignin\s*=\s*p\.live\s*&&\s*isOAuthProvider\(p\.id\)\s*&&\s*!credentialSaved/.test(ui), 'the card sign-in covers EVERY device-code provider (codex included) without a stored sign-in — never just OAUTH_EXTRA');
  A.ok(!/wantsOAuthSignin\s*=[^;]*!codexDead/.test(ui) && /codexDead \? '⏼ RECONNECT' : '⏼ SIGN IN'/.test(ui), '#92: a KNOWN-dead sign-in keeps the card button, labelled ⏼ RECONNECT (the RE-SIGN-IN row under API KEYS was the only way back in)');
  A.ok(/prov-oauth-signin"\]'\)/.test(ui) && /OAuthSignIn\.for\(pid\)/.test(ui), 'the card sign-in drives the SAME shared engine (OAuthSignIn.for), no bespoke fetch loop');
  A.ok(/id="prov-oauth-code-'\s*\+\s*esc\(p\.id\)/.test(ui) && /id="prov-oauth-status-'\s*\+\s*esc\(p\.id\)/.test(ui), 'the card owns a per-provider inline device-code surface (no id collision)');
  const signinHandler = ui.slice(ui.indexOf("querySelector('[data-act=\"prov-oauth-signin\"]')"));
  A.ok(/stopPropagation/.test(signinHandler.slice(0, 600)), 'the card sign-in click does not bubble into provider-select');
  // the card handler must route codex's connected truth to its literal status state (codexStatusKnown), not
  // the grok/kimi shared cache — otherwise the row keeps reading NOT SIGNED IN after a successful sign-in.
  A.ok(/pid === 'codex'.*codexStatusKnown\s*=\s*\{\s*connected:\s*true/.test(signinHandler), "a card-driven codex sign-in lands in codexStatusKnown (the codex truth the row actually reads)");
}

// ---- 2026-07-22 auth-lifecycle hardening (source-locks; the live races/keychain failures need real tokens
// or a packaged exe to reproduce, so these pin the mechanisms) ----
{
  const ui = read('frontend', 'app', 'stationui.js');
  const harness = read('frontend', 'app', 'harness.js');
  const sidecar = read('sidecar', 'index.js');
  // single-flight refresh: concurrent refreshes on a ROTATING refresh token false-expire a live sign-in
  // (the 2026-07-08 class, self-inflicted). Both the codex literal path and the grok/kimi shared path coalesce.
  A.ok(/codexRefreshInFlight\s*=\s*refreshCodexTokensOnce\(\)\.finally/.test(sidecar), 'codex refresh is single-flight (coalesced in-flight promise)');
  A.ok(/entry\.refreshInFlight\s*=\s*refreshOAuthTokensOnce\(id,\s*entry\)\.finally/.test(sidecar), 'grok/kimi refresh is single-flight per provider');
  // desktop keychain writes: configured flips ONLY after the invoke proves itself; Settings callers await and
  // render the honest failure (the optimistic flip toasted "stored in your OS keychain" over a rejected write).
  A.ok(/\.then\(r => \{ setDesktopConfigured\(p, on\); return r; \}\)/.test(harness), 'setKey flips configured only after the keychain write resolves');
  A.ok(/err && err\.message/.test(ui) && /could not verify and store the ' \+ provName\(provider\) \+ ' key/.test(ui), 'Settings key save renders the exact validation/keychain failure copy');
  // Settings OAuth state changes mirror into the desktop configured-map (genesis already did; Settings must too).
  A.ok(/Harness\.setDesktopConfigured\('codex', true\)/.test(ui) && /Harness\.setDesktopConfigured\(pid, true\)/.test(ui), 'Settings sign-in feeds the desktop configured-map');
  A.ok(/Harness\.setDesktopConfigured\('codex', false\)/.test(ui) && /Harness\.setDesktopConfigured\(pid, false\)/.test(ui), 'Settings disconnect clears the desktop configured-map');
  // model reconcile on OAuth card select: a foreign global model slug must not ride to the new endpoint.
  A.ok(/isOAuthProvider\(p\) && typeof fetch === 'function'/.test(ui) && /\/api\/auth\/' \+ p \+ '\/models/.test(ui), 'selecting an OAuth provider card reconciles the model against that provider\'s catalog');
  // mid-run token death carries provider identity from the adapter (the RECONNECT door depends on it).
  const factory = read('sidecar', 'providers', 'factory.js');
  A.ok(/label: isDeviceOAuth \? \(profile\.name \|\| profile\.id\) : undefined/.test(factory), 'device-OAuth adapters are constructed with the provider label');
}

A.report('settings-oauth-rows.test');
