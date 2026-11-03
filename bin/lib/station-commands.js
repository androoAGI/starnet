/* bin/lib/station-commands.js — the plain, scriptable `starnet` commands: ls · approve · deny · watch · flow.

   Same station truth as the dashboard (station-model.js), printed as plain lines for pipes, scripts and CI: no
   escape codes, stable columns, and --json where a script wants objects. The formatters are pure and exported for
   test/cli-dashboard.test.js; the command functions own their few HTTP calls. */
'use strict';

const http = require('node:http');
const core = require('./cli-core.js');
const { makeStation, sourceOf, fmtDur, costText, toolName, oneLine, argDigest, askGlance } = require('./station-model.js');
const { clean, trunc } = require('./tui.js');
const RunOutcome = require('../../frontend/app/runoutcome.js');   // TYPED OUTCOMES: a run's end prints its outcome-aware reason

function pad(s, n) { const t = trunc(clean(s), n); return t + ' '.repeat(Math.max(0, n - [...t].length)); }

// ---- ls ----------------------------------------------------------------------------------------------------
async function loadStation(client) {
  const model = makeStation();
  const [rt, snap, budget] = await Promise.all([
    client.request('GET', '/api/runtime/agent'), client.request('GET', '/api/state/snapshot'), client.request('GET', '/api/budget/status')
  ]);
  if (!(rt.ok && rt.status === 200 && rt.json)) { const e = new Error('could not read the station roster (' + (rt.error || 'HTTP ' + rt.status) + ')'); e.exitCode = core.EXIT.STATION; throw e; }
  model.setRoster(rt.json);
  const now = Date.now();
  if (snap.ok && snap.status === 200 && snap.json) model.applySnapshot(snap.json, now);
  if (budget.ok && budget.status === 200 && budget.json) model.applyBudget(budget.json);
  await fillAskSummaries(client, model);
  return { model, now, snapshot: (snap.ok && snap.json) || null };
}

/* The snapshot lists a desk ask without its words (only a background ask carries them): read each one's request, so
   `ls` and `approve` name what is being allowed, never just the tool. */
async function fillAskSummaries(client, model) {
  await Promise.all(model.state.prompts.filter(q => !q.summary && !q.question && q.runId).map(async q => {
    const r = await client.request('GET', '/api/consent/args?runId=' + encodeURIComponent(q.runId) + '&promptId=' + encodeURIComponent(q.promptId), null, { timeoutMs: 5000 });
    if (r.ok && r.status === 200 && r.json && r.json.args) model.describePrompt(q.promptId, r.json.args);
  }));
}

// one row per agent: what the snapshot proves (a live run and where it came from, an open ask), never a guess
function lsRows(model, now) {
  return model.state.order.map(id => {
    const a = model.state.agents.get(id);
    const asks = model.state.prompts.filter(q => q.agentId === id);
    const runs = [...a.runs].map(r => model.state.runs.get(r)).filter(Boolean);
    let status = 'idle', nowText = '-';
    if (asks.length) { status = 'needs-you'; nowText = asks[0].question ? 'asks: ' + asks[0].question.text : 'asks: ' + asks[0].tool + (asks[0].summary ? ' ' + asks[0].summary : ''); }
    else if (runs.length) { status = 'working'; const r = runs[0]; nowText = sourceOf(r) + ' run · ' + fmtDur(now - r.startedAt) + (runs.length > 1 ? ' · ' + runs.length + ' runs' : ''); }
    return { agentId: id, name: a.name, model: a.model, provider: a.provider, status, now: nowText, runs: runs.map(r => ({ runId: r.runId, source: sourceOf(r), startedAt: r.startedAt })), asks: asks.map(q => ({ promptId: q.promptId, runId: q.runId, tool: q.tool, summary: q.summary, question: q.question ? q.question.text : undefined })) };
  });
}
function formatLs(rows, cost, width) {
  const w = Math.max(60, width || 100);
  const lines = [pad('AGENT', 12) + ' ' + pad('MODEL', 22) + ' ' + pad('STATUS', 10) + ' NOW'];
  for (const r of rows) lines.push(pad(r.name, 12) + ' ' + pad(r.model || '-', 22) + ' ' + pad(r.status, 10) + ' ' + trunc(clean(r.now), w - 47));
  lines.push('');
  lines.push(rows.filter(r => r.status === 'working').length + ' working · ' + rows.filter(r => r.status === 'needs-you').length + ' need you · ' + costText(cost));
  return lines.join('\n');
}
async function lsCommand(opts, station, io) {
  const { model, now } = await loadStation(station.client);
  const rows = lsRows(model, now);
  if (opts.json) io.out(JSON.stringify({ agents: rows, spend: model.state.cost }) + '\n');
  else io.out(formatLs(rows, model.state.cost, io.columns) + '\n');
  return core.EXIT.OK;
}

