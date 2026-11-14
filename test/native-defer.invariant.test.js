/* node test/native-defer.invariant.test.js — W2.4 NATIVE ANTHROPIC DEFERRAL: on the native Anthropic API a tool reveal
   loads a tool the request declared up front, by reference, instead of growing the request's tools array.

   Red on 57c741da7 (the 0.15.2 candidate), green on the lane. Hermetic: no network, no paid call, a fake Anthropic
   upstream, the REAL loop, the REAL native adapter, the REAL registry and the REAL tool.search.

   THE API, AS DOCUMENTED (read 2026-11-14; the fake upstream enforces exactly these and nothing else):
     · platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool  "Custom tool search implementation": a
       client tool returns "a standard tool_result with tool_reference blocks in the content array"
       ({ type:'tool_reference', tool_name }); "Every tool referenced must have a corresponding tool definition in the
       top-level tools parameter, normally with defer_loading: true"; a missing one is a 400 "Tool reference 'x' not found
       in available tools"; all tools deferred is a 400 "At least one tool must have defer_loading=false"; "A tool with
       defer_loading: true can't also carry cache_control: the API returns a 400". No beta header. Models: the page's
       Model compatibility table (DOCUMENTED below); "Claude Opus 4.1 and earlier models don't support" it.
     · platform.claude.com/docs/en/api/messages/create  tool_result.content is an array of text | image | search_result |
       document | tool_reference blocks ("Tool reference block that can be included in tool_result content").
     · platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching  "Deferred tools are not
       included in the system-prompt prefix. When the model discovers a deferred tool ... the definition is appended
       inline as a tool_reference block in the conversation history. The prefix is untouched, so prompt caching is
       preserved."
     · preserved thinking (claude-api skill, preserved-thinking-migration): a deferred tool that nothing has referenced
       is outside the prefix a thinking block is bound to; it binds from the reference on.

   With the switch on (runAgentLoop nativeDefer: true, which the host sets from STARNET_NATIVE_DEFER):
   1. ACROSS TWO REVEALS FROM TWO REVEAL SITES THE TOOLS ARRAY NEVER CHANGES. A seven-request run on claude-opus-5-5
      reveals one tool through tool.search (toolsearch.js control.revealTools) and one through a tool's refusal (the
      registry's error path, the one browser.js uses). Every request carries byte-identical `tools`: the core tools, then
      every deferred tool with defer_loading: true, the cache anchor on the last core tool. Each reveal is a
      tool_reference on the tool result that made it, beside that result's unchanged text. Both revealed tools are
      called and run. The upstream refuses nothing and the model never calls a tool it cannot see.
   2. THE CACHE READS THE PREFIX AFTER EACH REVEAL. Every arm's real wire bodies are billed by
      test/helpers/anthropic-cache-sim.js, rendered as documented (a deferred definition is outside the prompt until a
      reference loads it inline). Off, the request after each reveal reads nothing and writes the whole prompt; on, it
      reads everything the request before it anchored and writes only the new turn. The numbers are printed.
   3. NO THINKING IS LOST. The upstream binds each thinking block to its prefix as documented and drops the first stale
      block and every later one. Off, the loop strips every earlier block at each reveal (the tools changed). On, nothing
      is stripped and nothing is dropped: the last request replays every block the run made.
   4. NOTHING THE MODEL IS TOLD CHANGES. The system prompt is byte-identical off and on (the deferred names stay in it),
      every tool definition is the one the switch-off run sends (no description trimmed), every core tool stays listed
      and undeferred, the transcript and the journaled tool results are the same.
   5. A 400 THAT NAMES THESE FIELDS FALLS BACK ONCE, FOR GOOD. The run re-sends on the old path, says so (failNote), and
      no later request for that model in this process tries again, a new adapter instance included. Another model does.
      A refusal that arrives at the first reveal falls back too, strips the thinking the old path would have stripped,
      and the revealed tool stays callable.
   6. AN UNSUPPORTED MODEL, ANOTHER HOST AND EVERY OTHER ROUTE TAKE THE OLD PATH: the switch-off bytes exactly. The gate
      is the documented support list. Only the native adapter declares the capability, and the other adapters send the
      same body whether or not a request carries the loop's field.
   7. A REVEAL WHOSE TOOL RESULT LEFT THE REQUEST KEEPS ITS TOOL CALLABLE. After a paid fold takes the result away, the
      tool is declared loaded (no defer_loading), as the old path does; nothing is dropped. After terminal tool evidence
      (control.stopTools) the request carries no tools at all, as before.
   With the switch off (absent, or false), every request body is byte-identical to the base: test/fixtures/
   native-defer-golden.json holds the sha256 of every request body, recorded from 57c741da7.
   8. ONE SWITCH: STARNET_NATIVE_DEFER is read in one place (sidecar/index.js), off unless set, and handed to the loop.

   RE-RECORD the golden only on the base, or when a request body changes on purpose for a reason outside this lane (say
   so in that commit):  node test/native-defer.invariant.test.js --update */
'use strict';
// hermetic: no operator switch from the shell (the cache TTL tier, the tool anchor, a price override) reaches a request
for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_/.test(k)) delete process.env[k];
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeToolSearchTool } = require('../sidecar/tools/builtin/toolsearch.js');
const { makeCapCtx } = require('../sidecar/capability/capGate.js');
const Anthropic = require('../sidecar/providers/anthropic.js');
const factory = require('../sidecar/providers/factory.js');
const failopen = require('../sidecar/failopen.js');
const { decomment } = require('./helpers/decomment.js');
const { sidecarSourceFiles } = require('./helpers/source.js');
const Sim = require('./helpers/anthropic-cache-sim.js');
const Bodies = require('./helpers/cache-ttl-bodies.js');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'native-defer-golden.json');
const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const noCache = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
const hash = v => crypto.createHash('sha1').update(JSON.stringify(noCache(v))).digest('hex').slice(0, 16);
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };
const tok = chars => Math.round(chars / 3.6);   // the simulator's own scale: about 3.6 characters to a token

// THE DOCUMENTED SUPPORT LIST, typed from the tool search page's Model compatibility table, never read from the code
const DOCUMENTED = ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-fable-5', 'claude-mythos-5',
  'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'];
// "Claude Opus 4.1 and earlier models don't support the tool search tool", and nothing that is not Claude
const UNDOCUMENTED = ['claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219',
  'claude-3-5-haiku-20241022', 'gpt-5.5', 'kimi-k2', ''];

