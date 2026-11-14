/* node test/batched-ageing.signin.e2e.test.js — BATCHED AGEING ON THE CHATGPT SIGN-IN, THROUGH THE REAL SIDECAR
   (cost lane 2026-11-14, STARNET_AGEING_SIGNIN).

   test/batched-ageing.signin.invariant.test.js proves the lane on the real loop and the real Codex adapter, and its
   switch-off bytes against the base. This is the host half: the ACTUAL sidecar (its env reader, its run host, the cost
   engine it builds for the route, its parker and fs.read, its ledger and usage receipts) on a signed-in Codex route
   whose endpoint is a loopback Responses upstream. No network beyond 127.0.0.1, a synthetic token, no spend.

   A 34-file read chain (one fs.read a turn, ~9,000 characters a file) on gpt-5.5 over the ChatGPT sign-in:
   · STARNET_BATCHED_AGEING=1 alone: the sign-in never ages. No request carries a stub, no batch is noted.
   · with STARNET_AGEING_SIGNIN=1 as well: old results leave the request view in batches, none before the run is
     projected past 24 requests; the station's console names each batch as weighed by the SIGN-IN PROXY at read 0.1 and
     write 1.25; on the batch request the upstream's cache read stops at the first aged result; a stub's handle, asked
     by the model through the real fs.read, returns the body it replaced.
   · either way the run books $0: the run end, the ledger row (a sign-in: unmetered) and every usage receipt carry
     counts only, never a price. The receipts are what a station owner reads to check a real run (.usage/calls.jsonl). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const FILES = 34, FILE_CHARS = 9000;
const MARK = 'SIGNIN-E2E-CHAIN';
const MODEL = 'gpt-5.5';
const RESULT_STUB = '[tool result elided at compaction — ';
const IPC = 'ageing-signin-e2e-ipc-token-1234567890';
const FLOOR = ['cabinet', 'dish', 'notebook', 'studio', 'workbench'].map(objectType => ({ objectType }));
const NL = String.fromCharCode(10);
const filler = (tag, chars) => { let s = ''; let i = 0; while (s.length < chars) s += tag + ' line ' + (i++) + ' lorem ipsum dolor sit amet consectetur' + NL; return s.slice(0, chars); };
const line = obj => 'data: ' + JSON.stringify(obj);
const segsOf = body => [String(body.instructions || '') + '\u0000' + JSON.stringify(body.tools || null)].concat((body.input || []).map(it => JSON.stringify(it)));
const outputsOf = body => (body.input || []).filter(it => it && it.type === 'function_call_output');
const stubCount = body => outputsOf(body).filter(it => String(it.output).indexOf(RESULT_STUB) === 0).length;
const handleOf = stub => { const m = /read it with fs\.read (\{[^\n]*?\})\](?:\n|$)/.exec(stub); return m ? JSON.parse(m[1]).path : null; };

/* The loopback Codex upstream: the run's own requests (the ones that carry the task and tools) follow the chain, then
   read one aged result back through its handle, then answer; any other call gets a short reply. It reports the usage an
   automatic prefix cache would: cached_tokens = the longest prefix the run's request before it sent. */
