'use strict';
/* Real sidecar/runOnce/RunTable/LineJobs, synthetic provider and explicit test-only
   fresh authority injection. No production entry route or saved-floor grant. */
const A = require('./_assert.js'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { fixture, clone } = require('./helpers/line-entry.js');
const C = require('../sidecar/routing/line-continuation.js');
const Pipeline = require('../frontend/app/pipeline.js');
const { floorOf, publishFloor } = require('./helpers/saved-floor.js');
(async () => {
  let fx, upstream;
  const calls = [];
  try {
    upstream = http.createServer((req, res) => {
      if (!req.url.includes('/chat/completions')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 64000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
      }
      let raw = ''; req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw); calls.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'actual complete entry\nVERDICT: BLOCKED' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 } }) + '\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + upstream.address().port;
    fx = SidecarFixture.create({ prefix: 'line-entry-host-', env: {
      STARNET_DEV: '1', STARNET_FULL_ACCESS: '1', STARNET_DEFAULT_PROVIDER: 'openrouter', STARNET_DEFAULT_MODEL: 'test/model', SKYNET_DEFAULT_MODEL: 'test/model',
      STARNET_OPENROUTER_KEY: 'entry-fixture-key', SKYNET_OPENROUTER_KEY: 'entry-fixture-key',
      STARNET_OPENROUTER_BASE: url + '/v1', SKYNET_OPENROUTER_BASE: url + '/v1', STARNET_MAX_ITERS: '2', STARNET_BUDGET_PER_DAY: '0',
      STARNET_CREDITS_URL: '', STARNET_CLOUD_URL: '', STARNET_LIVE_PRICES: '0', STARNET_REFLECTION: '0', STARNET_STUDY: '0',
      STARNET_FAILURE_REVIEW: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_THREAD_MINE: '0', STARNET_SCOUT: '0', STARNET_QUEST_REFRESH: '0',
      LINE_ENTRY_FIXTURE_UPSTREAM: url,
      LINE_ENTRY_HOST_CONTROL_INDEX: process.env.LINE_ENTRY_HOST_CONTROL_INDEX || '', LINE_ENTRY_HOST_CONTROL_SHA256: process.env.LINE_ENTRY_HOST_CONTROL_SHA256 || ''
    } });
    fx.env.LINE_ENTRY_FIXTURE_ROOT = fx.workspace;
    const control = value => fs.writeFileSync(path.join(fx.workspace, 'fixture-control.json'), JSON.stringify(value));
    control({});
    fs.writeFileSync(path.join(fx.workspace, 'line-jobs.json'), JSON.stringify({ version: 1, jobs: [] }));
    fs.writeFileSync(path.join(fx.workspace, 'line-spend.json'), JSON.stringify({ version: 1, lines: { 'line-a': { day: 0, usd: 5 } } }));
    const boot = path.join(fx.workspace, 'entry-boot.cjs');
    fs.writeFileSync(boot, 'require(' + JSON.stringify(path.resolve(__dirname, 'helpers/line-entry-host-preload.cjs')) + ');require(' + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ');');
    fx.entry = boot;
    const api = async (method, route, body) => { const out = await fx.json(method, route, body); assert.equal(out.status, 200, route + ': ' + out.text.slice(0, 400)); return out.body; };
    await fx.start();
    await api('POST', '/api/memory/config', { reflectEnabled: false, studyEnabled: false, failureReviewEnabled: false });
    await api('POST', '/api/save', { schema: 'starnet.save', version: require('../frontend/app/save.js').CURRENT, updatedAt: Date.now(), _saveRevision: 0, _saveDirty: true,
      _saveClient: 'entry-fixture', agent: { id: 'reviewer', name: 'Reviewer', createdAt: Date.now() }, agents: [],
      workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    await api('POST', '/api/roster', { updatedAt: Date.now(), agents: [{ agentId: 'reviewer', name: 'Reviewer', provider: 'openrouter', model: 'test/model' }] });
    // The host requires real workflow membership: the workflow is SAVED (the saved floor is the routing authority) and the page's
    // hint of it published. The entry itself is still the synthetic fixture input the preload represents.
    const { plan } = await publishFloor(fx, floorOf({ props: [
      { id: 'intake-a', t: 'intake', x: 0, y: 0, w: 1, h: 1, lineId: 'line-a' },
      { id: 'dock-reviewer', t: 'bay', x: 3, y: 0, w: 1, h: 1, agentId: 'reviewer' },
      { id: 'outbox-a', t: 'outbox', x: 6, y: 0, w: 1, h: 1 }
    ], belts: [1, 2, 4, 5].map(x => ({ x, y: 0, dir: 'E' })) }), { label: 'the fixture workflow' });
    assert.equal(Pipeline.ok(plan), true, 'the saved workflow compiles through the actual owner');
    const lineId = plan.lineOfProp['intake-a'];
    const route = { hash: plan.hash, lineId, agentId: 'reviewer', intakePresent: true };
    function data(id, runId) {
      const f = fixture(); f.job.id = id; f.receipt.binding.jobId = id; f.receipt.binding.entryRunId = runId;
      f.job.line = lineId; f.job.intakeId = 'intake-a';
      Object.assign(f.receipt.binding, { lineId, intakeId: 'intake-a', planHash: plan.hash, entryNode: { agentId: 'reviewer', dockId: 'dock-reviewer' } });
      f.receipt.binding.workitemId = 'crate-' + runId; f.receipt.at = Date.now();
      f.receipt.input.text = 'Return the final entry draft for ' + runId; f.job.text = f.receipt.input.text;
      f.receipt.inputDigest = C.entryInputDigest(f.receipt.input);
      fs.writeFileSync(path.join(fx.workspace, 'fixture-authority.json'), JSON.stringify({ binding: f.receipt.binding, inputDigest: f.receipt.inputDigest }));
      return { job: f.job, receipt: f.receipt };
    }
    const first = data('job-entryhost01', 'run-entry-host-01');
    const out = await api('POST', '/api/_entry-fixture', clone(first));
    console.log('ENTRY_FIXTURE_FIRST ' + JSON.stringify({ state: out.receipt.state, diagnostic: out.diagnostic, routing: out.routing }));
    A.eq(out.routing, route, 'actual host current plan matches original intake/dock/line/hash binding');
    A.eq([out.invoked, out.confirmed, out.receipt.state, out.usageStatus], [true, true, 'observed', 'observed'], 'actual host finalizer acknowledges its saved observation');
    A.eq(out.receipt.observation && out.receipt.observation.product.text, 'actual complete entry\nVERDICT: BLOCKED', 'actual accepted terminal output is persisted in full');
    A.eq(out.receipt.observation && [out.receipt.observation.outcome, out.receipt.observation.usd], ['succeeded', 0], 'actual known-free provider still produces an exact terminal receipt');
    A.eq([calls.length, out.live], [1, 0], 'one real provider call and balanced actual host RunTable cleanup');
    A.eq(calls[0] && calls[0].usage, { include: true }, 'actual OpenRouter transport requests reported usage/cost');
    A.eq(out.diagnostic.terminal && [out.diagnostic.terminal.usd, out.diagnostic.terminal.usageMissing, out.diagnostic.terminal.unpriced], [0, false, false], 'actual cost owner accepts explicit synthetic reported zero without an unknown-cost shortcut');
    const retry = await api('POST', '/api/_entry-fixture', clone(first));
    A.eq([retry.invoked, calls.length], [false, 1], 'lost caller response/retry buys no second provider call');
    await fx.restart();
    const after = await api('POST', '/api/_entry-fixture', clone(first));
    A.eq(after.routing, route, 'actual restart restores the same compiled route without reposting');
    A.eq([after.invoked, after.receipt.state, calls.length], [false, 'observed', 1], 'restart re-proves exact saved observation without paid re-entry');
    const second = data('job-entryhost02', 'run-entry-host-02');
    control({ failObservationRunId: second.receipt.binding.entryRunId });
    const failed = await api('POST', '/api/_entry-fixture', clone(second));
    console.log('ENTRY_FIXTURE_WRITE_FAILURE ' + JSON.stringify({ state: failed.receipt.state, diagnostic: failed.diagnostic }));
    A.eq([failed.receipt.state, failed.live, calls.length], ['uncertain', 0, 2], 'actual observation persistence failure retains uncertainty and releases the run');
    A.eq([failed.observationError, failed.diagnostic.observation, failed.executionError], ['EIO', 'fixture observation write refused', null], 'the exact injected persistence failure stays separate from execution');
    A.eq(failed.diagnostic.terminal && [failed.diagnostic.terminal.outcome, failed.diagnostic.terminal.text, failed.diagnostic.terminal.unpriced], ['succeeded', 'actual complete entry\nVERDICT: BLOCKED', false], 'write fault occurs after actual successful priced terminal evidence');
    control({});
    const held = await api('POST', '/api/_entry-fixture', clone(second));
    A.eq([held.invoked, held.receipt.state, calls.length], [false, 'uncertain', 2], 'repairing storage never automatically re-enters an uncertain paid attempt');
    const ledger = JSON.parse(fs.readFileSync(path.join(fx.workspace, 'line-spend.json'), 'utf8'));
    A.eq(ledger.lines['line-a'].usd, 5, 'private entry proof never books/adopts a line continuation');
    if (process.env.LINE_ENTRY_HOST_CONTROL_INDEX) A.ok(fx.output().includes('CONTROL_SOURCE LINE_ENTRY_HOST_CONTROL_INDEX SHA256=' + process.env.LINE_ENTRY_HOST_CONTROL_SHA256), 'actual child certifies exact old host source');
    A.report('line-entry.invocation.http');
  } finally {
    if (fx) await fx.dispose();
    if (upstream) await new Promise(resolve => upstream.close(resolve));
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
