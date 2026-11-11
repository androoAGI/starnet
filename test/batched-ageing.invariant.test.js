/* node test/batched-ageing.invariant.test.js — W2.1 BATCHED AGEING: old tool results and successful write arguments age
   in batches, in the request view only.

   Red on 9896a5c44 (the Wave 1 stack), green on the lane. Hermetic: no network, no paid call, a temp workspace, the
   binding Anthropic upstream test/history-edit.invariant.test.js runs (a thinking block's signature is its prefix, and
   drop_block drops the first stale block and every later one), the REAL loop, registry, host-shaped parker and fs.read.

   With the switch on (runAgentLoop batchedAgeing: true, which the host sets from STARNET_BATCHED_AGEING):
   1. A LONG RUN AGES IN BATCHES, NEVER PER TURN. A 48-request coding run on claude-opus-5-5 (16k-character reads,
      6k-character writes, an edit, a write that failed, a build log the registry parked before cutting it, words quoted
      from another session) sends request views whose old results and write arguments are stubs. The aged set changes
      only at a few batch requests, never on two requests in a row, never before the run's projection passes 24
      requests; each batch ages at least two tool turns and frees at least 60,000 characters, everything eligible behind
      the newest four tool turns, and nothing inside them. Between batches every request is append-only.
   2. THE TRANSCRIPT IS UNCHANGED. The run's messages and its last journal checkpoint carry every full body, and they
      equal the switch-off run's, message for message (thinking aside: the transcript keeps none).
   3. EVERY AGED STUB'S HANDLE READS BACK BYTE-IDENTICAL. Each stub on the wire (a result's, an argument's) names an
      fs.read call; through the REAL fs.read, paged the way a model pages, it returns the body it replaced (for the
      registry-parked log, the whole output the registry saved). Words quoted from another session, the failed write's
      arguments and short receipts never age.
   4. NO THINKING BLOCK IS DROPPED, through W1.7's request view: the binding upstream drops nothing on any request, and
      the last request replays exactly the blocks still bound (the one made before the first aged message, and every
      one made from the last batch on).
   5. RUNS PROJECTED AT 24 REQUESTS OR FEWER ARE UNTOUCHED: a 12-request run and a run whose turn ceiling is 24 send the
      same bytes with the switch on as the stack does with it off. So does a route the payback cannot price (a sign-in).
   With the switch off (absent, or false), every request body is byte-identical to the stack: test/fixtures/
   batched-ageing-golden.json holds the sha256 of every request body, recorded from 9896a5c44.
   6. ONE SWITCH: STARNET_BATCHED_AGEING is read in one place (sidecar/index.js), off unless set, and handed to the loop.
   7. A BATCH IS WEIGHED AND BILLED AT THE MODEL'S DOCUMENTED CACHE RATES (the W2.1 reviews). Every arm's real wire
      bodies are billed by test/helpers/anthropic-cache-sim.js (a read lands only where an earlier request wrote a
      breakpoint, at most 20 positions back from one of this request's; writes bill past the furthest hit), in input units
      at the documented 1.25 / 2 write and the MODEL's documented read, typed here from the claude-api skill and never
      read from the code under test: 0.05 on claude-opus-5-5, 0.025 on claude-fable-5-1 (red on c0560aaa6: its payback
      weighed the billing row's 0.10, which over-reports these reads; billed at the models' own reads its batches cost a
      fresh Fable 5.1 run 20.7% more than ageing off, and resumed Opus 5.5 runs 4.1% and 3.9% more):
        · every batch's payback weighed the model's documented read (its diagnostics line);
        · the fresh long run costs less with the switch on, on Opus 5.5 and on Fable 5.1;
        · a RESUMED conversation (a transcript seed and the run-context note before the newest message, as index.js
          runOnceCore sends it): at every batch request the documented cache reads exactly as far as the payback said,
          never less (red on 6f7b99465: its payback counted the re-write from the first aged message): on the default
          5-minute cache behind a 20,000-character conversation, the static prefix (the batch re-writes the whole
          conversation); on cache TTL 'mixed' behind a 200,000-character one, the pinned end of history (it re-writes
          from the note); and both runs cost no more with the switch on. Each batch bets on the run going on for the
          payback's horizon, and a run that ends sooner loses that batch's re-write: each batch's credited and actual
          remaining requests are printed;
        · NO BATCH WHEN RE-WRITING THE RESUMED CONVERSATION OUTWEIGHS THE SAVING: behind the 200,000-character
          conversation on the 5-minute cache no batch pays for that re-write within the payback's horizon (12 requests),
          so the switch-on run sends the switch-off bytes (red on 6f7b99465: three batches, 39.7% dearer than ageing
          off; with the re-write counted right but the projection the run's whole age: a batch at request 22 projected
          21 more requests, the run had 8, and it cost 9.5% more).
   8. EVERY ROUTE DECLARES WHERE ITS READS LAND (provider.cacheAnchors, which the payback asks): built by the real factory,
      on every request shape test/helpers/cache-ttl-bodies.js sends, in both TTL modes, each route's declaration matches
      the cache_control markers it puts on the wire (none on an automatic-prefix route; the static prefix anchored, only
      its stable part beside a tool anchor; the end of history pinned exactly when it says so).

   RE-RECORD the golden only on the base, or when a request body changes on purpose for a reason outside ageing (say so
   in that commit):  node test/batched-ageing.invariant.test.js --update */
