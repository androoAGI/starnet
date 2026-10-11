/* node test/budgetcaps.tokens.test.js — the PURE resolve/validate for the SUBSCRIPTION usage limits (2026-10-11): the
   daily pool and the per-run ceiling, both OPT-IN (0 = off). Their own key set (TOKEN_KEYS = ['perDayTokens', 'perRunTokens']) beside the four $ keys, which must stay EXACTLY as they were: the
   $ store normalizes through cleanOverrides (only those four keys survive) and budget-caps.test.js pins them. */
'use strict';
const A = require('./_assert.js');
const bc = require('../sidecar/budgetcaps.js');

// the $ surface is unchanged
A.eq(bc.KEYS, ['perRun', 'perAgent', 'perDay', 'global'], 'KEYS is still exactly the four $ keys');
A.eq(bc.cleanOverrides({ perDay: 3, perDayTokens: 15000 }), { perDay: 3 }, 'the $ cleaner drops the token key (it has its own store)');
A.eq(bc.validateOverridesPatch({ perDayTokens: 15000 }).ok, false, 'a token-only body is not a $ patch ("no cap fields")');
A.eq(Object.keys(bc.resolveCaps({}, {})).length, 4, 'resolveCaps still returns exactly 4 keys');

A.eq(bc.TOKEN_KEYS, ['perDayTokens', 'perRunTokens'], 'two token keys: the daily pool and the per-run ceiling');
A.eq(bc.TOKEN_CAP_MAX, 1e12, 'the token ceiling');

// clean
A.eq(bc.cleanTokenOverrides({ perDayTokens: 15000, perDay: 4, junk: 1 }), { perDayTokens: 15000 }, 'only the token key survives');
A.eq(bc.cleanTokenOverrides({ perDayTokens: 0 }), { perDayTokens: 0 }, 'a saved 0 (off) is kept');
A.eq(bc.cleanTokenOverrides({ perDayTokens: -1 }), {}, 'negative is junk');
A.eq(bc.cleanTokenOverrides({ perDayTokens: 1.5 }), {}, 'a fraction is junk (whole tokens only)');
A.eq(bc.cleanTokenOverrides({ perDayTokens: 2e12 }), {}, 'over the ceiling is junk');
A.eq(bc.cleanTokenOverrides({ perDayTokens: '15000' }), {}, 'a string is junk in storage');
A.eq(bc.cleanTokenOverrides(null), {}, 'null -> {}');

// resolve: saved > env > 0
A.eq(bc.resolveTokenCaps({ perDayTokens: 0 }, {}), { perDayTokens: 0, perRunTokens: 0 }, 'shipped default: both off (opt-in)');
A.eq(bc.resolveTokenCaps({}, {}), { perDayTokens: 0, perRunTokens: 0 }, 'no env, no saved -> 0 (off)');
A.eq(bc.resolveTokenCaps({ perDayTokens: 500000 }, {}), { perDayTokens: 500000, perRunTokens: 0 }, 'an env default applies');
A.eq(bc.resolveTokenCaps({ perDayTokens: 500000 }, { perDayTokens: 0 }), { perDayTokens: 0, perRunTokens: 0 }, 'a saved 0 beats the env default (the UI can turn it off)');
A.eq(bc.resolveTokenCaps({ perDayTokens: 500000 }, { perDayTokens: 15000 }), { perDayTokens: 15000, perRunTokens: 0 }, 'a saved value wins');
A.eq(bc.resolveTokenCaps({ perDayTokens: 0, perRunTokens: 2000000 }, { perRunTokens: 500000 }), { perDayTokens: 0, perRunTokens: 500000 }, 'a saved per-run ceiling beats its env default (SKYNET_MAX_UNBILLED_TOKENS)');
A.eq(bc.resolveTokenCaps({ perRunTokens: 2000000 }, { perRunTokens: 0 }).perRunTokens, 0, 'a saved 0 turns the per-run ceiling off over an env default');
A.eq(bc.cleanTokenOverrides({ perRunTokens: 40000, perDayTokens: 1.5 }), { perRunTokens: 40000 }, 'each key is cleaned on its own');
A.eq(bc.validateTokenPatch({ perRunTokens: 40000 }, { perDayTokens: 9 }).overrides, { perDayTokens: 9, perRunTokens: 40000 }, 'a per-run patch merges onto the saved daily limit');
A.ok(/perRunTokens/.test(bc.validateTokenPatch({ perRunTokens: -1 }).error), 'a bad per-run value is refused by name');
A.eq(bc.resolveTokenCaps({ perDayTokens: 1000.7 }, {}), { perDayTokens: 1000, perRunTokens: 0 }, 'a fractional env default floors');
A.eq(bc.resolveTokenCaps({ perDayTokens: -5 }, {}), { perDayTokens: 0, perRunTokens: 0 }, 'a negative env default resolves to 0');

// validate
{
  let v = bc.validateTokenPatch({ perDayTokens: 15000 }, {});
  A.eq(v, { ok: true, touched: true, overrides: { perDayTokens: 15000 } }, 'a number sets it');
  A.eq(bc.validateTokenPatch({ perDayTokens: '15000' }, {}).overrides, { perDayTokens: 15000 }, 'a numeric string from a form parses');
  A.eq(bc.validateTokenPatch({ perDayTokens: 0 }, { perDayTokens: 9 }).overrides, { perDayTokens: 0 }, '0 = off is a real saved choice');
  A.eq(bc.validateTokenPatch({ perDayTokens: null }, { perDayTokens: 9 }).overrides, {}, 'null clears back to the env default');
  A.eq(bc.validateTokenPatch({ perDayTokens: '' }, { perDayTokens: 9 }).overrides, {}, '"" clears too');
  A.eq(bc.validateTokenPatch({ perDay: 5 }, { perDayTokens: 9 }), { ok: true, touched: false, overrides: { perDayTokens: 9 } }, 'a body without the token key is untouched (the host decides)');
  for (const bad of [-1, 1.5, 'lots', NaN, Infinity, 2e12]) {
    v = bc.validateTokenPatch({ perDayTokens: bad }, {});
    A.ok(v.ok === false && /perDayTokens/.test(v.error), 'rejects ' + String(bad) + ': ' + v.error);
  }
  A.eq(bc.validateTokenPatch(null).ok, false, 'a non-object body is refused');
  A.eq(bc.validateTokenPatch([1]).ok, false, 'an array body is refused');
}

A.report('budgetcaps.tokens');
