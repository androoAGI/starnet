/* node test/provider-credential-live.test.js — a dead subscription sign-in is not "configured" (GitHub #92, quick win 9).

   The report: a ChatGPT refresh token another client had consumed (Codex CLI / VS Code) left the tokens on disk with a
   durable dead marker. Every run failed "ChatGPT sign-in needed", yet the diagnostics said "Credential: configured":
   providerHasCredential checked only that an access token was present, while the run's own account chain (accountChain)
   already skipped a dead sign-in through accountLive. Now providerHasCredential asks accountLive too, and the image route's
   private copy of the check (studioInput.codexSignedIn) is replaced by the same shared verdict.

   The REAL functions run from their own source (requiring sidecar/index.js would boot a sidecar), over fake stores. */
'use strict';
const A = require('./_assert.js');
const { sidecarFunctionSource, sidecarTopLevelFunction } = require('./helpers/source');

const names = ['providerHasCredential', 'accountLive', 'oauthPrimaryStatus', 'anyExtraAccountLive',
  'providerSignInExpired', 'providerHasStoredCredential', 'expiredSignInNote', 'providerCredentialError'];
const srcs = names.map(n => sidecarFunctionSource(n));
srcs.forEach((s, i) => A.ok(s.length > 40 && s.length < 3000, 'one bounded ' + names[i]));
const { getProviderProfile } = require('../sidecar/providers/registry.js');

function build(state) {
  const deps = {
    getProviderProfile,
    normalizeProvider: p => String(p || 'openrouter'),
    registryProviderUsesCodex: id => id === 'codex',
    registryProviderUsesDeviceOAuth: id => id === 'grok' || id === 'kimi',
    providerRequiresBaseUrl: id => id === 'custom',
    providerRequiresKey: id => id === 'openrouter' || id === 'custom',
    OAUTH_PROVIDER_IDS: ['grok', 'kimi'],
    providerAccounts: { list: id => (state.extras && state.extras[id]) || [] },
    oauthAccountEntry: (id, acct) => ((state.extras && state.extras[id]) || []).find(a => a.id === acct) || null,
    accountAuthSeen: new Map()
  };
  const keys = Object.keys(deps).concat(['codexTokens', 'codexAuthDead', 'codexPersistError', 'oauthProviders']);
  const vals = Object.values(deps).concat([state.codexTokens || null, state.codexAuthDead || null, '', state.oauthProviders || {}]);
  return new Function(...keys, srcs.join('\n') + '\nreturn { providerHasCredential, accountLive, providerHasStoredCredential, providerCredentialError, expiredSignInNote };')(...vals);
}
const tok = { access_token: 'at', refresh_token: 'rt' };
const dead = { code: 'refresh_token_reused', at: '2026-10-08T04:16:08.064Z' };

// ---- ChatGPT (codex) ----
A.ok(build({ codexTokens: tok }).providerHasCredential('codex'), 'a live ChatGPT sign-in is configured');
A.ok(!build({ codexTokens: tok, codexAuthDead: dead }).providerHasCredential('codex'), '#92: a sign-in recorded dead is NOT configured, its tokens still on disk');
A.ok(!build({}).providerHasCredential('codex'), 'no sign-in is not configured');
A.ok(build({ codexTokens: tok, codexAuthDead: dead, extras: { codex: [{ id: 'x1', tokens: tok }] } }).providerHasCredential('codex'),
  'a dead primary with a LIVE extra account is configured (the run chain opens on the extra)');
A.ok(!build({ codexTokens: tok, codexAuthDead: dead, extras: { codex: [{ id: 'x1', tokens: tok, authDead: dead }] } }).providerHasCredential('codex'),
  'a dead primary and a dead extra: not configured');
// ---- device-OAuth subscriptions (Grok, Kimi) ----
A.ok(build({ oauthProviders: { grok: { tokens: tok } } }).providerHasCredential('grok'), 'a live Grok sign-in is configured');
A.ok(!build({ oauthProviders: { grok: { tokens: tok, authDead: dead } } }).providerHasCredential('grok'), 'a Grok sign-in recorded dead is NOT configured');
// ---- key providers are unchanged ----
A.ok(build({}).providerHasCredential('openrouter', 'sk-or-1', ''), 'a key provider with a key is configured');
A.ok(!build({}).providerHasCredential('openrouter', '', ''), 'a key provider with no key is not');
A.ok(!build({}).providerHasCredential('custom', 'k', ''), 'a base-URL provider with no base URL is not');

