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
const { runContextOf } = require('./helpers/host-notes.js');
const text = content => typeof content === 'string' ? content : (content || []).map(p => p.text || '').join('');
const DOSSIER = belief => 'WHAT YOU KNOW ABOUT YOUR COMMANDER (the station has learned this — honor it; if anything here is wrong, the Commander will correct it):\n- Style: ' + belief;
const FORK = 'MID-TASK PREFERENCE FORK (you may use this AT MOST ONCE per task, or not at all):\nFORK_PROOF';
const HISTORY = [
  { role: 'user', content: 'Keep the API compatible. Previous project evidence: ' + 'HISTORY_EVIDENCE_17 '.repeat(1500) },
  { role: 'assistant', content: 'I will inspect the exact file.', tool_calls: [{ id: 'call_prior', type: 'function', function: { name: 'fs_read', arguments: '{"path":"src/exact-file.js"}' } }] },
  { role: 'tool', tool_call_id: 'call_prior', content: 'EXACT_TOOL_RESULT: export const invariant = 1739; preserve this value.' },
  { role: 'assistant', content: 'The compatibility constraint and value 1739 are verified.' }
];
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
        body: JSON.stringify(Object.assign({ provider, baseUrl, key: 'fixture-key', model, reasoningEffort: 'low', agentId: 'agent', streamId: 'learned-' + provider + '-' + Math.random(), isTask: true, placed: [], system, messages: HISTORY.concat([{ role: 'user', content: 'Write a short note about bees.' }]) }, extra || {})) });
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
      assert.deepEqual(a, b, provider + ': the WHOLE system stays identical so learned changes do not invalidate cached conversation history');
      const priorEnd = body => body.messages.findIndex(m => m.role === 'assistant' && text(m.content) === HISTORY[3].content) + 1;
      assert.ok(priorEnd(bodies[0]) > 0 && priorEnd(bodies[1]) > 0, provider + ': prior final answer retained');
      assert.deepEqual(bodies[0].messages.slice(0, priorEnd(bodies[0])), bodies[1].messages.slice(0, priorEnd(bodies[1])), provider + ': prior conversation and exact tool evidence remain byte-identical');
      assert.ok(JSON.stringify(bodies[0].messages).includes('EXACT_TOOL_RESULT') && JSON.stringify(bodies[0].messages).includes('src/exact-file.js'), provider + ': no tool evidence or call arguments removed');
      assert.equal((JSON.stringify(bodies[0].messages).match(/HISTORY_EVIDENCE_17/g) || []).length, 1500, provider + ': no history shortening to manufacture savings');
      assert.ok(a[0].text.includes('LEARNED_TAIL_IDENTITY'), provider + ': the persona stays in the prefix');
      assert.ok(a[0].text.includes('<capabilities_ground_truth>'), provider + ': the capabilities stay in the prefix');
      assert.ok(!a[0].text.includes('WHAT YOU KNOW') && !b[0].text.includes('MID-TASK PREFERENCE FORK'), provider + ': no learned block inside it');
      const noteA = runContextOf(bodies[0].messages), noteB = runContextOf(bodies[1].messages);
      assert.ok(noteA.includes('- Style: terse'), provider + ': the dossier still reaches the model');
      assert.ok(noteA.indexOf(TAIL_GUARD) >= 0 && noteA.indexOf(TAIL_GUARD) < noteA.indexOf('WHAT YOU KNOW'), provider + ': the guard opens the learned context');
      // Learned state changes only the current turn, never an earlier cached system/history block.
      assert.ok(!text(a).includes(TAIL_GUARD), provider + ': changing learned state is outside the top-level system');
      assert.ok(noteB.includes('- Style: thorough') && noteB.includes('FORK_PROOF'), provider + ': the change and the fork block reach the model');
      console.log('OK ' + provider + ': cached block held at ' + a[0].text.length + ' chars');
    }
    // A chat wire with no cache markers (automatic prefix caching): the learned text sits after every stable byte.
    bodies.length = 0;
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('terse'));
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('thorough'));
    const [x, y] = bodies.map(body => text(body.messages[0].content));
    const at = s => s.indexOf('WHAT YOU KNOW ABOUT YOUR COMMANDER');
    assert.equal(at(x), -1, 'custom: learned context is outside the system');
    assert.equal(x, y, 'custom: the entire system is byte-identical');
    assert.ok(runContextOf(bodies[0].messages).includes('- Style: terse') && runContextOf(bodies[1].messages).includes('- Style: thorough'), 'custom: both preferences reach their current turn');
    console.log('OK custom: ' + x.length + ' chars of stable system');

    // A real task keeps its Task Brief doctrine and the full learned context.
    bodies.length = 0;
    await run('custom', 'audit-model', persona + '\n\n' + DOSSIER('terse'), { streamId: 'learned-tail-brief' });
    const briefed = text(bodies[0].messages[0].content);
    const doctrine = briefed.indexOf(TaskIntent.directive('').trim().slice(0, 80));
    assert.ok(doctrine > 0, 'fixture: the task run carries the Task Brief doctrine');
    assert.ok(runContextOf(bodies[0].messages).includes('- Style: terse'), 'the learned text reaches the task alongside the current brief');
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
