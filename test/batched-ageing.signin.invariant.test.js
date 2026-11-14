/* node test/batched-ageing.signin.invariant.test.js — BATCHED AGEING ON A SIGN-IN ROUTE (cost lane 2026-11-14).

   Batched ageing (W2.1, sidecar/history-edit.js makeAgeing, STARNET_BATCHED_AGEING) weighs every batch with the route's
   cache rates, and an unpriced route has none: on a sign-in it never fired, so the ChatGPT sign-in, where plans run out,
   never aged. With STARNET_AGEING_SIGNIN on as well, a sign-in whose model the price table documents is weighed at
   that model's LIST cache rates as a proxy (cost.js signInCacheRates, prices.js signInCacheRatesOf): the list read
   (0.10x) and a write never under 1.25x.

   Red on 57c741da7 (the 0.15.2 candidate), green on the lane. Hermetic: no network, no paid call, no sign-in, a temp
   workspace; the REAL loop, registry, host-shaped parker, fs.read and Codex adapter (sidecar/providers/codex.js) over a
   scripted Responses upstream that reports the usage an automatic prefix cache would (cached_tokens = the longest
   prefix the request before it sent, item by item).

   1. OFF IS THE BASE, WHATEVER STARNET_BATCHED_AGEING IS. With the sign-in switch absent or false, a 48-request run on
      the Codex sign-in sends the bytes recorded from 57c741da7 (test/fixtures/batched-ageing-signin-golden.json: the
      sha256 of every request body), with batched ageing absent, off and on. The sign-in switch alone (batched ageing
      off) changes nothing either.
   2. ON, A LONG RUN AGES, WEIGHED BY PROXY. Both switches on: the same run sends aged views in batches, never on two
      requests in a row, never before it is projected past 24 requests. Every batch's note names the proxy and its
      rates (read 0.1, write 1.25), reports the characters it freed (equal to what left the wire) and a payback that
      holds (saving > re-write, the re-write counted from the first aged message: where this route's read stops, as
      the upstream's own cached_tokens confirm). Nothing else changes: the instructions, tools, model, effort and cache
      route of every request are the switch-off ones, and each input item is the switch-off item or its stub.
   3. STUBS KEEP WORKING HANDLES. Every stub on the last request names an fs.read call that returns, through the REAL
      fs.read, the exact body it replaced. The transcript and the journal checkpoint keep every full body.
   4. THE SAVING, MEASURED HERE (bytes before / after, and the run's own booked usage): fewer request bytes, and less
      plan weight at the list read (0.10x) and when every token counts the same (1.0x). Printed, never asserted: what
      the same batches do if the plan counted a cached token at 0.05x or at nothing.
   5. A SHORT RUN IS UNTOUCHED: a 12-request run and a run whose turn ceiling is 24 send the base bytes with both on.
   6. NOTHING ELSE UNPRICED AGES: a local model, a Claude sign-in (claude-cli stands down on purpose), another sign-in
      and an engine the host named no route for send the base bytes with both switches on.
   7. BILLING IS UNTOUCHED: the sign-in run books $0 on every record, the engine still has no cache rates and no price
      for the route, and a call without a provider cost still reconciles 'unpriced'.
   8. ONE RESOLVER, ONE SWITCH: STARNET_AGEING_SIGNIN is read in one place (sidecar/index.js), off unless set; the proxy
      rates come from one function (prices.js signInCacheRatesOf) through one engine method (cost.js signInCacheRates)
      that one call site asks (loop.js), and each of a run's engines is built with its route.

   RE-RECORD the golden only on the base, or when a Codex request body changes on purpose for a reason outside ageing
   (say so in that commit):  node test/batched-ageing.signin.invariant.test.js --update */
'use strict';
// hermetic: no operator switch from the shell reaches a request or a price
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
const prices = require('../sidecar/providers/prices.js');
const { runAgentLoop } = require('../sidecar/loop.js');
const { makeContext } = require('../sidecar/context.js');
const { makeRegistry } = require('../sidecar/tools/registry.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
const { makeOutputArtifacts } = require('../sidecar/output-artifacts.js');
const failopen = require('../sidecar/failopen.js');
const HE = require('../sidecar/history-edit.js');
const { decomment } = require('./helpers/decomment.js');
const { sidecarSourceFiles } = require('./helpers/source.js');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'batched-ageing-signin-golden.json');
const NL = String.fromCharCode(10);
const RESULT_STUB = '[tool result elided at compaction — ';
const ARG_STUB = '[argument elided at compaction — ';
const MODEL = 'gpt-5.5';
const line = obj => 'data: ' + JSON.stringify(obj);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const fn = (name, props) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: props || {} } } });
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };

/* ---------------------------------------------------------------- the scripted Codex upstream (the Responses wire) */
// a request as the backend's prompt cache sees it: the static prefix (instructions and tools), then each input item
const segsOf = body => [String(body.instructions || '') + '\u0000' + JSON.stringify(body.tools || null)].concat((body.input || []).map(it => JSON.stringify(it)));
function codexServer(script) {
  const posts = [];
  let prev = null;
  const fetch = async (url, init) => {
    if (String((init && init.method) || 'GET').toUpperCase() !== 'POST') return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const raw = String(init.body);
    const body = JSON.parse(raw);
    const n = posts.length + 1;
    // AUTOMATIC PREFIX CACHING: the longest prefix the request before this one sent is read, the rest is processed fresh
    const segs = segsOf(body);
    let k = 0, read = 0;
    if (prev) while (k < segs.length && k < prev.length && segs[k] === prev[k]) { read += segs[k].length; k++; }
    const total = segs.reduce((a, s) => a + s.length, 0);
    prev = segs;
    posts.push({ n, body, raw: sha(raw), bytes: Buffer.byteLength(raw, 'utf8'), route: (init.headers && init.headers.session_id) || '', total, read, hit: prev ? k : 0 });
    const usage = { input_tokens: Math.ceil(total / 4), output_tokens: 7, total_tokens: Math.ceil(total / 4) + 7, input_tokens_details: { cached_tokens: Math.floor(read / 4) } };
    const reply = script(n, body);
    const ev = reply.call
      ? [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_' + n, name: reply.call.name } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(reply.call.input || {}) },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_' + n } }]
      : [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
        { type: 'response.output_text.delta', output_index: 0, delta: reply.text },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } }];
    ev.push({ type: 'response.completed', response: { status: 'completed', usage } });
    return new Response(ev.map(line).concat(['data: [DONE]', '']).join(NL), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetch, posts };
}
// the requests whose prefix changed against the one before (an edit reached the wire)
const editedRequests = posts => posts.filter((p, k) => { if (!k) return false; const a = segsOf(posts[k - 1].body), b = segsOf(p.body); return a.some((x, i) => x !== b[i]); }).map(p => p.n);

