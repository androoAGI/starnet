/* node test/worker-prefix.e2e.test.js — THE WORKER PREFIX (cost lane W1.10, 2026-11-09), through the REAL request assembly
   of a hermetic sidecar.

   A delegated worker's system prompt is the prefix every provider reads from cache: the Codex route is a hash of its
   stable prefix, claude-cli and OpenRouter cache it, the Claude API anchors it. The worker's TASK CONTEXT (its lead's
   Task Brief, whose <task_brief id="tb_<lead run id>"> is per-run; the Commander evidence; the lead's query-ranked recall;
   the Commander's taste) changes with every dispatch, and it used to be appended to the worker's identity, so two
   dispatches to one agent never shared a cached prefix and the first call of each paid the whole system cold.

   1. Two foreground dispatches to ONE agent from two lead turns with different tasks: the worker's system prompt, its
      cached prefix (the Claude cache split on the wire) and its Codex cache route are BYTE-IDENTICAL, and none of them
      carries a tb_ id, the lead's request or its recalled memory. The fixed [DELEGATED EXECUTION] line stays there.
   2. The task context still reaches the worker in full, in its opening message: the <run_context> note carries the
      [TASK CONTEXT] block with that lead turn's own <task_brief id="tb_<lead run>">, its ORIGINAL REQUEST and the lead's
      pinned memory, exactly once in the request; the worker's own words (its subtask) are unchanged.
   3. A structured-result REPAIR (outputOnly: its system stays verbatim, it has no run-context note) still receives the
      [TASK CONTEXT] block, at the end of its system prompt.
   4. STARNET_STABLE_PREFIX=0 (the old single system prompt): the context rides the system prompt's per-run tail, AFTER the
      cached prefix, so the prefix is still byte-identical across the two dispatches.
   No external inference: a mock OpenRouter upstream records every body. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { hostNotes, runContextOf, userWords } = require('./helpers/host-notes.js');
const { makeCodexProvider } = require('../sidecar/providers/codex.js');

const HOST = '127.0.0.1';
const LEAD_MARK = 'WORKER_PREFIX_LEAD';
const WORKER_MARK = 'WORKER_PREFIX_WORKER';
const PINNED_MARK = 'WP_PINNED_MEMORY_MARK';
const ASK_ONE = 'WP_ASK_ONE: research the tide tables for Friday and summarize them.';
const ASK_TWO = 'WP_ASK_TWO: write a granite haiku as strict JSON.';
const TASK_ONE = 'WP_WORKER_TASK_ONE: list three facts about tides.';
const TASK_TWO = 'WP_WORKER_TASK_TWO: draft a haiku about granite.';
const WORKER_MODEL = 'anthropic/claude-wp-test';   // a Claude model id: OpenRouter's cache split puts the cached prefix on the wire
const BLOCK_HEAD = '[TASK CONTEXT]\n';   // the block itself (the fixed [DELEGATED EXECUTION] line only names it: "the [TASK CONTEXT] block")
const HAIKU_SCHEMA = { type: 'object', required: ['haiku'], properties: { haiku: { type: 'string' } } };

const text = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');
const first = body => (body.messages || [])[0] || {};
const systemOf = body => first(body).role === 'system' ? text(first(body).content) : '';
// the cached prefix OpenRouter's Claude split marks: the first system part, when the system was split at cacheSystemPrefix
function cachedPrefixOf(body) {
  const c = first(body).role === 'system' ? first(body).content : null;
  return Array.isArray(c) && c.length > 1 && c[0] && c[0].cache_control ? String(c[0].text || '') : '';
}
const lastUserIdx = msgs => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') return i; return -1; };
function openingWords(body) {   // the worker's own first-turn words, wherever the Claude projection put the host notes
  for (const m of body.messages || []) if (m && m.role === 'user') { const w = userWords(m).trim(); if (w) return w; }
  return '';
}

function startUpstream() {
  const workers = [], leads = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: ['test/model', WORKER_MODEL].map(id => ({ id, context_length: 200000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] })) }));
    }
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
    const msgs = (body && body.messages) || [];
    const sys = body ? systemOf(body) : '';
    const tools = (body && Array.isArray(body.tools)) ? body.tools : [];
    const li = lastUserIdx(msgs);
    const words = li >= 0 ? userWords(msgs[li]) : '';
    const after = msgs.slice(li + 1);
    const called = after.flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
    let reply = 'ok', call = null;
    if (sys.indexOf(WORKER_MARK) >= 0) {
      workers.push(body);
      if (/\[STRUCTURED RESULT REPAIR\]/.test(words)) reply = JSON.stringify({ haiku: 'granite holds the cold' });
      else if (openingWords(body).indexOf('WP_WORKER_TASK_TWO') >= 0) reply = 'not json: granite holds the cold';   // forces the one bounded repair
      else reply = 'WORKER ONE DONE: tides rise twice a day.';
    } else if (sys.indexOf(LEAD_MARK) >= 0 && tools.length) {
      leads.push(body);
      const ask = words.indexOf('WP_ASK_ONE') >= 0 ? TASK_ONE : (words.indexOf('WP_ASK_TWO') >= 0 ? TASK_TWO : '');
      const offersProceed = tools.some(t => t.function && t.function.name === 'brief_proceed');
      // a briefed lead settles its Task Brief before the first consequential tool (team.dispatch waits on it)
      if (ask && offersProceed && called.indexOf('brief_proceed') < 0) call = { name: 'brief_proceed', args: { objective: 'Delegate the subtask to the researcher', deliverable: 'The researcher\'s answer' } };
      else if (ask && called.indexOf('team_dispatch') < 0) call = { name: 'team_dispatch', args: { workers: [ask === TASK_ONE ? { agentId: 'researcher', prompt: TASK_ONE } : { agentId: 'researcher', prompt: TASK_TWO, resultSchema: HAIKU_SCHEMA }] } };
      else reply = 'LEAD DONE: the crew finished.';
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (call) {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + leads.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    } else {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }) + '\n\n');
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, workers, leads, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' })));
}

function hermeticEnv(base, extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0',
    SKYNET_THREAD_MINE: '0', STARNET_LIVE_PRICES: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_CLOUD_URL: 'http://127.0.0.1:9',
    STARNET_BUILD_DESCRIBE: 'v0.15.0-worker-prefix', SKYNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-worker-prefix-fake',
    SKYNET_DEFAULT_MODEL: 'test/model' }, extra || {});
}

async function station(up, extraEnv) {
  const fixture = SidecarFixture.create({ prefix: 'starnet-worker-prefix-', timeoutMs: 45000, env: hermeticEnv(up.base, extraEnv) });
  // the LEAD's pinned memory: getTaskContext ranks it into the worker's task context (the lead's recall)
  fs.writeFileSync(path.join(fixture.workspace, 'agent.notebook.json'), JSON.stringify([{ id: 'mem-wp-pin', kind: 'note', title: 'Report format',
    body: PINNED_MARK + ': the Commander wants every report as three short bullets.', ts: Date.now() - 60000, pinned: true }]));
  await fixture.start();
  const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
    { agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'test/model', system: LEAD_MARK + ': You are NOVA, the lead. You coordinate the crew.' },
    { agentId: 'researcher', name: 'Ada', role: 'researcher', provider: 'openrouter', model: WORKER_MODEL, system: WORKER_MARK + ': You are Ada, the researcher.' }] });
  A.eq(roster.status, 200, 'roster saved');
  return fixture;
}

// one lead turn in the Commander's conversation: the lead dispatches the researcher, then answers
async function leadTurn(fixture, ask) {
  const r = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'wp-home',
    system: LEAD_MARK + ': You are NOVA, the lead. You coordinate the crew.', messages: [{ role: 'user', content: ask }] }) });
  A.eq(r.status, 200, 'lead run accepted: ' + ask.slice(0, 10));
  const events = (await r.text()).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  const start = events.find(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'agent');
  const end = events.filter(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'agent').pop();
  A.eq(end && end.payload && end.payload.reason, 'done', 'the lead turn completes: ' + ask.slice(0, 10));
  return (start && start.payload && start.payload.runId) || '';
}

// the Codex cache route the codex provider derives for a request with this system prompt and cached prefix
async function codexRoute(system, prefix) {
  const seen = [];
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = b64({ alg: 'none' }) + '.' + b64({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-worker-prefix' } }) + '.sig';
  const fetchFn = async (_url, init) => { seen.push(JSON.parse(init.body)); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
  const p = makeCodexProvider({ fetch: fetchFn, token });
  for await (const _ of p.stream({ model: 'gpt-5.5', cacheSystemPrefix: prefix, messages: [{ role: 'system', content: system }, { role: 'user', content: 'x' }] })) { /* drain */ }
  return seen.length ? seen[0].prompt_cache_key : '';
}

