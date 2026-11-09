'use strict';
/* node test/usage-receipts.invariant.test.js — NO PROVIDER PATH SKIPS THE USAGE RECEIPT (W1.1 usage receipts, cost audit
   2026-11-08).

   StarNet could not prove what it spent: per model call nothing was stored. The receipt is written at ONE seam, the
   provider factory, which wraps every adapter it builds (runs, fallbacks, extra sign-ins, aux one-shots, compaction,
   vision, probes). This test locks the facts that make "every call has exactly one receipt" true:
     1. every adapter KIND the registry names, built through selectProvider and streamed once on a stub transport,
        appends exactly ONE record whose five counts are what the ONE resolver (cost.resolveUsage) reads from that
        call's own usage: fresh input, cache read, cache write, output, reasoning — plus the provider, the sign-in,
        the model, the run, how the call ended, and the window reading the call saw (codex headers, Claude Code's
        rate_limit_event). Never a word of the prompt or the reply.
     2. the deferred sign-in wrapper (tokenProvider) gets one receipt too; a refused call, a call the reader stopped
        early, and a call that never started each come out as they really were (error / stopped / no record);
     3. EVERY provider id in the registry comes back from selectProvider through the receipt seam;
     4. no production code builds an adapter outside the factory: an adapter constructor anywhere else may only read
        a model list, never stream. So no call can reach a provider without passing the seam.
   A new adapter kind has no stub here and fails step 1 until someone proves its calls get receipts.
   RED on e316231d7: there is no receipt seam (no usage-receipts.js, no factory.attachUsageReceipts). */
