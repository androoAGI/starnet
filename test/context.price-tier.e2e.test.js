/* node test/context.price-tier.e2e.test.js — the price-tier window ceiling, proven through a REAL booted sidecar
   (context-cost-1023).

   test/context.price-tier-window.test.js proves the ceiling through runAgentLoop with index.js's live bindings
   mirrored; this drives the production composition itself (/api/run -> runOnceCore -> makeContext with
   runWindowCeiling), because context.js swallows a throwing ceiling by design: a binding error in index.js would
   silently drop the ceiling and no source lock could see it.

   A loopback Anthropic wire reports a 1M window (max_input_tokens) for two models. The first call of each run reports
   an 80k-token prompt and asks for one tool; the next call is the turn after that tool result:
     · claude-haiku-5-5 (bills 5x above a 100K prompt): the run works in 100K, folds at 65K, so the 80k prompt is
       folded (a summarizer request reaches the wire, agent.compact fires) before the next call;
     · claude-test (no documented tier): the run keeps the real 1M window (fold at 650k), so nothing folds.
   ONE BUDGET AUTHORITY (context-budget-and-fold): the same sidecar's real GET /api/models/anthropic rows publish the pair the
   page fits a chat to, runWindow and compactAt (the share RUN_CONTEXT_DEFAULTS folds with), and that pair is the line the runs
   above really folded at: the 80k prompt is past floor(runWindow x compactAt) for the Haiku row and under it for the other.
   No external network and no provider spend. Part of test:http because it owns child processes and sockets. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { RUN_CONTEXT_DEFAULTS } = require('../sidecar/context.js');

const HOST = '127.0.0.1';
const KEY = 'anthropic-price-tier-e2e';

function anthropicSse(blocks) { return blocks.map(v => 'data: ' + JSON.stringify(v)).join('\n') + '\n'; }

function startProvider() {
  return new Promise(resolve => {
    const calls = [];
    const server = http.createServer((req, res) => {
      if (/\/models(?:\?|$|\/)/.test(req.url || '')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000 },
          { id: 'claude-test', type: 'model', display_name: 'Claude Test', max_input_tokens: 1000000 }
        ], has_more: false }));
      }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch (_) {}
        const isSummary = /compress an earlier slice|PREVIOUS SUMMARY/.test(JSON.stringify(body.system || ''));
        const hasToolResult = (body.messages || []).some(m => Array.isArray(m && m.content) && m.content.some(b => b && b.type === 'tool_result'));
        calls.push({ model: body.model, isSummary, hasToolResult });
        if (String(req.headers['x-api-key'] || '') !== KEY) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'unknown test credential' } }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (isSummary) {
          return res.end(anthropicSse([
            { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '## Active Task\nInspect the station.' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
            { type: 'message_stop' }
          ]));
        }
        if (!hasToolResult) {
          return res.end(anthropicSse([
            // 80k: over Haiku 5.5's 65K fold point (65% of its 100K tier), far under 650k (65% of the real 1M window)
            { type: 'message_start', message: { usage: { input_tokens: 80000, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'inspect_1', name: 'station_inspect', input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
            { type: 'message_stop' }
          ]));
        }
        return res.end(anthropicSse([
          { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inspected' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
          { type: 'message_stop' }
        ]));
      });
    });
    server.listen(0, HOST, () => resolve({ server, calls, baseUrl: 'http://' + HOST + ':' + server.address().port + '/v1' }));
  });
}

async function eventsOf(response) {
  const text = await response.text();
  return text.split('\n').map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
}

(async () => {
  const provider = await startProvider();
  const sidecar = SidecarFixture.create({
    prefix: 'starnet-price-tier-',
    env: {
      // the station holds the loopback credential too, so its own /api/models route can list the wire's catalog (the runs below
      // still send the same key and endpoint in their bodies)
      OPENROUTER_KEY: '', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: provider.baseUrl,
      SKYNET_BUDGET_PER_RUN: '10', SKYNET_BUDGET_PER_AGENT: '0', SKYNET_BUDGET_PER_DAY: '0', SKYNET_BUDGET_GLOBAL: '0',
      SKYNET_EDGE_TTS: '0', STARNET_EDGE_TTS: '0'
    }
  });
  await sidecar.start();
  const api = async (method, route, body) => fetch(sidecar.baseUrl + route, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, sidecar.token ? { 'X-StarNet-Token': sidecar.token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const runOn = async (model) => {
    const history = [];
    for (let i = 0; i < 8; i++) history.push({ role: i % 2 ? 'assistant' : 'user', content: 'history turn ' + i + ' with enough content to fold' });
    history.push({ role: 'user', content: 'finish this after inspecting the station' });
    const from = provider.calls.length;
    const res = await api('POST', '/api/run', { provider: 'anthropic', model, key: KEY, baseUrl: provider.baseUrl, internal: true, isTask: false, messages: history });
    A.eq(res.status, 200, model + ': /api/run streams');
    const events = await eventsOf(res);
    return { events, wire: provider.calls.slice(from).filter(c => c.model === model || c.isSummary) };
  };

  try {
    const haiku = await runOn('claude-haiku-5-5');
    A.ok(haiku.events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), 'Haiku 5.5: the run completed');
    A.ok(haiku.events.some(e => e.name === 'agent.compact'), 'Haiku 5.5: the 80k prompt was folded (the run works in its 100K price tier, not the 1M window)');
    A.ok(haiku.wire.some(c => c.isSummary), 'Haiku 5.5: a summarizer request reached the wire');
    A.eq(haiku.events.filter(e => e.name === 'agent.run.error').length, 0, 'Haiku 5.5: no run error');

    const linear = await runOn('claude-test');
    A.ok(linear.events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.reason === 'done'), 'no-tier model: the run completed');
    A.eq(linear.events.filter(e => e.name === 'agent.compact').length, 0, 'no-tier model: the same 80k prompt is not folded (the real 1M window is kept)');
    A.eq(linear.wire.filter(c => c.isSummary).length, 0, 'no-tier model: no summarizer request');

    // the rows the page fits to: the REAL route, the REAL handler, the same station that just ran both
    const listed = await api('GET', '/api/models/anthropic');
    A.eq(listed.status, 200, '/api/models/anthropic answers');
    const rows = ((await listed.json()).models) || [];
    const rowOf = id => rows.find(m => m && m.id === id);
    const haikuRow = rowOf('claude-haiku-5-5'), linearRow = rowOf('claude-test');
    A.ok(haikuRow && linearRow, 'the loopback catalog lists both models: ' + JSON.stringify(rows.map(m => m.id)));
    const line = row => Math.floor(row.runWindow * row.compactAt);
    A.eq([haikuRow.context_length, haikuRow.runWindow, haikuRow.compactAt], [1000000, 100000, RUN_CONTEXT_DEFAULTS.compactAt],
      'Haiku 5.5: the row publishes its 100K tier window and the share the context manager folds with');
    A.eq([linearRow.context_length, linearRow.runWindow, linearRow.compactAt], [1000000, 1000000, RUN_CONTEXT_DEFAULTS.compactAt],
      'no-tier model: the row publishes the whole window and the same share');
    // the 80k prompt both runs reported: past the published line for Haiku (and the run folded), under it for the other (and it did not)
    A.ok(80000 > line(haikuRow) && haiku.events.some(e => e.name === 'agent.compact'), 'Haiku 5.5: the published line ' + line(haikuRow) + ' is where the run folded an 80k prompt');
    A.ok(80000 <= line(linearRow) && linear.events.filter(e => e.name === 'agent.compact').length === 0, 'no-tier model: the published line ' + line(linearRow) + ' is where the run kept an 80k prompt whole');
  } finally {
    await sidecar.dispose();
    await new Promise(resolve => provider.server.close(resolve));
  }

  A.report('context.price-tier.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
