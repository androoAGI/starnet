/* node test/provider.remedy.test.js — the REMEDY must survive the cap on a provider failure.

   Reported: an OpenCode key the gateway refused answered "openai-compatible http 401 - [type server_error]
   Upstream request failed: Invalid credential — OpenCode refused this key. It wants a console SERVICE-ACCOUNT key
   (oc_sk_...) with the "Inference" permission — a member token, a session token or a key from another account is
   refused with exactly this me" — the sentence was cut off exactly where the remedy began, so the Commander was left
   with a bare "the key was rejected" and no way forward (2026-10-20).

   The upstream text is the truth and may be long (a cap keeps a log or a toast bounded). StarNet's OWN clause —
   where a key comes from, which card it belongs on — is what the Commander acts on, so it is kept WHOLE.

   Locks:
     · the adapter hands the remedy over as its own field (err.hint), separate from the upstream text
     · the capped failure text keeps that field whole, and still caps the upstream part
     · the validate/probe path (the one that answers the key check) uses that helper
*/
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const sidecar = read('sidecar', 'index.js');

/* the pure helper, lifted out of the source the way the sibling provider tests do */
const mText = /function providerFailureText\(e, cap\) \{[\s\S]*?\n\}/.exec(sidecar);
A.ok(mText, 'index.js defines providerFailureText');
const providerFailureText = new Function(mText[0] + '\nreturn providerFailureText;')();

(async () => {
  // --- a refusal with a remedy: the remedy is its own field ---
  const provider = makeOpenAICompatibleProvider({
    key: 'fixture-only', baseUrl: 'https://opencode.ai/zen/go/v1',
    fetch: async (_url, init) => {
      if (!init || !init.body) return new Response('{"data":[]}');
      return new Response(JSON.stringify({ type: 'server_error', error: { type: 'server_error', message: 'Upstream request failed: Invalid credential' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
  });
  let err = null;
  try {
    for await (const ev of provider.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] })) { void ev; }
  } catch (e) { err = e; }
  A.ok(err, 'a refused key throws');
  A.ok(/Invalid credential/.test(String(err.message)), 'the upstream text stays in the message');
  A.ok(!!err.hint, 'the remedy rides as its own field');
  A.ok(/SERVICE-ACCOUNT/.test(err.hint), 'the remedy names the key kind');
  A.ok(/console/.test(err.hint), 'the remedy names where the key comes from');

  // --- the capped text keeps the remedy WHOLE ---
  const capped = providerFailureText(err, 300);
  A.ok(capped.length > 300, 'the remedy is not cut away by the cap (got ' + capped.length + ' chars)');
  A.ok(capped.indexOf(err.hint) >= 0, 'the remedy is in the capped text');
  A.ok(/Keys\.$/.test(capped.trim()), 'the remedy ends with its instruction, not mid-sentence: ' + capped.slice(-40));
  A.ok(capped.indexOf('Invalid credential') >= 0, 'the upstream truth is still there');
  A.ok(capped.indexOf('Invalid credential') < capped.indexOf(err.hint), 'the upstream text comes first, the remedy last');

  // --- a message WITHOUT a remedy is simply capped ---
  const plain = providerFailureText(new Error('x'.repeat(900)), 300);
  A.eq(plain.length, 300, 'a remedy-less message is capped');
  A.eq(providerFailureText(new Error('short'), 300), 'short', 'a short message passes through');

  // --- the key check answers with that helper, not with a raw slice ---
  A.ok(/providerFailureText\(e, 300\)/.test(sidecar), 'the proof path builds its text with the helper');
  A.ok(!/String\(\(e && e\.message\) \|\| e\)\.slice\(0, 300\)/.test(sidecar), 'the raw cap that ate the remedy is gone');
  A.ok(/const line = '\[providers\] ' \+ route \+ ' ' \+ String\(id \|\| 'unknown'\) \+ ': ' \+ redact\(why\)\.slice\(0, 600\)/.test(sidecar),
    'the server-side key-check line keeps the whole remedy too');

  A.report('provider.remedy.test');
})().catch(e => { console.error(e); A.report('provider.remedy.test'); });
