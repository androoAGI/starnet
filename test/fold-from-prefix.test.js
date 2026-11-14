/* node test/fold-from-prefix.test.js: A PAID FOLD FROM THE RUN'S OWN PREFIX (cost lane W2.7; STARNET_FOLD_FROM_PREFIX, off by default).

   THE COST. When a long run passes its fold line and the free tier cannot clear it, the paid fold renders the older turns
   to text and sends them to the summarizer as fresh 48k-character prompts. The provider's prompt cache holds those very
   turns from the run's last request, and none of it is read: every folded byte is paid at the full input price.

   THE FIX. With the switch on, the fold sends the run's own next request (the same system prompt, tools, messages and
   effort) with one host message appended, the summarize instruction, and takes the reply as the summary. This file holds:
     1. where it may be done (history-edit.js prefixFold): the switch, the route, the cache's state, the window;
     2. the request and the instruction: nothing of the run's request changes, and the instruction says everything a chunk's
        prompt says (the same summary prompt and sections, the memory block, the previous summary);
     3. the summarizer: one request when the reply is a whole summary; the chunked fold, exactly as it is sent today, when
        the reply is cut, refused, empty, names a tool or is not a summary, or the provider fails; an auxiliary summarizer
        model is never sent the run's prefix;
     4. the adapters: which routes declare it, and that an explicit-anchor route places a fold's anchors where the run's
        last request put them and none after;
     5. the measurement the lane reports, on a hermetic long run through the real loop: bytes sent by the fold and the share
        of them that is an exact prefix of the run's previous request, off and on; nothing is written to the cache; no tool
        the reply names is run; a cold cache, a run that has sent nothing, and an auxiliary model stay chunked.
   The OFF state (byte-identical to the 0.15.2 candidate) and the invariant that is red there: fold-from-prefix.invariant.test.js. */
'use strict';
const A = require('./_assert.js');
const HistoryEdit = require('../sidecar/history-edit.js');
const { makeSummarizer, prefixInstruction, hasSection } = require('../sidecar/compaction-summarizer.js');
const { compactionSummaryPrompt, COMPACTION_SECTIONS } = require('../sidecar/context.js');
const provider = require('../sidecar/providers/provider.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const openrouter = require('../sidecar/providers/openrouter.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');
const factory = require('../sidecar/providers/factory.js');
const prices = require('../sidecar/providers/prices.js');
const cacheTtl = require('../sidecar/providers/cache-ttl.js');
const failopen = require('../sidecar/failopen.js');
const { runLong, flatten, bytesOf, sharedPrefix, filler, fn, MODEL, SUMMARY, NL } = require('./helpers/fold-fixture.js');

for (const name of ['SKYNET_ANTHROPIC_CACHE_TTL', 'SKYNET_ANTHROPIC_MAX_TOKENS', 'STARNET_STABLE_PREFIX', 'SKYNET_STABLE_PREFIX']) delete process.env[name];
const user = text => ({ role: 'user', content: text }), tool = (id, text) => ({ role: 'tool', tool_call_id: id, content: text });
const call = (id, name) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] });
const TOOLS = [fn('noop'), fn('fs_read', { path: { type: 'string' } })];
const convo = n => { const m = [{ role: 'system', content: 'You are a station agent. ' + filler('RULE', 600) }, user('audit every body')]; for (let i = 1; i <= n; i++) m.push(call('c' + i, 'noop'), tool('c' + i, filler('BODY#' + i, 900))); return m; };

