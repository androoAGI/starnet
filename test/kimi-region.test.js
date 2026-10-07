/* test/kimi-region.test.js — Kimi account REGIONS (#70).

   A Kimi account is either Global (kimi.ai) or China (kimi.com) and only signs in at its own deployment; a token
   minted by one region is refused by the other's API. Locks:
     · the pure region table (sidecar/providers/kimi-region.js) — hosts per Moonshot's kimi-code region.ts, the
       legacy rule (a stored credential with no region = China, so pre-#70 sign-ins keep working untouched), and the
       inference-base resolution (stock base of EITHER region -> the credential's own; a custom proxy kept)
     · the sidecar seams (source): device config from the region, the region stamped on the persisted credential at
       sign-in completion (primary AND extra accounts), every Kimi adapter's base resolved through selectProvider,
       status/accounts report the region, a bogus region is refused rather than guessed
     · the browser engine sends { region } on a Kimi start (and never on another provider's), defaulting Global
     · the Moonshot tool dialect also applies on the kimi.ai route. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const KR = require('../sidecar/providers/kimi-region.js');
const toolschema = require('../sidecar/providers/toolschema.js');

// ---- the region table ----
A.eq(KR.oauthUrls('global'), { deviceUrl: 'https://auth.kimi.ai/api/oauth/device_authorization', tokenUrl: 'https://auth.kimi.ai/api/oauth/token' }, 'global signs in at auth.kimi.ai');
A.eq(KR.oauthUrls('cn'), { deviceUrl: 'https://auth.kimi.com/api/oauth/device_authorization', tokenUrl: 'https://auth.kimi.com/api/oauth/token' }, 'china signs in at auth.kimi.com');
A.eq(KR.baseUrlFor('global'), 'https://api.kimi.ai/coding/v1', 'global inference base');
A.eq(KR.baseUrlFor('cn'), 'https://api.kimi.com/coding/v1', 'china inference base');
A.eq(KR.LEGACY_REGION, 'cn', 'the legacy (pre-#70) region is China');

// ---- normalization: named regions land, anything else is refused (null), never guessed ----
for (const v of ['global', 'GLOBAL', ' kimi.ai ', 'intl', 'international']) A.eq(KR.normalizeRegion(v), 'global', 'normalizes ' + JSON.stringify(v) + ' to global');
for (const v of ['cn', 'china', 'mainland-cn', 'kimi.com']) A.eq(KR.normalizeRegion(v), 'cn', 'normalizes ' + JSON.stringify(v) + ' to cn');
for (const v of ['', null, undefined, 'eu', 'moon']) A.eq(KR.normalizeRegion(v), null, 'refuses ' + JSON.stringify(v));

// ---- the stored credential's region: none (every pre-#70 envelope) = China ----
A.eq(KR.regionOfTokens({ access_token: 'x' }), 'cn', 'a legacy credential with no region reads as China');
A.eq(KR.regionOfTokens(null), 'cn', 'no credential at all reads as the legacy region');
A.eq(KR.regionOfTokens({ access_token: 'x', region: 'global' }), 'global', 'a global credential reads as global');
A.eq(KR.regionOfTokens({ access_token: 'x', region: 'garbage' }), 'cn', 'an unreadable stored region falls back to the legacy wire');

// ---- inference base: the credential's region wins over EITHER stock base; a custom proxy is kept ----
A.eq(KR.resolveBaseUrl('global', ''), 'https://api.kimi.ai/coding/v1', 'empty base -> the region base');
A.eq(KR.resolveBaseUrl('global', 'https://api.kimi.com/coding/v1'), 'https://api.kimi.ai/coding/v1', 'a kimi.ai token is never sent to the kimi.com API (registry default)');
A.eq(KR.resolveBaseUrl('cn', 'https://api.kimi.ai/coding/v1/'), 'https://api.kimi.com/coding/v1', 'a kimi.com token is never sent to the kimi.ai API');
A.eq(KR.resolveBaseUrl('cn', 'https://proxy.example/kimi/v1'), 'https://proxy.example/kimi/v1', 'a custom endpoint is left exactly as configured');

// ---- the Moonshot tool dialect covers the global route too ----
A.ok(toolschema.isMoonshotRoute('some-model', 'https://api.kimi.ai/coding/v1'), 'api.kimi.ai is a Moonshot route');
A.ok(toolschema.isMoonshotRoute('some-model', 'https://api.kimi.com/coding/v1'), 'api.kimi.com is still a Moonshot route');

// ---- sidecar seams (index.js self-boots, so these are source locks) ----
const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
A.ok(/function oauthDeviceConfig\(id, deviceId, region\)/.test(src), 'oauthDeviceConfig takes the region');
A.ok(/const urls = kimiRegion\.oauthUrls\(region\);[\s\S]{0,200}deviceUrl: urls\.deviceUrl,\s*tokenUrl: urls\.tokenUrl/.test(src), 'kimi device + token URLs come from the region table');
A.ok(!/auth\.kimi\.com\/api\/oauth/.test(src), 'no hard-coded kimi.com OAuth URL is left in index.js');
A.ok(/const region = id === 'kimi' \? kimiRegion\.regionOfTokens\(tokens\) : '';/.test(src), 'the primary entry boots in its stored credential\'s region');
A.ok(/entry\.region = pid === 'kimi' \? kimiRegion\.regionOfTokens\(tokens\) : '';/.test(src), 'each extra account boots in its OWN stored region');
A.ok(/pending\.region \? \{ region: pending\.region \} : \{\}\);\s*if \(pending\.region\) \{ entry\.region = pending\.region; entry\.auth = auth; \}/.test(src), 'a completed primary sign-in stamps its region on the credential and adopts its auth host');
A.ok(/tokens = Object\.assign\(\{\}, poll, \{ device_id: p\.deviceId \}, p\.region \? \{ region: p\.region \} : \{\}\);/.test(src), 'a completed extra-account sign-in stamps its region too');
A.ok(/if \(opts && normalizeProvider\(opts\.provider\) === 'kimi'\) \{\s*opts = Object\.assign\(\{\}, opts, \{ baseUrl: kimiRegion\.resolveBaseUrl\(opts\.kimiRegion \|\| kimiPrimaryRegion\(\), opts\.baseUrl\) \}\);/.test(src),
  'selectProvider resolves EVERY kimi adapter\'s base from its sign-in region');
A.ok(/kimiRegion: providerId === 'kimi' \? e\.region : undefined/.test(src), 'an extra Kimi account runs on its own region\'s API');
A.ok(/if \(pick\.error\) return json\(400, \{ error: pick\.error, code: 'bad_region' \}\);/.test(src), 'a start naming an unknown region is refused');
A.ok(/if \(id === 'kimi' && entry\.tokens && entry\.tokens\.access_token\) st\.region = /.test(src), 'status names the stored sign-in\'s region');

// ---- the browser engine: a Kimi start carries { region }; other providers' starts stay body-less ----
const store = {};
global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
const calls = [];
global.fetch = async (url, opts) => {
  calls.push({ url, body: opts && opts.body });
  if (/\/(start|add)(\?|$)/.test(url)) return { ok: true, json: async () => ({ user_code: 'U-1', verification_uri: 'https://x/device', device_auth_id: 'd1', interval: 60, expires_in: 900 }) };
  return { ok: true, json: async () => ({ status: 'pending' }) };
};
const signin = require('../frontend/app/codexsignin.js');
const KimiRegion = signin.KimiRegion;
(async () => {
  A.eq(KimiRegion.get(), 'global', 'a fresh browser defaults the next Kimi sign-in to Global');
  KimiRegion.noteSignedIn('cn');
  A.eq(KimiRegion.get(), 'cn', 'a stored China sign-in makes China the re-sign-in default');
  A.ok(KimiRegion.set('global') && KimiRegion.get() === 'global', 'an explicit pick wins over the stored region');
  A.ok(!KimiRegion.set('moon'), 'an unknown region pick is ignored');
  A.eq(KimiRegion.label('cn'), 'CHINA · kimi.com', 'labels name the domain');

  await new Promise(res => signin.OAuthSignIn.for('kimi').start({ onCode: res, onError: res }));
  signin.OAuthSignIn.for('kimi').cancel();
  const kimiStart = calls.find(c => c.url === '/api/auth/kimi/start');
  A.ok(kimiStart && JSON.parse(kimiStart.body).region === 'global', 'the kimi start POST carries the picked region');

  KimiRegion.set('cn');
  await new Promise(res => signin.OAuthAccounts.for('kimi').add({ onCode: res, onError: res }));
  signin.OAuthAccounts.for('kimi').cancel();
  const addStart = calls.find(c => c.url === '/api/auth/kimi/add');
  A.ok(addStart && JSON.parse(addStart.body).region === 'cn', 'an extra Kimi account start carries the picked region');

  await new Promise(res => signin.OAuthSignIn.for('grok').start({ onCode: res, onError: res }));
  signin.OAuthSignIn.for('grok').cancel();
  const grokStart = calls.find(c => c.url === '/api/auth/grok/start');
  A.ok(grokStart && grokStart.body === undefined, 'a grok start stays body-less (regions are Kimi-only)');

  A.report('kimi-region.test');
})();