/* ---------------------------------------------------------------- the workspace: host-shaped parker + REAL fs.read */
function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-ageing-signin-'));
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
// THE MODEL'S READ-BACK: a stub's handle through the REAL fs.read, following its next: pages
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

/* ---------------------------------------------------------------- the long coding run (as batched-ageing.invariant) */
const READ_CHARS = 16000;
const BUILD = filler('BUILD', 40000) + 'BUILD FAILED: 3 errors' + NL;
const call = (name, input) => ({ call: { name, input: input || {} } });
// request n's reply: tool calls until `total`, then the final answer
const codingScript = total => n => {
  if (n >= total) return { text: 'All done.' };
  if (n === 4) return call('build_log', {});
  if (n === 5) return call('recall', {});
  if (n === 7) return call('fs_write', { path: 'locked.txt', content: filler('LOCKED', 6000) });   // refused: never ages
  if (n === 10) return call('fs_edit', { path: 'out9.js', find: filler('FIND#10', 1500), replace: filler('REPLACE#10', 2500) });
  if (n % 3 === 0) return call('fs_write', { path: 'out' + n + '.js', content: filler('WRITE#' + n, 6000) });
  return call('fs_read', { path: 'src' + n + '.js' });
};
const WIRE_TOOLS = [fn('fs_read', { path: { type: 'string' } }), fn('fs_write', { path: { type: 'string' }, content: { type: 'string' } }),
  fn('fs_edit', { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }), fn('build_log'), fn('recall')];

/* o: { total, limits, ageing (the loop's batchedAgeing), signIn (its ageingSignIn), route (the route the host names the
   run's cost engine; default 'codex', null = it names none) } */
async function runCoding(o) {
  const ws = makeWorkspace();
  const up = codexServer(codingScript(o.total));
  const reg = makeRegistry();
  reg.register({ impact: 'none', name: 'fs_read', schema: { type: 'object', properties: { path: { type: 'string' } } }, run: async a => ({ content: filler('READ ' + a.path, READ_CHARS), summary: 'read' }) });
  reg.register({ impact: 'none', name: 'fs_write', schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
    run: async a => (a.path === 'locked.txt' ? { content: 'locked.txt is read-only', isError: true, summary: 'refused' } : { content: 'Wrote ' + String(a.content).length + ' chars to ' + a.path, summary: 'wrote' }) });
  reg.register({ impact: 'none', name: 'fs_edit', schema: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } }, run: async a => ({ content: 'Edited ' + a.path + ': 1 replacement', summary: 'edited' }) });
  reg.register({ impact: 'none', name: 'build_log', schema: { type: 'object' }, run: async () => ({ content: BUILD.slice(0, 3000) + NL + '[exit 1, output truncated]', fullContent: BUILD, summary: 'exit 1' }) });
  reg.register({ impact: 'none', name: 'recall', schema: { type: 'object' }, run: async () => ({ content: filler('QUOTED', READ_CHARS), quotedStreams: ['stream-2'], summary: 'recalled' }) });
  const provider = makeCodexProvider({ fetch: up.fetch, token: 'acc', reasoningEffort: 'low' });
  const capCtx = { canRun: () => true, canUse: () => ({ ok: true }), agentId: 'a', room: 'office', parkOutput: ws.parkOutput, outputMax: () => 27000 };
  const bus = A.makeBus();
  const seq = A.collectBus(bus, events.names());
  let checkpoint = null;
  const engineOpts = { priceOf: provider.priceOf };
  if (o.route !== null) engineOpts.route = o.route === undefined ? 'codex' : o.route;   // as index.js builds a run's engine
  const cost = makeCostEngine(engineOpts);
  const loopOpts = {
    messages: [{ role: 'system', content: 'You are a station agent.' }, { role: 'user', content: 'do the task' }],
    provider, emit: makeEmitter(bus, () => {}), cost, model: MODEL, agentId: 'a', runId: 'r', tools: WIRE_TOOLS,
    // the host's context manager (index.js ctxMgr) at a window this run never nears: no fold or micro tier mixes in
    context: makeContext({ contextLimit: 2000000, compactAt: 0.65, keepTailTurns: 1 }), summarize: async () => ({ summary: 'S', usd: 0, tokens: 0 }),
    limits: Object.assign({}, o.limits || {}), dispatch: (c, ctx) => reg.dispatch(c, ctx), capCtx,
    onCheckpoint: ({ messages }) => { checkpoint = JSON.parse(JSON.stringify(messages)); },
    sleep: async () => {}, random: () => 0.5
  };
  if (o.ageing !== undefined) loopOpts.batchedAgeing = o.ageing;
  if (o.signIn !== undefined) loopOpts.ageingSignIn = o.signIn;
  // each batch's diagnostics line. failopen prints a tag's first five and then every fiftieth, and this run has more
  // batches than five: the tally restarts at each line read here, so every batch prints (batches = the lines)
  failopen.resetForTests();
  const notes = [];
  const warn = console.warn;
  console.warn = (...a) => { const s = a.map(String).join(' '); if (s.indexOf('loop.historyEdit.aged') >= 0) { notes.push(s); failopen.resetForTests(); return undefined; } return warn.apply(console, a); };
  try {
    const res = await runAgentLoop(loopOpts);
    return { res, up, seq, checkpoint, ws, capCtx, cost, provider, notes, batches: notes.length };
  } catch (e) { fs.rmSync(ws.root, { recursive: true, force: true }); throw e; } finally { console.warn = warn; }
}
const hashes = run => run.up.posts.map(p => p.raw);
const CASES = {
  long: { total: 48 },                                  // 47 tool turns + the answer: projected well past 24
  short: { total: 12 },                                 // 11 tool turns + the answer: projected at 22 at most
  ceiling: { total: 40, limits: { maxIters: 24 } }      // a 24-turn ceiling (and its grace turn): never projected past 24
};