/* ---------------------------------------------------------------- the upstream: the documented rules, enforced */
// the tool_reference names in tool results before message `upto`
function refsBefore(messages, upto) {
  const out = new Set();
  for (let k = 0; k < upto && k < messages.length; k++) {
    const m = messages[k];
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      for (const x of b.content) if (x && x.type === 'tool_reference') out.add(x.tool_name);
    }
  }
  return out;
}
const bare = t => { const c = Object.assign({}, t); delete c.cache_control; delete c.defer_loading; return c; };
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
// the tools in the prompt at message `upto`: every undeferred one, and a deferred one from its first reference on
const loadedAt = (body, upto) => { const refs = refsBefore(body.messages, upto); return (body.tools || []).filter(t => !t.defer_loading || refs.has(t.name)); };
// what a thinking block at message `upto` is bound to (a name-keyed tool set, the system prompt, every earlier message)
const prefixSig = (body, upto, own) => 'sig:' + hash({ system: body.system || null, tools: loadedAt(body, upto).map(bare).sort(byName), msgs: body.messages.slice(0, upto), own });
// a request the documented API answers 400, in its words; null when the request is well formed
function violation(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = new Set(tools.map(t => t.name));
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if ('defer_loading' in t && typeof t.defer_loading !== 'boolean') return 'tools.' + i + '.defer_loading: Input should be a valid boolean';
    if (t.defer_loading && t.cache_control) return 'tools.' + i + '.cache_control: a tool with defer_loading: true cannot carry cache_control';
  }
  if (tools.length && tools.every(t => t.defer_loading)) return 'At least one tool must have defer_loading=false. All tools cannot be deferred.';
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (!Array.isArray(m.content)) continue;
    for (let j = 0; j < m.content.length; j++) {
      const b = m.content[j];
      if (b && b.type === 'tool_reference') return 'messages.' + i + '.content.' + j + ': tool_reference is not allowed here';
      if (!b || b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      for (const x of b.content) {
        if (!x || x.type !== 'tool_reference') continue;
        if (!/^[a-zA-Z0-9_-]{1,256}$/.test(String(x.tool_name))) return 'messages.' + i + '.content.' + j + ': tool_reference.tool_name: String should match pattern';
        if (!names.has(x.tool_name)) return 'Tool reference \'' + x.tool_name + '\' not found in available tools';
      }
    }
  }
  return null;
}
const refuse400 = message => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status: 400 });

/* script(k, body) -> the content of the k-th ANSWERED request: {type:'thinking'} | {type:'text', text} | {type:'tool_use',
   name, input}. o.refuse(body, n) -> a 400's words, or null (the fallback cases). Every request records: status, the raw
   body's sha256, the documented rule it broke (violation), the tools the scripted reply called that the model could not
   see (uncallable), dropped (input_transformations) and `replayed` = the answer that minted each thinking block. */
function deferServer(script, o) {
  o = o || {};
  const posts = [];
  const minted = new Map();
  let answered = 0;
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    const body = JSON.parse(init.body);
    const rec = { n: posts.length + 1, body, raw: sha(init.body), headers: init.headers || {}, status: 200, violation: null, uncallable: [], dropped: 0, replayed: [] };
    posts.push(rec);
    const refused = o.refuse ? o.refuse(body, rec.n) : null;
    if (refused) { rec.status = 400; return refuse400(refused); }
    rec.violation = violation(body);
    if (rec.violation) { rec.status = 400; return refuse400(rec.violation); }
    const th = body.thinking || null;
    const drop = !!(th && th.block_binding && th.block_binding.prefix_mismatch_behavior === 'drop_block');
    const transformations = [];
    let dropping = false;
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (b.type !== 'thinking') continue;
        rec.replayed.push(minted.get(b.signature) || 0);
        if (!dropping && b.signature === prefixSig(body, i, m.content.slice(0, j))) continue;
        if (!drop) { rec.status = 400; return refuse400('messages.' + i + '.content.' + j + ': Invalid `signature` in `thinking` block. The block is bound to a different conversation.'); }
        dropping = true;
        transformations.push({ type: 'thinking_dropped', path: 'messages.' + i + '.content.' + j, reason: 'prefix_binding_mismatch' });
      }
    }
    rec.dropped = transformations.length;
    const k = ++answered;
    rec.k = k;
    const content = script(k, body);
    const callable = new Set(loadedAt(body, body.messages.length).map(t => t.name));
    const ev = [{ type: 'message_start', message: { usage: { input_tokens: o.usageFor ? o.usageFor(k) : 100, output_tokens: 0 }, input_transformations: transformations.length ? transformations : undefined } }];
    const own = [];
    let toolUse = false;
    content.forEach((c, idx) => {
      if (c.type === 'thinking') {
        const sig = prefixSig(body, body.messages.length, own.slice());
        minted.set(sig, k);
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: sig } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'thinking', thinking: '', signature: sig });
      } else if (c.type === 'text') {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: c.text } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'text', text: c.text });
      } else {
        toolUse = true;
        if (!callable.has(c.name)) rec.uncallable.push(c.name);
        const id = 'toolu_' + k + '_' + idx;
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: c.name, input: {} } },
          { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'tool_use', id, name: c.name, input: c.input || {} });
      }
    });
    ev.push({ type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } }, { type: 'message_stop' });
    return new Response(ev.map(line).concat(['']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, posts, minted };
}
const thinkTool = (name, input) => [{ type: 'thinking' }, { type: 'tool_use', name, input: input || {} }];
const thinkText = [{ type: 'thinking' }, { type: 'text', text: 'All done.' }];
const plainTool = (name, input) => [{ type: 'tool_use', name, input: input || {} }];
const plainText = [{ type: 'text', text: 'All done.' }];

