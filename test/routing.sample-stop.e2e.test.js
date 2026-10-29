/* node test/routing.sample-stop.e2e.test.js — ■ STOP for RUN ONE REAL JOB, over real sockets against the REAL host
   (2026-09-29, handed over by the steptest-stuck investigation: the Workflow panel's RUN ONE REAL JOB had no stop — the
   one way out of a running job was the station-wide E-STOP).

   What it locks (boot + content-driven mock provider per routing.sample.e2e.test.js — zero real spend, no keys):
     1. POST /api/routing/sample/stop sits behind the same per-launch token gate as every /api route;
     2. nothing riding the line → an honest 409 {ok:false,error} (never a route-miss);
     3. a job whose model call HANGS is stopped mid-run: the stop answers {ok, stopped, halted ≥ 1}, and the in-flight
        sample POST settles promptly as a STOP — 502 {stopped:true}, an error that names the stop, nothing delivered —
        instead of waiting out the provider;
     4. the station is not wedged: the next sample rides the line and delivers;
     5. the run's stream rides agent.run.start (additive streamId) — how the crew row tells a line test from other work.

   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken, sseQuery } = require('./_httpToken.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const STOP_JOB = 'SAMPLE JOB: hang here until the sample STOP, request one.';
const HALT_JOB = 'SAMPLE JOB: hang here until E-STOP, request two.';

/* Hang only an EXACT job turn. Intake/quest analysis quotes recent jobs in its prompt: matching "hang here"
   anywhere parked those unrelated requests too, so hung.size could claim the next sample was admitted before its
   HTTP request reached the host. Each hanging request has its own admission and socket-close receipt. */
function startMockOpenRouter(script) {
  const requests = [], hung = new Set(), jobs = new Map(), waiters = new Map();
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = userWords(lastUser).toLowerCase();
    return script.find(r => r.job ? text === r.job.toLowerCase() : text.indexOf(r.when) >= 0) || { text: 'nothing to do' };
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
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (turn.hang) {
            const job = { requestId: requests.length, task: turn.job, arrivedAt: Date.now(), closedAt: null };
            jobs.set(turn.job, job); hung.add(res);
            res.on('close', () => { job.closedAt = Date.now(); hung.delete(res); });
            for (const resolve of waiters.get(turn.job) || []) resolve(job);
            waiters.delete(turn.job);
            return;   // never a byte more
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    function waitForJob(task) {
      if (jobs.has(task)) return Promise.resolve(jobs.get(task));
      return new Promise(resolve => {
        const settle = job => { clearTimeout(timer); resolve(job); };
        const timer = setTimeout(() => { waiters.delete(task); resolve(null); }, 10000);
        waiters.set(task, (waiters.get(task) || []).concat(settle));
      });
    }
    server.listen(0, HOST, () => resolve({ server, requests, hung, decide, waitForJob, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
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
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1)));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    // 20s upper bound (not a sleep): a cold boot on a loaded box (parallel agent gates) can blow 9s.
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 20000);
  });
}

async function startSseCollector(url) {
  const ac = new AbortController();
  const events = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'the station SSE feed opens');
  const reader = res.body.getReader();
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.indexOf('data:') !== 0) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch (_) {}
        }
      }
    } catch (_) {}
  })();
  return { events, close() { try { ac.abort(); } catch (_) {} } };
}