// ---- a sign-in that EXPIRED is not one that never existed (review of quick win 9) ----
// The run route answers 'missing key/model — ' + providerCredentialError; a dead sign-in must read as an expired one
// the page offers ⏼ RECONNECT for, never as "No model is connected yet" (friendlyerror.js classifies the real text).
{
  const F = require('../frontend/app/friendlyerror.js');
  const page = (err) => F.friendlyError(new Error('sidecar HTTP 400 — missing key/model — ' + err), 400);
  const deadCodex = build({ codexTokens: tok, codexAuthDead: dead });
  const codexErr = deadCodex.providerCredentialError('codex');
  A.ok(/sign-in expired/.test(codexErr) && !/connect ChatGPT first/.test(codexErr), 'a dead ChatGPT sign-in says it expired: ' + codexErr);
  const c = page(codexErr);
  A.ok(c.kind === 'oauth' && c.provider === 'codex' && c.signedOut === false, 'the page reads it as an expired ChatGPT sign-in: ' + JSON.stringify(c));
  A.eq((F.actionButton(c) || {}).label, '⏼ RECONNECT CHATGPT', 'and offers RECONNECT CHATGPT beside it');
  A.ok(/connect ChatGPT first/.test(build({}).providerCredentialError('codex')), 'a station never signed in keeps its "connect ChatGPT first" text');
  A.ok(/connect ChatGPT first/.test(build({ codexTokens: tok, codexAuthDead: dead, extras: { codex: [{ id: 'x1', tokens: tok }] } }).providerCredentialError('codex')),
    'a dead primary with a live extra account is not "expired" (it is configured; the text is only ever the fallback)');
  for (const id of ['grok', 'kimi']) {
    const err = build({ oauthProviders: { [id]: { tokens: tok, authDead: dead } } }).providerCredentialError(id);
    const r = page(err);
    A.ok(/sign-in expired/.test(err) && r.kind === 'oauth' && r.provider === id && r.signedOut === false,
      'a dead ' + id + ' sign-in reads as expired on the page: ' + err + ' -> ' + JSON.stringify(r));
    A.ok(/RECONNECT/.test((F.actionButton(r) || {}).label || ''), id + ': the door beside it is a RECONNECT');
    const signedOut = page(build({}).providerCredentialError(id));
    A.ok(signedOut.signedOut === true, id + ' never signed in still reads as signed out');
  }
  // the channel bot's per-message note: the hub answers sec.error before its "No provider/model is configured yet" line
  A.ok(/sign-in expired/.test(build({ oauthProviders: { grok: { tokens: tok, authDead: dead } } }).expiredSignInNote('grok')), 'a dead Grok sign-in gives the channel bot the expired note');
  A.eq(build({ oauthProviders: { grok: { tokens: tok } } }).expiredSignInNote('grok'), '', 'a live one gives none');
  A.eq(build({}).expiredSignInNote('grok'), '', 'and a never-signed-in one gives none (the hub keeps its own line)');
}

// ---- boot channel auto-start reads the STORED credential (review of quick win 9) ----
// A saved bot on a sign-in recorded dead must still start at boot: nothing restarts a skipped bot when the Commander
// reconnects (handleCodexPoll only clears the marker), so skipping it left Telegram/Discord/Slack offline until a restart.
{
  A.ok(build({ codexTokens: tok, codexAuthDead: dead }).providerHasStoredCredential('codex', '', ''), 'a dead ChatGPT sign-in is still a STORED credential');
  A.ok(build({ oauthProviders: { kimi: { tokens: tok, authDead: dead } } }).providerHasStoredCredential('kimi', '', ''), 'a dead Kimi sign-in too');
  A.ok(!build({}).providerHasStoredCredential('codex', '', ''), 'no sign-in at all is not');
  A.ok(!build({}).providerHasStoredCredential('openrouter', '', ''), 'a key provider with no key is not');
  A.ok(build({}).providerHasStoredCredential('openrouter', 'sk-or-1', ''), 'a key provider with a key is');
  const { readSidecarSource } = require('./helpers/source');
  const text = readSidecarSource();
  const a = text.indexOf('auto-start a previously-connected Telegram bot');
  const b = text.indexOf('Restore EVERY saved connector into the manager', a);
  A.ok(a > 0 && b > a, 'found the boot channel auto-start block');
  const boot = text.slice(a, b);
  for (const [ch, re] of [['telegram', /t\.enabled && tgTok && t\.model && providerHasStoredCredential\(t\.provider/],
    ['discord', /d\.enabled && dcTok && d\.model && providerHasStoredCredential\(d\.provider/],
    ['generic', /r\.enabled && authOk && r\.model && providerHasStoredCredential\(r\.provider/]])
    A.ok(re.test(boot), 'boot auto-start of the ' + ch + ' channel gates on the STORED credential');
  A.ok(!/providerHasCredential\(/.test(boot), 'no boot channel gate reads the live verdict');
  for (const fn of ['startTelegram', 'startDiscord', 'startGenericChannel']) {
    const s = sidecarFunctionSource(fn);
    A.ok(/secrets: \(\) => \{[\s\S]*?configured: providerHasCredential\([^)]*\), error: expiredSignInNote\(/.test(s), fn + '\'s hub secrets carry the expired-sign-in note');
  }
}

// ---- the image route reads the SAME verdict, never a private copy (quick win 9) ----
const core = sidecarTopLevelFunction('runOnceCore');
const i = core.indexOf('const studioInput = {');
A.ok(i > 0, 'runOnceCore builds the studio route input');
const studio = core.slice(i, core.indexOf('};', i) + 2);
A.ok(/codexSignedIn: accountLive\('codex', ''\)/.test(studio), 'the image route asks accountLive whether the primary ChatGPT sign-in is live: ' + studio.slice(-200));
A.ok(!/codexTokens|codexAuthDead/.test(studio), 'and keeps no private token / dead-marker check of its own');

A.report('provider-credential-live.test');