/* ---------------------------------------------------------------- the station: real registry, real tool.search */
const CORE_FILL = 16, SHELF_FILL = 22;
const pad2 = i => (i < 10 ? '0' : '') + i;
function fixture(small) {
  const registry = makeRegistry();
  const reg = (name, description, schema, run) => registry.register({ impact: 'external-service', name, capability: 'web', scope: 'read', requiresConsent: false, description, schema, run });
  reg('page.open', 'Open a web page and return its text.', { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    async a => ({ content: small ? 'opened ' + a.url : filler('PAGE ' + a.url, 20000), summary: 'opened' }));
  // REVEAL SITE 2: a refusal that names a deferred tool (registry.js turns err.revealTools into control.revealTools)
  reg('page.click', 'Click an element on the page.', { type: 'object', required: ['selector'], properties: { selector: { type: 'string' } } },
    async () => { const e = new Error('refused: this element opens a file chooser; attach the file with page.upload instead'); e.revealTools = ['page.upload']; e.toolSummary = 'refused'; throw e; });
  reg('page.dead', 'Check whether the page\'s domain can be reached at all.', { type: 'object', properties: {} },
    async () => ({ content: 'The domain does not resolve.', summary: 'unreachable', control: { stopTools: true } }));
  reg('page.fill', 'Type into a form field.', { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    async () => ({ content: small ? filler('FORM', 19000) : 'typed', summary: 'typed' }));
  if (!small) for (let i = 0; i < CORE_FILL; i++) {
    reg('core.t' + pad2(i), 'Core station capability ' + i + '. ' + filler('core' + pad2(i), 1400), { type: 'object', properties: { value: { type: 'string', description: 'The value core capability ' + i + ' acts on.' } } },
      async () => ({ content: 'ok', summary: 'ok' }));
  }
  // deferred: granted, named in the prompt, held off the wire until something reveals one
  reg('page.screenshot', 'Capture a screenshot of the current page as an image. Use it to show the Commander what you saw.', { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    async () => ({ content: 'shot taken', summary: 'ok' }));
  reg('page.upload', 'Attach a local file to a file input on the page.', { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    async () => ({ content: 'uploaded', summary: 'ok' }));
  if (!small) for (let i = 0; i < SHELF_FILL; i++) {
    reg('shelf.t' + pad2(i), 'Reserved station capability ' + i + '. ' + filler('shelf' + pad2(i), 1100), { type: 'object', properties: { value: { type: 'string', description: 'The value reserved capability ' + i + ' acts on.' } } },
      async () => ({ content: 'ok', summary: 'ok' }));
  }
  makeToolSearchTool({ registry }).register(registry);   // REVEAL SITE 1: the real tool.search
  const core = ['page.open', 'page.click', 'page.dead', 'page.fill', 'tool.search'];
  const deferred = ['page.screenshot', 'page.upload'];
  if (!small) { for (let i = 0; i < CORE_FILL; i++) core.push('core.t' + pad2(i)); for (let i = 0; i < SHELF_FILL; i++) deferred.push('shelf.t' + pad2(i)); }
  return { registry, core, deferred };
}
// the system prompt as a task run sends it: a cache-stable prefix, then the conversation's own tail, which names every
// deferred tool the way the [HARNESS] block does (docs/DECISIONS.md: a deferred tool stays NAMED in the prompt)
const sysPrefix = small => 'You are a station agent.' + (small ? '' : NL + filler('STANDING ORDERS', 36000));
const sysTail = deferred => '[HARNESS] These exist and you CAN use them (load one with tool_search first): ' + deferred.join(', ') + '.';

/* One run of the REAL loop through the REAL native adapter. o.nativeDefer: the switch as the host hands it (absent = the
   key is not passed at all). The wire lists are renamed dotted -> underscored exactly as index.js does it. */
async function runCase(o) {
  const up = o.up || deferServer(o.script, o);
  const fx = fixture(!!o.small);
  const core = fx.registry.wireFormat(fx.registry.list(new Set(fx.core)));
  const deferredDefs = fx.registry.wireFormat(fx.registry.list(new Set(fx.deferred)));
  const fromWire = new Map();
  for (const d of core.concat(deferredDefs)) { const real = d.function.name; const w = real.replace(/\./g, '_'); fromWire.set(w, real); d.function.name = w; }
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const prefix = sysPrefix(!!o.small);
  const provider = o.provider || Anthropic.makeAnthropicProvider(Object.assign({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' }, o.baseUrl ? { baseUrl: o.baseUrl } : {}));
  const res = await runAgentLoop(Object.assign({
    messages: [{ role: 'system', content: prefix + NL + NL + sysTail(fx.deferred) }, { role: 'user', content: 'do the task' }],
    provider, emit: makeEmitter(bus, () => {}),
    cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), model: o.model || 'claude-opus-5-5', agentId: 'a', runId: 'r',
    cacheSystemPrefix: prefix,
    tools: core, deferredTools: deferredDefs,
    context: o.context || null, summarize: o.summarize || null, microCompaction: o.microCompaction,
    limits: { maxIters: 12 },
    dispatch: (c, ctx) => fx.registry.dispatch(fromWire.has(c.name) ? Object.assign({}, c, { name: fromWire.get(c.name) }) : c, ctx),
    capCtx: makeCapCtx({ agentId: 'a', room: 'r', hasCompute: true, tools: fx.core.concat(fx.deferred), deferred: fx.deferred.slice(), approvalRules: {} }, { timeoutMs: 5000 }),
    sleep: async () => {}, random: () => 0.5
  }, o.nativeDefer === undefined ? {} : { nativeDefer: o.nativeDefer }));
  return { res, up, seq, core: core.map(d => d.function.name), deferred: deferredDefs.map(d => d.function.name), deferredDefs };
}
const hashes = run => run.up.posts.map(p => p.raw);
const answered = run => run.up.posts.filter(p => p.status === 200);
const toolNames = body => (body.tools || []).map(t => t.name);
const deferredNames = body => (body.tools || []).filter(t => t.defer_loading).map(t => t.name);
// every tool_reference a request carries: [the tool_use_id of the result that holds it, the tool it names]
function references(body) {
  const out = [];
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === 'tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x && x.type === 'tool_reference') out.push([b.tool_use_id, x.tool_name]);
  }
  return out;
}
const resultText = (body, id) => {
  for (const m of body.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === 'tool_result' && b.tool_use_id === id) return typeof b.content === 'string' ? b.content : b.content.filter(x => x.type === 'text').map(x => x.text).join('');
  }
  return null;
};
const transcript = res => JSON.stringify((res.messages || []).map(m => { const c = Object.assign({}, m); delete c.reasoning; return c; }));
const journal = seq => JSON.stringify(seq.filter(e => e.name === 'agent.tool_call' || e.name === 'agent.tool_result').map(e => [e.name, e.payload.callId, e.payload.name || '', e.payload.summary || '', e.payload.isError === true]));

/* THE PROMPT AS THE API RENDERS IT (the two caching pages above): a deferred definition is not in the tools prefix; a
   tool_reference stands for the whole definition, inline where it sits. The simulator prices this rendering. */
function rendered(body) {
  const defs = new Map((body.tools || []).map(t => [t.name, t]));
  const out = JSON.parse(JSON.stringify(body));
  if (Array.isArray(out.tools)) out.tools = out.tools.filter(t => !t.defer_loading);
  for (const m of out.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== 'tool_result' || !Array.isArray(b.content)) continue;
      b.content = b.content.map(x => (x && x.type === 'tool_reference') ? { type: 'tool_reference', tool_name: x.tool_name, definition: bare(defs.get(x.tool_name) || {}) } : x);
    }
  }
  return out;
}
function priced(run) {
  const cache = Sim.makeCache();
  return answered(run).map(p => cache.request(rendered(p.body)));
}
const written = u => u.write5m + u.write1h;

/* ---------------------------------------------------------------- the cases */
// k: 1 open a page · 2 tool.search (REVEAL 1) · 3 call what it revealed · 4 a refused click (REVEAL 2) · 5 call what
// that revealed · 6 open another page · 7 answer
const mainScript = k => k === 1 ? thinkTool('page_open', { url: 'https://a.example' }) : k === 2 ? thinkTool('tool_search', { query: 'screenshot' })
  : k === 3 ? thinkTool('page_screenshot', { name: 'after' }) : k === 4 ? thinkTool('page_click', { selector: '#file' })
    : k === 5 ? thinkTool('page_upload', { path: 'report.pdf' }) : k === 6 ? thinkTool('page_open', { url: 'https://b.example' }) : thinkText;
const plainScript = k => k === 1 ? plainTool('page_open', { url: 'https://a.example' }) : k === 2 ? plainTool('tool_search', { query: 'screenshot' })
  : k === 3 ? plainTool('page_screenshot', { name: 'after' }) : k === 4 ? plainTool('page_click', { selector: '#file' })
    : k === 5 ? plainTool('page_upload', { path: 'report.pdf' }) : plainText;
// a paid fold after a reveal: 1 tool.search (REVEAL) · 2 call it · 3-4 big form fills (the reported prompt passes the
// fold line at 4) · 5 call the revealed tool again, after the fold took its reveal away · 6 answer
const foldScript = k => k === 1 ? thinkTool('tool_search', { query: 'screenshot' }) : k === 2 ? thinkTool('page_screenshot', { name: 'one' })
  : (k === 3 || k === 4) ? thinkTool('page_fill', { text: 'x' }) : k === 5 ? thinkTool('page_screenshot', { name: 'two' }) : thinkText;
// terminal tool evidence after a reveal: 1 tool.search (REVEAL) · 2 the dead-domain proof (stopTools) · 3 answer
const stopScript = k => k === 1 ? thinkTool('tool_search', { query: 'screenshot' }) : k === 2 ? thinkTool('page_dead') : thinkText;
const foldCtx = () => makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 });
const CASES = {
  main: () => ({ script: mainScript }),
  legacy: () => ({ script: plainScript, model: 'claude-opus-4-1-20250805' }),
  fold: () => ({ script: foldScript, small: true, context: foldCtx(), usageFor: k => (k === 4 ? 14000 : 2000), microCompaction: false, summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }) }),
  stop: () => ({ script: stopScript, small: true })
};

