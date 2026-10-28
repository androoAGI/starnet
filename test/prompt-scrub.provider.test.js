/* node test/prompt-scrub.provider.test.js — the provider-boundary scrub (L3, context-key-redact 2026-10-28).

   Behind the projectors that scrub stored text, the factory wraps every adapter it builds (attachRequestScrub ->
   prompt-scrub guardRequest): a request leaves the process with the secret values the station HOLDS removed from its
   text. Driven through the REAL factory and REAL openrouter / openai-compatible / anthropic adapters with a fake fetch
   (zero network). Proves:
     W1 no held value reaches the wire body in system, user, assistant, tool content or tool-call arguments
     W2 an UNHELD vendor key in the live user turn still reaches the model (keys.save reads its starts_with hint there)
     W3 tools and a signed thinking block are byte-identical; the request still ends on a user turn
     W4 cacheSystemPrefix is scrubbed with the same rule, so openrouter still splits the cached system prefix
     W5 a request with nothing held in it reaches the adapter as the SAME object (clean station = byte-identical)
     W6 the held list is SNAPSHOT at an adapter's first request (no mid-run prefix churn); a new adapter sees a new value
     W7 the tokenProvider (deferred OAuth) path is wrapped exactly once
     W8 perf: a 512 KB request with 100 held values scrubs in < 30 ms cold and < 2 ms when its history is memoized */
'use strict';
const A = require('./_assert.js');
const context = require('../sidecar/context.js');
const factory = require('../sidecar/providers/factory.js');
const PS = require('../sidecar/prompt-scrub.js');
const FK = require('./helpers/fake-keys.js');
const { by } = FK.make('prompt-scrub-provider');