/* ---------------------------------------------------------------- what the wire says */
// what one input item carries that a stub can replace
const payloadOf = it => (it.type === 'function_call_output' ? String(it.output) : it.type === 'function_call' ? String(it.arguments) : JSON.stringify(it.content || ''));
// every tool turn on the wire, in order: { calls: [{ id, name, input }], results: { id: text } }
function turnsOf(body) {
  const out = [];
  let open = false;
  for (const it of body.input || []) {
    if (it.type === 'function_call') {
      if (!open) { out.push({ calls: [], results: {} }); open = true; }
      let input = {}; try { input = JSON.parse(it.arguments || '{}'); } catch (_) { input = {}; }
      out[out.length - 1].calls.push({ id: it.call_id, name: it.name, input });
    } else {
      open = false;
      if (it.type === 'function_call_output' && out.length) out[out.length - 1].results[it.call_id] = String(it.output);
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
// a batch's diagnostics line, parsed
const NOTE = /batched ageing from message (\d+): (\d+) tool result\(s\) and (\d+) write argument\(s\) left the request view \((\d+) characters; the run keeps every full body\); payback (\d+) > (\d+) = (\d+) requests credited x (\d+) freed x read ([\d.]+)( \(assumed\))? against (\d+) re-written from message (\d+) x \(write ([\d.]+) - read\) on (\S+?)(; SIGN-IN PROXY: [^\n]*)?$/;
function parseNote(s) {
  const m = NOTE.exec(String(s).trim());
  if (!m) return null;
  return { editAt: +m[1], results: +m[2], args: +m[3], freedChars: +m[4], saving: +m[5], rewrite: +m[6], credited: +m[7], freed: +m[8], read: +m[9], assumed: !!m[10], suffix: +m[11], from: +m[12], write: +m[13], model: m[14], proxy: m[15] || '' };
}
// the run's own booked usage (what a usage receipt keeps per call): uncached input and cache read, summed
function booked(run) {
  const calls = run.seq.filter(e => e.name === 'agent.cost' && e.payload && e.payload.reconciled === true && typeof e.payload.tokensIn === 'number');
  let uncached = 0, read = 0;
  for (const c of calls) { const r = Math.min(c.payload.cachedTokens || 0, c.payload.tokensIn || 0); read += r; uncached += (c.payload.tokensIn || 0) - r; }
  return { calls: calls.length, uncached, read };
}
const planWeight = (b, r) => b.uncached + b.read * r;
const pct = (on, off) => (100 * (off - on) / off).toFixed(1) + '%';

(async () => {
  if (process.argv.includes('--update')) {
    const cases = {};
    for (const [name, c] of Object.entries(CASES)) {
      const run = await runCoding(c);
      fs.rmSync(run.ws.root, { recursive: true, force: true });
      cases[name] = hashes(run);
    }
    let at = 'unknown';
    try { at = execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { /* not a git tree */ }
    if (process.env.GOLDEN_RECORDED_AT) at = String(process.env.GOLDEN_RECORDED_AT);   // recorded from an export of the base (no git there)
    fs.writeFileSync(GOLDEN, JSON.stringify({
      about: 'sha256 of every Codex (ChatGPT sign-in) request body test/batched-ageing.signin.invariant.test.js sends with no ageing switch set (the base). Re-record (--update) only on the base, or when a Codex request body changes on purpose for a reason outside ageing, and say so in that commit.',
      recordedAt: at, cases
    }, null, 1) + '\n');
    console.log('batched-ageing sign-in golden recorded at ' + at + ': ' + Object.entries(cases).map(([k, v]) => k + ' ' + v.length).join(', '));
    process.exit(0);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).cases;
  const toClean = [];
  try {
    // ================= THE PROXY (prices.js signInCacheRatesOf, cost.js signInCacheRates) =================
    /* THE LIST RATES, typed here from the price table's own source note (sidecar/providers/prices.js CACHE: "OpenAI:
       cached input is 0.10x list on every current model (gpt-5.x ...)", "None of these publish a separate write
       charge") and the planner's assumed write premium for a cached route that publishes nothing (1.25x), never read
       from the function under test. */
    const LIST = { read: 0.10, write: 1.00 }, FLOOR = 1.25;
    {
      const PROXY = { read: LIST.read, write: Math.max(LIST.write, FLOOR), published: true, proxy: true };
      const engine = (route, priceOf) => makeCostEngine(Object.assign({ priceOf: priceOf || (() => null) }, route === undefined ? {} : { route }));
      for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-5.6-sol', 'gpt-5']) {
        A.eq(engine('codex').signInCacheRates(id), PROXY, 'proxy: the ChatGPT sign-in\'s ' + id + ' is weighed at the list read 0.10x and a write of 1.25x, marked a proxy');
        A.eq(prices.signInCacheRatesOf('codex', id), { read: PROXY.read, write: PROXY.write }, 'proxy: prices.signInCacheRatesOf(codex, ' + id + ')');
      }
      A.eq(engine(' Codex ').signInCacheRates('openai/gpt-5.5'), PROXY, 'proxy: the route and the bare model id are matched as the documented-rate resolver matches them');
      const r = engine('codex').signInCacheRates(MODEL);
      A.ok(r.read <= prices.priceOf('openai', MODEL).cache.read && r.write >= prices.priceOf('openai', MODEL).cache.write && r.write >= HE.AGEING.ASSUMED_RATES.write,
        'proxy: never a dearer read nor a cheaper write than the priced OpenAI route weighs the same model with, and never under the assumed write (' + JSON.stringify(r) + ')');
      // only the gpt-5.x models the sign-in serves: nothing else has a documented rate here
      A.eq(['gpt-4o', 'gpt-50', 'o3', 'codex-mini-latest', 'claude-opus-5-5', '', null, undefined].map(id => engine('codex').signInCacheRates(id)), [null, null, null, null, null, null, null, null],
        'proxy: a model the table documents no sign-in rate for answers null (never ages)');
      // A CLAUDE SIGN-IN STANDS DOWN (claude-cli: every batch is a fresh child that re-writes the run at 2.0x)
      A.eq(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'opus', 'sonnet', 'gpt-5.5'].map(id => engine('claude-cli').signInCacheRates(id)), [null, null, null, null, null, null, null],
        'proxy: a Claude sign-in (claude-cli) has none, on purpose: it never ages');
      A.eq(['claude-code', 'claude-code-cli'].map(route => engine(route).signInCacheRates('claude-opus-5-5')), [null, null], 'proxy: nor under the route\'s other names');
      // every other unpriced route: another sign-in, a local model, a route the host did not name, a name that is no route
      A.eq(['grok', 'kimi', 'ollama', 'lmstudio', 'custom', 'openai', 'openrouter', 'starnet', '', 'constructor', '__proto__', 'toString'].map(route => engine(route).signInCacheRates(MODEL)),
        [null, null, null, null, null, null, null, null, null, null, null, null], 'proxy: Grok, Kimi, a local model and every other route have none');
      A.eq([engine(undefined).signInCacheRates(MODEL), makeCostEngine().signInCacheRates(MODEL), makeCostEngine({ priceOf: () => null, route: 42 }).signInCacheRates(MODEL)], [null, null, null], 'proxy: an engine the host named no route for has none');
      // a PRICED route is weighed by its own rates, never by a proxy
      const openai = id => prices.priceOf('openai', id);
      A.eq([engine('codex', openai).signInCacheRates(MODEL), engine('openai', openai).signInCacheRates(MODEL)], [null, null], 'proxy: a priced route has no proxy');
      A.eq(engine('openai', openai).cacheRates(MODEL), { read: 0.1, write: 1, published: true }, 'proxy: (the priced OpenAI route keeps its own rates: cacheRates is unchanged)');
      // BILLING NEVER SEES IT: the same engine has no cache rates, no price and no dollars for the route
      const codex = engine('codex');
      const usage = { prompt_tokens: 1000000, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 900000 } };
      A.eq(codex.cacheRates(MODEL), null, 'billing: the sign-in route still has no cache rates (unpriced)');
      A.eq([codex.reconcile(usage, MODEL).usd, codex.reconcile(usage, MODEL).costSource, codex.reconcile(usage, MODEL).unpriced, codex.reconcile(usage, MODEL).catalogPriced, codex.estimate(usage, MODEL).usd],
        [0, 'unpriced', true, false, 0], 'billing: a sign-in call still reconciles $0 and unpriced, with the proxy asked or not');
      A.eq(JSON.stringify(codex.reconcile(usage, MODEL)), JSON.stringify(engine(undefined).reconcile(usage, MODEL)), 'billing: naming the route changes nothing a reconcile returns');
      A.eq(Object.keys(codex.signInCacheRates(MODEL)).sort(), ['proxy', 'published', 'read', 'write'], 'proxy: it carries rates and the proxy mark, no price');
    }

    // ================= THE PLANNER CARRIES THE WORD, AND THE PROXY IS HARDER TO PASS THAN THE LIST =================
    {
      const run = n => {
        const list = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'do it' }];
        const origins = new Map();
        for (let k = 0; k < n; k++) {
          list.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + k, type: 'function', function: { name: 'fs_read', arguments: JSON.stringify({ path: 'f' + k }) } }] });
          const r = { role: 'tool', tool_call_id: 'c' + k, content: filler('R' + k, 25000) };
          list.push(r); origins.set(r, { parkedPath: null, parkMeta: {}, ok: true });
        }
        return { list, originOf: m => origins.get(m) || null };
      };
      const park = async () => ({ path: '.output/p.txt' });
      // a ruler that sizes a whole result 100, a stub 10, anything else 0: ten turns give F = 540, T = 460
      const measure = m => (m.role === 'tool' ? (String(m.content).indexOf(HE.ELIDED) === 0 ? 10 : 100) : 0);
      const proxyRates = () => makeCostEngine({ priceOf: () => null, route: 'codex' }).signInCacheRates(MODEL);
      const plan = (o) => { const r = run(10); return HE.makeAgeing({ originOf: r.originOf }).plan(r.list, Object.assign({ requests: 20, maxIters: Infinity, park, measure, holdsHistory: false, anchors: null }, o)); };
      const b = await plan({ rates: proxyRates });
      A.eq(b && [b.proxy, b.assumed, b.read, b.write, b.remaining, b.freed, b.suffix, Math.round(b.saving), Math.round(b.rewrite), b.from === b.editAt],
        [true, false, 0.1, 1.25, 12, 540, 460, 648, 529, true], 'planner: a sign-in batch is weighed 12 x 540 x 0.10 = 648 against 460 x (1.25 - 0.10) = 529, from the first aged message, and says its rates were a proxy');
      const priced = await plan({ rates: () => ({ read: 0.1, write: 1.25, published: true }) });
      A.eq(priced && priced.proxy, false, 'planner: a priced route\'s batch is no proxy');
      // R 8 (a 28-turn ceiling, 20 made): the list's own 1.00x write would pass (432 > 414); the proxy's 1.25x does not (432 < 529)
      A.eq([!!(await plan({ maxIters: 28, rates: () => ({ read: LIST.read, write: LIST.write, published: true }) })), await plan({ maxIters: 28, rates: proxyRates })], [true, null],
        'planner: the proxy is harder to pass than the list rates: 8 x 540 x 0.10 = 432 beats 460 x 0.90 = 414, not 460 x 1.15 = 529');
      A.eq(await plan({ rates: () => makeCostEngine({ priceOf: () => null, route: 'ollama' }).signInCacheRates(MODEL) }), null, 'planner: a local model has no rates and never ages');
      A.eq(await plan({ rates: () => makeCostEngine({ priceOf: () => null, route: 'claude-cli' }).signInCacheRates('claude-opus-5-5'), holdsHistory: true }), null, 'planner: a Claude sign-in has no rates and never ages');
    }

    // ================= 1. OFF IS THE BASE, WHATEVER BATCHED AGEING IS =================
    const off = await runCoding(Object.assign({}, CASES.long)); toClean.push(off.ws.root);
    A.eq(off.res.reason, 'done', 'off: the long run finishes');
    A.eq(hashes(off), golden.long, 'off (no switch): every Codex request body is byte-identical to the base (' + off.up.posts.length + ' requests)');
    const ageingOnly = await runCoding(Object.assign({ ageing: true }, CASES.long)); toClean.push(ageingOnly.ws.root);
    A.eq(hashes(ageingOnly), golden.long, 'off (batched ageing ON, sign-in switch absent): a sign-in route never ages: the base bytes');
    const ageingOnlyFalse = await runCoding(Object.assign({ ageing: true, signIn: false }, CASES.long)); toClean.push(ageingOnlyFalse.ws.root);
    A.eq(hashes(ageingOnlyFalse), golden.long, 'off (batched ageing ON, sign-in switch false): the base bytes');
    const signInOnly = await runCoding(Object.assign({ signIn: true }, CASES.long)); toClean.push(signInOnly.ws.root);
    A.eq(hashes(signInOnly), golden.long, 'the sign-in switch alone (batched ageing absent) does nothing: the base bytes');
    const signInOnlyFalse = await runCoding(Object.assign({ ageing: false, signIn: true }, CASES.long)); toClean.push(signInOnlyFalse.ws.root);
    A.eq(hashes(signInOnlyFalse), golden.long, 'the sign-in switch alone (batched ageing false) does nothing: the base bytes');
    A.eq(off.batches + ageingOnly.batches + ageingOnlyFalse.batches + signInOnly.batches + signInOnlyFalse.batches, 0, 'off: no batch ran');
    A.ok(off.up.posts.every(p => p.route && p.route === p.body.prompt_cache_key && p.route === off.up.posts[0].route), 'off: every request names the same cache route (session_id = prompt_cache_key)');

    // ================= 2. ON: THE LONG RUN AGES, WEIGHED BY PROXY =================
    const on = await runCoding(Object.assign({ ageing: true, signIn: true }, CASES.long)); toClean.push(on.ws.root);
    const posts = on.up.posts;
    A.eq(on.res.reason, 'done', 'on: the long run finishes');
    A.eq(posts.length, CASES.long.total, 'on: every turn went out');
    const edited = editedRequests(posts);
    A.ok(edited.length >= 2, 'on: the long run on the sign-in sends aged views in at least two batches (edited requests: ' + JSON.stringify(edited) + ')');
    A.eq(on.batches, edited.length, 'on: every batch reached the wire, and nothing else edited the prefix (batches ' + on.batches + ')');
    A.ok(edited.every((n, k) => k === 0 || n - edited[k - 1] >= 2), 'on: never on two requests in a row: ' + JSON.stringify(edited));
    A.ok(edited.every(n => n > 13), 'on: nothing ages before the run is projected past 24 requests (13 made, as many again)');
    // every batch says what it was weighed with, and its numbers hold
    const parsed = on.notes.map(parseNote);
    A.ok(parsed.length === on.batches && parsed.every(Boolean), 'on: every batch wrote its diagnostics line (' + on.notes.length + ' of ' + on.batches + '): ' + String(on.notes[0] || '').slice(0, 400));
    A.ok(on.notes.every(s => /; SIGN-IN PROXY: this route is a sign-in plan that publishes no cache weights, so the batch was weighed at the model's list cache rates \(the list read, a write of at least 1\.25x\), not at what the plan counts$/.test(String(s).trim())),
      'on: every batch\'s line says its rates were a sign-in proxy');
    A.eq(parsed.map(p => p && [p.read, p.write, p.assumed, p.model]), parsed.map(() => [0.1, 1.25, false, MODEL]), 'on: every batch was weighed at the list read 0.10 and a 1.25 write on ' + MODEL);
    A.ok(parsed.every(p => p && p.saving > p.rewrite && p.credited >= 1 && p.credited <= HE.AGEING.HORIZON && Math.abs(p.saving - p.credited * p.freed * p.read) <= p.credited && Math.abs(p.rewrite - p.suffix * (p.write - p.read)) <= 1),
      'on: every payback holds as reported: saving = requests credited (at most 12) x freed x read, above re-written x (write - read): ' + JSON.stringify(parsed.map(p => p && [p.saving, p.rewrite, p.credited, p.freed, p.suffix])));
    A.ok(parsed.every(p => p && p.from === p.editAt), 'on: the re-write is counted from the first aged message (an automatic-prefix route: the read reaches the edit)');
    // ...and that is where the upstream's cache read stopped on each batch request: the first stub's own item
    const firstStubSeg = body => 1 + (body.input || []).findIndex(it => payloadOf(it).indexOf(RESULT_STUB) === 0 || (it.type === 'function_call' && String(it.arguments).indexOf(ARG_STUB) >= 0));
    const firstNewStubSeg = (body, before) => 1 + (body.input || []).findIndex((it, i) => JSON.stringify(it) !== JSON.stringify((before.input || [])[i]));
    A.ok(edited.every(n => posts[n - 1].hit === firstNewStubSeg(posts[n - 1].body, posts[n - 2].body) && posts[n - 1].hit >= 1 && firstStubSeg(posts[n - 1].body) >= 1),
      'on: on each batch request the prefix cache read every item before the first newly aged one, and none after (cached_tokens stop at the edit): ' + JSON.stringify(edited.map(n => posts[n - 1].hit)));
    // the aged set request by request: it changes only at a batch, only grows; a batch is whole and frees what it says
    const original = new Map();   // key -> the text a stub replaced, from the transcript (the switch-on run's own messages)
    const callOf = new Map(), resultOf = new Map();
    for (const m of on.res.messages) {
      if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) callOf.set(c.id, { name: c.function.name, args: JSON.parse(c.function.arguments || '{}') });
      if (m.role === 'tool') resultOf.set(m.tool_call_id, m);
    }
    for (const [id, m] of resultOf) original.set('r:' + id, String(m.content));
    for (const [id, c] of callOf) for (const [k, v] of Object.entries(c.args)) if (typeof v === 'string') original.set('a:' + id + ':' + k, v);
    const okCall = id => { const r = resultOf.get(id); return !!r && String(r.content).indexOf('ERROR') !== 0; };
    const eligible = key => {
      const [kind, id, field] = key.split(':');
      const c = callOf.get(id);
      if (!c || c.name === 'recall') return false;
      const text = original.get(key) || '';
      if (kind === 'r') return text.length > 2000;
      return /^fs_(write|edit)$/.test(c.name) && okCall(id) && /^(content|find|replace)$/.test(field) && text.length > 1000;
    };
    // the characters ageing took off the wire at request n: the switch-off request's items against this one's
    const offPosts = off.up.posts;
    const takenOff = k => { const a = offPosts[k].body.input, b = posts[k].body.input; let d = 0; for (let i = 0; i < a.length; i++) d += payloadOf(a[i]).length - payloadOf(b[i]).length; return d; };
    let prev = new Map(), batchesSeen = 0, prevTaken = 0;
    for (let k = 0; k < posts.length; k++) {
      const p = posts[k];
      const now = stubsOf(p.body);
      const added = [...now.keys()].filter(x => !prev.has(x));
      const gone = [...prev.keys()].filter(x => !now.has(x) || now.get(x) !== prev.get(x));
      A.eq(gone, [], 'request ' + p.n + ': an aged stub stays exactly as it was (never re-aged, never un-aged)');
      const taken = takenOff(k);
      if (added.length) {
        const note = parsed[batchesSeen];
        batchesSeen++;
        A.ok(edited.indexOf(p.n) >= 0, 'request ' + p.n + ': stubs appear only on a batch request');
        const turns = turnsOf(p.body);
        const keepFrom = turns.length - 4;   // the newest four tool turns ride whole
        const turnOf = key => turns.findIndex(t => t.calls.some(c => c.id === key.split(':')[1]));
        A.ok(added.every(x => turnOf(x) >= 0 && turnOf(x) < keepFrom), 'request ' + p.n + ': a batch ages nothing inside the newest four tool turns');
        A.ok(new Set(added.map(turnOf)).size >= 2, 'request ' + p.n + ': a batch ages at least two tool turns');
        A.ok(taken - prevTaken >= 60000, 'request ' + p.n + ': a batch takes at least 60,000 characters off the wire (' + (taken - prevTaken) + ')');
        A.eq(note && note.freedChars, taken - prevTaken, 'request ' + p.n + ': the batch reports exactly the characters that left the wire');
        A.eq(note && [note.results, note.args], [added.filter(x => x[0] === 'r').length, added.filter(x => x[0] === 'a').length], 'request ' + p.n + ': and how many results and write arguments aged');
        const left = [];
        turns.slice(0, Math.max(0, keepFrom)).forEach(t => {
          for (const id of Object.keys(t.results)) if (eligible('r:' + id) && !now.has('r:' + id)) left.push('r:' + id);
          for (const c of t.calls) for (const f of Object.keys(c.input || {})) if (eligible('a:' + c.id + ':' + f) && !now.has('a:' + c.id + ':' + f)) left.push('a:' + c.id + ':' + f);
        });
        A.eq(left, [], 'request ' + p.n + ': a batch ages everything eligible behind the newest four tool turns');
      } else A.eq(taken, prevTaken, 'request ' + p.n + ': between batches nothing more leaves the wire');
      A.ok([...now.keys()].every(eligible), 'request ' + p.n + ': only eligible bodies are aged (never quoted words, a failed write, a short receipt)');
      prev = now; prevTaken = taken;
    }
    A.eq(batchesSeen, edited.length, 'on: each edited request is a batch that added stubs (' + batchesSeen + ')');
    // NOTHING ELSE CHANGED: the same static prefix, model, effort and cache route; each item is the switch-off item or its stub
    const fixed = b => JSON.stringify([b.model, b.instructions, b.tools, b.tool_choice, b.parallel_tool_calls, b.reasoning, b.include, b.store, b.stream, b.prompt_cache_key, Object.keys(b).sort()]);
    A.ok(posts.every((p, k) => fixed(p.body) === fixed(offPosts[k].body) && p.route === offPosts[k].route), 'on: instructions, tools, model, effort and the cache route of every request are the switch-off ones');
    A.ok(posts.every((p, k) => p.body.input.length === offPosts[k].body.input.length && p.body.input.every((it, i) => {
      const o = offPosts[k].body.input[i];
      if (JSON.stringify(it) === JSON.stringify(o)) return true;
      if (it.type !== o.type || it.call_id !== o.call_id || it.name !== o.name) return false;
      return it.type === 'function_call_output' ? String(it.output).indexOf(RESULT_STUB) === 0 : (it.type === 'function_call' && String(it.arguments).indexOf(ARG_STUB) >= 0);
    })), 'on: every input item is the switch-off item, or the stub of that same call or result');
    const parses = it => { try { const a = JSON.parse(it.arguments); return !!a && typeof a === 'object' && !Array.isArray(a); } catch (_) { return false; } };
    A.ok(posts.every(p => p.body.input.every(it => it.type !== 'function_call' || parses(it))), 'on: every function call\'s arguments still parse as a JSON object on the Responses wire, aged or not');

    // ================= 3. STUBS KEEP WORKING HANDLES; THE TRANSCRIPT KEEPS EVERY BODY =================
    const last = posts[posts.length - 1];
    const stubs = stubsOf(last.body);
    let read = 0, args = 0, parked = 0;
    for (const [key, stub] of stubs) {
      const h = handleOf(stub);
      A.ok(!!h, key + ': the stub names an fs.read handle (' + stub.slice(0, 160) + ')');
      if (!h) continue;
      const back = await readBack(on.ws.reg, on.capCtx, h);
      const id = key.split(':')[1];
      const want = (key.indexOf('r:') === 0 && callOf.get(id) && callOf.get(id).name === 'build_log') ? BUILD : original.get(key);
      A.ok(back.ok && back.text === want, key + ': its handle reads back BYTE-IDENTICAL (' + back.text.length + ' vs ' + (want || '').length + ' chars, ' + back.pages + ' page(s))');
      if (key.indexOf('a:') === 0) args++; else if (want === BUILD) parked++; else read++;
    }
    A.ok(read >= 8 && args >= 4 && parked === 1, 'handles: the read results, the write and edit arguments and the registry-parked log all came back (' + read + ' results, ' + args + ' arguments, ' + parked + ' parked)');
    const recallId = [...callOf].find(([, c]) => c.name === 'recall')[0];
    const lockedId = [...callOf].find(([, c]) => c.args.path === 'locked.txt')[0];
    A.ok(!stubs.has('r:' + recallId) && !stubs.has('a:' + lockedId + ':content'), 'never aged: the quoted recall result and the refused write\'s content ride whole');
    A.eq(on.ws.parks.filter(p => Array.isArray(p.meta.quotedStreams) && p.meta.quotedStreams.length).length, 0, 'the parker is never asked to save quoted words');
    const full = JSON.stringify(on.res.messages);
    A.ok(full.indexOf(RESULT_STUB) < 0 && full.indexOf(ARG_STUB) < 0, 'transcript: the run\'s messages carry no stub (every full body stays)');
    A.eq(on.res.messages, off.res.messages, 'transcript: the switch-on run\'s messages equal the switch-off run\'s, message for message');
    const cp = JSON.stringify(on.checkpoint || []);
    A.ok(!!on.checkpoint && cp.indexOf(RESULT_STUB) < 0 && cp.indexOf(ARG_STUB) < 0 && on.checkpoint.some(m => m.role === 'tool' && String(m.content).length >= READ_CHARS), 'transcript: the last journal checkpoint carries the full bodies');

    // ================= 4. THE SAVING, MEASURED: bytes before / after, and the run's own booked usage =================
    const bytes = run => run.up.posts.reduce((a, p) => a + p.bytes, 0);
    const fresh = run => run.up.posts.reduce((a, p) => a + (p.total - p.read), 0);
    const bOff = booked(off), bOn = booked(on);
    A.eq([bOff.calls, bOn.calls], [CASES.long.total, CASES.long.total], 'saving: each call booked its usage once (' + bOn.calls + ')');
    A.ok(bytes(on) < bytes(off), 'saving: the switch-on run sends fewer request bytes (' + bytes(on) + ' vs ' + bytes(off) + ', -' + pct(bytes(on), bytes(off)) + ')');
    A.ok(bOn.uncached + bOn.read < bOff.uncached + bOff.read, 'saving: and fewer input tokens in all (' + (bOn.uncached + bOn.read) + ' vs ' + (bOff.uncached + bOff.read) + ')');
    A.ok(bOn.uncached > bOff.uncached, 'saving: the batches re-process what they edit: more uncached input (' + bOn.uncached + ' vs ' + bOff.uncached + '), which the payback weighed');
    A.ok(planWeight(bOn, LIST.read) < planWeight(bOff, LIST.read), 'saving: less plan weight if a cached token counts the list 0.10x (' + Math.round(planWeight(bOn, LIST.read)) + ' vs ' + Math.round(planWeight(bOff, LIST.read)) + ', -' + pct(planWeight(bOn, LIST.read), planWeight(bOff, LIST.read)) + ')');
    A.ok(planWeight(bOn, 1) < planWeight(bOff, 1), 'saving: and less if every token counts the same (' + planWeight(bOn, 1) + ' vs ' + planWeight(bOff, 1) + ', -' + pct(planWeight(bOn, 1), planWeight(bOff, 1)) + ')');
    A.ok(planWeight(bOn, LIST.read) + (bOn.uncached - bOff.uncached) * (FLOOR - 1) < planWeight(bOff, LIST.read), 'saving: and still less with every re-processed token counted at the proxy\'s 1.25x write');
    console.log('  [saving] ' + CASES.long.total + ' requests on the ChatGPT sign-in (' + MODEL + '), batches at requests ' + JSON.stringify(edited) + ', each crediting ' + JSON.stringify(parsed.map(p => p && p.credited)) + ' more (the run had ' + JSON.stringify(edited.map(n => posts.length - n)) + ' more)');
    for (const p of parsed) if (p) console.log('  [batch] from message ' + p.editAt + ': ' + p.results + ' result(s) + ' + p.args + ' argument(s), ' + p.freedChars + ' characters freed; payback ' + p.saving + ' > ' + p.rewrite + ' (' + p.credited + ' requests x ' + p.freed + ' freed x read ' + p.read + ' against ' + p.suffix + ' re-written x (write ' + p.write + ' - read)), sign-in proxy');
    console.log('  [saving] request bytes: ' + bytes(off) + ' off, ' + bytes(on) + ' on (-' + pct(bytes(on), bytes(off)) + '); characters processed uncached: ' + fresh(off) + ' off, ' + fresh(on) + ' on');
    console.log('  [saving] booked usage (uncached input + cache read tokens): off ' + bOff.uncached + ' + ' + bOff.read + ', on ' + bOn.uncached + ' + ' + bOn.read);
    for (const [label, r] of [['1.00x (every token the same)', 1], ['0.50x', 0.5], ['0.25x', 0.25], ['0.10x (the list read: the proxy)', 0.1], ['0.05x (below the list)', 0.05], ['0.02x', 0.02], ['0.00x (cached tokens free)', 0]]) {
      console.log('  [saving] if the plan counts a cached token at ' + label + ': on vs off ' + Math.round(planWeight(bOn, r)) + ' vs ' + Math.round(planWeight(bOff, r)) + ' (' + (planWeight(bOn, r) <= planWeight(bOff, r) ? '-' : '+') + pct(planWeight(bOn, r), planWeight(bOff, r)).replace('-', '') + ')');
    }

    // ================= 5. A SHORT RUN IS UNTOUCHED =================
    const short = await runCoding(Object.assign({ ageing: true, signIn: true }, CASES.short)); toClean.push(short.ws.root);
    A.eq(short.res.reason, 'done', 'short: the 12-request run finishes');
    A.eq(hashes(short), golden.short, 'short: a 12-request run on the sign-in sends the base bytes with both switches on (' + short.up.posts.length + ' requests)');
    const capped = await runCoding(Object.assign({ ageing: true, signIn: true }, CASES.ceiling)); toClean.push(capped.ws.root);
    A.eq(hashes(capped), golden.ceiling, 'ceiling: a run whose turn ceiling is 24 sends the base bytes with both switches on (' + capped.up.posts.length + ' requests)');
    A.eq(short.batches + capped.batches, 0, 'short, ceiling: no batch ran');

    // ================= 6. NOTHING ELSE UNPRICED AGES =================
    // the same long run with both switches on, its cost engine built for another unpriced route (as index.js names it)
    for (const [route, what] of [['ollama', 'a local model'], ['claude-cli', 'a Claude sign-in (claude-cli stands down)'], ['grok', 'another sign-in'], [null, 'an engine the host named no route for']]) {
      const r = await runCoding(Object.assign({ ageing: true, signIn: true, route }, CASES.long)); toClean.push(r.ws.root);
      A.eq([r.batches, hashes(r).length === golden.long.length && hashes(r).every((h, k) => h === golden.long[k])], [0, true], 'unpriced (' + what + '): never aged with both switches on: the base bytes');
    }

    // ================= 7. BILLING IS UNTOUCHED ON THE SIGN-IN RUN =================
    for (const [name, run] of [['off', off], ['on', on]]) {
      const costs = run.seq.filter(e => e.name === 'agent.cost' || e.name === 'cost.estimate');
      A.ok(costs.length >= 2 * CASES.long.total && costs.every(e => e.payload.usd === 0), name + ': every cost record of the sign-in run says $0 (' + costs.length + ' records)');
      A.ok(costs.every(e => !Object.keys(e.payload).some(k => /price|rate|proxy/i.test(k))), name + ': no record carries a price, a rate or the proxy');
      A.eq([run.res.usd, run.cost.cacheRates(MODEL), run.provider.priceOf(MODEL)], [0, null, null], name + ': the run spent $0, and the route has no cache rates and no price');
    }
    A.eq(on.seq.filter(e => e.name === 'agent.cost').map(e => [e.payload.usd, e.payload.unpriced === true]), off.seq.filter(e => e.name === 'agent.cost').map(e => [e.payload.usd, e.payload.unpriced === true]), 'billing: the switch-on run\'s cost records say what the switch-off run\'s do, dollar for dollar');

    // ================= 8. ONE RESOLVER, ONE SWITCH =================
    const code = sidecarSourceFiles().map(f => ({ rel: f.rel, text: decomment(f.text) }));
    A.eq(code.filter(f => /AGEING_SIGNIN/.test(f.text)).map(f => f.rel), ['sidecar/index.js'], 'switch: STARNET_AGEING_SIGNIN is read in one place');
    const idx = code[0].text;
    A.eq((idx.match(/AGEING_SIGNIN/g) || []).length, 1, 'switch: read once');
    A.ok(/ageingSignIn:\s*\/\^\(1\|true\|yes\|on\)\$\/i\.test\(String\(ENV\('AGEING_SIGNIN'\)/.test(idx), 'switch: the host hands the loop ageingSignIn from ENV(\'AGEING_SIGNIN\'), off unless 1/true/yes/on');
    A.ok(/let cost = makeCostEngine\(\{ priceOf: provider\.priceOf, route: providerId \}\)/.test(idx) && /cost: makeCostEngine\(\{ priceOf: fbProvider\.priceOf, route: fbProviderId \}\)/.test(idx),
      'route: the run\'s engine and each provider fallback\'s are built with the route they price');
    A.eq(code.filter(f => /signInCacheRatesOf/.test(f.text)).map(f => f.rel).sort(), ['sidecar/cost.js', 'sidecar/providers/prices.js'], 'resolver: the proxy rates live in prices.js and only the cost engine reads them');
    A.eq(code.filter(f => /\bsignInCacheRates\b/.test(f.text)).map(f => f.rel).sort(), ['sidecar/cost.js', 'sidecar/loop.js'], 'resolver: one engine method, asked by the loop alone (nothing that bills asks)');
    const loopText = code.find(f => f.rel === 'sidecar/loop.js').text;
    A.eq([(loopText.match(/\bsignInCacheRates\b/g) || []).length, (loopText.match(/o\.ageingSignIn\b/g) || []).length], [2, 1], 'resolver: the loop asks at one site, behind the one option');
    A.ok(/if \(priced \|\| o\.ageingSignIn !== true \|\| typeof cost\.signInCacheRates !== 'function'\) return priced;/.test(loopText), 'resolver: a priced route keeps its own rates, and with the option off the proxy is never asked');
  } finally {
    for (const r of toClean) fs.rmSync(r, { recursive: true, force: true });
  }
  A.report('batched-ageing.signin.invariant.test');
})().catch(e => { console.log('FAIL: batched-ageing.signin.invariant.test threw -- ' + (e && e.stack || e)); process.exit(1); });
