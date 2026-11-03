'use strict';
/* Real sidecar finalization and durable restart after a paid summary stream fails. Only the loopback
 * provider transport is fake; no production loader/finalizer is replaced in the fixed run. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { history } = require('./spend.compaction-accounting.test.js');
const IPC = 'compaction-accounting-fixture-token-0123456789';
const MODEL = 'fixture/summary-receipt', calls = [];
let mode = 'usage_then_throw', compactCalls = 0;
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
    if (req.method !== 'POST') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: MODEL, context_length: 32000,
        supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } }] }));
    }
    const body = JSON.parse(raw);
    const compact = (body.messages || []).some(m => m.role === 'system' &&
      /You (?:compress an earlier slice|maintain a running summary) of an agent conversation/.test(JSON.stringify(m.content)));
    const n = compact ? ++compactCalls : 0, id = 'summary-http-' + (calls.length + 1);
    const failed = compact && n === (mode === 'usage_then_throw' ? 1 : 2);
    const usd = compact ? (failed ? 0.10 : 0.11) : 0.03;
    calls.push({ id, compact, failed, usd, model: body.model,
      system: JSON.stringify((body.messages || []).filter(m => m.role === 'system').map(m => m.content)).slice(0, 260) });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = data => res.write('data: ' + JSON.stringify(data) + '\n\n');
    send({ id, choices: [{ delta: {} }] });
    send({ choices: [{ delta: failed ? {} : { content: compact ? '## Completed\nEarlier fixture notes are retained.' : 'The fixture is complete. No files changed.' },
      finish_reason: failed ? null : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: failed ? 0 : 10, cost: usd } });
    if (failed) send({ error: { code: 500, message: 'fixture summary stream failed after real usage' } });
    res.end('data: [DONE]\n\n');
  });
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const f = SidecarFixture.create({ prefix: 'compaction-accounting-', env: {
    STARNET_IPC_TOKEN: IPC, STARNET_DEFAULT_MODEL: MODEL, STARNET_OPENROUTER_BASE: base,
    STARNET_OPENROUTER_KEY: 'fixture', STARNET_AUX_MODEL: MODEL, STARNET_BUDGET_PER_DAY: '0',
    STARNET_LIVE_PRICES: '0', STARNET_CONTEXT_LIMIT_OVERRIDE: '1000', STARNET_COMPACT_MICRO: '0',
    STARNET_COMPACT_CHUNK_CHARS: '1800', STARNET_COMPACT_MAX_CHUNKS: '8',
    STARNET_REFLECTION: '0', STARNET_STUDY: '0', STARNET_FAILURE_REVIEW: '0', STARNET_QUEST_REFRESH: '0',
    STARNET_THREAD_MINE: '0', STARNET_SKILL_REVIEW: '0', STARNET_SKILL_CURATOR: '0', STARNET_SCOUT: '0', STARNET_CRON_ENABLED: '0'
  } });
  const ledgerFile = path.join(f.workspace, 'ledger.jsonl');
  const rows = () => fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const entry = path.join(f.workspace, 'compaction-boot.cjs');
  fs.writeFileSync(entry, "const real = globalThis.fetch; globalThis.fetch = function(url) { const u = new URL(String((url && url.url) || url)); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? real.apply(this, arguments) : Promise.reject(new Error('compaction fixture: remote transport refused')); };\nrequire(" + JSON.stringify(path.resolve(__dirname, '../sidecar/index.js')) + ");\n");
  f.entry = entry;
  const proved = [];
  try {
    await f.start();
    const now = Date.now();
    const saved = await f.json('POST', '/api/save', { schema: 'starnet.save', version: 6, updatedAt: now,
      _saveRevision: 0, _saveDirty: true, _saveClient: 'compaction-accounting-test', agent: { id: 'agent', name: 'NOVA', createdAt: now },
      agents: [], workstreams: [{ id: 'general', history: [] }], activeId: 'general', generalId: 'general' });
    assert.equal(saved.status, 200); assert.equal(saved.body.ok, true);
    assert.equal((await f.request('/api/key', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-StarNet-Token': IPC },
      body: JSON.stringify({ provider: 'openrouter', key: 'fixture', baseUrl: base }) })).status, 200);
    assert.equal((await f.json('POST', '/api/roster', { updatedAt: now,
      agents: [{ agentId: 'agent', name: 'NOVA', provider: 'openrouter', model: MODEL }] })).status, 200);
    for (const kind of ['usage_then_throw', 'first_chunk_then_throw']) {
      mode = kind; compactCalls = 0; const from = calls.length;
      const ran = await f.json('POST', '/api/run', { agentId: 'agent', provider: 'openrouter', model: MODEL,
        key: 'fixture', streamId: 'compaction-' + kind, messages: history() });
      assert.equal(ran.status, 200, kind + ': real run accepted');
      const events = String(ran.text).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const started = events.find(e => e.name === 'agent.run.start');
      assert.ok(started && started.payload.runId, 'host-owned run ID');
      const ended = events.filter(e => e.name === 'agent.run.end').pop();
      assert.equal(ended && ended.payload.reason, 'done', kind + ': main call still completes');
      const actual = calls.slice(from), row = rows().find(r => r.runId === started.payload.runId && !r.aux);
      console.log(JSON.stringify({ kind, transport: actual, costEvents: events.filter(e => e.name === 'agent.cost').map(e => e.payload), row }));
      assert.equal(actual.filter(c => c.compact).length, kind === 'usage_then_throw' ? 1 : 2, 'intended summary failure reached');
      assert.equal(actual.filter(c => !c.compact).length, 1, 'one successful main call after failed summary');
      assert.equal(actual.filter(c => c.failed).length, 1, 'exactly one usage-then-error stream');
      const expected = actual.reduce((sum, call) => sum + call.usd, 0);
      assert.ok(row && Math.abs(row.usd - expected) < 1e-9, kind + ': durable main row retains every observed paid floor');
      assert.equal(row.usageMissing, true, kind + ': failed summary remains flagged after successful main completion');
      assert.deepEqual(row.generationIds, actual.map(c => c.id), 'durable receipt matches all actual attempts');
      assert.equal(row.generationCount, actual.length, 'no lost or fabricated provider call');
      proved.push({ kind, runId: row.runId, usd: row.usd, generationIds: row.generationIds });
    }
    const before = fs.readFileSync(ledgerFile, 'utf8');
    await f.stop(); await f.start();
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before, 'restart keeps exact ledger bytes and paid floors');
    for (const proof of proved) assert.deepEqual(rows().find(r => r.runId === proof.runId).generationIds, proof.generationIds);
    console.log(JSON.stringify({ cases: proved, restart: 'exact bytes preserved' }));
  } finally { await f.dispose(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e && e.stack || e); server.close(); process.exitCode = 1; });
