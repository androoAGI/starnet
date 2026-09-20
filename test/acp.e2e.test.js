/* node test/acp.e2e.test.js — StarNet's ACP agent, end to end, as an EDITOR would drive it.

   test/acp-core.test.js proves the protocol decisions against fakes. This is the honest proof that the surface
   exists: it boots the REAL sidecar, SPAWNS the real bridge process (sidecar/acp/serve.js) exactly the way an
   editor does, and speaks JSON-RPC 2.0 over its stdin/stdout as a client. Nothing is stubbed on either side of
   the pipe — the bridge discovers the station's per-launch token by scraping the served page (no --token given,
   so that path is under test too), drives a real agent run through /api/run, and the answer comes back as
   session/update notifications.

   What it locks:
     1. the handshake works over real stdio framing (and stdout carries ONLY protocol — a stray log byte here
        would corrupt the stream and an editor would drop the agent);
     2. a prompt produces a real run whose text streams back as agent_message_chunk;
     3. a tool call appears as a live tool_call / tool_call_update pair with a human title and a file location;
     4. the station's consent gate surfaces as a native session/request_permission, and the ANSWER reaches the
        station — an approved write really happens, a rejected one really does not;
     5. session/cancel stops a turn, and the turn still resolves (an unresolved prompt hangs the editor);
     6. with the station DOWN, the bridge answers with an honest error instead of a fabricated reply. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const SERVE = path.resolve(__dirname, '..', 'sidecar', 'acp', 'serve.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Content-driven mock provider — a queue desyncs, because a real run also makes reflection/aux calls this test
   never asked for. See test/routine-manage.e2e.test.js for the same note. */
function startMockOpenRouter(script) {
  const held = [];   // completions parked open by a `hold` rule, so a run stays genuinely in flight
  function decide(body) {
    const msgs = (body && body.messages) || [];
    const toolResults = msgs.filter(m => m && m.role === 'tool');
    if (toolResults.length) {
      const last = String(toolResults[toolResults.length - 1].content || '');
      return { text: last.indexOf('PROJECT_RELATIVE_ACP') >= 0 ? 'Observed PROJECT_RELATIVE_ACP through the native file tool.' : 'done' };
    }
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = String((lastUser && lastUser.content) || '').toLowerCase();
    return script.find(r => text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          let parsed = null; try { parsed = JSON.parse(body); } catch (_) {}
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (turn.hold) {
            // stream one delta then PARK: the run is provably in flight until release() is called
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'working' } }] }) + '\n\n');
            held.push(() => {
              res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' finished' } }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
              res.write('data: [DONE]\n\n');
              res.end();
            });
            return;
          }
          if (turn.tool) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          } else {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({
      server,
      inflight: () => held.length,
      release: () => { const fns = held.splice(0); fns.forEach(fn => { try { fn(); } catch (_) {} }); },
      base: 'http://' + HOST + ':' + server.address().port + '/api/v1'
    }));
  });
}

function bootSidecar(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], {
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && /already in use/i.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(bootSidecar(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('sidecar boot timeout:\n' + out)); } }, 9000);
  });
}

/* An ACP CLIENT: spawns the bridge and speaks JSON-RPC over its pipes, exactly as an editor does.
   `onPermission(params) -> optionId | null` decides how this "editor" answers a permission card. */
function makeAcpClient(port, onPermission) {
  const child = spawn(process.execPath, [SERVE, '--port=' + port], { stdio: ['pipe', 'pipe', 'pipe'] });
  let nextId = 0;
  const pending = new Map();
  const notifications = [];
  const stderr = [];
  const stdoutRaw = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => stderr.push(d));

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdoutRaw.push(chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg = null;
      try { msg = JSON.parse(line); }
      catch (_) { A.ok(false, 'the bridge wrote NON-JSON to stdout (this corrupts the protocol): ' + line.slice(0, 200)); continue; }

      if (msg.method && msg.id !== undefined) {
        // an agent -> client REQUEST (session/request_permission)
        const optionId = onPermission ? onPermission(msg.method, msg.params) : null;
        const result = optionId
          ? { outcome: { outcome: 'selected', optionId: optionId } }
          : { outcome: { outcome: 'cancelled' } };
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result }) + '\n');
        continue;
      }
      if (msg.method) { notifications.push(msg); continue; }          // a notification
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p(msg); }
    }
  });

  function send(method, params, timeoutMs) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out\nbridge stderr:\n' + stderr.join(''))); }, timeoutMs || 30000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} }) + '\n');
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {} }) + '\n');
  }
  return {
    child, notifications, send, notify,
    stderr: () => stderr.join(''),
    stdout: () => stdoutRaw.join(''),
    updates(sessionId) {
      return notifications
        .filter(n => n.method === 'session/update' && (!sessionId || n.params.sessionId === sessionId))
        .map(n => n.params.update);
    },
    textFor(sessionId) {
      return this.updates(sessionId).filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('');
    },
    clear() { this.notifications.length = 0; },
    kill() { try { child.kill(); } catch (_) {} }
  };
}

