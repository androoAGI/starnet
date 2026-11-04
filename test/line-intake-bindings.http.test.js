'use strict';
// Actual host creates, persists and reloads INBOX receipts without changing channel or schedule behavior.
const A = require('./_assert.js'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
const MODEL = 'intake-receipt-fixture';
(async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) { res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
    let raw = ''; req.on('data', part => raw += part); req.on('end', () => {
      requests.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Completed intake receipt job.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 40, completion_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + upstream.address().port;
  const fixture = SidecarFixture.create({ prefix: 'intake-receipt-', env: {
    STARNET_DEV: '1', STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_PROVIDER: 'custom', STARNET_DEFAULT_MODEL: MODEL,
    CUSTOM_OPENAI_KEY: 'fixture-key', CUSTOM_OPENAI_BASE_URL: origin + '/v1', STARNET_MAX_ITERS: '4',
    STARNET_BUDGET_PER_DAY: '0', STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_LIVE_PRICES: '0',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0',
    STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0', STARNET_CRON_ENABLED: '0'
  } });
  const boot = path.join(fixture.workspace, 'intake-boot.cjs');
  fs.writeFileSync(boot, "const real=globalThis.fetch;globalThis.fetch=function(url){const u=new URL(String((url&&url.url)||url));return u.origin==="
    + JSON.stringify(origin) + "?real.apply(this,arguments):Promise.reject(new Error('non-fixture upstream refused'));};require("
    + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ');');
  fixture.entry = boot;
  const api = async (method, route, body) => { const r = await fixture.json(method, route, body); assert.equal(r.status, 200, route + ': ' + r.text.slice(0, 500)); return r.body; };
  const chat = () => JSON.parse(fs.readFileSync(path.join(fixture.workspace, 'channels/chatmap.json'), 'utf8')).chats['receipt-chat'];
  try {
    await fixture.start();
    await api('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
      _saveClient: 'intake-fixture', agent: { id: 'agent', name: 'Receipt agent', createdAt: Date.now() }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    assert.notEqual((await api('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'agent', provider: 'custom', model: MODEL }] })).held, true);
    await publishFloor(fixture, floorOf({ props: [
      { id: 'in', lineId: 'line-stable', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'writer', t: 'bay', agentId: 'agent', x: 3, y: 0, w: 1, h: 1 },
      { id: 'out', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }), { label: 'the one-line floor' });
    await api('POST', '/api/dev/inbound', { chatId: 'receipt-chat', text: '/talk agent' });
    const sent = await api('POST', '/api/dev/inbound', { chatId: 'receipt-chat', text: 'TASK: Write the receipt result.' });
    const job = (await api('GET', '/api/line-jobs/' + sent.jobId)).job;
    A.eq(job.status, 'delivered', 'actual channel keeps its existing successful line behavior');
    A.eq(job.intakeId, 'in', 'actual admitted channel LineJob records INBOX');
    A.eq(chat().intakeBinding, { mode: 'line', agentId: 'agent', dockId: 'writer', lineId: 'line-stable', intakeId: 'in' }, 'actual channel map durably records final resolution');
    const schedules = [];
    for (const runsLine of [false, true]) {
      const created = await api('POST', '/api/cron', { name: runsLine ? 'Line intake digest' : 'Terminal weather summary',
        prompt: 'Write a brief status report.', schedule: 'every 1h', agentId: 'agent', provider: 'custom', model: MODEL,
        dockId: 'writer', runsLine, arm: false, intakeBinding: { mode: 'line', intakeId: 'forged' } });
      assert.ok(created.job && !created.duplicate, JSON.stringify(created)); schedules.push(created.job);
      A.eq(created.job.intakeBinding && created.job.intakeBinding.mode, runsLine ? 'line' : 'direct', 'schedule preserves existing runsLine opt-in: ' + runsLine);
      A.eq(created.job.intakeBinding && created.job.intakeBinding.intakeId, runsLine ? 'in' : undefined, 'schedule INBOX is host-derived: ' + runsLine);
      A.eq([created.job.provider, created.job.model], ['custom', MODEL], 'schedule keeps provider/model pair');
    }
    const trigger = await api('POST', '/api/routing/triggers', { kind: 'webhook', lineId: 'line-stable', intakeId: 'forged', config: { task: 'Write the webhook receipt result.' } });
    A.eq(trigger.trigger.intakeId, 'in', 'actual webhook binding names its INBOX');
    const hook = await fixture.json('POST', '/api/hooks/' + trigger.trigger.id, { job: 'receipt' },
      { headers: { 'X-StarNet-Hook-Key': trigger.secret, 'Idempotency-Key': 'receipt-one' } });
    assert.equal(hook.status, 202, hook.text);
    let hookJob;
    for (let i = 0; i < 150; i++) { hookJob = (await api('GET', '/api/line-jobs/' + hook.body.jobId)).job; if (hookJob && hookJob.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    A.eq(hookJob.status, 'delivered', 'webhook still executes its existing line exactly once');
    A.eq(hookJob.intakeId, 'in', 'actual webhook LineJob records INBOX');
    A.eq(requests.length, 2, 'channel and webhook each generate once; recording bindings generates nothing');
    await fixture.restart();
    A.eq((await api('GET', '/api/line-jobs/' + sent.jobId)).job.intakeId, 'in', 'job INBOX survives actual restart');
    A.eq((chat().intakeBinding || {}).intakeId, 'in', 'channel binding survives restart');
    const after = await api('GET', '/api/cron');
    A.eq(schedules.map(old => after.jobs.find(j => j.id === old.id).intakeBinding), schedules.map(j => j.intakeBinding), 'both schedule modes survive actual restart');
    A.eq((await api('GET', '/api/routing/triggers')).triggers.find(t => t.id === trigger.trigger.id).intakeId, 'in', 'webhook binding survives actual restart');
    A.eq(requests.length, 2, 'reload never replays work');
    await api('POST', '/api/roster', { updatedAt: Date.now(), agents: ['agent', 'second'].map(agentId => ({ agentId, provider: 'custom', model: MODEL })) });
    await publishFloor(fixture, floorOf({ props: [
      { id: 'in', lineId: 'line-stable', t: 'intake', x: 0, y: 0, w: 1, h: 1 },
      { id: 'writer', t: 'bay', agentId: 'agent', x: 3, y: 0, w: 1, h: 1 },
      { id: 'out', t: 'outbox', sendTo: 'target', x: 6, y: 0, w: 1, h: 1 },
      { id: 'target', lineId: 'line-target', t: 'intake', x: 0, y: 4, w: 1, h: 1 },
      { id: 'target-writer', t: 'bay', agentId: 'second', x: 3, y: 4, w: 1, h: 1 },
      { id: 'target-out', t: 'outbox', x: 6, y: 4, w: 1, h: 1 }
    ], belts: [0, 4].flatMap(y => [1, 2, 4, 5].map(x => ({ x, y, dir: 'E' }))) }), { label: 'the two-line floor with SEND TO' });
    const sample = await api('POST', '/api/routing/sample', { line: 'line-stable', text: 'Write one result and send it to the next line.' });
    assert.ok(sample.jobId, JSON.stringify(sample));
    let target;
    for (let i = 0; i < 150; i++) { target = (await api('GET', '/api/line-jobs?line=line-target')).jobs.find(j => j.from && j.from.jobId === sample.jobId);
      if (target && target.status !== 'running') break; await new Promise(r => setTimeout(r, 50)); }
    if (target) target = (await api('GET', '/api/line-jobs/' + target.id)).job;   // list summaries intentionally omit record-only metadata
    A.eq(target && target.status, 'delivered', 'actual SEND TO still executes the target line');
    A.eq(target && target.intakeId, 'target', 'actual SEND TO receipt names its selected target INBOX: ' + JSON.stringify(target));
    A.eq((await api('GET', '/api/line-jobs/' + sample.jobId)).job.intakeId, 'in', 'sample retains its own source INBOX');
    A.eq(requests.length, 4, 'sample and handoff add exactly their two expected generations');
    A.ok(requests.every(r => r.model === MODEL), 'all generated work retains the configured model');
  } finally { await fixture.dispose(); await new Promise(r => upstream.close(r)); }
  A.report('line-intake-bindings.http');
})().catch(error => { console.error(error); process.exitCode = 1; });
