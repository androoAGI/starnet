'use strict';
/* node test/overflow-named-cause.test.js — a 400 that NAMES what is wrong with the request never folds history, at any
   size, on any classify path (context-budget-and-fold, step 4: the class-level lock on quick win 16).

   THE BURN (email E28, the base64-summarizer credit burn). The overflow rule had a size heuristic, "a 400 on a prompt over
   0.4 x the window is probably too big", and it read the run-start size first and unconditionally. A run whose OPENING
   prompt was already over 0.4 of the window (a big paste, a screenshot-heavy chat) read every later 400 as an overflow,
   "invalid image data" too: a paid summarizer call, a resend of the same bad image, and the run died on the same 400.
   Quick win 16 made a named cause beat both sizes (errorClass.js NAMED_CAUSE_RE, overRatio); errorclass.overflow-phrasings
   pins six phrasings. This file locks the CLASS, so a new size rule, a reordering or a narrowed word list cannot bring the
   burn back one phrasing at a time:

     A  the sweep reads NAMED_CAUSE_RE itself (errorClass._internals): every alternative needs a sample here, a sample that
        matches only its own alternative (so narrowing or dropping that alternative turns exactly that sample red) and no
        overflow wording of its own, so it reaches the size rules. Each sample, and a table of wire-shaped provider
        phrasings, is classified at every size (run-start only, live only, both; 10%, 50%, 90% of the window) on every call
        site (HTTP 400, HTTP 422, a parsed error body, no status, no status with a typed body): never context_overflow,
        never shouldCompress, and the verdict does not move with the size. Over HTTP it is format_error; with no status it
        stays what a statusless message always was (unknown, retryable), never a fold;
     B  the controls that keep A honest: a 400 naming no cause IS read as an overflow at every size over the line, and a
        real overflow wording folds at every size even when it names a parameter or functions (the named cause vetoes the
        SIZE rules, never the wording);
     C  end to end through runAgentLoop and the real native Anthropic adapter (a scripted fetch, a 32,000-token window,
        a prompt at half of it): the bad request is posted once, no summarizer call, no agent.compact, the run ends
        error / format_error with the provider's own words; and a genuine overflow wording, or a 400 naming nothing, at the
        same size still folds once and finishes (the guard is not a blanket off switch).
   The real sidecar over HTTP is the same claim in fold-reuse.http.test.js. */
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { classifyApiError, _internals } = require('../sidecar/providers/errorClass.js');

const { NAMED_CAUSE_RE, OVERFLOW_RE } = _internals;
const LIMIT = 32000;