function startUpstream() {
  const posts = [];
  let prev = null, readBack = null;
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ models: [] })); }
      let body = null; try { body = JSON.parse(raw); } catch (_) { body = {}; }
      const main = Array.isArray(body.tools) && body.tools.length > 0 && JSON.stringify(body.input || []).indexOf(MARK) >= 0;
      let reply = { text: 'ok' }, usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 3, total_tokens: Math.ceil(raw.length / 4) + 3 };
      if (main) {
        const segs = segsOf(body);
        let k = 0, read = 0;
        if (prev) while (k < segs.length && k < prev.length && segs[k] === prev[k]) { read += segs[k].length; k++; }
        const total = segs.reduce((a, s) => a + s.length, 0);
        prev = segs;
        const n = posts.length + 1;
        usage = { input_tokens: Math.ceil(total / 4), output_tokens: 7, total_tokens: Math.ceil(total / 4) + 7, input_tokens_details: { cached_tokens: Math.floor(read / 4) } };
        posts.push({ n, body, hit: k, usage, session: req.headers.session_id || '' });
        const tool = (body.tools.map(t => t && t.name).filter(Boolean).find(name => /^fs[._]read$/.test(name))) || 'fs_read';
        const outs = outputsOf(body);
        const chainDone = outs.length >= FILES;
        if (!chainDone) reply = { call: { name: tool, input: { path: 'chain/f' + (outs.length + 1) + '.txt' } } };
        else if (!readBack) {
          // every file is read: ask for one aged result back through the handle its stub names (none aged: just answer)
          const stub = outs.find(it => String(it.output).indexOf(RESULT_STUB) === 0);
          const at = stub ? handleOf(String(stub.output)) : null;
          if (at) { readBack = { callId: 'call_' + n, agedCallId: stub.call_id, path: at }; reply = { call: { name: tool, input: { path: at } } }; }
          else reply = { text: 'DONE: every file is read.' };
        } else reply = { text: 'DONE: every file is read.' };
        if (reply.call) reply.call.id = 'call_' + n;
      }
      const ev = reply.call
        ? [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: reply.call.id, name: reply.call.name } },
          { type: 'response.function_call_arguments.delta', output_index: 0, delta: JSON.stringify(reply.call.input) },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: reply.call.id } }]
        : [{ type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant' } },
          { type: 'response.output_text.delta', output_index: 0, delta: reply.text },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message' } }];
      ev.push({ type: 'response.completed', response: { status: 'completed', usage } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(ev.map(line).concat(['data: [DONE]', '']).join(NL));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    base: 'http://127.0.0.1:' + server.address().port, posts, readBack: () => readBack,
    close: () => new Promise(r => server.close(() => r()))
  })));
}

// no operator switch, key or price override from the shell reaches the station under test
function hermeticEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_SCOUT: '0', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_QUEST_REFRESH: '0',
    SKYNET_AUX_BUDGET: '0', STARNET_LIVE_PRICES: '0', STARNET_IPC_TOKEN: IPC }, extra);
}

