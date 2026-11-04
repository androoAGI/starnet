'use strict';
// Real bound dev-channel jobs share a stream. Both server and actual Workflows reader keep exact run membership after restart.
const A = require('./_assert.js'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), vm = require('node:vm');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const MODEL = 'reader-fixture';

(async () => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = ''; req.on('data', part => { raw += part; });
    req.on('end', () => {
      JSON.parse(raw); calls++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Distinct reader result ' + calls + '.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'line-reader-', env: {
    STARNET_DEV: '1', STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_PROVIDER: 'custom', STARNET_DEFAULT_MODEL: MODEL,
    CUSTOM_OPENAI_KEY: 'reader-fixture-key', CUSTOM_OPENAI_BASE_URL: origin + '/v1', STARNET_MAX_ITERS: '4',
    STARNET_BUDGET_PER_DAY: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_LIVE_PRICES: '0',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0'
  } });
  const boot = path.join(fixture.workspace, 'reader-boot.cjs');
  fs.writeFileSync(boot, "const real=globalThis.fetch;globalThis.fetch=function(url){const u=new URL(String((url&&url.url)||url));return u.origin==="
    + JSON.stringify(origin) + "?real.apply(this,arguments):Promise.reject(new Error('non-fixture upstream refused'));};require("
    + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ');');
  fixture.entry = boot;
  const api = async (method, route, body) => { const r = await fixture.json(method, route, body); assert.equal(r.status, 200, route + ': ' + r.text.slice(0, 600)); return r.body; };
  const jobs = [];
  try {
    await fixture.start();
    await api('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
      _saveClient: 'reader-fixture', agent: { id: 'agent', name: 'Reader agent', createdAt: Date.now() }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    const roster = await api('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', name: 'Reader agent', provider: 'custom', model: MODEL }] });
    assert.notEqual(roster.held, true, 'fixture roster persists after founding');
    const { plan, hint } = await publishFloor(fixture, floorOf({ props: [
      { id: 'in', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'writer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'agent', role: 'WRITER' },
      { id: 'out', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }), { label: 'the one-line floor' });
    await api('POST', '/api/dev/inbound', { chatId: 'reader-shared', text: '/talk agent' });
    for (const word of ['first', 'second']) {
      const delivery = await api('POST', '/api/dev/inbound', { chatId: 'reader-shared', text: 'TASK: Write the ' + word + ' reader result.' });
      assert.ok(delivery.jobId, JSON.stringify(delivery));
      const job = (await api('GET', '/api/line-jobs/' + delivery.jobId)).job;
      assert.equal(job.status, 'delivered', JSON.stringify(job));
      assert.equal(job.runs.length, 1, 'one actual owned run per delivery');
      jobs.push(job);
    }
    A.eq(calls, 2, 'two ordinary deliveries call the synthetic provider twice');
    A.eq(jobs[0].streamId, jobs[1].streamId, 'actual shared chat reuses its stream');
    A.ok(jobs[0].id !== jobs[1].id && jobs[0].runs[0].runId !== jobs[1].runs[0].runId, 'shared stream retains distinct job and run identities');
    const opened = [];
    const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, JSON, Math, Date, Set, Map, encodeURIComponent,
      module: { exports: {} }, window: {}, document: { activeElement: null, querySelector: () => null }, Pipeline,
      StationUI: { registerWindow() {}, openTerm: key => opened.push(key), h: { present: [], notify() {}, navigateWork: (from, to) => opened.push(from + '>' + to) } },
      fetch: async url => { const r = await fixture.json('GET', url); return { status: r.status, json: async () => r.body }; }
    });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../frontend/app/windows/workflows.js'), 'utf8'), ctx);
    const reader = ctx.module.exports;
    async function verify(label) {
      for (const job of jobs) {
        const runId = job.runs[0].runId;
        const hit = await api('GET', '/api/line-jobs?stream=' + encodeURIComponent(job.streamId) + '&runId=' + encodeURIComponent(runId) + '&limit=1');
        A.eq(hit.jobs.map(row => row.id), [job.id], label + ': exact server join returns its own job');
        A.eq(await reader.openByStream(job.streamId, 'deliverables', runId), true, label + ': actual workflow reader opens a proved job');
        const selected = reader._state.job || {};
        A.eq([selected.id, selected.output], [job.id, job.output], label + ': actual workflow state keeps the exact requested job and answer');
      }
      const absent = await api('GET', '/api/line-jobs?stream=' + encodeURIComponent(jobs[0].streamId) + '&runId=not-a-member&limit=1');
      A.eq(absent.jobs, [], label + ': a nonmember never borrows newest job on the stream');
      A.eq(await reader.openByStream(jobs[0].streamId, 'deliverables', 'not-a-member'), false, label + ': reader refuses unknown exact run');
      A.eq(await reader.openByStream(jobs[0].streamId, 'deliverables'), false, label + ': shared stream alone is not job authority');
    }
    await verify('before restart');
    await fixture.restart();
    await verify('after restart');
    A.eq(calls, 2, 'all reads and restart make no new generation call');
    A.eq(await reader.openJob('job-absent000000', 'deliverables'), false, 'a deleted exact job cannot claim a successful navigation');
    await api('POST', '/api/routing', hint);   // the page publishes its hint again: the restarted station still holds exactly this saved floor
    const sample = await api('POST', '/api/routing/sample', { line: plan.lines[0].lineId, text: 'Write the legacy sample result.' });
    assert.ok(sample.jobId, JSON.stringify(sample));
    A.eq(await reader.openByStream(sample.streamId, 'deliverables'), true, 'legacy unique sample stream still opens its durable job');
    A.eq(reader._state.job.id, sample.jobId, 'legacy stream read keeps the sample identity');
  } finally {
    await fixture.dispose();
    await new Promise(resolve => upstream.close(resolve));
  }
  A.report('line-job-reader-identity.http');
})().catch(error => { console.error(error); process.exitCode = 1; });