// ---- the alternatives of the regex, read from the regex ----
function alternativesOf(source) {
  const out = [];
  let depth = 0, inClass = false, cur = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') { cur += ch + (source[i + 1] || ''); i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; cur += ch; continue; }
    if (ch === '[') { inClass = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
A.eq(alternativesOf('a|b[|]c|(d|e)f|g\\|h'), ['a', 'b[|]c', '(d|e)f', 'g\\|h'], 'the splitter reads bars outside groups, classes and escapes');
A.ok(NAMED_CAUSE_RE instanceof RegExp && OVERFLOW_RE instanceof RegExp, 'errorClass._internals exposes both regexes the overflow rules read');

/* ONE SAMPLE PER ALTERNATIVE, keyed by the alternative's own source text. Each is a request-defect sentence that carries
   that word and no other word of the list. A new alternative fails section A until it has a sample here. */
const SAMPLES = {
  'base64': 'invalid base64 data',
  'image': 'Could not process image',
  'media[ _]?type': "unexpected media_type 'application/x-foo'",
  'mime': 'bad mime sniffed from the payload',
  'schema': 'tools.2.input_schema is invalid',
  'json': 'request body is not valid JSON',
  'parse': 'could not parse the request body',
  'invalid[_ ]type': 'invalid_type: expected string',
  'tool_use': '`tool_use` ids must be unique',
  'tool_result': 'unexpected `tool_result` block',
  'tool_call': 'tool_calls must be followed by tool messages',
  'function': 'tool definition names an unknown function',
  'parameter': 'missing required parameter',
  'argument': 'invalid argument',
  'field': "unknown field 'foo'",
  'property': "additional property 'x' is not allowed",
  'enum': 'value must be one of the enum',
  'encoding': 'invalid encoding in request',
  'utf-?8': 'invalid utf-8 sequence in body',
  'unsupported': 'unsupported content block',
  'not supported': 'feature is not supported with this request',
  'role': "invalid role 'foo'",
  'messages?\\.\\d': 'messages.2: must not be empty',
  'content\\.\\d': 'content.3.text must not be empty'
};
// sentences shaped like what the providers send, each naming a cause by several words at once
const WIRE = [
  ['the bad image, full path', 'messages.2.content.1.image.source.base64: invalid image data'],
  ['the bad image, bare', 'invalid image data'],
  ['an image the provider could not read', 'Could not process image'],
  ['Anthropic, media type mismatch', 'messages.0.content.1.image.source.base64.data: Image does not match the provided media type image/png'],
  ['Anthropic, orphaned tool_use', 'messages.3: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01Abc. Each `tool_use` block must have a corresponding `tool_result` block in the next message.'],
  ['Anthropic, role order', 'messages: roles must alternate between "user" and "assistant", but found multiple "user" roles in a row'],
  ['Anthropic, tool schema', 'tools.2.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12'],
  ['OpenAI, tool message without calls', "Invalid parameter: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'."],
  ['OpenAI, unreadable body', 'We could not parse the JSON body of your request. (HINT: This likely indicates that your request is not properly formatted JSON.)'],
  ['OpenAI, a parameter this model refuses', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."],
  ['Gemini, unknown field', 'Invalid JSON payload received. Unknown name "foo" at \'generation_config\': Cannot find field.'],
  ['Gemini, bad role', 'Please use a valid role: user, model.']
];
// genuine overflow wordings; the last two also carry a named-cause word
const OVERFLOWS = [
  ['Anthropic', 'prompt is too long: 215000 tokens > 200000 maximum', false],
  ['llama.cpp', 'the request exceeds the available context size, try increasing it', false],
  ['OpenAI, counting messages and functions', "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens (129000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions.", true],
  ['a wording that names a parameter and the window', 'Invalid parameter: the input exceeds the context window of this model', true]
];

// the sizes of the prompt against the window: what the run started at, what it is now, or both
const pct = share => Math.round(share * LIMIT);
const SIZES = [
  ['10%, both', { approxTokens: pct(0.1), liveApproxTokens: pct(0.1) }],
  ['run-start 50%', { approxTokens: pct(0.5) }],
  ['live 50%', { approxTokens: 100, liveApproxTokens: pct(0.5) }],
  ['both 50%', { approxTokens: pct(0.5), liveApproxTokens: pct(0.5) }],
  ['run-start 90%', { approxTokens: pct(0.9) }],
  ['live 90%', { approxTokens: 100, liveApproxTokens: pct(0.9) }],
  ['both 90%', { approxTokens: pct(0.9), liveApproxTokens: pct(0.9) }]
];
const OVER_THE_LINE = SIZES.slice(1);
const ctxOf = size => Object.assign({ contextLimit: LIMIT }, size);

// the call sites: classify400 reads the first three, pickReason's own ratio line the last two
const SHAPES = [
  ['HTTP 400', true, msg => Object.assign(new Error('anthropic http 400 - ' + msg), { status: 400 })],
  ['HTTP 422', true, msg => Object.assign(new Error('openai-compatible http 422 - ' + msg), { status: 422 })],
  ['HTTP 400, parsed body', true, msg => Object.assign(new Error('api error'), { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: msg } } })],
  ['no status', false, msg => new Error(msg)],
  ['no status, typed body', false, msg => Object.assign(new Error('api error'), { body: { error: { type: 'invalid_request_error', message: msg } } })]
];

// every (call site, size) cell where this message is read as an overflow, told to fold, or answered differently by size
function foldingCells(msg) {
  const bad = [];
  for (const [shape, hasStatus, make] of SHAPES) {
    const small = classifyApiError(make(msg), ctxOf(SIZES[0][1]));
    for (const [size, ctx] of SIZES) {
      const v = classifyApiError(make(msg), ctxOf(ctx));
      const why = [];
      if (v.reason === 'context_overflow') why.push('context_overflow');
      if (v.shouldCompress) why.push('shouldCompress');
      if (v.reason !== small.reason) why.push('moved with size: ' + small.reason + ' -> ' + v.reason);
      if (hasStatus && v.reason !== 'format_error') why.push('over HTTP it is ' + v.reason + ', not format_error');
      if (why.length) bad.push(shape + ' @ ' + size + ': ' + why.join(', '));
    }
  }
  return bad;
}
// the cells where this message is NOT read as an overflow that folds (the opposite question, for the controls)
function notFoldingCells(msg, sizes) {
  const bad = [];
  for (const [shape, , make] of SHAPES) {
    for (const [size, ctx] of sizes) {
      const v = classifyApiError(make(msg), ctxOf(ctx));
      if (v.reason !== 'context_overflow' || v.shouldCompress !== true) bad.push(shape + ' @ ' + size + ': ' + v.reason + (v.shouldCompress ? ' + shouldCompress' : ''));
    }
  }
  return bad;
}

// ---- A. the sweep ----
{
  const alts = alternativesOf(NAMED_CAUSE_RE.source);
  A.ok(alts.length >= 20, 'NAMED_CAUSE_RE still reads as a list of single words and fields (' + alts.length + ' alternatives)');
  for (const alt of alts) A.ok(typeof SAMPLES[alt] === 'string', 'NAMED_CAUSE_RE gained the alternative "' + alt + '" and this sweep has no sample for it: add one that carries it and no other word of the list');
  // every sample is classified whether or not its alternative is still in the regex: dropping an alternative shows as the fold it brings back
  for (const alt of Object.keys(SAMPLES)) {
    const sample = SAMPLES[alt], low = sample.toLowerCase();
    A.ok(alts.includes(alt), 'sample for "' + alt + '" belongs to no alternative of NAMED_CAUSE_RE any more: delete or re-key it');
    A.ok(new RegExp(alt).test(low), '"' + alt + '": its sample carries it (' + sample + ')');
    A.eq(alts.filter(other => other !== alt && new RegExp(other).test(low)), [], '"' + alt + '": its sample carries no OTHER alternative, so narrowing or dropping this one turns this sample red');
    A.ok(!OVERFLOW_RE.test(low), '"' + alt + '": its sample is not an overflow wording, so it reaches the size rules');
    A.eq(foldingCells(sample), [], '"' + alt + '" (' + sample + '): no call site and no size reads it as an overflow');
  }
  for (const [who, msg] of WIRE) {
    const low = msg.toLowerCase();
    A.ok(NAMED_CAUSE_RE.test(low), who + ': the table holds only sentences that name a cause');
    A.ok(!OVERFLOW_RE.test(low), who + ': and are not overflow wordings');
    A.eq(foldingCells(msg), [], who + ': no call site and no size reads it as an overflow');
  }
}

// ---- B. the controls ----
{
  // the sizes are live: a 400 that names nothing is read by the size, at every size over the line and not under it
  A.eq(notFoldingCells('invalid request', OVER_THE_LINE), [], 'a 400 naming no cause on a prompt over 0.4 of the window is still read as an overflow, on every call site');
  for (const [shape, , make] of SHAPES) {
    const under = classifyApiError(make('invalid request'), ctxOf(SIZES[0][1]));
    A.eq([under.reason === 'context_overflow', under.shouldCompress], [false, false], shape + ': and under the line the same words are no overflow');
  }
  // a window the catalog does not know (contextLimit 0) never reads a size at all
  A.eq(classifyApiError(SHAPES[0][2]('invalid request'), { contextLimit: 0, approxTokens: 99999, liveApproxTokens: 99999 }).reason, 'format_error', 'a cold catalog has no ratio to read');
  // the named cause vetoes the SIZE rules, never the wording: a real overflow sentence folds at every size
  for (const [who, msg, names] of OVERFLOWS) {
    if (names) A.ok(NAMED_CAUSE_RE.test(msg.toLowerCase()), who + ': it carries a named-cause word, which is the point of the control');
    A.ok(OVERFLOW_RE.test(msg.toLowerCase()), who + ': it is an overflow wording');
    A.eq(notFoldingCells(msg, SIZES), [], who + ': folds on every call site at every size, small prompts included');
  }
}

// ---- C. through the loop and the real native Anthropic adapter ----
const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const okSse = text => new Response([
  line({ type: 'message_start', message: { usage: { input_tokens: 40, output_tokens: 0 } } }),
  line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
  line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }),
  line({ type: 'message_stop' }),
  ''
].join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const anthropicError = (status, message) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }),
  { status, headers: { 'Content-Type': 'application/json' } });
