/* node test/oneshot-small-model.invariant.test.js — W3.5 INVARIANT: one-shot background passes run on the small model
   of the run's provider family (cost audit 2026-11-08, Andrew's call 11-08).

   WHAT THIS LOCKS ("Done means" of lane W3.5), against the REAL sidecar and a mock OpenRouter that records every call:

     1. study, thread mining, scout and the session-title run call the SMALL model of the run's provider family — chosen
        from the provider's own catalog (anthropic/claude-haiku-5.5 beside a run on anthropic/claude-sonnet-5.5; never the
        older haiku, never another vendor's mini) — and the ledger rows and usage receipts name it.
     2. a small-model failure (an error, a refusal, malformed output) is retried ONCE on the run's own model, and both
        calls are recorded (ledger rows per model, receipts per call).
     3. REFLECTION stays on the run model unless its own switch (STARNET_AUX_SMALL_REFLECTION=1) is on.
     4. the claude-cli `haiku` alias is priced as the model it resolves to (claude-haiku-5-5 for CLI 2.1.319: its baked
        catalog maps haiku -> claude-haiku-5-5; the claude-api skill agrees), and a reply's usage names the model the CLI
        says served it.
     5. THE SMALL MODEL COSTS LESS (review r1). The catalog prices every id (OpenRouter's per-token rows). Beside a run on
        google/gemini-2.0-flash ($0.10/$0.40) the catalog lists the family's NEWEST small model, google/gemini-3.5-flash-lite,
        at $0.30/$2.50 (dearer) and the older google/gemini-2.0-flash-lite at $0.075/$0.30: study and thread mining take the
        cheaper 2.0-flash-lite and never the dearer newest one. A title on a `:free` run ($0) stays on it: a free pass never
        moves to a paid model.

   ZERO network, zero real key (the fake key routes to the mock), zero paid inference. */
'use strict';

const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const RUN_MODEL = 'anthropic/claude-sonnet-5.5';
const SMALL_MODEL = 'anthropic/claude-haiku-5.5';
const OLD_SMALL = 'anthropic/claude-haiku-4.5';
const OTHER_MINI = 'openai/gpt-5.4-mini';
// 5. a run whose family's newest small model costs MORE than the run; a free run
const CHEAP_RUN = 'google/gemini-2.0-flash';
const DEAR_SMALL = 'google/gemini-3.5-flash-lite';     // the newest flash-lite: dearer than CHEAP_RUN on both rates
const CHEAP_SMALL = 'google/gemini-2.0-flash-lite';    // older, and cheaper than CHEAP_RUN on both rates
const FREE_RUN = 'google/gemini-2.0-flash-exp:free';
// per-million USD [in, out] (prices.js list rates); the mock catalog states them per token, as OpenRouter does
const PRICES = { [RUN_MODEL]: [2, 10], [OLD_SMALL]: [1, 5], [SMALL_MODEL]: [0.10, 0.50], [OTHER_MINI]: [0.75, 4.50],
  [CHEAP_RUN]: [0.10, 0.40], [DEAR_SMALL]: [0.30, 2.50], [CHEAP_SMALL]: [0.075, 0.30], [FREE_RUN]: [0, 0] };
const TITLE_SYS = 'You generate a terse title for a work session. Reply with ONLY a 3 to 6 word title that names'
  + ' the concrete task or topic in the messages — never the greetings around it. Use Title Case. No'
  + ' surrounding quotes, no trailing punctuation, no preamble — output the title and nothing else.';

const LONG_REPLY = ('I dug through the deploy pipeline and rebuilt the staging rollback path end to end. ' +
  'Here is the substantive write-up with the reasoning, the tradeoffs, and the follow-ups worth remembering. ')
  .repeat(40);

// which pass a request is, from the system prompt each pass builds (the run itself carries the full [RUNTIME] prompt)
function kindOf(raw) {
  if (raw.indexOf('[RUNTIME]') >= 0) return 'main';
  if (raw.indexOf('terse title for a work session') >= 0) return 'title';
  if (raw.indexOf('reflecting right after finishing a task') >= 0) return 'reflection';
  if (raw.indexOf('You update a durable profile') >= 0) return 'study';
  if (raw.indexOf('You surface ideas the Commander raised') >= 0) return 'threadmine';
  if (raw.indexOf('You extract the recurring, specific work topics') >= 0) return 'scout';
  if (raw.indexOf('recipe author') >= 0 || raw.indexOf('station\'s recruiter') >= 0) return 'scout';
  if (raw.indexOf('Summarize this earlier part of the conversation') >= 0) return 'summary';
  return 'other';
}

