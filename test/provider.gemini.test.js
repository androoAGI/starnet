/* node test/provider.gemini.test.js - native Google Gemini provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeGeminiProvider, _internals } = require('../sidecar/providers/gemini.js');

const line = obj => 'data: ' + JSON.stringify(obj);
const sseFetch = (sseText, status) => async () => new Response(sseText, { status: status || 200, headers: { 'Content-Type': 'text/event-stream' } });
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

(async () => {
  // A. text turn: GenerateContentResponse chunks become text, usage, and normalized done.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }),
      line({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text chunks stream');
    A.eq(evs.find(e => e.type === 'usage').usage.total_tokens, 5, 'usageMetadata remapped');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'STOP -> stop');
    // USAGE BEFORE DONE (adapter contract): Gemini's final frame carries both; every other adapter yields
    // usage first, and a consumer that breaks at done (auxVisionCall) lost Gemini's tokens — silent under-bill.
    A.ok(evs.findIndex(e => e.type === 'usage') < evs.findIndex(e => e.type === 'done'), 'usage is emitted BEFORE done');
  }

  // B. functionCall parts become one harness tool call with JSON args.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'models/gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const start = evs.find(e => e.type === 'tool_start');
    A.eq(start, { type: 'tool_start', index: 0, id: 'call_0', name: 'web_search' }, 'functionCall start normalized');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'functionCall args JSON emitted');
    A.ok(evs.find(e => e.type === 'tool_done' && e.index === 0), 'tool_done emitted');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'functionCall finish -> tool_calls');
  }

  // B2. a repeated ci:pi:name across SSE frames, each with its OWN nonempty args, is TWO distinct calls — the
  //     args must NOT be concatenated into invalid JSON ({"q":"x"}{"q":"y"}); each gets its own dense index.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'x' } } }] } }] }),
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'web_search', args: { q: 'y' } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    const starts = evs.filter(e => e.type === 'tool_start');
    A.eq(starts.length, 2, 'two distinct tool_start events for the repeated-key-but-distinct-args calls');
    A.eq(starts.map(e => e.index), [0, 1], 'the second call gets its own dense index (not index 0 again)');
    const argsByIdx = {};
    for (const e of evs.filter(e => e.type === 'tool_args')) argsByIdx[e.index] = (argsByIdx[e.index] || '') + e.chunk;
    A.eq(argsByIdx[0], '{"q":"x"}', 'call 0 args are intact (not corrupted by the second call)');
    A.eq(argsByIdx[1], '{"q":"y"}', 'call 1 args are their own valid JSON, never concatenated onto call 0');
  }

  // B3. the NORMAL whole-functionCall case is unchanged: one part, one call, args emitted once.
  {
    const sse = [
      line({ candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: { id: 1 } } }] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-test', messages: [], tools: [{ type: 'function', function: { name: 'lookup' } }] });
    A.eq(evs.filter(e => e.type === 'tool_start').length, 1, 'a single whole functionCall is still exactly one call');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"id":1}', 'whole-call args intact');
  }

  // C. request conversion and URL shape.
  {
    let captured = null;
    const fetchImpl = async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response([line({ candidates: [{ finishReason: 'STOP' }] }), ''].join('\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeGeminiProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://gemini.test/v1beta/' });
    await collect(p, {
      model: 'gemini-test',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 'call_7', content: '{"result":"yes"}' }
      ],
      tools: [{ type: 'function', function: { name: 'web', description: 'd', parameters: { type: 'object' } } }]
    });
    A.eq(captured.url, 'https://gemini.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse', 'POSTs to streamGenerateContent SSE endpoint');
    A.eq(captured.headers['x-goog-api-key'], 'KEY', 'api key sent as x-goog-api-key');
    A.eq(captured.body.systemInstruction, { parts: [{ text: 'sys' }] }, 'leading system -> systemInstruction');
    // A no-argument tool omits `parameters` entirely: Gemini rejects an OBJECT schema whose
    // properties bag is empty ("should be non-empty for OBJECT type").
    A.eq(captured.body.tools[0].functionDeclarations[0], { name: 'web', description: 'd' }, 'OpenAI tool -> Gemini functionDeclaration');
    A.eq(captured.body.contents[0].parts[1], { functionCall: { name: 'web', args: { q: 1 } } }, 'assistant tool_call -> functionCall part');
    A.eq(captured.body.contents[1].parts[0], { functionResponse: { name: 'web', response: { result: 'yes' } } }, 'tool result -> functionResponse part');
  }

  // D. model catalog strips models/ for friendly stored IDs, but modelPath adds it back for calls.
  {
    const fetchImpl = async (url, init) => {
      A.eq(url, 'https://generativelanguage.googleapis.com/v1beta/models', 'lists /models');
      A.eq(init.headers['x-goog-api-key'], 'KEY', 'model listing is authenticated');
      return new Response(JSON.stringify({ models: [{ name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1000, outputTokenLimit: 200, supportedGenerationMethods: ['generateContent'] }] }), { status: 200 });
    };
    const p = makeGeminiProvider({ fetch: fetchImpl, key: 'KEY' });
    const models = await p.listModels();
    A.eq(models[0].id, 'gemini-x', 'models/ prefix stripped for UI');
    A.eq(p.contextLimit('gemini-x'), 1000, 'context limit from inputTokenLimit');
    A.eq(_internals.modelPath('gemini-x'), 'models/gemini-x', 'modelPath restores models/ prefix');
  }

  // Issue #19: a model on a later Google catalog page must remain selectable.
  {
    const urls = [];
    const token = 'next+/=& page';
    const p = makeGeminiProvider({ key: 'KEY', fetch: async (url, init) => {
      urls.push(url);
      A.eq(init.headers['x-goog-api-key'], 'KEY', 'each catalog page uses the selected key');
      const next = new URL(url).searchParams.get('pageToken');
      if (!next) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash' }], nextPageToken: token }));
      A.eq(next, token, 'opaque pagination tokens survive URL encoding');
      return new Response(JSON.stringify({ models: [
        { name: 'models/gemini-2.5-flash' },
        { name: 'models/gemini-3.1-pro-preview', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] }
      ] }));
    } });
    const [models, concurrent] = await Promise.all([p.listModels(), p.listModels()]);
    A.eq(models.map(m => m.id), ['gemini-2.5-flash', 'gemini-3.1-pro-preview'], 'later-page models appear once');
    A.eq(concurrent, models, 'concurrent callers share the complete catalog');
    A.eq(p.contextLimit('models/gemini-3.1-pro-preview'), 1048576, 'later-page context metadata is available');
    await p.listModels();
    A.eq(urls.length, 2, 'a successful complete catalog is cached');
  }
  // A failed or cyclic pagination response must not permanently cache page one.
  for (const failure of ['http', 'cycle']) {
    let healthy = false, calls = 0;
    const p = makeGeminiProvider({ fetch: async url => {
      calls++;
      if (healthy) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.1-pro-preview' }] }));
      if (failure === 'http' && new URL(url).searchParams.has('pageToken')) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ models: [{ name: 'models/first' }], nextPageToken: 'repeat' }));
    } });
    A.eq(await p.listModels(), [], failure + ': incomplete catalog is not published');
    A.ok(calls <= 3, failure + ': pagination terminates');
    healthy = true;
    A.eq((await p.listModels()).map(m => m.id), ['gemini-3.1-pro-preview'], failure + ': a later refresh recovers');
  }

  // E. USER ATTACHMENTS: a user message with an image_url part maps to a Gemini inlineData part (base64 data,
  //    no data: prefix); text is preserved; a plain-string user turn is unchanged.
  {
    const png = 'AAAABBBBCCCC';
    const conv = _internals.messagesToGemini([
      { role: 'user', content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: 'data:image/webp;base64,' + png } }
      ] }
    ]);
    A.eq(conv.contents[0].parts[0], { text: 'describe' }, 'text part preserved');
    A.eq(conv.contents[0].parts[1], { inlineData: { mimeType: 'image/webp', data: png } }, 'data: URL image_url -> inlineData part');

    const plain = _internals.messagesToGemini([{ role: 'user', content: 'hello' }]);
    A.eq(plain.contents[0].parts[0], { text: 'hello' }, 'plain string user turn unchanged');
  }

  A.eq(_internals.finishFor('MAX_TOKENS', false), 'length', 'MAX_TOKENS -> length');
  /* ---- THINKING. This adapter published ['none'] and sent no thinking parameter at all, so a Commander on
       their own Gemini key ran a NON-thinking Gemini. Two contracts, and sending BOTH to a Gemini 3 model is
       a documented error — so the split is asserted, not assumed. ---- */
  {
    let seen = null;
    // Key on the STREAM path specifically: the catalog warm-up hits the same host and would otherwise be
    // mistaken for the generate call (and fires asynchronously, so it can land either side of it).
    const bodyFetch = () => async (url, init) => {
      if (!/streamGenerateContent/.test(url)) return new Response('{"models":[]}', { status: 200 });
      seen = JSON.parse(init.body);
      return new Response('data: {"candidates":[{"finishReason":"STOP"}]}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const ask = async (model, opts, reqOpts) => {
      seen = null;
      const p = makeGeminiProvider(Object.assign({ fetch: bodyFetch(), key: 'k' }, opts || {}));
      for await (const _ of p.stream(Object.assign({ model, messages: [{ role: 'user', content: 'hi' }] }, reqOpts || {}))) { /* drain */ }
      return seen;
    };

    // MODERN (Gemini 3+): thinkingLevel, and NEVER a budget alongside it.
    let b = await ask('gemini-3-pro', { reasoningEffort: 'high' });
    A.eq(b.generationConfig.thinkingConfig, { thinkingLevel: 'HIGH' }, 'a modern Gemini gets thinkingLevel');
    A.eq(b.generationConfig.thinkingConfig.thinkingBudget, undefined, 'and NEVER a budget beside it — that pairing is a documented error');

    // LEGACY (2.5): thinkingBudget, never a level.
    b = await ask('gemini-2.5-flash', { reasoningEffort: 'high' });
    A.eq(typeof b.generationConfig.thinkingConfig.thinkingBudget, 'number', 'a 2.5 model gets a thinkingBudget');
    A.eq(b.generationConfig.thinkingConfig.thinkingLevel, undefined, 'and never a level — 2.5 does not support it');
    A.ok(b.generationConfig.thinkingConfig.thinkingBudget <= 24576, 'the budget stays under the smallest cap in the family');

    // 'none' means OFF on 2.5, and the floor on modern (some Gemini 3 models cannot stop thinking).
    b = await ask('gemini-2.5-flash', { reasoningEffort: 'none' });
    A.eq(b.generationConfig.thinkingConfig.thinkingBudget, 0, "'none' disables thinking on 2.5");
    b = await ask('gemini-3-pro', { reasoningEffort: 'none' });
    A.eq(b.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL', "'none' on a modern model asks for the floor rather than an unsupported off");

    // Pro models cannot accept every Flash thinking setting.
    for (const effort of ['none', 'off', 'disabled', 'minimal', 'low', 'medium', 'high']) {
      const expected = ['medium', 'high'].includes(effort) ? effort.toUpperCase() : 'LOW';
      b = await ask('models/gemini-3.1-pro-preview', { reasoningEffort: effort });
      A.eq(b.generationConfig.thinkingConfig, { thinkingLevel: expected }, '3.1 Pro accepts saved effort ' + effort);
    }
    b = await ask('gemini-2.5-pro', { reasoningEffort: 'none' });
    A.ok(b.generationConfig.thinkingConfig.thinkingBudget >= 128, '2.5 Pro never receives unsupported thinking-off');
    const capabilities = makeGeminiProvider({ fetch: bodyFetch(), key: 'k' });
    A.eq(capabilities.reasoningEfforts('models/gemini-3.1-pro-preview'), ['low', 'medium', 'high'], '3.1 Pro picker lists only supported levels');
    A.eq(_internals.normalizeModel({ name: 'models/gemini-3.1-pro-preview' }).reasoningEfforts, ['low', 'medium', 'high'], 'catalog and wire use the same capability policy');
    A.ok(!capabilities.reasoningEfforts('gemini-2.5-pro').includes('none'), '2.5 Pro picker has no unsupported OFF');
    A.ok(capabilities.reasoningEfforts('gemini-3-flash-preview').includes('minimal'), 'Flash retains minimal thinking');

    // An UNKNOWN Gemini defaults to the MODERN contract — an allowlist of new versions goes stale silently.
    b = await ask('gemini-4-ultra-preview', { reasoningEffort: 'medium' });
    A.eq(b.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM', 'an unrecognised Gemini takes the newest contract');

    // A per-request effort beats the construction default, and a non-Gemini endpoint gets nothing.
    b = await ask('gemini-3-pro', { reasoningEffort: 'low' }, { reasoningEffort: 'high' });
    A.eq(b.generationConfig.thinkingConfig.thinkingLevel, 'HIGH', 'req.reasoningEffort overrides the provider default');
    b = await ask('some-vendor/model', { reasoningEffort: 'high' });
    A.eq(b.generationConfig, undefined, 'a non-Gemini model on a Gemini-shaped endpoint gets no thinking config at all');

    // The published capability must match what the wire accepts, or the dock offers a dead control.
    const p = makeGeminiProvider({ fetch: bodyFetch(), key: 'k' });
    A.eq(p.reasoningEfforts('gemini-3-pro').indexOf('none'), -1, 'a modern model does not advertise an off switch it lacks');
    A.ok(p.reasoningEfforts('gemini-2.5-flash').indexOf('none') >= 0, 'a 2.5 model does advertise one');
  }

  /* ---- THOUGHT SIGNATURES (Gemini 3). A functionCall part arrives with an opaque `thoughtSignature` that
       MUST be echoed on that same functionCall part when the history replays — omit it and every tool
       round-trip 400s ("Function call is missing a thought_signature"), killing the run on its first
       internal tool call. It rides msg.reasoning (the loop's opaque-block park), keyed by call id. ---- */
  {
    // Stream: the signature comes back as an opaque reasoning block keyed by the SAME id tool_start publishes.
    const sse = [
      line({ candidates: [{ content: { parts: [
        { functionCall: { name: 'station_inspect', args: { q: 1 } }, thoughtSignature: 'sig-A' },
        { functionCall: { name: 'fs_list', args: { p: '/' } }, thoughtSignature: 'sig-B' }
      ] }, finishReason: 'STOP' }] }),
      ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: sseFetch(sse), key: 'k' });
    const evs = await collect(p, { model: 'gemini-3-flash', messages: [], tools: [{ type: 'function', function: { name: 'station_inspect' } }] });
    const sigs = evs.filter(e => e.type === 'reasoning' && e.block && e.block.type === 'gemini_tool_signature').map(e => e.block);
    A.eq(sigs, [
      { type: 'gemini_tool_signature', callId: 'call_0', signature: 'sig-A' },
      { type: 'gemini_tool_signature', callId: 'call_1', signature: 'sig-B' }
    ], 'each functionCall signature is parked as a reasoning block keyed by its harness call id');

    // Replay: the parked signature reattaches to ITS OWN functionCall part — and only that part.
    const conv = _internals.messagesToGemini([
      { role: 'assistant', content: '', reasoning: [
        { type: 'gemini_thought', text: 'scratchpad — never replayed as a signature' },
        { type: 'gemini_tool_signature', callId: 'call_0', signature: 'sig-A' },
        { type: 'gemini_tool_signature', callId: 'call_1', signature: 'sig-B' }
      ], tool_calls: [
        { id: 'call_0', function: { name: 'station_inspect', arguments: '{"q":1}' } },
        { id: 'call_1', function: { name: 'fs_list', arguments: '{"p":"/"}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_0', content: '{"ok":true}' }
    ]);
    A.eq(conv.contents[0].parts[0], { functionCall: { name: 'station_inspect', args: { q: 1 } }, thoughtSignature: 'sig-A' }, 'first functionCall replays with ITS signature');
    A.eq(conv.contents[0].parts[1], { functionCall: { name: 'fs_list', args: { p: '/' } }, thoughtSignature: 'sig-B' }, 'second functionCall replays with its own — not the first one\'s');

    // A signature-less transcript (pre-Gemini-3 history, or reasoning stripped on a provider switch) replays
    // byte-identical to before: no thoughtSignature key at all, never an empty one.
    const bare = _internals.messagesToGemini([
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'call_7', function: { name: 'web', arguments: '{}' } }] }
    ]);
    A.eq(bare.contents[0].parts[1], { functionCall: { name: 'web', args: {} } }, 'no parked signature -> the part shape is unchanged');
  }

  /* ---- A THOUGHT PART IS NOT THE ANSWER. Reachable before any thinking parameter existed here: the
       `includeThoughts:false` default is documented as silently ignored on some models. ---- */
  {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"let me work through this","thought":true}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"The answer is 4."}]},"finishReason":"STOP"}]}',
      '', ''
    ].join('\n');
    const p = makeGeminiProvider({ fetch: async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }), key: 'k' });
    const evs = [];
    for await (const e of p.stream({ model: 'gemini-3-pro', messages: [{ role: 'user', content: 'hi' }] })) evs.push(e);
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'The answer is 4.', 'a thought part NEVER reaches the answer the Commander reads');
    A.eq(evs.filter(e => e.type === 'reasoning').length, 1, 'it comes back as reasoning instead, so nothing is silently discarded');
  }

  A.report('provider.gemini.test');
})().catch(e => { console.log('FAIL: provider.gemini.test threw -- ' + (e && e.stack || e)); process.exit(1); });