// ---- approve / deny -----------------------------------------------------------------------------------------
async function answerCommand(opts, station, io) {
  const { model } = await loadStation(station.client);
  let want = null;
  if (opts.args[0]) {
    want = model.findAgent(opts.args[0]);
    if (!want) { io.err('starnet: no agent named ' + JSON.stringify(opts.args[0]) + ' — roster: ' + model.state.order.join(', ') + '\n'); return core.EXIT.STATION; }
  }
  const open = model.state.prompts.filter(q => !q.question && (!want || q.agentId === want.id));
  if (!open.length) {
    const questions = model.state.prompts.filter(q => q.question && (!want || q.agentId === want.id)).length;
    io.err('nothing is waiting for an answer' + (want ? ' from ' + want.name : '') + (questions ? ' (' + questions + ' question(s) wait in the dashboard or the app)' : '') + '\n');
    return core.EXIT.NOTHING;
  }
  const q = open[0];
  const decision = opts.cmd === 'deny' ? 'deny' : opts.session ? 'session' : 'once';
  const r = await station.client.request('POST', '/api/consent', { runId: q.runId, promptId: q.promptId, decision, via: 'terminal' });
  const name = (model.state.agents.get(q.agentId) || { name: q.agentId }).name;
  const what = q.tool + (q.summary ? ' ' + oneLine(clean(q.summary), 100) : '');
  if (r.ok && r.json && r.json.ok) {
    const applied = r.json.decision || decision;
    io.out((applied === 'deny' ? 'denied · ' : applied === 'session' ? 'allowed for this session · ' : 'allowed once · ') + name.toLowerCase() + ' · ' + what + '\n');
    return core.EXIT.OK;
  }
  if (r.ok && r.json && r.json.gone) { io.err('that ask is no longer waiting (answered elsewhere, expired, or its run ended)\n'); return core.EXIT.NOTHING; }
  io.err('starnet: the station did not take the answer (' + (r.error || 'HTTP ' + r.status) + ')\n');
  return core.EXIT.RUN_FAILED;
}

// ---- watch --------------------------------------------------------------------------------------------------
/* One line per meaningful event. Streamed text is buffered per run and printed a line at a time, so a reply reads
   as sentences, not a token per line. Returns the lines to print for this event (possibly none). */