(async () => {
  const mock = await startMockOpenRouter([
    { when: 'say hello', text: 'Hello from the station.' },
    { when: 'write the notes file', tool: { name: 'fs.write', args: { path: 'acp-notes.md', content: 'written through ACP' } } },
    { when: 'write the secret file', tool: { name: 'fs.write', args: { path: 'acp-denied.md', content: 'must never exist' } } },
    { when: 'read the notes file', tool: { name: 'fs.read', args: { path: 'acp-notes.md' } } },
    { when: 'read the project incident', tool: { name: 'fs.read', args: { path: 'incident.log' } } },
    { when: 'work slowly', hold: true }
  ]);
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-acp-')));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sk-acp-project-')));
  fs.writeFileSync(path.join(project, 'incident.log'), 'PROJECT_RELATIVE_ACP\n', 'utf8');
  const projectGrant = 'path:' + path.resolve(project);
  fs.writeFileSync(path.join(ws, 'permissions.allow.json'), JSON.stringify({ version: 1, allow: [projectGrant], meta: { [projectGrant]: { grantedAt: 1 } } }), 'utf8');
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-acp-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child: sidecar, port } = await bootSidecar(9110 + (process.pid % 40), env, 20);

  // the "editor" approves a write to acp-notes.md and rejects everything else, so both directions are proven
  const decisions = [];
  let client = makeAcpClient(port, (method, params) => {
    decisions.push({ method, title: params && params.toolCall && params.toolCall.title, params });
    const t = String((params && params.toolCall && params.toolCall.title) || '');
    return /acp-notes\.md/.test(t) ? 'once' : null;
  });

  try {
    /* ---- 1. the handshake over real stdio ------------------------------------------------------ */
    let sessionId = '';
    {
      const r = await client.send('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'starnet-acp-e2e', version: '1.0.0' }
      });
      A.ok(r.result, 'initialize answered: ' + JSON.stringify(r.error || '').slice(0, 200));
      A.eq(r.result.protocolVersion, 1, 'the bridge answers protocol v1');
      A.eq(r.result.agentInfo.name, 'starnet', 'the agent identifies as starnet');
      A.eq(r.result.agentCapabilities.loadSession, true, 'loadSession is advertised over the wire');

      const s = await client.send('session/new', { cwd: process.cwd(), mcpServers: [] });
      sessionId = s.result && s.result.sessionId;
      A.ok(sessionId, 'session/new returned a sessionId: ' + sessionId);
    }

    /* ---- 2. a real run, streamed back as session/update ---------------------------------------- */
    {
      client.clear();
      const r = await client.send('session/prompt', {
        sessionId: sessionId, prompt: [{ type: 'text', text: 'say hello' }]
      }, 60000);
      A.ok(r.result, 'session/prompt answered: ' + JSON.stringify(r.error || '').slice(0, 300));
      A.eq(r.result.stopReason, 'end_turn', 'a clean turn stops with end_turn');
      A.ok(client.textFor(sessionId).indexOf('Hello from the station.') >= 0,
        'the model text really streamed back through ACP: ' + JSON.stringify(client.textFor(sessionId)));
      A.ok(client.updates(sessionId).length >= 1, 'the answer arrived as session/update notifications, not in the response body');
    }

    /* ---- 3+4. a tool call, a native permission card, and an APPROVED write that really lands --- */
    {
      client.clear();
      decisions.length = 0;
      const r = await client.send('session/prompt', {
        sessionId: sessionId, prompt: [{ type: 'text', text: 'write the notes file' }]
      }, 90000);
      A.ok(r.result, 'the write turn answered: ' + JSON.stringify(r.error || '').slice(0, 300));

      const perm = decisions.find(d => d.method === 'session/request_permission');
      A.ok(perm, 'the station consent gate surfaced in the editor as session/request_permission');
      A.ok(/acp-notes\.md/.test(perm.title), 'the card names the file in words: ' + perm.title);
      A.eq(perm.params.toolCall.kind, 'edit', 'a write is presented as an EDIT');
      A.eq(perm.params.options.map(o => o.optionId).join(','), 'once,session,deny', 'the three real options are offered');

      const tc = client.updates(sessionId).find(u => u.sessionUpdate === 'tool_call');
      A.ok(tc, 'the tool call was announced to the editor');
      A.eq(tc.kind, 'edit', 'the announced call is an edit');
      A.ok(/acp-notes\.md/.test(tc.title), 'with a human title: ' + tc.title);
      A.ok(tc.locations && tc.locations[0] && /acp-notes\.md/.test(tc.locations[0].path),
        'and a LOCATION the editor can jump to');
      const upd = client.updates(sessionId).find(u => u.sessionUpdate === 'tool_call_update');
      A.ok(upd, 'and it was closed out with a tool_call_update');
      A.eq(upd.status, 'completed', 'the approved write completed');

      /* THE READ-BACK. An approved permission answer must actually reach the station, or the card is theatre.
         The file lives in the agent's workspace jail, so its presence on disk is the proof. */
      const written = path.join(ws, 'agent', 'acp-notes.md');
      A.ok(fs.existsSync(written), 'the APPROVED write really happened on disk at ' + written);
      A.ok(fs.readFileSync(written, 'utf8').indexOf('written through ACP') >= 0, 'with the content the agent sent');
    }

    /* ---- 4b. a REJECTED card must stop the write ----------------------------------------------- */
    {
      client.clear();
      decisions.length = 0;
      const r = await client.send('session/prompt', {
        sessionId: sessionId, prompt: [{ type: 'text', text: 'write the secret file' }]
      }, 90000);
      A.ok(r.result, 'the rejected turn still answered');
      A.ok(decisions.some(d => d.method === 'session/request_permission'), 'a permission card was raised');
      const upd = client.updates(sessionId).find(u => u.sessionUpdate === 'tool_call_update');
      A.eq(upd && upd.status, 'failed', 'the denied tool call renders as FAILED in the editor');
      A.ok(!fs.existsSync(path.join(ws, 'agent', 'acp-denied.md')),
        'the REJECTED write never happened — the editor answer really is the gate');
    }

    /* ---- 4c. ACP cwd is a blessed project root for native RELATIVE file calls ------------------ */
    {
      client.clear();
      const scoped = await client.send('session/new', { cwd: path.resolve(project), mcpServers: [] });
      const scopedId = scoped.result && scoped.result.sessionId;
      A.ok(scopedId, 'ACP opens a project-scoped session at the editor cwd');
      const r = await client.send('session/prompt', {
        sessionId: scopedId, prompt: [{ type: 'text', text: 'read the project incident' }]
      }, 90000);
      A.ok(r.result, 'the project-relative ACP read turn answered');
      A.ok(client.textFor(scopedId).indexOf('PROJECT_RELATIVE_ACP') >= 0,
        'ACP → /api/run → native fs.read resolves incident.log at the blessed editor cwd');
      A.ok(!fs.existsSync(path.join(ws, 'agent', 'incident.log')),
        'the ACP project read did not silently fall back to the private workspace');
    }

    /* ---- 5. cancel: the turn stops, resolves, and is reported as a CANCEL — not a failure -------
       The first cut accepted either 'cancelled' or 'end_turn' here, and that looseness hid a real bug: the
       cancel destroyed the socket immediately, racing ahead of the station's own settle, so the turn came back
       as 'end_turn' with "(StarNet could not complete this turn: aborted)" AND "(stopped: the run failed inside
       StarNet — check the station log)". Pressing Esc told the user their work had crashed. Assert the exact
       reason, and assert the failure wording is ABSENT. */
    {
      client.clear();
      /* The turn must still be RUNNING when the cancel lands, or this proves nothing: a fast tool turn finishes
         inside the sleep and then honestly reports how it really ended ('done'), which is correct behaviour and
         not a cancel. So hold the provider open. */
      const inflight = client.send('session/prompt', {
        sessionId: sessionId, prompt: [{ type: 'text', text: 'work slowly (cancel probe)' }]
      }, 60000);
      await sleep(1200);
      A.ok(mock.inflight() >= 1, 'the run is genuinely in flight when the cancel is sent');
      client.notify('session/cancel', { sessionId: sessionId });
      const r = await inflight;
      A.ok(r.result, 'a cancelled prompt still RESOLVES — an unresolved turn hangs the editor forever');
      A.eq(r.result.stopReason, 'cancelled', 'a user cancel reports stopReason CANCELLED, not a generic end_turn');
      const said = client.textFor(sessionId);
      A.ok(!/could not complete this turn/.test(said), 'a deliberate cancel is NOT reported as a transport failure: ' + JSON.stringify(said).slice(0, 200));
      A.ok(!/the run failed inside StarNet/.test(said), 'and does NOT tell the user to go check the station log');
      mock.release();   // drop the parked completion so the next phase starts from a clean inflight count
    }

    /* ---- 5b. CANCELLING ONE SESSION MUST NOT TOUCH ANOTHER -------------------------------------
       An editor keeps several sessions on one bridge process. The first cut tracked the in-flight runId in a
       MODULE-LEVEL variable, so a second session's agent.run.start overwrote it and a session/cancel posted
       /api/cancel with the WRONG runId — aborting the other session's run while leaving the cancelled one to
       die on a destroyed socket. The runId is now closure-local per run; this proves it. */
    {
      client.clear();
      const a = (await client.send('session/new', { cwd: process.cwd() })).result.sessionId;
      const b = (await client.send('session/new', { cwd: process.cwd() })).result.sessionId;
      A.ok(a !== b, 'two distinct sessions on one bridge');

      const runA = client.send('session/prompt', { sessionId: a, prompt: [{ type: 'text', text: 'work slowly (alpha)' }] }, 90000);
      await sleep(900);
      const runB = client.send('session/prompt', { sessionId: b, prompt: [{ type: 'text', text: 'work slowly (beta)' }] }, 90000);
      await sleep(1600);
      A.eq(mock.inflight(), 2, 'both runs are genuinely in flight (the provider is holding two completions)');

      client.notify('session/cancel', { sessionId: a });          // cancel ONLY session A
      const rA = await runA;
      A.eq(rA.result.stopReason, 'cancelled', 'the cancelled session reports cancelled');

      await sleep(300);
      mock.release();                                             // let B finish naturally
      const rB = await runB;
      A.eq(rB.result.stopReason, 'end_turn', 'the OTHER session finished normally — cancelling A did not abort B');
      A.ok(client.textFor(b).indexOf('finished') >= 0,
        'and B really produced its full answer: ' + JSON.stringify(client.textFor(b)).slice(0, 120));
    }

    /* ---- protocol hygiene: stdout carried ONLY JSON-RPC --------------------------------------- */
    {
      const lines = client.stdout().split('\n').filter(l => l.trim());
      A.ok(lines.length > 0, 'the bridge wrote to stdout');
      let allJson = true;
      for (const l of lines) { try { JSON.parse(l); } catch (_) { allJson = false; } }
      A.ok(allJson, 'EVERY stdout line is JSON — a single log byte on stdout would corrupt the protocol');
      A.ok(client.stderr().indexOf('[acp]') >= 0, 'and the bridge logs to stderr, where it belongs');
    }
  } finally {
    client.kill();
    try { sidecar.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(200);
  }

  /* ---- 6. WITH THE STATION DOWN, the bridge must be honest --------------------------------------
     The failure mode this forbids: an editor session that answers plausibly while nothing is actually running.
     Port 9 (discard) is closed, so token discovery fails and the run cannot start. */
  {
    const lonely = makeAcpClient(9, () => null);
    try {
      const init = await lonely.send('initialize', { protocolVersion: 1, clientInfo: { name: 'e2e' } }, 20000);
      A.ok(init.result, 'the bridge still initializes with no station — it must load in the editor to explain itself');
      const s = await lonely.send('session/new', { cwd: process.cwd() }, 20000);
      A.ok(s.result.sessionId, 'and still opens a session');
      const r = await lonely.send('session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'hello' }] }, 30000);
      A.ok(r.result, 'a prompt against a dead station still resolves the turn');
      const said = lonely.textFor(s.result.sessionId);
      A.ok(/could not complete this turn/.test(said), 'and says plainly that it could not run: ' + JSON.stringify(said).slice(0, 300));
      A.ok(/StarNet is not running|not reachable/.test(said), 'naming the real cause rather than inventing an answer');
    } finally { lonely.kill(); await sleep(150); }
  }

  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(project, { recursive: true, force: true }); } catch (_) {}
  A.report('acp.e2e.test');
})().catch(e => { console.log('FAIL: acp.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