const A = require('./_assert.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decomment } = require('./helpers/decomment.js');
const factory = require('../sidecar/providers/factory.js');
const registry = require('../sidecar/providers/registry.js');
const { makeSubUsage } = require('../sidecar/sub-usage.js');

let receipts = null, resolveUsage = null;
try { receipts = require('../sidecar/usage-receipts.js'); } catch (_) { receipts = null; }
try { resolveUsage = require('../sidecar/cost.js').resolveUsage || null; } catch (_) { resolveUsage = null; }

const ROOT = path.join(__dirname, '..');
const PROMPT = 'PROMPT-TEXT-91c2-never-in-a-receipt';
const REPLY = 'REPLY-TEXT-7f3a-never-in-a-receipt';
const COUNTS = ['uncachedIn', 'cacheRead', 'cacheWrite', 'out', 'reasoning'];
const pick = (o, keys) => { const r = {}; for (const k of keys) r[k] = o ? o[k] : undefined; return r; };
const sse = parts => parts.map(p => typeof p === 'string' ? p : 'data: ' + JSON.stringify(p)).join('\n\n') + '\n\n';
async function collect(p, req) { const out = []; for await (const e of p.stream(req)) out.push(e); return out; }
const lastUsage = evs => { const u = evs.filter(e => e && e.type === 'usage').pop(); return u ? u.usage : null; };
const inSecs = s => String(Math.floor(Date.now() / 1000) + s);

// ChatGPT's window headers: a real 5-hour window, and the zero-valued secondary the backend sends for an account with one
// window (Codex's own client reads it as no window) — the receipt carries the real one only
const CODEX_HEADERS = { 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': inSecs(3600),
  'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0', 'x-codex-secondary-reset-after-seconds': '0' };

/* One stub transport per adapter kind: the wire that kind speaks, answering one call with distinct counts. */
const STUBS = {
  codex: { provider: 'codex', opts: { token: 'fixture-token' }, window: 1,
    reply: () => ({ headers: CODEX_HEADERS, body: sse([
      { type: 'response.output_text.delta', output_index: 0, delta: REPLY },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
        output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1050 } } },
      'data: [DONE]']) }),
    want: { uncachedIn: 100, cacheRead: 600, cacheWrite: 300, out: 50, reasoning: 20 } },
  openrouter: { provider: 'openrouter', opts: { key: 'sk-or-v1-fixture' },
    reply: () => ({ body: sse([
      { choices: [{ delta: { content: REPLY } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2000, completion_tokens: 70, total_tokens: 2070, cost: 0.001,
        prompt_tokens_details: { cached_tokens: 1500, cache_write_tokens: 400 }, completion_tokens_details: { reasoning_tokens: 30 } } },
      'data: [DONE]']) }),
    want: { uncachedIn: 100, cacheRead: 1500, cacheWrite: 400, out: 70, reasoning: 30 } },
  'openai-compatible': { provider: 'openai', opts: { key: 'sk-fixture' },
    reply: () => ({ body: sse([
      { choices: [{ delta: { content: REPLY } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3000, completion_tokens: 90, total_tokens: 3090,
        prompt_tokens_details: { cached_tokens: 2500 }, completion_tokens_details: { reasoning_tokens: 40 } } },
      'data: [DONE]']) }),
    want: { uncachedIn: 500, cacheRead: 2500, cacheWrite: 0, out: 90, reasoning: 40 } },
  anthropic: { provider: 'anthropic', opts: { key: 'sk-ant-fixture' },
    reply: () => ({ body: sse([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 80, output_tokens_details: { thinking_tokens: 40 } } },
      { type: 'message_stop' }]) }),
    want: { uncachedIn: 100, cacheRead: 3000, cacheWrite: 200, out: 80, reasoning: 40 } },
  gemini: { provider: 'gemini', opts: { key: 'fixture-key' },
    reply: () => ({ body: sse([
      { candidates: [{ content: { parts: [{ text: REPLY }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 500, cachedContentTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 530 } }]) }),
    want: { uncachedIn: 400, cacheRead: 100, cacheWrite: 0, out: 20, reasoning: 10 } },
  // a local child, not HTTP: a fake `claude` (claude-cli.js runs the cli.js beside a .cmd shim as `node cli.js`, on every
  // platform) whose result line carries the thinking count the CLI reports, after the run's rate_limit_event
  'claude-cli': { provider: 'claude-cli', cli: true, window: 2,
    want: { uncachedIn: 10, cacheRead: 9000, cacheWrite: 500, out: 157, reasoning: 108 } }
};

const FAKE_CLI = `'use strict';
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }); process.exit(0); }
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const at = s => Math.floor(Date.now() / 1000) + s;
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.25, resetsAt: at(3600), status: 'allowed' }, seven_day: { utilization: 0.5, resetsAt: at(86400), status: 'allowed' } } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ${JSON.stringify(REPLY)} } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(REPLY)}, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 157, output_tokens_details: { thinking_tokens: 108 } } });
});
process.stdin.resume();
`;

function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    calls.push({ url: String(url), method });
    if (method === 'GET') return new Response(JSON.stringify({ data: [], models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const a = answer();
    const status = a.status || 200;
    return new Response(a.body, { status, headers: Object.assign({ 'Content-Type': status === 200 ? 'text/event-stream' : 'application/json' }, a.headers || {}) });
  };
  f.calls = calls;
  return f;
}

/* 4: the structural half — every adapter constructor, and every place outside the factory that calls one */
function constructorNames() {
  const dir = path.join(ROOT, 'sidecar', 'providers'), names = new Map();
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    let mod = null;
    try { mod = require(path.join(dir, f)); } catch (_) { continue; }
    for (const k of Object.keys(mod || {})) if (/^make\w*Provider$/.test(k) && typeof mod[k] === 'function') names.set(k, 'sidecar/providers/' + f);
  }
  return names;
}
function productionFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const r = rel + '/' + e.name;
      if (e.isDirectory()) walk(r);
      else if (/\.(c|m)?js$/.test(e.name)) out.push(r);
    }
  };
  for (const top of ['sidecar', 'bin', 'shared']) walk(top);
  return out;
}
// the index just past the call's closing paren (strings/comments are already blanked or harmless to paren counting here)
function callEnd(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}
// A construction outside the factory is allowed only as a model-list read: `make…Provider(…).listModels(` chained, or
// `const x = make…Provider(…)` whose every later use in the next lines is `x.listModels(`. Anything that could stream is not.
function catalogOnly(src, at, name) {
  const open = src.indexOf('(', at + name.length);
  const end = callEnd(src, open);
  if (end < 0) return false;
  const after = src.slice(end, end + 40);
  if (/^\s*\.\s*listModels\s*\(/.test(after)) return true;
  const before = src.slice(Math.max(0, at - 80), at);
  const bound = before.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/);
  if (!bound) return false;
  const v = bound[1], rest = src.slice(end, end + 1500);
  const uses = [...rest.matchAll(new RegExp('\\b' + v.replace(/\$/g, '\\$') + '\\b', 'g'))];
  return uses.length > 0 && uses.every(m => /^\s*\.\s*listModels\s*\(/.test(rest.slice(m.index + v.length, m.index + v.length + 30)));
}

(async () => {
  /* 1-3 need the seam */
  const seam = !!(receipts && typeof receipts.makeUsageReceipts === 'function' && typeof factory.attachUsageReceipts === 'function' && typeof resolveUsage === 'function');
  A.ok(seam, 'the provider factory has a usage-receipt seam (usage-receipts.js + factory.attachUsageReceipts + cost.resolveUsage)');
  if (seam) {
    const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-receipts-cli-'));
    const pkg = path.join(fakeRoot, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
    const shim = path.join(fakeRoot, 'claude.cmd');
    fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
    const envBefore = { bin: process.env.STARNET_CLAUDE_BIN, persist: process.env.STARNET_CLAUDE_CLI_PERSIST };
    process.env.STARNET_CLAUDE_BIN = shim;
    process.env.STARNET_CLAUDE_CLI_PERSIST = '0';
    const clock = { now: () => Date.now() };
    const sub = makeSubUsage({ clock });
    const sink = receipts.makeUsageReceipts({ clock, readings: sub });
    factory.attachSubUsage(sub);
    factory.attachUsageReceipts(sink);
    try {
      /* 1 */
      const kinds = [...new Set(registry.providerIds().map(id => registry.getProviderProfile(id).adapter))];
      A.ok(kinds.length >= 6, 'the registry names its adapter kinds: ' + kinds.join(', '));
      for (const kind of kinds) {
        const stub = STUBS[kind];
        A.ok(!!stub, 'adapter kind "' + kind + '" has a stub here (a new adapter must prove its calls get a receipt)');
        if (!stub) continue;
        sink.clear();
        const fetch = stub.cli ? undefined : fakeFetch(stub.reply);
        const p = factory.selectProvider(Object.assign({ provider: stub.provider, fetch, clock }, stub.opts || {}));
        let evs = [], error = null;
        try { evs = await collect(p, { model: 'fixture-model', messages: [{ role: 'user', content: PROMPT }], runId: 'run-' + kind, preStreamRetries: 0 }); }
        catch (e) { error = e; }
        A.ok(!error, kind + ': the stub call streams: ' + (error && error.message));
        const recs = sink.records();
        A.eq(recs.length, 1, kind + ': one call, exactly one receipt');
        const r = recs[0] || {};
        A.eq(pick(r, COUNTS), stub.want, kind + ': fresh input, cache read, cache write, output and reasoning, as the call said them');
        A.eq(pick(r, COUNTS), pick(resolveUsage(lastUsage(evs)), COUNTS), kind + ': ...read by the ONE resolver from the call\'s own usage event');
        A.eq([r.provider, r.account, r.model, r.runId, r.end], [stub.provider, 'primary', 'fixture-model', 'run-' + kind, 'done'], kind + ': who, which sign-in, which model, which run, how it ended');
        A.ok(typeof r.at === 'number' && typeof r.ms === 'number' && r.ms >= 0, kind + ': when it ended and how long it took');
        const text = JSON.stringify(r);
        A.ok(!text.includes(PROMPT) && !text.includes(REPLY), kind + ': counts only, never a word of the prompt or the reply');
        if (stub.window) {
          const w = r.window || {};
          A.eq((w.windows || []).length, stub.window, kind + ': the window reading this call saw rides on its receipt: ' + JSON.stringify(w));
          A.ok(typeof w.seenAt === 'number' && w.seenAt >= r.at - r.ms, kind + ': ...seen during this call');
          if (kind === 'codex') A.eq([w.windows[0].usedPct, w.windows[0].minutes], [12, 300], 'codex: the real 5-hour window, never the zero-valued phantom');
          if (kind === 'claude-cli') A.eq(w.windows.map(x => [x.id, x.usedPct, x.minutes]), [['five_hour', 25, 300], ['seven_day', 50, 10080]], 'claude-cli: both windows of the run\'s rate_limit_event');
        } else A.ok(r.window == null, kind + ': a provider that reports no plan window carries none');
      }

      /* 2: the deferred sign-in wrapper, and calls that end other ways */
      sink.clear();
      const deferred = factory.selectProvider({ provider: 'codex', fetch: fakeFetch(STUBS.codex.reply), tokenProvider: async () => 'deferred-token' });
      await collect(deferred, { model: 'fixture-model', messages: [{ role: 'user', content: PROMPT }] });
      A.eq(sink.records().map(r => [r.provider, r.end, r.out]), [['codex', 'done', 50]], 'the deferred sign-in wrapper (token fetched at first use): one receipt');

      sink.clear();
      const refused = factory.selectProvider({ provider: 'codex', token: 't', fetch: fakeFetch(() => ({ status: 429,
        headers: Object.assign({}, CODEX_HEADERS, { 'x-codex-primary-used-percent': '100' }), body: JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }) })) });
      let threw = null;
      try { await collect(refused, { model: 'fixture-model', messages: [{ role: 'user', content: PROMPT }], preStreamRetries: 0 }); } catch (e) { threw = e; }
      const rr = sink.records()[0] || {};
      A.ok(!!threw, 'a refused call still fails the call (the receipt changes nothing about it)');
      A.eq([sink.records().length, rr.end, rr.status, rr.usageMissing, COUNTS.some(k => k in rr)], [1, 'error', 429, true, false], 'a refused call: one receipt that says so, its HTTP status, and no counts made up');
      A.eq(rr.window && rr.window.windows[0].usedPct, 100, '...with the window reading the refusal carried (100% used)');
      A.ok(!JSON.stringify(rr).includes('usage limit has been reached'), '...and never the provider\'s error text');

      sink.clear();
      const early = factory.selectProvider({ provider: 'openrouter', key: 'k', fetch: fakeFetch(STUBS.openrouter.reply) });
      for await (const ev of early.stream({ model: 'fixture-model', messages: [{ role: 'user', content: PROMPT }] })) { if (ev.type === 'text') break; }
      A.eq(sink.records().map(r => [r.end, r.usageMissing]), [['stopped', true]], 'a call its reader stops before usage arrived: one receipt, usage unknown (never 0)');

      sink.clear();
      const ac = new AbortController(); ac.abort();
      const never = factory.selectProvider({ provider: 'codex', fetch: fakeFetch(STUBS.codex.reply), tokenProvider: async () => 't' });
      await collect(never, { model: 'fixture-model', messages: [], signal: ac.signal });
      A.eq(sink.records().length, 0, 'a call that never started (stopped before it went out) leaves no receipt');

      /* 3: every provider id comes back through the seam */
      const missed = [];
      for (const id of registry.providerIds()) {
        let p = null;
        try { p = factory.selectProvider({ provider: id, fetch: fakeFetch(() => ({ body: '' })), key: 'k', token: 't', baseUrl: 'http://127.0.0.1:9/v1' }); } catch (_) { p = null; }
        if (!p || p[receipts.RECEIPTED] !== true) missed.push(id);
        let q = null;
        try { q = factory.selectProvider({ provider: id, fetch: fakeFetch(() => ({ body: '' })), key: 'k', baseUrl: 'http://127.0.0.1:9/v1', tokenProvider: async () => 't' }); } catch (_) { q = null; }
        if (!q || q[receipts.RECEIPTED] !== true) missed.push(id + ' (deferred)');
      }
      A.eq(missed, [], 'every provider id, plain and deferred, comes back from selectProvider through the receipt seam');
    } finally {
      factory.attachUsageReceipts(null);
      factory.attachSubUsage(null);
      if (envBefore.bin === undefined) delete process.env.STARNET_CLAUDE_BIN; else process.env.STARNET_CLAUDE_BIN = envBefore.bin;
      if (envBefore.persist === undefined) delete process.env.STARNET_CLAUDE_CLI_PERSIST; else process.env.STARNET_CLAUDE_CLI_PERSIST = envBefore.persist;
      try { fs.rmSync(fakeRoot, { recursive: true, force: true }); } catch (_) {}
    }
  }

  /* 4 */
  const names = constructorNames();
  for (const n of ['makeCodexProvider', 'makeOpenRouterProvider', 'makeOpenAICompatibleProvider', 'makeAnthropicProvider', 'makeGeminiProvider', 'makeClaudeCliProvider'])
    A.ok(names.has(n), 'the scan knows the adapter constructor ' + n);
  const bypass = [];
  let catalogReads = 0;
  for (const rel of productionFiles()) {
    if (rel === 'sidecar/providers/factory.js') continue;
    const src = decomment(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    for (const [name] of names) {
      const re = new RegExp('\\b' + name + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src))) {
        if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;   // its definition
        const line = src.slice(0, m.index).split('\n').length;
        if (catalogOnly(src, m.index, name)) catalogReads++;
        else bypass.push(rel + ':' + line + ' ' + name);
      }
    }
  }
  A.eq(bypass, [], 'no production code builds an adapter outside the factory (build it with selectProvider so its calls get receipts)');
  A.ok(catalogReads <= 2, 'the only constructions outside the factory are the known model-list reads (' + catalogReads + ')');

  A.report('usage-receipts.invariant.test');
})().catch(e => { console.log('FAIL: usage-receipts.invariant.test threw - ' + (e && e.stack || e)); process.exit(1); });
