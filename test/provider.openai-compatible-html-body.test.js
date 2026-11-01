/* node test/provider.openai-compatible-html-body.test.js - a 200 web page instead of an API answer fails the turn
   AND releases the unread response body, so a streaming HTML page cannot hold its socket open across retries. */
'use strict';
const A = require('./_assert.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

(async () => {
  let cancelled = 0;
  const fetch = async () => ({
    ok: true, status: 200,
    headers: { get: k => (/content-type/i.test(k) ? 'text/html; charset=utf-8' : null) },
    body: { cancel() { cancelled++; return Promise.resolve(); } }
  });
  const p = makeOpenAICompatibleProvider({ fetch, key: 'k', baseUrl: 'https://gateway.example' });
  let err = null;
  try { for await (const _ of p.stream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) { /* drain */ } } catch (e) { err = e; }
  A.ok(err && /returned a web page, not an API response/.test(err.message), 'a web page fails the turn with the fix: ' + (err && err.message));
  A.eq(cancelled, 1, 'the unread HTML body is cancelled before the failure is thrown');
  A.report('provider.openai-compatible-html-body.test');
})().catch(e => { console.log('FAIL: provider.openai-compatible-html-body.test threw -- ' + (e && e.stack || e)); process.exit(1); });
