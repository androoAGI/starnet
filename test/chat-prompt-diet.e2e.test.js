/* node test/chat-prompt-diet.e2e.test.js — THE BYTES A GREETING ACTUALLY COSTS (issue #17).

   Boots the REAL sidecar against a mock OpenRouter (the roster-track.e2e pattern), drives one non-task turn
   ("hello", isTask:false — what frontend/app/classify.js sends for a greeting) and one task turn through
   /api/run, and asserts on the captured system prompts:
     - the greeting carries NO operator manual, NO skill recipes, NO [ORCHESTRATION] briefing (it has no tools
       on the wire, so those blocks described capabilities it did not have and cost ~25KB of prefill);
     - the task turn still carries all of them (the diet must never starve real work);
     - both carry the [RUNTIME] block, and on the task turn it rides AFTER the byte-stable blocks so a
       provider's prefix cache survives the per-run 'Run id:' line.
   Zero real network, zero spend. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function startMockOpenRouter() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        req.setEncoding('utf8');
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          const request = JSON.parse(body);
          requests.push(request);
          const latestUser = (request.messages || []).filter(m => m.role === 'user').at(-1);
          const cappedChat = latestUser && latestUser.content === 'hello cap regression';
          const cappedTask = latestUser && latestUser.content === 'write cap regression'
            && !(request.messages || []).some(m => String(m.content).includes('<output_continuation>'));
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: cappedChat || cappedTask ? 'length' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1)); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 12000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-chat-diet-'));
  const { child, port } = await boot(9040 + (process.pid % 25), { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base }, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    const hdr = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const r0 = await fetch(B + '/api/roster', { method: 'POST', headers: hdr, body: JSON.stringify({ agents: [
      { agentId: 'agent', system: 'lead', name: 'NOVA', role: 'overseer', track: '' },
      { agentId: 'rookie', system: 'you research', name: 'ROOKIE', role: 'researcher', track: '' }
    ], updatedAt: Date.now() }) });
    A.eq(r0.status, 200, 'POST /api/roster accepted');

    const run = async (isTask, text) => {
      const start = mock.requests.length;
      const r = await fetch(B + '/api/run', { method: 'POST', headers: hdr,
        body: JSON.stringify({ key: 'sk-or-v1-diet-fake', model: 'test/model', agentId: 'agent', isTask, surface: 'interactive', messages: [{ role: 'user', content: text }] }) });
      A.eq(r.status, 200, 'POST /api/run streams (200) for isTask=' + isTask);
      const events = await r.text();
      await new Promise(res => setTimeout(res, 250));
      const reqs = mock.requests.slice(start);
      const systems = reqs.map(q => ((((q || {}).messages || [])[0] || {}).content) || '');
      // the run's own request is the longest system prompt in the window (aux passes are shorter or absent)
      const system = systems.sort((a, b) => b.length - a.length)[0] || '';
      const tools = reqs.map(q => (q && Array.isArray(q.tools)) ? q.tools.length : 0);
      return { system, events, requests: reqs, tools: Math.max.apply(null, tools.concat([0])) };
    };

    const chat = await run(false, 'hello');
    const task = await run(true, 'research something for me');
    A.ok(chat.system.length > 0 && task.system.length > 0, 'both runs reached the provider with a system prompt');

    /* ---- the greeting is on a diet ---- */
    A.eq(chat.tools, 0, 'a non-task turn puts no tool schemas on the wire (unchanged contract)');
    A.ok(chat.system.indexOf('<starnet_operator_manual>') < 0, 'greeting: no operator manual');
    A.ok(chat.system.indexOf('[ORCHESTRATION]') < 0, 'greeting: no delegation briefing (it names tools the turn does not have)');
    A.ok(chat.system.indexOf('[HARNESS]') < 0, 'greeting: no tool note (unchanged contract)');
    const skillHeads = (task.system.match(/^### .+ -- /gm) || []);
    A.ok(skillHeads.length >= 1, 'the task turn carries at least one skill recipe (default-on library skills)');
    A.ok(skillHeads.every(h => chat.system.indexOf(h) < 0), 'greeting: none of those skill recipes ship');
    A.ok(chat.system.indexOf('<capabilities_ground_truth>') >= 0, 'greeting: the capabilities ground truth STAYS (truthful telemetry)');
    A.ok(chat.system.indexOf('[RUNTIME]') >= 0 && chat.system.indexOf('Run id:') >= 0, 'greeting: the runtime identity block STAYS');
    A.ok(chat.system.length < task.system.length * 0.4, 'greeting prompt is under 40% of the task prompt (' + chat.system.length + ' vs ' + task.system.length + ' chars)');

    /* ---- real work is never starved ---- */
    A.ok(task.tools > 0, 'the task turn still puts tool schemas on the wire');
    A.ok(task.system.indexOf('<starnet_operator_manual>') >= 0, 'task: operator manual present');
    A.ok(task.system.indexOf('[ORCHESTRATION]') >= 0, 'task: delegation briefing present');
    A.ok(task.system.indexOf('[HARNESS]') >= 0, 'task: tool note present');
    A.ok(task.system.indexOf('<capabilities_ground_truth>') >= 0, 'task: capabilities ground truth present');

    /* ---- prefix-cache order: the per-run line rides after the byte-stable blocks ---- */
    const iRuntime = task.system.indexOf('[RUNTIME]');
    A.ok(iRuntime > task.system.indexOf('[ORCHESTRATION]'), 'task: [RUNTIME] comes after the [ORCHESTRATION] briefing');
    A.ok(iRuntime > task.system.indexOf('<starnet_operator_manual>'), 'task: [RUNTIME] comes after the manual');
    A.ok(iRuntime > task.system.indexOf('<capabilities_ground_truth>'), 'task: [RUNTIME] comes after the capabilities block');
    A.ok(iRuntime > task.system.lastIndexOf('### '), 'task: [RUNTIME] comes after the last skill recipe');
    A.eq((task.system.match(/Run id: /g) || []).length, 1, 'task: exactly one run id line');

    // A per-request ceiling must not trigger four more generations of a greeting. Real tasks still
    // need semantic continuation to finish an answer or reissue a cut-off tool call.
    const cappedChat = await run(false, 'hello cap regression');
    A.eq(cappedChat.requests.length, 1, 'a capped casual reply stops after one generation');
    A.ok(cappedChat.events.includes('"finishReason":"length"'), 'the partial reply retains its output-limit status');
    A.ok(cappedChat.events.includes('"delta":"ok"'), 'the partial reply is retained in the live stream');
    const cappedTask = await run(true, 'write cap regression');
    A.ok(cappedTask.requests.some(q => q.messages.some(m => String(m.content).includes('<output_continuation>'))), 'real tasks retain semantic continuation');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('chat-prompt-diet.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
