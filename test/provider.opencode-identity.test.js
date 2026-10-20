/* node test/provider.opencode-identity.test.js — OpenCode's client contract for third-party agents.

   The 403 "FreeTierError: OpenCode's free tier can only be used from within OpenCode" reads like a rejected
   API key, and it sent a whole diagnosis down the wrong path (2026-10-20). These tests pin the three facts the
   harness now encodes: the client identifies itself, the reserved free models stay out of the picker, and the
   error text says what to DO instead of blaming the key. */
'use strict';
const A = require('./_assert.js');
const identity = require('../sidecar/providers/opencode-identity.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

(async () => {
  // --- which endpoints are OpenCode's ---
  A.ok(identity.isOpenCodeHost('https://opencode.ai/inference/openai/v1'), 'opencode.ai is an opencode endpoint');
  A.ok(identity.isOpenCodeHost('https://api.opencode.ai/v1'), 'a subdomain counts too');
  A.ok(!identity.isOpenCodeHost('https://openrouter.ai/api/v1'), 'openrouter is not an opencode endpoint');
  A.ok(!identity.isOpenCodeHost(''), 'an empty endpoint is not an opencode endpoint');
  A.ok(!identity.isOpenCodeHost('not a url'), 'a broken endpoint is not an opencode endpoint');
  A.ok(!identity.isOpenCodeHost('https://opencode.ai.evil.test/v1'), 'a lookalike host is not opencode');

  // --- the reserved free chat models ---
  A.ok(identity.isFreeOnlyModel('deepseek-v4.1-flash-free'), 'the -free variant is free-only');
  A.ok(identity.isFreeOnlyModel('BEAM-FREE'), 'the check is case-insensitive');
  A.ok(!identity.isFreeOnlyModel('deepseek-v4.1-flash'), 'the paid variant is not free-only');
  A.ok(!identity.isFreeOnlyModel(''), 'an empty id is not free-only');

  // --- the identity headers OpenCode asks a third-party client for ---
  const h = identity.identityHeaders({ baseUrl: 'https://opencode.ai/inference/openai/v1', sessionId: 'stream-42', version: '0.13.5' });
  A.eq(h['User-Agent'], 'starnet/0.13.5', 'the client names itself instead of a generic SDK name');
  A.eq(h['x-opencode-session'], 'stream-42', 'the conversation id rides along');
  A.eq(identity.identityHeaders({ baseUrl: 'https://openrouter.ai/api/v1', sessionId: 'x' }), {}, 'no identity headers towards other providers');
  A.eq(identity.identityHeaders({ baseUrl: 'https://opencode.ai/x' })['x-opencode-session'], undefined, 'without a session id the header stays away');
  A.eq(identity.identityHeaders({ baseUrl: 'https://opencode.ai/x', sessionId: 'a b/c' })['x-opencode-session'], 'abc', 'the session id is sanitized');

  // --- what a failure MEANS ---
  const freeTier = identity.failureHint({ baseUrl: 'https://opencode.ai/x', status: 403, detail: "[type FreeTierError] OpenCode's free tier can only be used from within OpenCode." });
  A.ok(freeTier.indexOf('deepseek-v4.1-flash') >= 0, 'the free-tier hint names a Go model that works');
  A.ok(freeTier.indexOf('oc_sk_') >= 0, 'the free-tier hint names the key kind');
  const badKey = identity.failureHint({ baseUrl: 'https://opencode.ai/x', status: 401, detail: 'Upstream request failed: Invalid credential' });
  A.ok(badKey.indexOf('SERVICE-ACCOUNT') >= 0, 'the invalid-credential hint names the service-account key');
  const noKey = identity.failureHint({ baseUrl: 'https://opencode.ai/x', status: 401, detail: 'Missing API key.' });
  A.ok(noKey.indexOf('no API key') >= 0, 'the missing-key hint says exactly that');
  A.eq(identity.failureHint({ baseUrl: 'https://openrouter.ai/api/v1', status: 403, detail: 'free tier' }), '', 'no opencode hint for other providers');
  A.eq(identity.failureHint({ baseUrl: 'https://opencode.ai/x', status: 500, detail: 'boom' }), '', 'no hint without a known cause');

  // --- the adapter's error message carries the hint, upstream text included ---
  const provider = makeOpenAICompatibleProvider({
    key: 'fixture-only', baseUrl: 'https://opencode.ai/inference/openai/v1',
    fetch: async (_url, init) => {
      if (!init || !init.body) return new Response('{"data":[]}');
      return new Response(JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode." } }),
        { status: 403, headers: { 'content-type': 'application/json' } });
    }
  });
  let message = '';
  try {
    for await (const ev of provider.stream({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hi' }] })) { void ev; }
  } catch (e) { message = String((e && e.message) || e); }
  A.ok(message.indexOf('FreeTierError') >= 0, 'the upstream text stays in the error');
  A.ok(message.indexOf('deepseek-v4.1-flash') >= 0, 'the error also says what to do instead of only blaming the key');

  // --- and the identity headers actually reach the wire ---
  const headers = identity.identityHeaders({ baseUrl: 'https://opencode.ai/inference/openai/v1', sessionId: 'stream-7', version: '0.13.5' });
  let sent = null;
  const identified = makeOpenAICompatibleProvider({
    key: 'fixture-only', baseUrl: 'https://opencode.ai/inference/openai/v1', headers,
    fetch: async (_url, init) => {
      if (!init || !init.body) return new Response('{"data":[]}');
      sent = init.headers;
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  for await (const ev of identified.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] })) { void ev; }
  A.eq(sent && sent['User-Agent'], 'starnet/0.13.5', 'the chat request identifies the client');
  A.eq(sent && sent['x-opencode-session'], 'stream-7', 'the chat request carries the conversation id');
  A.eq(sent && sent['Authorization'], 'Bearer fixture-only', 'the key still rides as the bearer');

  A.report('provider.opencode-identity.test');
})().catch(e => { console.error(e); A.report('provider.opencode-identity.test'); });
