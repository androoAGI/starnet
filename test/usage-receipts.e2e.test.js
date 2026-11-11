'use strict';
/* node test/usage-receipts.e2e.test.js — USAGE RECEIPTS on a REAL sidecar (W1.1, cost audit 2026-11-08). Part of test:http.

   The real sidecar (hermetic SidecarFixture: temp workspace + profile; every fetch to a host that is not loopback refused,
   so nothing here can reach a real provider or spend anything) runs one /api/run on each adapter kind against local
   fakes: ONE loopback upstream speaking ChatGPT's Responses wire (with its x-codex-* window headers, including the
   zero-valued phantom secondary), Anthropic's Messages wire, OpenRouter's and a generic OpenAI chat wire, and Gemini's;
   and a fake `claude` CLI (the npm-style .cmd shim beside node_modules/@anthropic-ai/claude-code/cli.js that claude-cli.js
   runs as `node cli.js`) that says its rate_limit_event and reports thinking tokens. Every call each fake answers gets
   its OWN counts (fresh input, cache read, cache write, output, reasoning), so a receipt can belong to one call only.
   Locks:
     1. WORKSPACES/.usage/calls.jsonl holds exactly ONE receipt per call a fake answered — run calls and any background
        call alike — with that call's own five counts, its provider, sign-in and model; nothing for a call that never
        happened; never a word of the prompt or the reply
     2. Claude Code's cache writes and thinking tokens are on its receipts; the plan-window reading each subscription call
        saw rides on its receipt; ChatGPT's zero-valued secondary slot is no window anywhere (the phantom is gone)
     3. GET /api/usage/providers `starnet`: StarNet's own tokens on each sign-in since each window opened, from those
        receipts, never a percentage; the terminal's /usage line renders it
     4. it all survives a restart: the receipts are on disk, the share after a restart is the share before */
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { starnetLine } = require('../bin/lib/usage.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const IPC = 'usage-receipts-e2e-ipc-token-0123456789';
const PROMPT = 'RECEIPT-E2E-PROMPT-words';
const REPLY = 'RECEIPT-E2E-REPLY-words';
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/profile': { email: 'plan@example.test' } })).toString('base64url') + '.fixture';
const MODELS = { codex: 'gpt-5.5', anthropic: 'claude-haiku-4-5', openrouter: 'or/model', openai: 'gpt-4.1-mini', gemini: 'gemini-2.5-flash', 'claude-cli': 'sonnet' };
const KEYED = ['anthropic', 'openrouter', 'openai', 'gemini'];
const COUNTS = ['uncachedIn', 'cacheRead', 'cacheWrite', 'out', 'reasoning'];
// call n's own counts — distinct per call, so a receipt can match one call only
const countsOf = (n, provider) => ({ uncachedIn: 1000 + n, cacheRead: 2000 + n, cacheWrite: provider === 'gemini' ? 0 : 300 + n, out: 50 + n, reasoning: 10 + (n % 7) });
const inSecs = s => String(Math.floor(Date.now() / 1000) + s);

function sse(parts) { return parts.map(p => typeof p === 'string' ? p : 'data: ' + JSON.stringify(p)).join('\n\n') + '\n\n'; }
function wire(provider, n) {
  const c = countsOf(n, provider);
  if (provider === 'codex') {
    return sse([{ type: 'response.output_text.delta', output_index: 0, delta: REPLY },
      { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: c.uncachedIn + c.cacheRead + c.cacheWrite,
        input_tokens_details: { cached_tokens: c.cacheRead, cache_write_tokens: c.cacheWrite }, output_tokens: c.out, output_tokens_details: { reasoning_tokens: c.reasoning } } } },
      'data: [DONE]']);
  }
  if (provider === 'anthropic') {
    return sse([{ type: 'message_start', message: { id: 'msg_' + n, usage: { input_tokens: c.uncachedIn, cache_creation_input_tokens: c.cacheWrite, cache_read_input_tokens: c.cacheRead, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: c.out, output_tokens_details: { thinking_tokens: c.reasoning } } },
      { type: 'message_stop' }]);
  }
  if (provider === 'gemini') {
    return sse([{ candidates: [{ content: { role: 'model', parts: [{ text: REPLY }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: c.uncachedIn + c.cacheRead, cachedContentTokenCount: c.cacheRead, candidatesTokenCount: c.out, thoughtsTokenCount: c.reasoning } }]);
  }
  const usage = { prompt_tokens: c.uncachedIn + c.cacheRead + c.cacheWrite, completion_tokens: c.out, total_tokens: c.uncachedIn + c.cacheRead + c.cacheWrite + c.out,
    prompt_tokens_details: { cached_tokens: c.cacheRead, cache_write_tokens: c.cacheWrite }, completion_tokens_details: { reasoning_tokens: c.reasoning } };
  if (provider === 'openrouter') usage.cost = 0.0001;
  return sse([{ choices: [{ index: 0, delta: { content: REPLY } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }, 'data: [DONE]']);
}

// one loopback upstream for every HTTP adapter: /<provider>/... ; every POST is a model call, numbered and recorded
function startUpstream() {
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      const provider = String(req.url || '').split('/')[1];
      if (!MODELS[provider]) { res.writeHead(404); return res.end(); }
      if (req.method !== 'POST') {   // a model list: every shape the adapters read
        const id = MODELS[provider];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id, type: 'model', display_name: id, context_length: 200000, max_input_tokens: 200000, supported_parameters: ['tools'] }],
          models: [{ name: 'models/' + id, inputTokenLimit: 200000, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }], has_more: false }));
      }
      const call = { provider, n: ++n, prompt: raw.indexOf(PROMPT) >= 0 };
      calls.push(call);
      const headers = { 'Content-Type': 'text/event-stream' };
      if (provider === 'codex') Object.assign(headers, { 'x-codex-primary-used-percent': '12', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': inSecs(3600),
        'x-codex-secondary-used-percent': '0', 'x-codex-secondary-window-minutes': '0', 'x-codex-secondary-reset-after-seconds': '0' });
      res.writeHead(200, headers);
      res.end(wire(provider, call.n));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port })));
}

