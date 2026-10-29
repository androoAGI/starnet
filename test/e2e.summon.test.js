/* node test/e2e.summon.test.js — TRUE end-to-end of the team.summon round-trip. Boots the REAL sidecar with a
   MOCK OpenRouter that makes the lead call team.summon, then ACTS AS THE BROWSER: it reads crew.summon.request off
   the live run stream and POSTs /api/summon/ack with a freshly-"minted" agentId, exactly as the Recruitment Bay's
   summonAgent() would. Proves the whole chain wires together — model → tool → crew.summon.request → ack → the new
   id flows back into the model's NEXT request so the lead can delegate to the worker. No real key/model/browser.

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const { bootToken } = require('./_httpToken.js');
const fs = require('fs');
const { spawn } = require('child_process');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// mock OpenRouter: /models -> a minimal catalog; /chat/completions -> the FIRST call returns a team_summon tool
// call (wire name uses underscores), every later call returns a short final completion. Captures each request so
// the test can assert what the model SAW after the tool returned.
function startMockOpenRouter() {
  const requests = [];
  let n = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (++n === 1) {
            // the lead decides to create a researcher: a single complete tool_call delta, then finish_reason
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_summon', type: 'function', function: { name: 'team_summon', arguments: JSON.stringify({ name: 'RESEARCHER', specId: 'researcher' }) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Done — RESEARCHER is on the crew.' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }) + '\n\n');
          }
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

// spawn the real sidecar; resolve once it logs its listen URL. Retries a refused bind (BIND_REFUSED) on a fresh allocatePort().
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-summon-'));
  // SKYNET_FULL_ACCESS so team.summon's consent gate bypasses (no human in this headless e2e) — exactly the
  // full-auto posture; the APPROVAL-mode prompt path is covered by the consent suites.
  const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1' };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');

    // drive a real streaming lead run; the mock makes it call team.summon
    const res = await fetch(B + '/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
      body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: 'summon a research agent for me' }] })
    });
    A.eq(res.status, 200, 'POST /api/run streams (200)');

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', events = [], runId = null, summonReq = null, ackPosted = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
        events.push(ev);
        if (ev.name === 'agent.run.start' && !runId) runId = ev.payload.runId;
        // ACT AS THE BROWSER: the station ran summonAgent() and reports the new agentId back, unblocking the tool.
        if (ev.name === 'crew.summon.request' && !ackPosted) {
          summonReq = ev.payload; ackPosted = true;
          await fetch(B + '/api/summon/ack', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
            // `desk` = where the station's summonAgent() actually seeded the new worker's workstation
            body: JSON.stringify({ runId, requestId: ev.payload.requestId, agentId: 'researcher-2', desk: 'BRIDGE' })
          });
        }
      }
    }

    // 1) the lead actually emitted a summon COMMAND carrying the class the model chose
    A.ok(summonReq, 'the run emitted crew.summon.request (the lead asked the station to create a worker)');
    A.eq(summonReq.name, 'RESEARCHER', 'summon request carries the requested name');
    A.eq(summonReq.specId, 'researcher', 'summon request carries the requested class');
    A.ok(summonReq.requestId, 'summon request carries a requestId for the ack');
    A.eq(summonReq.agentId, 'agent', 'summon request is attributed to the requesting lead');

    // 2) the run completed cleanly — the tool resolved on our ack and the model gave a final answer
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.eq(ends.length, 1, 'exactly one agent.run.end');
    A.eq(ends[0].payload.reason, 'done', 'the run completes with reason done');

    // 3) the team.summon tool returned OK (it received our new agentId, not an error)
    const toolResults = events.filter(e => e.name === 'agent.tool_result');
    A.ok(toolResults.some(e => e.payload.ok && !e.payload.isError), 'the team.summon tool returned ok');

    // 4) THE PROOF: the new agentId flowed back into the model's SECOND request as the tool result, so the lead
    //    can now delegate to the worker it just created.
    A.ok(mock.requests.length >= 2, 'the model was called again after the tool returned');
    const second = mock.requests[mock.requests.length - 1];
    A.ok(JSON.stringify(second.messages || []).indexOf('researcher-2') >= 0, 'the new agentId reached the model (ready for team.dispatch)');

    // 5) THE DESK RIDES ALONG: the workstation the station seeded with the new agent reaches the lead too, so it
    //    never tells the Commander to go build one. Sourced ONLY from the ack — the sidecar invents nothing.
    A.ok(JSON.stringify(second.messages || []).indexOf('BRIDGE') >= 0, 'the seeded workstation location reached the model');
  } finally {
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
  }
  A.report('e2e.summon.test');
})().catch(e => { console.error(e); process.exit(1); });
