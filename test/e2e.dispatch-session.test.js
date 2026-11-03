/* node test/e2e.dispatch-session.test.js — TRUE end-to-end of session-targeted delegation.

   Boots the REAL sidecar with a MOCK OpenRouter that makes the lead call team.dispatch with a `session`, then
   ACTS AS THE BROWSER: it holds the real SSE hub open, answers station.sessions with a live session list and
   station.deliver with an ack, exactly as stationcommands.js does in the page. Nothing is stubbed inside the
   sidecar — the bridge, the routes, the run host and the stores are all the shipped ones.

   THE BUG THIS PROVES CLOSED. team.dispatch was agent-addressed only, so a run the Commander asked to happen
   in "research" was filed under whatever session the LEAD was in: the work happened, the lead reported success,
   and the Commander could not find it. Unit tests can show the tool passes a streamId; only this shows the run
   host actually FILES it there. So the load-bearing assertions are the two that read the sidecar's own durable
   state afterwards — /api/runs and /api/transcript — not the tool's own account of itself.

   Also proves the refusal, which matters more than the happy path: a session name that does not exist must
   leave the worker unrun rather than picking a plausible one.

   NOT in test:fast (a child-process boot test shouldn't gate other agents' merges); run via `npm run test:http`. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const hash = text => require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const HOST = '127.0.0.1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw new Error('Timed out waiting for ' + label);
}

const WORKER_TEXT = 'Phobos and Deimos, both captured asteroids.';

/* Added to a count assertion's message: nothing while the count holds, and each extra model call's last user words and
   whether it offered tools when it does not. A call this test did not ask for has only been seen on a loaded gate. */
function extraCalls(mock, from) {
  const extra = mock.requests.slice(from).map(r => {
    const user = (r.messages || []).filter(m => m.role === 'user').pop();
    const words = user ? (typeof user.content === 'string' ? user.content : JSON.stringify(user.content)) : '';
    return { user: words.slice(0, 160), tools: !!(r.tools && r.tools.length) };
  });
  return extra.length ? ' | extra calls: ' + JSON.stringify(extra) : '';
}

/* The mock model. The LEAD's first call delegates; the WORKER's own agent loop then hits this same server and
   answers as itself; the lead's follow-up wraps up. Keyed on the agent the request is for rather than a call
   counter, because the worker's run is interleaved with the lead's and a counter would be order-fragile. */
function startMockOpenRouter(dispatchArgs, options) {
  options = options || {};
  const requests = [];
  const leadSeen = () => requests.filter(r => r.__lead).length;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 8000, pricing: options.pricing || { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') >= 0) {
        let body = ''; req.on('data', d => { body += d; }); req.on('end', async () => {
          let parsed = {};
          try { parsed = JSON.parse(body); } catch (_) {}
          // the WORKER is the run whose tools do NOT include team_dispatch (a worker can never re-delegate)
          const isLead = JSON.stringify(parsed.tools || []).indexOf('team_dispatch') >= 0;
          parsed.__lead = isLead;
          parsed.__repair = !isLead && (parsed.messages || []).some(m => m.role === 'user' && String(m.content).includes('[STRUCTURED RESULT REPAIR]'));
          requests.push(parsed);
          if (parsed.__repair && options.beforeRepair) await options.beforeRepair(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          if (isLead && leadSeen() === 1) {
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_dispatch', type: 'function', function: { name: 'team_dispatch', arguments: JSON.stringify(dispatchArgs) } }] } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
          } else {
            const text = isLead ? 'Handed off.' : parsed.__repair ? (options.repairText || WORKER_TEXT) : (options.workerText || WORKER_TEXT);
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
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

/* BE THE PAGE. Hold the real SSE hub open and answer station.command exactly as stationcommands.js would —
   the same verbs, the same /api/station/ack route. `sessions` is the live list a name is resolved against. */
function attachStationPage(B, token, sessions, options) {
  const seen = [];
  const ctrl = new AbortController();
  const ready = fetch(B + '/api/channels/events?' + require('./_httpToken.js').sseQuery(token), { signal: ctrl.signal }).then(async res => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
            if (!ev || ev.name !== 'station.command') continue;
            const p = ev.payload || {};
            seen.push(p);
            const out = p.verb === 'station.sessions' ? { ok: true, result: { sessions: sessions } }
              : p.verb === 'station.deliver' ? (options && options.deliverError ? { ok: false, error: options.deliverError } : { ok: true, result: { folded: true, session: 'research' } })
                : (p.verb === 'station.dispatch_start' || p.verb === 'station.dispatch_end')
                  ? { ok: true, result: { session: 'research' } }
                  : { ok: false, error: 'unknown station verb: ' + p.verb };
            await fetch(B + '/api/station/ack', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
              body: JSON.stringify(Object.assign({ id: p.id }, out))
            }).catch(() => {});
          }
        }
      } catch (_) { /* aborted at teardown */ }
    })();
    return true;
  });
  return { seen, ready, close: () => { try { ctrl.abort(); } catch (_) {} } };
}

