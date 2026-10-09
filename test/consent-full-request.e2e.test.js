'use strict';
/* THE REAL WIRE (user report 10-08): a model asks for a long shell.exec on a real sidecar, and the permission.prompt the
   desk card renders carries EVERY character of it — the part past the old 77-char clip included. Deny leaves the machine
   untouched; approve runs exactly the command that was inspected. */
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
test('a long shell.exec approval carries the whole command; deny runs nothing, approve runs exactly it', async () => {
  let steps = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
    let raw = ''; for await (const d of req) raw += d; const body = JSON.parse(raw || '{}');
    const n = (body.messages || []).filter(m => m.role === 'tool').length, step = steps[n];
    res.setHeader('Content-Type', 'text/event-stream');
    const delta = step ? { tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'Done.' };
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n'); res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'starnet-consent-full-', timeoutMs: 20000, env: { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'fixture-key', STARNET_OPENROUTER_KEY: 'fixture-key' } });
  // the tail past character 77 is what the old card hid: here it is the redirect that decides where the bytes land
  const words = 'the-whole-command-is-visible-' + 'x'.repeat(220);
  const cmd = 'echo ' + words + '> consent-full-marker.txt';
  async function run(decision) {
    steps = [{ name: 'brief_proceed', args: { objective: 'Run the controlled command.' } }, { name: 'shell_exec', args: { cmd } }];
    const response = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'agent', provider: 'openrouter', model: 'fixture/model', isTask: true, messages: [{ role: 'user', content: 'Run the controlled command.' }], placed: [{ objectType: 'computer' }, { objectType: 'workbench' }, { objectType: 'cabinet' }] }) });
    assert.equal(response.status, 200); let buf = '', runId = '', prompts = [], events = [];
    for await (const chunk of response.body) {
      buf += Buffer.from(chunk).toString(); let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let ev; try { ev = JSON.parse(buf.slice(0, idx)); } catch { } buf = buf.slice(idx + 1); if (!ev) continue; events.push(ev);
        if (ev.name === 'agent.run.start') runId = ev.payload.runId;
        if (ev.name === 'permission.prompt') { prompts.push(ev.payload); await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision }); }
      }
    }
    assert.ok(events.some(e => e.name === 'agent.run.end'), 'terminal run event');
    return { prompts, events };
  }
  try {
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'fixture/model', executionProfile: 'trusted-project', approvalMode: 'ask' }] });
    const marker = path.join(fixture.workspace, 'agent', 'consent-full-marker.txt');
    let { prompts, events } = await run('deny');
    const ask = prompts.find(p => p.tool === 'shell.exec' || p.tool === 'shell_exec');
    assert.ok(ask, 'the shell command asked first: ' + JSON.stringify(prompts.map(p => p.tool)) + ' ' + JSON.stringify(events.filter(e => /tool_result|error/.test(e.name)).map(e => e.payload).slice(0, 3)));
    assert.ok(cmd.length > 200);
    assert.deepEqual(JSON.parse(ask.argsSummary), { cmd }, 'the card receives every character of the command');
    assert.ok(!fs.existsSync(marker), 'deny ran nothing');
    ({ prompts } = await run('once'));
    assert.deepEqual(JSON.parse(prompts.find(p => /^shell/.test(p.tool)).argsSummary), { cmd });
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), words, 'approve ran exactly the inspected command');
  } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
});