const estimator = makeContext({ contextLimit: LIMIT, compactAt: 0.65, keepTail: 1 });

// the importer chat, its last message padded so the whole prompt is `share` of the window (0 = a short last message)
function importerChat(share) {
  const chat = [
    { role: 'system', content: 'You are a station agent.' },
    { role: 'user', content: 'Refactor the importer.' },
    { role: 'assistant', content: 'Reading the importer and its tests. ' + 'a'.repeat(4000) },
    { role: 'user', content: 'Also keep the CLI flags stable. ' + 'b'.repeat(4000) },
    { role: 'assistant', content: 'Noted, flags stay stable. ' + 'c'.repeat(4000) },
    { role: 'user', content: share ? 'Look at this. ' : 'Continue.' }
  ];
  if (share) chat[chat.length - 1].content += 'x'.repeat(Math.max(0, Math.round((share * LIMIT - estimator.estimateMessages(chat)) * 4)));
  return chat;
}
async function drive(script, size) {
  const posts = [];
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });   // catalog re-warm
    posts.push(JSON.parse(init.body));
    return script(posts.length);
  };
  const provider = makeAnthropicProvider({ fetch, key: 'fixture-only', baseUrl: 'https://anthropic.fixture.invalid/v1' });
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  let summarized = 0;
  const messages = importerChat(size.live);
  const live = estimator.estimateMessages(messages) / LIMIT;   // before the run, which may fold the array it was handed
  const res = await runAgentLoop({
    messages, provider, emit: makeEmitter(bus, () => {}), cost: makeCostEngine({ priceOf: () => ({ in: 3, out: 15 }) }),
    model: 'claude-sonnet-4-5', agentId: 'a', runId: 'r',
    context: makeContext({ contextLimit: LIMIT, compactAt: 0.65, keepTail: 1 }),
    summarize: async () => { summarized++; return 'SUMMARY: importer refactor, CLI flags must stay stable.'; },
    approxTokens: pct(size.start), contextLimit: LIMIT, sleep: async () => {}, random: () => 0.5
  });
  return { res, posts, summarized, seq, live };
}
// what the run started at (the figure the loop is handed) and what the prompt is now (the messages it holds)
const RUN_SIZES = [
  ['run-start 50%', { start: 0.5, live: 0 }],
  ['live 50%', { start: 100 / LIMIT, live: 0.5 }],
  ['both 50%', { start: 0.5, live: 0.5 }]
];
const compactsOf = seq => seq.filter(e => e.name === 'agent.compact');
const errorsOf = seq => seq.filter(e => e.name === 'agent.run.error');

