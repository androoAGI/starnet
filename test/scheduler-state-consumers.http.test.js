/* The real scheduler payload is consumed by model tools, channel commands, phone and page views.
   Only the provider transport is fake; no scheduler state or consumer implementation is replaced. */
'use strict';
const A = require('./_assert.js');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SidecarFixture, allocatePort } = require('./helpers/sidecar-fixture.js');
const Phone = require('../relay/app/phone-client.js');
const WorkView = require('../frontend/app/workview.js');
const { Widgets } = require('../frontend/app/widgets.js');

async function provider() {
  const captured = [];
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000,
        pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    let raw = '';
    req.on('data', b => { raw += b; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const tool = (body.messages || []).find(m => m.role === 'tool');
      const frame = tool ? { content: 'Read the schedule.' } : { tool_calls: [{ index: 0, id: 'schedule_list',
        type: 'function', function: { name: 'routine_list', arguments: '{}' } }] };
      if (tool) captured.push(String(tool.content));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: frame }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, captured, base: 'http://127.0.0.1:' + server.address().port + '/api/v1' };
}

function appsPage(payload) {
  const context = { document: { readyState: 'loading', addEventListener() {}, querySelector() { return null; } },
    fetch: async () => ({ ok: true, json: async () => payload }), console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/app/apps.js'), 'utf8'), context);
  return context.AppsUI;
}

(async () => {
  const model = await provider();
  const lanPort = await allocatePort();
  const fx = SidecarFixture.create({ prefix: 'starnet-scheduler-consumers-', env: {
    SKYNET_DEV: '1', STARNET_DEV: '1', STARNET_REMOTE_PORT: String(lanPort), STARNET_REMOTE_LAN: '1', STARNET_REMOTE_RELAY: 'off',
    SKYNET_OPENROUTER_BASE: model.base, STARNET_OPENROUTER_BASE: model.base,
    SKYNET_OPENROUTER_KEY: 'sk-or-v1-scheduler-fake', STARNET_OPENROUTER_KEY: 'sk-or-v1-scheduler-fake',
    SKYNET_DEFAULT_MODEL: 'test/model', STARNET_DEFAULT_MODEL: 'test/model'
  } });
  let phone;
  try {
    await fx.start();
    const founded = await fx.json('POST', '/api/save', { schema: 'starnet.save', version: 6,
      agent: { id: 'agent', name: 'Scheduler proof', createdAt: 1 }, workstreams: [] });
    A.eq(founded.status, 200, 'real founding save accepted');
    const made = await fx.json('POST', '/api/apps', { name: 'Scheduler proof', description: 'A schedule consumer' });
    const appId = made.body.app.id;
    const schedule = await fx.json('POST', '/api/apps/schedule', { id: appId, every: 'every 1h', task: 'refresh the proof' });
    A.eq(schedule.status, 200, 'real app routine created');
    const jobId = schedule.body.jobId;
    A.eq((await fx.json('POST', '/api/workshop/grant', { agentId: 'agent', on: true })).body.ok, true, 'real workshop routine granted');
    A.eq((await fx.json('POST', '/api/remote/enable', { on: true })).status, 200, 'phone door enabled');
    const pair = (await fx.json('POST', '/api/remote/pair', { name: 'Scheduler proof phone' })).body;
    const key = await Phone.makeDeviceKey();
    const base = 'http://127.0.0.1:' + lanPort;
    const paired = await Phone.pair({ base, pairingId: pair.pairingId, code: pair.code, name: 'Scheduler proof phone', key });
    phone = Phone.connect({ base, deviceId: paired.deviceId, stationPub: pair.stationPub, key });

    async function inspect(label, held) {
      const cron = (await fx.json('GET', '/api/cron')).body;
      const job = cron.jobs.find(j => j.id === jobId);
      const expected = held ? null : job.nextRunAt;
      A.ok(Number.isFinite(Date.parse(job.nextRunAt)), label + ': stored schedule survives the hold');
      A.eq(cron.scheduler && cron.scheduler.held, held, label + ': one server scheduler state');
      A.eq(job.nextFireAt, expected, label + ': API separates runnable fire from stored time');
      A.eq(WorkView.routineView(job, cron).next, expected || '', label + ': work card uses server fire');
      A.eq(Widgets._nextRoutine(cron, Date.now()).val === null, !!held, label + ': widget clock follows server fire');
      const life = (await fx.json('GET', '/api/lifecycle/armed')).body.categories.routines;
      A.eq(life.armed, !held, label + ': lifecycle reads scheduler authority');
      const earliest = held ? null : cron.jobs.filter(j => j.enabled !== false && Number.isFinite(Date.parse(j.nextRunAt)))
        .map(j => j.nextRunAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null;
      A.eq(life.nextFireAt, earliest, label + ': lifecycle clock is the earliest eligible routine');
      const apps = (await fx.json('GET', '/api/apps')).body;
      const app = apps.apps.find(a => a.id === appId);
      A.eq(app.schedule.nextFireAt, expected, label + ': app payload agrees');
      const page = appsPage(apps); await page.load();
      A.eq(/ · next /.test(page._test.statusOf(app)), !held, label + ': app page never gives a held countdown');
      const workshopRead = await fx.json('GET', '/api/workshop/backlog?agent=agent');
      A.eq(workshopRead.status, 200, label + ': workshop card is readable');
      const workshop = workshopRead.body;
      A.eq(workshop.shiftsPaused, held === 'off' ? 'scheduler-off' : held, label + ': workshop shares hold reason');
      if (held) A.eq(workshop.nextShiftAt, null, label + ': workshop withholds held shift');
      else A.ok(Number.isFinite(Date.parse(workshop.nextShiftAt)), label + ': workshop shift has a real runnable clock');
      const remote = await phone.call('routines');
      A.eq(remote.ok, true, label + ': sealed phone read succeeds');
      const row = remote.data.find(j => j.id === jobId);
      A.eq(row.held, held, label + ': phone shares hold reason');
      A.eq(row.nextRunAt, expected, label + ': phone never carries a held fire');
      const chatId = 'scheduler_' + label;
      A.eq((await fx.json('POST', '/api/dev/inbound', { text: '/routines', chatId })).status, 200, label + ': channel command accepted');
      const replies = (await fx.json('GET', '/api/dev/replies?chatId=' + chatId)).body.replies;
      const words = replies.map(r => r.text).join('\n');
      A.ok(words.includes('Scheduler proof'), label + ': command actually lists the routine');
      A.eq(words.includes('next ' + job.nextRunAt), !held, label + ': channel clock follows hold');
      const before = model.captured.length;
      const response = await fx.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        key: 'sk-or-v1-scheduler-fake', provider: 'openrouter', model: 'test/model', agentId: 'agent',
        streamId: chatId + '_tool', isTask: true, messages: [{ role: 'user', content: 'List my routines and when each runs next.' }]
      }) });
      const wire = await response.text();
      A.eq(response.status, 200, label + ': model tool run accepted');
      A.ok(model.captured.length > before, label + ': real routine.list tool result reaches the model: ' + wire.slice(-180));
      const packed = JSON.parse(model.captured.at(-1));
      const toolJob = packed.jobs.find(j => j.id === jobId);
      A.eq(toolJob.nextRunAt, expected, label + ': model clock agrees');
      A.eq(toolJob.nextFireAt, expected, label + ': model receives shared projection');
      if (held) A.eq(toolJob.nextRunLocal, null, label + ': model gets no local held clock');
    }
    await fx.json('POST', '/api/cron/arm', { enabled: true });
    await inspect('armed', null);
    await fx.json('POST', '/api/halt', {});
    await inspect('halted', 'halted');
    await fx.json('POST', '/api/cron/arm', { enabled: true });
    await inspect('resumed', null);
    await fx.json('POST', '/api/cron/arm', { enabled: false });
    await inspect('off', 'off');
  } finally {
    if (phone && phone.close) phone.close();
    await fx.dispose();
    model.server.closeAllConnections();
    await new Promise(resolve => model.server.close(resolve));
  }
  A.report('scheduler-state-consumers.http.test');
})().catch(e => { A.ok(false, e && e.stack); A.report('scheduler-state-consumers.http.test'); });
