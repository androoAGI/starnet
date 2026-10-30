/* node test/toolsets-preview-equals-run.e2e.test.js — GET /api/toolsets previews the run it names, exactly (authority-census).

   The lane's done-means: "/api/toolsets equals the captured provider tool list". The TOOLSETS readout used to describe
   capability FAMILIES (effectiveToolsets: granted by a prop / the profile / Full Access), while the run later applied the
   run authority, availability, crew and connector deferral and its own internal controls — so no readout could promise
   what the model would be offered (a5 R5, Q8). Its `run` section now names ONE context — a task the Commander sends this
   agent from COMMS (desktop lead, interactive, a Task Brief, first turn) on a placement — and is decided by the same
   ProjectTools.projectTools that run calls. This test asks for that preview, then sends that very task through the real
   /api/run with a scripted provider and compares the preview's advertised list with the tool list the provider actually
   received, name for name (after the wire's dot -> underscore mapping). Deferred stays deferred: never on the wire, still
   listed. The family rows are unchanged beside it. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

function startCapturingProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Looked.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

async function runTask(fixture, placed) {
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-preview-fake', provider: 'openrouter', model: 'test/model', agentId: 'scout',
      streamId: 'preview-' + Date.now(), isTask: true, placed,
      messages: [{ role: 'user', content: 'List what is in my project folder and summarize it.' }]
    })
  });
  A.eq(response.status, 200, 'the real /api/run admitted the task');
  const reader = response.body.getReader();
  for (;;) { const { done } = await reader.read(); if (done) break; }
}

(async () => {
  const provider = await startCapturingProvider();
  const fixture = SidecarFixture.create({
    prefix: 'sk-preview-',
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-preview-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-preview-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_FULL_ACCESS: '0'
    }
  });
  try {
    await fixture.start();
    const seeded = await fixture.json('POST', '/api/roster', {
      updatedAt: 100, agents: [{ agentId: 'scout', system: 'You are SCOUT.', name: 'SCOUT', provider: 'openrouter', model: 'test/model', approvalMode: 'ask' }]
    });
    A.ok(seeded.body && seeded.body.ok === true, 'SCOUT runs in ASK');

    for (const placed of [['workbench', 'dish', 'cabinet'], []]) {
      const label = placed.length ? placed.join('+') : 'nothing placed';
      const view = (await fixture.json('GET', '/api/toolsets?agent=scout&placed=' + placed.join(','))).body;
      A.ok(Array.isArray(view.toolsets) && view.toolsets.length > 0, label + ': the family rows are still there');
      const run = view.run || {};
      A.eq(run.context && run.context.origin, 'desktop-comms', label + ': the preview names the run it describes (a COMMS task)');
      A.eq(run.context && run.context.role, 'lead', label + ': ...as the lead');
      A.eq(run.context && run.context.placement, 'query', label + ': ...on the placement this request named');
      A.ok(Array.isArray(run.assumes) && run.assumes.length >= 1, label + ': the facts only one request carries are named, never guessed');
      A.ok(Array.isArray(run.advertised) && run.advertised.length > 0 && Array.isArray(run.deferred), label + ': advertised and deferred are listed apart');

      const before = provider.requests.length;
      await runTask(fixture, placed);
      const first = provider.requests[before];
      A.ok(first && Array.isArray(first.tools), label + ': the provider received the run\'s tool list');
      const wire = (first.tools || []).map(t => t.function && t.function.name).filter(Boolean).sort();
      const previewed = run.advertised.map(n => String(n).replace(/\./g, '_')).sort();
      A.eq(previewed, wire, label + ': GET /api/toolsets advertised EQUALS the provider\'s tool list, name for name');
      const onWire = new Set(wire);
      A.ok(run.deferred.every(n => !onWire.has(String(n).replace(/\./g, '_'))), label + ': a deferred tool is never on the wire (tool_search reveals it)');
      for (const n of run.advertised) A.ok(run.rows && run.rows[n] && run.rows[n].state === 'advertised', label + ': ' + n + ' has its row, advertised');
    }
  } finally {
    await fixture.dispose();
    provider.server.close();
  }
  A.report('toolsets-preview-equals-run.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
