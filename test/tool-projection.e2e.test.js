'use strict';
// Real sidecar + captured Ollama wire + real filesystem. No external inference.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const WM = require('../frontend/app/worldmodel.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
(async () => {
  let calls = [], filename = '', sequence = 0;
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
      if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [], models: [] })); }
      const body = JSON.parse(raw), names = (body.tools || []).map(t => t.function.name);
      calls.push(names);
      const result = (body.messages || []).some(m => m.role === 'tool');
      const write = names.includes('fs_write') && !result;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: write ? { tool_calls: [{ index: 0, id: 'write_probe', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: filename, content: 'projection proof' }) } }] } : { content: 'Projection complete.' }, finish_reason: write ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 20000, env: { STARNET_FULL_ACCESS: '0', SKYNET_FULL_ACCESS: '0' } });
  try {
    fs.writeFileSync(path.join(fixture.workspace, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: ['cabinet:write'], meta: {} }));
    await fixture.start();
    const station = WM.create();
    assert.ok(station.addProp({ t: 'war_intelcab', x: 2, y: 2, w: 1, h: 2 }).ok);
    const save = async () => {
      const r = await fixture.json('POST', '/api/save', { schema: 'starnet.save', version: 5, updatedAt: Date.now(), agent: { id: 'agent' }, station: station.serialize() });
      assert.equal(r.body.ok, true, r.text);
    };
    const roster = async (profile = 'station-gear', approvalMode = 'ask') => {
      const r = await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'Probe', provider: 'ollama', model: 'qwen3:14b', approvalMode, executionProfile: profile }] });
      assert.equal(r.status, 200, r.text);
    };
    const row = v => v.toolsets.find(t => t.id === 'cabinet');
    const view = async (query = '') => (await fixture.json('GET', '/api/toolsets' + query)).body;
    const run = async (model, extra, expected) => {
      calls = []; filename = 'projection-' + (++sequence) + '.txt';
      const r = await fixture.json('POST', '/api/run', { agentId: 'agent', provider: 'ollama', model, baseUrl, isTask: true, internal: true, messages: [{ role: 'user', content: 'Write the requested fixture file.' }], ...extra });
      assert.equal(r.status, 200, r.text);
      assert.ok(calls.length, 'provider actually received a request');
      assert.equal(calls[0].includes('fs_write'), expected, model + ' file projection');
      assert.ok(calls[0].includes('task_create'), 'lead orchestration stays projected');
      const events = r.text.trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
      const end = events.find(e => e.name === 'agent.run.end');
      assert.equal(end?.payload.reason, 'done', r.text);
      assert.equal(fs.existsSync(path.join(fixture.workspace, 'agent', filename)), expected, 'real file creation follows grant');
      if (expected) assert.equal(fs.readFileSync(path.join(fixture.workspace, 'agent', filename), 'utf8'), 'projection proof');
      const diag = (await fixture.json('GET', '/api/diagnostics')).body;
      assert.equal(diag.report.lastRun.runId, end.payload.runId, 'diagnostics correlates the completed run');
      return end.payload.runId;
    };
    await save(); await roster();
    // Regression: a saved cabinet was previously dropped when placed was omitted.
    await run('qwen3:14b', {}, true);
    assert.equal(row(await view()).available, true, 'default selects the actual primary agent and saved floor');
    assert.equal(row(await view('?agentId=agent')).available, true, 'agentId alias selects actual authority');
    assert.equal((await view()).toolsets.find(t => t.id === 'orchestrator').grantSource, 'lead run', 'lead runtime grant disclosed');
    assert.equal(row(await view('?placed=')).available, false, 'explicit empty disclosure overrides saved floor');
    await run('qwen3:14b', { placed: [] }, false);
    for (const model of ['qwen3:14b', 'qwen3:30b-a3b']) {
      await roster('trusted-project');
      await run(model, { placed: [] }, true);
      await fixture.json('POST', '/api/toolsets/cabinet', { enabled: false });
      await run(model, {}, false);
      await roster('trusted-project', 'full');
      await run(model, { placed: [] }, true);
      await fixture.json('POST', '/api/toolsets/cabinet', { enabled: true });
      await roster();
    }
    await fixture.restart();
    const lastRun = await run('qwen3:30b-a3b', {}, true);
    await fixture.restart();
    assert.equal((await fixture.json('GET', '/api/diagnostics')).body.report.lastRun.runId, lastRun, 'history survives restart');
    const prop = station.props().find(p => p.t === 'war_intelcab');
    assert.ok(prop); station.removeProp(prop.id); await save();
    await run('qwen3:30b-a3b', {}, false);
    assert.equal(row(await view()).available, false, 'saved removal revokes disclosure');
    assert.equal((await fixture.json('GET', '/api/toolsets?agentId=missing')).status, 404);
    assert.equal((await fixture.json('GET', '/api/toolsets?agent=agent&agentId=missing')).status, 400);
    console.log('tool-projection.e2e: OK (10 real runs, file writes, both model IDs, revocation and restart)');
  } finally { await fixture.dispose(); await new Promise(r => upstream.close(r)); }
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