'use strict';
// hermetic: no operator switch from the shell (the cache TTL tier, the tool anchor, a price override) reaches a request
for (const k of Object.keys(process.env)) if (/^(SKYNET|STARNET)_/.test(k)) delete process.env[k];
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');
const failopen = require('../sidecar/failopen.js');
const Provider = require('../sidecar/providers/provider.js');
const factory = require('../sidecar/providers/factory.js');
const HE = require('../sidecar/history-edit.js');
const { decomment } = require('./helpers/decomment.js');
const { sidecarSourceFiles } = require('./helpers/source.js');
const Sim = require('./helpers/anthropic-cache-sim.js');
const Bodies = require('./helpers/cache-ttl-bodies.js');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'batched-ageing-golden.json');
const NL = String.fromCharCode(10);
const RESULT_STUB = '[tool result elided at compaction — ';
const ARG_STUB = '[argument elided at compaction — ';
const line = obj => 'data: ' + JSON.stringify(obj);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const noCache = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
const hash = v => crypto.createHash('sha1').update(JSON.stringify(noCache(v))).digest('hex').slice(0, 16);
const prefixSig = (body, msgs, own) => 'sig:' + hash({ system: body.system || null, tools: body.tools || null, msgs, own });
// the same signatures from ONE running hash of a request's messages (sigAt(i, own) === prefixSig(body, messages[0..i), own),
// asked in rising i): prefixSig per block hashes the whole prefix again, which made a 48-request run cubic
function prefixSigs(body) {
  const run = crypto.createHash('sha1');
  run.update('{"system":' + JSON.stringify(noCache(body.system || null)) + ',"tools":' + JSON.stringify(noCache(body.tools || null)) + ',"msgs":[');
  let k = 0;
  return (i, own) => {
    for (; k < i; k++) run.update((k ? ',' : '') + JSON.stringify(noCache(body.messages[k])));
    const h = run.copy();
    h.update('],"own":' + JSON.stringify(noCache(own)) + '}');
    return 'sig:' + h.digest('hex').slice(0, 16);
  };
}
const fn = (name, props) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: props || {} } } });
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };

/* ---------------------------------------------------------------- the binding upstream (as history-edit.invariant) */
function bindingServer(script) {
  const posts = [];
  const minted = new Map();
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    const body = JSON.parse(init.body);
    const n = posts.length + 1;
    const rec = { n, body, raw: sha(init.body), dropped: 0, replayed: [] };
    posts.push(rec);
    const th = body.thinking || null;
    const drop = !!(th && th.block_binding && th.block_binding.prefix_mismatch_behavior === 'drop_block');
    const transformations = [];
    const sigAt = prefixSigs(body);
    let dropping = false;
    for (let i = 0; i < body.messages.length; i++) {
      const m = body.messages[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (b.type !== 'thinking') continue;
        rec.replayed.push(minted.get(b.signature) || 0);
        if (!dropping && b.signature === sigAt(i, m.content.slice(0, j))) continue;
        if (!drop) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.' + i + '.content.' + j + ': Invalid `signature` in `thinking` block.' } }), { status: 400 });
        dropping = true;
        transformations.push({ type: 'thinking_dropped', path: 'messages.' + i + '.content.' + j, reason: 'prefix_binding_mismatch' });
      }
    }
    rec.dropped = transformations.length;
    const content = script(n, body);
    const ev = [{ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 0 }, input_transformations: transformations.length ? transformations : undefined } }];
    const own = [];
    let toolUse = false;
    content.forEach((c, idx) => {
      if (c.type === 'thinking') {
        const sig = sigAt(body.messages.length, own.slice());
        minted.set(sig, n);
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '', signature: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'signature_delta', signature: sig } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'thinking', thinking: '', signature: sig });
      } else if (c.type === 'text') {
        ev.push({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: c.text } }, { type: 'content_block_stop', index: idx });
        own.push({ type: 'text', text: c.text });
      } else {
        toolUse = true;
        const id = 'toolu_' + n + '_' + idx;
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
// The wire as a flat list of non-thinking blocks (system + tools first): an append-only request extends the previous list.
function flat(body) {
  const out = [JSON.stringify(noCache({ system: body.system || null, tools: body.tools || null }))];
  for (const m of body.messages) {
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    for (const b of parts) if (b.type !== 'thinking' && b.type !== 'redacted_thinking') out.push(m.role + ':' + JSON.stringify(noCache(b)));
  }
  return out;
}
const editedRequests = posts => posts.filter((p, k) => k > 0 && (() => { const a = flat(posts[k - 1].body), b = flat(p.body); return a.some((x, i) => x !== b[i]); })()).map(p => p.n);

/* ---------------------------------------------------------------- the workspace: host-shaped parker + REAL fs.read */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ageing-'));
  fs.mkdirSync(path.join(root, 'a'), { recursive: true });
  const artifacts = makeOutputArtifacts({ fsp, fs, pathMod: path, root });
  const parks = [];
  let seq = 0;
  // the host parker's shape (index.js capCtx.parkOutput): quoted words are refused, the stem is tool-run-seq
  const parkOutput = async (content, meta) => {
    parks.push({ meta: meta || {}, chars: String(content).length });
    if (meta && Array.isArray(meta.quotedStreams) && meta.quotedStreams.length) return null;
    const stem = String((meta && meta.tool) || 'tool').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40) + '-r1-' + (seq++);
    return artifacts.park('a', stem, content);
  };
  const reg = makeRegistry();
  const fsTools = makeFsTools({ fsp, pathMod: path, root, rg: false });
  if (typeof fsTools.register === 'function') fsTools.register(reg); else for (const t of Object.values(fsTools)) if (t && t.name) reg.register(t);
  return { root, parks, parkOutput, reg };
}
// THE MODEL'S READ-BACK (as history-edit.invariant): a stub's handle through the REAL fs.read, following its next: pages
async function readBack(reg, ctx, call) {
  const m = /^fs\.read (\{.*\})$/.exec(call);
  if (!m) return { ok: false, text: '', pages: 0 };
  let args = JSON.parse(m[1]);
  const file = args.path;
  let text = '', pages = 0;
  for (;;) {
    const r = await reg.dispatch({ name: 'fs.read', args, argsRaw: JSON.stringify(args) }, ctx);
    pages++;
    if (!r || !r.ok) return { ok: false, text, pages };
    const s = String(r.content);
    const next = /\n\[showing characters \d+-\d+ of \d+[^\]\n]*; next: fs\.read (\{[^\n]*\})\]$/.exec(s);
    const a = next ? JSON.parse(next[1]) : null;
    if (a && a.path === file && pages < 200) { text += s.slice(0, next.index); args = a; continue; }
    const end = /\n\[showing characters \d+-\d+ of \d+; end of file\]$/.exec(s);
    text += end ? s.slice(0, end.index) : s;
    return { ok: true, text, pages };
  }
}

