/* node test/routing.linestats.e2e.test.js — real-sidecar proof for LINE WATCH's stats route
   (GET /api/routing/lines/stats) and the run-row stamps it folds.

   Over real sockets against the REAL host (content-driven mock provider — zero real spend, no keys):
     1. the route sits behind the per-launch token gate; with no armed plan it answers ok with NO lines (never a guess);
     2. a two-dock floor with a LINE BUDGET ($5/day): the line answers zeros before any work;
     3. a sample job through the line: both hop runs are recorded with the line + their own bay (lineId/dockId on
        the /api/runs rows), and the stats plate counts EXACTLY those rows (runs 2, shipped 0 — talk-only runs are
        not proven work — failed 0, a real median) with the $5 cap;
     4. a job whose second stage FAILS (the mock answers 400): the writer's row is a failure at bay b2, the stats
        count it, and b2's last outcome reads failed while b1's reads done;
     5. `since` in the future of every row folds nothing (the window is the caller's).

   In test/http.list (a child-process boot test does not gate test:fast). */
'use strict';

const A = require('./_assert.js');
const { userWords } = require('./helpers/host-notes.js');   // the user's own words: the run-context note leads the newest user message on this wire
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

// content-driven mock (a real run also makes reflection/aux calls; a queue would desync). A rule with `fail`
// answers HTTP 400 — a provider refusing the request, the forced-failure path (a 400 fails at once; a 5xx would
// spend ~100 s in the provider's transport retries, which the live proof exercises instead).
function startMockOpenRouter(script) {
  const requests = [];
  function decide(body) {
    const msgs = (body && body.messages) || [];
    if (msgs.some(m => m && m.role === 'tool')) return { text: 'done' };
    const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
    const text = userWords(lastUser).toLowerCase();
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
          if (turn.fail) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'mock provider rejected the request' } })); }
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
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) { /* gone */ } reject(new Error('boot timeout:\n' + out)); } }, 45000);   // generous: several lanes gate on one machine
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

function twoStagePlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1, limits: { maxUsdPerDay: 5 } },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent' },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    { when: 'kaboom', fail: true },                                         // the writer's handoff for the failing job
    { when: 'pipeline handoff', text: 'final answer' },                    // the writer handed stage one's text
    { when: 'first job', text: 'stage one findings' },
    { when: 'second job', text: 'stage one findings: KABOOM' }             // hands the writer a turn the mock fails
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-linestats-'));
  const hermes = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-linestats-hermes-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, HERMES_HOME: hermes,
    STARNET_DEV: '', SKYNET_DEV: '',
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-linestats-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const call = (method, p, body) => fetch(B + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(r => r.text().then(t => { let j = null; try { j = JSON.parse(t); } catch (_) { j = null; } return { status: r.status, j }; }));
    const t0 = Date.now() - 1;

    /* ---- 1. auth seam + no plan ---- */
    const bare = await fetch(B + '/api/routing/lines/stats', { headers: { Origin: B } });
    A.eq(bare.status, 403, 'no token -> 403 (the auth seam holds)');
    const empty = await call('GET', '/api/routing/lines/stats');
    A.eq(empty.status, 200, 'the stats route answers');
    A.eq(empty.j.lines, [], 'no armed plan -> no lines');
    A.eq(empty.j.spendDay, 'utc', 'the $ ledger day is named');

    /* ---- 2. an armed two-dock line with a $5/day budget: zeros ---- */
    const plan = twoStagePlan();
    A.eq((await call('POST', '/api/routing', plan)).status, 200, 'the two-stage floor deploys');
    const lineId = Pipeline.lineOf(plan, 'research-agent');
    let st = await call('GET', '/api/routing/lines/stats?since=' + t0);
    let L = (st.j.lines || []).find(l => l.lineId === lineId);
    A.eq(L, { lineId, runs: 0, shipped: 0, failed: 0, tests: 0, medianMs: null, usdToday: 0, capUsdPerDay: 5, spendDay: 'utc' }, 'a line with no work answers zeros + its cap (and names its UTC spend day)');

    /* ---- 3. a clean sample through the line ---- */
    const s1 = await call('POST', '/api/routing/sample', { line: lineId, text: 'FIRST JOB: summarize the notes.' });
    A.eq(s1.status, 200, 'the first sample completes: ' + JSON.stringify(s1.j && s1.j.error));
    let rows = ((await call('GET', '/api/runs?agent=*&limit=50&since=' + t0)).j.runs || []).filter(r => r.lineId === lineId);
    A.eq(rows.length, 2, 'both hop runs are stamped with the line');
    A.eq(rows.map(r => r.agentId + '@' + r.dockId).sort(), ['research-agent@b1', 'writer-agent@b2'], 'each row carries the bay it ran AT');
    st = await call('GET', '/api/routing/lines/stats?since=' + t0);
    L = st.j.lines.find(l => l.lineId === lineId);
    A.eq([L.runs, L.shipped, L.failed], [2, 0, 0], 'stats match the stamped rows (talk-only runs are not proven work)');
    // rc walk #30: the job's own answer agrees with SHIPPED — delivered (200), but a talk-only job is not shipped
    A.eq(s1.j.shipped, false, 'the sample answer says this delivered job was not counted in SHIPPED (it agrees with the plate)');
    A.eq(s1.j.shippedWhy, 'no-proven-work', '…and why, from its own run rows: no stage had a tool succeed or saved a file');
    A.ok(typeof L.medianMs === 'number' && L.medianMs > 0, 'a real median time per run: ' + L.medianMs);
    A.eq(st.j.docks.b1.failed, false, 'bay b1: last outcome done');
    A.eq(st.j.docks.b2.reason, 'done', 'bay b2: last outcome done');

    /* ---- 4. a job whose writer stage fails ---- */
    const s2 = await call('POST', '/api/routing/sample', { line: lineId, text: 'SECOND JOB: summarize again.' });
    A.eq(s2.status, 502, 'the failing sample reports it did not complete cleanly');
    rows = ((await call('GET', '/api/runs?agent=*&limit=50&since=' + t0)).j.runs || []).filter(r => r.lineId === lineId);
    const failedRows = rows.filter(r => ['error', 'refusal', 'max_iters', 'budget'].indexOf(r.reason) >= 0);
    A.eq(failedRows.map(r => r.dockId), ['b2'], 'exactly the writer\'s run at b2 failed: ' + JSON.stringify(rows.map(r => r.agentId + ':' + r.reason)));
    st = await call('GET', '/api/routing/lines/stats?since=' + t0);
    L = st.j.lines.find(l => l.lineId === lineId);
    A.eq(L.runs, rows.length, 'runs == the stamped /api/runs rows (' + rows.length + ')');
    A.eq(L.failed, failedRows.length, 'failed == the failed stamped rows');
    A.eq(st.j.docks.b2.failed, true, 'bay b2: last outcome FAILED (the lamp stays red until the next success)');
    A.eq(st.j.docks.b2.runId, failedRows[0].runId, 'bay b2 names the failed run');
    A.eq(st.j.docks.b1.failed, false, 'bay b1 is unaffected');

    /* ---- 5. the window is the caller's ---- */
    const later = await call('GET', '/api/routing/lines/stats?since=' + (Date.now() - 1));
    const Lz = later.j.lines.find(l => l.lineId === lineId);
    A.eq([Lz.runs, Lz.shipped, Lz.failed], [0, 0, 0], 'a window after every row folds nothing');
  } catch (e) {
    A.ok(false, 'unexpected: ' + (e && e.stack || e));
  } finally {
    await stopChild(child);
    mock.server.close();
    try { fs.rmSync(ws, { recursive: true, force: true }); fs.rmSync(hermes, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  A.report();
})();
