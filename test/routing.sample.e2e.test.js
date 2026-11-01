/* node test/routing.sample.e2e.test.js — real-sidecar proof for GET/POST /api/routing/sample (guided
   workflow Phase 4: PROOF — run a sample job).

   What it locks, over real sockets against the REAL host (boot pattern per routing.persist.e2e.test.js,
   content-driven mock provider per comms-send.e2e.test.js — zero real spend, no keys):
     1. the route sits behind the same per-launch token gate as every /api route;
     2. GET discovery answers available without dispatching or spending, while an unauthenticated probe
        remains denied;
     3. NO ARMED PLAN → POST gives an honest 409 refusal ({ok:false,error}), and never a route-miss;
     4. HAPPY PATH: the sample rides the REAL unaddressed dispatch path through a posted two-stage floor —
        the router picks the entry dock, the chain runner runs the downstream stage, the reply the line
        delivers is the LAST stage's, the recorded runs.jsonl rows are scoped by the sample's own streamId,
        and the workitem crates (with the additive sample:true marker, re-proven against shared/events
        validate()) ride the station bus;
     5. ONE IN FLIGHT per station: a concurrent second post refuses 409 while the first is riding;
     6. NO GRANTS PROPAGATION (the chain-grants law): a sample whose model tries a consent-gated mutation
        (shell.exec) is default-denied — the request body cannot smuggle unattendedGrants — and the line
        still delivers (a denial never gates the reply);
     7. LINE SCOPE (2026-08-10): { line } in the body makes the sample enter through THAT line's own door
        on a two-line floor (the FINISH card's { line: c.key } is finally honored); an unknown line refuses
        409 with no spend; a line-less POST stays byte-compatible with today's behaviour.

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
const Events = require('../shared/events.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Content-driven mock provider (a queue would desync — a real run also makes reflection/aux calls this test
   never asked for, and those would eat scripted turns). Same shape as comms-send.e2e.test.js. */
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
          try { parsed = JSON.parse(body); requests.push(parsed); } catch (_) {}
          const turn = decide(parsed);
          if (turn.status) {
            res.writeHead(turn.status, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: turn.error || 'mock provider failure' } }));
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
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

// the station SSE bus — where the workitem crates the world draws actually ride (chanEmit → /api/channels/events)
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
  return {
    events,
    async settle(ms) { const end = Date.now() + (ms || 1500); while (Date.now() < end) { await sleep(50); } },
    close() { try { ac.abort(); } catch (_) {} }
  };
}

