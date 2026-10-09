'use strict';
/* node test/consent-full-args.e2e.test.js — INSPECT FULL REQUEST through the real sidecar (customer report, 0.13.1).
   ASK agent -> shell.exec with a >80-char command carrying a bearer key -> permission.prompt (short summary unchanged)
   -> GET /api/consent/args returns the WHOLE command with the key redacted (and refuses a request without the token)
   -> deny -> the same GET is a 404: the text lived only on the pending prompt. Nothing is executed (the answer is deny). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const SECRET = 'sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXXXX';
const CMD = 'curl -sS -X POST https://api.example.test/v1/deploy/production/services/web-frontend -H "Authorization: Bearer ' + SECRET + '" -d @release-manifest.json';

test('a live consent card serves its whole redacted request until it is answered', async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] })); }
    let raw = ''; for await (const d of req) raw += d; const body = JSON.parse(raw || '{}');
    const n = (body.messages || []).filter(m => m.role === 'tool').length;
    const step = [{ name: 'brief_proceed', args: { objective: 'Deploy the release.' } }, { name: 'shell_exec', args: { cmd: CMD } }][n];
    res.setHeader('Content-Type', 'text/event-stream');
    const delta = step ? { tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.args) } }] } : { content: 'Stopped: the deploy was denied.' };
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ prefix: 'starnet-fullargs-', timeoutMs: 20000, env: { SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0', SKYNET_OPENROUTER_BASE: base, STARNET_OPENROUTER_BASE: base, SKYNET_OPENROUTER_KEY: 'fixture-key', STARNET_OPENROUTER_KEY: 'fixture-key' } });
  try {
    await fixture.start();
    await fixture.json('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: 'fixture/model', executionProfile: 'trusted-project', approvalMode: 'ask' }] });
    const response = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: 'agent', provider: 'openrouter', model: 'fixture/model', isTask: true, messages: [{ role: 'user', content: 'Deploy the release.' }], placed: [{ objectType: 'computer' }] }) });
    assert.equal(response.status, 200);
    let buf = '', runId = ''; const prompts = [], events = [], seen = [];
    for await (const chunk of response.body) {
      buf += Buffer.from(chunk).toString(); let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let ev; try { ev = JSON.parse(buf.slice(0, idx)); } catch (_) {} buf = buf.slice(idx + 1); if (!ev) continue; events.push(ev);
        if (ev.name === 'agent.run.start') runId = ev.payload.runId;
        if (ev.name !== 'permission.prompt') continue;
        prompts.push(ev.payload);
        const q = '/api/consent/args?runId=' + encodeURIComponent(runId) + '&promptId=' + encodeURIComponent(ev.payload.promptId);
        seen.push({ live: await fixture.json('GET', q) });
        const bare = await fetch(fixture.baseUrl + q, { headers: { Origin: fixture.baseUrl } });
        seen.at(-1).noToken = bare.status;
        await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'deny' });
        seen.at(-1).after = await fixture.json('GET', q);
      }
    }
    assert.ok(events.some(e => e.name === 'agent.run.end'), 'terminal run event');
    assert.equal(prompts.length, 1, 'one consent card: ' + JSON.stringify(events.map(e => e.name)));
    const p = prompts[0];
    assert.equal(p.tool, 'shell.exec');
    assert.ok(!p.argsSummary.includes(SECRET) && p.argsSummary.includes('-d @release-manifest.json'), 'the summary is the whole request, redacted: ' + p.argsSummary);
    assert.deepEqual(Object.keys(p).sort(), ['agentId', 'argsSummary', 'promptId', 'scope', 'tool'], 'the event carries no full text');
    const { live, noToken, after } = seen[0];
    assert.equal(live.status, 200, live.text);
    assert.equal(live.headers.get('cache-control'), 'no-store');
    assert.equal(live.body.ok, true); assert.equal(live.body.tool, 'shell.exec'); assert.equal(live.body.truncated, false);
    assert.ok(!live.text.includes(SECRET) && /redacted/i.test(live.body.args), 'the bearer key is redacted: ' + live.body.args);
    assert.ok(live.body.args.includes('https://api.example.test/v1/deploy/production/services/web-frontend') && live.body.args.includes('-d @release-manifest.json'), 'the whole command: ' + live.body.args);
    assert.ok(noToken === 401 || noToken === 403, 'token-gated like every /api route (got ' + noToken + ')');
    assert.equal(after.status, 404, 'gone once answered: ' + after.text);
    assert.equal(after.body.ok, false);
    assert.ok(!events.some(e => e.name === 'agent.tool_result' && e.payload && e.payload.ok === true && e.payload.callId === 'call_1'), 'denied: the command never ran');
  } finally { await fixture.dispose(); await new Promise(r => server.close(r)); }
});
