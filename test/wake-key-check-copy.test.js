/* node test/wake-key-check-copy.test.js — what a FIRST-TIME user reads when WAKE's key check fails.

   Found live by the onboarding sweep (2026-10-20) on a genuinely fresh station (empty workspace, clean browser,
   no key anywhere), CREATE YOUR OVERSEER › OpenRouter › WAKE:
     wrong key      → "could not start — provider rejected this key (HTTP 401) — your previous key is unchanged"
     provider down  → "could not start — fetch failed (ECONNREFUSED) — your previous key is unchanged"
     provider 503   → "could not start — credential probe HTTP 503 — your previous key is unchanged"
   There was no previous key — the tail asserted a credential the station never held — and the two outage lines
   were raw plumbing a beginner cannot act on. The same failures inside a run already read in plain words
   (Friendly.friendlyError); the very first screen did not.

   Behavioral: harness.js's own validateAndSetKey / keyCheckFailure / keyCheckLine run in a vm with the provider
   check stubbed, so the assertion is on the exact message WAKE prints. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./_assert.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'harness.js'), 'utf8');
// keyCheckFailure holds a regex with a brace in a character class, which A.fnBody cannot scan (see _assert.js) —
// lift it the way test/custom-provider-model-id.test.js does.
const kc = /function keyCheckFailure\(status, j, text, code\) \{[\s\S]*?\n  \}/.exec(src);
A.ok(!!kc, 'harness.js has keyCheckFailure');
const fns = [kc ? kc[0] : ''].concat(['function keyCheckLine(', 'async function validateAndSetKey('].map(h => {
  const body = A.fnBody(src, h);
  A.ok(body && body.length < 4000, 'harness.js has ' + h.replace(/\($/, ''));
  return body || '';
}));

async function wake({ had, status, j, text }) {
  const ctx = {
    Friendly: require('../frontend/app/friendlyerror.js'),
    normalizeProviderId: p => p, cleanKey: k => String(k || '').trim(), getProv: () => 'openrouter', getModel: () => 'test/model',
    getBaseUrl: () => '', setKey: () => ({}), hasStoredCredential: () => had, tokenWithheld: '',
    postKeyCheck: async () => ({ r: { ok: status >= 200 && status < 300, status }, j: j || {}, text: text || '' })
  };
  vm.createContext(ctx);
  vm.runInContext(fns.join('\n') + '\nthis.run = () => validateAndSetKey("sk-or-v1-candidate", "openrouter", "test/model");', ctx);
  try { await ctx.run(); return 'NO THROW'; } catch (e) { return e.message; }
}

(async () => {
  // a first-time user: nothing stored, so nothing can be "unchanged"
  const fresh401 = await wake({ had: false, status: 200, j: { error: 'provider rejected this key (HTTP 401)' } });
  A.ok(!/previous key/.test(fresh401), 'a fresh install never hears about a previous key: ' + fresh401);
  A.ok(/rejected this key/.test(fresh401) && /nothing was saved/.test(fresh401), 'the rejection says what happened and that nothing was saved: ' + fresh401);

  const freshDown = await wake({ had: false, status: 200, j: { error: 'fetch failed (ECONNREFUSED)' } });
  A.ok(/couldn.t reach the AI provider/i.test(freshDown) && /internet connection/i.test(freshDown), 'an unreachable provider reads in plain words: ' + freshDown);
  A.ok(/ECONNREFUSED/.test(freshDown), 'the raw cause is kept for support: ' + freshDown);
  A.ok(!/previous key/.test(freshDown), 'no previous-key claim on a fresh outage: ' + freshDown);

  const fresh503 = await wake({ had: false, status: 200, j: { error: 'credential probe HTTP 503' } });
  A.ok(/servers are having trouble/i.test(fresh503) && /try again/i.test(fresh503), 'a provider 5xx reads in plain words: ' + fresh503);

  // a key replacement in Settings (a credential IS stored): the preserved-key truth still rides
  const replace401 = await wake({ had: true, status: 200, j: { error: 'provider rejected this key (HTTP 401)' } });
  A.ok(/your previous key is unchanged/.test(replace401), 'replacing a stored key still reports it was kept: ' + replace401);

  A.report('wake-key-check-copy.test');
})();