// a deployable two-stage floor: INTAKE -> research-agent -> writer-agent -> OUTBOX. Bay rooms carry a
// computer (the compute gate) + a workbench (projects the consent-gated shell.exec the grants probe needs).
// Both docks carry a STANDING BRIEF (step editor): the entry dock's must reach its run's system context,
// the downstream dock's must reach the handoff turn — asserted against the mock provider's recordings.
const ENTRY_BRIEF = 'Dig the sources and hand a clean evidence pack downstream.';
const HOP_BRIEF = 'Draft the final answer in press style.';
function twoStagePlan() {
  const belt = (x, y, dir) => ({ x, y, dir });
  const plan = Pipeline.compileRoutingPlan({
    props: [{ id: 'i', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
            { id: 'b1', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'research-agent', brief: ENTRY_BRIEF },
            { id: 'b2', t: 'bay', x: 7, y: 0, w: 1, h: 1, agentId: 'writer-agent', brief: HOP_BRIEF },
            { id: 'o', t: 'outbox', x: 10, y: 0, w: 1, h: 1 }],
    belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'), belt(8, 0, 'E'), belt(9, 0, 'E')]
  });
  A.ok(Pipeline.ok(plan), 'fixture: the two-stage floor is deployable');
  A.eq((plan.chains['research-agent'] || {}).next, ['writer-agent'], 'fixture: the floor chains the two docks');
  // the brief rides dockBays, NOT the hashed dispatch record (2026-08-07: prompt text may not move plan.hash)
  A.eq(plan.dockBays.find(b => b.agentId === 'research-agent').brief, ENTRY_BRIEF, 'fixture: the compiled plan carries the entry brief');
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer', 'workbench'];
  return plan;
}

(async () => {
  const mock = await startMockOpenRouter([
    // order is load-bearing (script.find takes the FIRST match; later texts contain earlier phrases):
    { when: 'empty downstream payload', text: '' },
    { when: 'force clean early stop', text: 'empty downstream payload' },
    { when: 'force provider failure', status: 500, error: 'forced provider failure' },
    { when: 'use the shell', tool: { name: 'shell.exec', args: { cmd: 'echo pwned' } } },
    { when: 'stage one findings', text: 'final sample answer' },   // the hop's handoff prompt carries stage one's output
    { when: 'sample job', text: 'stage one findings' }             // the entry dock's own turn
  ]);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-routing-sample-'));
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws,
    // deliberately NO dev mode: the sample seam is a first-class production route, not a DEV-gated one
    STARNET_DEV: '', SKYNET_DEV: '',
    SKYNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-routing-sample-fake',
    SKYNET_DEFAULT_MODEL: 'test/model'
  };
  const { child, port } = await boot(await allocatePort(), env, 20);
  const B = 'http://' + HOST + ':' + port;
  let sse = null;
  try {
    const token = await bootToken(B, B);
    A.ok(token.length >= 32, 'got a session API token');
    const headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const post = (body) => fetch(B + '/api/routing/sample', { method: 'POST', headers, body: JSON.stringify(body == null ? {} : body) })
      .then(r => r.json().then(j => ({ status: r.status, j })));

    /* ---- 1. the route is behind the SAME per-launch token gate as every /api route ---- */
    const bare = await fetch(B + '/api/routing/sample', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: B }, body: '{}' });
    A.eq(bare.status, 403, 'no token -> 403 (the auth seam holds)');
    const bareGet = await fetch(B + '/api/routing/sample', { headers: { Origin: B } });
    A.eq(bareGet.status, 403, 'GET discovery also stays behind the session token gate');

    /* ---- 1b. GET is the inert discovery contract used by Build Mode ---- */
    const discovered = await fetch(B + '/api/routing/sample', { headers }).then(r => r.json().then(j => ({ status: r.status, j })));
    A.eq(discovered.status, 200, 'authenticated GET discovers the sample-job seam');
    A.ok(discovered.j && discovered.j.ok === true && discovered.j.available === true,
      'the discovery response explicitly says the seam is available');
    A.eq(mock.requests.length, 0, 'GET discovery never dispatches a provider request');

    /* ---- 2. no armed plan -> an honest POST refusal, never a route-miss ---- */
    const noPlan = await post({});
    A.eq(noPlan.status, 409, 'no armed routing plan -> 409');
    A.ok(noPlan.j && noPlan.j.ok === false, 'the refusal says ok:false');
    A.ok(/no work line is armed/.test(String(noPlan.j.error || '')), 'the refusal names the real reason: ' + noPlan.j.error);

    /* ---- 3. HAPPY PATH through a posted two-stage floor ---- */
    /* the docks' ROOM is bounded by the saved station (a posted plan may only narrow it — qa/bugs/a9a4f53c): save both
       bays with a workstation each and a workbench in their room, so the bay room is computer + workbench and the shell
       probe in section 5 meets a projected, consent-gated shell.exec */
    const WM = require('../frontend/app/worldmodel.js');
    const stDoc = WM.defaultDoc();
    stDoc.props.push({ id: 'b1', t: 'bay', x: 2, y: 1, w: 1, h: 1, agentId: 'research-agent' }, { id: 'pc1', t: 'console', x: 4, y: 1, w: 2, h: 1, agentId: 'research-agent' },
      { id: 'b2', t: 'bay', x: 8, y: 1, w: 1, h: 1, agentId: 'writer-agent' }, { id: 'pc2', t: 'console', x: 10, y: 1, w: 2, h: 1, agentId: 'writer-agent' },
      { id: 'wb1', t: 'workbench', x: 13, y: 1, w: 2, h: 1, block: true });
    stDoc._nid = 6;
    const prior = ((await (await fetch(B + '/api/save?agent=agent', { headers })).json()) || {}).save;
    const sv = await fetch(B + '/api/save', { method: 'POST', headers,
      body: JSON.stringify({ schema: 'starnet.save', version: 5, _saveRevision: (prior && prior._saveRevision) || 0, updatedAt: Date.now(), agent: { id: 'agent' }, station: stDoc }) });
    A.ok(sv.status === 200 && ((await sv.json()) || {}).ok === true, 'the station the line runs on (two bays, a workstation each, a workbench) is saved');
    const posted = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(twoStagePlan()) });
    A.eq(posted.status, 200, 'the two-stage floor deploys');
    sse = await startSseCollector(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token));

    const happy = await post({});
    A.eq(happy.status, 200, 'the sample answers 200 after the line delivered');
    const h = happy.j;
    A.ok(h.ok === true && h.sample === true, 'the answer is marked as a sample');
    A.eq(h.isTask, true, 'the canned sample text classifies as a TASK (a crate rides the belt)');
    A.eq(h.agentId, 'research-agent', 'the ROUTER picked the entry dock (unaddressed dispatch, not a fallback)');
    A.ok(/^sample-/.test(String(h.streamId || '')), 'the sample runs under its own workstream: ' + h.streamId);
    A.ok(h.workitemId, 'the entry crate has a workitemId');
    A.ok((h.replies || []).some(t => String(t).indexOf('final sample answer') >= 0),
      'the DELIVERED reply is the LAST stage\'s text (the chain ran): ' + JSON.stringify(h.replies).slice(0, 200));
    A.eq((h.runs || []).length, 2, 'exactly two real runs were recorded (entry dock + one chain hop)');
    A.ok(h.runs.every(r => r.streamId === h.streamId), 'every recorded run carries the sample\'s streamId');
    A.ok(h.runs.every(r => r.reason === 'done'), 'both stages finished clean');
    A.ok(h.delivered && h.delivered.agentId === 'writer-agent', 'the delivering run is the LAST stage (writer-agent)');
    A.ok(typeof h.totalUsd === 'number' && isFinite(h.totalUsd), 'the sample reports its real total cost');

    /* ---- 3b. THE STANDING BRIEFS REACHED THE RUNS (step editor — execution truth, not UI copy).
       The mock provider recorded every request body; the ENTRY dock's brief must ride its run's SYSTEM
       context, and the RECEIVING dock's brief must ride the handoff turn's USER text (the shared
       Pipeline.handoffPrompt 5th param via the chain runner's stageBrief seam). ---- */
    const BRIEF_HDR = 'YOUR STANDING BRIEF FOR THIS STATION:';
    const lastUserOf = rq => { const m = [...((rq && rq.messages) || [])].reverse().find(x => x && x.role === 'user'); return String((m && m.content) || ''); };
    const sysOf = rq => ((rq && rq.messages) || []).filter(x => x && x.role === 'system').map(x => String(x.content || '')).join('\n');
    // the station's own background jobs (the quest master reads recent activity, which can quote the sample) are not the
    // entry dock's run: a race picked one of them now and then
    const entryReq = mock.requests.find(rq => lastUserOf(rq).indexOf('SAMPLE JOB') >= 0 && lastUserOf(rq).indexOf('PIPELINE HANDOFF') < 0 && sysOf(rq).indexOf('quest master') < 0);
    A.ok(entryReq, 'the entry dock\'s provider request was recorded');
    A.ok(sysOf(entryReq).indexOf(BRIEF_HDR + '\n' + ENTRY_BRIEF) >= 0,
      'the ENTRY dock\'s standing brief rode its run\'s system context: ' + sysOf(entryReq).slice(-160));
    const hopReq = mock.requests.find(rq => lastUserOf(rq).indexOf('PIPELINE HANDOFF') >= 0);
    A.ok(hopReq, 'the chain hop\'s provider request was recorded');
    A.ok(lastUserOf(hopReq).indexOf(BRIEF_HDR + '\n' + HOP_BRIEF) >= 0,
      'the RECEIVING dock\'s standing brief rode the handoff turn: ' + lastUserOf(hopReq).slice(0, 300));
    A.ok(lastUserOf(hopReq).indexOf('stage one findings') >= 0, 'alongside the upstream output (the turn still carries the work)');

    // the recorded rows are in the station's real run history too (the ledger/run-store path, not a claim)
    const runsApi = await fetch(B + '/api/runs?agent=*&limit=50', { headers }).then(r => r.json());
    for (const r of h.runs) {
      A.ok((runsApi.runs || []).some(x => x && x.runId === r.runId), 'run ' + r.runId + ' is in GET /api/runs');
    }

    // the crates the world draws rode the REAL station bus — entry crate marked sample:true, chain hop, delivery
    await sse.settle(1500);
    const placed = sse.events.filter(e => e.name === 'workitem.placed').map(e => e.payload || {});
    const deliveredEv = sse.events.filter(e => e.name === 'workitem.delivered').map(e => e.payload || {});
    const entry = placed.find(p => p.kind === 'sample');
    A.ok(entry, 'the entry crate (kind:sample) rode the station bus');
    A.eq(entry.queueId, 'research-agent', 'the entry crate queues at the routed dock');
    A.eq(entry.sample, true, 'the entry crate carries the additive sample:true marker');
    A.ok(placed.some(p => p.kind === 'chain' && p.agentId === 'writer-agent'), 'the chain hop placed its own crate at the downstream dock');
    /* WORK BELONGS TO A LINE (Andrew's ruling, 2026-08-07): the sample IS one of the line's own triggers,
       so its crates carry the line they were fired for — derived server-side from the compiled plan
       (router.lineOriginFor), never taken from the request body. This is what lets the floor animate the
       handoff for line-owned work and stay still for a direct order. */
    const planLineId = require('../frontend/app/pipeline.js').lineOf(twoStagePlan(), 'research-agent');
    A.ok(!!planLineId, 'the compiled floor names the line these docks belong to');
    A.eq(entry.lineId, planLineId, 'the sample entry crate carries the line it was fired for');
    const hopCrate = placed.find(p => p.kind === 'chain' && p.agentId === 'writer-agent');
    A.eq(hopCrate.lineId, planLineId, 'and the handoff crate carries the SAME line end to end');
    A.ok(Events.validate('workitem.placed', hopCrate).ok, 'the additive lineId validates against the frozen workitem.placed contract');
    // A separate line-output authority receipt can arrive first. Follow this sample's
    // exact crate identity; selecting by sample:true would hide a missing marker.
    const outDel = deliveredEv.find(p => p.finalQueueId === 'outbox' && p.workitemId === h.workitemId);
    A.eq(entry.workitemId, h.workitemId, 'the response and placed sample identify the same crate');
    A.eq(deliveredEv.filter(p => p.finalQueueId === 'outbox' && p.workitemId === h.workitemId).length, 1, 'the sample crate receives exactly one OUTBOX completion');
    const entryRun = h.runs.find(r => r.agentId === 'research-agent');
    const terminal = deliveredEv.find(p => p.box === 'line-output' && p.entryRunId === entryRun.runId);
    A.ok(terminal && terminal.workitemId !== h.workitemId, 'the line terminal receipt has separate authority identity');
    A.ok(terminal && terminal.lineId === planLineId && terminal.outboxId === 'o', 'the terminal receipt names the exact completed line and OUTBOX');
    A.ok(terminal && terminal.workitemIds.includes(hopCrate.workitemId), 'the terminal receipt identifies the successful downstream work item');
    A.ok(terminal && Events.validate('workitem.delivered', terminal).ok, 'the authority receipt validates independently against the frozen contract');
    A.ok(outDel, 'the sample crate DELIVERED to the outbox');
    A.eq(outDel.sample, true, 'the delivery carries the sample:true marker too');
    // re-prove the schema law this marker leans on: obj() stanzas set no additionalProperties:false
    const v1 = Events.validate('workitem.placed', entry);
    const v2 = Events.validate('workitem.delivered', outDel);
    A.ok(v1.ok, 'workitem.placed with sample:true validates against the frozen contract: ' + JSON.stringify(v1.errors));
    A.ok(v2.ok, 'workitem.delivered with sample:true validates against the frozen contract: ' + JSON.stringify(v2.errors));

    /* ---- 3c. PROVIDER FAILURE is a failed proof, never a delivered crate. ---- */
    const failed = await post({ text: 'SAMPLE JOB: force provider failure.' });
    A.eq(failed.status, 502, 'provider failure returns a truthful gateway failure');
    A.eq(failed.j.ok, false, 'provider failure says ok:false');
    A.eq(failed.j.delivered, null, 'provider failure cannot claim a durable delivered run');
    A.ok((failed.j.runs || []).some(r => r.reason === 'error'), 'the failure response includes its durable error run');
    await sse.settle(500);
    A.ok(!sse.events.some(e => e.name === 'workitem.delivered' && e.payload && e.payload.workitemId === failed.j.workitemId), 'the failed crate never emits workitem.delivered');
    A.ok(!sse.events.some(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === failed.j.workitemId), 'provider failure is not falsely labeled as a supersede');

    const early = await post({ text: 'SAMPLE JOB: force clean early stop.' });
    A.eq(early.status, 502, 'a clean durable run that stops before OUTBOX is still a failed proof');
    A.eq(early.j.ok, false, 'clean early stop says ok:false');
    A.ok((early.j.runs || []).length >= 2
      && early.j.runs.some(r => r.reason === 'done')
      && early.j.runs.some(r => r.reason === 'empty')
      && early.j.runs.every(r => r.reason === 'done' || r.reason === 'empty'),
    'early-stop repro preserves the clean entry run and the empty downstream terminal without relabeling either');
    A.eq(early.j.delivered, null, 'clean early stop cannot claim an OUTBOX delivery');
    await sse.settle(500);
    A.ok(!sse.events.some(e => e.name === 'workitem.delivered' && e.payload && e.payload.workitemId === early.j.workitemId), 'clean early-stop crate never emits OUTBOX delivery');
    A.ok(!sse.events.some(e => e.name === 'workitem.superseded' && e.payload && e.payload.workitemId === early.j.workitemId), 'clean early stop is not falsely labeled as a supersede');

    /* ---- 4. ONE in flight per station ---- */
    const p1 = post({});
    await sleep(30);   // let the first post claim the lock in its synchronous slice
    const p2 = await post({});
    A.eq(p2.status, 409, 'a second sample while one is riding -> 409');
    A.ok(/already riding/.test(String((p2.j || {}).error || '')), 'the refusal says a sample is already riding: ' + (p2.j || {}).error);
    const r1 = await p1;
    A.eq(r1.status, 200, 'the FIRST sample still delivers (the refusal never killed it)');

    /* ---- 5. NO GRANTS PROPAGATION: a consent-gated mutation stays denied, body fields can't smuggle authority ---- */
    const before = mock.requests.length;
    const probe = await post({ text: 'SAMPLE JOB: use the shell to run the echo command now.', unattendedGrants: ['workbench'], grants: ['workbench'] });
    A.eq(probe.status, 200, 'the shell-probe sample still delivers (a denial never gates the reply)');
    const toolMsgs = [];
    for (const rq of mock.requests.slice(before)) {
      for (const m of ((rq && rq.messages) || [])) if (m && m.role === 'tool') toolMsgs.push(String(m.content || ''));
    }
    // the saved WORKBENCH is in the probe's bay room (its consent-free shell_bg_status rides the wire; the consent-gated
    // shell_exec is withheld from an unattended run), so the denial below is the workbench's consent posture, not a missing room
    A.ok(mock.requests.slice(before).some(rq => ((rq && rq.tools) || []).some(t => /^shell[._]bg[._]status$/.test(String((t.function && t.function.name) || t.name || '')))),
      'the probe\'s bay room holds the saved workbench (shell_bg_status offered)');
    A.ok(toolMsgs.length >= 1, 'the model\'s shell.exec attempt produced a tool result the provider saw');
    A.ok(!toolMsgs.some(t => /pwned/.test(t)), 'the command NEVER executed — no unattended grant reached the sample run: ' + JSON.stringify(toolMsgs).slice(0, 300));

    /* ---- 6. THE SAMPLE IS UNADDRESSED ON EVERY RUN, NOT JUST THE FIRST (2026-08-07) ----
       This route's whole claim is "a REAL run on the REAL UNADDRESSED dispatch path" — the junctions must
       sort it. But the hub's ordinary chat→agent bookkeeping saved a binding for chatId 'sample' during run
       #1, so from run #2 on resolveTarget took its ADDRESSED branch and delivered straight to the remembered
       dock: the FILTER never decided, and the proof quietly stopped proving the thing it names. Posted here
       as a FILTER floor with two lanes so the failure is unmissable — a second sample carrying the OTHER
       content tag must land at the OTHER dock. Two samples, two tags, two docks. ---- */
    const belt = (x, y, dir) => ({ x, y, dir });
    const filterPlan = Pipeline.compileRoutingPlan({
      props: [{ id: 'i2', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
              { id: 'f2', t: 'filter', x: 3, y: 0, w: 1, h: 1, routes: { code: 'S' }, def: 'E' },
              { id: 'bg', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'general-agent' },
              { id: 'bc', t: 'bay', x: 3, y: 3, w: 1, h: 1, agentId: 'code-agent' },
              // the dock the EARLIER samples ran at, still crewed on this floor but off the line. It exists
              // so this block is DECISIVE: with the old binding behaviour both samples below resolve to it
              // (resolveTarget's addressed branch honours any dock on the plan) and the filter never decides.
              { id: 'br', t: 'bay', x: 12, y: 12, w: 1, h: 1, agentId: 'research-agent' },
              { id: 'og', t: 'outbox', x: 8, y: 0, w: 1, h: 1 },
              { id: 'oc', t: 'outbox', x: 5, y: 3, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(4, 0, 'E'), belt(5, 0, 'E'), belt(7, 0, 'E'),
              belt(3, 1, 'S'), belt(3, 2, 'S'), belt(4, 3, 'E')]
    });
    A.ok(Pipeline.ok(filterPlan), 'fixture: the FILTER floor is deployable');
    A.eq(Pipeline.resolveTarget(filterPlan, { tag: 'code' }), 'code-agent', 'fixture: the filter sorts code work down the S lane');
    A.eq(Pipeline.resolveTarget(filterPlan, { tag: 'general' }), 'general-agent', 'fixture: everything else takes the default lane');
    for (const b of filterPlan.bays.concat(filterPlan.dockBays)) b.objects = ['computer'];
    const postedF = await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(filterPlan) });
    A.eq(postedF.status, 200, 'the FILTER floor deploys');

    const s1 = await post({ text: 'SAMPLE JOB: refactor the typescript module that keeps crashing.' });
    A.eq(s1.status, 200, 'sample #1 delivers');
    A.eq(s1.j.agentId, 'code-agent', 'sample #1 is SORTED by the filter (code tag -> the S lane)');
    const s2 = await post({ text: 'SAMPLE JOB: summarize what this work line does, in three sentences.' });
    A.eq(s2.status, 200, 'sample #2 delivers');
    A.eq(s2.j.agentId, 'general-agent',
      'sample #2 is sorted by the FILTER TOO — it did not inherit sample #1\'s dock, so the run is genuinely unaddressed every time');
    // and no binding was ever written: an ephemeral proof chat must not appear in the durable channel map
    let chatMap = { chats: {} };
    try { chatMap = JSON.parse(fs.readFileSync(path.join(ws, 'channels', 'chatmap.json'), 'utf8')); } catch (_) { /* never written at all is the strongest pass */ }
    A.ok(!(chatMap.chats || {}).sample, 'the sample chat is NEVER persisted as a bound chat: ' + JSON.stringify(Object.keys(chatMap.chats || {})));

    /* the pre-flight refusal and the real run cannot name different docks — the check no longer resolves a
       dock at all (it reads the compiled `reach`, which fans every junction lane), so a splitter/filter can
       never clear lane 0 in the check and take lane 1 in the run. An UNCREWED line still refuses honestly. */
    const uncrewed = Pipeline.compileRoutingPlan({
      props: [{ id: 'i3', t: 'intake', x: 0, y: 0, w: 1, h: 1 }, { id: 'b3', t: 'bay', x: 4, y: 0, w: 1, h: 1 }],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E')]
    });
    A.eq((await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(uncrewed) })).status, 200, 'the uncrewed floor deploys');
    const noDock = await post({});
    A.eq(noDock.status, 409, 'a line with no crewed dock still refuses, and refuses honestly');
    A.ok(/no dock/.test(String(noDock.j.error || '')), 'naming the real reason: ' + noDock.j.error);

    /* ---- 7. THE SAMPLE IS LINE-SCOPED (2026-08-10 audit) ----
       The FINISH card is titled for ONE line ("FINISH ‹LINE B›") and posts { line: c.key } — the
       lineComponents key, which IS the compiled plan's lineId (pipeline.js: lineId = c.key; one
       namespace). The route used to read only body.text, so on a two-line floor the card's sample rode
       whichever line's source compiled FIRST. Locked here on a floor with TWO disjoint complete lines
       (A compiles first) plus one UNCREWED third line:
         (c) no `line` -> byte-compatible today's behaviour: the sample rides the FIRST line (A);
         (a) line: B -> the sample enters through B's OWN door, runs B's dock, and its crate carries B;
         (b) an unknown line refuses 409 (never 404, never a ride down some other line), spending nothing;
             a known-but-uncrewed line refuses with the honest no-dock reason. */
    const twoLine = Pipeline.compileRoutingPlan({
      props: [
        // LINE A (oldest ids -> compiles first, keys 'p1'): INTAKE -> alpha-agent -> OUTBOX
        { id: 'p1', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
        { id: 'p2', t: 'bay', x: 4, y: 0, w: 1, h: 1, agentId: 'alpha-agent' },
        { id: 'p3', t: 'outbox', x: 7, y: 0, w: 1, h: 1 },
        // LINE B (disjoint, keys 'p4'): INTAKE -> beta-agent -> OUTBOX
        { id: 'p4', t: 'intake', x: 0, y: 10, w: 1, h: 1 },
        { id: 'p5', t: 'bay', x: 4, y: 10, w: 1, h: 1, agentId: 'beta-agent' },
        { id: 'p6', t: 'outbox', x: 7, y: 10, w: 1, h: 1 },
        // LINE C (disjoint, keys 'p7'): drawn but UNCREWED — exists on the plan, routes to no dock
        { id: 'p7', t: 'intake', x: 0, y: 20, w: 1, h: 1 },
        { id: 'p8', t: 'bay', x: 4, y: 20, w: 1, h: 1 }
      ],
      belts: [belt(1, 0, 'E'), belt(2, 0, 'E'), belt(3, 0, 'E'), belt(5, 0, 'E'), belt(6, 0, 'E'),
              belt(1, 10, 'E'), belt(2, 10, 'E'), belt(3, 10, 'E'), belt(5, 10, 'E'), belt(6, 10, 'E'),
              belt(1, 20, 'E'), belt(2, 20, 'E'), belt(3, 20, 'E')]
    });
    A.ok(Pipeline.ok(twoLine), 'fixture: the two-line floor is deployable');
    const lineA = twoLine.lineOfAgent['alpha-agent'], lineB = twoLine.lineOfAgent['beta-agent'];
    const lineC = twoLine.lineOfProp['p7'];
    A.ok(lineA && lineB && lineC && lineA !== lineB && lineB !== lineC, 'fixture: three distinct compiled lines: ' + [lineA, lineB, lineC].join(','));
    A.eq(Pipeline.resolveTarget(twoLine, {}), 'alpha-agent', 'fixture: the unscoped source walk resolves LINE A first');
    for (const b of twoLine.bays.concat(twoLine.dockBays)) b.objects = ['computer'];
    A.eq((await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(twoLine) })).status, 200, 'the two-line floor deploys');

    // (c) no `line` in the body -> EXACTLY today's behaviour: first-compiled line, no `line` echo
    const plain = await post({});
    A.eq(plain.status, 200, 'a line-less sample still delivers');
    A.eq(plain.j.agentId, 'alpha-agent', 'a line-less sample rides the first-compiled line, unchanged');
    A.ok(!('line' in plain.j), 'a line-less answer carries no line key (byte-compatible)');

    // (a) line: B -> the sample enters through LINE B's own door, not the first-compiled one
    const scoped = await post({ line: lineB });
    A.eq(scoped.status, 200, 'the line-scoped sample delivers');
    A.eq(scoped.j.agentId, 'beta-agent', 'the sample rode the NAMED line (B), not the first-compiled one (A)');
    A.eq(scoped.j.line, lineB, 'the answer echoes the line it proved');
    A.ok(scoped.j.runs.every(r => r.agentId === 'beta-agent'), 'every recorded run stayed on line B\'s dock: ' + JSON.stringify(scoped.j.runs.map(r => r.agentId)));
    await sse.settle(800);
    const scopedCrate = sse.events.filter(e => e.name === 'workitem.placed').map(e => e.payload || {})
      .find(p => p.workitemId === scoped.j.workitemId);
    A.ok(scopedCrate, 'the scoped sample\'s entry crate rode the station bus');
    A.eq(scopedCrate.queueId, 'beta-agent', 'the crate queues at line B\'s dock');
    A.eq(scopedCrate.lineId, lineB, 'the crate carries line B — the chain seed scopes the whole ride to the named line');

    // (b) an unknown line refuses honestly — 409 (route exists), ok:false, and NOTHING dispatched
    const reqBefore = mock.requests.length;
    const unknown = await post({ line: 'p999' });
    A.eq(unknown.status, 409, 'an unknown line refuses 409 — never a 404, never a ride down another line');
    A.ok(unknown.j && unknown.j.ok === false, 'the unknown-line refusal says ok:false');
    A.ok(/no armed work line is named "p999"/.test(String(unknown.j.error || '')), 'naming the real reason: ' + unknown.j.error);
    A.eq(mock.requests.length, reqBefore, 'an unknown-line refusal spends nothing (no provider request)');
    // …and a KNOWN line with no crewed dock refuses with the line-scoped no-dock reason
    const bare7 = await post({ line: lineC });
    A.eq(bare7.status, 409, 'a known-but-uncrewed line refuses 409');
    A.ok(new RegExp('line "' + lineC + '" routes this job to no dock').test(String(bare7.j.error || '')), 'naming the uncrewed line itself: ' + bare7.j.error);
    A.eq(mock.requests.length, reqBefore, 'the uncrewed-line refusal spends nothing either');
  } finally {
    if (sse) sse.close();
    try { child.kill(); } catch (_) {}
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('routing.sample.e2e.test');
})().catch(e => { console.log('FAIL: routing.sample.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
