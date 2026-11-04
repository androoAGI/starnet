'use strict';
// One production sidecar journey, repeated across wire protocols and entry points.
// Upstreams are strict loopback simulators. This is not external-provider or installer proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { seedActiveStation } = require('./helpers/station.js');   // a crew lives on a founded station: before one, the roster is held, never written
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const IPC = 'customer-journey-fixture-ipc-token-1234567890';
const providers = ['starnet', 'openrouter', 'custom', 'gemini', 'codex'];
// Agent ids are NOT provider names: WORKSPACES/codex holds the ChatGPT tokens, so an agent id `codex` is reserved
// (sidecar/workspace-reserved.js) and could never own a workspace.
const aid = p => 'journey-' + p;
const modelFor = p => p === 'gemini' ? 'gemini-3-flash' : p === 'codex' ? 'gpt-5.5' : p + '/journey';
const jwt = 'fixture.' + Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url') + '.fixture';

test('customer journey: connect, select, tool, output, restart and repeat on all primary adapters', { timeout: 180000 }, async () => {
  const calls = [], violations = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      const p = req.url.split('/')[1];
      if (!providers.includes(p)) { res.writeHead(404); res.end(); return; }
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      try {
        if (req.method !== 'POST' || /\/(debit|credit)$/.test(req.url)) {
          // OpenAI-shaped /models rows (no supported_parameters), on purpose: the kept OpenRouter endpoint warms the boot
          // catalog after the restart, and a row that names no parameters must not read as toolless (providers/openrouter.js)
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, balanceUsd: 100, data: [{ id: modelFor(p), context_length: 8000 }] })); return;
        }
        const body = JSON.parse(raw);
        const gemini = p === 'gemini', codex = p === 'codex';
        // Background title/summary inferences have no tools and can finish after the initiating run.
        // Answer them, but keep their receipts separate from the tool-capable journey requests.
        if (!body.tools?.length) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (gemini) send({ candidates: [{ content: { parts: [{ text: 'Summary' }] }, finishReason: 'STOP' }] });
          else if (codex) { send({ type: 'response.output_text.delta', delta: 'Summary' }); send({ type: 'response.completed', response: { status: 'completed' } }); }
          else send({ choices: [{ delta: { content: 'Summary' }, finish_reason: 'stop' }] });
          res.end('data: [DONE]\n\n'); return;
        }
        assert.equal(gemini ? req.headers['x-goog-api-key'] : req.headers.authorization, gemini ? p + '-fixture' : 'Bearer ' + (codex ? jwt : p + '-fixture'));
        if (!gemini) assert.equal(body.model, modelFor(p));
        else assert.ok(req.url.includes(modelFor(p)));
        const messages = gemini ? body.contents : codex ? body.input : body.messages;
        const parts = gemini ? messages.flatMap(m => m.parts || []) : [];
        const result = gemini ? parts.find(x => x.functionResponse) : codex ? messages.find(x => x.type === 'function_call_output') : messages.find(x => x.role === 'tool');
        if (result) {
          assert.ok(JSON.stringify(result).includes(p + '-journey-proof.txt'), 'tool must return a real file from this agent workspace, not an error or another agent workspace');
          if (gemini) {
            const call = parts.find(x => x.functionCall);
            assert.ok(call); assert.equal(call.thoughtSignature, 'opaque-journey-signature');
            assert.equal(result.functionResponse.name, 'fs_list');
          } else if (codex) {
            const call = messages.find(x => x.type === 'function_call' && x.call_id === result.call_id);
            assert.ok(call, 'Codex result must retain its call');
          } else {
            const open = new Set();
            for (const m of messages) {
              if (m.tool_calls) for (const c of m.tool_calls) { assert.ok(!open.has(c.id)); open.add(c.id); }
              else if (m.role === 'tool') assert.ok(open.delete(m.tool_call_id), 'result must match an outstanding call');
              else assert.equal(open.size, 0, 'calls must be answered before the next message');
            }
            assert.equal(open.size, 0);
          }
        }
        calls.push({ provider: p, result: !!result });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (gemini) {
          send({ candidates: [{ content: { role: 'model', parts: result ? [{ text: 'JOURNEY COMPLETE' }] : [{ functionCall: { name: 'fs_list', args: {} }, thoughtSignature: 'opaque-journey-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4 } });
        } else if (codex) {
          const item = { type: 'function_call', id: 'fc_journey', call_id: 'journey_inspect', name: 'fs_list', arguments: '{}' };
          if (result) send({ type: 'response.output_text.delta', delta: 'JOURNEY COMPLETE' });
          else { send({ type: 'response.output_item.added', output_index: 0, item }); send({ type: 'response.output_item.done', output_index: 0, item }); }
          send({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 4 } } });
        } else {
          send({ choices: [{ delta: result ? { content: 'JOURNEY COMPLETE' } : { tool_calls: [{ index: 0, id: 'journey_inspect', type: 'function', function: { name: 'fs_list', arguments: '{}' } }] }, finish_reason: result ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4 } });
        }
        res.end('data: [DONE]\n\n');
      } catch (e) { violations.push(p + ': ' + e.message); res.writeHead(400); res.end(JSON.stringify({ error: { message: e.message } })); }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const env = { STARNET_IPC_TOKEN: IPC, STARNET_FULL_ACCESS: '1', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: base + '/starnet', STARNET_CREDITS_TOKEN: 'starnet-fixture', STARNET_DEFAULT_MODEL: '', SKYNET_DEFAULT_MODEL: '' };
  // All ordinary credentials are delivered through the real desktop IPC route. Ambient keys cannot win.
  for (const name of ['OPENROUTER_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_API_KEY', 'CUSTOM_OPENAI_KEY', 'CREDITS_API_KEY']) {
    env[name] = ''; env['STARNET_' + name] = ''; env['SKYNET_' + name] = '';
  }
  const fixture = SidecarFixture.create({ prefix: 'customer-journey-', timeoutMs: 20000, env });
  try {
    for (const p of providers) {
      fs.mkdirSync(path.join(fixture.workspace, aid(p)), { recursive: true });
      fs.writeFileSync(path.join(fixture.workspace, aid(p), p + '-journey-proof.txt'), 'Fixture data, not a customer file.');
    }
    fs.mkdirSync(path.join(fixture.workspace, '.secrets'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, '.secrets', 'credits.json'), JSON.stringify({ url: base + '/starnet', accountId: 'fixture', linkedAt: Date.now() }));
    fs.mkdirSync(path.join(fixture.workspace, 'codex'), { recursive: true });
    fs.writeFileSync(path.join(fixture.workspace, 'codex', 'tokens.json'), JSON.stringify({ access_token: jwt, refresh_token: 'fixture', token_type: 'Bearer' }));
    seedActiveStation(fixture.workspace);
    await fixture.start();
    const agents = providers.map(provider => ({ agentId: aid(provider), name: provider, system: 'Inspect the station then answer.', provider, model: modelFor(provider) }));
    assert.equal((await fixture.json('POST', '/api/roster', { agents, updatedAt: Date.now() })).status, 200);
    await fixture.json('POST', '/api/cron/arm', { enabled: false });
    const jobs = {};
    for (const p of providers) {
      const r = await fixture.json('POST', '/api/cron', { name: 'Journey ' + p, prompt: 'Inspect then answer', schedule: 'every 1h', agentId: aid(p), provider: p, model: modelFor(p), runsLine: false });
      assert.equal(r.status, 200, JSON.stringify(r.body)); jobs[p] = r.body.job.id;
    }
    for (let boot = 0; boot < 2; boot++) {
      if (boot) await fixture.restart();
      // The desktop keychain re-pushes runtime keys each launch. Codex OAuth loads from durable storage.
      for (const p of providers) {
        const r = await fixture.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC }, body: JSON.stringify({ provider: p, key: p === 'codex' ? '' : p + '-fixture', baseUrl: base + '/' + p }) });
        assert.equal(r.status, 200, await r.text());
      }
      const roster = JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'agent.roster.json'), 'utf8'));
      for (const p of providers) {
        assert.ok(roster.agents.some(a => a.agentId === aid(p) && a.provider === p && a.model === modelFor(p)), 'saved provider/model survives restart');
        for (const entry of ['sample', 'direct', 'routine']) {
          calls.length = 0;
          if (entry === 'sample') {
            await publishFloor(fixture, floorOf({ props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: aid(p) }, { id: 'o', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }, { equip: ['computer', 'cabinet'] }), { label: 'the ' + p + ' line' });
            const r = await fixture.json('POST', '/api/routing/sample', {});
            assert.equal(r.body.ok, true, JSON.stringify(r.body));
            assert.equal(r.body.delivered.agentId, aid(p));
            assert.ok(JSON.stringify(r.body).includes('JOURNEY COMPLETE'), 'sample delivers final output');
          } else {
            const body = entry === 'routine' ? { id: jobs[p] } : { agentId: aid(p), provider: p, model: modelFor(p), internal: true, isTask: true, placed: ['computer', 'cabinet'], messages: [{ role: 'user', content: 'Inspect then answer' }] };
            const r = await fixture.json('POST', entry === 'routine' ? '/api/cron/run' : '/api/run', body);
            assert.equal(r.status, 200, r.text);
            const events = r.text.split(/\r?\n/).filter(Boolean).map(s => JSON.parse(s));
            assert.ok(events.some(e => e.name === 'agent.tool_result' && e.payload.ok && !e.payload.isError), JSON.stringify(events));
            assert.equal(events.filter(e => e.name === 'agent.run.end').length, 1);
            assert.ok(events.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'), JSON.stringify(events));
            assert.equal(events.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join(''), 'JOURNEY COMPLETE');
          }
          assert.deepEqual(violations, [], 'upstream accepts the real serialized tool history');
          assert.ok(calls.some(c => c.provider === p && !c.result), p + '/' + entry + ': initial inference');
          assert.ok(calls.some(c => c.provider === p && c.result), p + '/' + entry + ': second inference carries tool result');
          assert.ok(calls.every(c => c.provider === p), p + '/' + entry + ': no cross-provider fallback ' + JSON.stringify(calls));
        }
      }
    }
  } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
});