function makeWatchFormatter(names) {
  const text = new Map();   // runId -> pending partial line
  const nameOf = id => (names && names[id]) || String(id || '?');
  const stamp = ts => { const d = new Date(ts); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };
  return function format(ev, ts) {
    const p = (ev && ev.payload) || {};
    const who = pad(nameOf(p.workerAgentId || p.agentId), 10);
    const head = stamp(ts) + '  ' + who + '  ';
    const out = [];
    const flush = (runId) => { const t = text.get(runId); if (t && t.trim()) out.push(head + clean(t).trim()); text.delete(runId); };
    switch (ev.name) {
      case 'agent.run.start': out.push(head + '▸ started (' + sourceOf(p) + ')' + (p.prompt ? ' "' + trunc(clean(p.prompt), 120) + '"' : '')); break;
      case 'agent.token': {
        const t = (text.get(p.runId) || '') + String(p.delta || '');
        const parts = t.split('\n');
        for (const line of parts.slice(0, -1)) if (line.trim()) out.push(head + clean(line).trim());
        text.set(p.runId, parts[parts.length - 1]);
        break;
      }
      case 'agent.tool_call': { flush(p.runId); const said = argDigest(clean(p.argsSummary), toolName(p.name)); out.push(head + '↳ ' + toolName(p.name) + (said ? ' ' + oneLine(said, 160) : '')); break; }
      case 'agent.tool_result': out.push(head + '  ' + (p.ok && !p.isError ? 'ok' : 'FAIL') + ' ' + (Number(p.ms) || 0) + 'ms' + (p.summary ? ' · ' + trunc(clean(p.summary).replace(/\s+/g, ' '), 140) : '')); break;
      case 'permission.prompt': {
        let what = toolName(p.tool) + (p.argsSummary ? ' ' + oneLine(clean(askGlance(toolName(p.tool), p.argsSummary)), 140) : '');
        if (p.tool === 'brief.ask') { try { what = 'question: ' + JSON.parse(p.argsSummary).question; } catch (_) {} }
        out.push(head + '▲ needs you · ' + what + (p.tool === 'brief.ask' ? '' : '   (starnet approve ' + nameOf(p.workerAgentId || p.agentId).toLowerCase() + ')'));
        break;
      }
      case 'permission.response': out.push(head + (p.decision === 'deny' ? '✗ denied' : '✓ allowed ' + p.decision) + (p.via ? ' (' + p.via + ')' : '') + (p.expired ? ' (no answer in time)' : '')); break;
      case 'agent.run.error': out.push(head + '! ' + clean(p.message)); break;
      // the end's OUTCOME-aware reason (typed-outcomes): 'done' only for a run that SUCCEEDED — a cut reply prints cut_short, a 'done' its own error outranked prints error
      // review r8: an end that did not succeed also says its outcome in words, its failureCode included (RunOutcome.line, the `starnet -p`
      // receipt's "■ error · failed (rate_limit)") — it printed the bare word alone ("■ error", "■ budget")
      case 'agent.run.end': { flush(p.runId); const oc = RunOutcome.ofEnd(p, null); out.push(head + '■ ' + RunOutcome.reasonOf(p) + (oc.ok ? '' : ' · ' + RunOutcome.line(oc)) + (p.usd ? ' · $' + Number(p.usd).toFixed(4) : '')); break; }
      default: break;
    }
    return out;
  };
}
function watchCommand(opts, station, io) {
  const client = station.client;
  return new Promise(async (resolve) => {
    const rt = await client.request('GET', '/api/runtime/agent');
    const names = {};
    for (const a of ((rt.ok && rt.json && rt.json.agents) || [])) names[a.agentId] = String(a.name || a.agentId).toUpperCase();
    const fmt = makeWatchFormatter(names);
    let cursor = '', stopped = false, req = null, seenReady = false;
    const finish = (code) => { if (stopped) return; stopped = true; try { if (req) req.destroy(); } catch (_) {} process.removeListener('SIGINT', onSig); resolve(code); };
    const onSig = () => finish(core.EXIT.OK);
    process.on('SIGINT', onSig);
    let failures = 0;
    const connect = () => {
      if (stopped) return;
      const headers = { Accept: 'text/event-stream', Origin: client.base, 'x-starnet-token': client.token() };
      if (cursor) headers['Last-Event-ID'] = cursor;
      req = http.request({ host: client.host, port: client.port, method: 'GET', path: '/api/observe', headers }, res => {
        if (res.statusCode === 404) { io.err('starnet: this station has no live feed (it predates GET /api/observe) — update the app\n'); res.resume(); return finish(core.EXIT.STATION); }
        if (res.statusCode !== 200) { res.resume(); return retry(); }
        failures = 0;
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', chunk => {
          const r = core.splitSse(buf + chunk);
          buf = r.rest;
          for (const ev of r.events) {
            if (ev.id) cursor = ev.id;
            let j = null; try { j = JSON.parse(ev.data); } catch (_) { continue; }
            // a reset on a RE-connect means events were missed; the first connect has nothing to miss
            if (!j || !j.name) {
              if (j && j.stream === 'ready') {
                if (j.reset && seenReady && opts.json) io.out(JSON.stringify({ name: 'feed.reset', ts: Date.now() }) + '\n');
                // said once, on stderr (stdout stays the events): until now a quiet station looked the same as no connection
                if (!seenReady) io.err('· watching ' + client.base + ' live · ctrl+c stops\n');
                seenReady = true;
              }
              continue;
            }
            if (opts.json) io.out(JSON.stringify({ name: j.name, ts: Date.now(), payload: j.payload }) + '\n');
            else for (const line of fmt(j, Date.now())) io.out(line + '\n');
          }
        });
        const lost = () => { if (!stopped) retry(); };
        res.on('end', lost); res.on('error', lost);
      });
      req.on('error', () => { if (!stopped) retry(); });
      req.end();
    };
    const retry = () => {
      if (stopped) return;
      if (++failures > 15) { io.err('starnet: lost the station\n'); return finish(core.EXIT.STATION); }
      if (failures === 1 && !opts.json) io.err('· feed dropped, reconnecting…\n');
      setTimeout(connect, 2000);
    };
    connect();
  });
}

