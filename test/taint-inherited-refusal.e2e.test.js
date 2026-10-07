/* node test/taint-inherited-refusal.e2e.test.js — an INHERITED taint lock tells the truth and names the way out.

   A delegated worker starts with its lead's taint (orchestration connectorOptions -> initialTaint): the lead's chat
   had the Commander's attachment in it, so the handed-over instructions may carry that content. The lock is correct
   (sec-taint 09-25) — but the refusal used to say "This run has already read outside content", which a worker that
   read nothing has not done, and gave no way forward (a customer then told the worker "don't read attachments").

   Boots the REAL sidecar (hermetic SidecarFixture + content-driven mock OpenRouter, zero spend):
     1. an owner APP run on the lead WITH an attachment dispatches worker-1; worker-1 (approvalMode ask, no Full
        Access) calls web_request (credentialed) as its first call -> refused, and the refusal names the delegating agent + the
        new-session remedy, never "has already read outside content";
     2. the same lead in a NEW session with no attachment hands over cleanly; the worker itself reads an uploaded
        document and then calls web_request -> refused with the own-read wording (the wording follows the real cause).
   NOT in test:fast (child-process boot); listed in test/http.list. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const WORKER_MARK = 'WORKER_SYS_MARKER_INHERIT';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function startMock() {
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 32000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      let body = ''; req.on('data', d => { body += d; }); req.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
        const msgs = (parsed && parsed.messages) || [];
        const sys = msgs[0] && msgs[0].role === 'system' ? String(msgs[0].content || '') : '';
        const isWorker = sys.indexOf(WORKER_MARK) >= 0;
        const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
        const said = JSON.stringify((lastUser && lastUser.content) || '');
        const toolsSeen = msgs.slice(msgs.lastIndexOf(lastUser) + 1).filter(m => m && m.role === 'tool').length;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const usage = { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 };
        const call = (id, name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage }) + '\n\n');
        };
        const text = (t) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
        };
        if (isWorker && said.indexOf('DIRECT_READ') >= 0) {
          if (toolsSeen === 0) call('w_read', 'fs_read', { path: '.attachments/poison.txt' });
          else if (toolsSeen === 1) call('w_req2', 'web_request', { method: 'GET', url: 'https://api.example.com/own-read' });
          else text('worker done');
        } else if (isWorker) {
          if (toolsSeen === 0) call('w_req', 'web_request', { method: 'GET', url: 'https://api.example.com/inherited' });
          else text('worker done');
        } else if (said.indexOf('DELEGATE_NOW') >= 0 || said.indexOf('DELEGATE_READ') >= 0) {
          const read = said.indexOf('DELEGATE_READ') >= 0, dispId = read ? 'l_disp2' : 'l_disp';
          if (toolsSeen === 0) call(read ? 'l_brief2' : 'l_brief', 'brief_proceed', { objective: 'have worker-1 run the build' });   // settle the Task Brief gate
          else if (!msgs.some(m => m.role === 'tool' && m.tool_call_id === dispId)) call(dispId, 'team_dispatch', { workers: [{ agentId: 'worker-1', prompt: read ? 'DIRECT_READ: read the uploaded document, then run the build' : 'run the build and report' }] });
          else text('LEAD ACK');
        } else text('nothing to do');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// the tool message the mock was handed for a given tool call id (a tool turn replays on every later request)
function toolResult(requests, callId) {
  for (const rq of requests) for (const m of ((rq && rq.messages) || [])) {
    if (m && m.role === 'tool' && m.tool_call_id === callId) return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  }
  return null;
}

(async () => {
  const mock = await startMock();
  const fixture = SidecarFixture.create({ prefix: 'taint-inherit-', timeoutMs: 20000, env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'fixture', STARNET_OPENROUTER_KEY: 'fixture',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_ENABLED: '0', STARNET_CRON_ENABLED: '0',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: ''
  } });
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'lead-1', name: 'LEAD', model: 'test/model', provider: 'openrouter', approvalMode: 'full' },
      { agentId: 'worker-1', system: WORKER_MARK + ' — you are a worker.', name: 'WORKER', model: 'test/model', provider: 'openrouter', approvalMode: 'ask' }
    ] });
    A.eq(roster.status, 200, 'the lead (Full Access) and the worker (ask) are on the roster');

    /* ---- 1. inherited: the lead's chat holds the Commander's attachment ---- */
    const up = await fixture.json('POST', '/api/attachments', { agent: 'lead-1', name: 'pixel.png', dataUrl: 'data:image/png;base64,' + PNG_B64 });
    A.eq(up.status, 200, 'the owner uploads an attachment');
    const ref = up.body || {};
    const r1 = await fixture.json('POST', '/api/run', { key: 'sk-or-v1-fake', model: 'test/model', provider: 'openrouter', agentId: 'lead-1', isTask: true, streamId: 'S-inherit',
      messages: [{ role: 'user', content: 'DELEGATE_NOW: have worker-1 run the build', attachments: [{ id: ref.id, name: 'pixel.png', path: ref.path, mediaType: 'image/png', kind: 'image' }] }] });
    A.eq(r1.status, 200, 'the lead run streams');
    const inherited = toolResult(mock.requests, 'w_req');
    A.ok(inherited && /^(?:ERROR: )?BLOCKED: "web[._]request" is no longer available on this run/.test(inherited), 'the worker\'s credentialed web_request is refused by the inherited lock (got ' + JSON.stringify(inherited && inherited.slice(0, 200)) + ')');
    A.ok(inherited && /handed over by lead-1/.test(inherited) && /user attachment/.test(inherited), 'the refusal names the delegating agent and the real source');
    A.ok(inherited && /new session whose history has no attachments or outside pages/.test(inherited), 'the refusal names the structural way to an unlocked run');
    A.ok(inherited && inherited.indexOf('has already read outside content') < 0, 'it never claims a worker that read nothing "has already read outside content"');
    A.ok(inherited && /report the withheld step plainly/.test(inherited), 'the worker is still told to report the withheld step');

    /* ---- 2. own read: a CLEAN lead in a new session hands over; the worker itself reads a document ---- */
    const r2 = await fixture.json('POST', '/api/run', { key: 'sk-or-v1-fake', model: 'test/model', provider: 'openrouter', agentId: 'lead-1', isTask: true, streamId: 'S-own',
      messages: [{ role: 'user', content: 'DELEGATE_READ: have worker-1 read the uploaded document, then run the build' }] });
    A.eq(r2.status, 200, 'the clean lead run streams');
    const own = toolResult(mock.requests, 'w_req2');
    A.ok(own && /^(?:ERROR: )?BLOCKED: "web[._]request" is no longer available on this run/.test(own), 'the worker that read the document is locked (got ' + JSON.stringify(own && own.slice(0, 200)) + ')');
    A.ok(own && /has already read outside content \(via fs\.read\)/.test(own), 'a run that read the content itself keeps the own-read wording');
    A.ok(own && !/handed over by/.test(own), 'and never blames the lead, whose new session was clean');
  } catch (e) {
    console.error(e && e.stack || e);
    console.error('--- sidecar output (tail) ---\n' + String(fixture.output()).slice(-3000));
    process.exitCode = 1;
  } finally {
    await fixture.dispose();
    try { mock.server.closeAllConnections(); mock.server.close(); } catch (e) { console.warn(e.message); }
  }
  A.report('taint-inherited-refusal.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
