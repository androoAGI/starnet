/* node test/history-edit.invariant.test.js — W1.7 CONTEXT GROUNDWORK: one history-edit resolver, four invariants.

   Red on e316231d7, green on the lane. Hermetic: no network, no paid call, a temp workspace, fake upstreams only.

   1. NO THINKING BLOCK IS DROPPED AFTER AN EDIT. A fake Anthropic server enforces preserved-thinking binding the way
      provider.anthropic.thinking-binding.test.js does: a block's signature is its conversation prefix (system, tools,
      every earlier message, every earlier block of its own turn; cache_control ignored), and drop_block drops the first
      mismatched block AND every later one, reported in input_transformations. The REAL loop on claude-opus-5-5 goes
      through four history edits — a tool.search reveal, a stale screen capture aged out, the micro tier, a paid fold —
      and keeps working after each. Every request must report zero dropped blocks; the edit must really have happened
      on the wire; the blocks produced after it must still be replayed, and so must the blocks before it that the edit
      left valid (nothing the API would keep is stripped).
   2. EVERY ELISION STUB NAMES A HANDLE THAT READS BACK BYTE-IDENTICAL. The REAL loop + registry + fs tools + the host
      parker shape (output-artifacts.js, stems like index.js capCtx.parkOutput) fold old results through the micro
      tier. The agent edits the file it read before the elision, the file is rewritten again after it, and the run's
      window narrows (a fallback to a smaller model) before the handles are followed. Each stub's fs.read call, run
      through the REAL fs.read tool and paged the way a model pages (fs.read's own next: trailers), returns the elided
      body exactly — or, for a result the registry parked before cutting it, the tool's full output. No handle names
      the source a result was read from. Words quoted from another session are never parked, and the micro tier's
      measuring pass leaves no file behind.
   3. A FOLD'S OWN REQUEST WRITES NO CACHE: the REAL compaction summarizer through the REAL anthropic adapter sends no
      cache_control anywhere (the run loop's own requests still anchor theirs).
   4. A CUT OUTPUT KEEPS ITS HEAD AND ITS TAIL: shell.exec, verify.run and an MCP result over the 64k cap keep the end
      of the output (where the error is) inside the same budget. */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const A = require('./_assert.js');
const events = require('../shared/events.js');
const { makeEmitter } = require('../shared/emitter.js');
const { makeClock } = require('../shared/clock-rng.js');
const { makeCostEngine } = require('../sidecar/cost.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeAnthropicProvider } = require('../sidecar/providers/anthropic.js');
const { makeReplayProvider } = require('../sidecar/providers/replay.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');
const { makeSummarizer } = require('../sidecar/compaction-summarizer.js');
const { makeShellTool } = require('../sidecar/tools/builtin/shell.js');
const { makeVerifyTool } = require('../sidecar/tools/builtin/verify.js');
const { makeMcpToolDef, RESULT_MAX_CHARS } = require('../sidecar/mcp/translate.js');
const { echoMarker } = require('./helpers/shell-marker.js');

const NL = String.fromCharCode(10);
const line = obj => 'data: ' + JSON.stringify(obj);
const noCache = v => JSON.parse(JSON.stringify(v, (k, x) => (k === 'cache_control' ? undefined : x)));
const hash = v => crypto.createHash('sha1').update(JSON.stringify(noCache(v))).digest('hex').slice(0, 16);
const prefixSig = (body, msgs, own) => 'sig:' + hash({ system: body.system || null, tools: body.tools || null, msgs, own });
const fn = (name, props) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: props || {} } } });
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };

/* ---------------------------------------------------------------- 1. the binding upstream */
// script(n, body) -> the content of response n: {type:'thinking'} | {type:'text', text} | {type:'tool_use', name, input}.
// Every request records: dropped (input_transformations), and `replayed` = the response number that minted each thinking
// block it carried, in wire order (so a test can say WHICH blocks came back).
function bindingServer(script, usageFor) {
  const posts = [];
  const minted = new Map();
  const fetch = async (url, init) => {
    if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
    const body = JSON.parse(init.body);
    const n = posts.length + 1;
    const rec = { n, body, dropped: 0, replayed: [] };
    posts.push(rec);
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
        if (!dropping && b.signature === prefixSig(body, body.messages.slice(0, i), m.content.slice(0, j))) continue;
        if (!drop) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.' + i + '.content.' + j + ': Invalid `signature` in `thinking` block. The block is bound to a different conversation.' } }), { status: 400 });
        dropping = true;
        transformations.push({ type: 'thinking_block_dropped', reason: 'prefix_binding_mismatch', location: 'messages.' + i + '.content.' + j });
      }
    }
    rec.dropped = transformations.length;
    const content = script(n, body);
    const ev = [{ type: 'message_start', message: { usage: { input_tokens: usageFor ? usageFor(n) : 100, output_tokens: 0 }, input_transformations: transformations.length ? transformations : undefined } }];
    const own = [];
    let toolUse = false;
    content.forEach((c, idx) => {
      if (c.type === 'thinking') {
        const sig = prefixSig(body, body.messages, own.slice());
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
  return { fetch, posts };
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
// the requests whose wire is NOT an append-only extension of the one before (a history edit reached the wire)
const editedRequests = posts => posts.filter((p, k) => k > 0 && (() => { const a = flat(posts[k - 1].body), b = flat(p.body); return a.some((x, i) => x !== b[i]); })()).map(p => p.n);

const thinkTool = (name, input) => [{ type: 'thinking' }, { type: 'tool_use', name, input: input || {} }];
const thinkText = [{ type: 'thinking' }, { type: 'text', text: 'All done.' }];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function runBound(o) {
  const up = bindingServer(o.script, o.usageFor);
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_read', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async a => ({ content: 'file ' + a.path, summary: 'read' }) });
  reg.register({ impact: 'none', name: 'tool_search', schema: { type: 'object', properties: { query: { type: 'string' } } }, run: async () => ({ content: 'revealed web_fetch', summary: 'found', control: { revealTools: ['web_fetch'] } }) });
  let shot = 0;
  reg.register({ impact: 'none', name: 'snap', schema: { type: 'object' }, run: async () => ({ content: 'captured screen ' + (++shot), summary: 'shot', images: [{ mime: 'image/png', data: PNG }] }) });
  let k = 0;
  reg.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => filler('BODY#' + (++k), 19000) });
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  const res = await runAgentLoop({
    messages: [{ role: 'system', content: 'You are a station agent.' }, { role: 'user', content: 'do the task' }],
    provider: makeAnthropicProvider({ fetch: up.fetch, key: 'k', reasoningEffort: 'medium' }), emit: makeEmitter(bus, () => {}),
    cost: makeCostEngine({ priceOf: () => ({ in: 1, out: 1 }) }), model: 'claude-opus-5-5', agentId: 'a', runId: 'r',
    tools: [fn('fs_read', { path: { type: 'string' } }), fn('tool_search', { query: { type: 'string' } }), fn('snap'), fn('noop')],
    deferredTools: [fn('web_fetch', { url: { type: 'string' } })], toolImages: !!o.toolImages,
    context: o.context || null, summarize: o.summarize || null, microCompaction: o.microCompaction,
    limits: Object.assign({ maxIters: 10 }, o.limits || {}), dispatch: (c, ctx) => reg.dispatch(c, ctx),
    capCtx: { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office' }, sleep: async () => {}, random: () => 0.5
  });
  return { res, up, seq };
}
function checkBound(label, run, want) {
  const { res, up, seq } = run;
  A.eq(res.reason, 'done', label + ': the run finishes');
  A.eq(up.posts.length, want.requests, label + ': every turn went out (no 400, no rescue round-trip)');
  A.ok(editedRequests(up.posts).indexOf(want.editAt) >= 0, label + ': the edit really reached the wire at request ' + want.editAt + ' (edited: ' + JSON.stringify(editedRequests(up.posts)) + ')');
  if (want.compact) A.ok(seq.some(e => e.name === 'agent.compact' && e.payload.reason === want.compact), label + ': the ' + want.compact + ' fold ran');
  A.eq(up.posts.map(p => p.dropped), up.posts.map(() => 0), label + ': NO thinking block dropped on any request (per-request drops)');
  const last = up.posts[up.posts.length - 1];
  A.eq(last.replayed, want.lastReplays, label + ': the last request replays exactly the blocks still bound — those the edit left valid and every one produced after it');
}

/* ---------------------------------------------------------------- 2. the parker + fs tools */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-histedit-'));
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
  return { root, parks, parkOutput };
}
// THE MODEL'S READ-BACK: run a stub's handle through the REAL fs.read under the run's window as it is NOW, and follow
// fs.read's own paging (the next: trailer, same file only) the way a model does; the pages' text reassembled.
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
    if (a && a.path === file && pages < 100) { text += s.slice(0, next.index); args = a; continue; }
    const end = /\n\[showing characters \d+-\d+ of \d+; end of file\]$/.exec(s);
    text += end ? s.slice(0, end.index) : s;
    return { ok: true, text, pages };
  }
}

