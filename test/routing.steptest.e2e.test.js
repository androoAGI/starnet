/* node test/routing.steptest.e2e.test.js — real-sidecar proof for the conveyor STEP-THROUGH TEST routes
   (/api/routing/steptest[/:id[/continue|rerun|rewind|stop|pause]]).

   Over real sockets against the REAL host (boot + content-driven mock provider per routing.sample.e2e.test.js —
   zero real spend, no keys):
     1. the routes sit behind the per-launch token gate; GET answers { ok, session:null } before any test;
     2. refusals are 409 {ok:false,error} (no armed plan, unknown line, unknown id, a second session), bad JSON 400;
     3. a two-dock floor: start -> running -> PAUSED after the entry dock with the exact handoff text + a preview;
        the entry dock's standing brief rode its SYSTEM context;
     4. continue with an EDITED text -> the hop is stamped edited:true, the writer's handoff turn carries the
        owner's words + its own brief, and the writer's durable run row carries handoffEdited:true;
     5. rerun after a brief edit (the plan re-posts) runs the writer again on the SAME input with the NEW brief;
     6. rewind to hop 1 drops the later hops (their spend stays counted) and re-runs from there;
     7. a SIDECAR RESTART while paused: the session comes back paused and continues to the OUTBOX (done, final);
     8. every run is recorded under the session's own streamId in GET /api/runs.

   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// content-driven mock (a real run also makes reflection/aux calls; a queue would desync)
function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
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
          let parsed = null;
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) { parsed = null; }
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
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
      env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) { /* already gone */ }
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) { /* gone */ } reject(new Error('boot timeout:\n' + out)); } }, 20000);
  });
}
function stopChild(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode != null) return resolve();
    child.once('exit', () => resolve());
    try { child.kill(); } catch (_) { resolve(); }
    setTimeout(resolve, 5000);
  });
}

