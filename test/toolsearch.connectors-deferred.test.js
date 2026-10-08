/* node test/toolsearch.connectors-deferred.test.js — MCP connector tools past a footprint threshold are DEFERRED.

   The claim under test (w2 footprint, 2026-09-22): a connector's whole schema list used to ride every request.
   Past CONNECTOR_DEFER (8KB or 12 tools by default) the largest servers are deferred instead — still granted,
   found through tool.search, revealed by the loop on the next turn — and the system prompt carries a one-line
   server index in their place. Below the threshold the request is byte-identical to never deferring.

   A. the pure planner + index line (sidecar/tools/builtin/toolsearch.js).
   B. the REAL seam: a private sidecar, two fake MCP servers (40 tools / 3 tools) and a fake OpenAI-compatible
      model. The 40-tool server is off the wire and indexed; the model searches, the next request declares the
      found tool under its WIRE name, the model calls it and the MCP server really receives tools/call. The
      3-tool server stays advertised, and with only it configured the first request (tools + system) is
      identical to a sidecar whose connector deferral is switched off. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { planConnectorDeferral, connectorIndexLine } = require('../sidecar/tools/builtin/toolsearch.js');

const MARK = 'CONNECTOR_DEFER_PROBE';
const HOST = '127.0.0.1';

// ---- A. pure planner ----
function entries(server, n, bytes) {
  return Array.from({ length: n }, (_, i) => ({ name: 'mcp__' + server + '__t' + String(i).padStart(2, '0'), server, bytes }));
}
{
  const big = planConnectorDeferral(entries('github', 40, 600), { maxBytes: 8192, maxTools: 12 });
  A.eq(big.deferred.length, 40, '40 connector tools past the threshold are all deferred');
  A.eq(big.servers, [{ id: 'github', count: 40, bytes: 24000 }], 'the deferred server is reported with its count and bytes');
  const small = planConnectorDeferral(entries('notes', 3, 300), { maxBytes: 8192, maxTools: 12 });
  A.eq(small.deferred, [], '3 small connector tools stay advertised');
  A.eq(small.servers, [], 'and no server is indexed');
  const mixed = planConnectorDeferral(entries('notes', 3, 300).concat(entries('github', 40, 600)), { maxBytes: 8192, maxTools: 12 });
  A.eq(mixed.servers.map(s => s.id), ['github'], 'the LARGEST server goes first; the small one still fits and stays advertised');
  A.ok(mixed.deferred.every(n => n.indexOf('mcp__github__') === 0), 'only the large server\'s tools are deferred');
  A.eq(planConnectorDeferral(entries('a', 13, 10), { maxBytes: 8192, maxTools: 12 }).deferred.length, 13, 'the tool-count axis alone triggers deferral');
  A.eq(planConnectorDeferral(entries('a', 5, 2000), { maxBytes: 8192, maxTools: 12 }).deferred.length, 5, 'the byte axis alone triggers deferral');
  A.eq(planConnectorDeferral(entries('github', 40, 600), { maxBytes: 0, maxTools: 0 }).deferred, [], 'both limits 0 = never defer (the off switch)');
  const tie1 = planConnectorDeferral(entries('zeta', 10, 1000).concat(entries('alpha', 10, 1000)), { maxBytes: 12000, maxTools: 0 });
  const tie2 = planConnectorDeferral(entries('alpha', 10, 1000).concat(entries('zeta', 10, 1000)), { maxBytes: 12000, maxTools: 0 });
  A.eq(tie1, tie2, 'equal-size servers break ties on id — input order never changes the advertised list');
  A.eq(tie1.servers.map(s => s.id), ['alpha'], 'deferring one of two equal servers is enough to fit');
  const line = connectorIndexLine(big.servers);
  A.ok(line.indexOf('github (40 tools)') >= 0 && line.indexOf('tool_search') >= 0, 'the index line names the server, its count, and the way in');
  A.ok(line.indexOf('mcp__github__t00') < 0, 'the index does not re-list every tool name');
  A.eq(connectorIndexLine([]), '', 'no deferred server = no new prompt bytes');
}

// ---- B. the live seam ----
function mockMcp() {
  const calls = [];
  const tools = {
    big: Array.from({ length: 40 }, (_, i) => {
      const n = String(i).padStart(2, '0');
      return {
        name: 'widget_' + n,
        description: 'Operate on widget number ' + n + ' of the big fixture service: reads its record, applies the requested change, and returns the updated record with its revision history.',
        inputSchema: { type: 'object', required: ['id'], properties: {
          id: { type: 'string', description: 'The widget id, exactly as listed by the service.' },
          fields: { type: 'array', items: { type: 'string' }, description: 'Which record fields to return; all of them when omitted.' },
          dryRun: { type: 'boolean', description: 'Validate the change without applying it.' }
        } }
      };
    }),
    small: [
      { name: 'note_add', description: 'Add a note.', inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
      { name: 'note_list', description: 'List notes.', inputSchema: { type: 'object', properties: {} } },
      { name: 'note_get', description: 'Get one note.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
    ]
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    let raw = ''; for await (const c of req) raw += c;
    let msg = {}; try { msg = JSON.parse(raw || '{}'); } catch (_) {}
    const which = req.url.indexOf('/small') === 0 ? 'small' : 'big';
    const reply = (result, status) => {
      const headers = { 'Content-Type': 'application/json' };
      if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-' + which;
      res.writeHead(status || 200, headers);
      if (status === 202) return res.end();
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: which } });
    if (msg.method === 'notifications/initialized') return reply({}, 202);
    if (msg.method === 'tools/list') return reply({ tools: tools[which] });
    if (msg.method === 'tools/call') {
      calls.push({ server: which, name: msg.params && msg.params.name, args: msg.params && msg.params.arguments });
      return reply({ content: [{ type: 'text', text: which + ':' + (msg.params && msg.params.name) + ' ok' }], isError: false });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, calls, base: 'http://' + HOST + ':' + server.address().port })));
}

// OpenAI-compatible fake. Only requests carrying MARK are scripted/recorded; background model calls get a plain stop.
function mockModel() {
  const bodies = [];
  const sse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const toolCall = (res, id, name, args) => {
    sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const say = (res, text) => {
    sse(res, { choices: [{ delta: { content: text } }] });
    sse(res, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.setEncoding('utf8'); for await (const c of req) raw += c;
    if (!raw) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    let body = {}; try { body = JSON.parse(raw); } catch (_) {}
    const msgs = body.messages || [];
    const system = msgs.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (system.indexOf(MARK) < 0) { say(res, 'ok'); res.write('data: [DONE]\n\n'); return res.end(); }
    bodies.push(body);
    const user = msgs.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
    const results = msgs.filter(m => m.role === 'tool').length;
    const names = (body.tools || []).map(t => t.function && t.function.name);
    if (user.indexOf('SCENARIO:reveal') >= 0 && results === 0) toolCall(res, 'c_search', 'tool_search', { query: 'widget_17' });
    else if (user.indexOf('SCENARIO:reveal') >= 0 && results === 1 && names.indexOf('mcp__big__widget_17') >= 0) toolCall(res, 'c_widget', 'mcp__big__widget_17', { id: 'w17' });
    else say(res, 'done');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise(r => server.listen(0, HOST, () => r({ server, bodies, base: 'http://' + HOST + ':' + server.address().port + '/v1' })));
}

// Keep the fixture hermetic: no ambient provider key or tool-search/footprint override from the shell running the test.
function cleanEnv(extra) {
  const env = {};
  for (const k of Object.keys(process.env)) {
    if (/^(OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GOOGLE_API|XAI|GROQ|MISTRAL|DEEPSEEK|TOGETHER|FIREWORKS|PERPLEXITY|CEREBRAS|KIMI|ELEVENLABS|STARNET_|SKYNET_)/i.test(k)) env[k] = '';
  }
  return Object.assign(env, {
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0',
    STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '', STARNET_LIVE_PRICES: '0',
    // The [RUNTIME] block names the harness build; unpinned, each boot runs its own 2s `git describe --dirty`, and
    // on a loaded box one boot timed out to the package version — the byte-identity check then failed on that line.
    STARNET_BUILD_DESCRIBE: 'connector-defer-fixture'
  }, extra || {});
}

const systemOf = body => (body.messages || []).filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
const toolNames = body => (body.tools || []).map(t => t.function.name);

(async () => {
  const mcp = await mockMcp();
  const llm = await mockModel();
  const fixture = SidecarFixture.create({ prefix: 'starnet-connector-defer-', timeoutMs: 20000, env: cleanEnv() });
  // No streamId: an explicit stream would be seeded from its durable transcript on the second pass and the two
  // "identical" requests would differ by history rather than by footprint.
  async function run(scenario) {
    llm.bodies.length = 0;
    const r = await fixture.request('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'custom', baseUrl: llm.base, key: 'fixture-key', model: 'fixture-model', agentId: 'agent', isTask: true,
        placed: [], system: MARK + ': connector footprint probe.', messages: [{ role: 'user', content: 'SCENARIO:' + scenario + ' please proceed.' }] })
    });
    A.eq(r.status, 200, scenario + ': run accepted');
    const events = (await r.text()).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return {}; } });
    const end = events.filter(e => e.name === 'agent.run.end').pop();
    return { events, reason: end && end.payload && end.payload.reason, bodies: llm.bodies.slice() };
  }
  try {
    await fixture.start();
    for (const [id, path] of [['big', '/big'], ['small', '/small']]) {
      const c = await fixture.json('POST', '/api/connectors', { id, label: id, transport: 'http', url: mcp.base + path });
      A.eq(c.status, 200, 'connector ' + id + ' configured');
    }
    // A run projects only connectors that are up (or cached); wait for the live state instead of racing boot.
    async function connectorsUp(ids) {
      for (let i = 0; i < 200; i++) {
        const list = ((await fixture.json('GET', '/api/connectors')).body || {}).connectors || [];
        if (ids.every(id => list.some(c => c && c.id === id && (c.state === 'up' || c.state === 'cached') && c.toolCount > 0))) return true;
        await new Promise(r => setTimeout(r, 50));
      }
      return false;
    }
    A.ok(await connectorsUp(['big', 'small']), 'both fake MCP servers are connected with their tools listed');

    // Both servers: 43 tools, well past 12 — the 40-tool server is deferred, the 3-tool server is not.
    const rev = await run('reveal');
    A.eq(rev.reason, 'done', 'the reveal run completes');
    A.ok(rev.bodies.length >= 3, 'three scripted model turns reached the fake model (got ' + rev.bodies.length + ')');
    const [t1, t2] = rev.bodies;
    const n1 = toolNames(t1), n2 = toolNames(t2 || {});
    A.eq(n1.filter(n => n.indexOf('mcp__big__') === 0).length, 0, 'TURN 1: none of the 40 big-server tools is on the wire');
    A.eq(n1.filter(n => n.indexOf('mcp__small__') === 0).sort(), ['mcp__small__note_add', 'mcp__small__note_get', 'mcp__small__note_list'], 'TURN 1: the 3 small-server tools are still advertised');
    A.ok(n1.indexOf('tool_search') >= 0, 'TURN 1: tool_search is advertised');
    const sys1 = systemOf(t1);
    A.ok(sys1.indexOf('Connector tools not loaded yet') >= 0 && sys1.indexOf('big (40 tools)') >= 0, 'TURN 1: the system prompt carries the one-line server index');
    A.ok(sys1.indexOf('small (') < 0, 'TURN 1: the advertised small server is not indexed');
    A.ok(sys1.indexOf('mcp__big__widget_03') < 0, 'TURN 1: the index does not re-list the deferred tool names');
    A.ok(sys1.lastIndexOf('Run id:') > sys1.indexOf('Connector tools not loaded yet'), 'the index rides BEFORE the per-run ids (prompt-cache prefix law)');
    A.ok(n2.indexOf('mcp__big__widget_17') >= 0, 'TURN 2: the searched connector tool is declared under its wire name');
    A.eq(n2.filter(n => n.indexOf('mcp__big__') === 0).length, 1, 'TURN 2: only what matched was revealed');
    const searchResult = (t2.messages || []).filter(m => m.role === 'tool').map(m => String(m.content)).join('\n');
    A.ok(searchResult.indexOf('mcp__big__widget_17') >= 0, 'the tool_search result names the connector tool');
    A.eq(mcp.calls.filter(c => c.server === 'big' && c.name === 'widget_17').length, 1, 'the revealed connector tool really reached the MCP server (tools/call widget_17)');

    // Only the small server: below both thresholds -> nothing deferred, no index line.
    const rm = await fixture.json('POST', '/api/connectors/remove', { id: 'big' });
    A.eq(rm.status, 200, 'big connector removed');
    const below = await run('plain');
    A.eq(below.reason, 'done', 'below-threshold run completes');
    const b1 = below.bodies[0];
    A.ok(toolNames(b1).filter(n => n.indexOf('mcp__small__') === 0).length === 3, 'below threshold: all 3 connector tools advertised');
    A.ok(systemOf(b1).indexOf('Connector tools not loaded yet') < 0, 'below threshold: no index line');

    // Same station with connector deferral switched OFF (both axes 0): the first request must be identical.
    await fixture.restart({ SKYNET_CONNECTOR_DEFER_BYTES: '0', SKYNET_CONNECTOR_DEFER_TOOLS: '0', STARNET_CONNECTOR_DEFER_BYTES: '0', STARNET_CONNECTOR_DEFER_TOOLS: '0' });
    A.ok(await connectorsUp(['small']), 'the small connector is back after restart');
    const off = await run('plain');
    A.eq(off.reason, 'done', 'deferral-off run completes');
    const o1 = off.bodies[0];
    A.eq(toolNames(b1), toolNames(o1), 'below threshold the advertised tool list is identical to deferral switched off');
    A.eq(JSON.stringify(b1.tools), JSON.stringify(o1.tools), 'below threshold the tool schemas are byte-identical to deferral switched off');
    const norm = s => s.replace(/Run id: \S+/g, 'Run id: X');
    A.eq(norm(systemOf(b1)), norm(systemOf(o1)), 'below threshold the system prompt is byte-identical (per-run id aside)');
  } finally {
    await fixture.dispose();
    await new Promise(r => mcp.server.close(r));
    await new Promise(r => llm.server.close(r));
  }
  A.report('toolsearch.connectors-deferred');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
