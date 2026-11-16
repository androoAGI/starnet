'use strict';
// Lane T9s, through a REAL sidecar: the page's own answer to "is this a task?" (Classify.isTaskDirective with the agent's last
// turn, exactly as chat.js sends it on POST /api/run) decides whether the run carries tool definitions on the provider wire.
//   a result line, then "ok"           -> chat: one request, no tool definitions
//   a stated offer, then "yes please"  -> task: the request carries the tool definitions
// The unit table is test/classify-declared-offer.test.js; this one proves the answer reaches the wire. No live model: a loopback upstream.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { isTaskDirective } = require('../frontend/app/classify.js');

// [the agent's last turn, the Commander's reply, expect a task]
const CASES = [
  ['Glad I could fix that for you.', 'ok', false],
  ['I can only describe the steps, I have no way to run them.', 'ok', false],
  ['I can now see the build is green.', 'yes', false],
  ['I can search the web for the latest numbers.', 'yes please', true],
  ['I can draft the email for you. Just say the word.', 'yes please', true],
  ['I can write that script for you.', 'yes thanks', true]
];

(async () => {
  const wires = [];
  const upstream = http.createServer(async (req, res) => {
    req.setEncoding('utf8');
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!raw) return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 128000, supported_parameters: ['tools'] }] }));
    if (req.url.endsWith('/api/show')) return res.end(JSON.stringify({ model_info: { 'x.context_length': 131072 }, capabilities: ['completion', 'tools'] }));
    const body = JSON.parse(raw);
    if (body.messages?.some(m => m.role === 'system' && String(m.content).includes('OFFER_E2E_IDENTITY'))) wires.push(body);
    if (req.url.endsWith('/api/chat')) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Understood.' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 }) + '\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Understood.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const fixture = new SidecarFixture({ env: { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1' } });
  try {
    await fixture.start();
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
    console.log('classify-declared-offer.e2e: PASS (' + CASES.length + ' exchanges through a real sidecar: result lines and refusals stay chat, stated offers get tools)');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