function sse(res, text, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

/* mock OpenRouter. state.failSmall: every small-model answer is unusable in its own way —
   study: an HTTP 400 · threadmine: a refusal · scout: malformed prose · title: a chatty sentence (not a title) */
function startMock() {
  const state = { calls: [], failSmall: false };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const m = id => ({ id, context_length: 200000, pricing: { prompt: String(PRICES[id][0] / 1e6), completion: String(PRICES[id][1] / 1e6) }, supported_parameters: ['tools'] });
        res.end(JSON.stringify({ data: Object.keys(PRICES).map(m) }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let raw = ''; req.on('data', d => { raw += d; }); req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        const kind = kindOf(raw);
        const rec = { model: body.model, kind };
        state.calls.push(rec);
        const usage = { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 };
        if (kind === 'main') { sse(res, LONG_REPLY, { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 }); return; }
        const small = body.model === SMALL_MODEL;
        if (state.failSmall && small) {
          if (kind === 'study') {
            rec.failed = 'error';
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'small model rejected the request (test fault injection)', code: 400 } }));
            return;
          }
          if (kind === 'threadmine') { rec.failed = 'refusal'; sse(res, "I'm sorry, but I can't help with that request.", usage); return; }
          if (kind === 'scout') { rec.failed = 'malformed'; sse(res, 'Sure! The Commander seems to enjoy deployment work in general and might like more of it.', usage); return; }
          if (kind === 'title') { rec.failed = 'malformed'; sse(res, "Here's a title for your session: it is about rebuilding the staging rollback path and writing up the changes.", usage); return; }
        }
        if (kind === 'title') { sse(res, 'Staging Rollback Rebuild', usage); return; }
        sse(res, 'NONE', usage);
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

async function post(fixture, body) {
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  A.eq(r.status, 200, 'the real /api/run stream opened (' + (body.internal ? 'internal' : body.agentId) + ')');
  const raw = await r.text();
  return raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}
const task = (agentId, text) => ({ key: 'sk-or-v1-oneshot-fake', model: RUN_MODEL, agentId, isTask: true, messages: [{ role: 'user', content: text }] });
const title = (agentId) => ({ key: 'sk-or-v1-oneshot-fake', model: RUN_MODEL, agentId, internal: true, isTask: false, placed: [], oneShot: 'title', system: TITLE_SYS,
  messages: [{ role: 'user', content: 'Rebuild the staging deploy rollback path and write up what changed and why' }] });

async function settle(state, stableMs, maxMs) {
  const until = Date.now() + (maxMs || 15000);
  let last = -1, stableSince = Date.now();
  while (Date.now() < until) {
    if (state.calls.length !== last) { last = state.calls.length; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (stableMs || 2000)) break;
    await sleep(200);
  }
}
const readJsonl = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return []; } };
const textOf = evs => evs.filter(e => e.name === 'agent.token').map(e => (e.payload && (e.payload.delta || e.payload.text)) || '').join('');
const models = (calls, kind) => calls.filter(c => c.kind === kind).map(c => c.model);

const COMMON = { SKYNET_QUEST_REFRESH: '0', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0' };

// ---- 4. the claude-cli haiku alias, priced as what it resolves to ------------------------------------------------------
async function cliAlias() {
  const cli = require('../sidecar/providers/claude-cli.js');
  const prices = require('../sidecar/providers/prices.js');
  const u = { input_tokens: 1000000, output_tokens: 1000000 };
  const h55 = prices.priceOf('anthropic', 'claude-haiku-5-5');
  A.ok(!!h55, 'the list-rate table prices claude-haiku-5-5');
  const got = cli._internals.estimateUsd(u, 'haiku');
  A.ok(Math.abs(got - (h55.in + h55.out)) < 1e-9, "claude-cli's `haiku` alias is priced as claude-haiku-5-5, what CLI 2.1.319 resolves it to ($" + (h55.in + h55.out).toFixed(2) + ' per 1M in + 1M out; got $' + got + ')');
  // the CLI names the model that served the call (init + message_start): a usage event carries it, so a record says the model as it ran
  const fake = () => {
    const child = new EventEmitter();
    const s = () => { const x = new EventEmitter(); x.setEncoding = () => {}; return x; };
    child.stdout = s(); child.stderr = s(); child.pid = 4243; child.exitCode = null;
    child.kill = () => {};
    child.stdin = { on() {}, end() { setImmediate(() => {
      const lines = [
        { type: 'system', subtype: 'init', apiKeySource: 'none', model: 'claude-haiku-4-5-20251001', tools: [] },
        { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 9, output_tokens: 1 } } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NONE' } } },
        { type: 'result', subtype: 'success', is_error: false, result: 'NONE', stop_reason: 'end_turn', total_cost_usd: 0.01, usage: { input_tokens: 9, output_tokens: 2 } }
      ];
      for (const l of lines) child.stdout.emit('data', JSON.stringify(l) + '\n');
      child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0);
    }); } };
    return child;
  };
  const p = cli.makeClaudeCliProvider({ spawn: fake, fs: { statSync() { return { isFile: () => true }; }, writeFileSync() {}, unlinkSync() {} }, bin: 'claude.exe', env: { PATH: '', STARNET_CLAUDE_CLI_PERSIST: '0' }, platform: 'linux' });
  const evs = [];
  for await (const e of p.stream({ model: 'haiku', messages: [{ role: 'user', content: 'hi' }] })) evs.push(e);
  const usageEv = evs.filter(e => e.type === 'usage').pop();
  A.eq(usageEv && usageEv.model, 'claude-haiku-4-5-20251001', 'a claude-cli reply on the `haiku` alias names the model the CLI says served it (here an older CLI: Haiku 4.5)');
}

