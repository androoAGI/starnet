'use strict';
/* Real scheduled/Run Now entries, actual host acceptance checks and durable LineJobs. Only provider bytes are
 * synthetic. An unmet caller contract must not buy a downstream hop or publish an OUTBOX/SEND TO result. */
const assert = require('node:assert/strict');
const A = require('./_assert.js');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { userWords } = require('./helpers/host-notes.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'contract-fixture';

async function eventFeed(url) {
  const abort = new AbortController(), events = [];
  const response = await fetch(url, { signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const reading = (async () => {
    let buf = ''; const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += decoder.decode(value, { stream: true });
        let end;
        while ((end = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, end).trim(); buf = buf.slice(end + 1);
          if (line.startsWith('data:')) events.push(JSON.parse(line.slice(5)));
        }
      }
    } catch (error) { if (!abort.signal.aborted) throw error; }
  })();
  return { events, async close() { abort.abort(); await reading; } };
}

(async () => {
  let scenario = '', feed;
  const calls = [], receipts = [];
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw), messages = body.messages || [];
      const users = messages.filter(m => m.role === 'user').map(userWords);
      const hop = users.some(text => text.startsWith('PIPELINE HANDOFF'));
      const target = users.some(text => text.startsWith('[HAND-OFF'));
      calls.push({ scenario, hop, target, users });
      const asked = new Set(messages.flatMap(m => (m.tool_calls || []).map(t => t.function && t.function.name)));
      let delta = { content: hop ? 'The editor completed its stage.' : target ? 'The receiving line completed its work.' : 'The requested result is ready.' };
      let finish = 'stop';
      if (scenario === 'met' && !hop && !target) {
        let tool;
        if (!asked.has('brief_proceed')) tool = ['brief_proceed', { objective: 'Save required.txt', deliverable: 'required.txt', success: 'required.txt contains the requested result' }];
        else if (!asked.has('fs_write')) tool = ['fs_write', { path: 'required.txt', content: 'contract proof' }];
        if (tool) { finish = 'tool_calls'; delta = { tool_calls: [{ index: 0, id: 'call-' + tool[0], type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }; }
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish }], usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-contract-', env: {
    STARNET_DEV: '1', STARNET_FULL_ACCESS: '1', STARNET_CRON_TICK_MS: '100', STARNET_MAX_ITERS: '8',
    STARNET_DEFAULT_PROVIDER: 'custom', STARNET_DEFAULT_MODEL: MODEL,
    CUSTOM_OPENAI_KEY: 'contract-fixture-key', CUSTOM_OPENAI_BASE_URL: base + '/v1',
    STARNET_BUDGET_PER_DAY: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '',
    STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_LIVE_PRICES: '0'
  } });
  const boot = path.join(fixture.workspace, 'contract-boot.cjs');
  fs.writeFileSync(boot, "const real=globalThis.fetch;globalThis.fetch=function(url){const u=new URL(String((url&&url.url)||url));return u.origin===" + JSON.stringify(base) + "?real.apply(this,arguments):Promise.reject(new Error('contract fixture: non-fixture transport refused'));};require(" + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ');');
  fixture.entry = boot;
  const api = async (method, route, body) => { const r = await fixture.json(method, route, body); assert.equal(r.status, 200, route + ': ' + r.text.slice(0, 300)); return r.body; };
  async function until(fn, label) {
    const deadline = Date.now() + 30000;
    for (;;) { const result = await fn(); if (result) return result; if (Date.now() >= deadline) throw new Error('timeout: ' + label + '\n' + fixture.output().slice(-2500)); await sleep(100); }
  }
  try {
    await fixture.start();
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    const saved = await api('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
      _saveClient: 'contract-fixture', agent: { id: 'writer', name: 'Writer', createdAt: Date.now() }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    assert.equal(saved.ok, true);
    await api('POST', '/api/roster', { updatedAt: Date.now(), agents: ['writer', 'editor', 'receiver'].map(agentId => ({ agentId, name: agentId, provider: 'custom', model: MODEL })) });
    const props = [
      { id: 'in', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'writer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'writer', role: 'WRITER' },
      { id: 'editor', t: 'bay', x: 6, y: 0, w: 1, h: 1, agentId: 'editor', role: 'EDITOR' },
      { id: 'out', t: 'outbox', x: 9, y: 0, w: 1, h: 1, sendTo: 'target-in' },
      { id: 'target-in', t: 'intake', x: 0, y: 10, w: 1, h: 1 },
      { id: 'receiver', t: 'bay', x: 3, y: 10, w: 1, h: 1, agentId: 'receiver', role: 'WRITER' },
      { id: 'target-out', t: 'outbox', x: 6, y: 10, w: 1, h: 1 }
    ];
    const belts = [1, 2, 4, 5, 7, 8].map(x => ({ x, y: 0, dir: 'E' })).concat([1, 2, 4, 5].map(x => ({ x, y: 10, dir: 'E' })));
    const { plan } = await publishFloor(fixture, floorOf({ props, belts }, { equip: ['computer', 'workbench'] }), { label: 'the two-line floor' });
    const lineId = plan.lineOfProp.in, targetId = plan.lineOfProp['target-in'];
    assert.ok(lineId && targetId && lineId !== targetId);
    feed = await eventFeed(fixture.baseUrl + '/api/channels/events?' + require('./_httpToken.js').sseQuery(fixture.token));
    let sequence = 0;
    for (const entry of ['schedule', 'manual']) for (const variant of ['unmet', 'invalid', 'met', 'none']) {
      scenario = variant;
      const prior = new Set(((await api('GET', '/api/line-jobs')).jobs || []).map(j => j.id));
      const from = calls.length, eventFrom = feed.events.length;
      const contract = { requirements: [{ id: 'required-file', type: 'artifact_exists', path: 'required.txt' }] };
      const created = await api('POST', '/api/cron', { name: 'Contract ' + entry + ' ' + (++sequence), prompt: 'Fixture ' + entry + '/' + variant + ': prepare the requested result.',
        schedule: entry === 'schedule' ? 'in 1s' : 'every 1h', agentId: 'writer', dockId: 'writer', provider: 'custom', model: MODEL, runsLine: true,
        ...(variant === 'none' ? {} : { meta: { postconditions: variant === 'invalid' ? { requirements: [] } : contract } }) });
      assert.ok(created.job && !created.duplicate, 'independent routine ' + entry + '/' + variant);
      const id = created.job.id;
      if (entry === 'schedule') await api('POST', '/api/cron/arm', { enabled: true });
      else { const response = await fixture.request('/api/cron/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); assert.equal(response.status, 200); await response.text(); }
      const routine = await until(async () => ((await api('GET', '/api/cron')).jobs || []).find(j => j.id === id && j.lastStatus), entry + '/' + variant + ' routine');
      await api('POST', '/api/cron/arm', { enabled: false });
      const all = await until(async () => {
        const rows = ((await api('GET', '/api/line-jobs')).jobs || []).filter(j => !prior.has(j.id));
        const entryJob = rows.find(j => j.line === lineId);
        if (!entryJob || rows.some(j => /^(running|paused)$/.test(j.status))) return null;
        if (entryJob.outcome === 'delivered' && !rows.some(j => j.line === targetId)) return null;
        return rows;
      }, 'line settlement');
      const main = all.find(j => j.line === lineId); assert.ok(main, 'entry LineJob exists');
      const detail = (await api('GET', '/api/line-jobs/' + main.id)).job;
      const run = ((await api('GET', '/api/runs?agent=writer&runId=' + encodeURIComponent(routine.lastRunId))).runs || [])[0];
      assert.ok(run, 'entry durable run row exists');
      await until(() => feed.events.slice(eventFrom).some(e => e.name === 'cron.result' && e.payload.runId === routine.lastRunId), 'routine result event');
      const mine = calls.slice(from), events = feed.events.slice(eventFrom);
      const end = events.find(e => e.name === 'agent.run.end' && e.payload.runId === routine.lastRunId);
      const result = events.find(e => e.name === 'cron.result' && e.payload.runId === routine.lastRunId);
      const deliveries = events.filter(e => e.name === 'workitem.delivered');
      const label = entry + '/' + variant;
      A.eq(run.outcome, 'succeeded', label + ': provider execution remains succeeded');
      A.eq(run.completionEvidence.completionVerdict, variant === 'unmet' ? 'incomplete' : variant === 'invalid' ? 'verification_required' : variant === 'met' ? 'completed_verified' : 'not_assessed', label + ': durable host completion verdict');
      A.eq(end && end.payload.outcome, 'succeeded', label + ': terminal execution is not rewritten as provider failure');
      if (variant === 'unmet' || variant === 'invalid') {
        A.eq(mine.filter(c => c.hop).length, 0, label + ': unmet caller contract buys no downstream hop');
        A.eq(mine.filter(c => c.target).length, 0, label + ': unmet caller contract buys no SEND TO target');
        A.eq(deliveries.length, 0, label + ': no OUTBOX or line-output authority publication');
        A.eq(all.filter(j => j.line === targetId).length, 0, label + ': no receiving LineJob');
        A.eq([detail.outcome, detail.status, detail.stop && detail.stop.code], ['blocked', 'problem', 'blocked'], label + ': LineJob durably holds unverified work');
        A.eq([routine.lastStatus, routine.lastReason, routine.lastOutcome, routine.lastFailureCode], ['error', 'blocked', 'blocked', null], label + ': routine holds the job without inventing a provider failure');
        A.eq([routine.lastLine && routine.lastLine.stopCode, routine.lastLine && routine.lastLine.blocked], ['blocked', detail.error], label + ': routine stop facts retain the accepted job cause');
        A.eq(routine.lastError, detail.error, label + ': both durable records explain the same verification hold');
        A.ok(/Verification required/.test(detail.error), label + ': hold names verification, not a reviewer or provider failure');
        A.eq(result && [result.payload.outcome, result.payload.reason, result.payload.runOutcome], ['failed', 'blocked', 'blocked'], label + ': legacy coarse event plus typed outcome match durable hold');
        A.eq(events.filter(e => e.name === 'agent.run.error' && e.payload.runId === routine.lastRunId).length, 0, label + ': no synthetic provider error emitted');
      } else {
        A.eq(mine.filter(c => c.hop).length, 1, label + ': one unchanged downstream stage');
        A.eq(mine.filter(c => c.target).length, 1, label + ': one unchanged SEND TO');
        A.eq(detail.outcome, 'delivered', label + ': accepted/no-contract job delivered');
        A.eq(routine.lastStatus, 'ok', label + ': accepted/no-contract routine succeeds');
      }
      receipts.push({ entry, variant, run: { outcome: run.outcome, completion: run.completionEvidence.completionVerdict }, routine: { status: routine.lastStatus, outcome: routine.lastOutcome, error: routine.lastError }, line: { outcome: detail.outcome, stop: detail.stop }, hops: mine.filter(c => c.hop).length, targets: mine.filter(c => c.target).length, deliveries: deliveries.length });
      console.log(JSON.stringify(receipts[receipts.length - 1]));
      await api('POST', '/api/cron/remove', { id });
    }
  } finally {
    if (feed) await feed.close();
    await fixture.dispose(); await new Promise(resolve => upstream.close(resolve));
  }
  A.report('line-postconditions.e2e');
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
