'use strict';
// Real host + local provider wire: small talk, task promotion, context and restart preservation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeTaskBriefStore } = require('../sidecar/taskbrief-store.js');
const { isTaskDirective } = require('../frontend/app/classify.js');

(async () => {
  const wires = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (!raw) return res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 128000, supported_parameters: ['tools'] }] }));
    const body = JSON.parse(raw);
    if (body.messages?.some(m => m.role === 'system' && String(m.content).includes('CASUAL_SAFETY_IDENTITY'))) wires.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello, Commander.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const fixture = new SidecarFixture({ env: { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_OLLAMA_MAX_CHAT_TOKENS: '512', SKYNET_OLLAMA_MAX_TOKENS: '4096' } });
  try {
    const store = makeTaskBriefStore({ fs, path, workspaces: fixture.workspace });
    await store.prepare({ id: 'pending-brief', key: 'stream:pending-reply', text: 'Write a report', agentId: 'agent', streamId: 'pending-reply' }, Date.now());
    await store.ask('pending-brief', { mode: 'conversation', dimension: 'audience', question: 'Is this for engineers?', reason: 'Choose technical depth.', discoverable: false }, Date.now());
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', name: 'Lead', system: 'Lead identity', provider: 'ollama', model: 'fixture-model' },
      { agentId: 'worker', name: 'Worker', system: 'Worker identity', provider: 'ollama', model: 'fixture-model' }
    ] });
    const run = async (text, extra = {}) => {
      wires.length = 0;
      const response = await fixture.json('POST', '/api/run', {
        provider: 'ollama', baseUrl, model: 'fixture-model', agentId: 'agent',
        system: 'CASUAL_SAFETY_IDENTITY: Keep the conversation intact.',
        isTask: isTaskDirective(text), messages: [{ role: 'user', content: text }], ...extra
      });
      assert.equal(response.status, 200, response.text);
      const events = response.text.trim().split('\n').map(line => JSON.parse(line));
      const end = events.findLast(event => event.name === 'agent.run.end');
      assert.equal(end?.payload.reason, 'done', response.text);
      assert.equal(end.payload.finishReason, undefined, 'a clean reply remains a clean completion');
      assert.equal(wires.length, 1, 'one foreground generation for an ordinary reply');
      assert.ok(events.some(event => event.name === 'agent.token' && event.payload.delta === 'Hello, Commander.'));
      assert.ok(!('isTask' in wires[0]), 'internal classification does not leak onto the provider wire');
      return wires[0];
    };
    const small = await run('hello', { streamId: 'casual-history' });
    assert.equal(small.max_tokens, 512);
    assert.equal((small.tools || []).length, 0);
    assert.ok(!small.messages[0].content.includes('<starnet_operator_manual>'));
    assert.ok(!small.messages[0].content.includes('[ORCHESTRATION]'));
    for (const text of ['thanks', 'how are you today']) assert.equal((await run(text)).max_tokens, 512);
    assert.equal((await run('hello', { agentId: 'worker' })).max_tokens, 512, 'worker small talk has the same cap');
    const hosted = await run('hello', { provider: 'custom' });
    assert.equal(hosted.max_tokens, undefined, 'custom/hosted requests receive no local-model output cap');
    const history = [{ role: 'user', content: 'Remember the report code AZURE-739.' }, { role: 'assistant', content: 'The report code is AZURE-739.' }, { role: 'user', content: 'hello' }];
    const remembered = await run('hello', { messages: history });
    for (const row of history) assert.ok(remembered.messages.some(m => m.role === row.role && m.content === row.content), 'casual optimization retains supplied conversation context');
    const task = await run('hello, research this for me');
    assert.equal(task.max_tokens, 4096);
    assert.ok(task.tools.length > 0);
    assert.ok(task.messages[0].content.includes('<starnet_operator_manual>'));
    assert.ok(task.messages[0].content.includes('[ORCHESTRATION]'));
    // The frontend classifies yes as chat, but durable task state must promote it before applying a cap.
    const promoted = await run('yes', { streamId: 'pending-reply', isTask: false });
    assert.equal(promoted.max_tokens, 4096, 'pending clarification gets the task allowance');
    assert.ok(promoted.tools.length > 0, 'pending clarification retains tools');
    assert.ok(promoted.messages[0].content.includes('<starnet_operator_manual>'));
    const before = await fixture.json('GET', '/api/transcript?agent=agent&stream=casual-history&limit=200');
    await fixture.restart();
    const after = await fixture.json('GET', '/api/transcript?agent=agent&stream=casual-history&limit=200');
    assert.deepEqual(after.body, before.body, 'small-talk transcript survives sidecar restart exactly');
    const resumed = await run('hello again', { streamId: 'casual-history' });
    assert.equal(resumed.max_tokens, 512);
    assert.ok(resumed.messages.some(m => m.role === 'assistant' && m.content === 'Hello, Commander.'), 'restart rehydrates earlier dialogue into the provider request');
    console.log('casual-response-safety.e2e: PASS (lead/worker, hosted/local caps, context, task promotion, restart)');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
