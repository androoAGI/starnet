'use strict';
/* A line's DAILY LIMIT applies before its first stage on every host-routed entry.
   Real sidecar + local provider: no keys, no billable requests, isolated persisted day ledger. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { floorOf, hintFor, planOf, publishFloor } = require('./helpers/saved-floor.js');

async function startSseCollector(url) {
  const ac = new AbortController(), events = [];
  const res = await fetch(url, { signal: ac.signal });
  assert.equal(res.status, 200, 'the real station event feed opens');
  const reader = res.body.getReader();
  const reading = (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, end).trim(); buf = buf.slice(end + 1);
          if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5).trim()));
        }
      }
    } catch (error) { if (!ac.signal.aborted) throw error; }
  })();
  return { events, async close() { ac.abort(); await reading; } };
}

(async () => {
  const calls = [];
  let sse = null;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    if (!req.url.includes('/chat/completions')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } }] }));
    }
    calls.push(JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'The workflow result.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const fixture = SidecarFixture.create({ timeoutMs: 30000, env: {
    STARNET_OPENROUTER_KEY: 'fixture', SKYNET_OPENROUTER_KEY: 'fixture',
    STARNET_OPENROUTER_BASE: base + '/v1', SKYNET_OPENROUTER_BASE: base + '/v1',
    STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_DEV: '1', SKYNET_DEV: '1',
    STARNET_CRON_TICK_MS: '100', SKYNET_CRON_TICK_MS: '100',
    STARNET_FULL_ACCESS: '0', SKYNET_FULL_ACCESS: '0', SKYNET_AUX_BUDGET: '0', STARNET_AUX_BUDGET: '0'
  } });
  const geometry = { props: [
    { id: 'iA', t: 'intake', x: 0, y: 0, w: 1, h: 1, limits: { maxUsdPerDay: 1 } },
    { id: 'a1', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer' },
    { id: 'oA', t: 'outbox', x: 6, y: 0, w: 1, h: 1 },
    { id: 'iB', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
    { id: 'b1', t: 'bay', x: 3, y: 4, w: 1, h: 1, agentId: 'writer' },
    { id: 'oB', t: 'outbox', x: 6, y: 4, w: 1, h: 1 }
  ], belts: [0, 4].flatMap(y => [1, 2, 4, 5].map(x => ({ x, y, dir: 'E' }))) };
  const floor = floorOf(geometry), plan = planOf(hintFor(floor));
  assert.equal(Pipeline.ok(plan), true);
  const lineA = plan.lineOfProp.iA, lineB = plan.lineOfProp.iB;
  const day = Math.floor(Date.now() / 86400000);
  const ledger = path.join(fixture.workspace, 'line-spend.json');
  fs.writeFileSync(ledger, JSON.stringify({ version: 1, lines: { [lineA]: { day, usd: 1 } } }));
  const before = () => calls.length;
  const sample = line => fixture.json('POST', '/api/routing/sample', { line, text: 'Write the workflow result.' });
  const capText = /line reached its \$1\.00 daily limit/i;
  function assertCapped(job, label) {
    assert.deepEqual([job.status, job.outcome, job.stop && job.stop.code], ['problem', 'stopped_short', 'day_limit'], label + ': exact durable admission outcome: ' + JSON.stringify(job));
    assert.deepEqual(job.runs, [], label + ': no invented missing-terminal run for a known preflight refusal');
    assert.equal(job.usd, 0, label + ': no paid work');
    assert.match(job.stop.why, capText, label + ': the real $1.00 cap is retained');
    assert.ok(!/failed|\$0\.00/.test(job.stop.why), label + ': a cap is not a failed stage or a zero-dollar cap');
  }
  const list = async () => (await fixture.json('GET', '/api/line-jobs?line=' + encodeURIComponent(lineA))).body.jobs;
  async function cappedRecord(entry) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const row = (await list()).find(j => j.entry === entry);
      if (row && !/^(running|paused)$/.test(row.status)) {
        const full = (await fixture.json('GET', '/api/line-jobs/' + row.id)).body.job;
        assertCapped(full, entry);
        return full;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    assert.fail(entry + ': no settled capped line job');
  }
  async function openFeed() {
    sse = await startSseCollector(fixture.baseUrl + '/api/channels/events?' + require('./_httpToken.js').sseQuery(fixture.token));
  }
  function noDelivery(label) {
    assert.equal(sse.events.filter(e => e.name === 'workitem.delivered' && e.payload && (e.payload.finalQueueId === 'outbox' || e.payload.box === 'line-output')).length, 0, label + ': no delivered crate or terminal publication');
  }
  async function cappedSample(label) {
    const count = before(), result = await sample(lineA);
    assert.equal(calls.length, count, label + ': the exhausted line must make zero provider calls');
    assert.equal(result.body.ok, false, result.text);
    assert.ok(capText.test(JSON.stringify(result.body.replies)), label + ': the reply names the line daily cap: ' + result.text);
    // the refusal's REASON is the route's error (the panel / FINISH card / station.test_line read it) — never only "no durable run outcome"
    assert.ok(capText.test(String(result.body.error || '')) && /raise its LINE BUDGET or try again tomorrow/.test(result.body.error) && !/^⚠/.test(result.body.error), label + ': the error says the daily limit and how to raise it: ' + result.body.error);
    assert.equal(result.body.delivered, null, 'the refused job never claims delivery');
    const job = await fixture.json('GET', '/api/line-jobs/' + result.body.jobId);
    assert.deepEqual([result.body.outcome, result.body.stop && result.body.stop.code], ['stopped_short', 'day_limit'], label + ': route preserves the host cap: ' + JSON.stringify(result.body));
    assertCapped(job.body.job, label);
    // no run row exists for a refused entry: the job record and the route's error carry the cap, never "no step ran"
    assert.match(String(job.body.job.error || ''), capText, label + ': the job record says why it failed: ' + JSON.stringify(job.body.job.error));
    assert.match(String(result.body.error || ''), capText, label + ': the route\'s error names the cap: ' + JSON.stringify(result.body.error));
    return result;
  }
  try {
    await fixture.start();
    await fixture.json('POST', '/api/roster', { agents: [{ agentId: 'writer', name: 'Writer', provider: 'openrouter', model: 'test/model' }], updatedAt: Date.now() });
    await publishFloor(fixture, floor);   // saved, then published as the page does
    await openFeed();
    await cappedSample('sample entry');
    noDelivery('sample entry');
    await sse.close(); sse = null;
    await fixture.restart();
    await openFeed();
    await cappedSample('after restart');

    const channelCalls = before();
    const inbound = await fixture.json('POST', '/api/dev/inbound', { text: 'Write the capped workflow result.', chatId: 'capped-admission' });
    assert.equal(inbound.status, 200, inbound.text);
    await cappedRecord('channel');
    assert.equal(calls.length, channelCalls, 'the shared channel entry buys no run');

    const step = await fixture.json('POST', '/api/routing/steptest', { line: lineA, text: 'Write the capped workflow result.', pause: 'none' });
    assert.ok(step.status === 200 && step.body.ok, step.text);
    await cappedRecord('steptest');
    assert.equal(calls.length, channelCalls, 'the step entry buys no run');

    const routine = await fixture.json('POST', '/api/cron', { name: 'Capped line', prompt: 'Write the workflow result.',
      schedule: 'every 1h', agentId: 'writer', dockId: 'a1', model: 'test/model', provider: 'openrouter', runsLine: true });
    assert.ok(routine.body.job?.id, routine.text);
    let count = before();
    const run = await fixture.json('POST', '/api/cron/run', { id: routine.body.job.id });
    assert.equal(calls.length, count, 'Run Now also refuses before the first provider call');
    assert.ok(capText.test(run.text), run.text);
    assert.ok(run.text.includes('"reason":"budget"'), 'Run Now emits a budget outcome');
    await cappedRecord('manual');

    const scheduled = await fixture.json('POST', '/api/cron', { name: 'Overnight batch', prompt: 'Write the workflow result.',
      schedule: 'in 1s', agentId: 'writer', dockId: 'a1', model: 'test/model', provider: 'openrouter', runsLine: true });
    assert.ok(scheduled.body.job?.id && !scheduled.body.duplicate, 'a distinct scheduled routine is created (the mint gate folds a near-same name into the Run Now job, which never fires on schedule): ' + scheduled.text);
    await fixture.json('POST', '/api/cron/arm', { enabled: true });
    let fired = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const jobs = (await fixture.json('GET', '/api/cron')).body.jobs || [];
      fired = jobs.find(j => j.id === scheduled.body.job.id && j.lastRunAt);
      if (fired) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(fired, 'the scheduled job fired');
    assert.notEqual(fired.lastStatus, 'ok', 'the scheduled refusal is not success');
    assert.equal(calls.length, count, 'the scheduled line also spends nothing after the cap');
    await fixture.json('POST', '/api/cron/arm', { enabled: false });
    await cappedRecord('schedule');
    noDelivery('all capped entries');
    await sse.close(); sse = null;

    /* A TERMINAL routine (runsLine:false — Andrew's 08-07 ruling) on a bay of the capped line is not line work: its chain seed
       carries no line, so its spend never reaches the line ledger, and the line's daily limit must not refuse it. The crate
       still names the bay's line (LINE WATCH), which is exactly how the entry cap used to mistake it for a line entry. */
    const ledgerLine = () => ((JSON.parse(fs.readFileSync(ledger, 'utf8')).lines || {})[lineA] || null);
    const ledgerBefore = JSON.stringify(ledgerLine());
    const terminal = await fixture.json('POST', '/api/cron', { name: 'Solo report', prompt: 'Write the workflow result.',
      schedule: 'every 1h', agentId: 'writer', dockId: 'a1', model: 'test/model', provider: 'openrouter', runsLine: false });
    assert.ok(terminal.body.job?.id && !terminal.body.duplicate, terminal.text);
    count = before();
    const terminalRun = await fixture.json('POST', '/api/cron/run', { id: terminal.body.job.id });
    assert.ok(calls.length > count, 'a terminal routine on a capped line\'s bay still runs: ' + terminalRun.text.slice(0, 400));
    assert.ok(!capText.test(terminalRun.text), 'a terminal routine is never refused by the line daily limit: ' + terminalRun.text.slice(0, 400));
    assert.ok(terminalRun.text.includes('The workflow result.'), 'the terminal routine delivers its own answer');
    assert.equal(JSON.stringify(ledgerLine()), ledgerBefore, 'its spend never lands in the line ledger');
    const terminalScheduled = await fixture.json('POST', '/api/cron', { name: 'Morning summary', prompt: 'Write the workflow result.',
      schedule: 'in 1s', agentId: 'writer', dockId: 'a1', model: 'test/model', provider: 'openrouter', runsLine: false });
    assert.ok(terminalScheduled.body.job?.id && !terminalScheduled.body.duplicate, terminalScheduled.text);
    count = before();
    await fixture.json('POST', '/api/cron/arm', { enabled: true });
    let firedTerminal = null;
    const terminalDeadline = Date.now() + 15000;
    while (Date.now() < terminalDeadline) {
      const jobs = (await fixture.json('GET', '/api/cron')).body.jobs || [];
      firedTerminal = jobs.find(j => j.id === terminalScheduled.body.job.id && j.lastRunAt);
      if (firedTerminal) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await fixture.json('POST', '/api/cron/arm', { enabled: false });
    assert.ok(firedTerminal, 'the scheduled terminal routine fired');
    assert.equal(firedTerminal.lastStatus, 'ok', 'a scheduled terminal routine on a capped line\'s bay succeeds: ' + JSON.stringify(firedTerminal).slice(0, 400));
    assert.ok(calls.length > count, 'and really called its provider');
    assert.equal(JSON.stringify(ledgerLine()), ledgerBefore, 'the scheduled terminal fire leaves the line ledger alone too');

    count = before();
    const other = await sample(lineB);
    assert.equal(other.body.ok, true, other.text);
    assert.ok(calls.length > count, 'the same agent can still run another line with no cap');

    count = before();
    const direct = await fixture.json('POST', '/api/run', { agentId: 'writer', provider: 'openrouter', model: 'test/model',
      lineId: lineA, messages: [{ role: 'user', content: 'Say hello.' }] });
    assert.ok(!capText.test(direct.text), 'a direct order cannot forge a workflow origin');
    assert.ok(calls.length > count, 'direct conversation stays outside the workflow budget');

    await fixture.stop();
    fs.writeFileSync(ledger, JSON.stringify({ version: 1, lines: { [lineA]: { day: day - 1, usd: 1 } } }));
    await fixture.start();
    const tomorrow = await sample(lineA);
    assert.equal(tomorrow.body.ok, true, 'a previous day bucket no longer refuses: ' + tomorrow.text);
    console.log('routing.line-admission: OK — capped sample, restart, Run Now, scheduled entry, multi-bay isolation, direct order and day rollover');
  } finally {
    if (sse) await sse.close();
    await fixture.dispose();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
