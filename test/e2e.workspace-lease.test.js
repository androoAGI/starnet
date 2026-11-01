/* node test/e2e.workspace-lease.test.js — TRUE end-to-end for the CONCURRENT-SESSIONS workspace lease:
   boot the ACTUAL sidecar and drive two same-agent runs whose (mocked) model calls fs_write, so the lease
   engages through the REAL dispatch spine (loop → dispatch → mutatesWorkspace → workspaceLease), not just
   the unit surface. Proves both sides of the contract:
     1. WAIT + FIFO HANDOFF (default lease wait): run A takes the lease with its write and stays live on a
        slow final turn; run B's write WAITS, the lease hands off when A ends, and BOTH writes land.
     2. BOUNDED TRUTHFUL REFUSAL (tiny STARNET_WORKSPACE_LEASE_WAIT_MS): B's write times out, the model gets
        the truthful workspace-busy tool error, the run still completes clean, and B's file does NOT exist.
   No real key, no network. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
// the run-context note is the leading text of the newest user message on a non-Claude chat wire: match the Commander's own words
const { userWords } = require('./helpers/host-notes.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');
const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

// mock OpenRouter, three turns keyed on how many tool results are in the transcript:
//   turn 1 → brief_proceed (the Task Brief gate blocks mutating tools until the brief settles);
//   turn 2 → fs_write the file named in the directive ("WRITE <relpath> [SLOWFINISH]");
//   turn 3 → final text, held explicitly when the directive says SLOWFINISH. Test barriers prove
//            A acquired its lease before B starts, independent of machine load.
function startMockOpenRouter() {
  const requests = [];   // every completions transcript — the tool-result CONTENT (model-facing) is only visible here
  const held = new Map();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
          let msgs = []; try { msgs = (JSON.parse(body).messages) || []; } catch (_) {}
          requests.push(msgs);
          const toolResults = msgs.filter(m => m && m.role === 'tool').length;
          const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
          const directive = lastUser ? userWords(lastUser) : '';
          const m = /WRITE\s+(\S+)/.exec(directive);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const toolTurn = (id, name, args) => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (toolResults === 0 && m) { toolTurn('p1', 'brief_proceed', { objective: 'write the requested file' }); return; }
          if (toolResults === 1 && m) { toolTurn('w1', 'fs_write', { path: m[1], content: 'payload of ' + m[1] }); return; }
          const finish = () => {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'work complete' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } }) + '\n\n');
            res.write('data: [DONE]\n\n'); res.end();
          };
          if (directive.indexOf('SLOWFINISH') >= 0 && m) held.set(m[1], finish); else finish();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({ server, requests, held,
      release(name) { const finish = held.get(name); held.delete(name); if (finish) finish(); },
      base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) { settled = true; try { child.kill(); } catch (_) {} if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port')); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

function findFile(root, name) {   // recursive: workspace layout is the sidecar's business, not this test's
  let hits = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return hits; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) hits = hits.concat(findFile(p, name));
    else if (e.name === name) hits.push(p);
  }
  return hits;
}

async function driveRun(B, token, agentId, text, streamId) {
  const res = await fetch(B + '/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId, streamId, isTask: true, placed: ['cabinet'], messages: [{ role: 'user', content: text }] })
  });
  return res.text();
}
const endsOf = raw => raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
  .filter(e => e && e.name === 'agent.run.end').map(e => e.payload.reason);

async function untilReady(check, label) {
  const deadline = Date.now() + 15000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for ' + label);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

(async () => {
  const mock = await startMockOpenRouter();

  // ===== scenario 1: WAIT + FIFO HANDOFF (default 45s lease wait) =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wlease-ws1-'));
    const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1' };
    const { child, port } = await boot(await allocatePort(), env, 25);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const pA = driveRun(B, token, 'lease-agent', 'WRITE a.txt SLOWFINISH', 'sess-a');
      await untilReady(() => mock.held.has('a.txt') && findFile(ws, 'a.txt').length === 1, 'A holds the lease');
      const pB = driveRun(B, token, 'lease-agent', 'WRITE b.txt', 'sess-b');               // same agent: write must WAIT
      await untilReady(() => mock.requests.some(msgs => msgs.some(m => m.role === 'user' && userWords(m) === 'WRITE b.txt') && msgs.filter(m => m.role === 'tool').length === 1), 'B requests its write');
      A.eq(findFile(ws, 'b.txt').length, 0, 'B cannot write while A is held');
      mock.release('a.txt');
      const [rawA, rawB] = await Promise.all([pA, pB]);
      A.eq(endsOf(rawA)[0], 'done', 'scenario 1: run A (lease holder) completed clean');
      A.eq(endsOf(rawB)[0], 'done', 'scenario 1: run B (waiter) completed clean');
      A.ok(rawB.indexOf('workspace-busy') < 0 && rawB.indexOf('workspace busy') < 0,
        'scenario 1: B never saw a workspace-busy error — its write WAITED for the FIFO handoff');
      A.eq(findFile(ws, 'a.txt').length, 1, 'scenario 1: A\'s file landed on disk');
      A.eq(findFile(ws, 'b.txt').length, 1, 'scenario 1: B\'s file landed on disk AFTER the handoff (no clobber, no loss)');
    } finally { try { child.kill(); } catch (_) {} }
  }

  // ===== scenario 2: BOUNDED TRUTHFUL REFUSAL (250ms lease wait) =====
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wlease-ws2-'));
    const env = { SKYNET_WORKSPACES: ws, SKYNET_OPENROUTER_BASE: mock.base, SKYNET_FULL_ACCESS: '1', STARNET_WORKSPACE_LEASE_WAIT_MS: '250' };
    const { child, port } = await boot(await allocatePort(), env, 25);
    const B = 'http://' + HOST + ':' + port;
    try {
      const token = await bootToken(B, B);
      const pA = driveRun(B, token, 'lease-agent', 'WRITE a2.txt SLOWFINISH', 'sess-a2');
      await untilReady(() => mock.held.has('a2.txt') && findFile(ws, 'a2.txt').length === 1, 'A2 holds the lease');
      const rawB = await driveRun(B, token, 'lease-agent', 'WRITE b2.txt', 'sess-b2');     // A remains held through the refusal
      mock.release('a2.txt');
      const rawA = await pA;
      A.eq(endsOf(rawA)[0], 'done', 'scenario 2: the lease holder completed clean');
      A.eq(endsOf(rawB)[0], 'done', 'scenario 2: the refused run still completed clean (tool error, not run error)');
      A.ok(rawB.indexOf('workspace-busy') >= 0, 'scenario 2: B\'s tool result carries the truthful workspace-busy refusal');
      // the refusal's model-facing CONTENT (holder naming) rides the transcript back to the provider, not the NDJSON
      const busyToolMsg = mock.requests.flat().find(m => m && m.role === 'tool' && String(m.content || '').indexOf('workspace busy') >= 0);
      A.ok(!!busyToolMsg, 'scenario 2: the model received the workspace-busy tool result');
      A.ok(String((busyToolMsg || {}).content || '').indexOf('session: sess-a2') >= 0, 'scenario 2: the refusal NAMES the holder session');
      A.eq(findFile(ws, 'a2.txt').length, 1, 'scenario 2: the holder\'s file landed');
      A.eq(findFile(ws, 'b2.txt').length, 0, 'scenario 2: the refused write did NOT land (no silent half-write)');
    } finally { try { child.kill(); } catch (_) {} }
  }

  try { mock.server.close(); } catch (_) {}
  A.report('e2e.workspace-lease.test');
})().catch(e => { console.error(e); process.exit(1); });
