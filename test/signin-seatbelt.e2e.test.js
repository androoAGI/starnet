/* node test/signin-seatbelt.e2e.test.js — a sign-in run stops at a seatbelt that names its knob (spend-governor S1).

   A ChatGPT plan reports no subscription flag on its calls, and the per-run seatbelt counted only calls that did (Claude
   Code's), so a Codex, Grok or Kimi run had no ceiling at all: a ChatGPT plan burned through a day and a half of runs.

   The real sidecar, a stored ChatGPT sign-in and a stored Grok sign-in (WORKSPACES/codex|grok/tokens.json), and the
   Codex, Grok and OpenRouter endpoints pushed to one local fake through the desktop's token-gated runtime push (the
   subscription-stacking-oauth.e2e pattern: fakes at the transport edge only). STARNET_MAX_SUBSCRIPTION_TOKENS=60000.
   Every model turn of the task calls a tool and books 40,000 tokens; the fake keeps calling tools for 4 turns, then answers.
     - ChatGPT (Codex): the run ends 'budget' before its 3rd call (2 calls: 80,000 >= 60,000); agent.run.end carries
       subscriptionCapTokens 60000, and the stop text it leaves — the sentence channels and routines print
       (stop-reason.js) and the COMMS stop line (chat.js budgetStopLine) — names SIGN-IN TOKEN CEILING, and the server's
       names STARNET_MAX_SUBSCRIPTION_TOKENS too. Its ledger row is a subscription row.
     - Grok OAuth: the same.
     - An OpenRouter key with the same usage is not stopped by it: it runs to its answer, and its row is metered.
   RED at base: the Codex and Grok runs keep calling the fake until it stops sending tool calls, and no stop names a knob. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { stopSentence } = require('../sidecar/stop-reason.js');

const IPC = 'signin-seatbelt-ipc-token-1234567890abcdef';
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800, 'https://api.openai.com/profile': { email: 'plan@example.test' } })).toString('base64url') + '.fixture';
const TURNS_WITH_TOOLS = 4;
const RUNS = [
  { provider: 'codex', model: 'gpt-5.5', marker: 'SEATBELT-CODEX' },
  { provider: 'grok', model: 'grok-4', marker: 'SEATBELT-GROK' },
  { provider: 'openrouter', model: 'openai/gpt-5.5', marker: 'SEATBELT-OPENROUTER' }
];
const aid = p => 'seatbelt-' + p;

function startFake() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const route = req.url.split('/')[1];
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: RUNS.filter(r => r.provider === route).map(r => ({ id: r.model, context_length: 400000 })), models: [] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const codex = route === 'codex';
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // a background pass (title, reflection) has no tools: answer it, and keep it out of the count
      if (!(Array.isArray(body.tools) && body.tools.length)) {
        if (codex) { send({ type: 'response.output_text.delta', delta: 'ok' }); send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } }); }
        else send({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      const marker = (raw.match(/SEATBELT-[A-Z]+/) || ['?'])[0];
      const results = codex ? (body.input || []).filter(x => x && x.type === 'function_call_output').length
        : (body.messages || []).filter(m => m && m.role === 'tool').length;
      calls.push({ route, marker, results });
      const more = results < TURNS_WITH_TOOLS;
      if (codex) {
        const item = { type: 'function_call', id: 'fc_' + results, call_id: 'call_' + results, name: 'fs_list', arguments: '{}' };
        if (more) { send({ type: 'response.output_item.added', output_index: 0, item }); send({ type: 'response.output_item.done', output_index: 0, item }); }
        else send({ type: 'response.output_text.delta', delta: 'DONE ' + marker });
        send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30000, output_tokens: 10000 } } });
      } else {
        const usage = { prompt_tokens: 30000, completion_tokens: 10000, total_tokens: 40000 };
        if (route === 'openrouter') usage.cost = 0.0004;
        send({ choices: [{ delta: more ? { tool_calls: [{ index: 0, id: 'call_' + results, type: 'function', function: { name: 'fs_list', arguments: '{}' } }] } : { content: 'DONE ' + marker },
          finish_reason: more ? 'tool_calls' : 'stop' }], usage });
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: 'http://127.0.0.1:' + server.address().port })));
}

(async () => {
  const fake = await startFake();
  const env = { STARNET_IPC_TOKEN: IPC, STARNET_FULL_ACCESS: '1', STARNET_MAX_SUBSCRIPTION_TOKENS: '60000',
    STARNET_QUEST_REFRESH: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_SCOUT: '0', STARNET_THREAD_MINE: '0',
    STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  // ambient keys never reach a run here: the only key is the one pushed below
  for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY', 'CREDITS_API_KEY']) { env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = ''; }
  const fixture = SidecarFixture.create({ prefix: 'signin-seatbelt-', timeoutMs: 30000, env });
  try {
    for (const r of RUNS) {
      fs.mkdirSync(path.join(fixture.workspace, aid(r.provider)), { recursive: true });
      fs.writeFileSync(path.join(fixture.workspace, aid(r.provider), 'seatbelt-proof.txt'), 'Fixture data, not a customer file.');
    }
    fs.mkdirSync(path.join(fixture.workspace, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
    fs.mkdirSync(path.join(fixture.workspace, 'grok'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'grok', 'tokens.json'), JSON.stringify({ access_token: 'GROK-FIXTURE', refresh_token: 'grok-r', expires_at: 4102444800000, token_type: 'Bearer' }));
    await fixture.start();
    // the desktop's runtime push: a sign-in keeps its stored token, only its endpoint moves to the fake; OpenRouter gets a key
    for (const r of RUNS) {
      const res = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC },
        body: JSON.stringify({ provider: r.provider, key: r.provider === 'openrouter' ? 'or-fixture-key' : '', baseUrl: fake.base + '/' + r.provider }) });
      A.eq(res.status, 200, r.provider + ': the fake endpoint is pushed to the station');
    }
    const roster = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: RUNS.map(r => ({ agentId: aid(r.provider), name: r.provider, system: 'Inspect the station then answer.', provider: r.provider, model: r.model })) });
    A.eq(roster.status, 200, 'the agents are on the roster');

    const chat = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'chat.js'), 'utf8');
    const budgetStopLine = new Function(A.fnBody(chat, 'function budgetStopLine(') + '\nreturn budgetStopLine;')();
    const ledgerRows = () => fs.readFileSync(path.join(fixture.workspace, 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

    for (const r of RUNS) {
      const res = await fixture.json('POST', '/api/run', { agentId: aid(r.provider), provider: r.provider, model: r.model, internal: true, isTask: true,
        placed: ['computer', 'cabinet'], messages: [{ role: 'user', content: r.marker + ': inspect the station, then answer' }] });
      A.eq(res.status, 200, r.provider + ': the run streams through the real /api/run route');
      const events = String(res.text || '').split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
      const start = events.find(e => e.name === 'agent.run.start');
      const end = (events.filter(e => e.name === 'agent.run.end' && (!start || e.payload.runId === start.payload.runId)).pop() || {}).payload || {};
      const calls = fake.calls.filter(c => c.marker === r.marker);
      A.ok(events.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.ok), r.provider + ': its tool calls really ran: ' + JSON.stringify(events.filter(e => e.name === 'agent.run.error').map(e => e.payload.message)));
      const row = start ? ledgerRows().filter(x => x.runId === start.payload.runId && !x.aux).pop() : null;
      if (r.provider === 'openrouter') {
        A.eq([end.reason, calls.length, end.subscriptionCapTokens], ['done', TURNS_WITH_TOOLS + 1, undefined], 'openrouter: a key run with the same usage is not stopped by the sign-in seatbelt');
        A.eq(row && [row.billingClass, row.unmetered], ['metered', false], 'openrouter: its ledger row is metered');
        continue;
      }
      A.eq([end.reason, calls.length], ['budget', 2], r.provider + ': the run stops at the seatbelt before its 3rd call (40,000 tokens a call, a 60,000 ceiling)');
      A.eq([end.budgetScope, end.subscriptionCapTokens, end.subscriptionModel, end.subscriptionTokens], ['run', 60000, r.model, 80000], r.provider + ': agent.run.end names the ceiling, the model and how far it went');
      const server = stopSentence(end.reason, end);
      A.ok(/SIGN-IN TOKEN CEILING/.test(server) && /STARNET_MAX_SUBSCRIPTION_TOKENS/.test(server) && /60,000-token/.test(server) && !/SPENDING LIMITS/.test(server), r.provider + ': the stop channels and routines print names the knob: ' + server);
      const comms = budgetStopLine(end.budgetScope, end.budgetCapUsd, end.budgetCapIsBalance, null, { model: end.subscriptionModel, capTokens: end.subscriptionCapTokens }, end.budgetProjected);
      A.ok(/SIGN-IN TOKEN CEILING in SETTINGS › APP & BACKUP › Runtime limits/.test(comms) && /60,000-token/.test(comms), r.provider + ': the COMMS stop line names it too: ' + comms);
      A.eq(row && [row.billingClass, row.unmetered, row.usd], ['subscription', true, 0], r.provider + ': its ledger row is a $0 subscription row');
    }
  } finally {
    await fixture.dispose();
    await new Promise(r => fake.server.close(r));
  }
  A.report('signin-seatbelt.e2e.test');
})().catch(e => { console.log('FAIL: signin-seatbelt.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
