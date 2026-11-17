'use strict';
// Lane T9s, through a REAL sidecar: the page's own answer to "is this a task?" (Classify.isTaskDirective with the agent's last
// turn, exactly as chat.js sends it on POST /api/run) decides whether the run carries tool definitions on the provider wire.
//   a result line, then "ok"           -> chat: one request, no tool definitions
//   a stated offer, then "yes please"  -> task: the request carries the tool definitions
// T9s must-fix (2026-11-16): a hedged refusal ("I don't think I can ..."), a condition ("I'd need the API key before I can run it.")
// and a marked word ("I *wish* I could ..."), then "ok" -> chat, through BOTH doors: the desk, and a channel (POST /api/dev/inbound),
// where a real channel hub classifies the reply itself with the agent's last turn from that chat's own history. The model answers
// these with a promise, so a wrong task would show twice on the wire: the tool definitions, and the extra requests a promise draws.
// The unit table is test/classify-declared-offer.test.js; this one proves the answer reaches the wire. No live model: a loopback upstream.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { isTaskDirective } = require('../frontend/app/classify.js');

const PROMISE = "Great. I'll check the build again tomorrow.";
// [the agent's last turn, the Commander's reply, expect a task, the model's answer (default "Understood.")]
const CASES = [
  ['Glad I could fix that for you.', 'ok', false],
  ['I can only describe the steps, I have no way to run them.', 'ok', false],
  ['I can now see the build is green.', 'yes', false],
  ['I can search the web for the latest numbers.', 'yes please', true],
  ['I can draft the email for you. Just say the word.', 'yes please', true],
  ['I can write that script for you.', 'yes thanks', true],
  ["I don't think I can open that drive from here.", 'ok', false, PROMISE],
  ["I'd need the API key before I can run it.", 'ok', false, PROMISE],
  ['I *wish* I could run that for you.', 'ok', false, PROMISE]
];
// the channel door: the three must-fix rows again, and a stated offer, which proves the hub reads the agent's last turn ("yes
// please" alone is chat, so only the agent's offer in the chat's history can make it a task)
const HUB_CASES = CASES.slice(-3).concat([['I can search the web for the latest numbers.', 'yes please', true]]);
const textOf = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : ((p && p.text) || ''))).join('') : '');