const VAULT = by.VAULT.value, HELD2 = 'Zt9' + FK.stream('held2', 33, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
let held = [VAULT];
context.setKnownSecretSource(() => held);

const OPENAI_SSE = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n';
const ANTHROPIC_SSE = [
  ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 1, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([e, d]) => 'event: ' + e + '\ndata: ' + JSON.stringify(d) + '\n\n').join('');
function capture(sse) {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (init && init.body && init.method !== 'GET') { try { bodies.push(JSON.parse(init.body)); } catch (_) {} }
    if (!init || init.method === 'GET' || /\/models/.test(String(url))) return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { bodies, fetchImpl };
}
async function drain(p, req) { try { for await (const _ of p.stream(req)) { /* drain */ } } catch (_) { /* the body is captured before any parse */ } }

const TOOLS = [{ type: 'function', function: { name: 'keys_save', description: 'Save a key. starts_with: first chars.', parameters: { type: 'object', properties: { service: { type: 'string', enum: ['Instantly', 'Lemlist'] }, starts_with: { type: 'string' } }, required: ['service'] } } }];
const stablePrefix = 'You are the overseer. Station key on file: ' + VAULT + '. ' + 'stable prefix. '.repeat(20);
function request(model) {
  return {
    model, tools: TOOLS, cacheSystemPrefix: stablePrefix,
    messages: [
      { role: 'system', content: stablePrefix + 'per-conversation tail' },
      { role: 'user', content: 'earlier: my instantly key is ' + VAULT },
      { role: 'assistant', content: 'Saving ' + VAULT.slice(0, 14) + '…', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'keys_save', arguments: JSON.stringify({ service: 'Instantly', starts_with: VAULT }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'saved ' + VAULT },
      { role: 'assistant', content: [{ type: 'text', text: 'Done with ' + VAULT }] },
      { role: 'user', content: [{ type: 'text', text: 'now use this new key ' + by.OPENAI.value + ' and the vault ' + VAULT }] }
    ]
  };
}

(async () => {
  // ---- with no attachment the factory is byte-identical (the adapter object itself) ----
  {
    factory.attachRequestScrub(null);
    const c = capture(OPENAI_SSE);
    await drain(factory.selectProvider({ provider: 'openrouter', key: 'k', baseUrl: 'http://127.0.0.1:9/api/v1', fetch: c.fetchImpl }), request('openai/gpt-5.5'));
    A.ok(JSON.stringify(c.bodies[0] || {}).indexOf(VAULT) >= 0, 'setup: without the attachment the held value reaches the wire (what the guard fixes)');
  }
  factory.attachRequestScrub(PS.guardRequest);

  // ---- W1-W4 through three real adapters ----
  for (const [provider, model, sse, base] of [
    ['openrouter', 'anthropic/claude-sonnet-4.6', OPENAI_SSE, 'http://127.0.0.1:9/api/v1'],
    ['openai', 'gpt-5.5', OPENAI_SSE, 'http://127.0.0.1:9/v1'],
    ['anthropic', 'claude-sonnet-4-5', ANTHROPIC_SSE, 'http://127.0.0.1:9/v1']
  ]) {
    const c = capture(sse);
    const p = factory.selectProvider({ provider, key: 'k', baseUrl: base, fetch: c.fetchImpl });
    const req = request(model);
    if (provider === 'anthropic') req.messages[4] = { role: 'assistant', content: 'Done.', reasoning: [{ type: 'thinking', thinking: 'the vault holds ' + VAULT, signature: 'sig-abc' }] };
    const before = JSON.stringify(req);
    await drain(p, req);
    const body = c.bodies[0];
    A.ok(!!body, provider + ': a request body was captured');
    const wire = JSON.stringify(body || {});
    const thinking = provider === 'anthropic' ? 'the vault holds ' + VAULT : null;
    const withoutThinking = thinking ? wire.split(JSON.stringify(thinking).slice(1, -1)).join('') : wire;
    A.ok(withoutThinking.indexOf(VAULT) < 0 && FK.leak(withoutThinking, by.VAULT) === null, 'W1 ' + provider + ': no held value (or a head of one) in any message text or tool-call argument');
    A.ok(wire.indexOf('[redacted-secret]') >= 0, 'W1 ' + provider + ': the placeholder stands in its place');
    A.ok(wire.indexOf(by.OPENAI.value) >= 0, 'W2 ' + provider + ': an unheld vendor key in the live turn still reaches the model');
    A.eq(JSON.stringify(req), before, provider + ': the caller\'s request object is never mutated');
    const tools = body && (body.tools || []);
    A.ok(JSON.stringify(tools).indexOf('starts_with') >= 0 && JSON.stringify(tools).indexOf('Instantly') >= 0, 'W3 ' + provider + ': tools ride unchanged');
    const msgs = (body && body.messages) || [];
    const last = msgs[msgs.length - 1];
    A.ok(last && last.role === 'user', 'W3 ' + provider + ': the request still ends on a user turn');
    if (thinking) A.ok(wire.indexOf(JSON.stringify(thinking).slice(1, -1)) >= 0 && wire.indexOf('sig-abc') >= 0, 'W3 anthropic: the signed thinking block is byte-identical');
    if (provider === 'openrouter') {
      const sys = msgs[0];
      A.ok(sys && Array.isArray(sys.content) && sys.content[0].cache_control && sys.content[0].text.indexOf('You are the overseer.') === 0 && sys.content[0].text.indexOf(VAULT) < 0,
        'W4 openrouter: the scrubbed cacheSystemPrefix still splits off as the cached block');
    }
  }

  // ---- W5: identity on a clean request; W6: snapshot per adapter instance ----
  {
    const seen = [];
    const fake = { contextLimit: () => 1000, stream: async function* (req) { seen.push(req); yield { type: 'done' }; } };
    const g = PS.guardRequest(fake);
    const clean = { model: 'm', messages: [{ role: 'user', content: 'nothing secret here' }] };
    for await (const _ of g.stream(clean)) { /* drain */ }
    A.ok(seen[0] === clean, 'W5: a request with nothing held in it reaches the adapter as the same object');
    A.eq(typeof g.contextLimit, 'function', 'W5: the guarded adapter keeps every other method');
    held = [VAULT, HELD2];   // a key saved mid-run
    const mid = { model: 'm', messages: [{ role: 'user', content: 'use ' + HELD2 }] };
    for await (const _ of g.stream(mid)) { /* drain */ }
    A.ok(JSON.stringify(seen[1]).indexOf(HELD2) >= 0, 'W6: a value held after this adapter\'s first request is NOT scrubbed mid-run (stable prefix)');
    const g2 = PS.guardRequest(fake);
    for await (const _ of g2.stream(mid)) { /* drain */ }
    A.ok(JSON.stringify(seen[2]).indexOf(HELD2) < 0, 'W6: the next adapter (the next run) scrubs it');
    held = [VAULT];
  }

  // ---- W7: the deferred OAuth path is guarded exactly once ----
  {
    let wraps = 0;
    factory.attachRequestScrub(p => { wraps++; return PS.guardRequest(p); });
    const c = capture(OPENAI_SSE);
    const p = factory.selectProvider({ provider: 'openrouter', tokenProvider: async () => 'tok', baseUrl: 'http://127.0.0.1:9/api/v1', fetch: c.fetchImpl });
    A.eq(wraps, 1, 'W7: building a deferred provider wraps once');
    await drain(p, request('openai/gpt-5.5'));
    A.eq(wraps, 1, 'W7: activating it on the first stream builds the live adapter unwrapped (no second snapshot)');
    A.ok(c.bodies[0] && JSON.stringify(c.bodies[0]).indexOf(VAULT) < 0, 'W7: the deferred request is scrubbed');
    factory.attachRequestScrub(PS.guardRequest);
  }

  // ---- W8: perf budget ----
  {
    const many = Array.from({ length: 100 }, (_, i) => 'Hk' + i + FK.stream('perf' + i, 30, 'abcdefghijklmnopqrstuvwxyz0123456789'));
    held = Object.freeze(many.slice());
    const filler = FK.stream('filler', 1024, 'abcdefghij klmnopqrstuvwxyz ');
    let best = Infinity, bestWarm = Infinity;
    for (let trial = 0; trial < 3; trial++) {
      const msgs = [];
      for (let i = 0; i < 512; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: filler + (i === 300 ? ' ' + many[7] : '') });
      const g = PS.guardRequest({ stream: async function* () {} });
      let t0 = process.hrtime.bigint();
      g.stream({ model: 'm', messages: msgs });
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      msgs.push({ role: 'user', content: 'one more turn' });
      t0 = process.hrtime.bigint();
      g.stream({ model: 'm', messages: msgs });
      bestWarm = Math.min(bestWarm, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    A.ok(best < 30, 'W8: a 512 KB request with 100 held values scrubs in < 30 ms cold (' + best.toFixed(2) + ' ms)');
    A.ok(bestWarm < 2, 'W8: the next turn re-scans only the new message (' + bestWarm.toFixed(3) + ' ms)');
    held = [VAULT];
  }

  A.report('prompt-scrub.provider.test');
})().catch(e => { console.error(e); process.exit(1); });
