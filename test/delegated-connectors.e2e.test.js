'use strict';
// Real lead dispatch, worker run, MCP transport, permission cards and external-effect receipt.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
(async () => {
  let wire = [], effects = [], mode = 'direct';
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      if (req.method !== 'POST') return res.end(JSON.stringify({ data: [] }));
      const b = JSON.parse(raw);
      if (req.url === '/mcp') {
        const reply = result => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: b.id, result })); };
        if (b.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'crm-fixture', version: '1' } });
        if (b.method.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
        if (b.method === 'tools/list') return reply({ tools: ['read', 'write'].map(name => ({ name, description: name + ' fixture CRM record', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: name === 'read', destructiveHint: false } })) });
        if (b.method === 'tools/call') { effects.push(b.params.name); return reply({ content: [{ type: 'text', text: b.params.name + ' confirmed' }] }); }
        return reply({});
      }
      const names = (b.tools || []).map(t => t.function.name);
      const results = (b.messages || []).filter(m => m.role === 'tool');
      const specialist = /CRM_SPECIALIST/.test(JSON.stringify(b.messages));
      wire.push({ specialist, names });
      let call;
      if (mode !== 'direct' && !specialist && !results.length) call = { name: 'team_dispatch', arguments: JSON.stringify({ workers: [{ agentId: 'worker', prompt: 'Read then update the fixture CRM record.' }] }) };
      else if (specialist && results.length < 2) {
        const name = 'mcp__crm__' + (results.length ? 'write' : 'read');
        if (names.includes(name)) call = { name, arguments: '{}' };
      }
      const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + wire.length, type: 'function', function: call }] } : { content: 'Fixture finished.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 20000, env: { SKYNET_AUX_BUDGET: '0', SKYNET_OPENROUTER_BASE: base, OPENROUTER_API_KEY: 'synthetic-crm-key', SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0' } });
  async function drive(nextMode, decision = 'once') {
    mode = nextMode; wire = []; effects = [];
    const response = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token }, body: JSON.stringify({ agentId: mode === 'direct' ? 'worker' : 'agent', provider: 'openrouter', key: 'synthetic-crm-key', model: 'test/model', isTask: true, internal: true, placed: [], system: mode === 'direct' ? 'CRM_SPECIALIST' : '', messages: [{ role: 'user', content: 'Perform the fixture CRM task.' }] }) });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', leadId = ''; const events = [], prompts = [];
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl); pending = pending.slice(nl + 1); if (!line.trim()) continue;
        const event = JSON.parse(line); events.push(event);
        if (event.name === 'agent.run.start' && !leadId) leadId = event.payload.runId;
        if (event.name === 'permission.prompt') {
          prompts.push(event.payload);
          const answer = await fixture.json('POST', '/api/consent', { runId: leadId, promptId: event.payload.promptId, decision });
          assert.equal(answer.status, 200, answer.text);
        }
      }
    }
    return { events, prompts };
  }
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'LEAD', model: 'test/model', provider: 'openrouter', approvalMode: 'ask', executionProfile: 'trusted-project' },
      { agentId: 'worker', name: 'SPECIALIST', system: 'CRM_SPECIALIST', model: 'test/model', provider: 'openrouter', approvalMode: 'ask', executionProfile: 'trusted-project' }
    ] }); assert.equal(roster.status, 200, roster.text);
    const conn = await fixture.json('POST', '/api/connectors', { id: 'crm', transport: 'http', url: base + '/mcp', enabled: true });
    assert.equal(conn.status, 200, conn.text);
    const direct = await drive('direct');
    assert.deepEqual(effects, ['read', 'write'], 'direct specialist calls the connected CRM: ' + JSON.stringify({ wire: wire.map(w => ({ specialist: w.specialist, tools: w.names.filter(n => n.includes('mcp')) })), events: direct.events.filter(e => /error|end|result/.test(e.name)) }));
    assert.ok(direct.prompts.length >= 1, 'direct write approval reached the watcher');
    for (let boot = 0; boot < 2; boot++) {
      if (boot) await fixture.restart();
      const delegated = await drive('delegated');
      assert.ok(wire.some(w => w.specialist), 'real worker provider run occurred');
      assert.deepEqual(effects, ['read', 'write'], 'delegated specialist retains connected MCP tools');
      assert.ok(delegated.prompts.length >= 2, 'delegated write approval reaches the lead watcher');
      assert.ok(wire.filter(w => w.specialist).every(w => !w.names.includes('team_dispatch')), 'worker cannot recursively delegate');
    }
    await drive('delegated', 'deny');
    assert.ok(!effects.includes('write'), 'denied write never reaches MCP');
    await fixture.json('POST', '/api/connectors/remove', { id: 'crm' });
    await drive('delegated'); assert.deepEqual(effects, [], 'removed connector cannot be used by a worker');
    console.log('delegated-connectors.e2e: PASS (direct/delegated read/write, approval, denial, restart and removal)');
  } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