/* ---------- 1. where it may be done ---------- */
{
  const sent = convo(3), now = sent.concat([call('c4', 'noop'), tool('c4', 'r4')]);
  const mark = Object.assign(HistoryEdit.sentMark(sent, TOOLS), { at: 1000 });
  const ask = extra => HistoryEdit.prefixFold(Object.assign({ on: true, route: { ttlMs: 300000 }, holdsHistory: false, force: false, last: mark, messages: now, tools: TOOLS,
    now: 61000, promptTokens: 30000, windowTokens: 60000 }, extra));
  A.eq(ask(), { ok: true, read: sent.length }, 'a warm, unedited prefix on a declaring route inside the window: the fold may read it, up to the last request\'s messages');
  A.eq([ask({ on: false }), ask({ on: 1 }), ask({ on: undefined })].map(r => r.why), ['off', 'off', 'off'], 'only the switch itself turns it on');
  A.eq([ask({ route: null }), ask({ route: undefined }), ask({ route: true }), ask({ holdsHistory: true })].map(r => r.why), ['route', 'route', 'route', 'route'],
    'a route that declares nothing, and a provider that holds the history itself (the claude-cli child), keep the chunked fold');
  A.eq(ask({ force: true }).why, 'overflow', 'an overflow recovery is already past the window');
  A.eq([ask({ last: null }), ask({ last: { keys: [], toolsKey: mark.toolsKey } })].map(r => r.why), ['unsent', 'unsent'], 'a run that has sent nothing has nothing cached');
  const edited = now.slice(); edited[3] = tool('c1', 'an aged result');
  A.eq([ask({ messages: edited }), ask({ messages: now.slice(0, 4) }), ask({ tools: TOOLS.concat([fn('web_fetch')]) })].map(r => r.why), ['edited', 'edited', 'edited'],
    'a changed message, a shorter list or a revealed tool since the last request: the entries behind the change are dead');
  const inPlace = sent.map(m => Object.assign({}, m)), markIn = Object.assign(HistoryEdit.sentMark(inPlace, TOOLS), { at: 1000 });
  inPlace[3].content = 'rewritten in place after it was sent';
  A.eq(HistoryEdit.prefixFold({ on: true, route: { ttlMs: 300000 }, last: markIn, messages: inPlace, tools: TOOLS, promptTokens: 1, windowTokens: 60000 }).why, 'edited',
    'a turn rewritten in place is seen too: the mark keeps keys, not the messages');
  const withThinking = now.map((m, i) => (i === 2 ? Object.assign({}, m, { reasoning: [{ type: 'thinking', thinking: '', signature: 'sig' }] }) : m));
  A.eq(ask({ messages: withThinking }).ok, true, 'thinking is not part of a wire key (the request view strips what an edit invalidates, never an append)');
  A.eq([ask({ now: 1000 + 300000 - 30000 }).ok, ask({ now: 1000 + 300000 - 29999 }).why, ask({ now: 1000 + 3600000 - 29999, route: { ttlMs: 3600000 } }).why, ask({ now: 1000 + 3600000 - 30000, route: { ttlMs: 3600000 } }).ok],
    [true, 'cold', 'cold', true], 'a last request older than the cache keeps an entry (less a 30 s margin) is cold');
  A.eq([ask({ now: undefined }).ok, ask({ last: Object.assign({}, mark, { at: null }), now: 9e9 }).ok], [true, true], 'with no clock reading the age is not judged');
  A.eq([ask({ promptTokens: 52000 }).ok, ask({ promptTokens: 52001 }).why, ask({ windowTokens: 400000, promptTokens: 380000 }).ok, ask({ windowTokens: 400000, promptTokens: 380001 }).why],
    [true, 'window', true, 'window'], 'the prefix must leave room for the instruction and the summary: 8,000 tokens, or 5% of a larger window');
}

