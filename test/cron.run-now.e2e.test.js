/* node test/cron.run-now.e2e.test.js - real sidecar proof for routine Run Now.

   This boots the actual sidecar, creates a routine, opens the station SSE feed,
   presses /api/cron/run, and proves the manual fire is visible in every layer:
   panel NDJSON, mocked provider request, workitem.placed, and run lifecycle SSE. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { bootToken } = require('./_httpToken.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startMockOpenRouter() {
  const requests = [];
  let hold = null;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
          try { requests.push(JSON.parse(body)); } catch (_) {}
          if (hold) {
            const h = hold;
            hold = null;
            h();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'AI news found' } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, HOST, () => resolve({
      server,
      requests,
      base: 'http://' + HOST + ':' + server.address().port + '/api/v1',
      holdNext() { return new Promise(resolveHold => { hold = resolveHold; }); }
    }));
  });
}

function boot(port, env, attemptsLeft) {
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
        if (attemptsLeft > 0) resolve(boot(port + 1, env, attemptsLeft - 1));
        else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 9000);
  });
}

async function startSseCollector(url, onEvent) {
  const ac = new AbortController();
  const events = [];
  const waiters = [];
  const res = await fetch(url, { signal: ac.signal });
  A.eq(res.status, 200, 'SSE feed opens with token');
  const reader = res.body.getReader();
  function notify() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      try {
        if (w.pred(events)) { waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(events); }
      } catch (e) { waiters.splice(i, 1); clearTimeout(w.timer); w.reject(e); }
    }
  }
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
          if (!line || line[0] === ':') continue;
          if (line.indexOf('data:') === 0) {
            const raw = line.slice(5).trim();
            try { const event = JSON.parse(raw); events.push(event); if (onEvent) await onEvent(event); notify(); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  })();
  return {
    events,
    waitFor(pred, ms, label) {
      if (pred(events)) return Promise.resolve(events);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

async function readNdjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) { try { events.push(JSON.parse(line)); } catch (_) {} }
    }
  }
  return events;
}

(async () => {
  const mock = await startMockOpenRouter();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-cron-run-now-'));
  const env = {
    SKYNET_WORKSPACES: ws,
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-run-now-fake',
    SKYNET_DEFAULT_MODEL: 'test/model',
    SKYNET_CRON_TICK_MS: '1000'
  };
  const { child, port } = await boot(8910 + (process.pid % 50), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const create = await fetch(B + '/api/cron', {
      method: 'POST',
      headers,
      // runsLine:true — created from a line's INBOX trigger zone, so this routine IS one of that line's own
      // triggers and firing it runs the drawn stages (work belongs to a line, 2026-08-07). The opposite case
      // (a routine that predates the workflow) gets its own block below.
      body: JSON.stringify({ name: 'AI news', prompt: 'gather relevant AI news', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter', runsLine: true })
    });
    A.eq(create.status, 200, 'created routine');
    const job = (await create.json()).job;
    A.ok(job && job.id, 'routine id returned');

    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token), async event => {
      if (event.name !== 'station.command') return;
      const p = event.payload;
      await fetch(B + '/api/station/ack', { method: 'POST', headers,
        body: JSON.stringify({ id: p.id, ok: true, result: { folded: true } }) });
    });
    const run = await fetch(B + '/api/cron/run', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: job.id })
    });
    A.eq(run.status, 200, 'Run Now returns a stream');
    const panel = await readNdjson(run);
    const panelNames = panel.map(e => e.name);
    A.ok(panelNames.indexOf('agent.run.start') >= 0, 'panel stream includes agent.run.start');
    A.ok(panel.filter(e => e.name === 'agent.token').map(e => e.payload.delta).join('').indexOf('AI news found') >= 0, 'panel stream includes provider output');
    A.ok(panelNames.indexOf('agent.run.end') >= 0, 'panel stream includes agent.run.end');
    A.ok(mock.requests.length >= 1, 'mock provider was called');

    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'research-agent' && e.payload.kind === 'cron'), 5000, 'cron workitem');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.start' && e.payload && e.payload.agentId === 'research-agent' && e.payload.trigger === 'schedule'), 5000, 'SSE run start');
    await sse.waitFor(events => events.some(e => e.name === 'agent.run.end' && e.payload && e.payload.agentId === 'research-agent'), 5000, 'SSE run end');

    /* RUN NOW MUST FIRE THE WHOLE WORK LINE, exactly like the scheduled fire. This route calls runOnce
       DIRECTLY, so it bypasses the cron driver's advanceChain seam — it shipped running four stages on
       schedule and ONE stage from the button (caught live 2026-07-27), the same "one routine, two
       behaviours" bug the slash-command redirect in this route already exists to prevent. */
    const Pipeline = require('../frontend/app/pipeline.js');
    const belt = (x, y, dir) => ({ x, y, dir });
    const plan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent', brief: 'Dig three primary sources and cite them.' },
              { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent' },
              { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
    });
    A.eq(plan.chains['research-agent'].next, ['writer-agent'], 'the drawn floor chains the two docks');
    for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer'];   // an unequipped bay grants no compute
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');

    const callsBefore = mock.requests.length;
    const run2 = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: job.id }) });
    A.eq(run2.status, 200, 'Run Now returns a stream (second fire)');
    const panel2 = await readNdjson(run2);
    const starts = panel2.filter(e => e.name === 'agent.run.start').map(e => e.payload.agentId);
    A.ok(starts.indexOf('research-agent') >= 0, 'stage one ran');
    A.ok(starts.indexOf('writer-agent') >= 0, 'RUN NOW fired the DOWNSTREAM stage too (was one stage before)');
    A.ok(mock.requests.length >= callsBefore + 2, 'two provider calls — the line really bought both runs');
    await sse.waitFor(events => events.some(e => e.name === 'workitem.placed' && e.payload && e.payload.agentId === 'writer-agent' && e.payload.kind === 'chain'), 5000, 'the handoff rides as a chain crate');

    /* THE DOCK'S STANDING BRIEF RIDES A CRON ENTRY RUN (inbox-trigger, 2026-08-05). The posted plan carries
       b1's brief (pipeline bays.brief -> router.stageBrief); Run Now — and the scheduled fire, same seam —
       must append it to stage one's SYSTEM under the hub's exact section header. Recorded off the REAL
       provider request. And the FIRST fire (no plan posted yet) must have carried NO brief header at all —
       a floorless routine's system is byte-identical to the pre-brief behavior. */
    const sysOf = req => ((req.messages || []).find(m => m.role === 'system') || {}).content || '';
    const preFloor = mock.requests.slice(0, callsBefore);
    A.ok(preFloor.length >= 1 && preFloor.every(r => sysOf(r).indexOf('YOUR STANDING BRIEF FOR THIS STATION') < 0),
      'before a floor is posted, a Run Now carries NO brief header (pre-brief behavior intact)');
    const stage1 = mock.requests.slice(callsBefore).find(r =>
      (r.messages || []).some(m => m.role === 'user' && String(m.content || '').indexOf('gather relevant AI news') >= 0));
    A.ok(stage1, "found stage one's recorded provider request");
    /* RUN NOW GETS THE SCHEDULED FIRE'S TOOLS (B5). Stage one passed no `station`, so runOnce fell back to the broad
       autonomous office and Run Now had a dish (web_fetch/web_request) the routine's computer-only bay does not —
       "test it now" proved tools the scheduled fire lacks. Recorded off the REAL provider requests: the floorless
       fire runs in the default office (dish included), the bay-bound fire only in its bay room. */
    const toolNamesOf = req => (req.tools || []).map(t => String((t.function && t.function.name) || t.name || ''));
    A.ok(preFloor.some(r => toolNamesOf(r).indexOf('web_fetch') >= 0), 'before a floor is posted, Run Now runs in the default office (web_fetch offered)');
    A.ok(stage1 && toolNamesOf(stage1).indexOf('web_fetch') < 0 && toolNamesOf(stage1).indexOf('web_request') < 0,
      "a bay-bound Run Now runs in its computer-only bay room like the scheduled fire: no dish, no web tools");
    A.ok(sysOf(stage1).indexOf('YOUR STANDING BRIEF FOR THIS STATION:\nDig three primary sources and cite them.') >= 0,
      "stage one's system carries the dock's standing brief under the hub's exact section header");

    /* ---- A ROUTINE THAT DOES NOT BELONG TO THE LINE BUYS EXACTLY ONE RUN (2026-08-07, Andrew's ruling) ----
       THE MONEY CASE, on the real Run Now path and the same armed two-stage floor. Deciding "does this fire a
       line?" from the DOCK alone meant a routine created months before the workflow started spending a run per
       drawn stage the moment its agent was crewed onto the line — and delivering the LAST stage's text instead
       of its own answer. Without the durable marker it must stay terminal, and pressing the button must cost
       exactly one provider call. */
    {
      const mk = await fetch(B + '/api/cron', {
        method: 'POST', headers,
        body: JSON.stringify({ name: 'legacy digest', prompt: 'gather relevant AI news for the legacy digest', schedule: 'every 1h', agentId: 'research-agent', model: 'test/model', provider: 'openrouter' })
      });
      A.eq(mk.status, 200, 'a routine created WITHOUT the marker is accepted');
      const legacy = (await mk.json()).job;
      A.eq(legacy.runsLine, false, 'and it is terminal by default — the durable record says so');
      /* SETTLE FIRST: the previous stage's fire-and-forget aux passes (reflection, then the profile update) can still be
         in flight here, and one that lands after the window opens is counted against this routine. That race flaked on
         trunk and turned steady once routine runs stopped paying for a skill review after every run (2026-09-28): the
         reviews had been slowing the test enough to hide it. Wait until the provider has been quiet for 1.5 s. */
      for (let last = -1, quiet = 0, n = 0; quiet < 6 && n < 60; n++) {
        await new Promise(res => setTimeout(res, 250));
        if (mock.requests.length === last) quiet++; else { last = mock.requests.length; quiet = 0; }
      }
      const before = mock.requests.length;
      const r = await fetch(B + '/api/cron/run', { method: 'POST', headers, body: JSON.stringify({ id: legacy.id }) });
      A.eq(r.status, 200, 'Run Now streams');
      const ev = await readNdjson(r);
      const ran = ev.filter(e => e.name === 'agent.run.start').map(e => e.payload.agentId);
      A.eq(ran, ['research-agent'], 'ONLY the routine\'s own dock ran — the drawn stages downstream did not fire');
      A.eq(mock.requests.length - before, 1, 'PROVIDER CALLS: exactly ONE — a pre-existing routine never buys a whole line');
    }

    /* A SESSION IS NAMED AFTER THE RUN IT IS NAMED AFTER. Hops share the routine's 'cron-<runId>' stream so the
       session shows the whole line — which means that stream now holds SEVERAL run rows, and the frontend used
       to title/attribute the session from whichever row it read first. That titled the Commander's routine
       session with the internal PIPELINE HANDOFF prompt and credited it to the LAST stage's agent (caught by
       looking at the real session rail, 2026-07-27). This locks the data the picker needs: the defining row is
       findable by runId, and it is the routine's own. */
    const runsRes = await fetch(B + '/api/runs?agent=*&limit=50', { headers });
    A.eq(runsRes.status, 200, 'runs list reads');
    const rows = ((await runsRes.json()) || {}).runs || [];
    const byStream = {};
    for (const r of rows) if (r && typeof r.streamId === 'string' && r.streamId.indexOf('cron-') === 0) (byStream[r.streamId] = byStream[r.streamId] || []).push(r);
    const multi = Object.keys(byStream).find(k => byStream[k].length > 1);
    A.ok(multi, 'a chained routine records one row PER STAGE under a single stream');
    const defining = multi ? byStream[multi].find(r => String(r.runId || '') === multi.slice('cron-'.length)) : null;
    A.ok(defining, 'that stream still carries the run it is NAMED after');
    A.ok(defining && String(defining.title || '').indexOf('PIPELINE HANDOFF') < 0,
      'and the defining row is the ROUTINE, never a stage handoff — internal plumbing must not become a session title');
    // Session-only origins are valid scheduled destinations, including persisted origin-mode jobs.
    // A channel origin that ALSO captures a session must still require the channel, not silently redirect.
    {
      const jobs = [];
      for (const [name, origin] of [['session return', { sessionId: 'proof-session' }],
        ['unavailable channel', { sessionId: 'proof-session', channel: 'telegram', chatId: 'missing' }]]) {
        const r = await fetch(B + '/api/cron', { method: 'POST', headers, body: JSON.stringify({
          name, prompt: name, schedule: 'in 1s', agentId: 'session-proof', model: 'test/model', provider: 'openrouter', deliver: 'origin', origin
        }) });
        A.eq(r.status, 200, 'captured origin routine accepted');
        jobs.push((await r.json()).job);
      }
      await fetch(B + '/api/cron/arm', { method: 'POST', headers, body: JSON.stringify({ enabled: true }) });
      let rows = [];
      for (let i = 0; i < 100; i++) {
        rows = (await (await fetch(B + '/api/cron', { headers })).json()).jobs;
        if (rows.find(j => j.id === jobs[0].id)?.lastDeliveryOk === true && rows.find(j => j.id === jobs[1].id)?.blockedConfig) break;
        await sleep(100);
      }
      const delivered = rows.find(j => j.id === jobs[0].id), blocked = rows.find(j => j.id === jobs[1].id);
      A.eq(delivered.lastDeliveryOk, true, 'scheduled session-only origin ran and received a durable delivery ack');
      A.ok(!delivered.blockedConfig, 'session-only origin passes preflight');
      A.ok(/not connected and healthy/.test(blocked.blockedConfig && blocked.blockedConfig.reason), 'remote origin never silently falls back to its session');
      A.ok(sse.events.some(e => e.name === 'station.command' && e.payload.verb === 'station.deliver' && e.payload.args.sessionId === 'proof-session'), 'delivery targeted the captured session');
      await fetch(B + '/api/cron/arm', { method: 'POST', headers, body: JSON.stringify({ enabled: false }) });
      for (const j of jobs) await fetch(B + '/api/cron/remove', { method: 'POST', headers, body: JSON.stringify({ id: j.id }) });
    }
    /* Disconnecting the Run Now watcher cancels the run. Cancellation has no agent.run.error by design, so
       success must be derived from the terminal reason, not merely the absence of an error event. */
    const resultCount = sse.events.filter(e => e.name === 'cron.result' && e.payload && e.payload.jobId === job.id).length;
    const held = mock.holdNext();
    const cancel = new AbortController();
    const cancelledRun = fetch(B + '/api/cron/run', {
      method: 'POST', headers, body: JSON.stringify({ id: job.id }), signal: cancel.signal
    }).catch(() => null);
    await held;
    cancel.abort();
    await cancelledRun;
    await sse.waitFor(events => events.filter(e => e.name === 'cron.result' && e.payload && e.payload.jobId === job.id).length > resultCount, 5000, 'cancelled cron result');
    const cancelledResult = sse.events.filter(e => e.name === 'cron.result' && e.payload && e.payload.jobId === job.id).slice(-1)[0];
    A.eq(cancelledResult.payload.outcome, 'failed', 'cancelled Run Now is never announced as successful');
    A.eq(cancelledResult.payload.reason, 'cancelled', 'cancelled Run Now retains its terminal reason');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('cron.run-now.e2e.test');
})().catch(e => { console.log('FAIL: cron.run-now.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