/* A ROUTE THAT IS NOT THE NATIVE ADAPTER: a scripted provider that declares no deferral capability (as every adapter but
   anthropic.js). It records what the loop hands it. */
function otherRoute() {
  const reqs = [];
  let turn = 0;
  const call = (id, name, args) => [{ type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args) }, { type: 'tool_done', index: 0 }, { type: 'done', finishReason: 'tool_calls' }];
  const provider = {
    priceOf: () => ({ in: 1, out: 1 }), contextLimit: () => 0,
    stream: async function* (req) {
      reqs.push(JSON.stringify(Object.assign({}, req, { signal: undefined })));
      turn++;
      const evs = turn === 1 ? call('c1', 'tool_search', { query: 'screenshot' }) : turn === 2 ? call('c2', 'page_screenshot', { name: 'after' })
        : turn === 3 ? call('c3', 'page_click', { selector: '#file' }) : turn === 4 ? call('c4', 'page_upload', { path: 'report.pdf' })
          : [{ type: 'text', delta: 'All done.' }, { type: 'done', finishReason: 'stop' }];
      for (const e of evs) yield e;
    }
  };
  return { provider, reqs };
}
async function runOther(nativeDefer) {
  const o = otherRoute();
  const run = await runCase(Object.assign({ small: true, provider: o.provider, model: 'm', up: { posts: [] } }, nativeDefer === undefined ? {} : { nativeDefer }));
  return { res: run.res, reqs: o.reqs };
}
// the body an adapter built by the REAL factory hands fetch for one request
async function routeBody(route, req) {
  const r = Bodies.ROUTES[route];
  const posts = [];
  const f = async (url, init) => {
    if (String((init && init.method) || 'GET').toUpperCase() !== 'POST') return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    posts.push({ url: String(url), body: String(init && init.body) });
    const sse = /\/messages$/.test(String(url))
      ? [{ type: 'message_start', message: { id: 'msg_fixture', usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }].map(line).join(NL + NL) + NL + NL
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + NL + NL + 'data: [DONE]' + NL + NL;
    return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const p = factory.selectProvider(Object.assign({ provider: r.provider, key: 'k', fetch: f }, r.opts));
  try { for await (const _ of p.stream(Object.assign({ preStreamRetries: 0 }, req))) { /* drain */ } } catch (_) { /* the body is what is read */ }
  const post = posts.find(x => /\/(messages|chat\/completions)$/.test(x.url));
  return { body: post ? post.body : null, provider: p };
}

(async () => {
  if (process.argv.indexOf('--update') >= 0) {
    const cases = {};
    for (const name of Object.keys(CASES)) cases[name] = hashes(await runCase(CASES[name]()));
    cases.other = (await runOther()).reqs.map(sha);
    let at = 'unknown';
    try { at = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { /* not a git tree */ }
    fs.writeFileSync(GOLDEN, JSON.stringify({
      about: 'sha256 of every request body test/native-defer.invariant.test.js sends with native deferral OFF (the base). Re-record (--update) only on the base, or when a request body changes on purpose for a reason outside this lane, and say so in that commit.',
      recordedAt: at, cases
    }, null, 1) + '\n');
    console.log('native-defer golden recorded at ' + at + ': ' + Object.entries(cases).map(([k, v]) => k + ' ' + v.length).join(', '));
    process.exit(0);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).cases;
  const forget = () => { const s = Anthropic._internals && Anthropic._internals.deferRefused; if (s && typeof s.clear === 'function') s.clear(); };

  // ================= switch OFF: byte-identical to the base =================
  const off = await runCase(CASES.main());
  A.eq(off.res.reason, 'done', 'off: the run finishes');
  A.eq(hashes(off), golden.main, 'off (switch absent): every request body is byte-identical to the base (' + off.up.posts.length + ' requests)');
  A.eq(hashes(await runCase(Object.assign({ nativeDefer: false }, CASES.main()))), golden.main, 'off (switch false): every request body is byte-identical to the base');
  for (const name of ['legacy', 'fold', 'stop']) A.eq(hashes(await runCase(CASES[name]())), golden[name], 'off, ' + name + ': every request body is byte-identical to the base');
  A.eq((await runOther()).reqs.map(sha), golden.other, 'off, a route that is not the native adapter: every request the loop hands it is byte-identical to the base');
  {   // what the old path does at a reveal, on this run: the facts the on-arm is measured against
    const P = off.up.posts;
    A.eq(P.length, 7, 'off: seven requests');
    A.eq(P.map(p => toolNames(p.body).length), [21, 21, 22, 22, 23, 23, 23], 'off: each reveal grows the tools array (requests 3 and 5)');
    A.ok(P.every(p => deferredNames(p.body).length === 0 && references(p.body).length === 0), 'off: no defer_loading and no tool_reference anywhere');
    A.eq(P.map(p => p.dropped), P.map(() => 0), 'off: no thinking block dropped (the loop strips first)');
    A.eq(P[P.length - 1].replayed, [5, 6], 'off: the last request replays only the blocks made after the last reveal (every earlier one was stripped)');
  }

  // ================= 1. switch ON: two reveals, two sites, one tools array =================
  forget();
  const on = await runCase(Object.assign({ nativeDefer: true }, CASES.main()));
  const P = on.up.posts;
  A.eq(on.res.reason, 'done', 'on: the run finishes');
  A.eq(P.length, 7, 'on: seven requests, as off (no 400, no fallback round-trip)');
  A.eq(P.map(p => [p.status, p.violation]), P.map(() => [200, null]), 'on: every request is one the documented API accepts');
  A.eq(P.map(p => p.uncallable), P.map(() => []), 'on: the model never calls a tool it cannot see (both revealed tools were loaded when called)');
  const toolsRaw = P.map(p => JSON.stringify(p.body.tools));
  A.eq(toolsRaw.map(t => sha(t)), toolsRaw.map(() => sha(toolsRaw[0])), 'on: the tools array bytes of every request are identical (cache_control included)');
  A.eq(toolNames(P[0].body), on.core.concat(on.deferred), 'on: the array is the core tools, then every deferred tool, in the order the run was given them');
  A.eq(deferredNames(P[0].body), on.deferred, 'on: every deferred tool carries defer_loading: true, and no core tool does (a headline tool is never deferred)');
  A.ok(P[0].body.tools.every(t => !('defer_loading' in t) || t.defer_loading === true), 'on: defer_loading is only ever true');
  {
    const anchors = P[0].body.tools.map((t, i) => (t.cache_control ? i : -1)).filter(i => i >= 0);
    A.eq(anchors, [on.core.length - 1], 'on: the tools cache anchor sits on the last core tool, never on a deferred one');
    A.eq(P[0].body.tools[on.core.length - 1].cache_control, off.up.posts[0].body.tools[on.core.length - 1].cache_control, 'on: it is the anchor the switch-off request puts on that tool');
  }
  A.ok(P.every(p => !/tool|defer/i.test(String(p.headers['anthropic-beta'] || ''))), 'on: no beta header is sent for it (the documented feature needs none)');
  A.eq(P.map(p => String(p.headers['anthropic-beta'] || '')), off.up.posts.map(p => String(p.headers['anthropic-beta'] || '')), 'on: the request headers are the switch-off ones');
  // each reveal is a reference on the result that made it
  const idOf = (run, name) => { for (const m of run.res.messages) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c.function.name === name) return c.id; return null; };
  const searchId = idOf(on, 'tool_search'), clickId = idOf(on, 'page_click');
  A.eq(P.map(p => references(p.body)), [[], [], [[searchId, 'page_screenshot']], [[searchId, 'page_screenshot']],
    [[searchId, 'page_screenshot'], [clickId, 'page_upload']], [[searchId, 'page_screenshot'], [clickId, 'page_upload']], [[searchId, 'page_screenshot'], [clickId, 'page_upload']]],
  'on: reveal 1 rides the tool.search result, reveal 2 rides the refused click\'s result, each from the request after it and on every later one');
  A.eq([resultText(P[6].body, searchId), resultText(P[6].body, clickId)], [resultText(off.up.posts[6].body, idOf(off, 'tool_search')), resultText(off.up.posts[6].body, idOf(off, 'page_click'))],
    'on: both results keep the text the switch-off run sends (the reference is added beside it)');
  A.ok(/Now available to call for the rest of this run/.test(resultText(P[6].body, searchId)) && /^ERROR: .*refused: /.test(resultText(P[6].body, clickId)),
    'on: the search still says what it found and the refusal is still an error (' + JSON.stringify([String(resultText(P[6].body, searchId)).slice(0, 80), String(resultText(P[6].body, clickId)).slice(0, 80)]) + ')');
  A.ok(on.res.messages.some(m => m.role === 'tool' && m.content === 'shot taken') && on.res.messages.some(m => m.role === 'tool' && m.content === 'uploaded'), 'on: both revealed tools were dispatched and returned their real results');

  // ================= 2. the cache reads the prefix after each reveal =================
  {
    const U = priced(on), V = priced(off);
    const rows = [];
    for (const n of [3, 5]) {
      const u = U[n - 1], v = V[n - 1], before = U[n - 2];
      // The simulator is a pure prefix cache, so it still lets the old path read the tools that precede the appended one.
      // The docs' invalidation table is harsher ("Modifying tool definitions: entire cache"): both figures are printed.
      A.ok(v.hit <= off.up.posts[n - 1].body.tools.length - 2, 'cache, off: request ' + n + ' (after a reveal) reads at most the tools the request before it carried; the system prompt and the whole conversation are written again (hit ' + v.hit + ')');
      A.ok(written(v) >= 0.6 * v.total, 'cache, off: request ' + n + ' writes most of the prompt again (' + written(v) + ' of ' + v.total + ' characters)');
      A.ok(u.hit >= 0 && u.read >= before.total - before.uncached, 'cache, on: request ' + n + ' reads everything the request before it anchored (' + u.read + ' characters, of ' + (before.total - before.uncached) + ' anchored)');
      A.ok(written(u) <= 0.1 * written(v), 'cache, on: request ' + n + ' writes only the new turn (' + written(u) + ' characters against ' + written(v) + ' off)');
      rows.push('request ' + n + ' (prompt ' + tok(v.total) + ' tokens): written OFF ' + tok(written(v)) + ' tokens by the simulator, ' + tok(v.total - v.uncached)
        + ' if a tool change rewrites the tools too (the docs\' table); ON ' + tok(written(u)) + ' tokens (read ' + tok(u.read) + ')');
    }
    const bill = W => W.reduce((s, u) => s + Sim.inputEq(u, 0.05), 0);   // Opus 5.5's documented read: 0.05x input
    A.ok(bill(U) < bill(V), 'cache: the whole run bills less input with the switch on');
    A.eq(U.filter((u, i) => i > 0 && u.read === 0).length, 0, 'cache, on: no request after the first reads nothing');
    console.log('simulated cache, tokens written per reveal (claude-opus-5-5, ' + P[0].body.tools.length + ' tools declared, ' + on.core.length + ' loaded):');
    for (const r of rows) console.log('  ' + r);
    console.log('  whole run, input-equivalent tokens: OFF ' + tok(bill(V)) + ', ON ' + tok(bill(U)) + ' (' + (100 * (1 - bill(U) / bill(V))).toFixed(1) + '% less)');
  }

  // ================= 3. no thinking is lost =================
  A.eq(P.map(p => p.dropped), P.map(() => 0), 'thinking, on: no block dropped on any request');
  A.eq(P[P.length - 1].replayed, [1, 2, 3, 4, 5, 6], 'thinking, on: the last request replays every block the run made (nothing stripped at either reveal)');

  // ================= 4. nothing the model is told changes =================
  A.eq(P.map(p => JSON.stringify(noCache(p.body.system))), off.up.posts.map(p => JSON.stringify(noCache(p.body.system))), 'told: the system prompt is byte-identical off and on, on every request');
  A.ok(on.deferred.every(n => JSON.stringify(P[6].body.system).indexOf(n.replace(/_/g, '.')) >= 0), 'told: every deferred tool is still named in the prompt');
  {
    const offDefs = new Map(off.up.posts[6].body.tools.map(t => [t.name, JSON.stringify(bare(t))]));
    const wire = new Map(Anthropic._internals.toAnthropicTools(on.deferredDefs).map(t => [t.name, JSON.stringify(t)]));
    const same = P[0].body.tools.every(t => JSON.stringify(bare(t)) === (offDefs.has(t.name) ? offDefs.get(t.name) : wire.get(t.name)));
    A.ok(same, 'told: every tool definition is the one the switch-off path sends (name, description and schema; nothing trimmed)');
    A.ok(on.core.every(n => P.every(p => p.body.tools.some(t => t.name === n && !t.defer_loading))), 'told: every core tool stays listed and undeferred on every request');
  }
  A.eq(transcript(on.res), transcript(off.res), 'told: the transcript is the switch-off run\'s, message for message (thinking aside)');
  A.eq(journal(on.seq), journal(off.seq), 'journal: every tool call and result, both reveals included, is journaled as with the switch off');
  A.ok(JSON.parse(journal(on.seq)).some(e => e[0] === 'agent.tool_result' && /revealed$/.test(e[3])) && JSON.parse(journal(on.seq)).some(e => e[0] === 'agent.tool_result' && e[3] === 'refused'), 'journal: the tool.search reveal and the refusal are both there');

  // ================= 5. a 400 that names these fields falls back once, for good =================
  {
    forget();
    failopen.resetForTests();
    const refuseDefer = body => ((body.tools || []).some(t => 'defer_loading' in t) ? 'tools.4.custom.defer_loading: Extra inputs are not permitted' : null);
    const fb = await runCase(Object.assign({ nativeDefer: true, refuse: refuseDefer }, CASES.main()));
    const F = fb.up.posts;
    A.eq(fb.res.reason, 'done', 'fallback: the run finishes');
    A.eq(F.map(p => p.status), [400, 200, 200, 200, 200, 200, 200, 200], 'fallback: one refused request, then the run on the old path (one extra round-trip, once)');
    A.eq(F[1].raw, golden.main[0], 'fallback: the re-send is the switch-off request, byte for byte');
    A.ok(F.slice(1).every(p => deferredNames(p.body).length === 0 && references(p.body).length === 0), 'fallback: nothing after the refusal carries defer_loading or a tool_reference');
    A.eq(F.slice(1).map(p => toolNames(p.body).length), [21, 21, 22, 22, 23, 23, 23], 'fallback: reveals append to the tools array again');
    A.eq(F.slice(1).map(p => p.uncallable), F.slice(1).map(() => []), 'fallback: both revealed tools stay callable');
    A.eq(F.map(p => p.dropped), F.map(() => 0), 'fallback: no thinking block dropped');
    A.eq(failopen.counts()['providers.anthropic.native_defer'] || 0, 1, 'fallback: it says so once (diagnostics line)');
    // remembered for the model in this process: a NEW adapter instance never tries
    const again = await runCase(Object.assign({ nativeDefer: true, refuse: refuseDefer }, CASES.main()));
    A.eq(hashes(again), golden.main, 'fallback: the next run on that model, on a new adapter, sends the switch-off bytes from its first request (no second refusal)');
    A.eq(failopen.counts()['providers.anthropic.native_defer'] || 0, 1, 'fallback: and notes nothing more');
    // ...and only for that model
    const other = await runCase(Object.assign({ nativeDefer: true, model: 'claude-sonnet-5-5' }, CASES.main()));
    A.eq(other.res.reason, 'done', 'fallback: another model still runs');
    A.ok(deferredNames(other.up.posts[0].body).length === other.deferred.length && other.up.posts.every(p => p.status === 200 && !p.violation), 'fallback: another model still declares its deferred tools up front');

    // a refusal that arrives at the first reveal (defer_loading accepted, tool_reference not)
    forget();
    failopen.resetForTests();
    const refuseRef = body => (references(body).length ? 'messages.4.content.0.tool_result.content.1: Input tag \'tool_reference\' found using \'type\' does not match any of the expected tags: \'text\', \'image\', \'document\', \'search_result\'' : null);
    const late = await runCase(Object.assign({ nativeDefer: true, refuse: refuseRef }, CASES.main()));
    const L = late.up.posts;
    A.eq(late.res.reason, 'done', 'late fallback: the run finishes');
    A.eq(L.map(p => p.status), [200, 200, 400, 200, 200, 200, 200, 200], 'late fallback: the request after the first reveal is refused once and re-sent on the old path');
    A.ok(deferredNames(L[0].body).length > 0 && L.slice(3).every(p => deferredNames(p.body).length === 0 && references(p.body).length === 0), 'late fallback: nothing after the refusal carries the fields');
    A.eq(toolNames(L[3].body).length, 22, 'late fallback: the re-send carries the revealed tool the old way (appended)');
    A.eq(L.map(p => p.uncallable), L.map(() => []), 'late fallback: both revealed tools stay callable');
    A.eq(L.map(p => p.dropped), L.map(() => 0), 'late fallback: no thinking block dropped (the re-send strips what the old path strips at a reveal)');
    A.eq(failopen.counts()['providers.anthropic.native_defer'] || 0, 1, 'late fallback: noted once');
    // a 400 that names none of these fields is not this fallback's to catch
    forget();
    const unrelated = await runCase(Object.assign({ nativeDefer: true, refuse: (body, n) => (n === 1 ? 'max_tokens: 99999999 > 128000, which is the maximum allowed number of output tokens' : null) }, CASES.main()));
    A.ok(unrelated.up.posts.length >= 1 && unrelated.up.posts.every(p => p.status !== 200 || deferredNames(p.body).length > 0), 'an unrelated 400 does not turn native deferral off');
    forget();
  }

  // ================= 6. an unsupported model, another host, every other route: the old path =================
  {
    const gate = Anthropic.makeAnthropicProvider({ fetch: async () => new Response('{"data":[]}', { status: 200 }), key: 'k' });
    A.ok(typeof gate.nativeDefer === 'function' && typeof gate.deferredToolsKey === 'function', 'gate: the native adapter declares the capability');
    if (typeof gate.nativeDefer === 'function') {
      A.eq(DOCUMENTED.filter(m => !gate.nativeDefer(m)), [], 'gate: every model the tool search page lists is supported');
      A.eq(UNDOCUMENTED.filter(m => gate.nativeDefer(m)), [], 'gate: nothing else is (Opus 4.1 and earlier, non-Claude models)');
      const elsewhere = Anthropic.makeAnthropicProvider({ fetch: async () => new Response('{"data":[]}', { status: 200 }), key: 'k', baseUrl: 'https://claude-gateway.example/v1' });
      A.eq(DOCUMENTED.filter(m => elsewhere.nativeDefer(m)), [], 'gate: no model is supported on a host that is not the Anthropic API');
    }
    A.eq(hashes(await runCase(Object.assign({ nativeDefer: true }, CASES.legacy()))), golden.legacy, 'unsupported model (claude-opus-4-1), switch on: the switch-off bytes');
    A.eq(hashes(await runCase(Object.assign({ nativeDefer: true, baseUrl: 'https://claude-gateway.example/v1' }, CASES.main()))), golden.main, 'another host, switch on: the switch-off bytes');
    A.eq((await runOther(true)).reqs.map(sha), golden.other, 'a route that declares no capability, switch on: the loop hands it the switch-off requests (no new field, tools appended)');
    // the other adapters, built by the real factory, send the same body whether or not a request carries the field
    const nd = { deferred: on.deferredDefs, reveals: [{ id: 'call_1', names: ['page_screenshot'] }] };
    for (const route of ['openrouter', 'managed', 'openrouter-gpt']) {
      const req = Bodies.CASES['split-tools-iteration'](Bodies.ROUTES[route].model);
      const plain = await routeBody(route, req), carrying = await routeBody(route, Object.assign({}, req, { nativeDefer: nd }));
      A.ok(plain.body && plain.body === carrying.body, 'route ' + route + ': the same body with and without the loop\'s field');
      A.ok(typeof plain.provider.deferredToolsKey !== 'function' && typeof plain.provider.nativeDefer !== 'function', 'route ' + route + ': declares no deferral capability');
    }
  }

  // ================= 7. a reveal whose tool result left the request; terminal tool evidence =================
  {
    forget();
    const fold = await runCase(Object.assign({ nativeDefer: true }, CASES.fold()));
    const F = fold.up.posts;
    A.eq(fold.res.reason, 'done', 'fold: the run finishes');
    A.ok(fold.seq.some(e => e.name === 'agent.compact' && e.payload.reason === 'context'), 'fold: the paid fold ran');
    A.eq(F.map(p => [p.status, p.violation]), F.map(() => [200, null]), 'fold: every request is one the documented API accepts');
    const at = F.findIndex(p => references(p.body).length === 0 && p.n > 2);
    A.ok(at >= 2, 'fold: the fold took the tool.search result, and its reference, out of the request (request ' + (at + 1) + ')');
    A.eq(F.slice(1, at).map(p => references(p.body).map(r => r[1])), F.slice(1, at).map(() => ['page_screenshot']), 'fold: until then the reveal is a reference');
    A.ok(F.slice(at).every(p => p.body.tools.some(t => t.name === 'page_screenshot' && !t.defer_loading)), 'fold: from then on the revealed tool is declared loaded (no defer_loading), as the old path declares it');
    A.ok(F.slice(at).every(p => deferredNames(p.body).join() === 'page_upload'), 'fold: the tool nothing revealed stays deferred');
    A.eq(F.map(p => p.uncallable), F.map(() => []), 'fold: the revealed tool is callable before and after the fold');
    A.eq(F.map(p => p.dropped), F.map(() => 0), 'fold: no thinking block dropped');
    const tb = F.map(p => sha(JSON.stringify(noCache(p.body.tools))));
    A.eq(tb.map((t, i) => (i > 0 && t !== tb[i - 1] ? i + 1 : 0)).filter(Boolean), [at + 1], 'fold: the tools array changes once, at the fold, and never at the reveal');
    A.eq(F[F.length - 1].replayed.length > 0 && F[F.length - 1].replayed.every(k => k >= at), true, 'fold: the blocks made from the fold on replay intact (' + JSON.stringify(F[F.length - 1].replayed) + ')');
    console.log('fold after a reveal: ' + F.length + ' requests, the reference rides requests 2-' + at + ', the fold reaches the wire at request ' + (at + 1) + ', deferred per request ' + JSON.stringify(F.map(p => deferredNames(p.body).length)));
    {   /* THE ONE REQUEST WHERE THE SWITCH COSTS SOMETHING: the fold's own request declares the orphaned tool loaded (a
           tools change), where the old path's array stayed as the reveal left it. In the simulator that re-writes the
           newly loaded definition and the system prompt behind it, once; nothing more. (This fixture reveals on its first
           turn, with next to no prompt to save, so here the whole run comes out a little dearer; a reveal saves the
           prompt as it stands, see 2.) */
      const foldOff = await runCase(CASES.fold());
      const U = priced(fold), V = priced(foldOff);
      const bill = W => W.reduce((s, u) => s + Sim.inputEq(u, 0.05), 0);
      const extra = written(U[at]) - written(V[at]);
      const loadedDef = JSON.stringify(bare(F[at].body.tools.find(t => t.name === 'page_screenshot'))).length + JSON.stringify(noCache(F[at].body.system)).length;
      console.log('  simulated tokens written, request by request: OFF ' + JSON.stringify(V.map(u => tok(written(u)))) + ', ON ' + JSON.stringify(U.map(u => tok(written(u))))
        + '; whole run input-equivalent OFF ' + tok(bill(V)) + ', ON ' + tok(bill(U)));
      A.ok(extra >= 0 && extra <= loadedDef + 64, 'fold: the fold\'s own request writes the newly loaded definition and the system prompt again, and nothing more (' + extra + ' characters over the old path, bound ' + loadedDef + ')');
      A.eq(U.map((u, i) => (i !== at && written(u) > written(V[i]) ? i + 1 : 0)).filter(Boolean), [], 'fold: no other request writes more than the old path');
    }

    forget();
    const stop = await runCase(Object.assign({ nativeDefer: true }, CASES.stop()));
    const S = stop.up.posts;
    A.eq(stop.res.reason, 'done', 'stopTools: the run finishes');
    A.eq(S.map(p => p.status), [200, 200, 200], 'stopTools: three requests');
    A.eq([deferredNames(S[0].body).length, references(S[1].body).length], [2, 1], 'stopTools: until the proof, the deferred tools are declared and the reveal is a reference');
    A.eq(S[2].raw, golden.stop[2], 'stopTools: the tool-free request is the switch-off one, byte for byte (no tools, nothing declared up front)');
    A.ok(!('tools' in S[2].body), 'stopTools: it carries no tools at all');
  }

  // ================= 8. one switch =================
  {
    const code = sidecarSourceFiles().map(f => ({ rel: f.rel, text: decomment(f.text) }));
    A.eq(code.filter(f => /(STARNET|SKYNET)_NATIVE_DEFER|['"`]NATIVE_DEFER['"`]/.test(f.text)).map(f => f.rel), ['sidecar/index.js'], 'switch: STARNET_NATIVE_DEFER is read in one place');
    A.ok(/nativeDefer:\s*\/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('NATIVE_DEFER'\)/.test(code[0].text), 'switch: the host hands the loop nativeDefer from ENV(\'NATIVE_DEFER\'), off unless 1/true/yes/on');
    A.eq(code.filter(f => /deferredToolsKey\s*[(=:]|function deferredToolsKey/.test(f.text) && /defer_loading/.test(f.text)).map(f => f.rel), ['sidecar/providers/anthropic.js'], 'one resolver: only the native adapter writes defer_loading, behind its one support check');
    A.eq(code.filter(f => /defer_loading|tool_reference/.test(f.text)).map(f => f.rel), ['sidecar/providers/anthropic.js'], 'one resolver: no other sidecar file knows the wire fields');
  }

  // ================= 9. every request shape the adapter builds =================
  {
    // The native adapter on each shape a loop sends (test/helpers/cache-ttl-bodies.js), carrying the loop's field: two
    // deferred tools, one revealed by the history's own tool result (call_1). The documented rules hold on every one.
    forget();
    const fnDef = (name) => ({ type: 'function', function: { name, description: name + ' does one thing.', parameters: { type: 'object', properties: { value: { type: 'string' } } } } });
    const deferred = [fnDef('page_screenshot'), fnDef('page_upload')];
    const model = Bodies.ROUTES.anthropic.model;
    for (const name of Object.keys(Bodies.CASES)) {
      const req = Bodies.CASES[name](model);
      const hasCall = (req.messages || []).some(m => m.role === 'tool' && m.tool_call_id === 'call_1');
      const withTool = Object.assign({}, req, req.tools ? { tools: req.tools.concat([deferred[0]]) } : {});   // the loop appended the revealed definition
      const plain = await routeBody('anthropic', req);
      const sent = await routeBody('anthropic', Object.assign({}, withTool, { nativeDefer: { deferred, reveals: [{ id: 'call_1', names: ['page_screenshot'] }] } }));
      const body = JSON.parse(sent.body);
      if (!req.tools) { A.eq(sent.body, plain.body, 'shape ' + name + ': a request with no tools is the same body with the field as without'); continue; }
      A.eq(violation(body), null, 'shape ' + name + ': a request the documented API accepts');
      A.eq(toolNames(body), ['fs_read', 'web_search', 'page_screenshot', 'page_upload'], 'shape ' + name + ': the core tools, then the deferred ones');
      A.eq(references(body), hasCall ? [['call_1', 'page_screenshot']] : [], 'shape ' + name + ': the reveal rides its tool result when the request holds it');
      A.eq(deferredNames(body), hasCall ? ['page_screenshot', 'page_upload'] : ['page_upload'], 'shape ' + name + ': a revealed tool with no result to ride is declared loaded');
      const plainBody = JSON.parse(plain.body);
      const anchored = t => t.map((x, i) => (x.cache_control ? i : -1)).filter(i => i >= 0);
      A.eq(anchored(body.tools), anchored(plainBody.tools).map(() => (hasCall ? 1 : 2)), 'shape ' + name + ': the tools anchor, where the old path has one, sits on the last loaded tool');
      A.eq(JSON.stringify(noCache(body.system || null)), JSON.stringify(noCache(plainBody.system || null)), 'shape ' + name + ': the system prompt is unchanged');
      // the loop's request view: the same key before and after a reveal that rides its result; another once the result is gone
      const p = sent.provider;
      if (typeof p.deferredToolsKey !== 'function') { A.ok(false, 'shape ' + name + ': the adapter names the tools identity for the loop'); continue; }
      const key = r => JSON.stringify(p.deferredToolsKey(r));
      const base = { model, tools: req.tools, messages: req.messages, nativeDefer: { deferred, reveals: [] } };
      const after = { model, tools: withTool.tools, messages: req.messages, nativeDefer: { deferred, reveals: [{ id: 'call_1', names: ['page_screenshot'] }] } };
      A.eq(key(after) === key(base), hasCall, 'shape ' + name + ': the tools identity the loop is told ' + (hasCall ? 'does not change at a reveal that rides its result' : 'changes when a revealed tool has no result to ride'));
      A.eq(p.deferredToolsKey({ model, tools: req.tools, messages: req.messages }), null, 'shape ' + name + ': no field, no plan');
    }
    {   // a call id another provider minted (a mid-run fallback): the adapter rewrites it into this wire's grammar, and the
        // reference still rides that result; a stored message that happens to hold a `toolRefs` key loads nothing
      const odd = 'functions.fs_read:0';
      const tools = Bodies.CASES['nosystem-tools-turn'](model).tools;
      const messages = [{ role: 'user', content: 'go' }, { role: 'assistant', content: '', tool_calls: [{ id: odd, type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: odd, content: 'file text', toolRefs: ['page_upload'] }];
      const sent = await routeBody('anthropic', { model, tools: tools.concat([deferred[0]]), messages, nativeDefer: { deferred, reveals: [{ id: odd, names: ['page_screenshot'] }] } });
      const body = JSON.parse(sent.body);
      A.eq(violation(body), null, 'foreign id: a request the documented API accepts');
      A.eq(references(body).map(r => r[1]), ['page_screenshot'], 'foreign id: the reveal rides its result, and only what the loop said was revealed');
      A.ok(references(body).length === 1 && references(body)[0][0] !== odd && /^[a-zA-Z0-9_-]{1,64}$/.test(references(body)[0][0]), 'foreign id: under the id this wire carries');
      A.eq(deferredNames(body), ['page_screenshot', 'page_upload'], 'foreign id: both stay declared, not loaded up front');
    }
  }

  A.report('native-defer.invariant.test');
})().catch(e => { console.log('THREW', e && e.stack || e); process.exit(1); });