async function drive(B, token, prompt) {
  const res = await fetch(B + '/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
    body: JSON.stringify({ key: 'sk-or-v1-fake', model: 'test/model', agentId: 'agent', isTask: true, messages: [{ role: 'user', content: prompt }] })
  });
  A.eq(res.status, 200, 'POST /api/run streams (200)');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', events = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch (_) {}
    }
  }
  return events;
}

async function run(label, dispatchArgs, sessions, body, options) {
  options = options || {};
  const mock = await startMockOpenRouter(dispatchArgs, options);
  const fixture = SidecarFixture.create({ prefix: 'sk-dispatch-', env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', STARNET_OPENROUTER_KEY: 'sk-or-v1-local-proof',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '1', STARNET_FULL_ACCESS: '1',
    // the quest refresh looks 3 s after each boot and can ask the model, which this test's counts would read as dispatch work
    SKYNET_QUEST_REFRESH: '0'
  } });
  const page = { close: () => {} };
  let running = null;
  try {
    if (options.configureFixture) options.configureFixture(fixture);
    await fixture.start();
    const B = fixture.baseUrl, token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    // the crew the lead can address — pushed exactly as the browser's pushRoster() does
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: [
      { agentId: 'agent', system: 'LEAD', name: 'OVERSEER', model: 'test/model' },
      { agentId: 'researcher', system: 'You research things.', name: 'RESEARCHER', model: 'test/model' }
    ] }) });
    A.eq(roster.status, 200, label + ': the researcher is on the roster');
    const attached = attachStationPage(B, token, sessions, options);
    Object.assign(page, attached);
    await attached.ready;
    await sleep(250);   // let the hub register this client before the run emits
    const context = { B, H, token, station: attached.seen, mock, fixture, label,
      restart: async () => { page.close(); await fixture.restart(); } };
    running = drive(B, token, 'have the researcher summarise the moons of Mars in the research session');
    if (options.during) await options.during(context);
    const events = await running;
    await body({ ...context, events });
  } catch (e) {
    e.message += '\nsidecar output:\n' + fixture.output();
    throw e;
  } finally {
    if (options.release) options.release();
    page.close();
    await fixture.dispose();
    if (running) await running.catch(() => {});
    if (mock.server.closeAllConnections) mock.server.closeAllConnections();
    await new Promise(resolve => mock.server.close(resolve));
  }
}

