'use strict';
// #24: a linked zero balance must not change the payer for BYOK child or media runs.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
(async () => {
  const calls = []; let mode = 'direct';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url.includes('/balance')) return res.end(JSON.stringify({ balanceUsd: 0 }));
    if (req.url.includes('/history')) return res.end(JSON.stringify({ entries: [] }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    calls.push({ url: req.url, auth: req.headers.authorization });
    const body = JSON.parse(raw || '{}');
    if (body.modalities?.includes('image')) return res.end(JSON.stringify({ choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,' + PNG } }] } }], usage: { cost: 0 } }));
    const results = (body.messages || []).filter(m => m.role === 'tool');
    const worker = (body.messages || []).some(m => m.role === 'system' && String(m.content).includes('BYOK_WORKER'));
    let call;
    if (!results.length && mode === 'delegation' && !worker) call = { name: 'team_dispatch', args: { workers: [{ agentId: 'worker', prompt: 'Reply with a short greeting.' }] } };
    if (!results.length && mode === 'image') call = { name: 'image_generate', args: { prompt: 'a blue cube', path: 'images/byok.png' } };
    const delta = call ? { tool_calls: [{ index: 0, id: 'proof', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { content: 'Hello from the configured provider.' };
    res.setHeader('Content-Type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 4, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 30000, env: {
    STARNET_CLOUD_URL: base, STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '',
    STARNET_OPENROUTER_KEY: 'byok-fixture', SKYNET_OPENROUTER_KEY: 'byok-fixture',
    STARNET_OPENROUTER_BASE: base + '/byok/v1', SKYNET_OPENROUTER_BASE: base + '/byok/v1',
    STARNET_FULL_ACCESS: '1', SKYNET_FULL_ACCESS: '1', SKYNET_AUX_BUDGET: '0'
  } });
  try {
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets/credits.json'), JSON.stringify({ url: base, deviceToken: 'managed-fixture', accountId: 'fixture', linkedAt: Date.now() }));
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [
      { agentId: 'agent', provider: 'openrouter', model: 'test/model', approvalMode: 'full' },
      // Stale provider with no pinned model must still follow the lead.
      { agentId: 'worker', provider: 'starnet', model: '', system: 'BYOK_WORKER', approvalMode: 'full' }
    ] });
    for (const round of [0, 1]) {
      if (round) await fixture.restart();
      for (mode of ['direct', 'delegation', 'image']) {
        calls.length = 0;
        const r = await fixture.json('POST', '/api/run', { provider: 'openrouter', model: 'test/model', agentId: 'agent', isTask: true, placed: ['studio'], messages: [{ role: 'user', content: mode === 'image' ? 'Generate an image of a blue cube.' : 'Reply with a short greeting.' }] });
        const events = r.text.split('\n').filter(Boolean).map(JSON.parse);
        assert.equal(events.filter(e => e.name === 'agent.run.end' && e.payload.agentId === 'agent').at(-1)?.payload.reason, 'done', mode + ': ' + r.text);
        assert.ok(calls.length, mode + ' reached the upstream');
        assert.ok(calls.every(c => c.auth === 'Bearer byok-fixture' && c.url.startsWith('/byok/')), JSON.stringify(calls));
        if (mode === 'delegation') assert.equal(events.find(e => e.name === 'agent.run.end' && e.payload.agentId === 'worker')?.payload.reason, 'done', 'the child run must succeed, not merely emit a terminal');
        if (mode === 'image') assert.equal(fs.readFileSync(path.join(fixture.workspace, 'agent/images/byok.png')).toString('base64'), PNG);
      }
    }
    calls.length = 0; mode = 'direct';
    const managed = await fixture.json('POST', '/api/run', { provider: 'starnet', model: 'test/model', agentId: 'agent', messages: [{ role: 'user', content: 'Hello' }] });
    assert.match(managed.text, /Out of managed credit/);
    assert.equal(calls.filter(c => c.auth === 'Bearer managed-fixture' && c.url.includes('/chat/completions')).length, 0, 'actual managed runs remain blocked without credit');
    console.log('byok-linked-credit: OK — direct, delegation, images, restart and managed refusal');
  } finally { await fixture.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