const firstCall = (workers, mark) => workers.find(b => Array.isArray(b.tools) && b.tools.length && openingWords(b).indexOf(mark) >= 0);
const count = (hay, needle) => hay.split(needle).length - 1;

(async () => {
  const up = await startUpstream();
  let fixture = null;
  try {
    // ---- 1 + 2 + 3: two dispatches to one agent, the second with a structured-result repair ----
    fixture = await station(up);
    const run1 = await leadTurn(fixture, ASK_ONE);
    const run2 = await leadTurn(fixture, ASK_TWO);
    A.ok(run1 && run2 && run1 !== run2, 'two distinct lead runs (two Task Briefs)');
    const w1 = firstCall(up.workers, 'WP_WORKER_TASK_ONE'), w2 = firstCall(up.workers, 'WP_WORKER_TASK_TWO');
    A.ok(w1 && w2, 'both dispatches reached the worker (' + up.workers.length + ' worker request(s))');
    if (w1 && w2) {
      const s1 = systemOf(w1), s2 = systemOf(w2);
      const p1 = cachedPrefixOf(w1), p2 = cachedPrefixOf(w2);
      console.log('[worker-prefix] worker first call: ' + JSON.stringify(w1).length + ' B request | ' + s1.length + ' system chars | cached prefix ' + p1.length
        + ' | tools ' + JSON.stringify(w1.tools).length + ' B | dispatch-2 system ' + (s2 === s1 ? 'IDENTICAL' : 'DIFFERS'));
      A.eq(s2, s1, 'the worker\'s system prompt is BYTE-IDENTICAL across two dispatches with different tasks');
      A.eq(JSON.stringify(w2.tools), JSON.stringify(w1.tools), 'the worker\'s tool array is byte-identical across the two dispatches');
      A.ok(p1 && s1.indexOf(p1) === 0, 'the Claude cache split marks the worker\'s cached prefix on the wire');
      A.eq(p2, p1, 'the cached prefix is byte-identical across the two dispatches');
      const r1 = await codexRoute(s1, p1), r2 = await codexRoute(s2, p2);
      A.ok(r1 && r1 === r2, 'the Codex cache route is the same for both dispatches (' + r1 + ' / ' + r2 + ')');
      for (const [s, n] of [[s1, 1], [s2, 2]]) {
        A.ok(s.indexOf('tb_') < 0 && s.indexOf('<task_brief') < 0, 'dispatch ' + n + ': no Task Brief id in the worker\'s system prompt');
        A.ok(s.indexOf('ORIGINAL REQUEST') < 0 && s.indexOf('WP_ASK_') < 0, 'dispatch ' + n + ': the lead\'s request is not in the worker\'s system prompt');
        A.ok(s.indexOf(PINNED_MARK) < 0, 'dispatch ' + n + ': the lead\'s recalled memory is not in the worker\'s system prompt');
        A.ok(s.indexOf(WORKER_MARK) === 0, 'dispatch ' + n + ': the worker\'s identity opens its system prompt');
        A.ok(s.indexOf('[DELEGATED EXECUTION] Treat the [TASK CONTEXT] block handed to you with this task as settled input from the Commander.') > 0,
          'dispatch ' + n + ': the fixed [DELEGATED EXECUTION] line names the block and stays in the system prompt');
      }
      // 2: the context reaches the worker whole, in its opening message, with the lead turn's own brief
      for (const [w, runId, ask, task, n] of [[w1, run1, ASK_ONE, TASK_ONE, 1], [w2, run2, ASK_TWO, TASK_TWO, 2]]) {
        const note = runContextOf(w.messages);
        const at = note.indexOf(BLOCK_HEAD);
        A.ok(at >= 0, 'dispatch ' + n + ': the <run_context> note in the opening message carries the [TASK CONTEXT] block');
        A.ok(note.indexOf('<task_brief id="tb_' + runId + '"') > at, 'dispatch ' + n + ': the block carries that lead turn\'s own Task Brief (tb_' + runId.slice(0, 8) + '…)');
        A.ok(note.indexOf('ORIGINAL REQUEST: ' + ask) > at, 'dispatch ' + n + ': the block carries the lead\'s original request');
        A.ok(note.indexOf(PINNED_MARK) > at, 'dispatch ' + n + ': the block carries the lead\'s recalled memory');
        // the messages include the system message: each count is over the whole request body
        A.eq(count(JSON.stringify(w.messages), 'tb_' + runId), 1, 'dispatch ' + n + ': the Task Brief id rides the request exactly once');
        A.eq(count(JSON.stringify(w.messages), PINNED_MARK), 1, 'dispatch ' + n + ': the recalled memory rides the request exactly once');
        A.ok(openingWords(w).indexOf(task) === 0, 'dispatch ' + n + ': the worker\'s own words are its subtask, unchanged');
        A.ok(openingWords(w).indexOf('[TASK CONTEXT]') < 0 && openingWords(w).indexOf('tb_') < 0, 'dispatch ' + n + ': the task context is a host note, never part of the worker\'s own words (its directive / transcript row)');
      }
      A.ok(runContextOf(w1.messages).indexOf('tb_' + run2) < 0 && runContextOf(w2.messages).indexOf('tb_' + run1) < 0, 'each dispatch carries only its own lead turn\'s brief');
      A.eq(hostNotes(w1.messages, 'run_context').length, 1, 'exactly one run-context note');
      // 3: the structured-result repair (outputOnly keeps its system verbatim and has no run-context note)
      const repair = up.workers.find(b => /\[STRUCTURED RESULT REPAIR\]/.test(JSON.stringify(b.messages || [])));
      A.ok(repair, 'the invalid structured result got its one bounded repair');
      if (repair) {
        const rs = systemOf(repair);
        const at = rs.indexOf(BLOCK_HEAD);
        A.ok(rs.indexOf(s1.slice(0, s1.indexOf('[DELEGATED EXECUTION]'))) === 0, 'the repair opens on the same worker identity');
        A.ok(at > rs.indexOf('[DELEGATED EXECUTION]') && rs.indexOf('<task_brief id="tb_' + run2 + '"') > at && rs.indexOf(PINNED_MARK) > at,
          'the repair still receives the whole [TASK CONTEXT] block (its lead turn\'s brief and recall), at the end of its system prompt');
      }
    }
    await fixture.dispose(); fixture = null;

    // ---- 4: the kill switch keeps the context out of the cached prefix too ----
    up.workers.length = 0; up.leads.length = 0;
    fixture = await station(up, { STARNET_STABLE_PREFIX: '0' });
    const k1 = await leadTurn(fixture, ASK_ONE);
    const k2 = await leadTurn(fixture, ASK_ONE.replace('Friday', 'Saturday'));
    const kw = up.workers.filter(b => Array.isArray(b.tools) && b.tools.length && openingWords(b).indexOf('WP_WORKER_TASK_ONE') >= 0);
    A.eq(kw.length, 2, 'STARNET_STABLE_PREFIX=0: both dispatches reached the worker');
    if (kw.length === 2) {
      const [a, b] = kw;
      const pa = cachedPrefixOf(a), pb = cachedPrefixOf(b);
      A.ok(pa && pa === pb, 'STARNET_STABLE_PREFIX=0: the cached prefix is still byte-identical across the two dispatches');
      A.ok(pa.indexOf('tb_') < 0 && pa.indexOf(PINNED_MARK) < 0, 'STARNET_STABLE_PREFIX=0: no Task Brief id and no recall in the cached prefix');
      for (const [w, runId, n] of [[a, k1, 1], [b, k2, 2]]) {
        const s = systemOf(w);
        A.ok(s.indexOf(BLOCK_HEAD) >= pa.length && s.indexOf('<task_brief id="tb_' + runId + '"') > s.indexOf(BLOCK_HEAD),
          'STARNET_STABLE_PREFIX=0, dispatch ' + n + ': the [TASK CONTEXT] block rides the system prompt\'s per-run tail, after the cached prefix');
        A.eq(hostNotes(w.messages, 'run_context').length, 0, 'STARNET_STABLE_PREFIX=0, dispatch ' + n + ': no run-context note');
      }
    }
  } finally {
    if (fixture) await fixture.dispose();
    await new Promise(r => up.server.close(r));
  }
  A.report('worker-prefix.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
