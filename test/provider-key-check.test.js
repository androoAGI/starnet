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
const { readSidecarSource, functionSourceIn } = require('./helpers/source');
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const harness = read('frontend', 'app', 'harness.js');
const sidecar = process.env.PROVIDER_KEY_CHECK_CONTROL ? fs.readFileSync(process.env.PROVIDER_KEY_CHECK_CONTROL, 'utf8') : readSidecarSource();
const sidecarFunctionSource = name => functionSourceIn(sidecar, name);
const stationui = read('frontend', 'app', 'stationui.js');

// ---- keyCheckFailure (pure, extracted from the browser source) ----
const mFail = /function keyCheckFailure\(status, j, text, code\) \{[\s\S]*?\n  \}/.exec(harness);
A.ok(mFail, 'harness.js defines keyCheckFailure');
const keyCheckFailure = new Function(mFail[0] + '\nreturn keyCheckFailure;')();
A.eq(keyCheckFailure(200, { error: 'provider rejected this key (HTTP 401)' }, ''), 'provider rejected this key (HTTP 401)', 'a provider verdict passes through verbatim');
A.eq(keyCheckFailure(200, {}, '{}'), 'the provider did not verify this key', 'a 200 with no reason keeps the old wording');
const origin = keyCheckFailure(403, {}, 'forbidden origin');
A.ok(/station refused the key check \(HTTP 403 forbidden origin\)/.test(origin), 'a 403 origin refusal names the station, not the provider: ' + origin);
A.ok(/address/.test(origin), 'the origin refusal says what to do');
A.ok(/reload the page/.test(keyCheckFailure(403, {}, 'forbidden token')), 'a stale-token refusal says reload');
// a page the station KEPT its key from (Harness tokenWithheld = the peerowner reason) is not a restarted station: every
// key save on it hits 'forbidden token', and "restarted; reload" would be false (review threads-backend-05 follow-up)
{
  const withheldCheck = new Function('tokenWithheld', mFail[0] + '\nreturn keyCheckFailure;')('other-user');
  const w = withheldCheck(403, {}, 'forbidden token');
  A.ok(/not verified as running under your own user account/.test(w) && /kept its key from this page/.test(w), 'a withheld page\'s refused key check says why: ' + w);
  A.ok(!/restarted|reload/i.test(w), 'and never claims a restart or offers a reload: ' + w);
  A.ok(/reload the page/.test(new Function('tokenWithheld', mFail[0] + '\nreturn keyCheckFailure;')('')(403, {}, 'forbidden token')), 'a keyed page keeps the reload line');
}
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
const verifyPair = sidecarFunctionSource('verifyProviderPair');
const checkRoute = sidecarFunctionSource('providerCheckRoute');
A.ok(/const candidate = cleanProviderKey\(body\.key\);/.test(verifyPair) && /providerRuntimeKey\(id, candidate\)/.test(verifyPair), 'the shared verifier cleans probe input before resolving the credential');
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
A.ok(/providerCheckRoute\(req, res, true\)/.test(sidecarFunctionSource('handleProviderValidate')) && /providerCheckRoute\(req, res, false\)/.test(sidecarFunctionSource('handleProviderProbe')), 'validate and probe enter the same checked response with distinct route labels');