// the fake `claude`: each call numbered by its own pid (race-free), logged, answered with that call's counts after the run's
// rate_limit_event — the 10-27 live shape (unifiedWindows, utilization 0-1)
const FAKE_CLI = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const out = o => process.stdout.write(JSON.stringify(o) + '\\n');
if (args[0] === 'auth') { out({ loggedIn: true, authMethod: 'claude.ai', email: 'cli@example.test', subscriptionType: 'max' }); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const n = 100000 + process.pid;
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ provider: 'claude-cli', n, prompt: input.indexOf(${JSON.stringify(PROMPT)}) >= 0 }) + '\\n');
  const at = s => Math.floor(Date.now() / 1000) + s;
  out({ type: 'system', subtype: 'init', apiKeySource: 'none', tools: [] });
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: {
    five_hour: { utilization: 0.25, resetsAt: at(3600), status: 'allowed' }, seven_day: { utilization: 0.5, resetsAt: at(86400), status: 'allowed' } } } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ${JSON.stringify(REPLY)} } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: ${JSON.stringify(REPLY)}, stop_reason: 'end_turn', total_cost_usd: 0,
    usage: { input_tokens: 1000 + n, cache_creation_input_tokens: 300 + n, cache_read_input_tokens: 2000 + n, output_tokens: 50 + n, output_tokens_details: { thinking_tokens: 10 + (n % 7) } } });
});
`;
function makeFakeClaude(root) {
  const pkg = path.join(root, 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), FAKE_CLI);
  const shim = path.join(root, 'claude.cmd');
  fs.writeFileSync(shim, '@echo off\r\n');   // never executed: claude-cli.js runs the cli.js beside a .cmd shim
  return shim;
}

// the boot entry: the real sidecar with every fetch to a host that is not loopback refused (no real provider, no spend)
function bootEntry(dir) {
  const entry = path.join(dir, 'boot.js');
  const indexJs = path.resolve(__dirname, '..', 'sidecar', 'index.js');
  fs.writeFileSync(entry, "'use strict';\nconst real = globalThis.fetch;\n" +
    "globalThis.fetch = function (url) { const u = String((url && url.url) || url); return /^https?:[/][/](127[.]0[.]0[.]1|localhost)[:/]/.test(u) ? real.apply(this, arguments) : Promise.reject(new Error('usage-receipts.e2e: no network in this test (' + u + ')')); };\n" +
    'require(' + JSON.stringify(indexJs) + ');\n');
  return entry;
}

(async () => {
  const up = await startUpstream();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-receipts-e2e-'));
  const cliLog = path.join(scratch, 'claude-calls.jsonl');
  fs.writeFileSync(cliLog, '');
  const ENV = { STARNET_IPC_TOKEN: IPC, STARNET_CLAUDE_BIN: makeFakeClaude(scratch), STARNET_CLAUDE_CLI_PERSIST: '0', FAKE_CLAUDE_LOG: cliLog,
    STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_REMOTE_RELAY: 'off', SKYNET_REMOTE_RELAY: 'off',
    SKYNET_BUDGET_PER_RUN: '10', SKYNET_BUDGET_PER_AGENT: '0', SKYNET_BUDGET_PER_DAY: '0', SKYNET_BUDGET_GLOBAL: '0',
    STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', SKYNET_SKILL_CURATOR: '0', STARNET_QUEST_REFRESH: '0', SKYNET_QUEST_REFRESH: '0',
    STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY', 'XAI_API_KEY', 'CREDITS_API_KEY']) {
    ENV[name] = ''; ENV['STARNET_' + name] = ''; ENV['SKYNET_' + name] = '';
  }
  const fixture = SidecarFixture.create({ prefix: 'usage-receipts-e2e-', timeoutMs: 30000, entry: bootEntry(scratch), env: ENV });
  const file = path.join(fixture.workspace, '.usage', 'calls.jsonl');
  const receipts = () => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
  const cliCalls = () => fs.readFileSync(cliLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const allCalls = () => up.calls.concat(cliCalls());
  async function settle() {   // until no new call and no new receipt for 1.5 s (background calls land too)
    let last = '', since = Date.now();
    for (const until = Date.now() + 30000; Date.now() < until; await sleep(250)) {
      const now = allCalls().length + ':' + receipts().length;
      if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= 1500) return;
    }
  }
  try {
    fs.mkdirSync(path.join(fixture.workspace, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
    await fixture.start();
    const pushed = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'codex', key: '', baseUrl: up.base + '/codex' }) });
    A.eq(pushed.status, 200, 'the ChatGPT sign-in\'s endpoint is pushed to the loopback fake');

    /* one run per adapter kind */
    for (const provider of ['codex', 'anthropic', 'openrouter', 'openai', 'gemini', 'claude-cli']) {
      const body = { agentId: 'receipt-' + provider, provider, model: MODELS[provider], internal: true, isTask: false, messages: [{ role: 'user', content: PROMPT + ' on ' + provider }] };
      if (KEYED.includes(provider)) Object.assign(body, { key: provider + '-fixture-key', baseUrl: up.base + '/' + provider });
      // Claude Code's sign-in is read from `claude auth status` in the background: until that answers, a run is held with
      // "checking local sign-in" (a 400 that ran nothing). Ask the accounts route, then retry while it is still checking.
      if (provider === 'claude-cli') {
        for (const until = Date.now() + 20000; Date.now() < until; await sleep(250)) {
          const acc = await fixture.json('GET', '/api/auth/claude-cli/accounts');
          if (acc.body && Array.isArray(acc.body.accounts) && acc.body.accounts.some(a => a.loggedIn)) break;
        }
      }
      let r = await fixture.json('POST', '/api/run', body);
      for (let i = 0; i < 40 && r.status === 400 && /checking local sign-in/.test(String(r.text)); i++) { await sleep(250); r = await fixture.json('POST', '/api/run', body); }
      const events = String(r.text || '').split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      const end = (events.filter(e => e.name === 'agent.run.end').pop() || {}).payload || {};
      A.eq([r.status, end.reason], [200, 'done'], provider + ': the run streams through the real /api/run route and finishes: ' + (r.status === 200 ? JSON.stringify(events.filter(e => /error/.test(e.name)).map(e => e.payload)) : String(r.text)).slice(0, 400));
      A.ok(allCalls().some(c => c.provider === provider && c.prompt), provider + ': the run\'s call reached its fake');
    }
    await settle();

    /* 1 — one receipt per call, with that call's own counts */
    const calls = allCalls(), recs = receipts();
    const counted = recs.filter(r => !r.usageMissing);
    const unmatched = [], doubled = [];
    for (const c of calls) {
      const want = countsOf(c.n, c.provider);
      const mine = counted.filter(r => r.provider === c.provider && COUNTS.every(k => r[k] === want[k]));
      if (mine.length === 0) unmatched.push(c);
      if (mine.length > 1) doubled.push(c);
    }
    A.eq([unmatched, doubled], [[], []], 'every call a fake answered has exactly ONE receipt with that call\'s own five counts (' + calls.length + ' calls: ' +
      Object.entries(calls.reduce((m, c) => { m[c.provider] = (m[c.provider] || 0) + 1; return m; }, {})).map(([p, k]) => p + ' ' + k).join(', ') + ')');
    A.eq(counted.length, calls.length, '...and no receipt counts a call that never happened');
    A.eq(recs.filter(r => r.usageMissing).map(r => [r.provider, r.end, r.status]), [], 'no call failed or went unreported in this run');
    A.ok(recs.every(r => r.account === 'primary' && r.model === MODELS[r.provider]), '...each names its sign-in and model: ' + JSON.stringify(recs.map(r => [r.provider, r.account, r.model])));
    A.ok(recs.filter(r => r.end === 'done').length === recs.length, '...each ended done');
    const runRecs = recs.filter(r => r.runId);
    A.ok(runRecs.length >= 6, 'the run calls carry their run id: ' + runRecs.length);
    const raw = fs.readFileSync(file, 'utf8');
    A.ok(!/RECEIPT-E2E|fixture-key|plan@example/.test(raw), 'not a word of the prompt or the reply, and no credential, in .usage/calls.jsonl');

    /* 2 — Claude Code's cache writes + thinking, the windows each subscription call saw, no phantom */
    const cli = recs.filter(r => r.provider === 'claude-cli');
    A.ok(cli.length >= 1 && cli.every(r => r.cacheWrite > 300 && r.reasoning >= 10 && r.reasoning < 17), 'Claude Code receipts carry its cache writes and its thinking tokens: ' + JSON.stringify(cli.map(r => [r.cacheWrite, r.reasoning])));
    A.ok(cli.every(r => r.window && JSON.stringify(r.window.windows.map(w => [w.id, w.usedPct, w.minutes])) === JSON.stringify([['five_hour', 25, 300], ['seven_day', 50, 10080]])), 'each Claude Code receipt carries the window reading its call saw');
    const cx = recs.filter(r => r.provider === 'codex');
    A.ok(cx.length >= 1 && cx.every(r => r.window && JSON.stringify(r.window.windows.map(w => [w.id, w.usedPct, w.minutes])) === JSON.stringify([['primary', 12, 300]])), 'each ChatGPT receipt carries the 5-hour window, and no zero-valued phantom: ' + JSON.stringify(cx.map(r => r.window)));
    A.ok(recs.filter(r => !['claude-cli', 'codex'].includes(r.provider)).every(r => !r.window), 'a key provider\'s receipt carries no plan window (it has none)');

    /* 3 — the share, and the terminal line */
    const sum = list => list.reduce((s, r) => s + r.uncachedIn + r.cacheRead + r.cacheWrite + r.out, 0);
    const got = await fixture.json('GET', '/api/usage/providers');
    A.eq(got.status, 200, 'GET /api/usage/providers answers');
    const subs = got.body.subscriptions || {}, share = got.body.starnet || {};
    A.eq((subs.codex && subs.codex.primary.windows.map(w => [w.label, w.minutes])) || null, [['5-hour', 300]], 'ChatGPT\'s windows as said: the 5-hour one, no "0-minute" phantom');
    const five = ((share['claude-cli'] || {}).primary || {}).five_hour;
    A.ok(!!five && five.tokens === sum(cli) && five.calls === cli.length && five.cacheRead === cli.reduce((s, r) => s + r.cacheRead, 0),
      'Claude Code: StarNet\'s own tokens since the 5-hour window opened are its receipts\' sum: ' + JSON.stringify(five));
    A.ok(!!five && five.since >= five.from && five.since <= Date.now(), '...counted from the later of the window\'s opening and the first receipt');
    const plan = ((share.codex || {}).primary || {}).primary;
    A.ok(!!plan && plan.tokens === sum(cx) && plan.calls === cx.length, 'ChatGPT: the same from its receipts: ' + JSON.stringify(plan));
    A.ok(!/pct|percent/i.test(JSON.stringify(share)), 'never a StarNet percentage of a window');
    const line = starnetLine(subs['claude-cli'] && subs['claude-cli'].primary, share['claude-cli'] && share['claude-cli'].primary, got.body.now);
    A.ok(/^ {4}StarNet since each window opened: 5-hour \d+(\.\d)?[kM]? tokens \(\d+(\.\d)?[kM]? cache re-reads\)/.test(line || '') && !/%/.test(line), 'the terminal\'s /usage line renders it: ' + line);
    console.log('usage-receipts.e2e: ' + calls.length + ' calls, ' + recs.length + ' receipts (' +
      Object.entries(recs.reduce((m, r) => { m[r.provider] = (m[r.provider] || 0) + 1; return m; }, {})).map(([p, k]) => p + ' ' + k).join(', ') + ')\n' + line);

    /* 4 — a restart */
    await fixture.restart();
    const again = await fixture.json('GET', '/api/usage/providers');
    const five2 = (((again.body.starnet || {})['claude-cli'] || {}).primary || {}).five_hour;
    A.eq([receipts().length, five2 && five2.tokens, five2 && five2.calls], [recs.length, five.tokens, five.calls], 'after a restart the receipts and StarNet\'s share are what they were');
  } finally {
    await fixture.dispose();
    await new Promise(r => up.server.close(r));
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('usage-receipts.e2e.test');
})().catch(e => { console.log('FAIL: usage-receipts.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