(async () => {
  for (const [who, phrase] of WIRE.slice(0, 3)) {
    for (const [sizeName, size] of RUN_SIZES) {
      const label = '"' + phrase + '" @ ' + sizeName;
      const r = await drive(() => anthropicError(400, phrase), size);
      if (size.live) A.ok(Math.abs(r.live - size.live) < 0.02, label + ': the prompt really is about ' + Math.round(size.live * 100) + '% of the window (' + Math.round(r.live * 100) + '%)');
      A.eq(r.posts.length, 1, label + ': the bad request is posted once, never resent');
      A.eq(r.summarized, 0, label + ': no summarizer call');
      A.eq(compactsOf(r.seq).length, 0, label + ': no agent.compact');
      A.eq([r.res.reason, r.res.failureCode], ['error', 'format_error'], label + ': the run ends error / format_error');
      const errs = errorsOf(r.seq);
      A.ok(errs.length === 1 && errs[0].payload.failureCode === 'format_error' && errs[0].payload.message.toLowerCase().includes(phrase.toLowerCase()), label + ': one run error, with the provider\'s own words (' + (errs[0] && errs[0].payload.message) + ')');
    }
  }
  // the guard is not a blanket off switch: the same size, a sentence that is really an overflow, or names nothing, folds once and finishes
  for (const [who, phrase] of [['an overflow wording', 'This request exceeds the context window of the selected model'], ['a 400 that names nothing', 'invalid request']]) {
    for (const [sizeName, size] of RUN_SIZES.slice(1)) {
      const label = who + ' @ ' + sizeName;
      const r = await drive(n => n === 1 ? anthropicError(400, phrase) : okSse('finished after the fold'), size);
      A.eq(r.res.reason, 'done', label + ': the run finishes');
      A.eq([r.posts.length, r.summarized, compactsOf(r.seq).length], [2, 1, 1], label + ': one refused request, ONE fold, one retry');
      A.eq(errorsOf(r.seq).length, 0, label + ': recovered, not surfaced');
    }
  }
  {
    const r = await drive(n => n === 1 ? anthropicError(400, 'invalid request') : okSse('finished after the fold'), RUN_SIZES[0][1]);
    A.eq([r.res.reason, r.posts.length, r.summarized], ['done', 2, 1], 'a 400 naming nothing on a run that STARTED over the line folds once on the run-start size alone');
  }
  A.report('overflow-named-cause.test');
})().catch(e => { console.error(e); process.exit(1); });
