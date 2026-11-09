/* node test/e2e.approval-lifecycle.test.js — real-sidecar proof of the approval lifecycle across a run's end (2026-10-13).

   Two seams, one waiter (askHuman):

   1. A BACKGROUND hand-off (team.dispatch background:true) in ASK mode. The worker asks through its lead's consent
      broker, but the lead's turn ends right after the hand-off: its NDJSON stream closes and the run's teardown used
      to deny every open prompt within a second ("consent denied for fs.write: denied") — the row flashed "Needs you"
      and NEEDS YOU stayed empty. Now the worker's ask outlives the lead's turn: it is announced on the station bus
      (SSE) with the asking conversation and the run id to answer with, listed in the reconnect snapshot, answerable
      through POST /api/consent, and an unanswered one still fail-closes on the real consent timeout.

   2. rc-walk FINDINGS #60: the page watching a run reloads while the run waits on an approval. The disconnect law
      still cancels the run and denies the ask, but the conversation now SAYS so after the reload: the transcript
      carries one station line naming what was waiting and that nothing was approved. STOP (POST /api/cancel first)
      is a different cause and never gets that line.

   3. (2026-10-14 review) A background worker STOPPED while its ask waits settles that ask as stopped (never "nobody
      answered in time"), and a "session" answer after the lead's turn approves that one call: session grants end with
      the lead's run, so none is left behind under the ended run and the same worker's next write asks again.

   Boots the actual sidecar (hermetic fixture) on a scripted local model. */
'use strict';

const A = require('./_assert.js');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { sseQuery } = require('./_httpToken.js');
const { fetchJsonAtDesk } = require('./helpers/desk-code.js');

const HOST = '127.0.0.1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONSENT_TIMEOUT_MS = 7000;

function startMockProvider() {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
        return;
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', async () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (_) {}
        requests.push(parsed);
        const messages = parsed.messages || [];
        const toolNames = (parsed.tools || []).map(t => t && t.function && t.function.name);
        const lastUser = messages.map(m => m.role).lastIndexOf('user');
        // route on the Commander's own words: on this non-Claude wire the run-context note (task brief, commander evidence
        // that quotes earlier requests) leads the newest user message (provider.js noteCarrier)
        const user = String(userWords(messages[lastUser] || {}) || '');
        const used = messages.slice(lastUser + 1).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls || []).map(t => t.function && t.function.name);
        const lastTool = String((messages.slice(lastUser + 1).filter(m => m.role === 'tool').pop() || {}).content || '');
        const isLead = toolNames.indexOf('team_dispatch') >= 0;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const call = (name, args) => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: name + '_' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const say = text => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }) + '\n\n');
        };
        const needsBrief = toolNames.indexOf('brief_proceed') >= 0 && used.indexOf('brief_proceed') < 0;
        if (!parsed.tools || !parsed.tools.length) say('Launch prep');
        else if (isLead && /^Review the background work/.test(user)) say('Reviewed the background work.');
        else if (isLead && /hand off in the background/.test(user)) {
          if (needsBrief) call('brief_proceed', { objective: 'Hand the launch to the crew', deliverable: 'launch email and pricing page' });
          else if (used.indexOf('team_dispatch') < 0) call('team_dispatch', { background: true, workers: [
            { agentId: 'writer', prompt: 'Write the launch email' },
            { agentId: 'drafter', prompt: 'Draft the pricing page' }] });
          else say('Handed off.');
        } else if (isLead && /write the brief yourself/.test(user)) {
          if (needsBrief) call('brief_proceed', { objective: 'Write the opportunity brief', deliverable: 'opportunity-brief.md' });
          else if (used.indexOf('fs_write') < 0) call('fs_write', { path: 'opportunity-brief.md', content: '# Brief\n' });
          else say('tool said: ' + lastTool.slice(0, 120));
        } else if (!isLead && /Write the launch email/.test(user)) {
          if (used.indexOf('fs_write') < 0) call('fs_write', { path: 'launch-email.md', content: '# Launch email\n' });
          else say('writer tool said: ' + lastTool.slice(0, 160));
        } else if (!isLead && /Draft the pricing page/.test(user)) {
          // the second worker asks only AFTER the lead's turn is over (its first step is slow)
          const writes = used.filter(n => n === 'fs_write').length;
          if (!writes) { await sleep(1500); call('fs_write', { path: 'pricing-page.md', content: '# Pricing\n' }); }
          // a second page of the same kind once the first landed (part 4: does a "session" answer carry over?)
          else if (writes === 1 && /^Wrote /.test(lastTool)) call('fs_write', { path: 'pricing-faq.md', content: '# FAQ\n' });
          else say('drafter tool said: ' + lastTool.slice(0, 160));
        } else say('Done.');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, requests, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

