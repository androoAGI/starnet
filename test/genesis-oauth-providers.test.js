/* node test/genesis-oauth-providers.test.js — the genesis (CREATE YOUR OVERSEER) screen offers EVERY keyless
   device-code OAuth provider, not just ChatGPT (source-locks).

   THE BUG THIS LOCKS OUT (Andrew's report, 2026-07-20): the sidecar shipped grok/kimi subscription OAuth
   end-to-end (routes, registry profiles, Settings PROVIDERS rows, ModelDock groups) — but the onboarding
   brain picker only wired the Codex path, so a new user could only ever OAuth with ChatGPT. Worse,
   Harness.normalizeProviderId still folded 'grok' into the API-key 'xai' id (and 'kimi' fell through to
   'openrouter'), so even Settings could never actually make the OAuth brains the ACTIVE provider:
   setProv('grok') persisted 'xai' and every run went out on the wrong (keyless) API-key profile. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const harnessSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '../frontend/app/app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');

const Reg = require('../sidecar/providers/registry.js');
const { functionSourceIn } = require('./helpers/source.js');
const norm = new Function('SK', 'return (' + functionSourceIn(harnessSrc, 'normalizeProviderId') + ');')({ providers: { registry: Reg } });
for (const id of ['grok', 'kimi']) A.eq(norm(id), id, id + ' keeps its own OAuth identity');
A.eq(norm('moonshot'), 'kimi', 'moonshot follows the shared alias registry');
A.ok(!Reg.providerRequiresKey('grok') && !Reg.providerRequiresKey('kimi'), 'OAuth credentials never become pasted API keys');
A.ok(harnessSrc.includes('await refreshProviderReadiness()'), 'boot reads OAuth readiness from the common sidecar rows');
A.ok(!harnessSrc.includes('_configuredByProvider'), 'no optimistic OAuth/keychain configured map remains');

/* ---------- 3. the genesis screen OFFERS grok/kimi (the user-visible half) ----------
   Andrew's layout order (2026-07-22): the ChatGPT hero is the ONLY card up top; grok/kimi are
   STANDARD chips in the one provider grid — their OAuth surface (the shared sign-in block)
   appears when picked, never as extra hero-ish cards stacked under the ChatGPT button. */
A.ok(/class="prov" data-prov="grok"/.test(htmlSrc), 'genesis picker has a GROK chip (standard, not a mini-hero card)');
A.ok(/class="prov" data-prov="kimi"/.test(htmlSrc), 'genesis picker has a KIMI chip (standard, not a mini-hero card)');
A.ok(!/prov-oauth-grid/.test(htmlSrc) && !/class="prov prov-oauth"/.test(htmlSrc),
  'the grok/kimi mini-hero OAuth cards are gone — ChatGPT is the only hero up top');
{
  const grid = htmlSrc.slice(htmlSrc.indexOf('class="prov-grid"'));
  A.ok(grid.indexOf('data-prov="grok"') >= 0 && grid.indexOf('data-prov="kimi"') >= 0,
    'grok/kimi chips live INSIDE the standard provider grid');
}
A.ok(/id="codex-hint"/.test(htmlSrc), 'the shared sign-in block hint is addressable (per-provider copy)');

/* ---------- 4. app.js wires them through the SHARED device-code engine ---------- */
A.ok(/const OAUTH_GENESIS = Object.freeze\(\{[\s\S]{0,400}grok:[\s\S]{0,400}kimi:/.test(appSrc),
  'app.js declares the genesis OAuth provider table (codex + grok + kimi)');
A.ok(/OAuthSignIn\.for\(pid\)\.start\(/.test(appSrc),
  'grok/kimi sign-in drives the SAME shared engine as Settings (OAuthSignIn.for)');
A.ok(/\/api\/auth\/' \+ pid \+ '\/models/.test(appSrc),
  'grok/kimi model catalogs come from the account-discovery endpoint');
A.ok(/refreshOAuthGenesisStatus/.test(appSrc) && /Harness\.setDesktopConfigured\(pid, oauthConnected\[pid\]\)/.test(appSrc),
  'grok/kimi sign-in state feeds Harness.setDesktopConfigured (the wake sees a live brain)');

/* ---------- 5. the wake gate blocks an unsigned OAuth provider, per provider ---------- */
{
  const attemptStart = appSrc.indexOf('async function onWakeAttempt');
  const attemptBody = appSrc.slice(attemptStart, attemptStart + 6000);
  A.ok(/const readiness = Harness\.readiness\(Harness\.getProv\(\)\)/.test(appSrc) && /if \(!readiness\.unattendedReady\)/.test(appSrc)
    && !/if \(!oauthConnected\[pickedProvider\]\)/.test(attemptBody),
    'onWakeAttempt gates OAuth on common readiness, including extra accounts, without a stale primary-only override');
}

/* ---------- 6. app.js provider vocabulary matches ---------- */
const appNorm = new Function('SK', 'return (' + functionSourceIn(appSrc, 'normalizeProviderId') + ');')({ providers: { registry: Reg } });
for (const alias of ['grok', 'grok-oauth', 'supergrok', 'xai-oauth']) A.eq(appNorm(alias), 'grok', 'app registry preserves OAuth identity: ' + alias);
A.ok(/return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom'[^;]*;/.test(appSrc),
  'app.js providerNeedsKey knows grok/kimi are keyless');

A.report('genesis-oauth-providers.test');
