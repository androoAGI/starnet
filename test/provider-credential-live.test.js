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

const names = ['providerHasCredential', 'accountLive', 'oauthPrimaryStatus', 'anyExtraAccountLive'];
const srcs = names.map(n => sidecarFunctionSource(n));
srcs.forEach((s, i) => A.ok(s.length > 40 && s.length < 3000, 'one bounded ' + names[i]));

function build(state) {
  const deps = {
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
  return new Function(...keys, srcs.join('\n') + '\nreturn { providerHasCredential, accountLive };')(...vals);
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

// ---- the image route reads the SAME verdict, never a private copy (quick win 9) ----
const core = sidecarTopLevelFunction('runOnceCore');
const i = core.indexOf('const studioInput = {');
A.ok(i > 0, 'runOnceCore builds the studio route input');
const studio = core.slice(i, core.indexOf('};', i) + 2);
A.ok(/codexSignedIn: accountLive\('codex', ''\)/.test(studio), 'the image route asks accountLive whether the primary ChatGPT sign-in is live: ' + studio.slice(-200));
A.ok(!/codexTokens|codexAuthDead/.test(studio), 'and keeps no private token / dead-marker check of its own');

A.report('provider-credential-live.test');