async function arm(extraEnv) {
  const up = await startUpstream();
  const fixture = SidecarFixture.create({ prefix: 'sk-ageing-signin-', timeoutMs: 60000, env: hermeticEnv(extraEnv) });
  try {
    const dir = path.join(fixture.workspace, 'ab', 'chain');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= FILES; i++) fs.writeFileSync(path.join(dir, 'f' + i + '.txt'), 'step ' + i + ' of ' + FILES + NL + 'secret token: TOKEN-' + String(i).padStart(2, '0') + NL + filler('FILE ' + i, FILE_CHARS));
    // a signed-in ChatGPT account: a synthetic, unexpired access token; the endpoint arrives as the desktop hands it over
    const jwt = ['eyJhbGciOiJub25lIn0', Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url'), 'synthetic'].join('.');
    fs.mkdirSync(path.join(fixture.workspace, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'codex/tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'synthetic-refresh', auth_mode: 'device' }));
    await fixture.start();
    const pushed = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: 'codex', baseUrl: up.base + '/codex' }) });
    if (pushed.status !== 200) throw new Error('the Codex endpoint push was refused: HTTP ' + pushed.status + ' ' + (await pushed.text()).slice(0, 200));
    const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      provider: 'codex', model: MODEL, agentId: 'ab', isTask: true, placed: FLOOR, stationPlaced: FLOOR,
      messages: [{ role: 'user', content: MARK + ': in the folder chain read f1.txt to f' + FILES + '.txt with the file read tool, one file a turn, in order, then say DONE.' }] }) });
    const text = await r.text();
    const events = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const lines = file => { try { return fs.readFileSync(path.join(fixture.workspace, file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch (_) { return []; } };
    return { status: r.status, events, posts: up.posts, readBack: up.readBack(), output: String(fixture.output() || ''),
      ledger: lines('ledger.jsonl'), receipts: lines(path.join('.usage', 'calls.jsonl')) };
  } finally {
    await fixture.dispose();
    await up.close();
  }
}
const endOf = run => (run.events.findLast(e => e.name === 'agent.run.end') || {}).payload || {};
const agedNotes = run => run.output.split(/\r?\n/).filter(l => l.indexOf('loop.historyEdit.aged') >= 0);

(async () => {
  // ================= batched ageing ON, the sign-in switch absent: a sign-in never ages =================
  const off = await arm({ STARNET_BATCHED_AGEING: '1' });
  A.eq([off.status, endOf(off).reason], [200, 'done'], 'ageing only: the run on the ChatGPT sign-in finishes (' + String((off.events.find(e => e.name === 'agent.run.error') || { payload: {} }).payload.message || '').slice(0, 200) + ')');
  A.ok(off.posts.length >= FILES + 1, 'ageing only: the chain ran through the sign-in\'s endpoint (' + off.posts.length + ' requests)');
  A.eq([off.posts.reduce((a, p) => a + stubCount(p.body), 0), agedNotes(off).length, off.readBack], [0, 0, null], 'ageing only: no request carries a stub and no batch is noted: a sign-in route never ages without its own switch');
  A.ok(off.posts.every((p, k) => k === 0 || p.hit === segsOf(off.posts[k - 1].body).length), 'ageing only: every request extends the one before it (the prefix is never edited)');

  // ================= both switches: the sign-in ages, weighed by proxy =================
  const on = await arm({ STARNET_BATCHED_AGEING: '1', STARNET_AGEING_SIGNIN: '1' });
  A.eq([on.status, endOf(on).reason], [200, 'done'], 'both: the run finishes (' + String((on.events.find(e => e.name === 'agent.run.error') || { payload: {} }).payload.message || '').slice(0, 200) + ')');
  const stubsAt = on.posts.map(p => stubCount(p.body));
  const batchAt = on.posts.filter((p, k) => k > 0 && stubsAt[k] > stubsAt[k - 1]).map(p => p.n);
  A.ok(batchAt.length >= 2, 'both: old results leave the request view in batches (stubs first appear at requests ' + JSON.stringify(batchAt) + ')');
  A.ok(batchAt.every((n, k) => n > 13 && (k === 0 || n - batchAt[k - 1] >= 2)), 'both: none before the run is projected past 24 requests, never on two requests in a row');
  A.ok(stubsAt.every((c, k) => k === 0 || c >= stubsAt[k - 1]), 'both: an aged result stays aged');
  const notes = agedNotes(on);
  A.eq(notes.length, batchAt.length, 'both: the station\'s console notes each batch (' + notes.length + ')');
  A.ok(notes.length > 0 && notes.every(l => /freed x read 0\.1 against \d+ re-written from message \d+ x \(write 1\.25 - read\) on gpt-5\.5; SIGN-IN PROXY: this route is a sign-in plan that publishes no cache weights/.test(l)),
    'both: each note says the batch was weighed at read 0.1 and write 1.25 as a sign-in proxy: ' + String(notes[0] || '').slice(0, 420));
  // on a batch request the cache read stops at the first newly aged result, and the cache route never moves
  const firstChanged = (b, before) => 1 + (b.input || []).findIndex((it, i) => JSON.stringify(it) !== JSON.stringify((before.input || [])[i]));
  A.ok(batchAt.every(n => on.posts[n - 1].hit === firstChanged(on.posts[n - 1].body, on.posts[n - 2].body)), 'both: on each batch request the upstream\'s cache read stops at the first aged result');
  A.ok(on.posts.every(p => p.session && p.session === on.posts[0].session && p.session === p.body.prompt_cache_key), 'both: every request names the same cache route, batches included');
  // the handle: the model asked for one aged result back, and the real fs.read returned the body the stub replaced
  const rb = on.readBack;
  A.ok(!!rb && /\.output[\\/]/.test(String(rb && rb.path)), 'both: a stub names a saved file (' + (rb && rb.path) + ')');
  if (rb) {
    const whole = on.posts.map(p => outputsOf(p.body).find(it => it.call_id === rb.agedCallId)).filter(Boolean).map(it => String(it.output)).find(o => o.indexOf(RESULT_STUB) !== 0) || '';
    const back = on.posts.map(p => outputsOf(p.body).find(it => it.call_id === rb.callId)).filter(Boolean).map(it => String(it.output))[0] || '';
    A.ok(whole.length >= FILE_CHARS && back.indexOf(whole) === 0, 'both: read through the real fs.read, the handle returns the exact body the stub replaced (' + whole.length + ' characters, ' + back.length + ' returned)');
  }
  // the saving on the wire, in the upstream's own counts
  const sum = (run, f) => run.posts.slice(0, FILES + 1).reduce((a, p) => a + f(p.usage), 0);
  const inOff = sum(off, u => u.input_tokens), inOn = sum(on, u => u.input_tokens);
  const cachedOff = sum(off, u => u.input_tokens_details.cached_tokens), cachedOn = sum(on, u => u.input_tokens_details.cached_tokens);
  const weight = (i, c, r) => (i - c) + c * r;
  A.ok(inOn < inOff && weight(inOn, cachedOn, 0.1) < weight(inOff, cachedOff, 0.1), 'both: the first ' + (FILES + 1) + ' requests carry fewer input tokens (' + inOn + ' vs ' + inOff + ') and less plan weight at the list 0.10x read ('
    + Math.round(weight(inOn, cachedOn, 0.1)) + ' vs ' + Math.round(weight(inOff, cachedOff, 0.1)) + ')');
  console.log('  [e2e] ' + (FILES + 1) + ' requests on the ChatGPT sign-in through the real sidecar: input tokens ' + inOff + ' off, ' + inOn + ' on; of them cached ' + cachedOff + ' off, ' + cachedOn + ' on; batches at requests ' + JSON.stringify(batchAt));

  // ================= billing: a sign-in run books $0, with the proxy or without =================
  for (const [name, run] of [['ageing only', off], ['both', on]]) {
    const costs = run.events.filter(e => e.name === 'agent.cost' || e.name === 'cost.estimate');
    A.ok(costs.length > FILES && costs.every(e => !e.payload.usd), name + ': every cost event of the run says $0 (' + costs.length + ' events)');
    A.ok(!endOf(run).usd, name + ': the run ends at $0');
    const row = run.ledger.findLast(x => x.model === MODEL);
    A.ok(!!row && !row.usd && row.unmetered === true, name + ': the ledger row is a sign-in run at $0 (' + JSON.stringify(row && { usd: row.usd, unmetered: row.unmetered }) + ')');
    const mine = run.receipts.filter(x => x.provider === 'codex' && x.model === MODEL);
    A.ok(mine.length >= FILES + 1 && mine.every(x => typeof x.uncachedIn === 'number' && typeof x.cacheRead === 'number'), name + ': every call left a usage receipt with its uncached input and cache read (' + mine.length + ')');
    A.ok(mine.every(x => !Object.keys(x).some(k => /usd|price|cost|rate|proxy/i.test(k))), name + ': no receipt carries a dollar figure, a price or a rate');
  }
  // the receipts are the check a station owner runs: the same counts the upstream reported, call by call
  {
    const runId = ((on.events.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
    const mine = on.receipts.filter(x => x.provider === 'codex' && x.model === MODEL && x.runId === runId).slice(0, FILES + 1);
    A.eq(mine.map(x => [x.uncachedIn + x.cacheRead, x.cacheRead]), on.posts.slice(0, FILES + 1).map(p => [p.usage.input_tokens, p.usage.input_tokens_details.cached_tokens]), 'both: the run\'s receipts (.usage/calls.jsonl) hold the upstream\'s counts call by call');
    const k = batchAt[0] - 1;
    A.ok(mine[k] && mine[k - 1] && mine[k].uncachedIn > 4 * mine[k - 1].uncachedIn && mine[k + 1].cacheRead < mine[k - 1].cacheRead,
      'both: the first batch shows in the receipts: one call re-processes more uncached input (' + (mine[k] && mine[k].uncachedIn) + ' vs ' + (mine[k - 1] && mine[k - 1].uncachedIn) + '), and the calls after it read less from the cache ('
      + (mine[k + 1] && mine[k + 1].cacheRead) + ' vs ' + (mine[k - 1] && mine[k - 1].cacheRead) + ')');
  }
  A.report('batched-ageing.signin.e2e.test');
})().catch(e => { console.log('FAIL: batched-ageing.signin.e2e.test threw -- ' + (e && e.stack || e)); process.exit(1); });