(async () => {
  // ================= 1. thinking: four edits, zero drops, nothing bound is lost =================
  {
    // (a) tool.search reveal: `tools` grows at request 3 -> every earlier block is unbound (edit at 0)
    const reveal = await runBound({ script: n => n === 1 ? thinkTool('fs_read', { path: 'a' }) : n === 2 ? thinkTool('tool_search', { query: 'web' }) : n === 3 ? thinkTool('fs_read', { path: 'b' }) : thinkText });
    checkBound('reveal', reveal, { requests: 4, editAt: 3, lastReplays: [3] });
    A.ok(JSON.stringify(reveal.up.posts[0].body).indexOf('cache_control') >= 0, 'a run-loop request still anchors its prompt cache (only fold requests stop writing)');

    // (b) screenshot eviction (keep 1): capture 1 becomes a placeholder at request 3 -> block 1 (before it) stays bound
    const shots = await runBound({ toolImages: true, limits: { toolImageKeep: 1 }, script: n => n <= 2 ? thinkTool('snap') : n === 3 ? thinkTool('fs_read', { path: 'a' }) : thinkText });
    checkBound('screenshot eviction', shots, { requests: 4, editAt: 3, lastReplays: [1, 3] });

    // (c) the micro tier: results 1-2 are elided before request 4 -> block 1 (before them) stays bound, 2-3 do not
    const usage = n => (n === 3 ? 14000 : 2000);
    const ctx = () => makeContext({ contextLimit: 20000, compactAt: 0.65, keepTailTurns: 1 });
    let paid = 0;
    const micro = await runBound({ context: ctx(), usageFor: usage, summarize: async () => { paid++; return { summary: 'S', usd: 0, tokens: 0 }; },
      script: n => n <= 4 ? thinkTool('noop') : thinkText });
    checkBound('micro tier', micro, { requests: 5, editAt: 4, compact: 'micro', lastReplays: [1, 4] });
    A.eq(paid, 0, 'micro tier: it cleared the threshold alone (no paid fold mixed in)');

    // (d) a paid fold: turns 1-2 fold into a note before request 4 -> the kept tail's block 3 is unbound, block 4 is not
    const fold = await runBound({ context: ctx(), usageFor: usage, microCompaction: false, summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }),
      script: n => n <= 4 ? thinkTool('noop') : thinkText });
    checkBound('paid fold', fold, { requests: 5, editAt: 4, compact: 'context', lastReplays: [4] });
  }

  // ================= 2. every elision stub names a handle that reads back byte-identical =================
  {
    const ws = makeWorkspace();
    try {
      const notes = filler('NOTE', 20000);
      const notesPath = path.join(ws.root, 'a', 'notes.txt');
      fs.writeFileSync(notesPath, notes);
      const reg = makeRegistry();
      const fsTools = makeFsTools({ fsp, pathMod: path, root: ws.root, rg: false });
      if (typeof fsTools.register === 'function') fsTools.register(reg); else for (const t of Object.values(fsTools)) if (t && t.name) reg.register(t);
      const buildFull = filler('BUILD', 60000) + 'BUILD FAILED: 3 errors' + NL;
      reg.register({ impact: 'none', name: 'build_log', schema: { type: 'object' }, run: async () => ({ content: buildFull.slice(0, 3000) + NL + '[exit 1, output truncated]', fullContent: buildFull, summary: 'exit 1' }) });
      reg.register({ impact: 'none', name: 'recall', schema: { type: 'object' }, run: async () => ({ content: filler('QUOTED', 20000), quotedStreams: ['stream-2'], summary: 'recalled' }) });
      let k = 0;
      reg.register({ impact: 'none', name: 'noop', schema: { type: 'object' }, run: async () => filler('NOOP#' + (++k), 20000) });
      // the run's window-scaled budget (index.js capCtx.outputMax, a live thunk): wide while the run works, narrowed
      // afterwards the way a fallback to a smaller model narrows it, before the handles are followed
      let windowChars = 27000;
      const capCtx = { agentId: 'a', canUse: () => ({ ok: true }), canRun: () => ({ ok: true }), parkOutput: ws.parkOutput, outputMax: () => windowChars };
      const seen = new Map();
      const call = (id, name, args, p) => [{ type: 'tool_start', index: 0, id, name }, { type: 'tool_args', index: 0, chunk: JSON.stringify(args || {}) },
        { type: 'usage', usage: { prompt_tokens: p, completion_tokens: 1, total_tokens: p + 1 } }, { type: 'done', finishReason: 'tool_calls' }];
      // b1/b2 are fs.read results cut AFTER the tool ran: b1 = the run-wide budget's clip (index.js boundToolResult), b2 =
      // the registry's cap with a parker that failed. Their stubs must give back the cut bodies, exactly as the model saw them.
      const cutAfter = (id, r) => id === 'b1' ? Object.assign({}, r, { content: r.content.slice(0, 3000) + NL + NL + '[Tool result receipt: read. This run reached its context allowance.]', outputBounded: true })
        : id === 'b2' ? Object.assign({}, r, { content: r.content.slice(0, 2500) + NL + NL + '[... 17500 characters removed by the host output cap. The end of the output follows ...]' })
        : r;
      // e1: the agent edits the file it read (the usual coding flow) before the micro tier elides the old reads
      const edit = { path: 'notes.txt', find: 'NOTE line 7 lorem', replace: 'NOTE line 7 EDITED lorem' };
      const provider = makeReplayProvider({ turns: [call('b1', 'fs.read', { path: 'notes.txt' }, 2000), call('b2', 'fs.read', { path: 'notes.txt' }, 2000),
        call('c1', 'fs.read', { path: 'notes.txt' }, 2000), call('c2', 'build_log', {}, 2000), call('c3', 'recall', {}, 2000),
        call('c4', 'noop', {}, 2000), call('e1', 'fs.edit', edit, 2000), call('c5', 'noop', {}, 30000), [{ type: 'text', delta: 'FINAL' }, { type: 'done', finishReason: 'stop' }]] });
      const bus = A.makeBus();
      const seq = A.collectBus(bus, events.names());
      const res = await runAgentLoop({ messages: [{ role: 'user', content: 'gather the facts' }], provider, emit: makeEmitter(bus, () => {}),
        cost: makeCostEngine({ priceOf: provider.priceOf }), model: 'replay/model', agentId: 'a', runId: 'r1', tools: reg.wireFormat(),
        dispatch: async (c, ctx) => { const r = cutAfter(c.id, await reg.dispatch(c, ctx)); seen.set(c.id, r); return r; }, capCtx,
        context: makeContext({ contextLimit: 40000, compactAt: 0.65, keepTailTurns: 1 }), summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }), limits: { maxIters: 12 } });
      A.eq(res.reason, 'done', 'stubs: the run finishes');
      A.ok(seen.get('e1') && seen.get('e1').ok && fs.readFileSync(notesPath, 'utf8') === notes.replace(edit.find, edit.replace), 'stubs: the agent edited notes.txt after reading it, before the elision');
      A.ok(seq.some(e => e.name === 'agent.compact' && e.payload.reason === 'micro' && e.payload.elided >= 6), 'stubs: the micro tier elided the older results');
      A.ok(seen.get('c2') && seen.get('c2').parkedPath, 'stubs: the registry parked build_log before cutting it (a dispatch-time handle exists)');
      const stubs = res.messages.filter(m => m.role === 'tool' && /^\[tool result elided at compaction/.test(String(m.content)));
      const ids = stubs.map(m => m.tool_call_id).sort();
      A.ok(['b1', 'b2', 'c1', 'c2', 'c3', 'c4'].every(id => ids.indexOf(id) >= 0) && ids.every(id => /^(b1|b2|c1|c2|c3|c4|e1)$/.test(id)), 'stubs: the six older results are stubs (and at most the edit receipt): ' + JSON.stringify(ids));
      // after the elision: the source is rewritten again, and the window narrows to 8,000 characters (a 7,400-char fs.read page)
      fs.writeFileSync(notesPath, 'notes.txt was rewritten after the elision' + NL);
      windowChars = 8000;
      let saved = 0, paged = 0;
      for (const m of stubs) {
        const id = m.tool_call_id;
        const first = String(m.content).split(NL)[0];
        const handle = /with (fs\.read \{.*\})\]$/.exec(first);
        if (id === 'c3') { A.ok(!handle && /re-run the tool for the full output\]$/.test(first), 'stubs: words quoted from another session get no saved copy (the old wording stands)'); continue; }
        A.ok(!!handle, 'stubs: ' + id + ' names an fs.read handle (' + first.slice(0, 200) + ')');
        if (!handle) continue;
        A.ok(first.indexOf('notes.txt') < 0, 'stubs: ' + id + "'s handle never names the source it was read from");
        const back = await readBack(reg, capCtx, handle[1]);
        const want = id === 'c2' ? buildFull : seen.get(id).content;
        A.ok(back.ok && back.text === want, 'stubs: ' + id + "'s handle reads back BYTE-IDENTICAL after the source changed and the window narrowed (" + back.text.length + ' vs ' + want.length + ' chars, ' + back.pages + ' page(s))');
        if (id === 'c1') A.ok(back.text === notes, 'stubs: the read made before the edit comes back as it was read, not as the file says now');
        if (back.pages > 1) paged++;
        if (id !== 'c2') { A.ok(/; the whole result is saved: read it with fs\.read/.test(first), 'stubs: ' + id + ' is saved whole at elision'); saved++; }
      }
      A.ok(paged >= 3, 'stubs: the big bodies (c1, c2, c4) came back over several fs.read pages and reassembled exactly (' + paged + ')');
      const elisionParks = ws.parks.filter(p => p.meta.reason === 'elided-at-compaction');
      A.ok(!elisionParks.some(p => Array.isArray(p.meta.quotedStreams) && p.meta.quotedStreams.length), 'stubs: the parker is never even asked to save quoted words');
      A.eq(elisionParks.length, saved, 'stubs: one park per saved stub — the measuring pass asked for none');
      const files = fs.readdirSync(path.join(ws.root, 'a', '.output'));
      A.eq(files.length, saved + 1, 'stubs: .output holds the saved stubs and the registry park of build_log, nothing else (' + files.length + ' files)');
    } finally { fs.rmSync(ws.root, { recursive: true, force: true }); }
  }

  // ================= 3. a fold's own request writes no cache =================
  {
    const posts = [];
    const fetch = async (url, init) => {
      if (!/\/messages$/.test(String(url))) return new Response('{"data":[]}', { status: 200 });
      posts.push(JSON.parse(init.body));
      const ev = [{ type: 'message_start', message: { usage: { input_tokens: 5000, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Completed' + NL + '- the work so far' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }, { type: 'message_stop' }];
      return new Response(ev.map(line).concat(['']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const provider = makeAnthropicProvider({ fetch, key: 'k', reasoningEffort: 'medium' });
    const summarize = makeSummarizer({ provider, model: 'claude-opus-5-5', cost: makeCostEngine({ priceOf: provider.priceOf }), summaryPrompt: () => 'Summarize the conversation so far.' });
    const older = [{ role: 'user', content: 'audit the logs' }];
    for (let i = 1; i <= 6; i++) {
      older.push({ role: 'assistant', content: '', tool_calls: [{ id: 't' + i, type: 'function', function: { name: 'fs_read', arguments: '{"path":"log' + i + '.txt"}' } }] });
      older.push({ role: 'tool', tool_call_id: 't' + i, content: filler('LOG' + i, 20000) });
    }
    const out = await summarize(older, '', {});
    A.ok(out && out.summary && !out.rejected, 'fold: the summarizer produced a summary');
    A.ok(posts.length >= 2, 'fold: a multi-chunk fold (' + posts.length + ' requests)');
    A.eq(posts.map(b => JSON.stringify(b).indexOf('cache_control') >= 0), posts.map(() => false), 'fold: NO summarizer request carries cache_control (nothing re-reads it)');
  }

  // ================= 4. head + tail at the same 64k =================
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-histedit-sh-'));
    try {
      const big = 'HEAD-START' + NL + filler('OUT', 150000) + 'TAIL-END: 3 tests failed' + NL;
      // a fake spawn that prints `big` and then what the real shell prints for shell.exec's marker
      const spawn = (cmd) => {
        let dataCb = null;
        return { pid: 1, kill() {}, stdout: { on(ev, f) { if (ev === 'data') dataCb = f; } }, stderr: { on() {} },
          on(ev, f) { if (ev === 'close') setTimeout(() => { if (dataCb) dataCb(Buffer.from(big + (/__SK_CWD/.test(cmd) ? NL + echoMarker(cmd, '', 1) : ''))); f(/__SK_CWD/.test(cmd) ? 0 : 1); }, 0); } };
      };
      const sh = makeShellTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: s => s }).execTool;
      const r = await sh.run({ cmd: 'echo build' }, { agentId: 'a1', runId: 'r1', callId: 'c1' });
      A.ok(r.content.indexOf('HEAD-START') === 0, 'shell: the head of the output is kept');
      A.ok(r.content.indexOf('TAIL-END: 3 tests failed') > 0, 'shell: the END of the output is kept (where the error is)');
      A.ok(/\[exit 1, output truncated to 64KB\]$/.test(r.content), 'shell: the exit receipt is still the last line');
      A.ok(r.content.length <= 64000 + 400, 'shell: inside the same 64k budget (' + r.content.length + ' chars)');
      A.ok(r.fullContent.indexOf(big.slice(0, 1000)) === 0 && r.fullContent.indexOf('TAIL-END') > 0, 'shell: the full output still crosses to the parker');

      const vt = makeVerifyTool({ spawn, fs, pathMod: path, root, clock: makeClock(0), redact: s => s }).verifyTool;
      const v = await vt.run({ cmd: 'npm test' }, { agentId: 'a1', runId: 'r1', callId: 'c2' });
      A.ok(v.content.indexOf('HEAD-START') > 0 && v.content.indexOf('TAIL-END: 3 tests failed') > 0, 'verify: head AND tail of the check output are kept');
      A.ok(v.content.length <= 64000 + 400, 'verify: inside the same 64k budget (' + v.content.length + ' chars)');

      const mcp = makeMcpToolDef({ connectorId: 'db', mcpTool: { name: 'query', inputSchema: { type: 'object' } }, call: () => Promise.resolve({ content: [{ type: 'text', text: big }] }) });
      const m = await mcp.run({}, {});
      A.ok(m.content.indexOf('HEAD-START') > 0 && m.content.indexOf('TAIL-END: 3 tests failed') > 0, 'mcp: head AND tail of an oversized result are kept');
      A.ok(m.content.length < RESULT_MAX_CHARS + 600, 'mcp: inside the same 64k cap plus its fence and hint (' + m.content.length + ' chars)');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }

  A.report('history-edit.invariant.test');
})().catch(e => { console.log('FAIL: history-edit.invariant.test threw -- ' + (e && e.stack || e)); process.exit(1); });