(async () => {

// ---- THE HAPPY PATH: a named session resolves, and the run is really FILED there ----
await run('targeted',
  { workers: [{ agentId: 'researcher', prompt: 'summarise the moons of Mars', session: 'research' }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }, { id: 'ws_gen', title: 'General', agentId: 'agent' }],
  async ({ B, H, events, station, label }) => {
    // 1) the sidecar really asked the page to resolve the name (the bridge is live, not simulated)
    const asked = station.filter(c => c.verb === 'station.sessions');
    A.eq(asked.length, 1, label + ': the tool asked the live page for its session list, once');

    // 2) the run completed and the worker really ran
    const ends = events.filter(e => e.name === 'agent.run.end');
    A.ok(ends.length >= 1, label + ': the lead run ended');
    A.eq(ends[ends.length - 1].payload.reason, 'done', label + ': the lead completed cleanly');

    // 3) the finished answer was delivered to the page, into the RESOLVED session
    const delivered = station.filter(c => c.verb === 'station.deliver');
    A.eq(delivered.length, 1, label + ': the answer was delivered to the page exactly once');
    A.eq(delivered[0].args.streamId, 'ws_r1', label + ': delivered into the session the Commander named');
    A.eq(delivered[0].args.sessionTitle, 'research', label + ': delivery carries the stable title that heals page-local id drift');
    A.eq(delivered[0].args.agentId, 'researcher', label + ': attributed to the worker that did it');
    A.ok(delivered[0].args.text.indexOf('Phobos') >= 0, label + ": the delivered text is the worker's real output");
    A.eq(station.filter(c => c.verb === 'station.dispatch_start').length, 1, label + ': target-session activity starts from a real worker run');

    /* 4) ⛔ THE LOAD-BEARING PROOF. Everything above is the tool describing its own behaviour. THIS reads the
          sidecar's own durable ledger: the worker's run must be recorded under the named stream. Before this
          fix that field was empty and the run belonged to no session at all. */
    const runs = await (await fetch(B + '/api/runs?agent=researcher&limit=20', { headers: H })).json();
    const workerRun = (runs.runs || []).find(r => r && r.agentId === 'researcher');
    A.ok(workerRun, label + ": the worker's run is in the run ledger");
    A.eq(workerRun.streamId, 'ws_r1', label + ': and the ledger files it under the named session — not the lead\'s');
    A.eq(workerRun.runId, delivered[0].args.runId, label + ': the delivered runId is the SAME run the ledger recorded');
    A.eq(workerRun.delegatedBy, 'agent', label + ': the ledger names the lead that delegated it (the Dossier RECORD keeps it out of the chat fold, #57)');
    A.eq(workerRun.sessionTitle, 'research', label + ': the stable target title is durable for cross-page recovery');
    A.eq(workerRun.deliveryPrompt, 'summarise the moons of Mars', label + ': the delegated instruction is durable');
    A.eq(workerRun.deliveryText, WORKER_TEXT, label + ': the finished answer is durable when no page can receive it');

    // The lead lookup now returns its durable child runs, so COMMS can show the work hierarchy instead of
    // presenting the lead's one dispatch call as if it were the whole job.
    const leadEnd = ends.find(e => e.payload && e.payload.agentId === 'agent');
    const leadRuns = await (await fetch(B + '/api/runs?agent=agent&runId=' + encodeURIComponent(leadEnd.payload.runId), { headers: H })).json();
    const leadRun = (leadRuns.runs || [])[0];
    A.ok(leadRun && Array.isArray(leadRun.children), label + ': lead run API carries a child-run hierarchy');
    A.ok(leadRun.children.some(r => r.runId === workerRun.runId && r.parentRunId === leadRun.runId), label + ': the worker is joined to the exact lead that dispatched it');
    A.ok(leadRun.children.some(r => r.model === 'test/model' && typeof r.durationMs === 'number'), label + ': child hierarchy carries worker model and elapsed time');

    // 5) and its dialogue persisted under that stream, so a reload still finds the work there
    const tr = await (await fetch(B + '/api/transcript?agent=researcher&stream=ws_r1&limit=50', { headers: H })).json();
    const turns = tr.turns || [];
    A.ok(turns.some(t => t.role === 'assistant' && String(t.content).indexOf('Phobos') >= 0),
      label + ": the worker's answer persisted in that session's transcript");
    A.ok(turns.some(t => t.role === 'user' && /moons of Mars/.test(String(t.content))),
      label + ': along with the instruction it was given');

    // 6) the lead was told where it landed, so its spoken/typed report can be accurate
    const toolResults = events.filter(e => e.name === 'agent.tool_result');
    A.ok(toolResults.length >= 1, label + ': the dispatch returned a tool result');
  });

/* ---- ⛔ THE REFUSAL, WHICH MATTERS MORE. A name that matches nothing must leave the worker UNRUN. The
   original bug was not "the wrong session got picked at random" — it was that picking anything at all lets the
   lead truthfully report a success the Commander cannot find. ---- */
await run('unknown-session',
  { workers: [{ agentId: 'researcher', prompt: 'summarise the moons of Mars', session: 'marketing' }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }, { id: 'ws_gen', title: 'General', agentId: 'agent' }],
  async ({ B, H, station, mock, label }) => {
    A.eq(station.filter(c => c.verb === 'station.deliver').length, 0, label + ': nothing was delivered anywhere');
    A.eq(mock.requests.filter(r => !r.__lead).length, 0, label + ': the WORKER never ran — no work happened in the wrong place');
    const runs = await (await fetch(B + '/api/runs?agent=researcher&limit=20', { headers: H })).json();
    A.eq((runs.runs || []).filter(r => r && r.agentId === 'researcher').length, 0, label + ': and no worker run was recorded at all');
    // the lead is TOLD, in terms it can act on
    const followUp = mock.requests.filter(r => r.__lead).pop();
    const seen = JSON.stringify(followUp && followUp.messages || []);
    // matched loosely on purpose: `seen` is JSON, so the quotes around the name are backslash-escaped in it
    A.ok(/no session called/.test(seen) && /marketing/.test(seen), label + ': the model is told the session does not exist, by name');
    A.ok(seen.indexOf('research') >= 0, label + ': and is shown the sessions that DO exist, so it can correct itself');
    A.ok(/did NOT run/.test(seen), label + ': and told plainly that no work happened');
  });

// ---- FINAL DELIVERY AUTHORITY: raw output cannot win a race against its bounded result repair. ----
for (const validRepair of [true, false]) {
  const label = validRepair ? 'validated-repair' : 'invalid-result';
  let releaseRepair;
  const repairGate = new Promise(resolve => { releaseRepair = resolve; });
  const repairedText = validRepair ? JSON.stringify({ answer: 'x'.repeat(250000) + '\u{1F680}\u5B87\u5B99COMPLETE_TAIL' }) : 'still invalid JSON';
  const expectedReason = validRepair ? 'done' : 'invalid-result';
  let originalId = '';
  await run(label,
    { workers: [{ agentId: 'researcher', prompt: 'summarise the moons of Mars', session: 'research',
      resultSchema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } }, additionalProperties: false } }] },
    [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }, { id: 'ws_gen', title: 'General', agentId: 'agent' }],
    async ({ fixture, station, mock, restart }) => {
      const response = await fixture.json('GET', '/api/runs?agent=researcher&limit=20');
      A.eq(response.status, 200, label + ': completed runs are available over the real API');
      const runs = response.body.runs || [];
      const listed = runs.find(r => r.runId === originalId);
      const repair = runs.find(r => r.runId !== originalId);
      // threads-backend-16: the LIST no longer repeats a final envelope's preview when it records the full length (the
      // page reads the verified projection instead); the single-run read keeps the bounded preview
      const single = await fixture.json('GET', '/api/runs?agent=researcher&runId=' + encodeURIComponent(originalId));
      const original = ((single.body && single.body.runs) || []).find(r => r.runId === originalId);
      A.ok(original && listed, label + ': the original run is in the list and in its single read');
      if (Number.isSafeInteger(listed.dispatchDelivery.textLength)) {
        A.ok(!('text' in listed.dispatchDelivery), label + ': the list carries the final answer once (deliveryText), not twice');
        A.eq(Object.assign({}, original.dispatchDelivery, { text: undefined }), Object.assign({}, listed.dispatchDelivery, { text: undefined }), label + ': and is otherwise the same envelope');
      }
      A.eq(runs.length, 2, label + ': one original and one repair are exactly two executions');
      A.eq(new Set(runs.map(r => r.runId)).size, 2, label + ': finalization does not append a duplicate execution');
      A.eq(original.reason, 'done', label + ': execution outcome remains immutable after dispatch validation');
      A.eq(original.deliveryText, 'raw invalid JSON', label + ': original output remains execution evidence');
      A.eq(original.dispatchDelivery.state, 'final', label + ': original dispatch is finalized');
      A.eq(original.dispatchDelivery.reason, expectedReason, label + ': dispatch outcome comes from validation');
      A.eq(original.dispatchDelivery.repairRunId, repair.runId, label + ': final delivery links the real repair execution');
      A.eq(repair.dispatchDelivery.state, 'internal', label + ': repair is never an independent conversation delivery');
      A.eq(repair.deliveryText, repairedText.slice(0, 24000), label + ': repair execution retains its bounded preview');
      A.eq(mock.requests.filter(r => r.__repair).length, 1, label + ': exactly one bounded repair ran');
      const end = station.filter(c => c.verb === 'station.dispatch_end');
      A.eq(end.length, 1, label + ': dispatch ends once after validation');
      A.eq(end[0].args.runId, originalId, label + ': settlement retains the original dispatch identity');
      A.eq(end[0].args.reason, expectedReason, label + ': live settlement matches persisted dispatch outcome');
      A.eq({ ...end[0].args.dispatchDelivery, text: end[0].args.dispatchDelivery.text.slice(0, 24000), textLength: original.dispatchDelivery.textLength, textSha256: original.dispatchDelivery.textSha256 }, original.dispatchDelivery, label + ': live and recovered settlement share one final envelope with a bounded stored preview');
      const deliveries = station.filter(c => c.verb === 'station.deliver');
      if (validRepair) {
        A.eq(original.dispatchDelivery.text, repairedText.slice(0, 24000), label + ': only the repaired valid answer is final');
        A.ok(repairedText.length > 200000, label + ': recovery exercises an accepted answer larger than the historical transcript cap');
        A.eq(deliveries.length, 1, label + ': one validated answer is delivered');
        A.eq(deliveries[0].args.runId, originalId, label + ': repair preserves the delivery idempotency key');
        A.eq(deliveries[0].args.text, repairedText, label + ': the live delivery contains repaired text');
      } else {
        A.eq(deliveries.length, 0, label + ': invalid output is never delivered as a completed answer');
        A.ok(/No completion was accepted/.test(original.dispatchDelivery.text), label + ': finalized failure explains that validation failed');
      }
      const acceptedText = validRepair ? repairedText : original.dispatchDelivery.text;
      const canonicalRoute = '/api/transcript?agent=researcher&stream=ws_r1&limit=200';
      const finalRoute = '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(originalId) + '&delivery=1&limit=1';
      const canonical = await fixture.json('GET', canonicalRoute);
      A.eq(canonical.body.turns.filter(t => t.role === 'assistant').map(t => t.content), [acceptedText], label + ': conversation contains one full accepted answer without raw output or repair duplicates');
      A.eq(canonical.body.turns.filter(t => t.role === 'user').map(t => t.content), ['summarise the moons of Mars'], label + ': conversation keeps the original human-readable handoff');
      A.ok(canonical.body.turns.every(t => t.sourceRunId === originalId), label + ': displayed conversation belongs to original dispatch identity');
      const finalView = await fixture.json('GET', finalRoute);
      A.eq(finalView.body.turns.map(t => ({ role: t.role, sourceRunId: t.sourceRunId, content: t.content })), [{ role: 'assistant', sourceRunId: originalId, content: acceptedText }], label + ': exact finalized delivery view returns full authoritative text');
      A.eq(original.dispatchDelivery.textLength, acceptedText.length, label + ': durable envelope proves full accepted length');
      A.eq(original.dispatchDelivery.textSha256, hash(acceptedText), label + ': durable envelope proves full accepted UTF-8 digest');
      A.eq(finalView.body.turns[0].textLength, acceptedText.length, label + ': full projection carries the same exact length');
      A.eq(finalView.body.turns[0].textSha256, hash(acceptedText), label + ': full projection carries the same exact digest');
      if (validRepair) {
        A.ok(JSON.parse(finalView.body.turns[0].content).answer.endsWith('COMPLETE_TAIL'), label + ': complete valid JSON tail survives authoritative read');
        console.log('delivery proof: ' + JSON.stringify({ characters: acceptedText.length, sha256: hash(acceptedText), originalId, repairId: repair.runId, tail: 'COMPLETE_TAIL' }));
      }
      const rawOriginal = await fixture.json('GET', '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(originalId));
      A.eq(rawOriginal.body.turns.filter(t => t.role === 'assistant').map(t => t.content), [acceptedText], label + ': exact-run display keeps only the accepted conversation');
      const rawRepair = await fixture.json('GET', '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(repair.runId));
      A.eq(rawRepair.body.turns, [], label + ': exact-run display cannot expose internal repair execution');
      const internalFinal = await fixture.json('GET', '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(repair.runId) + '&delivery=1');
      A.eq(internalFinal.body.turns, [], label + ': internal repair has no independently finalized delivery');
      const beforeSpend = runs.reduce((sum, row) => sum + row.usd, 0);
      A.ok(beforeSpend > 0, label + ': deterministic mock pricing measures nonzero spend for duplicate detection');
      const before = runs.map(row => ({ runId: row.runId, ts: row.ts, usd: row.usd, reason: row.reason, dispatchDelivery: row.dispatchDelivery }));
      const requestCount = mock.requests.length;
      await restart();
      const replay = await fixture.json('GET', '/api/runs?agent=researcher&limit=20');
      const replayed = replay.body.runs || [];
      A.eq(replayed.map(row => ({ runId: row.runId, ts: row.ts, usd: row.usd, reason: row.reason, dispatchDelivery: row.dispatchDelivery })), before,
        label + ': a real sidecar restart preserves exactly the original and internal repair rows');
      A.eq(replayed.reduce((sum, row) => sum + row.usd, 0), beforeSpend, label + ': restart does not duplicate execution spend');
      A.eq(mock.requests.length, requestCount, label + ': restart does not rerun completed dispatch work' + extraCalls(mock, requestCount));
      A.eq((await fixture.json('GET', canonicalRoute)).body.turns, canonical.body.turns, label + ': reopening after real restart keeps only the full finalized conversation');
      A.eq((await fixture.json('GET', finalRoute)).body.turns, finalView.body.turns, label + ': exact authoritative delivery survives real restart without truncation');
    },
    { workerText: 'raw invalid JSON', repairText: repairedText, pricing: { prompt: '0.000001', completion: '0.000002' },
      beforeRepair: () => repairGate, release: releaseRepair,
      during: async ({ fixture, station, mock }) => {
        await waitFor(() => mock.requests.some(r => r.__repair), label + ' repair request');
        const pending = await fixture.json('GET', '/api/runs?agent=researcher&limit=20');
        const runs = pending.body.runs || [];
        A.eq(runs.length, 1, label + ': while repair is blocked only the original execution has ended');
        originalId = runs[0].runId;
        A.eq(runs[0].dispatchDelivery.state, 'pending', label + ': the real API keeps raw output provisional during repair');
        A.eq(runs[0].deliveryText, 'raw invalid JSON', label + ': the held test reaches the formerly unsafe raw-output window');
        A.eq(station.filter(c => c.verb === 'station.dispatch_end').length, 0, label + ': no end is emitted before validation');
        A.eq(station.filter(c => c.verb === 'station.deliver').length, 0, label + ': no raw answer is delivered while repair is in flight');
        A.eq(station.filter(c => c.verb === 'station.dispatch_start').length, 1, label + ': original dispatch activity remains the live owner');
        const conversation = await fixture.json('GET', '/api/transcript?stream=ws_r1&limit=200');
        A.eq(conversation.body.turns, [], label + ': pending raw output and internal repair cannot leak through conversation history');
        const raw = await fixture.json('GET', '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(originalId));
        A.eq(raw.body.turns, [], label + ': exact-run display also withholds unaccepted pending execution');
        const final = await fixture.json('GET', '/api/transcript?stream=ws_r1&runId=' + encodeURIComponent(originalId) + '&delivery=1&limit=1');
        A.eq(final.body.turns, [], label + ': pending original has no finalized delivery to recover');
        releaseRepair();
      }
    });
}


// The real composition root must not publish final recovery when saving its complete payload fails.
await run('projection-write-failure',
  { workers: [{ agentId: 'researcher', prompt: 'answer', session: 'research', resultSchema: { type: 'object' } }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }],
  async ({ fixture, mock, station, restart }) => {
    const rows = (await fixture.json('GET', '/api/runs?agent=researcher&limit=20')).body.runs;
    const original = rows.find(r => r.dispatchDelivery.state === 'pending');
    const repair = rows.find(r => r.dispatchDelivery.state === 'internal');
    A.eq(rows.length, 2, 'failed projection still records exactly original and repair executions');
    A.ok(original && repair, 'failed projection never upgrades the original run to recoverable final');
    const finalRoute = '/api/transcript?stream=ws_r1&runId=' + original.runId + '&delivery=1';
    A.eq((await fixture.json('GET', finalRoute)).body.turns, [], 'failed projection has no full accepted recovery payload');
    A.eq((await fixture.json('GET', '/api/transcript?stream=ws_r1')).body.turns, [], 'failed projection never substitutes original or repaired raw text into chat');
    const follow = mock.requests.filter(r => r.__lead).pop();
    const toolResult = JSON.stringify((follow.messages || []).filter(m => m.role === 'tool'));
    A.ok(/recovery record could not be saved/.test(toolResult), 'lead receives the persistence failure diagnosis');
    A.ok(/could not show it there/.test(toolResult), 'lead also receives the page delivery failure');
    A.ok(!/completed run is durable and will be reconciled/.test(toolResult), 'offline delivery cannot overwrite failed persistence with a false recovery promise');
    A.eq(station.filter(c => c.verb === 'station.deliver').length, 1, 'accepted result is still offered live despite storage failure');
    const spend = rows.reduce((n, r) => n + r.usd, 0);
    await restart();
    const replayed = (await fixture.json('GET', '/api/runs?agent=researcher&limit=20')).body.runs;
    A.eq(replayed.find(r => r.runId === original.runId).dispatchDelivery.state, 'pending', 'restart preserves unconfirmed recovery after failed projection');
    A.eq((await fixture.json('GET', finalRoute)).body.turns, [], 'restart cannot invent a missing full recovery payload');
    A.eq((await fixture.json('GET', '/api/transcript?stream=ws_r1')).body.turns, [], 'restart never displays raw invalid or internal repair output');
    A.eq(replayed.reduce((n, r) => n + r.usd, 0), spend, 'projection failure and restart do not duplicate spend');
  },
  { workerText: 'raw invalid JSON', repairText: JSON.stringify({ answer: 'x'.repeat(26000) + 'TAIL' }),
    deliverError: 'page unavailable', pricing: { prompt: '0.000001', completion: '0.000002' },
    configureFixture: fixture => {
      // Test-only process entry injects exactly the production append boundary; all HTTP/run/storage code remains real.
      const storeFile = path.resolve(__dirname, '../sidecar/transcriptstore.js');
      const entryFile = path.resolve(__dirname, '../sidecar/index.js');
      fixture.entry = path.join(fixture.profile, 'projection-fault.cjs');
      fs.writeFileSync(fixture.entry, 'const store = require(' + JSON.stringify(storeFile) + ');\n'
        + 'const make = store.makeTranscriptStore; store.makeTranscriptStore = o => { const s = make(o), append = s.appendStrict; s.appendStrict = row => { if (row.dispatchState === "final") throw new Error("injected projection write failure"); return append(row); }; return s; };\n'
        + 'require(' + JSON.stringify(entryFile) + ');\n');
    }
  });

// The second write can fail after complete acceptance; restart finishes only the run envelope, without rerunning work.
await run('run-final-patch-failure',
  { workers: [{ agentId: 'researcher', prompt: 'answer', session: 'research', resultSchema: { type: 'object' } }] },
  [{ id: 'ws_r1', title: 'research', agentId: 'researcher' }],
  async ({ fixture, mock, restart }) => {
    const rows = (await fixture.json('GET', '/api/runs?agent=researcher&limit=20')).body.runs;
    A.eq(rows.length, 1, 'failed run patch keeps one real execution');
    const original = rows[0];
    A.eq(original.dispatchDelivery.state, 'pending', 'failed run patch does not claim persisted final acknowledgement');
    const finalRoute = '/api/transcript?stream=ws_r1&runId=' + original.runId + '&delivery=1&limit=1';
    const accepted = (await fixture.json('GET', finalRoute)).body.turns[0];
    A.ok(accepted && accepted.content.endsWith('COMPLETE_TAIL"}'), 'full accepted payload is already recoverable before its run patch');
    const requests = mock.requests.length;
    fs.unlinkSync(path.join(fixture.profile, 'fail-run-patch'));
    await restart();
    const replay = (await fixture.json('GET', '/api/runs?agent=researcher&limit=20')).body.runs;
    A.eq(replay.length, 1, 'boot recovery never duplicates original execution');
    A.eq(replay[0].runId, original.runId, 'boot recovery retains original run identity');
    A.eq(replay[0].dispatchDelivery.state, 'final', 'boot completes interrupted run finalization from accepted payload');
    A.eq(replay[0].dispatchDelivery.textSha256, hash(accepted.content), 'recovered run envelope proves exact accepted payload');
    A.eq(replay[0].dispatchDelivery.textLength, accepted.content.length, 'recovered run envelope proves exact accepted length');
    A.eq(replay[0].usd, original.usd, 'recovering an interrupted patch preserves execution spend');
    A.eq(mock.requests.length, requests, 'boot finalization recovery never starts another model run' + extraCalls(mock, requests));
    A.eq((await fixture.json('GET', finalRoute)).body.turns, [accepted], 'boot recovery retains exactly one first accepted projection');
    await restart();
    A.eq((await fixture.json('GET', '/api/runs?agent=researcher&limit=20')).body.runs[0].dispatchDelivery, replay[0].dispatchDelivery, 'repeated restart is idempotent after final patch recovery');
  },
  { workerText: JSON.stringify({ answer: 'x'.repeat(210000) + 'COMPLETE_TAIL' }),
    deliverError: 'page unavailable', pricing: { prompt: '0.000001', completion: '0.000002' },
    configureFixture: fixture => {
      const storeFile = path.resolve(__dirname, '../sidecar/runstore.js');
      const entryFile = path.resolve(__dirname, '../sidecar/index.js');
      const marker = path.join(fixture.profile, 'fail-run-patch');
      fs.writeFileSync(marker, 'fault');
      fixture.entry = path.join(fixture.profile, 'run-patch-fault.cjs');
      fs.writeFileSync(fixture.entry, 'const fs = require("fs"), store = require(' + JSON.stringify(storeFile) + ');\n'
        + 'const make = store.makeRunStore; store.makeRunStore = o => { const s = make(o), finalize = s.finalizeDelivery; s.finalizeDelivery = (id, value) => { if (fs.existsSync(' + JSON.stringify(marker) + ')) throw new Error("injected run patch failure"); return finalize(id, value); }; return s; };\n'
        + 'require(' + JSON.stringify(entryFile) + ');\n');
    }
  });
A.report('e2e.dispatch-session.test');

})().catch(e => { console.error(e); process.exit(1); });