// ---- refused API calls are no longer silent ----
A.ok(/isAllowedApiOrigin\(String\(req\.headers\.origin \|\| ''\), PORT, req\.headers\.host\)\) return refuseAtGate\(req, res, 'forbidden origin'\);/.test(sidecar), 'the Origin check passes the Host (tunnel same-origin) and refuses through refuseAtGate');
A.ok(/function refuseAtGate\(req, res, reason\) \{\n  noteApiRefusal\(req, reason\);/.test(sidecar), 'refuseAtGate notes every refusal before it answers');
A.ok(sidecar.includes("return refuseAtGate(req, res, 'forbidden token');"), 'a stale-token refusal goes through refuseAtGate, so it is noted');
// sidecar-index-06: a page the station WITHHELD its key from sends no key at all. Its refusals must not be logged as "a
// page from before a sidecar restart; reload it" (the station did not restart, and reloading changes nothing).
{
  const m = /function noteApiRefusal\(req, reason\) \{[\s\S]*?\n\}/.exec(sidecar);
  A.ok(m, 'index.js defines noteApiRefusal');
  // the one no-key rule, which refuseAtGate also reads to name token_missing / token_stale on the wire
  const mKey = /function carriesNoKey\(req\) \{[^\n]*\}\n/.exec(sidecar);
  A.ok(mKey, 'index.js defines carriesNoKey');
  const lines = [];
  // a fresh once-per-cause registry per instance, so each case below is logged
  const noter = () => new Function('apiRefusalsSeen', 'apiauth', 'apitickets', 'PORT', 'recordDiagError', 'failNote', 'console', mKey[0] + m[0] + '\nreturn noteApiRefusal;')(
    new Set(), require('../sidecar/apiauth.js'), require('../sidecar/apitickets.js'), 8787, () => {}, () => {}, { warn: l => lines.push(l) });
  const note = noter();
  note({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' } }, 'forbidden token');
  A.ok(lines[0] && !/before a sidecar restart/.test(lines[0]) && /no station key/.test(lines[0]), 'a key-less request is not called a stale page: ' + lines[0]);
  note({ method: 'GET', url: '/api/state', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'x-starnet-token': 'old-launch-key' } }, 'forbidden token');
  A.ok(lines[1] && /before a sidecar restart; reload it/.test(lines[1]), 'a wrong key is still a page from before a restart: ' + lines[1]);
  // the header-less shapes (the COMMS EventSource, the unload save beacon) carry their key as a ?ticket=: a stale
  // ticket is a stale page, not a page the station kept its key from
  noter()({ method: 'GET', url: '/api/channels/events?ticket=old-launch-ticket', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' } }, 'forbidden token');
  A.ok(lines[2] && /before a sidecar restart; reload it/.test(lines[2]) && !/no station key/.test(lines[2]), 'a stale ?ticket= is a page from before a restart: ' + lines[2]);
  noter()({ method: 'GET', url: '/api/channels/events', headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' } }, 'forbidden token');
  A.ok(lines[3] && /no station key/.test(lines[3]), 'the same shape with no ticket carried no key: ' + lines[3]);
}
A.ok(/if \(apiRefusalsSeen\.has\(sig\) \|\| apiRefusalsSeen\.size >= 64\) return;/.test(sidecar), 'refusal notes are once per cause and bounded');

// ---- Settings shows the reason ----
A.ok(/const statWhy = [^\n]*health && !health\.credentialVerified\n[^\n]*health\.error \? String\(health\.error\)/.test(stationui), 'the provider card derives a reason line from the probe');
// org P03: an empty probe error still prints what the probe saw — never a bare NOT VERIFIED / CHECK FAILED
A.ok(/health\.reachable \? 'the provider answered but did not confirm this key' : 'the check got no answer from the provider'/.test(stationui), 'an empty probe error prints a fallback reason');
A.ok(/<span class="prov-stat-t">' \+ stat \+ statWhy \+ [^\n]*'<\/span><\/span>'/.test(stationui), 'the reason renders inside the card status, right under the verdict it explains');
A.ok(/error: r\.ok \? String\(\(j && j\.error\) \|\| ''\) : keyCheckFailure\(r\.status, j, text, stationCodeOf\(r\)\)/.test(harness), 'a refused probe names the refusal (by the gate\'s own code) instead of a blank CHECK FAILED');

// Actual route + shared verifier + diagnostic logger. Only transport/account/storage dependencies are fixtures;
// identity redaction deliberately knows no secrets, so an unsaved echo must be scrubbed by this production path.
async function sharedRouteProof() {
  const secretReader = require('./helpers/credential-store-sandbox.js').sandboxStore({});
  function station(savedKey, oauth = false) {
    const calls = [], lines = [], errors = [], responses = [];
    const base = 'https://fixture-user:fixture-password@fixture.invalid/v1?token=endpoint-secret';
    let verdict = 'reject';
    const deps = {
      getProviderProfile: () => ({}), registryProviderUsesCodex: () => oauth, registryProviderUsesDeviceOAuth: () => false,
      providerUsesCodex: () => oauth, providerUsesDeviceOAuth: () => false,
      providerRuntimeKey: (id, offered) => offered || (oauth ? '' : savedKey), providerRuntimeBaseUrl: () => base,
      providerRequiresKey: () => !oauth, providerRequiresBaseUrl: () => false,
      normalizeProviderIdFromRegistry: id => id === (oauth ? 'codex' : 'openrouter') ? id : '', readBody: async req => req.body,
      providerVerification: { keySlot: () => 'slot', ticket: () => ({}), note() {}, sync() {} },
      orderedAccountChain: () => [{ id: '' }], ensureCodexAccessToken: async () => savedKey,
      oauthPrimaryStatus: () => ({ tokens: { access_token: savedKey } }),
      credStore: { syncReadiness() {}, urlSecretParts: secretReader.urlSecretParts },
      selectProvider: options => ({ verifyCredential: async () => {
        const actualKey = options.key || options.token;
        calls.push(actualKey);
        if (verdict === 'throw') throw new Error('transport echoed ' + actualKey + ' ' + base + ' fixture-password endpoint-secret');
        return { ok: verdict === 'ok', credentialVerified: verdict === 'ok', reachable: true, status: verdict === 'ok' ? 'verified' : 'rejected',
          httpStatus: verdict === 'ok' ? 200 : 401, error: verdict === 'ok' ? '' : 'rejected ' + actualKey,
          cause: verdict === 'ok' ? '' : 'echo ' + actualKey + ' fixture-password endpoint-secret ' + base };
      } }),
      providerReadiness: () => ({ configured: false }), redact: String, keyCheckNoted: new Map(),
      recordDiagError: line => errors.push(line), console: { warn: line => lines.push(line) }, failNote: (tag, e) => { throw e; }
    };
    const names = Object.keys(deps), bodies = ['cleanProviderKey', 'noteKeyCheckFailure', 'verifyProviderPair', 'providerCheckRoute', 'handleProviderProbe', 'handleProviderValidate'].map(sidecarFunctionSource).join('\n');
    const handlers = new Function(...names, bodies + '\nreturn { probe: handleProviderProbe, validate: handleProviderValidate };')(...names.map(name => deps[name]));
    return { calls, lines, errors, responses, setVerdict: value => { verdict = value; }, async request(route, body) {
      let status, wire;
      await handlers[route]({ body: typeof body === 'string' ? body : JSON.stringify(body) }, { writeHead: s => { status = s; }, end: value => { wire = value; } });
      responses.push(wire); A.eq(status, 200, route + ': normal check response status'); return JSON.parse(wire);
    } };
  }
  const saved = 'saved-probe-fixture-key', offered = 'request-probe-fixture-key';
  const s = station(saved);
  const failed = await s.request('probe', { provider: 'openrouter' });
  A.eq(s.calls, [saved], 'saved-key probe verifies the actual resolved credential');
  A.eq(failed.credentialVerified, false, 'saved-key failure stays unverified');
  A.eq(s.lines.length, 1, 'a failed saved-key probe is noted even without a request candidate');
  A.ok(s.lines[0] && s.lines[0].startsWith('[providers] probe openrouter:'), 'saved-key diagnostic names the probe route');
  await s.request('probe', { provider: 'openrouter' });
  A.eq(s.lines.length, 1, 'the repeated saved-key failure is rate-limited');
  A.eq(s.errors, s.lines, 'saved-key failure reaches the durable diagnostic tail once');
  s.setVerdict('ok'); await s.request('probe', { provider: 'openrouter' });
  A.eq(s.lines.length, 1, 'successful verification does not log a failure');
  for (const route of ['probe', 'validate']) {
    const candidate = station(saved);
    await candidate.request(route, { provider: 'openrouter', key: ' \n' + offered + ' ' });
    A.eq(candidate.calls, [offered], route + ': cleaned request credential is verified');
    A.eq(candidate.lines.length, 1, route + ': request-key failure is noted');
    A.ok(!JSON.stringify([candidate.lines, candidate.errors, candidate.responses]).includes(offered), route + ': request credential never escapes');
  }
  const thrown = station(saved); thrown.setVerdict('throw');
  await thrown.request('probe', { provider: 'openrouter' });
  A.eq(thrown.lines.length, 1, 'a saved-key transport exception is also noted');
  A.ok(!JSON.stringify([thrown.lines, thrown.errors, thrown.responses]).includes(saved), 'transport throw cannot expose the privately captured key');
  A.ok(!/fixture-password|endpoint-secret|fixture-user/.test(JSON.stringify([thrown.lines, thrown.errors, thrown.responses])), 'saved endpoint and separately echoed URL credentials are scrubbed on a thrown transport error');
  const signedIn = station('oauth-token-fixture', true); signedIn.setVerdict('throw');
  await signedIn.request('probe', { provider: 'codex' });
  A.eq(signedIn.calls, ['oauth-token-fixture'], 'OAuth probe verifies the actual account token');
  A.eq(signedIn.lines.length, 1, 'a failing saved-token OAuth probe is diagnosed');
  A.ok(!/oauth-token-fixture|fixture-password|endpoint-secret/.test(JSON.stringify([signedIn.lines, signedIn.errors, signedIn.responses])), 'OAuth token and saved endpoint never escape transport-failure diagnostics');
  const missing = station('');
  await missing.request('probe', { provider: 'openrouter' });
  await missing.request('validate', '{invalid');
  await missing.request('probe', { provider: 'unknown', key: offered });
  A.eq([missing.calls.length, missing.lines.length], [0, 0], 'missing credential, malformed JSON and unknown provider invent no verification or credential diagnostic');
  const wire = JSON.stringify([s.lines, s.errors, s.responses]);
  A.ok(!wire.includes(saved) && !/endpoint-secret|fixture-password/.test(wire), 'saved credential and endpoint secrets never enter response or diagnostics');
  A.ok(s.responses.every(text => !/checkedKey|checkedEndpoint|onCredential/.test(text)), 'the diagnostic callback adds no internal credential field to JSON');
}
sharedRouteProof().then(() => A.report('provider-key-check.test')).catch(error => { console.error(error); process.exitCode = 1; });
