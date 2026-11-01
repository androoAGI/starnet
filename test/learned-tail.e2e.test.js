'use strict';
// issue #105, real HTTP request assembly and provider wires, no external inference: a learned block changing between two runs
// leaves each provider's cached system block byte-identical, and the model still receives the block.
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const text = content => typeof content === 'string' ? content : (content || []).map(p => p.text || '').join('');
const DOSSIER = belief => 'WHAT YOU KNOW ABOUT YOUR COMMANDER (the station has learned this — honor it; if anything here is wrong, the Commander will correct it):\n- Style: ' + belief;
const FORK = 'MID-TASK PREFERENCE FORK (you may use this AT MOST ONCE per task, or not at all):\nFORK_PROOF';
(async () => {
  const bodies = [];
  const upstream = http.createServer(async (req, res) => {
    req.setEncoding('utf8');
    let raw = ''; for await (const part of req) raw += part;
    if (!raw) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [] })); }
    const body = JSON.parse(raw);
    const system = body.system ? text(body.system) : body.messages.filter(m => m.role === 'system').map(m => text(m.content)).join('\n\n');
    if (system.includes('LEARNED_TAIL_IDENTITY')) bodies.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.system) res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\ndata: {"type":"message_stop"}\n\n');
    else res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const fixture = new SidecarFixture({ env: { SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '' } });
  try {
    await fixture.start();
    const run = async (provider, model, system) => {
      const r = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl },
        body: JSON.stringify({ provider, baseUrl, key: 'fixture-key', model, reasoningEffort: 'low', agentId: 'agent', streamId: 'learned-' + provider + '-' + Math.random(), isTask: true, placed: [], system, messages: [{ role: 'user', content: 'Write a short note about bees.' }] }) });
      assert.equal(r.status, 200);
      const events = (await r.text()).trim().split('\n').map(l => JSON.parse(l));
      assert.equal(events.findLast(e => e.name === 'agent.run.end')?.payload.reason, 'done', provider + ': the run finished');
    };
    const persona = 'LEARNED_TAIL_IDENTITY: you are Ada.';
    for (const [provider, model] of [['anthropic', 'claude-test'], ['openrouter', 'anthropic/claude-test']]) {
      bodies.length = 0;
      await run(provider, model, persona + '\n\n' + DOSSIER('terse'));
      await run(provider, model, persona + '\n\n' + DOSSIER('thorough') + '\n\n' + FORK);
      assert.equal(bodies.length, 2, provider + ': one foreground inference per run');
      const blocks = body => body.system || body.messages[0].content;
      const [a, b] = bodies.map(blocks);
      assert.ok(Array.isArray(a) && a.length >= 2, provider + ': the system is split into a prefix and a tail');
      assert.ok(a[0].cache_control, provider + ': the prefix keeps its cache anchor');
      assert.equal(a[0].text, b[0].text, provider + ': the cached block is byte-identical across a dossier change and a fork flip');
      assert.ok(a[0].text.includes('LEARNED_TAIL_IDENTITY'), provider + ': the persona stays in the prefix');
      assert.ok(a[0].text.includes('<capabilities_ground_truth>'), provider + ': the capabilities stay in the prefix');
      assert.ok(!a[0].text.includes('WHAT YOU KNOW') && !b[0].text.includes('MID-TASK PREFERENCE FORK'), provider + ': no learned block inside it');
      assert.ok(text(a.slice(1)).includes('- Style: terse'), provider + ': the dossier still reaches the model');
      assert.ok(text(b.slice(1)).includes('- Style: thorough') && text(b.slice(1)).includes('FORK_PROOF'), provider + ': the change and the fork block reach the model');
      console.log('OK ' + provider + ': cached block held at ' + a[0].text.length + ' chars');
    }
    // A chat wire with no cache markers (automatic prefix caching): the learned text sits after every stable byte.
    bodies.length = 0;
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('terse'));
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('thorough'));
    const [x, y] = bodies.map(body => text(body.messages[0].content));
    const at = s => s.indexOf('WHAT YOU KNOW ABOUT YOUR COMMANDER');
    assert.ok(at(x) > x.indexOf('<capabilities_ground_truth>'), 'custom: the dossier follows the capabilities');
    assert.equal(x.slice(0, at(x)), y.slice(0, at(y)), 'custom: everything before it is byte-identical');
    console.log('OK custom: ' + at(x) + ' chars of stable prefix');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
  console.log('learned-tail.e2e: OK');
})().catch(e => { console.error(e); process.exit(1); });
