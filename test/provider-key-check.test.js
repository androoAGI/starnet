/* test/provider-key-check.test.js — a key check that fails must SAY why, in the UI and server-side (#62).

   Reported: a valid, funded OpenRouter key read "not verified" on a headless Linux station reached over an SSH
   tunnel, with nothing logged anywhere. Reproduced: behind a port-remapping forward every POST /api/* was refused
   with a bare 403 "forbidden origin" (fixed in apiauth.js, locked in apiauth.test.js), and the browser folded that
   non-JSON refusal into "the provider did not verify this key". Locks:
     · harness.js keyCheckFailure: a provider verdict passes through; a station refusal names itself + its fix
     · whitespace / zero-width chars inside a pasted key are stripped (browser AND sidecar) — trim() only did the ends
     · the sidecar logs a key-free line for a failed validate/probe and for every refused API call (once per cause)
     · Settings shows the probe's reason under NOT VERIFIED / CHECK FAILED. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const harness = read('frontend', 'app', 'harness.js');
const sidecar = read('sidecar', 'index.js');
const stationui = read('frontend', 'app', 'stationui.js');

// ---- keyCheckFailure (pure, extracted from the browser source) ----
const mFail = /function keyCheckFailure\(status, j, text\) \{[\s\S]*?\n  \}/.exec(harness);
A.ok(mFail, 'harness.js defines keyCheckFailure');
const keyCheckFailure = new Function(mFail[0] + '\nreturn keyCheckFailure;')();
A.eq(keyCheckFailure(200, { error: 'provider rejected this key (HTTP 401)' }, ''), 'provider rejected this key (HTTP 401)', 'a provider verdict passes through verbatim');
A.eq(keyCheckFailure(200, {}, '{}'), 'the provider did not verify this key', 'a 200 with no reason keeps the old wording');
const origin = keyCheckFailure(403, {}, 'forbidden origin');
A.ok(/station refused the key check \(HTTP 403 forbidden origin\)/.test(origin), 'a 403 origin refusal names the station, not the provider: ' + origin);
A.ok(/address/.test(origin), 'the origin refusal says what to do');
A.ok(/reload the page/.test(keyCheckFailure(403, {}, 'forbidden token')), 'a stale-token refusal says reload');
A.ok(/localhost/.test(keyCheckFailure(403, {}, 'forbidden host')), 'a host refusal names the loopback rule');
A.ok(/HTTP 423\)$/.test(keyCheckFailure(423, {}, '<html>frozen</html>')), 'an HTML/JSON-ish body is not pasted into the message');
A.ok(!/did not verify/.test(origin), 'the misleading "provider did not verify" never appears for a station refusal');

// ---- key cleaning: browser and sidecar strip ALL whitespace + zero-width chars ----
const mClean = /const cleanKey = k => String\(k == null \? '' : k\)\.replace\(\/\[\\s\\u200b-\\u200d\\u2060\\ufeff\]\+\/g, ''\);/.exec(harness);
A.ok(mClean, 'harness.js defines cleanKey with the whitespace + zero-width class');
const cleanKey = new Function(mClean[0] + '\nreturn cleanKey;')();
A.eq(cleanKey('  sk-or-v1-abc\n def​\r\n'), 'sk-or-v1-abcdef', 'a wrapped / padded / zero-width-laced key is cleaned');
const mSide = /function cleanProviderKey\(v\) \{[^\n]*\}/.exec(sidecar);
A.ok(mSide, 'index.js defines cleanProviderKey');
const cleanProviderKey = new Function(mSide[0] + '\nreturn cleanProviderKey;')();
A.eq(cleanProviderKey('sk-or-v1-abc\ndef ﻿'), 'sk-or-v1-abcdef', 'the sidecar cleans the candidate the same way');
A.ok(/candidate = cleanProviderKey\(body\.key\);/.test(sidecar), 'validate cleans its candidate');
A.ok(/body\.key = cleanProviderKey\(body\.key\);/.test(sidecar), 'probe cleans the key it is handed');
A.ok(/const candidate = cleanKey\(key\);/.test(harness), 'validateAndSetKey stores the CLEANED key it proved');

// ---- server-side diagnosis: key-free, rate-limited ----
const mNote = /function noteKeyCheckFailure\(route, id, result, candidate\) \{[\s\S]*?\n\}/.exec(sidecar);
A.ok(mNote, 'index.js defines noteKeyCheckFailure');
const logged = [], diag = [];
const noteKeyCheckFailure = new Function('redact', 'recordDiagError', 'console', 'keyCheckNoted',
  mNote[0] + '\nreturn noteKeyCheckFailure;')(s => s, m => diag.push(m), { warn: m => logged.push(m) }, new Map());
const KEY = 'sk-or-v1-0123456789abcdef';
noteKeyCheckFailure('validate', 'openrouter', { status: 401, error: 'provider rejected this key (HTTP 401) ' + KEY }, KEY);
noteKeyCheckFailure('validate', 'openrouter', { status: 401, error: 'provider rejected this key (HTTP 401) ' + KEY }, KEY);
A.eq(logged.length, 1, 'one line per distinct failure (rate-limited)');
A.ok(logged[0] && logged[0].indexOf(KEY) < 0 && /\[key\]/.test(logged[0]), 'the candidate key never reaches the log: ' + logged[0]);
A.ok(/^\[providers\] validate openrouter: provider rejected this key \(HTTP 401\)/.test(logged[0]), 'the line names route, provider and reason (no doubled status)');
A.eq(diag.length, 1, 'the same line lands in the persisted diag error tail');
A.ok(/if \(obj && obj\.credentialVerified === false\) noteKeyCheckFailure\('validate', id, obj, candidate\);/.test(sidecar), 'every failed validate answer is noted');
A.ok(/noteKeyCheckFailure\('probe', id, obj, probeKey\)/.test(sidecar), 'a saved credential failing its probe is noted');

// ---- refused API calls are no longer silent ----
A.ok(/isAllowedApiOrigin\(String\(req\.headers\.origin \|\| ''\), PORT, req\.headers\.host\)\) \{ noteApiRefusal\(req, 'forbidden origin'\);/.test(sidecar), 'rejectApi passes the Host (tunnel same-origin) and notes an origin refusal');
A.ok(/noteApiRefusal\(req, 'forbidden token'\);/.test(sidecar), 'a stale-token refusal is noted');
A.ok(/if \(apiRefusalsSeen\.has\(sig\) \|\| apiRefusalsSeen\.size >= 64\) return;/.test(sidecar), 'refusal notes are once per cause and bounded');

// ---- Settings shows the reason ----
A.ok(/const statWhy = [^\n]*health && !health\.credentialVerified && health\.error/.test(stationui), 'the provider card derives a reason line from the probe');
A.ok(/statWhy \+ '<\/span><\/span>'/.test(stationui), 'the reason renders inside the card status');
A.ok(/error: r\.ok \? String\(\(j && j\.error\) \|\| ''\) : keyCheckFailure\(r\.status, j, text\)/.test(harness), 'a refused probe names the refusal instead of a blank CHECK FAILED');

A.report('provider-key-check.test');
