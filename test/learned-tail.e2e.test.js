'use strict';
// issue #105, real HTTP request assembly and provider wires, no external inference: a learned block changing between two runs
// leaves each provider's cached system block byte-identical, and the model still receives the block.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { TAIL_GUARD } = require('../sidecar/learned-tail.js');
const { TaskIntent } = require('../frontend/app/fork.js');
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
  // SidecarFixture leaves USERPROFILE real on Windows; this boot reads no real sign-in or home directory
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'starnet-learnedtail-home-'));
  const fixture = new SidecarFixture({ env: { HOME: home, USERPROFILE: home, SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1', SKYNET_SKILL_REVIEW: '0', SKYNET_SKILL_CURATOR: '0', SKYNET_THREAD_MINE: '0', SKYNET_SCOUT: '0', STARNET_CREDITS_URL: '', SKYNET_CREDITS_URL: '' } });
  try {
    await fixture.start();
    const run = async (provider, model, system, extra) => {
      const r = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token, Origin: fixture.baseUrl },
        body: JSON.stringify(Object.assign({ provider, baseUrl, key: 'fixture-key', model, reasoningEffort: 'low', agentId: 'agent', streamId: 'learned-' + provider + '-' + Math.random(), isTask: true, placed: [], system, messages: [{ role: 'user', content: 'Write a short note about bees.' }] }, extra || {})) });
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
      assert.ok(text(a.slice(1)).indexOf(TAIL_GUARD) >= 0 && text(a.slice(1)).indexOf(TAIL_GUARD) < text(a.slice(1)).indexOf('WHAT YOU KNOW'), provider + ': the guard opens the learned tail');
      // IX3: the tail follows the prefix directly, ahead of every block that changes per conversation
      assert.ok(text(a.slice(1)).trimStart().startsWith(TAIL_GUARD), provider + ': nothing sits between the prefix and the learned tail');
      assert.ok(text(a.slice(1)).indexOf('- Style: terse') < text(a.slice(1)).indexOf('## FINISH THE JOB'), provider + ': the learned text comes before the closing doctrine');
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

    // IX3: a run on a valid stream id carries the Task Brief doctrine (the random ids above are not valid ones, so those runs have none). The learned text stays ahead of it.
    bodies.length = 0;
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('terse'), { streamId: 'learned-tail-brief' });
    const briefed = text(bodies[0].messages[0].content);
    const doctrine = briefed.indexOf(TaskIntent.directive('').trim().slice(0, 80));
    assert.ok(doctrine > 0, 'fixture: the task run carries the Task Brief doctrine');
    assert.ok(briefed.indexOf('- Style: terse') < doctrine, 'the learned text comes before the Task Brief doctrine');
    console.log('OK task brief order');

    // IX1: STARNET_STABLE_PREFIX=0 restores the old single system prompt, and a recovery continuation takes this same branch
    // (`stablePrefix` is false for both). No split there, and nothing may be dropped.
    await fixture.restart({ STARNET_STABLE_PREFIX: '0' });
    bodies.length = 0;
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('terse') + '\n\n' + FORK);
    const old = text(bodies[0].messages[0].content);
    assert.ok(old.includes('- Style: terse') && old.includes('FORK_PROOF'), 'kill switch: the learned blocks still reach the model');
    assert.equal(old.split('- Style: terse').length - 1, 1, 'kill switch: once');
    assert.ok(old.indexOf('- Style: terse') < old.indexOf('<capabilities_ground_truth>'), 'kill switch: the persona is whole, in its old place, ahead of the capabilities');
    assert.ok(!old.includes(TAIL_GUARD), 'kill switch: no guard line, the old prompt is restored');
    console.log('OK kill switch');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('learned-tail.e2e: OK');
})().catch(e => { console.error(e); process.exit(1); });
