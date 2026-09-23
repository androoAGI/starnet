/* node test/provider.anthropic.test.js - native Anthropic Messages provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeAnthropicProvider, _internals } = require('../sidecar/providers/anthropic.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: Anthropic text deltas, split usage, and end_turn normalize to the harness stream.
  {
    const sse = [
      line({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const p = makeAnthropicProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'claude-test', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream');
    const usage = evs.filter(e => e.type === 'usage').pop().usage;
    A.eq(usage.prompt_tokens, 3, 'message_start input_tokens are retained in final usage');
    A.eq(usage.completion_tokens, 2, 'message_delta output_tokens -> completion_tokens');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'end_turn -> stop');
  }

  // B. tool call: content_block_start/tool_use + input_json_delta fragments become harness tool events.
  {
    const sse = [
      line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const p = makeAnthropicProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'claude-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start, { type: 'tool_start', index: 0, id: 'toolu_1', name: 'web_search' }, 'tool_use start is remapped to dense harness index');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'input_json_delta fragments concatenate');
    A.ok(evs.find(e => e.type === 'tool_done' && e.index === 0), 'tool_done emitted');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'tool_use -> tool_calls');
  }

  // C. request conversion: leading system lifts to top-level system; tools and tool-results use Anthropic shape.
  {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeAnthropicProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://anthropic.test/v1/' });
    await collect(p, {
      model: 'claude-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_7', content: 'result text' }
      ],
      tools: [{ type: 'function', function: { name: 'web', description: 'd', parameters: { type: 'object' } } }]
    });
    A.eq(captured.url, 'https://anthropic.test/v1/messages', 'POSTs to /messages');
    A.eq(captured.headers['x-api-key'], 'KEY', 'api key sent as x-api-key');
    A.eq(captured.headers['anthropic-version'], '2023-06-01', 'Anthropic API version header set');
    A.eq(captured.body.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      'leading system lifted — block form, carrying the cache breakpoint');
    A.eq(captured.body.tools[0], { name: 'web', description: 'd', input_schema: { type: 'object' } }, 'OpenAI tool -> Anthropic tool');
    A.eq(captured.body.messages[0].content[1], { type: 'tool_use', id: 'call_7', name: 'web', input: { q: 1 }, cache_control: { type: 'ephemeral' } },
      'assistant tool_call -> tool_use block (inside the last-3 sliding window, so it carries an anchor)');
    A.eq(captured.body.messages[1].content[0], { type: 'tool_result', tool_use_id: 'call_7', content: 'result text', cache_control: { type: 'ephemeral' } },
      'tool result -> tool_result block (last block of the last turn carries the conversation breakpoint)');
  }

  /* C2. PROMPT CACHING. Anthropic caches by PREFIX over tools -> system -> messages, so the breakpoint has to
     land on the last block of the STATIC prefix or the 59.7% of the request that is tool schemas is re-billed
     every turn. These pin the placement rules, the kill switch, and the aliasing trap. */
  {
    const cap = async (req, patch) => {
      let captured = null;
      const fetchImpl = async (url, init) => {
        captured = JSON.parse(init.body);
        return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      const prev = process.env.SKYNET_ANTHROPIC_CACHE;
      if (patch !== undefined) process.env.SKYNET_ANTHROPIC_CACHE = patch;
      // the flag is resolved at module load, so re-require through a cache bust to observe the OFF path.
      const mod = patch === undefined ? { makeAnthropicProvider }
        : (delete require.cache[require.resolve('../sidecar/providers/anthropic.js')], require('../sidecar/providers/anthropic.js'));
      await collect(mod.makeAnthropicProvider({ fetch: fetchImpl, key: 'k' }), req);
      if (patch !== undefined) {
        if (prev === undefined) delete process.env.SKYNET_ANTHROPIC_CACHE; else process.env.SKYNET_ANTHROPIC_CACHE = prev;
        delete require.cache[require.resolve('../sidecar/providers/anthropic.js')];
      }
      return captured;
    };
    const TOOLS = [{ type: 'function', function: { name: 'a', parameters: { type: 'object' } } }];

    // With a system prompt, SYSTEM is the anchor — it renders after tools, so one breakpoint caches both.
    const withSys = await cap({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: TOOLS });
    A.eq(withSys.system[0].cache_control, { type: 'ephemeral' }, 'system block carries the static-prefix breakpoint');
    A.ok(!withSys.tools[0].cache_control, 'no redundant breakpoint on tools when system already covers them');

    // With NO system prompt the last tool is the only anchor that still covers the tool catalogue.
    const noSys = await cap({ model: 'm', messages: [{ role: 'user', content: 'u' }], tools: TOOLS });
    A.ok(!noSys.system, 'no system block invented when the caller sent none');
    A.eq(noSys.tools[0].cache_control, { type: 'ephemeral' }, 'tools anchor the breakpoint when there is no system prompt');

    /* SLIDING TAIL ANCHORS (2026-07-31): the LAST THREE messages each carry a breakpoint (with the
       static-prefix anchor that is the API's 4-breakpoint max). One trailing anchor was fragile: a
       breakpoint only walks back 20 blocks for its predecessor, and one parallel-tool turn can append
       more than that — the anchor then misses and the whole conversation re-bills cold. Turns older
       than the window stay unstamped: they are read points the slid-off anchors already cover. */
    const convo = await cap({ model: 'm', messages: [
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' }, { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' }
    ] });
    A.ok(!convo.messages[0].content[0].cache_control, 'turns older than the sliding window are read points, not write points');
    A.ok(!convo.messages[1].content[0].cache_control, 'the window is exactly three — the fourth-from-last turn is unstamped');
    A.eq(convo.messages[2].content[0].cache_control, { type: 'ephemeral' }, 'third-from-last turn carries an anchor');
    A.eq(convo.messages[3].content[0].cache_control, { type: 'ephemeral' }, 'second-from-last turn carries an anchor');
    A.eq(convo.messages[4].content[0].cache_control, { type: 'ephemeral' }, 'last turn carries an anchor');

    // ALIASING TRAP: native image blocks pass through by reference, so stamping in place would mutate the
    // caller's own message array and leak cache_control back into harness state.
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } };
    const msgs = [{ role: 'user', content: [img] }];
    await cap({ model: 'm', messages: msgs });
    A.eq(img, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }, 'caller image block is NOT mutated by the breakpoint');

    // Kill switch: billing-affecting behaviour must be disableable without a code change.
    const off = await cap({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: TOOLS }, '0');
    A.ok(!off.system[0].cache_control, 'SKYNET_ANTHROPIC_CACHE=0 drops the system breakpoint');
    A.ok(!off.tools[0].cache_control, 'SKYNET_ANTHROPIC_CACHE=0 drops every breakpoint');
    A.eq(off.system[0].text, 's', 'system content survives with caching off');

    // 1-HOUR TTL (2026-07-31): SKYNET_ANTHROPIC_CACHE_TTL=1h rides every breakpoint. Opt-in because a 1h
    // write bills 2.0x (vs 1.25x) — the right trade only for human-paced conversations with >5min gaps.
    {
      const prevTtl = process.env.SKYNET_ANTHROPIC_CACHE_TTL;
      process.env.SKYNET_ANTHROPIC_CACHE_TTL = '1h';
      delete require.cache[require.resolve('../sidecar/providers/anthropic.js')];
      const mod = require('../sidecar/providers/anthropic.js');
      let got = null;
      const fetchImpl = async (url, init) => {
        got = JSON.parse(init.body);
        return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      await collect(mod.makeAnthropicProvider({ fetch: fetchImpl, key: 'k' }),
        { model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] });
      A.eq(got.system[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'the 1h TTL rides the static-prefix anchor');
      A.eq(got.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' }, 'and the tail anchors');
      if (prevTtl === undefined) delete process.env.SKYNET_ANTHROPIC_CACHE_TTL; else process.env.SKYNET_ANTHROPIC_CACHE_TTL = prevTtl;
      delete require.cache[require.resolve('../sidecar/providers/anthropic.js')];
    }
  }

  // D. model catalog parses /models.
  {
    const fetchImpl = async (url, init) => {
      A.eq(url, 'https://api.anthropic.com/v1/models', 'lists /models');
      A.eq(init.headers['x-api-key'], 'KEY', 'model listing is authenticated');
      return new Response(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }), { status: 200 });
    };
    const p = makeAnthropicProvider({ fetch: fetchImpl, key: 'KEY' });
    const models = await p.listModels();
    A.eq(models[0].id, 'claude-x', 'catalog id parsed');
    A.eq(models[0].supportsTools, true, 'Anthropic native models are marked tool-capable');
  }

  // E. max_tokens default is bumped high (no silent 4096 truncation); explicit + catalog ceilings honored.
  {
    // E1: no explicit max_tokens, cold catalog -> the 32000 fallback (NOT the old 4096).
    let captured = null;
    const fetchImpl = async (url, init) => {
      if (/\/models$/.test(url)) return new Response(JSON.stringify({ data: [{ id: 'claude-cap', display_name: 'X', max_output_tokens: 8192 }] }), { status: 200 });
      captured = { body: JSON.parse(init.body) };
      return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p1 = makeAnthropicProvider({ fetch: fetchImpl, key: 'k' });
    await collect(p1, { model: 'claude-unknown', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(captured.body.max_tokens, 32000, 'cold catalog + no explicit -> 32000 fallback (not 4096)');

    // E2: explicit per-request max_tokens still wins unchanged.
    captured = null;
    await collect(p1, { model: 'claude-unknown', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] });
    A.eq(captured.body.max_tokens, 512, 'explicit max_tokens is honored verbatim');

    // E3: once the catalog is warm, the model's real ceiling is used.
    const p2 = makeAnthropicProvider({ fetch: fetchImpl, key: 'k' });
    await p2.listModels();   // warm the catalog
    captured = null;
    await collect(p2, { model: 'claude-cap', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(captured.body.max_tokens, 8192, "warm catalog -> the model's real max_output_tokens");

    // E4: opts.maxTokens override applies when no explicit/catalog value is available.
    const p3 = makeAnthropicProvider({ fetch: async (url, init) => { if (/\/models$/.test(url)) return new Response('{"data":[]}', { status: 200 }); captured = { body: JSON.parse(init.body) }; return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }, key: 'k', maxTokens: 16000 });
    captured = null;
    await collect(p3, { model: 'claude-unknown', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(captured.body.max_tokens, 16000, 'opts.maxTokens override applied when no explicit/catalog ceiling');
  }

  // F. USER ATTACHMENTS: a user message with image_url parts maps to native Anthropic image blocks (base64 +
  //    url source), text parts are preserved, and a plain-string user turn is unchanged.
  {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m"';   // shape only; content is opaque
    const conv = _internals.messagesToAnthropic([
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
        { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }
      ] }
    ]);
    A.eq(conv.messages[0].content[0], { type: 'text', text: 'what is this?' }, 'text part preserved');
    A.eq(conv.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }, 'data: URL image_url -> base64 image block');
    A.eq(conv.messages[0].content[2], { type: 'image', source: { type: 'url', url: 'https://example.com/a.jpg' } }, 'http(s) image_url -> url image block');

    const plain = _internals.messagesToAnthropic([{ role: 'user', content: 'just text' }]);
    A.eq(plain.messages[0].content[0], { type: 'text', text: 'just text' }, 'plain string user turn unchanged');
  }

  // G. THINKING + EFFORT: the wire contract per model family. Before this the adapter emitted NO thinking
  //    parameter at all and advertised ['none'], so a BYOK Anthropic Commander ran a non-thinking Claude.
  {
    let seen = null;
    const bodyFetch = () => async (url, init) => {
      if (/\/models$/.test(url)) return new Response('{"data":[]}', { status: 200 });
      seen = JSON.parse(init.body);
      return new Response([line({ type: 'message_stop' }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const ask = async (model, providerOpts, reqOpts) => {
      seen = null;
      const p = makeAnthropicProvider(Object.assign({ fetch: bodyFetch(), key: 'k' }, providerOpts || {}));
      await collect(p, Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, reqOpts || {}));
      return seen;
    };

    // G1: MODERN contract — adaptive thinking + output_config.effort, driven by the construction default.
    let b = await ask('claude-opus-5', { reasoningEffort: 'high' });
    A.eq(b.thinking, { type: 'adaptive' }, 'modern Claude -> thinking:{type:adaptive}');
    A.eq(b.output_config, { effort: 'high' }, 'modern Claude -> output_config.effort carries the level');
    A.eq(b.budget_tokens, undefined, 'modern Claude never sends budget_tokens (the wire 400s on it)');

    // G2: a per-request effort beats the construction default (one agent dialled without a new provider).
    b = await ask('claude-opus-5', { reasoningEffort: 'low' }, { reasoningEffort: 'max' });
    A.eq(b.output_config.effort, 'max', 'req.reasoningEffort overrides the provider default');

    // G3: 'none' disables — and deliberately sends NO effort, because the wire refuses a disabled thinking
    //     block above `high` and an omitted effort leaves the always-accepted server default.
    b = await ask('claude-opus-5', { reasoningEffort: 'none' });
    A.eq(b.thinking, { type: 'disabled' }, "effort 'none' -> thinking disabled");
    A.eq(b.output_config, undefined, 'a disable is sent WITHOUT an effort (xhigh/max + disabled is a 400)');

    // G4: the 4.6 family predates `xhigh` — asking for it clamps UP to the strongest level it does publish.
    A.eq(makeAnthropicProvider({ fetch: bodyFetch(), key: 'k' }).reasoningEfforts('claude-sonnet-4-6').indexOf('xhigh'), -1, '4.6 publishes no xhigh');
    b = await ask('claude-sonnet-4-6', { reasoningEffort: 'xhigh' });
    A.eq(b.output_config.effort, 'max', "xhigh on a 4.6 model clamps to 'max', never dropped");

    // G5: LEGACY contract — manual budget_tokens, strictly below max_tokens, and no output_config.
    b = await ask('claude-opus-4-5', { reasoningEffort: 'high' }, { max_tokens: 32000 });
    A.eq(b.thinking.type, 'enabled', 'legacy Claude -> thinking:{type:enabled}');
    A.eq(b.thinking.budget_tokens > 0 && b.thinking.budget_tokens < 32000, true, 'legacy budget_tokens sits below max_tokens');
    A.eq(b.output_config, undefined, 'legacy Claude sends no output_config');

    // G6: a ceiling too small to think under starves the answer — ask for no thinking rather than truncate.
    b = await ask('claude-opus-4-5', { reasoningEffort: 'high' }, { max_tokens: 1000 });
    A.eq(b.thinking, undefined, 'no room above the 1024 floor -> no thinking requested at all');

    // G7: Fable/Mythos think unconditionally; 'none' is not offered and must never reach the wire as disabled.
    A.eq(makeAnthropicProvider({ fetch: bodyFetch(), key: 'k' }).reasoningEfforts('claude-fable-5').indexOf('none'), -1, 'fable publishes no none (disabled is a 400 there)');
    b = await ask('claude-fable-5', { reasoningEffort: 'none' });
    A.eq(b.thinking, { type: 'adaptive' }, "'none' on fable clamps up instead of sending a rejected disable");

    // #32: saved OFF settings must not send an unsupported disable to Opus 5.5.
    for (const model of ['claude-opus-5-5', 'claude-opus-5.5', 'claude-opus-5-5-20260922']) {
      const p = makeAnthropicProvider({ fetch: async () => new Response(JSON.stringify({ data: [{ id: model, display_name: 'Claude Opus 5.5' }] })), key: 'k' });
      const catalog = await p.listModels();
      const row = catalog.find(m => m.id === model);
      A.ok(row && !row.reasoningEfforts.includes('none'), model + ' catalog does not offer OFF');
      const Dock = require('../frontend/app/modeldock.js');
      A.ok(!Dock._internals.effortOptionsFor(row).includes('none'), model + ' picker consumes the supported catalog levels');
      for (const off of ['none', 'off', 'disabled']) {
        b = await ask(model, { reasoningEffort: off });
        A.eq(b.thinking, { type: 'adaptive' }, model + ' saved ' + off + ' uses adaptive thinking');
        A.eq(b.output_config, { effort: 'low' }, model + ' saved ' + off + ' clamps to lowest supported effort');
      }
      b = await ask(model, { reasoningEffort: 'high' }, { reasoningEffort: 'none' });
      A.eq(b.output_config, { effort: 'low' }, model + ' per-run OFF also clamps safely');
      b = await ask(model, { reasoningEffort: 'max' });
      A.eq(b.output_config, { effort: 'max' }, model + ' supported effort stays unchanged');
    }

    // G8: a NON-Claude model reached through an Anthropic-compatible baseUrl gets nothing (provider-compat law).
    b = await ask('some-vendor/mixtral', { reasoningEffort: 'high' });
    A.eq(b.thinking, undefined, 'non-Claude model on an anthropic-shaped endpoint gets no thinking parameter');
    A.eq(b.output_config, undefined, 'non-Claude model gets no output_config either');
  }

  // H. REASONING BLOCKS: thinking must never leak into the answer, and a signed block must survive replay.
  {
    const sse = [
      line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me ' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'check' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } }),
      line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const evs = await collect(makeAnthropicProvider({ fetch: sseFetch(sse), key: 'k' }), { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Answer.', 'thinking deltas NEVER become assistant text');
    const reasoning = evs.filter(e => e.type === 'reasoning');
    A.eq(reasoning.length, 1, 'one reasoning event per completed thinking block');
    A.eq(reasoning[0].block, { type: 'thinking', thinking: 'let me check', signature: 'sig123' }, 'the block is assembled whole: text + signature');

    // An UNSIGNED block cannot be replayed (the wire validates the signature), so it is dropped at the source
    // rather than handed on to fail the NEXT turn.
    const unsigned = [
      line({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'partial' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_stop' }),
      ''
    ].join('\n');
    const evs2 = await collect(makeAnthropicProvider({ fetch: sseFetch(unsigned), key: 'k' }), { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs2.filter(e => e.type === 'reasoning').length, 0, 'an unsigned thinking block is dropped, not replayed');

    // REPLAY ORDER is load-bearing: the thinking block must precede the tool_use it reasoned toward.
    const conv = _internals.messagesToAnthropic([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok', reasoning: [{ type: 'thinking', thinking: 't', signature: 's' }], tool_calls: [{ id: 'c1', function: { name: 'fs_read', arguments: '{}' } }] }
    ]);
    const a = conv.messages[1].content;
    A.eq(a[0], { type: 'thinking', thinking: 't', signature: 's' }, 'reasoning block replays FIRST in the assistant turn');
    A.eq(a[1].type, 'text', 'text follows the thinking block');
    A.eq(a[2].type, 'tool_use', 'tool_use follows both');

    // A message with no reasoning is byte-identical to the pre-thinking shape (every other provider).
    const plain = _internals.messagesToAnthropic([{ role: 'assistant', content: 'hi' }]);
    A.eq(plain.messages[0].content, [{ type: 'text', text: 'hi' }], 'no reasoning field -> unchanged assistant turn');
  }

  A.eq(_internals.normalizeUsage({ input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 }).prompt_tokens, 3, 'cache read tokens are included in prompt total');
  // Cross-run caching: changing runtime metadata must preserve a stable cache boundary,
  // without dropping/reclassifying any system instructions, history or tool definitions.
  {
    const prefix = 'Follow every task check and skill. '.repeat(150);
    const history = [{role:'user',content:'do the task'}, {role:'assistant',content:'checking'}, {role:'user',content:'continue'}];
    let first;
    for (const run of ['run-a','run-b']) {
      let body;
      const p = makeAnthropicProvider({key:'k',fetch:async (_,o)=>{body=JSON.parse(o.body);return new Response('data: {"type":"message_stop"}\n\n');}});
      const text = prefix + '\n[RUNTIME] Run id: ' + run + '\nUse the required approval and verification steps.';
      const messages=[{role:'system',content:text},...history]; const snapshot=JSON.stringify(messages);
      await collect(p,{model:'claude-test',messages,cacheSystemPrefix:prefix,tools:[{type:'function',function:{name:'verify',description:'verify work',parameters:{type:'object',properties:{}}}}]});
      A.eq(body.system.map(b=>b.text).join(''),text,'split preserves every system byte');
      A.eq(body.system.length,2,'stable and changing context have separate blocks');
      A.ok(body.system.every(b=>b.cache_control),'both boundaries remain cacheable');
      A.eq((JSON.stringify(body).match(/cache_control/g)||[]).length,4,'four-breakpoint budget includes tail');
      A.eq(body.tools[0].name,'verify','verification tool retained');
      A.eq(body.messages.map(m=>m.role),history.map(m=>m.role),'history roles unchanged');
      A.eq(JSON.stringify(messages),snapshot,'cache decoration never mutates history');
      if(first) A.eq(body.system[0],first,'stable cache block identical across run IDs');
      first=body.system[0];
    }
    for(const invalid of ['', 'not a prefix']) {
      let body;const p=makeAnthropicProvider({key:'k',fetch:async(_,o)=>{body=JSON.parse(o.body);return new Response('data: {"type":"message_stop"}\n\n');}});
      await collect(p,{model:'claude-test',messages:[{role:'system',content:'policy'}],cacheSystemPrefix:invalid});
      A.eq(body.system.length,1,'mismatch uses unchanged legacy block');
      A.eq(body.system[0].text,'policy','mismatch never drops text');
    }
  }
  A.report('provider.anthropic.test');
})().catch(e => { console.log('FAIL: provider.anthropic.test threw -- ' + (e && e.stack || e)); process.exit(1); });