(async () => {
  const wires = [], hubWires = [];
  const answers = new Map(CASES.filter(c => c[3]).map(c => [c[0], c[3]]));
  let planting = '';     // the channel door: the agent's turn the model gives next
  let hubPrior = null;   // the channel door: the agent's turn whose reply is on the wire now
  const upstream = http.createServer(async (req, res) => {
    req.setEncoding('utf8');
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!raw) return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 128000, supported_parameters: ['tools'] }] }));
    if (req.url.endsWith('/api/show')) return res.end(JSON.stringify({ model_info: { 'x.context_length': 131072 }, capabilities: ['completion', 'tools'] }));
    const body = JSON.parse(raw);
    if (body.messages?.some(m => m.role === 'system' && String(m.content).includes('OFFER_E2E_IDENTITY'))) wires.push(body);
    const said = (body.messages || []).filter(m => m.role === 'assistant').map(m => textOf(m.content));
    if (hubPrior !== null && said.includes(hubPrior)) hubWires.push(body);
    const answer = planting || answers.get(said[said.length - 1]) || 'Understood.';
    if (req.url.endsWith('/api/chat')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      return res.end(JSON.stringify({ message: { role: 'assistant', content: answer }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 }) + '\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const baseUrl = origin + '/v1';
  // the desk door's station: the page classifies, and sends isTask on POST /api/run
  const fixture = new SidecarFixture({ env: { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1' } });
  // the channel door's station: a real channel hub (the DEV channel, a hub with no bot server behind it) classifies the reply itself.
  // No roster: the hub runs on the environment's wire, which is this upstream (a roster agent's own wire is not).
  const hub = new SidecarFixture({ prefix: 'offer-e2e-hub-', env: { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_DEV: '1', STARNET_DEV: '1',
    SKYNET_OPENROUTER_BASE: origin + '/api/v1', STARNET_OPENROUTER_BASE: origin + '/api/v1', SKYNET_OPENROUTER_KEY: 'sk-or-v1-offer-e2e-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-offer-e2e-fake',
    SKYNET_DEFAULT_MODEL: 'fixture-model', STARNET_DEFAULT_MODEL: 'fixture-model',
    // no background learning passes: their own model calls would land between the doors, and in the request count
    SKYNET_SKILL_REVIEW: '0', STARNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', STARNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', STARNET_THREAD_MINE: '0',
    SKYNET_SCOUT: '0', STARNET_SCOUT: '0', SKYNET_QUEST_REFRESH: '0', STARNET_QUEST_REFRESH: '0',
    STARNET_CLOUD_URL: 'http://127.0.0.1:9', STARNET_CREDITS_URL: '', STARNET_LIVE_PRICES: '0' } });   // no account service: an empty cloud URL means the default one
  try {
    await Promise.all([fixture.start(), hub.start()]);   // the two stations boot side by side
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'Lead', system: 'Lead identity', provider: 'ollama', model: 'fixture-model' }] });
    let n = 0;
    for (const [prior, reply, wantTask] of CASES) {
      wires.length = 0;
      const isTask = isTaskDirective(reply, { priorAgentTurn: prior });
      assert.equal(isTask, wantTask, 'the classifier answer for ' + JSON.stringify(prior) + ' then ' + JSON.stringify(reply));
      const response = await fixture.json('POST', '/api/run', {
        provider: 'ollama', baseUrl, model: 'fixture-model', agentId: 'agent', streamId: 'offer-e2e-' + (n++),
        system: 'OFFER_E2E_IDENTITY: answer briefly.', isTask,
        messages: [{ role: 'user', content: 'help me with the build' }, { role: 'assistant', content: prior }, { role: 'user', content: reply }]
      });
      assert.equal(response.status, 200, response.text);
      const events = response.text.trim().split('\n').map(line => JSON.parse(line));
      const end = events.findLast(event => event.name === 'agent.run.end');
      assert.equal(end?.payload.reason, 'done', response.text);
      assert.equal(wires.length, 1, 'one provider request for ' + JSON.stringify(prior));
      const tools = (wires[0].tools || []).length;
      if (wantTask) assert.ok(tools > 0, 'a yes to a stated offer carries the tool definitions: ' + JSON.stringify(prior) + ' -> ' + tools);
      else assert.equal(tools, 0, 'a reply to a result line or a refusal carries no tool definitions: ' + JSON.stringify(prior) + ' -> ' + tools);
    }

    // the channel door, one chat a row
    let c = 0;
    for (const [prior, reply, wantTask, answer] of HUB_CASES) {
      const chatId = 'offer-hub-' + (c++);
      // "hello" is chat, and the model's answer to it is the agent's last turn in this chat's history
      planting = prior;
      const planted = await hub.json('POST', '/api/dev/inbound', { chatId, text: 'hello' });
      planting = '';
      assert.equal(planted.status, 200, planted.text);
      assert.deepEqual(planted.body.replies, [prior], 'the chat holds the agent\'s turn ' + JSON.stringify(prior) + ': ' + planted.text);
      hubWires.length = 0;
      hubPrior = prior;
      const answered = await hub.json('POST', '/api/dev/inbound', { chatId, text: reply });
      hubPrior = null;
      assert.equal(answered.status, 200, answered.text);
      const tools = (hubWires[0]?.tools || []).length;
      if (wantTask) assert.ok(tools > 0, 'on a channel, a yes to a stated offer carries the tool definitions: ' + JSON.stringify(prior) + ' -> ' + tools);
      else assert.equal(tools, 0, 'on a channel, ' + JSON.stringify(reply) + ' after a refusal carries no tool definitions: ' + JSON.stringify(prior) + ' -> ' + tools);
      assert.equal(hubWires.length, 1, 'one provider request for ' + JSON.stringify(reply) + ' after ' + JSON.stringify(prior) + ' on a channel');
      assert.deepEqual(answered.body.replies, [answer || 'Understood.'], 'the channel shows the model\'s answer: ' + answered.text);
    }
    console.log('classify-declared-offer.e2e: PASS (' + CASES.length + ' exchanges at the desk and ' + HUB_CASES.length + ' on a channel, through a real sidecar: result lines, refusals and hedged refusals stay chat, stated offers get tools)');
  } finally {
    await Promise.all([fixture.dispose(), hub.dispose()]);
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
