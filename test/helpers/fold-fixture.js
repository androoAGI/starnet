'use strict';
/* A LONG RUN THAT FOLDS, on a recording Anthropic upstream that keeps a prompt cache (cost lane W2.7, the fold-from-prefix
   tests). Hermetic: the REAL loop, the REAL Anthropic adapter, the REAL compaction summarizer; the only fake is the upstream,
   an injected fetch. No network, no paid call.

   THE UPSTREAM'S CACHE follows the documented rules (claude-api skill, shared/prompt-caching.md): a request is its tools,
   system blocks and message blocks in order; a block carrying cache_control is a breakpoint; at each breakpoint the longest
   cached prefix is read (an exact hit, else an entry found looking back at most 20 positions), and the prefix up to the
   breakpoint is written when it was not there. The model, the thinking setting, the effort and the tool choice head the
   prefix here, so a request that changes one of them reads nothing (the documented table only loses the messages cache for
   a tool-choice or thinking change: this upstream is the stricter of the two). An entry lives 5 minutes (1 hour for a
   ttl:'1h' breakpoint) from its last read, on the fixture's clock. Tokens are bytes / 4 on both sides.

   runLong(o) drives one run: a task, a tool that returns ~19k characters per call, a 60k-token window (so the run passes its
   fold line after eight results and the paid fold has several 48k-character chunks to send when it is chunked). */
const crypto = require('crypto');
const A = require('../_assert.js');
const events = require('../../shared/events.js');
const { makeEmitter } = require('../../shared/emitter.js');
const { makeCostEngine } = require('../../sidecar/cost.js');
const { runAgentLoop } = require('../../sidecar/loop.js');
const { makeContext, compactionSummaryPrompt, RUN_CONTEXT_DEFAULTS } = require('../../sidecar/context.js');
const { makeRegistry } = require('../../sidecar/tools/registry.js');
const { makeAnthropicProvider } = require('../../sidecar/providers/anthropic.js');
const { makeSummarizer } = require('../../sidecar/compaction-summarizer.js');

const NL = String.fromCharCode(10);
const MODEL = 'claude-opus-5-5';
const line = obj => 'data: ' + JSON.stringify(obj);
const bare = v => JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x));
const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const fn = (name, props) => ({ type: 'function', function: { name, description: name + ' tool', parameters: { type: 'object', properties: props || {} } } });
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };
const SUMMARY = ['## Active Task', 'Finish the audit.', '## Completed', '- BODY results read so far, values carried forward', '## Remaining Work', '- the rest of the calls'].join(NL);

// a request as the ordered positions a prefix cache sees: { text (cache_control left out), bp (it carried one), ttl }
function flatten(body) {
  const out = [{ text: 'head:' + JSON.stringify([body.model, body.thinking || null, (body.output_config && body.output_config.effort) || null, body.tool_choice || null]), bp: false }];
  const mark = b => !!(b && typeof b === 'object' && b.cache_control);
  const ttl = b => (mark(b) && b.cache_control.ttl === '1h' ? 3600000 : 300000);
  for (const t of body.tools || []) out.push({ text: 'tool:' + bare(t), bp: mark(t), ttl: ttl(t) });
  const system = typeof body.system === 'string' ? [{ type: 'text', text: body.system }] : (body.system || []);
  for (const s of system) out.push({ text: 'system:' + bare(s), bp: mark(s), ttl: ttl(s) });
  for (const m of body.messages || []) {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    for (const b of parts) out.push({ text: m.role + ':' + bare(b), bp: mark(b), ttl: ttl(b) });
  }
  return out;
}
const bytesOf = positions => positions.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
// how much of request b is, position for position, the start of request a (bytes of the shared leading positions)
function sharedPrefix(a, b) {
  let i = 0, bytes = 0;
  while (i < a.length && i < b.length && a[i].text === b[i].text) { bytes += Buffer.byteLength(b[i].text); i++; }
  return { positions: i, bytes, whole: i === a.length };
}
// which request this is: the run's own ('run'), a fold from the run's prefix ('prefix'), a chunk of the chunked fold ('chunk')
function kindOf(body) {
  const system = typeof body.system === 'string' ? body.system : (body.system || []).map(s => s.text).join(NL);
  if (/^You (compress an earlier slice|maintain a running summary)/.test(system)) return 'chunk';
  const last = (body.messages || []).at(-1), parts = last && Array.isArray(last.content) ? last.content : [];
  const tail = parts.length && typeof parts.at(-1).text === 'string' ? parts.at(-1).text : (last && typeof last.content === 'string' ? last.content : '');
  return /^<host_turn>\nThe host is folding this conversation/.test(tail) ? 'prefix' : 'run';
}
/* script(rec) -> the reply's content: [{ type: 'thinking' } | { type: 'text', text } | { type: 'tool_use', name, input }], or
   { status, message } to refuse the request. now(): the fixture clock (ms), for the cache's lifetimes. */
