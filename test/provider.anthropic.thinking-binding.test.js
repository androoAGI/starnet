/* node test/provider.anthropic.thinking-binding.test.js — issue #73: every run on claude-sonnet-5-5 / claude-opus-5-5
   through the native anthropic provider died with
     400 "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation…"
   and Sonnet 5.5 effort OFF died with
     400 "To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}."

   No live key exists here, so the upstream is a FAKE SERVER that enforces the documented rules itself:
     · a thinking block's signature is a hash of its conversation prefix (system, tools, every earlier message and every
       earlier block of its own turn — cache_control ignored); replaying it under a different prefix is the exact 400
       above, unless `thinking.block_binding.prefix_mismatch_behavior:'drop_block'` is on, in which case the block and
       every later one are dropped and reported in message_start.input_transformations;
     · block_binding without the `thinking-binding-controls-2026-08-01` beta header is a 400;
     · Sonnet 5.5 refuses {type:'disabled'}; `between_tools` refuses any other field inside `thinking`.
   Then the fixes are proven against it, through the adapter alone and through the REAL loop (two consecutive turns). */
'use strict';
const crypto = require('crypto');
const A = require('./_assert.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const failopen = require('../sidecar/failopen.js');
const { makeAnthropicProvider, _internals } = require('../sidecar/providers/anthropic.js');

const BETA = 'thinking-binding-controls-2026-08-01';
const BOUND_400 = 'Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the beta header.';
const SONNET_OFF_400 = 'To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.';
const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const noCache = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
const hash = v => crypto.createHash('sha1').update(JSON.stringify(noCache(v))).digest('hex').slice(0, 16);
const prefixSig = (body, msgs, ownBlocks) => 'sig:' + hash({ system: body.system || null, tools: body.tools || null, msgs, own: ownBlocks });
const apiError = (status, message) => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), { status, headers: { 'Content-Type': 'application/json' } });

/* The fake Anthropic server. script(n, body) returns the response content for request n as a list of
   {type:'thinking'} | {type:'text', text} | {type:'tool_use', name, input}; thinking blocks are signed here. */