/* ---------- 2. the request and the instruction ---------- */
{
  const base = { model: 'm', messages: convo(2), tools: TOOLS, isTask: true, runId: 'r', cacheSystemPrefix: 'You are a station agent.', reasoningEffort: 'high', maxTokens: 4096 };
  const frozen = JSON.stringify(base), req = HistoryEdit.prefixFoldRequest(base, 'INSTRUCTION', 4);
  A.eq(JSON.stringify(base), frozen, 'the run\'s own request is not touched');
  A.ok(req.tools === TOOLS && req.messages.slice(0, base.messages.length).every((m, i) => m === base.messages[i]), 'the tools array and every message are the run\'s own objects');
  A.eq(req.messages.at(-1), { role: 'system', content: 'INSTRUCTION' }, 'the instruction is ONE host message appended (a later system message: every adapter sends it as a user turn)');
  A.eq([req.model, req.isTask, req.runId, req.cacheSystemPrefix, req.reasoningEffort, req.maxTokens, req.prefixRead], ['m', true, 'r', 'You are a station agent.', 'high', 4096, 4],
    'every field the run\'s requests carry rides unchanged, and the request names how much of it the last request carried');
  A.eq(['tool_choice', 'toolChoice', 'neverReread'].filter(k => k in req), [], 'no tool choice is set (a changed one loses the cached messages) and the request is not marked never-reread (it must be anchored to read)');
  A.eq([provider.prefixReadOf(req), provider.prefixReadOf(base), provider.prefixReadOf(Object.assign({}, req, { prefixRead: req.messages.length })), provider.prefixReadOf(null)], [4, 0, 0, 0],
    'an adapter reads the count only from a request that is longer than it');

  for (const prev of ['', 'OLD SUMMARY TEXT']) {
    const text = prefixInstruction({ prompt: compactionSummaryPrompt({ prevSummary: !!prev }), memBlock: '[durable memory]' + NL + '- prefers tabs', prevSummary: prev, kept: 4, keptHead: 'the  kept\ntail  begins here' });
    A.ok(text.indexOf('<host_turn>' + NL) === 0 && text.endsWith(NL + '</host_turn>'), 'the instruction is fenced as a host turn (provider.js LOOP_HOST_TAGS)');
    A.ok(provider.LOOP_HOST_TAGS.indexOf('host_turn') >= 0, 'a tag every route already keeps for the host and makes inert in anyone else\'s text');
    A.ok(text.includes(compactionSummaryPrompt({ prevSummary: !!prev })), 'it carries the summary prompt a chunk gets, word for word (' + (prev ? 'merge' : 'fresh') + ')');
    A.eq(COMPACTION_SECTIONS.filter(s => text.includes('## ' + s)), COMPACTION_SECTIONS, 'so every required section is asked for');
    A.ok(text.includes('carried forward VERBATIM'), 'and the rule that collected results are never dropped');
    A.ok(text.includes('[durable memory]' + NL + '- prefers tabs' + NL + NL), 'the durable memory block rides as a chunk\'s does');
    A.eq(text.includes('PREVIOUS SUMMARY (update this — merge the new turns in, drop anything now obsolete):' + NL + 'OLD SUMMARY TEXT' + NL + NL), !!prev, 'the previous summary rides exactly as a chunk gets it, only when there is one');
    A.ok(text.includes('Summarize the earlier part of the conversation above so it can replace the raw turns.'), 'the same ask');
    A.ok(/not from the Commander\. Do not continue the task and do not call any tool: reply with the summary and nothing else\./.test(text), 'it says who is speaking, and that no tool may be called');
    A.ok(text.includes('The newest 4 messages above stay in the conversation word for word after your summary (that part begins: "the kept tail begins here").')
      && text.includes('If you are unsure whether something belongs to the replaced part, include it.'), 'it says what stays, and to include whatever is in doubt (never less than a chunked summary)');
  }
  A.ok(prefixInstruction({ prompt: 'P', kept: 0 }).includes('Every turn above is replaced by the summary, so it must carry all of it.') && prefixInstruction({ prompt: 'P', kept: 1 }).includes('The newest 1 message above stays in'),
    'nothing kept, or one message kept, is said plainly');
  A.eq([hasSection(SUMMARY), hasSection('## Completed'), hasSection('  ## completed: ' + NL + '- x'), hasSection('## Remaining Work (next)'), hasSection('## Done', ['Done'])], [true, true, true, true, true],
    'a summary holds at least one of the demanded sections as a heading line');
  A.eq([hasSection('I will now read the next file.'), hasSection('text ## Completed inline'), hasSection('## Notes' + NL + 'x'), hasSection('## Completedness'), hasSection(''), hasSection(null)], [false, false, false, false, false, false],
    'prose that carries on with the task, a heading inside a sentence, another heading and nothing at all are not summaries');
}