(async () => {
  await cliAlias();

  // ---- 1 + 3. the passes ride the family's small model; reflection stays on the run model -------------------------------
  {
    const mock = await startMock();
    const fixture = SidecarFixture.create({ prefix: 'sk-oneshot-a-', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base }, COMMON) });
    await fixture.start();
    try {
      await sleep(600);   // the mocked catalog warms
      await post(fixture, task('oneshot-a1', 'Rebuild the staging deploy rollback path and write up what changed and why'));
      await settle(mock.state);
      await post(fixture, task('oneshot-a2', 'Audit the production canary rollout gates and document the failure modes we found'));
      await settle(mock.state);
      const tEv = await post(fixture, title('oneshot-a1'));
      await settle(mock.state);
      const calls = mock.state.calls;
      if (process.env.ONESHOTDEBUG) calls.forEach((c, i) => console.error('  A#' + i + ' ' + c.kind + ' ' + c.model));
      A.ok(models(calls, 'main').length >= 2 && models(calls, 'main').every(m => m === RUN_MODEL), 'the task runs stayed on the run model');
      for (const k of ['study', 'threadmine', 'scout']) {
        const ms = models(calls, k);
        A.ok(ms.length >= 1, k + ' fired (non-vacuous: ' + ms.length + ' call(s))');
        A.ok(ms.length >= 1 && ms.every(m => m === SMALL_MODEL), k + ' rode the family small model ' + SMALL_MODEL + ' (got ' + ms.join(', ') + ')');
      }
      const rm = models(calls, 'reflection');
      A.ok(rm.length >= 1 && rm.every(m => m === RUN_MODEL), 'reflection stayed on the run model with its switch off (got ' + rm.join(', ') + ')');
      const tm = models(calls, 'title');
      A.ok(tm.length === 1 && tm[0] === SMALL_MODEL, 'the session-title run rode the small model, once (got ' + tm.join(', ') + ')');
      A.ok(textOf(tEv).indexOf('Staging Rollback Rebuild') >= 0, 'the title reply reached the page');
      A.ok(!calls.some(c => c.model === OLD_SMALL || c.model === OTHER_MINI), 'never the older haiku, never another vendor\'s mini');
      // records: the ledger rows and the receipts name the small model the passes ran on
      const rows = readJsonl(path.join(fixture.workspace, 'ledger.jsonl'));
      for (const k of ['study', 'threadmine']) {
        const r = rows.filter(x => x && x.aux === k);
        A.ok(r.length >= 1 && r.every(x => x.model === SMALL_MODEL), 'the ' + k + ' ledger row names ' + SMALL_MODEL + ' (got ' + r.map(x => x.model).join(', ') + ')');
      }
      const rec = readJsonl(path.join(fixture.workspace, '.usage', 'calls.jsonl'));
      A.ok(rec.filter(x => x.model === SMALL_MODEL).length >= 4, 'the usage receipts name the small model for the small-model calls (' + rec.filter(x => x.model === SMALL_MODEL).length + ')');

      // ---- 5. the small model must cost less than the run model; a free run keeps its model ----------------------------
      const from = calls.length;
      await post(fixture, Object.assign(task('oneshot-a3', 'Profile the nightly ETL job and write up which stages dominate its runtime'), { model: CHEAP_RUN }));
      await settle(mock.state);
      const g = calls.slice(from);
      if (process.env.ONESHOTDEBUG) g.forEach((c, i) => console.error('  A5#' + i + ' ' + c.kind + ' ' + c.model));
      A.ok(models(g, 'main').length >= 1 && models(g, 'main').every(m => m === CHEAP_RUN), 'the gemini task ran on ' + CHEAP_RUN);
      for (const k of ['study', 'threadmine']) {
        const ms = models(g, k);
        A.ok(ms.length >= 1 && ms.every(m => m === CHEAP_SMALL), k + ' on a ' + CHEAP_RUN + ' run took the CHEAPER ' + CHEAP_SMALL + ', not the newest small model (got ' + ms.join(', ') + ')');
      }
      A.ok(!g.some(c => c.model === DEAR_SMALL), 'no pass moved to ' + DEAR_SMALL + ', the newest small model that costs more than the run model ($0.30/$2.50 vs $0.10/$0.40)');
      const rows5 = readJsonl(path.join(fixture.workspace, 'ledger.jsonl')).filter(x => x && x.agentId === 'oneshot-a3' && x.aux === 'study');
      A.ok(rows5.length >= 1 && rows5.every(x => x.model === CHEAP_SMALL), 'the study ledger row names ' + CHEAP_SMALL + ' (got ' + rows5.map(x => x.model).join(', ') + ')');
      const from2 = calls.length;
      await post(fixture, Object.assign(title('oneshot-a3'), { model: FREE_RUN }));
      await settle(mock.state);
      const ft = models(calls.slice(from2), 'title');
      A.ok(ft.length === 1 && ft[0] === FREE_RUN, 'a title on a $0 (:free) run stays on it, never a paid small model (got ' + ft.join(', ') + ')');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  // ---- 2 + 3. a failed small call retries ONCE on the run model, both recorded; the reflection switch moves reflection --
  {
    const mock = await startMock();
    mock.state.failSmall = true;
    const fixture = SidecarFixture.create({ prefix: 'sk-oneshot-b-', env: Object.assign({ SKYNET_OPENROUTER_BASE: mock.base, STARNET_AUX_SMALL_REFLECTION: '1' }, COMMON) });
    await fixture.start();
    try {
      await sleep(600);
      await post(fixture, task('oneshot-b1', 'Rebuild the staging deploy rollback path and write up what changed and why'));
      await settle(mock.state);
      await post(fixture, task('oneshot-b2', 'Audit the production canary rollout gates and document the failure modes we found'));
      await settle(mock.state);
      const tEv = await post(fixture, title('oneshot-b1'));
      await settle(mock.state);
      const calls = mock.state.calls;
      if (process.env.ONESHOTDEBUG) calls.forEach((c, i) => console.error('  B#' + i + ' ' + c.kind + ' ' + c.model + (c.failed ? ' FAILED:' + c.failed : '')));
      const rm = models(calls, 'reflection');
      A.ok(rm.length >= 1 && rm.every(m => m === SMALL_MODEL), 'with STARNET_AUX_SMALL_REFLECTION=1 reflection rides the small model (got ' + rm.join(', ') + ')');
      // each failing pass: its small attempts each answered by exactly one run-model retry
      for (const [k, why] of [['study', 'error'], ['threadmine', 'refusal'], ['scout', 'malformed'], ['title', 'malformed']]) {
        const ms = models(calls, k);
        const small = ms.filter(m => m === SMALL_MODEL).length, run = ms.filter(m => m === RUN_MODEL).length;
        A.ok(small >= 1, k + ': the small model was tried first (' + ms.join(', ') + ')');
        A.ok(small >= 1 && run === small, k + ': a small-model ' + why + ' retried ONCE on the run model (small ' + small + ', run ' + run + ')');
        A.ok(ms[0] === SMALL_MODEL, k + ': the retry came after the small attempt, never before');
      }
      A.ok(textOf(tEv).indexOf('Staging Rollback Rebuild') >= 0 && textOf(tEv).indexOf("Here's a title") < 0, 'the title the page got is the run model\'s, never the malformed small reply');
      // records: both calls of a retried pass are on the ledger under the model each ran on, and both have receipts
      const rows = readJsonl(path.join(fixture.workspace, 'ledger.jsonl'));
      for (const k of ['study', 'threadmine']) {
        const got = rows.filter(x => x && x.aux === k).map(x => x.model);
        A.ok(got.indexOf(SMALL_MODEL) >= 0 && got.indexOf(RUN_MODEL) >= 0, k + ': the ledger records BOTH models that ran (' + got.join(', ') + ')');
      }
      const rec = readJsonl(path.join(fixture.workspace, '.usage', 'calls.jsonl'));
      const tSmall = rec.filter(x => x.model === SMALL_MODEL).length, tRun = rec.filter(x => x.model === RUN_MODEL).length;
      A.ok(tSmall >= 4 && tRun >= 6, 'the usage receipts record both sides of every retry (small ' + tSmall + ', run ' + tRun + ')');
    } finally { await fixture.dispose(); try { mock.server.close(); } catch (_) {} }
  }

  A.report('oneshot-small-model.invariant.test');
})().catch(e => { console.log('FAIL: oneshot-small-model.invariant.test threw - ' + (e && e.stack || e)); process.exit(1); });