// ---- flow -----------------------------------------------------------------------------------------------------
async function flowCommand(opts, station, io) {
  const client = station.client;
  const [s, j] = await Promise.all([client.request('GET', '/api/routing/lines/stats'), client.request('GET', '/api/line-jobs?limit=40')]);
  if (!(s.ok && s.status === 200)) { io.err('starnet: could not read the workflows (' + (s.error || 'HTTP ' + s.status) + ')\n'); return core.EXIT.STATION; }
  const model = makeStation();
  model.applyLines(s.json || {}, (j.ok && j.json && j.json.jobs) || []);
  const now = Date.now();
  if (opts.args[0] === 'run') {
    const line = model.findLine(opts.args[1]);
    if (!line) { io.err('starnet: no workflow named ' + JSON.stringify(opts.args[1]) + ' — ' + ([...model.state.lines.values()].map(l => l.name || l.lineId).join(', ') || 'none on this station') + '\n'); return core.EXIT.STATION; }
    const text = opts.args.slice(2).join(' ');
    if (!opts.json) io.err('▸ sending one job down ' + (line.name || line.lineId) + ' — waiting for it to deliver (ctrl+c stops waiting)\n');
    const r = await client.request('POST', '/api/routing/sample', { text, line: line.lineId }, { timeoutMs: 60 * 60 * 1000 });
    const ok = !!(r.ok && r.status === 200 && r.json && r.json.ok);
    const stopped = !ok && !!(r.json && r.json.stopped === true);
    if (opts.json) io.out(JSON.stringify(Object.assign({ ok, status: r.status || 0 }, r.json && typeof r.json === 'object' ? r.json : { error: r.error || r.text })) + '\n');
    else if (ok) io.out((line.name || line.lineId) + ' delivered' + (r.json.totalUsd ? ' · $' + Number(r.json.totalUsd).toFixed(4) : '') + (r.json.jobId ? ' · job ' + r.json.jobId : '') + '\n');
    else if (stopped) io.err('■ ' + (line.name || line.lineId) + ' was stopped: ' + String(r.json.error || 'you stopped this job before it reached the OUTBOX').replace(/^stopped\s*[—-]\s*/i, '') + '\n');
    else io.err('starnet: ' + (line.name || line.lineId) + ' did not deliver: ' + ((r.json && (r.json.error || r.json.reason)) || r.error || r.text || 'HTTP ' + r.status) + '\n');
    // review r8: a job the Commander STOPPED (the route's stopped:true) exits as a stop (4, as `starnet -p` does for one), never "1 run failed"
    return ok ? core.EXIT.OK : stopped ? core.EXIT.CANCELLED : core.EXIT.RUN_FAILED;
  }
  const flows = model.flows(now);
  if (opts.json) { io.out(JSON.stringify({ flows: flows.map(f => ({ lineId: f.lineId, name: f.name, state: f.state, runs: f.runs, shipped: f.shipped, lastJob: f.job ? { id: f.job.id, status: f.job.status, startedAt: f.job.startedAt, endedAt: f.job.endedAt, usd: f.job.usd } : null })) }) + '\n'); return core.EXIT.OK; }
  if (!flows.length) { io.out('no workflows on this station yet — build a line in the app (INBOX → steps → OUTBOX)\n'); return core.EXIT.OK; }
  io.out(pad('WORKFLOW', 24) + ' ' + pad('STATE', 12) + ' LAST JOB\n');
  for (const f of flows) io.out(pad(f.name, 24) + ' ' + pad(f.state, 12) + ' ' + f.text + (f.shipped ? ' · ' + f.shipped + ' shipped' : '') + '\n');
  return core.EXIT.OK;
}

module.exports = { lsCommand, answerCommand, watchCommand, flowCommand, lsRows, formatLs, makeWatchFormatter, loadStation, fillAskSummaries };
