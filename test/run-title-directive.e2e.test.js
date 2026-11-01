/* node test/run-title-directive.e2e.test.js — a run is titled by what the Commander asked, never by a screen-capture label
   (bug e7dcb889 family, quick win 17).

   When a tool returns pixels (fs.read of a PNG, a browser screenshot), the loop appends them to the run's messages as a
   USER-role turn that opens "[BEGIN EXTERNAL SCREEN CAPTURE — …". runOnceCore titled the run's history row (and decided
   whether the run was a line hop) from latestUserText(msgs) AFTER the loop, so that label became the run's title. Both now
   read the directive captured before the loop, the one the transcript already writes first.

   Boots the REAL sidecar (hermetic fixture) with a mock OpenRouter: the run reads a PNG from its own workspace (one real
   fs.read, whose pixels ride back as the capture turn), then answers. The run-history row must carry the directive. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const AGENT = 'titlecheck';
const DIRECTIVE = 'TITLE-SENTINEL look at pic.png and tell me what colour it is';
// a valid 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function startMock() {
  const state = { mainCalls: 0, sawCapture: false };
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        const isMain = body.indexOf('[RUNTIME]') >= 0;     // only the task run carries the full agent system prompt
        const capture = body.indexOf('BEGIN EXTERNAL SCREEN CAPTURE') >= 0;
        if (isMain) { state.mainCalls++; if (capture) state.sawCapture = true; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (isMain && !capture) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'fs.read', arguments: JSON.stringify({ path: 'pic.png' }) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: isMain ? 'It is a single dark pixel.' : 'ok, done.' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, state, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// the line-hop check (which gates the run-end reflection passes) reads the same pre-loop capture as the title
{
  const { sidecarTopLevelFunction } = require('./helpers/source');
  const core = sidecarTopLevelFunction('runOnceCore');
  const at = core.indexOf('const runDirective = latestUserText(');
  A.ok(at > 0 && at < core.indexOf('const _lineHop'), 'runOnceCore captures the directive before the loop');
  A.ok(/const _lineHop = !!\(Pipeline\.isHandoff && Pipeline\.isHandoff\(runDirective\)\);/.test(core), 'the line-hop check reads the captured directive, never the post-loop messages');
  A.ok(/runTranscript\.setDirective\(runDirective\)/.test(core), 'the transcript writes the same directive first');
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'sk-runtitle-', env: { SKYNET_OPENROUTER_BASE: mock.base, SKYNET_QUEST_REFRESH: '0', SKYNET_AUX_BUDGET: '0' } });
  await fixture.start();
  try {
    const B = fixture.baseUrl;
    fs.mkdirSync(path.join(fixture.workspace, AGENT), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, AGENT, 'pic.png'), PNG);
    const r = await fetch(B + '/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-runtitle-fake', model: 'test/model', agentId: AGENT, isTask: true, placed: [{ objectType: 'cabinet' }],
        messages: [{ role: 'user', content: DIRECTIVE }] })
    });
    A.eq(r.status, 200, 'the run stream opens');
    const text = await r.text();
    const events = text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const runId = ((events.find(e => e.name === 'agent.run.start') || {}).payload || {}).runId;
    const tool = events.find(e => e.name === 'agent.tool_result');
    A.ok(runId, 'the run started: ' + runId);
    A.ok(tool && !(tool.payload && tool.payload.isError), 'fs.read of the PNG ran: ' + JSON.stringify(tool && tool.payload).slice(0, 200));
    A.ok(mock.state.sawCapture, 'the PNG\'s pixels reached the model as the loop\'s screen-capture user turn (the precondition of the bug)');
    const end = events.find(e => e.name === 'agent.run.end');
    A.eq(end && end.payload && end.payload.reason, 'done', 'the run finished');
    let row = null;
    for (let i = 0; i < 30 && !row; i++) {
      const runs = ((await fixture.json('GET', '/api/runs?agent=' + AGENT + '&limit=10')).body.runs || []);
      row = runs.find(x => x.runId === runId) || null;
      if (!row) await new Promise(res => setTimeout(res, 100));
    }
    A.ok(row, 'the run has its history row');
    A.eq(row && row.title, DIRECTIVE, 'the history row is titled by the Commander\'s directive');
    A.ok(row && !/SCREEN CAPTURE/.test(row.title || ''), 'never by the screen-capture label: ' + JSON.stringify(row && row.title));
  } finally {
    await fixture.dispose();
    try { mock.server.close(); } catch (_) {}
  }
  A.report('run-title-directive.e2e.test');
})().catch(e => { console.log('FAIL: run-title-directive.e2e.test threw — ' + (e && e.stack || e)); process.exit(1); });
