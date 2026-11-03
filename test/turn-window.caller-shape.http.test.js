'use strict';
const A = require('./_assert.js');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { makeSegmentedTranscriptIo } = require('../sidecar/transcript-history.js');
const UserText = require('../frontend/app/usertext.js');
const requests = [], words = m => UserText.flatten(m && m.content, UserText.OPENAI);
const mock = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 128000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
  let raw = ''; req.on('data', part => { raw += part; }); req.on('end', () => {
    requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'CALLER_SHAPE_ANSWER' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
});
(async () => {
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + mock.address().port;
  const fx = SidecarFixture.create({ prefix: 'window-callers-', env: { STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_BASE: base,
    STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_TURNID_WINDOW: 'id', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0', SKYNET_AUX_BUDGET: '0', SKYNET_REFLECT: '0', SKYNET_SKILL_REVIEW: '0' } });
  const io = makeSegmentedTranscriptIo({ fs, path, root: path.join(fx.workspace, 'transcript-history-v2'), schedule() {} });
  io.appendDurable({ streamId: 's', agentId: 'agent', role: 'user', content: 'CANONICAL_SHAPE_OWNER', turnId: 'caller_seed_0001', directive: true });
  io.appendDurable({ streamId: 's', agentId: 'agent', role: 'assistant', content: 'CANONICAL_SHAPE_ANSWER', turnId: 'caller_seed_0001' }); io.close();
  let seq = 0;
  async function send(name, changes) {
    const now = Date.now(), before = requests.length;
    const pairs = [{ role: 'user', content: 'PRIOR_' + name }, { role: 'assistant', content: '', tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'fs_read', arguments: '{"path":"note.txt"}' } }] },
      { role: 'tool', tool_call_id: 'prior-call', content: 'PAIR_RESULT_' + name }, { role: 'user', content: 'NEW_' + name }];
    const response = await fx.json('POST', '/api/run', Object.assign({ provider: 'openrouter', model: 'test/model', key: 'fixture', agentId: 'agent', isTask: false,
      streamId: 's', turnId: 'caller_shape_' + String(++seq).padStart(6, '0'), turnAt: now, clientNow: now, windowTokens: 10000, messages: pairs }, changes));
    const events = response.status === 200 ? response.text.trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const start = events.find(e => e.name === 'agent.run.start')?.payload, end = events.findLast(e => e.name === 'agent.run.end' && !e.payload.parentRunId)?.payload;
    A.eq([response.status, end?.outcome], [200, 'succeeded'], name + ': actual run reaches a successful terminal');
    const status = await fx.json('GET', '/api/turn-identity');
    return { start, requests: requests.slice(before), window: status.body.ring.filter(e => e.surface === 'window' && e.runId === start?.runId) };
  }
  try {
    await fx.start();
    for (const [name, changes] of [
      ['internal', { internal: true }], ['streamless', { streamId: '' }],
      ['old-page', { turnId: undefined, windowTokens: undefined, windowCaller: 'desk' }],
      ['no-window-declaration', { windowTokens: undefined, windowCaller: 'desk' }]
    ]) {
      const result = await send(name, changes);
      A.ok(result.requests.some(r => r.messages.some(m => m.role === 'tool' && words(m).includes('PAIR_RESULT_' + name)) &&
        r.messages.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === 'prior-call'))), name + ': real provider keeps its caller-owned tool pair');
      A.eq(result.window.length, 0, name + ': no eligible desk-window comparison is invented');
    }
    const empty = await send('null-capture', { messages: [{ role: 'assistant', content: 'ASSISTANT_ONLY_INPUT' }] });
    A.ok(empty.requests.some(r => r.messages.some(m => words(m).includes('ASSISTANT_ONLY_INPUT'))), 'null capture preserves its actual assistant-only caller input');
    A.eq(empty.window.length, 0, 'null capture writes no window comparison');
    const eligible = await send('eligible', {});
    A.eq(eligible.window.length, 1, 'positive desk declaration activates exactly one real window comparison');
    A.ok(eligible.requests.some(r => r.messages.some(m => words(m).includes('CANONICAL_SHAPE_ANSWER'))), 'eligible control actually uses model-replay canonical history');
    A.eq(eligible.requests.some(r => r.messages.some(m => m.role === 'tool' && words(m).includes('PAIR_RESULT_eligible'))), false, 'eligible prose control replaces the stale posted pair');
  } finally { await fx.dispose(); mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
  A.report('turn-window.caller-shape.http');
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