/* ---------------------------------------------------------------- the long coding run */
const READ_CHARS = 16000;
const BUILD = filler('BUILD', 40000) + 'BUILD FAILED: 3 errors' + NL;
const thinkTool = (name, input) => [{ type: 'thinking' }, { type: 'tool_use', name, input: input || {} }];
const thinkText = [{ type: 'thinking' }, { type: 'text', text: 'All done.' }];
// request n's reply: tool calls until `total`, then the final answer
const codingScript = total => n => {
  if (n >= total) return thinkText;
  if (n === 4) return thinkTool('build_log', {});
  if (n === 5) return thinkTool('recall', {});
  if (n === 7) return thinkTool('fs_write', { path: 'locked.txt', content: filler('LOCKED', 6000) });   // refused: never ages
  if (n === 10) return thinkTool('fs_edit', { path: 'out9.js', find: filler('FIND#10', 1500), replace: filler('REPLACE#10', 2500) });
  if (n % 3 === 0) return thinkTool('fs_write', { path: 'out' + n + '.js', content: filler('WRITE#' + n, 6000) });
  return thinkTool('fs_read', { path: 'src' + n + '.js' });
};
const WIRE_TOOLS = [fn('fs_read', { path: { type: 'string' } }), fn('fs_write', { path: { type: 'string' }, content: { type: 'string' } }),
  fn('fs_edit', { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }), fn('build_log'), fn('recall')];

/* A RESUMED CONVERSATION, as index.js runOnceCore sends one: the thread's transcript (user and assistant text, which no
   batch ever ages: the run did not produce it), then the run-context note before the newest message */
const SEED = { pairs: 20, chars: 10000 }, SEED_SMALL = { pairs: 2, chars: 10000 };
function seedOf(s) {
  const out = [];
  for (let k = 0; k < s.pairs; k++) out.push({ role: 'user', content: filler('EARLIER ASK ' + k, s.chars / 4) }, { role: 'assistant', content: filler('EARLIER REPLY ' + k, s.chars * 3 / 4) });
  return out.concat([{ role: 'system', content: Provider.runContextNote('[TASK BRIEF] do the task') }]);
}

async function runCoding(o) {
  // the cache TTL tier a run's anchors ask for (cache-ttl.js reads it per request): 'mixed' pins the end of history
  if (o.ttl) process.env.SKYNET_ANTHROPIC_CACHE_TTL = o.ttl;
  try { return await runCodingNow(o); } finally { if (o.ttl) delete process.env.SKYNET_ANTHROPIC_CACHE_TTL; }
}
async function runCodingNow(o) {
  const ws = makeWorkspace();
  const up = bindingServer(codingScript(o.total));
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_read', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async a => ({ content: filler('READ ' + a.path, READ_CHARS), summary: 'read' }) });
  reg.register({ impact: 'none', name: 'fs_write', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    run: async a => (a.path === 'locked.txt' ? { content: 'locked.txt is read-only', isError: true, summary: 'refused' } : { content: 'Wrote ' + String(a.content).length + ' chars to ' + a.path, summary: 'wrote' }) });
  reg.register({ impact: 'none', name: 'fs_edit', schema: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } }, run: async a => ({ content: 'Edited ' + a.path + ': 1 replacement', summary: 'edited' }) });
  reg.register({ impact: 'none', name: 'build_log', schema: { type: 'object' }, run: async () => ({ content: BUILD.slice(0, 3000) + NL + '[exit 1, output truncated]', fullContent: BUILD, summary: 'exit 1' }) });
  reg.register({ impact: 'none', name: 'recall', schema: { type: 'object' }, run: async () => ({ content: filler('QUOTED', READ_CHARS), quotedStreams: ['stream-2'], summary: 'recalled' }) });
  const provider = makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' });
  const capCtx = { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', parkOutput: ws.parkOutput, outputMax: () => 27000 };
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  let checkpoint = null;
  const loopOpts = {
    messages: [{ role: 'system', content: 'You are a station agent.' }].concat(o.seed ? seedOf(o.seed) : [], [{ role: 'user', content: 'do the task' }]),
    provider, emit: makeEmitter(bus, () => {}), cost: makeCostEngine({ priceOf: o.priceOf || provider.priceOf }),
    model: o.model || 'claude-opus-5-5', agentId: 'a', runId: 'r', tools: WIRE_TOOLS,
    // the host's context manager (index.js ctxMgr) at a window this run never nears: no fold or micro tier mixes in
    context: makeContext({ contextLimit: 2000000, compactAt: 0.65, keepTailTurns: 1 }), summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }),
    limits: Object.assign({}, o.limits || {}), dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx,
    onCheckpoint: ({ messages }) => { checkpoint = JSON.parse(JSON.stringify(messages)); },
    sleep: async () => {}, random: () => 0.5
  };
  if (o.ageing !== undefined) loopOpts.batchedAgeing = o.ageing;
  // each batch's diagnostics line (failopen prints a tag's first five: the tally restarts per run), for the payback's numbers
  failopen.resetForTests();
  const notes = [];
  const warn = console.warn;
  console.warn = (...a) => { const s = a.map(String).join(' '); if (s.indexOf('loop.historyEdit.aged') >= 0) notes.push(s); return warn.apply(console, a); };
  try {
    const res = await runAgentLoop(loopOpts);
    return { res, up, seq, checkpoint, ws, capCtx, notes, batches: failopen.counts()['loop.historyEdit.aged'] || 0 };
  } catch (e) { fs.rmSync(ws.root, { recursive: true, force: true }); throw e; } finally { console.warn = warn; }
}
/* WHERE A BATCH'S PAYBACK SAID THE NEXT READ LANDS, as a position of the request it went out on (anthropic-cache-sim
   positions): the message it counted the re-write from (its diagnostics line: "re-written from message N"; a planner that
   names none counted from the first aged message) mapped onto the wire of a seeded run (0 the system prompt, 1..2P the
   transcript, 2P+1 the run-context note): the end of the static prefix, the block before the note, or the block before
   the first stub. */
function claimedFloor(note, body, seedPairs) {
  const from = Number((/re-written from message (\d+)/.exec(note) || /batched ageing from message (\d+)/.exec(note) || [])[1]);
  const P = Sim.positionsOf(body);
  const firstMsg = P.findIndex(p => /^(user|assistant):/.test(p.text));
  const notePos = P.findIndex(p => p.text.indexOf('"text":"' + Provider.RUN_CONTEXT_OPEN) >= 0);
  const firstStub = P.findIndex(p => p.text.indexOf(RESULT_STUB) >= 0 || p.text.indexOf(ARG_STUB) >= 0);
  if (from <= 1) return { from, pos: firstMsg - 1 };
  if (from === 2 * seedPairs + 1) return { from, pos: notePos - 1 };
  return { from, pos: firstStub - 1 };
}
const hashes = run => run.up.posts.map(p => p.raw);
const CASES = {
  long: { total: 48 },                                  // 47 tool turns + the answer: projected well past 24
  short: { total: 12 },                                 // 11 tool turns + the answer: projected at 22 at most
  ceiling: { total: 40, limits: { maxIters: 24 } }      // a 24-turn ceiling (and its grace turn): never projected past 24
};