function cachingServer(script, now) {
  const posts = [], cache = new Map();
  const clock = () => (typeof now === 'function' ? Number(now()) || 0 : 0);
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    const raw = String(init.body), body = JSON.parse(raw), n = posts.length + 1, at = clock();
    const positions = flatten(body), keys = [], sizes = [];
    let h = '', size = 0;
    for (const p of positions) { h = sha(h + p.text); size += Buffer.byteLength(p.text); keys.push(h); sizes.push(size); }
    const live = k => { const e = cache.get(k); return !!(e && e.until > at); };
    let read = -1, written = -1;
    positions.forEach((p, i) => {
      if (!p.bp) return;
      let hit = -1;
      if (live(keys[i])) hit = i;
      else for (let j = i - 1; j >= Math.max(0, i - 20); j--) if (live(keys[j])) { hit = j; break; }
      if (hit >= 0) { read = Math.max(read, hit); cache.get(keys[hit]).until = at + cache.get(keys[hit]).ttl; }
      if (hit !== i) { cache.set(keys[i], { until: at + p.ttl, ttl: p.ttl }); written = Math.max(written, i); }
    });
    const tok = bytes => Math.ceil(bytes / 4);
    const total = tok(size), cacheRead = read >= 0 ? tok(sizes[read]) : 0, cacheWrite = written > read ? tok(sizes[written]) - cacheRead : 0;
    const rec = { n, at, body, raw, bytes: Buffer.byteLength(raw), positions, kind: kindOf(body), anchors: positions.filter(p => p.bp).length,
      usage: { total, cacheRead, cacheWrite, fresh: total - cacheRead - cacheWrite } };
    posts.push(rec);
    const content = script(rec);
    if (content && !Array.isArray(content)) return new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: content.message || 'upstream failed' } }), { status: content.status || 500 });
    const ev = [{ type: 'message_start', message: { usage: { input_tokens: rec.usage.fresh, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 0 } } }];
    let toolUse = false;
    content.forEach((c, idx) => {
      if (c.type === 'thinking') {   // a signed thinking block, as a binding Claude model returns one: replayed on every later request
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: 'sig_' + n + '_' + idx } }, { type: 'content_block_stop', index: idx });
      } else if (c.type === 'text') {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: c.text } }, { type: 'content_block_stop', index: idx });
      } else {
        toolUse = true;
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: 'toolu_' + n + '_' + idx, name: c.name, input: {} } },
          { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input || {}) } }, { type: 'content_block_stop', index: idx });
      }
    });
    ev.push({ type: 'message_delta', delta: { stop_reason: content.cut ? 'max_tokens' : toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 60 } }, { type: 'message_stop' });
    return new Response(ev.map(line).concat(['']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, posts, cache };
}
/* runLong(o) -> { res, up, seq, ran, folds, runs, compacts }
   o.foldFromPrefix    the switch, as index.js hands it to the loop (absent: off)
   o.calls             tool calls the model makes before it finishes (default 11)
   o.foldReply(rec)    what the upstream answers a fold from the prefix with (default: a whole summary)
   o.clock             { now } handed to the loop and the upstream; o.onTool(k): called as the k-th tool call runs
   o.auxModelFor, o.messages, o.contextLimit, o.wrap(provider) */
async function runLong(o) {
  o = o || {};
  const calls = o.calls || 11;
  let made = 0;
  const up = cachingServer(rec => {
    if (rec.kind === 'chunk') return [{ type: 'text', text: SUMMARY }];
    if (rec.kind === 'prefix') return o.foldReply ? o.foldReply(rec) : [{ type: 'thinking' }, { type: 'text', text: SUMMARY }];
    return made++ < calls ? [{ type: 'thinking' }, { type: 'tool_use', name: 'noop', input: { step: made } }] : [{ type: 'thinking' }, { type: 'text', text: 'All done.' }];
  }, o.clock && o.clock.now);
  const reg = makeRegistry();
  let ran = 0;
  reg.register({ impact: 'none', name: 'noop', schema: { type: 'object', properties: { step: { type: 'number' } } },
    run: async () => { ran++; if (typeof o.onTool === 'function') o.onTool(ran); return filler('BODY#' + ran, 19000); } });
  const provider = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' });
  const cost = makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) });
  const bus = A.makeBus(), seq = A.collectBus(bus, events.names());
  const drained = [];
  const summarize = makeSummarizer({ provider, model: MODEL, cost, summaryPrompt: compactionSummaryPrompt, agentId: 'a', runId: 'r',
    auxModelFor: o.auxModelFor, transcriptDrain: older => { drained.push(older.length); } });
  const res = await runAgentLoop({
    messages: o.messages || [{ role: 'system', content: 'You are a station agent. ' + filler('RULE', 1800) }, { role: 'user', content: 'audit every body and report' }],
    provider: (o.wrap || (p => p))(provider), emit: makeEmitter(bus, () => {}), cost, model: MODEL, agentId: 'a', runId: 'r',
    tools: [fn('noop', { step: { type: 'number' } }), fn('fs_read', { path: { type: 'string' } })],
    context: makeContext(Object.assign({ contextLimit: o.contextLimit || 60000 }, RUN_CONTEXT_DEFAULTS)), summarize, microCompaction: false,
    foldFromPrefix: o.foldFromPrefix, clock: o.clock, limits: { maxIters: calls + 6 }, dispatch: (c, ctx) => reg.dispatch(c, ctx),
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, sleep: async () => {}, random: () => 0.5
  });
  return { res, up, seq, ran, drained, runs: up.posts.filter(p => p.kind === 'run'), folds: up.posts.filter(p => p.kind !== 'run'),
    compacts: seq.filter(e => e.name === 'agent.compact').map(e => e.payload) };
}
// the digest of every request a run sent, byte for byte (what "the same bytes as the base" is checked on)
const digest = posts => crypto.createHash('sha256').update(posts.map(p => p.raw).join(NL)).digest('hex');
module.exports = { runLong, cachingServer, flatten, bytesOf, sharedPrefix, kindOf, digest, filler, fn, MODEL, SUMMARY, NL };
