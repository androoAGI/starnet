/* node test/ask-brief-before-approval.e2e.test.js — ONE approval for one command (authority-census, live walk W-A1).

   THE WALK (C:/Users/andro/gen-trees/_logs/walk-evidence-0142, W-A1-b2 run dc6b2392-956d-49b3-9d39-bd56e9652c0c; the same
   shape in W-A1-b3 8a949c1a-6243-4e52-b80c-746f1d845ceb and W-A1-c e33f7df9-e0e1-4a63-bfe8-59b32846a701): an ASK run with
   outside content in its context asked shell_exec. The post-taint exact-call card opened, the Commander clicked Approve
   once, and the result was "not run yet — waiting on the task brief". The model settled the brief, made the IDENTICAL call
   again, and the Commander was asked to approve the same command a second time. The first approval bought nothing.

   CAUSE (a5-ask-double-approval-trace.json): dispatch awaited the post-taint confirmation BEFORE the Task Brief gate; the
   held return dropped the dispatch-local one-shot, and the retry is a new dispatch that asks again.

   THE FIX UNDER TEST: a call the brief will hold is held before any card opens. This test drives that exact sequence through
   the real sidecar — /api/run, a run tainted from its first turn (a Commander attachment), an unsettled Task Brief, the real
   shell.exec — with a scripted provider: shell_exec -> (held) -> brief_proceed -> the identical shell_exec -> done.
   On 748b0462595 it sees two shell.exec cards for one executed command; now it sees one. The separate contracts stay: the
   first call is still held (the brief is settled first), the card still approves only that one prepared call, and the
   command runs exactly once. */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const CMD = 'node -e "console.log(\'W_A1_SHELL_RAN\')"';

function startScriptedProvider() {
  return new Promise(resolve => {
    const requests = [];
    const server = http.createServer((req, res) => {
      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (!req.url.includes('/chat/completions')) { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = {}; try { body = JSON.parse(raw); } catch (_) {}
        requests.push(body);
        const results = (body.messages || []).filter(m => m && m.role === 'tool').length;
        const call = (id, name, args) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (results === 0) call('shell_1', 'shell_exec', { cmd: CMD });
        else if (results === 1) call('brief_1', 'brief_proceed', { objective: 'run the requested command once', deliverable: 'its output', assumptions: ['use the placed workbench'] });
        else if (results === 2) call('shell_2', 'shell_exec', { cmd: CMD });   // the IDENTICAL call, as the hold told it to
        else res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: results <= 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: 'http://127.0.0.1:' + server.address().port + '/api/v1' }));
  });
}

async function drive(fixture) {
  const response = await fixture.request('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: 'sk-or-v1-w-a1-fake', provider: 'openrouter', model: 'test/model',
      agentId: 'walker', streamId: 'w-a1-' + Date.now(), isTask: true,
      placed: [{ objectType: 'workbench' }],
      // a Commander attachment: outside bytes in this run's context from its first turn (handleRun initialTaint)
      messages: [{ role: 'user', content: 'Run the check command in the workbench and tell me what it prints.', attachments: [{ id: 'w-a1-missing', name: 'notes.txt', kind: 'file' }] }]
    })
  });
  A.eq(response.status, 200, 'the real /api/run admitted the task');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', runId = '';
  const events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      events.push(ev);
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      // the Commander clicks Approve once on every card, exactly as in the walk
      if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'once' });
    }
  }
  return events;
}

(async () => {
  const provider = await startScriptedProvider();
  const fixture = SidecarFixture.create({
    prefix: 'sk-w-a1-',
    env: {
      SKYNET_OPENROUTER_BASE: provider.baseUrl, STARNET_OPENROUTER_BASE: provider.baseUrl,
      SKYNET_OPENROUTER_KEY: 'sk-or-v1-w-a1-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-w-a1-fake',
      SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
      SKYNET_FULL_ACCESS: '0', SKYNET_CONSENT_TIMEOUT_MS: '8000', STARNET_CONSENT_TIMEOUT_MS: '8000'
    }
  });
  try {
    await fixture.start();
    const seeded = await fixture.json('POST', '/api/roster', {
      updatedAt: 100,
      agents: [{ agentId: 'walker', system: 'You are WALKER.', name: 'WALKER', provider: 'openrouter', model: 'test/model', approvalMode: 'ask' }]
    });
    A.ok(seeded.body && seeded.body.ok === true, 'WALKER runs in ASK');

    const events = await drive(fixture);
    const diag = JSON.stringify(events.filter(e => /permission|tool_call|tool_result|run\.end|run\.error/.test(e.name)).map(e => ({ n: e.name, p: { tool: e.payload.tool, name: e.payload.name, callId: e.payload.callId, summary: e.payload.summary, ok: e.payload.ok, held: e.payload.held, reason: e.payload.reason } })));
    const toolMessages = provider.requests.length ? (provider.requests[provider.requests.length - 1].messages || []).filter(m => m && m.role === 'tool') : [];
    const resultOf = id => toolMessages.find(m => m.tool_call_id === id);

    // the walk's sequence happened: first call held on the brief, brief settled, identical call made again
    const first = resultOf('shell_1'), second = resultOf('shell_2');
    A.ok(first && /Task Brief/.test(String(first.content)) && /make this same call again/.test(String(first.content)),
      'the first shell_exec is held on the unsettled Task Brief (the brief is still settled first): ' + JSON.stringify(first && first.content).slice(0, 240));
    A.ok(resultOf('brief_1'), 'the model settled the brief with brief_proceed');
    A.ok(second && /W_A1_SHELL_RAN/.test(String(second.content)), 'the identical second call ran the command: ' + JSON.stringify(second && second.content).slice(0, 240));
    A.ok(!/W_A1_SHELL_RAN/.test(String(first && first.content)), 'the held call ran nothing');

    // THE DEFECT: two cards for one command. One approval now covers the one command that ran.
    const shellCards = events.filter(e => e.name === 'permission.prompt' && e.payload && e.payload.tool === 'shell.exec');
    A.eq(shellCards.length, 1, 'ONE shell.exec approval card for one executed command (748b0462595 asked twice); events=' + diag);
    const cardAt = events.indexOf(shellCards[0]);
    const firstResultAt = events.findIndex(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === 'shell_1');
    A.ok(cardAt > firstResultAt && firstResultAt >= 0, 'the one card opens AFTER the held call returned, i.e. for the prepared call that runs; events=' + diag);
    const ran = toolMessages.filter(m => /W_A1_SHELL_RAN/.test(String(m.content)));
    A.eq(ran.length, 1, 'the command ran exactly once');
    const end = events.find(e => e.name === 'agent.run.end');
    A.ok(end && end.payload && end.payload.reason === 'done', 'the run finishes normally; events=' + diag);
  } finally {
    await fixture.dispose();
    provider.server.close();
  }
  A.report('ask-brief-before-approval.e2e');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
