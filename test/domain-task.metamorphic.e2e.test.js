/* node test/domain-task.metamorphic.e2e.test.js — PROSE IS ADVICE; ONLY A LEAD'S onlyHost SCOPES A RUN
   (domain-task-advisory; starnet-releases#5, gh#58, the 10-14 delegated-web-tools report).

   The run host classified the latest user message of every task run with DomainTask.classify and, when it read as one
   exact host, took team.* and web_search off the wire, refused delegation and stopped every tool on NXDOMAIN — for a
   lead, a dispatched worker and a routine alike. A security review, a QA pass or an automation check that named one
   site came back without its tools (rel#5), and a routine that named one shop lost web_search (gh#58's residual). Prose
   is advice now; the one thing that scopes a run is its lead's explicit onlyHost (team.dispatch / team.spawn).

   The real sidecar (test/helpers/sidecar-fixture.js) with the mock OpenRouter below as the only fake. Roster: the lead
   'agent' and its crew 'worker' (system WORKER_MARK), both Full Access, so the posture is the same for every brief.

   INV-3. For each report brief, the sorted wire tool names equal the control brief's on four surfaces: the lead run
   (the brief is its message), the worker that lead hands the brief to, a dispatched worker (a neutral lead message, the
   brief in the worker's prompt) and a routine (POST /api/cron + /api/cron/run; the request carrying routine_notepad).
   The lead's team_dispatch is never refused, and the dispatched worker completes all four scripted fs_list calls. The
   lead FOLLOWS ITS ADVICE (review round 1): its hand-off carries every parameter the run's one-host advice names, so
   advice that told it to scope or bound its worker would bring rel#5 back by the lead's own hand. The worker it hands
   the brief to keeps web_search, its fetch of another host runs, and its row names no scope and no bound.

   INV-4. Prose never stops a run's tools; only a lead-set scope does, and it says why. A lead asked to "Check
   starnessos.invalid and read its docs" fetches it, the fetch fails ENOTFOUND (web.js answers .invalid locally), and its
   next request keeps the same tools with the advice on the failed result. A worker dispatched with onlyHost lacks
   web_search, has a fetch to another host refused before any network, and after its own ENOTFOUND gets a request with
   zero tools; its row carries onlyHost. An onlyHost that is not a host starts no worker. A bounded:true worker runs at
   most 3 tool calls, and its summary and row read 'bounded read (requested by lead)'. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const LABEL = 'bounded read (requested by lead)';
const CONTROL = 'Summarize what we know about the release plan.';
// the report briefs test/domain-task.metamorphic.test.js holds the dispatcher to (provenance there)
const REPORT = [
  ['rel#5 engineering', 'Review the deployment script for starnet-demo.io, write a unit test for it, and run it.'],
  ['rel#5 security', 'Review the security headers and TLS setup on starnet-demo.io and list the risks.'],
  ['rel#5 qa', 'Check starnet-demo.io and read the release checklist in its docs.'],
  ['rel#5 automation', 'Inspect the CI status page on ci.starnet-demo.io and summarize what failed.'],
  ['rel#5 markdown', 'Review deploy-notes.md and confirm the release steps.'],
  ['gh#58 api', 'POST to https://api.x.com/v1/items with ${MY_KEY}, then check the response'],
  ['gh#58 residual', 'check my orders on printify.com and summarize them'],
  ['gh#58 routine', 'Check status.example.com every morning and read the latest incident.'],
  ['10-14 itch', 'Review the itch.io site for our game page and check the latest reviews.']
];
const NEUTRAL = 'Hand the next task to the specialist and report back.';
const WORKER_BRIEF = 'Read the product docs and summarize them.';   // names no host: a worker's scope can only be its lead's
const ADVICE_BRIEF = 'Check starnessos.invalid and read its docs.';
const SCOPED = 'starnessos.invalid';
const OTHER_URL = 'https://starnessos-mirror.invalid/docs';         // another host (.invalid never reaches the network)
const FS_CALLS = 4;

let script = {};    // what the mock model does in the run in flight
const seen = [];    // every chat request the sidecar sent
const sleep = ms => new Promise(res => setTimeout(res, ms));
const textOf = m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content));
const fetchCall = url => ({ name: 'web_fetch', arguments: JSON.stringify({ url }) });
const dispatchCall = worker => ({ name: 'team_dispatch', arguments: JSON.stringify({ workers: [Object.assign({ agentId: 'worker' }, worker)] }) });
const fsWorker = s => (s.tools.length < FS_CALLS && s.names.indexOf('fs_list') >= 0 ? { name: 'fs_list', arguments: JSON.stringify({ path: '.' }) } : null);
// the scoped worker: a fetch to another host, then its own host, then its report
const scopedWorker = s => (s.tools.length === 0 ? fetchCall(OTHER_URL) : s.tools.length === 1 ? fetchCall('https://' + SCOPED + '/docs') : null);
// the worker a lead hands its brief to: a fetch to another host, then its report
const handedWorker = s => (s.tools.length === 0 ? fetchCall(OTHER_URL) : null);
// a lead that follows its advice: every hand-off parameter the run's one-host advice names goes on its dispatch
const advisedHandOff = s => {
  const advice = (/\[DIRECT DOMAIN CHECK[^\]]*ADVICE\][^"\\]*/.exec(s.all) || [''])[0];
  const host = /\bonlyHost\s+([a-z0-9][a-z0-9.-]*[a-z0-9])/i.exec(advice);
  return Object.assign(host ? { onlyHost: host[1] } : {}, /\bbounded\s*:\s*true\b/.test(advice) ? { bounded: true } : {});
};

