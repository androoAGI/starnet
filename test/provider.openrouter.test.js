/* node test/provider.openrouter.test.js — the OpenRouter SSE adapter, fed canned bytes
   through an injected fake fetch. Asserts the exact HarnessEvent stream the proven loop
   consumes: text deltas (keep-alives skipped), index-keyed tool-call accumulation,
   usage with cost, normalized finishReason, and error surfacing. Zero network. */
'use strict';
const A = require('./_assert.js');
const { makeOpenRouterProvider } = require('../sidecar/providers/openrouter.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: deltas assembled, ':' keep-alive skipped, usage(cost), done normalized
  {
    const sse = [
      line({ choices: [{ delta: { content: 'Hel' } }] }),
      ': OPENROUTER PROCESSING',
      line({ choices: [{ delta: { content: 'lo' } }] }),
      line({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0001 } }),
      line({ choices: [{ finish_reason: 'stop', delta: {} }] }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas assembled; keep-alive skipped');
    const u = evs.find(e => e.type === 'usage');
    A.ok(u && u.usage.cost === 0.0001, 'usage event carries real cost');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'finishReason normalized');
  }

  // B. tool call: id+name on first fragment, args split across chunks, concatenated to valid JSON
  {
    const sse = [
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":' } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"candles 2026"}' } }] } }] }),
      line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
      'data: [DONE]', ''
    ].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start.index, 0, 'tool_start index'); A.eq(start.id, 'call_1', 'tool_start id'); A.eq(start.name, 'web_search', 'tool_start name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"query":"candles 2026"}', 'tool_args fragments concatenate to valid JSON');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'finishReason tool_calls');
  }

  // C. mid-stream error chunk throws with the provider message
  {
    const sse = [line({ error: { message: 'rate limited', code: 429 } }), ''].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    let threw = false;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = /rate limited/.test(e.message); }
    A.ok(threw, 'mid-stream error chunk throws with its message');
  }

  // D. HTTP error surfaces status + provider body
  {
    const badFetch = async () => new Response(JSON.stringify({ error: { message: 'no key' } }), { status: 401 });
    const p = makeOpenRouterProvider({ fetch: badFetch, key: '' });
    let msg = '';
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { msg = e.message; }
    A.ok(/401/.test(msg) && /no key/.test(msg), 'http error surfaces status + provider message');
  }

  // E. REGRESSION LOCK: a genuine error whose message merely CONTAINS "abort" still THROWS — it must
  //    not be swallowed as a clean, empty, "successful" turn. Cancellation is detected by signal/name only.
  {
    const sse = [line({ error: { message: 'upstream request was aborted by origin', code: 502 } }), ''].join('\n');
    const p = makeOpenRouterProvider({ fetch: sseFetch(sse), key: 'k' });
    let threw = false;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = /aborted/.test(e.message); }
    A.ok(threw, 'a real error containing "abort" is surfaced, not swallowed');
  }

  // F. a genuine cancellation (the reader throws AbortError) ends the stream CLEANLY — no throw, no events,
  //    so the loop then reports 'cancelled' (not 'error' and not a fake 'done').
  {
    const abortingFetch = async () => ({
      ok: true,
      body: { getReader: () => ({ read: async () => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; } }) }
    });
    const p = makeOpenRouterProvider({ fetch: abortingFetch, key: 'k' });
    let threw = false, evs = [];
    try { evs = await collect(p, { model: 'm', messages: [] }); } catch (e) { threw = true; }
    A.ok(!threw, 'a genuine AbortError ends the stream cleanly');
    A.eq(evs.length, 0, 'no events emitted after a clean cancel');
  }

  // G. a transient 503 is retried, then streams normally (no tokens lost — retry is pre-stream).
  //    Count only /chat/completions POSTs — a cold-catalog run also fires ONE background /models re-warm GET.
  {
    let calls = 0;
    const flaky = async (url) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });   // ignore the re-warm /models GET
      calls++;
      if (calls === 1) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }), 'data: [DONE]', ''].join('\n'),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: flaky, key: 'k' });
    const evs = await collect(p, { model: 'm', messages: [] });
    A.eq(calls, 2, 'a transient 503 triggers exactly one retry');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'hi', 'after retry it streams normally');
  }

  // G2. When all pre-stream attempts fail, the adapter marks its own retry ladder exhausted. The loop uses
  //     this provenance to avoid multiplying these three POSTs into fifteen indistinguishable POSTs.
  {
    let calls = 0, caught;
    const down = async (url) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      calls++;
      return new Response('{"error":{"message":"controlled outage"}}', { status: 503 });
    };
    try { await collect(makeOpenRouterProvider({ fetch: down, key: 'k' }), { model: 'm', messages: [] }); } catch (e) { caught = e; }
    A.eq(calls, 3, 'an immediate 503 is attempted exactly three times inside the adapter');
    A.ok(caught && caught.preStreamRetriesExhausted === true, 'the terminal adapter error records exhausted pre-stream retries');
  }

  // H. a non-transient 400 fails fast with NO retry (again counting only the chat POST, not the /models re-warm)
  {
    let calls = 0;
    const bad = async (url) => { if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 }); calls++; return new Response('{"error":{"message":"bad request"}}', { status: 400 }); };
    const p = makeOpenRouterProvider({ fetch: bad, key: 'k' });
    let threw = false, caught;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { caught = e; threw = /400/.test(e.message); }
    A.ok(threw && calls === 1, 'a 400 fails fast with no retry');
    A.eq(caught.preStreamRetriesExhausted, undefined, 'a fail-fast 400 never claims a retry ladder was exhausted');
  }

  // H2. TOOL-PAIR RECOVERY: a persisted orphan must not permanently 400-brick an OpenRouter chat.
  //     Exercise the real request-building path against a fake upstream that enforces the pairing rule.
  {
    const posted = [];
    const validatingFetch = async (url, opts) => {
      if (!/chat\/completions/.test(url)) return new Response('{"data":[]}', { status: 200 });
      const body = JSON.parse(opts.body);
      posted.push(body.messages);
      const open = new Set();
      let invalid = '';
      for (const msg of body.messages || []) {
        if (msg && msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) open.add(String(tc && tc.id || ''));
        } else if (msg && msg.role === 'tool') {
          const id = String(msg.tool_call_id || '');
          if (!id || !open.delete(id)) invalid = 'No tool call found for tool result ' + id;
        } else if (open.size) invalid = 'Tool call has no result';
      }
      if (open.size) invalid = 'Tool call has no result';
      if (invalid) return new Response(JSON.stringify({ error: { message: invalid } }), { status: 400 });
      return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenRouterProvider({ fetch: validatingFetch, key: 'k' });

    await collect(p, { model: 'm', messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', tool_call_id: 'orphan_1', content: 'result body' }
    ] });
    A.eq(posted[0][1], {
      role: 'user',
      content: '[recovered tool result orphan_1 — its originating call is not in this transcript]\nresult body'
    }, 'orphan result is preserved as labeled user text instead of a 400-invalid tool message');

    await collect(p, { model: 'm', messages: [
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_lost', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
      { role: 'user', content: 'continue' }
    ] });
    A.eq(posted[1][1], {
      role: 'tool', tool_call_id: 'call_lost',
      content: '[interrupted — this call produced no recorded result. Reissue it if it is still needed.]'
    }, 'unanswered call receives a synthetic result before the next conversational message');
    A.eq(posted[1][2], { role: 'user', content: 'continue' }, 'the following user message keeps its place after the repaired pair');
  }

  // H3. Healthy parallel pairs are byte-identical; duplicate results are downgraded without losing content.
  {
    const { repairToolPairs } = require('../sidecar/providers/openrouter.js')._internals;
    const healthy = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'one', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'two', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'A' },
      { role: 'tool', tool_call_id: 'b', content: 'B' }
    ];
    A.eq(repairToolPairs(healthy), healthy, 'well-formed parallel tool history is byte-identical');
    A.ok(repairToolPairs(healthy) === healthy, 'well-formed history returns by identity');

    const duplicate = repairToolPairs(healthy.concat({ role: 'tool', tool_call_id: 'b', content: { kept: true } }));
    A.eq(duplicate[3], {
      role: 'user',
      content: '[recovered tool result b — its originating call is not in this transcript]\n{"kept":true}'
    }, 'duplicate result becomes labeled text and preserves structured content');

    const badIds = repairToolPairs([{ role: 'assistant', content: '', tool_calls: [
      { id: 'same', type: 'function', function: { name: 'one', arguments: '{}' } },
      { id: 'same', type: 'function', function: { name: 'two', arguments: '{}' } },
      { type: 'function', function: { name: 'three', arguments: '{}' } }
    ] }]);
    A.eq(badIds[0].tool_calls.map(tc => tc.id), ['same', 'call_local_1', 'call_local_2'], 'missing or duplicate ids inside one batch are deterministically minted');
    A.eq(badIds.slice(1).map(m => m.tool_call_id), ['same', 'call_local_1', 'call_local_2'], 'every repaired call id receives a matching synthetic result');
  }

  // I. supportsTools reflects the warmed catalog; unknown -> null (never a false refusal)
  {
    const modelsFetch = async () => new Response(JSON.stringify({ data: [
      { id: 'tooly', supported_parameters: ['tools'] },
      { id: 'brainy', supported_parameters: ['tools', 'reasoning_effort'], reasoningEfforts: ['low', 'high'] },
      { id: 'plain', supported_parameters: [] }
    ] }), { status: 200 });
    const p = makeOpenRouterProvider({ fetch: modelsFetch });
    await p.listModels();
    A.eq(p.supportsTools('tooly'), true, 'tool-capable model -> true');
    A.eq(p.supportsTools('plain'), false, 'non-tool model -> false');
    A.eq(p.supportsTools('unknown-xyz'), null, 'unknown model -> null (do not false-refuse)');
    A.eq(p.reasoningEfforts('brainy'), ['low', 'high'], 'declared reasoning efforts are exposed');
    A.eq(p.reasoningEfforts('plain'), ['none'], 'non-reasoning model exposes only reasoning off');
  }

  // I2. reasoning effort is sent only for reasoning-capable models and clamps to the closest supported level.
  {
    const calls = [];
    const capFetch = async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    await collect(makeOpenRouterProvider({ fetch: capFetch, key: 'k', reasoningEffort: 'max' }), { model: 'brainy', messages: [] });
    A.eq(calls[0].body.reasoning, { effort: 'high' }, 'max clamps down to the strongest declared reasoning effort');
    calls.length = 0;
    await collect(makeOpenRouterProvider({ fetch: capFetch, key: 'k', reasoningEffort: 'high' }), { model: 'plain', messages: [] });
    A.eq(calls[0].body.reasoning, undefined, 'non-reasoning model omits the reasoning block');
  }

  // J. REGRESSION LOCK: a cancel during the PRE-STREAM request (POST / retry backoff) ends cleanly as a
  //    cancel — not a thrown error — so the loop reports 'cancelled'. (Caught by the regression review.)
  {
    let calls = 0;
    const p = makeOpenRouterProvider({ fetch: async () => { calls++; return new Response('', { status: 200 }); }, key: 'k' });
    let threw = false, evs = [];
    try { evs = await collect(p, { model: 'm', messages: [], signal: { aborted: true } }); } catch (e) { threw = true; }
    A.ok(!threw, 'a cancel during the pre-stream request ends cleanly (no throw)');
    A.eq(evs.length, 0, 'no events on a pre-stream cancel');
    A.eq(calls, 0, 'aborted before the request was even sent');
  }

  // K. classifier-driven retry replaces the old status whitelist: a 402 (billing) fails fast; a 408
  //    (timeout) now retries — the genuinely new behavior (408 was fail-fast under the hardcoded set).
  {
    let n = 0;
    const billing = async () => { n++; return new Response('{"error":{"message":"insufficient credits"}}', { status: 402 }); };
    let threw = false;
    try { await collect(makeOpenRouterProvider({ fetch: billing, key: 'k' }), { model: 'm', messages: [] }); } catch (e) { threw = /402/.test(e.message); }
    A.ok(threw && n === 1, 'a 402 billing error fails fast (no paid retry burned)');

    let m = 0;
    const timeout = async () => {
      m++;
      if (m === 1) return new Response('{"error":{"message":"request timeout"}}', { status: 408 });
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const evs = await collect(makeOpenRouterProvider({ fetch: timeout, key: 'k' }), { model: 'm', messages: [] });
    A.eq(m, 2, 'a 408 timeout now retries (classifier-derived; was fail-fast under the status whitelist)');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'ok', 'after the 408 retry it streams normally');
  }

  // K2. LOW-CREDIT SELF-HEAL: a 402 that NAMES the affordable ceiling ("can only afford N") retries ONCE with
  //     max_tokens clamped to 90% of N — a funded-but-small balance must run, not strand. A genuinely broke
  //     account (afford < 1024) keeps the honest fail-fast 402.
  {
    let bodies = [];
    const lowCredit = async (url, opts) => {
      bodies.push(JSON.parse(opts.body));
      if (bodies.length === 1) return new Response('{"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 51917."}}', { status: 402 });
      return new Response(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'healed' } }] }), 'data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const evs2 = await collect(makeOpenRouterProvider({ fetch: lowCredit, key: 'k' }), { model: 'm', messages: [] });
    A.eq(bodies.length, 2, '402-with-afford retried exactly once');
    A.eq(bodies[1].max_tokens, Math.floor(51917 * 0.9), 'retry clamped max_tokens to 90% of the stated affordable ceiling');
    A.eq(evs2.filter(e => e.type === 'text').map(e => e.delta).join(''), 'healed', 'the healed request streamed normally');

    let broke = 0;
    const brokeFetch = async () => { broke++; return new Response('{"error":{"message":"can only afford 300."}}', { status: 402 }); };
    let threwBroke = false;
    try { await collect(makeOpenRouterProvider({ fetch: brokeFetch, key: 'k' }), { model: 'm', messages: [] }); } catch (e) { threwBroke = /402/.test(e.message); }
    A.ok(threwBroke && broke === 1, 'afford below the 1024 floor keeps the honest fail-fast 402 (no useless paid retry)');
  }

  // L. prompt caching: applyCacheControl marks the system prefix cacheable for Anthropic-style models ONLY.
  //    NOTE: this asserts the wire SHAPE, not a real cache HIT — Anthropic only caches a prefix above a per-model
  //    minimum (~1024–4096 tokens), so the tiny 'SYS PREFIX' here would run uncached live. A real hit is proven by
  //    test/live.smoke.js (which pads the system prompt past the floor and checks cached_tokens > 0).
  {
    const { applyCacheControl } = require('../sidecar/providers/openrouter.js');
    const msgs = [{ role: 'system', content: 'SYS PREFIX' }, { role: 'user', content: 'hi' }];

    const cached = applyCacheControl(msgs, 'anthropic/claude-sonnet-4.6');
    A.eq(Array.isArray(cached[0].content), true, 'anthropic: system content becomes a block array');
    A.eq(cached[0].content[0].text, 'SYS PREFIX', 'system text preserved in the block');
    A.eq(cached[0].content[0].cache_control.type, 'ephemeral', 'ephemeral cache_control breakpoint set on the system block');
    // the tail message now ALSO carries a sliding anchor (see L1b) — text preserved, source not mutated
    A.eq(cached[1].content[0].text, 'hi', 'tail message text preserved in its anchored block');
    A.ok(cached[1].content[0].cache_control, 'the conversation tail carries a sliding anchor');
    A.eq(msgs[0].content, 'SYS PREFIX', 'pure: input is NOT mutated');
    A.eq(msgs[1].content, 'hi', 'pure: tail input is NOT mutated either');

    A.eq(applyCacheControl(msgs, 'openai/gpt-4o')[0].content, 'SYS PREFIX', 'non-anthropic model: system left as a plain string (no-op)');
    A.eq(applyCacheControl(msgs, 'openai/gpt-4o')[1].content, 'hi', 'non-anthropic model: tail left as a plain string too');
    A.ok(Array.isArray(applyCacheControl([{ role: 'user', content: 'hi' }], 'anthropic/claude-3.5')[0].content), 'no leading system -> the tail anchor still caches the conversation');
    A.eq(applyCacheControl([], 'anthropic/claude-3.5').length, 0, 'empty messages -> unchanged');
  }

  // L1b. SLIDING TAIL ANCHORS (ported from the anthropic adapter): the LAST THREE stampable non-system
  //      messages each carry a breakpoint — with the system anchor, exactly the API's 4-breakpoint maximum.
  //      One trailing anchor is fragile: a breakpoint only looks back 20 content blocks, and one wide
  //      parallel-tool turn can append more — three sliding anchors keep every gap under the window.
  {
    const { applyCacheControl } = require('../sidecar/providers/openrouter.js');
    const msgs = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool', content: 'tool result', tool_call_id: 't1' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q2' }
    ];
    const cached = applyCacheControl(msgs, 'anthropic/claude-sonnet-4.6');
    const anchored = cached.map((m, i) => Array.isArray(m.content) && m.content.some(p => p && p.cache_control) ? i : -1).filter(i => i >= 0);
    A.eq(anchored, [0, 3, 4, 5], 'system anchor + the LAST THREE messages = the 4-breakpoint maximum; older tail untouched');
    A.eq(cached[3].content[0].text, 'tool result', 'a tool-result message keeps its exact text inside the anchored block');
    A.eq(cached[3].tool_call_id, 't1', 'tool_call_id survives the stamp');
    A.eq(cached[1], msgs[1], 'messages beyond the three tail anchors are passed through by reference');
    A.eq(msgs[3].content, 'tool result', 'pure: no input message is mutated');
    // A blank message is never stamped (Anthropic 400s an empty text block); the anchor slides past it.
    const blank = applyCacheControl([
      { role: 'system', content: 'S' }, { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: '' }, { role: 'user', content: 'u3' }
    ], 'anthropic/claude-3.5');
    A.eq(blank[3].content, '', 'a blank message is skipped, not stamped');
    A.ok(Array.isArray(blank[1].content) && blank[1].content[0].cache_control, 'the third anchor slides past the blank onto the next stampable message');
  }

  // L2. caching is actually WIRED into the request body for Anthropic models (and absent for others)
  {
    const grab = async (model) => {
      const calls = [];
      const capFetch = async (url, opts) => { calls.push(opts); return new Response(['data: [DONE]', ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
      await collect(makeOpenRouterProvider({ fetch: capFetch, key: 'k' }), { model, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'u' }] });
      return JSON.parse(calls[0].body);
    };
    const ant = await grab('anthropic/claude-sonnet-4.6');
    A.ok(Array.isArray(ant.messages[0].content) && ant.messages[0].content[0].cache_control, 'stream() sends cache_control on the system block for anthropic');
    const gpt = await grab('openai/gpt-4o');
    A.eq(gpt.messages[0].content, 'S', 'stream() leaves the system content a plain string for non-anthropic');
  }

  // A host continuation must stay after the assistant answer. OpenRouter hoists
  // system messages for Claude; a trailing assistant then becomes forbidden prefill.
  {
    const messages = [
      { role: 'system', content: 'Primary policy' },
      { role: 'system', content: 'Tool policy' },
      { role: 'user', content: 'Write a file' },
      { role: 'assistant', content: 'Written and read back.' },
      { role: 'system', content: '<verify_before_done>Run the authorized check.</verify_before_done>' }
    ];
    const original = JSON.stringify(messages);
    for (const model of ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-5', 'openai/gpt-4o']) {
      let body;
      const fetch = async (url, opts) => {
        if (!url.endsWith('/chat/completions')) return new Response('{"data":[]}');
        body = JSON.parse(opts.body);
        return new Response('data: [DONE]\n\n');
      };
      await collect(makeOpenRouterProvider({ fetch, key: 'k' }), { model, messages });
      const claude = model.startsWith('anthropic/');
      A.eq(body.messages.map(m => m.role), ['system', 'system', 'user', 'assistant', claude ? 'user' : 'system'], model + ': leading policy preserved and continuation remains a conversation turn');
      const tail = body.messages.at(-1).content;
      A.eq(typeof tail === 'string' ? tail : tail[0].text, messages.at(-1).content, model + ': continuation bytes preserved');
    }
    A.eq(JSON.stringify(messages), original, 'provider translation never rewrites durable loop history');
  }

  A.report('provider.openrouter.test');
})();