/* ---------------------------------------------------------------- what the wire says */
// every tool turn on the wire, in order: { at (request message index), calls: [{ id, name, input }], results: { id: text } }
function turnsOf(body) {
  const out = [];
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input }));
      if (calls.length) out.push({ at: i, calls, results: {} });
    }
    if (m.role === 'user' && Array.isArray(m.content) && out.length) {
      for (const b of m.content) if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map(p => p.text || '').join('') : '');
        out[out.length - 1].results[b.tool_use_id] = text;
      }
    }
  }
  return out;
}
// the stubs a request carries: key 'r:<id>' (a result) or 'a:<id>:<field>' (an argument) -> stub text
function stubsOf(body) {
  const out = new Map();
  for (const t of turnsOf(body)) {
    for (const [id, text] of Object.entries(t.results)) if (text.indexOf(RESULT_STUB) === 0) out.set('r:' + id, text);
    for (const c of t.calls) for (const [k, v] of Object.entries(c.input || {})) if (typeof v === 'string' && v.indexOf(ARG_STUB) === 0) out.set('a:' + c.id + ':' + k, v);
  }
  return out;
}
const handleOf = stub => { const m = /read it with (fs\.read \{[^\n]*?\})\](?:\n|$)/.exec(stub); return m ? m[1] : null; };
const withoutThinking = msgs => JSON.parse(JSON.stringify(msgs, (k, v) => (k === 'reasoning' ? undefined : v)));