// the two-stage floor from routing.sample.e2e.test.js: INTAKE -> research-agent -> writer-agent -> OUTBOX
const belt = (x, y, dir) => ({ x, y, dir });
const GEO = {
  props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
          { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
          { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
          { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
  belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
};
function twoStagePlan() {
  const plan = Pipeline.compileRoutingPlan(GEO);
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer', 'workbench'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    { job: STOP_JOB, hang: true }, { job: HALT_JOB, hang: true }, // only these entry-dock calls never answer
    { when: 'stage one findings', text: 'final sample answer' },
    { when: 'sample job', text: 'stage one findings' }
  ]);
  const modelTurn = text => ({ messages: [{ role: 'user', content: text }] });
  A.ok(mock.decide(modelTurn(STOP_JOB)).hang && mock.decide(modelTurn(HALT_JOB)).hang, 'only each exact stop-test job opens its hanging provider request');
  A.ok(!mock.decide(modelTurn('Recent activity: ' + STOP_JOB + '\n' + HALT_JOB)).hang, 'auxiliary analysis quoting both tasks cannot satisfy either job admission');
  A.ok(!mock.decide({ messages: [{ role: 'user', content: STOP_JOB }, { role: 'assistant', content: 'stopped' }, { role: 'user', content: 'summarize recent work' }] }).hang,
    'a prior stopped task in history does not make the latest request hang');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sample-stop-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, STARNET_DEV: '', SKYNET_DEV: '',
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-sample-stop-fake', SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const call = (route, body) => fetch(B + route, { method: 'POST', headers, body: JSON.stringify(body == null ? {} : body) })
      .then(r => r.json().then(j => ({ status: r.status, j })));

    /* ---- 1. behind the launch token ---- */
    const bare = await fetch(B + '/api/routing/sample/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: '{}' });
    A.eq(bare.status, 403, 'no token -> 403 (the auth seam holds)');

    /* ---- 2. nothing riding the line -> an honest 409 ---- */
    const idle = await call('/api/routing/sample/stop');
    A.eq(idle.status, 409, 'nothing to stop -> 409, never a route-miss');
    A.ok(idle.j && idle.j.ok === false && /nothing to stop/.test(String(idle.j.error || '')), 'the refusal says why: ' + JSON.stringify(idle.j));

    /* ---- 3. a job whose model call hangs is stopped mid-run ---- */
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(twoStagePlan()) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');
    sse = await startSseCollector(B + '/api/channels/events?' + sseQuery(token));
    const t0 = Date.now();
    const line = (Pipeline.lineComponents(GEO) || [])[0].key;   // sent with its line, as the WORKFLOWS window does: the job keeps a record
    const riding = call('/api/routing/sample', { line, text: STOP_JOB });
    // A provider request with this exact unique task proves server admission, not merely fetch initiation.
    const firstRequest = await mock.waitForJob(STOP_JOB);
    A.ok(!!firstRequest && firstRequest.closedAt == null, 'fixture: the first job has its own hanging provider request: ' + JSON.stringify(firstRequest));
    if (!firstRequest) throw new Error('the first sample never reached its provider');
    const busy = await call('/api/routing/sample', {});
    A.eq(busy.status, 409, 'while it rides, a second sample is still refused (one per station)');
    const stop = await call('/api/routing/sample/stop');
    A.eq(stop.status, 200, 'the stop is accepted');
    A.ok(stop.j && stop.j.ok === true && stop.j.stopped === true && stop.j.halted >= 1, 'it killed the running job\'s run: ' + JSON.stringify(stop.j));
    A.ok(/^sample-/.test(String(stop.j.streamId || '')), 'and names the sample it stopped: ' + stop.j.streamId);
    const settled = await Promise.race([riding, sleep(15000).then(() => null)]);
    A.ok(!!settled, 'the in-flight sample POST settled promptly after the stop (it did not wait out the provider)');
    if (settled) {
      A.eq(settled.status, 502, 'a stopped job is not a delivered one');
      A.ok(settled.j.stopped === true && settled.j.ok === false && settled.j.delivered === null, 'it answers stopped:true, nothing delivered');
      A.ok(/stopped/.test(String(settled.j.error || '')), 'the error names the stop, not a failure of the line: ' + settled.j.error);
      A.ok(Date.now() - t0 < 20000, 'the whole stop took seconds, not a provider timeout');
      // the job's record says STOPPED, and keeps nothing as its output: the hub's E-STOP courtesy notice was saved as what
      // the job made (and offered NEEDS CHANGES against)
      const rec = await fetch(B + '/api/line-jobs/' + settled.j.jobId, { headers }).then(r => r.json());
      A.ok(rec && rec.job && rec.job.status === 'stopped', 'the job record says stopped: ' + JSON.stringify(rec && rec.job && [rec.job.status, rec.job.error]));
      A.eq(String((rec && rec.job && rec.job.output) || ''), '', 'nothing is kept as what a stopped job made');
    }
    // the abort reaches the provider socket promptly, but its close lands on the mock's side a beat later under load: wait for it
    // (bounded), never a fixed 400ms that a busy machine misses
    const tClose = Date.now();
    for (let i = 0; i < 60 && firstRequest.closedAt == null; i++) await sleep(50);
    A.ok(firstRequest.closedAt != null, 'the first job\'s exact provider connection was closed by the stop (' + (Date.now() - tClose) + 'ms): ' + JSON.stringify(firstRequest));
    const again = await call('/api/routing/sample/stop');
    A.eq(again.status, 409, 'once it has settled there is nothing left to stop');

    /* ---- 4. the station is not wedged: the next sample rides the line and delivers ---- */
    const next = await call('/api/routing/sample', {});
    A.eq(next.status, 200, 'the next sample delivers — the stop released the one-per-station lock');
    A.ok(next.j && next.j.ok === true && !!next.j.delivered, 'and it reached the OUTBOX');

    /* ---- 5. the run's stream rides agent.run.start (additive) ---- */
    await sleep(500);
    const starts = sse.events.filter(e => e && e.name === 'agent.run.start').map(e => e.payload || {});
    A.ok(starts.some(p => p.agentId === 'research-agent' && /^sample-/.test(String(p.streamId || ''))),
      'a sample run\'s agent.run.start carries its sample-… streamId: ' + JSON.stringify(starts.map(p => [p.agentId, p.streamId])).slice(0, 300));

    /* ---- 6. an E-STOP mid-job: the record says stopped (not "did not finish cleanly — send it again"), no notice as output ---- */
    const riding2 = call('/api/routing/sample', { line, text: HALT_JOB });
    const secondRequest = await mock.waitForJob(HALT_JOB);
    A.ok(!!secondRequest && secondRequest.closedAt == null && secondRequest.requestId !== firstRequest.requestId,
      'fixture: the E-STOP target has a distinct hanging provider request: ' + JSON.stringify(secondRequest));
    if (!secondRequest) throw new Error('the E-STOP sample never reached its provider');
    const halt = await call('/api/halt');
    A.eq(halt.status, 200, 'E-STOP is accepted');
    A.ok(halt.j.halted >= 1, 'E-STOP reports aborting the admitted sample run: ' + JSON.stringify(halt.j));
    const settled2 = await Promise.race([riding2, sleep(15000).then(() => null)]);
    A.ok(!!settled2 && settled2.j.stopped === true, 'the job answers stopped after an E-STOP: ' + JSON.stringify(settled2 && settled2.j && [settled2.status, settled2.j.error]));
    if (settled2 && settled2.j.jobId) {
      const rec2 = await fetch(B + '/api/line-jobs/' + settled2.j.jobId, { headers }).then(r => r.json());
      A.ok(rec2 && rec2.job && rec2.job.status === 'stopped', 'its record says stopped: ' + JSON.stringify(rec2 && rec2.job && [rec2.job.status, rec2.job.error]));
      A.ok(!/E-STOP/.test(String((rec2 && rec2.job && rec2.job.output) || '')), 'the E-STOP notice is not kept as its output: ' + JSON.stringify(rec2 && rec2.job && rec2.job.output));
    } else A.ok(false, 'the E-STOPped job names its record');
    await call('/api/halt/resume');
  } finally {
    if (sse) sse.close();
    for (const r of mock.hung) { try { r.end(); } catch (_) {} }
    try { child.kill(); } catch (_) {}
    try { mock.server.closeAllConnections && mock.server.closeAllConnections(); mock.server.close(); } catch (_) {}
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.sample-stop.e2e.test');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