const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
    if (req.method !== 'POST') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) { b = {}; }
    const msgs = Array.isArray(b.messages) ? b.messages : [];
    const lastUser = msgs.slice().reverse().find(m => m && m.role === 'user');
    const s = {
      mode: script.mode,
      who: /WORKER_MARK/.test(msgs.filter(m => m && m.role === 'system').map(textOf).join('\n')) ? 'worker' : 'lead',
      all: JSON.stringify(msgs),   // the per-run blocks (the direct-domain one included) ride the <run_context> note
      lastUser: lastUser ? textOf(lastUser) : '',
      names: (b.tools || []).map(t => t && t.function && t.function.name).filter(Boolean).sort(),
      tools: msgs.filter(m => m && m.role === 'tool').map(m => ({ id: String(m.tool_call_id || ''), content: textOf(m) }))
    };
    seen.push(s);
    let call = null;
    // the lead's own first turn on the message this run was started with
    if (s.who === 'lead' && script.lead && !s.tools.length && s.names.length && s.lastUser.indexOf(script.message) >= 0) call = typeof script.lead === 'function' ? script.lead(s) : script.lead;
    else if (s.who === 'worker' && typeof script.worker === 'function') call = script.worker(s);
    const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + seen.length, type: 'function', function: call }] } : { content: s.who === 'worker' ? 'worker done' : 'lead done' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }) + '\n\ndata: [DONE]\n\n');
  });
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 30000, env: { SKYNET_AUX_BUDGET: '0', SKYNET_OPENROUTER_BASE: base, OPENROUTER_API_KEY: 'synthetic-key', SKYNET_FULL_ACCESS: '0', STARNET_FULL_ACCESS: '0' } });
  // one /api/run for the lead, read to its end (a permission card, should one open, is answered once)
  async function runLead(message) {
    const response = await fetch(fixture.baseUrl + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': fixture.token },
      body: JSON.stringify({ agentId: 'agent', provider: 'openrouter', key: 'synthetic-key', model: 'test/model', isTask: true, messages: [{ role: 'user', content: message }] }) });
    if (response.status !== 200) throw new Error('run ' + response.status + ' ' + await response.text());
    const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
    let pending = '', runId = '';
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trim(); pending = pending.slice(nl + 1); if (!line) continue;
        let ev = null; try { ev = JSON.parse(line); } catch (_) { continue; }
        events.push(ev);
        if (ev.name === 'agent.run.start' && !runId) runId = ev.payload.runId;
        if (ev.name === 'permission.prompt') await fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'once' });
      }
    }
    return events;
  }
  // the lead's own result for its one call of `wire` (its summary is what the COMMS chip shows)
  const resultOf = (events, wire) => {
    const call = events.find(e => e.name === 'agent.tool_call' && e.payload && (e.payload.name === wire || e.payload.name === wire.replace('_', '.')));
    const res = call && events.find(e => e.name === 'agent.tool_result' && e.payload && e.payload.callId === call.payload.callId);
    return res ? res.payload : null;
  };
  // the dispatch rows as the lead's next request carries them
  const rowsIn = (from, mode) => {
    const next = seen.slice(from).find(s => s.mode === mode && s.who === 'lead' && s.tools.length);
    const text = next ? next.tools[0].content : '';
    try { return JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); } catch (_) { return []; }
  };
  let routineN = 0;
  async function runRoutine(brief) {
    script = { mode: 'routine', message: brief };
    const mk = await fixture.json('POST', '/api/cron', { name: 'metamorphic ' + (++routineN), prompt: brief, schedule: 'every 1h', agentId: 'agent', model: 'test/model', provider: 'openrouter' });
    if (mk.status !== 200) throw new Error('cron create ' + mk.status + ' ' + mk.text);
    const id = (mk.body && ((mk.body.job && mk.body.job.id) || mk.body.id)) || '';
    const from = seen.length;
    const fired = await fixture.json('POST', '/api/cron/run', { id });
    if (fired.status !== 200) throw new Error('cron run ' + fired.status + ' ' + fired.text);
    // the routine's own request is the one carrying routine_notepad (a separate skill pre-turn can come first)
    let main = null;
    for (const until = Date.now() + 15000; Date.now() < until;) {
      main = seen.slice(from).find(s => s.who === 'lead' && s.names.indexOf('routine_notepad') >= 0 && s.lastUser.indexOf(brief) >= 0) || null;
      const list = await fixture.json('GET', '/api/cron');
      const row = ((list.body && list.body.jobs) || []).find(j => j && j.id === id);
      if (main && row && !row.inFlightRunId) break;
      await sleep(100);
    }
    await fixture.json('POST', '/api/cron/remove', { id });
    return main;
  }
  // the four surfaces a prose brief reaches
  const callsOf = ws => (ws.length ? Math.max.apply(null, ws.map(w => w.tools.length)) : 0);
  async function surfaces(brief) {
    // the lead run on the brief hands it to its worker, following the run's advice to the letter
    script = { mode: 'lead', message: brief, lead: s => dispatchCall(Object.assign({ prompt: brief }, advisedHandOff(s))), worker: handedWorker };
    let from = seen.length;
    const leadEvents = await runLead(brief);
    const lead = seen.slice(from).find(s => s.mode === 'lead' && s.who === 'lead' && s.names.length && !s.tools.length && s.lastUser.indexOf(brief) >= 0);
    const dispatched = resultOf(leadEvents, 'team_dispatch');
    const handed = seen.slice(from).filter(s => s.mode === 'lead' && s.who === 'worker');
    const handedRow = rowsIn(from, 'lead')[0] || {};
    script = { mode: 'dispatch', message: NEUTRAL, lead: dispatchCall({ prompt: brief }), worker: fsWorker };
    from = seen.length;
    await runLead(NEUTRAL);
    const workers = seen.slice(from).filter(s => s.mode === 'dispatch' && s.who === 'worker');
    const routine = await runRoutine(brief);
    return {
      lead: lead ? lead.names : null,
      advised: !!lead && lead.all.indexOf('ADVICE]') >= 0,
      dispatch: dispatched ? (dispatched.isError ? 'REFUSED ' : '') + String(dispatched.summary || '') : 'NO RESULT',
      handed: handed.length ? handed[0].names : null,
      handedFetch: String(((handed[1] && handed[1].tools[0]) || {}).content || ''),
      handedRow: { onlyHost: handedRow.onlyHost, bound: handedRow.bound },
      worker: workers.length ? workers[0].names : null,
      workerCalls: callsOf(workers),
      routine: routine ? routine.names : null
    };
  }
  const diff = (got, want) => ({ missing: (want || []).filter(n => (got || []).indexOf(n) < 0), extra: (got || []).filter(n => (want || []).indexOf(n) < 0) });
  const startedAt = Date.now();
  try {
    await fixture.start();
    const roster = await fixture.json('POST', '/api/roster', { agents: [
      { agentId: 'agent', name: 'LEAD', model: 'test/model', provider: 'openrouter', approvalMode: 'full' },
      { agentId: 'worker', name: 'SPECIALIST', system: 'WORKER_MARK', model: 'test/model', provider: 'openrouter', approvalMode: 'full' }
    ] });
    if (roster.status !== 200) throw new Error('roster ' + roster.text);

    // ---- INV-3: a brief's prose never grants or withholds a tool, on any surface that runs it ----
    const control = await surfaces(CONTROL);
    A.ok(!!control.lead && control.lead.indexOf('team_dispatch') >= 0 && control.lead.indexOf('web_search') >= 0,
      'INV-3 control: the lead with crew is offered delegation and web search (' + (control.lead || []).length + ' tools)');
    A.ok(/^dispatched 1 worker\(s\), 1 done/.test(control.dispatch), 'INV-3 control: the lead\'s dispatch runs its worker: ' + control.dispatch);
    A.ok(!!control.handed && control.handed.indexOf('web_search') >= 0 && /ENOTFOUND|does not resolve/i.test(control.handedFetch),
      'INV-3 control: the worker the lead hands its brief to is offered web search, and its fetch of another host runs');
    A.ok(!!control.worker && control.worker.indexOf('web_search') >= 0 && control.worker.indexOf('fs_list') >= 0, 'INV-3 control: the worker is offered web search and its files');
    A.eq(control.workerCalls, FS_CALLS, 'INV-3 control: the worker makes all ' + FS_CALLS + ' scripted fs_list calls');
    A.ok(!!control.routine && control.routine.indexOf('web_search') >= 0, 'INV-3 control: the routine is offered web search');
    const violations = [];
    let advised = 0;
    for (const [id, brief] of REPORT) {
      const got = await surfaces(brief);
      if (got.advised) advised++;
      for (const k of ['lead', 'handed', 'worker', 'routine']) {
        const d = diff(got[k], control[k]);
        if (got[k] == null || d.missing.length || d.extra.length) violations.push(id + ' ' + k + ': ' + (got[k] == null ? 'NO REQUEST SEEN' : JSON.stringify(d)));
      }
      if (!/^dispatched 1 worker\(s\), 1 done/.test(got.dispatch)) violations.push(id + ' lead team_dispatch: ' + got.dispatch);
      if (got.handed && !/ENOTFOUND|does not resolve/i.test(got.handedFetch)) violations.push(id + ' handed: its fetch of another host was refused: ' + JSON.stringify(got.handedFetch.slice(0, 120)));
      if (got.handedRow.onlyHost || got.handedRow.bound) violations.push(id + ' handed: the lead scoped or bounded it on the advice: ' + JSON.stringify(got.handedRow));
      if (got.workerCalls !== FS_CALLS) violations.push(id + ' worker: ' + got.workerCalls + ' of ' + FS_CALLS + ' fs_list calls ran');
    }
    if (violations.length) console.log('PROSE-GATED (' + violations.length + '):\n  ' + violations.join('\n  '));
    A.ok(advised >= 4, 'INV-3: the one-host advice reaches the lead on the rel#5 one-site briefs, so its hand-off follows real advice (' + advised + ' of ' + REPORT.length + ' advised)');
    A.eq(violations.length, 0, 'INV-3: no report brief\'s prose moves the wire tool set of the lead, the worker it hands the brief to, a dispatched '
      + 'worker or a routine, refuses the lead\'s dispatch, or cuts a worker short (' + REPORT.length + ' briefs x 4 surfaces)');

    // ---- INV-4 (advice): a prose one-host check whose host does not resolve keeps its tools and is told why ----
    {
      script = { mode: 'advice', message: ADVICE_BRIEF, lead: fetchCall('https://' + SCOPED + '/docs') };
      const from = seen.length;
      await runLead(ADVICE_BRIEF);
      // (a host stop note, where one is sent, becomes the last user-side turn: the next request is found by its tool result)
      const reqs = seen.slice(from).filter(s => s.mode === 'advice' && s.who === 'lead');
      const first = reqs.find(s => !s.tools.length && s.names.length && s.lastUser.indexOf(ADVICE_BRIEF) >= 0), next = reqs.find(s => s.tools.length);
      const failed = next ? next.tools[0].content : '';
      A.ok(/ENOTFOUND|does not resolve/i.test(failed), 'INV-4 advice: the exact-host fetch failed as a missing domain: ' + JSON.stringify(failed.slice(0, 160)));
      A.ok(!!first && first.all.indexOf('[DIRECT DOMAIN CHECK') >= 0 && first.all.indexOf('ADVICE]') >= 0, 'INV-4 advice: the run carries the direct-domain block, as advice');
      A.eq(diff(first && first.names, control.lead), { missing: [], extra: [] }, 'INV-4 advice: the prose names one host, and the lead keeps the control\'s tools');
      A.ok(!!next && next.names.length > 0, 'INV-4 advice: the request after the failed fetch still offers tools (saw ' + (next ? next.names.length : 'no request') + ')');
      A.eq(next && next.names, first && first.names, 'INV-4 advice: the request after the failed fetch keeps the same tools (prose never stops a run)');
      A.ok(failed.indexOf('<terminal_domain_advice>') >= 0 && failed.indexOf(SCOPED) >= 0, 'INV-4 advice: the failed result carries the advice, naming the host');
    }

    // ---- INV-4 (scope): onlyHost is the lead's call, enforced on the worker it scoped ----
    {
      script = { mode: 'scoped', message: NEUTRAL, lead: dispatchCall({ prompt: WORKER_BRIEF, onlyHost: SCOPED }), worker: scopedWorker };
      const from = seen.length;
      const events = await runLead(NEUTRAL);
      const w = seen.slice(from).filter(s => s.mode === 'scoped' && s.who === 'worker');
      A.eq(diff(w[0] && w[0].names, control.worker), { missing: ['web_search'], extra: [] }, 'INV-4 scope: the scoped worker lacks web_search against the control worker, and nothing else');
      A.ok(!!w[0] && w[0].all.indexOf('[DIRECT DOMAIN CHECK') >= 0 && w[0].all.indexOf('HOST SCOPE SET BY YOUR LEAD]') >= 0, 'INV-4 scope: the worker is told its lead set the scope');
      // the wire marks a failed result 'ERROR: '; the text after it is the run host's direct-domain-target-only refusal
      A.eq(w[1] && w[1].tools[0] && w[1].tools[0].content.replace(/^ERROR: /, ''), 'Your lead scoped this run to the exact host ' + SCOPED
        + ' with onlyHost: fetch only that host. Do not try spelling variants or alternate domains; report what is left so your lead can re-dispatch it without onlyHost.',
        'INV-4 scope: a fetch to another host is refused before any network (direct-domain-target-only), naming the lead and the way out');
      A.ok(!!w[2] && /ENOTFOUND|does not resolve/i.test((w[2].tools[1] || {}).content || ''), 'INV-4 scope: the fetch of its own host fails as a missing domain');
      A.ok(!!w[2] && w[2].names.length === 0, 'INV-4 scope: after its own host proves missing, the worker\'s next request has zero tools (saw ' + (w[2] ? w[2].names.length : 'no request') + ')');
      A.eq(w.length, 3, 'INV-4 scope: one synthesis turn after the terminal evidence, then the worker ends');
      const row = rowsIn(from, 'scoped')[0] || {};
      A.eq(row.onlyHost, SCOPED, 'INV-4 scope: the worker\'s row carries the scope its lead set');
      A.ok(/^dispatched 1 worker\(s\)/.test(String((resultOf(events, 'team_dispatch') || {}).summary || '')), 'INV-4 scope: the scoped dispatch itself is not refused');
    }
    {
      script = { mode: 'badscope', message: NEUTRAL, lead: dispatchCall({ prompt: WORKER_BRIEF, onlyHost: 'not a host' }), worker: fsWorker };
      const from = seen.length;
      await runLead(NEUTRAL);
      A.eq(seen.slice(from).filter(s => s.mode === 'badscope' && s.who === 'worker').length, 0, 'INV-4 scope: an onlyHost that is not a host starts no worker');
      const row = rowsIn(from, 'badscope')[0] || {};
      A.ok(row.reason === 'error' && /onlyHost must be a host name/.test(String(row.result)), 'INV-4 scope: its row says why and what to do: ' + JSON.stringify(row));
    }

    // ---- INV-4 (bound): bounded:true through the real sidecar ----
    {
      script = { mode: 'bounded', message: NEUTRAL, lead: dispatchCall({ prompt: WORKER_BRIEF, bounded: true }), worker: fsWorker };
      const from = seen.length;
      const events = await runLead(NEUTRAL);
      const w = seen.slice(from).filter(s => s.mode === 'bounded' && s.who === 'worker');
      const ran = w.length ? Math.max.apply(null, w.map(s => s.tools.filter(t => t.content.indexOf(LABEL) < 0).length)) : -1;
      A.ok(w.length > 0 && ran >= 1 && ran <= 3, 'INV-4 bound: a bounded:true worker runs at most 3 tool calls (ran ' + ran + ')');
      const summary = String((resultOf(events, 'team_dispatch') || {}).summary || '');
      A.ok(summary.indexOf(LABEL) >= 0, 'INV-4 bound: the dispatch summary the COMMS chip shows names the bound: ' + JSON.stringify(summary));
      A.eq((rowsIn(from, 'bounded')[0] || {}).bound, LABEL, 'INV-4 bound: the worker\'s row names the bound and who asked for it');
    }
  } finally {
    await fixture.dispose();
    await new Promise(r => server.close(r));
  }
  console.log('domain-task.metamorphic.e2e: ' + seen.length + ' provider requests in ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
  A.report('domain-task.metamorphic.e2e.test');
})().catch(e => { console.error(e); process.exit(1); });