/* ---------------------------------------------------------------- 8. what each route declares, against its wire */
const ANTHROPIC_SSE = [{ type: 'message_start', message: { id: 'm', usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }].map(line).join(NL + NL) + NL + NL;
const CHAT_SSE = line({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + NL + NL + 'data: [DONE]' + NL + NL;
// the routes test/helpers/cache-ttl-bodies.js builds, plus the non-Claude ones a run can take through the same adapters
const DECL_ROUTES = Object.assign({}, Bodies.ROUTES, {
  'anthropic-no-tool-anchor': { provider: 'anthropic', model: 'claude-sonnet-5-5', opts: {}, env: { STARNET_ANTHROPIC_TOOL_ANCHOR: '0' } },
  'managed-gpt': { provider: 'starnet', model: 'openai/gpt-5.5', opts: { baseUrl: 'http://127.0.0.1:9/v1' } },
  openai: { provider: 'openai', model: 'gpt-5.5', opts: {} }
});
// one request through the REAL factory's adapter: { provider (its cacheAnchors), body (what it handed fetch) }
async function sendThrough(r, req) {
  const posts = [];
  const f = async (url, init) => {
    if (String((init && init.method) || 'GET').toUpperCase() !== 'POST') return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    posts.push(String(init && init.body));
    return new Response(/\/messages$/.test(String(url)) ? ANTHROPIC_SSE : CHAT_SSE, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const p = factory.selectProvider(Object.assign({ provider: r.provider, key: 'k', fetch: f }, r.opts));
  try { for await (const _ of p.stream(Object.assign({ preStreamRetries: 0 }, req))) { /* drain */ } } catch (_) { /* the body went out */ }
  return { p, body: posts.length ? JSON.parse(posts[0]) : null };
}
// the prompt in render order: { where: 'tool' | 'system' | 'msg', cc, text }
function wireBlocks(body) {
  const out = [];
  for (const t of (Array.isArray(body.tools) ? body.tools : [])) out.push({ where: 'tool', cc: t.cache_control || null });
  if (Array.isArray(body.system)) for (const b of body.system) out.push({ where: 'system', cc: b.cache_control || null, text: b.text });
  else if (typeof body.system === 'string' && body.system) out.push({ where: 'system', cc: null, text: body.system });
  let leading = true;
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    if (!m || m.role !== 'system') leading = false;
    const where = leading ? 'system' : 'msg';
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    if (!parts.length) out.push({ where, cc: null, text: '' });
    for (const b of parts) out.push({ where, cc: (b && b.cache_control) || null, text: b && typeof b.text === 'string' ? b.text : '' });
  }
  return out;
}
// what is wrong with a route's declaration for one request, given the wire it sent (an empty list: they agree)
function declProblems(tag, decl, req, body, mode) {
  if (decl === undefined) return [tag + ': the provider has no cacheAnchors (the payback cannot tell where its reads land)'];
  const blocks = wireBlocks(body);
  const anchored = blocks.filter(b => b.cc);
  if (decl === null) return anchored.length ? [tag + ': declares automatic prefix caching (null) but sent ' + anchored.length + ' cache_control marker(s)'] : [];
  const out = [];
  if (!anchored.length) out.push(tag + ': declares breakpoints but sent none');
  if (decl.history !== (mode === 'mixed')) out.push(tag + ': declares history ' + decl.history + ' in mode ' + mode);
  const sys = blocks.filter(b => b.where === 'system');
  const stable = typeof req.cacheSystemPrefix === 'string' ? req.cacheSystemPrefix.trim() : '';
  const floor = HE.readFloor(req.messages, req.messages.length, { anchors: decl, isHistoryEnd: Provider.isRunContextNote, stable });
  let lead = 0;
  while (lead < req.messages.length && req.messages[lead].role === 'system' && !Provider.isRunContextNote(req.messages[lead])) lead++;
  // the system prompt's own anchors matter when the read lands there (with the end of history pinned, it lands later)
  if (sys.length && floor.from === lead) {
    // the static prefix: a read can land on its end (with 'prefix' beside a tool anchor, on its stable part only)
    const unanchoredTail = [];
    for (let i = sys.length - 1; i >= 0 && !sys[i].cc; i--) unanchoredTail.unshift(sys[i].text);
    const wireTail = unanchoredTail.join('');
    const declTail = floor.systemTail ? String(floor.systemTail.content) : '';
    // never fewer re-written bytes than the wire leaves unanchored; exactly those on a request with tools (the only kind a
    // batch follows: without tools the native adapter anchors a split system whole, and the payback over-counts its tail)
    if (!declTail.endsWith(wireTail) || (Array.isArray(req.tools) && req.tools.length && wireTail !== declTail)) {
      out.push(tag + ': the unanchored end of the system prompt on the wire (' + JSON.stringify(wireTail.slice(0, 60)) + ') is not the one declared (' + JSON.stringify(declTail.slice(0, 60)) + ')');
    }
    if (!sys.some(b => b.cc)) out.push(tag + ': no system block anchored');
  }
  // the end of history: pinned (1h, on the last block before the newest run-context note) exactly when declared
  const note = blocks.findIndex(b => b.where === 'msg' && b.text.indexOf(Provider.RUN_CONTEXT_OPEN) === 0);
  const before = note > 0 && blocks[note - 1].where === 'msg' ? blocks[note - 1] : null;
  if (before && decl.history && !(before.cc && before.cc.ttl === '1h')) out.push(tag + ': declares the end of history pinned, but the block before the note carries ' + JSON.stringify(before.cc));
  if (before && !decl.history && Array.isArray(req.messages) && req.messages[req.messages.length - 1].role === 'tool' && before.cc) out.push(tag + ': declares no pinned end of history, but a later iteration still anchors the block before the note');
  return out;
}

(async () => {
  if (process.argv.includes('--update')) {
    const cases = {};
    for (const [name, c] of Object.entries(CASES)) {
      const run = await runCoding(c);
      fs.rmSync(run.ws.root, { recursive: true, force: true });
      cases[name] = hashes(run);
    }
    let at = 'unknown';
    try { at = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch (_) { /* not a git tree */ }
    fs.writeFileSync(GOLDEN, JSON.stringify({
      about: 'sha256 of every request body test/batched-ageing.invariant.test.js sends with batched ageing OFF (the stack). Re-record (--update) only on the base, or when a request body changes on purpose for a reason outside ageing, and say so in that commit.',
      recordedAt: at, cases
    }, null, 1) + '\n');
    console.log('batched-ageing golden recorded at ' + at + ': ' + Object.entries(cases).map(([k, v]) => k + ' ' + v.length).join(', '));
    process.exit(0);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).cases;
  const toClean = [];
  try {
    // ================= switch OFF: byte-identical to the stack =================
    const off = await runCoding(Object.assign({}, CASES.long)); toClean.push(off.ws.root);
    A.eq(off.res.reason, 'done', 'off: the long run finishes');
    A.eq(hashes(off), golden.long, 'off (switch absent): every request body is byte-identical to the stack (' + off.up.posts.length + ' requests)');
    const offFalse = await runCoding(Object.assign({ ageing: false }, CASES.long)); toClean.push(offFalse.ws.root);
    A.eq(hashes(offFalse), golden.long, 'off (switch false): every request body is byte-identical to the stack');
    A.eq(off.batches + offFalse.batches, 0, 'off: no batch ran');
    {   // the upstream's running-hash signatures are the whole-prefix hash, block for block (the last request's 47 turns)
      const b = off.up.posts[off.up.posts.length - 1].body, sigAt = prefixSigs(b), pairs = [];
      b.messages.forEach((m, i) => { if (m.role === 'assistant' && Array.isArray(m.content)) m.content.forEach((x, j) => { if (x.type === 'thinking') pairs.push([sigAt(i, m.content.slice(0, j)), prefixSig(b, b.messages.slice(0, i), m.content.slice(0, j)), x.signature]); }); });
      A.ok(pairs.length === CASES.long.total - 1 && pairs.every(([x, y, z]) => x === y && y === z), 'upstream: the running-hash signatures equal the whole-prefix hash and every replayed block matches (' + pairs.length + ' blocks)');
    }

    // ================= switch ON: the long run ages in batches =================
    const on = await runCoding(Object.assign({ ageing: true }, CASES.long)); toClean.push(on.ws.root);
    const posts = on.up.posts;
    A.eq(on.res.reason, 'done', 'on: the long run finishes');
    A.eq(posts.length, CASES.long.total, 'on: every turn went out (no 400, no rescue round-trip)');
    const edited = editedRequests(posts);
    A.ok(edited.length >= 2, 'on: the long run sends aged views in at least two batches (edited requests: ' + JSON.stringify(edited) + ')');
    A.eq(on.batches, edited.length, 'on: every batch reached the wire, and nothing else edited the prefix (batches ' + on.batches + ')');
    A.ok(edited.every((n, k) => k === 0 || n - edited[k - 1] >= 2), 'on: never on two requests in a row (never per turn): ' + JSON.stringify(edited));
    A.ok(edited.every(n => n > 13), 'on: nothing ages before the run is projected past 24 requests (13 made, as many again)');

    // the aged set request by request: it changes only at a batch, only grows, and each batch is a whole one
    const original = new Map();   // key -> the text a stub replaced, from the transcript (the switch-on run's own messages)
    const callOf = new Map(), resultOf = new Map();
    for (const m of on.res.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callOf.set(c.id, { name: c.function.name, args: JSON.parse(c.function.arguments || '{}') });
      if (m.role === 'tool') resultOf.set(m.tool_call_id, m);
    }
    for (const [id, m] of resultOf) original.set('r:' + id, String(m.content));
    for (const [id, c] of callOf) for (const [k, v] of Object.entries(c.args)) if (typeof v === 'string') original.set('a:' + id + ':' + k, v);
    // what may age, by the run's own facts: a body that would shrink to half or less, a handle that can exist (the quoted
    // recall result never: its words never become a file), and an argument only of a write that succeeded
    const okCall = id => { const r = resultOf.get(id); return !!r && String(r.content).indexOf('ERROR') !== 0; };
    const eligible = key => {
      const [kind, id, field] = key.split(':');
      const c = callOf.get(id);
      if (!c || c.name === 'recall') return false;
      const text = original.get(key) || '';
      if (kind === 'r') return text.length > 2000;
      return /^fs_(write|edit)$/.test(c.name) && okCall(id) && /^(content|find|replace)$/.test(field) && text.length > 1000;
    };
    let prev = new Map(), batchesSeen = 0;
    for (const p of posts) {
      const now = stubsOf(p.body);
      const added = [...now.keys()].filter(k => !prev.has(k));
      const gone = [...prev.keys()].filter(k => !now.has(k) || now.get(k) !== prev.get(k));
      A.eq(gone, [], 'request ' + p.n + ': an aged stub stays exactly as it was (never re-aged, never un-aged)');
      if (added.length) {
        batchesSeen++;
        A.ok(edited.indexOf(p.n) >= 0, 'request ' + p.n + ': stubs appear only on a batch request');
        const turns = turnsOf(p.body);
        const keepFrom = turns.length - 4;   // the newest four tool turns ride whole
        const turnOf = key => turns.findIndex(t => t.calls.some(c => c.id === key.split(':')[1]));
        A.ok(added.every(k => turnOf(k) >= 0 && turnOf(k) < keepFrom), 'request ' + p.n + ': a batch ages nothing inside the newest four tool turns');
        A.ok(new Set(added.map(turnOf)).size >= 2, 'request ' + p.n + ': a batch ages at least two tool turns (' + new Set(added.map(turnOf)).size + ')');
        const freed = added.reduce((s, k) => s + (original.get(k) || '').length - now.get(k).length, 0);
        A.ok(freed >= 60000, 'request ' + p.n + ': a batch frees at least 60,000 characters (' + freed + ')');
        const left = [];
        turns.slice(0, Math.max(0, keepFrom)).forEach(t => {
          for (const id of Object.keys(t.results)) if (eligible('r:' + id) && !now.has('r:' + id)) left.push('r:' + id);
          for (const c of t.calls) for (const k of Object.keys(c.input || {})) if (eligible('a:' + c.id + ':' + k) && !now.has('a:' + c.id + ':' + k)) left.push('a:' + c.id + ':' + k);
        });
        A.eq(left, [], 'request ' + p.n + ': a batch ages everything eligible behind the newest four tool turns');
      }
      A.ok([...now.keys()].every(eligible), 'request ' + p.n + ': only eligible bodies are aged (never quoted words, a failed write, a short receipt)');
      prev = now;
    }
    A.eq(batchesSeen, edited.length, 'on: each edited request is a batch that added stubs (' + batchesSeen + ')');

    // ---- 2. the transcript is unchanged ----
    const full = JSON.stringify(on.res.messages);
    A.ok(full.indexOf(RESULT_STUB) < 0 && full.indexOf(ARG_STUB) < 0, 'transcript: the run\'s messages carry no stub (every full body stays)');
    A.eq(withoutThinking(on.res.messages), withoutThinking(off.res.messages), 'transcript: the switch-on run\'s messages equal the switch-off run\'s, message for message');
    const cp = JSON.stringify(on.checkpoint || []);
    const firstRead = [...callOf].find(([, c]) => c.args.path === 'src1.js');
    A.ok(!!on.checkpoint && cp.indexOf(RESULT_STUB) < 0 && cp.indexOf(ARG_STUB) < 0 && !!firstRead
      && on.checkpoint.some(m => m.role === 'tool' && m.tool_call_id === firstRead[0] && m.content === original.get('r:' + firstRead[0]) && m.content.length >= READ_CHARS),
    'transcript: the last journal checkpoint carries the full bodies (the oldest read included)');

    // ---- 3. every aged stub's handle reads back byte-identical ----
    const last = posts[posts.length - 1];
    const stubs = stubsOf(last.body);
    let read = 0, args = 0, parked = 0;
    for (const [key, stub] of stubs) {
      const call = handleOf(stub);
      A.ok(!!call, key + ': the stub names an fs.read handle (' + stub.slice(0, 160) + ')');
      if (!call) continue;
      const back = await readBack(on.ws.reg, on.capCtx, call);
      const id = key.split(':')[1];
      const want = (key.indexOf('r:') === 0 && callOf.get(id) && callOf.get(id).name === 'build_log') ? BUILD : original.get(key);
      A.ok(back.ok && back.text === want, key + ': its handle reads back BYTE-IDENTICAL (' + back.text.length + ' vs ' + (want || '').length + ' chars, ' + back.pages + ' page(s))');
      if (key.indexOf('a:') === 0) args++; else if (want === BUILD) parked++; else read++;
    }
    A.ok(read >= 8 && args >= 4 && parked === 1, 'handles: the read results, the write and edit arguments and the registry-parked log all came back (' + read + ' results, ' + args + ' arguments, ' + parked + ' parked)');
    const recallId = [...callOf].find(([, c]) => c.name === 'recall')[0];
    const lockedId = [...callOf].find(([, c]) => c.args.path === 'locked.txt')[0];
    A.ok(!stubs.has('r:' + recallId) && !stubs.has('a:' + lockedId + ':content'), 'never aged: the quoted recall result and the refused write\'s content ride whole');
    const quotedParks = on.ws.parks.filter(p => Array.isArray(p.meta.quotedStreams) && p.meta.quotedStreams.length);
    A.eq(quotedParks.length, 0, 'the parker is never asked to save quoted words');

    // ---- 4. no thinking block is dropped ----
    A.eq(posts.map(p => p.dropped), posts.map(() => 0), 'thinking: NO block dropped on any request (per-request drops)');
    // with no batch every block is still bound: 1 .. 29
    const want = edited.length ? [1] : [];
    for (let k = edited.length ? edited[edited.length - 1] : 1; k < posts.length; k++) want.push(k);
    A.eq(last.replayed, want, 'thinking: the last request replays exactly the blocks still bound (block 1, made before the first aged message, and every block from the last batch on)');

    // ================= 5. runs projected at 24 requests or fewer, and an unpriced route, are untouched =================
    const short = await runCoding(Object.assign({ ageing: true }, CASES.short)); toClean.push(short.ws.root);
    A.eq(short.res.reason, 'done', 'short: the 12-request run finishes');
    A.eq(hashes(short), golden.short, 'short: a 12-request run sends the stack\'s bytes with the switch on (' + short.up.posts.length + ' requests)');
    const capped = await runCoding(Object.assign({ ageing: true }, CASES.ceiling)); toClean.push(capped.ws.root);
    A.eq(hashes(capped), golden.ceiling, 'ceiling: a run whose turn ceiling is 24 sends the stack\'s bytes with the switch on (' + capped.up.posts.length + ' requests)');
    const unpriced = await runCoding(Object.assign({ ageing: true, priceOf: () => null }, CASES.long)); toClean.push(unpriced.ws.root);
    A.eq(hashes(unpriced), golden.long, 'unpriced: a route the payback cannot price (a sign-in, a local model) is never aged');
    A.eq(short.batches + capped.batches + unpriced.batches, 0, 'short, ceiling, unpriced: no batch ran');

    // ================= 6. one switch =================
    // every sidecar file through the source helper (index.js first); the code, not the comments that name the switch
    const code = sidecarSourceFiles().map(f => ({ rel: f.rel, text: decomment(f.text) }));
    const readers = code.filter(f => /BATCHED_AGEING/.test(f.text)).map(f => f.rel);
    A.eq(readers, ['sidecar/index.js'], 'switch: STARNET_BATCHED_AGEING is read in one place');
    const idx = code[0].text;
    A.ok(/batchedAgeing:\s*\/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('BATCHED_AGEING'\)/.test(idx), 'switch: the host hands the loop batchedAgeing from ENV(\'BATCHED_AGEING\'), off unless 1/true/yes/on');

    // ================= 7. a batch never costs more than ageing off, at the model's documented cache rates =================
    // THE DOCUMENTED READS, typed from the claude-api skill (shared/prompt-caching.md:144, shared/model-migration.md:1695
    // and :2040: "0.025x on Claude Fable 5.1 ... 0.05x on Claude Opus 5.5"), never read from the code under test: a bill at
    // the rate the payback weighed would certify whatever rate it weighed (the W2.1 review: 0.10, the billing row's)
    const DOC_READ = { 'claude-opus-5-5': 0.05, 'claude-fable-5-1': 0.025 };
    const bill = (run, model) => Sim.priceRun(run.up.posts.map(p => p.body), DOC_READ[model || 'claude-opus-5-5']);
    const vs = (a, b) => Math.round(a.inputEq) + ' vs ' + Math.round(b.inputEq) + ' input units, ' + (100 * (a.inputEq - b.inputEq) / b.inputEq).toFixed(1) + '%';
    // what each batch's payback weighed, from its diagnostics line ("... x read 0.05 against ...")
    const weighedReads = run => run.notes.map(s => Number((/ freed x read ([\d.]+)/.exec(s) || [])[1]));
    const credited = run => run.notes.map(s => Number((/= (\d+) requests credited/.exec(s) || [])[1]));
    const betLine = (run, edited) => 'batches at requests ' + JSON.stringify(edited) + ', each crediting ' + JSON.stringify(credited(run)) + ' more requests (the run had '
      + JSON.stringify(edited.map(n => run.up.posts.length - n)) + ' more)';
    const billLines = [];
    A.eq(weighedReads(on), on.notes.map(() => DOC_READ['claude-opus-5-5']), 'documented rates: every batch of the Opus 5.5 run weighed its documented 0.05 read (' + JSON.stringify(weighedReads(on)) + ')');
    const billOff = bill(off), billOn = bill(on);
    A.ok(billOn.inputEq < billOff.inputEq, 'documented cache, fresh run on Opus 5.5 (read 0.05): on costs less than off (' + vs(billOn, billOff) + ', ' + on.batches + ' batches)');
    billLines.push('fresh run (5m), claude-opus-5-5 at read 0.05, ' + posts.length + ' requests: on vs off ' + vs(billOn, billOff) + '; ' + betLine(on, edited));
    // THE CHEAPEST DOCUMENTED READ: Fable 5.1 at 0.025 (the payback credits a quarter of a 0.10 read)
    const fabOff = await runCoding(Object.assign({ model: 'claude-fable-5-1' }, CASES.long)); toClean.push(fabOff.ws.root);
    const fabOn = await runCoding(Object.assign({ ageing: true, model: 'claude-fable-5-1' }, CASES.long)); toClean.push(fabOn.ws.root);
    const billFabOff = bill(fabOff, 'claude-fable-5-1'), billFabOn = bill(fabOn, 'claude-fable-5-1');
    A.eq([fabOff.res.reason, fabOn.res.reason, fabOn.up.posts.map(p => p.dropped).reduce((a, b) => a + b, 0)], ['done', 'done', 0], 'Fable 5.1: both runs finish, no thinking block dropped');
    A.ok(fabOn.batches >= 1 && weighedReads(fabOn).every(r => r === DOC_READ['claude-fable-5-1']), 'documented rates: every batch of the Fable 5.1 run weighed its documented 0.025 read (' + JSON.stringify(weighedReads(fabOn)) + ')');
    A.ok(billFabOn.inputEq <= billFabOff.inputEq, 'documented cache, fresh run on Fable 5.1 (read 0.025): on costs no more than off (' + vs(billFabOn, billFabOff) + ', ' + fabOn.batches + ' batch(es))');
    billLines.push('fresh run (5m), claude-fable-5-1 at read 0.025, ' + fabOn.up.posts.length + ' requests: on vs off ' + vs(billFabOn, billFabOff) + '; ' + betLine(fabOn, editedRequests(fabOn.up.posts)));
    // T: at every batch request of a resumed run, the documented cache reads exactly as far as the payback said it would
    // (never less: a re-write it did not count): on the 5-minute cache the static prefix, behind a conversation short
    // enough for a batch to pay (SEED_SMALL); on 'mixed' the pinned end of history, behind the long one (SEED); and both
    // runs cost no more with the switch on (6f7b99465, and T counted right with R the run's whole age: batches at
    // requests 18, 24 and 30 of 30, +2.0% on 'mixed'; c0560aaa6, weighed at 0.10 and billed at Opus 5.5's own read:
    // +4.1% on the 5-minute cache)
    const floorsMatch = (run, pairs) => {
      const edited = editedRequests(run.up.posts);
      const billed = bill(run);
      const rows = edited.map((n, k) => { const c = claimedFloor(run.notes[k] || '', run.up.posts[n - 1].body, pairs); return { n, from: c.from, said: c.pos, read: billed.perRequest[n - 1].hit }; });
      return { ok: edited.length === run.batches && run.notes.length === run.batches && rows.every(r => r.said >= 0 && r.read === r.said), rows, billed, edited };
    };
    for (const [ttl, seed] of [['5m', SEED_SMALL], ['mixed', SEED]]) {
      const tag = 'resumed ' + (seed.pairs * seed.chars) + ' characters (' + ttl + ')';
      const tOff = await runCoding(Object.assign({ seed, ttl }, CASES.long)); toClean.push(tOff.ws.root);
      const tOn = await runCoding(Object.assign({ ageing: true, seed, ttl }, CASES.long)); toClean.push(tOn.ws.root);
      A.eq([tOff.res.reason, tOn.res.reason, tOff.up.posts.length, tOn.up.posts.length], ['done', 'done', CASES.long.total, CASES.long.total], tag + ': both runs finish, every turn went out');
      const f = floorsMatch(tOn, seed.pairs);
      A.ok(tOn.batches >= 1 && f.ok, tag + ': every batch counted its re-write from where the documented cache\'s read lands ('
        + JSON.stringify(f.rows) + '; re-written from ' + (ttl === 'mixed' ? 'the note, message ' + (2 * seed.pairs + 1) : 'the system prompt, message 1') + ')');
      A.ok(f.rows.every(r => r.from === (ttl === 'mixed' ? 2 * seed.pairs + 1 : 1)), tag + ': ' + (ttl === 'mixed' ? 'the end of history is read back: the resumed conversation is never re-written' : 'the resumed conversation is counted in the re-write'));
      A.eq(tOn.up.posts.map(p => p.dropped), tOn.up.posts.map(() => 0), tag + ': no thinking block dropped');
      A.eq(weighedReads(tOn), tOn.notes.map(() => DOC_READ['claude-opus-5-5']), tag + ': every batch weighed Opus 5.5\'s documented 0.05 read');
      const billOffR = bill(tOff);
      A.ok(f.billed.inputEq <= billOffR.inputEq, tag + ': on costs no more than off at Opus 5.5\'s 0.05 read (' + vs(f.billed, billOffR) + ')');
      billLines.push(tag + ', ' + CASES.long.total + ' requests: on vs off ' + vs(f.billed, billOffR) + '; ' + betLine(tOn, f.edited));
    }
    // NO BATCH WHEN RE-WRITING THE RESUMED CONVERSATION OUTWEIGHS THE SAVING: behind the 200,000-character conversation on
    // the 5-minute cache no batch pays for re-writing it within the horizon (12 requests), so the switch-on run sends the
    // switch-off bytes (6f7b99465 counted the re-write from the first aged message: three batches, 39.7% dearer than off;
    // with T counted right but R the run's whole age, a batch at request 22 projected 21 more requests, the run had 8, and
    // cost 9.5% more than off)
    const bigOff = await runCoding(Object.assign({ seed: SEED }, CASES.long)); toClean.push(bigOff.ws.root);
    const bigOn = await runCoding(Object.assign({ ageing: true, seed: SEED }, CASES.long)); toClean.push(bigOn.ws.root);
    const billBigOff = bill(bigOff), billBigOn = bill(bigOn);
    A.ok(billBigOn.inputEq <= billBigOff.inputEq, 'documented cache, a 200,000-character resumed conversation on the 5-minute cache: on costs no more than off (' + vs(billBigOn, billBigOff) + ', ' + bigOn.batches + ' batch(es))');
    A.eq([bigOn.batches, hashes(bigOn).length === CASES.long.total && hashes(bigOn).every((h, k) => h === hashes(bigOff)[k])], [0, true], 'resumed 200,000 characters (5m): no batch: every request body is the switch-off one');
    billLines.push('resumed 200000 characters (5m): on vs off ' + vs(billBigOn, billBigOff) + ' (' + bigOn.batches + ' batches)');
    for (const l of billLines) console.log('  [bill] ' + l);

    // ================= 8. every route declares where its reads land, and its wire agrees =================
    const declIssues = [];
    let checked = 0;
    const seen = {};
    for (const mode of ['5m', 'mixed']) {
      for (const [route, r] of Object.entries(DECL_ROUTES)) {
        for (const name of Object.keys(Bodies.CASES)) {
          if (name === 'never-reread') continue;   // a fold's extraction: never re-read, never aged
          process.env.SKYNET_ANTHROPIC_CACHE_TTL = mode;
          for (const [k, v] of Object.entries(r.env || {})) process.env[k] = v;
          try {
            const req = Bodies.CASES[name](r.model);
            const sent = await sendThrough(r, req);
            const decl = typeof sent.p.cacheAnchors === 'function' ? sent.p.cacheAnchors(r.model) : undefined;
            seen[route + '/' + mode] = decl === undefined ? 'missing' : JSON.stringify(decl);
            if (!sent.body) { declIssues.push(route + '/' + name + '/' + mode + ': no request went out'); continue; }
            declIssues.push(...declProblems(route + '/' + name + '/' + mode, decl, req, sent.body, mode));
            checked++;
          } finally {
            delete process.env.SKYNET_ANTHROPIC_CACHE_TTL;
            for (const k of Object.keys(r.env || {})) delete process.env[k];
          }
        }
      }
    }
    A.eq(declIssues, [], 'declarations: on every route, request shape and TTL mode, provider.cacheAnchors matches the cache_control on the wire (' + checked + ' requests)');
    A.eq(seen, {
      'anthropic/5m': '{"history":false,"system":"prefix"}', 'openrouter/5m': '{"history":false,"system":"all"}', 'managed/5m': '{"history":false,"system":"all"}', 'openrouter-gpt/5m': 'null',
      'anthropic-no-tool-anchor/5m': '{"history":false,"system":"all"}', 'managed-gpt/5m': 'null', 'openai/5m': 'null',
      'anthropic/mixed': '{"history":true,"system":"prefix"}', 'openrouter/mixed': '{"history":true,"system":"all"}', 'managed/mixed': '{"history":true,"system":"all"}', 'openrouter-gpt/mixed': 'null',
      'anthropic-no-tool-anchor/mixed': '{"history":true,"system":"all"}', 'managed-gpt/mixed': 'null', 'openai/mixed': 'null'
    }, 'declarations: Claude routes anchor (the native one beside its tool anchor on the stable prefix only), every other route is an automatic prefix');
  } finally {
    for (const r of toClean) fs.rmSync(r, { recursive: true, force: true });
  }
  A.report('batched-ageing.invariant.test');
})().catch(e => { console.log('FAIL: batched-ageing.invariant.test threw -- ' + (e && e.stack || e)); process.exit(1); });