/* ---------- 3. the summarizer ---------- */
(async () => {
  const older = convo(40).slice(1);   // 40 results of 900 characters, folded in 12k-character chunks below (several requests)
  const base = { model: 'run-model', messages: convo(42), tools: TOOLS, isTask: true, runId: 'r', reasoningEffort: 'high', cacheSystemPrefix: 'You are a station agent.' };
  // a provider whose replies are scripted per request: text | { text, finish, tool, fail }
  const scripted = replies => {
    const requests = [];
    return { requests, stream: async function* (req) {
      requests.push(req);
      const r = replies(req, requests.length), o = typeof r === 'string' ? { text: r } : r;
      if (o.fail) throw Object.assign(new Error(o.fail), { status: 400 });
      if (o.tool) { yield { type: 'tool_start', index: 0, id: 't', name: o.tool }; yield { type: 'tool_args', index: 0, chunk: '{}' }; }
      if (o.text) yield { type: 'text', delta: o.text };
      yield { type: 'usage', usage: { prompt_tokens: 100, completion_tokens: 10 } };
      yield { type: 'done', finishReason: o.finish || (o.tool ? 'tool_calls' : 'stop') };
    } };
  };
  const isPrefix = req => Number.isSafeInteger(req.prefixRead);
  const wire = req => JSON.stringify(Object.assign({}, req, { signal: undefined }));
  const run = async (replies, extra, live) => {
    const p = scripted(replies), drains = [], settled = [];
    const summarize = makeSummarizer(Object.assign({ provider: p, model: 'run-model', summaryPrompt: compactionSummaryPrompt, auxEffortFor: () => 'low', runId: 'r', chunkChars: 12000,
      transcriptDrain: o => drains.push(o.length), memoryBlockFor: () => '[durable memory]' }, extra));
    let out = null, error = null;
    try { out = await summarize(older, 'PREV', Object.assign({ settleAttempt: a => { settled.push(a.model); return { usd: 1, tokensIn: 100, tokensOut: 10 }; } }, live)); } catch (e) { error = e; }
    return { out, error, requests: p.requests, drains, settled };
  };
  const prefix = { request: base, read: 80, kept: 6, keptHead: 'kept head' };
  const chunked = await run(() => SUMMARY, null, {});   // today's fold: what every fallback must send

  const taken = await run(() => SUMMARY, null, { prefix });
  A.eq([taken.requests.length, taken.out.summary, taken.out.prefix, taken.out.chunks, taken.out.truncatedChars, taken.out.prefixFallback, taken.drains], [1, SUMMARY, true, 1, 0, undefined, [older.length]],
    'a whole summary: ONE request, its reply is the summary, the transcript is drained once first');
  const sent = taken.requests[0];
  A.ok(sent.tools === TOOLS && sent.messages.slice(0, base.messages.length).every((m, i) => m === base.messages[i]) && sent.messages.length === base.messages.length + 1, 'it is the run\'s own request with one message appended');
  A.eq([sent.model, sent.reasoningEffort, sent.cacheSystemPrefix, sent.isTask, sent.runId, sent.prefixRead, sent.stream, 'neverReread' in sent, 'tool_choice' in sent], ['run-model', 'high', 'You are a station agent.', true, 'r', 80, true, false, false],
    'on the run\'s own effort (never the auxiliary effort: another effort misses the run\'s cache), with the run\'s fields');
  const said = sent.messages.at(-1).content;
  A.ok(sent.messages.at(-1).role === 'system' && said.includes(compactionSummaryPrompt({ prevSummary: true })) && said.includes('PREVIOUS SUMMARY') && said.includes('PREV' + NL) && said.includes('[durable memory]') && said.includes('The newest 6 messages') && said.includes('"kept head"'),
    'the instruction carries the merge prompt, the previous summary, the memory block and what stays');
  A.eq([taken.out.usd, taken.out.tokens, taken.settled], [1, 110, ['run-model']], 'its spend is booked like any attempt\'s');

  const cases = [
    ['a reply that names a tool', () => ({ tool: 'noop', text: SUMMARY }), 'tool-call'],
    ['a reply cut at the output cap', () => ({ text: '## Completed' + NL + '- VALUE_01=', finish: 'length' }), 'length'],
    ['a reply the provider withheld', () => ({ text: '', finish: 'content_filter' }), 'content_filter'],
    ['a refusal', () => 'I\'m sorry, but I can\'t provide the requested summary.', 'refusal'],
    ['an empty reply', () => '', 'empty'],
    ['a reply that carries on with the task', () => 'Next I will read body 9 and compare it with body 3.', 'no-sections'],
    ['a provider error (a prompt past the window)', () => ({ fail: 'prompt is too long: 210000 tokens > 200000 maximum' }), 'error']
  ];
  for (const [label, first, why] of cases) {
    const r = await run((req, n) => (isPrefix(req) ? first() : SUMMARY), null, { prefix });
    A.eq([r.error, r.out && r.out.prefixFallback, r.out && r.out.prefix, r.out && r.out.summary, r.out && r.out.chunks], [null, why, undefined, SUMMARY, chunked.out.chunks], label + ': not taken (' + why + '), and the chunked fold gives the summary');
    A.eq(r.requests.slice(1).map(wire), chunked.requests.map(wire), label + ': the chunked fold is sent exactly as today\'s (the same requests, from the same previous summary)');
    A.eq([r.settled.length, r.drains], [chunked.requests.length + 1, [older.length]], label + ': the failed attempt is booked, and the transcript drained once');
  }
  A.ok(chunked.requests.length >= 2 && chunked.requests.every(req => req.neverReread === true && !req.tools && req.reasoningEffort === 'low'), 'the control: today\'s fold is ' + chunked.requests.length + ' toolless never-reread chunk requests on the auxiliary effort');

  const aux = await run(() => SUMMARY, { auxModelFor: () => 'cheap-model' }, { prefix });
  A.eq([aux.requests.some(isPrefix), aux.requests.every(req => req.model === 'cheap-model'), aux.out.prefixSkipped, aux.out.prefixFallback, aux.out.summary], [false, true, 'aux-model', undefined, SUMMARY],
    'an auxiliary summarizer model is never sent the run\'s prefix (nothing is cached for it): chunked on that model, as before');
  const ac = new AbortController(); ac.abort();
  const aborted = await run(() => SUMMARY, { signal: ac.signal }, { prefix });
  A.eq([aborted.error && aborted.error.name, aborted.requests.length], ['AbortError', 0], 'a cancelled run sends nothing');
  const refused = await run(() => SUMMARY, null, { prefix, beforeAttempt: async () => false });
  A.eq([refused.error && refused.error.message, refused.requests.length], ['compaction call was not admitted', 0], 'a refused spend ends the fold, as it does for a chunk (no fallback past a spend stop)');
  const off = await run(() => SUMMARY, null, { prefix: null });
  A.eq(off.requests.map(wire), chunked.requests.map(wire), 'no prefix handed over: today\'s requests');

  /* ---------- 4. the adapters ---------- */
  {
    const fetch = async () => new Response('{"data":[]}', { status: 200 });
    const anth = makeAnthropicProvider({ fetch, key: 'k' });
    A.eq([anth.prefixFold('claude-opus-5-5'), anth.prefixFold('claude-haiku-5-5'), anth.prefixFold('some-vendor-model')], [{ ttlMs: 300000 }, { ttlMs: 300000 }, null],
      'the Anthropic route declares it for a Claude model, with the life of a tail anchor\'s entry');
    process.env.SKYNET_ANTHROPIC_CACHE_TTL = '1h';
    A.eq([anth.prefixFold('claude-opus-5-5'), openrouter.prefixFoldFor('anthropic/claude-opus-5.5'), cacheTtl.tailTtlMs()], [{ ttlMs: 3600000 }, { ttlMs: 3600000 }, 3600000], 'one hour when every anchor is on the 1-hour tier');
    process.env.SKYNET_ANTHROPIC_CACHE_TTL = 'mixed';
    A.eq([anth.prefixFold('claude-opus-5-5'), cacheTtl.tailTtlMs()], [{ ttlMs: 300000 }, 300000], 'five minutes under the mixed tiers: the newest messages are anchored on the 5-minute tier there');
    delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
    A.eq([openrouter.prefixFoldFor('anthropic/claude-sonnet-5.5'), openrouter.prefixFoldFor('openai/gpt-5.5'), openrouter.prefixFoldFor('google/gemini-3-pro')], [{ ttlMs: 300000 }, null, null],
      'OpenRouter declares it for a Claude model (explicit anchors); any other model\'s cache is its upstream\'s, and nothing is declared');
    const compat = o => makeOpenAICompatibleProvider(Object.assign({ fetch, key: 'k', baseUrl: 'https://api.example.test/v1' }, o));
    A.eq([compat({ priceFamily: 'openai' }).prefixFold('gpt-5.5'), compat({ priceFamily: 'deepseek' }).prefixFold('deepseek-chat'), compat({ priceFamily: 'mistral' }).prefixFold('mistral-large')],
      [{ ttlMs: 300000 }, { ttlMs: 300000 }, { ttlMs: 300000 }], 'a vendor endpoint whose price family documents a cached-input rate declares it');
    A.eq([compat({ priceFamily: 'xai' }).prefixFold('grok-4'), compat({ priceFamily: 'groq' }).prefixFold('x'), compat({}).prefixFold('local-model'), compat({ nativeOllama: true, baseUrl: 'http://127.0.0.1:11434/v1' }).prefixFold('qwen3:8b')],
      [null, null, null, null], 'a family with no documented cache rate, a custom endpoint and a local server declare nothing');
    const managed = compat({ cacheControl: openrouter.applyCacheControl, cacheAnchors: openrouter.cacheAnchorsFor, prefixFold: openrouter.prefixFoldFor, priceFamily: 'openai' });
    A.eq([managed.prefixFold('anthropic/claude-opus-5.5'), managed.prefixFold('openai/gpt-5.5')], [{ ttlMs: 300000 }, null], 'the managed route answers as its stamper does: a Claude model only');
    A.eq([prices.cachesPrompts('openai'), prices.cachesPrompts('anthropic'), prices.cachesPrompts('xai'), prices.cachesPrompts('toString'), prices.cachesPrompts(null)], [true, true, false, false, false], 'the price table is the one place a family\'s cache is known');
    const built = id => factory.selectProvider({ provider: id, key: 'k', token: 't', baseUrl: id === 'custom' ? 'http://127.0.0.1:9/v1' : undefined, fetch });
    const says = (id, model) => { const p = built(id); return typeof p.prefixFold === 'function' ? !!p.prefixFold(model) : false; };
    A.eq([says('anthropic', 'claude-opus-5-5'), says('openrouter', 'anthropic/claude-opus-5.5'), says('openai', 'gpt-5.5'), says('deepseek', 'deepseek-chat'), says('codex', 'gpt-5.5-codex')], [true, true, true, true, true],
      'through the provider factory: the Anthropic API, Claude through OpenRouter, the OpenAI and DeepSeek APIs and the ChatGPT sign-in can');
    A.eq([says('openrouter', 'openai/gpt-5.5'), says('xai', 'grok-4'), says('ollama', 'qwen3:8b'), says('custom', 'local'), says('gemini', 'gemini-3-pro'), says('claude-cli', 'claude-opus-5-5')], [false, false, false, false, false, false],
      'and the others cannot: their fold stays chunked');
    A.eq(built('claude-cli').holdsHistory(), true, 'the Claude Code route holds the run\'s history in its own child (and runs the model\'s tool calls itself)');

    // an explicit-anchor route places a fold's anchors where the run's last request put them, and none after
    const bodies = [];
    const recording = makeAnthropicProvider({ key: 'k', reasoningEffort: 'medium', fetch: async (url, init) => {
      if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
      bodies.push(JSON.parse(init.body));
      return new Response(['data: ' + JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }), 'data: ' + JSON.stringify({ type: 'message_stop' }), ''].join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const send = async req => { for await (const ev of recording.stream(req)) void ev; return bodies.at(-1); };
    for (const mode of ['', 'mixed']) {
      if (mode) process.env.SKYNET_ANTHROPIC_CACHE_TTL = mode; else delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
      const stable = 'You are a station agent.';
      const lastSent = convo(6); lastSent.splice(1, 0, { role: 'system', content: provider.runContextNote ? provider.runContextNote('[RUNTIME] run r') : '<run_context>x</run_context>' });
      const next = lastSent.concat([call('c7', 'noop'), tool('c7', filler('BODY#7', 900))]);
      const common = { model: MODEL, tools: TOOLS, stream: true, cacheSystemPrefix: stable };
      const was = await send(Object.assign({}, common, { messages: lastSent }));
      const plain = await send(Object.assign({}, common, { messages: next.concat([{ role: 'system', content: 'INSTRUCTION' }]) }));
      const fold = await send(HistoryEdit.prefixFoldRequest(Object.assign({}, common, { messages: next }), 'INSTRUCTION', lastSent.length));
      const a = flatten(was), f = flatten(fold), p = flatten(plain), label = 'anthropic' + (mode ? ' (' + mode + ' tiers)' : '');
      A.ok(sharedPrefix(a, f).whole, label + ': the run\'s last request is, block for block, the start of the fold request');
      A.eq(f.map((x, i) => (x.bp ? i : -1)).filter(i => i >= 0), a.map((x, i) => (x.bp ? i : -1)).filter(i => i >= 0), label + ': its anchors sit on exactly the blocks that request anchored');
      A.eq(f.filter(x => x.bp).map(x => x.ttl), a.filter(x => x.bp).map(x => x.ttl), label + ': on the same tiers');
      A.ok(f.slice(a.length).every(x => !x.bp) && f.length > a.length, label + ': the turns after it and the instruction carry none (nothing is written)');
      A.ok(p.slice(a.length).some(x => x.bp), label + ': the control: the same messages sent as an ordinary request anchor their newest blocks (a write the run would never read)');
      A.eq([JSON.stringify(fold.tools), JSON.stringify(fold.system), JSON.stringify(fold.thinking), JSON.stringify(fold.output_config), 'tool_choice' in fold],
        [JSON.stringify(was.tools), JSON.stringify(was.system), JSON.stringify(was.thinking), JSON.stringify(was.output_config), false], label + ': tools, system, thinking and effort are the run\'s bytes, and no tool choice is sent');
      A.eq(JSON.stringify(Object.assign({}, fold, { messages: null })), JSON.stringify(Object.assign({}, plain, { messages: null })), label + ': outside the message anchors the fold is the ordinary request');
    }
    delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
    const wireOf = list => provider.chatWireMessages(provider.chatRoleProjection(provider.prepareWireMessages(list, 'chat'), 'anthropic/claude-opus-5.5'));
    const lastSent = convo(6), next = lastSent.concat([call('c7', 'noop'), tool('c7', 'r7'), { role: 'system', content: 'INSTRUCTION' }]);
    const stamped = openrouter.applyCacheControl(wireOf(lastSent), 'anthropic/claude-opus-5.5', 'You are a station agent.', false);
    const folded = openrouter.applyCacheControl(wireOf(next), 'anthropic/claude-opus-5.5', 'You are a station agent.', false, wireOf(lastSent));
    const anchored = list => list.map((m, i) => (JSON.stringify(m).includes('cache_control') ? i : -1)).filter(i => i >= 0);
    A.eq([anchored(folded), JSON.stringify(folded.slice(0, stamped.length))], [anchored(stamped), JSON.stringify(stamped)], 'OpenRouter (Claude): the fold\'s anchors are the last request\'s, message for message, and nothing after them is anchored');
    A.ok(anchored(openrouter.applyCacheControl(wireOf(next), 'anthropic/claude-opus-5.5', 'You are a station agent.', false)).some(i => i >= stamped.length), 'the control: an ordinary request anchors its newest messages');
    A.eq(JSON.stringify(openrouter.applyCacheControl(wireOf(next), 'openai/gpt-5.5', '', false, wireOf(lastSent))), JSON.stringify(wireOf(next)), 'a model with no explicit anchors is sent as it is');
  }

  /* ---------- 5. the long run: off and on ---------- */
  failopen.resetForTests();
  const offRun = await runLong({});
  const onRun = await runLong({ foldFromPrefix: true });
  const before = run => run.runs.filter(p => p.n < run.folds[0].n).at(-1);
  const tally = run => { const prev = before(run); return { requests: run.folds.length, bytes: run.folds.reduce((n, f) => n + bytesOf(f.positions), 0),
    shared: run.folds.reduce((n, f) => n + sharedPrefix(prev.positions, f.positions).bytes, 0), fresh: run.folds.reduce((n, f) => n + f.usage.fresh, 0),
    read: run.folds.reduce((n, f) => n + f.usage.cacheRead, 0), written: run.folds.reduce((n, f) => n + f.usage.cacheWrite, 0) }; };
  const mOff = tally(offRun), mOn = tally(onRun), pct = (a, b) => (100 * a / b).toFixed(1) + '%';
  const weigh = (m, read) => Math.round(m.fresh + m.written * 1.25 + m.read * read);
  console.log('[fold-from-prefix] a run that folds after 8 tool results (60k-token window, 19k characters per result):');
  console.log('[fold-from-prefix]   OFF fold: ' + mOff.requests + ' requests, ' + mOff.bytes + ' bytes sent, ' + mOff.shared + ' (' + pct(mOff.shared, mOff.bytes) + ') an exact prefix of the run\'s previous request; tokens fresh ' + mOff.fresh + ' / cache read ' + mOff.read + ' / cache written ' + mOff.written + '; input at 0.1x reads ' + weigh(mOff, 0.1));
  console.log('[fold-from-prefix]   ON  fold: ' + mOn.requests + ' request,  ' + mOn.bytes + ' bytes sent, ' + mOn.shared + ' (' + pct(mOn.shared, mOn.bytes) + ') an exact prefix of the run\'s previous request; tokens fresh ' + mOn.fresh + ' / cache read ' + mOn.read + ' / cache written ' + mOn.written + '; input at 0.1x reads ' + weigh(mOn, 0.1) + ' (at 0.05x: ' + weigh(mOn, 0.05) + ')');
  A.eq([offRun.res.reason, onRun.res.reason, offRun.ran, onRun.ran], ['done', 'done', 11, 11], 'both runs finish their eleven tool calls');
  A.ok(mOff.requests >= 3 && offRun.folds.every(f => f.kind === 'chunk' && f.anchors === 0) && mOff.read === 0 && mOff.shared / mOff.bytes < 0.01,
    'off: the fold is ' + mOff.requests + ' chunk requests; none reads the cache and none of their bytes are the run\'s own request');
  A.eq([mOn.requests, onRun.folds[0].kind, mOn.written], [1, 'prefix', 0], 'on: the fold is ONE request from the run\'s prefix, and it writes nothing to the cache');
  A.ok(sharedPrefix(before(onRun).positions, onRun.folds[0].positions).whole && mOn.shared / mOn.bytes > 0.85, 'on: the run\'s previous request is, whole, the start of it (' + pct(mOn.shared, mOn.bytes) + ' of its bytes)');
  A.eq(mOn.read, before(onRun).usage.total, 'on: everything the previous request sent is read from the cache');
  A.ok(mOn.fresh < mOff.fresh / 4 && weigh(mOn, 0.1) < weigh(mOff, 0.1) / 3, 'on: fresh input tokens fall from ' + mOff.fresh + ' to ' + mOn.fresh + ' (weighted at 0.1x reads: ' + weigh(mOff, 0.1) + ' to ' + weigh(mOn, 0.1) + ')');
  const fold = onRun.folds[0].body, prior = before(onRun).body;
  A.eq([JSON.stringify(fold.tools), JSON.stringify(fold.system), JSON.stringify(fold.thinking), JSON.stringify(fold.output_config), fold.model, 'tool_choice' in fold],
    [JSON.stringify(prior.tools), JSON.stringify(prior.system), JSON.stringify(prior.thinking), JSON.stringify(prior.output_config), prior.model, false], 'on: the fold carries the run\'s tools, system, thinking, effort and model, byte for byte, and no tool choice');
  const thinking = p => p.positions.filter(x => x.text.indexOf('assistant:{"type":"thinking"') === 0).map(x => x.text);
  A.eq([thinking(before(onRun)).length, thinking(onRun.folds[0]).length, JSON.stringify(thinking(onRun.folds[0]).slice(0, 7)) === JSON.stringify(thinking(before(onRun)))], [7, 8, true],
    'on: every signed thinking block the run replays rides the fold unchanged, with the newest turn\'s after them (an append: none is unbound)');
  A.eq(onRun.runs.map(p => p.raw).slice(0, 8), offRun.runs.map(p => p.raw).slice(0, 8), 'the run\'s own requests before the fold are the same bytes off and on');
  A.eq([onRun.runs[8].raw === offRun.runs[8].raw, onRun.runs.length, offRun.runs.length], [true, 12, 12], 'and after it too: the same summary note, the same kept tail, the same requests');
  A.eq([offRun.compacts.length, JSON.stringify(Object.keys(offRun.compacts[0]).sort()), onRun.compacts[0].prefix, onRun.compacts[0].chunks, 'prefixWhy' in onRun.compacts[0]],
    [1, JSON.stringify(['afterTokens', 'agentId', 'beforeTokens', 'chunks', 'reason', 'removed', 'runId']), true, 1, false], 'agent.compact: unchanged off; on it says the summary came from the prefix');
  A.eq([offRun.drained, onRun.drained, failopen.counts()['loop.compaction.prefixFold'] || 0], [[12], [12], 0], 'the folded turns are drained to the transcript first either way, and nothing is noted');

  // a reply that names a tool: nothing runs, the chunked fold takes over
  failopen.resetForTests();
  const called = await runLong({ foldFromPrefix: true, foldReply: () => [{ type: 'tool_use', name: 'noop', input: { step: 99 } }] });
  A.eq([called.res.reason, called.ran, called.folds.map(f => f.kind).join(','), called.compacts[0].prefixWhy, called.compacts[0].prefix, failopen.counts()['loop.compaction.prefixFold']],
    ['done', 11, 'prefix,chunk,chunk,chunk', 'tool-call', undefined, 1], 'a fold reply that names a tool: the tool is never run (11 runs, as scripted), the chunked fold runs, and the fallback is noted');
  A.eq(called.folds.slice(1).map(f => f.raw), offRun.folds.map(f => f.raw), 'and that chunked fold is byte for byte the fold of a run with the switch off');
  // a provider error on the fold request (a prompt the provider calls too long)
  failopen.resetForTests();
  const failed = await runLong({ foldFromPrefix: true, foldReply: () => ({ status: 400, message: 'prompt is too long: 210000 tokens > 200000 maximum' }) });
  A.eq([failed.res.reason, failed.folds.map(f => f.kind).join(','), failed.compacts[0].prefixWhy, failed.folds.slice(1).map(f => f.raw).join('') === offRun.folds.map(f => f.raw).join('')],
    ['done', 'prefix,chunk,chunk,chunk', 'error', true], 'a provider error on the fold request: today\'s chunked fold, and the run goes on');
  // a cold cache: the last tool call before the fold took six minutes
  let t = 1000000;
  const cold = await runLong({ foldFromPrefix: true, clock: { now: () => t }, onTool: k => { t += k === 8 ? 360000 : 20000; } });
  A.eq([cold.res.reason, cold.folds.map(f => f.kind).join(','), cold.compacts[0].prefixWhy], ['done', 'chunk,chunk,chunk', 'cold'], 'a last request older than the cache keeps it: no fold from the prefix is sent (it would write the prefix again for nothing)');
  t = 1000000;
  const warm = await runLong({ foldFromPrefix: true, clock: { now: () => t }, onTool: () => { t += 60000; } });
  A.eq([warm.folds.map(f => f.kind).join(','), warm.folds[0].usage.cacheWrite, warm.folds[0].usage.cacheRead > 30000], ['prefix', 0, true], 'a minute between requests is warm: read from the cache, nothing written');
  // a resumed history already past the line: the run has sent nothing yet
  const resumed = [{ role: 'system', content: 'You are a station agent. ' + filler('RULE', 1800) }, user('audit every body and report')];
  for (let i = 1; i <= 9; i++) resumed.push(call('old' + i, 'noop'), tool('old' + i, filler('OLD#' + i, 19000)));
  resumed.push(user('carry on'));
  const pre = await runLong({ foldFromPrefix: true, messages: resumed, calls: 2 });
  A.eq([pre.res.reason, pre.up.posts[0].kind, pre.folds.every(f => f.kind === 'chunk'), pre.compacts[0].prefixWhy], ['done', 'chunk', true, 'unsent'], 'a preflight fold of a resumed history (nothing sent by this run yet) stays chunked');
  // an auxiliary summarizer model
  failopen.resetForTests();
  const auxRun = await runLong({ foldFromPrefix: true, auxModelFor: () => 'claude-haiku-5-5' });
  A.eq([auxRun.folds.every(f => f.kind === 'chunk' && f.body.model === 'claude-haiku-5-5'), auxRun.compacts[0].prefixWhy, failopen.counts()['loop.compaction.prefixFold'] || 0], [true, 'aux-model', 0],
    'a station that folds on an auxiliary model keeps its chunked fold on that model (not a failure: nothing is noted)');
  A.report('fold-from-prefix');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; A.report('fold-from-prefix'); });