const ENTRY_BRIEF = 'Dig the sources and hand a clean evidence pack downstream.';
const HOP_BRIEF = 'Draft the final answer in press style.';
const HOP_BRIEF2 = 'Draft the final answer as a haiku.';
function twoStagePlan(hopBrief) {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent', brief: ENTRY_BRIEF },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent', brief: hopBrief || HOP_BRIEF },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    { when: 'owner note', text: 'final answer built on the owner note' },   // the writer handed the EDITED text
    { when: 'pipeline handoff', text: 'final answer' },                    // the writer handed stage one's text
    { when: 'steptest job', text: 'stage one findings' }                   // the entry dock's own turn
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-steptest-'));
  const hermes = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-steptest-hermes-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, HERMES_HOME: hermes,
    STARNET_DEV: '', SKYNET_DEV: '',
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-steptest-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  let { child, port } = await boot(await allocatePort(), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const call = (method, p, body) => fetch(B + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) })
      .then(r => r.text().then(t => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } return { status: r.status, j }; }));
    const poll = async (id) => {
      for (let i = 0; i < 300; i++) {
        const g = await call('GET', '/api/routing/steptest/' + id);
        if (g.j && g.j.session && g.j.session.state !== 'running') return g.j.session;
        await sleep(100);
      }
      throw new Error('session never left running');
    };

    /* ---- 1. auth seam + discovery ---- */
    const bare = await fetch(B + '/api/routing/steptest', { headers: { Origin: B } });
    A.eq(bare.status, 403, 'no token -> 403 (the auth seam holds)');
    const none = await call('GET', '/api/routing/steptest');
    A.eq(none.status, 200, 'GET discovers the step-test seam');
    A.eq(none.j, { ok: true, session: null }, 'no session yet');
    A.eq(mock.requests.length, 0, 'discovery never dispatches');

    /* ---- 2. refusals ---- */
    const noPlan = await call('POST', '/api/routing/steptest', { line: 'x', text: 'STEPTEST JOB: go' });
    A.eq(noPlan.status, 409, 'no armed plan -> 409'); A.ok(/no work line is armed/.test(noPlan.j.error), noPlan.j.error);
    const badJson = await call('POST', '/api/routing/steptest', '{not json');
    A.eq(badJson.status, 400, 'unparseable JSON -> 400');
    const unknownId = await call('GET', '/api/routing/steptest/st_nope');
    A.eq(unknownId.status, 409, 'an unknown session id refuses 409 (never 404)');
    const posted = await call('POST', '/api/routing', twoStagePlan());
    A.eq(posted.status, 200, 'the two-stage floor deploys');
    const lineId = Pipeline.lineOf(twoStagePlan(), 'research-agent');
    const badLine = await call('POST', '/api/routing/steptest', { line: 'nope', text: 'STEPTEST JOB: go' });
    A.eq(badLine.status, 409, 'an unknown line -> 409');

    /* ---- 3. start -> paused after the entry dock ---- */
    const started = await call('POST', '/api/routing/steptest', { line: lineId, text: 'STEPTEST JOB: research sleep and memory.' });
    A.eq(started.status, 200, 'start answers 200'); A.eq(started.j.session.state, 'running', 'the session is running');
    const second = await call('POST', '/api/routing/steptest', { line: lineId, text: 'STEPTEST JOB: again' });
    A.eq(second.status, 409, 'a second session while one is active -> 409');
    const id = started.j.session.id;
    let s = await poll(id);
    A.eq(s.state, 'paused', 'paused after the entry dock');
    A.eq(s.hops.length, 1); A.eq(s.hops[0].agentId, 'research-agent'); A.eq(s.hops[0].output, 'stage one findings');
    A.eq(s.paused.text, 'stage one findings', 'the paused handoff text is exactly the dock\'s output');
    A.eq(s.paused.next, { kind: 'agent', agentId: 'writer-agent', back: false, dockId: 'b2' }, 'the preview names the writer — and its bay (additive dockId, multi-bay)');
    A.ok(/^steptest-/.test(s.streamId), 'the session runs under its own stream: ' + s.streamId);
    const sysOf = rq => ((rq && rq.messages) || []).filter(x => x && x.role === 'system').map(x => String(x.content || '')).join('\n');
    const lastUserOf = rq => { const m = [...((rq && rq.messages) || [])].reverse().find(x => x && x.role === 'user'); return String((m && m.content) || ''); };
    const entryReq = mock.requests.find(rq => lastUserOf(rq).indexOf('STEPTEST JOB') >= 0 && lastUserOf(rq).indexOf('PIPELINE HANDOFF') < 0);
    A.ok(entryReq && sysOf(entryReq).indexOf('YOUR STANDING BRIEF FOR THIS STATION:\n' + ENTRY_BRIEF) >= 0, 'the entry dock\'s brief rode its system context');

    /* ---- 4. continue with an EDITED handoff ---- */
    const EDIT = 'stage one findings + OWNER NOTE: cite two studies';
    const c1 = await call('POST', '/api/routing/steptest/' + id + '/continue', { text: EDIT });
    A.eq(c1.status, 200, 'continue answers 200');
    s = await poll(id);
    A.eq(s.state, 'paused', 'paused again after the writer');
    A.eq(s.hops[0].edited, true, 'hop 0\'s outgoing handoff is stamped edited:true');
    A.eq(s.hops[0].sent, EDIT, 'sent is the owner\'s text');
    A.eq(s.hops[1].input, EDIT, 'the writer\'s input is the post-edit text');
    A.eq(s.hops[1].output, 'final answer built on the owner note', 'the writer really worked from the edited text');
    A.eq(s.paused.next, { kind: 'outbox' }, 'next stop: the OUTBOX');
    const hopReq = mock.requests.find(rq => lastUserOf(rq).indexOf('OWNER NOTE') >= 0);
    A.ok(hopReq && /PIPELINE HANDOFF/.test(lastUserOf(hopReq)) && lastUserOf(hopReq).indexOf('YOUR STANDING BRIEF FOR THIS STATION:\n' + HOP_BRIEF) >= 0, 'the writer\'s handoff turn carries the edit AND its brief');
    const runs1 = await call('GET', '/api/runs?agent=*&limit=50');
    const writerRow = ((runs1.j && runs1.j.runs) || []).find(r => r.runId === s.hops[1].runId);
    A.ok(writerRow, 'the writer\'s run is in GET /api/runs');
    A.eq(writerRow && writerRow.handoffEdited, true, 'its durable run row says the owner edited its input');
    const entryRow = ((runs1.j && runs1.j.runs) || []).find(r => r.runId === s.hops[0].runId);
    A.ok(entryRow && !entryRow.handoffEdited, 'the entry run row carries no edit stamp');
    A.ok([writerRow, entryRow].every(r => r && r.streamId === s.streamId), 'both runs are recorded under the session stream');

    /* ---- 5. rerun after a brief edit ---- */
    A.eq((await call('POST', '/api/routing', twoStagePlan(HOP_BRIEF2))).status, 200, 'the floor re-posts with a new writer brief');
    const before = mock.requests.length;
    A.eq((await call('POST', '/api/routing/steptest/' + id + '/rerun', {})).status, 200, 'rerun answers 200');
    s = await poll(id);
    A.eq(s.hops.length, 3); A.eq(s.hops[2].rerun, true); A.eq(s.hops[2].input, EDIT, 'the re-run used the SAME input');
    A.ok(mock.requests.slice(before).some(rq => lastUserOf(rq).indexOf(HOP_BRIEF2) >= 0), 'and the writer\'s NEW brief');

    /* ---- 6. rewind to hop 1 ---- */
    const rw = await call('POST', '/api/routing/steptest/' + id + '/rewind', { hop: 1 });
    A.eq(rw.status, 200, 'rewind answers 200'); A.eq(rw.j.session.hops.length, 1, 'hops >= 1 dropped');
    s = await poll(id);
    A.eq(s.hops.length, 2); A.eq(s.hops[1].input, EDIT, 'the rewound hop re-ran on its original input');
    A.eq(s.state, 'paused');
    A.eq((await call('POST', '/api/routing/steptest/' + id + '/rewind', { hop: 7 })).status, 409, 'rewind to a hop that never ran -> 409');

    /* ---- 7. RESTART while paused ---- */
    await stopChild(child);
    ({ child, port } = await boot(await allocatePort(), env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const after = await call('GET', '/api/routing/steptest');
    A.eq(after.status, 200);
    A.eq(after.j.session && after.j.session.id, id, 'after a restart GET answers the same session');
    A.eq(after.j.session.state, 'paused', 'and it is still paused');
    A.eq(after.j.session.paused, s.paused, 'with the same handoff + preview');
    const c2 = await call('POST', '/api/routing/steptest/' + id + '/continue', {});
    A.eq(c2.status, 200, 'continue after the restart');
    s = await poll(id);
    A.eq(s.state, 'done', 'the test finished at the OUTBOX');
    A.eq(s.final, s.hops[1].output, 'final is what reached the OUTBOX');
    A.eq(s.hops[1].edited, false);
    A.eq((await call('POST', '/api/routing/steptest/' + id + '/continue', {})).status, 409, 'continue on a finished test -> 409');
    A.ok(typeof s.totalUsd === 'number' && s.limits && s.limits.maxUsdPerMessage > 0, 'the session reports its spend against the line budget');
  } finally {
    await stopChild(child);
    try { mock.server.close(); } catch (_) { /* closed */ }
  }
  A.report('routing.steptest.e2e');
})().catch(e => { console.log('FAIL: ' + (e && e.stack || e)); process.exit(1); });