// the station bus as a page sees it: every event, and every station.command acked the way a live page does
function attachBus(B, token) {
  const events = [];
  const ctrl = new AbortController();
  const ready = fetch(B + '/api/channels/events?' + sseQuery(token), { signal: ctrl.signal }).then(res => {
    A.eq(res.status, 200, 'the station bus opens');
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
            if (!ev || !ev.name) continue;
            events.push(Object.assign({ at: Date.now() }, ev));
            if (ev.name === 'station.command') {
              const p = ev.payload || {};
              const out = (p.verb === 'station.dispatch_start' || p.verb === 'station.dispatch_end' || p.verb === 'station.deliver') ? { ok: true, result: {} } : { ok: false, error: 'unknown station verb: ' + p.verb };
              fetch(B + '/api/station/ack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B },
                body: JSON.stringify(Object.assign({ id: p.id }, out)) }).catch(() => {});
            }
          }
        }
      } catch (_) { /* closed */ }
    })();
  });
  return { events, ready, close: () => ctrl.abort() };
}

// POST /api/run and read its NDJSON as it arrives; onEvent may answer prompts or abort the request (a page reload)
function startRun(B, H, body, onEvent) {
  const ctrl = new AbortController();
  const events = [];
  const done = (async () => {
    const res = await fetch(B + '/api/run', { method: 'POST', headers: H, body: JSON.stringify(body), signal: ctrl.signal });
    A.eq(res.status, 200, 'POST /api/run streams');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          events.push(ev);
          if (onEvent) await onEvent(ev, ctrl);
        }
      }
    } catch (e) { if (!ctrl.signal.aborted) throw e; }
    return events;
  })();
  return { events, done, ctrl };
}