function fakeServer(script, o) {
  o = o || {};
  const posts = [];
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    const body = JSON.parse(init.body);
    const headers = init.headers || {};
    posts.push({ body, headers });
    const th = body.thinking || null;
    const beta = String(headers['anthropic-beta'] || '');
    if (o.rejectBeta && beta.indexOf(BETA) >= 0) return apiError(400, 'Unexpected value(s) `' + BETA + '` for the `anthropic-beta` header.');
    if (th && th.block_binding && beta.indexOf(BETA) < 0) return apiError(400, 'thinking.block_binding: Extra inputs are not permitted');
    if (th && th.type === 'disabled' && /sonnet-5[-.]5/.test(body.model)) return apiError(400, SONNET_OFF_400);
    if (th && th.type === 'between_tools' && Object.keys(th).length !== 1) return apiError(400, 'thinking: between_tools accepts no other field');
    // the binding check, block by block, in wire order
    const drop = th && th.block_binding && th.block_binding.prefix_mismatch_behavior === 'drop_block';
    const transformations = [];
    let dropping = false;
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (b.type !== 'thinking') continue;
        const want = prefixSig(body, body.messages.slice(0, i), m.content.slice(0, j));
        if (!dropping && b.signature === want) continue;
        if (!drop) return apiError(400, 'messages.' + i + '.content.' + j + ': ' + BOUND_400);
        dropping = true;   // the first mismatched block AND every later thinking block
        transformations.push({ type: 'thinking_block_dropped', reason: 'prefix_binding_mismatch', location: 'messages.' + i + '.content.' + j });
      }
    }
    const content = script(posts.length, body);
    const ev = [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 }, input_transformations: transformations.length ? transformations : undefined } }];
    const own = [];
    let toolUse = false;
    content.forEach((c, idx) => {
      if (c.type === 'thinking') {
        const sig = prefixSig(body, body.messages, own.slice());
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: sig } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'thinking', thinking: '', signature: sig });
      } else if (c.type === 'text') {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: c.text } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'text', text: c.text });
      } else {
        toolUse = true;
        const id = 'toolu_' + posts.length + '_' + idx;
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id, name: c.name, input: {} } },
          { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'tool_use', id, name: c.name, input: c.input || {} });
      }
    });
    ev.push({ type: 'message_delta', delta: { stop_reason: toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } }, { type: 'message_stop' });
    return new Response(ev.map(line).concat(['']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, posts };
}
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
async function collectErr(p, req) { try { await collect(p, req); return null; } catch (e) { return e; } }
const thinkingCount = body => body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'thinking' || b.type === 'redacted_thinking').length : 0), 0);
const fsTool = { type: 'function', function: { name: 'fs_read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };

/* A history whose replayed thinking block was signed under a DIFFERENT prefix — what a tool.search reveal, a stale
   screenshot placeholder or a fold does to a live run. Signed against tools=[] then replayed with tools=[fs_read]. */
function staleHistory() {
  const sig = prefixSig({ system: null, tools: null }, [{ role: 'user', content: [{ type: 'text', text: 'read a' }] }], []);
  return [
    { role: 'user', content: 'read a' },
    { role: 'assistant', content: '', reasoning: [{ type: 'thinking', thinking: '', signature: sig }], tool_calls: [{ id: 'toolu_x', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'toolu_x', content: 'A' }
  ];
}

(async () => {
  // ---- 1. Sonnet 5.5 effort OFF -> between_tools, bare, no effort (was: 400 "send between_tools instead of disabled") ----
  for (const model of ['claude-sonnet-5-5', 'claude-sonnet-5.5', 'anthropic/claude-sonnet-5.5', 'claude-sonnet-5-5-20261001']) {
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    const p = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'none' });
    const err = await collectErr(p, { model, messages: [{ role: 'user', content: 'hi' }] });
    A.eq(err, null, model + ' OFF no longer 400s');
    A.eq(up.posts[0].body.thinking, { type: 'between_tools' }, model + ' OFF -> {type:between_tools} and nothing else inside thinking');
    A.eq(up.posts[0].body.output_config, undefined, model + ' OFF sends no effort (between_tools is refused above high)');
    A.eq(up.posts[0].headers['anthropic-beta'], undefined, model + ' OFF sends no binding beta (block_binding is adaptive-only)');
    A.ok(p.reasoningEfforts(model).indexOf('none') === 0, model + ' still publishes OFF, so the dock keeps the option');
  }
  {
    // the OLD wire, against the same fake server, is the reported failure verbatim
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    const p = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'none' });
    const err = await collectErr(p, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(err, null, 'Sonnet 5 OFF still accepted');
    A.eq(up.posts[0].body.thinking, { type: 'disabled' }, 'Sonnet 5 keeps {type:disabled} (between_tools is Sonnet 5.5 only)');
    const r = await fakeServer(() => [])
      .fetch('https://api.anthropic.com/v1/messages', { headers: {}, body: JSON.stringify({ model: 'claude-sonnet-5-5', messages: [], thinking: { type: 'disabled' } }) });
    A.eq((await r.json()).error.message, SONNET_OFF_400, 'fixture sanity: the fake server reproduces the reported Sonnet 5.5 OFF 400');
  }

  // ---- 2. binding generation on adaptive thinking: block_binding + the beta header travel together ----
  for (const model of ['claude-opus-5-5', 'claude-opus-5.5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'anthropic/claude-opus-5.5', 'claude-haiku-5-5', 'claude-haiku-5.5']) {
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    await collect(makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'high' }), { model, messages: [{ role: 'user', content: 'hi' }] });
    A.eq(up.posts[0].body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }, model + ' -> adaptive + drop_block binding');
    A.eq(up.posts[0].headers['anthropic-beta'], BETA, model + ' -> the binding beta header rides with it');
  }
  {
    // Opus 5.5 OFF still clamps to the lowest effort (thinking cannot be disabled there) — and is bound.
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    await collect(makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'off' }), { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(up.posts[0].body.output_config, { effort: 'low' }, 'Opus 5.5 OFF keeps its clamp to low');
    A.ok(up.posts[0].body.thinking.block_binding, 'and carries drop_block');
  }
  {
    /* Haiku 5.5 runs the same history-editing check as Fable 5.1 / Opus 5.5 / Sonnet 5.5 (claude-api skill,
       model-migration.md "Migrating to Claude Haiku 5.5"), and block_binding is valid only with adaptive thinking.
       Its OFF is a plain {type:'disabled'} (accepted at high or below) that must NOT carry block_binding. */
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    await collect(makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'none' }), { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(up.posts[0].body.thinking, { type: 'disabled' }, 'Haiku 5.5 OFF stays a bare disable (no block_binding beside it)');
    A.eq(up.posts[0].headers['anthropic-beta'], undefined, 'Haiku 5.5 OFF sends no binding beta');
    // a stale replayed block on Haiku 5.5: drop_block covers it in ONE request (was: a 400 + a strip-and-resend)
    const up2 = fakeServer(() => [{ type: 'text', text: 'done' }]);
    const evs = await collect(makeAnthropicProvider({ fetch: up2.fetch, key: 'k', reasoningEffort: 'medium' }), { model: 'claude-haiku-5-5', messages: staleHistory(), tools: [fsTool] });
    A.eq(up2.posts.length, 1, 'Haiku 5.5 history edit: ONE request, no 400 and no rescue round-trip');
    A.eq(evs.find(e => e.type === 'done').thinkingDropped, 1, 'Haiku 5.5: the dropped block is reported');
    A.eq(thinkingCount(up2.posts[0].body), 1, 'Haiku 5.5: the block was still sent (never pre-emptively stripped)');
  }
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'some-vendor/mixtral']) {
    const up = fakeServer(() => [{ type: 'text', text: 'ok' }]);
    await collect(makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'high' }), { model, messages: [{ role: 'user', content: 'hi' }] });
    A.ok(!(up.posts[0].body.thinking && up.posts[0].body.thinking.block_binding), model + ' gets no block_binding (outside the binding generation / not Claude)');
    A.eq(up.posts[0].headers['anthropic-beta'], undefined, model + ' gets no beta header');
  }
  A.eq(_internals.headerBag('k', null, [BETA, 'other-beta-2026-01-01', BETA])['anthropic-beta'], BETA + ',other-beta-2026-01-01', 'betas merge comma-separated, de-duplicated');

  // ---- 3. drop_block: a stale replayed block no longer kills the turn; the drop is reported, not hidden ----
  {
    const up = fakeServer(() => [{ type: 'text', text: 'done' }]);
    const before = failopen.counts()['providers.anthropic.thinking_dropped'] || 0;
    const evs = await collect(makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' }), { model: 'claude-opus-5-5', messages: staleHistory(), tools: [fsTool] });
    A.eq(up.posts.length, 1, 'drop_block: ONE request, no rescue needed');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'done', 'the turn completes');
    A.eq(evs.find(e => e.type === 'done').thinkingDropped, 1, 'input_transformations surfaces as done.thinkingDropped');
    A.eq((failopen.counts()['providers.anthropic.thinking_dropped'] || 0) - before, 1, 'and as a tagged diagnostics line (failopen tally)');
    A.eq(thinkingCount(up.posts[0].body), 1, 'the block was still SENT (never pre-emptively stripped on adaptive)');
  }

  // ---- 4. strip-and-retry rescue: 'bound' (no drop_block possible: Sonnet 5.5 between_tools) ----
  {
    const up = fakeServer(() => [{ type: 'text', text: 'recovered' }]);
    const p = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'none' });
    const history = staleHistory();
    const evs = await collect(p, { model: 'claude-sonnet-5-5', messages: history, tools: [fsTool] });
    A.eq(up.posts.length, 2, 'bound 400 -> exactly ONE resend');
    A.eq(thinkingCount(up.posts[1].body), 0, 'the resend strips the replayed thinking blocks');
    A.eq(up.posts[1].body.thinking, { type: 'between_tools' }, 'the resend keeps the same thinking mode');
    A.eq(evs.filter(e => e.type === 'usage').length, 2, 'usage comes only from the ONE billed stream (message_start + message_delta), never doubled');
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'recovered', 'the turn completes');
    A.ok(history[1].reasoning.length === 1, "the caller's transcript is never mutated");
    // next turn, same history objects: the stripped blocks stay stripped (bringing them back would break the NEW
    // blocks' prefix) — no second 400.
    await collect(p, { model: 'claude-sonnet-5-5', messages: history.concat([{ role: 'user', content: 'and b' }]), tools: [fsTool] });
    A.eq(up.posts.length, 3, 'the following turn needs no rescue');
    A.eq(thinkingCount(up.posts[2].body), 0, 'stripped blocks are remembered as stripped');
  }
  {
    // never loops: a server that refuses every time ends after exactly two requests, error intact
    const posts = [];
    const fetch = async (url, init) => { if (!/\/messages$/.test(url)) return new Response('{"data":[]}'); posts.push(JSON.parse(init.body)); return apiError(400, 'messages.1.content.0: ' + BOUND_400); };
    const err = await collectErr(makeAnthropicProvider({ fetch, key: 'k', reasoningEffort: 'high' }), { model: 'claude-opus-5', messages: staleHistory(), tools: [fsTool] });
    A.eq(posts.length, 2, 'a second bound 400 is NOT rescued again');
    A.ok(err && err.status === 400 && /bound to a different conversation/.test(err.message), 'and surfaces as the real 400');
  }
  {
    // an unrelated 400 is never rescued
    const posts = [];
    const fetch = async (url) => { if (!/\/messages$/.test(url)) return new Response('{"data":[]}'); posts.push(1); return apiError(400, 'max_tokens: must be greater than thinking.budget_tokens'); };
    const err = await collectErr(makeAnthropicProvider({ fetch, key: 'k', reasoningEffort: 'high' }), { model: 'claude-opus-5-5', messages: staleHistory(), tools: [fsTool] });
    A.eq(posts.length, 1, 'unrelated 400: one request, no rescue');
    A.ok(err && err.status === 400, 'unrelated 400 propagates unchanged');
  }
  {
    // a bound 400 with NO thinking blocks in the request cannot be helped by stripping -> no resend
    const posts = [];
    const fetch = async (url) => { if (!/\/messages$/.test(url)) return new Response('{"data":[]}'); posts.push(1); return apiError(400, BOUND_400); };
    await collectErr(makeAnthropicProvider({ fetch, key: 'k' }), { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(posts.length, 1, 'nothing to strip -> no resend');
  }

  // ---- 5. an endpoint that refuses the beta: one resend without block_binding/header, and it stays off ----
  for (const reject of ['header', 'field']) {
    const up = reject === 'header'
      ? fakeServer(() => [{ type: 'text', text: 'ok' }], { rejectBeta: true })
      : (() => {   // a gateway that strips the header but forwards the field -> "Extra inputs are not permitted"
          const s = fakeServer(() => [{ type: 'text', text: 'ok' }]);
          const f = s.fetch;
          s.fetch = (url, init) => f(url, Object.assign({}, init, { headers: Object.assign({}, init.headers, { 'anthropic-beta': undefined }) }));
          return s;
        })();
    const p = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'high' });
    const err = await collectErr(p, { model: 'claude-opus-5-5', messages: staleHistory(), tools: [fsTool] });
    A.eq(err, null, reject + ' rejection: the turn still completes');
    A.eq(up.posts.length, 2, reject + ' rejection: exactly one resend');
    A.ok(!up.posts[1].body.thinking.block_binding, reject + ' rejection: resend drops block_binding');
    A.ok(!up.posts[1].headers['anthropic-beta'], reject + ' rejection: resend drops the beta header');
    A.eq(thinkingCount(up.posts[1].body), 0, reject + ' rejection: resend strips thinking (no drop_block to cover a mismatch)');
    await collect(p, { model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'again' }] });
    A.ok(!up.posts[2].body.thinking.block_binding && !up.posts[2].headers['anthropic-beta'], reject + ' rejection: binding stays off for this provider');
  }

  // ---- 6. replay order: a block keeps its place in the turn (hoisting it rewrites its own prefix) ----
  {
    const shapes = {
      'text before thinking': [{ type: 'text', text: 'Let me look. ' }, { type: 'thinking' }, { type: 'tool_use', name: 'fs_read', input: { path: 'a' } }],
      'thinking between tool calls': [{ type: 'thinking' }, { type: 'tool_use', name: 'fs_read', input: { path: 'a' } }, { type: 'thinking' }, { type: 'tool_use', name: 'fs_read', input: { path: 'b' } }],
      'plain thinking-first': [{ type: 'thinking' }, { type: 'text', text: 'Reading.' }, { type: 'tool_use', name: 'fs_read', input: { path: 'a' } }]
    };
    for (const name of Object.keys(shapes)) {
      // drop_block OFF (Opus 5 is outside the binding list) so ANY reorder would be a hard 400 here
      const up = fakeServer(n => n === 1 ? shapes[name] : [{ type: 'text', text: 'fin' }]);
      const reg = makeRegistry();
      reg.register({ name: 'fs_read', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async a => ({ content: 'file ' + a.path, summary: 'read' }) });
      const res = await runAgentLoop({
        messages: [{ role: 'system', content: 'You are a station agent.' }, { role: 'user', content: 'read' }],
        provider: makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'high' }), emit: makeEmitter(A.makeBus(), () => {}),
        cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), model: 'claude-opus-5', agentId: 'a', runId: 'r', tools: [fsTool],
        limits: { maxIters: 4 }, dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' },
        sleep: async () => {}, random: () => 0.5
      });
      A.eq(res.reason, 'done', name + ': the run finishes');
      A.eq(up.posts.length, 2, name + ': no 400, no rescue — the replay matched the signed prefix');
      A.eq(up.posts[1].body.messages[1].content.map(b => b.type), shapes[name].map(c => c.type), name + ': replayed in the produced order');
    }
  }

  // ---- 7. ROOT CAUSE probe: two consecutive loop turns, request 1 vs request 2 (cache_control ignored) ----
  {
    const runProbe = async (withReveal) => {
      const up = fakeServer(n => n === 1
        ? [{ type: 'thinking' }, { type: 'tool_use', name: withReveal ? 'tool_search' : 'fs_read', input: withReveal ? { query: 'web' } : { path: 'a' } }]
        : [{ type: 'thinking' }, { type: 'text', text: 'answer' }]);
      const reg = makeRegistry();
      reg.register({ name: 'fs_read', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async a => ({ content: 'file ' + a.path, summary: 'read' }) });
      reg.register({ name: 'tool_search', schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => ({ content: 'revealed web_fetch', summary: 'found', control: { revealTools: ['web_fetch'] } }) });
      const searchTool = { type: 'function', function: { name: 'tool_search', description: 'find tools', parameters: { type: 'object', properties: { query: { type: 'string' } } } } };
      const webFetch = { type: 'function', function: { name: 'web_fetch', description: 'fetch a url', parameters: { type: 'object', properties: { url: { type: 'string' } } } } };
      const prefix = 'You are a station agent. '.repeat(20);
      const res = await runAgentLoop({
        messages: [{ role: 'system', content: prefix + '\n[RUNTIME] Run id: r1' }, { role: 'user', content: 'research this' }],
        provider: makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' }), emit: makeEmitter(A.makeBus(), () => {}),
        cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), model: 'claude-opus-5-5', agentId: 'a', runId: 'r',
        tools: [fsTool, searchTool], deferredTools: [webFetch], cacheSystemPrefix: prefix, toolImages: true,
        limits: { maxIters: 4 }, dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' },
        sleep: async () => {}, random: () => 0.5
      });
      const [r1, r2] = up.posts.map(p => noCache(p.body));
      return { res, up, diff: { system: JSON.stringify(r1.system) !== JSON.stringify(r2.system), tools: JSON.stringify(r1.tools) !== JSON.stringify(r2.tools), messages0: JSON.stringify(r1.messages[0]) !== JSON.stringify(r2.messages[0]) }, r1, r2 };
    };
    const plain = await runProbe(false);
    A.eq(plain.diff, { system: false, tools: false, messages0: false }, 'ROOT CAUSE: a plain tool round keeps system, tools and messages[0] byte-stable (the loop is append-only here)');
    A.eq(plain.up.posts.length, 2, 'plain round: no 400, no drop');
    const reveal = await runProbe(true);
    A.eq(reveal.diff, { system: false, tools: true, messages0: false }, 'ROOT CAUSE: a tool.search reveal changes `tools` mid-run, which unbinds every earlier thinking block');
    A.eq(reveal.r2.tools.map(t => t.name), ['fs_read', 'tool_search', 'web_fetch'], 'the revealed tool is appended to the request');
    A.eq(reveal.res.reason, 'done', 'with drop_block the revealed-tools turn still finishes');
    A.eq(reveal.up.posts.length, 2, 'no 400 and no rescue round-trip');
  }

  A.report('provider.anthropic.thinking-binding.test');
})().catch(e => { console.log('FAIL: provider.anthropic.thinking-binding.test threw -- ' + (e && e.stack || e)); process.exit(1); });