async function until(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const mock = await startMockProvider();
  // ASK mode: no full-access env, so every write asks the Commander
  const fixture = SidecarFixture.create({ prefix: 'sk-approval-life-', env: {
    SKYNET_OPENROUTER_BASE: mock.base, STARNET_OPENROUTER_BASE: mock.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-local-proof', STARNET_OPENROUTER_KEY: 'sk-or-v1-local-proof',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model',
    SKYNET_FULL_ACCESS: '', STARNET_FULL_ACCESS: '',
    STARNET_CONSENT_TIMEOUT_MS: String(CONSENT_TIMEOUT_MS)
  } });
  let bus = null;
  try {
    await fixture.start();
    const B = fixture.baseUrl, token = fixture.token;
    const H = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const roster = await fetch(B + '/api/roster', { method: 'POST', headers: H, body: JSON.stringify({ agents: [
      { agentId: 'agent', system: 'LEAD', name: 'NOVA', model: 'test/model' },
      { agentId: 'writer', system: 'You write launch copy.', name: 'VEX', model: 'test/model' },
      { agentId: 'drafter', system: 'You draft pages.', name: 'ROOK', model: 'test/model' }
    ] }) });
    A.eq(roster.status, 200, 'the crew is on the roster');
    bus = attachBus(B, token);
    await bus.ready;
    await sleep(250);

    /* ---------------- 1. a background hand-off's approvals outlive the lead's turn ---------------- */
    let leadRunId = '';
    const lead = startRun(B, H, { key: 'sk-or-v1-local-proof', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'ws_handoff',
      messages: [{ role: 'user', content: 'hand off in the background' }] }, async (ev) => {
      if (ev.name === 'agent.run.start' && ev.payload && !leadRunId) leadRunId = ev.payload.runId;
      // NOVA's own ask (the hand-off itself) is answered on its own stream, as the COMMS card does
      if (ev.name === 'permission.prompt' && ev.payload && !ev.payload.workerAgentId) {
        await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: leadRunId, promptId: ev.payload.promptId, decision: 'once' }) });
      }
    });
    const leadEvents = await lead.done;
    const leadEndedAt = Date.now();
    A.ok(leadEvents.some(e => e.name === 'agent.run.end' && e.payload && e.payload.runId === leadRunId), 'the lead turn ended right after handing off');
    A.ok(!leadEvents.some(e => e.name === 'permission.prompt' && e.payload && e.payload.workerAgentId),
      'a background worker\'s ask never rides the lead\'s own stream (that stream ends with the turn)');

    const askOf = who => bus.events.find(e => e.name === 'permission.prompt' && e.payload && e.payload.workerAgentId === who);
    await until(() => askOf('writer') && askOf('drafter'), 15000, 'both background workers asking on the station bus');
    const writerAsk = askOf('writer').payload, drafterAsk = askOf('drafter').payload;
    A.ok(askOf('drafter').at > leadEndedAt, 'the second worker asked after the lead\'s turn was already over');
    for (const p of [writerAsk, drafterAsk]) {
      A.eq(p.background, true, p.workerAgentId + ': the ask is marked as a background worker\'s');
      A.eq(p.runId, leadRunId, p.workerAgentId + ': the ask names the run whose answer slot holds it');
      A.eq(p.streamId, 'ws_handoff', p.workerAgentId + ': the ask names the conversation that handed the work off');
      A.ok(p.tool === 'fs.write' && /\.md/.test(p.argsSummary || ''), p.workerAgentId + ': the ask is the worker\'s file write');
    }
    // the old teardown denied within ~1 s: give it well past that, then the asks must still be open
    await sleep(2000);
    const deniedEarly = bus.events.filter(e => e.name === 'agent.tool_result' && e.payload && e.payload.isError && /denied/.test(e.payload.summary || ''));
    A.eq(deniedEarly.length, 0, 'no worker write was denied when the lead\'s turn ended');
    A.ok(!bus.events.some(e => e.name === 'permission.response' && e.payload && (e.payload.promptId === writerAsk.promptId || e.payload.promptId === drafterAsk.promptId)),
      'neither background ask was settled by the lead\'s teardown');

    // a page that reloads now finds both asks in the reconnect snapshot, named for the worker that asked
    const snap = await (await fetch(B + '/api/state/snapshot', { headers: H })).json();
    for (const p of [writerAsk, drafterAsk]) {
      const row = (snap.prompts || []).find(r => r.promptId === p.promptId);
      A.ok(!!row, p.workerAgentId + ': the reconnect snapshot lists the open ask');
      if (row) {
        A.eq(row.runId, leadRunId, p.workerAgentId + ': snapshot row answers with the lead run id');
        A.eq(row.agentId, p.workerAgentId, p.workerAgentId + ': snapshot row names the worker that asked (not the lead)');
        A.eq(row.background, true, p.workerAgentId + ': snapshot row is a background ask');
        A.eq(row.streamId, 'ws_handoff', p.workerAgentId + ': snapshot row names the conversation');
        A.eq(row.tool, 'fs.write', p.workerAgentId + ': snapshot row carries what it asks for');
      }
    }

    // the Commander approves the writer's ask from its row / NEEDS YOU (Chat.answerConsent -> POST /api/consent)
    const ans = await (await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: leadRunId, promptId: writerAsk.promptId, decision: 'once' }) })).json();
    A.eq(ans.ok, true, 'POST /api/consent with the prompt\'s runId answers a background ask after the lead ended');
    A.ok(!ans.gone, 'an answer that landed is never reported gone');
    await until(() => bus.events.some(e => e.name === 'permission.response' && e.payload && e.payload.promptId === writerAsk.promptId && e.payload.decision === 'once'), 5000, 'the answer announced on the station bus');
    const writerFile = path.join(fixture.workspace, 'writer', 'launch-email.md');
    await until(() => fs.existsSync(writerFile), 8000, 'the approved write landing in the writer\'s workspace');
    A.ok(fs.existsSync(writerFile), 'the approved background write really ran');

    // the drafter's ask is left alone: it still fail-closes on the real consent timeout, and says so
    const expired = await until(() => bus.events.find(e => e.name === 'permission.response' && e.payload && e.payload.promptId === drafterAsk.promptId), CONSENT_TIMEOUT_MS + 6000, 'the unanswered ask expiring');
    A.eq(expired.payload.decision, 'deny', 'an unanswered background ask fails closed');
    A.eq(expired.payload.expired, true, 'and is marked expired (nobody answered), never approved');
    A.ok(expired.at - drafterAsk.askedAt >= CONSENT_TIMEOUT_MS - 600, 'it expired on the consent timeout, not at the lead\'s end');
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'drafter', 'pricing-page.md')), 'the unanswered write never ran');
    const gone = await (await fetch(B + '/api/state/snapshot', { headers: H })).json();
    A.ok(!(gone.prompts || []).some(r => r.promptId === writerAsk.promptId || r.promptId === drafterAsk.promptId), 'settled asks leave the snapshot');
    const late = await (await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: leadRunId, promptId: drafterAsk.promptId, decision: 'once' }) })).json();
    A.eq(late.ok, false, 'a late answer to the expired ask approves nothing');
    /* SOAK 10-15: an ask the station no longer holds says so (gone:true), so the worker's row lets it go and says the
       approval is no longer waiting, instead of "Please try again" on a key nothing can answer any more */
    A.eq(late.gone, true, 'a late answer to the expired background ask is told the ask is gone');
    const twice = await (await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: leadRunId, promptId: writerAsk.promptId, decision: 'deny' }) })).json();
    A.eq([twice.ok, twice.gone], [false, true], 'a second answer to an ask already answered (on another surface) is told it is gone, and changes nothing');

    /* ---------------- 2. #60: the page reloads while the run waits on its own approval ---------------- */
    let reloadRunId = '';
    const reload = startRun(B, H, { key: 'sk-or-v1-local-proof', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'ws_reload', placed: ['cabinet'],   // NOVA's file cabinet: its own fs.write asks
      messages: [{ role: 'user', content: 'write the brief yourself' }] }, async (ev, ctrl) => {
      if (ev.name === 'agent.run.start' && ev.payload && !reloadRunId) reloadRunId = ev.payload.runId;
      if (ev.name === 'permission.prompt' && ev.payload && ev.payload.tool === 'fs.write') { await sleep(200); ctrl.abort(); }   // the page goes away
    });
    await reload.done;
    const rec = await until(async () => {
      const j = await (await fetch(B + '/api/runs?agent=agent&runId=' + encodeURIComponent(reloadRunId), { headers: H })).json();
      return (j.runs || [])[0];
    }, 8000, 'the reloaded run\'s record');
    A.eq(rec.reason, 'cancelled', 'the disconnect law still cancels the run');
    A.ok(rec.pageClosed && Array.isArray(rec.pageClosed.waitingOn) && rec.pageClosed.waitingOn.some(w => /opportunity-brief\.md/.test(w)),
      'the run record says the page closed while it waited on the opportunity-brief.md approval');
    const tr = await (await fetch(B + '/api/transcript?agent=agent&stream=ws_reload&limit=50', { headers: H })).json();
    const line = (tr.turns || []).find(t => t && t.sys && /closed, reloaded or reconnected/.test(t.content || ''));
    A.ok(!!line, 'after the reload the conversation carries the station\'s line about the ended run');
    if (line) {
      A.ok(/nothing was approved/.test(line.content) && /opportunity-brief\.md/.test(line.content), 'the line names what waited and that nothing was approved: ' + line.content);
      A.eq(line.transcriptPending, true, 'the line is the station\'s (re-sent on each read, never stacked by a merge)');
      A.eq(line.sourceRunId, reloadRunId, 'the line belongs to that run');
      const turns = tr.turns || [];
      const userIdx = turns.findIndex(t => t.role === 'user' && /write the brief yourself/.test(t.content || ''));
      A.ok(turns.indexOf(line) > userIdx && userIdx >= 0, 'the line sits after the request it answers');
    }
    const brief = path.join(fixture.workspace, 'agent', 'opportunity-brief.md');
    A.ok(!fs.existsSync(brief), 'the write that was waiting never ran');

    /* ---------------- 3. STOP mid-approval is the Commander's own act: no page-closed line ---------------- */
    let stopRunId = '';
    const stop = startRun(B, H, { key: 'sk-or-v1-local-proof', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'ws_stop', placed: ['cabinet'],   // NOVA's file cabinet: its own fs.write asks
      messages: [{ role: 'user', content: 'write the brief yourself' }] }, async (ev, ctrl) => {
      if (ev.name === 'agent.run.start' && ev.payload && !stopRunId) stopRunId = ev.payload.runId;
      if (ev.name === 'permission.prompt' && ev.payload && ev.payload.tool === 'fs.write') {
        // the page's STOP: the station confirms the cancel first, then the page drops its stream (chat.js stopActive)
        await fetch(B + '/api/cancel', { method: 'POST', headers: H, body: JSON.stringify({ runId: stopRunId }) });
        ctrl.abort();
      }
    });
    await stop.done;
    const stopRec = await until(async () => {
      const j = await (await fetch(B + '/api/runs?agent=agent&runId=' + encodeURIComponent(stopRunId), { headers: H })).json();
      return (j.runs || [])[0];
    }, 8000, 'the stopped run\'s record');
    A.eq(stopRec.reason, 'cancelled', 'STOP cancels the run');
    A.ok(!stopRec.pageClosed, 'a STOP is never recorded as the page closing');
    const trStop = await (await fetch(B + '/api/transcript?agent=agent&stream=ws_stop&limit=50', { headers: H })).json();
    A.ok(!(trStop.turns || []).some(t => t && t.sys && /closed, reloaded or reconnected/.test(t.content || '')), 'a stopped run gets no page-closed line');

    /* ---------------- 4. a background worker STOPPED while its ask waits, and a "session" answer after the lead ended ---------------- */
    let lead2RunId = '';
    const lead2 = startRun(B, H, { key: 'sk-or-v1-local-proof', model: 'test/model', agentId: 'agent', isTask: true, streamId: 'ws_handoff2',
      messages: [{ role: 'user', content: 'hand off in the background' }] }, async (ev) => {
      if (ev.name === 'agent.run.start' && ev.payload && !lead2RunId) lead2RunId = ev.payload.runId;
      if (ev.name === 'permission.prompt' && ev.payload && !ev.payload.workerAgentId) {
        await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: lead2RunId, promptId: ev.payload.promptId, decision: 'once' }) });
      }
    });
    await lead2.done;
    const ask2 = who => bus.events.find(e => e.name === 'permission.prompt' && e.payload && e.payload.workerAgentId === who && e.payload.runId === lead2RunId);
    await until(() => ask2('writer') && ask2('drafter'), 15000, 'both background workers of the second hand-off asking');
    const w2 = ask2('writer').payload, d2 = ask2('drafter').payload;
    // the Commander stops the writer (its row's STOP: POST /api/subagents/interrupt) while its write waits on them
    const recs = await (await fetch(B + '/api/subagents?leadId=agent', { headers: H })).json();
    const wrec = (recs.records || []).find(r => r.runId === w2.workerRunId);
    A.ok(!!wrec, 'the waiting writer has its durable background record');
    const intr = wrec ? await (await fetch(B + '/api/subagents/interrupt', { method: 'POST', headers: H, body: JSON.stringify({ id: wrec.id }) })).json() : {};
    A.eq(intr.ok, true, 'the writer is interrupted');
    const stoppedResp = await until(() => bus.events.find(e => e.name === 'permission.response' && e.payload && e.payload.promptId === w2.promptId), 5000, 'the stopped worker\'s ask settling');
    A.eq(stoppedResp.payload.decision, 'deny', 'a stopped worker\'s ask approves nothing');
    A.eq(stoppedResp.payload.stopped, true, 'and is announced as stopped (its card says the worker stopped)');
    A.ok(!stoppedResp.payload.expired, 'never as "nobody answered in time" — it was stopped, not left unanswered');
    A.ok(stoppedResp.at - w2.askedAt < CONSENT_TIMEOUT_MS - 1000, 'it settled at the stop, not on the consent timeout');
    // a "session" answer (a paired phone offers it) to the drafter's ask after the lead's turn: session grants end with
    // the lead's run (handleRun's finally), and that run is already over — so it approves this one call, and no grant
    // is written under the ended run (it would outlive every run that could ever clear it)
    // an answer addressed to a run that does not hold this ask applies nothing, and is never told "gone" while the ask
    // still waits (the page would drop a live ask's keys on that word)
    const astray = await (await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: 'not-the-slot', promptId: d2.promptId, decision: 'once' }) })).json();
    A.eq([astray.ok, !!astray.gone], [false, false], 'a misaddressed answer is refused, and the still-waiting ask is not reported gone');
    A.ok(!bus.events.some(e => e.name === 'permission.response' && e.payload && e.payload.promptId === d2.promptId), 'the misaddressed answer settled nothing');
    // "for this session" is a standing answer within the session, so the page key alone is handed a desk challenge (fix-sec2
    // review 3) and the ask keeps waiting; the Commander confirms it with the code this bare station printed on its console
    // (the page's replay, test/helpers/desk-code.js), and only then does it apply
    const sessBody = JSON.stringify({ runId: lead2RunId, promptId: d2.promptId, decision: 'session' });
    const sessAsked = await fetch(B + '/api/consent', { method: 'POST', headers: H, body: sessBody });
    const sessAskedBody = await sessAsked.json().catch(() => ({}));
    A.eq([sessAsked.status, sessAskedBody.code], [403, 'desk_confirm_required'], 'a "session" answer with the page key alone asks at the desk first');
    A.ok(!bus.events.some(e => e.name === 'permission.response' && e.payload && e.payload.promptId === d2.promptId), '...and settles nothing until it is confirmed');
    const sess = await fetchJsonAtDesk(fixture.desk, B + '/api/consent', { method: 'POST', headers: H, body: sessBody });
    A.eq(sess.ok, true, 'a "session" answer to a background ask after its lead ended is accepted once confirmed at the desk');
    const drafterFile = path.join(fixture.workspace, 'drafter', 'pricing-page.md');
    await until(() => fs.existsSync(drafterFile), 8000, 'the approved pricing page landing');
    A.ok(fs.existsSync(drafterFile), 'the approved background write ran');
    const settledAs = bus.events.find(e => e.name === 'permission.response' && e.payload && e.payload.promptId === d2.promptId);
    A.eq(settledAs && settledAs.payload.decision, 'once', 'every surface is told what was applied: approved once');
    const again = await until(() => bus.events.find(e => e.name === 'permission.prompt' && e.payload && e.payload.workerAgentId === 'drafter' && e.payload.runId === lead2RunId && e.payload.promptId !== d2.promptId), 8000, 'the drafter\'s second write asking');
    A.ok(/pricing-faq\.md/.test(again.payload.argsSummary || ''), 'the same worker\'s next write of that kind asks again (no grant was left under the ended run)');
    await fetch(B + '/api/consent', { method: 'POST', headers: H, body: JSON.stringify({ runId: lead2RunId, promptId: again.payload.promptId, decision: 'deny' }) });
    await until(() => bus.events.some(e => e.name === 'permission.response' && e.payload && e.payload.promptId === again.payload.promptId), 5000, 'the second ask settling');
    A.ok(!fs.existsSync(path.join(fixture.workspace, 'drafter', 'pricing-faq.md')), 'the denied second write never ran');
  } catch (e) {
    e.message += '\nsidecar output (tail):\n' + fixture.output().slice(-4000);
    throw e;
  } finally {
    if (bus) bus.close();
    await fixture.dispose();
    if (mock.server.closeAllConnections) mock.server.closeAllConnections();
    await new Promise(r => mock.server.close(r));
  }
  A.report('e2e.approval-lifecycle.test');
})().catch(e => { console.log('FAIL: e2e.approval-lifecycle.test threw - ' + (e && e.stack || e)); process.exit(1); });
